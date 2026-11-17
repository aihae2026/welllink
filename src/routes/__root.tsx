import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  useNavigate,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { AuthProvider, useAuth } from "../lib/auth";
import { setSupabasePublicConfig } from "../lib/supabase";
import { Toaster } from "../components/ui/sonner";
import { useReloadOnNewVersion } from "../lib/app-version";

// SSR(Cloudflare Worker runtime)에서만 process.env를 읽을 수 있다 -- browser에는
// process가 없다. 이 loader는 서버에서 실행되어 결과가 hydration payload로
// client에 그대로 전달되므로, browser는 이 공개 값(secret 아님)을 다시 읽으러
// process.env에 접근할 필요가 없다. Lovable Publish 런타임의 prefix 없는 이름도
// 함께 확인한다 -- src/lib/supabase.ts/ai-evaluation-server.ts 등과 동일한 순서.
function readServerSupabasePublicConfig(): { url: string; key: string } {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const url = env?.["VITE_SUPABASE_URL"] ?? env?.["SUPABASE_URL"] ?? "";
  const key =
    env?.["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
    env?.["VITE_SUPABASE_ANON_KEY"] ??
    env?.["SUPABASE_PUBLISHABLE_KEY"] ??
    "";
  return { url, key };
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">페이지를 찾을 수 없습니다</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          주소가 바뀌었거나 없는 화면입니다.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            홈으로
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: unknown; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          화면을 불러오지 못했습니다
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          잠시 후 다시 시도하거나 홈으로 이동해 주세요.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            다시 시도
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            홈으로
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: () => ({ supabasePublicConfig: readServerSupabasePublicConfig() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      // 화면별 head가 없을 때(404 등)와 링크 공유 미리보기에 보이는 기본값.
      { title: "WellLink" },
      { name: "description", content: "노인복지관 프로그램 출석·사업실적 관리" },
      { property: "og:title", content: "WellLink" },
      { property: "og:description", content: "노인복지관 프로그램 출석·사업실적 관리" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const { supabasePublicConfig } = Route.useLoaderData();
  // AuthProvider(자식)가 supabase.*를 실제로 호출하는 것은 그 useEffect뿐이고, 그건
  // 이 컴포넌트의 첫 렌더가 commit된 "이후"에만 실행된다 -- 즉 이 대입은 항상 그보다
  // 먼저 끝나 있다. 렌더 도중 side effect처럼 보이지만 이 모듈 변수 대입 자체는
  // DOM/state를 건드리지 않는 순수 설정이라 리렌더마다 다시 호출돼도 안전하다.
  setSupabasePublicConfig(supabasePublicConfig);
  // 새 버전이 배포되면 열려 있던 탭도 새 코드로 바꾼다.
  useReloadOnNewVersion();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
        <StaffSessionGate>
          <Outlet />
        </StaffSessionGate>
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}

// 로그인 없이 열리는 화면. 그 외 경로는 전부 직원 업무 화면으로 본다.
const PUBLIC_PATHS = ["/login", "/provision", "/instructor"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// 직원 업무 화면은 로그인 세션이 확인되기 전에는 페이지 컴포넌트를 렌더하지 않는다.
// 각 페이지가 데이터 hook을 StaffLayout(RequireAuth)보다 먼저 호출하는 구조라,
// 로그아웃 상태로 직원 화면 URL을 열면 anon으로 REST 조회가 먼저 나가 401이 콘솔에
// 찍힌 뒤에야 /login으로 이동했다. 여기서는 "세션이 없으면 요청 자체를 보내지 않는다"
// 만 담당한다 -- 직원 프로필/비밀번호 변경 강제 등 실제 접근 제어는 그대로
// RequireAuth와 RLS가 한다.
function StaffSessionGate({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  // location은 이동을 "시작"하는 순간 새 주소로 바뀌지만, 새 화면이 로드될 때까지는
  // 이전 화면이 계속 그려진다. 그래서 주소가 아니라 지금 실제로 그려진 화면의
  // 경로(resolvedLocation)로 판단한다 -- 그렇지 않으면 /login으로 이동하는 짧은
  // 틈에 이전 직원 화면이 한 번 그려지며 anon 조회가 나간다.
  const pathname = useRouterState({
    select: (st) => (st.resolvedLocation ?? st.location).pathname,
  });
  const isPublic = isPublicPath(pathname);

  useEffect(() => {
    if (isPublic || loading || session) return;
    navigate({ to: "/login" });
  }, [isPublic, loading, session, navigate]);

  if (isPublic || session) return <>{children}</>;
  // RequireAuth와 같은 모양/문구 -- SSR과 첫 client 렌더(loading=true)가 같아야 한다.
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
      <div className="text-sm text-muted-foreground">
        {loading ? "불러오는 중..." : "로그인 화면으로 이동 중..."}
      </div>
    </div>
  );
}
