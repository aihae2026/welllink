import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { compareName } from "./format";
import { fetchAbsenceAlertStates } from "./attendance-data";
import { useOrganizationBasic } from "./org-settings-data";
import { shortCycleLabel, useOperationCycleSelection } from "./operation-cycle-selection";

// Home Dashboard Closure: 홈 대시보드 전용 read hook. 기존 테이블/RPC만
// 조회한다(§25). Mock 숫자 없음 -- 전부 실제 조회 결과.

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

// ============================================================
// 출석관리 Card: 오늘 프로그램 수 / 출석 누락 / 결석 주의대상
// ============================================================

export type AttendanceCardCounts = {
  todayProgramCount: number;
  missingCount: number;
};

// 홈이 세는 범위: 오늘이 포함된 기본 운영구분 + 올해 "연중". 끝난 상반기는 넣지
// 않는다. 누락 카드와 결석 주의대상 카드가 같은 범위를 쓴다(숫자가 서로 어긋나
// 보이지 않도록). 연중은 별도 컬럼 없이 이름으로만 구분된다
// (create_business_year, 20260909070000:117-118).
export function useHomeScope() {
  const { data: basic } = useOrganizationBasic();
  const { activeYearId, cycles, activeCycleId } = useOperationCycleSelection({});

  let cycleIds: string[] | null = null; // null = 아직 운영구분을 모름
  if (basic && !activeYearId) {
    cycleIds = [];
  } else if (activeYearId && cycles) {
    const annualIds = cycles
      .filter((c) => shortCycleLabel(c.name).trim() === "연중")
      .map((c) => c.id);
    cycleIds = [...new Set([...(activeCycleId ? [activeCycleId] : []), ...annualIds])];
  }

  const labels = (cycles ?? [])
    .filter((c) => cycleIds?.includes(c.id))
    .map((c) => shortCycleLabel(c.name).trim());
  const activeLabel = (cycles ?? []).find((c) => c.id === activeCycleId)?.name;
  const scopeLabel = [
    ...(activeLabel ? [shortCycleLabel(activeLabel).trim()] : []),
    ...labels.filter((l) => l === "연중"),
  ]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join("·");

  return {
    cycleIds,
    scopeLabel,
    yearId: activeYearId ?? undefined,
    cycleId: activeCycleId ?? undefined,
  };
}

export function useAttendanceCardCounts(cycleIds: string[] | null) {
  return useQuery({
    queryKey: ["home-attendance-card-counts", cycleIds],
    enabled: cycleIds !== null,
    queryFn: async (): Promise<AttendanceCardCounts> => {
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      // 운영 중인 운영구분이 하나도 없으면(운영연도 미등록 등) 빈 조건(in.())으로
      // 요청하지 않고 0건으로 둔다. 운영구분이 있을 때의 집계는 그대로다.
      const missingQuery =
        cycleIds && cycleIds.length > 0
          ? supabase
              .from("sessions")
              .select("id, operation_terms!inner(operation_cycle_id)", {
                count: "exact",
                head: true,
              })
              .eq("status", "missing")
              .in("operation_terms.operation_cycle_id", cycleIds)
          : Promise.resolve({ count: 0, error: null });

      const [today, missing] = await Promise.all([
        supabase
          .from("sessions")
          .select("id", { count: "exact", head: true })
          .gte("starts_at", startOfDay.toISOString())
          .lte("starts_at", endOfDay.toISOString()),
        missingQuery,
      ]);
      if (today.error) throw today.error;
      if (missing.error) throw missing.error;

      return {
        todayProgramCount: today.count ?? 0,
        missingCount: missing.count ?? 0,
      };
    },
  });
}

