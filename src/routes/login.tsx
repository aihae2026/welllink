import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";

// WellLink v1.0은 공개 회원가입을 제공하지 않는다(직원 계정은 시스템관리자가 생성).
// 이 화면은 직원 이메일/비밀번호 로그인 전용이다 -- 강사는 별도 URL(/instructor/login)을
// 쓰며, 여기서는 그 화면으로 넘어가는 버튼만 제공하고 강사 로그인 폼 자체는 두지 않는다.
export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [{ title: "로그인 — WellLink v1.0" }],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (error) {
      setError("로그인에 실패했습니다. 이메일/비밀번호를 확인해 주세요.");
      return;
    }
    navigate({ to: "/" });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-2xl font-bold text-foreground sm:text-[28px]">WellLink 로그인</h1>
        <p className="mb-6 text-base text-muted-foreground">기관 업무용 계정으로 로그인해 주세요.</p>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-base font-medium">
              이메일
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-[50px] text-lg md:text-lg"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-base font-medium">
              비밀번호
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-[50px] text-lg md:text-lg"
            />
          </div>
          {error && <p className="text-base text-destructive">{error}</p>}
          <Button
            type="submit"
            className="h-14 w-full text-lg font-semibold"
            disabled={submitting}
          >
            {submitting ? "로그인 중..." : "로그인"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            비밀번호를 잊으셨으면 기관 관리자에게 임시 비밀번호 재발급을 요청해 주세요.
          </p>
        </form>

        <div className="my-6 border-t border-border" />

        <Button
          type="button"
          variant="outline"
          onClick={() => navigate({ to: "/instructor/login" })}
          className="h-14 w-full text-lg font-semibold"
        >
          강사 로그인
        </Button>
      </div>
    </div>
  );
}
