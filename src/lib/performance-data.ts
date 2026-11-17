import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import {
  groupTreeByUnitBusiness,
  normalizeBusinessTreeForUi,
  type UiUnitBusinessNode,
} from "./business-tree-normalize";

// Pipeline 2 / Batch 2.1: 사업실적(공식실적) E2E 실제 Supabase data layer.
// 공식 실적방식은 정확히 2종(출석연동=attendance / 직접등록=summary)이며 '명단' 방식은
// 없다(performance_method enum 자체에 값이 없음 -- 20260907010000_performance_pipeline.sql).
// 집계는 여기서 client-side로 다시 계산하지 않고 항상 get_activity_metrics /
// get_performance_report 서버 RPC 결과를 그대로 사용한다.

export type PerformanceMethod = "attendance" | "summary";
export type PerformanceStatus = "active" | "cancelled";

export const methodLabel = (m: PerformanceMethod): "출석연동" | "직접 등록" =>
  m === "attendance" ? "출석연동" : "직접 등록";

// ============================================================
// 사업연도 / 활동
// ============================================================

export type BusinessYearRow = { id: string; year: number; status: string };

export function useBusinessYears() {
  return useQuery({
    queryKey: ["business-years"],
    queryFn: async (): Promise<BusinessYearRow[]> => {
      const { data, error } = await supabase
        .from("business_years")
        .select("id, year, status")
        .order("year", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export type ActivityOption = {
  id: string;
  name: string;
  method: PerformanceMethod;
  businessNodeId: string;
};

// 실적 등록 화면의 단계별 선택(사업 > 대분류 > 중분류 > 활동)용 트리.
// 활성 활동이 하나도 없는 사업/대분류/중분류는 선택지에서 뺀다.
export type ActivityPickerTree = UiUnitBusinessNode<ActivityOption>[];

export function useActivityTreeForYear(businessYearId: string | undefined) {
  return useQuery({
    queryKey: ["performance-activity-tree", businessYearId],
    enabled: !!businessYearId,
    queryFn: async (): Promise<ActivityPickerTree> => {
      const yearId = businessYearId as string;
      const [nodesRes, unitsRes, activitiesRes] = await Promise.all([
        supabase
          .from("business_nodes")
          .select("id, parent_id, node_type, unit_business_id, name, sort_order, is_active")
          .eq("business_year_id", yearId)
          .order("sort_order"),
        supabase.from("unit_businesses").select("id, name").eq("business_year_id", yearId),
        supabase
          .from("activities")
          .select("id, name, default_performance_method, business_node_id")
          .eq("business_year_id", yearId)
          .eq("is_active", true)
          .order("sort_order"),
      ]);
      if (nodesRes.error) throw nodesRes.error;
      if (unitsRes.error) throw unitsRes.error;
      if (activitiesRes.error) throw activitiesRes.error;

      const nodes = nodesRes.data ?? [];
      const activities: ActivityOption[] = (activitiesRes.data ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        method: a.default_performance_method as PerformanceMethod,
        businessNodeId: a.business_node_id,
      }));
      const majorUnitBusinessId: Record<string, string> = {};
      nodes.forEach((n) => {
        if (n.node_type === "major") majorUnitBusinessId[n.id] = n.unit_business_id;
      });
      const grouped = groupTreeByUnitBusiness(
        unitsRes.data ?? [],
        normalizeBusinessTreeForUi(nodes, activities),
        majorUnitBusinessId,
      );

      return grouped
        .map((unit) => ({
          ...unit,
          majors: unit.majors
            .map((maj) => ({
              ...maj,
              middles: maj.middles.filter((mid) => mid.activities.length > 0),
            }))
            .filter((maj) => maj.middles.length > 0),
        }))
        .filter((unit) => unit.majors.length > 0);
    },
  });
}

// ============================================================
// 실적내역 / 실적 상세
// ============================================================

export type PerformanceRecordRow = {
  id: string;
  activityId: string;
  activityName: string;
  method: PerformanceMethod;
  status: PerformanceStatus;
  operationDate: string;
  activityContent: string | null;
  countValue: number;
  uniquePeopleValue: number;
  totalPeopleValue: number;
  sourceSessionId: string | null;
  createdAt: string;
};

function mapRecordRow(r: any): PerformanceRecordRow {
  return {
    id: r.id,
    activityId: r.activity_id,
    activityName: r.activities?.name ?? "-",
    method: r.method,
    status: r.status,
    operationDate: r.operation_date,
    activityContent: r.activity_content,
    countValue: r.count_value,
    uniquePeopleValue: r.unique_people_value,
    totalPeopleValue: r.total_people_value,
    sourceSessionId: r.source_session_id,
    createdAt: r.created_at,
  };
}

export function usePerformanceRecords(filters: {
  businessYearId: string | undefined;
  from: string;
  to: string;
  activityId?: string;
  activityIds?: string[];
  method?: PerformanceMethod;
  status?: PerformanceStatus;
}) {
  return useQuery({
    queryKey: ["performance-records", filters],
    enabled: !!filters.businessYearId,
    queryFn: async (): Promise<PerformanceRecordRow[]> => {
      let query = supabase
        .from("performance_records")
        .select(
          `id, activity_id, method, status, operation_date, activity_content, count_value,
           unique_people_value, total_people_value, source_session_id, created_at,
           activities(name)`,
        )
        .eq("business_year_id", filters.businessYearId as string)
        .gte("operation_date", filters.from)
        .lte("operation_date", filters.to)
        .order("operation_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (filters.activityId) query = query.eq("activity_id", filters.activityId);
      if (filters.activityIds) query = query.in("activity_id", filters.activityIds);
      if (filters.method) query = query.eq("method", filters.method);
      if (filters.status) query = query.eq("status", filters.status);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map(mapRecordRow);
    },
  });
}

// Final Batch A §21: 실적내역 Filter를 운영연도/기간/단위사업으로 단순화한다
// (대분류/중분류 filter는 없앤다). business_nodes.unit_business_id는
// major/middle 전부 채워져 있으므로(UnitBusiness↔BusinessNode Linkage
// Closure) activities.business_node_id -> business_nodes.unit_business_id로
// 바로 매핑할 수 있다.
export function useUnitBusinessesForYear(businessYearId: string | undefined) {
  return useQuery({
    queryKey: ["unit-businesses-for-year", businessYearId],
    enabled: !!businessYearId,
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await supabase
        .from("unit_businesses")
        .select("id, name")
        .eq("business_year_id", businessYearId as string)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useActivityIdsForUnitBusiness(
  businessYearId: string | undefined,
  unitBusinessId: string | undefined,
) {
  return useQuery({
    queryKey: ["activity-ids-for-unit-business", businessYearId, unitBusinessId],
    enabled: !!businessYearId && !!unitBusinessId,
    queryFn: async (): Promise<string[]> => {
      const { data: nodes, error: nodesError } = await supabase
        .from("business_nodes")
        .select("id")
        .eq("business_year_id", businessYearId as string)
        .eq("unit_business_id", unitBusinessId as string);
      if (nodesError) throw nodesError;
      const nodeIds = (nodes ?? []).map((n) => n.id);
      if (nodeIds.length === 0) return [];
      const { data: activities, error: activitiesError } = await supabase
        .from("activities")
        .select("id")
        .in("business_node_id", nodeIds);
      if (activitiesError) throw activitiesError;
      return (activities ?? []).map((a) => a.id);
    },
  });
}

export type PerformanceRecordDetail = PerformanceRecordRow & {
  operationTermName: string | null;
  sessionNo: number | null;
  creatorName: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
};

export function usePerformanceRecordDetail(recordId: string | undefined) {
  return useQuery({
    queryKey: ["performance-record-detail", recordId],
    enabled: !!recordId,
    queryFn: async (): Promise<PerformanceRecordDetail | null> => {
      const { data, error } = await supabase
        .from("performance_records")
        .select(
          `id, activity_id, method, status, operation_date, activity_content, count_value,
           unique_people_value, total_people_value, source_session_id, created_at,
           cancel_reason, cancelled_at,
           activities(name),
           sessions(session_no, operation_terms(name)),
           creator:principals!performance_records_created_by_fkey(name)`,
        )
        .eq("id", recordId as string)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const session = data.sessions as any;
      return {
        ...mapRecordRow(data),
        operationTermName: session?.operation_terms?.name ?? null,
        sessionNo: session?.session_no ?? null,
        creatorName: (data.creator as any)?.name ?? null,
        cancelReason: data.cancel_reason,
        cancelledAt: data.cancelled_at,
      };
    },
  });
}

function invalidatePerformanceRecords(qc: ReturnType<typeof useQueryClient>, recordId?: string) {
  qc.invalidateQueries({ queryKey: ["performance-records"] });
  qc.invalidateQueries({ queryKey: ["performance-report"] });
  if (recordId) qc.invalidateQueries({ queryKey: ["performance-record-detail", recordId] });
}

export function useCreateSummaryPerformance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      activityId: string;
      operationDate: string;
      activityContent: string;
      countValue: number;
      uniquePeopleValue: number;
      totalPeopleValue: number;
    }) => {
      const { data, error } = await supabase.rpc("create_summary_performance", {
        p_activity_id: input.activityId,
        p_operation_date: input.operationDate,
        p_activity_content: input.activityContent.trim() || null,
        p_count_value: input.countValue,
        p_unique_people_value: input.uniquePeopleValue,
        p_total_people_value: input.totalPeopleValue,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => invalidatePerformanceRecords(qc),
  });
}

export function useUpdateSummaryPerformance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      operationDate: string;
      activityContent: string;
      countValue: number;
      uniquePeopleValue: number;
      totalPeopleValue: number;
    }) => {
      const { error } = await supabase.rpc("update_summary_performance", {
        p_id: input.id,
        p_operation_date: input.operationDate,
        p_activity_content: input.activityContent.trim() || null,
        p_count_value: input.countValue,
        p_unique_people_value: input.uniquePeopleValue,
        p_total_people_value: input.totalPeopleValue,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => invalidatePerformanceRecords(qc, vars.id),
  });
}

export function useCancelPerformance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; reason: string }) => {
      const { error } = await supabase.rpc("cancel_performance", {
        p_id: input.id,
        p_reason: input.reason,
      });
      if (error) throw error;
    },
    onSuccess: (_d, vars) => invalidatePerformanceRecords(qc, vars.id),
  });
}

