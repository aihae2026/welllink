-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.1 Completion Pass
-- 1) 단위사업/사업분류 구조 수정: 단위사업은 "노년사회화교육사업" 1개뿐이다.
--    건강증진/교양강좌/문화예술/취미댄스는 소분류(business_node)이지 단위사업이 아니다.
-- 2) OperationTerm 생성이 program_schedule_defaults의 시간 유무에 의존하지 않도록
--    RPC를 forward-fix한다(실제 시간의 Source of Truth는 OperationTerm/Session이다).
--
-- forward-only migration이다. 이미 적용된 20260906064943/20260906071732은 건드리지 않는다.

-- ============================================================
-- 1. 사업분류 구조 수정 (트랜잭션 안에서 안전하게: 신규 노드/단위사업 생성 ->
--    29개 Activity remap -> 참조가 사라진 잘못된 4개 row 제거)
-- ============================================================

do $$
declare
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_major_id uuid;
  v_year_id uuid;
  v_mid_edu uuid;      -- 평생교육지원
  v_mid_leisure uuid;  -- 취미여가지원
  v_minor_ops uuid;        -- 프로그램운영관리
  v_minor_special uuid;    -- 특별강좌
  v_minor_liberal uuid;    -- 교양강좌프로그램
  v_minor_health uuid;     -- 건강증진프로그램
  v_minor_culture uuid;    -- 문화예술프로그램
  v_minor_dance uuid;      -- 취미댄스프로그램
  v_unit_id uuid;           -- 노년사회화교육사업 (유일한 단위사업)
  v_old_health uuid;
  v_old_liberal uuid;
  v_old_culture uuid;
  v_old_dance uuid;
  v_old_unit_health uuid;
  v_old_unit_liberal uuid;
  v_old_unit_culture uuid;
  v_old_unit_dance uuid;
begin
  select id into v_major_id from public.business_nodes
    where organization_id = v_org and node_type = 'major' and name = '노년사회화교육사업';
  select business_year_id into v_year_id from public.business_nodes where id = v_major_id;
  -- 빈 데이터베이스(새 설치)에는 고칠 사업구조가 없으므로 이 정정 블록은 건너뛴다.
  if v_major_id is null then
    raise notice '사업구조 데이터가 없어 정정 블록을 건너뜁니다.';
    return;
  end if;

  -- 기존(잘못된) minor node id 확보 -- remap 대상 판별용
  select id into v_old_health from public.business_nodes where organization_id = v_org and node_type = 'minor' and name = '건강증진' and parent_id = v_major_id;
  select id into v_old_liberal from public.business_nodes where organization_id = v_org and node_type = 'minor' and name = '교양강좌' and parent_id = v_major_id;
  select id into v_old_culture from public.business_nodes where organization_id = v_org and node_type = 'minor' and name = '문화예술' and parent_id = v_major_id;
  select id into v_old_dance from public.business_nodes where organization_id = v_org and node_type = 'minor' and name = '취미댄스' and parent_id = v_major_id;

  select id into v_old_unit_health from public.unit_businesses where organization_id = v_org and name = '건강증진';
  select id into v_old_unit_liberal from public.unit_businesses where organization_id = v_org and name = '교양강좌';
  select id into v_old_unit_culture from public.unit_businesses where organization_id = v_org and name = '문화예술';
  select id into v_old_unit_dance from public.unit_businesses where organization_id = v_org and name = '취미댄스';

  -- 1.1 신규 중분류: 평생교육지원 / 취미여가지원
  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, sort_order)
  values (v_org, v_year_id, v_major_id, 'middle', '평생교육지원', 1)
  returning id into v_mid_edu;

  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, sort_order)
  values (v_org, v_year_id, v_major_id, 'middle', '취미여가지원', 2)
  returning id into v_mid_leisure;

  -- 1.2 신규 소분류. 프로그램운영관리/특별강좌는 공식 분류표상 존재하지만
  -- 이를 뒷받침하는 실제 확인된 Activity 자료가 없으므로 구조만 만들고
  -- 가짜 Activity/Program은 생성하지 않는다(강사간담회/모니터링/욕구조사/
  -- 프로그램 운영지원 등 그 하위 항목도 동일한 이유로 만들지 않는다).
  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, sort_order)
  values (v_org, v_year_id, v_mid_edu, 'minor', '프로그램운영관리', 1)
  returning id into v_minor_ops;

  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, sort_order)
  values (v_org, v_year_id, v_mid_edu, 'minor', '특별강좌', 2)
  returning id into v_minor_special;

  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, sort_order)
  values (v_org, v_year_id, v_mid_edu, 'minor', '교양강좌프로그램', 3)
  returning id into v_minor_liberal;

  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, sort_order)
  values (v_org, v_year_id, v_mid_leisure, 'minor', '건강증진프로그램', 1)
  returning id into v_minor_health;

  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, sort_order)
  values (v_org, v_year_id, v_mid_leisure, 'minor', '문화예술프로그램', 2)
  returning id into v_minor_culture;

  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, sort_order)
  values (v_org, v_year_id, v_mid_leisure, 'minor', '취미댄스프로그램', 3)
  returning id into v_minor_dance;

  -- 1.3 단위사업은 "노년사회화교육사업" 하나만 남긴다.
  insert into public.unit_businesses (organization_id, business_year_id, name, sort_order)
  values (v_org, v_year_id, '노년사회화교육사업', 0)
  returning id into v_unit_id;

  -- 1.4 실제 29개 Activity remap: business_node_id는 세부분류로, unit_business_id는
  -- 전부 동일한 "노년사회화교육사업"으로.
  update public.activities set business_node_id = v_minor_health, unit_business_id = v_unit_id
    where organization_id = v_org and business_node_id = v_old_health;
  update public.activities set business_node_id = v_minor_liberal, unit_business_id = v_unit_id
    where organization_id = v_org and business_node_id = v_old_liberal;
  update public.activities set business_node_id = v_minor_culture, unit_business_id = v_unit_id
    where organization_id = v_org and business_node_id = v_old_culture;
  update public.activities set business_node_id = v_minor_dance, unit_business_id = v_unit_id
    where organization_id = v_org and business_node_id = v_old_dance;

  -- 1.5 더 이상 참조되지 않는 잘못된 4개 minor node + 4개 unit_business 제거.
  -- (참조가 실제로 0인지 먼저 확인 후 삭제 -- 0이 아니면 예외를 던져 migration을 중단시킨다)
  if exists (select 1 from public.activities where business_node_id in (v_old_health, v_old_liberal, v_old_culture, v_old_dance)) then
    raise exception '잘못된 business_node를 아직 참조하는 activity가 남아있어 삭제를 중단합니다.';
  end if;
  if exists (select 1 from public.activities where unit_business_id in (v_old_unit_health, v_old_unit_liberal, v_old_unit_culture, v_old_unit_dance)) then
    raise exception '잘못된 unit_business를 아직 참조하는 activity가 남아있어 삭제를 중단합니다.';
  end if;

  delete from public.business_nodes where id in (v_old_health, v_old_liberal, v_old_culture, v_old_dance);
  delete from public.unit_businesses where id in (v_old_unit_health, v_old_unit_liberal, v_old_unit_culture, v_old_unit_dance);
