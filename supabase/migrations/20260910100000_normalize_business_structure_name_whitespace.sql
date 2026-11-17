-- 사업구조 이름의 줄바꿈 정리.
--
-- 문제: 사업구조 Excel 등록 때 셀 안 줄바꿈(Alt+Enter)이 이름에 그대로 저장됐다
-- (예: "급식\r\n운영관리"). 화면은 줄바꿈을 공백으로 보여 줘서 티가 안 나지만,
-- 연간계획 템플릿을 내려받아 다시 올리면 줄바꿈 문자가 바뀌어(\r\n -> \r\r\n)
-- 이름 매칭이 전부 실패했다(A기관 81행 중 28행).
--
-- 1. 기존 이름 정리: 공백·줄바꿈 덩어리를 공백 한 칸으로 합치고 앞뒤를 자른다.
--    화면에 원래 보이던 모양 그대로다. 적용 시점 실DB 대상은 A기관
--    9건이며, 정리 후 같은 범위 안에서 이름이 겹치는 경우는 없음을 확인했다.
--      단위사업  "재가노인\r\n지원사업"          -> "재가노인 지원사업"(1-2에서 붙여쓰기)
--      대분류    "상담 및 \r\n정보제공"          -> "상담 및 정보제공"
--      대분류    "정서 및 \r\n사회생활지원"      -> "정서 및 사회생활지원"
--      대분류    "가족통합지원\r\n(○○패밀리)"  -> "가족통합지원 (○○패밀리)"(1-3에서 "가족통합지원")
--      대분류    "노인전문\r\n자원봉사"          -> "노인전문 자원봉사"
--      중분류    "프로그램\r\n운영관리"          -> "프로그램 운영관리"
--      중분류    "급식\r\n운영관리"              -> "급식 운영관리"
--      중분류    "직원\r\n복리후생"              -> "직원 복리후생"
--      중분류    "○○\r\n실버스타"              -> "○○ 실버스타"
--    활동/프로그램 이름은 대상이 없지만 같은 규칙으로 함께 정리한다(0건). 이름
--    변경 잠금(update_activity)은 "다른 이름으로 바꾸기"를 막는 것이고 이 정리는
--    글자가 바뀌지 않으므로 해당하지 않는다.
--
-- 2. 재발 방지: apply_business_structure_excel이 이름을 같은 규칙으로 정리한 뒤
--    기존 항목과 비교/저장한다. 이게 없으면 줄바꿈이 든 원본 Excel을 다시 올렸을
--    때 정리된 기존 대분류와 다른 이름으로 보여 중복 대분류가 생기거나 활동 위치
--    충돌로 등록 전체가 실패한다. 화면(BusinessStructureExcelDialog)도 같은 규칙으로
--    먼저 정리해서 보낸다. PostgreSQL trim()은 줄바꿈을 자르지 않으므로
--    regexp_replace로 합친 뒤 btrim한다.

-- ============================================================
-- 1. 기존 이름 정리
-- ============================================================
update public.unit_businesses
set name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
where name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));

update public.business_nodes
set name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
where name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));

update public.activities
set name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
where name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));

update public.programs
set name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
where name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));

-- ============================================================
-- 1-2. 사용자 지정 이름 변경(A기관 2026, 2026-09-10 사용자 요청)
-- ============================================================
-- - 단위사업 "재가노인 지원사업"(위 정리 결과) -> "재가노인지원사업": 다른 단위사업과
--   같은 붙여쓰기. 같은 사업연도 안에 같은 이름 없음 확인(테스트복지관의 같은 이름은
--   다른 사업연도). 이 단위사업의 AI 사업평가 기록 0건.
-- - 활동 "리듬피트니스" -> "리듬 피트니스": update_activity의 이름변경 잠금은
--   운영정보(operation_terms)만 있어도 막으므로 화면에서는 바꿀 수 없다. 하지만 이
--   활동은 하반기 운영정보만 있고(22회차 전부 예정, 실적 0건) 이름이 바뀌어 보일 지난
--   기록이 없어 잠금의 취지(지난 기록 이름 보존)에 걸리지 않으므로 여기서 직접
--   바꾼다. programs.name도 같이 바꾼다(update_activity와 동일).
insert into public.audit_logs (organization_id, action, entity_type, entity_id, before_json, after_json, reason)
select organization_id, 'update_unit_business', 'unit_business', id,
  jsonb_build_object('name', name), jsonb_build_object('name', '재가노인지원사업'),
  'migration 20260910100000: 사용자 요청 이름 정리'
from public.unit_businesses
where id = 'dd51c0e0-d829-4b32-960a-bf0b98cecc70';

update public.unit_businesses
set name = '재가노인지원사업'
where id = 'dd51c0e0-d829-4b32-960a-bf0b98cecc70';

insert into public.audit_logs (organization_id, action, entity_type, entity_id, before_json, after_json, reason)
select organization_id, 'update_activity', 'activity', id,
  jsonb_build_object('name', name), jsonb_build_object('name', '리듬 피트니스'),
  'migration 20260910100000: 사용자 요청 이름 정리(띄어쓰기, 실적·진행 회차 없음)'
