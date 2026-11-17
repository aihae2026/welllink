import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

// 강사 로그인/계정생성 서버 로직.
//
// 강사는 이름 + 휴대전화 뒤4자리 + PIN만 입력한다(처음에는 관리자가 발급한 6자리 시작코드를
// PIN 자리에 넣고, 그 로그인 때 6자리 새 PIN을 만들어야 세션이 발급된다). 그런데 현재 RLS는
// auth.uid() 기준이므로 강사도 로그인 이후에는 실제 Supabase Auth session이
// 있어야 한다. 임의 custom JWT를 직접 서명하지 않고, 공식 Admin API
// (generateLink + verifyOtp)만 사용해 안전하게 session을 발급한다.
//
// 이 파일의 모든 함수는 createServerFn().handler() 안에서만 service_role key를
// 사용한다 -- service_role key는 클라이언트 번들에 절대 포함되지 않는다
// (handler 밖 최상위에서 이 값을 읽거나 export하지 않는다).

function getServerEnv() {
  // Lovable Publish 런타임은 SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY(prefix 없음)를
  // process.env로 주입한다 -- src/lib/supabase.ts와 동일한 fallback 순서.
  const supabaseUrl = process.env["VITE_SUPABASE_URL"] ?? process.env["SUPABASE_URL"];
  const anonKey =
    process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["VITE_SUPABASE_ANON_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error("서버 환경변수가 설정되지 않았습니다(Supabase URL / 공개 키 / service role key).");
  }
  return { supabaseUrl, anonKey, serviceRoleKey };
}

function adminClient() {
  const { supabaseUrl, serviceRoleKey } = getServerEnv();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// 기관코드 정규화. DB에는 항상 소문자로 저장하므로(20260910040000 migration),
// 강사가 대문자로 입력하거나 앞뒤 공백을 붙여도 같은 기관으로 resolve된다.
// 형식이 아예 다르면 빈 문자열을 돌려주고, 호출한 쪽은 "찾을 수 없음"과 동일하게
// 처리한다(기관 존재 여부를 따로 알려주지 않는다).
function normalizeOrgCode(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,31}$/.test(code) ? code : "";
}

function anonClient() {
  const { supabaseUrl, anonKey } = getServerEnv();
  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type ResolveOrgInput = { orgCode: string };
type ResolveOrgResult = { ok: true; orgCode: string; name: string } | { ok: false };

// /instructor/login?org=<코드> 로 들어왔을 때, 기관코드가 실제 organization으로
// resolve되는지 확인하고 화면에 보여줄 기관명만 돌려준다. 기관 "목록"은 절대
// 반환하지 않는다 -- 정확한 코드를 이미 아는 경우에만 그 기관 하나가 확인된다.
//
// 이 결과는 표시(UX)용일 뿐이며 인증 근거가 아니다. 실제 인증은 아래 함수들이
// 기관코드를 다시 서버에서 resolve해 organization_id scope로 처리한다.
export const resolveInstructorOrgServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as ResolveOrgInput)
  .handler(async ({ data }): Promise<ResolveOrgResult> => {
    const orgCode = normalizeOrgCode(data.orgCode);
    if (!orgCode) return { ok: false };

    const admin = adminClient();
    const { data: org, error } = await admin
      .from("organizations")
      .select("org_code, name")
      .eq("org_code", orgCode)
      .maybeSingle();
    if (error || !org) return { ok: false };
    return { ok: true, orgCode: org.org_code as string, name: org.name as string };
  });

type InstructorLoginOrg = { orgCode: string; name: string };
type ListInstructorLoginOrgsResult =
  | { ok: true; orgs: InstructorLoginOrg[] }
  | { ok: false };

