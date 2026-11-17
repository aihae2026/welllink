import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";

// Pre-Final Gate: 직원 계정 lifecycle 서버 로직 (instructor-auth.ts와 동일한 패턴).
//
// 임시비밀번호 원문은 이 파일 안에서만 생성되고 호출자에게 한 번 반환된 뒤 어디에도
// 남지 않는다 -- DB(staff_profiles/audit_logs)에 저장하지 않고, 이 서버함수 자체도
// 값을 로그로 남기지 않는다(console.log 등 일절 사용하지 않음).

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

function callerScopedClient(accessToken: string) {
  const { supabaseUrl, anonKey } = getServerEnv();
  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

// 혼동되기 쉬운 문자(0/O, 1/l/I)를 제외한 안전한 charset. 12자 + 대소문자/숫자/기호
// 각 1개 이상을 강제해 실사용 가능한 임시비밀번호를 만든다.
const PASSWORD_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const PASSWORD_SYMBOLS = "!@#$%";

function generateTempPassword(): string {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  let base = "";
  for (let i = 0; i < 12; i++) {
    base += PASSWORD_CHARS[bytes[i]! % PASSWORD_CHARS.length];
  }
  const symbol = PASSWORD_SYMBOLS[bytes[12]! % PASSWORD_SYMBOLS.length];
  const insertAt = bytes[13]! % (base.length + 1);
  return base.slice(0, insertAt) + symbol + base.slice(insertAt);
}

// Supabase Auth Admin API가 이미 등록된 이메일에 대해 반환하는 에러를 판별한다.
// 버전별로 정확한 code 필드가 다를 수 있어(email_exists 등) 메시지/detail
// 키워드도 함께 확인한다 -- 어느 쪽이든 사용자에게는 raw 메시지 대신 친절한
// 한국어 문구로만 보여준다(§ Manual QA Gap Fix #2 5/6, Final QA Gap Fix §2).
//
// Final QA Gap Fix §2에서 발견: createUser의 중복 이메일은 AuthApiError(422,
// code="email_exists")로 명확히 오지만, updateUserById로 기존 계정 이메일을
// 중복값으로 바꿀 때는 GoTrue가 500을 반환하고 auth-js가 이를
// AuthRetryableFetchError로 감싸면서 code/detail이 전부 유실된다(message도
// "Error updating user"라는 고정 문구로 대체됨) -- 즉 이 함수가 아무리
// code/message/detail을 잘 판별해도 updateUserById 실패 케이스는 원천적으로
// 잡을 수 없다. 그래서 이메일 변경 경로는 이 함수에만 기대지 않고, 아래
// findAuthUserByEmail로 변경 시도 전에 미리 중복 여부를 직접 확인한다.
// 이 함수는 createUser 등 code/detail이 실제로 오는 다른 경로를 위해 그대로 둔다.
function isDuplicateEmailError(
  error: {
    code?: string | undefined;
    message?: string | undefined;
    detail?: string | undefined;
  } | null,
): boolean {
  if (!error) return false;
  if (error.code === "email_exists" || error.code === "23505") return true;
  const msg = (error.message ?? "").toLowerCase();
  const detail = (error.detail ?? "").toLowerCase();
  return (
    msg.includes("already") ||
    msg.includes("exist") ||
    msg.includes("registered") ||
    detail.includes("already") ||
    detail.includes("exist") ||
    detail.includes("duplicate")
  );
}

// updateUserById는 중복 이메일이어도 판별 가능한 에러를 주지 않으므로(위 주석
// 참고), 실제 변경을 시도하기 전에 해당 이메일을 쓰는 다른 계정이 이미
// 있는지 미리 확인한다. GoTrue admin REST의 `?email=` 쿼리 파라미터는 이
// 환경에서 무시되고 전체 목록을 그대로 반환함을 직접 확인했으므로(필터링
// 없이 아무 이메일이나 항상 "중복"으로 오판하는 실제 회귀를 만들 뻔했다),
// 대신 listUsers를 페이지네이션하며 정확히 일치하는 이메일만 클라이언트에서
// 직접 비교한다. read-only 조회이며 다른 업무데이터는 건드리지 않는다.
async function findAuthUserByEmail(
  admin: ReturnType<typeof adminClient>,
  email: string,
): Promise<{ id: string } | null> {
  const target = email.toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users) return null;
    const found = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (found) return { id: found.id };
    if (data.users.length < perPage) return null;
  }
  return null;
}

