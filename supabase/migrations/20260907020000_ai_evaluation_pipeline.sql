-- 웰링크(WellLink) v1.0 Pipeline 2 / Batch 2.2: AI 사업평가 E2E
-- 평가단위는 "소분류"가 아니라 "단위사업"이다 (Scope Lock v2 §6, 상세개발기준서 §10.1의
-- minor_node_id를 override -- 문서 우선순위상 Scope Lock v2가 최신/최우선이므로 여기서는
-- unit_business_id를 사용한다). 실제 단위사업은 "노년사회화교육사업" 1개뿐이다.
--
-- AI는 숫자를 계산하지 않는다. build_ai_evaluation_payload()가 서버(DB)에서 공식
-- get_activity_metrics/annual_plans 값을 그대로 모아 하나의 불변 snapshot payload(jsonb)를
-- 만들고, 그 payload를 그대로 Gemini에 보낸 뒤 같은 payload를 save_ai_evaluation_snapshot()이
-- 그대로 저장한다 -- 생성 중간에 실적이 바뀌어도 저장되는 snapshot은 최초 payload와 항상 같다.

-- ============================================================
-- 1. ai_evaluations / ai_evaluation_snapshots
-- ============================================================

create type ai_evaluation_period_type as enum ('quarter', 'half_year', 'year', 'custom');

create table public.ai_evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  business_year_id uuid not null references public.business_years (id),
  unit_business_id uuid not null references public.unit_businesses (id),
  period_type ai_evaluation_period_type not null,
  period_start date not null,
  period_end date not null,
  reference_note text,
  -- 단위사업 총계(활동 합산, plan은 하위 활동 전부가 미입력이면 NULL 유지 -- 0으로
  -- 임의 변환하지 않는다. Batch 2.1 get_performance_report의 null-preserving rollup과 동일 원칙).
  plan_count integer,
  plan_unique_people integer,
  plan_total_people integer,
  period_count integer not null,
  period_unique_people integer not null,
  period_total_people integer not null,
  ytd_count integer not null,
  ytd_unique_people integer not null,
  ytd_total_people integer not null,
  operation_result text not null,
  major_changes text not null,
  checkpoints text not null,
  future_direction text not null,
  model_name text,
  prompt_version text,
  -- 재시도(네트워크 재전송 등)로 같은 생성시도가 completed row 2개를 만들지 않게 한다.
  -- 사용자가 의도적으로 "다시 평가 생성"을 누르면 client가 새 idempotency_key를 발급한다.
  idempotency_key uuid not null unique,
  created_by uuid references public.principals (id),
  created_at timestamptz not null default now(),
  constraint ai_evaluations_period_valid check (period_start <= period_end),
  constraint ai_evaluations_plan_non_negative check (
    (plan_count is null or plan_count >= 0)
    and (plan_unique_people is null or plan_unique_people >= 0)
    and (plan_total_people is null or plan_total_people >= 0)
  ),
  constraint ai_evaluations_actual_non_negative check (
    period_count >= 0 and period_unique_people >= 0 and period_total_people >= 0
    and ytd_count >= 0 and ytd_unique_people >= 0 and ytd_total_people >= 0
  )
);

create index ai_evaluations_organization_id_idx on public.ai_evaluations (organization_id);
create index ai_evaluations_unit_business_id_idx on public.ai_evaluations (unit_business_id);
create index ai_evaluations_created_at_idx on public.ai_evaluations (created_at desc);

-- 활동별 evaluation-time snapshot. 이후 실적이 바뀌어도 이 표는 절대 재계산/UPDATE하지 않는다.
create table public.ai_evaluation_snapshots (
  id uuid primary key default gen_random_uuid(),
  ai_evaluation_id uuid not null references public.ai_evaluations (id),
  activity_id uuid not null references public.activities (id),
  activity_name_snapshot text not null,
  sort_order integer not null,
  plan_count integer,
  plan_unique_people integer,
  plan_total_people integer,
  period_count integer not null,
  period_unique_people integer not null,
  period_total_people integer not null,
  ytd_count integer not null,
  ytd_unique_people integer not null,
  ytd_total_people integer not null,
  unique (ai_evaluation_id, activity_id)
);

create index ai_evaluation_snapshots_evaluation_id_idx on public.ai_evaluation_snapshots (ai_evaluation_id);

