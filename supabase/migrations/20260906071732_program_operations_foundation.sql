-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.1: 프로그램 운영 기반
-- 사업연도 / 사업구조(대·중·소분류) / 단위사업 / 활동 / Program / 담당자배정
-- / 운영차수 / 회차 / Participant / Enrollment / 최초 수강명단 등록
--
-- 이 migration은 Batch 0(organizations/principals/staff_profiles/instructor_profiles)
-- 위에 순수 추가된다. 기존 4개 테이블/정책/함수는 전혀 건드리지 않는다.

-- ============================================================
-- 1. 사업연도
-- ============================================================

create type business_year_status as enum ('planning', 'active', 'closed');

create table public.business_years (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  year integer not null,
  status business_year_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, year)
);

create trigger business_years_set_updated_at
  before update on public.business_years
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- 2. 사업구조(대/중/소분류) — Design Lock의 분류 tree.
--    단위사업(AI 평가/집계 grouping 단위)과는 명시적으로 다른 개념이다.
--    이번 seed에는 실제 자료상 중분류를 구분할 근거가 없어 major -> minor로
--    직접 연결한다(중분류를 임의로 지어내지 않음). 스키마 자체는 major->middle->minor
--    3단계를 모두 지원한다.
-- ============================================================

create type business_node_type as enum ('major', 'middle', 'minor');

create table public.business_nodes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  business_year_id uuid not null references public.business_years (id),
  parent_id uuid references public.business_nodes (id),
  node_type business_node_type not null,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index business_nodes_organization_id_idx on public.business_nodes (organization_id);
create index business_nodes_parent_id_idx on public.business_nodes (parent_id);

create trigger business_nodes_set_updated_at
  before update on public.business_nodes
  for each row execute procedure public.set_updated_at();

-- 부모-자식 단계가 major -> middle -> minor 순서를 벗어나지 않게 강제한다
-- (major는 부모 없음, middle의 부모는 major, minor의 부모는 major 또는 middle).
create function public.validate_business_node_hierarchy()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  parent_type business_node_type;
begin
  if new.node_type = 'major' then
    if new.parent_id is not null then
      raise exception '대분류(major) 노드는 parent_id를 가질 수 없습니다.';
    end if;
    return new;
  end if;

  if new.parent_id is null then
    raise exception '% 노드는 parent_id가 필요합니다.', new.node_type;
  end if;

  select node_type into parent_type from public.business_nodes where id = new.parent_id;

  if new.node_type = 'middle' and parent_type <> 'major' then
    raise exception '중분류(middle)의 부모는 대분류(major)여야 합니다.';
  end if;

  if new.node_type = 'minor' and parent_type not in ('major', 'middle') then
    raise exception '소분류(minor)의 부모는 대분류 또는 중분류여야 합니다.';
  end if;

  return new;
end;
$$;

create trigger business_nodes_validate_hierarchy
  before insert or update on public.business_nodes
  for each row execute procedure public.validate_business_node_hierarchy();

-- ============================================================
-- 3. 단위사업 — AI 사업평가/공식집계의 grouping 단위.
--    Scope Lock v2 6절: "단위사업"은 소분류와 다른 개념이며 임의로 동일시하지 않는다.
--    그래서 business_nodes와 별도 테이블로 존재한다(activities가 두 축에 각각
--    독립적으로 연결됨 -- 4번 참고). 이번 실제 seed에서는 소분류 수준과 이름이
--    1:1로 겹치지만, 이는 이 기관의 실제 사업구조가 그렇다는 사실이지 스키마가
--    강제하는 제약이 아니다.
-- ============================================================

create table public.unit_businesses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  business_year_id uuid not null references public.business_years (id),
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_year_id, name)
);

create index unit_businesses_organization_id_idx on public.unit_businesses (organization_id);

create trigger unit_businesses_set_updated_at
  before update on public.unit_businesses
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- 4. 활동(Activity) — 공식 실적의 최하위 단위. 분류(business_node)와
--    단위사업(unit_business) 두 축에 각각 독립적으로 연결된다.
-- ============================================================

