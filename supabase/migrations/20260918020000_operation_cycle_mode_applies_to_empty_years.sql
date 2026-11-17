-- 운영구분 방식(반기제/분기제/연중)을 이미 만들어진 연도에도 반영한다.
--
-- 지금까지 이 설정은 create_business_year가 "다음 연도를 추가할 때"만 참조해서,
-- 연도를 먼저 만든 기관은 방식을 바꿔도 그 연도의 운영구분이 그대로 남았다.
-- (기관 관리자 피드백: 화면 순서는 운영 연도 → 운영구분 방식인데 실제로는
--  방식을 먼저 정해야 해서 헷갈린다.)
--
-- 바뀌는 점: 방식을 저장하면 **비어 있는 연도**의 운영구분을 새 방식으로 다시
-- 만든다. 운영차수(operation_terms)나 가져온 프로그램(operation_cycle_programs)이
-- 하나라도 있는 연도는 손대지 않고 건너뛴다 -- 회차·출석·수강명단이 딸려 있는
-- 운영구분을 지울 수는 없기 때문이다.
-- 반환값으로 어떤 연도를 다시 만들었고 어떤 연도를 건너뛰었는지 알려 주어
-- 화면에서 그대로 안내한다.

drop function if exists public.update_operation_cycle_mode(text, boolean);

create function public.update_operation_cycle_mode(p_mode text, p_include_annual_cycle boolean)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_org uuid;
  v_prev_mode text;
  v_prev_annual boolean;
  v_year record;
  v_has_data boolean;
  v_applied integer[] := '{}';
  v_skipped integer[] := '{}';
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

  -- 바뀐 게 없으면 기존 운영구분을 건드리지 않는다.
  if v_prev_mode is not distinct from p_mode
     and v_prev_annual is not distinct from p_include_annual_cycle then
    v_result := jsonb_build_object('applied_years', '[]'::jsonb, 'skipped_years', '[]'::jsonb);
  else
    for v_year in
      select id, year from public.business_years
      where organization_id = v_org order by year
    loop
      select exists (
          select 1 from public.operation_terms t
          join public.operation_cycles c on c.id = t.operation_cycle_id
          where c.business_year_id = v_year.id
        ) or exists (
          select 1 from public.operation_cycle_programs p
          join public.operation_cycles c on c.id = p.operation_cycle_id
          where c.business_year_id = v_year.id
        )
      into v_has_data;

      if v_has_data then
        v_skipped := v_skipped || v_year.year;
        continue;
      end if;

      -- 반기제 <-> 분기제: 연중을 제외한 운영구분을 다시 만든다.
      if v_prev_mode is distinct from p_mode then
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
      end if;

      -- 연중 운영구분 추가/해제
      if p_include_annual_cycle then
        if not exists (
          select 1 from public.operation_cycles
          where business_year_id = v_year.id and name = '연중'
        ) then
          perform public.create_operation_cycle(v_year.id, '연중', make_date(v_year.year, 1, 1), make_date(v_year.year, 12, 31));
        end if;
      else
        delete from public.operation_cycles
        where business_year_id = v_year.id and name = '연중';
      end if;

      v_applied := v_applied || v_year.year;
    end loop;

    v_result := jsonb_build_object(
      'applied_years', to_jsonb(v_applied),
      'skipped_years', to_jsonb(v_skipped));
  end if;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, before_json, after_json)
  values (v_org, public.current_principal_id(), 'update_operation_cycle_mode', 'organization', v_org,
    jsonb_build_object('operation_cycle_mode', v_prev_mode, 'include_annual_cycle', v_prev_annual),
    jsonb_build_object('operation_cycle_mode', p_mode, 'include_annual_cycle', p_include_annual_cycle)
      || v_result);

  return v_result;
end;
$$;
