import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  provisionOrganizationServerFn,
  lookupProvisioningInviteServerFn,
} from "@/lib/provisioning-server";

// 기관 초기등록. 이 주소는 도입 기관에 그대로 안내해도 되는 공개 페이지다 --
// 초대코드가 없으면 아무것도 할 수 없기 때문이다(정적 공유 토큰에서 기관별
// 1회용 초대코드로 교체됨, 20260910080000_provisioning_invites.sql 참고).
//
// 기관 담당자가 직접 여기서 기관명 + 최초 관리자 계정을 만든다. 기관코드는
// 초대코드에 박혀 있어 이 화면에서 바꿀 수 없다(읽기 전용 표시만) -- 강사
// 로그인 입력값이라 선점/오타가 그대로 장애가 되기 때문이다.
//
// Sidebar/로그인 화면에서 이 페이지로 링크하지 않는 것은 그대로 유지한다.
export const Route = createFileRoute("/provision")({
  // 공급자가 보내는 전용 링크(/provision?invite=ABCD-EFGH-JKLM). 형식만 가볍게
  // 정리하고, 유효성은 항상 서버가 판단한다.
  validateSearch: (search: Record<string, unknown>): { invite?: string } => {
    const invite = typeof search["invite"] === "string" ? search["invite"].trim() : "";
    return invite ? { invite } : {};
  },
  head: () => ({
    meta: [{ title: "기관 초기등록 — WellLink" }],
  }),
  component: ProvisionPage,
});

// 입력 중에도 저장형식(대문자 4자 3그룹)으로 맞춰준다. 서버도 같은 정규화를
// 다시 하므로 여기서의 정리는 순전히 편의용이다.
function formatInviteInput(raw: string): string {
  const compact = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  return (compact.match(/.{1,4}/g) ?? []).join("-");
}

