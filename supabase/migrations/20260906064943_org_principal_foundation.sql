-- 웰링크(WellLink) v1.0 Batch 0: 조직 / 인증주체 / 직원 Profile 공통 기반
--
-- 이 migration은 v1.0 전용 신규 개발 프로젝트에 적용되는 첫 migration이다.
-- 기존 MVP(WellLink_Demo) 데이터는 전부 가상/목업 데이터였고 실제 운영데이터가
-- 없으므로, 구 profiles/role/is_admin과의 backfill·호환·과도기 구조를 전혀
-- 만들지 않는다. v1.0은 이 migration부터 완전히 새로 시작한다.

-- ============================================================
-- 1. organizations
-- ============================================================

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Seoul',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 2. principals: 직원/강사 공통 인증주체
-- ============================================================

create type principal_type as enum ('staff', 'instructor');

-- auth_user_id는 nullable이다. 직원(staff)은 Supabase Auth(email/password)를 쓰므로
-- 반드시 있어야 하지만, 강사(instructor)는 최종 인증방식(이름+휴대폰뒤4자리+PIN)이
-- auth.users 계정을 요구할지 Batch 1.2에서 아직 확정되지 않았다. 그래서 컬럼 자체는
-- nullable로 열어 두고, principal_type='staff'일 때만 CHECK 제약으로 NOT NULL을
-- 강제한다. UNIQUE는 유지한다 -- Postgres는 NULL을 서로 다른 값으로 취급하므로
-- 강사 행이 여러 개 NULL이어도 unique 제약과 충돌하지 않는다.
create table public.principals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  auth_user_id uuid references auth.users (id) on delete cascade,
  principal_type principal_type not null,
  name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_user_id),
  constraint principals_staff_requires_auth_user
    check (principal_type <> 'staff' or auth_user_id is not null)
);

create index principals_organization_id_idx on public.principals (organization_id);

-- ============================================================
-- 3. staff_profiles
-- ============================================================

create type business_role as enum ('staff', 'department_manager', 'global_manager', 'global_viewer');