type ProvisionStaffInput = {
  callerAccessToken: string;
  organizationId: string;
  name: string;
  email: string;
  businessRole: "staff" | "department_manager" | "global_manager" | "global_viewer";
  isSystemAdmin: boolean;
};
type ProvisionStaffResult =
  { ok: true; principalId: string; tempPassword: string } | { ok: false; message: string };

// 직원 계정 생성. 호출자 본인의 access token으로 is_system_admin() 여부를 서버에서
// 재확인한다(클라이언트가 주장하는 권한을 신뢰하지 않는다).
export const provisionStaffServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as ProvisionStaffInput)
  .handler(async ({ data }): Promise<ProvisionStaffResult> => {
    const callerClient = callerScopedClient(data.callerAccessToken);

    const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("is_system_admin");
    if (adminCheckError || isAdmin !== true) {
      return { ok: false, message: "직원 계정을 생성할 권한이 없습니다." };
    }

    const email = data.email.trim().toLowerCase();
    if (!data.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, message: "입력값이 올바르지 않습니다." };
    }

    const admin = adminClient();
    const tempPassword = generateTempPassword();

    const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { welllink_principal_type: "staff" },
    });
    if (createUserError || !createdUser.user) {
      return {
        ok: false,
        message: isDuplicateEmailError(createUserError)
          ? "이미 등록된 이메일입니다."
          : "직원 계정 생성에 실패했습니다.",
      };
    }

    const { data: principalId, error: rpcError } = await callerClient.rpc("provision_staff", {
      p_organization_id: data.organizationId,
      p_auth_user_id: createdUser.user.id,
      p_name: data.name.trim(),
      p_business_role: data.businessRole,
      p_is_system_admin: data.isSystemAdmin,
    });

    if (rpcError || !principalId) {
      await admin.auth.admin.deleteUser(createdUser.user.id).catch(() => {});
      return { ok: false, message: `직원 계정 생성 실패: ${rpcError?.message ?? "unknown"}` };
    }

    return { ok: true, principalId: principalId as string, tempPassword };
  });

type ResetStaffPasswordInput = { callerAccessToken: string; principalId: string };
type ResetStaffPasswordResult = { ok: true; tempPassword: string } | { ok: false; message: string };

// 비밀번호 초기화. 새 임시비밀번호는 Auth Admin API로 즉시 덮어써 기존 비밀번호를
// 무효화하고, DB에는 must_change_password=true 플래그만 남긴다(mark_staff_password_reset).
// 대상 auth_user_id는 client가 주장하는 값을 받지 않고 principalId로 서버가 직접
// 조회한다(같은 조직 principal 조회 RLS를 그대로 사용 -- 타 조직 대상 지정 불가).
export const resetStaffPasswordServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as ResetStaffPasswordInput)
  .handler(async ({ data }): Promise<ResetStaffPasswordResult> => {
    const callerClient = callerScopedClient(data.callerAccessToken);

    const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("is_system_admin");
    if (adminCheckError || isAdmin !== true) {
      return { ok: false, message: "비밀번호를 초기화할 권한이 없습니다." };
    }

    const { data: principalRow, error: principalError } = await callerClient
      .from("principals")
      .select("auth_user_id, principal_type")
      .eq("id", data.principalId)
      .maybeSingle();
    if (principalError || !principalRow?.auth_user_id || principalRow.principal_type !== "staff") {
      return { ok: false, message: "대상 직원을 찾을 수 없습니다." };
    }

    const { error: rpcError } = await callerClient.rpc("mark_staff_password_reset", {
      p_principal_id: data.principalId,
    });
    if (rpcError) {
      return { ok: false, message: `비밀번호 초기화 실패: ${rpcError.message}` };
    }

    const admin = adminClient();
    const tempPassword = generateTempPassword();
    const { error: updateError } = await admin.auth.admin.updateUserById(
      principalRow.auth_user_id,
      {
        password: tempPassword,
      },
    );
    if (updateError) {
      return { ok: false, message: `비밀번호 초기화 실패: ${updateError.message}` };
    }

    return { ok: true, tempPassword };
  });

