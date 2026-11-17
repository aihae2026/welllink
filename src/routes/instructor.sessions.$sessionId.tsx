import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { InstructorLayout } from "@/components/layout/InstructorLayout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { errorReason } from "@/lib/error-message";
import {
  useSessionAttendanceRoster,
  useSessionDetail,
  useSessionInputDeadline,
  useSessionInputOpensAt,
  useSaveInstructorAttendance,
  type AttendanceMark,
} from "@/lib/attendance-data";

export const Route = createFileRoute("/instructor/sessions/$sessionId")({
  head: () => ({
    meta: [
      { title: "출석 입력 — WellLink 강사" },
      { name: "description", content: "회차별 출석을 입력합니다. 누르면 자동 저장됩니다." },
      { property: "og:title", content: "출석 입력 — WellLink 강사" },
      { property: "og:description", content: "태블릿 3열 색상 출석표." },
    ],
  }),
  component: AttendanceInput,
});

type Mark = "○" | "×" | "△";
const MARK_TO_DB: Record<Mark, AttendanceMark> = { "○": "present", "×": "absent", "△": "excused" };
const DB_TO_MARK: Record<AttendanceMark, Mark> = { present: "○", absent: "×", excused: "△" };

type SaveState = "idle" | "saving" | "saved" | "error";

// 자동저장 debounce(빠른 연속 탭 하나로 묶기) + 저장 진행 중 도착한 변경은
// 큐잉하지 않고 완료 직후 최신 상태로 한 번만 재저장한다(latest-write-wins).
const AUTO_SAVE_DEBOUNCE_MS = 700;

