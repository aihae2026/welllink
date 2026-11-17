-- ============================================================
-- 출석 자동확정/누락처리 Cron을 DB(pg_cron)로 이관
-- ============================================================
-- vite.config.ts의 Nitro scheduledTasks("* * * * *")는 Cloudflare Cron Trigger로
-- 변환될 것을 전제로 했지만, Lovable 배포에서는 실제로 돌지 않았다.
-- 2026-09-10 원격 DB 확인: 마감(종료+30분)이 지난 scheduled 회차 274건이 그대로
-- 남아 있었고, finalization_method='auto_latest_submission' 기록은 0건이었다.
--
-- 업무규칙은 기존 finalize_due_sessions()(20260907010000:174-227)를 그대로 쓴다.
-- 여기서는 그 함수를 매분 부르는 스케줄만 등록한다. 함수는 status='scheduled'만
-- 대상으로 하고 final_attendance는 on conflict do nothing이라, Nitro task가 함께
-- 돌아도 이중 처리되지 않는다.
--
-- 작업은 postgres로 등록되어 postgres로 실행된다. finalize_due_sessions()는
-- postgres 소유 security definer라 service_role 전용 잠금(20260910065000)과
-- 무관하게 실행된다.

create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'welllink-finalize-due-sessions') then
    perform cron.unschedule('welllink-finalize-due-sessions');
  end if;
end $$;

select cron.schedule(
  'welllink-finalize-due-sessions',
  '* * * * *',
  $$select count(*) from public.finalize_due_sessions()$$
);

-- 적용 직후 검증: 작업이 정확히 1개, 활성 상태로 등록되지 않았으면 실패시킨다.
do $$
begin
  if (select count(*) from cron.job
      where jobname = 'welllink-finalize-due-sessions' and active and schedule = '* * * * *') <> 1 then
    raise exception 'welllink-finalize-due-sessions cron job not registered';
  end if;
end $$;
