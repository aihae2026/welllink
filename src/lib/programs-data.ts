import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { compareName } from "./format";

// 프로그램 관리(출석관리 > 프로그램 관리) 실제 Supabase data layer.
// Batch 1.1 범위: 활동/프로그램/운영차수/회차/수강명단까지.
// 과도한 추상화 없이 화면이 필요로 하는 query/mutation만 직접 둔다.

export type ProgramListRow = {
  programId: string;
  activityId: string;
  name: string;
  weekdayLabel: string;
  timeLabel: string;
  instructorName: string | null;
  operationTermCount: number;
};

const WEEKDAY_LABEL: Record<number, string> = {
  1: "월",
  2: "화",
  3: "수",
  4: "목",
  5: "금",
  6: "토",
  7: "일",
};

function formatWeekdays(weekdays: number[] | null): string {
  if (!weekdays || weekdays.length === 0) return "-";
  return weekdays.map((w) => WEEKDAY_LABEL[w] ?? "?").join("·");
}

function formatTimeRange(start: string | null, end: string | null): string {
  if (!start || !end) return "시간 미등록";
  return `${start.slice(0, 5)}~${end.slice(0, 5)}`;
}

// Core Setup Model Simplification § Phase 3: activity_assignments가 복수담당을
// 지원하므로(activity당 current row가 여러 건일 수 있다) 첫 번째 담당자만 보여주고
// 나머지를 조용히 누락시키지 않는다. 프로그램 설정은 일정 확인용 화면이라 과도한
// UI 없이 "이름 외 N명"으로만 간결하게 표시한다.
function formatInstructorNames(currentAssignees: { principals?: { name?: string } | null }[]) {
  const names = currentAssignees.map((a) => a.principals?.name).filter((n): n is string => !!n);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  return `${names[0]} 외 ${names.length - 1}명`;
}

// business_nodes를 major->middle->minor 순서(각 단계 sort_order 기준)로 DFS해서
// "공식 사업구조 순서"를 만든다. DB 반환순서/생성순서에 맡기지 않는다(§운영 UX Gap
// Closure 25. 공식 정렬순서).
async function fetchNodeOrderIndex(): Promise<Map<string, number>> {
  const { data: nodes, error } = await supabase
    .from("business_nodes")
    .select("id, parent_id, node_type, sort_order")
    .order("sort_order");
  if (error) throw error;
  const rows = (nodes ?? []) as {
    id: string;
    parent_id: string | null;
    node_type: string;
    sort_order: number;
  }[];
  const majors = rows.filter((n) => n.node_type === "major");
  const middlesOf = (id: string) =>
    rows.filter((n) => n.node_type === "middle" && n.parent_id === id);
  const minorsOf = (id: string) =>
    rows.filter((n) => n.node_type === "minor" && n.parent_id === id);

  const order = new Map<string, number>();
  let i = 0;
  for (const maj of majors) {
    for (const mid of middlesOf(maj.id)) {
      for (const min of minorsOf(mid.id)) {
        order.set(min.id, i++);
      }
    }
  }
  return order;
}