-- ============================================================
-- 2. 권한 Helper -- 단위사업 소속 모든 활동을 읽을 수 있어야 그 단위사업을 읽을 수 있다.
--    staff가 활동 하나를 담당한다는 이유만으로 단위사업 전체 집계에 접근할 수 없다
--    (can_read_activity를 단위사업 소속 활동 전부에 대해 만족해야 함).
-- ============================================================

create function public.can_read_unit_business(p_unit_business_id uuid)
returns boolean
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_org uuid;
  v_ub_org uuid;
  v_role business_role;
begin
  v_org := public.current_organization_id();
  if v_org is null then return false; end if;

  select organization_id into v_ub_org from public.unit_businesses where id = p_unit_business_id;
  if v_ub_org is null or v_ub_org <> v_org then return false; end if;

  v_role := public.current_business_role();

  if v_role in ('global_manager', 'global_viewer') then
    return true;
  end if;

  if v_role = 'department_manager' then
    -- 이 단위사업의 활동 중 하나라도 읽을 수 없으면(자기 부서 범위 밖) 단위사업 평가 대상에서 제외.
    return not exists (
      select 1 from public.activities a
      where a.unit_business_id = p_unit_business_id and a.is_active = true
        and not public.can_read_activity(a.id)
    );
  end if;

  -- staff/강사 등은 활동 단위 권한만 가지며, 단위사업 전체 조회권한을 자동으로 얻지 않는다.
  return false;
end;
$$;

create function public.can_generate_ai_evaluation(p_unit_business_id uuid)
returns boolean
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_role business_role;
begin
  if not public.can_read_unit_business(p_unit_business_id) then
    return false;
  end if;
  v_role := public.current_business_role();
  -- global_viewer는 조회만 가능하고 생성할 수 없다.
  return v_role in ('global_manager', 'department_manager');
end;
$$;

-- ============================================================
-- 3. 평가대상 단위사업 목록
-- ============================================================

create function public.list_ai_evaluation_unit_businesses(p_business_year_id uuid)
returns table (out_id uuid, out_name text, out_sort_order integer)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_row record;
begin
  for v_row in
    select ub.id, ub.name, ub.sort_order
    from public.unit_businesses ub
    where ub.business_year_id = p_business_year_id and ub.is_active = true
    order by ub.sort_order
  loop
    if public.can_read_unit_business(v_row.id) then
      out_id := v_row.id;
      out_name := v_row.name;
      out_sort_order := v_row.sort_order;
      return next;
    end if;
  end loop;
end;
$$;

-- ============================================================
-- 4. AI 공식 Payload 준비 -- 아직 아무것도 저장하지 않는다(읽기전용).
--    반환된 jsonb를 그대로 Gemini에 보내고, 성공하면 같은 jsonb를 save_ai_evaluation_snapshot에
--    다시 넘겨 그대로 저장한다 -- 중간에 실적이 바뀌어도 저장값은 이 시점 값 그대로다.
-- ============================================================

