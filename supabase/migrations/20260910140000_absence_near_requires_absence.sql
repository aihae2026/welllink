-- ============================================================
-- 결석 "기준 임박"은 결석이 1회 이상일 때만
-- ============================================================
-- 임박을 "기준-1회"로 계산하면서 greatest(기준-1, 0)을 썼기 때문에, 기준을 1회로
-- 두면 임박 = 0회가 되어 결석이 한 번도 없는 수강자 전원이 임박 + 알림 중으로
-- 잡혔다(2026-09-10 미신고 1회 설정 상태에서 하반기 468명 중 457명이 결석 0회).
--
-- 바꾸는 규칙:
--   - 임박: 기준이 2회 이상일 때만, 누계 = 기준-1 (항상 1회 이상)
--   - 도달: 누계 >= 기준 (변경 없음)
--   - 알림: 누계 >= greatest(기준-1, 1) -- 임박 또는 도달 (결석 0회는 제외)
-- 기준이 2회 이상이면 결과는 이전과 같다. 기준 1회일 때만 달라진다.
--
-- list_absence_alert_states(20260910130000)와 v_enrollment_absence_state
-- (20260908100000, security_invoker는 20260910050651) 둘 다 같은 식으로 맞춘다.
-- 뷰는 create or replace가 옵션을 유지하는지에 기대지 않고 security_invoker를
-- 다시 명시한다.

create or replace view public.v_enrollment_absence_state
with (security_invoker = on) as
select
  e.id as enrollment_id,
  e.operation_term_id,
  e.participant_id,
  coalesce(fc.unexcused_count, 0)::integer as unexcused_count,
  coalesce(fc.excused_count, 0)::integer as excused_count,
  (o.unexcused_absence_threshold >= 2
    and coalesce(fc.unexcused_count, 0) = o.unexcused_absence_threshold - 1) as unexcused_near,
  coalesce(fc.unexcused_count, 0) >= o.unexcused_absence_threshold as unexcused_reached,
  (o.excused_absence_threshold >= 2
    and coalesce(fc.excused_count, 0) = o.excused_absence_threshold - 1) as excused_near,
  coalesce(fc.excused_count, 0) >= o.excused_absence_threshold as excused_reached,
  dm.id as dismissal_id,
  dm.dismissed_at,
  dm.dismissed_unexcused_count,
  dm.dismissed_excused_count,
  (
    (coalesce(fc.unexcused_count, 0) >= greatest(o.unexcused_absence_threshold - 1, 1)
      or coalesce(fc.excused_count, 0) >= greatest(o.excused_absence_threshold - 1, 1))
    and (
      dm.id is null
      or coalesce(fc.unexcused_count, 0) > dm.dismissed_unexcused_count
      or coalesce(fc.excused_count, 0) > dm.dismissed_excused_count
    )
  ) as alert_active
from public.enrollments e
join public.organizations o on o.id = e.organization_id
left join lateral (
  select
    count(*) filter (where fa.mark = 'absent') as unexcused_count,
    count(*) filter (where fa.mark = 'excused') as excused_count
  from public.final_attendance fa
  where fa.enrollment_id = e.id
) fc on true
left join lateral (
  select d.id, d.dismissed_at, d.dismissed_unexcused_count, d.dismissed_excused_count
  from public.absence_alert_dismissals d
  where d.enrollment_id = e.id
  order by d.dismissed_at desc
  limit 1
) dm on true;

create or replace function public.list_absence_alert_states(p_operation_cycle_ids uuid[])
returns table (
  out_enrollment_id uuid,
  out_operation_term_id uuid,
  out_unexcused_count integer,
  out_excused_count integer,
  out_unexcused_near boolean,
  out_unexcused_reached boolean,
  out_excused_near boolean,
  out_excused_reached boolean,
  out_alert_active boolean
)
language sql
stable
security definer set search_path = public
as $$
  with readable_terms as materialized (
    select ot.id
    from public.operation_terms ot
    join public.programs p on p.id = ot.program_id
    where ot.operation_cycle_id = any (p_operation_cycle_ids)
      and ot.organization_id = public.current_organization_id()
      and public.current_business_role() <> 'global_viewer'
      and public.can_read_activity(p.activity_id)
  ),
  states as (
    select
      e.id as enrollment_id,
      e.operation_term_id,
      coalesce(fc.unexcused_count, 0)::integer as unexcused_count,
      coalesce(fc.excused_count, 0)::integer as excused_count,
      (o.unexcused_absence_threshold >= 2
        and coalesce(fc.unexcused_count, 0) = o.unexcused_absence_threshold - 1) as unexcused_near,
      coalesce(fc.unexcused_count, 0) >= o.unexcused_absence_threshold as unexcused_reached,
      (o.excused_absence_threshold >= 2
        and coalesce(fc.excused_count, 0) = o.excused_absence_threshold - 1) as excused_near,
      coalesce(fc.excused_count, 0) >= o.excused_absence_threshold as excused_reached,
      (
        (coalesce(fc.unexcused_count, 0) >= greatest(o.unexcused_absence_threshold - 1, 1)
          or coalesce(fc.excused_count, 0) >= greatest(o.excused_absence_threshold - 1, 1))
        and (
          dm.id is null
          or coalesce(fc.unexcused_count, 0) > dm.dismissed_unexcused_count
          or coalesce(fc.excused_count, 0) > dm.dismissed_excused_count
        )
      ) as alert_active
    from readable_terms rt
    join public.enrollments e on e.operation_term_id = rt.id
    join public.organizations o on o.id = e.organization_id
    left join lateral (
      select
        count(*) filter (where fa.mark = 'absent') as unexcused_count,
        count(*) filter (where fa.mark = 'excused') as excused_count
      from public.final_attendance fa
      where fa.enrollment_id = e.id
    ) fc on true
    left join lateral (
      select d.id, d.dismissed_unexcused_count, d.dismissed_excused_count
      from public.absence_alert_dismissals d
      where d.enrollment_id = e.id
      order by d.dismissed_at desc
      limit 1
    ) dm on true
  )
  select
    s.enrollment_id, s.operation_term_id, s.unexcused_count, s.excused_count,
    s.unexcused_near, s.unexcused_reached, s.excused_near, s.excused_reached, s.alert_active
  from states s
  where s.unexcused_near or s.unexcused_reached or s.excused_near or s.excused_reached;
$$;

do $$
begin
  if not exists (
    select 1 from pg_class
    where oid = 'public.v_enrollment_absence_state'::regclass
      and 'security_invoker=on' = any (reloptions)
  ) then
    raise exception 'v_enrollment_absence_state lost security_invoker';
  end if;
  if has_function_privilege('anon', 'public.list_absence_alert_states(uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.list_absence_alert_states(uuid[])', 'EXECUTE') then
    raise exception 'list_absence_alert_states grant check failed';
  end if;
end $$;
