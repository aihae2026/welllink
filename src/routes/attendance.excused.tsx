import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  StaffLayout,
  AbsenceTabs,
  Panel,
  FilterBar,
  controlCls,
  chipCls,
  btnPrimaryCls,
  btnSecondaryCls,
  theadCls,
  btnRowCls,
  ListState,
} from "@/components/layout/StaffLayout";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useOperationCycleProgramStatus, useOperationTermRoster } from "@/lib/programs-data";
import {
  localDayKey,
  useExcusedAbsenceList,
  type ExcusedAbsenceRow,
  useUpcomingSessionsForTerm,
  useSetExcusedAbsence,
  useCancelExcusedAbsence,
} from "@/lib/attendance-data";
import { useAttendanceSettings } from "@/lib/org-settings-data";
import { OperationCycleSelector } from "@/components/attendance/OperationCycleSelector";
import { useOperationCycleSelection } from "@/lib/operation-cycle-selection";
import { toast } from "sonner";
import { compareName, formatDate, formatTime } from "@/lib/format";
import { errorReason } from "@/lib/error-message";

export const Route = createFileRoute("/attendance/excused")({
  // 운영연도/운영구분 선택값은 URL로 들고 다닌다 -- 결석 주의대상 탭과
  // 같은 선택을 공유하고, 새로고침/뒤로가기에도 유지되어야 한다.
  validateSearch: (
    search: Record<string, unknown>,
  ): { yearId?: string | undefined; cycleId?: string | undefined } => ({
    yearId: typeof search["yearId"] === "string" ? search["yearId"] : undefined,
    cycleId: typeof search["cycleId"] === "string" ? search["cycleId"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "결석 관리 — WellLink" },
      { name: "description", content: "오늘 및 향후 예정된 신고결석을 등록하고 조회합니다." },
      { property: "og:title", content: "신고결석 — WellLink" },
      { property: "og:description", content: "예정 회차 기준 신고결석 등록·조회 화면." },
    ],
  }),
  component: ExcusedPage,
});

// 신고결석 등록/조회 대상은 "선택된 운영구분에 가져와 기본설정까지 끝난
// 프로그램"이다. operationTermId는 그 구분에서의 운영정보(회차·수강명단).
type CycleProgramOption = {
  programId: string;
  name: string;
  operationTermId: string | null;
};