create table public.staff_profiles (
  principal_id uuid primary key references public.principals (id) on delete cascade,
  organization_id uuid not null references public.organizations (id),
  business_role business_role not null,
  is_system_admin boolean not null default false,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index staff_profiles_organization_id_idx on public.staff_profiles (organization_id);

-- ============================================================
-- 4. instructor_profiles (Batch 0에서는 스키마만. 실제 PIN 생성/검증/로그인은
--    Pipeline 1 / Batch 1.2에서 구현한다.)
-- ============================================================

create table public.instructor_profiles (
  principal_id uuid primary key references public.principals (id) on delete cascade,
  organization_id uuid not null references public.organizations (id),
  phone_last4 text,
  pin_hash text,
  pin_failed_count integer not null default 0,
  pin_locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index instructor_profiles_organization_id_idx on public.instructor_profiles (organization_id);

-- ============================================================
-- 5. organization_id 무결성: child profile의 organization_id가 principals와
--    어긋날 수 없도록 트리거로 강제한다. 클라이언트가 무엇을 보내든 무시하고
--    principals 기준으로 덮어쓴다 -- organization_id를 client SELECT/INSERT 값이
--    아니라 항상 인증주체에서 파생시킨다는 원칙을 DB 레벨에서 보장한다.
-- ============================================================

create function public.sync_profile_organization_id()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  select organization_id into new.organization_id
  from public.principals
  where id = new.principal_id;

  if new.organization_id is null then
    raise exception 'principal_id %가 존재하는 principals 행을 가리키지 않습니다.', new.principal_id;
  end if;

  return new;
end;
$$;

create trigger staff_profiles_sync_org
  before insert or update on public.staff_profiles
  for each row execute procedure public.sync_profile_organization_id();

create trigger instructor_profiles_sync_org
  before insert or update on public.instructor_profiles
  for each row execute procedure public.sync_profile_organization_id();

-- updated_at 자동 갱신 (단순 무결성 트리거 -- 업무흐름은 여기 넣지 않는다)
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute procedure public.set_updated_at();

create trigger principals_set_updated_at
  before update on public.principals
  for each row execute procedure public.set_updated_at();

create trigger staff_profiles_set_updated_at
  before update on public.staff_profiles
  for each row execute procedure public.set_updated_at();

create trigger instructor_profiles_set_updated_at
  before update on public.instructor_profiles
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- 6. 기본 RLS Helper (파라미터 없이 auth.uid() 기준으로만 계산 -> 호출자가
--    organization_id를 주입해 권한을 상승시킬 수 없다)
-- ============================================================

create function public.current_principal_id()
returns uuid
language sql
security definer set search_path = public
stable
as $$
  select id from public.principals
  where auth_user_id = auth.uid() and is_active = true
  limit 1;
$$;

create function public.current_organization_id()
returns uuid
language sql
security definer set search_path = public
stable
as $$
  select organization_id from public.principals
  where auth_user_id = auth.uid() and is_active = true
  limit 1;
$$;

create function public.current_business_role()
returns business_role
language sql
security definer set search_path = public
stable
as $$
  select sp.business_role
  from public.staff_profiles sp
  join public.principals p on p.id = sp.principal_id
  where p.auth_user_id = auth.uid() and p.is_active = true
  limit 1;
$$;

create function public.is_system_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select coalesce((
    select sp.is_system_admin
    from public.staff_profiles sp
    join public.principals p on p.id = sp.principal_id
    where p.auth_user_id = auth.uid() and p.is_active = true
    limit 1
  ), false);
$$;

-- 이번 Batch에서 의도적으로 만들지 않는 helper (후속 Batch에서 구현):
--   can_read_activity(activity_id)    -- Batch 1.1: 활동/담당자배정 테이블 생성 이후
--   can_manage_activity(activity_id)  -- Batch 1.1: 활동/담당자배정 테이블 생성 이후
--   is_run_instructor(program_run_id) -- Batch 1.2: 강사 PIN 인증 도입 이후

-- ============================================================
-- 7. RLS: 기본 DENY + 최소권한만 명시적으로 허용
-- ============================================================

alter table public.organizations enable row level security;
alter table public.principals enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.instructor_profiles enable row level security;

-- organizations: 자기 조직만 조회. 쓰기 정책 없음(전부 기본 DENY --
-- 조직 생성/수정은 이번 Batch에 클라이언트 경로가 없다).
create policy "같은 조직 조회"
  on public.organizations for select
  using (id = public.current_organization_id());

-- principals: 자기 조직 범위만 조회. 쓰기 정책 없음.
create policy "같은 조직 principal 조회"
  on public.principals for select
  using (organization_id = public.current_organization_id());

-- staff_profiles: 자기 조직 범위만 조회. 쓰기 정책 없음 -- business_role/
-- is_system_admin은 클라이언트가 직접 바꿀 수 없어야 하므로(권한상승 방지),
-- 향후 필요한 변경은 Batch 1.1+에서 SECURITY DEFINER RPC로만 허용한다.
create policy "같은 조직 staff_profile 조회"
  on public.staff_profiles for select
  using (organization_id = public.current_organization_id());

-- instructor_profiles에는 SELECT 정책을 의도적으로 추가하지 않는다(= 클라이언트에서
-- 완전 차단, RLS 기본 DENY 그대로 유지).
--
-- 이유: Postgres RLS는 행(row) 단위로만 허용/차단할 수 있고 열(column) 단위로는
-- pin_hash만 숨기고 나머지(phone_last4 등)는 보여주는 정책을 만들 수 없다. 그런데
-- Design Lock 45절은 "관리자는 강사의 PIN 원문을 조회하거나 임의 지정하지 않는다"고
-- 명시한다 -- 즉 시스템관리자를 포함해 그 누구도 pin_hash를 직접 SELECT해서는 안
-- 된다. "같은 조직이면 SELECT 허용" 같은 행 단위 정책으로는 이 요구를 만족시킬 수
-- 없으므로, 이번 Batch에서는 테이블 전체를 클라이언트 SELECT로부터 완전히 막아둔다.
--
-- Batch 1.2에서 실제 PIN 인증/강사 목록 조회가 필요해지면, pin_hash를 제외한 안전한
-- 컬럼만 노출하는 별도 view 또는 SECURITY DEFINER RPC로 좁게 열어준다.
