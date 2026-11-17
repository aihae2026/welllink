import { createFileRoute, Link } from "@tanstack/react-router";
import { InstructorLayout } from "@/components/layout/InstructorLayout";
import { StatusBadge } from "@/components/ui/status-badge";
import { useInstructorTodaySessions } from "@/lib/attendance-data";

export const Route = createFileRoute("/instructor/")({
  head: () => ({
    meta: [
      { title: "오늘 수업 — WellLink 강사" },
      {
        name: "description",
        content: "강사용 오늘 수업 목록에서 회차를 선택해 출석을 입력합니다.",
      },
      { property: "og:title", content: "오늘 수업 — WellLink 강사" },
      { property: "og:description", content: "모바일 우선 강사용 오늘 수업 화면." },
    ],
  }),
  component: TodayClasses,
});

function statusLabel(status: string, hasSaved: boolean) {
  // 휴강 회차도 목록에 남긴다 -- 빠지면 강사는 "오늘 수업이 없다"와 구분할 수 없다.
  if (status === "cancelled") return "휴강";
  if (status === "completed") return "확정됨";
  if (status === "missing") return "미입력";
  if (hasSaved) return "저장됨";
  return "입력 전";
}

// "오전 09:30 · 55회차"
function sessionSubtitle(startsAt: string, sessionNo: number) {
  const time = new Date(startsAt).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${time} · ${sessionNo}회차`;
}

function TodayClasses() {
  const { data: sessions, isLoading, isError, refetch, isFetching } = useInstructorTodaySessions();

  return (
    <InstructorLayout title="오늘 수업" date={new Date()}>
      {/* 휴대폰·태블릿 기준 카드라 넓은 화면에서는 가운데 720px로 둔다. */}
      <div className="mx-auto max-w-[720px]">
        {isLoading && <p className="text-base text-muted-foreground">불러오는 중...</p>}
        {/* 조회 실패를 "수업 없음"으로 보여주면 강사가 입력을 건너뛰게 된다 -- 따로 알리고 다시 시도. */}
        {isError && (
          <div className="rounded border border-border bg-card p-5">
            <p className="mb-3 text-base text-status-danger-fg">오늘 수업을 불러오지 못했습니다.</p>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="h-11 rounded-md bg-primary px-4 text-base font-semibold text-primary-foreground active:opacity-90 disabled:opacity-60"
            >
              {isFetching ? "불러오는 중…" : "다시 시도"}
            </button>
          </div>
        )}
        {!isLoading && !isError && (sessions?.length ?? 0) === 0 && (
          <p className="text-base text-muted-foreground">오늘 담당하는 수업이 없습니다.</p>
        )}
        <ul className="space-y-3">
          {sessions?.map((s) => (
            <li key={s.sessionId}>
              <Link
                to="/instructor/sessions/$sessionId"
                params={{ sessionId: s.sessionId }}
                className="block rounded border border-border bg-card p-5 active:bg-muted"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xl font-semibold text-foreground">{s.programName}</span>
                    <span className="text-base text-muted-foreground">
                      {sessionSubtitle(s.startsAt, s.sessionNo)}
                    </span>
                  </div>
                  <StatusBadge
                    label={statusLabel(s.status, s.hasSaved)}
                    tone={
                      s.status === "completed"
                        ? "success"
                        : s.status === "cancelled"
                          ? "neutral"
                          : s.hasSaved
                            ? "info"
                            : s.status === "missing"
                              ? "danger"
                              : "neutral"
                    }
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </InstructorLayout>
  );
}
