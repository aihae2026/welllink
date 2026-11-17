-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.2: 강사가 본인 담당 회차의 프로그램명을
-- 읽을 수 있도록 RLS 보강.
--
-- 실제 브라우저 E2E(강사 로그인 -> 오늘 수업)에서 발견: programs 테이블의 기존 SELECT
-- 정책("권한자 program 조회")은 can_read_activity() 기준인데, 이 함수는
-- current_business_role()이 있는 staff 전용이라 강사(principal_type='instructor')는
-- 항상 false를 반환한다. 그 결과 강사 화면에서 담당 프로그램명이 "-"로 보였다.
-- 강사 본인 담당 운영차수의 프로그램명만 추가로 열어준다(다른 프로그램은 여전히 차단).

create policy "강사 담당 프로그램명 조회" on public.programs for select
  using (
    exists (
      select 1 from public.operation_terms ot
      where ot.program_id = programs.id and public.is_run_instructor(ot.id)
    )
  );
