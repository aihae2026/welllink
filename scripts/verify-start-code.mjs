// 강사 시작코드 시험: 운영 DB와 무관한 임시 DB(PGlite)에서 시작코드 발급·로그인·만료·재발급·반복 실패·
// 타기관 차단·복구(롤백)를 단계별로 확인한다.
//
// 순서(실제 운영 반영 순서와 같다)
//   0. 시작코드 이전 상태(migrations 20261105010000 미만)를 만들고, 옛 방식의 강사 계정을 심어 둔다.
//   1. 20261105010000(추가) 적용 -> 기존 로그인이 그대로인지, 발급 기능이 동작하는지
//   2. 20261105020000(강제) 적용 -> 옛 뒤 4자리 경로가 닫혔는지, 만료·20회 실패·잠금이 동작하는지
//   3. 두 파일이 바꾼 것 이외의 함수·정책·열이 그대로인지(출석·실적·직원 로그인 등)
//   4. 롤백(강제 -> 추가 순서)이 옛 방식을 다시 열지 않는지, 롤백 뒤 재적용이 되는지
//
// Docker나 Supabase 계정 없이 PGlite로 실행한다. Supabase 고유 기능(pgcrypto, auth 스키마, pg_cron, 역할)은
// 같은 모양의 대용품으로 바꿔 둔 것이라, "SQL 논리가 맞는지"를 확인할 뿐 실제 Supabase 프로젝트의 결과를
// 대신하지 않는다. 특히 (a) 암호용 난수의 품질, (b) 두 요청이 정말 동시에 들어올 때의 행 잠금,
// (c) auth.sessions 삭제 권한은 이 시험으로 확인하지 못한다.
//
// 실행:
//   npm install --no-save @electric-sql/pglite@0.3.14   (프로젝트 폴더 밖 임시 폴더에서 설치해도 된다)
//   node scripts/verify-start-code.mjs [migrations 폴더] [rollback 폴더]
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migDir = process.argv[2] ?? path.join(here, "..", "supabase", "migrations");
const rbDir = process.argv[3] ?? path.join(here, "..", "supabase", "rollback");
const ADD = "20261105010000_instructor_start_code_add";
const ENF = "20261105020000_instructor_start_code_enforce";

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log("PASS", n)) : (fail++, console.log("FAIL", n, x)); };
const q = async (s, p) => (await db.query(s, p)).rows;
const tryQ = async (s, p) => { try { return { rows: await q(s, p) }; } catch (e) { return { err: String(e.message) }; } };
const wrongOf = (c) => (c === "123450" ? "123451" : "123450");
const section = (t) => console.log(`\n── ${t}`);

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema extensions; create schema auth; create schema cron;
  create function extensions.gen_salt(t text, n int default 6) returns text language sql as $$ select substr(md5(random()::text),1,8) $$;
  create function extensions.crypt(pw text, salt text) returns text language sql immutable as $$ select substr(salt,1,8)||md5(substr(salt,1,8)||pw) $$;
  create function extensions.gen_random_bytes(n int) returns bytea language sql volatile as $$ select decode(substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 2 * n), 'hex') $$;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, created_at timestamptz default now());
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table cron.job (jobid serial primary key, jobname text, schedule text, command text, active boolean default true);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid::bigint $$;
  create function cron.unschedule(job_name text) returns boolean language sql as $$ with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
