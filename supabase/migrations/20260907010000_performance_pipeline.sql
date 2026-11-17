-- 웰링크(WellLink) v1.0 Pipeline 2 / Batch 2.1: 공식 사업실적 E2E
-- 출석연동 실적(final_attendance 기반 자동생성) + 직접등록 실적(건/실인원/연인원 직접입력)
-- + 연간계획 직접입력 + 실적보고 서버 aggregate.
--
-- 문서 우선순위(Scope Lock v2 > Design Lock > 상세개발기준서)에 따라, 공식 실적방식은
-- 정확히 2종(출석연동/직접등록)이다. 직접등록(명단)은 본선에서 완전히 제외한다
-- (Scope Lock v2 §5.1, §8). Batch 1.1에서 이미 이를 예견해 만든 performance_method
-- enum('attendance','summary')에는 애초에 'roster' 값 자체가 없다 -- 그 enum을 그대로
-- 재사용해 스키마 레벨에서 재도입을 원천 차단한다.
--
-- metric은 정확히 건(count) / 실인원(unique_people) / 연인원(total_people) 3개이며
-- Scope Lock v2 §5.1/§5.3, 상세개발기준서 §8.1의 performance_records 정의, 현재 Lovable
-- UI(performance-mock.ts/management-mock.ts)에서 일관되게 사용하는 필드와 동일하다.
-- 임의로 새 metric을 추정하지 않았다.

-- ============================================================
-- 1. performance_records: 공식실적 Source of Truth
-- ============================================================

create type performance_status as enum ('active', 'cancelled');

create table public.performance_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  business_year_id uuid not null references public.business_years (id),
  activity_id uuid not null references public.activities (id),
  operation_term_id uuid references public.operation_terms (id),
  method performance_method not null,
  operation_date date not null,
  activity_content text,
  count_value integer not null,
  unique_people_value integer not null,
  total_people_value integer not null,
  status performance_status not null default 'active',
  source_session_id uuid unique references public.sessions (id),
  created_by uuid references public.principals (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.principals (id),
  cancel_reason text,
  constraint performance_records_values_non_negative check (
    count_value >= 0 and unique_people_value >= 0 and total_people_value >= 0
  ),
  constraint performance_records_unique_le_total check (unique_people_value <= total_people_value),
  -- 출석연동 record는 반드시 원본 Session을 가리키고, activity_content(장문 활동내용)를
  -- 직접 입력하지 않는다(Design Lock §28: "출석연동에는 활동내용 직접입력을 두지 않는다").
  -- 직접등록 record는 source_session_id가 없다.
  constraint performance_records_method_source_consistency check (
    (method = 'attendance' and source_session_id is not null and activity_content is null)
    or (method = 'summary' and source_session_id is null)
  ),
  constraint performance_records_cancel_consistency check (
    (status = 'active' and cancelled_at is null and cancelled_by is null and cancel_reason is null)
    or (status = 'cancelled' and cancelled_at is not null and cancel_reason is not null)
  )
);

create index performance_records_organization_id_idx on public.performance_records (organization_id);
create index performance_records_activity_id_idx on public.performance_records (activity_id);
create index performance_records_operation_date_idx on public.performance_records (operation_date);
create index performance_records_business_year_id_idx on public.performance_records (business_year_id);

create trigger performance_records_set_updated_at
  before update on public.performance_records
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- 2. annual_plans: 연간계획 직접입력 (문서 파싱/AI 추출 없음)
-- ============================================================

create table public.annual_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  business_year_id uuid not null references public.business_years (id),
  activity_id uuid not null references public.activities (id),
  count_target integer,
  count_basis text,
  unique_target integer,
  unique_basis text,
  total_target integer,
  total_basis text,
  updated_by uuid references public.principals (id),
  updated_at timestamptz not null default now(),
  unique (business_year_id, activity_id),
  constraint annual_plans_values_non_negative check (
    (count_target is null or count_target >= 0)
    and (unique_target is null or unique_target >= 0)
    and (total_target is null or total_target >= 0)
  )
);

create index annual_plans_organization_id_idx on public.annual_plans (organization_id);

