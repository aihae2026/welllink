-- 타 기관 즉시 도입 Readiness Gap Closure — Audit BLOCKER 1 해소.
-- unit_businesses(단위사업)를 만드는 정식 경로가 전무했다(과거 1회성 시드 보정
-- migration 외에는 INSERT가 전혀 없었음). create_activity_with_program이
-- unit_business_id를 필수로 요구하므로, 이게 없으면 어떤 조직도 Activity를
-- 만들 수 없었다(우리 조직도 다음 연도로 못 넘어감).
create function public.create_unit_business(p_business_year_id uuid, p_name text)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_year_org uuid;
  v_id uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '단위사업을 추가할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select organization_id into v_year_org from public.business_years where id = p_business_year_id;
  if v_year_org is null or v_year_org <> v_org then
    raise exception '연도를 찾을 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;
  if exists (
    select 1 from public.unit_businesses
    where business_year_id = p_business_year_id and name = trim(p_name)
  ) then
    raise exception '같은 연도에 동일한 이름의 단위사업이 이미 있습니다.';
  end if;

  insert into public.unit_businesses (organization_id, business_year_id, name)
  values (v_org, p_business_year_id, trim(p_name))
  returning id into v_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_unit_business', 'unit_business', v_id, jsonb_build_object('name', p_name));

  return v_id;
end;
$$;
