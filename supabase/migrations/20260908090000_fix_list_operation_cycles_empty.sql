-- WellLink v1.0 — list_operation_cycles가 아직 프로그램 설정(operation_terms)이
-- 하나도 없는 운영차수를 숨기던 문제를 수정한다.
--
-- 기존 로직은 "이 운영차수에 내가 읽을 수 있는 program이 하나라도 있어야 목록에
-- 노출"이었다(구 workflow -- 운영차수와 프로그램을 한 번에 생성하던 방식 기준).
-- 이번 재설계의 Step 1(create_operation_cycle)은 프로그램 없이 운영차수만
-- 먼저 생성하므로, 생성 직후(0개 term) 새로고침하면 목록에서 사라져 버리는
-- 회귀가 발생했다. term이 0개인 운영차수는 무조건 노출하고, term이 1개
-- 이상인 운영차수는 기존과 동일하게 can_read_activity 필터를 적용한다.
create or replace function public.list_operation_cycles(p_business_year_id uuid default null)
returns table (
  out_id uuid,
  out_name text,
  out_start_date date,
  out_end_date date,
  out_status operation_cycle_status,
  out_program_count integer
)
language plpgsql
security definer set search_path = public
stable
as $$
begin
  return query
    select oc.id, oc.name, oc.start_date, oc.end_date, oc.status,
      (select count(*)::integer from public.operation_terms ot
       join public.programs p on p.id = ot.program_id
       where ot.operation_cycle_id = oc.id and public.can_read_activity(p.activity_id))
    from public.operation_cycles oc
    where oc.organization_id = public.current_organization_id()
      and (p_business_year_id is null or oc.business_year_id = p_business_year_id)
      and (
        not exists (select 1 from public.operation_terms ot where ot.operation_cycle_id = oc.id)
        or exists (
          select 1 from public.operation_terms ot join public.programs p on p.id = ot.program_id
          where ot.operation_cycle_id = oc.id and public.can_read_activity(p.activity_id)
        )
      )
    order by oc.start_date desc;
end;
$$;