export function useProgramsList() {
  return useQuery({
    queryKey: ["programs-list"],
    queryFn: async (): Promise<ProgramListRow[]> => {
      const [{ data, error }, nodeOrder] = await Promise.all([
        supabase.from("programs").select(
          `id, name, activity_id,
             program_schedule_defaults(weekdays, start_time, end_time),
             activities(id, business_node_id, sort_order, default_performance_method,
               activity_assignments(staff_principal_id, effective_to, principals!activity_assignments_staff_principal_id_fkey(name))
             ),
             operation_terms(id)`,
        ),
        fetchNodeOrderIndex(),
      ]);
      if (error) throw error;

      // "프로그램 설정"은 출석관리가 필요한 정규 교육 프로그램만 다룬다(§ 담당자
      // 배정/사업구조 UX Gap Closure 5) -- summary(직접등록형 업무 실적) Activity는
      // 여기 노출되지 않는다. 사업실적 쪽에서는 그대로 포함된다.
      const rows = (data ?? [])
        .filter((row: any) => row.activities?.default_performance_method === "attendance")
        .map((row: any) => {
          const sched = Array.isArray(row.program_schedule_defaults)
            ? row.program_schedule_defaults[0]
            : row.program_schedule_defaults;
          const assignments = (row.activities?.activity_assignments ?? []) as any[];
          const currentAssignees = assignments.filter((a) => a.effective_to === null);
          return {
            programId: row.id as string,
            activityId: row.activity_id as string,
            name: row.name as string,
            weekdayLabel: formatWeekdays(sched?.weekdays ?? null),
            timeLabel: formatTimeRange(sched?.start_time ?? null, sched?.end_time ?? null),
            instructorName: formatInstructorNames(currentAssignees),
            operationTermCount: (row.operation_terms ?? []).length,
            _nodeId: row.activities?.business_node_id as string,
            _sortOrder: (row.activities?.sort_order ?? 0) as number,
          };
        });

      rows.sort((a, b) => {
        const ai = nodeOrder.get(a._nodeId) ?? 999999;
        const bi = nodeOrder.get(b._nodeId) ?? 999999;
        if (ai !== bi) return ai - bi;
        return a._sortOrder - b._sortOrder;
      });

      return rows.map(({ _nodeId, _sortOrder, ...r }) => r);
    },
  });
}

export function useProgramDetail(programId: string) {
  return useQuery({
    queryKey: ["program-detail", programId],
    enabled: !!programId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("programs")
        .select(
          `id, name, activity_id,
           program_schedule_defaults(weekdays, start_time, end_time),
           activities(id, business_year_id,
             activity_assignments(staff_principal_id, effective_to, principals!activity_assignments_staff_principal_id_fkey(name))
           )`,
        )
        .eq("id", programId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const sched = Array.isArray(data.program_schedule_defaults)
        ? (data.program_schedule_defaults[0] as any)
        : (data.program_schedule_defaults as any);
      const assignments = ((data as any).activities?.activity_assignments ?? []) as any[];
      const currentAssignees = assignments.filter((a) => a.effective_to === null);
      return {
        programId: data.id as string,
        activityId: data.activity_id as string,
        businessYearId: (data as any).activities?.business_year_id as string,
        name: data.name as string,
        weekdayLabel: formatWeekdays(sched?.weekdays ?? null),
        timeLabel: formatTimeRange(sched?.start_time ?? null, sched?.end_time ?? null),
        // program_schedule_defaults는 운영차수 생성 화면의 선택적 초기값일 뿐이다.
        // 없어도(null) 운영차수 생성 자체는 막지 않는다 -- 사용자가 그 화면에서 직접 입력한다.
        defaultWeekdays: (sched?.weekdays ?? []) as number[],
        defaultStartTime: (sched?.start_time ?? null) as string | null,
        defaultEndTime: (sched?.end_time ?? null) as string | null,
        instructorName: formatInstructorNames(currentAssignees),
      };
    },
  });
}

export type OperationTermRow = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  initialRosterAppliedAt: string | null;
  operationCycleId: string | null;
  // Manual QA Gap Fix §16-18: 'weekly'(정기 반복) | 'custom_dates'(직접 회차 지정).
  scheduleMode: string;
  weekdays: number[];
  startTime: string | null;
  endTime: string | null;
  instructorPrincipalId: string | null;
  // Manual QA Gap Fix §6: 등록 강사 연결이 없을 때 보여줄 미등록 강사명.
  instructorNameText: string | null;
};

export function useOperationTerms(programId: string) {
  return useQuery({
    queryKey: ["operation-terms", programId],
    enabled: !!programId,
    queryFn: async (): Promise<OperationTermRow[]> => {
      const { data, error } = await supabase
        .from("operation_terms")
        .select(
          "id, name, start_date, end_date, status, initial_roster_applied_at, operation_cycle_id, schedule_mode, weekdays, session_start_time, session_end_time, instructor_principal_id, instructor_name_text",
        )
        .eq("program_id", programId)
        .order("start_date", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        startDate: t.start_date,
        endDate: t.end_date,
        status: t.status,
        initialRosterAppliedAt: t.initial_roster_applied_at,
        operationCycleId: t.operation_cycle_id,
        scheduleMode: t.schedule_mode,
        weekdays: (t.weekdays ?? []) as number[],
        startTime: t.session_start_time,
        endTime: t.session_end_time,
        instructorPrincipalId: t.instructor_principal_id,
        instructorNameText: t.instructor_name_text,
      }));
    },
  });
}

