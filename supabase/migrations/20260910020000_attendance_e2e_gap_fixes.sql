-- Attendance E2E Manual QA Gap Fix
--
-- §3-5: 누락(missing) 회차 삭제. missing은 "종료+30분까지 강사 출석이
-- 확정되지 않았다"는 상태일 뿐 그 자체가 확정 업무이력이 아니다 -- 삭제
-- 기준은 상태가 아니라 dependency여야 한다. delete_session의 상태 가드를
-- scheduled 전용에서 scheduled/missing 둘 다 허용하도록 바꾸고, 의존성
-- 검사(final_attendance/instructor_attendance_submissions/performance_records/
-- excused_absences)는 그대로 유지한다.
--
-- §9-16: 종결 처리일시(ended_at, audit용, 불변)와 종결일(ended_effective_date,
-- 업무상 실제 적용일, 수정 가능)을 분리한다. 기존 end_session_no_exclusive는
-- session_no 기준 범위이고 session_effective_enrollment_ids()가 이미 이
-- 값만으로 "그 회차 당시 유효했던 Enrollment"를 올바르게 판단한다(활성/종결
-- 여부를 별도로 필터링하지 않음 -- 감사로 확인). 따라서 종결일을 새로
-- 수정 가능하게 만들 때, session_effective_enrollment_ids/roster/출석대상
-- 등 기존 consumer는 전혀 손대지 않고 end_session_no_exclusive를 새 종결일
-- 기준으로 재계산하는 것만으로 전체 흐름이 그대로 올바르게 동작한다.
--
-- §23-25: upsert_operation_term_for_cycle의 PostgREST overload 문제는
-- 별도 migration(20260910010000)에서 이미 수정했다.

-- ============================================================
-- 1. 누락 회차 삭제 -- 상태 가드를 scheduled/missing 허용으로 변경
-- ============================================================

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
  if v_session.status not in ('scheduled', 'missing') then
    raise exception '예정 또는 누락 상태인 회차만 삭제할 수 있습니다.';
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

-- ============================================================
-- 2. 종결일 -- 종결 처리일시(ended_at)와 분리된 업무상 적용일
-- ============================================================

alter table public.enrollments
  add column ended_effective_date date;

-- terminate_enrollments: 기존 로직(권한 검사, end_session_no_exclusive를
-- 다음 예정 회차 기준으로 계산, ended_at/ended_by 기록, audit_logs)은
-- 전혀 바꾸지 않는다. ended_effective_date만 "종결 처리한 날짜"로 함께
-- 기록한다(§10 B 기본값).
create or replace function public.terminate_enrollments(p_enrollment_ids uuid[])
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_enrollment record;
  v_activity_id uuid;
  v_organization_id uuid;
  v_next_session_no integer;
  v_count integer := 0;
begin
  for v_enrollment in
    select e.id, e.operation_term_id from public.enrollments e where e.id = any (p_enrollment_ids)
  loop
    select a.id, a.organization_id into v_activity_id, v_organization_id
    from public.operation_terms ot
    join public.programs p on p.id = ot.program_id
    join public.activities a on a.id = p.activity_id
    where ot.id = v_enrollment.operation_term_id;

    if not public.can_manage_activity(v_activity_id) then
      raise exception '수강 종결 권한이 없습니다(enrollment %).', v_enrollment.id;
    end if;

    select min(session_no) into v_next_session_no
    from public.sessions
    where operation_term_id = v_enrollment.operation_term_id and status = 'scheduled' and starts_at > now();

    update public.enrollments
    set end_session_no_exclusive = coalesce(v_next_session_no, 2147483647),
        ended_at = now(),
        ended_by = public.current_principal_id(),
        ended_effective_date = (now() at time zone 'Asia/Seoul')::date
    where id = v_enrollment.id and end_session_no_exclusive is null;

    if found then
      v_count := v_count + 1;
      insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
      values (v_organization_id, public.current_principal_id(), 'terminate_enrollment', 'enrollment', v_enrollment.id,
        jsonb_build_object('end_session_no_exclusive', coalesce(v_next_session_no, 2147483647)));
    end if;
  end loop;

  return v_count;
end;
$$;

-- 종결일 수정. end_session_no_exclusive를 새 종결일 기준으로 재계산하는
-- 것만으로 session_effective_enrollment_ids()를 쓰는 모든 기존 화면
-- (수강대상 roster, 출석 정정 roster, complete_missing_session 등)이
-- 손대지 않고도 새 기준을 그대로 따르게 된다. ended_at/ended_by(종결
-- 처리일시)는 감사 목적이라 여기서 절대 건드리지 않는다(§10 A).
create function public.update_enrollment_end_date(p_enrollment_id uuid, p_end_date date)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_enrollment record;
  v_activity_id uuid;
  v_term_start date;
  v_term_end date;
  v_new_cutoff integer;
  v_has_later_final_attendance boolean;
