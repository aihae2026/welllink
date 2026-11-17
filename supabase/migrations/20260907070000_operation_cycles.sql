-- 운영 UX Gap Closure — 핵심 수정: 운영차수를 Program마다 반복 생성해야 했던 문제를
-- 닫는다. 기존 operation_terms(Program별 run, Pipeline 1의 Source of Truth)는
-- 그대로 유지하고, 그 위에 공통 parent인 operation_cycles만 추가한다.
--
-- 기존 operation_terms(QA/실사용 데이터 포함)는 무작정 migration하지 않는다 --
-- operation_cycle_id는 nullable이라 기존 행은 계속 NULL로 남고(그대로 접근 가능),
-- 새 위저드로 만든 차수만 실제로 cycle에 연결된다.

create type operation_cycle_status as enum ('scheduled', 'active', 'ended');

create table public.operation_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  business_year_id uuid not null references public.business_years (id),
  name text not null,
  start_date date not null,
  end_date date not null,
  status operation_cycle_status not null default 'scheduled',
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.principals (id),
  constraint operation_cycles_date_range check (start_date <= end_date),
  unique (organization_id, idempotency_key)
);

create index operation_cycles_organization_id_idx on public.operation_cycles (organization_id);

alter table public.operation_terms add column operation_cycle_id uuid references public.operation_cycles (id);
create index operation_terms_operation_cycle_id_idx on public.operation_terms (operation_cycle_id);

alter table public.operation_cycles enable row level security;

create policy "권한자 운영차수그룹 조회" on public.operation_cycles for select
  using (
    exists (
      select 1 from public.operation_terms ot
      join public.programs p on p.id = ot.program_id
      where ot.operation_cycle_id = operation_cycles.id and public.can_read_activity(p.activity_id)
    )
    -- cycle을 막 만든 직후(아직 이 cycle을 참조하는 operation_term이 있으므로 위 exists로
    -- 충분하다) 이외에, 생성 권한이 있는 사용자는 자기 조직 것을 볼 수 있게 한다.
    or (
      organization_id = public.current_organization_id()
      and public.current_business_role() in ('global_manager', 'department_manager')
    )
  );

-- 운영차수(그룹) + 선택된 Program들을 하나의 transaction으로 일괄 생성한다.
-- p_programs: [{program_id, weekdays: number[], start_time, end_time, instructor_principal_id}, ...]
-- 권한 없는/조건 미충족 program이 하나라도 있으면 함수 전체가 rollback된다(plpgsql
-- 함수 본문은 기본적으로 하나의 transaction).
create function public.create_operation_cycle_with_programs(
  p_business_year_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date,
  p_programs jsonb,
  p_idempotency_key text
)
returns table (out_cycle_id uuid, out_term_count integer, out_session_count integer)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_year_org uuid;
  v_existing_cycle_id uuid;
  v_cycle_id uuid;
  v_row jsonb;
  v_program_id uuid;
  v_activity_id uuid;
  v_weekdays smallint[];
  v_start_time time;
  v_end_time time;
  v_instructor uuid;
  v_term_id uuid;
  v_term_count integer := 0;
  v_session_count integer := 0;
  v_seq integer;
  v_date date;
