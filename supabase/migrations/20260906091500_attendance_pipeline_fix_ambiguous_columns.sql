-- 웰링크(WellLink) v1.0 Pipeline 1 / Batch 1.2: 함수 내 컬럼명 모호성(ambiguous column) 수정.
--
-- verify_instructor_login / save_instructor_attendance는 `returns table(...)`의 OUT
-- 파라미터 이름(principal_id, version)이 실제 테이블 컬럼명과 같아서, PL/pgSQL이
-- 자동으로 만드는 동명 변수와 본문 안의 bare column reference가 충돌해
-- "column reference ... is ambiguous" 오류가 발생했다(RPC 테스트 중 실제 발견).
-- forward-only migration으로 두 함수만 재정의한다.

drop function if exists public.verify_instructor_login(text, text, text);

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
    where instructor_profiles.principal_id = v_principal_id;

    return query select v_principal_id, v_auth_user_id, v_organization_id;
  else
    update public.instructor_profiles
    set pin_failed_count = pin_failed_count + 1,
        pin_locked_until = case when pin_failed_count + 1 >= 5 then now() + interval '15 minutes' else pin_locked_until end
    where instructor_profiles.principal_id = v_principal_id;

    return;
  end if;
end;
$$;

revoke execute on function public.verify_instructor_login(text, text, text) from public, anon, authenticated;
grant execute on function public.verify_instructor_login(text, text, text) to service_role;

drop function if exists public.save_instructor_attendance(uuid, jsonb, text);

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

  select instructor_attendance_submissions.id, instructor_attendance_submissions.version
    into v_existing_submission_id, v_existing_version
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

  select coalesce(max(instructor_attendance_submissions.version), 0) + 1 into v_new_version
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
