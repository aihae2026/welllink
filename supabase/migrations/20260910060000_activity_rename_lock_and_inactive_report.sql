-- 프로그램 이름 변경 정책: "이름이 바뀐 프로그램은 새 활동으로 등록한다."
--
-- 문제: programs.name 하나를 모든 운영차수가 공유한다. 사업·활동 관리에서 이름을
-- 바꾸면(update_activity) activities.name/programs.name이 함께 덮어써져서, 이미
-- 끝난 상반기의 출석·실적 화면까지 새 이름으로 바뀌었다(예: 상반기 "AI건강코칭"을
-- 하반기 "AI기초"로 바꾸면 상반기 기록도 "AI기초"로 표시됨).
--
-- 운영차수별 이름 칸을 두는 대신, 이름이 바뀌면 새 활동으로 등록하게 한다.
-- 그러려면 두 가지를 막아야 한다.
--
-- 1. 운영 기록(운영정보 또는 실적)이 있는 활동은 이름을 바꿀 수 없다. 운영 전인
--    활동의 오타 수정은 그대로 허용한다.
-- 2. 옛 활동을 비활성화하면 그 활동의 실적이 실적보고/AI 사업평가에서 사라졌다
--    (모두 is_active = true 활동만 집계). "비활성이어도 실적이 있으면 집계에
--    포함"으로 바꾼다 -- 그래야 상반기가 끝난 옛 활동을 비활성화해 하반기 프로그램
--    선택 목록에서 치워도 상반기 실적이 남는다. 활동은 사업연도별이므로 "실적이
--    있다"는 곧 그 연도의 실적이다. 실적보고/단위사업 집계/AI 평가 Payload/단위사업
--    조회권한 네 곳이 같은 활동 집합을 봐야 합계가 서로 어긋나지 않으므로 전부 같은
--    helper로 바꾼다.

-- ============================================================
-- 1. helper: 활동에 유효 실적이 한 건이라도 있는가
-- ============================================================
create or replace function public.activity_has_performance(p_activity_id uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.performance_records pr
    where pr.activity_id = p_activity_id and pr.status = 'active'
  );
$$;

-- 아래 security definer 함수들 안에서만 호출한다(소유자 권한으로 실행) -- 클라이언트가
-- 직접 부를 이유가 없고, 조직 검사 없이 활동 id만 받으므로 막아 둔다.
revoke all on function public.activity_has_performance(uuid) from public, anon, authenticated;
grant execute on function public.activity_has_performance(uuid) to service_role;

-- ============================================================
-- 2. update_activity: 운영 기록이 있으면 이름 변경 거부
-- ============================================================
-- 활성/비활성 토글도 이 함수를 같은 이름으로 호출하므로, 이름이 실제로 바뀔 때만
-- 검사한다.
create or replace function public.update_activity(p_id uuid, p_name text, p_is_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before record;
  v_new_name text;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '활동을 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select name, is_active into v_before from public.activities where id = p_id and organization_id = v_org;
  if not found then
    raise exception '활동을 찾을 수 없습니다.';
  end if;

  v_new_name := coalesce(trim(p_name), v_before.name);

  if v_new_name is distinct from v_before.name and (
    exists (
      select 1 from public.operation_terms ot
      join public.programs p on p.id = ot.program_id
      where p.activity_id = p_id
    )
    or exists (select 1 from public.performance_records pr where pr.activity_id = p_id)
  ) then
    raise exception '이미 운영 기록이 있는 활동은 이름을 바꿀 수 없습니다(지난 기록의 이름까지 바뀌기 때문입니다). 이름이 바뀐 프로그램은 "Excel로 사업구조 등록"에서 새 활동으로 추가해 주세요.';
  end if;

  update public.activities set name = v_new_name, is_active = p_is_active where id = p_id;
  update public.programs set name = v_new_name where activity_id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_activity', 'activity', p_id,
    jsonb_build_object('name', v_before.name, 'is_active', v_before.is_active),
    jsonb_build_object('name', p_name, 'is_active', p_is_active));
end;
$$;

