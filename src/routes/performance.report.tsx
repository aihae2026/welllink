import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import {
  StaffLayout,
  Panel,
  PanelHeader,
  FilterBar,
  controlCls,
  btnPrimaryCls,
  btnSecondaryCls,
  theadCls,
  ListState,
} from "@/components/layout/StaffLayout";
import { downloadPerformanceReportExcel } from "@/lib/performance-report-excel";
import {
  useBusinessYears,
  usePerformanceReport,
  useUnitBusinessesForYear,
  type PerformanceReportRow,
  type ReportMetric,
} from "@/lib/performance-data";
import { TREE_INDENT, TREE_LEVEL_CLS } from "@/lib/business-tree-visual";
import { errorReason } from "@/lib/error-message";

export const Route = createFileRoute("/performance/report")({
  head: () => ({
    meta: [
      { title: "실적보고 — WellLink" },
      { name: "description", content: "사업연도·월/분기/연간 기준의 기관 총계와 실적보고 화면." },
      { property: "og:title", content: "실적보고 — WellLink" },
      { property: "og:description", content: "기간별 기관 총계 및 사업구조별 실적보고." },
    ],
  }),
  component: ReportPage,
});

const selectCls = controlCls;
const numCls = "px-2 py-2 text-right text-muted-foreground tabular-nums";
const groupBorder = "border-l border-slate-300/70";
// 사업구조별 상세의 고정 머리줄 전용: theadCls에서 반투명 배경(bg-muted/40)만 뺀 것.
const stickyTheadCls = "bg-muted text-left text-xs text-muted-foreground";
// 사업/활동 열을 가로 스크롤에서 왼쪽에 고정한다. 고정 칸은 뒤로 지나가는 숫자가 비치지 않게
// 불투명해야 하므로 행 배경(bg-muted/70 · /40)과 같은 색을 카드색과 섞어 칠하고, 경계선은
// collapse 테두리가 따라오지 않아 ::after 세로선으로 긋는다.
const stickyColCls =
  "sticky left-0 after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border";
const stickyUnitBg = "bg-[color-mix(in_oklab,var(--color-muted)_70%,var(--color-card))]";
const stickyMajorBg = "bg-[color-mix(in_oklab,var(--color-muted)_40%,var(--color-card))]";

function lastDayOfMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatRate(actual: number | null, plan: number | null): string {
  if (plan === null || plan === 0) return "-";
  if (actual === null) return "-";
  return `${((actual / plan) * 100).toFixed(1)}%`;
}

// 달성/미달 기준(누계 ÷ 연간계획): 분기 = 분기×25%, 월 = 해당 월까지 월수÷12, 연간 = 100%.
// 계획이 없거나 0이라 달성률이 "-"인 칸은 색을 칠하지 않는다.
type RateTarget = { ratio: number; label: string };

function rateTarget(
  periodType: "월" | "분기" | "연간",
  month: number,
  quarter: number,
): RateTarget {
  if (periodType === "분기")
    return { ratio: quarter / 4, label: `${quarter}분기 ${quarter * 25}%` };
  if (periodType === "월") {
    const pct = Math.round((month / 12) * 1000) / 10;
    return { ratio: month / 12, label: `${month}월 ${pct}%` };
  }
  return { ratio: 1, label: "연간 100%" };
}

// 달성 색: 상태 배지용 파랑(text-status-info-fg)은 표 숫자에선 남색처럼 어두워 보여 더 선명한 파랑을 쓴다.
const achievedCls = "text-blue-600";

function rateToneCls(actual: number | null, plan: number | null, target: RateTarget): string {
  if (plan === null || plan === 0 || actual === null) return "text-foreground";
  // 월 기준(예: 1/12)의 부동소수 오차로 딱 맞춘 실적이 미달로 보이지 않게 여유를 둔다.
  return actual / plan >= target.ratio - 1e-9 ? achievedCls : "text-status-danger-fg";
}

