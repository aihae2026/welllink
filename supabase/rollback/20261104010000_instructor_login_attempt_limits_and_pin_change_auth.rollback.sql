-- 20261104010000_instructor_login_attempt_limits_and_pin_change_auth.sql 되돌리기.
-- (1단계만 적용된 상태에서 쓴다. 2단계까지 적용했다면 이 파일이 아니라 별도 절차가 필요하다.)
-- 옛 verify_instructor_login 정의는 20260910040000 migration에서 그대로 가져왔다.

begin;

create or replace function public.verify_instructor_login(
  p_org_code text, p_name text, p_phone_last4 text, p_pin text
)
returns table(principal_id uuid, auth_user_id uuid, organization_id uuid, pin_confirmed boolean)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org_id uuid;
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
  v_pin_hash text;
  v_pin_confirmed boolean;
  v_failed_count integer;
  v_locked_until timestamptz;
  v_ok boolean;
begin
  v_org_id := public.resolve_organization_id_by_code(p_org_code);
  if v_org_id is null then
    -- 존재하지 않는 기관코드도 "자격증명 불일치"와 동일하게 처리한다.
    return;
  end if;

  select p.id, p.auth_user_id, p.organization_id, ip.pin_hash, ip.pin_confirmed, ip.pin_failed_count, ip.pin_locked_until
    into v_principal_id, v_auth_user_id, v_organization_id, v_pin_hash, v_pin_confirmed, v_failed_count, v_locked_until
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.organization_id = v_org_id
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4
  for update of ip;

  if v_principal_id is null then
    return;
  end if;

  if v_locked_until is not null and v_locked_until > now() then
    raise exception 'LOCKED';
  end if;

  v_ok := v_pin_hash is not null and extensions.crypt(p_pin, v_pin_hash) = v_pin_hash;

  if v_ok then
    update public.instructor_profiles
    set pin_failed_count = 0, pin_locked_until = null
    where instructor_profiles.principal_id = v_principal_id;

    return query select v_principal_id, v_auth_user_id, v_organization_id, v_pin_confirmed;
  else
    update public.instructor_profiles
    set pin_failed_count = pin_failed_count + 1,
        pin_locked_until = case when pin_failed_count + 1 >= 5 then now() + interval '15 minutes' else pin_locked_until end
    where instructor_profiles.principal_id = v_principal_id;

    return;
  end if;
end;
$$;

revoke execute on function public.verify_instructor_login(text, text, text, text) from public, anon, authenticated;
grant execute on function public.verify_instructor_login(text, text, text, text) to service_role;

drop function if exists public.set_instructor_pin(text, text, text, text, text);
drop function if exists public.instructor_authenticate(text, text, text, text);
drop function if exists public.instructor_note_failed_login(uuid, text);
drop function if exists public.instructor_is_login_locked(uuid, text);
drop table if exists public.instructor_login_attempts;

commit;
