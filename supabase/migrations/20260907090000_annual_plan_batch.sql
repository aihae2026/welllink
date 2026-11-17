-- 운영 UX Gap Closure: 연간계획 여러 Activity를 한 번에 저장한다(브라우저에서
-- Activity마다 UPDATE를 순차 호출하지 않는다). 기존 upsert_annual_plan 단건 RPC의
-- 로직을 그대로 loop 안에서 재사용한다. 산출근거(basis)는 화면에서 더 이상 필수
-- 입력으로 요구하지 않지만, 값이 있으면 그대로 저장한다(기존 데이터/기능 보존).
create function public.upsert_annual_plan_batch(p_business_year_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_activity_id uuid;
  v_organization_id uuid;
  v_count integer := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_activity_id := (v_row->>'activity_id')::uuid;

    if not public.can_manage_activity(v_activity_id) then
      raise exception '권한이 없는 활동이 포함되어 있습니다.';
    end if;
    select organization_id into v_organization_id from public.activities where id = v_activity_id;
    if v_organization_id is null then
      raise exception '활동을 찾을 수 없습니다: %', v_activity_id;
    end if;

    insert into public.annual_plans (
      organization_id, business_year_id, activity_id,
      count_target, count_basis, unique_target, unique_basis, total_target, total_basis,
      updated_by
    ) values (
      v_organization_id, p_business_year_id, v_activity_id,
      nullif(v_row->>'count_target', '')::integer, nullif(trim(coalesce(v_row->>'count_basis', '')), ''),
      nullif(v_row->>'unique_target', '')::integer, nullif(trim(coalesce(v_row->>'unique_basis', '')), ''),
      nullif(v_row->>'total_target', '')::integer, nullif(trim(coalesce(v_row->>'total_basis', '')), ''),
      public.current_principal_id()
    )
    on conflict (business_year_id, activity_id) do update set
      count_target = excluded.count_target,
      count_basis = excluded.count_basis,
      unique_target = excluded.unique_target,
      unique_basis = excluded.unique_basis,
      total_target = excluded.total_target,
      total_basis = excluded.total_basis,
      updated_by = excluded.updated_by;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
