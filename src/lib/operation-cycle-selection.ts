import { useOperationCycles, type OperationCycleRow } from "@/lib/programs-data";
import { useOrganizationBasic } from "@/lib/org-settings-data";

export type BusinessYearOption = { id: string; year: number; status: string };

// Program Settings Final Design Lock §7/§10: 자동생성된 운영구분 이름은
// 연도 접두어 없이 저장된다("상반기"). 기존 기관의 수동생성 이름("2026년
// 상반기")과 섞여 있을 수 있으므로 표시할 때는 접두어를 항상 벗겨서 짧게
// 보여준다 -- 연도는 상단 selector에서 이미 보여주므로 반복하지 않는다.
export function shortCycleLabel(name: string) {
  return name.replace(/^\d{4}년\s*/, "");
}

function todayLocalIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// 기본 운영연도는 "오늘이 속한 달력 연도". business_years에는 시작/종료일이
// 없고 year 정수만 있으므로(20260906071732_program_operations_foundation.sql)
// 달력 연도로 판정하고, 해당 연도가 없으면 기존처럼 최신 연도로 떨어진다.
export function pickDefaultYearId(years: BusinessYearOption[]): string | null {
  if (years.length === 0) return null;
  const thisYear = new Date().getFullYear();
  return (years.find((y) => y.year === thisYear) ?? years[0])?.id ?? null;
}

function cycleSpanDays(c: OperationCycleRow) {
  return (Date.parse(c.endDate) - Date.parse(c.startDate)) / 86400000;
}

// 기본 운영구분은 "오늘이 운영기간에 포함된 구분". 하반기와 연중처럼 여러
// 구분이 동시에 오늘을 포함할 수 있으므로 기간이 가장 짧은(= 가장 구체적인)
// 구분을 우선한다. 동률이면 list_operation_cycles의 정렬(start_date desc)을
// 그대로 따라 늦게 시작한 구분이 선택된다. 오늘을 포함하는 구분이 없으면
// (지난 연도/미래 연도를 보는 경우) 기존 동작대로 목록 첫 번째를 쓴다.
export function pickDefaultCycleId(cycles: OperationCycleRow[] | undefined): string | null {
  if (!cycles || cycles.length === 0) return null;
  const today = todayLocalIso();
  const current = cycles.filter((c) => c.startDate <= today && today <= c.endDate);
  if (current.length === 0) return cycles[0]?.id ?? null;
  return current.reduce((a, b) => (cycleSpanDays(b) < cycleSpanDays(a) ? b : a)).id;
}

/**
 * 운영연도/운영구분 선택 상태를 계산한다. 선택값(yearId/cycleId)은 호출하는
 * 화면이 보관한다 -- 프로그램 설정은 로컬 state, 결석관리는 탭 사이를 오가야
 * 하므로 URL search param을 쓴다. 선택값이 없거나 현재 목록에 없는 값이면
 * 위의 "오늘 기준" 기본값으로 떨어진다.
 */
export function useOperationCycleSelection(selected: {
  yearId?: string | null | undefined;
  cycleId?: string | null | undefined;
}) {
  const { data: basic } = useOrganizationBasic();
  const years = basic?.years ?? [];
  const activeYearId =
    (selected.yearId && years.some((y) => y.id === selected.yearId) ? selected.yearId : null) ??
    pickDefaultYearId(years);

  const { data: cycles, isLoading: cyclesLoading } = useOperationCycles(activeYearId);
  const activeCycleId =
    (selected.cycleId && cycles?.some((c) => c.id === selected.cycleId)
      ? selected.cycleId
      : null) ?? pickDefaultCycleId(cycles);
  const activeCycle = cycles?.find((c) => c.id === activeCycleId) ?? null;

  return {
    years,
    cycles,
    cyclesLoading,
    activeYearId,
    activeCycleId,
    activeCycle,
    activeCycleLabel: activeCycle ? shortCycleLabel(activeCycle.name) : "",
  };
}
