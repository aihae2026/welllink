// 새 설치 시험: 빈 데이터베이스에 supabase/migrations 전체를 순서대로 적용하고,
// README의 "처음 설치" 절차(첫 기관 -> 첫 관리자 -> 강사 계정 + 시작코드 -> 6자리 PIN 로그인)를 따라 해 본다.
//
// - Docker나 Supabase 계정 없이 PGlite(Node 안에서 도는 Postgres)로 실행한다.
// - Supabase 고유 기능은 같은 모양의 대용품으로 대체한다: pgcrypto(crypt, gen_salt), auth 스키마
//   (users, uid), pg_cron(schedule, unschedule), 역할(anon, authenticated, service_role).
//   그래서 "마이그레이션 순서와 로직이 빈 DB에서 성립하는지"를 확인하는 시험이며,
//   실제 Supabase 프로젝트에서 실행한 결과를 대신하지는 않는다.
//
// 실행:
//   npm install --no-save @electric-sql/pglite@0.3.14
//   node scripts/verify-fresh-install.mjs [migrations 폴더]
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log("PASS", n)) : (fail++, console.log("FAIL", n, x)); };
const q = async (s, p) => (await db.query(s, p)).rows;
const tryQ = async (s, p) => { try { return { rows: await q(s, p) }; } catch (e) { return { err: String(e.message) }; } };

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema extensions; create schema auth; create schema cron;
  create function extensions.gen_salt(t text, n int default 6) returns text language sql as $$ select substr(md5(random()::text),1,8) $$;
  create function extensions.crypt(pw text, salt text) returns text language sql immutable as $$ select substr(salt,1,8)||md5(substr(salt,1,8)||pw) $$;
  create function extensions.gen_random_bytes(n int) returns bytea language sql volatile as $$ select decode(substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 2 * n), 'hex') $$;
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null);
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb, created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table cron.job (jobid serial primary key, jobname text, schedule text, command text, active boolean default true);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid::bigint $$;
  create function cron.unschedule(job_name text) returns boolean language sql as $$ with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
`);

// 1. 마이그레이션 전체 적용 (빈 DB)
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
let applied = 0;
for (const f of files) {
  try {
    await db.exec(fs.readFileSync(path.join(dir, f), "utf8")
      .replace(/create extension if not exists pg_cron with schema pg_catalog;/gi, "")
      .replace(/create extension if not exists pgcrypto with schema extensions;/gi, ""));
    applied++;
  } catch (e) { console.log("FAIL apply", f, String(e.message).split("\n")[0]); break; }
}
ok(`빈 DB에 마이그레이션 ${files.length}개 전부 적용`, applied === files.length, `${applied}/${files.length}`);
const [cnt] = await q(`select (select count(*) from pg_tables where schemaname='public')::int as tables,
   (select count(*) from pg_tables where schemaname='public' and not rowsecurity)::int as no_rls`);
ok("public 테이블 34개", cnt.tables === 34, JSON.stringify(cnt));
ok("RLS가 꺼진 테이블 0개", cnt.no_rls === 0, JSON.stringify(cnt));

// 2. README 절차: 첫 기관 만들기 (SQL)
const ORG = "00000000-0000-0000-0000-000000000001";
const first = await tryQ(`insert into public.organizations (id, name, org_code) values ('${ORG}', '시험복지관', 'testwelfare')`);
ok("첫 기관 INSERT 성공", !first.err, first.err);
const sup = await tryQ(`update public.organizations set is_supplier = true where id = '${ORG}'`);
ok("공급자 기관 지정 UPDATE 성공", !sup.err, sup.err);

// 3. bootstrap-first-admin.ts 가 하는 일(auth 사용자, principal, staff_profiles, audit_logs)
const [au] = await q(`insert into auth.users (email) values ('admin@test.example') returning id`);
const [pr] = await q(`insert into public.principals (organization_id, auth_user_id, principal_type, name) values ('${ORG}', $1, 'staff', '최초관리자') returning id`, [au.id]);
const prof = await tryQ(`insert into public.staff_profiles (principal_id, business_role, is_system_admin, must_change_password) values ($1, 'global_manager', true, true)`, [pr.id]);
ok("최초 관리자 staff_profiles INSERT 성공", !prof.err, prof.err);
const aud = await tryQ(`insert into public.audit_logs (organization_id, actor_principal_id, action, entity_type, entity_id, after_json) values ('${ORG}', $1, 'bootstrap_first_admin', 'principal', $1, '{}')`, [pr.id]);
ok("감사 기록 INSERT 성공", !aud.err, aud.err);

// 4. 그 관리자로 로그인한 것처럼 권한 확인
await db.exec(`select set_config('request.jwt.claim.sub', '${au.id}', false)`);
const who = (await q(`select public.is_system_admin() as admin, public.current_organization_id() as org`))[0];
ok("관리자 권한 인식(is_system_admin)", who.admin === true, JSON.stringify(who));
ok("기관 인식(current_organization_id)", who.org === ORG, JSON.stringify(who));
const supAdmin = (await tryQ(`select public.is_supplier_admin() as v`));
ok("공급자 관리자 인식(is_supplier_admin)", supAdmin.rows?.[0]?.v === true, JSON.stringify(supAdmin));

// 5. 관리자가 강사 계정을 만들고(시작코드 발급), 강사가 시작코드로 6자리 PIN을 만들어 로그인
const [iu] = await q(`insert into auth.users (email) values ('instructor-x@auth.internal.invalid') returning id`);
const mkI = await tryQ(`select * from public.provision_instructor_with_start_code('${ORG}', $1, '김강사', '0001')`, [iu.id]);
ok("관리자가 강사 계정 생성 + 시작코드 발급", !mkI.err && /^[0-9]{6}$/.test(mkI.rows?.[0]?.out_code ?? ""), JSON.stringify(mkI));
const startCode = mkI.rows?.[0]?.out_code;
await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
const login = (pin) => tryQ(`select * from public.verify_instructor_login('testwelfare','김강사','0001',$1)`, [pin]);
let r = await login("0001");
ok("옛 방식(뒤4자리)으로는 인증되지 않음", r.rows?.length === 0, JSON.stringify(r));
r = await login(startCode);
ok("시작코드로 인증 → 아직 PIN 미설정(pin_confirmed=false)", r.rows?.length === 1 && r.rows[0].pin_confirmed === false, JSON.stringify(r));
r = await tryQ(`select * from public.set_instructor_pin('testwelfare','김강사','0001',$1,'482915')`, [startCode]);
ok("시작코드 + 6자리 새 PIN으로 PIN 설정", r.rows?.length === 1, JSON.stringify(r));
r = await login("482915");
ok("새 PIN으로 로그인 + pin_confirmed=true", r.rows?.length === 1 && r.rows[0].pin_confirmed === true, JSON.stringify(r));
r = await tryQ(`select * from public.set_instructor_pin('testwelfare','김강사','0001',$1,'729104')`, [startCode]);
ok("사용한 시작코드로는 다시 설정할 수 없음(빈 결과 또는 오류)", r.rows?.length === 0 || !!r.err, JSON.stringify(r));

// 6. 초대코드 발급 구조(공급자)가 비어 있는 DB에서 동작하는지
const inv = await tryQ(`select count(*)::int as n from public.provisioning_invites`);
ok("초대코드 표 사용 가능", inv.rows?.[0]?.n === 0, JSON.stringify(inv));

console.log(`\n== ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
