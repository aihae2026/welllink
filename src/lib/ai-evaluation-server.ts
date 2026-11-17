import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import {
  detectBlockedPii,
  detectPiiWarnings,
  findMemberNames,
  type PiiMatch,
  type PiiWarningKind,
} from "@/lib/pii-guard";

// Pipeline 2 / Batch 2.2: AI 사업평가 생성 서버함수.
// WellLink_Demo의 src/lib/ai-review-server.ts 패턴을 재사용한다: service_role을 쓰지 않고
// 호출자 본인의 access token으로 request-scoped client를 만들어 RLS/RPC 권한검사를 그대로
// 받는다. Gemini secret은 process.env에서만 읽고 클라이언트 번들에 절대 포함되지 않는다.
//
// 흐름: PII guard(참고사항 차단 -> 경고 확인) -> build_ai_evaluation_payload(RPC, 아직 미저장) -> Gemini 호출
// -> 4영역 구조검증 -> save_ai_evaluation_snapshot(RPC, 같은 payload 그대로 저장).
// Gemini 호출이 성공하기 전까지는 ai_evaluations에 어떤 row도 만들지 않는다 -- 그래서 별도
// pending/failed 상태 컬럼이 필요 없다(실패해도 남는 부분 데이터가 없다).

export type AiEvaluationErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "PII_DETECTED"
  | "PII_CHECK_FAILED"
  | "INVALID_INPUT"
  | "AI_NOT_CONFIGURED"
  | "AI_TIMEOUT"
  | "AI_REQUEST_FAILED"
  | "AI_RESPONSE_INVALID";

export class AiEvaluationError extends Error {
  code: AiEvaluationErrorCode;
  constructor(code: AiEvaluationErrorCode) {
    super(code);
    this.name = "AiEvaluationError";
    this.code = code;
  }
}

const periodTypeSchema = z.enum(["quarter", "half_year", "year", "custom"]);

const generateInputSchema = z.object({
  accessToken: z.string().min(1),
  unitBusinessId: z.string().uuid(),
  periodType: periodTypeSchema,
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  referenceNote: z.string().trim().max(2000),
  idempotencyKey: z.string().uuid(),
  // 경고창에서 "개인정보가 아닙니다"를 확인했을 때만 true. 차단 항목은 이 값과 무관하게 막힌다.
  acknowledgePiiWarnings: z.boolean().default(false),
});

export type GenerateAiEvaluationResult =
  | { status: "created"; evaluationId: string }
  | { status: "needs_confirmation"; warnings: PiiMatch<PiiWarningKind>[] };

function createRequestScopedSupabaseClient(accessToken: string) {
  // Lovable Publish 런타임은 SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY(prefix 없음)를
  // process.env로 주입한다 -- src/lib/supabase.ts와 동일한 fallback 순서.
  const supabaseUrl = import.meta.env["VITE_SUPABASE_URL"] ?? process.env["SUPABASE_URL"];
  const supabasePublishableKey =
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
    import.meta.env["VITE_SUPABASE_ANON_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"];
  return createClient(supabaseUrl, supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const PARTICIPANT_PAGE_SIZE = 1000;

// 기관 수강생 이름 전체(RLS로 본인 기관만). PostgREST 한 번 응답 한도를 넘을 수 있어 나눠 받는다.
async function listParticipantNames(
  client: ReturnType<typeof createRequestScopedSupabaseClient>,
): Promise<string[]> {
  const names: string[] = [];
  for (let from = 0; ; from += PARTICIPANT_PAGE_SIZE) {
    const { data, error } = await client
      .from("participants")
      .select("name")
      .order("id")
      .range(from, from + PARTICIPANT_PAGE_SIZE - 1);
    if (error) throw new AiEvaluationError("PII_CHECK_FAILED");
    for (const row of data ?? []) names.push(row.name as string);
    if (!data || data.length < PARTICIPANT_PAGE_SIZE) return names;
  }
}

// ---------------------------------------------------------------------------
// Gemini 호출
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_MAX_OUTPUT_TOKENS = 1600;
const GEMINI_TIMEOUT_MS = 25000;
const PROMPT_VERSION = "welllink-evaluation-v1";

const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    operationResult: {
      type: "string",
      description: "운영결과: 계획 대비 실적과 달성률에서 확인되는 사실만 기술한다.",
    },
    majorChanges: {
      type: "string",
      description:
        "주요 변화: 평가기간 실적과 누계(activities breakdown)에서 관찰 가능한 변화만 언급한다.",
    },
    checkpoints: {
      type: "string",
      description: "점검사항: 원인이 불분명한 사항을 원인 단정 없이 확인 요청 형태로 기술한다.",
    },
    futureDirection: {
      type: "string",
      description: "향후 운영방향: 제공된 데이터 범위 안에서만 제안한다.",
    },
  },
  required: ["operationResult", "majorChanges", "checkpoints", "futureDirection"],
} as const;

export const geminiOutputSchema = z
  .object({
    operationResult: z.string().trim().min(1),
    majorChanges: z.string().trim().min(1),
    checkpoints: z.string().trim().min(1),
    futureDirection: z.string().trim().min(1),
  })
  .strict();