create type performance_method as enum ('attendance', 'summary');
-- 'roster'(직접등록 명단)는 Scope Lock v2에서 본선 완전 제외이므로 enum 값 자체를
-- 만들지 않는다 -- 스키마 레벨에서 재도입을 원천 차단한다.

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  business_year_id uuid not null references public.business_years (id),
  business_node_id uuid not null references public.business_nodes (id),
  unit_business_id uuid not null references public.unit_businesses (id),
  name text not null,
  default_performance_method performance_method not null default 'attendance',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_year_id, name)
);

create index activities_organization_id_idx on public.activities (organization_id);
create index activities_business_node_id_idx on public.activities (business_node_id);
create index activities_unit_business_id_idx on public.activities (unit_business_id);

create trigger activities_set_updated_at
  before update on public.activities
  for each row execute procedure public.set_updated_at();

-- business_node_id와 unit_business_id가 같은 사업연도/조직에 속하는지 강제한다.
create function public.validate_activity_refs()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  node_year uuid;
  unit_year uuid;
begin
  select business_year_id into node_year from public.business_nodes where id = new.business_node_id;
  select business_year_id into unit_year from public.unit_businesses where id = new.unit_business_id;

  if node_year is distinct from new.business_year_id then
    raise exception 'business_node_id가 activity와 같은 사업연도에 속하지 않습니다.';
  end if;
  if unit_year is distinct from new.business_year_id then
    raise exception 'unit_business_id가 activity와 같은 사업연도에 속하지 않습니다.';
  end if;

  return new;
end;
$$;

create trigger activities_validate_refs
  before insert or update on public.activities
  for each row execute procedure public.validate_activity_refs();

-- ============================================================
-- 5. Program(내부 운영 객체) — "1 Activity = 1 Program" 원칙.
--    사용자 UI에는 Program이 별도로 노출되지 않고 "활동/프로그램"명만 보인다.
-- ============================================================

create table public.programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  activity_id uuid not null unique references public.activities (id),
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index programs_organization_id_idx on public.programs (organization_id);

create trigger programs_set_updated_at
  before update on public.programs
  for each row execute procedure public.set_updated_at();

-- 기본 운영요일/시간. 요일은 ISO 8601 기준 1=월 ... 7=일.
-- start_time/end_time은 nullable이다 -- 실제 공식 시간표 자료가 없는 상태에서
-- 임의로 채우지 않기 위해서다(최종 보고에 명시).
create table public.program_schedule_defaults (
  program_id uuid primary key references public.programs (id) on delete cascade,
  weekdays smallint[] not null,
  start_time time,
  end_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint program_schedule_defaults_weekdays_valid check (
    weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and array_length(weekdays, 1) > 0
  )
);

create trigger program_schedule_defaults_set_updated_at
  before update on public.program_schedule_defaults
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- 6. 담당자 배정 — 한 시점에 한 Activity의 현재 담당자는 1명.
--    effective_to IS NULL 인 행이 "현재 담당자"다. partial unique index로
--    동시에 현재 담당자가 2명 생기는 것을 DB 레벨에서 막는다.
-- ============================================================

create table public.activity_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  activity_id uuid not null references public.activities (id),
  staff_principal_id uuid not null references public.principals (id),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.principals (id),
  constraint activity_assignments_valid_range check (effective_to is null or effective_to > effective_from)
);

create unique index activity_assignments_current_unique
  on public.activity_assignments (activity_id)
  where effective_to is null;

create index activity_assignments_staff_idx on public.activity_assignments (staff_principal_id);

-- ============================================================
-- 7. department_manager 업무범위 — 명시적 scope assignment.
--    departments/positions 테이블은 아직 없으므로(Design Lock 42절 "조직 관리"는
--    이번 Batch 범위가 아님), business_node 단위로 department_manager의 관리범위를
--    명시적으로 지정하는 최소 구조를 둔다. 조직 전체로 임의 확대하지 않는다.
-- ============================================================

create table public.department_manager_scopes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  principal_id uuid not null references public.principals (id),
  business_node_id uuid not null references public.business_nodes (id),
  created_at timestamptz not null default now(),
  unique (principal_id, business_node_id)
);

create index department_manager_scopes_principal_idx on public.department_manager_scopes (principal_id);

