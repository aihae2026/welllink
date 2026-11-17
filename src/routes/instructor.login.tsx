import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import {
  instructorLoginServerFn,
  instructorSetPinServerFn,
  resolveInstructorOrgServerFn,
  listInstructorLoginOrgsServerFn,
} from "@/lib/instructor-auth";

// Instructor Tablet Attendance + Login UX Lock: 강사 아이디(이름+휴대전화 뒤4자리) +
// PIN. 처음 쓰는 강사는 관리자가 발급한 6자리 시작코드를 PIN 칸에 넣는다(별도 "PIN 설정"
// 사전 진입점이 없다) -- 그 값으로 로그인하면 서버가 mustSetPin을 돌려주고, 이 경우 세션이
// 발급되지 않은 채 "새 PIN(6자리) 설정" 화면으로 간다. 새 PIN을 만들면 그때 처음 세션이
// 발급된다. ("현재 PIN 그대로 사용"은 없다.) 휴대전화 뒤4자리는 더 이상 최초 PIN이 아니다.
//
// Instructor Auth Organization Scope: 여기에 기관 선택이 추가된다. 강사 아이디는
// 기관 안에서만 유일하므로(성명+뒤4자리는 다른 기관과 겹칠 수 있다), 인증은 항상
// 선택한 기관의 기관코드 -> organization_id resolve 후 그 범위 안에서만 이뤄진다.
// 기관은 드롭다운으로 고른다(제품 결정 -- 기관명 공개를 감수하되 QA/테스트 기관은
// instructor_login_listed=false로 목록에서 뺀다). ?org=<기관코드>로 들어오면 기관을
// 자동 적용해 강사는 아이디+PIN만 입력한다. 단 드롭다운 값이든 query의 org 값이든
// 그 자체가 인증 근거는 아니다 -- 서버가 매번 다시 resolve한다.
export const Route = createFileRoute("/instructor/login")({
  // 기관 전용 링크(/instructor/login?org=well001). 형식만 가볍게 정리하고, 실제
  // 유효성은 서버에서 판단한다.
  validateSearch: (search: Record<string, unknown>): { org?: string } => {
    const org = typeof search["org"] === "string" ? search["org"].trim() : "";
    return org ? { org } : {};
  },
  head: () => ({
    meta: [{ title: "강사 로그인 — WellLink v1.0" }],
  }),
  component: InstructorLoginPage,
});

type Step = "login" | "set-pin";

const LOCKED_MESSAGE =
  "로그인을 여러 번 잘못 시도하여 잠겼습니다. 15분 후 다시 시도해 주세요.";
const ID_FORMAT_ERROR = "아이디는 이름과 휴대전화 뒤 4자리를 붙여 입력해 주세요.";
const PIN_LENGTH_ERROR = "PIN 또는 시작코드(숫자 4~6자리)를 입력해 주세요.";
const CODE_EXPIRED_ERROR =
  "시작코드를 쓸 수 없습니다. 사용 기간(7일)이 지났거나 아직 발급되지 않았습니다. 관리자에게 새 시작코드를 요청해 주세요.";
const NEW_PIN_LENGTH_ERROR = "새 PIN은 숫자 6자리로 입력해 주세요.";
const PIN_WEAK_ERROR =
  "이 PIN은 쓸 수 없습니다. 같은 숫자 반복(111111), 연속 숫자(123456), 휴대전화 뒤 4자리가 들어간 PIN은 피해 주세요.";
const ORG_REQUIRED_ERROR = "기관을 선택해 주세요.";
const ORG_LIST_ERROR = "기관 목록을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.";
// 기관이 틀렸는지 아이디/PIN이 틀렸는지 구분해서 알려주지 않는다.
const LOGIN_INVALID_ERROR = "기관 또는 로그인 정보를 확인해 주세요.";

// "김역삼1234" 또는 "김역삼 1234"(이름/숫자 사이 공백 허용) -> { name: "김역삼", phoneLast4: "1234" }.
function parseInstructorId(raw: string): { name: string; phoneLast4: string } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\S.*?)\s*([0-9]{4})$/);
  if (!match) return null;
  const name = match[1]!.trim();
  const phoneLast4 = match[2]!;
  if (!name || /^[0-9]+$/.test(name)) return null;
  return { name, phoneLast4 };
}