export function useRestorePerformance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("restore_performance", { p_id: id });
      if (error) throw error;
    },
    onSuccess: (_d, id) => invalidatePerformanceRecords(qc, id),
  });
}

// ============================================================
// 실적보고 (서버 aggregate)
// ============================================================

export type ReportMetric = { count: number | null; unique: number | null; total: number | null };

export type PerformanceReportRow = {
  nodeId: string;
  nodeType: "activity" | "major" | "middle" | "minor";
  parentId: string | null;
  unitBusinessId: string | null;
  label: string;
  level: number;
  sortOrder: number;
  plan: ReportMetric;
  period: ReportMetric;
  ytd: ReportMetric;
};

export function usePerformanceReport(input: {
  businessYearId: string | undefined;
  periodStart: string;
  periodEnd: string;
  ytdStart: string;
}) {
  return useQuery({
    queryKey: ["performance-report", input],
    enabled: !!input.businessYearId,
    queryFn: async (): Promise<PerformanceReportRow[]> => {
      const { data, error } = await supabase.rpc("get_performance_report", {
        p_business_year_id: input.businessYearId as string,
        p_period_start: input.periodStart,
        p_period_end: input.periodEnd,
        p_ytd_start: input.ytdStart,
      });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        nodeId: r.node_id,
        nodeType: r.node_type,
        parentId: r.parent_id,
        unitBusinessId: r.unit_business_id,
        label: r.label,
        level: r.level,
        sortOrder: r.sort_order,
        plan: { count: r.plan_count, unique: r.plan_unique, total: r.plan_total },
        period: { count: r.period_count, unique: r.period_unique, total: r.period_total },
        ytd: { count: r.ytd_count, unique: r.ytd_unique, total: r.ytd_total },
      }));
    },
  });
}