-- ============================================================
-- 8. Activity 권한 Helper (Batch 0에서 보류했던 것)
-- ============================================================

create function public.can_read_activity(p_activity_id uuid)
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
          -- 배정받은 소분류 자신, 또는 그 상위(중분류/대분류)가 일치하면
          -- 해당 소분류 아래 모든 활동을 관리범위로 본다.
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

  if v_role = 'staff' then
    return exists (
      select 1 from public.activity_assignments aa
      where aa.activity_id = p_activity_id
        and aa.staff_principal_id = v_principal
        and aa.effective_to is null
    );
  end if;

  return false;
end;
$$;

create function public.can_manage_activity(p_activity_id uuid)
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

  if v_role = 'staff' then
    return exists (
      select 1 from public.activity_assignments aa
      where aa.activity_id = p_activity_id
        and aa.staff_principal_id = v_principal
        and aa.effective_to is null
    );
  end if;

  return false;
end;
$$;

-- 아래 helper는 이번 Batch에서도 만들지 않는다(강사 PIN 인증 도입 이후):
--   is_run_instructor(operation_term_id) -- Batch 1.2

-- ============================================================
-- 9. 운영차수 / 회차
-- ============================================================

create type operation_term_status as enum ('scheduled', 'active', 'ended');

create table public.operation_terms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  program_id uuid not null references public.programs (id),
  business_year_id uuid not null references public.business_years (id),
  name text not null,
  start_date date not null,
  end_date date not null,
  session_start_time time,
  session_end_time time,
  weekdays smallint[] not null,
  instructor_principal_id uuid references public.principals (id),
  status operation_term_status not null default 'scheduled',
  initial_roster_applied_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.principals (id),
  updated_at timestamptz not null default now(),
  constraint operation_terms_date_range check (start_date <= end_date),
  constraint operation_terms_weekdays_valid check (
    weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and array_length(weekdays, 1) > 0
  )
);

create index operation_terms_program_id_idx on public.operation_terms (program_id);
create index operation_terms_organization_id_idx on public.operation_terms (organization_id);

create trigger operation_terms_set_updated_at
  before update on public.operation_terms
  for each row execute procedure public.set_updated_at();

create type session_status as enum ('scheduled', 'completed', 'missing', 'cancelled');

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  operation_term_id uuid not null references public.operation_terms (id),
  session_no integer not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status session_status not null default 'scheduled',
  cancelled_at timestamptz,
  cancelled_by uuid references public.principals (id),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sessions_time_range check (ends_at > starts_at),
  unique (operation_term_id, session_no)
);

create index sessions_operation_term_id_idx on public.sessions (operation_term_id);
create index sessions_organization_id_idx on public.sessions (organization_id);
create index sessions_status_starts_at_idx on public.sessions (status, starts_at);

-- ============================================================
-- 10. 회차 자동생성 공통 계산 로직 (Preview와 실제 생성이 동일 함수를 쓰게 해서
--     서로 다른 계산식으로 drift하지 않게 한다)
-- ============================================================

create function public.compute_session_dates(p_start date, p_end date, p_weekdays smallint[])
returns setof date
language sql
immutable
as $$
  select d::date
  from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') as d
  where extract(isodow from d)::smallint = any(p_weekdays)
  order by d;
$$;

-- 운영차수 생성 전 회차 Preview. 읽기 전용이며 아무것도 쓰지 않는다.
create function public.preview_operation_term_sessions(
  p_program_id uuid,
  p_start_date date,
  p_end_date date,
  p_excluded_dates date[] default '{}'
)
returns table (session_no integer, session_date date)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_activity_id uuid;
  v_weekdays smallint[];
begin
  select a.id, psd.weekdays into v_activity_id, v_weekdays
  from public.programs p
  join public.activities a on a.id = p.activity_id
  join public.program_schedule_defaults psd on psd.program_id = p.id
  where p.id = p_program_id;

  if v_activity_id is null then
    raise exception '프로그램을 찾을 수 없거나 기본 운영요일이 설정되지 않았습니다.';
  end if;

  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 운영차수를 관리할 권한이 없습니다.';
  end if;

  return query
    select row_number() over (order by d)::integer, d
    from public.compute_session_dates(p_start_date, p_end_date, v_weekdays) as d
    where d <> all (coalesce(p_excluded_dates, '{}'::date[]));
