-- ============================================================
-- 결석 상태 조회 RPC -- 홈 "결석 주의대상" 시간초과 해결
-- ============================================================
-- 20260910050651(Lovable 보안 일괄 수정)이 v_enrollment_absence_state를
-- security_invoker로 바꾸면서, 뷰 안의 final_attendance 한 행마다 RLS 정책
-- ("권한자 공식출석 조회": can_read_activity(activity_id_for_session(...)))이
-- 평가되게 됐다. 기관 전체를 세던 홈 카드 요청이 8초 statement_timeout에 걸려
-- 500으로 실패했다(2026-09-10 Lovable에서 8,071ms 확인). 운영구분 하나만 보는
-- 결석관리 목록은 아직 272ms지만 출석이 쌓이면 같은 길을 간다.
--
-- 뷰를 definer로 되돌리면 다른 기관 데이터가 다시 보이므로, 대신 security
-- definer 함수에서 권한을 운영차수(operation_term) 단위로 한 번씩만 검사한다.
-- 거르는 기준은 security_invoker 뷰가 RLS로 받던 것과 같다:
--   - enrollments "권한자(전체조회자 제외) enrollment 조회"
--     (20260906071732:983): global_viewer 제외 + can_read_activity(프로그램 활동)
--   - final_attendance / absence_alert_dismissals: 같은 운영차수의 활동으로
--     검사하므로, 위를 통과한 enrollment의 행은 전부 읽을 수 있다.
-- 판정식(near/reached/alert_active)은 20260908100000:62-101의 뷰 정의를 그대로
-- 옮긴다. 뷰는 dismiss_absence_alert(definer, 20260906090000:720)가 계속 쓰므로
-- 남겨둔다.
--
-- 두 화면 모두 근접/도달 대상만 쓰므로(alert_active도 근접/도달일 때만 true)
-- 그 행만 돌려준다.

create function public.list_absence_alert_states(p_operation_cycle_ids uuid[])
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
      coalesce(fc.unexcused_count, 0) = greatest(o.unexcused_absence_threshold - 1, 0) as unexcused_near,
      coalesce(fc.unexcused_count, 0) >= o.unexcused_absence_threshold as unexcused_reached,
      coalesce(fc.excused_count, 0) = greatest(o.excused_absence_threshold - 1, 0) as excused_near,
      coalesce(fc.excused_count, 0) >= o.excused_absence_threshold as excused_reached,
      (
        (coalesce(fc.unexcused_count, 0) >= greatest(o.unexcused_absence_threshold - 1, 0)
          or coalesce(fc.excused_count, 0) >= greatest(o.excused_absence_threshold - 1, 0))
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

revoke all on function public.list_absence_alert_states(uuid[]) from public, anon;
grant execute on function public.list_absence_alert_states(uuid[]) to authenticated, service_role;

do $$
begin
  if has_function_privilege('anon', 'public.list_absence_alert_states(uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.list_absence_alert_states(uuid[])', 'EXECUTE') then
    raise exception 'list_absence_alert_states grant check failed';
  end if;
end $$;