begin
  select e.id, e.organization_id, e.operation_term_id, e.start_session_no, e.end_session_no_exclusive
  into v_enrollment
  from public.enrollments e
  where e.id = p_enrollment_id;

  if v_enrollment.id is null then
    raise exception '수강 기록을 찾을 수 없습니다.';
  end if;

  select ot.start_date, ot.end_date into v_term_start, v_term_end
  from public.operation_terms ot
  where ot.id = v_enrollment.operation_term_id;

  v_activity_id := public.activity_id_for_operation_term(v_enrollment.operation_term_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 종결일을 수정할 권한이 없습니다.';
  end if;

  if v_enrollment.end_session_no_exclusive is null then
    raise exception '종결된 수강 기록만 종결일을 수정할 수 있습니다.';
  end if;

  if p_end_date is null then
    raise exception '종결일을 입력해 주세요.';
  end if;
  if p_end_date < v_term_start or p_end_date > v_term_end then
    raise exception '종결일은 해당 운영구분 기간(%~%) 안이어야 합니다.', v_term_start, v_term_end;
  end if;

  -- §15: 이미 확정된 출석(FinalAttendance)이 있는 회차 이후로 종결일을
  -- 당기면 확정 이력과 새 기준이 충돌한다 -- 자동으로 그 이력을 지우지
  -- 않고, 수정 자체를 막고 안내한다.
  select exists (
    select 1
    from public.final_attendance fa
    join public.sessions s on s.id = fa.session_id
    where fa.enrollment_id = p_enrollment_id
      and (s.starts_at at time zone 'Asia/Seoul')::date > p_end_date
  ) into v_has_later_final_attendance;

  if v_has_later_final_attendance then
    raise exception '이미 출석이 확정된 회차 이후로는 종결일을 수정할 수 없습니다. 해당 회차의 출석 기록을 먼저 확인해 주세요.';
  end if;

  select min(session_no) into v_new_cutoff
  from public.sessions
  where operation_term_id = v_enrollment.operation_term_id
    and (starts_at at time zone 'Asia/Seoul')::date > p_end_date;

  if v_new_cutoff is not null and v_new_cutoff < v_enrollment.start_session_no then
    raise exception '종결일이 이 수강생의 등록 시작 시점보다 이전입니다.';
  end if;

  update public.enrollments
  set end_session_no_exclusive = coalesce(v_new_cutoff, 2147483647),
      ended_effective_date = p_end_date
  where id = p_enrollment_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_enrollment.organization_id, public.current_principal_id(), 'update_enrollment_end_date', 'enrollment', p_enrollment_id,
    jsonb_build_object('ended_effective_date', p_end_date, 'end_session_no_exclusive', coalesce(v_new_cutoff, 2147483647)));
end;
$$;

-- ============================================================
-- 3. 회차 및 출석현황 -- 수강인원/출석/결석(신고) 통계 포함 목록
-- ============================================================

create function public.list_operation_term_sessions(p_operation_term_id uuid)
returns table (
  out_id uuid,
  out_session_no integer,
  out_starts_at timestamptz,
  out_ends_at timestamptz,
  out_status text,
  out_has_submission boolean,
  out_has_correction boolean,
  out_enrolled_count integer,
  out_present_count integer,
  out_absent_total_count integer,
  out_absent_excused_count integer
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_activity_id uuid;
begin
  v_activity_id := public.activity_id_for_operation_term(p_operation_term_id);
  if not public.can_read_activity(v_activity_id) then
    raise exception '이 운영정보의 회차를 조회할 권한이 없습니다.';
  end if;

  return query
  select
    s.id,
    s.session_no,
    s.starts_at,
    s.ends_at,
    s.status::text,
    exists (select 1 from public.instructor_attendance_submissions ias where ias.session_id = s.id),
    exists (
      select 1 from public.final_attendance fa
      where fa.session_id = s.id and fa.finalization_method = 'staff_correction'
    ),
    (select count(*) from public.session_effective_enrollment_ids(s.id))::integer,
    (select count(*) from public.final_attendance fa where fa.session_id = s.id and fa.mark = 'present')::integer,
    (select count(*) from public.final_attendance fa where fa.session_id = s.id and fa.mark in ('absent', 'excused'))::integer,
    (select count(*) from public.final_attendance fa where fa.session_id = s.id and fa.mark = 'excused')::integer
  from public.sessions s
  where s.operation_term_id = p_operation_term_id
  order by s.session_no;
end;
$$;

-- ============================================================
-- 4. 프로그램 제외 차단 문구 정리
-- ============================================================

create or replace function public.remove_operation_cycle_program(p_operation_cycle_id uuid, p_program_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_activity_id uuid;
  v_term_id uuid;
  v_has_business_data boolean;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '프로그램을 제외할 권한이 없습니다.';
  end if;

  if not exists (
    select 1 from public.operation_cycle_programs ocp
    join public.operation_cycles oc on oc.id = ocp.operation_cycle_id
    where ocp.operation_cycle_id = p_operation_cycle_id
      and ocp.program_id = p_program_id
      and oc.organization_id = v_org
  ) then
    raise exception '이 운영구분에 선택된 프로그램이 아닙니다.';
  end if;

  select a.id into v_activity_id
  from public.programs p join public.activities a on a.id = p.activity_id
  where p.id = p_program_id;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램을 제외할 권한이 없습니다.';
  end if;

  select id into v_term_id from public.operation_terms
  where operation_cycle_id = p_operation_cycle_id and program_id = p_program_id;

  if v_term_id is not null then
    select
      exists (select 1 from public.enrollments where operation_term_id = v_term_id)
      or exists (
        select 1 from public.sessions s
        where s.operation_term_id = v_term_id
          and (
            exists (select 1 from public.instructor_attendance_submissions where session_id = s.id)
            or exists (select 1 from public.final_attendance where session_id = s.id)
            or exists (select 1 from public.excused_absences where session_id = s.id)
            or exists (select 1 from public.performance_records where source_session_id = s.id)
          )
      )
    into v_has_business_data;

    if v_has_business_data then
      raise exception '이미 운영 이력이 있는 프로그램입니다. 기존 기록은 그대로 보존됩니다.';
    end if;

    delete from public.sessions where operation_term_id = v_term_id;
    delete from public.operation_terms where id = v_term_id;
  end if;

  delete from public.operation_cycle_programs
  where operation_cycle_id = p_operation_cycle_id and program_id = p_program_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'remove_operation_cycle_program', 'operation_cycle', p_operation_cycle_id,
    jsonb_build_object('program_id', p_program_id));
end;
$$;
