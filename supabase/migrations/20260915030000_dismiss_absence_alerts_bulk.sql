-- WellLink v1.0 — 결석 주의대상 알림 일괄 끄기.
--
-- 결석관리 > 결석 주의대상에서 체크박스로 고른 여러 명의 알림을 한 번에 끈다.
-- 화면에서 dismiss_absence_alert를 사람 수만큼 부르면 느리고, 중간에 실패하면
-- 일부만 꺼진 채로 남는다 -- 한 트랜잭션에서 처리해 하나라도 실패하면 전부 취소한다.
--
-- 한 건 처리는 dismiss_absence_alert(20260906090000:695, 실DB 정의와 동일)와 같다:
--   - 수강 기록이 없거나 can_manage_activity가 거짓이면 예외(전체 취소).
--   - 해제 시점의 결석/신고결석 누계를 absence_alert_dismissals에 남긴다.
-- 누계는 v_enrollment_absence_state와 같은 식(final_attendance의 absent/excused 수)으로
-- 직접 센다(뷰는 security_invoker라 행 단위 비용이 크다 -- 20260910130000 참고).
-- 이미 꺼진 대상(최근 해제 기록의 누계가 현재 누계 이상)은 새 기록을 남기지 않고 건너뛴다.
-- 반환값: 실제로 새로 끈 인원 수.

create or replace function public.dismiss_absence_alerts(p_enrollment_ids uuid[])
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_enrollment_id uuid;
  v_organization_id uuid;
  v_operation_term_id uuid;
  v_activity_id uuid;
  v_unexcused integer;
  v_excused integer;
  v_dismissed_unexcused integer;
  v_dismissed_excused integer;
  v_principal uuid := public.current_principal_id();
  v_count integer := 0;
begin
  foreach v_enrollment_id in array coalesce(
    (select array_agg(distinct x) from unnest(p_enrollment_ids) x where x is not null),
    '{}'::uuid[]
  ) loop
    select e.organization_id, e.operation_term_id into v_organization_id, v_operation_term_id
    from public.enrollments e where e.id = v_enrollment_id;

    if v_organization_id is null then
      raise exception '수강 기록을 찾을 수 없습니다.';
    end if;

    v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
    if not public.can_manage_activity(v_activity_id) then
      raise exception '이 결석알림을 해제할 권한이 없습니다.';
    end if;

    select
      count(*) filter (where fa.mark = 'absent'),
      count(*) filter (where fa.mark = 'excused')
    into v_unexcused, v_excused
    from public.final_attendance fa
    where fa.enrollment_id = v_enrollment_id;

    v_dismissed_unexcused := null;
    v_dismissed_excused := null;
    select d.dismissed_unexcused_count, d.dismissed_excused_count
    into v_dismissed_unexcused, v_dismissed_excused
    from public.absence_alert_dismissals d
    where d.enrollment_id = v_enrollment_id
    order by d.dismissed_at desc
    limit 1;

    if v_dismissed_unexcused is not null
       and v_unexcused <= v_dismissed_unexcused
       and v_excused <= v_dismissed_excused then
      continue;
    end if;

    insert into public.absence_alert_dismissals
      (organization_id, enrollment_id, dismissed_unexcused_count, dismissed_excused_count, dismissed_by)
    values (v_organization_id, v_enrollment_id, v_unexcused, v_excused, v_principal);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.dismiss_absence_alerts(uuid[]) from public, anon;
grant execute on function public.dismiss_absence_alerts(uuid[]) to authenticated, service_role;

do $$
begin
  if has_function_privilege('anon', 'public.dismiss_absence_alerts(uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.dismiss_absence_alerts(uuid[])', 'EXECUTE') then
    raise exception 'dismiss_absence_alerts grant check failed';
  end if;
end $$;
