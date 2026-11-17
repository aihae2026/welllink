import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";

// 운영 UX Gap Closure: 기관 설정 화면들의 실제 data layer.

export function useOrganizationBasic() {
  return useQuery({
    queryKey: ["org-basic"],
    queryFn: async () => {
      const [{ data: org, error: orgError }, { data: years, error: yearsError }] =
        await Promise.all([
          supabase.from("organizations").select("name").single(),
          supabase
            .from("business_years")
            .select("id, year, status")
            .order("year", { ascending: false }),
        ]);
      if (orgError) throw orgError;
      if (yearsError) throw yearsError;
      return {
        organizationName: org?.name as string,
        years: (years ?? []) as { id: string; year: number; status: string }[],
      };
    },
  });
}

export function useUpdateOrganizationName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const { error } = await supabase.rpc("update_organization_name", { p_name: name });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-basic"] }),
  });
}

// Final Batch A §12: 출결관리 설정(결석관리/신고결석 사용 여부, 결석 누계 기준값).
// 앱 전역(Sidebar 노출 여부 등)에서 자주 참조되므로 org-basic과는 별도
// query key로 분리한다.
export type AttendanceSettings = {
  attendanceEnabled: boolean;
  excusedAbsenceEnabled: boolean;
  unexcusedAbsenceThreshold: number;
  excusedAbsenceThreshold: number;
  // Program Settings Final Design Lock §1-3: 운영구분 방식(반기제/분기제) +
  // 연중 운영구분 추가 여부. 같은 organizations row에 있으므로 같은 쿼리로
  // 함께 가져온다 -- 저장은 update_operation_cycle_mode로 별도 처리한다.
  operationCycleMode: "semester" | "quarter";
  includeAnnualCycle: boolean;
};

export function useAttendanceSettings() {
  return useQuery({
    queryKey: ["attendance-settings"],
    queryFn: async (): Promise<AttendanceSettings> => {
      const { data, error } = await supabase
        .from("organizations")
        .select(
          "attendance_enabled, excused_absence_enabled, unexcused_absence_threshold, excused_absence_threshold, operation_cycle_mode, include_annual_cycle",
        )
        .single();
      if (error) throw error;
      return {
        attendanceEnabled: data.attendance_enabled,
        // 신고결석은 결석관리의 하위 기능이다 -- 결석관리가 꺼져 있으면 DB에
        // excused_absence_enabled=true가 남아 있더라도(자동 OFF 도입 이전에 저장된
        // 기관) 앱 전체에서 OFF로 취급한다. 설정 화면도 이 값으로 draft를 채우므로
        // 다음 저장 때 DB 값도 false로 정리된다.
        excusedAbsenceEnabled: data.attendance_enabled && data.excused_absence_enabled,
        unexcusedAbsenceThreshold: data.unexcused_absence_threshold,
        excusedAbsenceThreshold: data.excused_absence_threshold,
        operationCycleMode: data.operation_cycle_mode,
        includeAnnualCycle: data.include_annual_cycle,
      };
    },
  });
}

export function useUpdateAttendanceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      attendanceEnabled: boolean;
      excusedAbsenceEnabled: boolean;
      unexcusedAbsenceThreshold: number;
      excusedAbsenceThreshold: number;
    }) => {
      const { error } = await supabase.rpc("update_attendance_settings", {
        p_attendance_enabled: input.attendanceEnabled,
        p_excused_absence_enabled: input.excusedAbsenceEnabled,
        p_unexcused_absence_threshold: input.unexcusedAbsenceThreshold,
        p_excused_absence_threshold: input.excusedAbsenceThreshold,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attendance-settings"] }),
  });
}

// Program Settings Final Design Lock §1-9: 운영구분 방식(반기제/분기제) +
// 연중 여부 저장. "다음 연도 추가" 시 그 연도의 운영구분을 자동 생성하는 데
// 쓰이고(create_business_year), migration 20260918020000부터는 **아직 비어 있는
// 연도**의 운영구분도 새 방식으로 다시 만든다. 20260918030000부터 연중 추가는
// 지우는 것이 없으므로 운영 중인 연도에도 허용하고, 연중 해제는 그 연중이 비어
// 있을 때만 한다. RPC가 연도별로 어떻게 처리했는지 돌려준다.
export type OperationCycleModeResult = {
  appliedYears: number[];
  skippedYears: number[];
  annualAddedYears: number[];
  annualRemovedYears: number[];
  annualKeptYears: number[];
};