function ProvisionPage() {
  const navigate = useNavigate();
  const { invite: inviteFromLink } = Route.useSearch();

  const [inviteCode, setInviteCode] = useState(
    inviteFromLink ? formatInviteInput(inviteFromLink) : "",
  );
  const [verified, setVerified] = useState<{ orgCode: string; expiresAt: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    email: string;
    tempPassword: string;
    orgCode: string;
  } | null>(null);

  const verifyCode = async (code: string) => {
    setChecking(true);
    setError(null);
    try {
      const res = await lookupProvisioningInviteServerFn({ data: { code } });
      if (!res.ok) {
        setVerified(null);
        setError(res.message);
        return;
      }
      setVerified({ orgCode: res.orgCode, expiresAt: res.expiresAt });
    } catch {
      setVerified(null);
      setError("요청을 처리할 수 없습니다.");
    } finally {
      setChecking(false);
    }
  };

  // 링크로 들어온 경우 코드를 자동 확인해 담당자가 한 단계 덜 밟게 한다.
  useEffect(() => {
    if (inviteFromLink) void verifyCode(formatInviteInput(inviteFromLink));
    // 최초 1회만.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVerify = async (e: FormEvent) => {
    e.preventDefault();
    await verifyCode(inviteCode);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await provisionOrganizationServerFn({
        data: { inviteCode, organizationName, adminName, adminEmail },
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setResult({ email: adminEmail, tempPassword: res.tempPassword, orgCode: res.orgCode });
    } catch {
      setError("요청을 처리할 수 없습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  if (result) {
    const copy = async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(`${what}을(를) 복사했습니다.`);
      } catch {
        toast.error("복사할 수 없습니다. 직접 선택해 옮겨 적어 주세요.");
      }
    };
    const allText = [
      `로그인 이메일: ${result.email}`,
      `임시 비밀번호: ${result.tempPassword}`,
      `기관코드(강사 로그인용): ${result.orgCode}`,
    ].join("\n");
    const fields = [
      { label: "로그인 이메일", value: result.email, mono: false },
      { label: "임시 비밀번호", value: result.tempPassword, mono: true },
      { label: "기관코드(강사 로그인용)", value: result.orgCode, mono: true },
    ];
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <h1 className="mb-1 text-2xl font-bold text-foreground sm:text-[28px]">기관 초기등록 완료</h1>
          <p className="mb-6 text-base text-muted-foreground">
            최초 관리자 계정이 생성되었습니다. 아래 정보는 지금 한 번만 표시되며 다시 조회할 수
            없습니다. 지금 안전한 곳에 옮겨 적어 주세요.
          </p>
          <div className="space-y-3 rounded border border-border bg-card p-4 text-sm">
            {fields.map((f) => (
              <div key={f.label} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">{f.label}</div>
                  <div
                    className={`break-all text-base font-medium text-foreground ${f.mono ? "font-mono" : ""}`}
                  >
                    {f.value}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copy(f.value, f.label)}
                  className="h-9 shrink-0 rounded border border-border bg-card px-3 text-sm text-foreground hover:bg-muted"
                >
                  복사
                </button>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-12 w-full text-base"
              onClick={() => copy(allText, "로그인 정보")}
            >
              전체 복사
            </Button>
            <Button
              type="button"
              className="h-14 w-full text-lg font-semibold"
              onClick={() => {
                // 이 화면을 떠나면 임시 비밀번호를 다시 볼 수 없다 -- 옮겨 적었는지 한 번 더 묻는다.
                if (
                  !window.confirm(
                    "임시 비밀번호를 옮겨 적으셨나요?\n이 화면을 떠나면 다시 볼 수 없습니다.",
                  )
                ) {
                  return;
                }
                navigate({ to: "/login" });
              }}
            >
              로그인하러 가기
            </Button>
          </div>
          <p className="mt-4 text-[13px] text-muted-foreground">
            이 계정은 최초 로그인 시 비밀번호 변경이 강제되며, 로그인 직후 [운영설정 &gt;
            기본정보]와 [운영설정 &gt; 사용자 관리]를 모두 사용할 수 있습니다. 사용하신 초대코드는
            이제 만료되어 다시 쓸 수 없습니다.
          </p>
        </div>
      </div>
    );
  }

  // 1단계: 초대코드 확인. 코드가 확인되기 전에는 기관 정보를 묻지 않는다.
  if (!verified) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <h1 className="mb-1 text-2xl font-bold text-foreground sm:text-[28px]">기관 초기등록</h1>
          <p className="mb-6 text-base text-muted-foreground">
            WellLink 도입 기관용 화면입니다. 발급받으신 초대코드를 입력해 주세요.
          </p>
          <form onSubmit={handleVerify} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="inviteCode" className="text-base font-medium">초대코드</Label>
              <Input
                id="inviteCode"
                required
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="ABCD-EFGH-JKLM"
                className="h-[50px] font-mono text-lg md:text-lg"
                value={inviteCode}
                onChange={(e) => setInviteCode(formatInviteInput(e.target.value))}
              />
              <p className="text-[13px] text-muted-foreground">
                대소문자와 하이픈은 자동으로 맞춰집니다.
              </p>
            </div>
            {error && <p className="text-base text-destructive">{error}</p>}
            <Button
              type="submit"
              className="h-14 w-full text-lg font-semibold"
              disabled={checking || inviteCode.length !== 14}
            >
              {checking ? "확인 중..." : "다음"}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  // 2단계: 기관 정보 + 최초 관리자.
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-2xl font-bold text-foreground sm:text-[28px]">기관 초기등록</h1>
        <p className="mb-6 text-base text-muted-foreground">
          기관 정보와 최초 관리자 계정을 입력해 주세요. 만드신 관리자 계정으로 이후 직원·강사 설정을
          직접 하시게 됩니다.
        </p>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label className="text-base font-medium">기관코드</Label>
            <div className="rounded border border-border bg-muted px-3 py-2 font-mono text-sm text-foreground">
              {verified.orgCode}
            </div>
            <p className="text-[13px] text-muted-foreground">
              발급된 초대코드에 지정되어 있어 변경할 수 없습니다. 강사 로그인에 사용할 공개
              코드이며, 강사에게는 이 코드 또는 /instructor/login?org={verified.orgCode} 링크를
              안내합니다.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="organizationName" className="text-base font-medium">기관명</Label>
            <Input
              id="organizationName"
              className="h-[50px] text-lg md:text-lg"
              required
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adminName" className="text-base font-medium">최초 관리자 이름</Label>
            <Input
              id="adminName"
              className="h-[50px] text-lg md:text-lg"
              required
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adminEmail" className="text-base font-medium">최초 관리자 이메일</Label>
            <Input
              id="adminEmail"
              className="h-[50px] text-lg md:text-lg"
              type="email"
              autoComplete="email"
              required
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
            />
          </div>
          {error && <p className="text-base text-destructive">{error}</p>}
          <Button type="submit" className="h-14 w-full text-lg font-semibold" disabled={submitting}>
            {submitting ? "생성 중..." : "기관 생성"}
          </Button>
        </form>
      </div>
    </div>
  );
}
