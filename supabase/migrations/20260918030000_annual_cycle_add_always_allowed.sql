-- 연중 운영구분 추가는 언제나 허용한다.
--
-- 20260918020000에서는 "연도에 프로그램이 하나라도 있으면 그 연도는 통째로
-- 건너뛴다"였다. 그래서 반기제를 그대로 둔 채 [연중 운영구분 추가]만 켜도
-- 이미 운영 중인 연도에는 연중이 생기지 않았다. 연중을 더하는 것은 운영구분
-- 하나를 새로 만드는 일(insert)이라 기존 회차·출석을 건드리지 않으므로,
-- 운영 중인 연도에도 허용하는 것이 맞다.
--
-- 이번 migration의 규칙:
--   * 반기제 <-> 분기제 : 지우고 다시 만드는 일이므로, 그 연도의 **연중이 아닌**
--     운영구분에 운영차수·가져온 프로그램이 없을 때만 다시 만든다.
--   * 연중 추가       : 모든 연도에 추가한다(없을 때만).
--   * 연중 해제       : 그 **연중 운영구분 자체**에 운영차수·가져온 프로그램이
--     없을 때만 지운다. 있으면 그대로 두고 알려 준다.
--
-- 반환값(화면 안내용):
--   applied_years        방식대로 운영구분을 다시 만든 연도
--   skipped_years        프로그램이 있어 방식 변경을 건너뛴 연도
--   annual_added_years   연중을 추가한 연도
--   annual_removed_years 연중을 지운 연도
--   annual_kept_years    연중에 프로그램이 있어 지우지 못한 연도

create or replace function public.update_operation_cycle_mode(p_mode text, p_include_annual_cycle boolean)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_prev_mode text;
  v_prev_annual boolean;
  v_year record;
  v_mode_blocked boolean;
  v_annual_id uuid;
  v_annual_busy boolean;
  v_applied integer[] := '{}';
  v_skipped integer[] := '{}';
  v_annual_added integer[] := '{}';
  v_annual_removed integer[] := '{}';
  v_annual_kept integer[] := '{}';
  v_result jsonb;
begin
  if public.current_business_role() <> 'global_manager' then
    raise exception '운영구분 방식을 변경할 권한이 없습니다.';
  end if;
  v_org := public.current_organization_id();
  if p_mode not in ('semester', 'quarter') then
    raise exception '운영구분 방식을 확인해 주세요.';
  end if;

  select operation_cycle_mode, include_annual_cycle
  into v_prev_mode, v_prev_annual
  from public.organizations where id = v_org for update;

  update public.organizations
  set operation_cycle_mode = p_mode, include_annual_cycle = p_include_annual_cycle
  where id = v_org;

  if v_prev_mode is not distinct from p_mode
     and v_prev_annual is not distinct from p_include_annual_cycle then
    -- 바뀐 게 없으면 기존 운영구분을 건드리지 않는다.
    null;
  else
    for v_year in
      select id, year from public.business_years
      where organization_id = v_org order by year
    loop
      -- 1) 반기제 <-> 분기제: 연중이 아닌 운영구분이 모두 비어 있을 때만
      if v_prev_mode is distinct from p_mode then
        select exists (
            select 1 from public.operation_terms t
            join public.operation_cycles c on c.id = t.operation_cycle_id
            where c.business_year_id = v_year.id and c.name <> '연중'
          ) or exists (
            select 1 from public.operation_cycle_programs p
            join public.operation_cycles c on c.id = p.operation_cycle_id
            where c.business_year_id = v_year.id and c.name <> '연중'
          )
        into v_mode_blocked;

        if v_mode_blocked then
          v_skipped := v_skipped || v_year.year;
        else
          delete from public.operation_cycles
          where business_year_id = v_year.id and name <> '연중';

          if p_mode = 'quarter' then
            perform public.create_operation_cycle(v_year.id, '1분기', make_date(v_year.year, 1, 1), make_date(v_year.year, 3, 31));
            perform public.create_operation_cycle(v_year.id, '2분기', make_date(v_year.year, 4, 1), make_date(v_year.year, 6, 30));
            perform public.create_operation_cycle(v_year.id, '3분기', make_date(v_year.year, 7, 1), make_date(v_year.year, 9, 30));
            perform public.create_operation_cycle(v_year.id, '4분기', make_date(v_year.year, 10, 1), make_date(v_year.year, 12, 31));
          else
            perform public.create_operation_cycle(v_year.id, '상반기', make_date(v_year.year, 1, 1), make_date(v_year.year, 6, 30));
            perform public.create_operation_cycle(v_year.id, '하반기', make_date(v_year.year, 7, 1), make_date(v_year.year, 12, 31));
          end if;
          v_applied := v_applied || v_year.year;
        end if;
      end if;

      -- 2) 연중: 추가는 항상, 해제는 그 연중이 비어 있을 때만
      select id into v_annual_id from public.operation_cycles
      where business_year_id = v_year.id and name = '연중';

      if p_include_annual_cycle then
        if v_annual_id is null then
          perform public.create_operation_cycle(v_year.id, '연중', make_date(v_year.year, 1, 1), make_date(v_year.year, 12, 31));
          v_annual_added := v_annual_added || v_year.year;
        end if;
      elsif v_annual_id is not null then
        select exists (select 1 from public.operation_terms where operation_cycle_id = v_annual_id)
            or exists (select 1 from public.operation_cycle_programs where operation_cycle_id = v_annual_id)
        into v_annual_busy;

        if v_annual_busy then
          v_annual_kept := v_annual_kept || v_year.year;
        else
          delete from public.operation_cycles where id = v_annual_id;
          v_annual_removed := v_annual_removed || v_year.year;
        end if;
      end if;
    end loop;
  end if;

  v_result := jsonb_build_object(
    'applied_years', to_jsonb(v_applied),
    'skipped_years', to_jsonb(v_skipped),
    'annual_added_years', to_jsonb(v_annual_added),
    'annual_removed_years', to_jsonb(v_annual_removed),
    'annual_kept_years', to_jsonb(v_annual_kept));

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_operation_cycle_mode', 'organization', v_org,
    jsonb_build_object('operation_cycle_mode', v_prev_mode, 'include_annual_cycle', v_prev_annual),
    jsonb_build_object('operation_cycle_mode', p_mode, 'include_annual_cycle', p_include_annual_cycle)
      || v_result);

  return v_result;
end;
$$;
