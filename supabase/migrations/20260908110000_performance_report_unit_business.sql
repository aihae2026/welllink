-- WellLink v1.0 — Final Batch A §25-27: 실적보고에 단위사업 scope를 추가한다.
-- get_performance_report가 지금까지 대분류/중분류/활동만 반환해 단위사업
-- 단위로 필터링/그룹핑할 방법이 없었다. business_nodes/activities 모두
-- unit_business_id를 이미 갖고 있으므로(UnitBusiness↔BusinessNode Linkage
-- Closure) 반환 컬럼에 하나만 추가하면 된다 -- 집계 로직 자체는 그대로다.
drop function public.get_performance_report(uuid, date, date, date);

create function public.get_performance_report(
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
    where a.organization_id = v_org and a.business_year_id = p_business_year_id and a.is_active = true
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
      where a.business_node_id in (select id from descendants) and a.is_active = true and public.can_read_activity(a.id)
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
