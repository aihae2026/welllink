-- WellLink v1.0 — 결석관리 OFF면 신고결석도 OFF (DB 저장 경로에서 강제)
--
-- 2026-09-10 사용자 결정: 신고결석은 결석관리의 하위 기능이다. 출결관리 설정
-- 화면(결석관리 스위치를 끄면 신고결석 스위치도 함께 꺼짐)과 앱 데이터층
-- (useAttendanceSettings가 attendance_enabled && excused_absence_enabled로 해석)에
-- 이미 같은 규칙을 넣었고, 이 migration은 유일한 저장 경로인
-- update_attendance_settings에서도 같은 규칙을 강제한다 -- 클라이언트가
-- (p_attendance_enabled=false, p_excused_absence_enabled=true)를 보내더라도
-- excused_absence_enabled는 false로 저장되고, audit_logs에도 실제 저장된 값이
-- 남는다.
--
-- 의도적으로 하지 않는 것:
--   - 기존 행 일괄 UPDATE(backfill) / CHECK 제약 추가. organizations에는 동결
--     보존 중인 ONBOARDING_QA 증거 기관이 있어 일괄 UPDATE로 건드리지 않는다
--     (CHECK 제약은 backfill 없이는 추가할 수 없다). 기존에 (false, true)로 저장된
--     기관은 앱이 이미 신고결석 OFF로 취급하며, 해당 기관이 다음에 출결관리
--     설정을 저장하면 이 함수를 거쳐 DB 값도 정리된다.
--
-- 시그니처/권한 검사/기준값 검증/감사로그 구조는
-- 20260908120000_member_code_generalize_and_onboarding_flag.sql 정의와 동일하다
-- (create or replace + 동일 시그니처라 기존 EXECUTE 권한도 그대로 유지된다).

create or replace function public.update_attendance_settings(
  p_attendance_enabled boolean,
  p_excused_absence_enabled boolean,
  p_unexcused_absence_threshold integer,
  p_excused_absence_threshold integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_excused_absence_enabled boolean;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '출결관리 설정을 변경할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  if p_unexcused_absence_threshold is null or p_unexcused_absence_threshold < 1 then
    raise exception '미신고결석 기준 회수를 확인해 주세요.';
  end if;
  if p_excused_absence_threshold is null or p_excused_absence_threshold < 1 then
    raise exception '신고결석 기준 회수를 확인해 주세요.';
  end if;

  -- 결석관리를 끄면 신고결석도 항상 끈다.
  v_excused_absence_enabled := p_attendance_enabled and p_excused_absence_enabled;

  update public.organizations
  set attendance_enabled = p_attendance_enabled,
      excused_absence_enabled = v_excused_absence_enabled,
      unexcused_absence_threshold = p_unexcused_absence_threshold,
      excused_absence_threshold = p_excused_absence_threshold,
      attendance_settings_saved_at = now()
  where id = v_org;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'update_attendance_settings', 'organization', v_org,
    jsonb_build_object(
      'attendance_enabled', p_attendance_enabled,
      'excused_absence_enabled', v_excused_absence_enabled,
      'unexcused_absence_threshold', p_unexcused_absence_threshold,
      'excused_absence_threshold', p_excused_absence_threshold
    ));
end;
$$;
