-- 사용자 관리 > 강사 계정의 PIN 상태에 "첫 로그인 전"을 보여주기 위해
-- list_instructor_accounts가 pin_confirmed(강사가 첫 로그인 후 PIN 유지·변경을
-- 골랐는지, 20260910030000)를 함께 돌려준다. 반환 열이 늘어 drop 후 다시 만든다.
-- 데이터는 바꾸지 않는다. 권한은 기존과 같다(authenticated · service_role).

drop function if exists public.list_instructor_accounts();

create function public.list_instructor_accounts()
returns table (
  out_principal_id uuid,
  out_name text,
  out_phone_last4 text,
  out_is_active boolean,
  out_pin_set boolean,
  out_pin_locked boolean,
  out_pin_confirmed boolean,
  out_created_at timestamptz
)
language plpgsql
security definer set search_path = public
stable
as $$
declare
  v_row record;
begin
  if not public.is_system_admin() then
    raise exception '강사 목록을 조회할 권한이 없습니다.';
  end if;

  for v_row in
    select p.id, p.name, ip.phone_last4, p.is_active,
           (ip.pin_hash is not null) as pin_set,
           (ip.pin_locked_until is not null and ip.pin_locked_until > now()) as pin_locked,
           ip.pin_confirmed,
           p.created_at
    from public.principals p
    join public.instructor_profiles ip on ip.principal_id = p.id
    where p.organization_id = public.current_organization_id() and p.principal_type = 'instructor'
    order by p.created_at
  loop
    out_principal_id := v_row.id;
    out_name := v_row.name;
    out_phone_last4 := v_row.phone_last4;
    out_is_active := v_row.is_active;
    out_pin_set := v_row.pin_set;
    out_pin_locked := v_row.pin_locked;
    out_pin_confirmed := v_row.pin_confirmed;
    out_created_at := v_row.created_at;
    return next;
  end loop;
end;
$$;

revoke execute on function public.list_instructor_accounts() from public, anon;
grant execute on function public.list_instructor_accounts() to authenticated, service_role;