export function useOperationTermRoster(operationTermId: string | undefined) {
  return useQuery({
    queryKey: ["operation-term-roster", operationTermId],
    enabled: !!operationTermId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("enrollments")
        .select(
          "id, start_session_no, end_session_no_exclusive, ended_effective_date, participants(member_code, name)",
        )
        .eq("operation_term_id", operationTermId as string)
        .order("created_at");
      if (error) throw error;
      // 수강명단은 이름 가나다순(동명이인은 회원번호순).
      const rows = (data ?? []).map((e: any) => ({
        enrollmentId: e.id as string,
        memberCode: e.participants?.member_code as string,
        name: e.participants?.name as string,
        active: e.end_session_no_exclusive === null,
        // Attendance E2E Manual QA Gap Fix §9-10: 종결 처리일시(ended_at,
        // audit용)와 분리된, 업무상 실제 적용된 종결일.
        endedEffectiveDate: e.ended_effective_date as string | null,
      }));
      return rows.sort(
        (a: { name: string; memberCode: string }, b: { name: string; memberCode: string }) =>
          compareName(a.name ?? "", b.name ?? "") ||
          compareName(a.memberCode ?? "", b.memberCode ?? ""),
      );
    },
  });
}

// Attendance E2E Manual QA Gap Fix §11: 종결일 수정.
export function useUpdateEnrollmentEndDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      enrollmentId: string;
      operationTermId: string;
      endDate: string;
    }) => {
      const { error } = await supabase.rpc("update_enrollment_end_date", {
        p_enrollment_id: input.enrollmentId,
        p_end_date: input.endDate,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-term-roster", vars.operationTermId] });
      qc.invalidateQueries({ queryKey: ["operation-term-sessions", vars.operationTermId] });
    },
  });
}

// Attendance E2E Manual QA Gap Fix §17-21: list_operation_term_sessions RPC로
// 교체 -- 수강인원(그 회차 당시 유효했던 Enrollment 수)/출석/결석(신고)을
// 서버에서 session_effective_enrollment_ids()·final_attendance 기준으로
// 계산해 함께 내려준다(클라이언트에서 별도 range 재계산 없이 단일 소스 사용).
export function useOperationTermSessions(operationTermId: string | undefined) {
  return useQuery({
    queryKey: ["operation-term-sessions", operationTermId],
    enabled: !!operationTermId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_operation_term_sessions", {
        p_operation_term_id: operationTermId as string,
      });
      if (error) throw error;
      return (data ?? []).map((s: any) => ({
        id: s.out_id,
        session_no: s.out_session_no,
        starts_at: s.out_starts_at,
        ends_at: s.out_ends_at,
        status: s.out_status,
        hasSubmission: s.out_has_submission,
        hasCorrection: s.out_has_correction,
        enrolledCount: s.out_enrolled_count as number,
        presentCount: s.out_present_count as number,
        absentTotalCount: s.out_absent_total_count as number,
        absentExcusedCount: s.out_absent_excused_count as number,
      }));
    },
  });
}

// Manual QA Gap Fix §19: 예정 회차 휴강 -- 강사 출석대상/실적 생성/결석 집계에서
// 자연히 제외된다(finalize_due_sessions 등이 이미 status='scheduled'만 대상으로
// 함). 회차 row 자체는 이력으로 보존한다(물리삭제 아님).
export function useCancelSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sessionId: string; operationTermId: string }) => {
      const { error } = await supabase.rpc("cancel_session", { p_session_id: input.sessionId });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-term-sessions", vars.operationTermId] });
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status"] });
    },
  });
}

