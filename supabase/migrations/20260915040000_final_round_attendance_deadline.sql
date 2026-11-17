-- WellLink v1.0 — 본선(심사) 기간 한시 설정: 강사 출석 입력 마감을 수업 당일 자정으로 완화.
--
-- 되돌리기: supabase/rollback/final_round_attendance_deadline_revert.sql
-- (본선 후 migrations 폴더로 옮겨 마지막 적용 시각보다 뒤의 이름으로 적용한다).
--
-- 1) 출석 입력 마감시간을 한 함수(session_input_deadline)로 모은다.
--    지금까지는 save_instructor_attendance / finalize_due_sessions / uncancel_session과
--    강사 화면이 각자 "종료 + 30분"을 계산했다. 이제 셋 모두 이 함수를 부르고, 강사 화면은
--    get_session_input_deadline RPC로 같은 값을 받는다 -- 되돌릴 때는 이 함수 하나만 바꾼다.
--    본선 기간 값: 수업 당일 자정(한국시간, 다음 날 00:00). 시작 전 입력 불가는 그대로.
--    그 밖의 함수 본문은 2026-09-15 실DB 정의와 동일하다(마감 비교 줄과 저장 오류 문구만 바뀜).
--
-- 테스트 강사 계정 활성화와 요일별 프로그램 담당 연결은 사용자가 화면에서 직접 한다(migration에 넣지 않음).

