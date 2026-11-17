-- 담당자 배정/사업구조 UX Gap Closure §5-6: summary(직접등록형 업무) Activity는
-- 프로그램 기본정보 일괄설정/운영차수 생성 Wizard의 대상 목록에 나오면 안 된다.
-- 둘 다 이 RPC 하나를 공유하므로 여기서 attendance 방식만 필터링하면 충분하다.
create or replace function public.list_programs_with_schedule()
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
      and a.default_performance_method = 'attendance'
      and public.can_read_activity(a.id)
    order by a.sort_order;
end;
$$;
