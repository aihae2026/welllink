-- WellLink v1.0 — 강사 최초 PIN 선점 방지 (2단계: 옛 경로 폐쇄)
--
-- 반드시 20261105010000 migration과, 그 migration의 시작코드 함수를 쓰는 새 화면이 배포된 뒤에 적용한다.
-- 새 화면을 배포하기 전에 적용하면 옛 화면의 "강사 추가"가 시작코드를 보여 주지 못한다.
--
-- 이 migration이 하는 일
--   (1) instructor_authenticate: 아직 새 PIN을 만들지 않은 계정은 "유효한 시작코드"로만 통과시킨다.
--       - 시작코드가 없거나(옛 방식으로 뒤 4자리가 저장된 계정) 7일이 지났거나 실패가 20회 이상 쌓였으면,
--         값이 맞더라도 START_CODE_EXPIRED로 거부한다. 값이 틀린 경우는 지금처럼 일반 실패로만 처리해
--         "이 이름과 뒤 4자리가 실제 계정인가"를 알려 주지 않는다.
--   (2) provision_instructor: 최초 PIN을 뒤 4자리로 저장하지 않는다. 아무도 모르는 무작위 해시로 저장해 두고,
--       시작코드를 발급해야 로그인할 수 있다(provision_instructor_with_start_code가 한 트랜잭션에서 발급).
--   (3) reset_instructor_pin(뒤 4자리로 되돌리는 옛 초기화)을 삭제한다. 초기화는 시작코드 재발급이 대신한다.
--
-- 복구: supabase/rollback/20261105020000_instructor_start_code_enforce.rollback.sql
--   (되돌려도 뒤 4자리로 로그인되는 옛 방식은 다시 열리지 않는다.)

-- ============================================================
-- 1. 공통 인증 함수: 시작코드 유효성 검사 추가
-- ============================================================
-- 20261104010000의 본문에서 달라진 곳은 v_start_expires 읽기와, 맞는 PIN일 때의 "시작코드 유효성" 검사뿐이다.
create or replace function public.instructor_authenticate(
  p_org_code text, p_name text, p_phone_last4 text, p_pin text
)
returns table(principal_id uuid, auth_user_id uuid, organization_id uuid, pin_confirmed boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org_id uuid;
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
  v_pin_hash text;
  v_pin_confirmed boolean;
  v_failed_count integer;
  v_locked_until timestamptz;
  v_start_expires timestamptz;
  v_ok boolean;
begin
  v_org_id := public.resolve_organization_id_by_code(p_org_code);
  if v_org_id is null then
    return;
  end if;

  if public.instructor_is_login_locked(v_org_id, p_name) then
    raise exception 'LOCKED';
  end if;

  select p.id, p.auth_user_id, p.organization_id, ip.pin_hash, ip.pin_confirmed, ip.pin_failed_count,
         ip.pin_locked_until, ip.start_code_expires_at
    into v_principal_id, v_auth_user_id, v_organization_id, v_pin_hash, v_pin_confirmed, v_failed_count,
         v_locked_until, v_start_expires
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.organization_id = v_org_id
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4
  for update of ip;

  if v_principal_id is null then
    -- 없는 (이름, 뒤4자리)도 (기관 + 이름) 단위로 실패를 센다.
    perform public.instructor_note_failed_login(v_org_id, p_name);
    return;
  end if;

  if v_locked_until is not null and v_locked_until > now() then
    raise exception 'LOCKED';
  end if;

  v_ok := v_pin_hash is not null and extensions.crypt(p_pin, v_pin_hash) = v_pin_hash;

  if v_ok then
    -- 아직 6자리 새 PIN을 만들지 않은 계정은 유효한 시작코드로만 통과한다.
    -- 만료됐거나, 시작코드가 없거나(옛 뒤 4자리 방식), 실패가 20회 이상 쌓여 코드가 무효가 된 경우다.
    if v_pin_confirmed is not true
       and (v_start_expires is null or v_start_expires <= now() or v_failed_count >= 20) then
      raise exception 'START_CODE_EXPIRED';
    end if;

    update public.instructor_profiles
    set pin_failed_count = 0, pin_locked_until = null
    where instructor_profiles.principal_id = v_principal_id;

    delete from public.instructor_login_attempts a
    where a.organization_id = v_org_id and a.name_key = lower(btrim(coalesce(p_name, '')));

    return query select v_principal_id, v_auth_user_id, v_organization_id, v_pin_confirmed;
  else
    update public.instructor_profiles
    set pin_failed_count = pin_failed_count + 1,
        pin_locked_until = case when pin_failed_count + 1 >= 5 then now() + interval '15 minutes' else pin_locked_until end
    where instructor_profiles.principal_id = v_principal_id;

    perform public.instructor_note_failed_login(v_org_id, p_name);
    return;
  end if;
end;
$$;

revoke execute on function public.instructor_authenticate(text, text, text, text) from public, anon, authenticated;
grant execute on function public.instructor_authenticate(text, text, text, text) to service_role;

-- ============================================================
-- 2. provision_instructor: 뒤 4자리를 최초 PIN으로 저장하지 않는다
-- ============================================================
-- 20260910030000의 본문에서 달라진 곳은 pin_hash에 뒤 4자리 대신 무작위 해시를 넣는 한 곳뿐이다.
-- (시작코드를 발급하기 전까지는 누구도 이 계정으로 로그인할 수 없다.)
create or replace function public.provision_instructor(
  p_organization_id uuid, p_auth_user_id uuid, p_name text, p_phone_last4 text
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

  select id into v_principal_id from public.principals where auth_user_id = p_auth_user_id;
  if v_principal_id is not null then
    return v_principal_id;
  end if;

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

  insert into public.instructor_profiles (principal_id, organization_id, phone_last4, pin_hash, pin_confirmed, start_code_expires_at)
  values (
    v_principal_id, p_organization_id, p_phone_last4,
    extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 10)),
    false, null
  );

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (p_organization_id, public.current_principal_id(), 'provision_instructor', 'principal', v_principal_id,
          jsonb_build_object('name', p_name));

  return v_principal_id;
end;
$$;

-- ============================================================
-- 3. 옛 초기화 함수 삭제
-- ============================================================
-- 뒤 4자리로 되돌리던 함수. 새 화면은 issue_instructor_start_code를 쓴다.
drop function if exists public.reset_instructor_pin(uuid);
