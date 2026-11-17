-- 강사 출석 입력: 사전 신고결석(사유결석) 대상자를 출석(○) <-> 신고결석(△)으로 자유롭게
-- 오갈 수 있게 한다.
--
-- 이전(20260906091500)에는 "한 번 출석(○)으로 저장된 사전 사유결석 대상자는 다시
-- 사유결석(△)으로 되돌릴 수 없다"를 서버가 강제했다. 강사 화면이 이름을 누를 때마다
-- 자동저장하므로, 주황 칸을 한 번 잘못 누르기만 해도 그 회차에서는 영구히 출석으로
-- 굳어 버렸다(2026-09-10 제품 결정으로 되돌리기 허용).
--
-- 바뀌는 것은 그 되돌리기 금지 검사 하나뿐이다. 나머지 제한은 그대로다:
--   * △는 직원이 미리 등록한(취소되지 않은) 사전 사유결석 대상자에게만 허용
--   * 사전 사유결석 대상자는 ○/△만 가능(× 불가), 그 외 대상자는 ○/×만 가능
--   * 시작 전/마감(종료 + 30분) 후/이미 처리된 회차는 저장 불가, 대상자 완전성 검사,
--     idempotency_key 재시도, append-only version 이력
--
-- create or replace(시그니처·반환형 동일)라 기존 실행 권한은 그대로 유지된다.

create or replace function public.save_instructor_attendance(
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
