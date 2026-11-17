-- Program Settings Final Design Lock §8
--
-- 운영기간 수정 가능 여부는 "과거/현재 연도"가 아니라 연결된 업무데이터
-- 기준으로 판단해야 한다. 기존 update_operation_cycle은 operation_terms가
-- "하나라도 있으면" 무조건 날짜 변경을 막았고(그마저도 예외 없이 조용히
-- 무시 -- 사용자에게 아무 안내도 없었다), operation_terms는 있지만 실제
-- Enrollment/출석/실적이 전혀 없는 "안전한 설정상태"인 경우까지 막고
-- 있었다. 실제 업무데이터(Enrollment/강사출석/공식출석/사유결석/실적)
-- 존재 여부로 다시 판단하고, 막힐 때는 §8/§52에 명시된 문구 그대로
-- exception을 던져 UI가 raw error 없이 안내 Popup을 띄울 수 있게 한다.
create or replace function public.update_operation_cycle(
  p_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_cycle_org uuid;
  v_business_year_id uuid;
  v_cur_start date;
  v_cur_end date;
  v_year integer;
  v_has_business_data boolean;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '운영구분을 수정할 권한이 없습니다.';
  end if;

  select organization_id, business_year_id, start_date, end_date
    into v_cycle_org, v_business_year_id, v_cur_start, v_cur_end
  from public.operation_cycles where id = p_id;
  if v_cycle_org is null or v_cycle_org <> v_org then
    raise exception '운영구분을 찾을 수 없습니다.';
  end if;

  if p_name is null or trim(p_name) = '' then
    raise exception '운영구분명을 입력해 주세요.';
  end if;
  if exists (
    select 1 from public.operation_cycles
    where business_year_id = v_business_year_id and name = trim(p_name) and id <> p_id
  ) then
    raise exception '같은 운영연도에 이미 "%" 운영구분이 있습니다.', trim(p_name);
  end if;

  select exists (
    select 1 from public.operation_terms ot
    where ot.operation_cycle_id = p_id
      and (
        exists (select 1 from public.enrollments e where e.operation_term_id = ot.id)
        or exists (
          select 1 from public.sessions s
          where s.operation_term_id = ot.id
            and (
              exists (select 1 from public.instructor_attendance_submissions where session_id = s.id)
              or exists (select 1 from public.final_attendance where session_id = s.id)
              or exists (select 1 from public.excused_absences where session_id = s.id)
              or exists (select 1 from public.performance_records where source_session_id = s.id)
            )
        )
      )
  ) into v_has_business_data;

  if v_has_business_data then
    if p_start_date is distinct from v_cur_start or p_end_date is distinct from v_cur_end then
      raise exception '현재 운영구분에 수강 또는 출석 등 운영데이터가 연결되어 있습니다.';
    end if;
    update public.operation_cycles set name = trim(p_name) where id = p_id;
  else
    if p_start_date is null or p_end_date is null or p_start_date > p_end_date then
      raise exception '운영기간이 올바르지 않습니다.';
    end if;
    select year into v_year from public.business_years where id = v_business_year_id;
    if extract(year from p_start_date)::integer <> v_year or extract(year from p_end_date)::integer <> v_year then
      raise exception '운영기간은 선택한 운영연도(%)의 범위 안이어야 합니다.', v_year;
    end if;
    update public.operation_cycles
    set name = trim(p_name), start_date = p_start_date, end_date = p_end_date
    where id = p_id;
  end if;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'update_operation_cycle', 'operation_cycle', p_id,
    jsonb_build_object('name', p_name, 'start_date', p_start_date, 'end_date', p_end_date, 'business_data_present', v_has_business_data));
end;
$$;
