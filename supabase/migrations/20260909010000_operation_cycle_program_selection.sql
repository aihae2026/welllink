-- Manual QA Gap Fix — 프로그램 설정 / 강사 / 수강대상 등록 흐름 정리
--
-- §2-3: 운영구분마다 실제 운영할 Program만 선택할 수 있게 한다. 지금까지는
-- "출석연동 활동은 전부" 자동으로 매 운영구분의 대상이 되어(list_operation_
-- cycle_program_status가 조직 전체 활동을 무조건 나열), 실제로 이 운영구분에서
-- 쓰지 않는 프로그램까지 "설정필요"로 계속 노출되는 문제가 있었다.
--
-- 최소 forward-only 변경: operation_terms/sessions 구조는 이미 "운영구분+
-- Program"의 실제 운영정보를 정확히 표현하고 있으므로 재설계하지 않는다.
-- "이 운영구분에서 이 Program을 다루기로 했다"는 그보다 한 단계 앞선 선택
-- 상태이므로, 이를 위한 최소 join 테이블만 추가한다(스키마 재설계 아님).
--
-- §4-6: 강사가 아직 시스템에 등록되지 않았어도 운영정보를 등록할 수 있어야
-- 한다. operation_terms에 nullable text 컬럼 하나만 추가한다(instructor
-- schema 재설계 아님) -- instructor_principal_id가 있으면 그 값이
-- source of truth이고, 없으면 이 텍스트를 그대로 화면에 보여준다.

create table public.operation_cycle_programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  operation_cycle_id uuid not null references public.operation_cycles (id),
  program_id uuid not null references public.programs (id),
  created_at timestamptz not null default now(),
  created_by uuid references public.principals (id),
  unique (operation_cycle_id, program_id)
);

create index operation_cycle_programs_cycle_id_idx on public.operation_cycle_programs (operation_cycle_id);
create index operation_cycle_programs_program_id_idx on public.operation_cycle_programs (program_id);

alter table public.operation_cycle_programs enable row level security;

create policy "권한자 운영구분 프로그램선택 조회" on public.operation_cycle_programs for select
  using (
    organization_id = public.current_organization_id()
    and public.current_business_role() in ('global_manager', 'department_manager', 'staff')
  );

-- 이 테이블은 새로 시작하므로 비어 있다. 그런데 list_operation_cycle_program_status
-- 를 아래에서 "선택된 Program만" 보여주도록 바꾸면, 이 migration 이전에 이미
-- 운영정보(operation_terms)까지 설정해 둔 기존 Program들이 전부 화면에서
-- 사라져 버리는 회귀가 생긴다. 그런 조합은 이미 사실상 "선택된" 것이므로
-- 한 번만 역산해서 채워 넣는다(business 데이터 자체는 전혀 건드리지 않는다 --
-- 이 새 선택-추적 테이블만 채운다).
insert into public.operation_cycle_programs (organization_id, operation_cycle_id, program_id, created_at)
select distinct ot.organization_id, ot.operation_cycle_id, ot.program_id, now()
from public.operation_terms ot
where ot.operation_cycle_id is not null
on conflict (operation_cycle_id, program_id) do nothing;

alter table public.operation_terms add column instructor_name_text text;

-- 이 운영구분에 아직 선택되지 않은, 조직의 출석연동 활동 목록(선택 Dialog용).
create function public.list_selectable_programs_for_cycle(p_operation_cycle_id uuid)
returns table (out_program_id uuid, out_activity_id uuid, out_name text)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_org uuid;
  v_cycle_org uuid;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '프로그램을 선택할 권한이 없습니다.';
  end if;
  select organization_id into v_cycle_org from public.operation_cycles where id = p_operation_cycle_id;
  if v_cycle_org is null or v_cycle_org <> v_org then
    raise exception '운영구분을 찾을 수 없습니다.';
  end if;

  return query
    select p.id, a.id, p.name
    from public.activities a
    join public.programs p on p.activity_id = a.id
    where a.organization_id = v_org
      and a.default_performance_method = 'attendance'
      and a.is_active = true
      and public.can_read_activity(a.id)
      and not exists (
        select 1 from public.operation_cycle_programs ocp
        where ocp.operation_cycle_id = p_operation_cycle_id and ocp.program_id = p.id
      )
    order by p.name;
end;
$$;

