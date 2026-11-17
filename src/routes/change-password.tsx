import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";

// Pre-Final Gate: 임시 비밀번호 로그인 직후 강제 비밀번호 변경 화면. StaffLayout(Sidebar)을
// 쓰지 않는다 -- must_change_password=true인 동안은 다른 업무화면으로 빠져나갈 수 없어야
// 하므로 login.tsx와 같은 standalone 화면으로 만든다.
export const Route = createFileRoute("/change-password")({
  head: () => ({
    meta: [{ title: "비밀번호 변경 — WellLink" }],
  }),
  component: ChangePasswordPage,
});

const MIN_LENGTH = 8;

function ChangePasswordPage() {
  const navigate = useNavigate();
  const { session, staffProfile, loading, signOut } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      navigate({ to: "/login" });
      return;
    }
    // 이미 비밀번호를 바꾼 계정이 직접 이 URL로 들어오면 홈으로 보낸다.
    if (staffProfile && !staffProfile.mustChangePassword) {
      navigate({ to: "/" });
    }
  }, [loading, session, staffProfile, navigate]);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const valid = password.length >= MIN_LENGTH && password === confirm;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);

    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setSubmitting(false);
      setError(
        updateError.code === "same_password"
          ? "임시 비밀번호와 동일합니다. 다른 비밀번호를 입력해 주세요."
          : "비밀번호 변경에 실패했습니다. 잠시 후 다시 시도해 주세요.",
      );
      return;
    }

    const { error: clearError } = await supabase.rpc("clear_must_change_password");
    setSubmitting(false);
    if (clearError) {
      setError(
        "비밀번호는 변경되었지만 상태 갱신에 실패했습니다. 새로고침 후 다시 로그인해 주세요.",
      );
      return;
    }

    // navigate({ to: "/" })만 쓰면 auth.tsx의 staffProfile이 이 세션 안에서 아직
    // must_change_password=true로 캐시돼 있어 RequireAuth가 바로 이 화면으로 다시
    // 튕겨낸다(실제로 겪은 버그) -- 전체 새로고침으로 최신 프로필을 다시 읽게 한다.
    window.location.href = "/";
  };

  if (loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 text-sm text-muted-foreground">
        불러오는 중...
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-2xl font-bold text-foreground sm:text-[28px]">비밀번호 변경</h1>
        <p className="mb-6 text-base text-muted-foreground">
          임시 비밀번호로 로그인했습니다. 계속하려면 새 비밀번호를 설정해 주세요.
        </p>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="new-password" className="text-base font-medium">새 비밀번호</Label>
            <Input
              id="new-password"
              className="h-[50px] text-lg md:text-lg"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {tooShort && (
              <p className="text-xs text-destructive">
                비밀번호는 {MIN_LENGTH}자 이상이어야 합니다.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password" className="text-base font-medium">새 비밀번호 확인</Label>
            <Input
              id="confirm-password"
              className="h-[50px] text-lg md:text-lg"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch && <p className="text-xs text-destructive">비밀번호가 일치하지 않습니다.</p>}
          </div>
          {error && <p className="text-base text-destructive">{error}</p>}
          <Button type="submit" className="h-14 w-full text-lg font-semibold" disabled={!valid || submitting}>
            {submitting ? "변경 중..." : "비밀번호 변경"}
          </Button>
        </form>
        {/* 지금 바꿀 수 없으면(다른 사람 계정으로 들어왔거나 나중에 할 때) 여기서 빠져나간다. */}
        <p className="mt-6 text-center text-sm text-muted-foreground">
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={async () => {
              await signOut();
              navigate({ to: "/login" });
            }}
          >
            로그아웃
          </button>
        </p>
      </div>
    </div>
  );
}