// 값이 없는 칸(계획 미입력 등)은 화면에서 "-"로 줄인다. 수십 칸에 "미입력"이 반복되면 숫자가
// 묻힌다. Excel 다운로드(performance-report-excel.ts)는 제출 문서라 "미입력" 글자를 그대로 쓴다.
const fmtMetric = (v: number | null) => (v === null ? "-" : v.toLocaleString());

const METRIC_ROWS = [
  { key: "count", label: "건" },
  { key: "unique", label: "실인원" },
  { key: "total", label: "연인원" },
] as const;

function MetricCells({ m, group }: { m: ReportMetric; group?: boolean }) {
  return (
    <>
      <td className={`${numCls} ${group ? groupBorder : ""}`}>{fmtMetric(m.count)}</td>
      <td className={numCls}>{fmtMetric(m.unique)}</td>
      <td className={numCls}>{fmtMetric(m.total)}</td>
    </>
  );
}

type TreeRow = {
  row: PerformanceReportRow;
  depth: number;
  uiLevel: "unit" | "major" | "middle" | "activity";
  unitId: string | null;
};

// legacy(major->middle->minor->activity)/new(major->middle->activity) 물리
// 구조를 모두 최종 대분류/중분류 2단계로 정규화한다(§ Core Setup Model
// Simplification Phase 1) -- src/lib/business-tree-normalize.ts와 동일한
// "자식이 또 자식(손자)을 가지면 그 자식을 대분류로 승격하고 root는 숨긴다"
// 판단을 이 화면이 받는 flat RPC row 모양에 맞춰 그대로 적용한다. 실제
// 데이터는 한 root 아래 자식들이 전부 legacy형이거나 전부 new형이며 섞이지
// 않는다(감사 완료) -- 섞인 경우는 root를 그대로 숨기는 단순화를 적용한다.
function computeUiLevels(nodes: PerformanceReportRow[]) {
  const childrenOf = new Map<string, PerformanceReportRow[]>();
  const roots: PerformanceReportRow[] = [];
  for (const n of nodes) {
    if (n.parentId) {
      const list = childrenOf.get(n.parentId) ?? [];
      list.push(n);
      childrenOf.set(n.parentId, list);
    } else {
      roots.push(n);
    }
  }
  const hiddenIds = new Set<string>();
  const uiLevel = new Map<string, "major" | "middle">();
  for (const root of roots) {
    const children = childrenOf.get(root.nodeId) ?? [];
    if (children.length === 0) {
      uiLevel.set(root.nodeId, "major");
      continue;
    }
    let anyLegacyChild = false;
    for (const child of children) {
      const grandchildren = childrenOf.get(child.nodeId) ?? [];
      if (grandchildren.length > 0) {
        anyLegacyChild = true;
        uiLevel.set(child.nodeId, "major");
        for (const gc of grandchildren) uiLevel.set(gc.nodeId, "middle");
      } else {
        uiLevel.set(child.nodeId, "middle");
      }
    }
    if (anyLegacyChild) {
      hiddenIds.add(root.nodeId);
    } else {
      uiLevel.set(root.nodeId, "major");
    }
  }
  return { hiddenIds, uiLevel };
}

