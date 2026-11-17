-- WellLink v1.0 — 신고결석을 수업 당일(한국시간 자정 전)까지 등록·취소할 수 있게 한다.
--
-- 지금까지 set_excused_absence / cancel_excused_absence는 회차 status가 scheduled일 때만
-- 받았다. 그래서 오늘 수업이라도 누락(missing)·확정(completed)으로 넘어가면 직원이
-- 신고결석을 바꿀 수 없었다(2026-09-15 사용자 결정으로 당일 자정까지 허용).
--
-- 바뀌는 규칙:
--   * 결석일(starts_at의 한국시간 날짜)이 오늘 이후면 등록·취소 가능. 어제 이전은 불가
--     (출석정정 이용).
--   * 휴강(cancelled) 회차에는 등록 불가(취소는 허용 -- 정리용).
--   * 확정(completed) 회차: 공식출석을 함께 바로잡는다.
--       등록: 결석(absent) -> 신고결석(excused). 출석(present)으로 확정된 이용자는 등록 불가.
--       취소: 신고결석(excused) -> 결석(absent).
--     바꿀 때는 correct_final_attendance와 같은 방식으로 finalization_method =
--     staff_correction, attendance_corrections 이력, 실적 재계산, audit_logs를 남긴다.
--   * 누락(missing) 회차: 공식출석이 아직 없으므로 신고결석만 바꾼다(누락보완 명단에 반영).
--
-- finalize_due_sessions: 강사가 출석을 저장한 뒤 직원이 신고결석을 바꾸면 강사 입력값과
-- 어긋날 수 있다. 자동확정 때 결석/신고결석만 신고결석 표에 맞춰 바로잡는다
-- (출석은 그대로, 강사 원본 입력 instructor_attendance_entries는 보존).
-- 그 밖의 finalize_due_sessions 본문은 2026-09-15 실DB 정의와 동일하다.
--
-- create or replace(시그니처·반환형 동일)라 기존 실행 권한은 그대로 유지된다.

-- 확정 회차의 공식출석 1건을 신고결석 등록/취소에 맞춰 바꾼다(내부 전용).
create or replace function public.sync_final_attendance_for_excused(
  p_session_id uuid,
  p_enrollment_id uuid,
  p_from_mark attendance_mark,
  p_to_mark attendance_mark,
  p_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_final record;
begin
  select fa.id, fa.organization_id, fa.mark
    into v_final
  from public.final_attendance fa
  where fa.session_id = p_session_id and fa.enrollment_id = p_enrollment_id;

  if v_final.id is null or v_final.mark <> p_from_mark then
    return;
  end if;

  update public.final_attendance
  set mark = p_to_mark, finalization_method = 'staff_correction', updated_at = now()
  where id = v_final.id;

  insert into public.attendance_corrections
    (organization_id, final_attendance_id, session_id, enrollment_id, before_mark, after_mark, reason, corrected_by)
  values
    (v_final.organization_id, v_final.id, p_session_id, p_enrollment_id, p_from_mark, p_to_mark, p_reason, public.current_principal_id());

  perform public.recompute_attendance_performance_for_session(p_session_id);

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json, reason)
  values (v_final.organization_id, public.current_principal_id(), 'correct_final_attendance', 'final_attendance', v_final.id,
          jsonb_build_object('mark', p_from_mark), jsonb_build_object('mark', p_to_mark), p_reason);
end;
$$;

revoke all on function public.sync_final_attendance_for_excused(uuid, uuid, attendance_mark, attendance_mark, text)
  from public, anon, authenticated;

create or replace function public.set_excused_absence(p_session_id uuid, p_enrollment_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_organization_id uuid;
  v_operation_term_id uuid;
  v_status session_status;
  v_starts_at timestamptz;
  v_activity_id uuid;
  v_id uuid;
  v_final_mark attendance_mark;
begin
  select s.organization_id, s.operation_term_id, s.status, s.starts_at
    into v_organization_id, v_operation_term_id, v_status, v_starts_at
  from public.sessions s
  where s.id = p_session_id;

  if v_organization_id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 사유결석을 지정할 권한이 없습니다.';
  end if;

  if (v_starts_at at time zone 'Asia/Seoul')::date < (now() at time zone 'Asia/Seoul')::date then
    raise exception '지난 날짜의 회차는 신고결석을 등록할 수 없습니다. 출석정정을 이용해 주세요.';
  end if;

  if v_status = 'cancelled' then
    raise exception '휴강한 회차에는 신고결석을 등록할 수 없습니다.';
  end if;

  if not exists (
    select 1 from public.session_effective_enrollment_ids(p_session_id) eid where eid = p_enrollment_id
  ) then
    raise exception '해당 회차 시점에 유효한 수강생이 아닙니다.';
  end if;

  select id into v_id from public.excused_absences
  where session_id = p_session_id and enrollment_id = p_enrollment_id and cancelled_at is null;

  if v_id is not null then
    return v_id;
  end if;

  if v_status = 'completed' then
    select fa.mark into v_final_mark
    from public.final_attendance fa
    where fa.session_id = p_session_id and fa.enrollment_id = p_enrollment_id;

    if v_final_mark = 'present' then
      raise exception '이미 출석으로 확정된 이용자입니다. 출석정정을 이용해 주세요.';
    end if;
  end if;

  insert into public.excused_absences (organization_id, session_id, enrollment_id, created_by)
  values (v_organization_id, p_session_id, p_enrollment_id, public.current_principal_id())
  returning id into v_id;

  if v_status = 'completed' then
    perform public.sync_final_attendance_for_excused(p_session_id, p_enrollment_id, 'absent', 'excused', '신고결석 등록');
  end if;

  return v_id;
end;
$$;

create or replace function public.cancel_excused_absence(p_session_id uuid, p_enrollment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_operation_term_id uuid;
  v_status session_status;
  v_starts_at timestamptz;
  v_activity_id uuid;
  v_cancelled integer;
begin
  select s.operation_term_id, s.status, s.starts_at into v_operation_term_id, v_status, v_starts_at
  from public.sessions s where s.id = p_session_id;

  if v_operation_term_id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 사유결석을 해제할 권한이 없습니다.';
  end if;

  if (v_starts_at at time zone 'Asia/Seoul')::date < (now() at time zone 'Asia/Seoul')::date then
    raise exception '지난 날짜의 회차는 신고결석을 취소할 수 없습니다. 출석정정을 이용해 주세요.';
  end if;

  update public.excused_absences
  set cancelled_at = now()
  where session_id = p_session_id and enrollment_id = p_enrollment_id and cancelled_at is null;
  get diagnostics v_cancelled = row_count;

  if v_cancelled > 0 and v_status = 'completed' then
    perform public.sync_final_attendance_for_excused(p_session_id, p_enrollment_id, 'excused', 'absent', '신고결석 취소');
  end if;
end;
$$;

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
        -- 강사 저장 뒤 직원이 신고결석을 바꾼 경우: 결석/신고결석만 신고결석 표에 맞춘다.
        insert into public.final_attendance
          (organization_id, session_id, enrollment_id, mark, source_submission_id, finalization_method)
        select v_session.organization_id, v_session.id, ie.enrollment_id,
               case
                 when ie.mark = 'absent' and ea.id is not null then 'excused'::attendance_mark
                 when ie.mark = 'excused' and ea.id is null then 'absent'::attendance_mark
                 else ie.mark
               end,
               v_latest_submission_id, 'auto_latest_submission'
        from public.instructor_attendance_entries ie
        left join public.excused_absences ea
          on ea.session_id = v_session.id and ea.enrollment_id = ie.enrollment_id and ea.cancelled_at is null
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
