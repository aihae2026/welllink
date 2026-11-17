import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// Lovable 편집기는 미리보기를 iframe으로 열기 때문에, 미리보기 주소에는 프레임 차단 헤더를
// 붙이지 않는다(붙이면 편집기 안의 미리보기가 빈 화면이 된다). 배포 주소에만 붙인다.
const PREVIEW_HOST_PATTERN = /^id-preview--|^preview--|\.lovableproject\.com$/;

// HTML 문서 응답에 안전한 보안 헤더를 더한다.
// - frame-ancestors 'none' (+ 구형 브라우저용 X-Frame-Options): 다른 사이트가 이 화면을
//   iframe으로 끼워 넣는 것(클릭재킹)을 막는다.
// - Permissions-Policy: 쓰지 않는 브라우저 기능(카메라·마이크·위치·결제)을 끈다.
// - Content-Security-Policy: 스크립트·연결 대상을 제한한다. 외부 주소의 스크립트를 불러오거나
//   Supabase 밖으로 데이터를 보내는 것을 막아, 화면에서 악성 스크립트가 실행되더라도 로그인
//   정보를 바깥으로 빼내기 어렵게 한다. 2026-11-04에 시험 모드(Report-Only)로 직원 화면 약
//   20곳과 강사 화면(오늘 수업·출석 입력)에서 위반이 0건임을 확인한 뒤 실제 적용으로 바꿨다.
//   script-src에 'unsafe-inline'이 남아 있는 것은 SSR이 화면 안에 인라인 스크립트를 넣기
//   때문이다(이것까지 막으려면 요청마다 nonce를 발급하는 별도 작업이 필요하다).
//   문제가 생기면 이 값만 Content-Security-Policy-Report-Only로 되돌리면 된다.
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function withSecurityHeaders(request: Request, response: Response): Response {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;

  let hostname = "";
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return response;
  }
  if (PREVIEW_HOST_PATTERN.test(hostname)) return response;

  const headers = new Headers(response.headers);
  if (!headers.has("content-security-policy")) {
    headers.set("Content-Security-Policy", CSP_POLICY);
  }
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return withSecurityHeaders(request, await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
