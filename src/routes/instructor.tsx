import { useEffect, type ReactNode } from "react";
import { createFileRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { InstructorAuthProvider, useInstructorAuth } from "@/lib/instructor-session";

export const Route = createFileRoute("/instructor")({
  component: () => (
    <InstructorAuthProvider>
      <InstructorSessionGate>
        <Outlet />
      </InstructorSessionGate>
    </InstructorAuthProvider>
  ),
});

// 강사 화면은 강사 세션이 확인되기 전에는 페이지 컴포넌트를 렌더하지 않는다.
// 각 페이지가 데이터 hook을 RequireInstructorAuth보다 먼저 호출하는 구조라, 로그아웃
// 상태로 /instructor를 열면 anon으로 수업 조회가 먼저 나가 401이 콘솔에 찍힌 뒤에야
// /instructor/login으로 이동했다(직원 화면의 __root StaffSessionGate와 같은 문제).
// 강사 프로필 확인 등 실제 접근 제어는 그대로 RequireInstructorAuth와 RLS가 한다.
function InstructorSessionGate({ children }: { children: ReactNode }) {
  const { session, loading } = useInstructorAuth();
  const navigate = useNavigate();
  // 주소(location)가 아니라 지금 실제로 그려진 화면의 경로로 판단한다 -- 이동 중에는
  // 새 화면이 로드될 때까지 이전 화면이 계속 그려지기 때문이다.
  const pathname = useRouterState({
    select: (st) => (st.resolvedLocation ?? st.location).pathname,
  });
  const isLoginPage = pathname === "/instructor/login";

  useEffect(() => {
    if (isLoginPage || loading || session) return;
    navigate({ to: "/instructor/login" });
  }, [isLoginPage, loading, session, navigate]);

  if (isLoginPage || session) return <>{children}</>;
  // RequireInstructorAuth와 같은 모양/문구 -- SSR과 첫 client 렌더(loading=true)가 같아야 한다.
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
      <div className="text-sm text-muted-foreground">
        {loading ? "불러오는 중..." : "로그인 화면으로 이동 중..."}
      </div>
    </div>
  );
}
