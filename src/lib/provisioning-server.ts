import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

// 타 기관 즉시 도입 Readiness Gap Closure: 공급자 전용 기관 초기등록.
//
// "공급자 초기 프로비저닝 -> 기관 관리자 직접 초기설정" 모델(§1)의 첫 단계를
// 담당한다. 인증 방식은 정적 공유 토큰(WELLLINK_PROVISIONING_TOKEN)에서
// 기관별 1회용 초대코드로 교체됐다 -- 초기등록 주소를 고객 기관에 그대로
// 배포하려면 (a) 무제한 재사용 불가 (b) 만료 (c) 개별 취소 (d) 발급자 추적이
// 필요했기 때문이다. 자세한 배경은 20260910080000_provisioning_invites.sql.
//
// 신뢰 경계: 초대코드 대조와 발급 권한 검사는 전부 이 파일(서버) 안에서만
// 일어난다. /provision은 로그인 없이 열리는 공개 페이지이므로 클라이언트가
// 주장하는 어떤 값도(기관코드 포함) 그대로 믿지 않는다 -- 기관코드는 초대에
// 박혀 있는 값만 쓴다.
//
// 임시비밀번호는 이 파일 안에서만 생성되고 호출자에게 1회 반환된 뒤 어디에도
// 저장/로그되지 않는다(staff-management-server.ts와 동일한 원칙).

function getServerEnv() {
  // Lovable Publish 런타임은 SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY(prefix 없음)를
  // process.env로 주입한다 -- staff-management-server.ts와 동일한 fallback 순서.
  const supabaseUrl = process.env["VITE_SUPABASE_URL"] ?? process.env["SUPABASE_URL"];
  const anonKey =
    process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["VITE_SUPABASE_ANON_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      "서버 환경변수가 설정되지 않았습니다(Supabase URL / 공개 키 / service role key).",
    );
  }
  return { supabaseUrl, anonKey, serviceRoleKey };
}

function adminClient() {
  const { supabaseUrl, serviceRoleKey } = getServerEnv();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function callerScopedClient(accessToken: string) {
  const { supabaseUrl, anonKey } = getServerEnv();
  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const PASSWORD_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const PASSWORD_SYMBOLS = "!@#$%";
function generateTempPassword(): string {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  let base = "";
  for (let i = 0; i < 12; i++) base += PASSWORD_CHARS[bytes[i]! % PASSWORD_CHARS.length];
  const symbol = PASSWORD_SYMBOLS[bytes[12]! % PASSWORD_SYMBOLS.length];
  const insertAt = bytes[13]! % (base.length + 1);
  return base.slice(0, insertAt) + symbol + base.slice(insertAt);
}

// 혼동문자(I/L/O/0/1) 제외. 전화로 불러주거나 메일에 붙여넣는 코드라 대문자 4자
// 3그룹으로 끊는다. DB의 provisioning_invites_code_format check와 같은 charset.
const INVITE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateInviteCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) out += "-";
    out += INVITE_CHARS[bytes[i]! % INVITE_CHARS.length];
  }
  return out;
}

// 수신자는 코드를 소문자로 치거나 하이픈을 빼먹거나 공백을 붙여 넣는다. 저장
// 형식(대문자 + 하이픈)으로 정규화한 뒤에만 대조한다.
export function normalizeInviteCode(raw: string): string {
  const compact = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 12) return "";
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

const ORG_CODE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 초대코드가 유효하지 않은 모든 사유(없음/만료/사용됨/취소됨)를 하나의 문구로
// 뭉뚱그린다 -- 어떤 코드가 "존재는 한다"는 사실 자체를 흘리지 않기 위해서다.
const GENERIC_INVITE_ERROR = "사용할 수 없는 초대코드입니다. 발급처에 문의해 주세요.";
const GENERIC_AUTH_ERROR = "요청을 처리할 수 없습니다.";

type InviteRow = {
  id: string;
  code: string;
  org_code: string;
  label: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
};

function isInviteUsable(invite: InviteRow): boolean {
  if (invite.used_at || invite.revoked_at) return false;
  return new Date(invite.expires_at).getTime() > Date.now();
}