-- 선택한 Program들을 이 운영구분에 추가한다(이미 선택된 것은 조용히 건너뛴다
-- -- idempotent). 운영정보/회차는 여기서 만들지 않는다 -- Step 2에서 실제
-- 요일/시간을 설정할 때 upsert_operation_term_for_cycle이 그 프로그램에
-- 대해서만 만든다.
create function public.add_operation_cycle_programs(p_operation_cycle_id uuid, p_program_ids uuid[])
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_cycle_org uuid;
  v_program_id uuid;
  v_activity_id uuid;
  v_activity_org uuid;
  v_added integer := 0;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '프로그램을 선택할 권한이 없습니다.';
  end if;
  select organization_id into v_cycle_org from public.operation_cycles where id = p_operation_cycle_id;
  if v_cycle_org is null or v_cycle_org <> v_org then
    raise exception '운영구분을 찾을 수 없습니다.';
  end if;
  if p_program_ids is null or array_length(p_program_ids, 1) is null then
    raise exception '선택할 프로그램을 지정해 주세요.';
  end if;

  foreach v_program_id in array p_program_ids
  loop
    select a.id, a.organization_id into v_activity_id, v_activity_org
    from public.programs p join public.activities a on a.id = p.activity_id
    where p.id = v_program_id;
    if v_activity_id is null or v_activity_org <> v_org then
      raise exception '프로그램을 찾을 수 없습니다.';
    end if;
    if not public.can_manage_activity(v_activity_id) then
      raise exception '이 프로그램을 운영구분에 추가할 권한이 없습니다.';
    end if;

    insert into public.operation_cycle_programs (organization_id, operation_cycle_id, program_id, created_by)
    values (v_org, p_operation_cycle_id, v_program_id, public.current_principal_id())
    on conflict (operation_cycle_id, program_id) do nothing;
    if found then
      v_added := v_added + 1;
    end if;
  end loop;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'add_operation_cycle_programs', 'operation_cycle', p_operation_cycle_id,
    jsonb_build_object('program_ids', p_program_ids, 'added', v_added));

  return v_added;
end;
$$;

-- 이 운영구분에 "선택된" Program만 상태표에 노출한다(§2, §3). 강사 미등록
-- 텍스트(instructor_name_text)도 함께 반환한다(§6). 반환 컬럼이 늘어나
-- (out_instructor_name_text 추가) row type이 바뀌므로 CREATE OR REPLACE로는
-- 안 되고 먼저 DROP해야 한다.
drop function if exists public.list_operation_cycle_program_status(uuid);

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
  out_instructor_name_text text,
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
    raise exception '운영구분을 찾을 수 없습니다.';
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
      ot.instructor_name_text,
      (select count(*)::integer from public.sessions s where s.operation_term_id = ot.id),
      (select count(*)::integer from public.enrollments e where e.operation_term_id = ot.id and e.end_session_no_exclusive is null),
      ot.initial_roster_applied_at is not null
    from public.operation_cycle_programs ocp
    join public.programs p on p.id = ocp.program_id
    join public.activities a on a.id = p.activity_id
    left join public.operation_terms ot
      on ot.operation_cycle_id = p_operation_cycle_id and ot.program_id = p.id
    left join public.principals ip on ip.id = ot.instructor_principal_id
    where ocp.operation_cycle_id = p_operation_cycle_id
      and public.can_read_activity(a.id)
    order by p.name;
end;
$$;

-- upsert_operation_term_for_cycle: (1) 선택되지 않은 Program에는 운영정보를
-- 만들 수 없게 막는다(§2 hard rule -- "선택되지 않은 Program의 OperationTerm/
-- Session을 생성하지 않는다"). (2) 미등록 강사명(p_instructor_name_text)을
-- 받는다 -- 등록 강사를 고르면(p_instructor_principal_id) 그 값이 우선이고
-- 텍스트는 저장하지 않는다.
create or replace function public.upsert_operation_term_for_cycle(
  p_operation_cycle_id uuid,
  p_program_id uuid,
  p_weekdays smallint[],
  p_start_time time,
  p_end_time time,
  p_instructor_principal_id uuid,
  p_excluded_dates date[] default '{}',
  p_instructor_name_text text default null
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
  v_protected_count integer;
  v_seq integer;
  v_date date;
  v_conflict_cycle_name text;
  v_instructor_text text;
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

  v_instructor_text := case
    when p_instructor_principal_id is not null then null
    else nullif(trim(coalesce(p_instructor_name_text, '')), '')
  end;

  select id, weekdays, session_start_time, session_end_time, instructor_principal_id, instructor_name_text
    into v_term_id, v_cur_weekdays, v_cur_start, v_cur_end, v_cur_instructor, v_cur_instructor_text
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
      instructor_principal_id, instructor_name_text, status, created_by
    ) values (
      v_org, p_program_id, v_cycle_year, p_operation_cycle_id, v_cycle_name,
      v_cycle_start, v_cycle_end, p_start_time, p_end_time, p_weekdays,
      p_instructor_principal_id, v_instructor_text, 'scheduled', public.current_principal_id()
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

  if v_cur_weekdays = p_weekdays and v_cur_start = p_start_time and v_cur_end = p_end_time then
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
  set weekdays = p_weekdays,
      session_start_time = p_start_time,
      session_end_time = p_end_time,
      instructor_principal_id = p_instructor_principal_id,
      instructor_name_text = v_instructor_text
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