end;
$$;

-- 운영차수 생성 RPC. 하나의 Transaction 안에서 권한확인 -> 입력검증 ->
-- OperationTerm 생성 -> Session 일괄 생성까지 원자적으로 처리한다.
create function public.create_operation_term(
  p_program_id uuid,
  p_business_year_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date,
  p_excluded_dates date[] default '{}'
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_id uuid;
  v_organization_id uuid;
  v_weekdays smallint[];
  v_start_time time;
  v_end_time time;
  v_term_id uuid;
  v_principal uuid;
  v_seq integer := 0;
  v_date date;
begin
  select a.id, p.organization_id, psd.weekdays, psd.start_time, psd.end_time
  into v_activity_id, v_organization_id, v_weekdays, v_start_time, v_end_time
  from public.programs p
  join public.activities a on a.id = p.activity_id
  join public.program_schedule_defaults psd on psd.program_id = p.id
  where p.id = p_program_id;

  if v_activity_id is null then
    raise exception '프로그램을 찾을 수 없거나 기본 운영요일이 설정되지 않았습니다.';
  end if;

  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 운영차수를 생성할 권한이 없습니다.';
  end if;

  if v_start_time is null or v_end_time is null then
    raise exception '이 프로그램은 아직 실제 운영시간(start_time/end_time)이 등록되지 않아 운영차수를 생성할 수 없습니다.';
  end if;

  if p_start_date > p_end_date then
    raise exception '시작일은 종료일보다 늦을 수 없습니다.';
  end if;

  v_principal := public.current_principal_id();

  insert into public.operation_terms (
    organization_id, program_id, business_year_id, name,
    start_date, end_date, session_start_time, session_end_time,
    weekdays, status, created_by
  ) values (
    v_organization_id, p_program_id, p_business_year_id, p_name,
    p_start_date, p_end_date, v_start_time, v_end_time,
    v_weekdays, 'scheduled', v_principal
  )
  returning id into v_term_id;

  for v_date in
    select d from public.compute_session_dates(p_start_date, p_end_date, v_weekdays) as d
    where d <> all (coalesce(p_excluded_dates, '{}'::date[]))
  loop
    v_seq := v_seq + 1;
    insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
    values (
      v_organization_id, v_term_id, v_seq,
      (v_date + v_start_time) at time zone 'Asia/Seoul',
      (v_date + v_end_time) at time zone 'Asia/Seoul',
      'scheduled'
    );
  end loop;

  if v_seq = 0 then
    raise exception '생성될 회차가 없습니다. 기간/요일/제외일을 확인해 주세요.';
  end if;

  return v_term_id;
end;
$$;

-- ============================================================
-- 11. Participant / Enrollment
-- ============================================================

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  member_code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, member_code),
  constraint participants_member_code_format check (member_code ~ '^[0-9]{4}-[0-9]{5}$')
);

create index participants_organization_id_idx on public.participants (organization_id);

create trigger participants_set_updated_at
  before update on public.participants
  for each row execute procedure public.set_updated_at();

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  operation_term_id uuid not null references public.operation_terms (id),
  participant_id uuid not null references public.participants (id),
  start_session_no integer not null default 1,
  end_session_no_exclusive integer,
  created_at timestamptz not null default now(),
  created_by uuid references public.principals (id),
  ended_at timestamptz,
  ended_by uuid references public.principals (id),
  -- >= 허용: 시작 회차가 오기도 전에 바로 종결되는 경우(연인원 0으로 끝나는
  -- 정상적인 업무 케이스)까지 포함한다.
  constraint enrollments_valid_range check (
    end_session_no_exclusive is null or end_session_no_exclusive >= start_session_no
  )
);

create unique index enrollments_active_unique
  on public.enrollments (operation_term_id, participant_id)
  where end_session_no_exclusive is null;

create index enrollments_operation_term_id_idx on public.enrollments (operation_term_id);
create index enrollments_participant_id_idx on public.enrollments (participant_id);

-- ============================================================
-- 12. 최초 수강명단 등록 (idempotent) + 감사로그
-- ============================================================

