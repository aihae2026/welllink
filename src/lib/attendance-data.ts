import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { compareName } from "./format";

// Pipeline 1 / Batch 1.2: 출석관리 E2E 실제 Supabase data layer.
// 사유결석 / 강사 출석저장(raw) / 공식출석(final) / 직원 정정·누락보완 /
// 결석누계(파생 view) / 결석알림 dismiss.

export type AttendanceMark = "present" | "absent" | "excused";

// Final Batch A §4 / Home Dashboard Closure §12: 회차 상태 최종 정의(직원
// 화면 공통). 수업 전은 빈 문자열(배지 없음), 강사 저장 후 공식확정 전은
// 입력중, 확정 후 완료/누락. 정정 여부는 이 값과 별개로 hasCorrection
// 플래그를 각 화면에서 배지로 따로 표시한다(별도 status를 만들지 않는다).
export function sessionStatusLabel(status: string, hasSubmission: boolean): string {
  if (status === "cancelled") return "휴강";
  if (status === "missing") return "누락";
  if (status === "completed") return "완료";
  return hasSubmission ? "입력중" : "";
}

export type SessionRosterRow = {
  enrollmentId: string;
  participantId: string;
  memberCode: string;
  name: string;
  isPreExcused: boolean;
  latestInstructorMark: AttendanceMark | null;
  finalMark: AttendanceMark | null;
  finalAttendanceId: string | null;
};

export function useSessionAttendanceRoster(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session-attendance-roster", sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<SessionRosterRow[]> => {
      const { data, error } = await supabase.rpc("get_session_attendance_roster", {
        p_session_id: sessionId as string,
      });
      if (error) throw error;
      // 출석 입력(직원·강사) 명단은 이름 가나다순(동명이인은 회원번호순).
      const rows: SessionRosterRow[] = (data ?? []).map((r: any) => ({
        enrollmentId: r.enrollment_id,
        participantId: r.participant_id,
        memberCode: r.member_code,
        name: r.name,
        isPreExcused: r.is_pre_excused,
        latestInstructorMark: r.latest_instructor_mark,
        finalMark: r.final_mark,
        finalAttendanceId: r.final_attendance_id,
      }));
      return rows.sort(
        (a, b) =>
          compareName(a.name ?? "", b.name ?? "") ||
          compareName(a.memberCode ?? "", b.memberCode ?? ""),
      );
    },
  });
}

export type FinalAttendanceInfo = {
  id: string;
  enrollmentId: string;
  mark: AttendanceMark;
  finalizationMethod: "auto_latest_submission" | "staff_missing_completion" | "staff_correction";
  finalizedAt: string;
};

export const FINALIZATION_METHOD_LABEL: Record<FinalAttendanceInfo["finalizationMethod"], string> =
  {
    auto_latest_submission: "강사 입력",
    staff_missing_completion: "직원 입력(누락분)",
    staff_correction: "직원 수정",
  };

export function useFinalAttendanceForSession(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["final-attendance-for-session", sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<Record<string, FinalAttendanceInfo>> => {
      const { data, error } = await supabase
        .from("final_attendance")
        .select("id, enrollment_id, mark, finalization_method, finalized_at")
        .eq("session_id", sessionId as string);
      if (error) throw error;
      const map: Record<string, FinalAttendanceInfo> = {};
      for (const r of data ?? []) {
        map[r.enrollment_id] = {
          id: r.id,
          enrollmentId: r.enrollment_id,
          mark: r.mark,
          finalizationMethod: r.finalization_method,
          finalizedAt: r.finalized_at,
        };
      }
      return map;
    },
  });
}

export function useSessionDetail(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session-detail", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sessions")
        .select(
          `id, session_no, starts_at, ends_at, status, operation_term_id,
           operation_terms(id, name, program_id, instructor_principal_id, operation_cycle_id,
             programs(id, name, activities(id)))`,
        )
        .eq("id", sessionId as string)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const ot = data.operation_terms as any;
      return {
        id: data.id as string,
        sessionNo: data.session_no as number,
        startsAt: data.starts_at as string,
        endsAt: data.ends_at as string,
        status: data.status as string,
        operationTermId: data.operation_term_id as string,
        operationTermName: ot?.name as string | undefined,
        // Attendance E2E Manual QA Gap Fix §1-2: 출석 입력/정정 저장 후
        // 원래 보고 있던 운영구분으로 정확히 복귀하기 위해 필요하다.
        operationCycleId: ot?.operation_cycle_id as string | undefined,
        programId: ot?.program_id as string | undefined,
        programName: ot?.programs?.name as string | undefined,
      };
    },
  });
}

