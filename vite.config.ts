// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// nitro의 tasks virtual module은 handler 문자열을 그대로 import()에 넣는다(내부적으로
// 별도 base 경로 해석을 하지 않는다) -- 그래서 상대경로("./server/...")는 실패하고
// 절대경로가 필요하다.
const finalizeDueSessionsTaskHandler = fileURLToPath(
  new URL("./src/server/tasks/finalize-due-sessions.ts", import.meta.url),
);

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  // Batch 1.2 Completion Pass: 출석 자동확정 Scheduled Job.
  // cloudflare-module preset은 scheduledTasks/tasks를 실제 Cron Trigger로 자동 변환한다
  // (wrangler 설정을 직접 손으로 만들지 않는다 -- Nitro 공식 문서의 권장 방식).
  //
  // @lovable.dev/vite-tanstack-config의 `nitro` 옵션 타입은 { preset?, output?, cloudflare? }로
  // 좁게 선언되어 있지만, 런타임에서는 이 객체를 그대로 nitro/vite의 nitro()에 전달한다
  // (실제로 experimental/scheduledTasks/tasks가 빌드 결과 wrangler.json의 triggers.crons와
  // Cron Trigger 실행 경로에 정확히 반영됨을 build + wrangler dev로 직접 확인했다).
  // 라이브러리의 .d.ts가 좁아서 생기는 타입 오차일 뿐이라 as any로 우회한다.
  nitro: {
    experimental: { tasks: true },
    scheduledTasks: {
      "* * * * *": "attendance:finalize-due-sessions",
    },
    tasks: {
      "attendance:finalize-due-sessions": {
        handler: finalizeDueSessionsTaskHandler,
        description: "마감된 회차를 finalize_due_sessions()로 자동확정/누락처리",
      },
    },
  } as any,
});
