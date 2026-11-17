-- 활동 이름변경 잠금 완화: "운영정보가 있으면 잠금" -> "진행된 회차나 실적이 있으면 잠금".
--
-- 20260910060000에서 운영 기록(운영정보 또는 실적)이 있는 활동의 이름 변경을 막았다.
-- 목적은 지난 운영차수 기록의 이름까지 바뀌는 것을 막는 것이다(programs.name 하나를
-- 모든 차수가 공유). 그런데 운영정보만 만들어 두고 아직 한 번도 진행하지 않은 활동도
-- 막혀서, 등록 직후의 띄어쓰기/오타 수정을 화면에서 할 수 없었다(실사례: 하반기
-- 운영정보만 있고 22회차 전부 예정인 "리듬피트니스" -> "리듬 피트니스").
--
-- 새 기준 -- 아래 중 하나라도 있으면 잠금(이름을 바꾸면 옛 이름으로 남은 기록이
-- 새 이름으로 보이게 되는 경우):
-- - 진행된 회차: status가 completed/missing이거나, 아직 scheduled라도 시작시각이
--   지난 회차(자동확정 전이라 강사 출석 입력이 있을 수 있음). cancelled는 제외.
-- - 실적(performance_records): 직접등록 활동은 회차 없이 실적만 있으므로 그대로 둔다.
-- 둘 다 없으면 이름을 바꿀 수 있고, 지금처럼 프로그램명(programs.name)도 같이 바뀐다.

-- 20260910060000 버전에서 잠금 조건과 안내 문구만 바꾼다.
create or replace function public.update_activity(p_id uuid, p_name text, p_is_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_before record;
  v_new_name text;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '활동을 수정할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  select name, is_active into v_before from public.activities where id = p_id and organization_id = v_org;
  if not found then
    raise exception '활동을 찾을 수 없습니다.';
  end if;

  v_new_name := coalesce(trim(p_name), v_before.name);

  if v_new_name is distinct from v_before.name and (
    exists (
      select 1 from public.sessions s
      join public.operation_terms ot on ot.id = s.operation_term_id
      join public.programs p on p.id = ot.program_id
      where p.activity_id = p_id
        and (
          s.status in ('completed', 'missing')
          or (s.status = 'scheduled' and s.starts_at <= now())
        )
    )
    or exists (select 1 from public.performance_records pr where pr.activity_id = p_id)
  ) then
    raise exception '이미 진행된 회차나 실적이 있는 활동은 이름을 바꿀 수 없습니다(지난 기록의 이름까지 바뀌기 때문입니다). 이름이 바뀐 프로그램은 "+ 활동 추가"로 새 활동을 추가해 주세요.';
  end if;

  update public.activities set name = v_new_name, is_active = p_is_active where id = p_id;
  update public.programs set name = v_new_name where activity_id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_activity', 'activity', p_id,
    jsonb_build_object('name', v_before.name, 'is_active', v_before.is_active),
    jsonb_build_object('name', p_name, 'is_active', p_is_active));
end;
$$;
