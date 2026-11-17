import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { compareName } from "./format";
import { generateAiEvaluation } from "@/lib/ai-evaluation-server";

// Pipeline 2 / Batch 2.2: AI 사업평가 실제 Supabase data layer.
// 평가단위는 단위사업이다(소분류 아님). 목록/상세는 client에서 직접 조회하고,
// 생성만 서버함수(generateAiEvaluation)를 거친다 -- 계산은 전부 DB RPC가 담당한다.

export type PeriodType = "quarter" | "half_year" | "year" | "custom";

export type UnitBusinessOption = { id: string; name: string };

export function useUnitBusinesses(businessYearId: string | undefined) {
  return useQuery({
    queryKey: ["ai-evaluation-unit-businesses", businessYearId],
    enabled: !!businessYearId,
    queryFn: async (): Promise<UnitBusinessOption[]> => {
      const { data, error } = await supabase.rpc("list_ai_evaluation_unit_businesses", {
        p_business_year_id: businessYearId as string,
      });
      if (error) throw error;
      return (data ?? [])
        .map((r: any) => ({ id: r.out_id as string, name: r.out_name as string }))
        .sort((a: UnitBusinessOption, b: UnitBusinessOption) => compareName(a.name, b.name));
    },
  });
}

// AI 사업평가 작성·결과 화면에 함께 보여 주는 AI 사용 안내(두 화면 문구를 한 곳에서 관리).
export const AI_DRAFT_NOTICE =
  "AI 사업평가는 Google Gemini가 시스템이 확정한 실적 수치를 바탕으로 작성한 초안입니다. 수치는 AI가 계산하지 않으며, 결과는 담당자가 검토한 뒤 활용해 주세요.";

// Final Batch A §39 / Home Dashboard Closure §7: 시스템 표현
// ("quarter (2026-01-01 ~ 2026-03-31)") 대신 사람이 바로 이해하는 표현
// ("2026년 1분기")을 쓴다. 목록/작성/홈 화면이 같이 쓴다. DB의 period_type
// enum에는 아직 "month"가 없지만(§25 -- 이번 작업에서 DB는 건드리지 않는다),
// 향후를 위해 formatter는 미리 지원해 둔다.
export function formatPeriodHuman(
  periodType: string,
  periodStart: string,
  periodEnd: string,
): string {
  const year = periodStart.slice(0, 4);
  const month = Number(periodStart.slice(5, 7));
  if (periodType === "month") return `${year}년 ${month}월`;
  if (periodType === "quarter") return `${year}년 ${Math.ceil(month / 3)}분기`;
  if (periodType === "half_year") return `${year}년 ${month <= 6 ? "상반기" : "하반기"}`;
  if (periodType === "year") return `${year}년 연간`;
  return `${periodStart.replaceAll("-", ".")} ~ ${periodEnd.replaceAll("-", ".")}`;
}

// Final Batch A §40: AI 평가 생성 전, 어떤 데이터를 참고하게 되는지 화면에서
// 먼저 보여준다(연간계획 등록 여부/실적 건수). business_nodes.unit_business_id는
// major/middle 전부 채워져 있고 activities도 자체 unit_business_id를 가지므로
// 두 테이블만 조회하면 된다(집계는 새로 만들지 않고 count만 쓴다).
// metrics: 생성할 때와 같은 build_ai_evaluation_payload(저장하지 않는 계산 RPC)로 받은
// 연간계획/평가기간 실적/누계. 결과 화면의 "평가 기준 실적"과 같은 값이며, 조회에
// 실패하면 null로 두고 건수 안내만 보여 준다.
export type EvaluationDataPreview = {
  hasAnnualPlan: boolean;
  performanceRecordCount: number;
  metrics: { plan: MetricTriple; period: MetricTriple; ytd: MetricTriple } | null;
};

type PayloadMetric = { count?: number | null; unique?: number | null; total?: number | null };
type PreviewPayload = { plan?: PayloadMetric; period?: PayloadMetric; ytd?: PayloadMetric };

