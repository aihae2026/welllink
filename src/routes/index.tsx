import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import {
  CalendarDays,
  ChevronRight,
  ClipboardList,
  FilePlus2,
  ListChecks,
  Sparkles,
} from "lucide-react";
import { StaffLayout, Panel, PanelHeader } from "@/components/layout/StaffLayout";
import { SessionStatusBadge, StatusBadge } from "@/components/ui/status-badge";
import { sessionStatusLabel } from "@/lib/attendance-data";
import { useAttendanceSettings } from "@/lib/org-settings-data";
import { formatPeriodHuman } from "@/lib/evaluation-data";
import { formatTime } from "@/lib/format";
import {
  useAttendanceCardCounts,
  useHomeScope,
  useHomeAbsenceAlertCount,
  usePerformanceCardCounts,
  useLatestEvaluation,
  useTodaySessions,
} from "@/lib/home-data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "홈 — WellLink v1.0 복지관 업무지원" },
      {
        name: "description",
        content:
          "WellLink 홈. 출석관리 → 사업실적 → AI 사업평가 파이프라인과 오늘의 프로그램을 한눈에 확인합니다.",
      },
      { property: "og:title", content: "홈 — WellLink v1.0" },
      {
        property: "og:description",
        content: "복지관 출석·실적·사업평가 업무를 연결하는 WellLink 업무지원 시스템.",
      },
    ],
  }),
  component: HomePage,
});


