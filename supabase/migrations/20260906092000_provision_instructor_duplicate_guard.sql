-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.2: provision_instructor 중복 가드.
--
-- verify_instructor_login은 이름+휴대전화 뒤4자리 조합으로 강사를 특정한다. RPC
-- 테스트 중, 같은 조직에 이름+뒤4자리가 완전히 같은 강사 principal이 2개 존재하면
-- 어느 쪽이 조회될지 결정적이지 않다는 것을 실제로 확인했다(ORDER BY 없는
-- SELECT INTO가 임의의 한 행을 선택함 -- 이번 케이스에서는 잠긴 계정이 선택되어
-- 정상 계정으로 로그인이 막히는 문제로 나타났다). forward-fix로 provision_instructor가
-- 같은 조직 내 이름+뒤4자리 중복 생성을 아예 막도록 한다.

create or replace function public.provision_instructor(
  p_organization_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_phone_last4 text,
  p_pin text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
begin
  if not public.is_system_admin() then
    raise exception '강사 계정을 생성할 권한이 없습니다.';
  end if;
  if p_organization_id is distinct from public.current_organization_id() then
    raise exception '다른 조직에 강사 계정을 생성할 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;
  if p_phone_last4 !~ '^[0-9]{4}$' then
    raise exception '휴대전화 뒤 4자리 형식이 올바르지 않습니다.';
  end if;
  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN은 6자리 숫자여야 합니다.';
  end if;

  select id into v_principal_id from public.principals where auth_user_id = p_auth_user_id;
  if v_principal_id is not null then
    return v_principal_id;
  end if;

  -- 로그인 조회 키(이름+뒤4자리)가 같은 조직 안에서 유일하도록 보장한다 --
  -- 그렇지 않으면 verify_instructor_login이 어느 강사를 조회할지 결정적이지 않다.
  if exists (
    select 1
    from public.principals p
    join public.instructor_profiles ip on ip.principal_id = p.id
    where p.organization_id = p_organization_id
      and p.principal_type = 'instructor'
      and p.is_active = true
      and p.name = trim(p_name)
      and ip.phone_last4 = p_phone_last4
  ) then
    raise exception '이미 같은 이름과 휴대전화 뒤4자리를 가진 강사 계정이 있습니다.';
  end if;

  insert into public.principals (organization_id, auth_user_id, principal_type, name)
  values (p_organization_id, p_auth_user_id, 'instructor', trim(p_name))
  returning id into v_principal_id;

  insert into public.instructor_profiles (principal_id, organization_id, phone_last4, pin_hash)
  values (v_principal_id, p_organization_id, p_phone_last4, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)));

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (p_organization_id, public.current_principal_id(), 'provision_instructor', 'principal', v_principal_id,
          jsonb_build_object('name', p_name));

  return v_principal_id;
end;
$$;