// RPC는 활동(leaf) 전체 + 사업구조 노드(level별로 묶여) 를 flat하게 반환한다(화면에서
// reduce로 다시 집계하지 않는다는 원칙은 지키되, 트리 들여쓰기 표시 순서만 클라이언트에서
// parent_id 기준으로 재구성한다 -- 수치 계산은 전혀 하지 않는다).
function buildTree(rows: PerformanceReportRow[], unitId: string | null): TreeRow[] {
  const nodes = rows.filter((r) => r.nodeType !== "activity");
  const activities = rows.filter((r) => r.nodeType === "activity");
  const { hiddenIds, uiLevel } = computeUiLevels(nodes);
  const nodesByParent = new Map<string, PerformanceReportRow[]>();
  for (const n of nodes) {
    const key = n.parentId ?? "__root__";
    if (!nodesByParent.has(key)) nodesByParent.set(key, []);
    nodesByParent.get(key)!.push(n);
  }
  const activitiesByNode = new Map<string, PerformanceReportRow[]>();
  for (const a of activities) {
    if (!a.parentId) continue;
    if (!activitiesByNode.has(a.parentId)) activitiesByNode.set(a.parentId, []);
    activitiesByNode.get(a.parentId)!.push(a);
  }
  const bySort = (a: PerformanceReportRow, b: PerformanceReportRow) => a.sortOrder - b.sortOrder;

  const out: TreeRow[] = [];
  function visit(node: PerformanceReportRow, depth: number) {
    if (!hiddenIds.has(node.nodeId)) {
      out.push({ row: node, depth, uiLevel: uiLevel.get(node.nodeId) ?? "middle", unitId });
    }
    const nextDepth = hiddenIds.has(node.nodeId) ? depth : depth + 1;
    const children = [...(nodesByParent.get(node.nodeId) ?? [])].sort(bySort);
    const leafActs = [...(activitiesByNode.get(node.nodeId) ?? [])].sort(bySort);
    children.forEach((c) => visit(c, nextDepth));
    leafActs.forEach((a) => out.push({ row: a, depth: nextDepth, uiLevel: "activity", unitId }));
  }
  const roots = [...(nodesByParent.get("__root__") ?? [])].sort(bySort);
  roots.forEach((r) => visit(r, 0));
  return out;
}

function sumMetric(rows: PerformanceReportRow[], key: "plan" | "period" | "ytd"): ReportMetric {
  let count: number | null = null;
  let unique: number | null = null;
  let total: number | null = null;
  let countSet = false;
  let uniqueSet = false;
  let totalSet = false;
  for (const r of rows) {
    const m = r[key];
    if (m.count !== null) {
      count = (count ?? 0) + m.count;
      countSet = true;
    }
    if (m.unique !== null) {
      unique = (unique ?? 0) + m.unique;
      uniqueSet = true;
    }
    if (m.total !== null) {
      total = (total ?? 0) + m.total;
      totalSet = true;
    }
  }
  return {
    count: countSet ? count : key === "plan" ? null : 0,
    unique: uniqueSet ? unique : key === "plan" ? null : 0,
    total: totalSet ? total : key === "plan" ? null : 0,
  };
}

