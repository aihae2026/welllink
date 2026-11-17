-- 활동 이름변경 잠금 기준: "진행된 회차 또는 실적" -> "실제 기록(출석 제출·확정 출석·실적)".
--
-- 20260910110000은 completed/missing 회차와 "scheduled인데 시작시각이 지난 회차"를
-- 진행된 회차로 보고 잠갔다. 그런데 하반기 운영정보를 지난 날짜(07-06~)로 소급
-- 등록하면 지난 회차가 전부 scheduled로 생기고, 자동확정(finalize_due_sessions)이
-- 돌지 않으면 그대로 남는다(적용 시점 274회차, 강사 출석 제출 0건). 그 결과 소급 등록한
-- 하반기 활동이 기록이 하나도 없는데도 전부 잠겨서 완화 효과가 없었다.
--
-- 잠금의 목적은 옛 이름으로 남은 기록이 새 이름으로 보이는 것을 막는 것이다. 이름이
-- 남는 곳은 회차가 아니라 기록이므로, 아래 기록이 하나라도 있을 때만 잠근다.
-- 회차 상태나 자동확정 여부와 상관없이 결과가 같다.
-- - 강사 출석 제출(instructor_attendance_submissions)
-- - 확정 출석(final_attendance): 직원 누락 보완·출석 정정 포함
-- - 실적(performance_records): 직접등록 활동은 회차 없이 실적만 있다
-- 셋 다 없으면 이름을 바꿀 수 있고, 지금처럼 프로그램명(programs.name)도 같이 바뀐다.

-- 20260910110000 버전에서 잠금 조건과 안내 문구만 바꾼다.
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
          exists (select 1 from public.instructor_attendance_submissions ias where ias.session_id = s.id)
          or exists (select 1 from public.final_attendance fa where fa.session_id = s.id)
        )
    )
    or exists (select 1 from public.performance_records pr where pr.activity_id = p_id)
  ) then
    raise exception '이미 출석이나 실적 기록이 있는 활동은 이름을 바꿀 수 없습니다(지난 기록의 이름까지 바뀌기 때문입니다). 이름이 바뀐 프로그램은 "+ 활동 추가"로 새 활동을 추가해 주세요.';
  end if;

  update public.activities set name = v_new_name, is_active = p_is_active where id = p_id;
  update public.programs set name = v_new_name where activity_id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_activity', 'activity', p_id,
    jsonb_build_object('name', v_before.name, 'is_active', v_before.is_active),
    jsonb_build_object('name', p_name, 'is_active', p_is_active));
end;
$$;