// 강사 출석 입력 마감시각. 마감 규칙은 DB 함수 session_input_deadline 한 곳에만 있고
// (평소 종료+30분, 본선 기간 수업 당일 자정 -- migration 20260915040000), 화면은 그 값을 받아 쓴다.
export function useSessionInputDeadline(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session-input-deadline", sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.rpc("get_session_input_deadline", {
        p_session_id: sessionId as string,
      });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
  });
}

// 강사 출석 입력 시작시각(수업 시작 10분 전). 규칙은 DB 함수 session_input_opens_at 한 곳에만
// 있고(migration 20260917020000), 서버 저장 검사와 화면이 같은 값을 쓴다.
export function useSessionInputOpensAt(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session-input-opens-at", sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.rpc("get_session_input_opens_at", {
        p_session_id: sessionId as string,
      });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
  });
}

export function useSaveInstructorAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sessionId: string;
      entries: { enrollment_id: string; mark: AttendanceMark }[];
      idempotencyKey: string;
    }) => {
      const { data, error } = await supabase.rpc("save_instructor_attendance", {
        p_session_id: input.sessionId,
        p_entries: input.entries,
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      return (data as { submission_id: string; version: number }[])[0];
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["session-attendance-roster", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["instructor-today-sessions"] });
    },
  });
}

export function useCompleteMissingSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sessionId: string;
      // Attendance E2E Manual QA Gap Fix §1: 저장 성공 후 회차 및
      // 출석현황 목록을 즉시 최신 상태로 반영하려면 그 목록의 query key인
      // operationTermId가 필요하다.
      operationTermId?: string | undefined;
      entries: { enrollment_id: string; mark: AttendanceMark }[];
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("complete_missing_session", {
        p_session_id: input.sessionId,
        p_entries: input.entries,
        p_reason: input.reason,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["session-attendance-roster", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["session-detail", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["final-attendance-for-session", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["home-attendance-counts"] });
      if (vars.operationTermId) {
        qc.invalidateQueries({ queryKey: ["operation-term-sessions", vars.operationTermId] });
      }
    },
  });
}

export function useCorrectFinalAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      finalAttendanceId: string;
      afterMark: AttendanceMark;
      reason: string;
      sessionId: string;
      operationTermId?: string | undefined;
    }) => {
      const { error } = await supabase.rpc("correct_final_attendance", {
        p_final_attendance_id: input.finalAttendanceId,
        p_after_mark: input.afterMark,
        p_reason: input.reason,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["session-attendance-roster", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["final-attendance-for-session", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["absence-alert-list"] });
      if (vars.operationTermId) {
        qc.invalidateQueries({ queryKey: ["operation-term-sessions", vars.operationTermId] });
      }
    },
  });
}

export function useSetExcusedAbsence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sessionId: string; enrollmentId: string }) => {
      const { error } = await supabase.rpc("set_excused_absence", {
        p_session_id: input.sessionId,
        p_enrollment_id: input.enrollmentId,
      });
      if (error) throw error;
    },
    // 확정된 오늘 회차는 서버가 공식출석(결석 <-> 신고결석)도 함께 바꾸므로 출석 쪽 목록도 새로 받는다.
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["excused-absence-list"] });
      qc.invalidateQueries({ queryKey: ["home-attendance-counts"] });
      qc.invalidateQueries({ queryKey: ["session-attendance-roster", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["final-attendance-for-session", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["absence-alert-list"] });
    },
  });
}

export function useCancelExcusedAbsence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sessionId: string; enrollmentId: string }) => {
      const { error } = await supabase.rpc("cancel_excused_absence", {
        p_session_id: input.sessionId,
        p_enrollment_id: input.enrollmentId,
      });
      if (error) throw error;
    },
    // 확정된 오늘 회차는 서버가 공식출석(결석 <-> 신고결석)도 함께 바꾸므로 출석 쪽 목록도 새로 받는다.
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["excused-absence-list"] });
      qc.invalidateQueries({ queryKey: ["home-attendance-counts"] });
      qc.invalidateQueries({ queryKey: ["session-attendance-roster", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["final-attendance-for-session", vars.sessionId] });
      qc.invalidateQueries({ queryKey: ["absence-alert-list"] });
    },
  });
}

