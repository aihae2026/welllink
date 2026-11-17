import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  StaffLayout,
  Panel,
  btnPrimaryCls,
  btnRowCls,
  theadCls,
} from "@/components/layout/StaffLayout";
import { SessionStatusBadge, StatusBadge } from "@/components/ui/status-badge";
import {
  useSessionDetail,
  useSessionAttendanceRoster,
  useFinalAttendanceForSession,
  useCompleteMissingSession,
  useCorrectFinalAttendance,
  FINALIZATION_METHOD_LABEL,
  type AttendanceMark,
} from "@/lib/attendance-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";
import { formatDate, formatTime } from "@/lib/format";

export const Route = createFileRoute("/attendance/sessions/$sessionId")({
  head: () => ({
    meta: [
      { title: "회차 출석기록 — WellLink" },
      {
        name: "description",
        content: "직원이 회차별 출석기록을 확인하고 정정사유와 함께 정정하는 화면입니다.",
      },
      { property: "og:title", content: "회차 출석기록 — WellLink" },
      { property: "og:description", content: "직원용 회차 출석기록 확인·정정 화면." },
    ],
  }),
  component: SessionAttendancePage,
});

type Mark = "○" | "×" | "△";
const MARKS: Mark[] = ["○", "×", "△"];
const MARK_TO_DB: Record<Mark, AttendanceMark> = { "○": "present", "×": "absent", "△": "excused" };
const DB_TO_MARK: Record<AttendanceMark, Mark> = { present: "○", absent: "×", excused: "△" };

// 강사 출석 화면과 같은 색(출석 파랑 · 결석 빨강 · 신고결석 주황). 결석은 미신고만 뜻한다.
const MARK_LABEL: Record<AttendanceMark, string> = { present: "출석", absent: "결석", excused: "신고결석" };
// ○×△ 버튼 뜻을 화면에 풀어 쓴다.
const MARK_LEGEND = MARKS.map((m) => `${m} ${MARK_LABEL[MARK_TO_DB[m]]}`).join(" · ");
const MARK_COLOR: Record<AttendanceMark, string> = {
  present: "bg-attendance-present-bg text-attendance-present-fg",
  absent: "bg-attendance-absent-bg text-attendance-absent-fg",
  excused: "bg-attendance-excused-bg text-attendance-excused-fg",
};

