import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import {
  StaffLayout,
  Panel,
  controlCls,
  btnPrimaryCls,
  btnSecondaryCls,
} from "@/components/layout/StaffLayout";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBusinessYears } from "@/lib/performance-data";
import {
  AI_DRAFT_NOTICE,
  formatAchievementRate,
  formatMetricValue,
  formatPeriodHuman,
  useEvaluationDataPreview,
  useUnitBusinesses,
  useGenerateEvaluation,
  type PeriodType,
} from "@/lib/evaluation-data";
import {
  BLOCKED_PII_LABEL,
  PII_WARNING_LABEL,
  detectBlockedPii,
  type PiiMatch,
  type PiiWarningKind,
} from "@/lib/pii-guard";
import { toast } from "sonner";

export const Route = createFileRoute("/evaluation/new")({
  head: () => ({
    meta: [
      { title: "AI 사업평가 작성 — WellLink" },
      { name: "description", content: "단위사업·평가기간을 선택해 AI 사업평가를 작성합니다." },
      { property: "og:title", content: "AI 사업평가 작성 — WellLink" },
      { property: "og:description", content: "AI 사업평가 작성 화면." },
    ],
  }),
  component: EvaluationNewPage,
});

const fieldCls = controlCls;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function lastDayOfMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

const PERIOD_TYPE_OPTIONS: { value: PeriodType; label: string }[] = [
  { value: "quarter", label: "분기" },
  { value: "half_year", label: "반기" },
  { value: "year", label: "연간" },
  { value: "custom", label: "직접선택" },
];