function ExcusedPage() {
  const [period, setPeriod] = useState<"예정" | "지난">("예정");
  const [pickedDate, setPickedDate] = useState("");
  const [program, setProgram] = useState("전체");
  const [open, setOpen] = useState(false);
  // [취소]를 누르면 바로 취소하지 않고 확인창에서 [예]를 눌렀을 때 취소한다.
  const [pendingCancel, setPendingCancel] = useState<ExcusedAbsenceRow | null>(null);

  const { yearId, cycleId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const {
    years,
    cycles,
    cyclesLoading,
    activeYearId,
    activeCycleId,
    activeCycle,
    activeCycleLabel,
  } = useOperationCycleSelection({ yearId, cycleId });
  const tabSearch = { yearId: activeYearId ?? undefined, cycleId: activeCycleId ?? undefined };

  // 기관 전체 프로그램 목록(useProgramsList)을 쓰면 다른 운영구분의 회차·
  // 수강명단이 섞이므로, 이 운영구분에 가져온 프로그램만 사용한다.
  const { data: cyclePrograms } = useOperationCycleProgramStatus(activeCycleId);
  const programOptions: CycleProgramOption[] = (cyclePrograms ?? [])
    .filter((p) => p.hasTerm)
    .map((p) => ({ programId: p.programId, name: p.name, operationTermId: p.operationTermId }));

  const {
    data: rowsData,
    isLoading: listLoading,
    isError: listError,
    isFetching: listFetching,
    refetch: refetchList,
  } = useExcusedAbsenceList(activeCycleId);
  const cancel = useCancelExcusedAbsence();
  const { data: attendanceSettings } = useAttendanceSettings();

  // 날짜를 고르면 그날만 본다(오늘·예정/지난 기록 버튼은 꺼진다).
  // 오늘 수업은 이미 시작했어도 하루가 끝날 때까지 오늘·예정에 둔다.
  const today = localDayKey(new Date());
  const byProgramThenUser = (a: ExcusedAbsenceRow, b: ExcusedAbsenceRow) =>
    compareName(a.programName, b.programName) || compareName(a.userName, b.userName);
  const rows = (rowsData ?? [])
    .filter((r) => program === "전체" || r.programName === program)
    .filter((r) =>
      pickedDate
        ? r.sessionDay === pickedDate
        : period === "예정"
          ? r.sessionDay >= today
          : r.sessionDay < today,
    )
    // 예정: 가까운 날짜부터. 지난 기록: 최근 날짜부터. 같은 날은 프로그램·이용자 이름순.
    .sort(
      (a, b) =>
        (period === "지난" && !pickedDate
          ? b.sessionDay.localeCompare(a.sessionDay)
          : a.sessionDay.localeCompare(b.sessionDay)) || byProgramThenUser(a, b),
    );
  // [취소]는 오늘(자정 전)부터의 회차. 확정된 오늘 회차는 서버가 공식출석도 함께 바꾼다.
  const showCancelColumn = pickedDate ? pickedDate >= today : period === "예정";
  const canCancel = (r: ExcusedAbsenceRow) => r.sessionDay >= today;
  const cancelColSpan = showCancelColumn ? 6 : 5;
  const emptyMessage =
    programOptions.length === 0
      ? "이 운영구분에는 기본설정이 끝난 프로그램이 없습니다. 프로그램 설정에서 먼저 등록해 주세요."
      : "표시할 신고결석이 없습니다.";

  // 표와 휴대폰 카드가 같이 쓴다.
  const cancelOne = async (r: ExcusedAbsenceRow) => {
    try {
      await cancel.mutateAsync({ sessionId: r.sessionId, enrollmentId: r.enrollmentId });
      toast.success("신고결석을 취소했습니다.");
    } catch (e: any) {
      toast.error(`취소 실패: ${errorReason(e)}`);
    }
  };

  if (attendanceSettings && !attendanceSettings.attendanceEnabled) {
    return (
      <StaffLayout title="결석 관리">
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">
            결석 관리 기능이 사용 안 함으로 설정되어 있습니다. 운영설정 &gt; 기본정보에서 켤 수
            있습니다.
          </p>
        </Panel>
      </StaffLayout>
    );
  }

  // 신고결석을 끈 기관은 "신고결석 관리" 탭이 없다 -- 안내 화면 대신 결석
  // 주의대상 탭으로 바로 보낸다(선택한 운영연도/운영구분 유지).
  if (attendanceSettings && !attendanceSettings.excusedAbsenceEnabled) {
    return <Navigate to="/attendance/absence" search={tabSearch} replace />;
  }

  return (
    <StaffLayout title="결석 관리">
      <OperationCycleSelector
        years={years}
        cycles={cycles}
        cyclesLoading={cyclesLoading}
        activeYearId={activeYearId}
        activeCycleId={activeCycleId}
        onYearChange={(nextYearId) => {
          setProgram("전체");
          setPickedDate("");
          navigate({ search: { yearId: nextYearId, cycleId: undefined } });
        }}
        onCycleChange={(nextCycleId) => {
          setProgram("전체");
          setPickedDate("");
          navigate({ search: { yearId: activeYearId ?? undefined, cycleId: nextCycleId } });
        }}
        period={
          activeCycle ? { startDate: activeCycle.startDate, endDate: activeCycle.endDate } : null
        }
      />
      <AbsenceTabs active="excused" search={tabSearch} />
      <p className="mb-4 text-sm text-muted-foreground">
        이용자가 미리 알려온 결석을 등록하고 취소합니다.
      </p>

      {!cyclesLoading && (!cycles || cycles.length === 0) && (
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">
            이 운영연도에 등록된 운영구분이 없습니다. 운영설정 &gt; 기본정보 &gt; 출결관리 설정에서
            먼저 운영구분을 만들어 주세요.
          </p>
        </Panel>
      )}

      {activeCycleId && (
        <>
          <FilterBar>
            <div className="flex gap-1">
              {(["예정", "지난"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setPeriod(p);
                    setPickedDate("");
                  }}
                  className={`${chipCls} ${
                    !pickedDate && period === p
                      ? "border-primary text-foreground"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {p === "예정" ? "오늘·예정" : "지난 기록"}
                </button>
              ))}
            </div>
            <input
              type="date"
              aria-label="날짜 선택"
              value={pickedDate}
              min={activeCycle?.startDate}
              max={activeCycle?.endDate}
              onChange={(e) => setPickedDate(e.target.value)}
              className={`${controlCls} w-40 ${pickedDate ? "border-primary" : ""}`}
            />
            <select
              value={program}
              onChange={(e) => setProgram(e.target.value)}
              className={`${controlCls} w-48`}
            >
              <option>전체</option>
              {programOptions.map((p) => (
                <option key={p.programId}>{p.name}</option>
              ))}
            </select>
            <button
              onClick={() => setOpen(true)}
              disabled={programOptions.length === 0}
              className={`${btnPrimaryCls} ml-auto`}
            >
              + 신고결석 등록
            </button>
          </FilterBar>

          {/* 휴대폰(640px 미만)은 표 대신 두 줄 카드: 이용자·프로그램 / 결석일·회차 + [취소].
              태블릿·데스크탑은 아래 표 그대로다. */}
          <Panel className="sm:hidden">
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="font-medium text-foreground">{r.userName}</span>
                      <span className="text-muted-foreground"> · {r.programName}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
                      {formatDate(r.sessionDate)} · {r.sessionNo}회차
                    </p>
                  </div>
                  {canCancel(r) && (
                    <button
                      onClick={() => setPendingCancel(r)}
                      disabled={cancel.isPending}
                      className={`${btnSecondaryCls} min-h-11 shrink-0 px-4`}
                    >
                      취소
                    </button>
                  )}
                </li>
              ))}
              {rows.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <ListState
                    loading={listLoading}
                    error={listError}
                    retrying={listFetching}
                    onRetry={() => refetchList()}
                    empty={emptyMessage}
                  />
                </li>
              )}
            </ul>
          </Panel>

          <Panel className="hidden sm:block">
            {/* 넓은 화면에서 프로그램 열만 늘어나 나머지 열이 오른쪽 끝에 몰리지 않도록
                열 폭을 모두 정하고 남는 폭은 마지막 빈 열이 받는다. 프로그램 열 270px은
                최장 "(비)건강백세운동교실"(약 186px)이 잘리지 않는 폭. */}
            <table className="w-full min-w-[700px] table-fixed text-sm">
              <colgroup>
                <col className="w-[110px]" />
                <col className="w-[270px]" />
                <col className="w-[130px]" />
                <col className="w-[80px]" />
                {showCancelColumn && <col className="w-[90px]" />}
                <col />
              </colgroup>
              <thead>
                <tr className={theadCls}>
                  <th className="px-4 py-2 font-medium">이용자</th>
                  <th className="px-4 py-2 font-medium">프로그램</th>
                  <th className="px-4 py-2 font-medium">결석일</th>
                  <th className="px-4 py-2 font-medium">회차</th>
                  {showCancelColumn && <th className="px-4 py-2 font-medium">취소</th>}
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-medium text-foreground">{r.userName}</td>
                    <td className="truncate px-4 py-2.5 text-foreground" title={r.programName}>
                      {r.programName}
                    </td>
                    <td className="px-4 py-2.5 text-foreground tabular-nums">
                      {formatDate(r.sessionDate)}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.sessionNo}회차</td>
                    {showCancelColumn && (
                      // 버튼이 있어도 글자 행과 높이가 같도록 작은 버튼 + 좁은 위아래 여백.
                      <td className="px-4 py-1.5">
                        {canCancel(r) && (
                          <button
                            onClick={() => setPendingCancel(r)}
                            disabled={cancel.isPending}
                            className={btnRowCls}
                          >
                            {cancel.isPending ? "처리 중…" : "취소"}
                          </button>
                        )}
                      </td>
                    )}
                    <td />
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={cancelColSpan}
                      className="px-4 py-8 text-center text-sm text-muted-foreground"
                    >
                      <ListState
                        loading={listLoading}
                        error={listError}
                        retrying={listFetching}
                        onRetry={() => refetchList()}
                        empty={emptyMessage}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>

          <AlertDialog
            open={pendingCancel !== null}
            onOpenChange={(o) => {
              if (!o) setPendingCancel(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>신고결석을 취소할까요?</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingCancel &&
                    `${pendingCancel.userName} · ${pendingCancel.programName} · ${formatDate(pendingCancel.sessionDate)} ${pendingCancel.sessionNo}회차`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>아니요</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    if (pendingCancel) void cancelOne(pendingCancel);
                    setPendingCancel(null);
                  }}
                >
                  예
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* key: 운영구분이 바뀌면 다이얼로그 내부 선택값(프로그램/이용자/회차)을 초기화 */}
          <RegisterExcusedDialog
            key={activeCycleId}
            open={open}
            onOpenChange={setOpen}
            programs={programOptions}
          />
        </>
      )}
    </StaffLayout>
  );
}

function RegisterExcusedDialog({
  open,
  onOpenChange,
  programs,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  programs: CycleProgramOption[];
}) {
  const [programId, setProgramId] = useState<string | undefined>(undefined);
  const [participantEnrollmentId, setParticipantEnrollmentId] = useState<string | undefined>(
    undefined,
  );
  const [rounds, setRounds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 선택된 운영구분의 운영정보(term)를 그대로 쓴다. 예전에는 프로그램의
  // operation_terms 중 첫 번째(start_date 최신)를 썼기 때문에, 한 프로그램이
  // 여러 운영구분에 걸쳐 있으면 다른 구분의 수강명단/회차가 나올 수 있었다.
  const selected = programs.find((p) => p.programId === programId) ?? programs[0];
  const operationTermId = selected?.operationTermId ?? undefined;
  const { data: upcoming } = useUpcomingSessionsForTerm(operationTermId);
  const { data: roster } = useOperationTermRoster(operationTermId);
  const attending = (roster ?? []).filter((r) => r.active);
  const setExcused = useSetExcusedAbsence();

  const close = () => {
    onOpenChange(false);
    setProgramId(undefined);
    setParticipantEnrollmentId(undefined);
    setRounds([]);
  };

  const submit = async () => {
    if (!participantEnrollmentId || rounds.length === 0) return;
    setSubmitting(true);
    // 회차를 한 건씩 등록한다 -- 중간에 실패해도 앞 회차는 이미 등록된 상태라
    // "등록 실패"만 띄우면 몇 건이 됐는지 알 수 없다. 건수와 첫 실패 사유를 함께 알린다.
    let done = 0;
    const failures: string[] = [];
    try {
      for (const sessionId of rounds) {
        try {
          await setExcused.mutateAsync({ sessionId, enrollmentId: participantEnrollmentId });
          done += 1;
        } catch (e) {
          failures.push(errorReason(e));
        }
      }
      if (failures.length === 0) {
        toast.success(`신고결석 ${done}건을 등록했습니다.`);
        close();
      } else {
        toast.error(
          `${done}건 등록, ${failures.length}건 실패했습니다. ${failures[0] ?? ""}`.trim(),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>신고결석 등록</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <label className="grid gap-1">
            <span className="text-muted-foreground">프로그램</span>
            <select
              value={selected?.programId}
              onChange={(e) => {
                setProgramId(e.target.value);
                setParticipantEnrollmentId(undefined);
                setRounds([]);
              }}
              className={controlCls}
            >
              {programs.map((p) => (
                <option key={p.programId} value={p.programId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">이용자 (수강중)</span>
            <select
              value={participantEnrollmentId}
              onChange={(e) => setParticipantEnrollmentId(e.target.value)}
              className={controlCls}
            >
              <option value="">선택</option>
              {attending.map((r) => (
                <option key={r.enrollmentId} value={r.enrollmentId}>
                  {r.name} ({r.memberCode})
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-1">
            <span className="text-muted-foreground">예정 회차 (복수 선택)</span>
            <div className="max-h-56 overflow-y-auto rounded border border-border">
              {(upcoming ?? []).length === 0 && (
                <p className="px-3 py-3 text-xs text-muted-foreground">예정 회차가 없습니다.</p>
              )}
              {upcoming?.map((s) => (
                <label
                  key={s.sessionId}
                  className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-0"
                >
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={rounds.includes(s.sessionId)}
                    onChange={(e) =>
                      setRounds((prev) =>
                        e.target.checked
                          ? [...prev, s.sessionId]
                          : prev.filter((x) => x !== s.sessionId),
                      )
                    }
                  />
                  <span className="text-foreground">{s.sessionNo}회차</span>
                  <span className="text-muted-foreground">
                    {formatDate(s.startsAt)} {formatTime(s.startsAt)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <button onClick={close} className={btnSecondaryCls}>
            닫기
          </button>
          <button
            onClick={submit}
            disabled={!participantEnrollmentId || rounds.length === 0 || submitting}
            className={btnPrimaryCls}
          >
            등록
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