// ============================================================
// 1. 초대코드 조회 (공개 -- /provision 진입 시)
// ============================================================
// 수신자가 코드를 넣었을 때 "어느 기관코드로 만들어지는지"만 미리 보여준다.
// label(공급자 메모)은 절대 반환하지 않는다.
type LookupInviteResult =
  { ok: true; orgCode: string; expiresAt: string } | { ok: false; message: string };

export const lookupProvisioningInviteServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { code: string })
  .handler(async ({ data }): Promise<LookupInviteResult> => {
    const code = normalizeInviteCode(data?.code ?? "");
    if (!code) return { ok: false, message: GENERIC_INVITE_ERROR };

    let admin: ReturnType<typeof adminClient>;
    try {
      admin = adminClient();
    } catch {
      return { ok: false, message: GENERIC_AUTH_ERROR };
    }

    const { data: invite } = await admin
      .from("provisioning_invites")
      .select("id, code, org_code, label, expires_at, used_at, revoked_at")
      .eq("code", code)
      .maybeSingle<InviteRow>();

    if (!invite || !isInviteUsable(invite)) {
      return { ok: false, message: GENERIC_INVITE_ERROR };
    }
    return { ok: true, orgCode: invite.org_code, expiresAt: invite.expires_at };
  });

// ============================================================
// 2. 기관 초기등록 (공개 -- 초대코드 필요)
// ============================================================
type ProvisionOrganizationInput = {
  inviteCode: string;
  organizationName: string;
  adminName: string;
  adminEmail: string;
};
type ProvisionOrganizationResult =
  | { ok: true; organizationId: string; orgCode: string; tempPassword: string }
  | { ok: false; message: string };

