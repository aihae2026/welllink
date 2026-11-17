-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.2: 출석관리 E2E
-- 사유결석 사전지정 / 강사 PIN 인증 / 강사 원본 출석저장(불변) / 자동 공식확정 /
-- 직원 출석정정 및 누락보완 / 결석누계(파생) / 결석알림(dismiss 분리)
--
-- Batch 0(organizations/principals/staff_profiles/instructor_profiles) +
-- Pipeline 1 / Batch 1.1(사업구조/프로그램/운영차수/회차/수강명단) 위에 순수 추가된다.
-- 기존 테이블/정책/함수는 전혀 건드리지 않는다(ALTER 없음, 신규 CREATE만).

create extension if not exists pgcrypto with schema extensions;

-- ============================================================
-- 1. 공통 helper: operation_term/session -> activity_id
--    (기존 정책들이 반복하던 3-way join을 재사용 가능한 함수로 정리)
-- ============================================================

create function public.activity_id_for_operation_term(p_operation_term_id uuid)
returns uuid
language sql
security definer set search_path = public
stable
as $$
  select a.id
  from public.operation_terms ot
  join public.programs p on p.id = ot.program_id
  join public.activities a on a.id = p.activity_id
  where ot.id = p_operation_term_id;
$$;

create function public.activity_id_for_session(p_session_id uuid)
returns uuid
language sql
security definer set search_path = public
stable
as $$
  select public.activity_id_for_operation_term(s.operation_term_id)
  from public.sessions s
  where s.id = p_session_id;
$$;

-- ============================================================
-- 2. is_run_instructor: Batch 0/1.1에서 보류했던 helper.
--    current_principal_id() -> instructor principal -> operation_term.instructor_principal_id
--    가 일치하고, 같은 organization일 때만 true. is_system_admin이라고 자동으로
--    강사가 되지 않는다(무조건 principals/operation_terms 실제 연결만 본다).
-- ============================================================

create function public.is_run_instructor(p_operation_term_id uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1
    from public.operation_terms ot
    join public.principals p on p.id = ot.instructor_principal_id
    where ot.id = p_operation_term_id
      and p.id = public.current_principal_id()
      and p.principal_type = 'instructor'
      and p.is_active = true
      and ot.organization_id = public.current_organization_id()
  );
$$;

-- ============================================================
-- 3. 출석대상자 계산: Enrollment 효력시점 기준으로 서버에서 계산한다.
--    session.session_no 시점에 활성인 Enrollment만 대상 -- 클라이언트가 보낸
--    명단을 신뢰하지 않고 항상 이 함수로 재계산한다.
-- ============================================================

create function public.session_effective_enrollment_ids(p_session_id uuid)
returns setof uuid
language sql
security definer set search_path = public
stable
as $$
  select e.id
  from public.enrollments e
  join public.sessions s on s.operation_term_id = e.operation_term_id
  where s.id = p_session_id
    and e.start_session_no <= s.session_no
    and (e.end_session_no_exclusive is null or s.session_no < e.end_session_no_exclusive);
$$;

-- ============================================================
-- 4. 사유결석(사전지정) — 상세사유 수집하지 않는다. "어느 회차, 어느 수강생이
--    사전 사유결석인지"만 기록한다.
-- ============================================================

create table public.excused_absences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  session_id uuid not null references public.sessions (id),
  enrollment_id uuid not null references public.enrollments (id),
  created_by uuid references public.principals (id),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);

create unique index excused_absences_active_unique
  on public.excused_absences (session_id, enrollment_id)
  where cancelled_at is null;

create index excused_absences_session_id_idx on public.excused_absences (session_id);
create index excused_absences_enrollment_id_idx on public.excused_absences (enrollment_id);

