-- WellLink v1.0 Final Batch A: 담당자 배정(assign_activity)에 감사로그가 빠져 있던
-- 것을 보완한다. terminate_enrollments(Pre-Final Gate)와 동일한 패턴 --
-- 새 기능이 아니라 이미 있는 audit_logs 관행을 이 RPC에도 적용하는 것이다.
create or replace function public.assign_activity(p_activity_id uuid, p_staff_principal_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_new_id uuid;
  v_org uuid;
  v_prev_staff_principal_id uuid;
begin
  if not public.can_manage_activity(p_activity_id) then
    raise exception '이 활동의 담당자를 배정할 권한이 없습니다.';
  end if;

  v_org := public.current_organization_id();

  select staff_principal_id into v_prev_staff_principal_id
  from public.activity_assignments
  where activity_id = p_activity_id and effective_to is null;

  update public.activity_assignments
  set effective_to = now()
  where activity_id = p_activity_id and effective_to is null;

  insert into public.activity_assignments (organization_id, activity_id, staff_principal_id, created_by)
  values (v_org, p_activity_id, p_staff_principal_id, public.current_principal_id())
  returning id into v_new_id;

  insert into public.audit_logs (
    organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json
  )
  values (
    v_org, public.current_principal_id(), 'assign_activity', 'activity', p_activity_id,
    jsonb_build_object('staff_principal_id', v_prev_staff_principal_id),
    jsonb_build_object('staff_principal_id', p_staff_principal_id)
  );

  return v_new_id;
end;
$$;