export const provisionOrganizationServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as ProvisionOrganizationInput)
  .handler(async ({ data }): Promise<ProvisionOrganizationResult> => {
    const code = normalizeInviteCode(data.inviteCode ?? "");
    if (!code) return { ok: false, message: GENERIC_INVITE_ERROR };

    let admin: ReturnType<typeof adminClient>;
    try {
      admin = adminClient();
    } catch {
      // 환경변수 미설정 자체도 구체적으로 알려주지 않는다(정보 노출 최소화).
      return { ok: false, message: GENERIC_AUTH_ERROR };
    }

    const { data: invite } = await admin
      .from("provisioning_invites")
      .select("id, code, org_code, label, expires_at, used_at, revoked_at")
      .eq("code", code)
      .maybeSingle<InviteRow>();

    if (!invite || !isInviteUsable(invite)) {
      return { ok: false, message: GENERIC_INVITE_ERROR };
    }

    const organizationName = data.organizationName.trim();
    const adminName = data.adminName.trim();
    const adminEmail = data.adminEmail.trim().toLowerCase();
    // 기관코드는 클라이언트 입력을 쓰지 않는다 -- 초대에 박혀 있는 값만 쓴다.
    const organizationCode = invite.org_code;

    if (!organizationName || !adminName) {
      return { ok: false, message: "입력값이 올바르지 않습니다." };
    }
    if (!EMAIL_RE.test(adminEmail)) {
      return { ok: false, message: "이메일 형식이 올바르지 않습니다." };
    }

    const { data: existingOrg } = await admin
      .from("organizations")
      .select("id")
      .eq("name", organizationName)
      .maybeSingle();
    if (existingOrg) {
      return { ok: false, message: "이미 같은 이름의 기관이 등록되어 있습니다." };
    }

    const { data: existingCode } = await admin
      .from("organizations")
      .select("id")
      .eq("org_code", organizationCode)
      .maybeSingle();
    if (existingCode) {
      // 발급 시점에는 비어 있었는데 그 사이 같은 코드로 기관이 생긴 경우.
      // 수신자가 고칠 수 있는 문제가 아니므로 발급처로 보낸다.
      return { ok: false, message: "이 초대코드는 사용할 수 없습니다. 발급처에 문의해 주세요." };
    }

    // 코드를 먼저 선점(claim)한다. used_at is null 조건을 건 update가 실제로
    // 행을 바꿨을 때만 진행하므로, 두 사람이 같은 코드를 동시에 제출해도 한 쪽만
    // 통과한다. 이후 단계가 실패하면 아래 보상처리에서 다시 풀어준다.
    const { data: claimed } = await admin
      .from("provisioning_invites")
      .update({ used_at: new Date().toISOString() })
      .eq("id", invite.id)
      .is("used_at", null)
      .is("revoked_at", null)
      .select("id");
    if (!claimed || claimed.length === 0) {
      return { ok: false, message: GENERIC_INVITE_ERROR };
    }
    const releaseInvite = async () => {
      await admin
        .from("provisioning_invites")
        .update({ used_at: null, used_organization_id: null })
        .eq("id", invite.id);
    };

    const { data: org, error: orgError } = await admin
      .from("organizations")
      .insert({ name: organizationName, org_code: organizationCode })
      .select("id")
      .single();
    if (orgError || !org) {
      await releaseInvite();
      return { ok: false, message: `기관 생성 실패: ${orgError?.message ?? "unknown"}` };
    }

    const tempPassword = generateTempPassword();
    const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
      email: adminEmail,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { welllink_principal_type: "staff" },
    });
    if (createUserError || !createdUser.user) {
      // organizations는 아직 principal이 하나도 없어 다른 어떤 것도 참조하지 않으므로
      // 안전하게 되돌릴 수 있다(고아 auth user는 애초에 생기지 않았음).
      await admin.from("organizations").delete().eq("id", org.id);
      await releaseInvite();
      return {
        ok: false,
        message: createUserError?.message?.includes("already been registered")
          ? "이미 사용 중인 이메일입니다."
          : `관리자 계정 생성 실패: ${createUserError?.message ?? "unknown"}`,
      };
    }

    const { data: principal, error: principalError } = await admin
      .from("principals")
      .insert({
        organization_id: org.id,
        auth_user_id: createdUser.user.id,
        principal_type: "staff",
        name: adminName,
      })
      .select("id")
      .single();
    if (principalError || !principal) {
      // 보상처리: 방금 만든 auth user와 organization을 모두 되돌린다(부분성공 방지).
      await admin.auth.admin.deleteUser(createdUser.user.id).catch(() => {});
      await admin.from("organizations").delete().eq("id", org.id);
      await releaseInvite();
      return {
        ok: false,
        message: `관리자 계정 연결 실패: ${principalError?.message ?? "unknown"}`,
      };
    }

    const { error: profileError } = await admin.from("staff_profiles").insert({
      principal_id: principal.id,
      business_role: "global_manager",
      is_system_admin: true,
      must_change_password: true,
    });
    if (profileError) {
      await admin.from("principals").delete().eq("id", principal.id);
      await admin.auth.admin.deleteUser(createdUser.user.id).catch(() => {});
      await admin.from("organizations").delete().eq("id", org.id);
      await releaseInvite();
      return { ok: false, message: `관리자 권한 설정 실패: ${profileError.message}` };
    }

    // 선점 시점에는 아직 org가 없어 used_organization_id를 채울 수 없었다.
    // 여기서 연결해 "이 초대가 어느 기관이 됐는지"를 남긴다.
    await admin
      .from("provisioning_invites")
      .update({ used_organization_id: org.id })
      .eq("id", invite.id);

    await admin.from("audit_logs").insert({
      organization_id: org.id,
      actor_principal_id: principal.id,
      action: "provision_organization",
      entity_type: "organization",
      entity_id: org.id,
      after_json: { name: organizationName, org_code: organizationCode, invite_id: invite.id },
    });

    return { ok: true, organizationId: org.id, orgCode: organizationCode, tempPassword };
  });

// ============================================================
// 3. 초대코드 발급/조회/취소 (공급자 기관 system admin 전용)
// ============================================================
// 호출자 본인의 access token으로 is_supplier_admin()을 서버에서 재확인한다
// (클라이언트가 주장하는 권한을 신뢰하지 않는다 -- staff-management-server.ts와
// 동일한 패턴).
const INVITE_VALID_DAYS = 14;

async function requireSupplierAdmin(accessToken: string) {
  const callerClient = callerScopedClient(accessToken);
  const { data: isSupplierAdmin, error } = await callerClient.rpc("is_supplier_admin");
  if (error || isSupplierAdmin !== true) return null;

  const { data: userData } = await callerClient.auth.getUser();
  const authUserId = userData?.user?.id;
  if (!authUserId) return null;

  const admin = adminClient();
  const { data: principal } = await admin
    .from("principals")
    .select("id, organization_id")
    .eq("auth_user_id", authUserId)
    .eq("is_active", true)
    .maybeSingle<{ id: string; organization_id: string }>();
  if (!principal) return null;

  return { admin, principalId: principal.id, organizationId: principal.organization_id };
}

