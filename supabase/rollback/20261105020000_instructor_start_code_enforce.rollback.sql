-- 되돌리기: 20261105020000_instructor_start_code_enforce.sql (시작코드 강제)
--
-- 언제 쓰나: 시작코드 강제 적용 뒤 정상 강사의 로그인이 예상 밖으로 막히는 등, 강제 규칙만 잠시 풀어야 할 때.
--
-- 이 파일은 "과거의 취약한 방식(뒤 4자리가 최초 PIN)을 다시 여는 일"을 하지 않는다.
--   - 시작코드가 없는 미설정 계정(뒤 4자리 해시가 남은 계정)은 먼저 무작위 해시로 바꿔 둔다.
--     이 계정들은 관리자가 시작코드를 발급하기 전까지 로그인할 수 없다(복구 뒤에도 마찬가지).
--   - provision_instructor는 옛 본문으로 되돌리지 않는다(뒤 4자리를 PIN으로 저장하지 않는 현재 본문 유지).
--   - 옛 reset_instructor_pin(뒤 4자리로 되돌리기)은 되살리지 않는다. 같은 이름의 함수는 안내 오류만 낸다.
-- 되돌려지는 것은 "인증 함수의 시작코드 만료·실패 20회 검사" 하나뿐이다.
--   (되돌린 동안에는 만료된 시작코드도 로그인에 쓸 수 있다. 계정별 5회 잠금과 이름별 10회 잠금은 그대로다.)

-- 1. 뒤 4자리 해시가 남은 미설정 계정을 사용할 수 없게 한다.
update public.instructor_profiles
set pin_hash = extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf', 10))
where pin_confirmed = false and start_code_expires_at is null;

-- 2. 인증 함수에서 시작코드 만료 검사만 뺀 본문(20261104010000과 같음, 단 위 1번으로 옛 해시는 이미 무효)
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

-- 3. 옛 화면이 부르는 이름만 남기되, 뒤 4자리로 되돌리지 않고 안내 오류만 낸다.
create or replace function public.reset_instructor_pin(p_principal_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  raise exception '강사 PIN 초기화는 시작코드 재발급으로 바뀌었습니다. 화면을 새로고침해 주세요.';
end;
$$;

revoke execute on function public.reset_instructor_pin(uuid) from public, anon;
grant execute on function public.reset_instructor_pin(uuid) to authenticated, service_role;
