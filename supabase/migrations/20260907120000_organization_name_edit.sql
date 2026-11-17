-- 타 기관 즉시 도입 Readiness Gap Closure §14: 기관명 오타를 고칠 최소 수정 기능.
-- 주소/전화/대표자/사업자번호 등 새 프로필 필드는 추가하지 않는다.
create function public.update_organization_name(p_name text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before text;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '기관명을 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_name is null or trim(p_name) = '' then
    raise exception '기관명을 입력해 주세요.';
  end if;

  select name into v_before from public.organizations where id = v_org;

  update public.organizations set name = trim(p_name) where id = v_org;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_organization_name', 'organization', v_org,
    jsonb_build_object('name', v_before), jsonb_build_object('name', p_name));
end;
$$;
