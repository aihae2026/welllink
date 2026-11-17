-- 실제 브라우저 검증에서 발견: 담당자 배정 화면은 global_manager/department_manager가
-- 쓰는데, 직원 목록은 지금까지 list_staff_accounts(is_system_admin 전용)만 있었다.
-- business_role과 is_system_admin은 서로 독립축이어야 하므로(§ 운영설정 Permission),
-- is_system_admin이 아닌 global_manager도 담당자 배정을 쓸 수 있어야 한다.
--
-- list_staff_accounts(email/역할/must_change_password 등 민감정보 포함)는 계속
-- system_admin 전용으로 그대로 두고, 이 화면 전용으로 이름만 반환하는 최소 RPC를
-- 새로 둔다.
create function public.list_assignable_staff()
returns table (out_principal_id uuid, out_name text)
language plpgsql
security definer set search_path = public
stable
as $$
begin
  if public.current_business_role() not in ('global_manager', 'department_manager') then
    raise exception '직원 목록을 조회할 권한이 없습니다.';
  end if;
  return query
    select p.id, p.name
    from public.principals p
    join public.staff_profiles sp on sp.principal_id = p.id
    where p.organization_id = public.current_organization_id()
      and p.principal_type = 'staff'
      and p.is_active = true
    order by p.name;
end;
$$;