create or replace function public.session_input_deadline(p_starts_at timestamptz, p_ends_at timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $$
  -- 본선 기간: 수업 당일 자정까지. (평소 규칙: p_ends_at + interval '30 minutes')
  select ((p_starts_at at time zone 'Asia/Seoul')::date + 1)::timestamp at time zone 'Asia/Seoul';
$$;

revoke all on function public.session_input_deadline(timestamptz, timestamptz) from public, anon;
grant execute on function public.session_input_deadline(timestamptz, timestamptz) to authenticated, service_role;

-- 강사 출석 화면용. security invoker라 볼 수 있는 회차만 값이 나온다(없으면 null).
create or replace function public.get_session_input_deadline(p_session_id uuid)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select public.session_input_deadline(s.starts_at, s.ends_at)
  from public.sessions s
  where s.id = p_session_id;
$$;

revoke all on function public.get_session_input_deadline(uuid) from public, anon;
grant execute on function public.get_session_input_deadline(uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.save_instructor_attendance(p_session_id uuid, p_entries jsonb, p_idempotency_key text)
 RETURNS TABLE(submission_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session record;
  v_instructor_id uuid;
  v_expected uuid[];
  v_payload_ids uuid[] := '{}';
  v_row jsonb;
  v_enrollment_id uuid;
  v_mark text;
  v_is_pre_excused boolean;
  v_existing_submission_id uuid;
  v_existing_version integer;
  v_new_submission_id uuid;
  v_new_version integer;
begin
  select s.id, s.organization_id, s.operation_term_id, s.starts_at, s.ends_at, s.status
    into v_session
  from public.sessions s
  where s.id = p_session_id;

  if v_session.id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  if not public.is_run_instructor(v_session.operation_term_id) then
    raise exception '이 회차의 출석을 저장할 권한이 없습니다.';
  end if;

  v_instructor_id := public.current_principal_id();

  select instructor_attendance_submissions.id, instructor_attendance_submissions.version
    into v_existing_submission_id, v_existing_version
  from public.instructor_attendance_submissions
  where session_id = p_session_id and idempotency_key = p_idempotency_key;

  if v_existing_submission_id is not null then
    return query select v_existing_submission_id, v_existing_version;
    return;
  end if;

  if v_session.status <> 'scheduled' then
    raise exception '이미 마감되었거나 처리된 회차입니다.';
  end if;

  if now() < v_session.starts_at then
    raise exception '회차 시작 전에는 출석을 저장할 수 없습니다.';
  end if;
  if now() >= public.session_input_deadline(v_session.starts_at, v_session.ends_at) then
    raise exception '출석 입력 마감시간이 지나 출석을 저장할 수 없습니다.';
  end if;

  select array_agg(eid) into v_expected from public.session_effective_enrollment_ids(p_session_id) eid;
  v_expected := coalesce(v_expected, '{}');

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception '출석 입력 형식이 올바르지 않습니다.';
  end if;

  for v_row in select * from jsonb_array_elements(p_entries)
  loop
    v_enrollment_id := (v_row->>'enrollment_id')::uuid;
    v_mark := v_row->>'mark';

    if v_enrollment_id is null or v_mark is null then
      raise exception '출석 입력에 누락된 값이 있습니다.';
    end if;
    if v_enrollment_id = any (v_payload_ids) then
      raise exception '같은 수강생이 중복 전달되었습니다.';
    end if;
    v_payload_ids := array_append(v_payload_ids, v_enrollment_id);

    if not (v_enrollment_id = any (v_expected)) then
      raise exception '이 회차의 대상자가 아닌 수강생이 포함되어 있습니다.';
    end if;
    if v_mark not in ('present', 'absent', 'excused') then
      raise exception '유효하지 않은 출석값입니다: %', v_mark;
    end if;

    v_is_pre_excused := exists (
      select 1 from public.excused_absences ea
      where ea.session_id = p_session_id and ea.enrollment_id = v_enrollment_id and ea.cancelled_at is null
    );

    if v_is_pre_excused then
      if v_mark not in ('present', 'excused') then
        raise exception '사전 사유결석 대상자는 사유결석(△) 또는 출석(○)만 가능합니다.';
      end if;
    else
      if v_mark not in ('present', 'absent') then
        raise exception '사전 사유결석이 지정되지 않은 대상자는 출석(○) 또는 결석(×)만 가능합니다.';
      end if;
    end if;
  end loop;

  if array_length(v_payload_ids, 1) is distinct from array_length(v_expected, 1)
     or exists (select 1 from unnest(v_expected) x where not (x = any (v_payload_ids))) then
    raise exception '이 회차의 전체 대상자와 제출된 출석 입력이 일치하지 않습니다.';
  end if;

  select coalesce(max(instructor_attendance_submissions.version), 0) + 1 into v_new_version
  from public.instructor_attendance_submissions
  where session_id = p_session_id;

  insert into public.instructor_attendance_submissions
    (organization_id, session_id, instructor_principal_id, version, idempotency_key)
  values (v_session.organization_id, p_session_id, v_instructor_id, v_new_version, p_idempotency_key)
  returning id into v_new_submission_id;

  for v_row in select * from jsonb_array_elements(p_entries)
  loop
    insert into public.instructor_attendance_entries (submission_id, enrollment_id, mark)
    values (v_new_submission_id, (v_row->>'enrollment_id')::uuid, (v_row->>'mark')::attendance_mark);
  end loop;

  return query select v_new_submission_id, v_new_version;
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_due_sessions()
 RETURNS TABLE(out_session_id uuid, out_result text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session record;
  v_latest_submission_id uuid;
begin
  for v_session in
    select s.id, s.organization_id, s.operation_term_id
    from public.sessions s
    where s.status = 'scheduled'
      and now() >= public.session_input_deadline(s.starts_at, s.ends_at)
    order by s.ends_at
  loop
    begin
      select id into v_latest_submission_id
      from public.instructor_attendance_submissions
      where session_id = v_session.id
      order by version desc
      limit 1;

      if v_latest_submission_id is null then
        update public.sessions set status = 'missing' where id = v_session.id and status = 'scheduled';
        out_session_id := v_session.id;
        out_result := 'missing';
        return next;
      else
        insert into public.final_attendance
          (organization_id, session_id, enrollment_id, mark, source_submission_id, finalization_method)
        select v_session.organization_id, v_session.id, ie.enrollment_id, ie.mark, v_latest_submission_id, 'auto_latest_submission'
        from public.instructor_attendance_entries ie
        where ie.submission_id = v_latest_submission_id
        on conflict (session_id, enrollment_id) do nothing;

        update public.sessions
        set status = 'completed', finalized_at = now()
        where id = v_session.id and status = 'scheduled';

        perform public.recompute_attendance_performance_for_session(v_session.id);

        out_session_id := v_session.id;
        out_result := 'finalized';
        return next;
      end if;
    exception when others then
      out_session_id := v_session.id;
      out_result := 'error: ' || sqlerrm;
      return next;
    end;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.uncancel_session(p_session_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session record;
  v_activity_id uuid;
  v_new_status session_status;
begin
  select s.id, s.organization_id, s.starts_at, s.ends_at, s.status, ot.program_id
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

  if now() >= public.session_input_deadline(v_session.starts_at, v_session.ends_at) then
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
$function$;
