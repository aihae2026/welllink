-- WellLink v1.0 — Manual QA Gap Fix #2: Staff Collaboration Model + 직원 정보 수정.
--
-- 1) 담당자 배정 = "업무 책임 표시"로 정의를 확정한다. 담당 여부를 업무데이터
--    조회/수정 권한의 기준으로 더 이상 쓰지 않는다 -- canonical 일반 직원(staff
--    role)은 같은 organization의 업무 Activity 전체를 조회/수정할 수 있다.
--    activity_assignments 테이블/RPC(assign_activity/unassign_activity)는 그대로
--    유지한다(주 담당자 표시 목적) -- 다만 그 두 RPC의 "누가 배정을 바꿀 수
--    있는가"는 can_manage_activity()에서 분리해 global_manager 전용으로
--    고정한다(§9 최종 정책).
--
-- can_read_activity/can_manage_activity는 이 코드베이스 전역(Program/Attendance/
-- AnnualPlan/Performance/AI Evaluation/Enrollment 등)의 Permission Source of
-- Truth이므로, 이 두 함수만 고치면 나머지 화면/RPC/RLS 정책은 전수 수정할
-- 필요가 없다(이미 전부 이 두 함수를 통해서만 권한을 검사하도록 되어 있음을
-- 전수 검색으로 확인했다). department_manager/global_viewer의 기존 동작은
-- 건드리지 않는다 -- 이번 v1.0 정책 대상은 canonical "일반"(staff)뿐이다.
create or replace function public.can_read_activity(p_activity_id uuid)
returns boolean
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_org uuid;
  v_activity_org uuid;
  v_role business_role;
  v_principal uuid;
  v_node_id uuid;
begin
  v_org := public.current_organization_id();
  if v_org is null then return false; end if;

  select organization_id, business_node_id into v_activity_org, v_node_id
  from public.activities where id = p_activity_id;

  if v_activity_org is null or v_activity_org <> v_org then
    return false;
  end if;

  v_role := public.current_business_role();
  v_principal := public.current_principal_id();

  if v_role in ('global_manager', 'global_viewer') then
    return true;
  end if;

  if v_role = 'department_manager' then
    return exists (
      select 1 from public.department_manager_scopes dms
      where dms.principal_id = v_principal
        and dms.business_node_id in (
          with recursive ancestors as (
            select id from public.business_nodes where id = v_node_id
            union all
            select bn.parent_id from public.business_nodes bn
            join ancestors a on bn.id = a.id
            where bn.parent_id is not null
          )
          select id from ancestors
        )
    );
  end if;

  -- canonical 일반 직원: 담당 여부와 무관하게 같은 organization 업무는 전부
  -- 조회 가능(organization isolation은 위에서 이미 강제됨).
  if v_role = 'staff' then
    return true;
  end if;

  return false;
end;
$$;

create or replace function public.can_manage_activity(p_activity_id uuid)
returns boolean
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_org uuid;
  v_activity_org uuid;
  v_role business_role;
  v_principal uuid;
  v_node_id uuid;
begin
  v_org := public.current_organization_id();
  if v_org is null then return false; end if;

  select organization_id, business_node_id into v_activity_org, v_node_id
  from public.activities where id = p_activity_id;

  if v_activity_org is null or v_activity_org <> v_org then
    return false;
  end if;

  v_role := public.current_business_role();
  v_principal := public.current_principal_id();

  if v_role = 'global_manager' then
    return true;
  end if;

  if v_role = 'global_viewer' then
    return false;
  end if;

  if v_role = 'department_manager' then
    return exists (
      select 1 from public.department_manager_scopes dms
      where dms.principal_id = v_principal
        and dms.business_node_id in (
          with recursive ancestors as (
            select id from public.business_nodes where id = v_node_id
            union all
            select bn.parent_id from public.business_nodes bn
            join ancestors a on bn.id = a.id
            where bn.parent_id is not null
          )
          select id from ancestors
        )
    );
  end if;

  -- canonical 일반 직원: 담당 여부와 무관하게 같은 organization 업무를 전부
  -- 수정 가능. "담당자 배정" 자체를 바꾸는 권한은 여기서 분리되어
  -- assign_activity/unassign_activity가 이 함수를 더 이상 쓰지 않는다(아래).
  if v_role = 'staff' then
    return true;
  end if;

  return false;