function ReportPage() {
  const { data: years } = useBusinessYears();
  const [businessYearId, setBusinessYearId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!businessYearId && years && years.length > 0) {
      setBusinessYearId((years.find((y) => y.status === "active") ?? years[0])?.id);
    }
  }, [years, businessYearId]);
  const currentYear = years?.find((y) => y.id === businessYearId)?.year ?? new Date().getFullYear();

  const [periodType, setPeriodType] = useState<"월" | "분기" | "연간">("분기");
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [quarter, setQuarter] = useState(Math.ceil((new Date().getMonth() + 1) / 3));
  const annual = periodType === "연간";
  const actualLabel =
    periodType === "월" ? "월간실적" : periodType === "분기" ? "분기실적" : "연간실적";

  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;
  const { periodStart, periodEnd } = useMemo(() => {
    if (periodType === "월") {
      return {
        periodStart: `${currentYear}-${pad2(month)}-01`,
        periodEnd: `${currentYear}-${pad2(month)}-${pad2(lastDayOfMonth(currentYear, month))}`,
      };
    }
    if (periodType === "분기") {
      const startMonth = (quarter - 1) * 3 + 1;
      const endMonth = startMonth + 2;
      return {
        periodStart: `${currentYear}-${pad2(startMonth)}-01`,
        periodEnd: `${currentYear}-${pad2(endMonth)}-${pad2(lastDayOfMonth(currentYear, endMonth))}`,
      };
    }
    return { periodStart: yearStart, periodEnd: yearEnd };
  }, [periodType, month, quarter, currentYear]);

  const {
    data: rows,
    isLoading: reportLoading,
    isError: reportError,
    isFetching: reportFetching,
    refetch: refetchReport,
  } = usePerformanceReport({
    businessYearId,
    periodStart,
    periodEnd,
    ytdStart: yearStart,
  });

  const { data: unitBusinesses } = useUnitBusinessesForYear(businessYearId);
  const [unitBusinessId, setUnitBusinessId] = useState("전체");

  // Final Batch A §26: 선택된 단위사업 기준으로 요약/상세가 동일 scope를
  // 쓴다. "전체"를 고르면 단위사업별 block으로 분리해서 보여준다.
  const scopes = useMemo(() => {
    if (unitBusinessId !== "전체") {
      const ub = unitBusinesses?.find((u) => u.id === unitBusinessId);
      return [
        {
          id: unitBusinessId,
          name: ub?.name ?? "",
          rows: (rows ?? []).filter((r) => r.unitBusinessId === unitBusinessId),
        },
      ];
    }
    return (unitBusinesses ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      rows: (rows ?? []).filter((r) => r.unitBusinessId === u.id),
    }));
  }, [rows, unitBusinesses, unitBusinessId]);

  const target = rateTarget(periodType, month, quarter);
  const [downloading, setDownloading] = useState(false);

  // 엑셀은 화면에서 접힌 활동까지 모두 담는다(요약 시트 + 사업구조별 상세 시트).
  async function handleDownload() {
    const showUnitRows = unitBusinessId === "전체";
    const orgTotal = orgTotalOf(scopes);
    const periodName =
      periodType === "월" ? `${month}월` : periodType === "분기" ? `${quarter}분기` : "연간";
    const scopeName = showUnitRows ? "전체" : (scopes[0]?.name ?? "");
    setDownloading(true);
    try {
      await downloadPerformanceReportExcel({
        fileName: `실적보고_${currentYear}년_${periodName}_${scopeName}.xlsx`.replace(
          /[\\/:*?"<>|\s]+/g,
          "_",
        ),
        title: `${currentYear}년 ${periodName} 실적보고 · ${scopeName}`,
        periodText: annual
          ? `기간 ${yearStart} ~ ${yearEnd}`
          : `${actualLabel} ${periodStart} ~ ${periodEnd} · 누계 ${yearStart} ~ ${periodEnd}`,
        annual,
        actualLabel,
        targetRatio: target.ratio,
        targetLabel: target.label,
        summary: {
          plan: orgTotal.plan,
          actual: annual ? orgTotal.ytd : orgTotal.period,
          ytd: orgTotal.ytd,
        },
        rows: buildReportTree(scopes, showUnitRows).map(({ row, uiLevel }) => ({
          label: row.label,
          level: uiLevel,
          plan: row.plan,
          actual: annual ? row.ytd : row.period,
          ytd: row.ytd,
        })),
      });
    } catch (e) {
      toast.error(`엑셀 파일을 만들지 못했습니다. ${errorReason(e)}`);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <StaffLayout
      title="실적보고"
      description="기간별 사업실적과 계획 대비 달성현황을 확인합니다."
      actions={
        <Link to="/management/annual-plan" className={btnSecondaryCls}>
          연간계획 등록
        </Link>
      }
    >
      <FilterBar>
        <select
          className={`${selectCls} w-40`}
          value={businessYearId ?? ""}
          onChange={(e) => {
            // 연도를 바꾸면 그 연도에 없는 단위사업 선택은 비운다(빈 표 방지).
            setBusinessYearId(e.target.value);
            setUnitBusinessId("전체");
          }}
        >
          {years?.map((y) => (
            <option key={y.id} value={y.id}>
              {y.year}년
            </option>
          ))}
        </select>
        <select
          className={`${selectCls} w-48`}
          value={unitBusinessId}
          onChange={(e) => setUnitBusinessId(e.target.value)}
        >
          <option value="전체">단위사업 전체</option>
          {unitBusinesses?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select
          className={`${selectCls} w-32`}
          value={periodType}
          onChange={(e) => setPeriodType(e.target.value as typeof periodType)}
        >
          <option>월</option>
          <option>분기</option>
          <option>연간</option>
        </select>
        {periodType === "월" && (
          <select
            className={`${selectCls} w-32`}
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m}월
              </option>
            ))}
          </select>
        )}
        {periodType === "분기" && (
          <select
            className={`${selectCls} w-28`}
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
        <button
          type="button"
          className={`${btnPrimaryCls} ml-auto`}
          onClick={handleDownload}
          disabled={!rows || scopes.length === 0 || downloading}
        >
          <Download className="size-4" strokeWidth={1.75} />
          Excel 다운로드
        </button>
      </FilterBar>

      {(reportLoading || reportError || scopes.length === 0) && (
        <Panel className="p-6">
          <p className="text-center text-sm text-muted-foreground">
            <ListState
              loading={reportLoading}
              error={reportError}
              retrying={reportFetching}
              onRetry={() => refetchReport()}
              empty="등록된 단위사업이 없습니다."
            />
          </p>
        </Panel>
      )}

      {!reportLoading && !reportError && scopes.length > 0 && (
        <ReportBody
          scopes={scopes}
          annual={annual}
          actualLabel={actualLabel}
          showUnitRows={unitBusinessId === "전체"}
          target={target}
        />
      )}
    </StaffLayout>
  );
}