create table public.roster_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  operation_term_id uuid not null references public.operation_terms (id),
  idempotency_key text not null,
  row_count integer not null,
  imported_at timestamptz not null default now(),
  imported_by uuid references public.principals (id),
  unique (operation_term_id, idempotency_key)
);

-- 초기 전체 수강명단 적용. rows는 jsonb 배열 [{member_code, name}, ...].
-- 하나의 Transaction 안에서: 권한확인 -> 최초등록 여부 확인 -> 전체 행 검증 ->
-- Participant upsert -> Enrollment 생성 -> Import 기록까지 원자적으로 처리한다.
-- 중간 오류 시 전체 rollback(부분성공 없음).
create function public.apply_initial_roster(
  p_operation_term_id uuid,
  p_rows jsonb,
  p_idempotency_key text
)
returns table (participant_count integer, enrollment_count integer)
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_id uuid;
  v_organization_id uuid;
  v_already_applied timestamptz;
  v_row jsonb;
  v_member_code text;
  v_name text;
  v_participant_id uuid;
  v_participant_count integer := 0;
  v_enrollment_count integer := 0;
  v_seen_codes text[] := '{}';
begin
  select a.id, ot.organization_id, ot.initial_roster_applied_at
  into v_activity_id, v_organization_id, v_already_applied
  from public.operation_terms ot
  join public.programs p on p.id = ot.program_id
  join public.activities a on a.id = p.activity_id
  where ot.id = p_operation_term_id;

  if v_activity_id is null then
    raise exception '운영차수를 찾을 수 없습니다.';
  end if;

  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 운영차수의 수강명단을 등록할 권한이 없습니다.';
  end if;

  -- idempotency: 이미 같은 요청(operation_term_id + idempotency_key)이 적용된 적
  -- 있으면 재실행해도 중복 생성하지 않고 그대로 완료된 것으로 처리한다.
  if exists (
    select 1 from public.roster_imports
    where operation_term_id = p_operation_term_id and idempotency_key = p_idempotency_key
  ) then
    select count(*) into v_enrollment_count from public.enrollments where operation_term_id = p_operation_term_id;
    return query select v_enrollment_count, v_enrollment_count;
    return;
  end if;

  if v_already_applied is not null then
    raise exception '이 운영차수는 이미 최초 수강명단이 등록되어 재적용할 수 없습니다.';
  end if;

  -- 전체 행 검증 (형식/중복) -- 하나라도 잘못되면 전체 rollback
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_member_code := regexp_replace(coalesce(v_row->>'member_code', ''), '[^0-9]', '', 'g');
    v_name := trim(coalesce(v_row->>'name', ''));

    if length(v_member_code) <> 9 then
      raise exception '회원코드 형식 오류: % (YYYY##### 9자리 숫자여야 합니다)', v_row->>'member_code';
    end if;
    v_member_code := substr(v_member_code, 1, 4) || '-' || substr(v_member_code, 5, 5);

    if v_name = '' then
      raise exception '회원코드 %의 성명이 비어 있습니다.', v_member_code;
    end if;

    if v_member_code = any (v_seen_codes) then
      raise exception '같은 파일 안에 회원코드가 중복되었습니다: %', v_member_code;
    end if;
    v_seen_codes := array_append(v_seen_codes, v_member_code);
  end loop;

  -- 검증 통과 후 실제 반영
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_member_code := regexp_replace(coalesce(v_row->>'member_code', ''), '[^0-9]', '', 'g');
    v_member_code := substr(v_member_code, 1, 4) || '-' || substr(v_member_code, 5, 5);
    v_name := trim(v_row->>'name');

    insert into public.participants (organization_id, member_code, name)
    values (v_organization_id, v_member_code, v_name)
    on conflict (organization_id, member_code) do update set name = excluded.name
    returning id into v_participant_id;
    v_participant_count := v_participant_count + 1;

    insert into public.enrollments (organization_id, operation_term_id, participant_id, start_session_no, created_by)
    values (v_organization_id, p_operation_term_id, v_participant_id, 1, public.current_principal_id());
    v_enrollment_count := v_enrollment_count + 1;
  end loop;

  update public.operation_terms set initial_roster_applied_at = now() where id = p_operation_term_id;

  insert into public.roster_imports (organization_id, operation_term_id, idempotency_key, row_count, imported_by)
  values (v_organization_id, p_operation_term_id, p_idempotency_key, v_participant_count, public.current_principal_id());

  return query select v_participant_count, v_enrollment_count;