from public.activities
where business_year_id = 'c4754ce1-bd01-416a-b579-285e93133cdf' and name = '리듬피트니스';

update public.programs p
set name = '리듬 피트니스'
from public.activities a
where p.activity_id = a.id
  and a.business_year_id = 'c4754ce1-bd01-416a-b579-285e93133cdf' and a.name = '리듬피트니스';

update public.activities
set name = '리듬 피트니스'
where business_year_id = 'c4754ce1-bd01-416a-b579-285e93133cdf' and name = '리듬피트니스';

-- ============================================================
-- 1-3. 가족통합지원 대분류 정리(A기관 2026, 2026-09-10 사용자 요청)
-- ============================================================
-- - 대분류 "가족통합지원 (○○패밀리)" -> "가족통합지원"
-- - 중분류 "중분류 가"(활동 2) + "중분류 나"(활동 2) -> "○○패밀리"(활동 4):
--   중분류 가 노드를 "○○패밀리"로 이름만 바꿔 남기고, 중분류 나의 활동 2개를 옮긴 뒤
--   빈 중분류 나 노드를 지운다. 활동/프로그램/연간계획/실적은 활동 id 기준이라 그대로다.
--   실적보고의 중분류 행만 두 줄에서 한 줄(합산)로 바뀐다.
-- 적용 시점 확인: 중분류 나에 하위 노드·부서관리자 관리범위 없음, 같은 사업연도에
-- "가족통합지원"/"○○패밀리" 노드 없음. 대분류가 없으면 건너뛰고, 있는데 상태가 달라져 있으면 전체를 중단한다.
do $$
declare
  v_major uuid := 'c7be8fa1-42d4-4d6f-9d0e-3d8eaa8ee4b5';
  v_keep uuid := '78177635-97a3-4956-aa56-26b2fccb9ce6'; -- 중분류 가 -> ○○패밀리
  v_drop uuid := '5d974458-e98f-4846-8be9-e6e9b2c56761'; -- 중분류 나 -> 통합 후 삭제
  v_org uuid;
  v_major_name text;
  v_moved uuid[];
begin
  select organization_id, name into v_org, v_major_name
  from public.business_nodes where id = v_major and node_type = 'major';
  if v_org is null then
    -- A기관 DB 전용 정리다. 이 대분류가 없는 DB(새로 설치한 DB 등)에서는 건너뛴다.
    return;
  end if;
  if not exists (select 1 from public.business_nodes where id = v_keep and parent_id = v_major and node_type = 'middle' and name = '중분류 가')
    or not exists (select 1 from public.business_nodes where id = v_drop and parent_id = v_major and node_type = 'middle' and name = '중분류 나')
  then
    raise exception '가족통합지원 대분류/중분류 상태가 예상과 다릅니다. 중단합니다.';
  end if;
  if exists (select 1 from public.business_nodes where parent_id = v_drop)
    or exists (select 1 from public.department_manager_scopes where business_node_id = v_drop)
  then
    raise exception '중분류 나에 하위 노드 또는 부서관리자 관리범위가 있어 통합할 수 없습니다.';
  end if;

  update public.business_nodes set name = '가족통합지원' where id = v_major;
  insert into public.audit_logs (organization_id, action, entity_type, entity_id, before_json, after_json, reason)
  values (v_org, 'update_business_node', 'business_node', v_major,
    jsonb_build_object('name', v_major_name), jsonb_build_object('name', '가족통합지원'),
    'migration 20260910100000: 사용자 요청 이름 정리');

  update public.business_nodes set name = '○○패밀리' where id = v_keep;
  insert into public.audit_logs (organization_id, action, entity_type, entity_id, before_json, after_json, reason)
  values (v_org, 'update_business_node', 'business_node', v_keep,
    jsonb_build_object('name', '중분류 가'), jsonb_build_object('name', '○○패밀리'),
    'migration 20260910100000: 중분류 가+중분류 나 -> ○○패밀리 통합');

  select array_agg(id) into v_moved from public.activities where business_node_id = v_drop;
  update public.activities set business_node_id = v_keep where business_node_id = v_drop;

  delete from public.business_nodes where id = v_drop;
  insert into public.audit_logs (organization_id, action, entity_type, entity_id, before_json, after_json, reason)
  values (v_org, 'merge_business_node', 'business_node', v_drop,
    jsonb_build_object('name', '중분류 나', 'node_type', 'middle', 'parent_id', v_major),
    jsonb_build_object('merged_into', v_keep, 'moved_activity_ids', to_jsonb(coalesce(v_moved, '{}'))),
    'migration 20260910100000: 중분류 가+중분류 나 -> ○○패밀리 통합');
end;
$$;

