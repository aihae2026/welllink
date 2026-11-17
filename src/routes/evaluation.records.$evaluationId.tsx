import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Check, ChevronDown, Copy, Info } from "lucide-react";
import { StaffLayout, Panel, PanelHeader, theadCls } from "@/components/layout/StaffLayout";
import { formatDateTime } from "@/lib/format";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AI_DRAFT_NOTICE,
  formatAchievementRate as formatRate,
  formatMetricValue as metricValue,
  useEvaluationDetail,
  type EvaluationDetail,
  type MetricTriple,
} from "@/lib/evaluation-data";

export const Route = createFileRoute("/evaluation/records/$evaluationId")({
  head: () => ({
    meta: [
      { title: "AI 사업평가 상세 — WellLink" },
      { name: "description", content: "AI 사업평가 목록에서 진입하는 상세 화면입니다." },
      { property: "og:title", content: "AI 사업평가 상세 — WellLink" },
      { property: "og:description", content: "단위사업·평가기간·평가 기준 실적을 담은 평가 상세." },
    ],
  }),
  component: EvaluationDetailPage,
});

const numCls = "px-3 py-2 text-right text-muted-foreground tabular-nums";

const PERIOD_TYPE_LABEL: Record<string, string> = {
  quarter: "분기",
  half_year: "반기",
  year: "연간",
  custom: "직접선택",
};