const toMetricTriple = (m: PayloadMetric | undefined): MetricTriple => ({
  count: m?.count ?? null,
  unique: m?.unique ?? null,
  total: m?.total ?? null,
});

// 0과 "값 없음"을 구분해 표시한다(작성·결과 화면 공용).
export const formatMetricValue = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : v.toLocaleString();

export function formatAchievementRate(actual: number | null, plan: number | null): string {
  if (plan === null || plan === 0 || actual === null) return "-";
  return `${((actual / plan) * 100).toFixed(1)}%`;
}

export function useEvaluationDataPreview(input: {
  businessYearId: string | undefined;
  unitBusinessId: string;
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
}) {
  return useQuery({
    queryKey: ["ai-evaluation-data-preview", input],
    enabled: !!input.businessYearId && !!input.unitBusinessId,
    queryFn: async (): Promise<EvaluationDataPreview> => {
      const { data: nodes, error: nodesError } = await supabase
        .from("business_nodes")
        .select("id")
        .eq("business_year_id", input.businessYearId as string)
        .eq("unit_business_id", input.unitBusinessId);
      if (nodesError) throw nodesError;
      const nodeIds = (nodes ?? []).map((n) => n.id);

      const { data: byNode, error: byNodeError } = nodeIds.length
        ? await supabase.from("activities").select("id").in("business_node_id", nodeIds)
        : { data: [], error: null };
      if (byNodeError) throw byNodeError;
      const { data: byUnit, error: byUnitError } = await supabase
        .from("activities")
        .select("id")
        .eq("unit_business_id", input.unitBusinessId);
      if (byUnitError) throw byUnitError;
      const activityIds = Array.from(
        new Set([...(byNode ?? []), ...(byUnit ?? [])].map((a) => a.id)),
      );
      if (activityIds.length === 0) {
        return { hasAnnualPlan: false, performanceRecordCount: 0, metrics: null };
      }

      const [{ data: plans, error: plansError }, { count, error: countError }] = await Promise.all([
        supabase
          .from("annual_plans")
          .select("activity_id")
          .eq("business_year_id", input.businessYearId as string)
          .in("activity_id", activityIds)
          .limit(1),
        supabase
          .from("performance_records")
          .select("id", { count: "exact", head: true })
          .eq("status", "active")
          .in("activity_id", activityIds)
          .gte("operation_date", input.periodStart)
          .lte("operation_date", input.periodEnd),
      ]);
      if (plansError) throw plansError;
      if (countError) throw countError;

      const { data: payload, error: payloadError } = await supabase.rpc(
        "build_ai_evaluation_payload",
        {
          p_unit_business_id: input.unitBusinessId,
          p_period_type: input.periodType,
          p_period_start: input.periodStart,
          p_period_end: input.periodEnd,
        },
      );
      const p = payload as PreviewPayload | null;
      const metrics =
        payloadError || !p
          ? null
          : {
              plan: toMetricTriple(p.plan),
              period: toMetricTriple(p.period),
              ytd: toMetricTriple(p.ytd),
            };

      return {
        hasAnnualPlan: (plans ?? []).length > 0,
        performanceRecordCount: count ?? 0,
        metrics,
      };
    },
  });
}

export type EvaluationListRow = {
  id: string;
  unitBusinessName: string;
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  creatorName: string | null;
};

export function useEvaluationsList(filters: {
  businessYearId: string | undefined;
  unitBusinessId?: string;
}) {
  return useQuery({
    queryKey: ["ai-evaluations", filters],
    enabled: !!filters.businessYearId,
    queryFn: async (): Promise<EvaluationListRow[]> => {
      let query = supabase
        .from("ai_evaluations")
        .select(
          `id, period_type, period_start, period_end, created_at,
           unit_businesses(name), creator:principals!ai_evaluations_created_by_fkey(name)`,
        )
        .eq("business_year_id", filters.businessYearId as string)
        .order("created_at", { ascending: false });
      if (filters.unitBusinessId) query = query.eq("unit_business_id", filters.unitBusinessId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        unitBusinessName: r.unit_businesses?.name ?? "-",
        periodType: r.period_type,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        createdAt: r.created_at,
        creatorName: r.creator?.name ?? null,
      }));
    },
  });
}