// Final Batch A §26 후속: 단위사업 "전체"일 때 단위사업마다 요약+상세 Panel 한
// 세트를 통째로 반복하면 화면이 세로로 끝없이 길어져 비교가 불가능해진다. 전체일
// 때는 기관 총계 요약 1개 + 사업구조별 상세 1개만 두고, 상세 테이블 안에서
// 단위사업을 최상위 행(unit)으로 쭉 나열한다. 개별 단위사업을 고른 경우의 표현은
// 기존과 동일하다.
type ReportScope = { id: string; name: string; rows: PerformanceReportRow[] };

function orgTotalOf(scopes: ReportScope[]) {
  const majorRows = scopes.flatMap((s) => s.rows).filter((r) => r.nodeType === "major");
  return {
    plan: sumMetric(majorRows, "plan"),
    period: sumMetric(majorRows, "period"),
    ytd: sumMetric(majorRows, "ytd"),
  };
}

// 단위사업 행의 수치는 그 단위사업의 대분류(major) 합 -- 개별 단위사업을
// 선택했을 때의 실적 요약과 정확히 같은 값이다(활동을 화면에서 다시 집계하지
// 않는다는 원칙은 그대로 지킨다). 화면 표와 엑셀 다운로드가 같은 트리를 쓴다.
function buildReportTree(scopes: ReportScope[], showUnitRows: boolean): TreeRow[] {
  const out: TreeRow[] = [];
  for (const scope of scopes) {
    if (showUnitRows) {
      const scopeMajors = scope.rows.filter((r) => r.nodeType === "major");
      out.push({
        row: {
          nodeId: `unit:${scope.id}`,
          nodeType: "major",
          parentId: null,
          unitBusinessId: scope.id,
          label: scope.name,
          level: 0,
          sortOrder: 0,
          plan: sumMetric(scopeMajors, "plan"),
          period: sumMetric(scopeMajors, "period"),
          ytd: sumMetric(scopeMajors, "ytd"),
        },
        depth: 0,
        uiLevel: "unit",
        unitId: scope.id,
      });
    }
    for (const t of buildTree(scope.rows, scope.id)) {
      out.push(showUnitRows ? { ...t, depth: t.depth + 1 } : t);
    }
  }
  return out;
}