export type ProvisioningInviteRow = {
  id: string;
  code: string;
  orgCode: string;
  label: string | null;
  expiresAt: string;
  usedAt: string | null;
  usedOrganizationId: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: "active" | "used" | "revoked" | "expired";
};

function inviteStatus(r: {
  used_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}): ProvisioningInviteRow["status"] {
  if (r.used_at) return "used";
  if (r.revoked_at) return "revoked";
  if (new Date(r.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

type IssueInviteInput = { callerAccessToken: string; orgCode: string; label: string };
type IssueInviteResult =
  { ok: true; invite: ProvisioningInviteRow } | { ok: false; message: string };

export const issueProvisioningInviteServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as IssueInviteInput)
  .handler(async ({ data }): Promise<IssueInviteResult> => {
    let ctx: Awaited<ReturnType<typeof requireSupplierAdmin>>;
    try {
      ctx = await requireSupplierAdmin(data.callerAccessToken);
    } catch {
      return { ok: false, message: GENERIC_AUTH_ERROR };
    }
    if (!ctx) return { ok: false, message: "초대코드를 발급할 권한이 없습니다." };
    const { admin, principalId, organizationId } = ctx;

    const orgCode = (data.orgCode ?? "").trim().toLowerCase();
    const label = (data.label ?? "").trim() || null;
    if (!ORG_CODE_RE.test(orgCode)) {
      return { ok: false, message: "기관코드는 영문 소문자/숫자/하이픈 3~32자로 입력해 주세요." };
    }

    const { data: existingOrg } = await admin
      .from("organizations")
      .select("id")
      .eq("org_code", orgCode)
      .maybeSingle();
    if (existingOrg) {
      return { ok: false, message: "이미 사용 중인 기관코드입니다." };
    }

    const expiresAt = new Date(Date.now() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // code는 전역 unique다. 충돌 확률은 무시할 수준이지만(31^12), 충돌 시
    // 사용자에게 실패를 보여주는 대신 몇 번 다시 뽑는다.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: inserted, error } = await admin
        .from("provisioning_invites")
        .insert({
          code: generateInviteCode(),
          org_code: orgCode,
          label,
          expires_at: expiresAt,
          issued_by_principal_id: principalId,
          issuer_organization_id: organizationId,
        })
        .select(
          "id, code, org_code, label, expires_at, used_at, used_organization_id, revoked_at, created_at",
        )
        .single();

      if (!error && inserted) {
        await admin.from("audit_logs").insert({
          organization_id: organizationId,
          actor_principal_id: principalId,
          action: "issue_provisioning_invite",
          entity_type: "provisioning_invite",
          entity_id: inserted.id,
          // 코드 원문은 감사로그에 남기지 않는다(로그 열람만으로 초대를 쓸 수
          // 있게 되면 안 된다).
          after_json: { org_code: orgCode, label, expires_at: expiresAt },
        });
        return {
          ok: true,
          invite: {
            id: inserted.id,
            code: inserted.code,
            orgCode: inserted.org_code,
            label: inserted.label,
            expiresAt: inserted.expires_at,
            usedAt: inserted.used_at,
            usedOrganizationId: inserted.used_organization_id,
            revokedAt: inserted.revoked_at,
            createdAt: inserted.created_at,
            status: inviteStatus(inserted),
          },
        };
      }
      // 살아있는 초대가 이미 같은 기관코드로 있는 경우(부분 unique index).
      if (error?.message?.includes("provisioning_invites_live_org_code_key")) {
        return {
          ok: false,
          message:
            "이 기관코드로 아직 사용되지 않은 초대코드가 있습니다. 기존 초대를 취소한 뒤 다시 발급해 주세요.",
        };
      }
      if (!error?.message?.includes("provisioning_invites_code_key")) {
        return { ok: false, message: `초대코드 발급 실패: ${error?.message ?? "unknown"}` };
      }
    }
    return { ok: false, message: "초대코드 발급에 실패했습니다. 다시 시도해 주세요." };
  });

type ListInvitesResult =
  { ok: true; invites: ProvisioningInviteRow[] } | { ok: false; message: string };

export const listProvisioningInvitesServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { callerAccessToken: string })
  .handler(async ({ data }): Promise<ListInvitesResult> => {
    let ctx: Awaited<ReturnType<typeof requireSupplierAdmin>>;
    try {
      ctx = await requireSupplierAdmin(data.callerAccessToken);
    } catch {
      return { ok: false, message: GENERIC_AUTH_ERROR };
    }
    if (!ctx) return { ok: false, message: "초대코드를 조회할 권한이 없습니다." };

    const { data: rows, error } = await ctx.admin
      .from("provisioning_invites")
      .select(
        "id, code, org_code, label, expires_at, used_at, used_organization_id, revoked_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { ok: false, message: `조회 실패: ${error.message}` };

    return {
      ok: true,
      invites: (rows ?? []).map((r) => ({
        id: r.id,
        code: r.code,
        orgCode: r.org_code,
        label: r.label,
        expiresAt: r.expires_at,
        usedAt: r.used_at,
        usedOrganizationId: r.used_organization_id,
        revokedAt: r.revoked_at,
        createdAt: r.created_at,
        status: inviteStatus(r),
      })),
    };
  });

// 발급 화면에서 "이미 쓰이는 기관코드"를 미리 보여주기 위한 목록. 발급 시
// 중복 차단은 issueProvisioningInviteServerFn이 따로 하므로, 이 목록은 공급자가
// 발급 전에 이미 배정된 코드를 확인하는 용도다.
export type OrganizationCodeRow = {
  orgCode: string;
  name: string;
  isSupplier: boolean;
  createdAt: string;
};

type ListOrgCodesResult =
  { ok: true; organizations: OrganizationCodeRow[] } | { ok: false; message: string };

export const listOrganizationCodesServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { callerAccessToken: string })
  .handler(async ({ data }): Promise<ListOrgCodesResult> => {
    let ctx: Awaited<ReturnType<typeof requireSupplierAdmin>>;
    try {
      ctx = await requireSupplierAdmin(data.callerAccessToken);
    } catch {
      return { ok: false, message: GENERIC_AUTH_ERROR };
    }
    if (!ctx) return { ok: false, message: "기관코드 목록을 조회할 권한이 없습니다." };

    const { data: rows, error } = await ctx.admin
      .from("organizations")
      .select("org_code, name, is_supplier, created_at")
      .not("org_code", "is", null)
      .order("is_supplier", { ascending: false })
      .order("org_code", { ascending: true });
    if (error) return { ok: false, message: `조회 실패: ${error.message}` };

    return {
      ok: true,
      organizations: (rows ?? []).map((r) => ({
        orgCode: r.org_code as string,
        name: r.name,
        isSupplier: r.is_supplier === true,
        createdAt: r.created_at,
      })),
    };
  });

type RevokeInviteResult = { ok: true } | { ok: false; message: string };

export const revokeProvisioningInviteServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { callerAccessToken: string; inviteId: string })
  .handler(async ({ data }): Promise<RevokeInviteResult> => {
    let ctx: Awaited<ReturnType<typeof requireSupplierAdmin>>;
    try {
      ctx = await requireSupplierAdmin(data.callerAccessToken);
    } catch {
      return { ok: false, message: GENERIC_AUTH_ERROR };
    }
    if (!ctx) return { ok: false, message: "초대코드를 취소할 권한이 없습니다." };
    const { admin, principalId, organizationId } = ctx;

    // 이미 사용된 초대는 취소하지 않는다 -- 취소해도 만들어진 기관이 사라지지
    // 않으므로 이력만 왜곡된다.
    const { data: updated, error } = await admin
      .from("provisioning_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.inviteId)
      .is("used_at", null)
      .is("revoked_at", null)
      .select("id, org_code");
    if (error) return { ok: false, message: `취소 실패: ${error.message}` };
    if (!updated || updated.length === 0) {
      return { ok: false, message: "이미 사용되었거나 취소된 초대코드입니다." };
    }

    await admin.from("audit_logs").insert({
      organization_id: organizationId,
      actor_principal_id: principalId,
      action: "revoke_provisioning_invite",
      entity_type: "provisioning_invite",
      entity_id: data.inviteId,
      after_json: { org_code: updated[0]!.org_code },
    });

    return { ok: true };
  });
