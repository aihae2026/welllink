-- WellLink v1.0 Final Batch A — Core Setup Model Simplification.
-- 실제 사용자 QA 결과, 사업구조를 4단계(대/중/소분류 + Activity)로 유지하는 것이
-- 사용자에게 과도하게 복잡하다는 것이 확인됐다. 실제 출석/실적/연간계획 데이터가
-- 본격적으로 쌓이기 전인 지금을 구조 단순화의 마지막 적절한 시점으로 보고,
-- business_nodes의 minor 단계를 사용 중단하고 활동(activities)이 최종 소분류
-- leaf 역할을 겸하도록 collapse한다. activities table 자체나 그 FK는 건드리지
-- 않는다(§ Design Lock: Activity가 담당자/권한/실적/연간계획의 Source of Truth).
--
-- 최종 구조: unit_business / business_node(major) / business_node(middle) / activity
-- (기존 minor 단계 제거, 기존 minor node의 id는 그대로 middle로 승격되어
--  activities.business_node_id는 단 하나도 값이 바뀌지 않는다)

-- ============================================================
-- 1. 사업구조 계층 collapse (major->중복 제거, middle->major 승격, minor->middle 승격)
-- ============================================================

create function public._migrate_collapse_business_hierarchy(p_organization_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_major record;
begin
  -- 이미 minor가 없는 조직(신규 조직, 또는 사업구조가 아직 없는 조직)은 건드리지
  -- 않는다 -- idempotent skip.
  if not exists (
    select 1 from public.business_nodes
    where organization_id = p_organization_id and node_type = 'minor'
  ) then
    return;
  end if;

  if (
    select count(*) from public.business_nodes
    where organization_id = p_organization_id and node_type = 'major'
  ) <> 1 then
    raise exception 'org % 는 major 노드가 정확히 1개가 아니어서 자동 collapse 대상이 아닙니다 -- 수동 확인이 필요합니다.', p_organization_id;
  end if;

  select * into v_major from public.business_nodes
  where organization_id = p_organization_id and node_type = 'major';

  -- 이 major 노드에 직접 연결된 activity가 있으면(=활동이 대분류 바로 아래
  -- 붙어 있으면) 이 major를 삭제할 수 없다 -- 안전하게 자동 변환 불가.
  if exists (select 1 from public.activities where business_node_id = v_major.id) then
    raise exception 'org % 의 major 노드에 직접 연결된 activity가 있어 자동 collapse할 수 없습니다.', p_organization_id;
  end if;

  -- 기존 middle -> major로 승격 (parent 제거). id는 그대로 유지되므로 이 노드를
  -- 가리키는 department_manager_scopes 등 참조는 전혀 바뀌지 않는다.
  update public.business_nodes
  set node_type = 'major', parent_id = null
  where organization_id = p_organization_id and parent_id = v_major.id and node_type = 'middle';

  -- 기존 minor -> middle로 승격. parent_id는 그대로 유지한다(이제 major가 된
  -- 노드를 그대로 가리킴). activities.business_node_id도 전혀 바뀌지 않는다.
  -- 만약 어떤 minor의 부모가 방금 major로 승격되지 않은 노드라면(예상 밖 구조),
  -- validate_business_node_hierarchy 트리거가 여기서 자동으로 예외를 던진다.
  update public.business_nodes
  set node_type = 'middle'
  where organization_id = p_organization_id and node_type = 'minor';

  -- 기존 최상위 major는 이제 자식이 전혀 없어야 한다(모두 승격됨). 자식이
  -- 남아 있으면(예상 밖 구조) 삭제하지 않고 예외를 던진다.
  if exists (select 1 from public.business_nodes where parent_id = v_major.id) then
    raise exception 'org % 의 기존 major 노드에 여전히 자식이 남아 있어 삭제할 수 없습니다.', p_organization_id;
  end if;

  delete from public.business_nodes where id = v_major.id;
end;
$$;

do $$
declare
  v_org record;
begin
  for v_org in select id from public.organizations loop
    perform public._migrate_collapse_business_hierarchy(v_org.id);
  end loop;
end;
$$;

drop function public._migrate_collapse_business_hierarchy(uuid);

-- ============================================================
-- 2. 신규 사업구조 생성 시 minor 단계 재도입 차단
--    (기존 enum 값 자체는 과거 migration 호환을 위해 남겨둔다 -- DB에는 이제
--     minor 타입 row가 0건이지만 타입은 유지)
-- ============================================================

create or replace function public.create_business_node(
  p_business_year_id uuid,
  p_parent_id uuid,
  p_node_type business_node_type,
  p_name text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_id uuid;
  v_year_org uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '사업구조를 추가할 권한이 없습니다.';
  end if;
  if p_node_type = 'minor' then
    raise exception '소분류(minor) 단계는 더 이상 사용하지 않습니다. 대분류 또는 중분류만 생성할 수 있습니다.';
  end if;
  v_org := public.current_organization_id();

  select organization_id into v_year_org from public.business_years where id = p_business_year_id;
  if v_year_org is null or v_year_org <> v_org then
    raise exception '연도를 찾을 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;

  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name)
  values (v_org, p_business_year_id, p_parent_id, p_node_type, trim(p_name))
  returning id into v_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_business_node', 'business_node', v_id,
    jsonb_build_object('name', p_name, 'node_type', p_node_type));

  return v_id;
end;
$$;

-- ============================================================
-- 3. 활동 담당자 복수 배정: Activity 1개 <-> 담당자 여러 명 (many-to-many).
--    activity_assignments 테이블/history 구조는 그대로 유지하고, "현재 담당자
--    유일성" 제약만 (activity_id) 단독에서 (activity_id, staff_principal_id)
--    조합으로 완화한다 -- 같은 직원이 같은 활동에 중복 current assignment를
--    가질 수는 없지만, 서로 다른 직원은 같은 활동에 동시에 current일 수 있다.
-- ============================================================

drop index if exists public.activity_assignments_current_unique;

create unique index activity_assignments_current_unique
  on public.activity_assignments (activity_id, staff_principal_id)
  where effective_to is null;

-- 기존 assign_activity는 배정 시 그 활동의 다른 모든 현재 담당자를 자동
-- 해제했다(1인 담당 전제). 복수담당 모델에서는 특정 (activity, staff) 조합만
-- 다루고 다른 직원의 배정에는 관여하지 않는다. 이미 현재 담당이면 그대로
-- idempotent 반환.
create or replace function public.assign_activity(p_activity_id uuid, p_staff_principal_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_existing_id uuid;
  v_new_id uuid;
begin
  if not public.can_manage_activity(p_activity_id) then
    raise exception '이 활동의 담당자를 배정할 권한이 없습니다.';
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

-- 특정 (activity, staff) 조합의 현재 배정만 해제한다. 같은 활동의 다른 담당자
-- 배정에는 영향을 주지 않는다.
create function public.unassign_activity(p_activity_id uuid, p_staff_principal_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.can_manage_activity(p_activity_id) then
    raise exception '이 활동의 담당자를 해제할 권한이 없습니다.';
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

-- can_read_activity / can_manage_activity의 staff 분기는 이미 "이 직원이 이
-- 활동에 current assignment를 갖는가"만 확인하므로(다른 직원의 배정 존재
-- 여부와 무관), 복수담당 모델에서도 수정 없이 그대로 올바르게 동작한다.
