-- WellLink v1.0 — 관리자 전용 RPC가 "직원 권한값이 없는 로그인"을 통과시키던 문제 수정.
--
-- 권한은 관리자(global_manager + 시스템관리자) / 일반(staff) 두 가지다. 그런데
-- 관리자 전용 RPC 다수가 `current_business_role() <> 'global_manager'`로 거부하고,
-- 운영구분 RPC와 수강명단 일괄등록은 `current_business_role() = 'global_viewer'`로만
-- 거부했다. 강사 로그인(및 직원 프로필 없는 사용자)은 current_business_role()이
-- NULL이고, SQL에서 NULL 비교는 NULL(=거짓 취급)이라 이 조건들에 걸리지 않아
-- 통과했다(2026-09-15 강사 세션으로 확인). 강사 로그인은 실제 인증 세션이라
-- API를 직접 호출하면 기관 설정 변경이 가능한 상태였다.
--
-- 바꾸는 것은 각 함수의 "권한 조건" 한 곳뿐이고, 본문의 나머지는 실DB에 적용된
-- 현재 정의를 그대로 둔다(pg_get_functiondef로 읽어 조건만 치환 후 재생성).
-- 치환할 조건을 찾지 못한 함수가 하나라도 있으면 이 migration 전체가 실패한다.
--
-- 1) 관리자 전용(21개): `<> 'global_manager'` -> `is distinct from 'global_manager'`
--    (NULL도 거부). 일반 직원은 원래부터 거부 대상이라 동작 변화 없음.
-- 2) 담당자 목록(list_assignable_staff): `not in ('global_manager','department_manager')`
--    -> NULL이면 ''로 보고 거부.
-- 3) 운영구분 생성·수정·삭제(3개): `= 'global_viewer'` -> `is distinct from 'global_manager'`
--    (사용자 결정: 관리자 전용으로 잠금. 화면도 운영설정=관리자 전용).
-- 4) 수강명단 일괄등록(apply_bulk_roster_for_cycle): 활동 권한 검사가 없어서
--    NULL을 조회전용과 같이 거부한다. 일반 직원은 그대로 허용.
-- add_operation_cycle_programs / list_selectable_programs_for_cycle /
-- remove_operation_cycle_program은 뒤에 활동 권한 검사가 있어 강사가 이미 막히므로 두지 않는다.

do $$
declare
  v_rule record;
  v_fn text;
  v_oid oid;
  v_def text;
  v_new text;
begin
  for v_rule in
    select * from (values
      -- (함수 목록, 찾을 정규식, 바꿀 조건)
      (array[
        'apply_business_structure_excel', 'assign_activity', 'create_activity_with_program',
        'create_business_node', 'create_business_year', 'create_department', 'create_unit_business',
        'delete_activity', 'delete_business_node', 'delete_business_year', 'delete_unit_business',
        'list_departments', 'set_department_active', 'set_staff_department', 'unassign_activity',
        'update_activity', 'update_attendance_settings', 'update_business_node', 'update_business_year',
        'update_operation_cycle_mode', 'update_organization_name', 'update_unit_business'
      ],
       '(public\.)?current_business_role\(\) <> ''global_manager''',
       'public.current_business_role() is distinct from ''global_manager'''),
      (array['list_assignable_staff'],
       '(public\.)?current_business_role\(\) not in \(''global_manager'', ''department_manager''\)',
       'coalesce(public.current_business_role()::text, '''') not in (''global_manager'', ''department_manager'')'),
      (array['create_operation_cycle', 'update_operation_cycle', 'delete_operation_cycle'],
       '(public\.)?current_business_role\(\) = ''global_viewer''',
       'public.current_business_role() is distinct from ''global_manager'''),
      (array['apply_bulk_roster_for_cycle'],
       '(public\.)?current_business_role\(\) = ''global_viewer''',
       'coalesce(public.current_business_role()::text, ''global_viewer'') = ''global_viewer''')
    ) as t(fns, pattern, replacement)
  loop
    foreach v_fn in array v_rule.fns loop
      select p.oid into strict v_oid
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_fn;

      v_def := pg_get_functiondef(v_oid);
      if v_def !~ v_rule.pattern then
        raise exception '%: 바꿀 권한 조건을 찾지 못했습니다(정의가 예상과 다름).', v_fn;
      end if;
      v_new := regexp_replace(v_def, v_rule.pattern, v_rule.replacement, 'g');
      execute v_new;
    end loop;
  end loop;
end;
$$;
