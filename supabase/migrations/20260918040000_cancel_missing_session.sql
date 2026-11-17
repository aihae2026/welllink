-- 누락 회차도 휴강으로 바꿀 수 있게 한다.
--
-- 지금까지 cancel_session은 status='scheduled'만 허용했다(20260909030000).
-- 그래서 공휴일·행사 등으로 수업이 없었던 날을 마감 전에 미리 휴강으로
-- 바꿔 두지 못하면, 마감이 지나 '누락'이 된 뒤에는 휴강도 삭제도 막혀
-- (삭제 역시 예정 회차만 허용) 그 회차를 정리할 방법이 아예 없었다.
-- 실제 운영에서 반복적으로 걸리는 문제라 'missing'을 허용 대상에 넣는다.
--
-- 안전성: 'missing'은 정의상 강사 제출본 없이 마감된 회차이므로
-- final_attendance/performance_records가 없다. 기존 제출본 가드는 그대로
-- 두어(누락인데 제출본이 남아 있는 예외 상황까지) 원래 취지를 지킨다.
-- finalize_due_sessions는 status='scheduled'만 훑으므로(20260907010000)
-- 휴강으로 옮겨진 회차가 다시 누락으로 되돌아오는 일은 없다.
-- 휴강취소(uncancel_session)는 마감이 지난 회차를 'missing'으로 되돌리므로
-- (20260909100000) 누락 -> 휴강 -> 휴강취소 -> 누락으로 정확히 복귀한다.
create or replace function public.cancel_session(p_session_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_activity_id uuid;
begin
  select s.id, s.organization_id, s.status, ot.program_id
  into v_session
  from public.sessions s
  join public.operation_terms ot on ot.id = s.operation_term_id
  where s.id = p_session_id;

  if v_session.id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  select a.id into v_activity_id
  from public.programs p join public.activities a on a.id = p.activity_id
  where p.id = v_session.program_id;

  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 회차를 휴강 처리할 권한이 없습니다.';
  end if;
  if v_session.status not in ('scheduled', 'missing') then
    raise exception '예정 또는 누락 상태인 회차만 휴강할 수 있습니다.';
  end if;
  if exists (select 1 from public.final_attendance where session_id = p_session_id) then
    raise exception '이미 출석이 확정된 회차는 휴강할 수 없습니다.';
  end if;
  if exists (select 1 from public.instructor_attendance_submissions where session_id = p_session_id) then
    raise exception '이미 강사가 출석을 제출한 회차는 휴강할 수 없습니다.';
  end if;
  if exists (select 1 from public.performance_records where source_session_id = p_session_id) then
    raise exception '이미 실적이 만들어진 회차는 휴강할 수 없습니다.';
  end if;

  update public.sessions
  set status = 'cancelled', cancelled_at = now(), cancelled_by = public.current_principal_id()
  where id = p_session_id and status in ('scheduled', 'missing');

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_session.organization_id, public.current_principal_id(), 'cancel_session', 'session', p_session_id,
    jsonb_build_object('from_status', v_session.status));
end;
$$;
