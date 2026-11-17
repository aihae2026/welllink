-- WellLink v1.0 — 본선(심사) 기간 한시 설정 되돌리기.
-- 대상: supabase/migrations/20260915040000_final_round_attendance_deadline.sql
--
-- 사용법(본선 후): 이 파일을 supabase/migrations/로 복사하고, 파일명 앞 시각을
-- 원격에 마지막으로 적용된 migration보다 뒤로 붙인다(예: 20261201000000_final_round_attendance_deadline_revert.sql).
-- 적용 전 --dry-run으로 대상 확인.
--
-- 1) 출석 입력 마감을 "종료 + 30분"으로 복원한다. 세 DB 함수와 강사 화면은
--    session_input_deadline을 거치므로 이 함수 하나만 바꾸면 된다(코드 수정 불필요).
-- 2) 테스트 강사 계정("테스트")이 저장한 출석을 지운다. 그 회차에 쌓인 확정 출석·정정 이력도
--    함께 지우고(본선 기간 직원 정정 포함), 회차를 누락(마감 전이면 예정)으로 돌린 뒤 실적을 다시 계산한다.
--
-- 테스트 강사의 프로그램 담당 원복과 계정 비활성화는 사용자가 화면에서 직접 한다.

create or replace function public.session_input_deadline(p_starts_at timestamptz, p_ends_at timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select p_ends_at + interval '30 minutes';
$$;

do $$
declare
  v_test uuid := '151c8215-db0c-4e66-b30f-e38185543914';
  v_session_id uuid;
  v_sessions integer := 0;
begin
  for v_session_id in
    select distinct session_id
    from public.instructor_attendance_submissions
    where instructor_principal_id = v_test
  loop
    delete from public.attendance_corrections where session_id = v_session_id;
    delete from public.final_attendance where session_id = v_session_id;
    delete from public.instructor_attendance_submissions
    where session_id = v_session_id and instructor_principal_id = v_test;

    update public.sessions
    set status = case when now() >= public.session_input_deadline(starts_at, ends_at)
                      then 'missing'::session_status else 'scheduled'::session_status end,
        finalized_at = null
    where id = v_session_id and status in ('completed', 'scheduled');

    perform public.recompute_attendance_performance_for_session(v_session_id);
    v_sessions := v_sessions + 1;
  end loop;

  raise notice '테스트 강사 입력 정리: 회차 %개', v_sessions;
end;
$$;
