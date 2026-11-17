-- 웰링크(WellLink) v1.0 Pre-Final Gate: 직원 계정 lifecycle + 강사 PIN lifecycle + Audit gap 보완.
--
-- 새로운 제품기획이 아니다. Scope Lock v2가 "실사용에 필요한 기능"으로 이미 확정한
-- 사용자관리(직원 계정 생성/비활성화/권한변경/비밀번호 초기화, 강사 계정 생성/PIN
-- lifecycle)를 이번에 처음으로 실제 구현한다 -- settings.users.tsx는 지금까지
-- 100% Mock(settings-mock.ts)이었고 이를 뒷받침하는 RPC가 전혀 없었다.
--
-- 복잡한 HR/조직관리(부서·직위 트리)는 이번 Gate 범위가 아니다(departments/positions
-- 테이블은 어떤 이전 migration에서도 만들어진 적이 없음을 직접 확인했다) -- 실제
-- staff_profiles 스키마(Batch 0)에 이미 있는 필드(business_role, is_system_admin,
-- must_change_password)만 사용한다.

-- ============================================================
-- 1. 직원(Staff) Lifecycle
-- ============================================================

-- Auth 계정(auth_user_id)은 server function이 Admin API로 먼저 만든 뒤 이 RPC에
-- 넘긴다(강사 provisioning과 동일 패턴). 임시비밀번호 원문은 이 RPC도, 이 RPC를
-- 호출하는 server function도 어디에도 저장하지 않는다 -- 호출자에게 한 번 반환되고
-- 끝난다.
create function public.provision_staff(
  p_organization_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_business_role business_role,
  p_is_system_admin boolean
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
begin
  if not public.is_system_admin() then
    raise exception '직원 계정을 생성할 권한이 없습니다.';
  end if;
  if p_organization_id is distinct from public.current_organization_id() then
    raise exception '다른 조직에 직원 계정을 생성할 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;

  -- server function 재시도로 같은 auth_user_id가 다시 들어와도 중복 생성하지 않는다.
  select id into v_principal_id from public.principals where auth_user_id = p_auth_user_id;
  if v_principal_id is not null then
    return v_principal_id;
  end if;

  insert into public.principals (organization_id, auth_user_id, principal_type, name)
  values (p_organization_id, p_auth_user_id, 'staff', trim(p_name))
  returning id into v_principal_id;

  insert into public.staff_profiles (principal_id, business_role, is_system_admin, must_change_password)
  values (v_principal_id, p_business_role, p_is_system_admin, true);

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (
    p_organization_id, public.current_principal_id(), 'provision_staff', 'principal', v_principal_id,
    jsonb_build_object('name', p_name, 'business_role', p_business_role, 'is_system_admin', p_is_system_admin)
  );

  return v_principal_id;
end;
$$;

create function public.list_staff_accounts()
returns table (
  out_principal_id uuid,
  out_name text,
  out_email text,
  out_business_role business_role,
  out_is_system_admin boolean,
  out_is_active boolean,
  out_must_change_password boolean,
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
    raise exception '직원 목록을 조회할 권한이 없습니다.';
  end if;

  for v_row in
    select p.id, p.name, au.email, sp.business_role, sp.is_system_admin, p.is_active,
           sp.must_change_password, p.created_at
    from public.principals p
    join public.staff_profiles sp on sp.principal_id = p.id
    left join auth.users au on au.id = p.auth_user_id
    where p.organization_id = public.current_organization_id() and p.principal_type = 'staff'
    order by p.created_at
  loop
    out_principal_id := v_row.id;
    out_name := v_row.name;
    out_email := v_row.email;
    out_business_role := v_row.business_role;
    out_is_system_admin := v_row.is_system_admin;
    out_is_active := v_row.is_active;
    out_must_change_password := v_row.must_change_password;
    out_created_at := v_row.created_at;
    return next;
  end loop;
end;
$$;

create function public.update_staff_role(
  p_principal_id uuid,
  p_business_role business_role,
  p_is_system_admin boolean,
  p_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_before record;
  v_org uuid;
begin
  if not public.is_system_admin() then
    raise exception '직원 권한을 변경할 권한이 없습니다.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception '변경사유를 입력해 주세요.';
  end if;

  select sp.business_role, sp.is_system_admin, p.organization_id
    into v_before
  from public.staff_profiles sp
  join public.principals p on p.id = sp.principal_id
  where sp.principal_id = p_principal_id;

  if v_before.organization_id is null or v_before.organization_id <> public.current_organization_id() then
    raise exception '대상 직원을 찾을 수 없습니다.';
  end if;

  update public.staff_profiles
  set business_role = p_business_role, is_system_admin = p_is_system_admin
  where principal_id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json, reason)
  values (
    v_before.organization_id, public.current_principal_id(), 'update_staff_role', 'principal', p_principal_id,
    jsonb_build_object('business_role', v_before.business_role, 'is_system_admin', v_before.is_system_admin),
    jsonb_build_object('business_role', p_business_role, 'is_system_admin', p_is_system_admin),
    p_reason
  );
end;
$$;

create function public.set_staff_active(p_principal_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before boolean;
begin
  if not public.is_system_admin() then
    raise exception '직원 계정 상태를 변경할 권한이 없습니다.';
  end if;
  if p_principal_id = public.current_principal_id() then
    raise exception '본인 계정은 이 화면에서 비활성화할 수 없습니다.';
  end if;

  select organization_id, is_active into v_org, v_before
  from public.principals where id = p_principal_id and principal_type = 'staff';

  if v_org is null or v_org <> public.current_organization_id() then
    raise exception '대상 직원을 찾을 수 없습니다.';
  end if;

  update public.principals set is_active = p_is_active where id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (
    v_org, public.current_principal_id(), 'set_staff_active', 'principal', p_principal_id,
    jsonb_build_object('is_active', v_before), jsonb_build_object('is_active', p_is_active)
  );
end;
$$;

-- 비밀번호 초기화: 새 임시비밀번호 자체는 server function이 Auth Admin API로 별도
-- 발급한다. 이 RPC는 must_change_password 플래그만 세우고 Audit을 남긴다 -- 비밀번호
-- 원문은 이 함수의 인자에도 전혀 등장하지 않는다.
create function public.mark_staff_password_reset(p_principal_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  if not public.is_system_admin() then
    raise exception '직원 비밀번호를 초기화할 권한이 없습니다.';
  end if;

  select p.organization_id into v_org
  from public.principals p where p.id = p_principal_id and p.principal_type = 'staff';

  if v_org is null or v_org <> public.current_organization_id() then
    raise exception '대상 직원을 찾을 수 없습니다.';
  end if;

  update public.staff_profiles set must_change_password = true where principal_id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_org, public.current_principal_id(), 'reset_staff_password', 'principal', p_principal_id);
end;
$$;

-- 본인 비밀번호 변경 완료(강제 변경 화면에서 supabase.auth.updateUser로 비밀번호를
-- 바꾼 "이후" 호출). 관리자 권한 불필요 -- 항상 현재 로그인 계정 본인 것만 바꾼다.
create function public.clear_must_change_password()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
  v_org uuid;
begin
  v_principal_id := public.current_principal_id();
  if v_principal_id is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select organization_id into v_org from public.principals where id = v_principal_id;

  update public.staff_profiles set must_change_password = false where principal_id = v_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_org, v_principal_id, 'staff_password_changed', 'principal', v_principal_id);
end;
$$;

-- ============================================================
-- 2. 강사(Instructor) PIN Lifecycle -- 관리자가 PIN을 지정하지 않도록 재설계.
-- ============================================================

drop function if exists public.provision_instructor(uuid, uuid, text, text, text);

-- p_pin 파라미터를 완전히 제거한다. 생성 직후 pin_hash는 NULL(미설정) 상태이며,
-- 강사가 최초 접속 때 본인이 직접 설정한다(§3의 set_instructor_pin).
create function public.provision_instructor(
  p_organization_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_phone_last4 text
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

  -- pin_hash는 의도적으로 넣지 않는다(컬럼 기본값 NULL 그대로) -- 관리자는 PIN을
  -- 지정하지 않는다.
  insert into public.instructor_profiles (principal_id, organization_id, phone_last4)
  values (v_principal_id, p_organization_id, p_phone_last4);

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (p_organization_id, public.current_principal_id(), 'provision_instructor', 'principal', v_principal_id,
          jsonb_build_object('name', p_name));

  return v_principal_id;
end;
$$;

-- 로그인 화면이 "PIN 입력" 또는 "PIN 설정" 중 어느 화면을 보여줄지 결정하기 위한
-- 사전조회. verify_instructor_login과 동일하게 service_role 전용이며, 존재하지
-- 않는 계정은 빈 결과(예외 아님)로 응답해 verify_instructor_login과 동일한 방식으로
-- 처리한다.
create function public.begin_instructor_login(p_name text, p_phone_last4 text)
returns table (principal_id uuid, needs_pin_setup boolean, is_locked boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
  v_pin_hash text;
  v_locked_until timestamptz;
begin
  select p.id, ip.pin_hash, ip.pin_locked_until
    into v_principal_id, v_pin_hash, v_locked_until
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4;

  if v_principal_id is null then
    return;
  end if;

  principal_id := v_principal_id;
  needs_pin_setup := v_pin_hash is null;
  is_locked := v_locked_until is not null and v_locked_until > now();
  return next;
end;
$$;

revoke execute on function public.begin_instructor_login(text, text) from public, anon, authenticated;
grant execute on function public.begin_instructor_login(text, text) to service_role;

-- 최초 접속(또는 관리자 초기화 후) PIN 설정. pin_hash가 NULL일 때만 동작한다 --
-- 이미 설정된 PIN을 이 경로로 덮어쓸 수 없다(그건 관리자 reset_instructor_pin을
-- 거쳐야 한다).
create function public.set_instructor_pin(p_name text, p_phone_last4 text, p_new_pin text)
returns table (out_principal_id uuid, out_auth_user_id uuid, out_organization_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
  v_pin_hash text;
begin
  if p_new_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN은 6자리 숫자여야 합니다.';
  end if;

  select p.id, p.auth_user_id, p.organization_id, ip.pin_hash
    into v_principal_id, v_auth_user_id, v_organization_id, v_pin_hash
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
  if v_pin_hash is not null then
    raise exception 'ALREADY_SET';
  end if;

  update public.instructor_profiles
  set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
      pin_failed_count = 0, pin_locked_until = null
  where principal_id = v_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_organization_id, v_principal_id, 'instructor_pin_set', 'principal', v_principal_id);

  out_principal_id := v_principal_id;
  out_auth_user_id := v_auth_user_id;
  out_organization_id := v_organization_id;
  return next;
end;
$$;

revoke execute on function public.set_instructor_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.set_instructor_pin(text, text, text) to service_role;

create function public.reset_instructor_pin(p_principal_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  if not public.is_system_admin() then
    raise exception '강사 PIN을 초기화할 권한이 없습니다.';
  end if;

  select p.organization_id into v_org
  from public.principals p where p.id = p_principal_id and p.principal_type = 'instructor';

  if v_org is null or v_org <> public.current_organization_id() then
    raise exception '대상 강사를 찾을 수 없습니다.';
  end if;

  update public.instructor_profiles
  set pin_hash = null, pin_failed_count = 0, pin_locked_until = null
  where principal_id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_org, public.current_principal_id(), 'reset_instructor_pin', 'principal', p_principal_id);
end;
$$;

create function public.set_instructor_active(p_principal_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before boolean;
begin
  if not public.is_system_admin() then
    raise exception '강사 계정 상태를 변경할 권한이 없습니다.';
  end if;

  select organization_id, is_active into v_org, v_before
  from public.principals where id = p_principal_id and principal_type = 'instructor';

  if v_org is null or v_org <> public.current_organization_id() then
    raise exception '대상 강사를 찾을 수 없습니다.';
  end if;

  update public.principals set is_active = p_is_active where id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (
    v_org, public.current_principal_id(), 'set_instructor_active', 'principal', p_principal_id,
    jsonb_build_object('is_active', v_before), jsonb_build_object('is_active', p_is_active)
  );
end;
$$;

-- 관리자용 강사 목록: pin_hash는 절대 노출하지 않고 안전한 상태값만 반환한다
-- (Batch 0의 instructor_profiles RLS 설계 의도를 그대로 따른다).
create function public.list_instructor_accounts()
returns table (
  out_principal_id uuid,
  out_name text,
  out_phone_last4 text,
  out_is_active boolean,
  out_pin_set boolean,
  out_pin_locked boolean,
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
    out_created_at := v_row.created_at;
    return next;
  end loop;
end;
$$;

-- ============================================================
-- 3. Audit Gap 보완: 수강 종결(terminate_enrollments)에 Audit 기록 추가.
-- ============================================================

drop function if exists public.terminate_enrollments(uuid[]);

create function public.terminate_enrollments(p_enrollment_ids uuid[])
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_enrollment record;
  v_activity_id uuid;
  v_organization_id uuid;
  v_next_session_no integer;
  v_count integer := 0;
begin
  for v_enrollment in
    select e.id, e.operation_term_id from public.enrollments e where e.id = any (p_enrollment_ids)
  loop
    select a.id, a.organization_id into v_activity_id, v_organization_id
    from public.operation_terms ot
    join public.programs p on p.id = ot.program_id
    join public.activities a on a.id = p.activity_id
    where ot.id = v_enrollment.operation_term_id;

    if not public.can_manage_activity(v_activity_id) then
      raise exception '수강 종결 권한이 없습니다(enrollment %).', v_enrollment.id;
    end if;

    select min(session_no) into v_next_session_no
    from public.sessions
    where operation_term_id = v_enrollment.operation_term_id and status = 'scheduled' and starts_at > now();

    update public.enrollments
    set end_session_no_exclusive = coalesce(v_next_session_no, 2147483647),
        ended_at = now(),
        ended_by = public.current_principal_id()
    where id = v_enrollment.id and end_session_no_exclusive is null;

    if found then
      v_count := v_count + 1;
      insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
      values (v_organization_id, public.current_principal_id(), 'terminate_enrollment', 'enrollment', v_enrollment.id,
              jsonb_build_object('end_session_no_exclusive', coalesce(v_next_session_no, 2147483647)));
    end if;
  end loop;

  return v_count;
end;
$$;
