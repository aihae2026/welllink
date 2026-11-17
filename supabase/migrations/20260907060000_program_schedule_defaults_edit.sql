-- 운영 UX Gap Closure: Program 기본정보(요일/시간) 등록/수정 경로가 없던 문제를
-- 닫는다. program_schedule_defaults는 이미 존재하는 테이블(Batch 1.1)이고, 여기서는
-- 그것을 실제로 쓸 수 있는 RPC만 추가한다. 개별/일괄 편집 둘 다 이 두 RPC로 처리한다
-- (브라우저에서 row마다 UPDATE를 순차 호출하지 않는다).

create function public.upsert_program_schedule_default(
  p_program_id uuid,
  p_weekdays smallint[],
  p_start_time time,
  p_end_time time
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_activity_id uuid;
begin
  select activity_id into v_activity_id from public.programs where id = p_program_id;
  if v_activity_id is null then
    raise exception '프로그램을 찾을 수 없습니다.';
  end if;
  if not public.can_manage_activity(v_activity_id) then
    raise exception '이 프로그램의 기본정보를 수정할 권한이 없습니다.';
  end if;
  if p_weekdays is null or array_length(p_weekdays, 1) is null then
    raise exception '요일을 1개 이상 선택해 주세요.';
  end if;

  insert into public.program_schedule_defaults (program_id, weekdays, start_time, end_time)
  values (p_program_id, p_weekdays, p_start_time, p_end_time)
  on conflict (program_id) do update
    set weekdays = excluded.weekdays, start_time = excluded.start_time, end_time = excluded.end_time;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json)
  select organization_id, public.current_principal_id(), 'update_program_schedule_default', 'activity', v_activity_id,
    jsonb_build_object('weekdays', p_weekdays, 'start_time', p_start_time, 'end_time', p_end_time)
  from public.activities where id = v_activity_id;
end;
$$;

-- 여러 Program을 한 번에 저장한다. p_rows: [{program_id, weekdays, start_time, end_time}, ...]
-- 권한 없는 program이 하나라도 섞여 있으면 전체 rollback(부분성공 없음).
create function public.upsert_program_schedule_defaults_batch(p_rows jsonb)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_row jsonb;
  v_program_id uuid;
  v_activity_id uuid;
  v_weekdays smallint[];
  v_count integer := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_program_id := (v_row->>'program_id')::uuid;
    select activity_id into v_activity_id from public.programs where id = v_program_id;
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

    insert into public.program_schedule_defaults (program_id, weekdays, start_time, end_time)
    values (
      v_program_id, v_weekdays,
      nullif(v_row->>'start_time', '')::time,
      nullif(v_row->>'end_time', '')::time
    )
    on conflict (program_id) do update
      set weekdays = excluded.weekdays, start_time = excluded.start_time, end_time = excluded.end_time;

    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, after_json)
  values (public.current_organization_id(), public.current_principal_id(), 'batch_update_program_schedule_defaults', 'activity',
    jsonb_build_object('count', v_count));

  return v_count;
end;
$$;

-- 목록/일괄편집 화면에서 쓸 조회 RPC (can_read_activity 기준으로 필터링된 목록).
create function public.list_programs_with_schedule()
returns table (
  out_activity_id uuid,
  out_program_id uuid,
  out_name text,
  out_weekdays smallint[],
  out_start_time time,
  out_end_time time,
  out_sort_order integer
)
language plpgsql
security definer set search_path = public
stable
as $$
begin
  return query
    select a.id, p.id, a.name, psd.weekdays, psd.start_time, psd.end_time, a.sort_order
    from public.activities a
    join public.programs p on p.activity_id = a.id
    left join public.program_schedule_defaults psd on psd.program_id = p.id
    where a.organization_id = public.current_organization_id()
      and public.can_read_activity(a.id)
    order by a.sort_order;
end;
$$;
