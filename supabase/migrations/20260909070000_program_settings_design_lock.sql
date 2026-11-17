-- Program Settings Final Design Lock
--
-- §1-9: 운영구분 방식(반기제/분기제)+연중 여부를 기관 설정(organizations)에
-- 저장하고, 운영연도 생성(create_business_year) 시 그 설정에 따라 해당
-- 연도의 운영구분을 자동 생성한다. 사용자에게 "프로그램용 운영연도"를 별도로
-- 만들게 하지 않는다(§2) -- business_years는 원래부터 organization 단위로
-- 하나뿐이고 operation_cycles가 business_year_id를 참조하는 구조라 이미
-- "별도 생성"이 필요 없었다; 이번에 추가하는 건 순수히 "운영구분 자동생성"
-- 뿐이다. 기존 create_operation_cycle을 그대로 재사용해 이름 중복검사/
-- 감사로그 등 기존 안전장치를 그대로 적용받는다(§67 audit 원칙).
--
-- §56: operation_cycle_programs가 operation_cycles를 FK(ON DELETE 절 없음
-- = NO ACTION/RESTRICT)로 참조하는데 delete_operation_cycle이 이를 검사하지
-- 않아, 실제 업무데이터 없이 "가져오기"만 된 상태에서도 운영구분 삭제 시 raw
-- FK violation이 노출되는 실제 버그가 있었다(audit로 확인). 여기서 고친다.
--
-- §17: "프로그램 제외하기" -- Program Master는 그대로 두고 operation_cycle_programs
-- mapping만 안전하게 정리한다. 실제 업무데이터(Enrollment/출석/실적 등)가
-- 있으면 차단한다.
--
-- §22-25/§45/§47: "공휴일 자동 휴강" -- 연도별 날짜를 코드에 hardcode하지
-- 않기 위해 public_holidays라는 유지보수 가능한 데이터 테이블을 둔다. 양력
-- 고정일(신정/삼일절/어린이날/현충일/광복절/개천절/한글날/성탄절)은 MM-DD
-- 패턴을 여러 해에 걸쳐 계산해 넣을 수 있어 이번에 함께 시드한다. 설날/추석/
-- 부처님오신날 등 음력 기반 공휴일은 정확한 변환 없이 추측 입력하면 실제
-- 운영일을 잘못 휴강 처리할 위험이 있어 이번 배치에서는 넣지 않는다 --
-- 검증된 날짜가 확보되면 이 테이블에 추가로 insert하면 된다.
--
-- §47-48: 회차 추가/수정 -- 지금까지는 "기본설정" 저장 시 term 전체를
-- 재생성하는 경로만 있었고, 회차 하나만 추가/수정하는 RPC가 없었다. 새로
-- add_session/update_session을 추가한다. 둘 다 §49의 delete_session과
-- 동일한 "업무데이터 dependency 존재 여부" 기준을 그대로 따른다.
--
-- §42: 휴강취소가 무조건 scheduled로 돌아가면 안 된다 -- 이미 종료+30분이
-- 지난 회차는(이 시점에 FinalAttendance가 없다는 건 위에서 이미 확인했으므로)
-- missing으로 돌아가야 자연스럽다. "휴강 전 상태"를 별도로 저장하는 컬럼을
-- 새로 만들지 않고, 현재 시각 기준으로 그때그때 재계산하는 최소 구현이다.

-- ============================================================
-- 1. 운영구분 방식(반기제/분기제) + 연중 여부 -- 기관 설정
-- ============================================================

alter table public.organizations
  add column operation_cycle_mode text not null default 'semester'
    constraint organizations_operation_cycle_mode_valid check (operation_cycle_mode in ('semester', 'quarter')),
  add column include_annual_cycle boolean not null default false;

create function public.update_operation_cycle_mode(p_mode text, p_include_annual_cycle boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '운영구분 방식을 변경할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_mode not in ('semester', 'quarter') then
    raise exception '운영구분 방식을 확인해 주세요.';
  end if;

  update public.organizations
  set operation_cycle_mode = p_mode, include_annual_cycle = p_include_annual_cycle
  where id = v_org;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'update_operation_cycle_mode', 'organization', v_org,
    jsonb_build_object('operation_cycle_mode', p_mode, 'include_annual_cycle', p_include_annual_cycle));
end;
$$;