-- ============================================================
-- 3. 실적보고: 비활성이어도 실적이 있는 활동은 포함
-- ============================================================
-- 20260908110000_performance_report_unit_business.sql 버전에서 활동 선택 조건 두 곳만
-- 바꾼다(leaf 행과 노드 합산이 같은 활동 집합을 봐야 한다).
create or replace function public.get_performance_report(
  p_business_year_id uuid,
  p_period_start date,
  p_period_end date,
  p_ytd_start date
)
returns table (
  node_id uuid,
  node_type text,
  parent_id uuid,
  unit_business_id uuid,
  label text,
  level integer,
  sort_order integer,
  plan_count integer,
  plan_unique integer,
  plan_total integer,
  period_count integer,
  period_unique integer,
  period_total integer,
  ytd_count integer,
  ytd_unique integer,
  ytd_total integer
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_org uuid;
  v_activity record;
  v_node record;
  v_period record;
  v_ytd record;
  v_plan record;
  v_agg record;
begin
  v_org := public.current_organization_id();
  if v_org is null then
    raise exception '조직 정보를 확인할 수 없습니다.';
  end if;

  -- 활동(leaf) 행
  for v_activity in
    select a.id, a.name, a.business_node_id, a.unit_business_id, a.sort_order
    from public.activities a
    where a.organization_id = v_org and a.business_year_id = p_business_year_id
      and (a.is_active = true or public.activity_has_performance(a.id))
      and public.can_read_activity(a.id)
    order by a.sort_order
  loop
    select * into v_period from public.get_activity_metrics(v_activity.id, p_period_start, p_period_end);
    select * into v_ytd from public.get_activity_metrics(v_activity.id, p_ytd_start, p_period_end);
    select ap.count_target, ap.unique_target, ap.total_target into v_plan
    from public.annual_plans ap where ap.activity_id = v_activity.id and ap.business_year_id = p_business_year_id;

    node_id := v_activity.id;
    node_type := 'activity';
    parent_id := v_activity.business_node_id;
    unit_business_id := v_activity.unit_business_id;
    label := v_activity.name;
    level := 3;
    sort_order := v_activity.sort_order;
    plan_count := v_plan.count_target; plan_unique := v_plan.unique_target; plan_total := v_plan.total_target;
    period_count := v_period.count_value; period_unique := v_period.unique_people_value; period_total := v_period.total_people_value;
    ytd_count := v_ytd.count_value; ytd_unique := v_ytd.unique_people_value; ytd_total := v_ytd.total_people_value;
    return next;
  end loop;

  -- 사업구조 노드(대/중/소분류) 행: 하위 활동 metric의 단순 합산(상세개발기준서 §8.5.4).
  for v_node in
    select bn.id, bn.name, bn.parent_id, bn.node_type, bn.sort_order, bn.unit_business_id,
      case bn.node_type when 'major' then 0 when 'middle' then 1 when 'minor' then 2 end as lvl
    from public.business_nodes bn
    where bn.organization_id = v_org and bn.business_year_id = p_business_year_id and bn.is_active = true
    order by lvl, bn.sort_order
  loop
    select
      case when bool_or(sub.leaf_plan_count is not null) then coalesce(sum(sub.leaf_plan_count), 0)::int else null end as agg_plan_count,
      case when bool_or(sub.leaf_plan_unique is not null) then coalesce(sum(sub.leaf_plan_unique), 0)::int else null end as agg_plan_unique,
      case when bool_or(sub.leaf_plan_total is not null) then coalesce(sum(sub.leaf_plan_total), 0)::int else null end as agg_plan_total,
      coalesce(sum(sub.leaf_period_count), 0)::int as agg_period_count,
      coalesce(sum(sub.leaf_period_unique), 0)::int as agg_period_unique,
      coalesce(sum(sub.leaf_period_total), 0)::int as agg_period_total,
      coalesce(sum(sub.leaf_ytd_count), 0)::int as agg_ytd_count,
      coalesce(sum(sub.leaf_ytd_unique), 0)::int as agg_ytd_unique,
      coalesce(sum(sub.leaf_ytd_total), 0)::int as agg_ytd_total
    into v_agg
    from (
      -- 소분류는 직속 활동 + (있다면) 하위 없음(활동이 소분류의 최하위이므로).
      -- 중/대분류는 자기 자신을 조상으로 갖는 모든 하위 소분류의 활동 합.
      -- 서브쿼리 컬럼명을 leaf_ 접두사로 지어 바깥 함수의 OUT 파라미터(plan_count 등)와
      -- 겹치지 않게 한다(동명 충돌 시 column reference ambiguous 오류가 실제로 발생함을
      -- Batch 1.2에서 이미 확인했다).
      with recursive descendants as (
        select bn2.id from public.business_nodes bn2 where bn2.id = v_node.id
        union all
        select bn3.id from public.business_nodes bn3 join descendants d on bn3.parent_id = d.id
      )
      select
        a.id,
        (select p2.count_target from public.annual_plans p2 where p2.activity_id = a.id and p2.business_year_id = p_business_year_id) as leaf_plan_count,
        (select p2.unique_target from public.annual_plans p2 where p2.activity_id = a.id and p2.business_year_id = p_business_year_id) as leaf_plan_unique,
        (select p2.total_target from public.annual_plans p2 where p2.activity_id = a.id and p2.business_year_id = p_business_year_id) as leaf_plan_total,
        (select m.count_value from public.get_activity_metrics(a.id, p_period_start, p_period_end) m) as leaf_period_count,
        (select m.unique_people_value from public.get_activity_metrics(a.id, p_period_start, p_period_end) m) as leaf_period_unique,
        (select m.total_people_value from public.get_activity_metrics(a.id, p_period_start, p_period_end) m) as leaf_period_total,
        (select m.count_value from public.get_activity_metrics(a.id, p_ytd_start, p_period_end) m) as leaf_ytd_count,
        (select m.unique_people_value from public.get_activity_metrics(a.id, p_ytd_start, p_period_end) m) as leaf_ytd_unique,
        (select m.total_people_value from public.get_activity_metrics(a.id, p_ytd_start, p_period_end) m) as leaf_ytd_total
      from public.activities a
      where a.business_node_id in (select id from descendants)
        and (a.is_active = true or public.activity_has_performance(a.id))
        and public.can_read_activity(a.id)
    ) sub;

    node_id := v_node.id;
    node_type := v_node.node_type::text;
    parent_id := v_node.parent_id;
    unit_business_id := v_node.unit_business_id;
    label := v_node.name;
    level := v_node.lvl;
    sort_order := v_node.sort_order;
    plan_count := v_agg.agg_plan_count;
    plan_unique := v_agg.agg_plan_unique;
    plan_total := v_agg.agg_plan_total;
    period_count := v_agg.agg_period_count;
    period_unique := v_agg.agg_period_unique;
    period_total := v_agg.agg_period_total;
    ytd_count := v_agg.agg_ytd_count;
    ytd_unique := v_agg.agg_ytd_unique;
    ytd_total := v_agg.agg_ytd_total;
    return next;
  end loop;
end;
$$;

-- ============================================================
-- 4. 단위사업 집계: 같은 규칙
-- ============================================================
create or replace function public.get_unit_business_aggregate(
  p_unit_business_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (count_value integer, unique_people_value integer, total_people_value integer)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_activity record;
  v_count integer := 0;
  v_unique integer := 0;
  v_total integer := 0;
  v_m record;
begin
  for v_activity in
    select id from public.activities
    where unit_business_id = p_unit_business_id
      and (is_active = true or public.activity_has_performance(id))
  loop
    select * into v_m from public.get_activity_metrics(v_activity.id, p_period_start, p_period_end);
    v_count := v_count + coalesce(v_m.count_value, 0);
    v_unique := v_unique + coalesce(v_m.unique_people_value, 0);
    v_total := v_total + coalesce(v_m.total_people_value, 0);
  end loop;

  return query select v_count, v_unique, v_total;
end;
$$;

-- ============================================================
-- 5. 단위사업 조회권한: AI 평가 Payload가 읽을 활동 집합과 같게
-- ============================================================
-- department_manager는 단위사업 소속 활동을 전부 읽을 수 있어야 그 단위사업을
-- 읽는다. Payload가 실적 있는 비활성 활동도 읽게 되므로(get_activity_metrics가
-- 권한 없으면 예외) 여기서도 같은 집합으로 검사한다.
create or replace function public.can_read_unit_business(p_unit_business_id uuid)
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
      where a.unit_business_id = p_unit_business_id
        and (a.is_active = true or public.activity_has_performance(a.id))
        and not public.can_read_activity(a.id)
    );
  end if;

  -- staff/강사 등은 활동 단위 권한만 가지며, 단위사업 전체 조회권한을 자동으로 얻지 않는다.
  return false;
end;
$$;

-- ============================================================
-- 6. AI 사업평가 Payload: 같은 규칙
-- ============================================================
-- 20260907020000_ai_evaluation_pipeline.sql 버전에서 활동 선택 조건 한 곳만 바꾼다.
create or replace function public.build_ai_evaluation_payload(
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
    where a.unit_business_id = p_unit_business_id
      and (a.is_active = true or public.activity_has_performance(a.id))
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
