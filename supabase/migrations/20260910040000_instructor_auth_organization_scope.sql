-- Instructor Auth Organization Scope: 강사 인증을 반드시 기관 단위로 scope한다.
--
-- 문제: verify_instructor_login / set_instructor_pin /
-- confirm_instructor_current_pin이 (name, phone_last4)만으로 전역 검색한 뒤
-- SELECT ... INTO로 한 행을 받는다. plpgsql의 SELECT INTO는 여러 행이 매칭돼도
-- 오류 없이 "임의의 첫 행"을 조용히 집어온다. 따라서 서로 다른 기관에 같은
-- 성명 + 휴대전화 뒤4자리 강사가 있으면
--   (1) 다른 기관 강사로 인증될 수 있고
--   (2) 올바른 강사가 로그인에 실패할 수 있다.
-- 반면 provision_instructor의 중복 검사는 organization_id 범위이므로, 생성
-- 정책(기관 내 유일)과 로그인 정책(전역 유일 가정)이 비대칭이었다.
--
-- 원칙: "강사 계정은 항상 특정 organization 안에서 식별한다."
-- 강사가 고른 기관의 기관코드(org_code)를 organization_id로 resolve한 뒤, 그
-- organization_id 범위 안에서만 강사를 조회한다.
--
-- 기존 강사 계정은 건드리지 않는다 -- pin_hash / pin_confirmed / 실패카운트 /
-- 잠금상태를 그대로 두며, 기관코드 도입 때문에 PIN을 재생성하지 않는다.

-- ============================================================
-- 1. organizations.org_code -- 공개 로그인용 기관코드
-- ============================================================
-- 기존 organizations에는 재사용할 수 있는 public-facing code/slug/tenant code가
-- 전혀 없었다(name/timezone + 운영설정 컬럼뿐). 그래서 최소한으로 새로 추가한다.
-- UUID나 내부 PK를 강사에게 입력시키지 않기 위한 것이므로, 사람이 외워서 칠 수
-- 있는 짧은 문자열이어야 한다.
--
-- 정규화 정책: 저장은 항상 소문자, 앞뒤 공백 제거. 강사가 대문자로 입력하거나
-- 공백을 붙여도 같은 기관으로 resolve된다. URL query(?org=)에 그대로 쓸 수 있도록
-- 영문 소문자/숫자/하이픈만 허용한다.
alter table public.organizations
  add column if not exists org_code text;

-- 기존 row 백필. 신규 컬럼이라 아직 어떤 row도 값이 없다(충돌 없음).
-- 실제 운영기관(강사 계정이 실제로 존재하는 유일한 기관)에는 제품 결정에 따라
-- 'well001'을 부여한다 -- 기관명을 코드에 그대로 넣지 않는다.
update public.organizations
set org_code = 'well001'
where id = '00000000-0000-0000-0000-000000000001'
  and org_code is null;

-- 나머지(QA/dev 전용 조직)는 결정적으로 부여한다. 생성순서 기준이라 재실행해도
-- 같은 결과가 나오고, prefix별로 번호를 매기므로 서로 충돌하지 않는다.
with remaining as (
  select
    id,
    case when name like '%개발용%' then 'dev' else 'qa' end as prefix,
    row_number() over (
      partition by case when name like '%개발용%' then 'dev' else 'qa' end
      order by created_at, id
    ) as rn
  from public.organizations
  where org_code is null
)
update public.organizations o
set org_code = r.prefix || lpad(r.rn::text, 3, '0')
from remaining r
where o.id = r.id;

alter table public.organizations
  alter column org_code set not null;

alter table public.organizations
  drop constraint if exists organizations_org_code_format;
alter table public.organizations
  add constraint organizations_org_code_format
    check (org_code ~ '^[a-z0-9][a-z0-9-]{2,31}$');

-- 전역 unique. 이미 소문자로만 저장하므로 컬럼 unique index로 충분하다.
create unique index if not exists organizations_org_code_key
  on public.organizations (org_code);

comment on column public.organizations.org_code is
  '강사 로그인용 기관코드. 소문자/숫자/하이픈, 전역 unique. 강사 로그인 드롭다운의 선택값이며 /instructor/login?org=<코드> 전용 링크에도 쓰인다.';

