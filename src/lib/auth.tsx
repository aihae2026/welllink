import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { Button } from "@/components/ui/button";
import { useLoginPrincipalType } from "./login-principal-type";

// WellLink v1.0 직원 인증/권한 모델. Source of Truth는 오직 하나:
//   auth.users -> principals -> staff_profiles
// 구 MVP의 profiles/role/is_admin은 존재하지 않으며 참조하지도 않는다(과도기 없음).
// 강사 로그인은 이번 Batch에서 구현하지 않는다 -- Pipeline 1 / Batch 1.2에서 별도 구현.

export type BusinessRole = "staff" | "department_manager" | "global_manager" | "global_viewer";

export type StaffProfile = {
  principalId: string;
  organizationId: string;
  organizationName: string;
  /** 공급자 기관(is_supplier=true)의 system admin 여부. 기관 초기등록 탭 노출에만 쓴다(권한 판정은 항상 서버). */
  isSupplierAdmin: boolean;
  name: string | null;
  businessRole: BusinessRole;
  isSystemAdmin: boolean;
  mustChangePassword: boolean;
};

type AuthContextValue = {
  session: Session | null;
  staffProfile: StaffProfile | null;
  /** true = 세션은 있지만 principals/staff_profiles에 연결된 계정이 없음(관리자에게 계정 연결 필요) */
  noStaffProfile: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [noStaffProfile, setNoStaffProfile] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadStaffProfile(userId: string) {
      const { data: principal } = await supabase
        .from("principals")
        .select("id, organization_id, name, organizations(name)")
        .eq("auth_user_id", userId)
        .eq("principal_type", "staff")
        .eq("is_active", true)
        .maybeSingle();

      if (!active) return;

      if (!principal) {
        setStaffProfile(null);
        setNoStaffProfile(true);
        return;
      }

      const { data: staff } = await supabase
        .from("staff_profiles")
        .select("business_role, is_system_admin, must_change_password")
        .eq("principal_id", principal.id)
        .maybeSingle();

      if (!active) return;

      if (!staff) {
        setStaffProfile(null);
        setNoStaffProfile(true);
        return;
      }

      const orgName = Array.isArray(principal.organizations)
        ? principal.organizations[0]?.name
        : (principal.organizations as { name: string } | null)?.name;

      // 공급자 여부는 별도 RPC로 따로 묻는다. principals 조회에 organizations.is_supplier를
      // 섞으면 마이그레이션(20260910080000) 적용 전 배포에서 조회 전체가 실패해 모든
      // 직원 로그인이 막힌다. RPC가 없거나 실패하면 false로 두고 로그인은 그대로 진행한다.
      const { data: isSupplierAdmin, error: supplierError } =
        await supabase.rpc("is_supplier_admin");

      if (!active) return;

      setStaffProfile({
        principalId: principal.id,
        organizationId: principal.organization_id,
        organizationName: orgName ?? "",
        isSupplierAdmin: !supplierError && isSupplierAdmin === true,
        name: principal.name,
        businessRole: staff.business_role,
        isSystemAdmin: staff.is_system_admin,
        mustChangePassword: staff.must_change_password,
      });
      setNoStaffProfile(false);
    }

    async function init() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setSession(data.session);
      if (data.session) await loadStaffProfile(data.session.user.id);
      if (active) setLoading(false);
    }
    init();

    const { data: listener } = supabase.auth.onAuthStateChange(
      async (_event: AuthChangeEvent, newSession: Session | null) => {
        if (!active) return;
        setSession(newSession);
        if (newSession) {
          await loadStaffProfile(newSession.user.id);
        } else {
          setStaffProfile(null);
          setNoStaffProfile(false);
        }
        setLoading(false);
      },
    );

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, staffProfile, noStaffProfile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth는 AuthProvider 내부에서만 사용할 수 있습니다.");
  return ctx;
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

// 직원 화면(StaffLayout)을 감싸는 접근 제어. 권한 없는 화면 진입은 여기서 막되,
// 최종 방어선은 항상 서버(RLS)다 -- 이 컴포넌트는 UX 편의일 뿐 보안 경계가 아니다.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, staffProfile, noStaffProfile, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const loginType = useLoginPrincipalType(session?.user.id, noStaffProfile);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      navigate({ to: "/login" });
      return;
    }
    // 임시비밀번호 로그인 직후에는 새 비밀번호를 설정하기 전까지 그 어떤 업무화면도
    // 보여주지 않는다 -- Pre-Final Gate 직원 비밀번호 lifecycle 강제.
    if (staffProfile?.mustChangePassword && pathname !== "/change-password") {
      navigate({ to: "/change-password" });
    }
  }, [loading, session, staffProfile?.mustChangePassword, pathname, navigate]);

  if (loading) return <CenteredMessage>불러오는 중...</CenteredMessage>;
  if (!session) return <CenteredMessage>로그인 화면으로 이동 중...</CenteredMessage>;
  // 직원 정보가 없는 로그인(대개 같은 브라우저에서 강사로 로그인된 상태)은 안내만 띄우면
  // 막다른 화면이 된다 -- 로그아웃하고 직원으로 다시 로그인하거나, 강사면 강사 화면으로 가게 한다.
  if (noStaffProfile && loginType === null) {
    return <CenteredMessage>계정 정보를 확인하는 중...</CenteredMessage>;
  }
  if (noStaffProfile) {
    const isInstructor = loginType === "instructor";
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm text-center">
          {isInstructor ? (
            <>
              <p className="text-base font-medium text-foreground">
                지금 강사 계정으로 로그인되어 있습니다.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                직원 화면은 직원 계정으로 로그인해야 볼 수 있습니다.
              </p>
            </>
          ) : (
            <>
              <p className="text-base font-medium text-foreground">
                이 계정에 연결된 직원 정보가 없습니다.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                다른 계정으로 로그인하거나 관리자에게 계정 연결을 요청해 주세요.
              </p>
            </>
          )}
          <div className="mt-6 flex flex-col gap-2">
            <Button
              size="lg"
              onClick={async () => {
                await signOut();
                navigate({ to: "/login" });
              }}
            >
              {isInstructor ? "로그아웃하고 직원으로 로그인" : "로그아웃하고 다시 로그인"}
            </Button>
            {isInstructor && (
              <Button size="lg" variant="outline" onClick={() => navigate({ to: "/instructor" })}>
                강사 화면으로 가기
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (!staffProfile) return <CenteredMessage>계정 정보를 확인하는 중...</CenteredMessage>;
  if (staffProfile.mustChangePassword && pathname !== "/change-password") {
    return <CenteredMessage>비밀번호 변경 화면으로 이동 중...</CenteredMessage>;
  }

  return <>{children}</>;
}