function AttendanceInput() {
  const { sessionId } = Route.useParams();
  const { data: session } = useSessionDetail(sessionId);
  const { data: deadlineAt } = useSessionInputDeadline(sessionId);
  const { data: opensAtRaw } = useSessionInputOpensAt(sessionId);
  const {
    data: roster,
    isLoading: rosterLoading,
    isError: rosterError,
    isFetching: rosterFetching,
    refetch: refetchRoster,
  } = useSessionAttendanceRoster(sessionId);
  const saveAttendance = useSaveInstructorAttendance();

  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // 저장이 거부된 이유(휴강·마감 등)는 서버가 한국어로 보내 준다 -- 그대로 보여준다.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // 안내 팝업 문구(null이면 닫힘) -- 입력 불가 상태에서 저장 버튼·이름 칸을 눌렀을 때.
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const marksRef = useRef(marks);
  marksRef.current = marks;
  const savingRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const debounceTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!roster) return;
    setMarks((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      return Object.fromEntries(
        roster.map((r) => [
          r.enrollmentId,
          r.latestInstructorMark ? DB_TO_MARK[r.latestInstructorMark] : r.isPreExcused ? "△" : "○",
        ]),
      ) as Record<string, Mark>;
    });
  }, [roster]);

  const startsAt = session ? new Date(session.startsAt) : null;
  const startTimeLabel =
    startsAt?.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) ?? "-";
  const deadline = deadlineAt ? new Date(deadlineAt) : null;
  // 입력은 수업 시작 10분 전부터(서버 session_input_opens_at). 값을 받기 전엔 시작 시각으로 막는다.
  const opensAt = opensAtRaw ? new Date(opensAtRaw) : startsAt;
  const isBeforeStart = !!opensAt && now < opensAt;
  const opensLabel = (() => {
    if (!opensAt || !startsAt) return "";
    const minutes = Math.round((startsAt.getTime() - opensAt.getTime()) / 60000);
    const time = opensAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    return minutes > 0 ? `수업 시작 ${minutes}분 전(${time})부터` : `수업 시작(${time})부터`;
  })();
  const isAfterDeadline = !!deadline && now > deadline;
  const isCancelled = session?.status === "cancelled";
  const isMissing = session?.status === "missing";
  const isFinalized = session?.status === "completed" || isMissing;
  const canSave = !isCancelled && !isFinalized && !isBeforeStart && !isAfterDeadline;
  // 마감이 지났거나 확정된 회차는 버튼을 [저장 마감]으로 보여준다(시작 전은 그냥 회색 [저장]).
  const isClosed = isCancelled || isFinalized || isAfterDeadline;
  // 입력 불가 상태에서 저장 버튼이나 이름 칸을 누르면 이 문구를 팝업으로 보여준다.
  const lockedMessage = isCancelled
    ? "휴강된 수업이라 출석을 입력할 수 없습니다."
    : isMissing
      ? "미입력으로 마감된 회차입니다. 출석 입력이 필요하면 담당 직원에게 문의해 주세요."
      : isFinalized
        ? "출석이 이미 확정되어 수정할 수 없습니다."
        : isBeforeStart
          ? `${opensLabel} 출석을 입력할 수 있습니다.`
          : "마감시간이 지나 출석을 수정할 수 없습니다.";

  const roster_ = useMemo(() => roster ?? [], [roster]);

  // §17/§18: 매 자동저장은 idempotency_key로 서버측 append-only 이력에 안전하게
  // 새 version을 남긴다(같은 키 재시도는 중복 없이 기존 것을 반환) -- 여기서는
  // "저장 중이면 대기했다가 최신 상태로 한 번만 재저장"만 클라이언트에서 보장하면
  // 된다(중복 row 문제는 idempotency_key가, 오래된 응답 덮어쓰기 문제는 여기서 해결).
  const runSave = async () => {
    if (!canSave) return;
    if (savingRef.current) {
      pendingSaveRef.current = true;
      return;
    }
    savingRef.current = true;
    setSaveState("saving");
    const snapshot = marksRef.current;
    try {
      await saveAttendance.mutateAsync({
        sessionId,
        entries: roster_.map((r) => ({
          enrollment_id: r.enrollmentId,
          mark: MARK_TO_DB[snapshot[r.enrollmentId] ?? "○"],
        })),
        idempotencyKey: crypto.randomUUID(),
      });
      setSaveState("saved");
      setSaveError(null);
      setSavedAt(
        new Date().toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      );
    } catch (e) {
      setSaveState("error");
      setSaveError(errorReason(e, "네트워크 연결을 확인한 뒤 다시 시도해 주세요."));
    } finally {
      savingRef.current = false;
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void runSave();
      }
    }
  };

  // 화면을 떠날 때(기기 뒤로가기 등) 쓰는 최신 runSave -- cleanup은 첫 렌더에서 만들어져
  // 그때의 canSave/roster_를 들고 있으므로 ref로 최신 것을 부른다.
  const runSaveRef = useRef(runSave);
  runSaveRef.current = runSave;

  const scheduleAutoSave = () => {
    if (debounceTimerRef.current) window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = undefined;
      void runSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
  };

  // debounce 대기 중에 화면을 떠나면 그 변경을 버리지 않고 즉시 저장을 보낸다. 저장
  // 요청(mutation)은 화면이 사라진 뒤에도 끝까지 진행된다.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = undefined;
        void runSaveRef.current();
      }
    };
  }, []);

  const toggle = (enrollmentId: string, isPreExcused: boolean) => {
    if (!canSave) return;
    setMarks((prev) => {
      const cur = prev[enrollmentId];
      // 사전 신고결석 대상자는 신고결석(△) <-> 출석(○)만 오간다(결석× 없음). 서버도 같은
      // 규칙이며, 출석으로 바꿨다가 다시 신고결석으로 되돌리는 것도 허용한다(migration 090000).
      if (isPreExcused) {
        return { ...prev, [enrollmentId]: cur === "△" ? "○" : "△" };
      }
      return { ...prev, [enrollmentId]: cur === "○" ? "×" : "○" };
    });
    scheduleAutoSave();
  };

  const manualSave = () => {
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = undefined;
    }
    void runSave();
  };

  const markOf = (r: { enrollmentId: string; isPreExcused: boolean }): Mark =>
    marks[r.enrollmentId] ?? (r.isPreExcused ? "△" : "○");
  const totalCount = roster_.length;
  const presentCount = roster_.filter((r) => markOf(r) === "○").length;
  const absentCount = roster_.filter((r) => markOf(r) === "×").length;
  const excusedCount = roster_.filter((r) => markOf(r) === "△").length;

  return (
    <InstructorLayout title="출석 입력" date={startsAt}>
      <div className="mb-3 flex items-center justify-between gap-3">
        {/* 날짜는 머리줄에 있으므로 여기는 "가곡클래스B  오전 11:00 · 10회차". 좁은 화면에서는
            시간이 다음 줄로 내려간다. */}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <p className="text-xl font-semibold text-foreground">{session?.programName ?? "수업"}</p>
          <p className="text-base text-muted-foreground">
            {startTimeLabel} · {session?.sessionNo ?? "-"}회차
          </p>
        </div>
        {/* 저장은 이름을 누를 때마다 자동으로 되지만, 전원 출석이라 아무것도 누르지 않는
            날을 위해 작은 [저장] 버튼을 남긴다(저장본이 없으면 마감 때 누락 처리된다).
            "입력 가능/불가" 표시는 따로 두지 않고, 입력 불가일 때 누르면 이유를 팝업으로 알린다. */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={canSave ? manualSave : () => setNotice(lockedMessage)}
            disabled={canSave && rosterLoading}
            aria-disabled={!canSave}
            className={`h-10 rounded-md px-4 text-base font-semibold active:opacity-90 disabled:opacity-60 ${
              canSave ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            {saveState === "saving" ? "저장 중…" : isClosed ? "저장 마감" : "저장"}
          </button>
          {saveState === "saved" && savedAt && (
            <p className="text-sm text-status-success-fg">{savedAt} 저장됨</p>
          )}
        </div>
      </div>

      {saveState === "error" && (
        <p className="mb-3 text-base text-status-danger-fg">
          저장하지 못했습니다. {saveError ?? "네트워크 연결을 확인한 뒤 다시 시도해 주세요."}
        </p>
      )}

      {/* 입력할 수 없는 회차(휴강·마감·확정·시작 전)는 이유를 화면에 그대로 띄운다. */}
      {!canSave && session && (
        <p className="mb-3 rounded border border-border bg-muted px-3 py-2 text-base text-foreground">
          {lockedMessage}
        </p>
      )}
      {/* 입력할 수 있을 때만 보여준다. 처음 화면이 전원 출석(○)으로 시작한다는 점을 현장 강사
          의견으로 안내한다(마감 시각 안내 줄은 사용자 결정으로 이 문구로 바꿨다). */}
      {canSave && (
        <p className="mb-3 text-base text-muted-foreground">
          처음에는 모두 출석으로 표시됩니다. 결석한 분만 눌러 바꿔 주세요. 누르면 바로 저장됩니다.
        </p>
      )}

      {/* 범례(§5)와 집계를 한 줄로 합쳤다: 색 점이 범례이고, 옆 숫자는 그 색 칸의 개수다.
          그래서 결석은 미신고결석(빨강)만 세고, 전체 = 출석 + 결석 + 신고결석이다. 셀 내부에는
          상태 텍스트를 넣지 않는다. 휴대폰에서도 반드시 한 줄 -- 글자 크기를 화면 폭에 맞춰
          줄이고(clamp), 태블릿부터는 왼쪽부터 붙여 늘어놓는다. */}
      <div className="mb-4 flex items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-border bg-card px-3 py-3 text-[clamp(0.75rem,4vw,1rem)] md:justify-start md:gap-8 md:px-4 md:text-lg">
        <span className="text-foreground">
          전체 <span className="text-[1.125em] font-bold">{totalCount}</span>
        </span>
        <LegendCount className="bg-attendance-present-bg" label="출석" value={presentCount} />
        <LegendCount className="bg-attendance-absent-bg" label="결석" value={absentCount} />
        <LegendCount className="bg-attendance-excused-bg" label="신고결석" value={excusedCount} />
      </div>

      {rosterLoading && <p className="text-base text-muted-foreground">불러오는 중...</p>}
      {rosterError && (
        <div className="rounded border border-border bg-card p-5">
          <p className="mb-3 text-base text-status-danger-fg">수강생 명단을 불러오지 못했습니다.</p>
          <button
            type="button"
            onClick={() => refetchRoster()}
            disabled={rosterFetching}
            className="h-11 rounded-md bg-primary px-4 text-base font-semibold text-primary-foreground active:opacity-90 disabled:opacity-60"
          >
            {rosterFetching ? "불러오는 중…" : "다시 시도"}
          </button>
        </div>
      )}

      {/* 모바일 3열, 태블릿(md, 768px+) 4열 -- 태블릿 가로(1024px 전후)도 xl 미만이라 4열.
          데스크탑(xl, 1280px+)은 10열 고정. 모바일 3열과 xl 초입(1280px대 10열)은 칸이
          100~115px라 좌우 여백과 글자를 줄여 네 글자 이름·회원번호가 한 줄에 들어가게 한다. */}
      <div className="grid grid-cols-3 gap-1.5 md:grid-cols-4 md:gap-3 xl:grid-cols-10 xl:gap-2.5">
        {roster_.map((r) => {
          const mark = markOf(r);
          const colorClass =
            mark === "○"
              ? "bg-attendance-present-bg text-attendance-present-fg"
              : mark === "×"
                ? "bg-attendance-absent-bg text-attendance-absent-fg"
                : "bg-attendance-excused-bg text-attendance-excused-fg";
          return (
            <button
              key={r.enrollmentId}
              onClick={() =>
                canSave ? toggle(r.enrollmentId, r.isPreExcused) : setNotice(lockedMessage)
              }
              // 입력 불가(마감·확정·시작 전)면 막지 않고 누르면 이유 팝업을 띄우며, 칸을
              // 흐리게 해 "지금은 못 바꾼다"를 보여준다. 색은 남겨 두어 기록은 그대로 읽힌다.
              aria-disabled={!canSave}
              className={`flex min-h-20 w-full flex-col items-center justify-center gap-1 rounded-xl px-1 py-3 text-center transition-opacity active:opacity-80 md:min-h-24 md:px-3 xl:px-1 2xl:px-3 ${colorClass} ${canSave ? "" : "opacity-75 saturate-50"}`}
            >
              <span className="text-[22px] font-bold leading-tight md:text-[26px] xl:text-[22px] 2xl:text-[26px]">
                {r.name}
              </span>
              <span className="text-sm leading-tight tabular-nums opacity-90 min-[360px]:text-base md:text-lg xl:text-base 2xl:text-lg">
                {r.memberCode}
              </span>
            </button>
          );
        })}
      </div>

      <AlertDialog open={notice !== null} onOpenChange={(open) => !open && setNotice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>안내</AlertDialogTitle>
            <AlertDialogDescription className="text-base">{notice}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction>확인</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </InstructorLayout>
  );
}

function LegendCount({
  className,
  label,
  value,
}: {
  className: string;
  label: string;
  value: number;
}) {
  // 크기는 em 단위 -- 부모 줄의 글자 크기(화면 폭에 따라 변함)를 따라간다.
  return (
    <span className="inline-flex items-center gap-[0.35em] text-foreground">
      <span className={`inline-block size-[0.85em] shrink-0 rounded-full ${className}`} />
      {label} <span className="text-[1.125em] font-bold">{value}</span>
    </span>
  );
}
