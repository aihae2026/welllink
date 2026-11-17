-- WellLink v1.0 — 일반 직원(staff)의 AI 사업평가 조회·생성 허용.
--
-- 권한은 관리자(global_manager + 시스템관리자) / 일반(staff) 두 가지로 단순화했고
-- 담당자 배정은 업무 권한의 기준에서 뺐다(20260908070000: 일반 직원은 같은
-- organization 업무 Activity 전체를 조회·수정). 그런데 AI 사업평가는 활동이 아니라
-- 단위사업 단위로 권한을 검사하는 두 함수가 따로 있었고, 둘 다 staff를 막고 있었다.
-- 그 결과 일반 직원은 AI 평가 작성 화면의 단위사업 선택지가 0개이고, 기존 평가도
-- 목록·상세에서 보이지 않았다(RLS "권한자 AI 평가 조회"가 can_read_unit_business 사용).
--
-- 이 migration은 그 두 함수만 바꾼다:
--   1) can_read_unit_business: staff면 같은 organization의 단위사업을 조회할 수 있다.
--   2) can_generate_ai_evaluation: staff도 생성할 수 있다(global_viewer는 계속 불가).
-- department_manager / global_viewer 분기는 기존 동작 그대로 둔다.

create or replace function public.can_read_unit_business(p_unit_business_id uuid)
returns boolean
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_org uuid;
  v_ub_org uuid;
  v_role business_role;
begin
  v_org := public.current_organization_id();
  if v_org is null then return false; end if;

  select organization_id into v_ub_org from public.unit_businesses where id = p_unit_business_id;
  if v_ub_org is null or v_ub_org <> v_org then return false; end if;

  v_role := public.current_business_role();

  if v_role in ('global_manager', 'global_viewer') then
    return true;
  end if;

  -- 일반 직원: 담당 여부와 무관하게 같은 organization 단위사업은 전부 조회 가능
  -- (can_read_activity의 staff 정책과 같은 기준, 20260908070000).
  if v_role = 'staff' then
    return true;
  end if;

  if v_role = 'department_manager' then
    -- 이 단위사업의 활동 중 하나라도 읽을 수 없으면(자기 부서 범위 밖) 단위사업 평가 대상에서 제외.
    return not exists (
      select 1 from public.activities a
      where a.unit_business_id = p_unit_business_id
        and (a.is_active = true or public.activity_has_performance(a.id))
        and not public.can_read_activity(a.id)
    );
  end if;

  return false;
end;
$$;

create or replace function public.can_generate_ai_evaluation(p_unit_business_id uuid)
returns boolean
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_role business_role;
begin
  if not public.can_read_unit_business(p_unit_business_id) then
    return false;
  end if;
  v_role := public.current_business_role();
  -- global_viewer는 조회만 가능하고 생성할 수 없다. 일반 직원(staff)은 생성할 수 있다.
  return v_role in ('global_manager', 'department_manager', 'staff');
end;
$$;
