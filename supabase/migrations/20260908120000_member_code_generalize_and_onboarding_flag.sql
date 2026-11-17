-- Manual QA Gap Fix — Initial Setup & Program Onboarding
--
-- §25: 회원번호를 YYYY-##### 강제 형식에서 "기관에서 사용하는 내부 회원 식별값"으로
-- 완화한다. forward-only: 기존 값/ID/FK는 전혀 건드리지 않는다 -- 기존에 저장된
-- "YYYY-#####" 값들은 새 제약(빈 값 아님 + 길이 제한)을 그대로 만족하므로 무변경.
--
-- §2: "기본 운영 설정" 초기설정 완료 판정을 위해, organizations에 DB default가
-- 아니라 "출결관리 설정을 실제로 저장한 시각"을 기록하는 최소 컬럼을 추가한다
-- (attendance_enabled 등은 이미 default true라서, 컬럼 값만으로는 사용자가
-- 명시적으로 저장했는지 판별할 수 없었다).

alter table public.organizations
  add column attendance_settings_saved_at timestamptz;

-- 이 migration 이전부터 이미 존재하던 기관은(실제 운영 중인 기관 포함) 이미
-- 초기설정을 마친 상태로 간주한다 -- 그렇지 않으면 이 컬럼이 전부 NULL로
-- 채워지는 순간, 이미 정상 운영 중이던 관리자가 로그인할 때마다 갑자기
-- "기본 운영 설정 미완료"로 판정되어 Home 대신 운영설정으로 리다이렉트되는
-- 회귀가 생긴다(신규 가입 흐름이 아니라 기존 사용자 흐름을 깨는 것을 방지하는
-- 목적의 one-time backfill이며, attendance_enabled 등 실제 설정값은 전혀
-- 건드리지 않는다 -- 이 새 bookkeeping 컬럼만 채운다). 이 migration 적용 이후
-- 새로 생성되는 기관은 여전히 NULL로 시작해 정상적으로 명시적 저장을 거친다.
update public.organizations
set attendance_settings_saved_at = now()
where attendance_settings_saved_at is null;

alter table public.participants
  drop constraint participants_member_code_format,
  add constraint participants_member_code_format
    check (trim(member_code) <> '' and char_length(member_code) <= 40);

