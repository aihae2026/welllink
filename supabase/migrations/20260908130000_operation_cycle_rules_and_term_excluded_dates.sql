-- Manual QA Gap Fix — Initial Setup & Program Onboarding
--
-- §11: 운영구분 생성 규칙 -- 동일 운영연도 내 이름 중복 금지, 기간은 해당
-- 운영연도 범위 안, 같은 Program이 서로 겹치는 두 운영구분에 동시에 운영되지
-- 않도록 방지(중복 회차 생성 방지).
-- §13: 운영구분 수정(이름은 항상, 기간은 Program 운영정보/Session이 아직 없을
-- 때만) / 삭제(하위 업무데이터가 전혀 없을 때만).
-- §20: "회차 일정 확인" 단계에서 생성된 회차 중 일부를 제외하고 등록할 수
-- 있도록 upsert_operation_term_for_cycle에 최소 파라미터(p_excluded_dates)를
-- 추가한다. "월N회"처럼 요일 패턴을 벗어난 임의 날짜를 추측 생성하지는 않는다
-- -- 여전히 요일 반복 생성 + 사용자가 직접 제외를 선택하는 방식만 지원한다.

create or replace function public.create_operation_cycle(
  p_business_year_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_year_org uuid;
  v_year integer;
  v_cycle_id uuid;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '운영구분을 생성할 권한이 없습니다.';
  end if;

  select organization_id, year into v_year_org, v_year
  from public.business_years where id = p_business_year_id;
  if v_year_org is null or v_year_org <> v_org then
    raise exception '연도를 찾을 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '운영구분명을 입력해 주세요.';
  end if;
  if p_start_date is null or p_end_date is null or p_start_date > p_end_date then
    raise exception '운영기간이 올바르지 않습니다.';
  end if;
  if extract(year from p_start_date)::integer <> v_year or extract(year from p_end_date)::integer <> v_year then
    raise exception '운영기간은 선택한 운영연도(%)의 범위 안이어야 합니다.', v_year;
  end if;
  if exists (
    select 1 from public.operation_cycles
    where business_year_id = p_business_year_id and name = trim(p_name)
  ) then
    raise exception '같은 운영연도에 이미 "%" 운영구분이 있습니다.', trim(p_name);
  end if;

  insert into public.operation_cycles (organization_id, business_year_id, name, start_date, end_date, idempotency_key, created_by)
  values (v_org, p_business_year_id, trim(p_name), p_start_date, p_end_date,
    'manual:' || gen_random_uuid()::text, public.current_principal_id())
  returning id into v_cycle_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_operation_cycle', 'operation_cycle', v_cycle_id,
    jsonb_build_object('name', p_name, 'start_date', p_start_date, 'end_date', p_end_date));

  return v_cycle_id;
end;
$$;

create function public.update_operation_cycle(
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
  v_year integer;
  v_has_terms boolean;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '운영구분을 수정할 권한이 없습니다.';
  end if;

  select organization_id, business_year_id into v_cycle_org, v_business_year_id
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

  select exists (select 1 from public.operation_terms where operation_cycle_id = p_id) into v_has_terms;

  if v_has_terms then
    -- 프로그램 일정이 설정된 운영구분은 운영기간을 변경할 수 없다(§13) --
    -- 이름만 반영하고 날짜 값은 조용히 무시한다(클라이언트가 입력 자체를 잠근다).
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
    jsonb_build_object('name', p_name, 'start_date', p_start_date, 'end_date', p_end_date, 'dates_applied', not v_has_terms));
end;
$$;

create function public.delete_operation_cycle(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_cycle_org uuid;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '운영구분을 삭제할 권한이 없습니다.';
  end if;

  select organization_id into v_cycle_org from public.operation_cycles where id = p_id;
  if v_cycle_org is null or v_cycle_org <> v_org then
    raise exception '운영구분을 찾을 수 없습니다.';
  end if;

  -- Program 운영정보(operation_terms)가 하나라도 있으면 그 아래 Session/Enrollment/
  -- Attendance/Performance가 연쇄로 존재할 수 있으므로 통째로 막는다(§13 --
  -- 하위 업무데이터가 하나도 없는 경우에만 삭제 가능, cascade delete 금지).
  if exists (select 1 from public.operation_terms where operation_cycle_id = p_id) then
    raise exception '이 운영구분에는 이미 등록된 프로그램 운영정보가 있어 삭제할 수 없습니다. 먼저 관련 운영정보를 정리해 주세요.';
  end if;

  delete from public.operation_cycles where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_org, public.current_principal_id(), 'delete_operation_cycle', 'operation_cycle', p_id);
end;
$$;

