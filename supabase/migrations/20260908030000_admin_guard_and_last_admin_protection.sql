-- WellLink v1.0 Core Setup Model Simplification — Phase 4B: 기관 직원 권한을
-- 사용자-facing "관리자"("global_manager" + "is_system_admin=true" 조합, 이하
-- canonical 관리자)/"일반"("staff" + "is_system_admin=false", canonical 일반)
-- 두 개로 단순화하기 전에, 이 canonical 조합을 실제로 안전하게 만들기 위한
-- 서버 guard 두 가지를 update_staff_role/set_staff_active에 추가한다.
--
-- business_role enum이나 staff_profiles 스키마 자체는 건드리지 않는다(legacy
-- 값 department_manager/global_viewer, 그리고 기존 실제 계정의 현재 상태는
-- 전부 그대로 유지 -- 이 migration은 두 RPC의 본문만 교체한다).

-- 관리자 → 일반 변경 시: (a) 본인 스스로는 자기 권한을 관리자에서 일반으로
-- 낮출 수 없다(다른 관리자가 해야 한다). (b) 조직의 마지막 active canonical
-- 관리자는 일반으로 낮출 수 없다.
create or replace function public.update_staff_role(
  p_principal_id uuid,
  p_business_role business_role,
  p_is_system_admin boolean,
  p_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_before record;
  v_was_canonical_admin boolean;
  v_will_be_canonical_admin boolean;
  v_canonical_admin_count integer;
begin
  if not public.is_system_admin() then
    raise exception '직원 권한을 변경할 권한이 없습니다.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception '변경사유를 입력해 주세요.';
  end if;

  select sp.business_role, sp.is_system_admin, p.organization_id
    into v_before
  from public.staff_profiles sp
  join public.principals p on p.id = sp.principal_id
  where sp.principal_id = p_principal_id;

  if v_before.organization_id is null or v_before.organization_id <> public.current_organization_id() then
    raise exception '대상 직원을 찾을 수 없습니다.';
  end if;

  v_was_canonical_admin := v_before.business_role = 'global_manager' and v_before.is_system_admin = true;
  v_will_be_canonical_admin := p_business_role = 'global_manager' and p_is_system_admin = true;

  if v_was_canonical_admin and not v_will_be_canonical_admin then
    if p_principal_id = public.current_principal_id() then
      raise exception '본인 스스로는 관리자 권한을 낮출 수 없습니다. 다른 관리자에게 변경을 요청해 주세요.';
    end if;

    select count(*) into v_canonical_admin_count
    from public.staff_profiles sp2
    join public.principals p2 on p2.id = sp2.principal_id
    where p2.organization_id = v_before.organization_id
      and p2.is_active = true
      and sp2.business_role = 'global_manager'
      and sp2.is_system_admin = true;

    if v_canonical_admin_count <= 1 then
      raise exception '기관에는 최소 1명의 관리자가 필요합니다.';
    end if;
  end if;

  update public.staff_profiles
  set business_role = p_business_role, is_system_admin = p_is_system_admin
  where principal_id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json, reason)
  values (
    v_before.organization_id, public.current_principal_id(), 'update_staff_role', 'principal', p_principal_id,
    jsonb_build_object('business_role', v_before.business_role, 'is_system_admin', v_before.is_system_admin),
    jsonb_build_object('business_role', p_business_role, 'is_system_admin', p_is_system_admin),
    p_reason
  );
end;
$$;

-- 조직의 마지막 active canonical 관리자는 비활성화할 수 없다(본인 비활성화는
-- 이미 별도로 차단되어 있음, 그대로 유지).
create or replace function public.set_staff_active(p_principal_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before boolean;
  v_business_role business_role;
  v_is_system_admin boolean;
  v_canonical_admin_count integer;
begin
  if not public.is_system_admin() then
    raise exception '직원 계정 상태를 변경할 권한이 없습니다.';
  end if;
  if p_principal_id = public.current_principal_id() then
    raise exception '본인 계정은 이 화면에서 비활성화할 수 없습니다.';
  end if;

  select organization_id, is_active into v_org, v_before
  from public.principals where id = p_principal_id and principal_type = 'staff';

  if v_org is null or v_org <> public.current_organization_id() then
    raise exception '대상 직원을 찾을 수 없습니다.';
  end if;

  if p_is_active = false then
    select sp.business_role, sp.is_system_admin into v_business_role, v_is_system_admin
    from public.staff_profiles sp where sp.principal_id = p_principal_id;

    if v_business_role = 'global_manager' and v_is_system_admin = true then
      select count(*) into v_canonical_admin_count
      from public.staff_profiles sp2
      join public.principals p2 on p2.id = sp2.principal_id
      where p2.organization_id = v_org
        and p2.is_active = true
        and sp2.business_role = 'global_manager'
        and sp2.is_system_admin = true;

      if v_canonical_admin_count <= 1 then
        raise exception '기관에는 최소 1명의 관리자가 필요합니다.';
      end if;
    end if;
  end if;

  update public.principals set is_active = p_is_active where id = p_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (
    v_org, public.current_principal_id(), 'set_staff_active', 'principal', p_principal_id,
    jsonb_build_object('is_active', v_before), jsonb_build_object('is_active', p_is_active)
  );
end;
$$;
