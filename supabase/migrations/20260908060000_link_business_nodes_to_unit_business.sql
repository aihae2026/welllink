-- WellLink v1.0 — UnitBusiness ↔ BusinessNode Linkage Closure.
--
-- 최종 사용자 모델: 단위사업 -> 대분류 -> 중분류 -> 소분류(활동). 지금까지
-- unit_businesses와 business_nodes(대분류/중분류)는 DB에서 완전히 독립된 두
-- 축이었다(활동만 양쪽을 각각 참조하고, business_nodes 자체는 어느 단위사업에도
-- 속해 있지 않았다). 이 migration은 그 연결을 business_nodes.unit_business_id
-- 컬럼으로 명시적으로 만든다.
--
-- Activity/Program의 id, business_node_id, unit_business_id는 전혀 건드리지
-- 않는다 -- 이미 있는 Activity.unit_business_id를 source of truth로 삼아
-- 이를 대분류/중분류 노드로 "역산"해 채워 넣을 뿐이다. 적용 전 전체
-- organization/business_year를 대상으로 한 READ-ONLY ambiguity 조사에서
-- major가 서로 다른 unit_business를 참조하는 사례, middle이 parent major와
-- 불일치하는 사례, 소속을 특정할 수 없는 빈 major 사례가 전부 0건임을 이미
-- 확인했다(대상: major 4개, middle 9개, 전 organization).

alter table public.business_nodes
  add column unit_business_id uuid references public.unit_businesses (id);

-- 1) major: 하위(직접 + 중분류를 통한 간접) Activity들이 참조하는 unit_business_id로
--    backfill한다.
with major_unit as (
  select bn.id as major_id,
         (array_agg(distinct a.unit_business_id) filter (where a.unit_business_id is not null))[1] as ub_id
  from public.business_nodes bn
  left join public.business_nodes mid
    on mid.parent_id = bn.id and mid.node_type = 'middle'
  left join public.activities a
    on a.business_node_id = bn.id or a.business_node_id = mid.id
  where bn.node_type = 'major'
  group by bn.id
)
update public.business_nodes bn
set unit_business_id = mu.ub_id
from major_unit mu
where bn.id = mu.major_id and mu.ub_id is not null;

-- 2) Activity가 하나도 없는 major(빈 대분류)는, 같은 organization + business_year에
--    unit_business가 정확히 1개일 때만 그 값으로 backfill한다.
update public.business_nodes bn
set unit_business_id = only_unit.id
from public.unit_businesses only_unit
where bn.node_type = 'major'
  and bn.unit_business_id is null
  and only_unit.organization_id = bn.organization_id
  and only_unit.business_year_id = bn.business_year_id
  and (
    select count(*) from public.unit_businesses u2
    where u2.organization_id = bn.organization_id and u2.business_year_id = bn.business_year_id
  ) = 1;

-- 3) middle: parent major의 unit_business_id를 그대로 상속한다.
update public.business_nodes mid
set unit_business_id = maj.unit_business_id
from public.business_nodes maj
where mid.node_type = 'middle' and mid.parent_id = maj.id;

-- 4) 안전망: backfill 후에도 major/middle 중 unit_business_id가 비어 있으면
--    (사전 조사를 통과했다면 정상적으로는 발생하지 않는다) NOT NULL을 걸기
--    전에 migration 자체를 실패시킨다.
do $$
declare v_unresolved integer;
begin
  select count(*) into v_unresolved
  from public.business_nodes
  where node_type in ('major', 'middle') and unit_business_id is null;

  if v_unresolved > 0 then
    raise exception 'unit_business_id backfill 실패: %개의 대분류/중분류가 unit_business를 특정할 수 없습니다.', v_unresolved;
  end if;
end $$;

alter table public.business_nodes
  alter column unit_business_id set not null;

create index business_nodes_unit_business_id_idx on public.business_nodes (unit_business_id);

-- ============================================================
-- 정합성 강제: business_nodes_validate_hierarchy 트리거를 확장한다.
--   - major: unit_business_id 필수 + 그 unit_business가 같은
--     organization/business_year인지 검증.
--   - middle/minor: parent(major)의 unit_business_id를 서버가 그대로
--     상속시킨다(클라이언트가 보낸 값은 무시) -- 사용자가 중분류 생성 때
--     단위사업을 다시 고르다 다른 단위사업으로 잘못 연결하는 경우를
--     원천적으로 제거한다.
-- ============================================================
create or replace function public.validate_business_node_hierarchy()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  parent_type business_node_type;
  parent_unit_business_id uuid;
  v_unit_org uuid;
  v_unit_year uuid;
