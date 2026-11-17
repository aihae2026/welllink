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
import {
  methodLabel,
  useActivityIdsForUnitBusiness,
  useBusinessYears,
  usePerformanceRecords,
  useUnitBusinessesForYear,
} from "@/lib/performance-data";

export const Route = createFileRoute("/performance/records/")({
  // 고른 연도·기간·단위사업을 주소에 남긴다 -- 실적 상세에 다녀와도 같은 목록이 유지된다.
  validateSearch: (
    search: Record<string, unknown>,
  ): { yearId?: string; from?: string; to?: string; unitId?: string } => ({
    ...(typeof search["yearId"] === "string" ? { yearId: search["yearId"] } : {}),
    ...(typeof search["from"] === "string" ? { from: search["from"] } : {}),
    ...(typeof search["to"] === "string" ? { to: search["to"] } : {}),
    ...(typeof search["unitId"] === "string" ? { unitId: search["unitId"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "실적내역 — WellLink" },
      { name: "description", content: "등록된 사업실적 내역을 조회하고 상세로 진입합니다." },
      { property: "og:title", content: "실적내역 — WellLink" },
      { property: "og:description", content: "활동별 실적 등록 내역 목록." },
    ],
  }),
  component: RecordsPage,
});

const inputCls = controlCls;

function RecordsPage() {
  const navigate = useNavigate();
  const { data: years } = useBusinessYears();
  const search = Route.useSearch();
  // 선택은 주소가 보관한다. 값이 없으면 활성 연도와 그 연도 전체 기간이 기본이다.
  const businessYearId =
    search.yearId ?? (years?.find((y) => y.status === "active") ?? years?.[0])?.id;
  const currentYear = years?.find((y) => y.id === businessYearId);

  const { data: unitBusinesses } = useUnitBusinessesForYear(businessYearId);

  const from = search.from ?? (currentYear ? `${currentYear.year}-01-01` : "");
  const to = search.to ?? (currentYear ? `${currentYear.year}-12-31` : "");
  const unitBusinessId = search.unitId ?? "전체";
  const setSearch = (next: Partial<typeof search>) =>
    navigate({ to: "/performance/records", search: { ...search, ...next }, replace: true });
  // 연도를 바꾸면 기간·단위사업은 그 연도 기본값으로 되돌린다(빈 목록이 보이는 것 방지).
  const setYear = (yearId: string) =>
    navigate({ to: "/performance/records", search: { yearId }, replace: true });

  const { data: activityIds } = useActivityIdsForUnitBusiness(
    businessYearId,
    unitBusinessId !== "전체" ? unitBusinessId : undefined,
  );

  const {
    data: rows,
    isLoading: rowsLoading,
    isError: rowsError,
    isFetching: rowsFetching,
    refetch: refetchRows,
  } = usePerformanceRecords({
    businessYearId,
    from,
    to,
    ...(unitBusinessId !== "전체" ? { activityIds: activityIds ?? [] } : {}),
  });

  // 합계는 취소되지 않은 실적만 더한다. 실인원은 실적마다 따로 센 숫자라 더하면 같은 사람이
  // 중복되므로 합계를 내지 않는다(건 · 연인원만).
  const activeRows = rows?.filter((r) => r.status !== "cancelled") ?? [];
  const hasCancelled = (rows?.length ?? 0) > activeRows.length;
  const sumCount = activeRows.reduce((s, r) => s + (r.countValue ?? 0), 0);
  const sumTotal = activeRows.reduce((s, r) => s + (r.totalPeopleValue ?? 0), 0);

  return (
    <StaffLayout
      title="실적내역"
      description="자동 집계된 사업실적을 조회·확인하고, 필요한 경우 직접 등록합니다."
    >
      <FilterBar>
        <select
          value={businessYearId ?? ""}
          onChange={(e) => setYear(e.target.value)}
          className={`${inputCls} w-32`}
        >
          {years?.map((y) => (
            <option key={y.id} value={y.id}>
              {y.year}년
            </option>
          ))}
        </select>
        {/* 기간은 시작일 ~ 종료일을 한 묶음으로 둔다. 휴대폰에서는 연도 아래 한 줄에 함께
            내려가고(가운데서 끊기지 않게), 640px 이상은 연도 옆 같은 줄이다. */}
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <input
            type="date"
            value={from}
            onChange={(e) => setSearch({ from: e.target.value })}
            className={`${inputCls} min-w-0 flex-1 sm:flex-none`}
          />
          <span className="text-sm text-muted-foreground">~</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setSearch({ to: e.target.value })}
            className={`${inputCls} min-w-0 flex-1 sm:flex-none`}
          />
        </div>
        <select
          value={unitBusinessId}
          onChange={(e) => setSearch({ unitId: e.target.value })}
          className={`${inputCls} w-48`}
        >
          <option value="전체">단위사업 전체</option>
          {unitBusinesses?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <Link to="/performance/new" className={`${btnPrimaryCls} ml-auto`}>
          + 실적 직접 등록
        </Link>
      </FilterBar>

      <Panel>
        <table className="w-full min-w-[760px] table-fixed text-sm">
          <colgroup>
            <col className="w-[120px]" />
            <col />
            <col className="w-[110px]" />
            <col className="w-[70px]" />
            <col className="w-[80px]" />
            <col className="w-[80px]" />
          </colgroup>
          <thead>
            <tr className={theadCls}>
              <th className="px-4 py-2 font-medium">일자</th>
              <th className="px-4 py-2 font-medium">활동</th>
              <th className="px-4 py-2 font-medium">등록방식</th>
              <th className="px-4 py-2 text-right font-medium">건</th>
              <th className="px-4 py-2 text-right font-medium">실인원</th>
              <th className="px-4 py-2 text-right font-medium">연인원</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => (
              <tr
                key={row.id}
                onClick={() =>
                  navigate({
                    to: "/performance/records/$recordId",
                    params: { recordId: row.id },
                    search,
                  })
                }
                className={`cursor-pointer border-b border-border last:border-0 hover:bg-muted/60 ${
                  row.status === "cancelled" ? "text-muted-foreground/70" : ""
                }`}
              >
                <td className="px-4 py-2.5 text-muted-foreground tabular-nums">{row.operationDate}</td>
                <td
                  className={`px-4 py-2.5 font-medium text-foreground ${
                    row.status === "cancelled" ? "line-through opacity-60" : ""
                  }`}
                >
                  {row.activityName}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {row.method === "summary" ? (
                    <span className="inline-flex items-center rounded border border-status-info-border bg-status-info-bg px-1.5 py-0.5 text-xs font-medium text-status-info-fg">
                      직접 등록
                    </span>
                  ) : (
                    methodLabel(row.method)
                  )}
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
                  {row.countValue.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
                  {row.uniquePeopleValue.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right text-muted-foreground tabular-nums">
                  {row.totalPeopleValue.toLocaleString()}
                </td>
              </tr>
            ))}
            {(rowsLoading || rowsError || rows?.length === 0) && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  <ListState
                    loading={rowsLoading}
                    error={rowsError}
                    retrying={rowsFetching}
                    onRetry={() => refetchRows()}
                    empty={
                      <>
                        조회된 실적이 없습니다.
                        <br />
                        출석이 확정되면 프로그램 실적이 자동으로 집계됩니다.
                        <br />
                        출석과 연동되지 않는 실적은 실적 직접 등록을 이용해 주세요.
                      </>
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
          {rows && rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/30 font-medium text-foreground">
                <td colSpan={3} className="px-4 py-2.5">
                  합계{hasCancelled ? " (취소 제외)" : ""}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{sumCount.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-right text-muted-foreground">-</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{sumTotal.toLocaleString()}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </Panel>
    </StaffLayout>
  );
}