end;
$$;

-- ============================================================
-- 담당자 배정 자체의 변경 권한을 can_manage_activity에서 분리해 global_manager
-- 전용으로 고정한다(§9). can_manage_activity가 위에서 staff에게 true를 반환하게
-- 됐으므로, 이 두 함수가 계속 can_manage_activity를 쓰면 일반 직원도 담당자를
-- 바꿀 수 있게 되어버린다 -- "책임 표시"라는 조직관리 정보는 관리자만 통제한다는
-- 정책을 지키기 위해 직접 role 체크로 바꾸고, org isolation은 활동 조회로
-- 명시적으로 다시 검증한다(기존에는 can_manage_activity가 이 역할을 겸했다).
create or replace function public.assign_activity(p_activity_id uuid, p_staff_principal_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_org uuid;
  v_existing_id uuid;
  v_new_id uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '이 활동의 담당자를 배정할 권한이 없습니다.';
  end if;

  select organization_id into v_activity_org from public.activities where id = p_activity_id;
  if v_activity_org is null or v_activity_org <> public.current_organization_id() then
    raise exception '활동을 찾을 수 없습니다.';
  end if;

  select id into v_existing_id from public.activity_assignments
  where activity_id = p_activity_id and staff_principal_id = p_staff_principal_id and effective_to is null;

  if v_existing_id is not null then
    return v_existing_id;
  end if;

  insert into public.activity_assignments (organization_id, activity_id, staff_principal_id, created_by)
  values (public.current_organization_id(), p_activity_id, p_staff_principal_id, public.current_principal_id())
  returning id into v_new_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (public.current_organization_id(), public.current_principal_id(), 'assign_activity', 'activity_assignment', v_new_id,
    jsonb_build_object('activity_id', p_activity_id, 'staff_principal_id', p_staff_principal_id));

  return v_new_id;
end;
$$;

create or replace function public.unassign_activity(p_activity_id uuid, p_staff_principal_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_org uuid;
  v_id uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '이 활동의 담당자를 해제할 권한이 없습니다.';
  end if;

  select organization_id into v_activity_org from public.activities where id = p_activity_id;
  if v_activity_org is null or v_activity_org <> public.current_organization_id() then
    raise exception '활동을 찾을 수 없습니다.';
  end if;

  update public.activity_assignments
  set effective_to = now()
  where activity_id = p_activity_id
    and staff_principal_id = p_staff_principal_id
    and effective_to is null
  returning id into v_id;

  if v_id is null then
    raise exception '현재 이 직원이 담당 중인 활동이 아닙니다.';
  end if;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json)
  values (public.current_organization_id(), public.current_principal_id(), 'unassign_activity', 'activity_assignment', v_id,
    jsonb_build_object('activity_id', p_activity_id, 'staff_principal_id', p_staff_principal_id));
end;
$$;

-- ============================================================
-- 직원 이름 수정. 이메일은 auth.users가 유일한 source of truth라 여기서
-- 다루지 않는다(server function이 Auth Admin API로 직접 처리).
-- ============================================================
create function public.update_staff_info(p_principal_id uuid, p_name text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before text;
begin
  if not public.is_system_admin() then
    raise exception '직원 정보를 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;

  select name into v_before from public.principals
  where id = p_principal_id and organization_id = v_org and principal_type = 'staff';
  if not found then
    raise exception '대상 직원을 찾을 수 없습니다.';
  end if;

  update public.principals set name = trim(p_name) where id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_staff_info', 'principal', p_principal_id,
    jsonb_build_object('name', v_before), jsonb_build_object('name', trim(p_name)));
end;
$$;
