-- Micro Scope Reduction — 공휴일 자동 휴강 기능 v1.0 제외
--
-- 대한민국 공휴일·대체공휴일·음력 공휴일을 정확히 처리하려면 범위가
-- 불필요하게 커진다는 판단에 따라, 공휴일 자동 휴강 기능을 v1.0 Scope에서
-- 제외한다. 공휴일 포함 모든 날짜는 다른 날짜와 동일하게 예정(scheduled)
-- 상태로 회차를 생성하고, 실제 휴강이 필요하면 회차 및 출석현황에서
-- 사용자가 직접 상태를 눌러 처리한다(기존 Design Lock 그대로 유지).
--
-- public_holidays 테이블과 operation_terms.holiday_auto_cancel 컬럼은 DROP
-- 하지 않는다(§5 -- 되돌리기 위한 불필요한 destructive migration을 만들지
-- 않는다). 두 함수 모두 public_holidays 조회와 v_is_holiday 판단 로직만
-- 제거하고, 항상 status='scheduled'/cancelled_at=null/cancelled_by=null로
-- 생성하도록 최소 수정한다. p_holiday_auto_cancel 파라미터와
-- operation_terms.holiday_auto_cancel 컬럼 저장 자체는 시그니처 안정성을
-- 위해 남겨두되(§11 -- DB column/function 내부 이름까지 rename할 필요 없음),
-- 더 이상 회차 생성 로직의 판단조건으로 쓰이지 않는다(§6). 기존에 이미
-- holiday_auto_cancel=true로 저장된 row나 이미 cancelled로 생성된 Session은
-- 일괄 변경하지 않는다(§6-7) -- 이 migration은 향후 신규 회차 생성 동작만
-- 바꾼다.