-- ============================================================
-- 1-2. organizations.instructor_login_listed -- 강사 로그인 드롭다운 노출 여부
-- ============================================================
-- 제품 결정: 강사 로그인 화면에서 기관을 드롭다운으로 고른다(기관명 공개를 감수).
-- 단 QA/테스트/dev 조직 이름이 공개 로그인 화면에 뜨면 안 되므로, 노출 여부를
-- 기관별로 둔다. 신규 기관(공급자 초기등록으로 생기는 실제 기관)은 기본 노출.
-- 미노출 기관도 ?org=<코드> 전용 링크로는 그대로 로그인할 수 있다 -- 이 값은
-- 목록 표시용일 뿐 인증 조건이 아니다.
alter table public.organizations
  add column if not exists instructor_login_listed boolean not null default true;

-- 현재 존재하는 QA/테스트/dev 조직만 명시적으로 숨긴다. "실제 기관이 아닌 나머지
-- 전부" 같은 조건을 쓰지 않는 이유: 이 migration이 다시 실행되더라도 이후 새로
-- 생긴 실제 기관을 실수로 숨기지 않게 하기 위해서다.
update public.organizations
set instructor_login_listed = false
where id in (
  'dddddddd-0000-0000-0000-000000000001', -- WellLink 개발용 조직
  'bbbbbbbb-0000-0000-0000-000000000009', -- B21_REMRLS_교차조직
  'ff6e3bbb-ee23-4efe-ab2a-552b0f93f7bb', -- ONBOARDING_QA_기관
  '4aabd8ad-8d7d-4bb3-8478-0f8e8380f1f2', -- PHASE4B_QA_기관
  'ad0d3cbf-9bca-437d-95c4-b2b4db50b9ba', -- INSTRUCTORQA_기관
  '8876a00b-0719-45cc-b1df-c6f764e79c03'  -- 테스트복지관
);

comment on column public.organizations.instructor_login_listed is
  '강사 로그인 드롭다운에 기관명을 표시할지 여부. false여도 ?org=<코드> 링크 로그인은 가능하다.';

-- ============================================================
-- 2. 기관코드 -> organization_id resolve 헬퍼
-- ============================================================
-- 강사 인증 함수들이 공통으로 쓴다. 존재하지 않는 코드면 NULL을 돌려주고, 호출한
-- 쪽에서 "기관코드 또는 로그인 정보를 확인해 주세요" 하나로 뭉뚱그려 처리한다
-- (기관 존재 여부와 강사 존재 여부를 구분해서 알려주지 않는다).
create or replace function public.resolve_organization_id_by_code(p_org_code text)
returns uuid
language sql
stable
security definer set search_path = public
as $$
  select id from public.organizations
  where org_code = lower(trim(coalesce(p_org_code, '')))
$$;

-- 기관 목록을 열거할 수 있는 통로를 새로 열지 않는다 -- 이 함수는 service_role만
-- 호출할 수 있고, 브라우저는 항상 서버함수(instructor-auth.ts)를 거친다.
revoke execute on function public.resolve_organization_id_by_code(text) from public, anon, authenticated;
grant execute on function public.resolve_organization_id_by_code(text) to service_role;

-- ============================================================
-- 3. verify_instructor_login -- organization scope
-- ============================================================
-- 기존 3-arg 시그니처는 전역 검색이므로 남겨두면 안 된다(overload로 남으면 예전
-- 경로가 계속 살아있는 셈이다). 정확한 시그니처를 명시적으로 DROP한다.
--
-- 참고: 20260910030000이 이 함수를 drop 후 재생성하면서 revoke/grant를 다시
-- 적용하지 않아 default PUBLIC execute 상태가 됐고, 이후 20260910050651(Lovable
-- 보안 일괄 수정)이 anon은 막았지만 대신 모든 public 함수에 authenticated
-- execute를 줬다 -- 즉 로그인한 아무 직원/강사나 강사 PIN 함수를 직접 부를 수
-- 있다. 강사 인증 함수는 서버함수(service_role) 전용이므로 아래에서 다시
-- service_role만 남긴다.
drop function if exists public.verify_instructor_login(text, text, text);

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