export type AiEvaluationResultSections = z.infer<typeof geminiOutputSchema>;

type MetricTriple = { count: number | null; unique: number | null; total: number | null };
type ActivityPayload = {
  activity_id: string;
  activity_name: string;
  sort_order: number;
  plan: MetricTriple;
  period: MetricTriple;
  ytd: MetricTriple;
};
export type AiEvaluationSnapshotPayload = {
  organization_id: string;
  business_year_id: string;
  unit_business_id: string;
  unit_business_name: string;
  period_type: string;
  period_start: string;
  period_end: string;
  plan: MetricTriple;
  period: MetricTriple;
  ytd: MetricTriple;
  activities: ActivityPayload[];
};

// 연간계획이 없는 값(null)을 그대로 넘기면 모델이 결과 문장에 "(null)"이라고
// 옮겨 적는다. 사람이 읽을 낱말로 바꿔서 넘긴다.
const NOT_SET = "미설정";
function readableTriple(t: MetricTriple): Record<string, number | string> {
  return {
    건: t.count ?? NOT_SET,
    실인원: t.unique ?? NOT_SET,
    연인원: t.total ?? NOT_SET,
  };
}

function formatRate(actual: number | null, plan: number | null): string {
  if (plan === null || plan === 0 || actual === null) return "미설정";
  return `${((actual / plan) * 100).toFixed(1)}%`;
}

const PERIOD_TYPE_LABEL: Record<string, string> = {
  quarter: "분기",
  half_year: "반기",
  year: "연간",
  custom: "직접선택",
};

function buildPrompt(payload: AiEvaluationSnapshotPayload, referenceNote: string): string {
  const data = {
    단위사업: payload.unit_business_name,
    평가기간유형: PERIOD_TYPE_LABEL[payload.period_type] ?? payload.period_type,
    기간범위: `${payload.period_start} ~ ${payload.period_end}`,
    연간계획: readableTriple(payload.plan),
    평가기간실적: readableTriple(payload.period),
    누계: readableTriple(payload.ytd),
    누적달성률: {
      건: formatRate(payload.ytd.count, payload.plan.count),
      실인원: formatRate(payload.ytd.unique, payload.plan.unique),
      연인원: formatRate(payload.ytd.total, payload.plan.total),
    },
    활동별실적: payload.activities.map((a) => ({
      활동명: a.activity_name,
      연간계획: readableTriple(a.plan),
      평가기간실적: readableTriple(a.period),
      누계: readableTriple(a.ytd),
    })),
    AI참고사항: referenceNote || null,
  };

  return `당신은 한국 사회복지관의 사업평가서 초안을 작성하는 보조자입니다.
아래 [데이터]만을 근거로 평가 초안 4개 항목을 작성하세요. 데이터에 없는 사실을 만들어내지 마세요.

[데이터]
${JSON.stringify(data)}

[반드시 지켜야 할 규칙]
1. 계산 금지: 연간계획/평가기간실적/누계/누적달성률/활동별실적 수치는 이미 시스템이 확정한 공식값입니다. 다시 계산하거나 다른 숫자를 만들어내지 말고, 그대로 인용하거나 해석만 하세요.
2. 연간계획의 값이 "미설정"이면 목표가 세워지지 않은 것입니다. 0으로 해석하면 안 되고, "미설정"/"null" 같은 낱말을 결과 문장에 그대로 쓰지 마세요("목표가 설정되지 않은" 식으로 풀어 쓰세요).
3. 연간계획이 0인데 실적이 0보다 크면 "목표 0으로 설정되어 있으나 실적이 발생함" 정도로 사실만 언급하세요. "목표 초과 달성"이라고 표현하지 마세요.
4. majorChanges(주요 변화): 활동별실적의 평가기간실적과 누계를 비교해 관찰 가능한 변화만 언급하세요. 전년도/이전 기간 자료가 제공되지 않았으므로 "전년 대비"/"지난 분기 대비" 같은 표현은 근거 없이 쓰지 마세요.
5. AI참고사항에 명시되지 않은 원인을 "참여 저조 때문"/"홍보 부족 때문"처럼 단정하지 마세요. 원인이 불분명하면 checkpoints(점검사항)에 "원인 확인이 필요함" 정도로만 작성하세요.
6. 실적 수치만으로 "만족도가 향상됨"/"삶의 질이 향상됨"/"사업 효과성이 검증됨" 같은 성과를 만들어내지 마세요. AI참고사항에 근거가 있을 때만 그 범위 내에서 활용하세요.
7. 개인(이용자·강사·직원)을 특정하거나 평가하지 마세요. 존재하지 않는 이용자 사례나 발언을 만들어내지 마세요.
8. 이 데이터에 없는 프로그램/활동을 언급하지 말고, 단위사업 전체를 근거 없이 과장하지 마세요.
9. 문체: 한국 사회복지관 사업평가서에 어울리는 간결하고 공식적인 업무 문체를 사용하고, 과장 표현을 쓰지 마세요.

[출력 항목]
- operationResult: 운영결과
- majorChanges: 주요 변화
- checkpoints: 점검사항
- futureDirection: 향후 운영방향

지정된 JSON 스키마 형식으로만 응답하세요.`;
}