// Manual QA Gap Fix §8-10: 휴강 취소. 기존 설계에서는 제외돼 있었으나, QA에서
// 발견된 오기입(잘못 휴강 처리) 복구 필요에 따른 명시적 Scope 변경이다.
// 출석/실적 등 확정 업무데이터가 하나라도 있으면 서버가 friendly 오류로 거부한다.
export function useUncancelSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sessionId: string; operationTermId: string }) => {
      const { error } = await supabase.rpc("uncancel_session", { p_session_id: input.sessionId });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-term-sessions", vars.operationTermId] });
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status"] });
    },
  });
}

// Manual QA Gap Fix §11-14: "과거 여부"가 아니라 "업무데이터 dependency 존재
// 여부"로 삭제 가능 여부를 판단한다(서버가 최종 판단). 출석/실적/사유결석 등이
// 있으면 서버가 friendly 오류로 거부한다.
export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sessionId: string; operationTermId: string }) => {
      const { error } = await supabase.rpc("delete_session", { p_session_id: input.sessionId });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-term-sessions", vars.operationTermId] });
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status"] });
    },
  });
}

// weekdays/시간은 이제 항상 호출자가 명시적으로 전달한다. program_schedule_defaults는
// 화면에서 이 입력값을 미리 채워주는 선택적 기본값일 뿐, RPC는 그 값의 존재 여부와
// 무관하게 동작한다(실제 시간의 Source of Truth는 OperationTerm/Session이다).
export function usePreviewOperationTerm() {
  return useMutation({
    mutationFn: async (input: {
      programId: string;
      startDate: string;
      endDate: string;
      weekdays: number[];
      excludedDates: string[];
    }) => {
      const { data, error } = await supabase.rpc("preview_operation_term_sessions", {
        p_program_id: input.programId,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_weekdays: input.weekdays,
        p_excluded_dates: input.excludedDates,
      });
      if (error) throw error;
      return data as { session_no: number; session_date: string }[];
    },
  });
}

export function useCreateOperationTerm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      programId: string;
      businessYearId: string;
      name: string;
      startDate: string;
      endDate: string;
      weekdays: number[];
      startTime: string;
      endTime: string;
      excludedDates: string[];
    }) => {
      const { data, error } = await supabase.rpc("create_operation_term", {
        p_program_id: input.programId,
        p_business_year_id: input.businessYearId,
        p_name: input.name,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_weekdays: input.weekdays,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
        p_excluded_dates: input.excludedDates,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-terms", vars.programId] });
      qc.invalidateQueries({ queryKey: ["programs-list"] });
    },
  });
}

export function useApplyInitialRoster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      operationTermId: string;
      rows: { member_code: string; name: string }[];
      idempotencyKey: string;
    }) => {
      const { data, error } = await supabase.rpc("apply_initial_roster", {
        p_operation_term_id: input.operationTermId,
        p_rows: input.rows,
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      return data as { participant_count: number; enrollment_count: number }[];
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-term-roster", vars.operationTermId] });
      qc.invalidateQueries({ queryKey: ["operation-terms"] });
      // Manual QA Gap Fix §4: 프로그램 상세에서 수강대상을 등록해도 메인 화면의
      // 수강인원/상태가 즉시 갱신되지 않던 버그 -- 메인이 읽는 쿼리키를 함께 무효화한다.
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status"] });
    },
  });
}

export function useAddEnrollments(operationTermId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: { member_code: string; name: string }[]) => {
      const { data, error } = await supabase.rpc("add_enrollments", {
        p_operation_term_id: operationTermId,
        p_participants: rows,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operation-term-roster", operationTermId] });
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status"] });
    },
  });
}

// 수강생 추가 미리보기: 회원번호별 기존 성명과 이 운영차수 수강 상태.
// add_enrollments는 기존 회원번호면 입력 성명을 무시하므로, 등록 전에 대조한다.
export type ExistingMemberState = { name: string; activeInTerm: boolean; endedInTerm: boolean };

