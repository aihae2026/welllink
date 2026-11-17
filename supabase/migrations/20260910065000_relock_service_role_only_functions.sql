-- ============================================================
-- service_role 전용 함수 재잠금 (20260910050651 부작용 복구)
-- ============================================================
-- 20260910050651(Lovable 보안 일괄 수정)의 DO-loop가 public 스키마의 모든 함수에
-- `GRANT EXECUTE ... TO authenticated, service_role`을 걸면서, 앞선 migration들이
-- 의도적으로 service_role 전용으로 잠가둔 함수까지 로그인 사용자에게 열렸다.
--
-- 2026-09-10 원격 DB 확인(has_function_privilege) 결과 authenticated가 여전히
-- 실행 가능한 것은 아래 3개다. 나머지 service_role 전용 함수
-- (verify_instructor_login 4-arg, set_instructor_pin 4-arg,
-- confirm_instructor_current_pin 3-arg, resolve_organization_id_by_code,
-- activity_has_performance)는 20260910040000/060000이 이미 다시 잠갔다.
--
--   finalize_due_sessions()                          -- 원래: 20260907010000:229-230
--   recompute_attendance_performance_for_session(uuid) -- 원래: 20260907010000:165
--   begin_instructor_login(text, text)               -- 원래: 20260907030000:347-348
--
-- recompute_...를 부르는 complete_missing_session / correct_final_attendance /
-- finalize_due_sessions는 모두 postgres 소유 security definer라 authenticated
-- 권한을 회수해도 내부 호출은 영향 없다. finalize_due_sessions는
-- src/server/tasks/finalize-due-sessions.ts에서 admin(service_role)으로만 호출한다.

revoke execute on function public.finalize_due_sessions() from public, anon, authenticated;
grant execute on function public.finalize_due_sessions() to service_role;

revoke execute on function public.recompute_attendance_performance_for_session(uuid) from public, anon, authenticated;
grant execute on function public.recompute_attendance_performance_for_session(uuid) to service_role;

revoke execute on function public.begin_instructor_login(text, text) from public, anon, authenticated;
grant execute on function public.begin_instructor_login(text, text) to service_role;

-- 적용 직후 검증: 하나라도 authenticated/anon이 실행 가능하거나 service_role이
-- 실행 불가하면 트랜잭션 전체를 실패시킨다.
do $$
declare
  v_sig regprocedure;
begin
  foreach v_sig in array array[
    'public.finalize_due_sessions()'::regprocedure,
    'public.recompute_attendance_performance_for_session(uuid)'::regprocedure,
    'public.begin_instructor_login(text, text)'::regprocedure
  ] loop
    if has_function_privilege('authenticated', v_sig, 'EXECUTE')
       or has_function_privilege('anon', v_sig, 'EXECUTE')
       or not has_function_privilege('service_role', v_sig, 'EXECUTE') then
      raise exception 'relock failed for %', v_sig;
    end if;
  end loop;
end $$;