export function useUpdateOperationCycleMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      mode: "semester" | "quarter";
      includeAnnualCycle: boolean;
    }): Promise<OperationCycleModeResult> => {
      const { data, error } = await supabase.rpc("update_operation_cycle_mode", {
        p_mode: input.mode,
        p_include_annual_cycle: input.includeAnnualCycle,
      });
      if (error) throw error;
      const raw = (data ?? {}) as {
        applied_years?: number[];
        skipped_years?: number[];
        annual_added_years?: number[];
        annual_removed_years?: number[];
        annual_kept_years?: number[];
      };
      return {
        appliedYears: raw.applied_years ?? [],
        skippedYears: raw.skipped_years ?? [],
        annualAddedYears: raw.annual_added_years ?? [],
        annualRemovedYears: raw.annual_removed_years ?? [],
        annualKeptYears: raw.annual_kept_years ?? [],
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-settings"] });
      qc.invalidateQueries({ queryKey: ["operation-cycles"] });
      qc.invalidateQueries({ queryKey: ["business-years"] });
    },
  });
}

export function useCreateUnitBusiness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { businessYearId: string; name: string }) => {
      const { data, error } = await supabase.rpc("create_unit_business", {
        p_business_year_id: input.businessYearId,
        p_name: input.name,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

export function useUpdateUnitBusiness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string }) => {
      const { error } = await supabase.rpc("update_unit_business", {
        p_id: input.id,
        p_name: input.name,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

export function useDeleteUnitBusiness() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_unit_business", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

// Manual QA Gap Fix — Initial Setup & Program Onboarding §2: 기관 초기설정을
// 최종 3단계로 확정한다.
// 1) 기본 운영 설정 -- 운영연도 1개 이상 + 출결관리 설정을 명시적으로 저장한
//    이력(attendance_settings_saved_at). attendance_enabled 등은 DB default가
//    있어서 컬럼 값만으로는 "명시적으로 확인·저장"했는지 알 수 없으므로, 저장
//    시각을 기록하는 최소 컬럼을 따로 둔다(§2 완료조건 1).
// 2) 사업·활동 구성 -- 최소 소분류(활동) 1개 존재.
// 3) 사용자 등록 -- provision으로 생성된 최초 관리자 본인은 제외하고, 추가
//    직원/강사가 1명 이상 존재. 조직 내 가장 먼저 만들어진 principal이 곧 그
//    최초 관리자다(principals에 별도 provisioning 플래그가 없으므로
//    created_at 최솟값으로 판별). 3번은 hard gate가 아니므로 Home 진입 여부
//    판단(§1)에는 쓰지 않는다 -- 체크리스트에만 노출한다.
export type OnboardingStatus = {
  hasBasicInfo: boolean;
  hasBusinessStructure: boolean;
  hasUsers: boolean;
};

export function useOnboardingStatus() {
  return useQuery({
    queryKey: ["onboarding-status"],
    queryFn: async (): Promise<OnboardingStatus> => {
      const head = { count: "exact" as const, head: true };
      const [org, years, activeActivities, staffPrincipals] = await Promise.all([
        supabase.from("organizations").select("attendance_settings_saved_at").single(),
        supabase.from("business_years").select("id", head),
        supabase.from("activities").select("id", head).eq("is_active", true),
        supabase
          .from("principals")
          .select("id, created_at, is_active")
          .eq("principal_type", "staff")
          .order("created_at", { ascending: true }),
      ]);

      const staffList = staffPrincipals.data ?? [];
      const initialAdminId = staffList[0]?.id;
      const hasUsers = staffList.some((p) => p.id !== initialAdminId && p.is_active);

      return {
        hasBasicInfo: (years.count ?? 0) > 0 && !!org.data?.attendance_settings_saved_at,
        hasBusinessStructure: (activeActivities.count ?? 0) > 0,
        hasUsers,
      };
    },
  });
}

export function useCreateBusinessYear() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (year: number) => {
      const { error } = await supabase.rpc("create_business_year", { p_year: year });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org-basic"] });
      qc.invalidateQueries({ queryKey: ["business-structure"] });
      // Program Settings Final Design Lock §2: 운영연도 생성이 그 해의
      // 운영구분도 함께 만들므로, 프로그램 설정 화면의 운영구분 목록도
      // 즉시 갱신되어야 한다 -- 사용자가 새로고침 없이 바로 쓸 수 있어야 한다.
      qc.invalidateQueries({ queryKey: ["operation-cycles"] });
    },
  });
}

export function useUpdateBusinessYear() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; year: number }) => {
      const { error } = await supabase.rpc("update_business_year", {
        p_id: input.id,
        p_year: input.year,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-basic"] }),
  });
}

export function useDeleteBusinessYear() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_business_year", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-basic"] }),
  });
}

export type BusinessNodeRow = {
  id: string;
  parent_id: string | null;
  node_type: "major" | "middle" | "minor";
  name: string;
  is_active: boolean;
  business_year_id: string;
  unit_business_id: string;
};
export type ActivityRow = {
  id: string;
  business_node_id: string;
  business_year_id: string;
  unit_business_id: string;
  name: string;
  default_performance_method: string;
  is_active: boolean;
};

