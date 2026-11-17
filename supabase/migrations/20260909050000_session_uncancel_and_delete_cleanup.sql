-- Manual QA Gap Fix — Enrollment / Session State Integrity
--
-- §8-10: 휴강 취소(uncancel_session). 기존 상세개발기준에서는 휴강취소가
-- 범위에서 제외되어 있었으나, Manual QA에서 발견된 오기입(잘못 휴강 처리한
-- 회차) 복구 필요에 따라 이번 배치에서 명시적으로 Scope를 변경한다. 대규모
-- 상태모델 변경 없이 cancelled -> scheduled 단방향 복귀 RPC 1개만 추가한다.
--
-- §11-14: 회차 삭제(delete_session) 기준을 "과거 여부"가 아니라 "업무데이터
-- dependency 존재 여부"로 재정의한다. delete_operation_cycle이 이미 따르고
-- 있는 원칙(하위 업무데이터가 전혀 없을 때만 물리삭제, 있으면 즉시 차단)과
-- 동일하므로 새로운 삭제 원칙을 도입하는 것이 아니다 -- starts_at <= now()
-- 제약만 제거하고 의존성 검사는 그대로 유지한다. 추가로 감사 중 발견한 gap:
-- excused_absences.session_id가 sessions를 FK로 참조하는데(on delete 절
-- 없음 = RESTRICT) 기존 delete_session은 이를 애플리케이션 레벨에서 검사하지
-- 않아, 사유결석이 지정된 회차를 삭제 시도하면 원시 FK 위반 오류가 그대로
-- 노출됐다(§10 "원시 DB 오류 비노출" 원칙 위반). 두 RPC 모두에 동일하게 추가한다.

create or replace function public.delete_session(p_session_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_activity_id uuid;
begin
  select s.id, s.organization_id, s.status, s.starts_at, ot.program_id
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
    raise exception '이 회차를 삭제할 권한이 없습니다.';
  end if;
  if v_session.status <> 'scheduled' then
    raise exception '예정 상태인 회차만 삭제할 수 있습니다.';
  end if;
  if exists (select 1 from public.final_attendance where session_id = p_session_id)
    or exists (select 1 from public.instructor_attendance_submissions where session_id = p_session_id)
    or exists (select 1 from public.performance_records where source_session_id = p_session_id)
    or exists (select 1 from public.excused_absences where session_id = p_session_id)
  then
    raise exception '출석 또는 실적이 존재하는 회차는 삭제할 수 없습니다.';
  end if;

  delete from public.sessions where id = p_session_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_session.organization_id, public.current_principal_id(), 'delete_session', 'session', p_session_id);
end;
$$;

-- §8-10: 휴강 취소. cancelled -> scheduled 단방향 복귀만 지원한다. 출석/실적
-- 등 확정 업무데이터가 하나라도 있으면 즉시 차단하고, 원시 DB 오류를 그대로
-- 보여주지 않고 §10에 명시된 문구 그대로 안내한다. 취소 이력 자체는 audit_logs에
-- 남기고, 원래 휴강 처리 이력(cancelled_at/cancelled_by가 있었다는 사실)은
-- 되돌린 뒤에도 audit_logs를 통해 추적 가능하다(cancel_session이 이미 기록함).
create function public.uncancel_session(p_session_id uuid)
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
    or exists (select 1 from public.excused_absences where session_id = p_session_id)
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
