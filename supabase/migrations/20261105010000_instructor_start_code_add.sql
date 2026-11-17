-- WellLink v1.0 — 강사 최초 PIN 선점 방지 (1단계: 추가만, 기존 로그인 동작은 바꾸지 않음)
--
-- 문제: 지금은 최초 PIN이 "휴대전화 뒤 4자리"이고 로그인 아이디에도 같은 숫자가 들어 있어,
-- 이름과 뒤 4자리만 아는 사람이 강사보다 먼저 PIN을 만들어 계정을 차지할 수 있다.
--
-- 해결: 관리자가 강사를 등록하거나 PIN을 초기화할 때 DB가 무작위 6자리 "시작코드"를 만들어
-- 관리자 화면에 한 번만 보여 준다. 강사는 지금의 PIN 칸에 이 코드를 넣어 로그인하고, 기존
-- "6자리 새 PIN 만들기" 화면에서 마무리한다. 시작코드는
--   - 암호용 난수(gen_random_bytes)로 DB 안에서 만들고 (함수 인자·로그에 나타나지 않음)
--   - 원문은 저장하지 않고 PIN과 같은 bcrypt 해시로 pin_hash 자리에 저장하며
--   - 7일간만 유효하고 (start_code_expires_at), 새 PIN 설정에 성공하면 즉시 사라지고,
--   - 다시 발급하면 같은 자리를 덮어써서 이전 코드가 곧바로 무효가 된다.
--
-- 이 migration은 "추가"만 한다.
--   - 열 1개, 새 함수 3개, 목록 함수의 열 1개 추가, set_instructor_pin이 시작코드 만료값을 지우도록 보강.
--   - 기존 로그인(instructor_authenticate)과 옛 등록·초기화 함수는 그대로 둔다.
--     그래서 이 migration을 먼저 적용하고 새 화면을 나중에 Publish해도 그 사이 옛 화면이 계속 동작한다.
--   - 뒤 4자리를 최초 PIN으로 받아 주는 옛 경로를 닫는 일은 다음 migration(20261105020000)에서 한다.
--     (새 화면 배포 후에 적용)

-- ============================================================
-- 1. 열 추가: 시작코드 만료 시각
-- ============================================================
-- NULL이면 "시작코드가 발급되지 않은 상태"다. 값이 있으면 그 시각까지만 시작코드가 유효하다.
alter table public.instructor_profiles
  add column if not exists start_code_expires_at timestamptz;

comment on column public.instructor_profiles.start_code_expires_at is
  '시작코드 만료 시각. 값이 있으면 pin_hash는 시작코드의 해시이며 이 시각 이후엔 쓸 수 없다. 새 PIN 설정 시 NULL로 돌아간다.';

-- ============================================================
-- 2. 6자리 시작코드 생성 도우미 (내부용)
-- ============================================================
-- 0~4,293,999,999 중 균등하게 뽑은 값을 1,000,000으로 나눈 나머지를 쓴다(편향 제거를 위해 범위 밖이면 다시 뽑음).
create or replace function public.instructor_generate_start_code()
returns text
language plpgsql
volatile
security definer set search_path = public
as $$
declare
  v_n bigint;
begin
  loop
    v_n := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    exit when v_n < 4294000000;
  end loop;
  return lpad((v_n % 1000000)::text, 6, '0');
end;
$$;

revoke execute on function public.instructor_generate_start_code() from public, anon, authenticated;
grant execute on function public.instructor_generate_start_code() to service_role;