create function public.build_ai_evaluation_payload(
  p_unit_business_id uuid,
  p_period_type ai_evaluation_period_type,
  p_period_start date,
  p_period_end date
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_business_year_id uuid;
  v_business_year_start date;
  v_business_year_end date;
  v_ub_name text;
  v_activity record;
  v_period record;
  v_ytd record;
  v_plan record;
  v_activities jsonb := '[]'::jsonb;
  v_agg_plan_count integer;
  v_agg_plan_unique integer;
  v_agg_plan_total integer;
  v_agg_period_count integer := 0;
  v_agg_period_unique integer := 0;
  v_agg_period_total integer := 0;
  v_agg_ytd_count integer := 0;
  v_agg_ytd_unique integer := 0;
  v_agg_ytd_total integer := 0;
  v_plan_count_seen boolean := false;
  v_plan_unique_seen boolean := false;
  v_plan_total_seen boolean := false;
begin
  if not public.can_generate_ai_evaluation(p_unit_business_id) then
    raise exception '이 단위사업의 AI 사업평가를 생성할 권한이 없습니다.';
  end if;

  select ub.organization_id, ub.business_year_id, ub.name
    into v_org, v_business_year_id, v_ub_name
  from public.unit_businesses ub where ub.id = p_unit_business_id;

  if v_org is null then
    raise exception '단위사업을 찾을 수 없습니다.';
  end if;

  select (by.year || '-01-01')::date, (by.year || '-12-31')::date
    into v_business_year_start, v_business_year_end
  from public.business_years by where by.id = v_business_year_id;

  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then
    raise exception '평가기간이 올바르지 않습니다.';
  end if;
  if p_period_start < v_business_year_start or p_period_end > v_business_year_end then
    raise exception '평가기간은 해당 사업연도를 벗어날 수 없습니다.';
  end if;

  for v_activity in
    select a.id, a.name, a.sort_order
    from public.activities a
    where a.unit_business_id = p_unit_business_id and a.is_active = true
    order by a.sort_order
  loop
    select * into v_period from public.get_activity_metrics(v_activity.id, p_period_start, p_period_end);
    select * into v_ytd from public.get_activity_metrics(v_activity.id, v_business_year_start, p_period_end);
    select ap.count_target, ap.unique_target, ap.total_target into v_plan
    from public.annual_plans ap where ap.activity_id = v_activity.id and ap.business_year_id = v_business_year_id;

    v_activities := v_activities || jsonb_build_object(
      'activity_id', v_activity.id,
      'activity_name', v_activity.name,
      'sort_order', v_activity.sort_order,
      'plan', jsonb_build_object('count', v_plan.count_target, 'unique', v_plan.unique_target, 'total', v_plan.total_target),
      'period', jsonb_build_object('count', v_period.count_value, 'unique', v_period.unique_people_value, 'total', v_period.total_people_value),
      'ytd', jsonb_build_object('count', v_ytd.count_value, 'unique', v_ytd.unique_people_value, 'total', v_ytd.total_people_value)
    );

    if v_plan.count_target is not null then
      v_agg_plan_count := coalesce(v_agg_plan_count, 0) + v_plan.count_target;
      v_plan_count_seen := true;
    end if;
    if v_plan.unique_target is not null then
      v_agg_plan_unique := coalesce(v_agg_plan_unique, 0) + v_plan.unique_target;
      v_plan_unique_seen := true;
    end if;
    if v_plan.total_target is not null then
      v_agg_plan_total := coalesce(v_agg_plan_total, 0) + v_plan.total_target;
      v_plan_total_seen := true;
    end if;

    v_agg_period_count := v_agg_period_count + v_period.count_value;
    v_agg_period_unique := v_agg_period_unique + v_period.unique_people_value;
    v_agg_period_total := v_agg_period_total + v_period.total_people_value;
    v_agg_ytd_count := v_agg_ytd_count + v_ytd.count_value;
    v_agg_ytd_unique := v_agg_ytd_unique + v_ytd.unique_people_value;
    v_agg_ytd_total := v_agg_ytd_total + v_ytd.total_people_value;
  end loop;

  if not v_plan_count_seen then v_agg_plan_count := null; end if;
  if not v_plan_unique_seen then v_agg_plan_unique := null; end if;
  if not v_plan_total_seen then v_agg_plan_total := null; end if;

  return jsonb_build_object(
    'organization_id', v_org,
    'business_year_id', v_business_year_id,
    'unit_business_id', p_unit_business_id,
    'unit_business_name', v_ub_name,
    'period_type', p_period_type,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'plan', jsonb_build_object('count', v_agg_plan_count, 'unique', v_agg_plan_unique, 'total', v_agg_plan_total),
    'period', jsonb_build_object('count', v_agg_period_count, 'unique', v_agg_period_unique, 'total', v_agg_period_total),
    'ytd', jsonb_build_object('count', v_agg_ytd_count, 'unique', v_agg_ytd_unique, 'total', v_agg_ytd_total),
    'activities', v_activities
  );
end;
$$;

-- ============================================================
-- 5. AI 결과 + Snapshot 저장 -- build_ai_evaluation_payload가 반환한 jsonb를 그대로 받아
--    다시 조회하지 않고 그대로 저장한다(Gemini에 보낸 값과 저장값을 항상 일치시키기 위함).
-- ============================================================

create function public.save_ai_evaluation_snapshot(
  p_payload jsonb,
  p_reference_note text,
  p_operation_result text,
  p_major_changes text,
  p_checkpoints text,
  p_future_direction text,
  p_model_name text,
  p_prompt_version text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_unit_business_id uuid;
  v_id uuid;
  v_activity jsonb;
begin
  v_unit_business_id := (p_payload->>'unit_business_id')::uuid;
  if not public.can_generate_ai_evaluation(v_unit_business_id) then
    raise exception '이 단위사업의 AI 사업평가를 저장할 권한이 없습니다.';
  end if;

  if coalesce(trim(p_operation_result), '') = '' or coalesce(trim(p_major_changes), '') = ''
     or coalesce(trim(p_checkpoints), '') = '' or coalesce(trim(p_future_direction), '') = '' then
    raise exception 'AI 평가 결과 4개 영역이 모두 필요합니다.';
  end if;

  insert into public.ai_evaluations (
    organization_id, business_year_id, unit_business_id,
    period_type, period_start, period_end, reference_note,
    plan_count, plan_unique_people, plan_total_people,
    period_count, period_unique_people, period_total_people,
    ytd_count, ytd_unique_people, ytd_total_people,
    operation_result, major_changes, checkpoints, future_direction,
    model_name, prompt_version, idempotency_key, created_by
  ) values (
    (p_payload->>'organization_id')::uuid,
    (p_payload->>'business_year_id')::uuid,
    v_unit_business_id,
    (p_payload->>'period_type')::ai_evaluation_period_type,
    (p_payload->>'period_start')::date,
    (p_payload->>'period_end')::date,
    nullif(trim(coalesce(p_reference_note, '')), ''),
    (p_payload->'plan'->>'count')::integer,
    (p_payload->'plan'->>'unique')::integer,
    (p_payload->'plan'->>'total')::integer,
    (p_payload->'period'->>'count')::integer,
    (p_payload->'period'->>'unique')::integer,
    (p_payload->'period'->>'total')::integer,
    (p_payload->'ytd'->>'count')::integer,
    (p_payload->'ytd'->>'unique')::integer,
    (p_payload->'ytd'->>'total')::integer,
    trim(p_operation_result), trim(p_major_changes), trim(p_checkpoints), trim(p_future_direction),
    nullif(trim(coalesce(p_model_name, '')), ''),
    nullif(trim(coalesce(p_prompt_version, '')), ''),
    p_idempotency_key,
    public.current_principal_id()
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- 이미 같은 idempotency_key로 저장된 평가가 있다(재시도) -- 새로 만들지 않고 기존 것을 반환한다.
    select id into v_id from public.ai_evaluations where idempotency_key = p_idempotency_key;
    return v_id;
  end if;

  for v_activity in select * from jsonb_array_elements(p_payload->'activities')
  loop
    insert into public.ai_evaluation_snapshots (
      ai_evaluation_id, activity_id, activity_name_snapshot, sort_order,
      plan_count, plan_unique_people, plan_total_people,
      period_count, period_unique_people, period_total_people,
      ytd_count, ytd_unique_people, ytd_total_people
    ) values (
      v_id,
      (v_activity->>'activity_id')::uuid,
      v_activity->>'activity_name',
      (v_activity->>'sort_order')::integer,
      (v_activity->'plan'->>'count')::integer,
      (v_activity->'plan'->>'unique')::integer,
      (v_activity->'plan'->>'total')::integer,
      (v_activity->'period'->>'count')::integer,
      (v_activity->'period'->>'unique')::integer,
      (v_activity->'period'->>'total')::integer,
      (v_activity->'ytd'->>'count')::integer,
      (v_activity->'ytd'->>'unique')::integer,
      (v_activity->'ytd'->>'total')::integer
    );
  end loop;

  return v_id;
end;
$$;

-- ============================================================
-- 6. RLS -- 조회는 can_read_unit_business, 쓰기는 RPC 전용(직접 INSERT/UPDATE/DELETE 전부 차단).
-- ============================================================

alter table public.ai_evaluations enable row level security;
alter table public.ai_evaluation_snapshots enable row level security;

create policy "권한자 AI 평가 조회" on public.ai_evaluations for select
  using (public.can_read_unit_business(unit_business_id));

create policy "권한자 AI 평가 Snapshot 조회" on public.ai_evaluation_snapshots for select
  using (
    exists (
      select 1 from public.ai_evaluations ae
      where ae.id = ai_evaluation_id and public.can_read_unit_business(ae.unit_business_id)
    )
  );
