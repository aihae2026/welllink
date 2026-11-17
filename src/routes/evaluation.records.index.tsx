import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  StaffLayout,
  Panel,
  FilterBar,
  controlCls,
  btnPrimaryCls,
  theadCls,
  ListState,
} from "@/components/layout/StaffLayout";
import { useBusinessYears } from "@/lib/performance-data";
import { formatDateTime } from "@/lib/format";
import { formatPeriodHuman, useEvaluationsList, useUnitBusinesses } from "@/lib/evaluation-data";

export const Route = createFileRoute("/evaluation/records/")({
  head: () => ({
    meta: [
      { title: "AI 사업평가 — WellLink" },
      { name: "description", content: "작성된 AI 사업평가 내역을 조회하고 상세로 진입합니다." },
      { property: "og:title", content: "AI 사업평가 — WellLink" },
      { property: "og:description", content: "AI 사업평가 작성 내역 목록." },
    ],
  }),
  component: EvaluationRecordsPage,
});

const selectCls = controlCls;

// 같은 날 같은 기간 평가가 여러 건일 수 있어 시각까지 보인다("2026-09-15 14:32").

function EvaluationRecordsPage() {
  const navigate = useNavigate();
  const { data: years } = useBusinessYears();
  const [businessYearId, setBusinessYearId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!businessYearId && years && years.length > 0) {
      setBusinessYearId((years.find((y) => y.status === "active") ?? years[0])?.id);
    }
  }, [years, businessYearId]);

  const { data: unitBusinesses } = useUnitBusinesses(businessYearId);
  const [unitBusinessId, setUnitBusinessId] = useState("전체");

  const {
    data: rows,
    isLoading: rowsLoading,
    isError: rowsError,
    isFetching: rowsFetching,
    refetch: refetchRows,
  } = useEvaluationsList({
    businessYearId,
    ...(unitBusinessId !== "전체" ? { unitBusinessId } : {}),
  });

  return (
    <StaffLayout
      title="AI 사업평가"
      description="사업실적을 바탕으로 AI 사업평가 초안을 작성합니다."
    >
      <FilterBar>
        <select
          className={`${selectCls} w-40`}
          value={businessYearId ?? ""}
          onChange={(e) => {
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
        <Link to="/evaluation/new" className={`${btnPrimaryCls} ml-auto`}>
          + AI 사업평가 작성
        </Link>
      </FilterBar>

      <Panel>
        <table className="w-full min-w-[680px] table-fixed text-sm">
          <colgroup>
            <col className="w-[150px]" />
            <col />
            <col className="w-[160px]" />
            <col className="w-[120px]" />
          </colgroup>
          <thead>
            <tr className={theadCls}>
              <th className="px-4 py-2 font-medium">작성일시</th>
              <th className="px-4 py-2 font-medium">단위사업</th>
              <th className="px-4 py-2 font-medium">평가기간</th>
              <th className="px-4 py-2 font-medium">작성자</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((e) => (
              <tr
                key={e.id}
                onClick={() =>
                  navigate({
                    to: "/evaluation/records/$evaluationId",
                    params: { evaluationId: e.id },
                  })
                }
                className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/60"
              >
                <td className="px-4 py-2.5 text-muted-foreground tabular-nums">
                  {formatDateTime(e.createdAt)}
                </td>
                <td className="px-4 py-2.5 text-foreground">{e.unitBusinessName}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {formatPeriodHuman(e.periodType, e.periodStart, e.periodEnd)}
                </td>
                <td className="truncate px-4 py-2.5 text-muted-foreground">{e.creatorName ?? "-"}</td>
              </tr>
            ))}
            {(rowsLoading || rowsError || rows?.length === 0) && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <ListState
                    loading={rowsLoading}
                    error={rowsError}
                    retrying={rowsFetching}
                    onRetry={() => refetchRows()}
                    empty="조건에 해당하는 평가가 없습니다."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </StaffLayout>
  );
}
