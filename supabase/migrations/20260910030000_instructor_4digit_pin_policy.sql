-- Instructor Tablet Attendance + Login UX Lock: 강사 PIN을 6자리에서 4자리로
-- 바꾸고, 최초 PIN을 휴대전화 뒤4자리로 자동 부여한다. 강사는 최초 로그인 성공
-- 직후 "현재 PIN 유지" 또는 "새 PIN 설정" 중 하나를 선택하며, 그 선택 여부를
-- pin_confirmed로 구분한다(선택 전에는 로그인마다 선택화면을 다시 보여준다).
--
-- 기존 계정은 이미 강사 본인이 직접 설정한 PIN을 실사용 중이므로 전부
-- pin_confirmed=true로 시작한다(재설정 화면이 갑자기 다시 뜨면 안 된다).
-- 기존 PIN hash는 그대로 두고 평문 복원도 하지 않는다 -- 길이(6자리 vs 4자리)
-- 자체를 강제로 바꾸지 않으며, 강사가 다음에 PIN을 바꿀 때부터만 4자리 규칙이
-- 적용된다(§33 "기존 계정 자동 파괴 금지").
alter table public.instructor_profiles
  add column if not exists pin_confirmed boolean not null default true;

-- provision_instructor: 최초 PIN = 휴대전화 뒤4자리(관리자가 별도로 지정하지 않음,
-- 이미 관리자가 입력한 값이라 새로 노출되는 정보가 아니다). pin_confirmed=false로
-- 시작해 강사가 첫 로그인 후 유지/변경을 선택하게 한다.
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

  insert into public.instructor_profiles (principal_id, organization_id, phone_last4, pin_hash, pin_confirmed)
  values (
    v_principal_id, p_organization_id, p_phone_last4,
    extensions.crypt(p_phone_last4, extensions.gen_salt('bf', 10)),
    false
  );

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (p_organization_id, public.current_principal_id(), 'provision_instructor', 'principal', v_principal_id,
          jsonb_build_object('name', p_name));

  return v_principal_id;
end;
$$;

-- reset_instructor_pin: 관리자 초기화도 동일 정책 -- 뒤4자리로 되돌리고
-- pin_confirmed=false로 만들어 강사가 다시 유지/변경을 선택하게 한다.
-- 관리자는 여전히 실제 PIN 값을 조회하지 않는다(뒤4자리는 이미 아는 값).
create or replace function public.reset_instructor_pin(p_principal_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_phone_last4 text;
begin
  if not public.is_system_admin() then
    raise exception '강사 PIN을 초기화할 권한이 없습니다.';
  end if;

  select p.organization_id, ip.phone_last4 into v_org, v_phone_last4
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.id = p_principal_id and p.principal_type = 'instructor';

  if v_org is null or v_org <> public.current_organization_id() then
    raise exception '대상 강사를 찾을 수 없습니다.';
  end if;

  update public.instructor_profiles
  set pin_hash = extensions.crypt(v_phone_last4, extensions.gen_salt('bf', 10)),
      pin_confirmed = false,
      pin_failed_count = 0,
      pin_locked_until = null
  where principal_id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_org, public.current_principal_id(), 'reset_instructor_pin', 'principal', p_principal_id);
end;
$$;

-- verify_instructor_login: 응답에 pin_confirmed를 포함시켜, 로그인 성공 직후
-- 클라이언트가 "PIN 설정 선택" 화면을 보여줄지 바로 오늘 수업으로 보낼지
-- 판단할 수 있게 한다. 잠금/실패 카운트 정책(5회 실패 -> 15분 잠금)은 그대로.
-- 매개변수는 동일하지만 RETURNS TABLE 컬럼이 늘어나 CREATE OR REPLACE만으로는
-- 교체할 수 없다(Postgres: "cannot change return type of existing function") --
-- 정확한 기존 시그니처만 명시적으로 DROP한 뒤 다시 만든다(overload 누적 방지,
-- 20260910010000 마이그레이션에서 이미 겪은 문제와 동일 패턴).
drop function if exists public.verify_instructor_login(text, text, text);