end $$;

-- ============================================================
-- 2. OperationTerm 생성 RPC forward-fix: program_schedule_defaults의
--    시간이 NULL이라는 이유만으로 실패하지 않는다. 실제 요일/시작시간/종료시간을
--    호출자가 명시적으로 전달하며, Preview와 생성이 같은 계산 규칙
--    (compute_session_dates)을 계속 공유한다.
-- ============================================================

drop function if exists public.preview_operation_term_sessions(uuid, date, date, date[]);
drop function if exists public.create_operation_term(uuid, uuid, text, date, date, date[]);

create function public.preview_operation_term_sessions(
  p_program_id uuid,
  p_start_date date,
  p_end_date date,
  p_weekdays smallint[],
  p_excluded_dates date[] default '{}'
)
returns table (session_no integer, session_date date)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_activity_id uuid;
begin
  select a.id into v_activity_id
  from public.programs p
  join public.activities a on a.id = p.activity_id
  where p.id = p_program_id;

  if v_activity_id is null then
    raise exception '프로그램을 찾을 수 없습니다.';
  end if;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 운영차수를 관리할 권한이 없습니다.';
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception '시작일/종료일을 입력해 주세요.';
  end if;
  if p_start_date > p_end_date then
    raise exception '시작일은 종료일보다 늦을 수 없습니다.';
  end if;
  if p_weekdays is null or array_length(p_weekdays, 1) is null or array_length(p_weekdays, 1) = 0 then
    raise exception '운영 요일을 선택해 주세요.';
  end if;

  return query
    select row_number() over (order by d)::integer, d
    from public.compute_session_dates(p_start_date, p_end_date, p_weekdays) as d
    where d <> all (coalesce(p_excluded_dates, '{}'::date[]));
end;
$$;

create function public.create_operation_term(
  p_program_id uuid,
  p_business_year_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date,
  p_weekdays smallint[],
  p_start_time time,
  p_end_time time,
  p_excluded_dates date[] default '{}'
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_id uuid;
  v_organization_id uuid;
  v_term_id uuid;
  v_principal uuid;
  v_seq integer := 0;
  v_date date;
begin
  select a.id, p.organization_id into v_activity_id, v_organization_id
  from public.programs p
  join public.activities a on a.id = p.activity_id
  where p.id = p_program_id;

  if v_activity_id is null then
    raise exception '프로그램을 찾을 수 없습니다.';
  end if;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 운영차수를 생성할 권한이 없습니다.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception '시작일/종료일을 입력해 주세요.';
  end if;
  if p_start_date > p_end_date then
    raise exception '시작일은 종료일보다 늦을 수 없습니다.';
  end if;
  if p_weekdays is null or array_length(p_weekdays, 1) is null or array_length(p_weekdays, 1) = 0 then
    raise exception '운영 요일을 선택해 주세요.';
  end if;
  if p_start_time is null then
    raise exception '시작시간을 입력해 주세요.';
  end if;
  if p_end_time is null then
    raise exception '종료시간을 입력해 주세요.';
  end if;
  if p_end_time <= p_start_time then
    raise exception '종료시간은 시작시간보다 늦어야 합니다.';
  end if;

  v_principal := public.current_principal_id();

  insert into public.operation_terms (
    organization_id, program_id, business_year_id, name,
    start_date, end_date, session_start_time, session_end_time,
    weekdays, status, created_by
  ) values (
    v_organization_id, p_program_id, p_business_year_id, p_name,
    p_start_date, p_end_date, p_start_time, p_end_time,
    p_weekdays, 'scheduled', v_principal
  )
  returning id into v_term_id;

  for v_date in
    select d from public.compute_session_dates(p_start_date, p_end_date, p_weekdays) as d
    where d <> all (coalesce(p_excluded_dates, '{}'::date[]))
  loop
    v_seq := v_seq + 1;
    insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
    values (
      v_organization_id, v_term_id, v_seq,
      (v_date + p_start_time) at time zone 'Asia/Seoul',
      (v_date + p_end_time) at time zone 'Asia/Seoul',
      'scheduled'
    );
  end loop;

  if v_seq = 0 then
    raise exception '생성될 회차가 없습니다. 기간/요일/제외일을 확인해 주세요.';
  end if;

  return v_term_id;
end;
$$;
