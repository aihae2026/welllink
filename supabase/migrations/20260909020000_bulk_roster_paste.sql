-- Manual QA Gap Fix — §9-16: 프로그램 설정 메인 화면에서 여러 Program의
-- 수강명단을 한 번에(붙여넣기) 등록한다. 개별 Program의 apply_initial_roster
-- (§13, 회원번호/성명 2컬럼, term 1개 대상)는 그대로 두고, 여기서는 "이 운영
-- 구분에 선택된 Program"만 대상으로 프로그램명까지 함께 받는 새 RPC 하나만
-- 추가한다(대규모 재설계 아님). 검증(1차 loop) -> 반영(2차 loop) -> term별
-- 최초등록 기록까지 전부 이 함수 하나(=하나의 트랜잭션) 안에서 원자적으로
-- 처리해 partial apply를 만들지 않는다(기존 안전 정책 유지, §16).
create function public.apply_bulk_roster_for_cycle(
  p_operation_cycle_id uuid,
  p_rows jsonb
)
returns table (out_participant_count integer, out_enrollment_count integer, out_program_count integer)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_cycle_org uuid;
  v_row jsonb;
  v_row_no integer;
  v_program_name text;
  v_member_code text;
  v_name text;
  v_program_id uuid;
  v_term_id uuid;
  v_already_applied timestamptz;
  v_participant_id uuid;
  v_participant_count integer := 0;
  v_enrollment_count integer := 0;
  v_seen_row_keys text[] := '{}';
  v_touched_terms uuid[] := '{}';
begin
  v_org := public.current_organization_id();
  if v_org is null or public.current_business_role() = 'global_viewer' then
    raise exception '수강명단을 등록할 권한이 없습니다.';
  end if;
  select organization_id into v_cycle_org from public.operation_cycles where id = p_operation_cycle_id;
  if v_cycle_org is null or v_cycle_org <> v_org then
    raise exception '운영구분을 찾을 수 없습니다.';
  end if;

  -- 1차: 전체 행 검증 (형식/프로그램 소속/운영정보 존재/최초등록 여부/중복) --
  -- 하나라도 잘못되면 전체 rollback(partial apply 없음).
  v_row_no := 0;
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row_no := v_row_no + 1;
    v_program_name := trim(coalesce(v_row->>'program_name', ''));
    v_member_code := trim(coalesce(v_row->>'member_code', ''));
    v_name := trim(coalesce(v_row->>'name', ''));

    if v_program_name = '' then
      raise exception '%번째 행: 프로그램명이 비어 있습니다.', v_row_no;
    end if;
    if v_member_code = '' then
      raise exception '%번째 행: 회원번호가 비어 있습니다.', v_row_no;
    end if;
    if v_name = '' then
      raise exception '%번째 행: 성명이 비어 있습니다.', v_row_no;
    end if;
    if char_length(v_member_code) > 40 then
      raise exception '%번째 행: 회원번호가 너무 깁니다: %', v_row_no, v_member_code;
    end if;

    select p.id into v_program_id
    from public.operation_cycle_programs ocp
    join public.programs p on p.id = ocp.program_id
    where ocp.operation_cycle_id = p_operation_cycle_id and p.name = v_program_name;
    if v_program_id is null then
      raise exception '%번째 행: "%"은(는) 현재 운영구분에 포함되지 않은 프로그램입니다.', v_row_no, v_program_name;
    end if;

    select ot.id, ot.initial_roster_applied_at into v_term_id, v_already_applied
    from public.operation_terms ot
    where ot.operation_cycle_id = p_operation_cycle_id and ot.program_id = v_program_id;
    if v_term_id is null then
      raise exception '%번째 행: "%"의 운영정보가 아직 설정되지 않았습니다.', v_row_no, v_program_name;
    end if;
    if v_already_applied is not null then
      raise exception '%번째 행: "%"은(는) 이미 최초 수강명단이 등록되어 재적용할 수 없습니다.', v_row_no, v_program_name;
    end if;

    if (v_program_id::text || ':' || v_member_code) = any (v_seen_row_keys) then
      raise exception '%번째 행: 같은 프로그램("%") 안에 회원번호가 중복되었습니다: %', v_row_no, v_program_name, v_member_code;
    end if;
    v_seen_row_keys := array_append(v_seen_row_keys, v_program_id::text || ':' || v_member_code);
  end loop;

  -- 2차: 실제 반영.
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_program_name := trim(v_row->>'program_name');
    v_member_code := trim(v_row->>'member_code');
    v_name := trim(v_row->>'name');

    select p.id into v_program_id
    from public.operation_cycle_programs ocp
    join public.programs p on p.id = ocp.program_id
    where ocp.operation_cycle_id = p_operation_cycle_id and p.name = v_program_name;

    select id into v_term_id from public.operation_terms
    where operation_cycle_id = p_operation_cycle_id and program_id = v_program_id;

    insert into public.participants (organization_id, member_code, name)
    values (v_org, v_member_code, v_name)
    on conflict (organization_id, member_code) do update set name = excluded.name
    returning id into v_participant_id;
    v_participant_count := v_participant_count + 1;

    insert into public.enrollments (organization_id, operation_term_id, participant_id, start_session_no, created_by)
    values (v_org, v_term_id, v_participant_id, 1, public.current_principal_id());
    v_enrollment_count := v_enrollment_count + 1;

    if not (v_term_id = any (v_touched_terms)) then
      v_touched_terms := array_append(v_touched_terms, v_term_id);
    end if;
  end loop;

  update public.operation_terms
  set initial_roster_applied_at = now()
  where id = any (v_touched_terms);

  insert into public.roster_imports (organization_id, operation_term_id, idempotency_key, row_count, imported_by)
  select v_org, resolved.term_id, 'bulk:' || gen_random_uuid()::text, count(*), public.current_principal_id()
  from (
    select ot.id as term_id
    from jsonb_array_elements(p_rows) r
    join public.operation_cycle_programs ocp on ocp.operation_cycle_id = p_operation_cycle_id
    join public.programs p on p.id = ocp.program_id and p.name = trim(r->>'program_name')
    join public.operation_terms ot on ot.operation_cycle_id = p_operation_cycle_id and ot.program_id = p.id
  ) resolved
  group by resolved.term_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  values (v_org, public.current_principal_id(), 'apply_bulk_roster_for_cycle', 'operation_cycle', p_operation_cycle_id,
    jsonb_build_object('participant_count', v_participant_count, 'enrollment_count', v_enrollment_count,
      'program_count', coalesce(array_length(v_touched_terms, 1), 0)));

  return query select v_participant_count, v_enrollment_count, coalesce(array_length(v_touched_terms, 1), 0);
end;
$$;