export function usePreviewAddEnrollments(operationTermId: string) {
  return useMutation({
    mutationFn: async (memberCodes: string[]) => {
      const { data, error } = await supabase.rpc("preview_add_enrollments", {
        p_operation_term_id: operationTermId,
        p_member_codes: memberCodes,
      });
      if (error) throw error;
      return new Map<string, ExistingMemberState>(
        (data ?? []).map((r: any): [string, ExistingMemberState] => [
          r.out_member_code,
          {
            name: r.out_existing_name,
            activeInTerm: r.out_active_in_term,
            endedInTerm: r.out_ended_in_term,
          },
        ]),
      );
    },
  });
}

// ---------------- Program 기본정보(요일/시간) 개별·일괄 수정 ----------------

export function useUpsertProgramSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      programId: string;
      weekdays: number[];
      startTime: string;
      endTime: string;
    }) => {
      const { error } = await supabase.rpc("upsert_program_schedule_default", {
        p_program_id: input.programId,
        p_weekdays: input.weekdays,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["programs-list"] });
      qc.invalidateQueries({ queryKey: ["program-detail", vars.programId] });
      qc.invalidateQueries({ queryKey: ["programs-with-schedule"] });
    },
  });
}

export type ProgramScheduleBatchRow = {
  programId: string;
  name: string;
  weekdays: number[];
  startTime: string | null;
  endTime: string | null;
  sortOrder: number;
};

export function useProgramsWithSchedule() {
  return useQuery({
    queryKey: ["programs-with-schedule"],
    queryFn: async (): Promise<ProgramScheduleBatchRow[]> => {
      const [{ data, error }, nodeOrder] = await Promise.all([
        supabase.rpc("list_programs_with_schedule"),
        fetchNodeOrderIndex(),
      ]);
      if (error) throw error;
      const { data: acts, error: actsError } = await supabase
        .from("activities")
        .select("id, business_node_id");
      if (actsError) throw actsError;
      const nodeByActivity = new Map((acts ?? []).map((a: any) => [a.id, a.business_node_id]));

      type Row = ProgramScheduleBatchRow & { _nodeId: string | undefined };
      const rows: Row[] = (data ?? []).map((r: any) => ({
        programId: r.out_program_id as string,
        name: r.out_name as string,
        weekdays: (r.out_weekdays ?? []) as number[],
        startTime: r.out_start_time as string | null,
        endTime: r.out_end_time as string | null,
        sortOrder: r.out_sort_order as number,
        _nodeId: nodeByActivity.get(r.out_activity_id) as string | undefined,
      }));

      rows.sort((a: Row, b: Row) => {
        const ai: number = (a._nodeId ? nodeOrder.get(a._nodeId) : undefined) ?? 999999;
        const bi: number = (b._nodeId ? nodeOrder.get(b._nodeId) : undefined) ?? 999999;
        if (ai !== bi) return ai - bi;
        return a.sortOrder - b.sortOrder;
      });

      return rows.map(({ _nodeId, ...r }: Row) => r);
    },
  });
}

export function useBatchUpsertProgramSchedules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      rows: { program_id: string; weekdays: number[]; start_time: string; end_time: string }[],
    ) => {
      const { data, error } = await supabase.rpc("upsert_program_schedule_defaults_batch", {
        p_rows: rows,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["programs-list"] });
      qc.invalidateQueries({ queryKey: ["programs-with-schedule"] });
    },
  });
}

// ---------------- 운영차수 일괄 생성(공통 parent) ----------------

export type OperationCycleProgramInput = {
  program_id: string;
  weekdays: number[];
  start_time: string;
  end_time: string;
  instructor_principal_id: string | null;
};

export function useCreateOperationCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      businessYearId: string;
      name: string;
      startDate: string;
      endDate: string;
      programs: OperationCycleProgramInput[];
      idempotencyKey: string;
    }) => {
      const { data, error } = await supabase.rpc("create_operation_cycle_with_programs", {
        p_business_year_id: input.businessYearId,
        p_name: input.name,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
        p_programs: input.programs,
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      return (data as any[])[0] as {
        out_cycle_id: string;
        out_term_count: number;
        out_session_count: number;
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["programs-list"] });
      qc.invalidateQueries({ queryKey: ["operation-terms"] });
      qc.invalidateQueries({ queryKey: ["operation-cycles"] });
    },
  });
}