create function public.set_excused_absence(p_session_id uuid, p_enrollment_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_organization_id uuid;
  v_operation_term_id uuid;
  v_status session_status;
  v_activity_id uuid;
  v_id uuid;
begin
  select s.organization_id, s.operation_term_id, s.status
    into v_organization_id, v_operation_term_id, v_status
  from public.sessions s
  where s.id = p_session_id;

  if v_organization_id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 사유결석을 지정할 권한이 없습니다.';
  end if;

  if v_status <> 'scheduled' then
    raise exception '이미 공식출석이 처리된 회차는 사유결석 사전지정을 사용할 수 없습니다. 직원 출석정정을 이용해 주세요.';
  end if;

  if not exists (
    select 1 from public.session_effective_enrollment_ids(p_session_id) eid where eid = p_enrollment_id
  ) then
    raise exception '해당 회차 시점에 유효한 수강생이 아닙니다.';
  end if;

  select id into v_id from public.excused_absences
  where session_id = p_session_id and enrollment_id = p_enrollment_id and cancelled_at is null;

  if v_id is not null then
    return v_id;
  end if;

  insert into public.excused_absences (organization_id, session_id, enrollment_id, created_by)
  values (v_organization_id, p_session_id, p_enrollment_id, public.current_principal_id())
  returning id into v_id;

  return v_id;
end;
$$;

create function public.cancel_excused_absence(p_session_id uuid, p_enrollment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_operation_term_id uuid;
  v_status session_status;
  v_activity_id uuid;
begin
  select s.operation_term_id, s.status into v_operation_term_id, v_status
  from public.sessions s where s.id = p_session_id;

  if v_operation_term_id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 사유결석을 해제할 권한이 없습니다.';
  end if;

  if v_status <> 'scheduled' then
    raise exception '이미 공식출석이 처리된 회차는 사유결석 사전지정을 사용할 수 없습니다. 직원 출석정정을 이용해 주세요.';
  end if;

  update public.excused_absences
  set cancelled_at = now()
  where session_id = p_session_id and enrollment_id = p_enrollment_id and cancelled_at is null;
end;
$$;

-- ============================================================
-- 5. 강사 원본 출석 저장(Raw) — immutable. 재저장은 새 version을 만든다.
-- ============================================================

create type attendance_mark as enum ('present', 'absent', 'excused');

create table public.instructor_attendance_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  session_id uuid not null references public.sessions (id),
  instructor_principal_id uuid not null references public.principals (id),
  version integer not null,
  submitted_at timestamptz not null default now(),
  idempotency_key text not null,
  unique (session_id, version),
  unique (session_id, idempotency_key)
);

create index instructor_attendance_submissions_session_idx
  on public.instructor_attendance_submissions (session_id);

create table public.instructor_attendance_entries (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.instructor_attendance_submissions (id) on delete cascade,
  enrollment_id uuid not null references public.enrollments (id),
  mark attendance_mark not null,
  unique (submission_id, enrollment_id)
);

create index instructor_attendance_entries_submission_idx
  on public.instructor_attendance_entries (submission_id);
create index instructor_attendance_entries_enrollment_idx
  on public.instructor_attendance_entries (enrollment_id);

-- save_instructor_attendance: 하나의 RPC/transaction. 시작/마감시간, 대상자 완전성,
-- 사유결석 지정상태, △→○ irreversible 규칙, idempotency를 전부 검증한 뒤에만
-- submission + entries 전체를 생성한다(partial save 없음).
create function public.save_instructor_attendance(
  p_session_id uuid,
  p_entries jsonb,
  p_idempotency_key text
)
returns table (submission_id uuid, version integer)
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_instructor_id uuid;
  v_expected uuid[];
  v_payload_ids uuid[] := '{}';
  v_row jsonb;
  v_enrollment_id uuid;
  v_mark text;
  v_is_pre_excused boolean;
  v_was_present_before boolean;
  v_existing_submission_id uuid;
  v_existing_version integer;
  v_new_submission_id uuid;
  v_new_version integer;
begin
  select s.id, s.organization_id, s.operation_term_id, s.starts_at, s.ends_at, s.status
    into v_session
  from public.sessions s
  where s.id = p_session_id;

  if v_session.id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  if not public.is_run_instructor(v_session.operation_term_id) then
    raise exception '이 회차의 출석을 저장할 권한이 없습니다.';
  end if;

  v_instructor_id := public.current_principal_id();

  -- idempotency: 같은 요청 재전송 시 새 version을 만들지 않는다.
  select id, version into v_existing_submission_id, v_existing_version
  from public.instructor_attendance_submissions
  where session_id = p_session_id and idempotency_key = p_idempotency_key;

  if v_existing_submission_id is not null then
    return query select v_existing_submission_id, v_existing_version;
    return;
  end if;

  if v_session.status <> 'scheduled' then
    raise exception '이미 마감되었거나 처리된 회차입니다.';
  end if;

  if now() < v_session.starts_at then
    raise exception '회차 시작 전에는 출석을 저장할 수 없습니다.';
  end if;
  if now() > v_session.ends_at + interval '30 minutes' then
    raise exception '회차 마감시간(종료 + 30분)이 지나 출석을 저장할 수 없습니다.';
  end if;

  select array_agg(eid) into v_expected from public.session_effective_enrollment_ids(p_session_id) eid;
  v_expected := coalesce(v_expected, '{}');

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception '출석 입력 형식이 올바르지 않습니다.';
  end if;

  for v_row in select * from jsonb_array_elements(p_entries)
  loop
    v_enrollment_id := (v_row->>'enrollment_id')::uuid;
    v_mark := v_row->>'mark';

    if v_enrollment_id is null or v_mark is null then
      raise exception '출석 입력에 누락된 값이 있습니다.';
    end if;
    if v_enrollment_id = any (v_payload_ids) then
      raise exception '같은 수강생이 중복 전달되었습니다.';
    end if;
    v_payload_ids := array_append(v_payload_ids, v_enrollment_id);

    if not (v_enrollment_id = any (v_expected)) then
      raise exception '이 회차의 대상자가 아닌 수강생이 포함되어 있습니다.';
    end if;
    if v_mark not in ('present', 'absent', 'excused') then
      raise exception '유효하지 않은 출석값입니다: %', v_mark;
    end if;

    v_is_pre_excused := exists (
      select 1 from public.excused_absences ea
      where ea.session_id = p_session_id and ea.enrollment_id = v_enrollment_id and ea.cancelled_at is null
    );

    if v_is_pre_excused then
      if v_mark not in ('present', 'excused') then
        raise exception '사전 사유결석 대상자는 사유결석(△) 또는 출석(○)만 가능합니다.';
      end if;

      v_was_present_before := exists (
        select 1
        from public.instructor_attendance_entries ie
        join public.instructor_attendance_submissions s2 on s2.id = ie.submission_id
        where s2.session_id = p_session_id and ie.enrollment_id = v_enrollment_id and ie.mark = 'present'
      );

      if v_was_present_before and v_mark <> 'present' then
        raise exception '한 번 출석(○)으로 저장된 사전 사유결석 대상자는 다시 사유결석(△)으로 되돌릴 수 없습니다.';
      end if;
    else
      if v_mark not in ('present', 'absent') then
        raise exception '사전 사유결석이 지정되지 않은 대상자는 출석(○) 또는 결석(×)만 가능합니다.';
      end if;
    end if;
  end loop;

  if array_length(v_payload_ids, 1) is distinct from array_length(v_expected, 1)
     or exists (select 1 from unnest(v_expected) x where not (x = any (v_payload_ids))) then
    raise exception '이 회차의 전체 대상자와 제출된 출석 입력이 일치하지 않습니다.';
  end if;

  select coalesce(max(version), 0) + 1 into v_new_version
  from public.instructor_attendance_submissions
  where session_id = p_session_id;

  insert into public.instructor_attendance_submissions
    (organization_id, session_id, instructor_principal_id, version, idempotency_key)
  values (v_session.organization_id, p_session_id, v_instructor_id, v_new_version, p_idempotency_key)
  returning id into v_new_submission_id;

  for v_row in select * from jsonb_array_elements(p_entries)
  loop
    insert into public.instructor_attendance_entries (submission_id, enrollment_id, mark)
    values (v_new_submission_id, (v_row->>'enrollment_id')::uuid, (v_row->>'mark')::attendance_mark);
  end loop;

  return query select v_new_submission_id, v_new_version;
end;
$$;

-- ============================================================
-- 6. 공식 출석(Source of Truth)
-- ============================================================

create type finalization_method as enum ('auto_latest_submission', 'staff_missing_completion', 'staff_correction');

create table public.final_attendance (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  session_id uuid not null references public.sessions (id),
  enrollment_id uuid not null references public.enrollments (id),
  mark attendance_mark not null,
  source_submission_id uuid references public.instructor_attendance_submissions (id),
  finalized_at timestamptz not null default now(),
  finalization_method finalization_method not null,
  updated_at timestamptz not null default now(),
  unique (session_id, enrollment_id)
);

create index final_attendance_session_idx on public.final_attendance (session_id);
create index final_attendance_enrollment_idx on public.final_attendance (enrollment_id);

create trigger final_attendance_set_updated_at
  before update on public.final_attendance
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- 7. 최소 Audit 기반
-- ============================================================

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  actor_principal_id uuid references public.principals (id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_json jsonb,
  after_json jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index audit_logs_organization_id_idx on public.audit_logs (organization_id);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

-- ============================================================
-- 8. Attendance Correction History (immutable)
-- ============================================================

create table public.attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  final_attendance_id uuid not null references public.final_attendance (id),
  session_id uuid not null references public.sessions (id),
  enrollment_id uuid not null references public.enrollments (id),
  before_mark attendance_mark not null,
  after_mark attendance_mark not null,
  reason text not null,
  corrected_by uuid references public.principals (id),
  corrected_at timestamptz not null default now()
);

create index attendance_corrections_final_attendance_idx
  on public.attendance_corrections (final_attendance_id);

-- ============================================================
-- 9. 자동확정 finalize_due_sessions() — server/scheduled 전용
-- ============================================================

create function public.finalize_due_sessions()
returns table (session_id uuid, result text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_latest_submission_id uuid;
  v_expected uuid[];
begin
  for v_session in
    select s.id, s.organization_id, s.operation_term_id
    from public.sessions s
    where s.status = 'scheduled'
      and now() >= s.ends_at + interval '30 minutes'
    order by s.ends_at
  loop
    begin
      select id into v_latest_submission_id
      from public.instructor_attendance_submissions
      where session_id = v_session.id
      order by version desc
      limit 1;

      if v_latest_submission_id is null then
        update public.sessions set status = 'missing' where id = v_session.id and status = 'scheduled';
        session_id := v_session.id;
        result := 'missing';
        return next;
      else
        insert into public.final_attendance
          (organization_id, session_id, enrollment_id, mark, source_submission_id, finalization_method)
        select v_session.organization_id, v_session.id, ie.enrollment_id, ie.mark, v_latest_submission_id, 'auto_latest_submission'
        from public.instructor_attendance_entries ie
        where ie.submission_id = v_latest_submission_id
        on conflict (session_id, enrollment_id) do nothing;

        update public.sessions
        set status = 'completed', finalized_at = now()
        where id = v_session.id and status = 'scheduled';

        session_id := v_session.id;
        result := 'finalized';
        return next;
      end if;
    exception when others then
      session_id := v_session.id;
      result := 'error: ' || sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

revoke execute on function public.finalize_due_sessions() from public, anon, authenticated;
grant execute on function public.finalize_due_sessions() to service_role;

-- ============================================================
-- 10. 직원 누락보완 / 출석정정
-- ============================================================

create function public.complete_missing_session(
  p_session_id uuid,
  p_entries jsonb,
  p_reason text
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_activity_id uuid;
  v_expected uuid[];
  v_payload_ids uuid[] := '{}';
  v_row jsonb;
  v_enrollment_id uuid;
  v_mark text;
  v_count integer := 0;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception '보완 사유를 입력해 주세요.';
  end if;

  select s.id, s.organization_id, s.operation_term_id, s.status into v_session
  from public.sessions s where s.id = p_session_id;

  if v_session.id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_session.operation_term_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 회차를 보완할 권한이 없습니다.';
  end if;

  if v_session.status <> 'missing' then
    raise exception '누락 상태인 회차만 보완할 수 있습니다.';
  end if;

  select array_agg(eid) into v_expected from public.session_effective_enrollment_ids(p_session_id) eid;
  v_expected := coalesce(v_expected, '{}');

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception '출석 입력 형식이 올바르지 않습니다.';
  end if;

  for v_row in select * from jsonb_array_elements(p_entries)
  loop
    v_enrollment_id := (v_row->>'enrollment_id')::uuid;
    v_mark := v_row->>'mark';
    if v_enrollment_id is null or v_mark is null then
      raise exception '출석 입력에 누락된 값이 있습니다.';
    end if;
    if v_enrollment_id = any (v_payload_ids) then
      raise exception '같은 수강생이 중복 전달되었습니다.';
    end if;
    v_payload_ids := array_append(v_payload_ids, v_enrollment_id);
    if not (v_enrollment_id = any (v_expected)) then
      raise exception '이 회차의 대상자가 아닌 수강생이 포함되어 있습니다.';
    end if;
    if v_mark not in ('present', 'absent', 'excused') then
      raise exception '유효하지 않은 출석값입니다: %', v_mark;
    end if;
  end loop;

  if array_length(v_payload_ids, 1) is distinct from array_length(v_expected, 1)
     or exists (select 1 from unnest(v_expected) x where not (x = any (v_payload_ids))) then
    raise exception '이 회차의 전체 대상자와 제출된 출석 입력이 일치하지 않습니다.';
  end if;

  insert into public.final_attendance
    (organization_id, session_id, enrollment_id, mark, source_submission_id, finalization_method)
  select v_session.organization_id, p_session_id, (e->>'enrollment_id')::uuid, (e->>'mark')::attendance_mark,
         null, 'staff_missing_completion'
  from jsonb_array_elements(p_entries) e
  on conflict (session_id, enrollment_id) do nothing;

  get diagnostics v_count = row_count;

  update public.sessions set status = 'completed', finalized_at = now()
  where id = p_session_id and status = 'missing';

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json, reason)
  values (v_session.organization_id, public.current_principal_id(), 'complete_missing_session', 'session', p_session_id, p_entries, p_reason);

  return v_count;
end;
$$;

create function public.correct_final_attendance(
  p_final_attendance_id uuid,
  p_after_mark attendance_mark,
  p_reason text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_final record;
  v_activity_id uuid;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception '정정 사유를 입력해 주세요.';
  end if;

  select fa.id, fa.organization_id, fa.session_id, fa.enrollment_id, fa.mark
    into v_final
  from public.final_attendance fa
  where fa.id = p_final_attendance_id;

  if v_final.id is null then
    raise exception '공식 출석 기록을 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_session(v_final.session_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 출석을 정정할 권한이 없습니다.';
  end if;

  if v_final.mark = p_after_mark then
    raise exception '기존 값과 동일한 값으로는 정정할 수 없습니다.';
  end if;

  update public.final_attendance
  set mark = p_after_mark, finalization_method = 'staff_correction', updated_at = now()
  where id = p_final_attendance_id;

  insert into public.attendance_corrections
    (organization_id, final_attendance_id, session_id, enrollment_id, before_mark, after_mark, reason, corrected_by)
  values
    (v_final.organization_id, p_final_attendance_id, v_final.session_id, v_final.enrollment_id, v_final.mark, p_after_mark, p_reason, public.current_principal_id());

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json, reason)
  values (v_final.organization_id, public.current_principal_id(), 'correct_final_attendance', 'final_attendance', p_final_attendance_id,
          jsonb_build_object('mark', v_final.mark), jsonb_build_object('mark', p_after_mark), p_reason);
end;
$$;

-- ============================================================
-- 11. 결석알림 dismiss 대상 테이블 (파생 view가 이 테이블을 참조하므로 view보다 먼저 생성)
-- ============================================================

create table public.absence_alert_dismissals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  enrollment_id uuid not null references public.enrollments (id),
  dismissed_at timestamptz not null default now(),
  dismissed_unexcused_count integer not null,
  dismissed_excused_count integer not null,
  dismissed_by uuid references public.principals (id)
);

create index absence_alert_dismissals_enrollment_idx on public.absence_alert_dismissals (enrollment_id);

-- ============================================================
-- 12. 결석누계(파생) — final_attendance만 기준. 저장된 집계 테이블을 두지 않고
--     매 조회시 계산해서 정정 직후에도 별도 재계산 없이 항상 일치하게 한다.
-- ============================================================

create view public.v_enrollment_absence_state as
select
  e.id as enrollment_id,
  e.operation_term_id,
  e.participant_id,
  coalesce(fc.unexcused_count, 0)::integer as unexcused_count,
  coalesce(fc.excused_count, 0)::integer as excused_count,
  coalesce(fc.unexcused_count, 0) = 1 as unexcused_near,
  coalesce(fc.unexcused_count, 0) >= 2 as unexcused_reached,
  coalesce(fc.excused_count, 0) = 4 as excused_near,
  coalesce(fc.excused_count, 0) >= 5 as excused_reached,
  dm.id as dismissal_id,
  dm.dismissed_at,
  dm.dismissed_unexcused_count,
  dm.dismissed_excused_count,
  (
    (coalesce(fc.unexcused_count, 0) >= 1 or coalesce(fc.excused_count, 0) >= 4)
    and (
      dm.id is null
      or coalesce(fc.unexcused_count, 0) > dm.dismissed_unexcused_count
      or coalesce(fc.excused_count, 0) > dm.dismissed_excused_count
    )
  ) as alert_active
from public.enrollments e
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

create function public.dismiss_absence_alert(p_enrollment_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_organization_id uuid;
  v_operation_term_id uuid;
  v_activity_id uuid;
  v_unexcused integer;
  v_excused integer;
  v_id uuid;
begin
  select e.organization_id, e.operation_term_id into v_organization_id, v_operation_term_id
  from public.enrollments e where e.id = p_enrollment_id;

  if v_organization_id is null then
    raise exception '수강 기록을 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 결석알림을 해제할 권한이 없습니다.';
  end if;

  select unexcused_count, excused_count into v_unexcused, v_excused
  from public.v_enrollment_absence_state where enrollment_id = p_enrollment_id;

  insert into public.absence_alert_dismissals
    (organization_id, enrollment_id, dismissed_unexcused_count, dismissed_excused_count, dismissed_by)
  values (v_organization_id, p_enrollment_id, coalesce(v_unexcused, 0), coalesce(v_excused, 0), public.current_principal_id())
  returning id into v_id;

  return v_id;
end;
$$;

-- 알림 다시 켜기: 결석누계를 바꾸지 않는다. dismissal 상태만 제거한다.
-- 이후 새로운 결석이 없어도 즉시 근접/도달 상태 그대로 다시 alert_active가 된다.
create function public.reactivate_absence_alert(p_enrollment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_operation_term_id uuid;
  v_activity_id uuid;
begin
  select e.operation_term_id into v_operation_term_id
  from public.enrollments e where e.id = p_enrollment_id;

  if v_operation_term_id is null then
    raise exception '수강 기록을 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 결석알림을 재활성화할 권한이 없습니다.';
  end if;

  delete from public.absence_alert_dismissals where enrollment_id = p_enrollment_id;
end;
$$;

-- ============================================================
-- 13. 출석입력 화면용 조회 RPC (강사 + 직원 공용, 서버에서 계산한 실제 대상자만)
-- ============================================================

create function public.get_session_attendance_roster(p_session_id uuid)
returns table (
  enrollment_id uuid,
  participant_id uuid,
  member_code text,
  name text,
  is_pre_excused boolean,
  latest_instructor_mark attendance_mark,
  final_mark attendance_mark,
  final_attendance_id uuid
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_operation_term_id uuid;
  v_activity_id uuid;
begin
  select s.operation_term_id into v_operation_term_id from public.sessions s where s.id = p_session_id;
  if v_operation_term_id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  v_activity_id := public.activity_id_for_operation_term(v_operation_term_id);
  if not (public.is_run_instructor(v_operation_term_id) or public.can_read_activity(v_activity_id)) then
    raise exception '이 회차의 출석정보를 조회할 권한이 없습니다.';
  end if;

  return query
  select
    e.id,
    e.participant_id,
    pt.member_code,
    pt.name,
    exists (
      select 1 from public.excused_absences ea
      where ea.session_id = p_session_id and ea.enrollment_id = e.id and ea.cancelled_at is null
    ),
    (
      select ie.mark
      from public.instructor_attendance_entries ie
      join public.instructor_attendance_submissions sub on sub.id = ie.submission_id
      where sub.session_id = p_session_id and ie.enrollment_id = e.id
      order by sub.version desc
      limit 1
    ),
    fa.mark,
    fa.id
  from public.session_effective_enrollment_ids(p_session_id) eid
  join public.enrollments e on e.id = eid
  join public.participants pt on pt.id = e.participant_id
  left join public.final_attendance fa on fa.session_id = p_session_id and fa.enrollment_id = e.id;
end;
$$;

-- ============================================================
-- 14. 강사 인증: PIN 검증(service_role 전용) + Provisioning
-- ============================================================

-- 강사 계정 생성. 반드시 system_admin만, 같은 조직에만. Supabase Auth 계정(auth_user_id)은
-- server route가 Admin API로 먼저 만든 뒤 이 RPC에 전달한다(SQL에서 auth.users를
-- 직접 만들지 않는다 -- 공식 Admin API만 사용).
create function public.provision_instructor(
  p_organization_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_phone_last4 text,
  p_pin text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
begin
  if not public.is_system_admin() then
    raise exception '강사 계정을 생성할 권한이 없습니다.';
  end if;
  if p_organization_id is distinct from public.current_organization_id() then
    raise exception '다른 조직에 강사 계정을 생성할 수 없습니다.';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception '이름을 입력해 주세요.';
  end if;
  if p_phone_last4 !~ '^[0-9]{4}$' then
    raise exception '휴대전화 뒤 4자리 형식이 올바르지 않습니다.';
  end if;
  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN은 6자리 숫자여야 합니다.';
  end if;

  -- 이미 같은 auth_user_id로 provisioning된 적이 있으면(server route 재시도)
  -- 중복 생성하지 않고 기존 principal을 그대로 반환한다.
  select id into v_principal_id from public.principals where auth_user_id = p_auth_user_id;
  if v_principal_id is not null then
    return v_principal_id;
  end if;

  insert into public.principals (organization_id, auth_user_id, principal_type, name)
  values (p_organization_id, p_auth_user_id, 'instructor', trim(p_name))
  returning id into v_principal_id;

  insert into public.instructor_profiles (principal_id, organization_id, phone_last4, pin_hash)
  values (v_principal_id, p_organization_id, p_phone_last4, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)));

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (p_organization_id, public.current_principal_id(), 'provision_instructor', 'principal', v_principal_id,
          jsonb_build_object('name', p_name));

  return v_principal_id;
end;
$$;

-- 강사 로그인 PIN 검증. 로그인 전(세션 없음) 상태에서 호출되므로 일반 client가
-- 절대 직접 호출할 수 없게 service_role 전용으로 제한한다. 성공/실패 사유(이름/
-- 뒤4자리/PIN 중 무엇이 틀렸는지)를 구분해서 알려주지 않는다 -- 계정탐색 방지.
create function public.verify_instructor_login(
  p_name text,
  p_phone_last4 text,
  p_pin text
)
returns table (principal_id uuid, auth_user_id uuid, organization_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
  v_pin_hash text;
  v_failed_count integer;
  v_locked_until timestamptz;
  v_ok boolean;
begin
  select p.id, p.auth_user_id, p.organization_id, ip.pin_hash, ip.pin_failed_count, ip.pin_locked_until
    into v_principal_id, v_auth_user_id, v_organization_id, v_pin_hash, v_failed_count, v_locked_until
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4
  for update of ip;

  if v_principal_id is null then
    return;
  end if;

  if v_locked_until is not null and v_locked_until > now() then
    raise exception 'LOCKED';
  end if;

  v_ok := v_pin_hash is not null and extensions.crypt(p_pin, v_pin_hash) = v_pin_hash;

  if v_ok then
    update public.instructor_profiles
    set pin_failed_count = 0, pin_locked_until = null
    where principal_id = v_principal_id;

    return query select v_principal_id, v_auth_user_id, v_organization_id;
  else
    update public.instructor_profiles
    set pin_failed_count = pin_failed_count + 1,
        pin_locked_until = case when pin_failed_count + 1 >= 5 then now() + interval '15 minutes' else pin_locked_until end
    where principal_id = v_principal_id;

    return;
  end if;
end;
$$;

revoke execute on function public.verify_instructor_login(text, text, text) from public, anon, authenticated;
grant execute on function public.verify_instructor_login(text, text, text) to service_role;

-- ============================================================
-- 15. RLS
-- ============================================================

alter table public.excused_absences enable row level security;
alter table public.instructor_attendance_submissions enable row level security;
alter table public.instructor_attendance_entries enable row level security;
alter table public.final_attendance enable row level security;
alter table public.attendance_corrections enable row level security;
alter table public.audit_logs enable row level security;
alter table public.absence_alert_dismissals enable row level security;

create policy "권한자 사유결석 조회" on public.excused_absences for select
  using (
    public.can_read_activity(public.activity_id_for_session(session_id))
    or public.is_run_instructor((select s.operation_term_id from public.sessions s where s.id = session_id))
  );

create policy "본인 또는 권한자 submission 조회" on public.instructor_attendance_submissions for select
  using (
    instructor_principal_id = public.current_principal_id()
    or public.can_read_activity(public.activity_id_for_session(session_id))
  );

create policy "본인 또는 권한자 entry 조회" on public.instructor_attendance_entries for select
  using (
    exists (
      select 1 from public.instructor_attendance_submissions sub
      where sub.id = submission_id
        and (
          sub.instructor_principal_id = public.current_principal_id()
          or public.can_read_activity(public.activity_id_for_session(sub.session_id))
        )
    )
  );

create policy "권한자 공식출석 조회" on public.final_attendance for select
  using (public.can_read_activity(public.activity_id_for_session(session_id)));

create policy "권한자 출석정정이력 조회" on public.attendance_corrections for select
  using (public.can_read_activity(public.activity_id_for_session(session_id)));

create policy "관리자 audit 조회" on public.audit_logs for select
  using (
    organization_id = public.current_organization_id()
    and (public.current_business_role() = 'global_manager' or public.is_system_admin())
  );

create policy "권한자 결석알림해제 조회" on public.absence_alert_dismissals for select
  using (
    exists (
      select 1 from public.enrollments e
      where e.id = enrollment_id and public.can_read_activity(public.activity_id_for_operation_term(e.operation_term_id))
    )
  );

-- 강사가 자기 담당 세션의 유효 enrollment/participant 최소정보를 볼 수 있게 하는
-- 추가 정책. 기존 Batch 1.1 정책(staff 기준)은 건드리지 않고 새 정책을 더한다
-- (permissive 정책은 OR로 합쳐진다).
create policy "강사 담당 회차 운영차수 조회" on public.operation_terms for select
  using (public.is_run_instructor(id));

create policy "강사 담당 회차 조회" on public.sessions for select
  using (public.is_run_instructor(operation_term_id));

create policy "강사 담당 세션 유효 enrollment 조회" on public.enrollments for select
  using (public.is_run_instructor(operation_term_id));

create policy "강사 담당 대상자 최소정보 조회" on public.participants for select
  using (
    exists (
      select 1 from public.enrollments e
      where e.participant_id = participants.id and public.is_run_instructor(e.operation_term_id)
    )
  );