-- ============================================================
-- 2. 운영연도 생성 시 운영구분 자동 생성
-- ============================================================

create or replace function public.create_business_year(p_year integer)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_id uuid;
  v_mode text;
  v_include_annual boolean;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '연도를 추가할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_year is null or p_year < 2000 or p_year > 2200 then
    raise exception '연도 값이 올바르지 않습니다.';
  end if;

  insert into public.business_years (organization_id, year, status)
  values (v_org, p_year, 'active')
  returning id into v_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'create_business_year', 'business_year', v_id, jsonb_build_object('year', p_year));

  select operation_cycle_mode, include_annual_cycle into v_mode, v_include_annual
  from public.organizations where id = v_org;

  if v_mode = 'quarter' then
    perform public.create_operation_cycle(v_id, '1분기', make_date(p_year, 1, 1), make_date(p_year, 3, 31));
    perform public.create_operation_cycle(v_id, '2분기', make_date(p_year, 4, 1), make_date(p_year, 6, 30));
    perform public.create_operation_cycle(v_id, '3분기', make_date(p_year, 7, 1), make_date(p_year, 9, 30));
    perform public.create_operation_cycle(v_id, '4분기', make_date(p_year, 10, 1), make_date(p_year, 12, 31));
  else
    perform public.create_operation_cycle(v_id, '상반기', make_date(p_year, 1, 1), make_date(p_year, 6, 30));
    perform public.create_operation_cycle(v_id, '하반기', make_date(p_year, 7, 1), make_date(p_year, 12, 31));
  end if;

  if v_include_annual then
    perform public.create_operation_cycle(v_id, '연중', make_date(p_year, 1, 1), make_date(p_year, 12, 31));
  end if;

  return v_id;
end;
$$;

-- ============================================================
-- 3. delete_operation_cycle -- operation_cycle_programs 정리 (§56 버그 수정)
-- ============================================================

create or replace function public.delete_operation_cycle(p_id uuid)
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

  if exists (select 1 from public.operation_terms where operation_cycle_id = p_id) then
    raise exception '이 운영구분에는 이미 등록된 프로그램 운영정보가 있어 삭제할 수 없습니다. 먼저 관련 운영정보를 정리해 주세요.';
  end if;

  delete from public.operation_cycle_programs where operation_cycle_id = p_id;

  delete from public.operation_cycles where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_org, public.current_principal_id(), 'delete_operation_cycle', 'operation_cycle', p_id);
end;
$$;

-- ============================================================
-- 4. 프로그램 제외하기
-- ============================================================

create function public.remove_operation_cycle_program(p_operation_cycle_id uuid, p_program_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_activity_id uuid;
  v_term_id uuid;
  v_has_business_data boolean;
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '프로그램을 제외할 권한이 없습니다.';
  end if;

  if not exists (
    select 1 from public.operation_cycle_programs ocp
    join public.operation_cycles oc on oc.id = ocp.operation_cycle_id
    where ocp.operation_cycle_id = p_operation_cycle_id
      and ocp.program_id = p_program_id
      and oc.organization_id = v_org
  ) then
    raise exception '이 운영구분에 선택된 프로그램이 아닙니다.';
  end if;

  select a.id into v_activity_id
  from public.programs p join public.activities a on a.id = p.activity_id
  where p.id = p_program_id;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램을 제외할 권한이 없습니다.';
  end if;

  select id into v_term_id from public.operation_terms
  where operation_cycle_id = p_operation_cycle_id and program_id = p_program_id;

  if v_term_id is not null then
    select
      exists (select 1 from public.enrollments where operation_term_id = v_term_id)
      or exists (
        select 1 from public.sessions s
        where s.operation_term_id = v_term_id
          and (
            exists (select 1 from public.instructor_attendance_submissions where session_id = s.id)
            or exists (select 1 from public.final_attendance where session_id = s.id)
            or exists (select 1 from public.excused_absences where session_id = s.id)
            or exists (select 1 from public.performance_records where source_session_id = s.id)
          )
      )
    into v_has_business_data;

    if v_has_business_data then
      raise exception '현재 운영구분에 수강 또는 출석 등 운영데이터가 연결되어 있습니다.';
    end if;

    delete from public.sessions where operation_term_id = v_term_id;
    delete from public.operation_terms where id = v_term_id;
  end if;

  delete from public.operation_cycle_programs
  where operation_cycle_id = p_operation_cycle_id and program_id = p_program_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'remove_operation_cycle_program', 'operation_cycle', p_operation_cycle_id,
    jsonb_build_object('program_id', p_program_id));