export function useTerminateEnrollments(operationTermId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enrollmentIds: string[]) => {
      const { data, error } = await supabase.rpc("terminate_enrollments", {
        p_enrollment_ids: enrollmentIds,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operation-term-roster", operationTermId] });
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status"] });
    },
  });
}

// ---------------- Program Operations Redesign: Term First / Excel First ----------------

export type OperationCycleRow = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  programCount: number;
};

export function useOperationCycles(businessYearId: string | null) {
  return useQuery({
    queryKey: ["operation-cycles", businessYearId],
    queryFn: async (): Promise<OperationCycleRow[]> => {
      const { data, error } = await supabase.rpc("list_operation_cycles", {
        p_business_year_id: businessYearId,
      });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.out_id,
        name: r.out_name,
        startDate: r.out_start_date,
        endDate: r.out_end_date,
        status: r.out_status,
        programCount: r.out_program_count,
      }));
    },
  });
}

// Step 1: 운영차수만 단독 생성한다(프로그램 선택 없이) -- 프로그램별 설정은
// Step 2(Excel)에서 별도로 처리한다.
export function useCreateOperationCycleOnly() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      businessYearId: string;
      name: string;
      startDate: string;
      endDate: string;
    }) => {
      const { data, error } = await supabase.rpc("create_operation_cycle", {
        p_business_year_id: input.businessYearId,
        p_name: input.name,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operation-cycles"] }),
  });
}

// Manual QA Gap Fix §13: 운영구분명은 항상 수정 가능. 운영기간은 아직 Program
// 운영정보/Session이 생성되지 않은 경우(programCount === 0)만 수정 가능 --
// 서버가 그 경우 날짜 변경을 조용히 무시한다(§13 참고). 어느 쪽으로 수정할지는
// 호출 전 클라이언트가 programCount로 미리 판단해 입력 자체를 잠근다.
export function useUpdateOperationCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string; startDate: string; endDate: string }) => {
      const { error } = await supabase.rpc("update_operation_cycle", {
        p_id: input.id,
        p_name: input.name,
        p_start_date: input.startDate,
        p_end_date: input.endDate,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operation-cycles"] }),
  });
}

export function useDeleteOperationCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_operation_cycle", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["operation-cycles"] }),
  });
}

export type CycleProgramStatusRow = {
  programId: string;
  activityId: string;
  name: string;
  hasTerm: boolean;
  operationTermId: string | null;
  // Manual QA Gap Fix §16-18: 'weekly'(정기 반복) | 'custom_dates'(직접 회차 지정).
  scheduleMode: string | null;
  weekdays: number[];
  startTime: string | null;
  endTime: string | null;
  instructorName: string | null;
  // Manual QA Gap Fix §6: 등록 강사 연결이 없을 때 보여줄 미등록 강사명.
  instructorNameText: string | null;
  sessionCount: number;
  enrollmentCount: number;
  initialRosterApplied: boolean;
};

// Manual QA Gap Fix §2-3: 이 운영구분에 "선택된" Program만 반환한다(전체
// 출석연동 활동을 자동으로 나열하지 않는다).
export function useOperationCycleProgramStatus(operationCycleId: string | null) {
  return useQuery({
    queryKey: ["operation-cycle-program-status", operationCycleId],
    enabled: !!operationCycleId,
    queryFn: async (): Promise<CycleProgramStatusRow[]> => {
      const { data, error } = await supabase.rpc("list_operation_cycle_program_status", {
        p_operation_cycle_id: operationCycleId,
      });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        programId: r.out_program_id,
        activityId: r.out_activity_id,
        name: r.out_name,
        hasTerm: r.out_has_term,
        operationTermId: r.out_operation_term_id,
        scheduleMode: r.out_schedule_mode,
        weekdays: (r.out_weekdays ?? []) as number[],
        startTime: r.out_start_time,
        endTime: r.out_end_time,
        instructorName: r.out_instructor_name,
        instructorNameText: r.out_instructor_name_text,
        sessionCount: r.out_session_count,
        enrollmentCount: r.out_enrollment_count,
        initialRosterApplied: r.out_initial_roster_applied,
      }));
    },
  });
}