create or replace function public.verify_instructor_login(p_name text, p_phone_last4 text, p_pin text)
returns table(principal_id uuid, auth_user_id uuid, organization_id uuid, pin_confirmed boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
  v_pin_hash text;
  v_pin_confirmed boolean;
  v_failed_count integer;
  v_locked_until timestamptz;
  v_ok boolean;
begin
  select p.id, p.auth_user_id, p.organization_id, ip.pin_hash, ip.pin_confirmed, ip.pin_failed_count, ip.pin_locked_until
    into v_principal_id, v_auth_user_id, v_organization_id, v_pin_hash, v_pin_confirmed, v_failed_count, v_locked_until
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4
  for update of ip;

  if v_principal_id is null then
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

    return query select v_principal_id, v_auth_user_id, v_organization_id, v_pin_confirmed;
  else
    update public.instructor_profiles
    set pin_failed_count = pin_failed_count + 1,
        pin_locked_until = case when pin_failed_count + 1 >= 5 then now() + interval '15 minutes' else pin_locked_until end
    where instructor_profiles.principal_id = v_principal_id;

    return;
  end if;
end;
$$;

-- set_instructor_pin: 6자리 -> 4자리. "이미 설정됨" 기준을 pin_hash is not null에서
-- pin_confirmed로 바꾼다 -- 이제 pin_hash는 provision 시점부터 항상 채워져 있으므로
-- (뒤4자리), 실제로 막아야 하는 것은 "이미 강사가 유지/변경을 선택했는데 다시
-- 바꾸려는 시도"이지 "PIN이 존재하는지"가 아니다.
create or replace function public.set_instructor_pin(p_name text, p_phone_last4 text, p_new_pin text)
returns table(out_principal_id uuid, out_auth_user_id uuid, out_organization_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
  v_pin_confirmed boolean;
begin
  if p_new_pin !~ '^[0-9]{4}$' then
    raise exception 'PIN은 4자리 숫자여야 합니다.';
  end if;

  select p.id, p.auth_user_id, p.organization_id, ip.pin_confirmed
    into v_principal_id, v_auth_user_id, v_organization_id, v_pin_confirmed
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4
  for update of ip;

  if v_principal_id is null then
    raise exception '계정 정보를 확인할 수 없습니다.';
  end if;
  if v_pin_confirmed then
    raise exception 'ALREADY_SET';
  end if;

  update public.instructor_profiles
  set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
      pin_confirmed = true, pin_failed_count = 0, pin_locked_until = null
  where principal_id = v_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_organization_id, v_principal_id, 'instructor_pin_set', 'principal', v_principal_id);

  out_principal_id := v_principal_id;
  out_auth_user_id := v_auth_user_id;
  out_organization_id := v_organization_id;
  return next;
end;
$$;

-- confirm_instructor_current_pin: "현재 PIN 그대로 사용" 선택. PIN 값(hash)은
-- 건드리지 않고 pin_confirmed만 true로 만들어, 다음 로그인부터 선택화면이 다시
-- 뜨지 않게 한다. instructor_login 성공 직후 흐름의 일부이므로 name+phoneLast4로만
-- 식별한다(set_instructor_pin과 동일한 신원확인 수준) -- 이 값을 true로 바꾸는 것은
-- PIN 자체를 노출하거나 변경하지 않으므로 추가 위험이 없다.
create or replace function public.confirm_instructor_current_pin(p_name text, p_phone_last4 text)
returns table(out_principal_id uuid, out_auth_user_id uuid, out_organization_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
begin
  select p.id, p.auth_user_id, p.organization_id
    into v_principal_id, v_auth_user_id, v_organization_id
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4
  for update of ip;

  if v_principal_id is null then
    raise exception '계정 정보를 확인할 수 없습니다.';
  end if;

  update public.instructor_profiles
  set pin_confirmed = true
  where principal_id = v_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_organization_id, v_principal_id, 'instructor_pin_confirmed_current', 'principal', v_principal_id);

  out_principal_id := v_principal_id;
  out_auth_user_id := v_auth_user_id;
  out_organization_id := v_organization_id;
  return next;
end;
$$;