end;
$$;

-- ============================================================
-- 5. 공휴일 자동 휴강
-- ============================================================

create table public.public_holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null
);

insert into public.public_holidays (holiday_date, name)
select make_date(y, m, d), label
from generate_series(2020, 2035) as y,
  (values (1, 1, '신정'), (3, 1, '삼일절'), (5, 5, '어린이날'), (6, 6, '현충일'),
          (8, 15, '광복절'), (10, 3, '개천절'), (10, 9, '한글날'), (12, 25, '크리스마스')
  ) as h(m, d, label)
on conflict (holiday_date) do nothing;

alter table public.operation_terms
  add column holiday_auto_cancel boolean not null default false;

-- upsert_operation_term_for_cycle: p_holiday_auto_cancel 파라미터를 추가하고,
-- 회차 생성 시 그 날짜가 public_holidays에 있으면 처음부터 status='cancelled'로
-- 만든다(Session 자체는 존재, 처음부터 휴강 -- §25). 그 외 로직(정기 반복/
-- 직접 회차 지정, 변경 시 기존 회차 보호, overlap 차단 등)은 기존과 동일하다.
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
  v_is_holiday boolean;
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
        v_is_holiday := p_holiday_auto_cancel and exists (select 1 from public.public_holidays where holiday_date = v_date);
        insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status, cancelled_at, cancelled_by)
        values (v_org, v_term_id, v_seq, (v_date + p_start_time) at time zone 'Asia/Seoul',
          (v_date + p_end_time) at time zone 'Asia/Seoul',
          case when v_is_holiday then 'cancelled' else 'scheduled' end,
          case when v_is_holiday then now() else null end,
          case when v_is_holiday then public.current_principal_id() else null end);
      end loop;
    else
      for v_date in select distinct d from unnest(p_explicit_dates) as d order by d
      loop
        v_seq := v_seq + 1;
        v_is_holiday := p_holiday_auto_cancel and exists (select 1 from public.public_holidays where holiday_date = v_date);
        insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status, cancelled_at, cancelled_by)
        values (v_org, v_term_id, v_seq, (v_date + p_start_time) at time zone 'Asia/Seoul',
          (v_date + p_end_time) at time zone 'Asia/Seoul',
          case when v_is_holiday then 'cancelled' else 'scheduled' end,
          case when v_is_holiday then now() else null end,
          case when v_is_holiday then public.current_principal_id() else null end);
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
      v_is_holiday := p_holiday_auto_cancel and exists (select 1 from public.public_holidays where holiday_date = v_date);
      insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status, cancelled_at, cancelled_by)
      values (v_org, v_term_id, v_seq, (v_date + p_start_time) at time zone 'Asia/Seoul',
        (v_date + p_end_time) at time zone 'Asia/Seoul',
        case when v_is_holiday then 'cancelled' else 'scheduled' end,
        case when v_is_holiday then now() else null end,
        case when v_is_holiday then public.current_principal_id() else null end);
    end loop;
  else
    for v_date in select distinct d from unnest(p_explicit_dates) as d order by d
    loop
      v_seq := v_seq + 1;
      v_is_holiday := p_holiday_auto_cancel and exists (select 1 from public.public_holidays where holiday_date = v_date);
      insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status, cancelled_at, cancelled_by)
      values (v_org, v_term_id, v_seq, (v_date + p_start_time) at time zone 'Asia/Seoul',
        (v_date + p_end_time) at time zone 'Asia/Seoul',
        case when v_is_holiday then 'cancelled' else 'scheduled' end,
        case when v_is_holiday then now() else null end,
        case when v_is_holiday then public.current_principal_id() else null end);
    end loop;
  end if;

  if v_seq = 0 then
    raise exception '생성될 회차가 없습니다(기간/요일/날짜를 확인해 주세요).';
  end if;

  return query select v_term_id, false, true;
end;
$$;

-- ============================================================
-- 6. 회차 추가 / 회차 수정 (§47-48)
-- ============================================================

create function public.add_session(p_operation_term_id uuid, p_date date, p_start_time time, p_end_time time)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_term record;
  v_activity_id uuid;
  v_session_id uuid;
  v_next_no integer;
  v_is_holiday boolean;