begin
  if new.node_type = 'major' then
    if new.parent_id is not null then
      raise exception '대분류(major) 노드는 parent_id를 가질 수 없습니다.';
    end if;
    if new.unit_business_id is null then
      raise exception '대분류(major)는 단위사업을 지정해야 합니다.';
    end if;

    select organization_id, business_year_id into v_unit_org, v_unit_year
    from public.unit_businesses where id = new.unit_business_id;

    if v_unit_org is null then
      raise exception '단위사업을 찾을 수 없습니다.';
    end if;
    if v_unit_org <> new.organization_id or v_unit_year <> new.business_year_id then
      raise exception '단위사업이 이 대분류와 같은 기관/연도에 속해 있지 않습니다.';
    end if;

    return new;
  end if;

  if new.parent_id is null then
    raise exception '% 노드는 parent_id가 필요합니다.', new.node_type;
  end if;

  select node_type, unit_business_id into parent_type, parent_unit_business_id
  from public.business_nodes where id = new.parent_id;

  if new.node_type = 'middle' and parent_type <> 'major' then
    raise exception '중분류(middle)의 부모는 대분류(major)여야 합니다.';
  end if;

  if new.node_type = 'minor' and parent_type not in ('major', 'middle') then
    raise exception '소분류(minor)의 부모는 대분류 또는 중분류여야 합니다.';
  end if;

  new.unit_business_id := parent_unit_business_id;

  return new;
end;
$$;

-- ============================================================
-- create_business_node: 대분류 생성 시 unit_business_id를 필수로 받는다.
-- 인자 개수가 바뀌므로(4 -> 5) 기존 함수를 먼저 DROP해 overload가 남지
-- 않게 한다(호출부는 이 화면 한 곳뿐 -- 같은 커밋에서 함께 수정한다).
-- ============================================================
drop function public.create_business_node(uuid, uuid, business_node_type, text);

create function public.create_business_node(
  p_business_year_id uuid,
  p_parent_id uuid,
  p_node_type business_node_type,
  p_name text,
  p_unit_business_id uuid default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_id uuid;
  v_year_org uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '사업구조를 추가할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select organization_id into v_year_org from public.business_years where id = p_business_year_id;
  if v_year_org is null or v_year_org <> v_org then
    raise exception '연도를 찾을 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;
  if p_node_type = 'major' and p_unit_business_id is null then
    raise exception '대분류는 단위사업을 지정해야 합니다.';
  end if;

  -- unit_business_id는 major일 때만 클라이언트 값을 실제로 쓴다. middle/minor는
  -- validate_business_node_hierarchy 트리거가 parent에서 상속시켜 덮어쓰므로
  -- 여기서 보내는 값(있어도/없어도)은 트리거 실행 후 의미가 없어진다.
  insert into public.business_nodes (organization_id, business_year_id, parent_id, node_type, name, unit_business_id)
  values (v_org, p_business_year_id, p_parent_id, p_node_type, trim(p_name), p_unit_business_id)
  returning id into v_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_business_node', 'business_node', v_id,
    jsonb_build_object('name', p_name, 'node_type', p_node_type));

  return v_id;
end;
$$;

-- ============================================================
-- create_activity_with_program: unit_business_id를 클라이언트가 다시 고르게
-- 하지 않고, 선택된 중분류(business_node)에서 자동 파생한다. 인자 개수가
-- 바뀌므로(5 -> 4) 기존 함수를 먼저 DROP한다(호출부 한 곳, 같은 커밋에서 수정).
-- ============================================================
drop function public.create_activity_with_program(uuid, uuid, uuid, text, performance_method);

create function public.create_activity_with_program(
  p_business_year_id uuid,
  p_business_node_id uuid,
  p_name text,
  p_default_performance_method performance_method
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_activity_id uuid;
  v_node_unit_business_id uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '활동을 추가할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;

  select unit_business_id into v_node_unit_business_id
  from public.business_nodes
  where id = p_business_node_id and organization_id = v_org;

  if v_node_unit_business_id is null then
    raise exception '중분류를 찾을 수 없습니다.';
  end if;

  insert into public.activities (
    organization_id, business_year_id, business_node_id, unit_business_id, name, default_performance_method
  )
  values (v_org, p_business_year_id, p_business_node_id, v_node_unit_business_id, trim(p_name), p_default_performance_method)
  returning id into v_activity_id;

  insert into public.programs (organization_id, activity_id, name)
  values (v_org, v_activity_id, trim(p_name));

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_activity_with_program', 'activity', v_activity_id,
    jsonb_build_object('name', p_name, 'default_performance_method', p_default_performance_method));

  return v_activity_id;
end;
$$;

-- ============================================================
-- delete_unit_business: business_nodes가 이제 unit_business_id FK를 가지므로,
-- 대분류/중분류가 남아있는 단위사업을 지우려 하면 (guard 없이는) FK 위반 raw
-- 에러가 난다. 기존과 같은 안내 메시지 패턴으로 미리 막는다.
-- ============================================================
create or replace function public.delete_unit_business(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before text;
  v_has_data boolean;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '단위사업을 삭제할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select name into v_before from public.unit_businesses where id = p_id and organization_id = v_org;
  if not found then
    raise exception '단위사업을 찾을 수 없습니다.';
  end if;

  select exists (
    select 1 from public.activities where unit_business_id = p_id
    union all select 1 from public.ai_evaluations where unit_business_id = p_id
    union all select 1 from public.business_nodes where unit_business_id = p_id
  ) into v_has_data;

  if v_has_data then
    raise exception '연결된 대분류·활동 또는 평가 데이터가 있어 이 단위사업을 삭제할 수 없습니다.';
  end if;

  delete from public.unit_businesses where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json)
  values (v_org, public.current_principal_id(), 'delete_unit_business', 'unit_business', p_id,
    jsonb_build_object('name', v_before));
end;
$$;