create or replace function public.upsert_operation_term_for_cycle(
  p_operation_cycle_id uuid,
  p_program_id uuid,
  p_weekdays smallint[],
  p_start_time time,
  p_end_time time,
  p_instructor_principal_id uuid,
  p_excluded_dates date[] default '{}',
  p_instructor_name_text text default null,
  p_schedule_mode text default 'weekly',
  p_explicit_dates date[] default null,
  p_holiday_auto_cancel boolean default false
)
returns table (out_term_id uuid, out_created boolean, out_sessions_regenerated boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_cycle_org uuid;
  v_cycle_start date;
  v_cycle_end date;
  v_cycle_year uuid;
  v_cycle_name text;
  v_activity_id uuid;
  v_term_id uuid;
  v_cur_weekdays smallint[];
  v_cur_start time;
  v_cur_end time;
  v_cur_instructor uuid;
  v_cur_instructor_text text;
  v_cur_schedule_mode text;
  v_cur_holiday_auto_cancel boolean;
  v_protected_count integer;
  v_seq integer;
  v_date date;
  v_conflict_cycle_name text;
  v_instructor_text text;
  v_final_weekdays smallint[];
  v_unchanged boolean;
begin
  v_org := public.current_organization_id();
  select organization_id, start_date, end_date, business_year_id, name
    into v_cycle_org, v_cycle_start, v_cycle_end, v_cycle_year, v_cycle_name
  from public.operation_cycles where id = p_operation_cycle_id;
  if v_cycle_org is null or v_cycle_org <> v_org then
    raise exception '운영구분을 찾을 수 없습니다.';
  end if;

  select a.id into v_activity_id
  from public.programs p join public.activities a on a.id = p.activity_id
  where p.id = p_program_id;
  if v_activity_id is null then
    raise exception '프로그램을 찾을 수 없습니다.';
  end if;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 운영정보를 설정할 권한이 없습니다.';
  end if;
  if not exists (
    select 1 from public.operation_cycle_programs
    where operation_cycle_id = p_operation_cycle_id and program_id = p_program_id
  ) then
    raise exception '이 프로그램은 현재 운영구분에 선택되지 않았습니다. 먼저 프로그램을 선택해 주세요.';
  end if;

  if p_schedule_mode not in ('weekly', 'custom_dates') then
    raise exception '일정방식을 확인해 주세요.';
  end if;
  if p_start_time is null or p_end_time is null then
    raise exception '시작/종료 시간을 입력해 주세요.';
  end if;
  if p_end_time <= p_start_time then
    raise exception '종료시간은 시작시간보다 늦어야 합니다.';
  end if;

  if p_schedule_mode = 'weekly' then
    if p_weekdays is null or array_length(p_weekdays, 1) is null then
      raise exception '요일을 1개 이상 선택해 주세요.';
    end if;
    v_final_weekdays := p_weekdays;
  else
    if p_explicit_dates is null or array_length(p_explicit_dates, 1) is null then
      raise exception '직접 회차 지정은 날짜를 1개 이상 선택해야 합니다.';
    end if;
    if exists (
      select 1 from unnest(p_explicit_dates) as d
      where d < v_cycle_start or d > v_cycle_end
    ) then
      raise exception '선택한 날짜가 운영구분 기간(%~%) 밖에 있습니다.', v_cycle_start, v_cycle_end;
    end if;
    v_final_weekdays := '{}'::smallint[];
  end if;

  if p_instructor_principal_id is not null and not exists (
    select 1 from public.principals
    where id = p_instructor_principal_id and organization_id = v_org
      and principal_type = 'instructor' and is_active = true
  ) then
    raise exception '강사를 찾을 수 없거나 비활성 상태입니다.';
  end if;

  v_instructor_text := case
    when p_instructor_principal_id is not null then null
    else nullif(trim(coalesce(p_instructor_name_text, '')), '')
  end;

  select id, weekdays, session_start_time, session_end_time, instructor_principal_id, instructor_name_text, schedule_mode, holiday_auto_cancel
    into v_term_id, v_cur_weekdays, v_cur_start, v_cur_end, v_cur_instructor, v_cur_instructor_text, v_cur_schedule_mode, v_cur_holiday_auto_cancel
  from public.operation_terms
  where operation_cycle_id = p_operation_cycle_id and program_id = p_program_id;

  if v_term_id is null then
    select oc.name into v_conflict_cycle_name
    from public.operation_terms ot
    join public.operation_cycles oc on oc.id = ot.operation_cycle_id
    where ot.program_id = p_program_id
      and ot.operation_cycle_id <> p_operation_cycle_id
      and oc.start_date <= v_cycle_end
      and oc.end_date >= v_cycle_start
    limit 1;
    if v_conflict_cycle_name is not null then
      raise exception '이 프로그램은 이미 기간이 겹치는 다른 운영구분(%)에서 운영 중입니다.', v_conflict_cycle_name;
    end if;

    insert into public.operation_terms (
      organization_id, program_id, business_year_id, operation_cycle_id, name,
      start_date, end_date, session_start_time, session_end_time, weekdays,
      instructor_principal_id, instructor_name_text, schedule_mode, holiday_auto_cancel, status, created_by
    ) values (
      v_org, p_program_id, v_cycle_year, p_operation_cycle_id, v_cycle_name,
      v_cycle_start, v_cycle_end, p_start_time, p_end_time, v_final_weekdays,
      p_instructor_principal_id, v_instructor_text, p_schedule_mode, p_holiday_auto_cancel, 'scheduled', public.current_principal_id()
    )
    returning id into v_term_id;

    v_seq := 0;
    if p_schedule_mode = 'weekly' then
      for v_date in
        select d from public.compute_session_dates(v_cycle_start, v_cycle_end, p_weekdays) as d
        where d <> all (coalesce(p_excluded_dates, '{}'))
      loop
        v_seq := v_seq + 1;
        insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
        values (v_org, v_term_id, v_seq, (v_date + p_start_time) at time zone 'Asia/Seoul',
          (v_date + p_end_time) at time zone 'Asia/Seoul', 'scheduled');
      end loop;
    else
      for v_date in select distinct d from unnest(p_explicit_dates) as d order by d
      loop
        v_seq := v_seq + 1;
        insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
        values (v_org, v_term_id, v_seq, (v_date + p_start_time) at time zone 'Asia/Seoul',
          (v_date + p_end_time) at time zone 'Asia/Seoul', 'scheduled');
      end loop;
    end if;

    if v_seq = 0 then
      raise exception '생성될 회차가 없습니다(기간/요일/날짜를 확인해 주세요).';
    end if;

    return query select v_term_id, true, true;
    return;
  end if;

  v_unchanged :=
    p_schedule_mode = 'weekly'
    and v_cur_schedule_mode = 'weekly'
    and v_cur_weekdays = p_weekdays
    and v_cur_start = p_start_time
    and v_cur_end = p_end_time
    and v_cur_holiday_auto_cancel = p_holiday_auto_cancel;

  if v_unchanged then
    if v_cur_instructor is distinct from p_instructor_principal_id
      or v_cur_instructor_text is distinct from v_instructor_text then
      update public.operation_terms
      set instructor_principal_id = p_instructor_principal_id,
          instructor_name_text = v_instructor_text
      where id = v_term_id;
    end if;
    return query select v_term_id, false, false;
    return;
  end if;

  select count(*) into v_protected_count
  from public.sessions s
  where s.operation_term_id = v_term_id
    and (
      s.starts_at <= now()
      or exists (select 1 from public.final_attendance fa where fa.session_id = s.id)
      or exists (select 1 from public.instructor_attendance_submissions ias where ias.session_id = s.id)
    );

  if v_protected_count > 0 then
    raise exception '이미 출석기록이 있는 회기가 있어 전체 일정을 자동 변경할 수 없습니다. 예외 일정은 회차 단위로 수정해 주세요.';
  end if;

  delete from public.sessions where operation_term_id = v_term_id;

  update public.operation_terms
  set weekdays = v_final_weekdays,
      session_start_time = p_start_time,
      session_end_time = p_end_time,
      instructor_principal_id = p_instructor_principal_id,
      instructor_name_text = v_instructor_text,
      schedule_mode = p_schedule_mode,
      holiday_auto_cancel = p_holiday_auto_cancel
  where id = v_term_id;

  v_seq := 0;
  if p_schedule_mode = 'weekly' then
    for v_date in
      select d from public.compute_session_dates(v_cycle_start, v_cycle_end, p_weekdays) as d
      where d <> all (coalesce(p_excluded_dates, '{}'))
    loop
      v_seq := v_seq + 1;
      insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
      values (v_org, v_term_id, v_seq, (v_date + p_start_time) at time zone 'Asia/Seoul',
        (v_date + p_end_time) at time zone 'Asia/Seoul', 'scheduled');
    end loop;
  else
    for v_date in select distinct d from unnest(p_explicit_dates) as d order by d
    loop
      v_seq := v_seq + 1;
      insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
      values (v_org, v_term_id, v_seq, (v_date + p_start_time) at time zone 'Asia/Seoul',
        (v_date + p_end_time) at time zone 'Asia/Seoul', 'scheduled');
    end loop;
  end if;

  if v_seq = 0 then
    raise exception '생성될 회차가 없습니다(기간/요일/날짜를 확인해 주세요).';
  end if;

  return query select v_term_id, false, true;
end;
$$;

create or replace function public.add_session(p_operation_term_id uuid, p_date date, p_start_time time, p_end_time time)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_term record;
  v_activity_id uuid;
  v_session_id uuid;
  v_next_no integer;
begin
  select ot.id, ot.organization_id, ot.program_id, ot.start_date, ot.end_date
  into v_term
  from public.operation_terms ot where ot.id = p_operation_term_id;

  if v_term.id is null then
    raise exception '운영정보를 찾을 수 없습니다.';
  end if;

  select a.id into v_activity_id
  from public.programs p join public.activities a on a.id = p.activity_id
  where p.id = v_term.program_id;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 회차를 추가할 권한이 없습니다.';
  end if;

  if p_date is null or p_date < v_term.start_date or p_date > v_term.end_date then
    raise exception '운영구분 기간(%~%) 안의 날짜만 추가할 수 있습니다.', v_term.start_date, v_term.end_date;
  end if;
  if p_start_time is null or p_end_time is null or p_end_time <= p_start_time then
    raise exception '시작/종료 시간을 확인해 주세요.';
  end if;

  select coalesce(max(session_no), 0) + 1 into v_next_no
  from public.sessions where operation_term_id = p_operation_term_id;

  insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
  values (
    v_term.organization_id, p_operation_term_id, v_next_no,
    (p_date + p_start_time) at time zone 'Asia/Seoul', (p_date + p_end_time) at time zone 'Asia/Seoul',
    'scheduled'
  )
  returning id into v_session_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_term.organization_id, public.current_principal_id(), 'add_session', 'session', v_session_id);

  return v_session_id;
end;
$$;
