-- Attendance E2E Manual QA Gap Fix §23-25
--
-- 실제 확인된 심각한 버그: upsert_operation_term_for_cycle이 여러 배치를
-- 거치며 파라미터를 늘릴 때마다 매번 `create or replace function`을 썼지만,
-- Postgres의 CREATE OR REPLACE FUNCTION은 인자 시그니처(개수/이름/순서)가
-- 완전히 같을 때만 "교체"하고, 다르면 새 함수(overload)를 추가로 만든다 --
-- 에러 없이 조용히 overload가 누적된다. 그 결과 현재 DB에는 이 이름으로
-- 5개의 서로 다른 signature가 동시에 존재한다(pg_proc 직접 조회로 확인):
--   1) 6-param (최초, p_instructor_principal_id까지)
--   2) 7-param (+p_excluded_dates)
--   3) 8-param (+p_instructor_name_text)
--   4) 10-param (+p_schedule_mode, +p_explicit_dates)
--   5) 11-param (+p_holiday_auto_cancel) -- 현재 canonical
-- 공휴일 자동휴강 기능을 넣을 때(1~4는 이미 5로 대체된 줄 알았으나 실제로는
-- 남아있었음)와 뺄 때(client가 11번째 인자를 다시 보내지 않게 되면서 10-param
-- overload(#4)와 11-param overload(#5) 사이에서 PostgREST가 어느 쪽을 호출할지
-- 정할 수 없는 PGRST203 "Could not choose the best candidate function" 오류가
-- 실제로 재현됨(RPC 직접 호출로 확인) -- 강사 변경뿐 아니라 기본설정 저장
-- 전체가 이 상태에서는 항상 실패한다.
--
-- 정확한 인자 타입 signature로 obsolete overload(1~4) 4개만 DROP한다.
-- 함수 이름 전체를 지우지 않고, 현재 client가 실제로 쓰는 canonical
-- 11-param 버전(#5)은 그대로 둔다(재정의하지 않음 -- 로직 변경 없음).

drop function if exists public.upsert_operation_term_for_cycle(
  uuid, uuid, smallint[], time, time, uuid
);

drop function if exists public.upsert_operation_term_for_cycle(
  uuid, uuid, smallint[], time, time, uuid, date[]
);

drop function if exists public.upsert_operation_term_for_cycle(
  uuid, uuid, smallint[], time, time, uuid, date[], text
);

drop function if exists public.upsert_operation_term_for_cycle(
  uuid, uuid, smallint[], time, time, uuid, date[], text, text, date[]
);
