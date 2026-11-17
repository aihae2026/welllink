import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  StaffLayout,
  Panel,
  PanelHeader,
  FilterBar,
  btnPrimaryCls,
  btnSecondaryCls,
  controlCls,
  theadCls,
  ListState,
} from "@/components/layout/StaffLayout";
import {
  useAnnualPlanRows,
  useBatchUpsertAnnualPlan,
  useBusinessYears,
  useUnitBusinessesForYear,
  type AnnualPlanActivityRow,
} from "@/lib/performance-data";
import { DIRECT_ENTRY_BADGE_CLS } from "@/lib/business-tree-visual";
import { AnnualPlanExcelDialog } from "@/components/management/AnnualPlanExcelDialog";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

export const Route = createFileRoute("/management/annual-plan")({
  head: () => ({
    meta: [
      { title: "연간계획 등록 — WellLink" },
      { name: "description", content: "사업연도별 활동 연간계획 목표를 등록합니다." },
      { property: "og:title", content: "연간계획 등록 — WellLink" },
      { property: "og:description", content: "활동별 연간계획 목표 등록 화면." },
    ],
  }),
  component: AnnualPlanPage,
});

const inputCls = "w-20 rounded border border-input bg-card px-2 py-1 text-sm text-right";
// w-0 + nowrap: 칸이 내용 폭까지만 줄어들고 남는 폭은 활동 칸으로 간다.
const labelCellCls = "px-4";
const numCellCls = "whitespace-nowrap px-3 text-right";

// 단위사업 선택의 "전체" 값 -- 실제 단위사업 id(uuid)와 겹치지 않는다
// (사업구조 화면 settings.organization.business.tsx와 같은 규칙).
const ALL_UNITS = "__all__";

type Draft = Record<string, { count: number | null; unique: number | null; total: number | null }>;

function toDraftValue(row: AnnualPlanActivityRow) {
  return { count: row.count.target, unique: row.unique.target, total: row.total.target };
}