function InstructorLoginPage() {
  const navigate = useNavigate();
  const { org: orgFromLink } = Route.useSearch();
  const [step, setStep] = useState<Step>("login");
  const [orgCode, setOrgCode] = useState("");
  // 링크로 받은 기관코드가 실제 기관으로 확인되면 기관명만 보여주고 선택을 다시
  // 요구하지 않는다. 확인되지 않으면 그냥 드롭다운 화면으로 둔다.
  const [linkedOrgName, setLinkedOrgName] = useState<string | null>(null);
  const [orgOptions, setOrgOptions] = useState<{ orgCode: string; name: string }[] | null>(null);
  const [orgListFailed, setOrgListFailed] = useState(false);
  const [instructorId, setInstructorId] = useState("");
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newPinConfirm, setNewPinConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{ name: string; phoneLast4: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await listInstructorLoginOrgsServerFn();
        if (!active) return;
        if (!result.ok) {
          setOrgListFailed(true);
          return;
        }
        setOrgOptions(result.orgs);
        // 선택지가 하나뿐이면 미리 골라 둔다 -- 강사가 한 단계 덜 밟게 한다.
        const only = result.orgs.length === 1 ? result.orgs[0] : undefined;
        if (only) setOrgCode((prev) => prev || only.orgCode);
      } catch {
        if (active) setOrgListFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!orgFromLink) return;
    let active = true;
    (async () => {
      try {
        const result = await resolveInstructorOrgServerFn({ data: { orgCode: orgFromLink } });
        if (!active || !result.ok) return;
        setOrgCode(result.orgCode);
        setLinkedOrgName(result.name);
      } catch {
        // 확인에 실패하면 드롭다운으로 기관을 고르는 기본 화면으로 둔다.
      }
    })();
    return () => {
      active = false;
    };
  }, [orgFromLink]);

  const establishSession = async (accessToken: string, refreshToken: string) => {
    const { error: setSessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (setSessionError) {
      setError("로그인 처리 중 오류가 발생했습니다. 다시 시도해 주세요.");
      return false;
    }
    return true;
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!orgCode) {
      setError(ORG_REQUIRED_ERROR);
      return;
    }
    const parsed = parseInstructorId(instructorId);
    if (!parsed) {
      setError(ID_FORMAT_ERROR);
      return;
    }
    if (pin.length < 4) {
      setError(PIN_LENGTH_ERROR);
      return;
    }

    setSubmitting(true);
    try {
      const result = await instructorLoginServerFn({
        data: { orgCode, name: parsed.name, phoneLast4: parsed.phoneLast4, pin },
      });
      if (!result.ok) {
        setError(
          result.reason === "locked"
            ? LOCKED_MESSAGE
            : result.reason === "code_expired"
              ? CODE_EXPIRED_ERROR
              : LOGIN_INVALID_ERROR,
        );
        setSubmitting(false);
        return;
      }
      setIdentity(parsed);
      if (result.mustSetPin) {
        // 아직 세션이 없다. 방금 입력한 PIN(pin)을 현재 PIN으로 함께 보내 새 PIN을 만든다.
        setNewPin("");
        setNewPinConfirm("");
        setStep("set-pin");
        setSubmitting(false);
        return;
      }
      const ok = await establishSession(result.accessToken, result.refreshToken);
      if (!ok) {
        setSubmitting(false);
        return;
      }
      navigate({ to: "/instructor" });
    } catch {
      setError("로그인 처리 중 오류가 발생했습니다. 다시 시도해 주세요.");
      setSubmitting(false);
    }
  };

  const handleSetPin = async (e: FormEvent) => {
    e.preventDefault();
    if (!identity) return;
    if (newPin.length !== 6) {
      setError(NEW_PIN_LENGTH_ERROR);
      return;
    }
    if (newPin !== newPinConfirm) {
      setError("PIN이 서로 일치하지 않습니다.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await instructorSetPinServerFn({
        data: {
          orgCode,
          name: identity.name,
          phoneLast4: identity.phoneLast4,
          currentPin: pin,
          newPin,
        },
      });
      if (!result.ok) {
        setError(
          result.reason === "locked"
            ? LOCKED_MESSAGE
            : result.reason === "weak"
              ? PIN_WEAK_ERROR
              : result.reason === "code_expired"
                ? CODE_EXPIRED_ERROR
                : "PIN 설정 중 오류가 발생했습니다. 처음부터 다시 로그인해 주세요.",
        );
        setSubmitting(false);
        return;
      }
      const ok = await establishSession(result.accessToken, result.refreshToken);
      if (!ok) {
        setSubmitting(false);
        return;
      }
      navigate({ to: "/instructor" });
    } catch {
      setError("PIN 설정 중 오류가 발생했습니다. 다시 시도해 주세요.");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <h1
          className={`${step === "login" ? "mb-1" : "mb-6"} text-2xl font-bold text-foreground sm:text-[28px]`}
        >
          강사 로그인
        </h1>
        {step === "login" && (
          <p className="mb-6 text-base text-muted-foreground">
            {linkedOrgName
              ? "강사 아이디와 PIN을 입력해 주세요."
              : "기관을 선택하고 강사 아이디와 PIN을 입력해 주세요."}
          </p>
        )}

        {step === "login" && (
          <form onSubmit={handleLogin} className="space-y-5">
            {linkedOrgName ? (
              // 기관 전용 링크로 들어온 경우: 기관을 다시 고르게 하지 않고 어느
              // 기관으로 로그인하는지만 확인시켜 준다. 강사는 아이디+PIN만 입력한다.
              <div className="space-y-2">
                <Label className="text-base font-medium">기관</Label>
                <div className="flex h-14 items-center rounded-md border border-input bg-muted px-3 text-lg text-foreground shadow-sm">
                  {linkedOrgName}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="orgCode" className="text-base font-medium">
                  기관
                </Label>
                {/* 태블릿/휴대폰에서 OS 기본 선택창이 크게 뜨도록 native select를 쓴다.
                    겉모양만 Input과 맞추고(그림자/테두리/포커스), 화살표는 직접 그린다. */}
                <div className="relative">
                  <select
                    id="orgCode"
                    required
                    value={orgCode}
                    onChange={(e) => setOrgCode(e.target.value)}
                    disabled={orgOptions === null}
                    className="h-14 w-full appearance-none rounded-md border border-input bg-transparent pl-3 pr-11 text-lg text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="">
                      {orgOptions === null && !orgListFailed
                        ? "불러오는 중..."
                        : "기관을 선택해 주세요"}
                    </option>
                    {(orgOptions ?? []).map((o) => (
                      <option key={o.orgCode} value={o.orgCode}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    aria-hidden
                    className="pointer-events-none absolute right-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
                  />
                </div>
                {orgListFailed && <p className="text-base text-destructive">{ORG_LIST_ERROR}</p>}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="instructorId" className="text-base font-medium">
                강사 아이디
              </Label>
              <Input
                id="instructorId"
                placeholder="예: 김역삼1234"
                required
                // 기관코드가 이미 링크로 정해진 경우에만 여기가 첫 입력칸이다.
                autoFocus={Boolean(linkedOrgName)}
                value={instructorId}
                onChange={(e) => setInstructorId(e.target.value)}
                className="h-14 text-lg md:text-lg"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pin" className="text-base font-medium">
                PIN 또는 시작코드(숫자)
              </Label>
              <Input
                id="pin"
                type="password"
                inputMode="numeric"
                maxLength={6}
                required
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                className="h-14 text-lg tracking-widest md:text-lg"
              />
              <p className="text-base text-muted-foreground">
                처음 쓰시는 분은 관리자에게 받은 시작코드 6자리를 넣어 주세요. 다음 화면에서 앞으로
                쓰실 6자리 PIN을 만듭니다.
              </p>
            </div>
            {error && <p className="text-base text-destructive">{error}</p>}
            <Button
              type="submit"
              className="h-14 w-full text-lg font-semibold"
              disabled={submitting}
            >
              {submitting ? "로그인 중..." : "로그인"}
            </Button>
          </form>
        )}

        {step === "set-pin" && (
          <>
            <p className="mb-6 text-base text-muted-foreground">
              {identity?.name} 님, 처음 로그인하셨거나 PIN을 새로 만들어야 합니다. 앞으로 사용하실
              6자리 PIN을 설정해 주세요.
            </p>
            <form onSubmit={handleSetPin} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="newPin" className="text-base font-medium">
                  새 PIN
                </Label>
                <Input
                  id="newPin"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  autoFocus
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                  className="h-14 text-lg tracking-widest md:text-lg"
                />
                <p className="text-base text-muted-foreground">
                  숫자 6자리를 입력해 주세요. 같은 숫자 반복, 연속 숫자, 휴대전화 뒤 4자리가 들어간
                  PIN은 쓸 수 없습니다.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPinConfirm" className="text-base font-medium">
                  PIN 확인
                </Label>
                <Input
                  id="newPinConfirm"
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  required
                  value={newPinConfirm}
                  onChange={(e) =>
                    setNewPinConfirm(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))
                  }
                  className="h-14 text-lg tracking-widest md:text-lg"
                />
              </div>
              {error && <p className="text-base text-destructive">{error}</p>}
              <Button
                type="submit"
                className="h-14 w-full text-lg font-semibold"
                disabled={submitting}
              >
                {submitting ? "설정 중..." : "PIN 설정"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setPin("");
                  setNewPin("");
                  setNewPinConfirm("");
                  setStep("login");
                }}
                className="w-full text-center text-base text-muted-foreground hover:text-foreground"
              >
                처음으로
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
