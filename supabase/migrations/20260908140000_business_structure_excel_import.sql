-- Manual QA Gap Fix — Initial Setup & Program Onboarding §3: 사업구조(단위사업 ->
-- 대분류 -> 중분류 -> 소분류/활동) Excel 초기등록. 신규기관이 사업구조를 전부
-- 수기로 입력하지 않아도 되게 한다.
--
-- 원칙(§3, §I):
-- - ADD-ONLY: 이미 같은 이름으로 존재하는 단위사업/대분류/중분류는 그대로
--   재사용하고, 없는 것만 새로 만든다. 이름 유사도로 추측매칭하지 않는다
--   (정확히 같은 이름 + 같은 부모일 때만 "이미 존재"로 판단).
-- - 활동(activities)은 사업연도 안에서 이름이 전역 unique이므로, 같은 이름이
--   이미 "다른" 위치(다른 중분류)에 존재하면 자동으로 옮기거나 병합하지 않고
--   전체 요청을 거부한다(이해 가능한 오류로 안내).
-- - 하나의 함수 호출 = 하나의 트랜잭션. 중간에 예외가 나면 전체가 rollback되어
--   partial apply가 생기지 않는다(PL/pgSQL 함수 자체가 원자적).
-- - 기존 구조 자동삭제/자동동기화 없음 -- 이미 정확히 같은 위치에 존재하는
--   활동은 조용히 건너뛴다(방식이 다르더라도 자동으로 바꾸지 않는다).

create function public.apply_business_structure_excel(
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
    v_unit_name := trim(coalesce(v_row->>'unit_business', ''));
    v_major_name := trim(coalesce(v_row->>'major', ''));
    v_middle_name := trim(coalesce(v_row->>'middle', ''));
    v_activity_name := trim(coalesce(v_row->>'activity', ''));
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