function AnnualPlanPage() {
  const { data: years } = useBusinessYears();
  const [businessYearId, setBusinessYearId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!businessYearId && years && years.length > 0) {
      setBusinessYearId((years.find((y) => y.status === "active") ?? years[0])?.id);
    }
  }, [years, businessYearId]);

  const { data: unitBusinesses } = useUnitBusinessesForYear(businessYearId);
  const [unitBusinessId, setUnitBusinessId] = useState<string>(ALL_UNITS);
  const showAllUnits = unitBusinessId === ALL_UNITS;

  const {
    data,
    isLoading: planLoading,
    isError: planError,
    isFetching: planFetching,
    refetch: refetchPlan,
  } = useAnnualPlanRows(businessYearId);
  const allRows = data?.rows ?? [];
  // Final Batch A §28-30: 연간계획은 Excel-first로 대량입력하고, 화면에는
  // 선택한 단위사업(또는 전체) 범위의 활동을 대분류/중분류/활동 flat table로
  // 보여준다(accordion 대신 검토하기 쉬운 flat table -- §29). 전체일 때는
  // 드롭다운 순서대로 단위사업끼리 묶고, 단위사업 안의 순서는 그대로 둔다.
  const unitName = useMemo(
    () => new Map((unitBusinesses ?? []).map((u) => [u.id, u.name])),
    [unitBusinesses],
  );
  const rows = useMemo(() => {
    const source = data?.rows ?? [];
    if (!showAllUnits) return source.filter((r) => r.unitBusinessId === unitBusinessId);
    const order = new Map((unitBusinesses ?? []).map((u, i) => [u.id, i]));
    const rank = (id: string | null) => (id ? (order.get(id) ?? order.size) : order.size);
    return source
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r.unitBusinessId) - rank(b.r.unitBusinessId) || a.i - b.i)
      .map(({ r }) => r);
  }, [data, unitBusinesses, unitBusinessId, showAllUnits]);

  const [draft, setDraft] = useState<Draft>({});
  const [excelOpen, setExcelOpen] = useState(false);
  const batchSave = useBatchUpsertAnnualPlan();

  const valueOf = (r: AnnualPlanActivityRow, key: "count" | "unique" | "total") =>
    draft[r.activityId]?.[key] !== undefined ? draft[r.activityId]![key] : toDraftValue(r)[key];

  // 목표는 0 이상 정수만 받는다. 숫자가 아닌 글자는 아예 들어가지 않게 걸러서
  // "1,200"을 붙여넣으면 1200이 되고, 예전처럼 NaN이 저장돼 목표가 지워지지 않는다.
  function setValue(activityId: string, key: "count" | "unique" | "total", v: string) {
    const base = allRows.find((r) => r.activityId === activityId);
    if (!base) return;
    const digits = v.replace(/[^0-9]/g, "");
    const parsed = digits === "" ? null : Number(digits);
    setDraft((prev) => ({
      ...prev,
      [activityId]: { ...toDraftValue(base), ...prev[activityId], [key]: parsed },
    }));
  }

  const dirty = Object.keys(draft).length > 0;

  // 저장하지 않은 변경은 연도를 바꾸거나 다른 화면으로 가면 사라진다. 사라지기 전에 묻는다.
  const DISCARD_MESSAGE = "저장하지 않은 변경이 있습니다. 버리고 이동할까요?";
  function confirmDiscard(message = DISCARD_MESSAGE) {
    return !dirty || window.confirm(message);
  }
  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(DISCARD_MESSAGE),
    enableBeforeUnload: false,
  });

  async function save() {
    if (!businessYearId) return;
    // 전체↔단위사업을 오가며 고친 값도 저장되므로, 기준값(basis)은 화면에
    // 보이는 행이 아니라 연도 전체 행에서 찾는다.
    const toSave = Object.entries(draft).map(([activityId, v]) => {
      const original = allRows.find((r) => r.activityId === activityId);
      return {
        activity_id: activityId,
        count_target: v.count,
        count_basis: original?.count.basis ?? null,
        unique_target: v.unique,
        unique_basis: original?.unique.basis ?? null,
        total_target: v.total,
        total_basis: original?.total.basis ?? null,
      };
    });
    try {
      const count = await batchSave.mutateAsync({ businessYearId, rows: toSave });
      toast.success(`${count}개 활동의 연간계획을 저장했습니다.`);
      setDraft({});
    } catch (e: any) {
      toast.error(`저장 실패: ${errorReason(e)}`);
    }
  }

  return (
    <StaffLayout title="연간계획 등록" back={{ label: "실적보고", to: "/performance/report" }}>
      <FilterBar>
        <select
          className={controlCls}
          value={businessYearId ?? ""}
          onChange={(e) => {
            if (!confirmDiscard("저장하지 않은 변경이 있습니다. 버리고 다른 연도를 볼까요?")) {
              return;
            }
            setDraft({});
            setBusinessYearId(e.target.value);
            setUnitBusinessId(ALL_UNITS);
          }}
        >
          {years?.map((y) => (
            <option key={y.id} value={y.id}>
              {y.year}년
            </option>
          ))}
        </select>
        <select
          className={controlCls}
          value={unitBusinessId}
          onChange={(e) => setUnitBusinessId(e.target.value)}
        >
          <option value={ALL_UNITS}>단위사업 전체</option>
          {unitBusinesses?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <button
          className={btnSecondaryCls}
          onClick={() => {
            // Excel로 적용한 값이 표에 남아 있던 옛 변경으로 다시 덮이지 않게, 먼저 정리한다.
            if (!confirmDiscard("저장하지 않은 변경이 있습니다. 버리고 Excel로 등록할까요?")) {
              return;
            }
            setDraft({});
            setExcelOpen(true);
          }}
        >
          Excel 등록
        </button>
        <button
          className={`${btnPrimaryCls} ml-auto`}
          disabled={!dirty || batchSave.isPending}
          onClick={save}
        >
          변경사항 저장
        </button>
      </FilterBar>
      <p className="mb-3 text-[13px] text-muted-foreground">
        최초·대량 입력은 Excel 등록을, 오타나 소폭 수정은 아래 표에서 바로 입력한 뒤 [변경사항
        저장]을 이용해 주세요. 빈칸은 미입력(-), 0은 실제 계획값 0을 의미합니다.
      </p>

      <Panel>
        <PanelHeader title="활동별 연간계획" />
        <div className="overflow-x-auto">
          {/* 열 폭은 colgroup에서 명시한다(자동폭에 맡기면 활동 칸이 무너진다).
              폭은 실제 최장값 기준 -- 단위사업 "가족(세대)통합지원사업",
              활동 "친환경생활용품KIT" + [직접등록] 배지. 좁은 화면에서는 줄이지
              않고 min-width를 지킨 채 가로로 스크롤한다. */}
          <table
            className="w-full table-fixed text-sm"
            style={{ minWidth: showAllUnits ? 1120 : 920 }}
          >
            <colgroup>
              {showAllUnits && <col className="w-[200px]" />}
              <col className="w-[150px]" />
              <col className="w-[160px]" />
              <col className="w-[300px]" />
              <col className="w-[104px]" />
              <col className="w-[104px]" />
              <col className="w-[104px]" />
            </colgroup>
            <thead>
              <tr className={theadCls}>
                {showAllUnits && <th className={`${labelCellCls} py-2 font-medium`}>단위사업</th>}
                <th className={`${labelCellCls} py-2 font-medium`}>대분류</th>
                <th className={`${labelCellCls} py-2 font-medium`}>중분류</th>
                <th className="px-4 py-2 font-medium">활동</th>
                <th className={`${numCellCls} py-2 font-medium`}>건</th>
                <th className={`${numCellCls} py-2 font-medium`}>실인원</th>
                <th className={`${numCellCls} py-2 font-medium`}>연인원</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.activityId} className="border-b border-border last:border-0">
                  {showAllUnits && (
                    <td className={`${labelCellCls} py-2.5 text-muted-foreground`}>
                      {(r.unitBusinessId && unitName.get(r.unitBusinessId)) || "-"}
                    </td>
                  )}
                  <td className={`${labelCellCls} py-2.5 text-muted-foreground`}>{r.majorName}</td>
                  <td className={`${labelCellCls} py-2.5 text-muted-foreground`}>{r.middleName}</td>
                  <td className="break-keep px-4 py-2.5 text-foreground">
                    {r.activityName}
                    {r.isSummaryMethod && (
                      <span className={`${DIRECT_ENTRY_BADGE_CLS} whitespace-nowrap`}>
                        직접 등록
                      </span>
                    )}
                  </td>
                  {(["count", "unique", "total"] as const).map((key) => (
                    <td key={key} className={`${numCellCls} py-2.5`}>
                      <input
                        className={inputCls}
                        inputMode="numeric"
                        placeholder="-"
                        value={valueOf(r, key) === null ? "" : String(valueOf(r, key))}
                        onChange={(e) => setValue(r.activityId, key, e.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {(planLoading || planError || rows.length === 0) && (
                <tr>
                  <td
                    colSpan={showAllUnits ? 7 : 6}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    <ListState
                      loading={planLoading}
                      error={planError}
                      retrying={planFetching}
                      onRetry={() => refetchPlan()}
                      empty="등록된 활동이 없습니다."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {businessYearId && (
        <AnnualPlanExcelDialog
          open={excelOpen}
          onOpenChange={setExcelOpen}
          businessYearId={businessYearId}
          rows={rows}
          unitNames={unitName}
        />
      )}
    </StaffLayout>
  );
}
