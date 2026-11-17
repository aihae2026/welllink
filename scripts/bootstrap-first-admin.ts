// 최초 시스템 관리자 부트스트랩 스크립트.
//
// provision_staff RPC는 "호출자가 이미 system_admin이어야 한다"는 조건이 있어
// 최초 1명은 그 RPC로 만들 수 없다(닭과 달걀 문제). 이 스크립트는 그 최초 1명만
// service_role 권한으로 직접 만든다. 이후 직원/강사는 반드시 이 계정으로 로그인해
// 화면(설정 > 사용자 관리)에서 생성한다 -- 이 스크립트를 다시 쓰지 않는다.
//
// 반드시 사용자 본인이 본인 터미널에서 직접 실행한다(Claude에게 실행을 맡기거나
// 실제 이름/이메일을 채팅에 붙여넣지 않는다). 출력되는 임시비밀번호도 본인만 본다.
//
// 실행: bun run scripts/bootstrap-first-admin.ts

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { createInterface } from "readline/promises";

function loadEnvLocal() {
  const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]!] = m[2]!.trim();
  }
  return env;
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

const ORG_ID = "00000000-0000-0000-0000-000000000001";

async function main() {
  const env = loadEnvLocal();
  const url = env["VITE_SUPABASE_URL"];
  const serviceKey = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !serviceKey) {
    console.error(".env.local에 VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 필요합니다.");
    process.exit(1);
  }
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // 다른(테스트) 조직의 system_admin은 이 판단에 영향을 주면 안 되므로 실제 조직으로
  // 스코프를 좁혀서 확인한다.
  const { data: existingAdmins, error: countError } = await admin
    .from("principals")
    .select("id, staff_profiles!inner(is_system_admin)")
    .eq("organization_id", ORG_ID)
    .eq("staff_profiles.is_system_admin", true);
  if (countError) {
    console.error("기존 관리자 확인 실패:", countError.message);
    process.exit(1);
  }
  if ((existingAdmins?.length ?? 0) > 0) {
    console.error("이미 실제 조직에 system_admin 계정이 존재합니다. 이 스크립트는 최초 1회만 사용합니다.");
    console.error("추가 직원 계정은 반드시 웹 화면(설정 > 사용자 관리)에서 생성해 주세요.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const name = (await rl.question("최초 관리자 실명: ")).trim();
  const email = (await rl.question("최초 관리자 실제 이메일: ")).trim().toLowerCase();
  rl.close();

  if (!name) {
    console.error("이름이 비어 있습니다.");
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("이메일 형식이 올바르지 않습니다.");
    process.exit(1);
  }

  const tempPassword = generateTempPassword();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { welllink_principal_type: "staff" },
  });
  if (createErr || !created.user) {
    console.error("Auth 계정 생성 실패:", createErr?.message ?? "unknown");
    process.exit(1);
  }

  const { data: principal, error: principalErr } = await admin
    .from("principals")
    .insert({
      organization_id: ORG_ID,
      auth_user_id: created.user.id,
      principal_type: "staff",
      name,
    })
    .select("id")
    .single();
  if (principalErr || !principal) {
    console.error("principal 생성 실패:", principalErr?.message ?? "unknown");
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
    process.exit(1);
  }

  const { error: profileErr } = await admin.from("staff_profiles").insert({
    principal_id: principal.id,
    business_role: "global_manager",
    is_system_admin: true,
    must_change_password: true,
  });
  if (profileErr) {
    console.error("staff_profiles 생성 실패:", profileErr.message);
    process.exit(1);
  }

  await admin.from("audit_logs").insert({
    organization_id: ORG_ID,
    actor_principal_id: principal.id,
    action: "bootstrap_first_admin",
    entity_type: "principal",
    entity_id: principal.id,
    after_json: { name, business_role: "global_manager", is_system_admin: true },
  });

  console.log("");
  console.log("=== 최초 관리자 계정 생성 완료 (아래 정보는 본인만 확인하세요) ===");
  console.log("이메일:", email);
  console.log("임시비밀번호:", tempPassword);
  console.log("http://localhost:8080/login 에서 위 정보로 로그인 후, 비밀번호 변경 화면이 뜨면 새 비밀번호로 바꿔 주세요.");
  console.log("이후 직원/강사 계정은 로그인 후 [설정 > 사용자 관리] 화면에서 생성하시면 됩니다.");
}

main();