-- ============================================================
-- 3. 시작코드 발급·재발급 (관리자 전용, 같은 기관 강사만)
-- ============================================================
-- 등록 직후 첫 발급과 PIN 초기화(재발급)를 같은 함수가 처리한다.
-- 발급하면 그 강사의 기존 PIN은 즉시 쓸 수 없게 되고(해시를 덮어씀), 실패 횟수·잠금이 초기화되며,
-- 이미 열려 있는 로그인 세션도 가능한 범위에서 종료한다(auth.sessions 삭제).
--   * 세션을 지워도 이미 발급된 접근 토큰(JWT)은 만료될 때까지(Supabase 설정값) 남을 수 있다.
--   * 세션 삭제가 권한 문제로 실패해도 발급 자체는 성공시키고, out_sessions_revoked=false로 알린다.
create or replace function public.issue_instructor_start_code(p_principal_id uuid)
returns table(out_code text, out_expires_at timestamptz, out_sessions_revoked boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_auth_user_id uuid;
  v_name text;
  v_code text;
  v_expires timestamptz := now() + interval '7 days';
  v_revoked boolean := false;
begin
  if public.is_system_admin() is distinct from true then
    raise exception '강사 시작코드를 발급할 권한이 없습니다.';
  end if;

  select p.organization_id, p.auth_user_id, p.name
    into v_org, v_auth_user_id, v_name
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.id = p_principal_id and p.principal_type = 'instructor'
  for update of ip;

  -- 없는 강사와 다른 기관 강사는 구분하지 않고 같은 메시지로 거부한다.
  if v_org is null or v_org is distinct from public.current_organization_id() then
    raise exception '대상 강사를 찾을 수 없습니다.';
  end if;

  v_code := public.instructor_generate_start_code();

  update public.instructor_profiles
  set pin_hash = extensions.crypt(v_code, extensions.gen_salt('bf', 10)),
      pin_confirmed = false,
      pin_failed_count = 0,
      pin_locked_until = null,
      start_code_expires_at = v_expires
  where principal_id = p_principal_id;

  -- (기관 + 이름) 단위 로그인 실패 기록도 비운다. 이전 잠금 때문에 새 코드가 막히지 않게 한다.
  delete from public.instructor_login_attempts a
  where a.organization_id = v_org and a.name_key = lower(btrim(coalesce(v_name, '')));

  -- 열려 있는 로그인 세션 종료(실패해도 발급은 유지).
  begin
    delete from auth.sessions where user_id = v_auth_user_id;
    v_revoked := true;
  exception when others then
    v_revoked := false;
  end;

  -- 감사 기록에는 "발급했다"는 사실만 남기고 코드 값은 남기지 않는다.
  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_org, public.current_principal_id(), 'issue_instructor_start_code', 'principal', p_principal_id);

  out_code := v_code;
  out_expires_at := v_expires;
  out_sessions_revoked := v_revoked;
  return next;
end;
$$;

revoke execute on function public.issue_instructor_start_code(uuid) from public, anon;
grant execute on function public.issue_instructor_start_code(uuid) to authenticated, service_role;

-- ============================================================
-- 4. 강사 등록 + 시작코드 발급을 한 번에 (한 트랜잭션)
-- ============================================================
-- 기존 provision_instructor는 최초 PIN을 뒤 4자리로 저장한다. 이 함수는 그것을 호출한 직후 같은
-- 트랜잭션 안에서 시작코드로 덮어쓰므로, 뒤 4자리가 유효한 순간이 외부에 보이지 않는다.
create or replace function public.provision_instructor_with_start_code(
  p_organization_id uuid, p_auth_user_id uuid, p_name text, p_phone_last4 text
)
returns table(out_principal_id uuid, out_code text, out_expires_at timestamptz)
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
  v_issued record;
begin
  v_principal_id := public.provision_instructor(p_organization_id, p_auth_user_id, p_name, p_phone_last4);
  select * into v_issued from public.issue_instructor_start_code(v_principal_id);

  out_principal_id := v_principal_id;
  out_code := v_issued.out_code;
  out_expires_at := v_issued.out_expires_at;
  return next;
end;
$$;

revoke execute on function public.provision_instructor_with_start_code(uuid, uuid, text, text) from public, anon;
grant execute on function public.provision_instructor_with_start_code(uuid, uuid, text, text) to authenticated, service_role;

-- ============================================================
-- 5. 강사 목록: 시작코드 만료 시각 추가
-- ============================================================
-- 반환 열이 늘어 drop 후 다시 만든다(20260917010000과 같은 방식). 권한은 기존과 같다.
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
  out_created_at timestamptz,
  out_start_code_expires_at timestamptz
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
           p.created_at,
           ip.start_code_expires_at
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
    out_start_code_expires_at := v_row.start_code_expires_at;
    return next;
  end loop;
end;
$$;

revoke execute on function public.list_instructor_accounts() from public, anon;
grant execute on function public.list_instructor_accounts() to authenticated, service_role;

-- ============================================================
-- 6. set_instructor_pin: 새 PIN 설정 성공 시 시작코드 만료값을 비운다
-- ============================================================
-- 20261104010000의 본문과 같고, 마지막 update에 start_code_expires_at = null 한 줄만 더했다.
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
  -- 형식 검사는 인증 전에 한다(잘못된 형식의 요청이 실패 횟수를 늘리지 않게).
  if p_new_pin is null or p_new_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN_FORMAT';
  end if;

  -- 현재 PIN(또는 시작코드) 검증(실패 횟수 집계·잠금 포함). 실패하면 빈 결과로 끝낸다.
  select * into v_auth
  from public.instructor_authenticate(p_org_code, p_name, p_phone_last4, p_current_pin);
  if v_auth.principal_id is null then
    return;
  end if;

  if v_auth.pin_confirmed then
    raise exception 'ALREADY_SET';
  end if;

  -- 약한 PIN 거부: 같은 숫자 반복, 연속 숫자, 현재 PIN·뒤4자리로 시작하거나 끝나는 PIN.
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
      pin_confirmed = true, pin_failed_count = 0, pin_locked_until = null,
      start_code_expires_at = null
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