function MarkBadge({ mark }: { mark: AttendanceMark }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${MARK_COLOR[mark]}`}
    >
      {MARK_LABEL[mark]}
    </span>
  );
}

// 누락 입력·정정에서 ○×△ 버튼: 고른 버튼만 해당 출석 색으로 칠한다.
function markButtonCls(m: Mark, selected: boolean) {
  return `size-8 rounded border text-sm ${
    selected
      ? `border-transparent font-semibold ${MARK_COLOR[MARK_TO_DB[m]]}`
      : "border-border text-muted-foreground hover:bg-muted"
  }`;
}

function statusLabel(status: string | undefined) {
  if (status === "scheduled") return "입력중";
  if (status === "completed") return "완료";
  if (status === "missing") return "누락";
  if (status === "cancelled") return "휴강";
  return "";
}

function SessionAttendancePage() {
  const { sessionId } = Route.useParams();
  const navigate = useNavigate();
  const { data: session } = useSessionDetail(sessionId);
  const { data: roster } = useSessionAttendanceRoster(sessionId);
  const { data: finalMap } = useFinalAttendanceForSession(sessionId);
  const completeMissing = useCompleteMissingSession();
  const correct = useCorrectFinalAttendance();

  const isMissing = session?.status === "missing";
  // 회차표의 "입력중" 배지에서 넘어온 예정 회차 -- 아직 확정 전이라 강사가 저장한 출석만 읽기전용으로 보여준다.
  const isScheduled = session?.status === "scheduled";
  const programId = session?.programId;

  const [missingMarks, setMissingMarks] = useState<Record<string, Mark>>({});
  const [missingReason, setMissingReason] = useState("");
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [correctMark, setCorrectMark] = useState<Mark | null>(null);
  const [correctReason, setCorrectReason] = useState("");

  useEffect(() => {
    if (!roster || !isMissing) return;
    setMissingMarks((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      return Object.fromEntries(
        roster.map((r) => [r.enrollmentId, r.isPreExcused ? "△" : "○"]),
      ) as Record<string, Mark>;
    });
  }, [roster, isMissing]);

  // Attendance E2E Manual QA Gap Fix §1-2: 저장 성공 후 원래 보고 있던
  // 프로그램의 같은 운영구분(cycleId) "회차 및 출석현황" 탭으로 복귀한다 --
  // 다른 운영구분으로 임의 이동하지 않는다.
  function backToSessionsTab() {
    if (!programId) return;
    navigate({
      to: "/attendance/programs/$programId",
      params: { programId },
      search: {
        cycleId: session?.operationCycleId,
        tab: "회차 및 출석현황",
        yearId: undefined,
        missing: undefined,
      },
    });
  }

  const submitMissing = async () => {
    if (!missingReason.trim() || !roster) return;
    try {
      await completeMissing.mutateAsync({
        sessionId,
        operationTermId: session?.operationTermId,
        entries: roster.map((r) => ({
          enrollment_id: r.enrollmentId,
          mark: MARK_TO_DB[missingMarks[r.enrollmentId] ?? "○"],
        })),
        reason: missingReason,
      });
      toast.success("누락 회차 출석을 보완했습니다.");
      setMissingReason("");
      backToSessionsTab();
    } catch (e: any) {
      toast.error(`보완 실패: ${errorReason(e)}`);
    }
  };

  const submitCorrection = async (finalAttendanceId: string) => {
    if (!correctMark || !correctReason.trim()) return;
    try {
      await correct.mutateAsync({
        finalAttendanceId,
        afterMark: MARK_TO_DB[correctMark],
        reason: correctReason,
        sessionId,
        operationTermId: session?.operationTermId,
      });
      toast.success("출석을 정정했습니다.");
      setCorrectingId(null);
      setCorrectMark(null);
      setCorrectReason("");
      // 한 명 고칠 때마다 회차 목록으로 돌아가면 여러 명을 이어서 고칠 수 없다 -- 화면에 머문다.
      // (누락 회차 전체 보완은 한 번에 끝나는 일이라 기존대로 목록으로 돌아간다.)
    } catch (e: any) {
      toast.error(`정정 실패: ${errorReason(e)}`);
    }
  };

  return (
    <StaffLayout
      title={`${session?.programName ?? "프로그램"} ${session?.sessionNo ? `${session.sessionNo}회차` : ""} 출석기록`}
      // 저장 후 복귀(backToSessionsTab)와 같은 곳으로 돌아간다 -- 주소만 열면
      // 프로그램 상세의 첫 탭(기본설정)이 열려 회차 목록을 다시 찾아야 했다.
      back={
        programId
          ? {
              label: "회차 및 출석현황",
              to: `/attendance/programs/${programId}`,
              search: {
        cycleId: session?.operationCycleId,
        tab: "회차 및 출석현황",
        yearId: undefined,
        missing: undefined,
      },
            }
          : { label: "프로그램", to: "/attendance/programs" }
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">{session ? formatDate(session.startsAt) : "-"}</span>
        <span className="tabular-nums">
          {session ? `${formatTime(session.startsAt)}~${formatTime(session.endsAt)}` : "-"}
        </span>
        <SessionStatusBadge status={statusLabel(session?.status)} />
        {Object.values(finalMap ?? {}).some((f) => f.finalizationMethod === "staff_correction") && (
          <StatusBadge label="정정됨" tone="warn" />
        )}
      </div>

      {isScheduled ? (
        <p className="mb-3 text-sm text-muted-foreground">
          강사가 입력 중인 회차입니다. 아래는 강사가 마지막으로 저장한 출석이며, 입력 마감 후 자동으로
          확정됩니다.
        </p>
      ) : isMissing ? (
        <p className="mb-3 text-sm text-muted-foreground">{MARK_LEGEND}</p>
      ) : (
        <p className="mb-3 text-sm text-muted-foreground">
          완료된 회차의 출석기록입니다. 각 행의 [정정]으로 사유와 함께 수정할 수 있습니다.
          {` (${MARK_LEGEND})`}
        </p>
      )}

      <Panel>
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className={theadCls}>
              <th className="px-4 py-2 font-medium">회원번호</th>
              <th className="px-4 py-2 font-medium">성명</th>
              <th className="px-4 py-2 font-medium">
                {isMissing ? "출석 입력" : isScheduled ? "강사 입력" : "출석"}
              </th>
              {!isMissing && !isScheduled && <th className="px-4 py-2 font-medium">출처</th>}
              {!isMissing && !isScheduled && <th className="px-4 py-2 font-medium">관리</th>}
            </tr>
          </thead>
          <tbody>
            {roster?.map((r) => {
              const final = finalMap?.[r.enrollmentId];
              const isCorrectingThis =
                correctingId !== null && correctingId === r.finalAttendanceId;
              return (
                <tr key={r.enrollmentId} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 text-muted-foreground">{r.memberCode}</td>
                  <td className="px-4 py-2.5 text-foreground">{r.name}</td>
                  <td className="px-4 py-2.5">
                    {isScheduled ? (
                      r.latestInstructorMark ? (
                        <MarkBadge mark={r.latestInstructorMark} />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )
                    ) : isMissing ? (
                      <div className="flex gap-1">
                        {MARKS.map((m) => (
                          <button
                            key={m}
                            title={MARK_LABEL[MARK_TO_DB[m]]}
                            aria-label={MARK_LABEL[MARK_TO_DB[m]]}
                            onClick={() =>
                              setMissingMarks((prev) => ({ ...prev, [r.enrollmentId]: m }))
                            }
                            className={markButtonCls(m, missingMarks[r.enrollmentId] === m)}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    ) : isCorrectingThis ? (
                      <div className="flex gap-1">
                        {MARKS.map((m) => (
                          <button
                            key={m}
                            title={MARK_LABEL[MARK_TO_DB[m]]}
                            aria-label={MARK_LABEL[MARK_TO_DB[m]]}
                            onClick={() => setCorrectMark(m)}
                            className={markButtonCls(m, correctMark === m)}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    ) : (
                      final ? (
                        <MarkBadge mark={final.mark} />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )
                    )}
                  </td>
                  {!isMissing && !isScheduled && (
                    <td className="px-4 py-2.5">
                      {final ? (
                        final.finalizationMethod === "staff_correction" ? (
                          <StatusBadge label={FINALIZATION_METHOD_LABEL.staff_correction} tone="warn" />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {FINALIZATION_METHOD_LABEL[final.finalizationMethod]}
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                  )}
                  {!isMissing && !isScheduled && (
                    <td className="px-4 py-2.5">
                      {final &&
                        (isCorrectingThis ? (
                          <button
                            onClick={() => {
                              setCorrectingId(null);
                              setCorrectMark(null);
                              setCorrectReason("");
                            }}
                            className={btnRowCls}
                          >
                            취소
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setCorrectingId(final.id);
                              setCorrectMark(DB_TO_MARK[final.mark]);
                              setCorrectReason("");
                            }}
                            className={btnRowCls}
                          >
                            정정
                          </button>
                        ))}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {correctingId && (
        <div className="mt-4 max-w-xl">
          <label className="mb-1 block text-sm text-foreground">
            정정사유 <span className="text-status-danger-fg">*</span>
          </label>
          <textarea
            value={correctReason}
            onChange={(e) => setCorrectReason(e.target.value)}
            rows={3}
            placeholder="정정사유를 입력해야 저장할 수 있습니다."
            className="w-full rounded border border-input bg-card px-2.5 py-2 text-sm text-foreground"
          />
          <div className="mt-3 flex gap-2">
            <button
              disabled={!correctReason.trim() || correct.isPending}
              onClick={() => submitCorrection(correctingId)}
              className={btnPrimaryCls}
            >
              정정 저장
            </button>
          </div>
        </div>
      )}

      {isMissing && (
        <div className="mt-4 max-w-xl">
          <label className="mb-1 block text-sm text-foreground">
            입력 사유 <span className="text-status-danger-fg">*</span>
          </label>
          <textarea
            value={missingReason}
            onChange={(e) => setMissingReason(e.target.value)}
            rows={3}
            placeholder="입력 사유를 입력해야 저장할 수 있습니다."
            className="w-full rounded border border-input bg-card px-2.5 py-2 text-sm text-foreground"
          />
          <div className="mt-3 flex gap-2">
            <button
              disabled={!missingReason.trim() || completeMissing.isPending}
              onClick={submitMissing}
              className={btnPrimaryCls}
            >
              출석 저장
            </button>
          </div>
        </div>
      )}
    </StaffLayout>
  );
}