create or replace function public.update_attendance_settings(
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
      excused_absence_threshold = p_excused_absence_threshold,
      attendance_settings_saved_at = now()
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

-- apply_initial_roster / add_enrollments: member_code 정규화를
-- "숫자만 남기고 YYYY-##### 9자리로 강제 변환"에서 "trim만 하고 그대로 저장"으로
-- 바꾼다. 숫자/문자/하이픈 모두 허용, 앞자리 0 보존, 임의 하이픈 추가/제거 없음.
create or replace function public.apply_initial_roster(
  p_operation_term_id uuid,
  p_rows jsonb,
  p_idempotency_key text
)
returns table (participant_count integer, enrollment_count integer)
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_id uuid;
  v_organization_id uuid;
  v_already_applied timestamptz;
  v_row jsonb;
  v_member_code text;
  v_name text;
  v_participant_id uuid;
  v_participant_count integer := 0;
  v_enrollment_count integer := 0;
  v_seen_codes text[] := '{}';
begin
  select a.id, ot.organization_id, ot.initial_roster_applied_at
  into v_activity_id, v_organization_id, v_already_applied
  from public.operation_terms ot
  join public.programs p on p.id = ot.program_id
  join public.activities a on a.id = p.activity_id
  where ot.id = p_operation_term_id;

  if v_activity_id is null then
    raise exception '운영차수를 찾을 수 없습니다.';
  end if;

  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 운영차수의 수강명단을 등록할 권한이 없습니다.';
  end if;

  if exists (
    select 1 from public.roster_imports
    where operation_term_id = p_operation_term_id and idempotency_key = p_idempotency_key
  ) then
    select count(*) into v_enrollment_count from public.enrollments where operation_term_id = p_operation_term_id;
    return query select v_enrollment_count, v_enrollment_count;
    return;
  end if;

  if v_already_applied is not null then
    raise exception '이 운영차수는 이미 최초 수강명단이 등록되어 재적용할 수 없습니다.';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_member_code := trim(coalesce(v_row->>'member_code', ''));
    v_name := trim(coalesce(v_row->>'name', ''));

    if v_member_code = '' then
      raise exception '회원번호가 비어 있는 행이 있습니다.';
    end if;
    if char_length(v_member_code) > 40 then
      raise exception '회원번호가 너무 깁니다: %', v_member_code;
    end if;

    if v_name = '' then
      raise exception '회원번호 %의 성명이 비어 있습니다.', v_member_code;
    end if;

    if v_member_code = any (v_seen_codes) then
      raise exception '같은 파일 안에 회원번호가 중복되었습니다: %', v_member_code;
    end if;
    v_seen_codes := array_append(v_seen_codes, v_member_code);
  end loop;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_member_code := trim(coalesce(v_row->>'member_code', ''));
    v_name := trim(v_row->>'name');

    insert into public.participants (organization_id, member_code, name)
    values (v_organization_id, v_member_code, v_name)
    on conflict (organization_id, member_code) do update set name = excluded.name
    returning id into v_participant_id;
    v_participant_count := v_participant_count + 1;

    insert into public.enrollments (organization_id, operation_term_id, participant_id, start_session_no, created_by)
    values (v_organization_id, p_operation_term_id, v_participant_id, 1, public.current_principal_id());
    v_enrollment_count := v_enrollment_count + 1;
  end loop;

  update public.operation_terms set initial_roster_applied_at = now() where id = p_operation_term_id;

  insert into public.roster_imports (organization_id, operation_term_id, idempotency_key, row_count, imported_by)
  values (v_organization_id, p_operation_term_id, p_idempotency_key, v_participant_count, public.current_principal_id());

  return query select v_participant_count, v_enrollment_count;
end;
$$;

create or replace function public.add_enrollments(p_operation_term_id uuid, p_participants jsonb)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_id uuid;
  v_organization_id uuid;
  v_row jsonb;
  v_member_code text;
  v_name text;
  v_participant_id uuid;
  v_next_session_no integer;
  v_added integer := 0;
begin
  select a.id, ot.organization_id into v_activity_id, v_organization_id
  from public.operation_terms ot
  join public.programs p on p.id = ot.program_id
  join public.activities a on a.id = p.activity_id
  where ot.id = p_operation_term_id;

  if v_activity_id is null then
    raise exception '운영차수를 찾을 수 없습니다.';
  end if;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 운영차수에 수강생을 추가할 권한이 없습니다.';
  end if;

  select min(session_no) into v_next_session_no
  from public.sessions
  where operation_term_id = p_operation_term_id and status = 'scheduled' and starts_at > now();

  if v_next_session_no is null then
    raise exception '추가할 수 있는 예정 회차가 없습니다.';
  end if;

  for v_row in select * from jsonb_array_elements(p_participants)
  loop
    v_member_code := trim(coalesce(v_row->>'member_code', ''));
    if v_member_code = '' then
      raise exception '회원번호가 비어 있습니다.';
    end if;
    if char_length(v_member_code) > 40 then
      raise exception '회원번호가 너무 깁니다: %', v_member_code;
    end if;
    v_name := trim(v_row->>'name');

    select id into v_participant_id from public.participants
    where organization_id = v_organization_id and member_code = v_member_code;

    if v_participant_id is null then
      if coalesce(v_name, '') = '' then
        raise exception '신규 회원번호 %는 성명이 필요합니다.', v_member_code;
      end if;
      insert into public.participants (organization_id, member_code, name)
      values (v_organization_id, v_member_code, v_name)
      returning id into v_participant_id;
    end if;

    if exists (
      select 1 from public.enrollments
      where operation_term_id = p_operation_term_id
        and participant_id = v_participant_id
        and end_session_no_exclusive is null
    ) then
      raise exception '회원번호 %는 이미 이 운영차수에 수강 중입니다.', v_member_code;
    end if;

    insert into public.enrollments (organization_id, operation_term_id, participant_id, start_session_no, created_by)
    values (v_organization_id, p_operation_term_id, v_participant_id, v_next_session_no, public.current_principal_id());
    v_added := v_added + 1;
  end loop;

  return v_added;
end;
$$;