create trigger annual_plans_set_updated_at
  before update on public.annual_plans
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- 3. 출석연동 실적 재계산 (내부 함수 -- finalize/missing-completion/correction 내부에서만 호출)
-- ============================================================

-- 회차 하나의 출석연동 실적을 재계산해 upsert한다. 건=1(완료된 이 회차),
-- 실인원=연인원=이 회차에서 present로 확정된 인원수(단일 회차 안에서는 중복이 있을 수
-- 없으므로 실인원과 연인원이 항상 같다 -- Run 단위 중복제거는 이 record들을 여러 개
-- 합산하는 보고서 집계(get_activity_metrics) 단계에서 수행한다, 상세개발기준서 §8.5.1/§8.5.5).
create function public.recompute_attendance_performance_for_session(p_session_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_activity_id uuid;
  v_business_year_id uuid;
  v_present_count integer;
begin
  select s.id, s.organization_id, s.operation_term_id, s.status, s.starts_at::date as operation_date
    into v_session
  from public.sessions s
  where s.id = p_session_id;

  if v_session.id is null then
    raise exception '회차를 찾을 수 없습니다.';
  end if;

  select a.id, ot.business_year_id into v_activity_id, v_business_year_id
  from public.operation_terms ot
  join public.programs p on p.id = ot.program_id
  join public.activities a on a.id = p.activity_id
  where ot.id = v_session.operation_term_id;

  if v_session.status <> 'completed' then
    -- missing/scheduled/cancelled 회차는 공식실적이 없다. 이미 생성된 record가 있다면
    -- (예: 정정으로 completed에서 다시 벗어나는 경우는 현재 업무규칙상 없지만 방어적으로)
    -- 제거한다 -- 출석연동 record는 절대 취소 상태로 남기지 않고 물리 삭제한다(직접등록만
    -- soft-cancel 대상이다. 존재 자체가 completed 회차와 1:1이어야 하므로).
    delete from public.performance_records where source_session_id = p_session_id;
    return;
  end if;

  select count(*)::int into v_present_count
  from public.final_attendance fa
  where fa.session_id = p_session_id and fa.mark = 'present';

  insert into public.performance_records (
    organization_id, business_year_id, activity_id, operation_term_id, method,
    operation_date, activity_content, count_value, unique_people_value, total_people_value,
    status, source_session_id
  )
  values (
    v_session.organization_id, v_business_year_id, v_activity_id, v_session.operation_term_id, 'attendance',
    v_session.operation_date, null, 1, v_present_count, v_present_count,
    'active', p_session_id
  )
  on conflict (source_session_id) do update set
    count_value = excluded.count_value,
    unique_people_value = excluded.unique_people_value,
    total_people_value = excluded.total_people_value,
    operation_date = excluded.operation_date,
    updated_at = now();
end;
$$;

revoke execute on function public.recompute_attendance_performance_for_session(uuid) from public, anon, authenticated;

-- ============================================================
-- 4. finalize_due_sessions / complete_missing_session / correct_final_attendance 확장
--    -- 기존 함수를 drop+recreate하여 같은 transaction 안에서 실적 재계산까지 처리한다.
-- ============================================================

drop function if exists public.finalize_due_sessions();

create function public.finalize_due_sessions()
returns table (out_session_id uuid, out_result text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_latest_submission_id uuid;
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
        out_session_id := v_session.id;
        out_result := 'missing';
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

        perform public.recompute_attendance_performance_for_session(v_session.id);

        out_session_id := v_session.id;
        out_result := 'finalized';
        return next;
      end if;
    exception when others then
      out_session_id := v_session.id;
      out_result := 'error: ' || sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

revoke execute on function public.finalize_due_sessions() from public, anon, authenticated;
grant execute on function public.finalize_due_sessions() to service_role;

drop function if exists public.complete_missing_session(uuid, jsonb, text);

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

  perform public.recompute_attendance_performance_for_session(p_session_id);

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json, reason)
  values (v_session.organization_id, public.current_principal_id(), 'complete_missing_session', 'session', p_session_id, p_entries, p_reason);

  return v_count;
end;
$$;

drop function if exists public.correct_final_attendance(uuid, attendance_mark, text);

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

  perform public.recompute_attendance_performance_for_session(v_final.session_id);

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json, reason)
  values (v_final.organization_id, public.current_principal_id(), 'correct_final_attendance', 'final_attendance', p_final_attendance_id,
          jsonb_build_object('mark', v_final.mark), jsonb_build_object('mark', p_after_mark), p_reason);
