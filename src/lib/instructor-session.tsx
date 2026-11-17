import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { Button } from "@/components/ui/button";
import { useLoginPrincipalType } from "./login-principal-type";

// 강사 인증 컨텍스트. 직원용 useAuth(auth.tsx)와 별도인 이유:
// - 직원은 이메일/비밀번호로 직접 auth.users에 로그인하지만, 강사는
//   이름+휴대전화 뒤4자리+PIN으로 서버(instructor-auth.ts)에서 검증한 뒤
//   발급받은 access/refresh token을 supabase.auth.setSession()으로 주입한다.
// - 화면에 보여줄 프로필도 staff_profiles가 아니라 principal_type='instructor'
//   기준으로 다르다.

type InstructorProfile = {
  principalId: string;
  name: string | null;
};

type InstructorAuthContextValue = {
  session: Session | null;
  instructorProfile: InstructorProfile | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const InstructorAuthContext = createContext<InstructorAuthContextValue | null>(null);

// 강사 세션 무조작 자동 로그아웃. 수업 중 태블릿을 두고 간 경우 등 오래 방치된 세션이
// 계속 이용자 명단·출석을 볼 수 있는 것을 막는다. 화면을 누르거나 키를 누르거나 스크롤하면
// 마지막 조작 시각이 갱신된다. 시간을 바꾸려면 이 값만 고치면 된다.
const INSTRUCTOR_IDLE_LOGOUT_MS = 60 * 60 * 1000;
const INSTRUCTOR_ACTIVITY_KEY = "welllink.instructor.lastActivityAt";

function readLastActivityAt(): number {
  try {
    const value = Number(window.localStorage.getItem(INSTRUCTOR_ACTIVITY_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeLastActivityAt(at: number) {
  try {
    window.localStorage.setItem(INSTRUCTOR_ACTIVITY_KEY, String(at));
  } catch {
    // 저장이 막힌 브라우저에서는 이 탭의 타이머만으로 동작한다.
  }
}

export function InstructorAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [instructorProfile, setInstructorProfile] = useState<InstructorProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function loadProfile(userId: string) {
      const { data } = await supabase
        .from("principals")
        .select("id, name")
        .eq("auth_user_id", userId)
        .eq("principal_type", "instructor")
        .eq("is_active", true)
        .maybeSingle();
      if (!active) return;
      setInstructorProfile(data ? { principalId: data.id, name: data.name } : null);
    }

    async function init() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setSession(data.session);
      if (data.session) await loadProfile(data.session.user.id);
      if (active) setLoading(false);
    }
    init();

    const { data: listener } = supabase.auth.onAuthStateChange(
      async (_event: AuthChangeEvent, newSession: Session | null) => {
        if (!active) return;
        setSession(newSession);
        if (newSession) {
          await loadProfile(newSession.user.id);
        } else {
          setInstructorProfile(null);
        }
        setLoading(false);
      },
    );

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // 마지막 조작 시각은 "로그인 시각"과 "저장된 마지막 조작 시각" 중 늦은 쪽을 기준으로 한다.
  // 그래야 예전 세션의 낡은 기록 때문에 새로 로그인하자마자 로그아웃되지 않는다.
  const signedInUserId = instructorProfile ? (session?.user.id ?? null) : null;
  const lastSignInAt = session?.user.last_sign_in_at ?? null;
  useEffect(() => {
    if (!signedInUserId) return;

    const signedInAtMs = Date.parse(lastSignInAt ?? "") || 0;
    const logoutIfIdle = () => {
      const lastActiveAt = Math.max(readLastActivityAt(), signedInAtMs);
      if (!lastActiveAt) return;
      if (Date.now() - lastActiveAt > INSTRUCTOR_IDLE_LOGOUT_MS) {
        void supabase.auth.signOut();
      }
    };
    logoutIfIdle();

    let lastWriteAt = 0;
    const markActive = () => {
      const now = Date.now();
      if (now - lastWriteAt < 5000) return;
      lastWriteAt = now;
      writeLastActivityAt(now);
    };
    const activityEvents = ["pointerdown", "keydown", "touchstart", "scroll"] as const;
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, markActive, { passive: true, capture: true });
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") logoutIfIdle();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = window.setInterval(logoutIfIdle, 30_000);

    return () => {
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, markActive, { capture: true });
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(timer);
    };
  }, [signedInUserId, lastSignInAt]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <InstructorAuthContext.Provider value={{ session, instructorProfile, loading, signOut }}>
      {children}
    </InstructorAuthContext.Provider>
  );
}

export function useInstructorAuth() {
  const ctx = useContext(InstructorAuthContext);
  if (!ctx)
    throw new Error("useInstructorAuth는 InstructorAuthProvider 내부에서만 사용할 수 있습니다.");
  return ctx;
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

export function RequireInstructorAuth({ children }: { children: ReactNode }) {
  const { session, instructorProfile, loading, signOut } = useInstructorAuth();
  const navigate = useNavigate();
  const loginType = useLoginPrincipalType(
    session?.user.id,
    !loading && !!session && !instructorProfile,
  );

  useEffect(() => {
    if (loading) return;
    if (!session) {
      navigate({ to: "/instructor/login" });
    }
  }, [loading, session, navigate]);

  if (loading) return <CenteredMessage>불러오는 중...</CenteredMessage>;
  if (!session) return <CenteredMessage>로그인 화면으로 이동 중...</CenteredMessage>;
  // 강사 정보가 없는 로그인(대개 같은 브라우저에서 직원으로 로그인된 상태)도 막다른 화면이
  // 되지 않게, 로그아웃하고 강사로 다시 로그인하거나 직원이면 직원 화면으로 가게 한다.
  // 강사 화면 규칙대로 글씨와 버튼을 크게 둔다.
  if (!instructorProfile && loginType === null) {
    return <CenteredMessage>계정 정보를 확인하는 중...</CenteredMessage>;
  }
  if (!instructorProfile) {
    const isStaff = loginType === "staff";
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md text-center">
          {isStaff ? (
            <>
              <p className="text-xl font-semibold text-foreground">
                지금 직원 계정으로 로그인되어 있습니다.
              </p>
              <p className="mt-2 text-base text-muted-foreground">
                강사 화면은 강사 계정으로 로그인해야 볼 수 있습니다.
              </p>
            </>
          ) : (
            <>
              <p className="text-xl font-semibold text-foreground">
                이 계정에 연결된 강사 정보가 없습니다.
              </p>
              <p className="mt-2 text-base text-muted-foreground">
                다른 계정으로 로그인하거나 기관에 계정 연결을 요청해 주세요.
              </p>
            </>
          )}
          <div className="mt-6 flex flex-col gap-3">
            <Button
              className="h-14 text-lg font-semibold"
              onClick={async () => {
                await signOut();
                navigate({ to: "/instructor/login" });
              }}
            >
              {isStaff ? "로그아웃하고 강사로 로그인" : "로그아웃하고 다시 로그인"}
            </Button>
            {isStaff && (
              <Button
                variant="outline"
                className="h-14 text-lg font-semibold"
                onClick={() => navigate({ to: "/" })}
              >
                직원 화면으로 가기
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