export type MetricTriple = { count: number | null; unique: number | null; total: number | null };

export type EvaluationActivitySnapshot = {
  activityId: string;
  activityName: string;
  period: MetricTriple;
  ytd: MetricTriple;
};

export type EvaluationDetail = {
  id: string;
  unitBusinessName: string;
  periodType: PeriodType;
  periodStart: string;
  periodEnd: string;
  referenceNote: string | null;
  createdAt: string;
  creatorName: string | null;
  plan: MetricTriple;
  period: MetricTriple;
  ytd: MetricTriple;
  operationResult: string;
  majorChanges: string;
  checkpoints: string;
  futureDirection: string;
  activities: EvaluationActivitySnapshot[];
};

export function useEvaluationDetail(id: string | undefined) {
  return useQuery({
    queryKey: ["ai-evaluation-detail", id],
    enabled: !!id,
    queryFn: async (): Promise<EvaluationDetail | null> => {
      const { data, error } = await supabase
        .from("ai_evaluations")
        .select(
          `id, period_type, period_start, period_end, reference_note, created_at,
           plan_count, plan_unique_people, plan_total_people,
           period_count, period_unique_people, period_total_people,
           ytd_count, ytd_unique_people, ytd_total_people,
           operation_result, major_changes, checkpoints, future_direction,
           unit_businesses(name), creator:principals!ai_evaluations_created_by_fkey(name),
           ai_evaluation_snapshots(activity_id, activity_name_snapshot, sort_order,
             period_count, period_unique_people, period_total_people,
             ytd_count, ytd_unique_people, ytd_total_people)`,
        )
        .eq("id", id as string)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const snapshots = ((data.ai_evaluation_snapshots as any[]) ?? []).sort(
        (a, b) => a.sort_order - b.sort_order,
      );
      return {
        id: data.id,
        unitBusinessName: (data.unit_businesses as any)?.name ?? "-",
        periodType: data.period_type,
        periodStart: data.period_start,
        periodEnd: data.period_end,
        referenceNote: data.reference_note,
        createdAt: data.created_at,
        creatorName: (data.creator as any)?.name ?? null,
        plan: {
          count: data.plan_count,
          unique: data.plan_unique_people,
          total: data.plan_total_people,
        },
        period: {
          count: data.period_count,
          unique: data.period_unique_people,
          total: data.period_total_people,
        },
        ytd: {
          count: data.ytd_count,
          unique: data.ytd_unique_people,
          total: data.ytd_total_people,
        },
        operationResult: data.operation_result,
        majorChanges: data.major_changes,
        checkpoints: data.checkpoints,
        futureDirection: data.future_direction,
        activities: snapshots.map((s: any) => ({
          activityId: s.activity_id,
          activityName: s.activity_name_snapshot,
          period: {
            count: s.period_count,
            unique: s.period_unique_people,
            total: s.period_total_people,
          },
          ytd: { count: s.ytd_count, unique: s.ytd_unique_people, total: s.ytd_total_people },
        })),
      };
    },
  });
}

export function useGenerateEvaluation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      unitBusinessId: string;
      periodType: PeriodType;
      periodStart: string;
      periodEnd: string;
      referenceNote: string;
      idempotencyKey: string;
      acknowledgePiiWarnings: boolean;
    }) => {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("AUTH_REQUIRED");
      return generateAiEvaluation({ data: { ...input, accessToken } });
    },
    onSuccess: (result) => {
      if (result.status === "created") qc.invalidateQueries({ queryKey: ["ai-evaluations"] });
    },
  });
}