// 누락(강사가 출석을 넣지 않아 마감된 회차)은 프로그램 상세에 들어가야만 보였다.
// 목록에서 바로 보이도록 운영구분 단위로 한 번에 세어 온다(키: operation_term_id).
export function useCycleMissingSessionCounts(operationCycleId: string | null) {
  return useQuery({
    queryKey: ["cycle-missing-session-counts", operationCycleId],
    enabled: !!operationCycleId,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .from("sessions")
        .select("id, operation_term_id, operation_terms!inner(operation_cycle_id)")
        .eq("status", "missing")
        .eq("operation_terms.operation_cycle_id", operationCycleId as string);
      if (error) throw error;
      const counts: Record<string, number> = {};
      for (const row of (data ?? []) as { operation_term_id: string | null }[]) {
        if (!row.operation_term_id) continue;
        counts[row.operation_term_id] = (counts[row.operation_term_id] ?? 0) + 1;
      }
      return counts;
    },
  });
}

export type SelectableProgramRow = { programId: string; activityId: string; name: string };

export function useSelectableProgramsForCycle(operationCycleId: string | null) {
  return useQuery({
    queryKey: ["selectable-programs-for-cycle", operationCycleId],
    enabled: !!operationCycleId,
    queryFn: async (): Promise<SelectableProgramRow[]> => {
      const { data, error } = await supabase.rpc("list_selectable_programs_for_cycle", {
        p_operation_cycle_id: operationCycleId,
      });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        programId: r.out_program_id,
        activityId: r.out_activity_id,
        name: r.out_name,
      }));
    },
  });
}

export function useAddOperationCyclePrograms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { operationCycleId: string; programIds: string[] }) => {
      const { data, error } = await supabase.rpc("add_operation_cycle_programs", {
        p_operation_cycle_id: input.operationCycleId,
        p_program_ids: input.programIds,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status", vars.operationCycleId] });
      qc.invalidateQueries({ queryKey: ["selectable-programs-for-cycle", vars.operationCycleId] });
    },
  });
}

export type UpsertTermResult = { termId: string; created: boolean; sessionsRegenerated: boolean };

// Step 2의 실제 엔진: Excel 한 행 = 이 mutation 한 번. 값이 기존과 동일하면 서버가
// 아무 것도 바꾸지 않는다(재업로드 idempotent). 일정이 실제로 바뀌는데 이미
// 출석기록/과거 회차가 있으면 서버가 명확한 한국어 예외로 거부한다.
export function useUpsertOperationTermForCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      operationCycleId: string;
      programId: string;
      weekdays: number[];
      startTime: string;
      endTime: string;
      instructorPrincipalId: string | null;
      // Manual QA Gap Fix §20: 요일 반복으로 계산된 회차 날짜 중 사용자가
      // "회차 일정 확인" 단계에서 직접 제외한 날짜(YYYY-MM-DD). 비정기 임의
      // 날짜를 추측 생성하지 않고, 반복 패턴에서 제외만 지원하는 최소 구현.
      excludedDates?: string[];
      // Manual QA Gap Fix §4-6: 아직 시스템에 등록되지 않은 강사명. instructorPrincipalId가
      // 있으면 그 값이 우선이고 이 텍스트는 서버에서 저장하지 않는다.
      instructorNameText?: string | null;
      // Manual QA Gap Fix §16-18: 'weekly'(기본, 요일 반복) | 'custom_dates'(직접
      // 회차 지정 -- explicitDates로 준 날짜만 회차가 된다, 추측 생성 없음).
      scheduleMode?: "weekly" | "custom_dates";
      explicitDates?: string[] | undefined;
    }): Promise<UpsertTermResult> => {
      const { data, error } = await supabase.rpc("upsert_operation_term_for_cycle", {
        p_operation_cycle_id: input.operationCycleId,
        p_program_id: input.programId,
        p_weekdays: input.weekdays,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
        p_instructor_principal_id: input.instructorPrincipalId,
        p_excluded_dates: input.excludedDates ?? [],
        p_instructor_name_text: input.instructorNameText ?? null,
        p_schedule_mode: input.scheduleMode ?? "weekly",
        p_explicit_dates: input.explicitDates ?? null,
      });
      if (error) throw error;
      const row = (data as any[])[0];
      return {
        termId: row.out_term_id,
        created: row.out_created,
        sessionsRegenerated: row.out_sessions_regenerated,
      };
    },
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status", vars.operationCycleId] });
      qc.invalidateQueries({ queryKey: ["programs-list"] });
      qc.invalidateQueries({ queryKey: ["operation-terms"] });
      // 회차 목록(회차·출석 탭)이 무효화되지 않아 방금 바뀐 운영정보(요일/시간/
      // 직접 회차 지정 날짜)를 반영한 새 회차가 새로고침 전까지 보이지 않던 버그.
      qc.invalidateQueries({ queryKey: ["operation-term-sessions", data.termId] });
    },
  });
}