function EvaluationNewPage() {
  const navigate = useNavigate();
  const { data: years } = useBusinessYears();
  const [businessYearId, setBusinessYearId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!businessYearId && years && years.length > 0) {
      setBusinessYearId((years.find((y) => y.status === "active") ?? years[0])?.id);
    }
  }, [years, businessYearId]);
  const currentYear = years?.find((y) => y.id === businessYearId)?.year ?? new Date().getFullYear();

  const { data: unitBusinesses } = useUnitBusinesses(businessYearId);
  const [unitBusinessId, setUnitBusinessId] = useState("");

  const [periodType, setPeriodType] = useState<PeriodType>("quarter");
  // 실적보고와 같이 오늘이 속한 분기를 기본으로 연다.
  const [quarter, setQuarter] = useState(Math.ceil((new Date().getMonth() + 1) / 3));
  const [half, setHalf] = useState<"상반기" | "하반기">("상반기");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [note, setNote] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;

  const { periodStart, periodEnd, rangeIncomplete, invertedRange, outsideYear } = useMemo(() => {
    if (periodType === "quarter") {
      const startMonth = (quarter - 1) * 3 + 1;
      const endMonth = startMonth + 2;
      return {
        periodStart: `${currentYear}-${pad2(startMonth)}-01`,
        periodEnd: `${currentYear}-${pad2(endMonth)}-${pad2(lastDayOfMonth(currentYear, endMonth))}`,
        rangeIncomplete: false,
        invertedRange: false,
        outsideYear: false,
      };
    }
    if (periodType === "half_year") {
      return half === "상반기"
        ? {
            periodStart: `${currentYear}-01-01`,
            periodEnd: `${currentYear}-06-30`,
            rangeIncomplete: false,
            invertedRange: false,
            outsideYear: false,
          }
        : {
            periodStart: `${currentYear}-07-01`,
            periodEnd: `${currentYear}-12-31`,
            rangeIncomplete: false,
            invertedRange: false,
            outsideYear: false,
          };
    }
    if (periodType === "year") {
      return {
        periodStart: yearStart,
        periodEnd: yearEnd,
        rangeIncomplete: false,
        invertedRange: false,
        outsideYear: false,
      };
    }
    return {
      periodStart: customStart,
      periodEnd: customEnd,
      rangeIncomplete: customStart === "" || customEnd === "",
      invertedRange: customStart !== "" && customEnd !== "" && customStart > customEnd,
      // 사업연도 밖 기간은 서버가 거부한다 -- 화면에서 먼저 막고 이유를 보여준다.
      outsideYear:
        (customStart !== "" && (customStart < yearStart || customStart > yearEnd)) ||
        (customEnd !== "" && (customEnd < yearStart || customEnd > yearEnd)),
    };
  }, [periodType, quarter, half, customStart, customEnd, currentYear]);

  const blockedPii = useMemo(() => detectBlockedPii(note), [note]);
  const piiDetected = blockedPii.length > 0;
  const [piiWarnings, setPiiWarnings] = useState<PiiMatch<PiiWarningKind>[] | null>(null);
  const generate = useGenerateEvaluation();
  const { data: preview } = useEvaluationDataPreview({
    businessYearId,
    unitBusinessId,
    periodType,
    periodStart,
    periodEnd,
  });

  const metrics = preview?.metrics ?? null;

  // Final QA Gap Fix §3: 사업실적이 0건이면 평가할 데이터가 없으므로 생성 자체를
  // 막는다(안내 문구는 기존대로 유지, 여기서는 버튼만 막는다). 연간계획 없음은
  // 별개 상황(달성률 평가만 제한)이므로 이 조건에 포함하지 않는다.
  const disabled =
    generate.isPending ||
    !unitBusinessId ||
    rangeIncomplete ||
    invertedRange ||
    outsideYear ||
    piiDetected ||
    !preview ||
    preview.performanceRecordCount === 0;

  // acknowledgePiiWarnings: 경고창에서 [그래도 생성]을 눌렀을 때만 true.
  const handleGenerate = async (acknowledgePiiWarnings = false) => {
    if (disabled) return;
    try {
      const result = await generate.mutateAsync({
        unitBusinessId,
        periodType,
        periodStart,
        periodEnd,
        referenceNote: note,
        idempotencyKey,
        acknowledgePiiWarnings,
      });
      if (result.status === "needs_confirmation") {
        setPiiWarnings(result.warnings);
        return;
      }
      navigate({
        to: "/evaluation/records/$evaluationId",
        params: { evaluationId: result.evaluationId },
      });
    } catch (e: any) {
      const code = e?.message as string | undefined;
      const message =
        code === "PII_DETECTED"
          ? "개인정보로 보이는 내용이 포함되어 있습니다. 해당 내용을 삭제한 후 다시 시도해 주세요."
          : code === "PII_CHECK_FAILED"
            ? "개인정보 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
            : code === "FORBIDDEN"
              ? "이 단위사업의 AI 사업평가를 작성할 권한이 없습니다."
              : code === "AI_NOT_CONFIGURED"
                ? "AI 사업평가 기능이 아직 설정되지 않았습니다. 관리자에게 문의해 주세요."
                : code === "AI_TIMEOUT"
                  ? "AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요."
                  : code === "AI_REQUEST_FAILED" || code === "AI_RESPONSE_INVALID"
                    ? "AI 사업평가 작성에 실패했습니다. 잠시 후 다시 시도해 주세요."
                    : "AI 사업평가 작성 중 오류가 발생했습니다. 다시 시도해 주세요.";
      toast.error(message);
      // 재시도는 같은 idempotency_key를 유지한다(중복 completed 방지). 사용자가 조건을 바꿔
      // 새로 생성하고 싶다면 이 화면을 다시 진입해 새 key를 받게 된다.
    }
  };

  return (
    <StaffLayout
      title="AI 사업평가 작성"
      description="연간계획과 사업실적을 바탕으로 사업 운영현황을 분석하고 평가 초안을 작성합니다."
      back={{ label: "AI 사업평가", to: "/evaluation/records" }}
    >
      <Panel className="p-5">
        <div className="max-w-2xl space-y-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              평가대상 단위사업 <span className="text-destructive">*</span>
            </label>
            <select
              className={`${fieldCls} w-64`}
              value={unitBusinessId}
              onChange={(e) => setUnitBusinessId(e.target.value)}
            >
              <option value="">선택</option>
              {unitBusinesses?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              평가기간 <span className="text-destructive">*</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={`${fieldCls} w-40`}
                value={businessYearId ?? ""}
                onChange={(e) => {
                  // 연도를 바꾸면 단위사업과 직접선택 기간은 비운다 -- 이전 연도 값으로
                  // 생성을 눌러 서버가 거부하는 일을 막는다.
                  setBusinessYearId(e.target.value);
                  setUnitBusinessId("");
                  setCustomStart("");
                  setCustomEnd("");
                }}
              >
                {years?.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.year}년
                  </option>
                ))}
              </select>
              <select
                className={`${fieldCls} w-32`}
                value={periodType}
                onChange={(e) => setPeriodType(e.target.value as PeriodType)}
              >
                {PERIOD_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {periodType === "quarter" && (
                <select
                  className={`${fieldCls} w-28`}
                  value={quarter}
                  onChange={(e) => setQuarter(Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((q) => (
                    <option key={q} value={q}>
                      {q}분기
                    </option>
                  ))}
                </select>
              )}
              {periodType === "half_year" && (
                <select
                  className={`${fieldCls} w-28`}
                  value={half}
                  onChange={(e) => setHalf(e.target.value as typeof half)}
                >
                  <option value="상반기">상반기</option>
                  <option value="하반기">하반기</option>
                </select>
              )}
            </div>

            {periodType === "custom" && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  className={fieldCls}
                  min={yearStart}
                  max={yearEnd}
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                />
                <span className="text-sm text-muted-foreground">~</span>
                <input
                  type="date"
                  className={fieldCls}
                  min={yearStart}
                  max={yearEnd}
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
                {outsideYear && (
                  <span className="text-[13px] text-status-danger-fg">
                    사업연도({yearStart} ~ {yearEnd}) 안의 기간만 평가할 수 있습니다.
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {currentYear}-01-01 ~ {currentYear}-12-31 범위 안에서만 선택할 수 있습니다.
                </span>
              </div>
            )}
            {invertedRange && (
              <p className="mt-1.5 text-xs text-destructive">종료일은 시작일 이후여야 합니다.</p>
            )}
            {!rangeIncomplete && !invertedRange && (
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                {formatPeriodHuman(periodType, periodStart, periodEnd)} 실적을 평가합니다.
              </p>
            )}
          </div>

          {unitBusinessId && !rangeIncomplete && !invertedRange && (
            <div className="rounded border border-border bg-muted/30 px-4 py-3 text-sm">
              <p className="mb-2 font-medium text-foreground">분석 데이터</p>
              <div className="space-y-1 text-muted-foreground">
                <p>
                  연간계획{" "}
                  <span className={preview?.hasAnnualPlan ? "text-foreground" : ""}>
                    {preview ? (preview.hasAnnualPlan ? "등록됨" : "미등록") : "확인 중..."}
                  </span>
                </p>
                <p>
                  사업실적{" "}
                  <span className="text-foreground">
                    {preview ? `${preview.performanceRecordCount}건` : "확인 중..."}
                  </span>
                </p>
                <p>
                  실적기간{" "}
                  <span className="text-foreground">
                    {formatPeriodHuman(periodType, periodStart, periodEnd)}
                  </span>
                </p>
              </div>
              {metrics && (
                <div className="mt-3 overflow-x-auto rounded border border-border bg-card">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="px-3 py-1.5 text-left font-medium">구분</th>
                        <th className="px-3 py-1.5 text-right font-medium">건</th>
                        <th className="px-3 py-1.5 text-right font-medium">실인원</th>
                        <th className="px-3 py-1.5 text-right font-medium">연인원</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {(
                        [
                          ["연간계획", metrics.plan],
                          ["평가기간 실적", metrics.period],
                          ["누계", metrics.ytd],
                        ] as const
                      ).map(([label, m]) => (
                        <tr key={label} className="border-b border-border/60">
                          <td className="px-3 py-1.5 text-foreground">{label}</td>
                          <td className="px-3 py-1.5 text-right">{formatMetricValue(m.count)}</td>
                          <td className="px-3 py-1.5 text-right">{formatMetricValue(m.unique)}</td>
                          <td className="px-3 py-1.5 text-right">{formatMetricValue(m.total)}</td>
                        </tr>
                      ))}
                      <tr>
                        <td className="px-3 py-1.5 text-foreground">누적 달성률</td>
                        {(["count", "unique", "total"] as const).map((k) => (
                          <td key={k} className="px-3 py-1.5 text-right">
                            {formatAchievementRate(metrics.ytd[k], metrics.plan[k])}
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                  <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                    AI는 위 공식 실적 수치를 그대로 사용합니다.
                  </p>
                </div>
              )}
              {preview && !preview.hasAnnualPlan && (
                <p className="mt-2 text-[13px] text-muted-foreground">
                  연간계획이 없어 달성률 평가는 포함되지 않습니다.
                </p>
              )}
              {preview && preview.performanceRecordCount === 0 && (
                <p className="mt-2 text-xs text-destructive">평가할 사업실적이 없습니다.</p>
              )}
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              평가 참고사항 <span className="text-muted-foreground">(선택)</span>
            </label>
            <textarea
              rows={4}
              // fieldCls의 고정 높이(h-9) 때문에 rows가 무시되어 한 줄만 보였다 -- 최소 4줄 높이를 준다.
              className={`${fieldCls} min-h-24 w-full resize-y py-2`}
              placeholder="예: 기관 행사로 일부 운영일정이 조정되었습니다."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {piiDetected && (
              <div className="mt-1.5 text-xs text-destructive">
                <p>
                  개인정보로 보이는 내용이 포함되어 있습니다. 해당 내용을 삭제한 후 다시 시도해
                  주세요.
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {blockedPii.map((m) => (
                    <li key={`${m.kind}:${m.text}`}>
                      {BLOCKED_PII_LABEL[m.kind]}: {m.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              실적만으로 알기 어려운 일정 변경, 행사, 외부 환경 등의 내용을 입력해 주세요.
            </p>
            <p className="mt-1 text-[13px]">
              <span className="rounded-sm bg-destructive/10 px-1 py-0.5 font-medium text-destructive [box-decoration-break:clone]">
                주민등록번호, 연락처, 주소, 회원명·회원번호, 민감정보(건강 등) 개인정보를 입력하지
                마세요.
              </span>
            </p>
          </div>
        </div>
      </Panel>

      <p className="mt-4 flex items-start gap-1.5 text-[13px] text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{AI_DRAFT_NOTICE}</span>
      </p>
      <div className="mt-3 flex justify-end">
        <button
          onClick={() => handleGenerate()}
          disabled={disabled}
          className={`${btnPrimaryCls} px-4 disabled:cursor-not-allowed`}
        >
          {generate.isPending ? "작성 중..." : "AI 사업평가 작성"}
        </button>
      </div>

      <Dialog open={piiWarnings !== null} onOpenChange={(v) => !v && setPiiWarnings(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>개인정보로 보이는 내용이 있습니다</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            평가 참고사항은 외부 AI로 전송되고 평가 기록에 저장됩니다. 아래 내용이 개인정보가 아닌
            경우에만 진행해 주세요.
          </p>
          <ul className="max-h-60 space-y-1 overflow-y-auto rounded border border-border bg-muted/30 px-4 py-3 text-sm">
            {piiWarnings?.map((m) => (
              <li key={`${m.kind}:${m.text}`} className="break-all">
                <span className="font-medium text-foreground">{PII_WARNING_LABEL[m.kind]}</span>
                <span className="text-muted-foreground"> · {m.text}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <button className={btnSecondaryCls} onClick={() => setPiiWarnings(null)}>
              수정하기
            </button>
            <button
              className={btnPrimaryCls}
              disabled={generate.isPending}
              onClick={() => {
                setPiiWarnings(null);
                void handleGenerate(true);
              }}
            >
              그래도 작성
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StaffLayout>
  );
}