export function useBusinessStructure(businessYearId: string | null) {
  return useQuery({
    queryKey: ["business-structure", businessYearId],
    enabled: !!businessYearId,
    queryFn: async () => {
      const [
        { data: nodes, error: nodesError },
        { data: acts, error: actsError },
        { data: units, error: unitsError },
      ] = await Promise.all([
        supabase
          .from("business_nodes")
          .select("id, parent_id, node_type, name, is_active, business_year_id, unit_business_id")
          .eq("business_year_id", businessYearId)
          .order("sort_order"),
        supabase
          .from("activities")
          .select(
            "id, business_node_id, business_year_id, unit_business_id, name, default_performance_method, is_active",
          )
          .eq("business_year_id", businessYearId)
          .order("sort_order"),
        supabase.from("unit_businesses").select("id, name").eq("business_year_id", businessYearId),
      ]);
      if (nodesError) throw nodesError;
      if (actsError) throw actsError;
      if (unitsError) throw unitsError;
      return {
        nodes: (nodes ?? []) as BusinessNodeRow[],
        activities: (acts ?? []) as ActivityRow[],
        units: (units ?? []) as { id: string; name: string }[],
      };
    },
  });
}

export function useCreateBusinessNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      businessYearId: string;
      parentId: string | null;
      nodeType: "major" | "middle" | "minor";
      name: string;
      // 대분류(major) 생성 때만 필수 -- 중분류는 서버가 parent에서 자동 상속한다.
      unitBusinessId: string | undefined;
    }) => {
      const { error } = await supabase.rpc("create_business_node", {
        p_business_year_id: input.businessYearId,
        p_parent_id: input.parentId,
        p_node_type: input.nodeType,
        p_name: input.name,
        p_unit_business_id: input.unitBusinessId ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

export function useUpdateBusinessNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string; isActive: boolean }) => {
      const { error } = await supabase.rpc("update_business_node", {
        p_id: input.id,
        p_name: input.name,
        p_is_active: input.isActive,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

// 활동의 unit_business는 더 이상 여기서 고르지 않는다 -- 어느 중분류
// (businessNodeId) 아래 만드는지로 서버가 자동 파생한다(§ UnitBusiness ↔
// BusinessNode Linkage Closure 15).
export function useCreateActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      businessYearId: string;
      businessNodeId: string;
      name: string;
      defaultPerformanceMethod: "attendance" | "summary";
    }) => {
      const { error } = await supabase.rpc("create_activity_with_program", {
        p_business_year_id: input.businessYearId,
        p_business_node_id: input.businessNodeId,
        p_name: input.name,
        p_default_performance_method: input.defaultPerformanceMethod,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

export function useUpdateActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string; isActive: boolean }) => {
      const { error } = await supabase.rpc("update_activity", {
        p_id: input.id,
        p_name: input.name,
        p_is_active: input.isActive,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

export function useDeleteBusinessNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_business_node", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

// Manual QA Gap Fix §3: 사업구조(단위사업/대분류/중분류/소분류) Excel 초기등록.
// 서버가 하나의 RPC 안에서 원자적으로 처리한다(partial apply 없음).
export function useApplyBusinessStructureExcel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      businessYearId: string;
      rows: {
        unit_business: string;
        major: string;
        middle: string;
        activity: string;
        method: "attendance" | "summary";
      }[];
    }) => {
      const { data, error } = await supabase.rpc("apply_business_structure_excel", {
        p_business_year_id: input.businessYearId,
        p_rows: input.rows,
      });
      if (error) throw error;
      const row = (data as any[])[0];
      return {
        unitsCreated: row.out_units_created as number,
        majorsCreated: row.out_majors_created as number,
        middlesCreated: row.out_middles_created as number,
        activitiesCreated: row.out_activities_created as number,
      };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

export function useDeleteActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("delete_activity", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["business-structure"] }),
  });
}

export type DepartmentRow = { id: string; name: string; isActive: boolean; staffCount: number };

export function useDepartments() {
  return useQuery({
    queryKey: ["departments"],
    queryFn: async (): Promise<DepartmentRow[]> => {
      const { data, error } = await supabase.rpc("list_departments");
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.out_id,
        name: r.out_name,
        isActive: r.out_is_active,
        staffCount: r.out_staff_count,
      }));
    },
  });
}

export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const { error } = await supabase.rpc("create_department", { p_name: name });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
  });
}

export function useSetDepartmentActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; isActive: boolean }) => {
      const { error } = await supabase.rpc("set_department_active", {
        p_id: input.id,
        p_is_active: input.isActive,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["departments"] }),
  });
}

export function useSetStaffDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { principalId: string; departmentId: string | null }) => {
      const { error } = await supabase.rpc("set_staff_department", {
        p_principal_id: input.principalId,
        p_department_id: input.departmentId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["departments"] });
      qc.invalidateQueries({ queryKey: ["staff-accounts"] });
    },
  });
}
