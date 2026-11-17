-- WellLink v1.0 — 강사 로그인 보안 강화 (1단계: 새 기능 추가, 기존 동작은 깨지 않음)
--
-- 전문가 검토 의견(기술적 리스크 2번)에 따른 변경이다.
--   (1) 없는 계정에도 시도 제한: 지금은 존재하는 (이름, 뒤4자리)만 실패를 세기 때문에
--       이름만 알면 뒤4자리 1만 가지를 횟수 제한 없이 시도할 수 있다.
--       (기관 + 이름) 단위로도 실패를 세어 15분 안에 10번 실패하면 15분간 잠근다.
--   (2) PIN 설정 함수가 현재 PIN을 요구한다. 지금은 기관코드·이름·뒤4자리만 알면
--       누구나 PIN을 설정할 수 있다. 새 5-인자 set_instructor_pin은 현재 PIN을 검증하고
--       (실패 횟수 집계 포함) 그 뒤에만 새 PIN을 저장한다.
--   (3) 새 PIN은 6자리. 같은 숫자 반복, 연속 숫자, 뒤4자리(또는 현재 PIN)로 시작·끝나는
--       PIN은 거부한다.
--
-- 이 migration은 "추가"만 한다. 기존 4-인자 set_instructor_pin과
-- confirm_instructor_current_pin은 그대로 남겨 두어, 이 migration을 먼저 적용하고
-- 새 코드를 나중에 Publish해도 그 사이 옛 코드가 계속 동작한다.
-- 옛 함수 삭제와 "전원 6자리 PIN 강제"는 새 코드가 배포된 뒤 다음 migration에서 한다.
--
-- 주의: 실패 횟수는 함수가 "정상 반환"해야 저장된다. 예외(raise exception)를 던지면
-- 같은 호출 안의 기록이 모두 되돌려지므로, 인증 실패는 예외가 아니라 빈 결과로 알린다.

-- ============================================================
-- 1. (기관 + 이름) 단위 실패 기록
-- ============================================================
create table if not exists public.instructor_login_attempts (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name_key text not null,
  failed_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz,
  primary key (organization_id, name_key)
);

comment on table public.instructor_login_attempts is
  '강사 로그인 실패 기록((기관, 이름) 단위). 없는 계정에 대한 대입 시도도 센다. 서버 함수(service_role)만 쓴다.';

-- RLS를 켜고 정책을 만들지 않는다 -- 브라우저(anon/authenticated)는 읽을 수도 쓸 수도 없다.
-- 아래 security definer 함수만 이 표를 다룬다.
alter table public.instructor_login_attempts enable row level security;
revoke all on public.instructor_login_attempts from public, anon, authenticated;

-- ============================================================
-- 2. 실패 기록·잠금 확인 도우미
-- ============================================================
create or replace function public.instructor_is_login_locked(p_org_id uuid, p_name text)
returns boolean
language sql
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.instructor_login_attempts a
    where a.organization_id = p_org_id
      and a.name_key = lower(btrim(coalesce(p_name, '')))
      and a.locked_until is not null
      and a.locked_until > now()
  );
$$;

create or replace function public.instructor_note_failed_login(p_org_id uuid, p_name text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_key text := lower(btrim(coalesce(p_name, '')));
  v_row public.instructor_login_attempts%rowtype;
  v_count integer;
begin
  select * into v_row
  from public.instructor_login_attempts
  where organization_id = p_org_id and name_key = v_key
  for update;

  if not found then
    insert into public.instructor_login_attempts (organization_id, name_key, failed_count, window_started_at)
    values (p_org_id, v_key, 1, now())
    on conflict (organization_id, name_key) do update
      set failed_count = public.instructor_login_attempts.failed_count + 1;
    return;
  end if;

  -- 15분이 지났고 잠금도 풀렸으면 새로 센다.
  if v_row.window_started_at < now() - interval '15 minutes'
     and (v_row.locked_until is null or v_row.locked_until <= now()) then
    update public.instructor_login_attempts
    set failed_count = 1, window_started_at = now(), locked_until = null
    where organization_id = p_org_id and name_key = v_key;
    return;
  end if;

  v_count := v_row.failed_count + 1;
  update public.instructor_login_attempts
  set failed_count = v_count,
      locked_until = case when v_count >= 10 then now() + interval '15 minutes' else locked_until end
  where organization_id = p_org_id and name_key = v_key;
end;
$$;

revoke execute on function public.instructor_is_login_locked(uuid, text) from public, anon, authenticated;
grant execute on function public.instructor_is_login_locked(uuid, text) to service_role;
revoke execute on function public.instructor_note_failed_login(uuid, text) from public, anon, authenticated;
grant execute on function public.instructor_note_failed_login(uuid, text) to service_role;

-- ============================================================
-- 3. 공통 인증 함수 (로그인과 PIN 설정이 함께 쓴다)
-- ============================================================
-- 계정별 잠금(5회 실패 -> 15분)은 그대로 두고, (기관 + 이름) 단위 잠금(10회 -> 15분)을
-- 더한다. 인증 실패는 빈 결과로 알리고(예외 아님), 잠겨 있으면 LOCKED 예외를 던진다.
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
  v_ok boolean;
begin
  v_org_id := public.resolve_organization_id_by_code(p_org_code);
  if v_org_id is null then
    return;
  end if;

  if public.instructor_is_login_locked(v_org_id, p_name) then
    raise exception 'LOCKED';
  end if;

  select p.id, p.auth_user_id, p.organization_id, ip.pin_hash, ip.pin_confirmed, ip.pin_failed_count, ip.pin_locked_until
    into v_principal_id, v_auth_user_id, v_organization_id, v_pin_hash, v_pin_confirmed, v_failed_count, v_locked_until
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
-- 4. verify_instructor_login -- 같은 시그니처, 공통 인증 함수로 위임
-- ============================================================
create or replace function public.verify_instructor_login(
  p_org_code text, p_name text, p_phone_last4 text, p_pin text
)
returns table(principal_id uuid, auth_user_id uuid, organization_id uuid, pin_confirmed boolean)
language plpgsql
security definer set search_path = public
as $$
begin
  return query select * from public.instructor_authenticate(p_org_code, p_name, p_phone_last4, p_pin);
end;
$$;

revoke execute on function public.verify_instructor_login(text, text, text, text) from public, anon, authenticated;
grant execute on function public.verify_instructor_login(text, text, text, text) to service_role;

-- ============================================================
-- 5. set_instructor_pin (5-인자) -- 현재 PIN을 검증한 뒤 6자리 새 PIN 저장
-- ============================================================
-- 기존 4-인자 함수는 인자 개수가 달라 서로 다른 함수로 공존한다(이 migration은 삭제하지 않음).
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

  -- 현재 PIN 검증(실패 횟수 집계·잠금 포함). 실패하면 빈 결과로 끝낸다.
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