// 강사 로그인 드롭다운용 기관 목록. 제품 결정으로 기관명 공개를 감수하되,
// instructor_login_listed=false인 기관(QA/테스트/dev)은 절대 내려보내지 않는다.
// 기관명과 기관코드만 반환한다 -- organization id(UUID)나 다른 컬럼은 노출하지
// 않는다. 기관코드는 선택값으로만 쓰이며, 인증은 여전히 서버가 기관코드를 다시
// resolve해 organization_id 범위 안에서만 처리한다.
export const listInstructorLoginOrgsServerFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ListInstructorLoginOrgsResult> => {
    try {
      const admin = adminClient();
      const { data, error } = await admin
        .from("organizations")
        .select("org_code, name")
        .eq("instructor_login_listed", true)
        .order("name");
      if (error || !data) return { ok: false };
      return {
        ok: true,
        orgs: data.map((o) => ({ orgCode: o.org_code as string, name: o.name as string })),
      };
    } catch {
      return { ok: false };
    }
  },
);

type InstructorLoginInput = { orgCode: string; name: string; phoneLast4: string; pin: string };
// mustSetPin=true: 자격증명은 맞지만 아직 6자리 새 PIN을 만들지 않은 계정이다.
// 이 경우 세션(토큰)을 발급하지 않는다 -- 새 PIN을 만들기 전에는 앱을 쓸 수 없다.
// code_expired: 시작코드가 맞지만 사용 기간(7일)이 지났거나 쓸 수 없게 된 경우, 또는 시작코드가 아직
// 발급되지 않은 계정에서 예전 최초 PIN(뒤 4자리)을 넣은 경우. 관리자에게 새 코드를 받으면 된다.
type InstructorLoginResult =
  | { ok: true; mustSetPin: false; accessToken: string; refreshToken: string }
  | { ok: true; mustSetPin: true }
  | { ok: false; reason: "invalid" | "locked" | "code_expired" };

// 로그인 PIN 형식: 6자리 시작코드·새 6자리 PIN과 기존 4~5자리 PIN을 모두 받는다.
const LOGIN_PIN_PATTERN = /^[0-9]{4,6}$/;

// 이름/뒤4자리/PIN 중 어느 단계에서 실패했는지는 절대 구분해서 알려주지 않는다
// (계정탐색 방지) -- "locked"만 예외적으로 구분한다. 사용자가 15분을 기다려야
// 한다는 사실 자체는 정상적으로 알아야 하는 정보이지, 자격증명 중 무엇이
// 틀렸는지를 드러내는 정보가 아니기 때문이다.
export const instructorLoginServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as InstructorLoginInput)
  .handler(async ({ data }): Promise<InstructorLoginResult> => {
    // 기관코드가 비어있거나 형식이 틀리면 DB까지 가지 않는다. 클라이언트가 보낸
    // org 값을 그대로 신뢰하지 않고, 아래 RPC가 서버에서 다시 organization으로
    // resolve한 뒤 그 organization_id 안에서만 강사를 찾는다.
    const orgCode = normalizeOrgCode(data.orgCode);
    if (!orgCode) {
      return { ok: false, reason: "invalid" };
    }
    if (typeof data.pin !== "string" || !LOGIN_PIN_PATTERN.test(data.pin)) {
      return { ok: false, reason: "invalid" };
    }

    const admin = adminClient();

    const { data: rows, error } = await admin.rpc("verify_instructor_login", {
      p_org_code: orgCode,
      p_name: data.name,
      p_phone_last4: data.phoneLast4,
      p_pin: data.pin,
    });

    if (error) {
      if (error.message?.includes("LOCKED")) {
        return { ok: false, reason: "locked" };
      }
      if (error.message?.includes("START_CODE_EXPIRED")) {
        return { ok: false, reason: "code_expired" };
      }
      return { ok: false, reason: "invalid" };
    }

    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) {
      return { ok: false, reason: "invalid" };
    }

    // 아직 6자리 새 PIN을 만들지 않은 계정은 세션을 주지 않고 PIN 설정 단계로 보낸다.
    if (row.pin_confirmed !== true) {
      return { ok: true, mustSetPin: true };
    }

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(
      row.auth_user_id,
    );
    if (userError || !userData.user?.email) {
      return { ok: false, reason: "invalid" };
    }

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: userData.user.email,
    });
    const hashedToken = linkData?.properties?.hashed_token;
    if (linkError || !hashedToken) {
      return { ok: false, reason: "invalid" };
    }

    const anon = anonClient();
    const { data: otpData, error: otpError } = await anon.auth.verifyOtp({
      type: "magiclink",
      token_hash: hashedToken,
    });
    if (otpError || !otpData.session) {
      return { ok: false, reason: "invalid" };
    }

    return {
      ok: true,
      mustSetPin: false,
      accessToken: otpData.session.access_token,
      refreshToken: otpData.session.refresh_token,
    };
  });