export type ExcusedAbsenceRow = {
  id: string;
  programName: string;
  userName: string;
  sessionDate: string;
  // 결석일(YYYY-MM-DD, 기기 시간 기준). 오늘·예정/지난 기록/날짜 선택을 이 값으로 나눈다.
  sessionDay: string;
  sessionNo: number;
  sessionId: string;
  enrollmentId: string;
};

export function localDayKey(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// 결석관리는 프로그램 설정과 동일하게 운영연도/운영구분 단위로 본다 --
// operationCycleId가 정해지기 전에는 조회하지 않는다(enabled).
// 운영구분의 신고결석을 한 번에 가져오고, 기간 나누기·정렬은 화면에서 한다.
export function useExcusedAbsenceList(operationCycleId: string | null) {
  return useQuery({
    queryKey: ["excused-absence-list", operationCycleId],
    enabled: !!operationCycleId,
    queryFn: async (): Promise<ExcusedAbsenceRow[]> => {
      const query = supabase
        .from("excused_absences")
        .select(
          `id, session_id, enrollment_id,
           sessions!inner(session_no, starts_at,
             operation_terms!inner(operation_cycle_id, programs(name))),
           enrollments(participants(name))`,
        )
        .eq("sessions.operation_terms.operation_cycle_id", operationCycleId as string)
        .is("cancelled_at", null)
        .order("created_at", { ascending: false });
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((r: any) => {
        const startsAt = r.sessions?.starts_at as string;
        return {
          id: r.id as string,
          programName: r.sessions?.operation_terms?.programs?.name ?? "-",
          userName: r.enrollments?.participants?.name ?? "-",
          sessionDate: startsAt,
          sessionDay: localDayKey(new Date(startsAt)),
          sessionNo: r.sessions?.session_no as number,
          sessionId: r.session_id as string,
          enrollmentId: r.enrollment_id as string,
        };
      });
    },
  });
}

export type UpcomingSessionOption = {
  sessionId: string;
  sessionNo: number;
  startsAt: string;
};

// 사유결석 등록 다이얼로그: 오늘(자정 전)부터의 회차를 대상으로 한다. 이미 시작했거나
// 누락·확정된 오늘 회차도 포함한다(set_excused_absence가 결석일 기준으로 받는다).
// 휴강 회차는 제외. 어제 이전 회차는 직원 출석정정을 사용한다.
export function useUpcomingSessionsForTerm(operationTermId: string | undefined) {
  return useQuery({
    queryKey: ["upcoming-sessions-for-term", operationTermId],
    enabled: !!operationTermId,
    queryFn: async (): Promise<UpcomingSessionOption[]> => {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const { data, error } = await supabase
        .from("sessions")
        .select("id, session_no, starts_at, status, operation_term_id")
        .eq("operation_term_id", operationTermId as string)
        .neq("status", "cancelled")
        .gte("starts_at", startOfToday.toISOString())
        .order("starts_at");
      if (error) throw error;
      return (data ?? []).map((s: any) => ({
        sessionId: s.id,
        sessionNo: s.session_no,
        startsAt: s.starts_at,
      }));
    },
  });
}

export type AbsenceStateRow = {
  enrollmentId: string;
  operationTermId: string;
  programName: string;
  userName: string;
  unexcusedCount: number;
  excusedCount: number;
  unexcusedNear: boolean;
  unexcusedReached: boolean;
  excusedNear: boolean;
  excusedReached: boolean;
  alertActive: boolean;
};

export function useAbsenceAlertList(operationCycleId: string | null) {
  return useQuery({
    queryKey: ["absence-alert-list", operationCycleId],
    enabled: !!operationCycleId,
    queryFn: async (): Promise<AbsenceStateRow[]> => {
      // 근접/도달 대상만 서버에서 계산해 받는다(list_absence_alert_states,
      // 20260910130000). 이름/프로그램명은 enrollments(실제 FK 보유)에서 별도로
      // 조회해 합친다.
      const rows = await fetchAbsenceAlertStates([operationCycleId as string]);
      if (rows.length === 0) return [];

      const enrollmentIds = rows.map((r) => r.out_enrollment_id);
      const { data: enrollmentInfo, error: infoError } = await supabase
        .from("enrollments")
        .select("id, participants(name), operation_terms(programs(name))")
        .in("id", enrollmentIds);
      if (infoError) throw infoError;
      const infoById: Record<string, any> = Object.fromEntries(
        (enrollmentInfo ?? []).map((e: any) => [e.id, e]),
      );

      // 프로그램 이름순 → 이용자 이름순.
      const list: AbsenceStateRow[] = rows.map((r) => {
        const info = infoById[r.out_enrollment_id];
        return {
          enrollmentId: r.out_enrollment_id,
          operationTermId: r.out_operation_term_id,
          programName: info?.operation_terms?.programs?.name ?? "-",
          userName: info?.participants?.name ?? "-",
          unexcusedCount: r.out_unexcused_count,
          excusedCount: r.out_excused_count,
          unexcusedNear: r.out_unexcused_near,
          unexcusedReached: r.out_unexcused_reached,
          excusedNear: r.out_excused_near,
          excusedReached: r.out_excused_reached,
          alertActive: r.out_alert_active,
        };
      });
      return list.sort(
        (a, b) => compareName(a.programName, b.programName) || compareName(a.userName, b.userName),
      );
    },
  });
}

// 결석관리 목록과 홈 "결석 주의대상"이 같이 쓴다. v_enrollment_absence_state를
// 직접 조회하면 security_invoker(20260910050651) 때문에 출석 행마다 RLS가 돌아
// 시간초과가 난다 -- 권한을 운영차수 단위로 한 번만 검사하는 RPC를 쓴다.
export type AbsenceAlertStateRpcRow = {
  out_enrollment_id: string;
  out_operation_term_id: string;
  out_unexcused_count: number;
  out_excused_count: number;
  out_unexcused_near: boolean;
  out_unexcused_reached: boolean;
  out_excused_near: boolean;
  out_excused_reached: boolean;
  out_alert_active: boolean;
};

export async function fetchAbsenceAlertStates(
  operationCycleIds: string[],
): Promise<AbsenceAlertStateRpcRow[]> {
  if (operationCycleIds.length === 0) return [];
  const { data, error } = await supabase.rpc("list_absence_alert_states", {
    p_operation_cycle_ids: operationCycleIds,
  });
  if (error) throw error;
  return (data ?? []) as AbsenceAlertStateRpcRow[];
}

function invalidateAbsenceAlerts(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["absence-alert-list"] });
  qc.invalidateQueries({ queryKey: ["home-absence-alert-count"] });
}