begin
  v_org := public.current_organization_id();
  if v_org is null then
    raise exception '조직 정보를 확인할 수 없습니다.';
  end if;

  select organization_id into v_year_org from public.business_years where id = p_business_year_id;
  if v_year_org is null or v_year_org <> v_org then
    raise exception '연도를 찾을 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '운영차수명을 입력해 주세요.';
  end if;
  if p_start_date > p_end_date then
    raise exception '시작일은 종료일보다 늦을 수 없습니다.';
  end if;
  if p_programs is null or jsonb_array_length(p_programs) = 0 then
    raise exception '운영할 프로그램을 1개 이상 선택해 주세요.';
  end if;

  select id into v_existing_cycle_id from public.operation_cycles
  where organization_id = v_org and idempotency_key = p_idempotency_key;
  if v_existing_cycle_id is not null then
    select count(*), coalesce(sum(s.cnt), 0) into v_term_count, v_session_count
    from public.operation_terms ot
    left join lateral (select count(*) as cnt from public.sessions where operation_term_id = ot.id) s on true
    where ot.operation_cycle_id = v_existing_cycle_id;
    return query select v_existing_cycle_id, v_term_count, v_session_count::integer;
    return;
  end if;

  insert into public.operation_cycles (organization_id, business_year_id, name, start_date, end_date, idempotency_key, created_by)
  values (v_org, p_business_year_id, trim(p_name), p_start_date, p_end_date, p_idempotency_key, public.current_principal_id())
  returning id into v_cycle_id;

  for v_row in select * from jsonb_array_elements(p_programs) loop
    v_program_id := (v_row->>'program_id')::uuid;

    select a.id into v_activity_id from public.programs p join public.activities a on a.id = p.activity_id
    where p.id = v_program_id;
    if v_activity_id is null then
      raise exception '프로그램을 찾을 수 없습니다: %', v_program_id;
    end if;
    if not public.can_manage_activity(v_activity_id) then
      raise exception '권한이 없는 프로그램이 포함되어 있습니다.';
    end if;

    select array_agg(x::smallint) into v_weekdays from jsonb_array_elements_text(v_row->'weekdays') as x;
    if v_weekdays is null or array_length(v_weekdays, 1) is null then
      raise exception '요일을 1개 이상 선택해 주세요: %', v_program_id;
    end if;
    v_start_time := nullif(v_row->>'start_time', '')::time;
    v_end_time := nullif(v_row->>'end_time', '')::time;
    if v_start_time is null or v_end_time is null then
      raise exception '시작/종료시간을 입력해 주세요: %', v_program_id;
    end if;
    v_instructor := nullif(v_row->>'instructor_principal_id', '')::uuid;
    if v_instructor is not null and not exists (
      select 1 from public.principals where id = v_instructor and organization_id = v_org and principal_type = 'instructor'
    ) then
      raise exception '강사를 찾을 수 없습니다: %', v_instructor;
    end if;

    insert into public.operation_terms (
      organization_id, program_id, business_year_id, operation_cycle_id, name,
      start_date, end_date, session_start_time, session_end_time, weekdays,
      instructor_principal_id, status, created_by
    ) values (
      v_org, v_program_id, p_business_year_id, v_cycle_id, trim(p_name),
      p_start_date, p_end_date, v_start_time, v_end_time, v_weekdays,
      v_instructor, 'scheduled', public.current_principal_id()
    )
    returning id into v_term_id;
    v_term_count := v_term_count + 1;

    v_seq := 0;
    for v_date in
      select d from public.compute_session_dates(p_start_date, p_end_date, v_weekdays) as d
    loop
      v_seq := v_seq + 1;
      insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status)
      values (
        v_org, v_term_id, v_seq,
        (v_date + v_start_time) at time zone 'Asia/Seoul',
        (v_date + v_end_time) at time zone 'Asia/Seoul',
        'scheduled'
      );
      v_session_count := v_session_count + 1;
    end loop;

    if v_seq = 0 then
      raise exception '생성될 회차가 없습니다(기간/요일 확인): %', v_program_id;
    end if;
  end loop;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_operation_cycle', 'operation_cycle', v_cycle_id,
    jsonb_build_object('name', p_name, 'program_count', v_term_count, 'session_count', v_session_count));

  return query select v_cycle_id, v_term_count, v_session_count;
end;
$$;

create function public.list_operation_cycles(p_business_year_id uuid default null)
returns table (
  out_id uuid,
  out_name text,
  out_start_date date,
  out_end_date date,
  out_status operation_cycle_status,
  out_program_count integer
)
language plpgsql
security definer set search_path = public
stable
as $$
begin
  return query
    select oc.id, oc.name, oc.start_date, oc.end_date, oc.status,
      (select count(*)::integer from public.operation_terms ot
       join public.programs p on p.id = ot.program_id
       where ot.operation_cycle_id = oc.id and public.can_read_activity(p.activity_id))
    from public.operation_cycles oc
    where oc.organization_id = public.current_organization_id()
      and (p_business_year_id is null or oc.business_year_id = p_business_year_id)
      and exists (
        select 1 from public.operation_terms ot join public.programs p on p.id = ot.program_id
        where ot.operation_cycle_id = oc.id and public.can_read_activity(p.activity_id)
      )
    order by oc.start_date desc;
end;
$$;
