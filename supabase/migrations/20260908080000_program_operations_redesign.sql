-- WellLink v1.0 — Program Operations Redesign: Term First / Excel First / Enrollment
-- Lifecycle.
--
-- 기존 데이터모델(operation_cycles/operation_terms/sessions/enrollments)은 이미
-- 이번 재설계가 요구하는 semantics와 정확히 일치한다(운영차수 공통기간=
-- operation_cycles, 프로그램별 설정=operation_terms, 회차 자동생성=
-- compute_session_dates, 등록일/종결일=enrollments.start_session_no/
-- end_session_no_exclusive -- 전부 이미 존재). 따라서 이 migration은 새 테이블을
-- 만들지 않고 RPC 3개만 추가한다:
--
--   1) create_operation_cycle           -- Step 1: 운영차수만 단독 생성(프로그램 선택 없이)
--   2) upsert_operation_term_for_cycle  -- Step 2: Excel 한 행 = 이 RPC 한 번 호출.
--                                          재호출 시 idempotent upsert. 일정이 실제로
--                                          바뀌는데 이미 출석기록/과거 회차가 있으면
--                                          거부(§15) -- 부분 재계산으로 얼버무리지 않는다.
--   3) list_operation_cycle_program_status -- Step 2/3 진행상태·상태요약표 조회.

-- ============================================================
-- 1. 운영차수 단독 생성 (Step 1)
-- ============================================================
create function public.create_operation_cycle(
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
  v_cycle_id uuid;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '운영차수를 생성할 권한이 없습니다.';
  end if;

  select organization_id into v_year_org from public.business_years where id = p_business_year_id;
  if v_year_org is null or v_year_org <> v_org then
    raise exception '연도를 찾을 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '운영차수명을 입력해 주세요.';
  end if;
  if p_start_date is null or p_end_date is null or p_start_date > p_end_date then
    raise exception '운영기간이 올바르지 않습니다.';
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

-- ============================================================
-- 2. Excel 한 행을 안전하게 upsert (Step 2 엔진)
-- ============================================================
create function public.upsert_operation_term_for_cycle(
  p_operation_cycle_id uuid,
  p_program_id uuid,
  p_weekdays smallint[],
  p_start_time time,
  p_end_time time,
  p_instructor_principal_id uuid
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
begin
  v_org := public.current_organization_id();
  select organization_id, start_date, end_date, business_year_id, name
    into v_cycle_org, v_cycle_start, v_cycle_end, v_cycle_year, v_cycle_name
  from public.operation_cycles where id = p_operation_cycle_id;
  if v_cycle_org is null or v_cycle_org <> v_org then
    raise exception '운영차수를 찾을 수 없습니다.';
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
    -- 신규: term 생성 + 전체 회차 생성.
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
    for v_date in select d from public.compute_session_dates(v_cycle_start, v_cycle_end, p_weekdays) as d
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
      raise exception '생성될 회차가 없습니다(기간/요일을 확인해 주세요).';
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
  for v_date in select d from public.compute_session_dates(v_cycle_start, v_cycle_end, p_weekdays) as d
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
    raise exception '생성될 회차가 없습니다(기간/요일을 확인해 주세요).';
  end if;

  return query select v_term_id, false, true;
end;
$$;

-- ============================================================
-- 3. Step 2/3 진행상태 + 상태요약표 조회
-- ============================================================
create function public.list_operation_cycle_program_status(p_operation_cycle_id uuid)
returns table (
  out_program_id uuid,
  out_activity_id uuid,
  out_name text,
  out_has_term boolean,
  out_operation_term_id uuid,
  out_weekdays smallint[],
  out_start_time time,
  out_end_time time,
  out_instructor_name text,
  out_session_count integer,
  out_enrollment_count integer,
  out_initial_roster_applied boolean
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_org uuid;
begin
  v_org := public.current_organization_id();
  if v_org is null then
    raise exception '조직 정보를 확인할 수 없습니다.';
  end if;
  if not exists (select 1 from public.operation_cycles where id = p_operation_cycle_id and organization_id = v_org) then
    raise exception '운영차수를 찾을 수 없습니다.';
  end if;

  return query
    select
      p.id,
      a.id,
      p.name,
      ot.id is not null,
      ot.id,
      ot.weekdays,
      ot.session_start_time,
      ot.session_end_time,
      ip.name,
      (select count(*)::integer from public.sessions s where s.operation_term_id = ot.id),
      (select count(*)::integer from public.enrollments e where e.operation_term_id = ot.id and e.end_session_no_exclusive is null),
      ot.initial_roster_applied_at is not null
    from public.activities a
    join public.programs p on p.activity_id = a.id
    left join public.operation_terms ot
      on ot.operation_cycle_id = p_operation_cycle_id and ot.program_id = p.id
    left join public.principals ip on ip.id = ot.instructor_principal_id
    where a.organization_id = v_org
      and a.default_performance_method = 'attendance'
      and a.is_active = true
      and public.can_read_activity(a.id)
    order by p.name;
end;
$$;