end;
$$;

-- ============================================================
-- 5. 직접등록 실적 RPC
-- ============================================================

create function public.create_summary_performance(
  p_activity_id uuid,
  p_operation_date date,
  p_activity_content text,
  p_count_value integer,
  p_unique_people_value integer,
  p_total_people_value integer
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_organization_id uuid;
  v_business_year_id uuid;
  v_method performance_method;
  v_id uuid;
begin
  if not public.can_manage_activity(p_activity_id) then
    raise exception '이 활동에 실적을 등록할 권한이 없습니다.';
  end if;

  select a.organization_id, a.business_year_id, a.default_performance_method
    into v_organization_id, v_business_year_id, v_method
  from public.activities a where a.id = p_activity_id;

  if v_organization_id is null then
    raise exception '활동을 찾을 수 없습니다.';
  end if;
  if v_method <> 'summary' then
    raise exception '이 활동은 출석연동 활동이라 직접등록할 수 없습니다.';
  end if;
  if p_operation_date is null then
    raise exception '운영일자를 입력해 주세요.';
  end if;
  if p_count_value is null or p_unique_people_value is null or p_total_people_value is null
     or p_count_value < 0 or p_unique_people_value < 0 or p_total_people_value < 0 then
    raise exception '건/실인원/연인원은 0 이상의 값이어야 합니다.';
  end if;
  if p_unique_people_value > p_total_people_value then
    raise exception '실인원은 연인원보다 클 수 없습니다.';
  end if;
  if p_activity_content is not null and length(p_activity_content) > 100 then
    raise exception '활동내용은 100자를 넘을 수 없습니다.';
  end if;

  insert into public.performance_records (
    organization_id, business_year_id, activity_id, method,
    operation_date, activity_content, count_value, unique_people_value, total_people_value,
    status, created_by
  ) values (
    v_organization_id, v_business_year_id, p_activity_id, 'summary',
    p_operation_date, nullif(trim(p_activity_content), ''), p_count_value, p_unique_people_value, p_total_people_value,
    'active', public.current_principal_id()
  )
  returning id into v_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_organization_id, public.current_principal_id(), 'create_summary_performance', 'performance_record', v_id,
          jsonb_build_object('count', p_count_value, 'unique', p_unique_people_value, 'total', p_total_people_value));

  return v_id;
end;
$$;

create function public.update_summary_performance(
  p_id uuid,
  p_operation_date date,
  p_activity_content text,
  p_count_value integer,
  p_unique_people_value integer,
  p_total_people_value integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_record record;
  v_activity_id uuid;
begin
  select pr.id, pr.organization_id, pr.activity_id, pr.method, pr.status,
         pr.count_value as before_count, pr.unique_people_value as before_unique, pr.total_people_value as before_total
    into v_record
  from public.performance_records pr where pr.id = p_id;

  if v_record.id is null then
    raise exception '실적 기록을 찾을 수 없습니다.';
  end if;
  if v_record.method <> 'summary' then
    raise exception '출석연동 실적은 직접 수정할 수 없습니다. 출석관리에서 공식출석을 정정해 주세요.';
  end if;
  if v_record.status <> 'active' then
    raise exception '취소된 실적은 수정할 수 없습니다. 먼저 복구해 주세요.';
  end if;
  if not public.can_manage_activity(v_record.activity_id) then
    raise exception '이 실적을 수정할 권한이 없습니다.';
  end if;
  if p_operation_date is null then
    raise exception '운영일자를 입력해 주세요.';
  end if;
  if p_count_value is null or p_unique_people_value is null or p_total_people_value is null
     or p_count_value < 0 or p_unique_people_value < 0 or p_total_people_value < 0 then
    raise exception '건/실인원/연인원은 0 이상의 값이어야 합니다.';
  end if;
  if p_unique_people_value > p_total_people_value then
    raise exception '실인원은 연인원보다 클 수 없습니다.';
  end if;
  if p_activity_content is not null and length(p_activity_content) > 100 then
    raise exception '활동내용은 100자를 넘을 수 없습니다.';
  end if;

  update public.performance_records
  set operation_date = p_operation_date,
      activity_content = nullif(trim(p_activity_content), ''),
      count_value = p_count_value,
      unique_people_value = p_unique_people_value,
      total_people_value = p_total_people_value
  where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_record.organization_id, public.current_principal_id(), 'update_summary_performance', 'performance_record', p_id,
          jsonb_build_object('count', v_record.before_count, 'unique', v_record.before_unique, 'total', v_record.before_total),
          jsonb_build_object('count', p_count_value, 'unique', p_unique_people_value, 'total', p_total_people_value));
