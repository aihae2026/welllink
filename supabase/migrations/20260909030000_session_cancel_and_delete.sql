-- Manual QA Gap Fix — Program Operations Closure
--
-- §19-20: 회차 휴강/삭제. sessions 테이블은 이미 session_status enum에 'cancelled'
-- 값과 cancelled_at/cancelled_by 컬럼까지 갖추고 있었지만(과거 설계 당시부터
-- 예비돼 있었음), 그 상태로 전이시키는 RPC가 지금까지 하나도 없었다. 스키마
-- 변경 없이 RPC 2개만 추가한다.
--
-- finalize_due_sessions/강사용 회차 목록은 이미 status='scheduled'만 대상으로
-- 하므로(감사로 확인됨), 'cancelled'로 전이된 회차는 별도 조치 없이도 강사
-- 출석대상/실적 생성/결석 집계에서 자연히 제외된다(§19).

-- 예정 회차 휴강. scheduled 상태에서만 가능. 이미 강사가 출석을 제출했다면
-- (아직 finalize 전이라도) 그 원본을 고아로 만들지 않도록 차단한다.
create function public.cancel_session(p_session_id uuid)
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
  if v_session.status <> 'scheduled' then
    raise exception '예정 상태인 회차만 휴강할 수 있습니다.';
  end if;
  if exists (select 1 from public.instructor_attendance_submissions where session_id = p_session_id) then
    raise exception '이미 강사가 출석을 제출한 회차는 휴강할 수 없습니다.';
  end if;

  update public.sessions
  set status = 'cancelled', cancelled_at = now(), cancelled_by = public.current_principal_id()
  where id = p_session_id and status = 'scheduled';

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_session.organization_id, public.current_principal_id(), 'cancel_session', 'session', p_session_id);
end;
$$;

-- 회차 삭제는 "아직 아무 업무데이터도 생기지 않은, 잘못 만든 미래 예정 회차"
-- 정리 용도로만 허용한다(operation_cycles의 delete_operation_cycle과 동일한
-- 원칙 -- 하위 업무데이터가 전혀 없을 때만 물리삭제, 있으면 즉시 차단).
-- 출석/실적 이력이 있는 회차는 물리삭제를 새로 도입하지 않고 cancel_session
-- (이력 보존)으로만 처리한다.
create function public.delete_session(p_session_id uuid)
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
  if v_session.status <> 'scheduled' or v_session.starts_at <= now() then
    raise exception '아직 시작하지 않은 예정 회차만 삭제할 수 있습니다.';
  end if;
  if exists (select 1 from public.final_attendance where session_id = p_session_id)
    or exists (select 1 from public.instructor_attendance_submissions where session_id = p_session_id)
    or exists (select 1 from public.performance_records where source_session_id = p_session_id)
  then
    raise exception '출석 또는 실적이 존재하는 회차는 삭제할 수 없습니다.';
  end if;

  delete from public.sessions where id = p_session_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_session.organization_id, public.current_principal_id(), 'delete_session', 'session', p_session_id);
end;
$$;
