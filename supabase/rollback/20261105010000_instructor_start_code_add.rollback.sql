-- 되돌리기: 20261105010000_instructor_start_code_add.sql (시작코드 추가분)
--
-- 순서: 20261105020000(강제)을 먼저 되돌린 뒤에 이 파일을 적용한다.
-- 강제 단계가 적용된 채로 이 파일을 실행하면 인증 함수가 삭제될 열을 읽게 되므로 아래에서 막는다.
--
-- 주의(시작코드를 이미 발급한 뒤라면):
--   발급된 시작코드는 pin_hash 자리에 해시로 남아 있다. 이 파일을 적용하면 만료 시각이 사라져
--   그 코드가 기한 없이 첫 PIN으로 쓰인다(계정별 5회 잠금·이름별 10회 잠금은 유지). 되돌린 뒤에는
--   미설정 강사가 먼저 로그인해 6자리 PIN을 만들도록 안내하는 것이 안전하다.
--   이 파일은 뒤 4자리를 최초 PIN으로 되돌리지 않는다.

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'instructor_authenticate'
      and pg_get_functiondef(p.oid) like '%START_CODE_EXPIRED%'
  ) then
    raise exception '20261105020000(시작코드 강제)을 먼저 되돌려 주세요.';
  end if;
end $$;

-- 1. 새 함수 삭제
drop function if exists public.provision_instructor_with_start_code(uuid, uuid, text, text);
drop function if exists public.issue_instructor_start_code(uuid);
drop function if exists public.instructor_generate_start_code();

-- 2. 강사 목록 함수를 이전 모양(20260917010000)으로
drop function if exists public.list_instructor_accounts();

create function public.list_instructor_accounts()
returns table (
  out_principal_id uuid,
  out_name text,
  out_phone_last4 text,
  out_is_active boolean,
  out_pin_set boolean,
  out_pin_locked boolean,
  out_pin_confirmed boolean,
  out_created_at timestamptz
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_row record;
begin
  if not public.is_system_admin() then
    raise exception '강사 목록을 조회할 권한이 없습니다.';
  end if;

  for v_row in
    select p.id, p.name, ip.phone_last4, p.is_active,
           (ip.pin_hash is not null) as pin_set,
           (ip.pin_locked_until is not null and ip.pin_locked_until > now()) as pin_locked,
           ip.pin_confirmed,
           p.created_at
    from public.principals p
    join public.instructor_profiles ip on ip.principal_id = p.id
    where p.organization_id = public.current_organization_id() and p.principal_type = 'instructor'
    order by p.created_at
  loop
    out_principal_id := v_row.id;
    out_name := v_row.name;
    out_phone_last4 := v_row.phone_last4;
    out_is_active := v_row.is_active;
    out_pin_set := v_row.pin_set;
    out_pin_locked := v_row.pin_locked;
    out_pin_confirmed := v_row.pin_confirmed;
    out_created_at := v_row.created_at;
    return next;
  end loop;
end;
$$;

revoke execute on function public.list_instructor_accounts() from public, anon;
grant execute on function public.list_instructor_accounts() to authenticated, service_role;

-- 3. set_instructor_pin을 20261104010000 본문으로
create or replace function public.set_instructor_pin(
  p_org_code text, p_name text, p_phone_last4 text, p_current_pin text, p_new_pin text
)
returns table(out_principal_id uuid, out_auth_user_id uuid, out_organization_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_auth record;
begin
  if p_new_pin is null or p_new_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN_FORMAT';
  end if;

  select * into v_auth
  from public.instructor_authenticate(p_org_code, p_name, p_phone_last4, p_current_pin);
  if v_auth.principal_id is null then
    return;
  end if;

  if v_auth.pin_confirmed then
    raise exception 'ALREADY_SET';
  end if;

  if p_new_pin ~ '^([0-9])\1{5}$'
     or p_new_pin = p_current_pin
     or p_new_pin in ('012345', '123456', '234567', '345678', '456789', '567890',
                      '987654', '876543', '765432', '654321', '543210', '432109')
     or left(p_new_pin, 4) = p_phone_last4
     or right(p_new_pin, 4) = p_phone_last4
     or (length(p_current_pin) between 4 and 5
         and (left(p_new_pin, length(p_current_pin)) = p_current_pin
              or right(p_new_pin, length(p_current_pin)) = p_current_pin))
  then
    raise exception 'PIN_WEAK';
  end if;

  update public.instructor_profiles
  set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
      pin_confirmed = true, pin_failed_count = 0, pin_locked_until = null
  where principal_id = v_auth.principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_auth.organization_id, v_auth.principal_id, 'instructor_pin_set', 'principal', v_auth.principal_id);

  out_principal_id := v_auth.principal_id;
  out_auth_user_id := v_auth.auth_user_id;
  out_organization_id := v_auth.organization_id;
  return next;
end;
$$;

revoke execute on function public.set_instructor_pin(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_instructor_pin(text, text, text, text, text) to service_role;

-- 4. 열 삭제 (마지막)
alter table public.instructor_profiles drop column if exists start_code_expires_at;
