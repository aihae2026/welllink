-- Manual QA Micro Gap Fix — 휴강취소 Guard 정리
--
-- uncancel_session(휴강취소)의 목적은 "잘못 휴강 처리한 회차"의 오기입 복구다.
-- 신고결석(excused_absences)은 회차가 scheduled일 때만 사전 지정 가능한
-- 예정 정보일 뿐, 강사 출석/공식 출석/실적처럼 이미 "확정된" 업무데이터가
-- 아니다 -- 휴강 후에도 그 지정 자체는 삭제/재생성 없이 그대로 남아 있으므로
-- (cancel_session이 excused_absences를 건드리지 않음, 그대로 확인됨) 휴강을
-- 취소해 다시 scheduled로 되돌리는 것을 막을 이유가 없다. delete_session의
-- excused_absences 의존성 체크는 이번 수정과 무관하게 그대로 유지한다 --
-- 회차를 물리적으로 삭제하면 그 신고결석 지정 자체가 사라지므로(§14 FK
-- RESTRICT gap) 삭제 차단은 계속 필요하지만, 휴강취소는 회차를 삭제하지
-- 않으므로 같은 논리가 적용되지 않는다(§3 "휴강취소 ≠ 회차 삭제").
create or replace function public.uncancel_session(p_session_id uuid)
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
    raise exception '이 회차의 휴강을 취소할 권한이 없습니다.';
  end if;
  if v_session.status <> 'cancelled' then
    raise exception '휴강 상태인 회차만 휴강을 취소할 수 있습니다.';
  end if;
  if exists (select 1 from public.final_attendance where session_id = p_session_id)
    or exists (select 1 from public.instructor_attendance_submissions where session_id = p_session_id)
    or exists (select 1 from public.performance_records where source_session_id = p_session_id)
  then
    raise exception '출석 또는 실적이 연결된 회차는 휴강을 취소할 수 없습니다.';
  end if;

  update public.sessions
  set status = 'scheduled', cancelled_at = null, cancelled_by = null
  where id = p_session_id and status = 'cancelled';

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_session.organization_id, public.current_principal_id(), 'uncancel_session', 'session', p_session_id);
end;
$$;
