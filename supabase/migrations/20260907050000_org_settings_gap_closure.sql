-- WellLink v1.0 Final Batch A — 운영 UX Gap Closure.
-- 실사용 QA에서 "새 사업/Activity/연도를 어디서 등록하는지 경로가 없다",
-- "조직구조를 어디서 관리하는지 없다", "변경이력을 raw하게밖에 못 본다"는 문제를
-- 닫는다. 새 제품기획이 아니라 이미 있는 business_years/business_nodes/
-- unit_businesses/activities/programs/audit_logs를 실제로 관리할 수 있는
-- 최소 RPC를 추가하는 것이다.

-- ============================================================
-- 1. 연도 추가
-- ============================================================
create function public.create_business_year(p_year integer)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '연도를 추가할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_year is null or p_year < 2000 or p_year > 2200 then
    raise exception '연도 값이 올바르지 않습니다.';
  end if;

  insert into public.business_years (organization_id, year, status)
  values (v_org, p_year, 'active')
  returning id into v_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_business_year', 'business_year', v_id, jsonb_build_object('year', p_year));

  return v_id;
end;
$$;

-- ============================================================
-- 2. 사업구조(대/중/소분류) 추가
-- ============================================================
create function public.create_business_node(
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

create function public.update_business_node(p_id uuid, p_name text, p_is_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before record;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '사업구조를 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select name, is_active into v_before from public.business_nodes where id = p_id and organization_id = v_org;
  if not found then
    raise exception '사업구조를 찾을 수 없습니다.';
  end if;

  update public.business_nodes set name = coalesce(trim(p_name), name), is_active = p_is_active where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_business_node', 'business_node', p_id,
    jsonb_build_object('name', v_before.name, 'is_active', v_before.is_active),
    jsonb_build_object('name', p_name, 'is_active', p_is_active));
end;
$$;

-- ============================================================
-- 3. Activity + Program 동시 생성 (1 Activity = 1 Program 원칙)
-- ============================================================
create function public.create_activity_with_program(
  p_business_year_id uuid,
  p_business_node_id uuid,
  p_unit_business_id uuid,
  p_name text,
  p_default_performance_method performance_method
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_activity_id uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '활동을 추가할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;

  insert into public.activities (
    organization_id, business_year_id, business_node_id, unit_business_id, name, default_performance_method
  )
  values (v_org, p_business_year_id, p_business_node_id, p_unit_business_id, trim(p_name), p_default_performance_method)
  returning id into v_activity_id;

  insert into public.programs (organization_id, activity_id, name)
  values (v_org, v_activity_id, trim(p_name));

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_activity_with_program', 'activity', v_activity_id,
    jsonb_build_object('name', p_name, 'default_performance_method', p_default_performance_method));

  return v_activity_id;
end;
$$;

create function public.update_activity(p_id uuid, p_name text, p_is_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before record;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '활동을 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select name, is_active into v_before from public.activities where id = p_id and organization_id = v_org;
  if not found then
    raise exception '활동을 찾을 수 없습니다.';
  end if;

  update public.activities set name = coalesce(trim(p_name), name), is_active = p_is_active where id = p_id;
  update public.programs set name = coalesce(trim(p_name), name) where activity_id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_activity', 'activity', p_id,
    jsonb_build_object('name', v_before.name, 'is_active', v_before.is_active),
    jsonb_build_object('name', p_name, 'is_active', p_is_active));
end;
$$;

-- ============================================================
-- 4. 조직 관리 (departments) — 과도한 HR 기능 없이 최소 스키마만.
--    department_manager_scopes(기존, business_node 기준 최소권한)는 그대로 두고
--    departments는 순수 표시/소속 정리용으로만 쓴다. department가 생겼다고
--    department_manager 권한이 넓어지지 않는다(§ 최소권한 원칙 유지).
-- ============================================================
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create trigger departments_set_updated_at
  before update on public.departments
  for each row execute procedure public.set_updated_at();

alter table public.staff_profiles add column department_id uuid references public.departments (id);

alter table public.departments enable row level security;

create policy "같은 조직 부서 조회" on public.departments for select
  using (organization_id = public.current_organization_id());

create function public.create_department(p_name text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '부서를 추가할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;

  insert into public.departments (organization_id, name) values (v_org, trim(p_name)) returning id into v_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_department', 'department', v_id, jsonb_build_object('name', p_name));

  return v_id;
end;
$$;

create function public.set_department_active(p_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '부서를 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  update public.departments set is_active = p_is_active where id = p_id and organization_id = v_org;
  if not found then
    raise exception '부서를 찾을 수 없습니다.';
  end if;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'set_department_active', 'department', p_id, jsonb_build_object('is_active', p_is_active));
end;
$$;

create function public.set_staff_department(p_principal_id uuid, p_department_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '소속 부서를 변경할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  if p_department_id is not null then
    if not exists (select 1 from public.departments where id = p_department_id and organization_id = v_org) then
      raise exception '부서를 찾을 수 없습니다.';
    end if;
  end if;
  if not exists (select 1 from public.principals where id = p_principal_id and organization_id = v_org and principal_type = 'staff') then
    raise exception '직원을 찾을 수 없습니다.';
  end if;

  update public.staff_profiles set department_id = p_department_id where principal_id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'set_staff_department', 'principal', p_principal_id, jsonb_build_object('department_id', p_department_id));
end;
$$;

create function public.list_departments()
returns table (out_id uuid, out_name text, out_is_active boolean, out_staff_count integer)
language plpgsql
security definer set search_path = public
as $$
begin
  if public.current_business_role() <> 'global_manager' and not public.is_system_admin() then
    raise exception '부서 목록을 조회할 권한이 없습니다.';
  end if;
  return query
    select d.id, d.name, d.is_active,
      (select count(*)::integer from public.staff_profiles sp where sp.department_id = d.id)
    from public.departments d
    where d.organization_id = public.current_organization_id()
    order by d.sort_order, d.name;
end;
$$;

-- ============================================================
-- 5. 변경이력(Audit) — 민감(계정/인증) Audit은 is_system_admin만,
--    나머지 business Audit은 global_manager도 볼 수 있게 서버에서 분리한다.
--    raw before/after_json은 그대로 반환하되(화면에서 요약 포맷팅), Secret/PIN/
--    Password 원문은 어떤 audit_logs 행에도 애초에 기록되지 않는다(코드 감사 완료).
-- ============================================================
create function public.list_audit_logs(p_limit integer default 100)
returns table (
  out_id uuid,
  out_created_at timestamptz,
  out_actor_name text,
  out_action text,
  out_entity_type text,
  out_entity_id uuid,
  out_before_json jsonb,
  out_after_json jsonb,
  out_reason text
)
language plpgsql
security definer set search_path = public
as $$
declare
  v_is_admin boolean;
  v_is_global_manager boolean;
  v_sensitive_actions text[] := array[
    'provision_staff', 'update_staff_role', 'set_staff_active', 'mark_staff_password_reset',
    'clear_must_change_password', 'provision_instructor', 'reset_instructor_pin',
    'set_instructor_active', 'bootstrap_first_admin'
  ];
begin
  v_is_admin := public.is_system_admin();
  v_is_global_manager := public.current_business_role() = 'global_manager';
  if not v_is_admin and not v_is_global_manager then
    raise exception '변경이력을 조회할 권한이 없습니다.';
  end if;

  return query
    select al.id, al.created_at, p.name, al.action, al.entity_type, al.entity_id,
      al.before_json, al.after_json, al.reason
    from public.audit_logs al
    left join public.principals p on p.id = al.actor_principal_id
    where al.organization_id = public.current_organization_id()
      and (v_is_admin or not (al.action = any(v_sensitive_actions)))
    order by al.created_at desc
    limit greatest(1, least(p_limit, 500));
end;
$$;
