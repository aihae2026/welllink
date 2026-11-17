-- WellLink v1.0 — Final Batch A §12: 출결관리 설정. 결석관리/신고결석 사용
-- 여부와 결석 누계 기준값을 기관별로 설정 가능하게 한다. 지금까지 이 값들은
-- v_enrollment_absence_state 뷰에 하드코딩(무단 2회/신고 5회)돼 있었다 --
-- 저장 필드가 실제로 없던 경우이므로(§45) organizations에 최소 컬럼만
-- 추가하는 forward migration으로 처리한다. 기존 하드코딩 값을 그대로
-- default로 사용해 기존 동작은 바뀌지 않는다.

alter table public.organizations
  add column attendance_enabled boolean not null default true,
  add column excused_absence_enabled boolean not null default true,
  add column unexcused_absence_threshold integer not null default 2
    constraint organizations_unexcused_threshold_positive check (unexcused_absence_threshold >= 1),
  add column excused_absence_threshold integer not null default 5
    constraint organizations_excused_threshold_positive check (excused_absence_threshold >= 1);

create function public.update_attendance_settings(
  p_attendance_enabled boolean,
  p_excused_absence_enabled boolean,
  p_unexcused_absence_threshold integer,
  p_excused_absence_threshold integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '출결관리 설정을 변경할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();

  if p_unexcused_absence_threshold is null or p_unexcused_absence_threshold < 1 then
    raise exception '미신고결석 기준 회수를 확인해 주세요.';
  end if;
  if p_excused_absence_threshold is null or p_excused_absence_threshold < 1 then
    raise exception '신고결석 기준 회수를 확인해 주세요.';
  end if;

  update public.organizations
  set attendance_enabled = p_attendance_enabled,
      excused_absence_enabled = p_excused_absence_enabled,
      unexcused_absence_threshold = p_unexcused_absence_threshold,
      excused_absence_threshold = p_excused_absence_threshold
  where id = v_org;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'update_attendance_settings', 'organization', v_org,
    jsonb_build_object(
      'attendance_enabled', p_attendance_enabled,
      'excused_absence_enabled', p_excused_absence_enabled,
      'unexcused_absence_threshold', p_unexcused_absence_threshold,
      'excused_absence_threshold', p_excused_absence_threshold
    ));
end;
$$;

-- v_enrollment_absence_state: 하드코딩된 2/1/5/4 대신 기관별 설정값을 사용하도록
-- 재정의한다("near"는 "기준-1회"). enrollments에는 organization_id가 이미
-- 있으므로 organizations를 그대로 join한다.
create or replace view public.v_enrollment_absence_state as
select
  e.id as enrollment_id,
  e.operation_term_id,
  e.participant_id,
  coalesce(fc.unexcused_count, 0)::integer as unexcused_count,
  coalesce(fc.excused_count, 0)::integer as excused_count,
  coalesce(fc.unexcused_count, 0) = greatest(o.unexcused_absence_threshold - 1, 0) as unexcused_near,
  coalesce(fc.unexcused_count, 0) >= o.unexcused_absence_threshold as unexcused_reached,
  coalesce(fc.excused_count, 0) = greatest(o.excused_absence_threshold - 1, 0) as excused_near,
  coalesce(fc.excused_count, 0) >= o.excused_absence_threshold as excused_reached,
  dm.id as dismissal_id,
  dm.dismissed_at,
  dm.dismissed_unexcused_count,
  dm.dismissed_excused_count,
  (
    (coalesce(fc.unexcused_count, 0) >= greatest(o.unexcused_absence_threshold - 1, 0)
      or coalesce(fc.excused_count, 0) >= greatest(o.excused_absence_threshold - 1, 0))
    and (
      dm.id is null
      or coalesce(fc.unexcused_count, 0) > dm.dismissed_unexcused_count
      or coalesce(fc.excused_count, 0) > dm.dismissed_excused_count
    )
  ) as alert_active
from public.enrollments e
join public.organizations o on o.id = e.organization_id
left join lateral (
  select
    count(*) filter (where fa.mark = 'absent') as unexcused_count,
    count(*) filter (where fa.mark = 'excused') as excused_count
  from public.final_attendance fa
  where fa.enrollment_id = e.id
) fc on true
left join lateral (
  select d.id, d.dismissed_at, d.dismissed_unexcused_count, d.dismissed_excused_count
  from public.absence_alert_dismissals d
  where d.enrollment_id = e.id
  order by d.dismissed_at desc
  limit 1
) dm on true;
