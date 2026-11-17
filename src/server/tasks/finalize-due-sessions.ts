import { defineTask } from "nitro/task";
import { createClient } from "@supabase/supabase-js";

// Cloudflare Cron Trigger(약 1분 간격) -> Nitro scheduled task -> 이 파일 -> DB의
// finalize_due_sessions() RPC. 업무규칙(마감시간 계산, latest submission 선택,
// 저장없음->누락, idempotency)은 전부 DB 함수 안에 있다. 이 파일은 그 함수를
// service_role 권한으로 호출하기만 하는 얇은 트리거/adapter이고, 업무규칙을
// 여기서 다시 구현하지 않는다.
//
// service_role key는 여기서도 process.env로만 읽는다 -- VITE_ 접두사가 아니므로
// 클라이언트 번들에 절대 포함되지 않는다(instructor-auth.ts의 서버 함수들과 동일한
// 서버 전용 환경변수 규칙).

type FinalizeTaskResult = {
  ok: boolean;
  error: string | undefined;
  processedCount: number | undefined;
  processed: { out_session_id: string; out_result: string }[] | undefined;
};

export default defineTask({
  meta: {
    name: "attendance:finalize-due-sessions",
    description: "입력 마감시간(session_input_deadline)이 지난 회차를 finalize_due_sessions()로 자동확정/누락처리한다.",
  },
  async run(): Promise<{ result: FinalizeTaskResult }> {
    const supabaseUrl = process.env["VITE_SUPABASE_URL"];
    const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
    if (!supabaseUrl || !serviceRoleKey) {
      const message =
        "finalize-due-sessions task: 서버 환경변수가 설정되지 않았습니다(VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).";
      console.error(message);
      return {
        result: { ok: false, error: message, processedCount: undefined, processed: undefined },
      };
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await admin.rpc("finalize_due_sessions");

    if (error) {
      // 오류를 삼키지 않는다 -- 로그로 남아 실패를 확인할 수 있어야 한다.
      console.error("finalize-due-sessions task failed:", error.message);
      return {
        result: {
          ok: false,
          error: error.message,
          processedCount: undefined,
          processed: undefined,
        },
      };
    }

    const processed = (data ?? []) as { out_session_id: string; out_result: string }[];
    if (processed.length > 0) {
      console.log(
        `finalize-due-sessions task: ${processed.length}건 처리 -`,
        processed.map((p) => `${p.out_session_id}:${p.out_result}`).join(", "),
      );
    }

    return { result: { ok: true, error: undefined, processedCount: processed.length, processed } };
  },
});