function ReportBody({
  scopes,
  annual,
  actualLabel,
  showUnitRows,
  target,
}: {
  scopes: ReportScope[];
  annual: boolean;
  actualLabel: string;
  showUnitRows: boolean;
  target: RateTarget;
}) {
  const rows = useMemo(() => scopes.flatMap((s) => s.rows), [scopes]);
  const orgTotal = useMemo(() => orgTotalOf(scopes), [scopes]);
  const tree = useMemo(() => buildReportTree(scopes, showUnitRows), [scopes, showUnitRows]);
  // Activity의 직접 부모(사업구조 노드 중 실제로 Activity를 갖는 가장 깊은
  // 레벨 -- legacy DB에서는 minor, migration 후에는 middle)만 접기/펼치기
  // 대상으로 삼는다. literal node_type === "minor"에 의존하지 않고, "이
  // nodeId가 실제로 어떤 Activity의 parentId로 쓰이는가"로 구조적으로
  // 판단한다(§ Core Setup Model Simplification Phase 1).
  const leafGroupIds = useMemo(
    () =>
      new Set(
        rows
          .filter((r) => r.nodeType === "activity" && r.parentId)
          .map((r) => r.parentId as string),
      ),
    [rows],
  );
  // Activity 29개가 처음부터 다 펼쳐지지 않게, leaf group 아래 activity는
  // 기본 접힘 상태로 시작한다(§ 운영 UX Gap Closure 22).
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const visibleTree = useMemo(
    () =>
      tree.filter((t) => {
        // 단위사업 행은 기본 펼침(collapsedGroups[key] === true일 때만 접힘)이며,
        // 접으면 그 아래 사업구조/활동을 통째로 감춘다.
        if (t.uiLevel !== "unit" && t.unitId && collapsedGroups[`unit:${t.unitId}`] === true) {
          return false;
        }
        if (t.uiLevel !== "activity") return true;
        const parentId = t.row.parentId;
        return parentId ? collapsedGroups[parentId] === false : true;
      }),
    [tree, collapsedGroups],
  );

  const summaryGroups: { label: string; m: ReportMetric }[] = annual
    ? [
        { label: "연간계획", m: orgTotal.plan },
        { label: actualLabel, m: orgTotal.ytd },
      ]
    : [
        { label: "연간계획", m: orgTotal.plan },
        { label: actualLabel, m: orgTotal.period },
        { label: "누계", m: orgTotal.ytd },
      ];

  return (
    <div className="mb-6">
      <Panel className="mb-4">
        <PanelHeader title="실적 요약" />
        {/* 지표(건·실인원·연인원)를 행으로, 연간계획·실적·누계·달성률을 열로 둔다. 12칸 가로표는
            1440px에서도 달성률 칸이 잘렸다 -- 4~5칸이라 휴대폰 폭에서도 가로 스크롤 없이 들어간다.
            640px 이상에서는 아래 사업구조별 상세와 칸 경계가 위아래로 맞도록 같은 열 구성(220 + 76×n,
            같은 최소폭)을 쓰고 각 칸을 3열씩 합친다. 상세표는 세로 스크롤바가 생기므로 두 표 모두
            scrollbar-gutter로 스크롤바 자리를 잡아 표 폭을 같게 한다. */}
        <div className="overflow-x-auto [scrollbar-gutter:stable]">
          <table
            className={`w-full table-fixed text-sm ${annual ? "sm:min-w-[904px]" : "sm:min-w-[1132px]"}`}
          >
            <colgroup>
              <col className="w-[64px] sm:w-[220px]" />
              {Array.from({ length: (summaryGroups.length + 1) * 3 }).map((_, i) => (
                <col key={i} className="sm:w-[76px]" />
              ))}
            </colgroup>
            <thead>
              <tr className={theadCls}>
                {/* 좁은 화면에서 가로로 밀어도 지표 칸은 상세표의 사업/활동 칸처럼 왼쪽에 고정한다.
                    머리줄 배경(bg-muted/40)은 반투명이라 같은 색을 카드색과 섞어 불투명하게 칠한다. */}
                <th
                  className={`px-2 py-2 text-left font-medium sm:px-4 ${stickyColCls} z-[1] ${stickyMajorBg}`}
                >
                  지표
                </th>
                {summaryGroups.map((g) => (
                  <th
                    key={g.label}
                    colSpan={3}
                    className={`px-2 py-2 text-right font-medium ${groupBorder}`}
                  >
                    {g.label}
                  </th>
                ))}
                <th colSpan={3} className={`px-2 py-2 text-right font-medium ${groupBorder}`}>
                  달성률
                </th>
              </tr>
            </thead>
          <tbody>
            {METRIC_ROWS.map(({ key, label }) => (
              <tr key={key} className="border-b border-border/60 last:border-0">
                <th
                  scope="row"
                  className={`px-2 py-2 text-left font-medium text-foreground sm:px-4 ${stickyColCls} z-[1] bg-card`}
                >
                  {label}
                </th>
                {summaryGroups.map((g) => (
                  <td key={g.label} colSpan={3} className={`${numCls} ${groupBorder}`}>
                    {fmtMetric(g.m[key])}
                  </td>
                ))}
                <td
                  colSpan={3}
                  className={`px-2 py-2 text-right font-medium tabular-nums ${groupBorder} ${rateToneCls(orgTotal.ytd[key], orgTotal.plan[key], target)}`}
                >
                  {formatRate(orgTotal.ytd[key], orgTotal.plan[key])}
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="사업구조별 상세" />
        {/* 표 안 세로 스크롤 높이를 화면 높이에 맞춘다: 페이지를 표까지 내리면 표가 화면을 꽉 채우고
            그 안에서만 스크롤된다(고정 머리줄 56px + 패널 제목줄 44px + 여백을 뺀 높이, 최소 400px).
            고정 560px일 때는 큰 화면에선 아래가 비고 작은 노트북에선 틀이 화면을 넘어 스크롤이 겹쳤다. */}
        <div className="max-h-[max(400px,calc(100dvh_-_7.5rem))] overflow-auto [scrollbar-gutter:stable]">
          <table
            className="w-full table-fixed text-sm"
            style={{ minWidth: 220 + (annual ? 3 : 4) * 3 * 76 }}
          >
            {/* 1440px 화면(표 영역 1135px)에 12칸이 들어가는 폭: 220 + 12×76 = 1132. 더 좁은 화면에서는
                가로로 밀어도 사업/활동 열이 왼쪽에 고정돼 어느 행의 숫자인지 계속 보인다. */}
            <colgroup>
              <col className="w-[220px]" />
              {Array.from({ length: (annual ? 3 : 4) * 3 }).map((_, i) => (
                <col key={i} className="w-[76px]" />
              ))}
            </colgroup>
            {/* 고정 머리줄은 불투명해야 한다: theadCls의 bg-muted/40이 bg-muted보다 CSS에서 뒤에 나와
                반투명 배경이 되면서 스크롤한 내용이 비쳐 겹쳐 보였다. 칸 경계선도 collapse 테두리는
                스크롤할 때 따라오지 않으므로 칸마다 안쪽 그림자로 긋는다. */}
            <thead className="sticky top-0 z-10 bg-muted [&_th]:shadow-[inset_0_-1px_0_var(--border)]">
              <tr className={`${stickyTheadCls} text-center`}>
                <th className={`px-4 py-2 text-left font-medium ${stickyColCls} z-20 bg-muted`} rowSpan={2}>
                  사업/활동
                </th>
                <th className={`px-2 py-2 text-center font-medium ${groupBorder}`} colSpan={3}>
                  연간계획
                </th>
                <th className={`px-2 py-2 text-center font-medium ${groupBorder}`} colSpan={3}>
                  {actualLabel}
                </th>
                {!annual && (
                  <th className={`px-2 py-2 text-center font-medium ${groupBorder}`} colSpan={3}>
                    누계
                  </th>
                )}
                <th className={`px-2 py-2 text-center font-medium ${groupBorder}`} colSpan={3}>
                  달성률
                </th>
              </tr>
              <tr className={`${stickyTheadCls} text-right`}>
                {Array.from({ length: annual ? 3 : 4 }).map((_, i) => (
                  <Fragment key={i}>
                    <th className={`px-2 py-1.5 text-right font-normal ${groupBorder}`}>건</th>
                    <th className="px-2 py-1.5 text-right font-normal">실인원</th>
                    <th className="px-2 py-1.5 text-right font-normal">연인원</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleTree.map(({ row, depth, uiLevel: level }) => {
                const rowCls = TREE_LEVEL_CLS[level];
                const actual = annual ? row.ytd : row.period;
                const isUnit = level === "unit";
                const isLeafGroup = !isUnit && leafGroupIds.has(row.nodeId);
                const isCollapsed = isUnit
                  ? collapsedGroups[row.nodeId] === true
                  : isLeafGroup
                    ? (collapsedGroups[row.nodeId] ?? true)
                    : false;
                const rowBg = isUnit ? "bg-muted/70" : level === "major" ? "bg-muted/40" : "";
                return (
                  <tr
                    key={row.nodeId}
                    className={`border-b border-border/60 last:border-0 ${rowBg}`}
                  >
                    <td
                      className={`px-4 py-2 ${rowCls} ${stickyColCls} z-[1] ${
                        isUnit ? stickyUnitBg : level === "major" ? stickyMajorBg : "bg-card"
                      }`}
                      style={{ paddingLeft: TREE_INDENT[level] }}
                    >
                      {isUnit || isLeafGroup ? (
                        <button
                          type="button"
                          className="flex items-center gap-1.5 text-left"
                          onClick={() =>
                            setCollapsedGroups((p) => ({ ...p, [row.nodeId]: !isCollapsed }))
                          }
                        >
                          <span className="text-xs text-muted-foreground">
                            {isCollapsed ? "▸" : "▾"}
                          </span>
                          {row.label}
                        </button>
                      ) : (
                        row.label
                      )}
                    </td>
                    <MetricCells m={row.plan} group />
                    <MetricCells m={actual} group />
                    {!annual && <MetricCells m={row.ytd} group />}
                    <td
                      className={`px-2 py-2 text-right tabular-nums ${groupBorder} ${rateToneCls(row.ytd.count, row.plan.count, target)}`}
                    >
                      {formatRate(row.ytd.count, row.plan.count)}
                    </td>
                    <td
                      className={`px-2 py-2 text-right tabular-nums ${rateToneCls(row.ytd.unique, row.plan.unique, target)}`}
                    >
                      {formatRate(row.ytd.unique, row.plan.unique)}
                    </td>
                    <td
                      className={`px-2 py-2 text-right tabular-nums ${rateToneCls(row.ytd.total, row.plan.total, target)}`}
                    >
                      {formatRate(row.ytd.total, row.plan.total)}
                    </td>
                  </tr>
                );
              })}
              {visibleTree.length === 0 && (
                <tr>
                  <td
                    colSpan={1 + (annual ? 3 : 4) * 3}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    조회된 실적이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2 text-[13px] text-muted-foreground">
          상위 사업의 값은 하위 활동 값의 합으로 표시합니다. 계획이 없는 칸과 달성률을 계산할 수
          없는 칸은 "-"로 표시합니다.
          <br />
          달성률은 누계 ÷ 연간계획이며, {target.label} 이상이면{" "}
          <span className={achievedCls}>파란색(달성)</span>, 미만이면{" "}
          <span className="text-status-danger-fg">빨간색(미달)</span>으로 표시합니다(분기별 25%씩,
          월은 월수÷12, 연간은 100% 기준).
        </p>
      </Panel>
    </div>
  );
}