begin
  select ot.id, ot.organization_id, ot.program_id, ot.start_date, ot.end_date, ot.holiday_auto_cancel
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

  v_is_holiday := v_term.holiday_auto_cancel
    and exists (select 1 from public.public_holidays where holiday_date = p_date);

  insert into public.sessions (organization_id, operation_term_id, session_no, starts_at, ends_at, status, cancelled_at, cancelled_by)
  values (
    v_term.organization_id, p_operation_term_id, v_next_no,
    (p_date + p_start_time) at time zone 'Asia/Seoul', (p_date + p_end_time) at time zone 'Asia/Seoul',
    case when v_is_holiday then 'cancelled' else 'scheduled' end,
    case when v_is_holiday then now() else null end,
    case when v_is_holiday then public.current_principal_id() else null end
  )
  returning id into v_session_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_term.organization_id, public.current_principal_id(), 'add_session', 'session', v_session_id);

  return v_session_id;
end;
$$;

create function public.update_session(p_session_id uuid, p_date date, p_start_time time, p_end_time time)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_activity_id uuid;
begin
  select s.id, s.organization_id, s.status, ot.program_id, ot.start_date, ot.end_date
  into v_session
  from public.sessions s
  join public.operation_terms ot on ot.id = s.operation_term_id
  where s.id = p_session_id;

  if v_session.id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  select a.id into v_activity_id
  from public.programs p join public.activities a on a.id = p.activity_id
  where p.id = v_session.program_id;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 회차를 수정할 권한이 없습니다.';
  end if;

  if exists (select 1 from public.final_attendance where session_id = p_session_id)
    or exists (select 1 from public.instructor_attendance_submissions where session_id = p_session_id)
    or exists (select 1 from public.performance_records where source_session_id = p_session_id)
  then
    raise exception '이미 출석 또는 실적 등 업무기록이 연결된 회차입니다.';
  end if;

  if p_date is null or p_date < v_session.start_date or p_date > v_session.end_date then
    raise exception '운영구분 기간(%~%) 안의 날짜만 지정할 수 있습니다.', v_session.start_date, v_session.end_date;
  end if;
  if p_start_time is null or p_end_time is null or p_end_time <= p_start_time then
    raise exception '시작/종료 시간을 확인해 주세요.';
  end if;

  update public.sessions
  set starts_at = (p_date + p_start_time) at time zone 'Asia/Seoul',
      ends_at = (p_date + p_end_time) at time zone 'Asia/Seoul'
  where id = p_session_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_session.organization_id, public.current_principal_id(), 'update_session', 'session', p_session_id);
end;
$$;

-- ============================================================
-- 7. 휴강취소 -- 예정/누락 스마트 복귀 (§42)
-- ============================================================

create or replace function public.uncancel_session(p_session_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_activity_id uuid;
  v_new_status text;
begin
  select s.id, s.organization_id, s.ends_at, s.status, ot.program_id
  into v_session
  from public.sessions s
  join public.operation_terms ot on ot.id = s.operation_term_id
  where s.id = p_session_id;

  if v_session.id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  select a.id into v_activity_id
  from public.programs p join public.activities a on a.id = p.activity_id
  where p.id = v_session.program_id;

  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 회차의 휴강을 취소할 권한이 없습니다.';
  end if;
  if v_session.status <> 'cancelled' then
    raise exception '휴강 상태인 회차만 휴강을 취소할 수 있습니다.';
  end if;
  if exists (select 1 from public.final_attendance where session_id = p_session_id)
    or exists (select 1 from public.instructor_attendance_submissions where session_id = p_session_id)
    or exists (select 1 from public.performance_records where source_session_id = p_session_id)
  then
    raise exception '출석 또는 실적이 연결된 회차는 휴강을 취소할 수 없습니다.';
  end if;

  v_new_status := case when now() >= v_session.ends_at + interval '30 minutes' then 'missing' else 'scheduled' end;

  update public.sessions
  set status = v_new_status, cancelled_at = null, cancelled_by = null
  where id = p_session_id and status = 'cancelled';

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_session.organization_id, public.current_principal_id(), 'uncancel_session', 'session', p_session_id,
    jsonb_build_object('new_status', v_new_status));
end;
$$;