end;
$$;

-- ============================================================
-- 13. 운영 중 추가등록 / 수강종결
-- ============================================================

create function public.add_enrollments(p_operation_term_id uuid, p_participants jsonb)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_id uuid;
  v_organization_id uuid;
  v_row jsonb;
  v_member_code text;
  v_name text;
  v_participant_id uuid;
  v_next_session_no integer;
  v_added integer := 0;
begin
  select a.id, ot.organization_id into v_activity_id, v_organization_id
  from public.operation_terms ot
  join public.programs p on p.id = ot.program_id
  join public.activities a on a.id = p.activity_id
  where ot.id = p_operation_term_id;

  if v_activity_id is null then
    raise exception '운영차수를 찾을 수 없습니다.';
  end if;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 운영차수에 수강생을 추가할 권한이 없습니다.';
  end if;

  -- 처리 이후 가장 가까운 예정 회차를 계산한다. 완료된 과거 회차에는 소급하지 않는다.
  select min(session_no) into v_next_session_no
  from public.sessions
  where operation_term_id = p_operation_term_id and status = 'scheduled' and starts_at > now();

  if v_next_session_no is null then
    raise exception '추가할 수 있는 예정 회차가 없습니다.';
  end if;

  for v_row in select * from jsonb_array_elements(p_participants)
  loop
    v_member_code := regexp_replace(coalesce(v_row->>'member_code', ''), '[^0-9]', '', 'g');
    if length(v_member_code) <> 9 then
      raise exception '회원코드 형식 오류: %', v_row->>'member_code';
    end if;
    v_member_code := substr(v_member_code, 1, 4) || '-' || substr(v_member_code, 5, 5);
    v_name := trim(v_row->>'name');

    select id into v_participant_id from public.participants
    where organization_id = v_organization_id and member_code = v_member_code;

    if v_participant_id is null then
      if coalesce(v_name, '') = '' then
        raise exception '신규 회원코드 %는 성명이 필요합니다.', v_member_code;
      end if;
      insert into public.participants (organization_id, member_code, name)
      values (v_organization_id, v_member_code, v_name)
      returning id into v_participant_id;
    end if;

    if exists (
      select 1 from public.enrollments
      where operation_term_id = p_operation_term_id
        and participant_id = v_participant_id
        and end_session_no_exclusive is null
    ) then
      raise exception '회원코드 %는 이미 이 운영차수에 수강 중입니다.', v_member_code;
    end if;

    insert into public.enrollments (organization_id, operation_term_id, participant_id, start_session_no, created_by)
    values (v_organization_id, p_operation_term_id, v_participant_id, v_next_session_no, public.current_principal_id());
    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$$;

create function public.terminate_enrollments(p_enrollment_ids uuid[])
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_enrollment record;
  v_activity_id uuid;
  v_next_session_no integer;
  v_count integer := 0;
begin
  for v_enrollment in
    select e.id, e.operation_term_id from public.enrollments e where e.id = any (p_enrollment_ids)
  loop
    select a.id into v_activity_id
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
    end if;
  end loop;

  return v_count;
end;
$$;

-- ============================================================
-- 14. 담당자 배정 RPC
-- ============================================================

