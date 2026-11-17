-- WellLink v1.0 Core Setup Model Simplification — Setup UX Closure.
-- 운영 연도/단위사업/대분류/중분류/Activity를 실사용 중 잘못 입력했을 때
-- DB 관리자 없이 스스로 고칠 수 있는 최소 CRUD를 추가한다. 전부 신규
-- forward migration이며 과거 migration은 건드리지 않는다. cascade로 업무
-- 데이터를 지우는 경로는 만들지 않는다 -- 하위 데이터가 하나라도 있으면
-- 수정/삭제 자체를 차단한다.

-- ============================================================
-- 1. 운영 연도 수정/삭제
-- ============================================================

create function public.update_business_year(p_id uuid, p_year integer)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before integer;
  v_has_data boolean;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '운영 연도를 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select year into v_before from public.business_years where id = p_id and organization_id = v_org;
  if not found then
    raise exception '운영 연도를 찾을 수 없습니다.';
  end if;
  if p_year is null or p_year < 2000 or p_year > 2200 then
    raise exception '연도 값이 올바르지 않습니다.';
  end if;

  select exists (
    select 1 from public.business_nodes where business_year_id = p_id
    union all select 1 from public.unit_businesses where business_year_id = p_id
    union all select 1 from public.activities where business_year_id = p_id
    union all select 1 from public.operation_terms where business_year_id = p_id
    union all select 1 from public.annual_plans where business_year_id = p_id
    union all select 1 from public.performance_records where business_year_id = p_id
    union all select 1 from public.ai_evaluations where business_year_id = p_id
    union all select 1 from public.operation_cycles where business_year_id = p_id
  ) into v_has_data;

  if v_has_data then
    raise exception '등록된 사업·활동 또는 운영 데이터가 있어 이 연도를 수정할 수 없습니다.';
  end if;

  update public.business_years set year = p_year where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_business_year', 'business_year', p_id,
    jsonb_build_object('year', v_before), jsonb_build_object('year', p_year));
end;
$$;

create function public.delete_business_year(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before integer;
  v_has_data boolean;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '운영 연도를 삭제할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select year into v_before from public.business_years where id = p_id and organization_id = v_org;
  if not found then
    raise exception '운영 연도를 찾을 수 없습니다.';
  end if;

  select exists (
    select 1 from public.business_nodes where business_year_id = p_id
    union all select 1 from public.unit_businesses where business_year_id = p_id
    union all select 1 from public.activities where business_year_id = p_id
    union all select 1 from public.operation_terms where business_year_id = p_id
    union all select 1 from public.annual_plans where business_year_id = p_id
    union all select 1 from public.performance_records where business_year_id = p_id
    union all select 1 from public.ai_evaluations where business_year_id = p_id
    union all select 1 from public.operation_cycles where business_year_id = p_id
  ) into v_has_data;

  if v_has_data then
    raise exception '등록된 사업·활동 또는 운영 데이터가 있어 이 연도를 삭제할 수 없습니다.';
  end if;

  delete from public.business_years where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json)
  values (v_org, public.current_principal_id(), 'delete_business_year', 'business_year', p_id,
    jsonb_build_object('year', v_before));
end;
$$;

-- ============================================================
-- 2. 단위사업 수정/삭제
-- ============================================================

create function public.update_unit_business(p_id uuid, p_name text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before text;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '단위사업을 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;

  select name into v_before from public.unit_businesses where id = p_id and organization_id = v_org;
  if not found then
    raise exception '단위사업을 찾을 수 없습니다.';
  end if;

  update public.unit_businesses set name = trim(p_name) where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_unit_business', 'unit_business', p_id,
    jsonb_build_object('name', v_before), jsonb_build_object('name', trim(p_name)));
end;
$$;

create function public.delete_unit_business(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before text;
  v_has_data boolean;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '단위사업을 삭제할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select name into v_before from public.unit_businesses where id = p_id and organization_id = v_org;
  if not found then
    raise exception '단위사업을 찾을 수 없습니다.';
  end if;

  select exists (
    select 1 from public.activities where unit_business_id = p_id
    union all select 1 from public.ai_evaluations where unit_business_id = p_id
  ) into v_has_data;

  if v_has_data then
    raise exception '연결된 활동 또는 평가 데이터가 있어 이 단위사업을 삭제할 수 없습니다.';
  end if;

  delete from public.unit_businesses where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json)
  values (v_org, public.current_principal_id(), 'delete_unit_business', 'unit_business', p_id,
    jsonb_build_object('name', v_before));
end;
$$;

-- ============================================================
-- 3. 대분류/중분류(business_nodes) 삭제 — 빈 노드만
-- ============================================================

create function public.delete_business_node(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before record;
  v_has_children boolean;
  v_has_activities boolean;
  v_has_scopes boolean;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '사업구조를 삭제할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select name, node_type into v_before from public.business_nodes where id = p_id and organization_id = v_org;
  if not found then
    raise exception '사업구조를 찾을 수 없습니다.';
  end if;

  select exists (select 1 from public.business_nodes where parent_id = p_id) into v_has_children;
  select exists (select 1 from public.activities where business_node_id = p_id) into v_has_activities;
  select exists (select 1 from public.department_manager_scopes where business_node_id = p_id) into v_has_scopes;

  if v_has_children then
    raise exception '하위 중분류가 있어 삭제할 수 없습니다.';
  end if;
  if v_has_activities then
    raise exception '연결된 활동이 있어 삭제할 수 없습니다.';
  end if;
  if v_has_scopes then
    raise exception '이 사업구조를 관리범위로 지정한 부서관리자가 있어 삭제할 수 없습니다.';
  end if;

  delete from public.business_nodes where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json)
  values (v_org, public.current_principal_id(), 'delete_business_node', 'business_node', p_id,
    jsonb_build_object('name', v_before.name, 'node_type', v_before.node_type));
end;
$$;

-- ============================================================
-- 4. Activity 삭제 — 업무데이터가 전혀 없는 신규 Activity만
-- ============================================================

create function public.delete_activity(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before text;
  v_program_id uuid;
  v_has_data boolean;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '활동을 삭제할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select name into v_before from public.activities where id = p_id and organization_id = v_org;
  if not found then
    raise exception '활동을 찾을 수 없습니다.';
  end if;

  select id into v_program_id from public.programs where activity_id = p_id;

  select exists (
    select 1 from public.annual_plans where activity_id = p_id
    union all select 1 from public.performance_records where activity_id = p_id
    union all select 1 from public.activity_assignments where activity_id = p_id
    union all select 1 from public.operation_terms where program_id = v_program_id
  ) into v_has_data;

  if v_has_data then
    raise exception '연결된 운영·실적·담당자 데이터가 있어 이 활동을 삭제할 수 없습니다.';
  end if;

  delete from public.programs where id = v_program_id;
  delete from public.activities where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json)
  values (v_org, public.current_principal_id(), 'delete_activity', 'activity', p_id,
    jsonb_build_object('name', v_before));
end;
$$;
