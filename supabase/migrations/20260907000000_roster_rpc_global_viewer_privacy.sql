-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.2 Completion Pass: get_session_attendance_roster
-- global_viewer 개인정보 우회 접근 차단.
--
-- Design Lock 원칙(Batch 1.1부터 적용): global_viewer는 업무 집계는 볼 수 있어도
-- 개인 수강명단/출석원자료(성명, 회원코드 등) 원자료에는 접근할 수 없다. 기존
-- participants/enrollments 테이블의 RLS 정책은 이미 이 원칙을 지키고 있었지만,
-- Batch 1.2에서 새로 만든 get_session_attendance_roster는 SECURITY DEFINER 함수라서
-- 테이블 RLS를 우회하고, 내부 권한체크에 can_read_activity()를 그대로 썼다.
-- can_read_activity()는 global_viewer에 대해 true를 반환하도록 설계되어 있어서
-- (업무 데이터는 볼 수 있어야 하므로) 의도치 않게 global_viewer가 이 RPC를 통해
-- 성명/회원코드 원자료를 읽을 수 있는 우회 경로가 생겼다. 실제 확인됨.
--
-- 수정: 이 RPC는 담당 강사(is_run_instructor) 또는 "전체조회자를 제외한" 권한자
-- (can_manage_activity 또는 can_read_activity이면서 global_viewer가 아닌 경우)만
-- 호출할 수 있게 한다.

create or replace function public.get_session_attendance_roster(p_session_id uuid)
returns table (
  enrollment_id uuid,
  participant_id uuid,
  member_code text,
  name text,
  is_pre_excused boolean,
  latest_instructor_mark attendance_mark,
  final_mark attendance_mark,
  final_attendance_id uuid
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_operation_term_id uuid;
  v_activity_id uuid;
begin
  select s.operation_term_id into v_operation_term_id from public.sessions s where s.id = p_session_id;
  if v_operation_term_id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
  if not (
    public.is_run_instructor(v_operation_term_id)
    or (public.can_read_activity(v_activity_id) and public.current_business_role() <> 'global_viewer')
  ) then
    raise exception '이 회차의 출석정보를 조회할 권한이 없습니다.';
  end if;

  return query
  select
    e.id,
    e.participant_id,
    pt.member_code,
    pt.name,
    exists (
      select 1 from public.excused_absences ea
      where ea.session_id = p_session_id and ea.enrollment_id = e.id and ea.cancelled_at is null
    ),
    (
      select ie.mark
      from public.instructor_attendance_entries ie
      join public.instructor_attendance_submissions sub on sub.id = ie.submission_id
      where sub.session_id = p_session_id and ie.enrollment_id = e.id
      order by sub.version desc
      limit 1
    ),
    fa.mark,
    fa.id
  from public.session_effective_enrollment_ids(p_session_id) eid
  join public.enrollments e on e.id = eid
  join public.participants pt on pt.id = e.participant_id
  left join public.final_attendance fa on fa.session_id = p_session_id and fa.enrollment_id = e.id;
end;
$$;