end;
$$;

create function public.cancel_performance(p_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_record record;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception '취소 사유를 입력해 주세요.';
  end if;

  select pr.id, pr.organization_id, pr.activity_id, pr.method, pr.status into v_record
  from public.performance_records pr where pr.id = p_id;

  if v_record.id is null then
    raise exception '실적 기록을 찾을 수 없습니다.';
  end if;
  if v_record.method <> 'summary' then
    raise exception '출석연동 실적은 취소할 수 없습니다.';
  end if;
  if v_record.status <> 'active' then
    raise exception '이미 취소된 실적입니다.';
  end if;
  if not public.can_manage_activity(v_record.activity_id) then
    raise exception '이 실적을 취소할 권한이 없습니다.';
  end if;

  update public.performance_records
  set status = 'cancelled', cancelled_at = now(), cancelled_by = public.current_principal_id(), cancel_reason = p_reason
  where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, reason)
  values (v_record.organization_id, public.current_principal_id(), 'cancel_performance', 'performance_record', p_id, p_reason);
end;
$$;

create function public.restore_performance(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_record record;
begin
  select pr.id, pr.organization_id, pr.activity_id, pr.method, pr.status into v_record
  from public.performance_records pr where pr.id = p_id;

  if v_record.id is null then
    raise exception '실적 기록을 찾을 수 없습니다.';
  end if;
  if v_record.method <> 'summary' then
    raise exception '출석연동 실적은 복구 대상이 아닙니다.';
  end if;
  if v_record.status <> 'cancelled' then
    raise exception '취소된 실적만 복구할 수 있습니다.';
  end if;
  if not public.can_manage_activity(v_record.activity_id) then
    raise exception '이 실적을 복구할 권한이 없습니다.';
  end if;

  update public.performance_records
  set status = 'active', cancelled_at = null, cancelled_by = null, cancel_reason = null
  where id = p_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_record.organization_id, public.current_principal_id(), 'restore_performance', 'performance_record', p_id);
end;
$$;

-- ============================================================
-- 6. 연간계획 RPC
-- ============================================================