type ProvisionInstructorInput = {
  callerAccessToken: string;
  organizationId: string;
  name: string;
  phoneLast4: string;
};
// startCode는 지금 한 번만 관리자 화면에 보여 주는 값이다. 서버 로그·오류 메시지에 절대 남기지 않는다.
type ProvisionInstructorResult =
  | { ok: true; principalId: string; startCode: string; expiresAt: string }
  | { ok: false; message: string };

// 강사 계정 생성. 일반 직원 브라우저가 임의로 호출할 수 없도록, 호출자 본인의
// access token으로 is_system_admin() 여부를 먼저 서버에서 재확인한다
// (클라이언트가 "나는 관리자다"라고 주장하는 값은 신뢰하지 않는다).
//
// 관리자는 PIN을 지정하지 않는다 -- 생성 직후 DB가 무작위 6자리 시작코드를 만들어 돌려주고
// (7일 유효, 1회용, pin_confirmed=false), 관리자는 그 코드를 강사에게 전한다. 강사는 시작코드로
// 로그인한 뒤 6자리 새 PIN을 만들어야 한다(아래 instructorSetPinServerFn, 현재 PIN을 함께
// 검증). 그 전에는 세션이 발급되지 않는다. 휴대전화 뒤4자리는 더 이상 최초 PIN이 아니다.
// 20261105010000_instructor_start_code_add.sql, 20261105020000_instructor_start_code_enforce.sql,
// 20261104010000_instructor_login_attempt_limits_and_pin_change_auth.sql 참고.
export const provisionInstructorServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as ProvisionInstructorInput)
  .handler(async ({ data }): Promise<ProvisionInstructorResult> => {
    const { supabaseUrl, anonKey } = getServerEnv();
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${data.callerAccessToken}` } },
    });

    const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("is_system_admin");
    if (adminCheckError || isAdmin !== true) {
      return { ok: false, message: "강사 계정을 생성할 권한이 없습니다." };
    }

    if (!/^[0-9]{4}$/.test(data.phoneLast4) || !data.name.trim()) {
      return { ok: false, message: "입력값이 올바르지 않습니다." };
    }

    const admin = adminClient();

    // 자연키(같은 조직 + 이름 + 뒤4자리) 기준 idempotency: 이미 생성된 강사가
    // 있으면 새 Auth user를 만들지 않고 기존 principal을 그대로 반환한다.
    const { data: existing } = await callerClient
      .from("instructor_profiles")
      .select("principal_id, principals!inner(name, organization_id)")
      .eq("phone_last4", data.phoneLast4)
      .eq("principals.organization_id", data.organizationId)
      .eq("principals.name", data.name.trim());
    if (existing && existing.length > 0 && existing[0]) {
      // 이미 있는 강사에게는 새 코드를 몰래 만들지 않는다. 관리자가 상세 화면에서 재발급한다.
      return {
        ok: false,
        message:
          "이미 같은 이름과 휴대전화 뒤 4자리의 강사가 있습니다. 강사 상세에서 시작코드를 다시 발급해 주세요.",
      };
    }

    // 실제 이메일처럼 보이지 않는, 명백한 내부 auth identifier 형식.
    const syntheticEmail = `instructor-${crypto.randomUUID()}@auth.internal.invalid`;

    const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      email_confirm: true,
      user_metadata: { welllink_principal_type: "instructor" },
    });
    if (createUserError || !createdUser.user) {
      return {
        ok: false,
        message: `강사 인증계정 생성 실패: ${createUserError?.message ?? "unknown"}`,
      };
    }

    // 강사 등록과 시작코드 발급을 DB가 한 트랜잭션으로 처리한다(뒤 4자리가 유효한 순간이 없다).
    const { data: rows, error: rpcError } = await callerClient.rpc(
      "provision_instructor_with_start_code",
      {
        p_organization_id: data.organizationId,
        p_auth_user_id: createdUser.user.id,
        p_name: data.name.trim(),
        p_phone_last4: data.phoneLast4,
      },
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;

    if (rpcError || !row?.out_principal_id || !row.out_code) {
      // compensating cleanup: DB row가 생기지 않았으면 방금 만든 Auth user도 정리한다.
      await admin.auth.admin.deleteUser(createdUser.user.id).catch(() => {});
      return { ok: false, message: `강사 계정 생성 실패: ${rpcError?.message ?? "unknown"}` };
    }

    return {
      ok: true,
      principalId: row.out_principal_id as string,
      startCode: row.out_code as string,
      expiresAt: row.out_expires_at as string,
    };
  });

type InstructorSetPinInput = {
  orgCode: string;
  name: string;
  phoneLast4: string;
  currentPin: string;
  newPin: string;
};
type InstructorSetPinResult =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; reason: "invalid" | "already_set" | "locked" | "weak" | "code_expired" };

// 로그인 단계에서 mustSetPin=true를 받은 강사가 6자리 새 PIN을 만들 때 호출된다.
// 현재 PIN(관리자가 발급한 시작코드 또는 기존 PIN)을 함께 받아 서버가 다시 검증한다 --
// 이름과 뒤4자리만 알아서는 PIN을 바꿀 수 없다. 현재 PIN이 틀리면 로그인과 똑같이
// 실패 횟수가 집계되고 잠긴다. 성공하면 로그인과 동일한 방식(magiclink + verifyOtp)으로
// 세션 토큰을 처음 발급한다(이 전까지는 세션이 없다).
export const instructorSetPinServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as InstructorSetPinInput)
  .handler(async ({ data }): Promise<InstructorSetPinResult> => {
    if (typeof data.newPin !== "string" || !/^[0-9]{6}$/.test(data.newPin)) {
      return { ok: false, reason: "invalid" };
    }
    if (typeof data.currentPin !== "string" || !LOGIN_PIN_PATTERN.test(data.currentPin)) {
      return { ok: false, reason: "invalid" };
    }

    const orgCode = normalizeOrgCode(data.orgCode);
    if (!orgCode) {
      return { ok: false, reason: "invalid" };
    }

    const admin = adminClient();
    const { data: rows, error } = await admin.rpc("set_instructor_pin", {
      p_org_code: orgCode,
      p_name: data.name,
      p_phone_last4: data.phoneLast4,
      p_current_pin: data.currentPin,
      p_new_pin: data.newPin,
    });

    if (error) {
      if (error.message?.includes("LOCKED")) {
        return { ok: false, reason: "locked" };
      }
      if (error.message?.includes("ALREADY_SET")) {
        return { ok: false, reason: "already_set" };
      }
      if (error.message?.includes("PIN_WEAK")) {
        return { ok: false, reason: "weak" };
      }
      if (error.message?.includes("START_CODE_EXPIRED")) {
        return { ok: false, reason: "code_expired" };
      }
      return { ok: false, reason: "invalid" };
    }

    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return { ok: false, reason: "invalid" };

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(
      row.out_auth_user_id,
    );
    if (userError || !userData.user?.email) {
      return { ok: false, reason: "invalid" };
    }

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: userData.user.email,
    });
    const hashedToken = linkData?.properties?.hashed_token;
    if (linkError || !hashedToken) {
      return { ok: false, reason: "invalid" };
    }

    const anon = anonClient();
    const { data: otpData, error: otpError } = await anon.auth.verifyOtp({
      type: "magiclink",
      token_hash: hashedToken,
    });
    if (otpError || !otpData.session) {
      return { ok: false, reason: "invalid" };
    }

    return {
      ok: true,
      accessToken: otpData.session.access_token,
      refreshToken: otpData.session.refresh_token,
    };
  });