type UpdateStaffInfoInput = {
  callerAccessToken: string;
  principalId: string;
  name: string;
  email: string;
};
type UpdateStaffInfoResult = { ok: true } | { ok: false; message: string };

// 직원 이름/이메일 수정. 이메일은 principals/staff_profiles 어디에도 복사본을
// 두지 않고 auth.users를 유일한 source of truth로 그대로 쓰므로(목록 조회도
// auth.users를 join해서 보여준다), Auth 로그인 이메일과 앱이 보여주는 이메일이
// 애초에 서로 다른 값을 가질 수 없는 구조다 -- 두 곳을 각각 갱신하며 동기화를
// 맞추는 것이 아니다.
//
// 그래도 이메일(Auth Admin API) 변경과 이름(RPC) 변경은 별개의 두 호출이므로,
// 이메일을 먼저 바꾸고 그 다음 이름 RPC가 실패하면 이메일을 원래 값으로
// 되돌려(compensating action) 절반만 반영된 상태를 남기지 않는다.
export const updateStaffInfoServerFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as UpdateStaffInfoInput)
  .handler(async ({ data }): Promise<UpdateStaffInfoResult> => {
    const callerClient = callerScopedClient(data.callerAccessToken);

    const { data: isAdmin, error: adminCheckError } = await callerClient.rpc("is_system_admin");
    if (adminCheckError || isAdmin !== true) {
      return { ok: false, message: "직원 정보를 수정할 권한이 없습니다." };
    }

    const name = data.name.trim();
    const email = data.email.trim().toLowerCase();
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, message: "입력값이 올바르지 않습니다." };
    }

    const { data: principalRow, error: principalError } = await callerClient
      .from("principals")
      .select("auth_user_id, principal_type")
      .eq("id", data.principalId)
      .maybeSingle();
    if (principalError || !principalRow?.auth_user_id || principalRow.principal_type !== "staff") {
      return { ok: false, message: "대상 직원을 찾을 수 없습니다." };
    }

    const admin = adminClient();
    const { data: currentUser, error: getUserError } = await admin.auth.admin.getUserById(
      principalRow.auth_user_id,
    );
    if (getUserError || !currentUser.user?.email) {
      return { ok: false, message: "대상 직원 계정을 확인할 수 없습니다." };
    }
    const previousEmail = currentUser.user.email;
    const emailChanged = email !== previousEmail.toLowerCase();

    if (emailChanged) {
      const existing = await findAuthUserByEmail(admin, email);
      if (existing && existing.id !== principalRow.auth_user_id) {
        return { ok: false, message: "이미 다른 사용자가 사용 중인 이메일입니다." };
      }

      const { error: emailError } = await admin.auth.admin.updateUserById(
        principalRow.auth_user_id,
        { email },
      );
      if (emailError) {
        return {
          ok: false,
          message: isDuplicateEmailError(emailError)
            ? "이미 다른 사용자가 사용 중인 이메일입니다."
            : "이메일 변경에 실패했습니다.",
        };
      }
    }

    const { error: nameError } = await callerClient.rpc("update_staff_info", {
      p_principal_id: data.principalId,
      p_name: name,
    });
    if (nameError) {
      if (emailChanged) {
        // 이름 변경 실패로 전체를 실패 처리하니, 방금 바꾼 이메일을 원상복구해
        // "이메일만 바뀌고 이름은 안 바뀐" 불일치 상태를 남기지 않는다.
        await admin.auth.admin
          .updateUserById(principalRow.auth_user_id, { email: previousEmail })
          .catch(() => {});
      }
      return { ok: false, message: `이름 변경 실패: ${nameError.message}` };
    }

    return { ok: true };
  });