create function public.upsert_annual_plan(
  p_activity_id uuid,
  p_business_year_id uuid,
  p_count_target integer,
  p_count_basis text,
  p_unique_target integer,
  p_unique_basis text,
  p_total_target integer,
  p_total_basis text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_organization_id uuid;
  v_id uuid;
begin
  if not public.can_manage_activity(p_activity_id) then
    raise exception '이 활동의 연간계획을 수정할 권한이 없습니다.';
  end if;

  select a.organization_id into v_organization_id from public.activities a where a.id = p_activity_id;
  if v_organization_id is null then
    raise exception '활동을 찾을 수 없습니다.';
  end if;
  if (p_count_target is not null and p_count_target < 0)
     or (p_unique_target is not null and p_unique_target < 0)
     or (p_total_target is not null and p_total_target < 0) then
    raise exception '계획값은 0 이상이어야 합니다.';
  end if;

  insert into public.annual_plans (
    organization_id, business_year_id, activity_id,
    count_target, count_basis, unique_target, unique_basis, total_target, total_basis,
    updated_by
  ) values (
    v_organization_id, p_business_year_id, p_activity_id,
    p_count_target, nullif(trim(coalesce(p_count_basis, '')), ''),
    p_unique_target, nullif(trim(coalesce(p_unique_basis, '')), ''),
    p_total_target, nullif(trim(coalesce(p_total_basis, '')), ''),
    public.current_principal_id()
  )
  on conflict (business_year_id, activity_id) do update set
    count_target = excluded.count_target,
    count_basis = excluded.count_basis,
    unique_target = excluded.unique_target,
    unique_basis = excluded.unique_basis,
    total_target = excluded.total_target,
    total_basis = excluded.total_basis,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================
-- 7. 공식 집계: get_activity_metrics / get_performance_report
-- ============================================================

-- 활동 하나의 기간별 공식 metric. 실인원은 출석연동/직접등록을 서로 다른 방식으로
-- 계산한 뒤 합산한다(상세개발기준서 §8.5): 출석연동은 Run(operation_term) 단위로
-- FinalAttendance에서 직접 distinct participant 수를 다시 세고(레코드에 저장된 값을
-- 그대로 합산하지 않음 -- 회차간 중복제거가 필요하므로), Run이 여러 개면 Run별
-- 실인원을 단순 합산한다(Run 간 재중복제거 없음). 직접등록은 저장된 unique_people_value를
-- 그대로 합산한다(원자료가 없어 입력값이 공식값이므로).
create function public.get_activity_metrics(
  p_activity_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (count_value integer, unique_people_value integer, total_people_value integer)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_attendance_count integer;
  v_attendance_total integer;
  v_attendance_unique integer;
  v_summary_count integer;
  v_summary_unique integer;
  v_summary_total integer;
begin
  if not public.can_read_activity(p_activity_id) then
    raise exception '이 활동의 실적을 조회할 권한이 없습니다.';
  end if;

  select coalesce(sum(pr.count_value), 0)::int, coalesce(sum(pr.total_people_value), 0)::int
    into v_attendance_count, v_attendance_total
  from public.performance_records pr
  where pr.activity_id = p_activity_id and pr.method = 'attendance' and pr.status = 'active'
    and pr.operation_date between p_period_start and p_period_end;

  -- Run(operation_term) 단위 distinct 실인원의 합
  select coalesce(sum(run_unique.c), 0)::int into v_attendance_unique
  from (
    select count(distinct fa.enrollment_id)::int as c
    from public.performance_records pr
    join public.sessions s on s.id = pr.source_session_id
    join public.final_attendance fa on fa.session_id = s.id and fa.mark = 'present'
    where pr.activity_id = p_activity_id and pr.method = 'attendance' and pr.status = 'active'
      and pr.operation_date between p_period_start and p_period_end
    group by pr.operation_term_id
  ) run_unique;

  select coalesce(sum(pr.count_value), 0)::int, coalesce(sum(pr.unique_people_value), 0)::int, coalesce(sum(pr.total_people_value), 0)::int
    into v_summary_count, v_summary_unique, v_summary_total
  from public.performance_records pr
  where pr.activity_id = p_activity_id and pr.method = 'summary' and pr.status = 'active'
    and pr.operation_date between p_period_start and p_period_end;

  return query select
    v_attendance_count + v_summary_count,
    v_attendance_unique + v_summary_unique,
    v_attendance_total + v_summary_total;
end;
$$;

-- 단위사업(현재는 "노년사회화교육사업" 1개) 전체의 공식 집계. Batch 2.2(AI 사업평가)가
-- 재사용할 Source of Truth로 만든다 -- 이번 Batch에서 AI 관련 기능은 만들지 않는다.
create function public.get_unit_business_aggregate(
  p_unit_business_id uuid,
  p_period_start date,
  p_period_end date
)
returns table (count_value integer, unique_people_value integer, total_people_value integer)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_activity record;
  v_count integer := 0;
  v_unique integer := 0;
  v_total integer := 0;
  v_m record;
begin
  for v_activity in select id from public.activities where unit_business_id = p_unit_business_id and is_active = true
  loop
    select * into v_m from public.get_activity_metrics(v_activity.id, p_period_start, p_period_end);
    v_count := v_count + coalesce(v_m.count_value, 0);
    v_unique := v_unique + coalesce(v_m.unique_people_value, 0);
    v_total := v_total + coalesce(v_m.total_people_value, 0);
  end loop;

  return query select v_count, v_unique, v_total;
end;
$$;

-- 실적보고: 사업구조(대/중/소분류) 트리 + 활동(leaf) 각 행에 대해 계획/기간실적/YTD를
-- 함께 반환한다. 브라우저에서 reduce로 집계하지 않고 서버에서 전부 계산해서 내려준다.
create function public.get_performance_report(
  p_business_year_id uuid,
  p_period_start date,
  p_period_end date,
  p_ytd_start date
)
returns table (
  node_id uuid,
  node_type text,
  parent_id uuid,
  label text,
  level integer,
  sort_order integer,
  plan_count integer,
  plan_unique integer,
  plan_total integer,
  period_count integer,
  period_unique integer,
  period_total integer,
  ytd_count integer,
  ytd_unique integer,
  ytd_total integer
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_org uuid;
  v_activity record;
  v_node record;
  v_period record;
  v_ytd record;
  v_plan record;
  v_agg record;
begin
  v_org := public.current_organization_id();
  if v_org is null then
    raise exception '조직 정보를 확인할 수 없습니다.';
  end if;

  -- 활동(leaf) 행
  for v_activity in
    select a.id, a.name, a.business_node_id, a.sort_order
    from public.activities a
    where a.organization_id = v_org and a.business_year_id = p_business_year_id and a.is_active = true
      and public.can_read_activity(a.id)
    order by a.sort_order
  loop
    select * into v_period from public.get_activity_metrics(v_activity.id, p_period_start, p_period_end);
    select * into v_ytd from public.get_activity_metrics(v_activity.id, p_ytd_start, p_period_end);
    select ap.count_target, ap.unique_target, ap.total_target into v_plan
    from public.annual_plans ap where ap.activity_id = v_activity.id and ap.business_year_id = p_business_year_id;

    node_id := v_activity.id;
    node_type := 'activity';
    parent_id := v_activity.business_node_id;
    label := v_activity.name;
    level := 3;
    sort_order := v_activity.sort_order;
    plan_count := v_plan.count_target; plan_unique := v_plan.unique_target; plan_total := v_plan.total_target;
    period_count := v_period.count_value; period_unique := v_period.unique_people_value; period_total := v_period.total_people_value;
    ytd_count := v_ytd.count_value; ytd_unique := v_ytd.unique_people_value; ytd_total := v_ytd.total_people_value;
    return next;
  end loop;

  -- 사업구조 노드(대/중/소분류) 행: 하위 활동 metric의 단순 합산(상세개발기준서 §8.5.4).
  for v_node in
    select bn.id, bn.name, bn.parent_id, bn.node_type, bn.sort_order,
      case bn.node_type when 'major' then 0 when 'middle' then 1 when 'minor' then 2 end as lvl
    from public.business_nodes bn
    where bn.organization_id = v_org and bn.business_year_id = p_business_year_id and bn.is_active = true
    order by lvl, bn.sort_order
  loop
    select
      case when bool_or(sub.leaf_plan_count is not null) then coalesce(sum(sub.leaf_plan_count), 0)::int else null end as agg_plan_count,
      case when bool_or(sub.leaf_plan_unique is not null) then coalesce(sum(sub.leaf_plan_unique), 0)::int else null end as agg_plan_unique,
      case when bool_or(sub.leaf_plan_total is not null) then coalesce(sum(sub.leaf_plan_total), 0)::int else null end as agg_plan_total,
      coalesce(sum(sub.leaf_period_count), 0)::int as agg_period_count,
      coalesce(sum(sub.leaf_period_unique), 0)::int as agg_period_unique,
      coalesce(sum(sub.leaf_period_total), 0)::int as agg_period_total,
      coalesce(sum(sub.leaf_ytd_count), 0)::int as agg_ytd_count,
      coalesce(sum(sub.leaf_ytd_unique), 0)::int as agg_ytd_unique,
      coalesce(sum(sub.leaf_ytd_total), 0)::int as agg_ytd_total
    into v_agg
    from (
      -- 소분류는 직속 활동 + (있다면) 하위 없음(활동이 소분류의 최하위이므로).
      -- 중/대분류는 자기 자신을 조상으로 갖는 모든 하위 소분류의 활동 합.
      -- 서브쿼리 컬럼명을 leaf_ 접두사로 지어 바깥 함수의 OUT 파라미터(plan_count 등)와
      -- 겹치지 않게 한다(동명 충돌 시 column reference ambiguous 오류가 실제로 발생함을
      -- Batch 1.2에서 이미 확인했다).
      with recursive descendants as (
        select bn2.id from public.business_nodes bn2 where bn2.id = v_node.id
        union all
        select bn3.id from public.business_nodes bn3 join descendants d on bn3.parent_id = d.id
      )
      select
        a.id,
        (select p2.count_target from public.annual_plans p2 where p2.activity_id = a.id and p2.business_year_id = p_business_year_id) as leaf_plan_count,
        (select p2.unique_target from public.annual_plans p2 where p2.activity_id = a.id and p2.business_year_id = p_business_year_id) as leaf_plan_unique,
        (select p2.total_target from public.annual_plans p2 where p2.activity_id = a.id and p2.business_year_id = p_business_year_id) as leaf_plan_total,
        (select m.count_value from public.get_activity_metrics(a.id, p_period_start, p_period_end) m) as leaf_period_count,
        (select m.unique_people_value from public.get_activity_metrics(a.id, p_period_start, p_period_end) m) as leaf_period_unique,
        (select m.total_people_value from public.get_activity_metrics(a.id, p_period_start, p_period_end) m) as leaf_period_total,
        (select m.count_value from public.get_activity_metrics(a.id, p_ytd_start, p_period_end) m) as leaf_ytd_count,
        (select m.unique_people_value from public.get_activity_metrics(a.id, p_ytd_start, p_period_end) m) as leaf_ytd_unique,
        (select m.total_people_value from public.get_activity_metrics(a.id, p_ytd_start, p_period_end) m) as leaf_ytd_total
      from public.activities a
      where a.business_node_id in (select id from descendants) and a.is_active = true and public.can_read_activity(a.id)
    ) sub;

    node_id := v_node.id;
    node_type := v_node.node_type::text;
    parent_id := v_node.parent_id;
    label := v_node.name;
    level := v_node.lvl;
    sort_order := v_node.sort_order;
    plan_count := v_agg.agg_plan_count;
    plan_unique := v_agg.agg_plan_unique;
    plan_total := v_agg.agg_plan_total;
    period_count := v_agg.agg_period_count;
    period_unique := v_agg.agg_period_unique;
    period_total := v_agg.agg_period_total;
    ytd_count := v_agg.agg_ytd_count;
    ytd_unique := v_agg.agg_ytd_unique;
    ytd_total := v_agg.agg_ytd_total;
    return next;
  end loop;
end;
$$;

-- ============================================================
-- 8. RLS
-- ============================================================

alter table public.performance_records enable row level security;
alter table public.annual_plans enable row level security;

-- performance_records: can_read_activity 재사용(global_viewer도 공식 aggregate/원자료를
-- 읽을 수 있다 -- 개인 참여자 원자료가 아니라 조직 업무데이터이므로 Batch 1.2에서 발견한
-- "global_viewer 개인정보 우회" 문제와는 다른 성격이다. 이 테이블에는애초에 성명/회원코드가
-- 없다). 쓰기 정책은 두지 않는다(전부 RPC 경유, client direct write는 기본 DENY).
create policy "권한자 공식실적 조회" on public.performance_records for select
  using (public.can_read_activity(activity_id));

create policy "권한자 연간계획 조회" on public.annual_plans for select
  using (public.can_read_activity(activity_id));