-- ============================================================
-- 2. apply_business_structure_excel: 이름 정리 후 비교/저장
-- ============================================================
-- 20260908140000_business_structure_excel_import.sql 버전에서 이름 4개를 읽는 줄만
-- 바꾼다.
create or replace function public.apply_business_structure_excel(
  p_business_year_id uuid,
  p_rows jsonb
)
returns table (
  out_units_created integer,
  out_majors_created integer,
  out_middles_created integer,
  out_activities_created integer
)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_year_org uuid;
  v_row jsonb;
  v_row_no integer := 0;
  v_unit_name text;
  v_major_name text;
  v_middle_name text;
  v_activity_name text;
  v_method text;
  v_unit_id uuid;
  v_major_id uuid;
  v_middle_id uuid;
  v_activity_id uuid;
  v_existing_activity_node uuid;
  v_units_created integer := 0;
  v_majors_created integer := 0;
  v_middles_created integer := 0;
  v_activities_created integer := 0;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() <> 'global_manager' then
    raise exception '사업구조를 등록할 권한이 없습니다.';
  end if;

  select organization_id into v_year_org from public.business_years where id = p_business_year_id;
  if v_year_org is null or v_year_org <> v_org then
    raise exception '운영 연도를 찾을 수 없습니다.';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row_no := v_row_no + 1;
    v_unit_name := btrim(regexp_replace(coalesce(v_row->>'unit_business', ''), '\s+', ' ', 'g'));
    v_major_name := btrim(regexp_replace(coalesce(v_row->>'major', ''), '\s+', ' ', 'g'));
    v_middle_name := btrim(regexp_replace(coalesce(v_row->>'middle', ''), '\s+', ' ', 'g'));
    v_activity_name := btrim(regexp_replace(coalesce(v_row->>'activity', ''), '\s+', ' ', 'g'));
    v_method := trim(coalesce(v_row->>'method', ''));

    if v_unit_name = '' or v_major_name = '' or v_middle_name = '' or v_activity_name = '' then
      raise exception '%번째 행: 단위사업/대분류/중분류/소분류(활동)는 비어 있을 수 없습니다.', v_row_no;
    end if;
    if v_method not in ('attendance', 'summary') then
      raise exception '%번째 행: 실적등록방식을 확인해 주세요(출석연동/직접등록). 입력값: "%"', v_row_no, coalesce(v_row->>'method', '');
    end if;

    select id into v_unit_id from public.unit_businesses
    where business_year_id = p_business_year_id and name = v_unit_name;
    if v_unit_id is null then
      insert into public.unit_businesses (organization_id, business_year_id, name)
      values (v_org, p_business_year_id, v_unit_name)
      returning id into v_unit_id;
      v_units_created := v_units_created + 1;
    end if;

    select id into v_major_id from public.business_nodes
    where business_year_id = p_business_year_id and unit_business_id = v_unit_id
      and node_type = 'major' and name = v_major_name;
    if v_major_id is null then
      insert into public.business_nodes (organization_id, business_year_id, unit_business_id, parent_id, node_type, name)
      values (v_org, p_business_year_id, v_unit_id, null, 'major', v_major_name)
      returning id into v_major_id;
      v_majors_created := v_majors_created + 1;
    end if;

    select id into v_middle_id from public.business_nodes
    where business_year_id = p_business_year_id and parent_id = v_major_id
      and node_type = 'middle' and name = v_middle_name;
    if v_middle_id is null then
      insert into public.business_nodes (organization_id, business_year_id, unit_business_id, parent_id, node_type, name)
      values (v_org, p_business_year_id, v_unit_id, v_major_id, 'middle', v_middle_name)
      returning id into v_middle_id;
      v_middles_created := v_middles_created + 1;
    end if;

    select id, business_node_id into v_activity_id, v_existing_activity_node
    from public.activities where business_year_id = p_business_year_id and name = v_activity_name;

    if v_activity_id is not null then
      if v_existing_activity_node <> v_middle_id then
        raise exception '%번째 행: 활동명 "%"이(가) 이미 다른 대분류/중분류 아래 등록되어 있습니다. 파일을 확인해 주세요.', v_row_no, v_activity_name;
      end if;
      -- 정확히 같은 위치에 이미 존재 -- 자동 동기화하지 않고 그대로 둔다.
    else
      insert into public.activities (organization_id, business_year_id, business_node_id, unit_business_id, name, default_performance_method)
      values (v_org, p_business_year_id, v_middle_id, v_unit_id, v_activity_name, v_method::performance_method)
      returning id into v_activity_id;
      v_activities_created := v_activities_created + 1;

      insert into public.programs (organization_id, activity_id, name)
      values (v_org, v_activity_id, v_activity_name);
    end if;
  end loop;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'apply_business_structure_excel', 'business_year', p_business_year_id,
    jsonb_build_object(
      'units_created', v_units_created, 'majors_created', v_majors_created,
      'middles_created', v_middles_created, 'activities_created', v_activities_created,
      'row_count', v_row_no
    ));

  return query select v_units_created, v_majors_created, v_middles_created, v_activities_created;
end;
$$;
