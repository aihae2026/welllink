-- 사용자 지시로 "변경이력" 조회 UI를 본선 범위에서 제외한다. audit_logs 테이블과
-- 모든 INSERT측 기록(assign_activity, create_business_year 등)은 그대로 유지하고,
-- 이 UI만을 위해 추가했던 조회 전용 RPC만 되돌린다.
drop function if exists public.list_audit_logs(integer);