-- ============================================================
-- 4. set_instructor_pin -- organization scope
-- ============================================================
drop function if exists public.set_instructor_pin(text, text, text);

create or replace function public.set_instructor_pin(
  p_org_code text, p_name text, p_phone_last4 text, p_new_pin text
)
returns table(out_principal_id uuid, out_auth_user_id uuid, out_organization_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org_id uuid;
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
  v_pin_confirmed boolean;
begin
  if p_new_pin !~ '^[0-9]{4}$' then
    raise exception 'PIN은 4자리 숫자여야 합니다.';
  end if;

  v_org_id := public.resolve_organization_id_by_code(p_org_code);
  if v_org_id is null then
    raise exception '계정 정보를 확인할 수 없습니다.';
  end if;

  select p.id, p.auth_user_id, p.organization_id, ip.pin_confirmed
    into v_principal_id, v_auth_user_id, v_organization_id, v_pin_confirmed
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.organization_id = v_org_id
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4
  for update of ip;

  if v_principal_id is null then
    raise exception '계정 정보를 확인할 수 없습니다.';
  end if;
  if v_pin_confirmed then
    raise exception 'ALREADY_SET';
  end if;

  update public.instructor_profiles
  set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
      pin_confirmed = true, pin_failed_count = 0, pin_locked_until = null
  where principal_id = v_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_organization_id, v_principal_id, 'instructor_pin_set', 'principal', v_principal_id);

  out_principal_id := v_principal_id;
  out_auth_user_id := v_auth_user_id;
  out_organization_id := v_organization_id;
  return next;
end;
$$;

revoke execute on function public.set_instructor_pin(text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_instructor_pin(text, text, text, text) to service_role;

-- ============================================================
-- 5. confirm_instructor_current_pin -- organization scope
-- ============================================================
drop function if exists public.confirm_instructor_current_pin(text, text);

create or replace function public.confirm_instructor_current_pin(
  p_org_code text, p_name text, p_phone_last4 text
)
returns table(out_principal_id uuid, out_auth_user_id uuid, out_organization_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_org_id uuid;
  v_principal_id uuid;
  v_auth_user_id uuid;
  v_organization_id uuid;
begin
  v_org_id := public.resolve_organization_id_by_code(p_org_code);
  if v_org_id is null then
    raise exception '계정 정보를 확인할 수 없습니다.';
  end if;

  select p.id, p.auth_user_id, p.organization_id
    into v_principal_id, v_auth_user_id, v_organization_id
  from public.principals p
  join public.instructor_profiles ip on ip.principal_id = p.id
  where p.principal_type = 'instructor'
    and p.is_active = true
    and p.organization_id = v_org_id
    and p.name = p_name
    and ip.phone_last4 = p_phone_last4
  for update of ip;

  if v_principal_id is null then
    raise exception '계정 정보를 확인할 수 없습니다.';
  end if;

  update public.instructor_profiles
  set pin_confirmed = true
  where principal_id = v_principal_id;

  insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id)
  values (v_organization_id, v_principal_id, 'instructor_pin_confirmed_current', 'principal', v_principal_id);

  out_principal_id := v_principal_id;
  out_auth_user_id := v_auth_user_id;
  out_organization_id := v_organization_id;
  return next;
end;
$$;

revoke execute on function public.confirm_instructor_current_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.confirm_instructor_current_pin(text, text, text) to service_role;

-- ============================================================
-- 6. reset_instructor_pin / provision_instructor -- 이미 scope됨(변경 없음)
-- ============================================================
-- reset_instructor_pin(p_principal_id uuid)은 principal ID를 직접 받고
-- is_system_admin() + organization_id = current_organization_id() 를 이미 검사한다.
-- 즉 관리자 본인 기관의 강사에게만 적용되며 전역 (name, phone_last4) 검색을 하지
-- 않는다. provision_instructor 역시 p_organization_id를 받아 동일하게 검사한다.
-- 이미 principal ID로 안전하게 동작하는 내부 함수까지 불필요하게 바꾸지 않는다.
