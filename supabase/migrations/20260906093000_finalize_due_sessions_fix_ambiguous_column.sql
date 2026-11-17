-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.2: finalize_due_sessions 컬럼명 모호성 수정.
--
-- returns table(session_id uuid, result text)의 OUT 파라미터 이름 session_id가
-- 함수 본문의 `on conflict (session_id, enrollment_id)` 충돌대상 컬럼 목록과 충돌해
-- "column reference session_id is ambiguous" 오류가 실제로 발생했다(RPC 테스트 중
-- 확인). ON CONFLICT 충돌대상 컬럼은 테이블 별칭으로 한정할 수 없으므로, OUT
-- 파라미터 이름 자체를 테이블 컬럼명과 겹치지 않게 바꾼다.

drop function if exists public.finalize_due_sessions();

create function public.finalize_due_sessions()
returns table (out_session_id uuid, out_result text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_latest_submission_id uuid;
begin
  for v_session in
    select s.id, s.organization_id, s.operation_term_id
    from public.sessions s
    where s.status = 'scheduled'
      and now() >= s.ends_at + interval '30 minutes'
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
$$;

revoke execute on function public.finalize_due_sessions() from public, anon, authenticated;
grant execute on function public.finalize_due_sessions() to service_role;