// 클립보드 권한이 거부된 환경(임베디드/샌드박스 브라우저 등)에서도 조용히 실패하고,
// 실제로 복사가 되지 않았다면 "복사됨" 성공 피드백을 보여주지 않는다.
async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyIconButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={label}
            onClick={async () => {
              const ok = await copyText(text);
              if (!ok) return;
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            }}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {done ? (
              <Check className="size-4" strokeWidth={1.5} />
            ) : (
              <Copy className="size-4" strokeWidth={1.5} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{done ? "복사됨" : "복사"}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function MetricCells({ m }: { m: MetricTriple }) {
  return (
    <>
      <td className={numCls}>{metricValue(m.count)}</td>
      <td className={numCls}>{metricValue(m.unique)}</td>
      <td className={numCls}>{metricValue(m.total)}</td>
    </>
  );
}

function InfoItem({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`flex gap-4 border-b border-border/60 pb-2.5 ${full ? "sm:col-span-2" : ""}`}>
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

const RESULT_SECTIONS = [
  { key: "operationResult", title: "운영결과" },
  { key: "majorChanges", title: "주요 변화" },
  { key: "checkpoints", title: "점검사항" },
  { key: "futureDirection", title: "향후 운영방향" },
] as const;

function Detail({ ev }: { ev: EvaluationDetail }) {
  const [allCopied, setAllCopied] = useState(false);
  const sections = RESULT_SECTIONS.map((s) => ({ title: s.title, body: ev[s.key] }));
  const fullText = sections.map((s) => `${s.title}\n${s.body}`).join("\n\n");

  const snapshotRows: { label: string; metric: MetricTriple }[] = [
    { label: "연간계획", metric: ev.plan },
    { label: "평가기간 실적", metric: ev.period },
    { label: "누계", metric: ev.ytd },
    {
      label: "누적 달성률",
      metric: {
        count: null,
        unique: null,
        total: null,
      },
    },
  ];

  return (
    <>
      <Panel className="p-5">
        <dl className="grid gap-x-10 gap-y-3 text-sm sm:grid-cols-2">
          <InfoItem label="단위사업" value={ev.unitBusinessName} />
          <InfoItem label="평가기간" value={PERIOD_TYPE_LABEL[ev.periodType] ?? ev.periodType} />
          <InfoItem label="기간 범위" value={`${ev.periodStart} ~ ${ev.periodEnd}`} />
          <InfoItem label="작성일시" value={formatDateTime(ev.createdAt)} />
          <InfoItem label="작성자" value={ev.creatorName ?? "-"} />
          {ev.referenceNote && <InfoItem label="AI 참고사항" value={ev.referenceNote} full />}
        </dl>
      </Panel>

      <Panel className="mt-4">
        <PanelHeader
          title="평가 기준 실적"
          action={
            <span className="text-xs text-muted-foreground">평가 작성 당시 공식 실적 기준</span>
          }
        />
        <table className="w-full text-sm">
          <thead>
            <tr className={theadCls}>
              <th className="px-4 py-2 text-left font-medium">구분</th>
              <th className="px-3 py-2 text-right font-medium">건</th>
              <th className="px-3 py-2 text-right font-medium">실인원</th>
              <th className="px-3 py-2 text-right font-medium">연인원</th>
            </tr>
          </thead>
          <tbody>
            {snapshotRows.map((row) =>
              row.label === "누적 달성률" ? (
                <tr key={row.label} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 text-foreground">{row.label}</td>
                  <td className={numCls}>{formatRate(ev.ytd.count, ev.plan.count)}</td>
                  <td className={numCls}>{formatRate(ev.ytd.unique, ev.plan.unique)}</td>
                  <td className={numCls}>{formatRate(ev.ytd.total, ev.plan.total)}</td>
                </tr>
              ) : (
                <tr key={row.label} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 text-foreground">{row.label}</td>
                  <MetricCells m={row.metric} />
                </tr>
              ),
            )}
          </tbody>
        </table>

        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 border-t border-border px-4 py-2.5 text-sm text-muted-foreground hover:bg-muted/60">
            <ChevronDown
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
              strokeWidth={1.5}
            />
            세부 실적 보기
          </CollapsibleTrigger>
          <CollapsibleContent>
            <table className="w-full border-t border-border text-sm">
              <thead>
                <tr className={theadCls}>
                  <th className="px-4 py-2 text-left font-medium" rowSpan={2}>
                    활동
                  </th>
                  <th
                    className="border-l border-border px-3 py-2 text-center font-medium"
                    colSpan={3}
                  >
                    평가기간 실적
                  </th>
                  <th
                    className="border-l border-border px-3 py-2 text-center font-medium"
                    colSpan={3}
                  >
                    누계
                  </th>
                </tr>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="border-l border-border px-3 py-1.5 text-right font-medium">건</th>
                  <th className="px-3 py-1.5 text-right font-medium">실인원</th>
                  <th className="px-3 py-1.5 text-right font-medium">연인원</th>
                  <th className="border-l border-border px-3 py-1.5 text-right font-medium">건</th>
                  <th className="px-3 py-1.5 text-right font-medium">실인원</th>
                  <th className="px-3 py-1.5 text-right font-medium">연인원</th>
                </tr>
              </thead>
              <tbody>
                {ev.activities.map((a) => (
                  <tr key={a.activityId} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-foreground">{a.activityName}</td>
                    <MetricCells m={a.period} />
                    <MetricCells m={a.ytd} />
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapsibleContent>
        </Collapsible>
      </Panel>

      <Panel className="mt-4">
        <PanelHeader
          title="AI 사업평가 결과"
          action={
            <button
              onClick={async () => {
                const ok = await copyText(fullText);
                if (!ok) return;
                setAllCopied(true);
                setTimeout(() => setAllCopied(false), 1500);
              }}
              className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
            >
              {allCopied ? "복사됨" : "전체 복사"}
            </button>
          }
        />
        <p className="flex items-start gap-1.5 border-b border-border px-4 py-2 text-[13px] text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{AI_DRAFT_NOTICE}</span>
        </p>
        <div className="divide-y divide-border">
          {sections.map((s) => (
            <div key={s.title} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                <CopyIconButton text={s.body} label={`${s.title} 복사`} />
              </div>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

function EvaluationDetailPage() {
  const { evaluationId } = Route.useParams();
  const { data: ev, isLoading } = useEvaluationDetail(evaluationId);

  return (
    <StaffLayout
      title="AI 사업평가 상세"
      back={{ label: "AI 사업평가", to: "/evaluation/records" }}
    >
      {isLoading && (
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        </Panel>
      )}
      {!isLoading && !ev && (
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">해당 평가를 찾을 수 없습니다.</p>
        </Panel>
      )}
      {ev && <Detail ev={ev} />}
    </StaffLayout>
  );
}