// "2026년 9월 15일(화)"
function formatHeadlineDate(): string {
  const now = new Date();
  const weekday = now.toLocaleDateString("ko-KR", { weekday: "short" });
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일(${weekday})`;
}

// "오전 10:00~10:50" -- 시작과 끝이 같은 오전/오후면 끝쪽 표시는 뺀다("오전 11:30~오후 12:20"은 그대로).
function formatTimeRange(startIso: string, endIso: string): string {
  const start = formatTime(startIso);
  const end = formatTime(endIso);
  const [startPeriod] = start.split(" ");
  const [endPeriod, endClock] = end.split(" ");
  return startPeriod === endPeriod && endClock ? `${start}~${endClock}` : `${start}~${end}`;
}

// Home Dashboard Closure §3/§19: 세 Pipeline Card는 동일한 시각적 비중으로
// 나란히 배치한다 -- 출석관리만 강조되지 않도록 flex flex-col + 버튼을
// 항상 카드 하단에 고정한다(내용 길이가 달라도 카드 높이는 grid가 맞춰준다).
function PipelineCard({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action: { label: string; to: string; params?: Record<string, string> };
}) {
  return (
    <div className="flex flex-col rounded border border-border bg-card p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded border border-border bg-muted/50">
          {icon}
        </span>
        <span className="text-sm font-medium text-foreground">{title}</span>
      </div>
      <div className="mt-4 flex-1 space-y-2.5">{children}</div>
      <Link
        to={action.to}
        {...(action.params ? { params: action.params } : {})}
        className="mt-4 inline-flex h-9 items-center justify-center rounded border border-border bg-card text-sm text-foreground transition-colors hover:bg-muted"
      >
        {action.label}
      </Link>
    </div>
  );
}

// 숫자만 보고 끝나지 않도록, 목록이 있는 항목은 줄 전체가 링크다.
const mobileSummaryRowCls =
  "flex min-h-12 items-center gap-3 px-4 py-2.5 transition-colors active:bg-muted";

function StatRow({
  label,
  value,
  to,
  search,
}: {
  label: string;
  value: string;
  to?: string;
  search?: Record<string, string | undefined>;
}) {
  const body = (
    <>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold text-foreground">{value}</span>
    </>
  );
  if (!to) {
    return <div className="flex items-baseline justify-between">{body}</div>;
  }
  return (
    <Link
      to={to}
      search={search ?? {}}
      className="-mx-1 flex items-baseline justify-between rounded px-1 transition-colors hover:bg-muted"
    >
      {body}
    </Link>
  );
}

function HomePage() {
  const { data: settings } = useAttendanceSettings();
  const homeScope = useHomeScope();
  const { data: attendanceCounts } = useAttendanceCardCounts(homeScope.cycleIds);
  const absenceAlert = useHomeAbsenceAlertCount();
  const { data: performanceCounts } = usePerformanceCardCounts();
  const { data: latestEvaluation } = useLatestEvaluation();
  const { data: todaySessions } = useTodaySessions();

  const attendanceEnabled = settings?.attendanceEnabled ?? true;
  const excusedAbsenceEnabled = settings?.excusedAbsenceEnabled ?? true;

  return (
    <StaffLayout title="홈">
      {/* 날짜가 매일 보는 정보라 앞에 진하게, 문구는 한 톤 연하게. 좁은 화면에서는 문구가 통째로 다음 줄로 내려가 날짜가 쪼개지지 않는다. */}
      <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <p className="text-lg font-semibold tracking-tight text-foreground">
          {formatHeadlineDate()}
        </p>
        <p className="text-[15px] text-muted-foreground">
          복지 현장의 기록을 연결해, 성과와 가치로
        </p>
      </div>

      {/* 휴대폰(640px 미만)에서는 세 카드가 세로로 쌓여 두 화면 가까이 차지했다.
          카드마다 핵심 숫자만 한 줄로 보여주고, 줄을 누르면 카드 버튼과 같은 화면으로 간다. */}
      <nav className="overflow-hidden rounded border border-border bg-card sm:hidden">
        <ul className="divide-y divide-border">
          <li>
            <Link to="/attendance/programs" className={mobileSummaryRowCls}>
              <span className="shrink-0 text-sm font-medium text-foreground">출석관리</span>
              <span className="min-w-0 flex-1 text-right text-sm text-muted-foreground">
                누락 {attendanceCounts ? `${attendanceCounts.missingCount}건` : "-"}
                {attendanceEnabled &&
                  ` · 결석 알림 ${absenceAlert.count !== undefined ? `${absenceAlert.count}명` : "-"}`}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            </Link>
          </li>
          <li>
            <Link to="/performance/records" className={mobileSummaryRowCls}>
              <span className="shrink-0 text-sm font-medium text-foreground">사업실적</span>
              <span className="min-w-0 flex-1 text-right text-sm text-muted-foreground">
                이번 달 {performanceCounts ? `${performanceCounts.total}건` : "-"}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            </Link>
          </li>
          <li>
            {latestEvaluation ? (
              <Link
                to="/evaluation/records/$evaluationId"
                params={{ evaluationId: latestEvaluation.id }}
                className={mobileSummaryRowCls}
              >
                <span className="shrink-0 text-sm font-medium text-foreground">AI 사업평가</span>
                <span className="min-w-0 flex-1 text-right text-sm text-muted-foreground">
                  최근{" "}
                  {formatPeriodHuman(
                    latestEvaluation.periodType,
                    latestEvaluation.periodStart,
                    latestEvaluation.periodEnd,
                  )}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              </Link>
            ) : (
              <Link to="/evaluation/new" className={mobileSummaryRowCls}>
                <span className="shrink-0 text-sm font-medium text-foreground">AI 사업평가</span>
                <span className="min-w-0 flex-1 text-right text-sm text-muted-foreground">
                  작성된 평가 없음
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              </Link>
            )}
          </li>
        </ul>
      </nav>

      <div className="hidden gap-4 sm:grid md:grid-cols-3">
        <PipelineCard
          icon={<ClipboardList className="size-4 text-muted-foreground" strokeWidth={1.5} />}
          title="출석관리"
          action={{ label: "프로그램 설정 보기", to: "/attendance/programs" }}
        >
          <StatRow
            label="오늘 프로그램"
            value={attendanceCounts ? `${attendanceCounts.todayProgramCount}개` : "-"}
          />
          <StatRow
            label={homeScope.scopeLabel ? `출석 누락(${homeScope.scopeLabel})` : "출석 누락"}
            value={attendanceCounts ? `${attendanceCounts.missingCount}건` : "-"}
            to="/attendance/programs"
            search={{ missing: "1" }}
          />
          {attendanceEnabled && (
            <StatRow
              label={
                absenceAlert.scopeLabel ? `결석 알림(${absenceAlert.scopeLabel})` : "결석 알림"
              }
              value={absenceAlert.count !== undefined ? `${absenceAlert.count}명` : "-"}
              to="/attendance/absence"
              search={{ yearId: absenceAlert.yearId, cycleId: absenceAlert.cycleId }}
            />
          )}
        </PipelineCard>

        <PipelineCard
          icon={<ListChecks className="size-4 text-muted-foreground" strokeWidth={1.5} />}
          title="사업실적"
          action={{ label: "실적내역 보기", to: "/performance/records" }}
        >
          <StatRow
            label="이번 달 실적"
            value={performanceCounts ? `${performanceCounts.total}건` : "-"}
          />
          <StatRow
            label="출석연동"
            value={performanceCounts ? `${performanceCounts.attendance}건` : "-"}
          />
          <StatRow
            label="직접 등록"
            value={performanceCounts ? `${performanceCounts.summary}건` : "-"}
          />
        </PipelineCard>

        <PipelineCard
          icon={<Sparkles className="size-4 text-muted-foreground" strokeWidth={1.5} />}
          title="AI 사업평가"
          action={
            latestEvaluation
              ? {
                  label: "평가 보기",
                  to: "/evaluation/records/$evaluationId",
                  params: { evaluationId: latestEvaluation.id },
                }
              : { label: "AI 사업평가 작성", to: "/evaluation/new" }
          }
        >
          {latestEvaluation ? (
            <>
              <p className="text-sm text-muted-foreground">최근 작성한 평가</p>
              <p className="text-xl font-semibold text-foreground">
                {formatPeriodHuman(
                  latestEvaluation.periodType,
                  latestEvaluation.periodStart,
                  latestEvaluation.periodEnd,
                )}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">작성된 평가가 없습니다.</p>
          )}
        </PipelineCard>
      </div>

      <Panel className="mt-6">
        <PanelHeader title="오늘의 프로그램" />
        {/* 한 회차 = 한 칸(1줄 시간 + 상태 배지, 2줄 프로그램명). 세로로 길게 늘어지지 않도록
            휴대폰 2칸 / 태블릿 3칸 / 데스크탑 4칸 / 넓은 모니터 5칸으로 채운다.
            누락·완료 회차는 출석 입력·기록 화면으로, 그 밖(예정·입력중·휴강)은 프로그램의
            회차 탭으로 이동한다. */}
        <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {todaySessions?.map((s) => {
            const label = sessionStatusLabel(s.status, s.hasSubmission);
            const tileCls =
              "block rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted";
            const body = (
              <>
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <span className="whitespace-nowrap text-[13px] text-muted-foreground tabular-nums">
                    {formatTimeRange(s.startsAt, s.endsAt)}
                  </span>
                  <span className="flex items-center gap-1">
                    <SessionStatusBadge status={label} />
                    {s.hasCorrection && <StatusBadge label="정정됨" tone="warn" />}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium text-foreground">{s.programName}</p>
              </>
            );
            if (s.status === "missing" || s.status === "completed") {
              return (
                <Link
                  key={s.sessionId}
                  to="/attendance/sessions/$sessionId"
                  params={{ sessionId: s.sessionId }}
                  className={tileCls}
                >
                  {body}
                </Link>
              );
            }
            if (s.programId) {
              return (
                <Link
                  key={s.sessionId}
                  to="/attendance/programs/$programId"
                  params={{ programId: s.programId }}
                  search={{
                    cycleId: s.operationCycleId ?? undefined,
                    tab: "회차 및 출석현황",
                    yearId: undefined,
                    missing: undefined,
                  }}
                  className={tileCls}
                >
                  {body}
                </Link>
              );
            }
            return (
              <div key={s.sessionId} className={tileCls}>
                {body}
              </div>
            );
          })}
          {todaySessions?.length === 0 && (
            <p className="col-span-full px-1 py-4 text-center text-sm text-muted-foreground">
              오늘 예정된 프로그램이 없습니다.
            </p>
          )}
        </div>
      </Panel>

      <Panel className="mt-6">
        <PanelHeader title="업무 바로가기" />
        <div className="grid gap-2 p-4 sm:grid-cols-3">
          {attendanceEnabled && excusedAbsenceEnabled && (
            <Link
              to="/attendance/excused"
              className="inline-flex h-9 items-center gap-2 rounded border border-border bg-card px-3 text-sm text-foreground transition-colors hover:bg-muted"
            >
              <CalendarDays className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
              <span className="truncate">신고결석 등록</span>
            </Link>
          )}
          <Link
            to="/performance/new"
            className="inline-flex h-9 items-center gap-2 rounded border border-border bg-card px-3 text-sm text-foreground transition-colors hover:bg-muted"
          >
            <FilePlus2 className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <span className="truncate">실적 직접 등록</span>
          </Link>
          <Link
            to="/evaluation/new"
            className="inline-flex h-9 items-center gap-2 rounded border border-border bg-card px-3 text-sm text-foreground transition-colors hover:bg-muted"
          >
            <Sparkles className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
            <span className="truncate">AI 사업평가 작성</span>
          </Link>
        </div>
      </Panel>
    </StaffLayout>
  );
}