// 결석 주의대상(알림 중 인원)은 결석관리 화면의 기본 운영구분(오늘이 포함된
// 가장 짧은 구분)에 올해 "연중" 운영구분을 항상 더해서 센다 -- 끝난 상반기
// 인원은 넣지 않는다. 연중은 별도 표시 컬럼 없이 이름으로만 구분된다
// (create_business_year, 20260909070000:117-118).
export function useHomeAbsenceAlertCount() {
  const { cycleIds, scopeLabel, yearId, cycleId } = useHomeScope();

  const query = useQuery({
    queryKey: ["home-absence-alert-count", cycleIds],
    enabled: cycleIds !== null,
    queryFn: async (): Promise<number> => {
      const rows = await fetchAbsenceAlertStates(cycleIds ?? []);
      return rows.filter((r) => r.out_alert_active).length;
    },
  });

  // 결석관리 화면은 운영구분 하나만 보여주므로, 눌렀을 때는 기본 운영구분으로 보낸다.
  return { count: query.data, scopeLabel, yearId, cycleId };
}

// ============================================================
// 사업실적 Card: 이번 달 실적 총계 / 출석연동 / 직접등록
// ============================================================

export type PerformanceCardCounts = {
  total: number;
  attendance: number;
  summary: number;
};

export function usePerformanceCardCounts() {
  return useQuery({
    queryKey: ["home-performance-card-counts"],
    queryFn: async (): Promise<PerformanceCardCounts> => {
      const now = new Date();
      const from = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const to = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(lastDay)}`;

      const { data, error } = await supabase
        .from("performance_records")
        .select("method")
        .eq("status", "active")
        .gte("operation_date", from)
        .lte("operation_date", to);
      if (error) throw error;

      const rows = data ?? [];
      const attendance = rows.filter((r) => r.method === "attendance").length;
      const summary = rows.filter((r) => r.method === "summary").length;
      return { total: rows.length, attendance, summary };
    },
  });
}

// ============================================================
// AI 사업평가 Card: created_at 최신 1건
// ============================================================

export type LatestEvaluation = {
  id: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
};

export function useLatestEvaluation() {
  return useQuery({
    queryKey: ["home-latest-evaluation"],
    queryFn: async (): Promise<LatestEvaluation | null> => {
      const { data, error } = await supabase
        .from("ai_evaluations")
        .select("id, period_type, period_start, period_end")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        id: data.id,
        periodType: data.period_type,
        periodStart: data.period_start,
        periodEnd: data.period_end,
      };
    },
  });
}

// ============================================================
// 오늘의 프로그램: 오늘 예정된 회차 전체(시작시간 오름차순)
// ============================================================

export type TodaySessionRow = {
  sessionId: string;
  startsAt: string;
  endsAt: string;
  programName: string;
  programId: string | null;
  operationCycleId: string | null;
  status: string;
  hasSubmission: boolean;
  hasCorrection: boolean;
};

export function useTodaySessions() {
  return useQuery({
    queryKey: ["home-today-sessions"],
    queryFn: async (): Promise<TodaySessionRow[]> => {
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      const { data, error } = await supabase
        .from("sessions")
        .select(
          `id, starts_at, ends_at, status,
           operation_terms(program_id, operation_cycle_id, programs(name)),
           instructor_attendance_submissions(id),
           final_attendance(finalization_method)`,
        )
        .gte("starts_at", startOfDay.toISOString())
        .lte("starts_at", endOfDay.toISOString())
        .order("starts_at");
      if (error) throw error;

      return (data ?? [])
        .map((s: any) => ({
          sessionId: s.id as string,
          startsAt: s.starts_at as string,
          endsAt: s.ends_at as string,
          programName: (s.operation_terms?.programs?.name as string | undefined) ?? "-",
          programId: (s.operation_terms?.program_id as string | undefined) ?? null,
          operationCycleId: (s.operation_terms?.operation_cycle_id as string | undefined) ?? null,
          status: s.status as string,
          hasSubmission: (s.instructor_attendance_submissions ?? []).length > 0,
          hasCorrection: (s.final_attendance ?? []).some(
            (f: any) => f.finalization_method === "staff_correction",
          ),
        }))
        .sort((a, b) => {
          const t = a.startsAt.localeCompare(b.startsAt);
          if (t !== 0) return t;
          return compareName(a.programName, b.programName);
        });
    },
  });
}
