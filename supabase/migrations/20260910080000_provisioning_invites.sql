-- 기관 초기등록 초대코드(Provisioning Invites): 정적 공유 토큰을 기관별 1회용
-- 초대코드로 교체한다.
--
-- 문제: /provision은 WELLLINK_PROVISIONING_TOKEN 하나로만 보호됐다. 이 토큰은
--   (1) 만료가 없고 (2) 1회용이 아니라 무제한 기관 생성이 가능하며
--   (3) 개별 취소가 불가능하고(회수하려면 전체 재배포)
--   (4) audit_logs의 actor가 "새로 만들어진 관리자 본인"이라 누가 만들었는지
--       추적할 수 없었다.
-- 그래서 초기등록 주소를 고객 기관에 그대로 배포할 수 없었다.
--
-- 원칙: "초대코드 1개 = 기관 1개." 공급자가 기관별로 코드를 발급하고, 그 코드는
-- 한 번 쓰이면 소멸한다. 기관코드(org_code)는 발급 시점에 공급자가 지정하며
-- 수신자는 바꿀 수 없다 -- org_code는 강사 로그인 입력값이라 선점/오타가 그대로
-- 장애가 되기 때문이다.
--
-- 기존 organizations / staff_profiles / principals 스키마는 건드리지 않는다
-- (organizations.is_supplier 컬럼 추가만).

-- ============================================================
-- 1. organizations.is_supplier -- 초대코드를 발급할 수 있는 공급자 기관
-- ============================================================
-- 초대 발급 권한을 "system admin"만으로 두면 고객 기관의 관리자도 새 기관을
-- 무제한 만들 수 있게 된다(권한 상승). 발급은 공급자 기관의 system admin으로만
-- 제한한다.
alter table public.organizations
  add column if not exists is_supplier boolean not null default false;

comment on column public.organizations.is_supplier is
  'WellLink 공급자 기관 여부. true인 기관의 system admin만 기관 초기등록 초대코드를 발급/취소할 수 있다.';

-- 실제 운영기관(= 공급자가 직접 쓰는 기관)을 공급자로 지정한다. 다른 기관은
-- default false 그대로다.
update public.organizations
set is_supplier = true
where id = '00000000-0000-0000-0000-000000000001'
  and is_supplier = false;

-- ============================================================
-- 2. provisioning_invites
-- ============================================================
-- code는 평문으로 저장한다. 공급자가 발급 후 기관 담당자에게 다시 안내해야 하는
-- 운영 요구가 있고(분실 재안내), 이 테이블은 RLS deny-all + service_role 전용이라
-- 클라이언트에서 직접 읽을 수 없다. 대신 단기 만료 + 1회용 + 개별 취소로 위험을
-- 낮춘다.
create table if not exists public.provisioning_invites (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  -- 발급 시점에 공급자가 지정하는 기관코드. 수신자는 수정할 수 없다.
  org_code text not null,
  -- 공급자 본인 확인용 메모(예: "○○노인복지관 2026 도입"). 수신자에게는
  -- 노출하지 않는다.
  label text,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_organization_id uuid references public.organizations (id) on delete set null,
  revoked_at timestamptz,
  issued_by_principal_id uuid not null references public.principals (id) on delete restrict,
  issuer_organization_id uuid not null references public.organizations (id) on delete restrict,
  created_at timestamptz not null default now()
);

-- organizations.org_code와 같은 형식을 쓴다(저장은 항상 소문자).
alter table public.provisioning_invites
  drop constraint if exists provisioning_invites_org_code_format;
alter table public.provisioning_invites
  add constraint provisioning_invites_org_code_format
    check (org_code ~ '^[a-z0-9][a-z0-9-]{2,31}$');

-- 혼동문자(I/L/O/0/1)를 뺀 charset을 4자씩 3그룹으로 끊은 형식. 전화로 불러줄 수
-- 있어야 해서 대문자 + 하이픈 고정이다.
alter table public.provisioning_invites
  drop constraint if exists provisioning_invites_code_format;
alter table public.provisioning_invites
  add constraint provisioning_invites_code_format
    check (code ~ '^[A-HJ-KMNP-Z2-9]{4}-[A-HJ-KMNP-Z2-9]{4}-[A-HJ-KMNP-Z2-9]{4}$');

create unique index if not exists provisioning_invites_code_key
  on public.provisioning_invites (code);

-- 같은 org_code로 살아있는(미사용 + 미취소) 초대가 둘 이상 존재하지 못하게 한다.
-- 만료된 것은 제외하지 않는다 -- 만료는 시간이 지나면 자동으로 바뀌는 값이라
-- 부분 인덱스 조건으로 쓰면 인덱스가 시간에 따라 달라지기 때문이다(immutable
-- 위반). 만료된 코드로 재발급하려면 먼저 취소하면 된다.
create unique index if not exists provisioning_invites_live_org_code_key
  on public.provisioning_invites (org_code)
  where used_at is null and revoked_at is null;

comment on table public.provisioning_invites is
  '기관 초기등록(/provision) 1회용 초대코드. 공급자 기관의 system admin만 발급/취소하며, 사용 즉시 used_at이 찍혀 재사용할 수 없다.';

-- RLS: 정책을 하나도 만들지 않는다. 이 테이블은 service_role(서버함수)만
-- 접근하며, anon/authenticated 클라이언트는 어떤 행도 읽거나 쓸 수 없다.
-- (/provision은 로그인 없이 열리는 공개 페이지이므로 코드 대조를 클라이언트에
--  절대 맡기지 않는다.)
alter table public.provisioning_invites enable row level security;

-- ============================================================
-- 3. is_supplier_admin() -- 발급 권한 헬퍼
-- ============================================================
-- is_system_admin()과 같은 패턴. 서버함수가 호출자 토큰으로 재검사하고, UI는
-- 탭 노출 여부를 정하는 데만 쓴다(UI는 신뢰 경계가 아니다).
create or replace function public.is_supplier_admin()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select coalesce((
    select sp.is_system_admin and o.is_supplier
    from public.staff_profiles sp
    join public.principals p on p.id = sp.principal_id
    join public.organizations o on o.id = p.organization_id
    where p.auth_user_id = auth.uid() and p.is_active = true
    limit 1
  ), false);
$$;

comment on function public.is_supplier_admin() is
  '공급자 기관(is_supplier=true)의 system admin 여부. 기관 초기등록 초대코드 발급/취소 권한.';

-- 20260910050651(Lovable 보안 일괄 수정) 이후 public 함수는 anon/PUBLIC 실행을
-- 막는 것이 기준이다. 새 함수는 default privilege로 PUBLIC 실행이 열리므로 직접 닫는다.
revoke all on function public.is_supplier_admin() from public, anon;
grant execute on function public.is_supplier_admin() to authenticated, service_role;