export type BulkRosterResult = {
  participantCount: number;
  enrollmentCount: number;
  programCount: number;
};

// Manual QA Gap Fix §9-16: 프로그램 설정 메인 화면에서 "프로그램명/회원번호/성명"
// 붙여넣기로 여러 Program의 수강명단을 한 번에 등록한다. 하나의 RPC 호출 =
// 하나의 트랜잭션(원자적, partial apply 없음).
export function useApplyBulkRosterForCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      operationCycleId: string;
      rows: { program_name: string; member_code: string; name: string }[];
    }): Promise<BulkRosterResult> => {
      const { data, error } = await supabase.rpc("apply_bulk_roster_for_cycle", {
        p_operation_cycle_id: input.operationCycleId,
        p_rows: input.rows,
      });
      if (error) throw error;
      const row = (data as any[])[0];
      return {
        participantCount: row.out_participant_count,
        enrollmentCount: row.out_enrollment_count,
        programCount: row.out_program_count,
      };
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status", vars.operationCycleId] });
      qc.invalidateQueries({ queryKey: ["operation-term-roster"] });
    },
  });
}

// ---------------- Program Settings Final Design Lock ----------------

// §17: "프로그램 제외하기" -- Program Master는 그대로 두고 이 운영구분에서만
// 뺀다. 단순 mapping만 있으면 안전하게 정리, 실제 업무데이터가 있으면 서버가
// friendly 오류로 차단한다.
export function useRemoveOperationCycleProgram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { operationCycleId: string; programId: string }) => {
      const { error } = await supabase.rpc("remove_operation_cycle_program", {
        p_operation_cycle_id: input.operationCycleId,
        p_program_id: input.programId,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status", vars.operationCycleId] });
      qc.invalidateQueries({ queryKey: ["selectable-programs-for-cycle", vars.operationCycleId] });
      qc.invalidateQueries({ queryKey: ["operation-terms"] });
    },
  });
}

// §47: 회차 추가. 운영구분 기간 안의 날짜만 허용, 항상 예정(scheduled) 상태로
// 생성된다(공휴일 자동 휴강은 v1.0 Scope에서 제외 -- Holiday Auto Cancel
// Scope Reduction).
export function useAddSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      operationTermId: string;
      date: string;
      startTime: string;
      endTime: string;
    }) => {
      const { data, error } = await supabase.rpc("add_session", {
        p_operation_term_id: input.operationTermId,
        p_date: input.date,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-term-sessions", vars.operationTermId] });
      qc.invalidateQueries({ queryKey: ["operation-cycle-program-status"] });
    },
  });
}

// §48: 회차 수정(개별 회차의 일자/시간만). 이미 출석/실적이 연결된 회차는
// 서버가 차단한다 -- 기본설정을 바꿔서 회차를 수정하는 것과는 다른 경로다.
export function useUpdateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sessionId: string;
      operationTermId: string;
      date: string;
      startTime: string;
      endTime: string;
    }) => {
      const { error } = await supabase.rpc("update_session", {
        p_session_id: input.sessionId,
        p_date: input.date,
        p_start_time: input.startTime,
        p_end_time: input.endTime,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["operation-term-sessions", vars.operationTermId] });
    },
  });
}
