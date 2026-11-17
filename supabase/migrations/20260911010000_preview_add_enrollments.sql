-- 수강생 추가(붙여넣기/직접 입력) 미리보기용 조회 전용 함수.
--
-- add_enrollments는 이미 있는 회원번호면 입력한 성명을 보지 않고 기존 회원으로
-- 등록한다. 여러 명을 붙여넣을 때 회원번호 오타가 다른 사람의 수강 등록으로
-- 조용히 이어지지 않도록, 등록 전에 회원번호별 기존 성명과 이 운영차수의 수강
-- 상태(수강 중/종결)를 화면에 보여준다.
--
-- 권한은 add_enrollments와 같다(can_manage_activity). 입력한 회원번호만 조회하며
-- 데이터는 바꾸지 않는다. add_enrollments 자체는 그대로 두고 최종 검증을 맡긴다.

create function public.preview_add_enrollments(p_operation_term_id uuid, p_member_codes text[])
returns table (
  out_member_code text,
  out_existing_name text,
  out_active_in_term boolean,
  out_ended_in_term boolean
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_activity_id uuid;
  v_organization_id uuid;
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
  if coalesce(array_length(p_member_codes, 1), 0) > 1000 then
    raise exception '한 번에 확인할 수 있는 회원번호는 1,000개까지입니다.';
  end if;

  return query
  select
    pt.member_code,
    pt.name,
    exists (
      select 1 from public.enrollments e
      where e.operation_term_id = p_operation_term_id
        and e.participant_id = pt.id
        and e.end_session_no_exclusive is null
    ),
    exists (
      select 1 from public.enrollments e
      where e.operation_term_id = p_operation_term_id
        and e.participant_id = pt.id
        and e.end_session_no_exclusive is not null
    )
  from public.participants pt
  where pt.organization_id = v_organization_id
    and pt.member_code in (select trim(c) from unnest(p_member_codes) as c);
end;
$$;

revoke all on function public.preview_add_enrollments(uuid, text[]) from public, anon;
grant execute on function public.preview_add_enrollments(uuid, text[]) to authenticated, service_role;

do $$
begin
  if has_function_privilege('anon', 'public.preview_add_enrollments(uuid, text[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.preview_add_enrollments(uuid, text[])', 'EXECUTE') then
    raise exception 'preview_add_enrollments grant check failed';
  end if;
end $$;