// ============================================================
// 연간계획 직접입력
// ============================================================

export type AnnualPlanActivityRow = {
  activityId: string;
  activityName: string;
  path: string;
  majorName: string;
  middleName: string;
  businessNodeId: string;
  unitBusinessId: string | null;
  isSummaryMethod: boolean;
  count: { target: number | null; basis: string | null };
  unique: { target: number | null; basis: string | null };
  total: { target: number | null; basis: string | null };
};

export type BusinessNodeLite = {
  id: string;
  name: string;
  parentId: string | null;
  nodeType: "major" | "middle" | "minor";
  unitBusinessId: string | null;
};

export function useAnnualPlanRows(businessYearId: string | undefined) {
  return useQuery({
    queryKey: ["annual-plan-rows", businessYearId],
    enabled: !!businessYearId,
    queryFn: async (): Promise<{ rows: AnnualPlanActivityRow[]; nodes: BusinessNodeLite[] }> => {
      const [activitiesRes, nodesRes, plansRes] = await Promise.all([
        supabase
          .from("activities")
          .select(
            "id, name, business_node_id, unit_business_id, sort_order, default_performance_method",
          )
          .eq("business_year_id", businessYearId as string)
          .eq("is_active", true)
          .order("sort_order"),
        supabase
          .from("business_nodes")
          .select("id, name, parent_id, node_type, sort_order, unit_business_id")
          .eq("business_year_id", businessYearId as string)
          .order("sort_order"),
        supabase
          .from("annual_plans")
          .select(
            "activity_id, count_target, count_basis, unique_target, unique_basis, total_target, total_basis",
          )
          .eq("business_year_id", businessYearId as string),
      ]);
      if (activitiesRes.error) throw activitiesRes.error;
      if (nodesRes.error) throw nodesRes.error;
      if (plansRes.error) throw plansRes.error;

      const nodeMap = new Map<string, { name: string; parent_id: string | null }>(
        (nodesRes.data ?? []).map((n: any) => [n.id, { name: n.name, parent_id: n.parent_id }]),
      );
      const chainFor = (nodeId: string): string[] => {
        const parts: string[] = [];
        let cur = nodeMap.get(nodeId);
        let guard = 0;
        while (cur && guard < 10) {
          parts.unshift(cur.name);
          cur = cur.parent_id ? nodeMap.get(cur.parent_id) : undefined;
          guard += 1;
        }
        return parts;
      };
      const planMap = new Map<string, any>(
        (plansRes.data ?? []).map((p: any) => [p.activity_id, p]),
      );

      const rows = (activitiesRes.data ?? []).map((a: any) => {
        const p = planMap.get(a.id);
        const chain = chainFor(a.business_node_id);
        return {
          activityId: a.id as string,
          activityName: a.name as string,
          path: chain.join(" > "),
          majorName: chain[0] ?? "",
          middleName: chain.length > 1 ? (chain[chain.length - 1] ?? "") : "",
          businessNodeId: a.business_node_id as string,
          unitBusinessId: a.unit_business_id as string | null,
          isSummaryMethod: a.default_performance_method === "summary",
          count: { target: p?.count_target ?? null, basis: p?.count_basis ?? null },
          unique: { target: p?.unique_target ?? null, basis: p?.unique_basis ?? null },
          total: { target: p?.total_target ?? null, basis: p?.total_basis ?? null },
        };
      });

      const nodes: BusinessNodeLite[] = (nodesRes.data ?? []).map((n: any) => ({
        id: n.id,
        name: n.name,
        parentId: n.parent_id,
        nodeType: n.node_type,
        unitBusinessId: n.unit_business_id,
      }));

      return { rows, nodes };
    },
  });
}

export function useBatchUpsertAnnualPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      businessYearId: string;
      rows: {
        activity_id: string;
        count_target: number | null;
        count_basis: string | null;
        unique_target: number | null;
        unique_basis: string | null;
        total_target: number | null;
        total_basis: string | null;
      }[];
    }) => {
      const { data, error } = await supabase.rpc("upsert_annual_plan_batch", {
        p_business_year_id: input.businessYearId,
        p_rows: input.rows,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["annual-plan-rows", vars.businessYearId] });
      qc.invalidateQueries({ queryKey: ["performance-report"] });
    },
  });
}