export function useDismissAbsenceAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enrollmentId: string) => {
      const { error } = await supabase.rpc("dismiss_absence_alert", {
        p_enrollment_id: enrollmentId,
      });
      if (error) throw error;
    },
    onSuccess: () => invalidateAbsenceAlerts(qc),
  });
}

// 결석 주의대상 일괄 끄기: 한 트랜잭션에서 처리해 하나라도 실패하면 전부 취소된다.
// 반환값은 새로 끈 인원 수(이미 꺼져 있던 대상은 서버가 건너뛴다).
export function useDismissAbsenceAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enrollmentIds: string[]) => {
      const { data, error } = await supabase.rpc("dismiss_absence_alerts", {
        p_enrollment_ids: enrollmentIds,
      });
      if (error) throw error;
      return data ?? 0;
    },
    onSuccess: () => invalidateAbsenceAlerts(qc),
  });
}

export function useReactivateAbsenceAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enrollmentId: string) => {
      const { error } = await supabase.rpc("reactivate_absence_alert", {
        p_enrollment_id: enrollmentId,
      });
      if (error) throw error;
    },
    onSuccess: () => invalidateAbsenceAlerts(qc),
  });
}

// 강사 화면: 본인 담당 운영차수의 오늘 이후 예정/진행중 회차.
export type InstructorSessionRow = {
  sessionId: string;
  sessionNo: number;
  startsAt: string;
  endsAt: string;
  status: string;
  programName: string;
  operationTermName: string;
  hasSaved: boolean;
};

export function useInstructorTodaySessions() {
  return useQuery({
    queryKey: ["instructor-today-sessions"],
    queryFn: async (): Promise<InstructorSessionRow[]> => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const { data, error } = await supabase
        .from("sessions")
        .select(
          `id, session_no, starts_at, ends_at, status,
           operation_terms(name, programs(name)),
           instructor_attendance_submissions(id)`,
        )
        .gte("starts_at", startOfDay.toISOString())
        .lte("starts_at", endOfDay.toISOString())
        .order("starts_at");
      if (error) throw error;
      return (data ?? []).map((s: any) => ({
        sessionId: s.id,
        sessionNo: s.session_no,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        status: s.status,
        programName: s.operation_terms?.programs?.name ?? "-",
        operationTermName: s.operation_terms?.name ?? "-",
        hasSaved: (s.instructor_attendance_submissions ?? []).length > 0,
      }));
    },
  });
}