function extractOutputText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const steps = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;

  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    if ((step as { type?: unknown }).type !== "model_output") continue;

    const content = (step as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      if ((block as { type?: unknown }).type !== "text") continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) return text;
    }
  }
  return null;
}

async function callGemini(
  payload: AiEvaluationSnapshotPayload,
  referenceNote: string,
): Promise<AiEvaluationResultSections> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new AiEvaluationError("AI_NOT_CONFIGURED");

  const prompt = buildPrompt(payload, referenceNote);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: prompt,
        store: false,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: GEMINI_RESPONSE_SCHEMA,
        },
        generation_config: {
          max_output_tokens: GEMINI_MAX_OUTPUT_TOKENS,
          thinking_level: "minimal",
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new AiEvaluationError("AI_TIMEOUT");
    throw new AiEvaluationError("AI_REQUEST_FAILED");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errorBody = (await response.json()) as {
        error?: { status?: string; message?: string };
      };
      const status = errorBody?.error?.status;
      const message = errorBody?.error?.message?.slice(0, 300);
      if (status || message) detail = ` googleStatus=${status ?? "-"} message=${message ?? "-"}`;
    } catch {
      // 본문이 JSON이 아니면 상태 코드만 남긴다.
    }
    console.error(`Gemini API 호출 실패: status=${response.status}${detail}`);
    throw new AiEvaluationError("AI_REQUEST_FAILED");
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new AiEvaluationError("AI_RESPONSE_INVALID");
  }

  const text = extractOutputText(responseBody);
  if (!text) throw new AiEvaluationError("AI_RESPONSE_INVALID");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new AiEvaluationError("AI_RESPONSE_INVALID");
  }

  const parsed = geminiOutputSchema.safeParse(parsedJson);
  if (!parsed.success) throw new AiEvaluationError("AI_RESPONSE_INVALID");

  return parsed.data;
}

// ---------------------------------------------------------------------------
export const generateAiEvaluation = createServerFn({ method: "POST" })
  .validator((data: unknown) => generateInputSchema.parse(data))
  .handler(async ({ data }): Promise<GenerateAiEvaluationResult> => {
    // PII guard가 가장 먼저다 -- 통과하지 못하면 DB에도 Gemini에도 전혀 닿지 않는다.
    if (detectBlockedPii(data.referenceNote).length > 0) {
      throw new AiEvaluationError("PII_DETECTED");
    }

    const client = createRequestScopedSupabaseClient(data.accessToken);

    const { data: userData, error: userError } = await client.auth.getUser(data.accessToken);
    if (userError || !userData.user) throw new AiEvaluationError("AUTH_REQUIRED");

    // 재시도(같은 idempotency_key)면 Gemini를 다시 부르지 않고 기존 결과를 그대로 반환한다.
    const { data: existing } = await client
      .from("ai_evaluations")
      .select("id")
      .eq("idempotency_key", data.idempotencyKey)
      .maybeSingle();
    if (existing) {
      return { status: "created", evaluationId: existing.id as string };
    }

    // 경고 항목(회원명·주소·생년월일·건강정보)은 사용자가 확인해야만 Gemini로 보낸다.
    if (data.referenceNote && !data.acknowledgePiiWarnings) {
      const names = await listParticipantNames(client);
      const warnings = [
        ...findMemberNames(data.referenceNote, names),
        ...detectPiiWarnings(data.referenceNote),
      ];
      if (warnings.length > 0) return { status: "needs_confirmation", warnings };
    }

    const { data: payload, error: payloadError } = await client.rpc("build_ai_evaluation_payload", {
      p_unit_business_id: data.unitBusinessId,
      p_period_type: data.periodType,
      p_period_start: data.periodStart,
      p_period_end: data.periodEnd,
    });
    if (payloadError || !payload) {
      if (payloadError?.message?.includes("권한")) throw new AiEvaluationError("FORBIDDEN");
      throw new AiEvaluationError("INVALID_INPUT");
    }

    const aiResult = await callGemini(payload as AiEvaluationSnapshotPayload, data.referenceNote);

    const { data: evaluationId, error: saveError } = await client.rpc(
      "save_ai_evaluation_snapshot",
      {
        p_payload: payload,
        p_reference_note: data.referenceNote || null,
        p_operation_result: aiResult.operationResult,
        p_major_changes: aiResult.majorChanges,
        p_checkpoints: aiResult.checkpoints,
        p_future_direction: aiResult.futureDirection,
        p_model_name: GEMINI_MODEL,
        p_prompt_version: PROMPT_VERSION,
        p_idempotency_key: data.idempotencyKey,
      },
    );
    if (saveError || !evaluationId) {
      throw new AiEvaluationError("AI_RESPONSE_INVALID");
    }

    return { status: "created", evaluationId: evaluationId as string };
  });