`);

const stripExt = (sql) => sql
  .replace(/create extension if not exists pg_cron with schema pg_catalog;/gi, "")
  .replace(/create extension if not exists pgcrypto with schema extensions;/gi, "");
const applyFile = async (dir, name) => db.exec(stripExt(fs.readFileSync(path.join(dir, `${name}.sql`), "utf8")));

// ── 0. 시작코드 이전 상태
section("0. 시작코드 이전 상태 만들기");
const all = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();
const before = all.filter((n) => n < ADD);
let okApply = true;
for (const n of before) { try { await applyFile(migDir, n); } catch (e) { okApply = false; console.log("FAIL apply", n, String(e.message).split("\n")[0]); break; } }
ok(`${ADD} 이전 마이그레이션 ${before.length}개 적용`, okApply);
ok("추가·강제 파일이 목록에 있다", all.includes(ADD) && all.includes(ENF));

const sub = (uid) => db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
await db.exec(`insert into public.organizations (id, name, org_code) values ('${ORG_A}', '가기관', 'orga'), ('${ORG_B}', '나기관', 'orgb')`);

async function mkStaff(org, email, name, { admin }) {
  const [u] = await q(`insert into auth.users (email) values ($1) returning id`, [email]);
  const [p] = await q(`insert into public.principals (organization_id, auth_user_id, principal_type, name) values ($1, $2, 'staff', $3) returning id`, [org, u.id, name]);
  await q(`insert into public.staff_profiles (principal_id, business_role, is_system_admin, must_change_password) values ($1, $2, $3, false)`, [p.id, admin ? "global_manager" : "staff", admin]);
  return { uid: u.id, pid: p.id };
}
const adminA = await mkStaff(ORG_A, "admin-a@test.example", "가관리자", { admin: true });
const staffA = await mkStaff(ORG_A, "staff-a@test.example", "가직원", { admin: false });
const adminB = await mkStaff(ORG_B, "admin-b@test.example", "나관리자", { admin: true });

// 옛 방식 provision_instructor로 강사 심기 (관리자 로그인 상태에서)
async function mkInstructorOld(org, adminUid, name, last4) {
  await sub(adminUid);
  const [u] = await q(`insert into auth.users (email) values ($1) returning id`, [`inst-${name}-${last4}@auth.internal.invalid`]);
  const r = await tryQ(`select public.provision_instructor($1, $2, $3, $4) as id`, [org, u.id, name, last4]);
  return { uid: u.id, pid: r.rows?.[0]?.id, err: r.err };
}
const keep = await mkInstructorOld(ORG_A, adminA.uid, "기존강사", "1111");   // 이미 6자리 PIN을 만든 강사
const unset = await mkInstructorOld(ORG_A, adminA.uid, "미설정강사", "2222"); // 아직 PIN을 안 만든 강사(뒤 4자리 해시)
await sub(null);
const login = (org, name, last4, pin) => tryQ(`select * from public.verify_instructor_login($1,$2,$3,$4)`, [org, name, last4, pin]);
const setPin = (org, name, last4, cur, next) => tryQ(`select * from public.set_instructor_pin($1,$2,$3,$4,$5)`, [org, name, last4, cur, next]);
const kind = (r) => (r.err ? `ERR:${r.err.replace(/^error:\s*/i, "").split("\n")[0]}` : r.rows.length ? "OK" : "EMPTY");

let r = await setPin("orga", "기존강사", "1111", "1111", "482915");
ok("(사전) 기존 강사가 6자리 PIN을 만든 상태", kind(r) === "OK", kind(r));
const [keepHashBefore] = await q(`select pin_hash from public.instructor_profiles where principal_id = $1`, [keep.pid]);

// 변경 전 스냅샷(함수 정의·정책·열)
const snapFns = async () => Object.fromEntries((await q(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k, md5(pg_get_functiondef(p.oid)) as h from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).map((x) => [x.k, x.h]));
const snapPolicies = async () => (await q(`select tablename || ':' || policyname || ':' || coalesce(qual,'') || ':' || coalesce(with_check,'') as v from pg_policies where schemaname='public' order by 1`)).map((x) => x.v);
const snapCols = async () => (await q(`select table_name || '.' || column_name || ':' || data_type as v from information_schema.columns where table_schema='public' order by 1`)).map((x) => x.v);
const fnsBefore = await snapFns(), polBefore = await snapPolicies(), colsBefore = await snapCols();

// ── 1. 추가 마이그레이션
section("1. 추가 마이그레이션(20261105010000) 적용 직후");
try { await applyFile(migDir, ADD); ok("추가 마이그레이션 적용", true); } catch (e) { ok("추가 마이그레이션 적용", false, String(e.message).split("\n")[0]); }

ok("기존 강사: 기존 PIN으로 그대로 로그인", kind(await login("orga", "기존강사", "1111", "482915")) === "OK");
r = await login("orga", "미설정강사", "2222", "2222");
ok("(이 단계는 설계상 변경 없음) 미설정 강사의 옛 뒤 4자리는 아직 통과", kind(r) === "OK" && r.rows[0].pin_confirmed === false, kind(r));
ok("기존 강사의 PIN 해시가 바뀌지 않았다", (await q(`select pin_hash from public.instructor_profiles where principal_id = $1`, [keep.pid]))[0].pin_hash === keepHashBefore.pin_hash);

// 관리자가 미설정 강사에게 시작코드 발급
await sub(adminA.uid);
r = await tryQ(`select * from public.issue_instructor_start_code($1)`, [unset.pid]);
ok("관리자가 시작코드 발급", kind(r) === "OK", kind(r));
const code1 = r.rows?.[0]?.out_code;
ok("시작코드는 숫자 6자리", /^[0-9]{6}$/.test(code1 ?? ""), String(code1));
const days = r.rows?.[0] ? (new Date(r.rows[0].out_expires_at) - Date.now()) / 86400000 : 0;
ok("유효기간은 7일", days > 6.99 && days <= 7.0001, String(days));
await sub(null);

const [prof1] = await q(`select pin_hash, pin_confirmed, start_code_expires_at from public.instructor_profiles where principal_id = $1`, [unset.pid]);
ok("DB에는 코드 원문이 아니라 해시만 있다", prof1.pin_hash !== code1 && prof1.pin_hash.length > 20);
const auditText = (await q(`select coalesce(string_agg(to_jsonb(a)::text, ' '), '') as t from public.audit_logs a`))[0].t;
ok("감사 기록에 코드 값이 없다(발급 사실만 있다)", !auditText.includes(code1) && auditText.includes("issue_instructor_start_code"));
ok("발급 후 옛 뒤 4자리로 로그인 불가", kind(await login("orga", "미설정강사", "2222", "2222")) === "EMPTY");
r = await login("orga", "미설정강사", "2222", code1);
ok("시작코드로 인증 -> 아직 PIN 미설정(pin_confirmed=false)", kind(r) === "OK" && r.rows[0].pin_confirmed === false, kind(r));

// 시작코드로 새 PIN 설정
r = await setPin("orga", "미설정강사", "2222", code1, "654987");
ok("시작코드 + 6자리 새 PIN으로 PIN 설정", kind(r) === "OK", kind(r));
const [prof2] = await q(`select pin_confirmed, start_code_expires_at from public.instructor_profiles where principal_id = $1`, [unset.pid]);
ok("설정 뒤 pin_confirmed=true, 시작코드 만료값 비워짐", prof2.pin_confirmed === true && prof2.start_code_expires_at === null);
ok("사용한 시작코드는 다시 쓸 수 없다(로그인)", kind(await login("orga", "미설정강사", "2222", code1)) === "EMPTY");
ok("사용한 시작코드로 PIN 재설정도 불가", kind(await setPin("orga", "미설정강사", "2222", code1, "731946")) === "EMPTY");
ok("새 PIN으로 로그인", kind(await login("orga", "미설정강사", "2222", "654987")) === "OK");
r = await setPin("orga", "기존강사", "1111", "482915", "731946");
ok("PIN을 이미 만든 강사는 PIN 재설정 불가(ALREADY_SET)", /ALREADY_SET/.test(kind(r)), kind(r));

// 재발급
await db.query(`insert into auth.sessions (user_id) values ($1), ($1)`, [unset.uid]);
await sub(adminA.uid);
r = await tryQ(`select * from public.issue_instructor_start_code($1)`, [unset.pid]);
const code2 = r.rows?.[0]?.out_code;
ok("PIN을 이미 쓰던 강사에게도 재발급(=초기화) 가능", kind(r) === "OK" && /^[0-9]{6}$/.test(code2 ?? ""), kind(r));
ok("재발급하면 열려 있던 로그인 세션이 종료된다", (await q(`select count(*)::int as n from auth.sessions where user_id = $1`, [unset.uid]))[0].n === 0 && r.rows?.[0]?.out_sessions_revoked === true);
await sub(null);
ok("재발급하면 이전 PIN은 즉시 무효", kind(await login("orga", "미설정강사", "2222", "654987")) === "EMPTY");
if (code2 === code1) console.log("INFO 우연히 같은 코드가 나와 '이전 코드 무효' 확인 생략");
else ok("재발급하면 이전 시작코드도 무효", kind(await login("orga", "미설정강사", "2222", code1)) === "EMPTY");
ok("새 시작코드로 인증", kind(await login("orga", "미설정강사", "2222", code2)) === "OK");

// 권한·기관 격리
section("1-b. 발급 권한과 기관 격리");
await sub(staffA.uid);
r = await tryQ(`select * from public.issue_instructor_start_code($1)`, [unset.pid]);
ok("일반 직원은 발급 불가", /권한/.test(r.err ?? ""), kind(r));
await sub(keep.uid);
r = await tryQ(`select * from public.issue_instructor_start_code($1)`, [unset.pid]);
ok("강사 로그인 세션은 발급 불가", /권한/.test(r.err ?? ""), kind(r));
await sub(adminB.uid);
const rOther = await tryQ(`select * from public.issue_instructor_start_code($1)`, [unset.pid]);
ok("다른 기관 관리자는 발급 불가", /대상 강사를 찾을 수 없습니다/.test(rOther.err ?? ""), kind(rOther));
const rNone = await tryQ(`select * from public.issue_instructor_start_code($1)`, ["00000000-0000-0000-0000-0000000000ff"]);
ok("없는 강사와 다른 기관 강사는 같은 메시지(존재 여부 비노출)", rNone.err === rOther.err, `${rNone.err} / ${rOther.err}`);
await sub(adminA.uid);
r = await tryQ(`select * from public.issue_instructor_start_code($1)`, [staffA.pid]);
ok("강사가 아닌 계정(직원)은 대상이 될 수 없다", /대상 강사를 찾을 수 없습니다/.test(r.err ?? ""), kind(r));
await sub(null);
r = await tryQ(`select * from public.issue_instructor_start_code($1)`, [unset.pid]);
ok("로그인하지 않은 호출(익명)은 발급 불가", /권한/.test(r.err ?? ""), kind(r));
ok("발급 함수는 익명 역할에 실행 권한이 없다", (await q(`select has_function_privilege('anon', 'public.issue_instructor_start_code(uuid)', 'execute') as v`))[0].v === false);
ok("코드 생성 도우미는 로그인 사용자도 직접 호출 불가", (await q(`select has_function_privilege('authenticated', 'public.instructor_generate_start_code()', 'execute') as v`))[0].v === false);

// 등록과 발급 동시
section("1-c. 강사 등록 + 시작코드(한 트랜잭션)");
await sub(adminA.uid);
const [nu] = await q(`insert into auth.users (email) values ('inst-new@auth.internal.invalid') returning id`);
r = await tryQ(`select * from public.provision_instructor_with_start_code($1,$2,$3,$4)`, [ORG_A, nu.id, "신규강사", "3333"]);
ok("신규 강사 등록 + 시작코드 발급", kind(r) === "OK" && /^[0-9]{6}$/.test(r.rows[0]?.out_code ?? ""), kind(r));
const newCode = r.rows?.[0]?.out_code;
r = await tryQ(`select * from public.list_instructor_accounts()`);
const lrow = r.rows?.find((x) => x.out_name === "신규강사");
ok("강사 목록에 시작코드 만료 시각이 나온다", !!lrow?.out_start_code_expires_at && lrow.out_pin_confirmed === false, JSON.stringify(lrow));
r = await tryQ(`select * from public.provision_instructor_with_start_code($1,$2,$3,$4)`, [ORG_B, nu.id, "다른기관", "4444"]);
ok("다른 기관에는 등록·발급 불가", /다른 조직/.test(r.err ?? ""), kind(r));
await sub(null);
ok("신규 강사: 뒤 4자리로는 로그인 불가", kind(await login("orga", "신규강사", "3333", "3333")) === "EMPTY");
ok("신규 강사: 시작코드로 인증", kind(await login("orga", "신규강사", "3333", newCode)) === "OK");

// ── 2. 강제
section("2. 강제 마이그레이션(20261105020000) 적용 직후");
// 강제 전에 옛 방식 미설정 강사 한 명 더(뒤 4자리 해시 + 시작코드 없음)
const legacy = await mkInstructorOld(ORG_A, adminA.uid, "옛미설정", "5555");
await sub(null);
try { await applyFile(migDir, ENF); ok("강제 마이그레이션 적용", true); } catch (e) { ok("강제 마이그레이션 적용", false, String(e.message).split("\n")[0]); }

ok("기존 강사: 기존 PIN으로 그대로 로그인", kind(await login("orga", "기존강사", "1111", "482915")) === "OK");
ok("기존 강사의 PIN 해시가 마이그레이션 전과 같다", (await q(`select pin_hash from public.instructor_profiles where principal_id = $1`, [keep.pid]))[0].pin_hash === keepHashBefore.pin_hash);
r = await login("orga", "옛미설정", "5555", "5555");
ok("시작코드가 없는 옛 미설정 계정은 뒤 4자리로 통과 불가(START_CODE_EXPIRED)", /START_CODE_EXPIRED/.test(kind(r)), kind(r));
ok("틀린 값에는 일반 실패(계정 존재 여부를 알리지 않는다)", kind(await login("orga", "옛미설정", "5555", "9999")) === "EMPTY");
ok("없는 계정도 같은 일반 실패", kind(await login("orga", "없는사람", "0000", "9999")) === "EMPTY");
ok("신규 강사: 발급받은 시작코드는 그대로 유효", kind(await login("orga", "신규강사", "3333", newCode)) === "OK");

// 새 provision_instructor(직접 호출)는 뒤 4자리를 PIN으로 쓰지 않는다
const direct = await mkInstructorOld(ORG_A, adminA.uid, "직접등록", "6666");
await sub(null);
ok("provision_instructor를 직접 불러도 뒤 4자리로 로그인 불가", kind(await login("orga", "직접등록", "6666", "6666")) === "EMPTY");
ok("옛 reset_instructor_pin 함수가 삭제됐다", (await q(`select count(*)::int as n from pg_proc where proname = 'reset_instructor_pin'`))[0].n === 0);

// 만료
await sub(adminA.uid);
const [eu] = await q(`insert into auth.users (email) values ('inst-exp@auth.internal.invalid') returning id`);
r = await tryQ(`select * from public.provision_instructor_with_start_code($1,$2,$3,$4)`, [ORG_A, eu.id, "만료강사", "7777"]);
const expCode = r.rows?.[0]?.out_code, expPid = r.rows?.[0]?.out_principal_id;
await sub(null);
await db.query(`update public.instructor_profiles set start_code_expires_at = now() - interval '1 minute' where principal_id = $1`, [expPid]);
ok("7일이 지난 시작코드(정확한 값)는 로그인 거부", /START_CODE_EXPIRED/.test(kind(await login("orga", "만료강사", "7777", expCode))));
ok("7일이 지난 시작코드로 PIN 설정도 거부", /START_CODE_EXPIRED/.test(kind(await setPin("orga", "만료강사", "7777", expCode, "839201"))));
ok("만료 상태에서 틀린 값은 일반 실패", kind(await login("orga", "만료강사", "7777", wrongOf(expCode))) === "EMPTY");
await sub(adminA.uid);
r = await tryQ(`select * from public.issue_instructor_start_code($1)`, [expPid]);
const expCode2 = r.rows?.[0]?.out_code;
await sub(null);
ok("만료 후 재발급하면 다시 사용 가능", kind(await login("orga", "만료강사", "7777", expCode2)) === "OK");

// 반복 실패
const unlock = async (pid, name) => {
  await db.query(`update public.instructor_profiles set pin_locked_until = null where principal_id = $1`, [pid]);
  await db.query(`delete from public.instructor_login_attempts where name_key = lower($1)`, [name]);
};
section("2-b. 반복 입력 방지");
{
  const [u] = await q(`insert into auth.users (email) values ('inst-rep@auth.internal.invalid') returning id`);
  await sub(adminA.uid);
  const pr = await tryQ(`select * from public.provision_instructor_with_start_code($1,$2,$3,$4)`, [ORG_A, u.id, "반복강사", "8888"]);
  const pid = pr.rows[0].out_principal_id, c = pr.rows[0].out_code;
  await sub(null);
  let kinds = [];
  for (let i = 0; i < 5; i++) kinds.push(kind(await login("orga", "반복강사", "8888", wrongOf(c))));
  ok("틀린 코드 5회 -> 5번째까지는 일반 실패", kinds.every((k) => k === "EMPTY"), kinds.join(","));
  ok("6번째부터는 잠금(LOCKED)", /LOCKED/.test(kind(await login("orga", "반복강사", "8888", wrongOf(c)))));
  ok("잠금 중에는 정확한 코드도 거부", /LOCKED/.test(kind(await login("orga", "반복강사", "8888", c))));
  await db.query(`update public.instructor_profiles set pin_locked_until = now() - interval '1 minute' where principal_id = $1`, [pid]);
  await db.query(`delete from public.instructor_login_attempts where name_key = '반복강사'`);
  await login("orga", "반복강사", "8888", wrongOf(c));
  const [lk] = await q(`select pin_locked_until > now() as locked from public.instructor_profiles where principal_id = $1`, [pid]);
  ok("잠금이 풀린 뒤 한 번만 틀려도 곧바로 다시 잠긴다(15분에 1회 수준)", lk.locked === true);

  // 19회 실패까지는 정확한 코드 유효, 20회 실패 이후에는 무효
  await sub(adminA.uid);
  const rr = await tryQ(`select * from public.issue_instructor_start_code($1)`, [pid]);
  const c2 = rr.rows[0].out_code;
  await sub(null);
  for (let i = 0; i < 19; i++) { await unlock(pid, "반복강사"); await login("orga", "반복강사", "8888", wrongOf(c2)); }
  await unlock(pid, "반복강사");
  ok("실패 19회까지는 정확한 코드가 유효", kind(await login("orga", "반복강사", "8888", c2)) === "OK");
  await sub(adminA.uid);
  const r3 = await tryQ(`select * from public.issue_instructor_start_code($1)`, [pid]);
  const c3 = r3.rows[0].out_code;
  await sub(null);
  for (let i = 0; i < 20; i++) { await unlock(pid, "반복강사"); await login("orga", "반복강사", "8888", wrongOf(c3)); }
  await unlock(pid, "반복강사");
  ok("실패 20회가 쌓이면 정확한 코드도 무효(START_CODE_EXPIRED)", /START_CODE_EXPIRED/.test(kind(await login("orga", "반복강사", "8888", c3))));
  await sub(adminA.uid);
  const r4 = await tryQ(`select * from public.issue_instructor_start_code($1)`, [pid]);
  await sub(null);
  ok("재발급하면 실패 횟수가 초기화되어 다시 사용 가능", kind(await login("orga", "반복강사", "8888", r4.rows[0].out_code)) === "OK");
}

// (기관+이름) 단위 잠금은 그대로
{
  let last = "";
  for (let i = 0; i < 11; i++) last = kind(await login("orga", "존재안함", "1234", "000000"));
  ok("없는 이름 대입도 (기관+이름) 단위로 잠긴다(기존 동작 유지)", /LOCKED/.test(last), last);
}

// 타기관 차단
section("2-c. 타기관 차단");
{
  await sub(adminB.uid);
  const [u] = await q(`insert into auth.users (email) values ('inst-b@auth.internal.invalid') returning id`);
  const pr = await tryQ(`select * from public.provision_instructor_with_start_code($1,$2,$3,$4)`, [ORG_B, u.id, "기존강사", "1111"]); // 가기관과 같은 이름·뒤4자리
  const cB = pr.rows?.[0]?.out_code;
  await sub(null);
  ok("같은 이름·뒤 4자리라도 기관마다 따로 인증된다", kind(await login("orgb", "기존강사", "1111", cB)) === "OK");
  ok("나기관 시작코드로 가기관 계정에 로그인 불가", kind(await login("orga", "기존강사", "1111", cB)) === "EMPTY");
  ok("가기관 PIN으로 나기관 계정에 로그인 불가", kind(await login("orgb", "기존강사", "1111", "482915")) === "EMPTY");
  ok("가기관 기존 강사는 영향 없음", kind(await login("orga", "기존강사", "1111", "482915")) === "OK");
}

// 난수·구조 점검
section("2-d. 코드 생성 점검, 동시성 구조");
{
  const rows = await q(`select public.instructor_generate_start_code() as c from generate_series(1, 3000)`);
  const set = new Set(rows.map((x) => x.c));
  ok("3000개 생성 모두 숫자 6자리", rows.every((x) => /^[0-9]{6}$/.test(x.c)));
  ok("3000개 중 중복이 거의 없다(생일 역설 기대치 약 4.5개 이내)", 3000 - set.size < 20, String(3000 - set.size));
  const lead = Array(10).fill(0); rows.forEach((x) => lead[+x.c[0]]++);
  ok("첫 자리 숫자가 고르게 나온다(각 150~450회)", lead.every((n) => n > 150 && n < 450), lead.join(","));
  const src = (await q(`select pg_get_functiondef('public.instructor_authenticate(text,text,text,text)'::regprocedure) as d`))[0].d;
  ok("인증 함수는 계정 행을 잠그고(for update) 검사한다", /for update of ip/.test(src));
  const src2 = (await q(`select pg_get_functiondef('public.issue_instructor_start_code(uuid)'::regprocedure) as d`))[0].d;
  ok("발급 함수도 같은 행을 잠그고 갱신한다", /for update of ip/.test(src2));
}

// ── 3. 다른 기능이 그대로인지
section("3. 다른 기능 변경 없음 확인(출석·실적·직원 로그인·권한)");
{
  const fnsAfter = await snapFns(), polAfter = await snapPolicies(), colsAfter = await snapCols();
  const changed = Object.keys(fnsAfter).filter((k) => k in fnsBefore && fnsAfter[k] !== fnsBefore[k]).sort();
  const added = Object.keys(fnsAfter).filter((k) => !(k in fnsBefore)).sort();
  const removed = Object.keys(fnsBefore).filter((k) => !(k in fnsAfter)).sort();
  console.log("  바뀐 함수:", changed.join(", "));
  console.log("  추가된 함수:", added.join(", "));
  console.log("  삭제된 함수:", removed.join(", "));
  const wantChanged = ["instructor_authenticate(p_org_code text, p_name text, p_phone_last4 text, p_pin text)", "list_instructor_accounts()", "provision_instructor(p_organization_id uuid, p_auth_user_id uuid, p_name text, p_phone_last4 text)", "set_instructor_pin(p_org_code text, p_name text, p_phone_last4 text, p_current_pin text, p_new_pin text)"].sort();
  ok("바뀐 함수는 강사 인증·등록·목록 4개뿐", JSON.stringify(changed) === JSON.stringify(wantChanged));
  ok("추가된 함수는 시작코드 관련 3개뿐", added.length === 3 && added.every((k) => /start_code/.test(k)), added.join(","));
  ok("삭제된 함수는 reset_instructor_pin 하나뿐", removed.length === 1 && /^reset_instructor_pin/.test(removed[0]), removed.join(","));
  ok("출석 저장·자동확정·실적·직원 로그인·기관 판별 함수는 정의가 그대로", ["save_instructor_attendance", "finalize_due_sessions", "is_run_instructor", "is_system_admin", "current_organization_id", "current_business_role"].every((n) => { const ks = Object.keys(fnsBefore).filter((k) => k.startsWith(n + "(")); return ks.length > 0 && ks.every((k) => fnsAfter[k] === fnsBefore[k]); }));
  ok("RLS 정책이 하나도 바뀌지 않았다", JSON.stringify(polBefore) === JSON.stringify(polAfter));
  const newCols = colsAfter.filter((c) => !colsBefore.includes(c)), lostCols = colsBefore.filter((c) => !colsAfter.includes(c));
  ok("테이블 열 변화는 start_code_expires_at 추가 하나뿐", newCols.length === 1 && /instructor_profiles\.start_code_expires_at/.test(newCols[0]) && lostCols.length === 0, `${newCols} / ${lostCols}`);
  const [cnt] = await q(`select (select count(*) from pg_tables where schemaname='public')::int as tables, (select count(*) from pg_tables where schemaname='public' and not rowsecurity)::int as no_rls`);
  ok("public 테이블 34개, RLS 꺼진 테이블 0개", cnt.tables === 34 && cnt.no_rls === 0, JSON.stringify(cnt));
}

// ── 4. 롤백
section("4. 롤백 시험");
{
  // 롤백 전 상태: 옛미설정(뒤 4자리 해시) / 신규강사(시작코드) / 기존강사(PIN)
  const rbEnf = fs.readFileSync(path.join(rbDir, `${ENF}.rollback.sql`), "utf8");
  const rbAdd = fs.readFileSync(path.join(rbDir, `${ADD}.rollback.sql`), "utf8");
  const e = await db.exec(rbAdd).then(() => ({}), (x) => ({ err: String(x.message) }));
  ok("강제 단계가 적용된 채로 추가분 롤백을 실행하면 막힌다", /먼저 되돌려/.test(e.err ?? ""), e.err ?? "막히지 않음");

  try { await db.exec(rbEnf); ok("강제 롤백 적용", true); } catch (x) { ok("강제 롤백 적용", false, String(x.message).split("\n")[0]); }
  ok("(강제 롤백 후) 기존 강사 로그인 유지", kind(await login("orga", "기존강사", "1111", "482915")) === "OK");
  ok("(강제 롤백 후) 옛 뒤 4자리로 다시 열리지 않는다", kind(await login("orga", "옛미설정", "5555", "5555")) === "EMPTY");
  ok("(강제 롤백 후) 발급받은 시작코드는 계속 사용 가능", kind(await login("orga", "신규강사", "3333", newCode)) === "OK");
  ok("(강제 롤백 후) 직접 등록한 계정도 뒤 4자리로 열리지 않는다", kind(await login("orga", "직접등록", "6666", "6666")) === "EMPTY");
  ok("(강제 롤백 후) 옛 초기화 함수는 뒤 4자리로 되돌리지 않고 안내 오류만 낸다", /시작코드/.test((await tryQ(`select public.reset_instructor_pin($1)`, [keep.pid])).err ?? ""));

  try { await db.exec(rbAdd); ok("추가분 롤백 적용", true); } catch (x) { ok("추가분 롤백 적용", false, String(x.message).split("\n")[0]); }
  ok("(전체 롤백 후) 시작코드 함수·열이 사라졌다", (await q(`select count(*)::int as n from pg_proc where proname like '%start_code%'`))[0].n === 0 && (await q(`select count(*)::int as n from information_schema.columns where table_name='instructor_profiles' and column_name='start_code_expires_at'`))[0].n === 0);
  ok("(전체 롤백 후) 기존 강사 로그인 유지", kind(await login("orga", "기존강사", "1111", "482915")) === "OK");
  ok("(전체 롤백 후) 옛 뒤 4자리 경로는 여전히 닫혀 있다", kind(await login("orga", "옛미설정", "5555", "5555")) === "EMPTY");
  const fnsRb = await snapFns();
  const diff = Object.keys(fnsBefore).filter((k) => fnsRb[k] !== fnsBefore[k] && k in fnsRb);
  console.log("  롤백 후 시작 전과 다른 함수:", diff.join(", "));

  // 재적용
  try { await applyFile(migDir, ADD); await applyFile(migDir, ENF); ok("롤백 뒤 두 마이그레이션 재적용", true); } catch (x) { ok("롤백 뒤 두 마이그레이션 재적용", false, String(x.message).split("\n")[0]); }
  ok("(재적용 후) 기존 강사 로그인 유지", kind(await login("orga", "기존강사", "1111", "482915")) === "OK");
}

console.log(`\n== ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