create function public.assign_activity(p_activity_id uuid, p_staff_principal_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_new_id uuid;
begin
  if not public.can_manage_activity(p_activity_id) then
    raise exception '이 활동의 담당자를 배정할 권한이 없습니다.';
  end if;

  update public.activity_assignments
  set effective_to = now()
  where activity_id = p_activity_id and effective_to is null;

  insert into public.activity_assignments (organization_id, activity_id, staff_principal_id, created_by)
  values (public.current_organization_id(), p_activity_id, p_staff_principal_id, public.current_principal_id())
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ============================================================
-- 15. RLS
-- ============================================================

alter table public.business_years enable row level security;
alter table public.business_nodes enable row level security;
alter table public.unit_businesses enable row level security;
alter table public.activities enable row level security;
alter table public.programs enable row level security;
alter table public.program_schedule_defaults enable row level security;
alter table public.activity_assignments enable row level security;
alter table public.department_manager_scopes enable row level security;
alter table public.operation_terms enable row level security;
alter table public.sessions enable row level security;
alter table public.participants enable row level security;
alter table public.enrollments enable row level security;
alter table public.roster_imports enable row level security;

-- 사업연도/사업구조/단위사업: 같은 조직이면 조회 가능(범용 관리 UI는 없지만
-- 목록/상세 화면이 이 값을 읽어야 하므로 SELECT는 열어둔다). 쓰기 정책 없음
-- (이번 Batch는 seed로만 채우고, 범용 편집 RPC/UI를 만들지 않는다).
create policy "같은 조직 사업연도 조회" on public.business_years for select
  using (organization_id = public.current_organization_id());
create policy "같은 조직 사업구조 조회" on public.business_nodes for select
  using (organization_id = public.current_organization_id());
create policy "같은 조직 단위사업 조회" on public.unit_businesses for select
  using (organization_id = public.current_organization_id());

-- activities/programs/program_schedule_defaults: 권한(can_read_activity) 있는
-- 사람만 조회. 쓰기 정책 없음(전부 RPC 또는 seed로만 기록됨).
create policy "권한자 activity 조회" on public.activities for select
  using (public.can_read_activity(id));
create policy "권한자 program 조회" on public.programs for select
  using (public.can_read_activity(activity_id));
create policy "권한자 schedule 조회" on public.program_schedule_defaults for select
  using (public.can_read_activity((select activity_id from public.programs where id = program_id)));

create policy "권한자 담당자배정 조회" on public.activity_assignments for select
  using (public.can_read_activity(activity_id));

-- department_manager_scopes: 본인 것과, 관리범위를 확인해야 하는 global_manager만.
create policy "본인 scope 또는 global_manager 조회" on public.department_manager_scopes for select
  using (
    organization_id = public.current_organization_id()
    and (principal_id = public.current_principal_id() or public.current_business_role() = 'global_manager')
  );

create policy "권한자 운영차수 조회" on public.operation_terms for select
  using (public.can_read_activity((select a.id from public.programs p join public.activities a on a.id = p.activity_id where p.id = program_id)));

create policy "권한자 회차 조회" on public.sessions for select
  using (
    exists (
      select 1 from public.operation_terms ot
      join public.programs p on p.id = ot.program_id
      where ot.id = operation_term_id and public.can_read_activity(p.activity_id)
    )
  );

-- Participant/Enrollment: 개인정보이므로 "같은 조직"만으로 열지 않는다.
-- 1) 해당 운영차수(활동)에 대한 접근권한이 있어야 하고,
-- 2) global_viewer는 업무 집계는 볼 수 있어도 개인 원자료는 볼 수 없다
--    (Design Lock: "전체조회자 -- 개인 수강명단, 출석기록 등 개인 원자료 접근 불가").
create policy "권한자(전체조회자 제외) participant 조회" on public.participants for select
  using (
    organization_id = public.current_organization_id()
    and public.current_business_role() <> 'global_viewer'
    and exists (
      select 1 from public.enrollments e
      join public.operation_terms ot on ot.id = e.operation_term_id
      join public.programs p on p.id = ot.program_id
      where e.participant_id = participants.id and public.can_read_activity(p.activity_id)
    )
  );

create policy "권한자(전체조회자 제외) enrollment 조회" on public.enrollments for select
  using (
    public.current_business_role() <> 'global_viewer'
    and exists (
      select 1 from public.operation_terms ot
      join public.programs p on p.id = ot.program_id
      where ot.id = operation_term_id and public.can_read_activity(p.activity_id)
    )
  );

create policy "권한자 roster_import 조회" on public.roster_imports for select
  using (
    exists (
      select 1 from public.operation_terms ot
      join public.programs p on p.id = ot.program_id
      where ot.id = operation_term_id and public.can_read_activity(p.activity_id)
    )
  );
