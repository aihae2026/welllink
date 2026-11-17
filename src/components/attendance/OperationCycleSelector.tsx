import type { OperationCycleRow } from "@/lib/programs-data";
import { shortCycleLabel, type BusinessYearOption } from "@/lib/operation-cycle-selection";

// 운영연도 select + 운영구분 버튼. 프로그램 설정·결석관리가 공통으로 쓴다.
// 선택 상태/기본값 계산은 useOperationCycleSelection(lib)에서 한다.
export function OperationCycleSelector({
  years,
  cycles,
  cyclesLoading,
  activeYearId,
  activeCycleId,
  onYearChange,
  onCycleChange,
  period,
}: {
  years: BusinessYearOption[];
  cycles: OperationCycleRow[] | undefined;
  cyclesLoading: boolean;
  activeYearId: string | null;
  activeCycleId: string | null;
  onYearChange: (yearId: string) => void;
  onCycleChange: (cycleId: string) => void;
  // 선택한 운영구분의 기간. 버튼 줄 오른쪽 끝에 "운영기간: 시작 ~ 끝"으로 보여준다.
  period?: { startDate: string; endDate: string } | null;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {years.length > 0 && (
        <select
          aria-label="운영연도"
          className="h-9 rounded border border-input bg-card px-2.5 text-sm"
          value={activeYearId ?? ""}
          onChange={(e) => onYearChange(e.target.value)}
        >
          {years.map((y) => (
            <option key={y.id} value={y.id}>
              {y.year}년
            </option>
          ))}
        </select>
      )}

      {!cyclesLoading && cycles && cycles.length > 0 && (
        <div className="flex gap-1">
          {cycles.map((c) => (
            <button
              key={c.id}
              onClick={() => onCycleChange(c.id)}
              className={`rounded border px-3 py-1.5 text-sm ${
                activeCycleId === c.id
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {shortCycleLabel(c.name)}
            </button>
          ))}
        </div>
      )}

      {period && (
        <span className="text-sm text-muted-foreground tabular-nums sm:ml-auto">
          운영기간: {period.startDate} ~ {period.endDate}
        </span>
      )}
    </div>
  );
}