-- upsert_operation_term_for_cycle: (1) 신규 term 생성 시 같은 Program이 기간이
-- 겹치는 다른 운영구분에 이미 운영 중이면 차단한다(§11, 중복 회차 생성 방지).
-- (2) p_excluded_dates -- 요일 반복으로 계산된 날짜 중 사용자가 "회차 일정
-- 확인" 단계에서 직접 제외를 선택한 날짜는 회차를 만들지 않는다(§20 최소 구현
-- -- 임의 날짜를 추측 생성하지 않고, 계산된 반복 패턴에서 제외만 허용).
create or replace function public.upsert_operation_term_for_cycle(
  p_operation_cycle_id uuid,
  p_program_id uuid,
  p_weekdays smallint[],
  p_start_time time,
  p_end_time time,
  p_instructor_principal_id uuid,
  p_excluded_dates date[] default '{}'
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
  v_protected_count integer;
  v_seq integer;
  v_date date;
  v_conflict_cycle_name text;
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

  if p_weekdays is null or array_length(p_weekdays, 1) is null then
    raise exception '요일을 1개 이상 선택해 주세요.';
  end if;
  if p_start_time is null or p_end_time is null then
    raise exception '시작/종료 시간을 입력해 주세요.';
  end if;
  if p_end_time <= p_start_time then
    raise exception '종료시간은 시작시간보다 늦어야 합니다.';
  end if;
  if p_instructor_principal_id is not null and not exists (
    select 1 from public.principals
    where id = p_instructor_principal_id and organization_id = v_org
      and principal_type = 'instructor' and is_active = true
  ) then
    raise exception '강사를 찾을 수 없거나 비활성 상태입니다.';
  end if;

  select id, weekdays, session_start_time, session_end_time, instructor_principal_id
    into v_term_id, v_cur_weekdays, v_cur_start, v_cur_end, v_cur_instructor
  from public.operation_terms
  where operation_cycle_id = p_operation_cycle_id and program_id = p_program_id;

  if v_term_id is null then
    -- 같은 Program이 기간이 겹치는 다른 운영구분에 이미 운영 중이면 차단한다
    -- (같은 회차가 두 운영구분에서 중복 생성되는 것을 막는다).
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

    -- 신규: term 생성 + 전체 회차 생성(제외 날짜 제외).
    insert into public.operation_terms (
      organization_id, program_id, business_year_id, operation_cycle_id, name,
      start_date, end_date, session_start_time, session_end_time, weekdays,
      instructor_principal_id, status, created_by
    ) values (
      v_org, p_program_id, v_cycle_year, p_operation_cycle_id, v_cycle_name,
      v_cycle_start, v_cycle_end, p_start_time, p_end_time, p_weekdays,
      p_instructor_principal_id, 'scheduled', public.current_principal_id()
    )
    returning id into v_term_id;

    v_seq := 0;
    for v_date in
      select d from public.compute_session_dates(v_cycle_start, v_cycle_end, p_weekdays) as d
      where d <> all (coalesce(p_excluded_dates, '{}'))
    loop
      v_seq := v_seq + 1;
      insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
      values (
        v_org, v_term_id, v_seq,
        (v_date + p_start_time) at time zone 'Asia/Seoul',
        (v_date + p_end_time) at time zone 'Asia/Seoul',
        'scheduled'
      );
    end loop;

    if v_seq = 0 then
      raise exception '생성될 회차가 없습니다(기간/요일/제외 날짜를 확인해 주세요).';
    end if;

    return query select v_term_id, true, true;
    return;
  end if;

  -- 기존 term: 값이 동일하면(같은 Excel 재업로드 등) 아무 것도 바꾸지 않는다
  -- (§14 재업로드 idempotency) -- 강사만 다르면 강사만 갱신(일정에 영향 없음).
  if v_cur_weekdays = p_weekdays and v_cur_start = p_start_time and v_cur_end = p_end_time then
    if v_cur_instructor is distinct from p_instructor_principal_id then
      update public.operation_terms set instructor_principal_id = p_instructor_principal_id
      where id = v_term_id;
    end if;
    return query select v_term_id, false, false;
    return;
  end if;

  -- 일정이 실제로 바뀌는 경우: 이미 출석기록이 있거나 과거로 지나간 회차가 하나라도
  -- 있으면 전체 재계산을 거부한다(§15 -- 과거 출석 데이터 보존 최우선. 부분
  -- 재계산으로 얼버무리지 않고 명확히 차단한다).
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

  -- 보호 대상이 전혀 없으므로(전부 미래 + 무출석) 안전하게 전체 재생성한다.
  delete from public.sessions where operation_term_id = v_term_id;

  update public.operation_terms
  set weekdays = p_weekdays,
      session_start_time = p_start_time,
      session_end_time = p_end_time,
      instructor_principal_id = p_instructor_principal_id
  where id = v_term_id;

  v_seq := 0;
  for v_date in
    select d from public.compute_session_dates(v_cycle_start, v_cycle_end, p_weekdays) as d
    where d <> all (coalesce(p_excluded_dates, '{}'))
  loop
    v_seq := v_seq + 1;
    insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
    values (
      v_org, v_term_id, v_seq,
      (v_date + p_start_time) at time zone 'Asia/Seoul',
      (v_date + p_end_time) at time zone 'Asia/Seoul',
      'scheduled'
    );
  end loop;

  if v_seq = 0 then
    raise exception '생성될 회차가 없습니다(기간/요일/제외 날짜를 확인해 주세요).';
  end if;

  return query select v_term_id, false, true;
end;
$$;
