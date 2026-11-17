-- WellLink v1.0 — 강사 로그인 보안 강화 (2단계: 옛 경로 폐쇄)
--
-- 20261104010000 migration과 그 migration을 쓰는 새 코드가 배포된 뒤에 적용한다.
-- 새 코드를 배포하기 전에 적용하면, 옛 화면이 삭제된 함수를 호출해 강사의 PIN 설정에서
-- 오류가 난다.
--
-- 아래 두 함수는 현재 PIN이나 세션을 확인하지 않고도 이름·뒤4자리만 알면 PIN을 바꾸거나
-- "현재 PIN 그대로 사용"을 확정할 수 있었다(전문가 검토 의견: 기술적 리스크 2번).
-- 새 5-인자 set_instructor_pin(현재 PIN 검증 포함)만 남긴다.
drop function if exists public.set_instructor_pin(text, text, text, text);
drop function if exists public.confirm_instructor_current_pin(text, text, text);
