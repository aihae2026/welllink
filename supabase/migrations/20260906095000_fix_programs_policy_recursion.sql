-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.2: programs RLS 정책 무한재귀 수정.
--
-- 실제 브라우저 E2E(강사 로그인 -> 회차 상세)에서 발견: "강사 담당 프로그램명 조회"
-- 정책이 programs 정책 평가 중에 operation_terms를 직접 서브쿼리로 조회했는데,
-- operation_terms의 기존 정책("권한자 운영차수 조회")이 다시 programs를 조회한다.
-- 두 정책 모두 authenticated 역할로 평가되어 RLS가 계속 재적용되면서
-- "infinite recursion detected in policy for relation programs" 오류가 발생했다.
--
-- 고쳐야 할 부분은 조회 대상이 아니라 "어떻게 확인하는가"다: SECURITY DEFINER 함수는
-- 테이블 소유자 권한으로 실행되어 그 함수 내부의 조회에는 RLS가 재적용되지 않는다
-- (can_read_activity 등 기존 helper들이 이미 이 패턴을 쓴다). 같은 패턴으로
-- operation_terms 조회를 SECURITY DEFINER 함수 안으로 옮겨 재귀를 끊는다.

create function public.instructs_program(p_program_id uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.operation_terms ot
    where ot.program_id = p_program_id and public.is_run_instructor(ot.id)
  );
$$;

drop policy if exists "강사 담당 프로그램명 조회" on public.programs;

create policy "강사 담당 프로그램명 조회" on public.programs for select
  using (public.instructs_program(id));
