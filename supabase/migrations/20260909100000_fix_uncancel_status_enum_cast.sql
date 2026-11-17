-- Program Settings Final Design Lock — bugfix (same class as 20260909090000)
--
-- uncancel_session의 v_new_status가 text 변수로 선언되어 있어
-- `v_new_status := case when ... then 'missing' else 'scheduled' end;`
-- 대입 자체는 되지만, 그 text 변수를 다시 `update ... set status = v_new_status`로
-- session_status enum 컬럼에 넣을 때 암시적 캐스팅이 안 되어 동일한
-- "column status is of type session_status but expression is of type text"
-- 오류로 휴강취소(예정/누락 스마트 복귀, §42)가 항상 실패하던 실제 버그였다
-- (QA 중 실제 재현·확인). v_new_status를 session_status 타입으로 선언하고
-- CASE 없이 IF/ELSE로 리터럴을 직접 대입하도록 바꾼다(리터럴을 enum 타입
-- 변수에 직접 대입하는 것은 항상 안전하게 캐스팅된다). 가드 조건/로직은
-- 전혀 바꾸지 않는다.
create or replace function public.uncancel_session(p_session_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_activity_id uuid;
  v_new_status session_status;
begin
  select s.id, s.organization_id, s.ends_at, s.status, ot.program_id
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

  if now() >= v_session.ends_at + interval '30 minutes' then
    v_new_status := 'missing';
  else
    v_new_status := 'scheduled';
  end if;

  update public.sessions
  set status = v_new_status, cancelled_at = null, cancelled_by = null
  where id = p_session_id and status = 'cancelled';

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_session.organization_id, public.current_principal_id(), 'uncancel_session', 'session', p_session_id,
    jsonb_build_object('new_status', v_new_status));
end;
$$;
