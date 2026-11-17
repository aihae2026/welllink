import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  StaffLayout,
  Panel,
  btnPrimaryCls,
  btnSecondaryCls,
  btnRowCls,
  chipCls,
  controlCls,
  theadCls,
} from "@/components/layout/StaffLayout";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SessionStatusBadge, StatusBadge } from "@/components/ui/status-badge";
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
import {
  BlockedActionDialog,
  type BlockedAction,
} from "@/components/attendance/BlockedActionDialog";
import { AddStudentsDialog } from "@/components/attendance/AddStudentsDialog";
import { InitialRosterDialog } from "@/components/attendance/InitialRosterDialog";
import {
  useProgramDetail,
  useOperationTerms,
  useOperationTermRoster,
  useOperationTermSessions,
  useTerminateEnrollments,
  useAddEnrollments,
  useUpsertOperationTermForCycle,
  useCancelSession,
  useDeleteSession,
  useUncancelSession,
  useAddSession,
  useUpdateSession,
  useUpdateEnrollmentEndDate,
} from "@/lib/programs-data";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useInstructorAccounts } from "@/lib/user-management-data";
import { sessionStatusLabel } from "@/lib/attendance-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";
import { formatDate, formatTime } from "@/lib/format";

// 종결·재등록은 서버에서 "아직 시작하지 않은 회차"를 기준으로 적용된다
// (terminate_enrollments / add_enrollments: starts_at > now()).
const TERMINATE_NOTICE =
  "아직 시작하지 않은 회차부터 출석 대상에서 제외됩니다. 지난 출석 기록은 그대로 남습니다.";

type PendingConfirm = {
  title: string;
  description: string;
  actionLabel: string;
  run: () => void;
} | null;

const WEEKDAY_OPTIONS = [
  { v: 1, label: "월" },
  { v: 2, label: "화" },
  { v: 3, label: "수" },
  { v: 4, label: "목" },
  { v: 5, label: "금" },
  { v: 6, label: "토" },
  { v: 7, label: "일" },
];

function shortCycleLabel(name: string) {
  return name.replace(/^\d{4}년\s*/, "");
}

export const Route = createFileRoute("/attendance/programs/$programId")({
  validateSearch: (search: Record<string, unknown>) => ({
    cycleId: typeof search["cycleId"] === "string" ? search["cycleId"] : undefined,
    // 목록으로 돌아갈 때 그대로 넘겨 주려고 들고만 있는 값(이 화면에서는 쓰지 않는다).
    yearId: typeof search["yearId"] === "string" ? search["yearId"] : undefined,
    missing: search["missing"] === "1" ? ("1" as const) : undefined,
    // Attendance E2E Manual QA Gap Fix §1-2: 출석 입력/정정 저장 후
    // "회차 및 출석현황" 탭으로 정확히 복귀하기 위한 진입 탭 지정.
    tab: typeof search["tab"] === "string" ? search["tab"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "프로그램 상세 — WellLink" },
      {
        name: "description",
        content:
          "프로그램의 기본설정, 수강대상, 회차 및 출석현황을 탭으로 확인하는 상세 화면입니다.",
      },
      { property: "og:title", content: "프로그램 상세 — WellLink" },
      { property: "og:description", content: "기본설정 · 수강대상 · 회차 및 출석현황." },
    ],
  }),
  component: ProgramDetailPage,
});

const TABS = ["기본설정", "수강대상", "회차 및 출석현황"] as const;

// 날짜 칸(YYYY-MM-DD)은 기기(한국) 시간 기준이어야 한다. toISOString()은 표준시라
// 오전 9시 전에 시작하는 회차가 전날 날짜로 채워졌다.
function localDateIso(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function ProgramDetailPage() {
  const { programId } = Route.useParams();
  const { cycleId, tab: tabParam, yearId: yearSearch, missing: missingSearch } = Route.useSearch();
  // 목록으로 돌아갈 때 보던 조건을 그대로 돌려준다.
  const backToPrograms = {
    label: "프로그램 설정",
    to: "/attendance/programs",
    search: { yearId: yearSearch, cycleId, missing: missingSearch },
  } as const;
  const navigate = useNavigate();
  const { data: program, isLoading: programLoading } = useProgramDetail(programId);
  const { data: terms, isLoading: termsLoading } = useOperationTerms(programId);
  const [tab, setTab] = useState<(typeof TABS)[number]>(
    (TABS as readonly string[]).includes(tabParam ?? "")
      ? (tabParam as (typeof TABS)[number])
      : "기본설정",
  );
  const [selectedTermId, setSelectedTermId] = useState<string | undefined>(undefined);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [rosterFilter, setRosterFilter] = useState<"수강중" | "종결" | "전체">("수강중");
  const [selected, setSelected] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<BlockedAction>(null);
  // 브라우저 기본 confirm 대신 신고결석 취소와 같은 앱 확인창을 쓴다.
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);

  // Program Settings Final Design Lock §19/§35: cycleId에 해당하는 term이
  // 없으면(이 운영구분에는 아직 기본설정이 없는 경우) 절대 다른 운영구분의
  // term으로 fallback하지 않는다 -- "아직 기본설정이 없다"는 사실 그대로
  // 보여줘야 한다. cycleId 없이 직접 URL로 들어온 경우에만 가장 최근 term으로
  // fallback한다(기존 동작 유지).
  useEffect(() => {
    if (selectedTermId || !terms) return;
    if (!cycleId) {
      if (terms[0]) setSelectedTermId(terms[0].id);
      return;
    }
    const matched = terms.find((t) => t.operationCycleId === cycleId);
    if (matched) setSelectedTermId(matched.id);
  }, [terms, selectedTermId, cycleId]);

  const currentTerm = terms?.find((t) => t.id === selectedTermId);
  // §36: 이 운영구분에 아직 기본설정이 없을 때, 다른 운영구분의 가장 최근
  // term을 "표시"하지는 않되 새 기본설정 Form의 초기값(prefill)으로는 쓴다.
  const otherCycleTerm = !currentTerm ? terms?.[0] : undefined;
  const { data: roster } = useOperationTermRoster(currentTerm?.id);
  const { data: sessions } = useOperationTermSessions(currentTerm?.id);
  const terminate = useTerminateEnrollments(currentTerm?.id ?? "");
  const addEnrollments = useAddEnrollments(currentTerm?.id ?? "");
  const updateEndDate = useUpdateEnrollmentEndDate();
  const [editEndDateFor, setEditEndDateFor] = useState<{
    enrollmentId: string;
    date: string;
  } | null>(null);
  const cancelSession = useCancelSession();
  const deleteSession = useDeleteSession();
  const uncancelSession = useUncancelSession();
  const addSession = useAddSession();
  const updateSession = useUpdateSession();

  async function runTerminate(enrollmentIds: string[], successMessage: string) {
    try {
      await terminate.mutateAsync(enrollmentIds);
      toast.success(successMessage);
      setSelected((prev) => prev.filter((id) => !enrollmentIds.includes(id)));
    } catch (e: any) {
      setBlocked({ title: "종결 처리할 수 없습니다.", reason: errorReason(e) });
    }
  }

  function terminateOne(enrollmentId: string) {
    setPendingConfirm({
      title: "이 수강생을 종결 처리할까요?",
      description: TERMINATE_NOTICE,
      actionLabel: "종결",
      run: () => void runTerminate([enrollmentId], "종결 처리했습니다."),
    });
  }

  function reenrollOne(r: { memberCode: string; name: string }) {
    if (!currentTerm) return;
    setPendingConfirm({
      title: `"${r.name}"님을 다시 등록할까요?`,
      description: "아직 시작하지 않은 다음 회차부터 출석 대상에 포함됩니다.",
      actionLabel: "재등록",
      run: () => void runReenroll(r),
    });
  }

  async function runReenroll(r: { memberCode: string; name: string }) {
    try {
      await addEnrollments.mutateAsync([{ member_code: r.memberCode, name: r.name }]);
      toast.success("재등록했습니다.");
    } catch (e: any) {
      // Program Settings Final Design Lock §34/§52: 활성 Enrollment 중복 시
      // 정확히 이 문구로 안내한다.
      const reason = e.message.includes("이미 이 운영차수에 수강 중")
        ? "현재 이 프로그램을 이미 수강 중입니다."
        : errorReason(e);
      setBlocked({ title: "재등록할 수 없습니다.", reason });
    }
  }

  // §11: 종결일 수정. 종결 처리일시(ended_at, audit)는 절대 건드리지 않는다 --
  // 서버 RPC가 이미 그 값을 그대로 두고 ended_effective_date만 바꾼다.
  async function submitEndDate(date: string) {
    if (!currentTerm || !editEndDateFor) return;
    try {
      await updateEndDate.mutateAsync({
        enrollmentId: editEndDateFor.enrollmentId,
        operationTermId: currentTerm.id,
        endDate: date,
      });
      toast.success("종결일을 수정했습니다.");
      setEditEndDateFor(null);
    } catch (e: any) {
      setBlocked({ title: "종결일을 수정할 수 없습니다.", reason: errorReason(e) });
      setEditEndDateFor(null);
    }
  }

  // §39-41: 상태 Badge를 직접 클릭해서 휴강/휴강취소를 처리한다. 별도 Confirm
  // 없이 즉시 처리하고, 서버가 차단하면 안내 Popup으로 보여준다. 차단 사유는
  // 서버 RPC가 이미 §52 취지에 맞는 친절한 한국어 문구로 던지므로 그대로
  // 보여준다 -- 클라이언트에서 원인을 임의로 고정된 문구로 대체하면(예:
  // 항상 "이미 출석/실적 확정") 실제로는 다른 이유(예: 상태가 이미 바뀐 뒤의
  // 중복 클릭)로 차단된 경우에도 잘못된 사유를 보여주게 된다.
  async function toggleSessionStatus(s: { id: string; status: string }) {
    if (!currentTerm) return;
    try {
      if (s.status === "cancelled") {
        await uncancelSession.mutateAsync({ sessionId: s.id, operationTermId: currentTerm.id });
        toast.success("휴강을 취소했습니다.");
      } else {
        await cancelSession.mutateAsync({ sessionId: s.id, operationTermId: currentTerm.id });
        toast.success("휴강 처리했습니다.");
      }
    } catch (e: any) {
      setBlocked({ title: "회차 상태를 변경할 수 없습니다.", reason: errorReason(e) });
    }
  }

  // 누락 회차는 배지를 누르면 출석 입력으로 가므로(위 §39-41 주석 참고) 휴강
  // 진입점을 [⋯] 메뉴에 따로 둔다. 이미 지나간 회차를 집계에서 빼는 일이라
  // 예정 회차 휴강과 달리 확인창을 한 번 거친다.
  function cancelMissingSession(sessionId: string) {
    if (!currentTerm) return;
    setPendingConfirm({
      title: "이 회차를 휴강으로 바꿀까요?",
      description:
        "이미 마감된 누락 회차입니다. 휴강으로 바꾸면 출석·결석 및 실적 집계에서 빠집니다. 휴강 상태를 다시 누르면 취소할 수 있습니다.",
      actionLabel: "휴강 처리",
      run: () => void toggleSessionStatus({ id: sessionId, status: "missing" }),
    });
  }

  function deleteOneSession(sessionId: string) {
    if (!currentTerm) return;
    const operationTermId = currentTerm.id;
    setPendingConfirm({
      title: "이 회차를 삭제할까요?",
      description: "삭제한 회차는 되돌릴 수 없습니다.",
      actionLabel: "삭제",
      run: () => void runDeleteSession(sessionId, operationTermId),
    });
  }

  async function runDeleteSession(sessionId: string, operationTermId: string) {
    try {
      await deleteSession.mutateAsync({ sessionId, operationTermId });
      toast.success("회차를 삭제했습니다.");
    } catch (e: any) {
      setBlocked({ title: "회차를 삭제할 수 없습니다.", reason: errorReason(e) });
    }
  }

  const { data: instructors } = useInstructorAccounts();
  const upsertTerm = useUpsertOperationTermForCycle();
  const [editingTerm, setEditingTerm] = useState(false);
  const [termScheduleMode, setTermScheduleMode] = useState<"weekly" | "custom_dates">("weekly");
  const [termWeekdays, setTermWeekdays] = useState<number[]>([]);
  const [termDates, setTermDates] = useState<string[]>([]);
  const [newDate, setNewDate] = useState("");
  const [termStart, setTermStart] = useState("");
  const [termEnd, setTermEnd] = useState("");
  const [termInstructor, setTermInstructor] = useState("");
  const [termInstructorText, setTermInstructorText] = useState("");

  const nameCounts = new Map<string, number>();
  for (const i of instructors ?? []) nameCounts.set(i.name, (nameCounts.get(i.name) ?? 0) + 1);
  const instructorOptionLabel = (i: { name: string; phoneLast4: string }) =>
    (nameCounts.get(i.name) ?? 0) > 1 ? `${i.name} (${i.phoneLast4})` : i.name;

  function startEditTerm() {
    // §36: 현재 운영구분에 term이 아직 없으면 다른 운영구분의 가장 최근
    // 기본설정을 초기값으로만 채운다(자동 저장/회차 복사는 아니다).
    const source = currentTerm ?? otherCycleTerm;
    setTermScheduleMode(source?.scheduleMode === "custom_dates" ? "custom_dates" : "weekly");
    setTermWeekdays(source?.weekdays ?? []);
    setTermDates(
      currentTerm
        ? (sessions ?? []).map((s: any) => localDateIso(new Date(s.starts_at)))
        : [],
    );
    setNewDate("");
    setTermStart(source?.startTime?.slice(0, 5) ?? "");
    setTermEnd(source?.endTime?.slice(0, 5) ?? "");
    setTermInstructor(source?.instructorPrincipalId ?? "");
    setTermInstructorText(source?.instructorPrincipalId ? "" : (source?.instructorNameText ?? ""));
    setEditingTerm(true);
  }

  async function saveTermSchedule() {
    const operationCycleId = currentTerm?.operationCycleId ?? cycleId;
    if (!operationCycleId || !termStart || !termEnd) {
      toast.error("시작/종료시간을 입력해 주세요.");
      return;
    }
    if (termScheduleMode === "weekly" && termWeekdays.length === 0) {
      toast.error("요일을 1개 이상 선택해 주세요.");
      return;
    }
    if (termScheduleMode === "custom_dates" && termDates.length === 0) {
      toast.error("직접 회차 지정은 날짜를 1개 이상 선택해야 합니다.");
      return;
    }
    try {
      await upsertTerm.mutateAsync({
        operationCycleId,
        programId,
        weekdays: termScheduleMode === "weekly" ? [...termWeekdays].sort((a, b) => a - b) : [],
        startTime: termStart,
        endTime: termEnd,
        instructorPrincipalId: termInstructor || null,
        instructorNameText: termInstructor ? null : termInstructorText || null,
        scheduleMode: termScheduleMode,
        explicitDates: termScheduleMode === "custom_dates" ? [...termDates].sort() : undefined,
      });
      toast.success("기본설정을 저장했습니다.");
      setEditingTerm(false);
    } catch (e: any) {
      toast.error(`저장 실패: ${errorReason(e)}`);
    }
  }

  const rosterRows = (roster ?? []).filter((r) => {
    if (rosterFilter === "전체") return true;
    return rosterFilter === "수강중" ? r.active : !r.active;
  });

  const endSelected = () => {
    const ids = [...selected];
    setPendingConfirm({
      title: `선택한 ${ids.length}명을 종결 처리할까요?`,
      description: TERMINATE_NOTICE,
      actionLabel: "종결",
      run: () => void runTerminate(ids, "선택한 수강생을 종결 처리했습니다."),
    });
  };

  if (programLoading) {
    return (
      <StaffLayout
        title="프로그램 상세"
        back={backToPrograms}
      >
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        </Panel>
      </StaffLayout>
    );
  }

  if (!program) {
    return (
      <StaffLayout
        title="프로그램 상세"
        back={backToPrograms}
      >
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">해당 프로그램을 찾을 수 없습니다.</p>
        </Panel>
      </StaffLayout>
    );
  }

  // §18: 페이지 상단에 프로그램명 + "운영구분 · 운영기간"을 보여준다.
  const headerCycleLabel = currentTerm
    ? shortCycleLabel(currentTerm.name)
    : (terms?.find((t) => t.operationCycleId === cycleId)?.name ?? "");
  const headerPeriod = currentTerm
    ? `${shortCycleLabel(currentTerm.name)} ${currentTerm.startDate} ~ ${currentTerm.endDate}`
    : "";

  // 탭을 옮겨도 늘 보이는 요약 줄: 일정 · 강사 · 수강 인원 · 누락 회차 수.
  const summaryInstructor = currentTerm
    ? currentTerm.instructorPrincipalId
      ? (instructors?.find((i) => i.principalId === currentTerm.instructorPrincipalId)?.name ??
        "등록 강사")
      : currentTerm.instructorNameText
        ? `${currentTerm.instructorNameText} [계정 없음]`
        : "강사 미배정"
    : "";
  const summarySchedule = currentTerm
    ? `${
        currentTerm.scheduleMode === "custom_dates"
          ? "직접 회차 지정"
          : currentTerm.weekdays.map((w) => WEEKDAY_OPTIONS[w - 1]?.label).join("·")
      } ${currentTerm.startTime?.slice(0, 5) ?? ""}~${currentTerm.endTime?.slice(0, 5) ?? ""}`
    : "";
  const activeCount = roster ? roster.filter((r) => r.active).length : null;
  const missingCount = sessions ? sessions.filter((s: { status: string }) => s.status === "missing").length : null;

  return (
    <StaffLayout
      title={program.name}
      back={backToPrograms}
    >
      {currentTerm && (
        <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span className="tabular-nums">{headerPeriod}</span>
          <span aria-hidden>·</span>
          <span className="text-foreground">{summarySchedule}</span>
          <span aria-hidden>·</span>
          <span>{summaryInstructor}</span>
          <span aria-hidden>·</span>
          <span>수강 {activeCount ?? "-"}명</span>
          <span aria-hidden>·</span>
          <span className={missingCount ? "font-medium text-status-danger-fg" : ""}>
            누락 {missingCount ?? "-"}회
          </span>
        </p>
      )}
      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              // 주소에 탭을 남겨, 회차 화면에서 브라우저 뒤로가기를 눌러도 이 탭으로 돌아온다.
              navigate({
                to: "/attendance/programs/$programId",
                params: { programId },
                search: { cycleId, tab: t, yearId: yearSearch, missing: missingSearch },
                replace: true,
              });
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "기본설정" && (
        <Panel className="p-5">
          {/* §20: Info icon + hover 설명. 운영구분명은 동적으로 반영한다. */}
          <div className="mb-4 flex items-center gap-1.5">
            <h2 className="text-sm font-medium text-foreground">프로그램 기본설정</h2>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex size-[18px] cursor-help items-center justify-center rounded-full border border-muted-foreground/40 text-xs text-muted-foreground">
                    i
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  현재 선택한 운영구분({headerCycleLabel || "미선택"})에서 이 프로그램의 일정과
                  강사를 설정합니다.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {currentTerm && !editingTerm && (
              <button className={`${btnSecondaryCls} ml-auto`} onClick={startEditTerm}>
                기본설정 수정
              </button>
            )}
          </div>

          {currentTerm ? (
            <dl className="grid gap-x-10 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">운영기간</dt>
                <dd className="text-foreground tabular-nums">
                  {currentTerm.startDate} ~ {currentTerm.endDate}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">일정 방식</dt>
                <dd className="text-foreground">
                  {currentTerm.scheduleMode === "custom_dates"
                    ? "직접 회차 지정"
                    : `정기 반복 · ${currentTerm.weekdays.map((w) => WEEKDAY_OPTIONS[w - 1]?.label).join("·")}`}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">수업 시간</dt>
                <dd className="text-foreground tabular-nums">
                  {currentTerm.startTime?.slice(0, 5)}~{currentTerm.endTime?.slice(0, 5)}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">강사</dt>
                <dd className="text-foreground">
                  {currentTerm.instructorPrincipalId
                    ? (instructors?.find((i) => i.principalId === currentTerm.instructorPrincipalId)
                        ?.name ?? "등록 강사")
                    : currentTerm.instructorNameText
                      ? (
                        <>
                          {currentTerm.instructorNameText}{" "}
                          <span className="text-xs text-muted-foreground">[계정 없음]</span>
                        </>
                      )
                      : "미배정"}
                </dd>
              </div>
            </dl>
          ) : (
            !termsLoading &&
            cycleId &&
            !editingTerm && (
              <div className="rounded border border-dashed border-border p-4">
                <p className="mb-3 text-sm text-muted-foreground">
                  이 운영구분에는 아직 기본설정이 없습니다. 일정과 강사를 등록하면 회차가 자동
                  생성됩니다.
                </p>
                <button onClick={startEditTerm} className={btnPrimaryCls}>
                  기본설정 등록
                </button>
              </div>
            )
          )}

          {editingTerm && (
            <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
              <div className="flex gap-1">
                {(
                  [
                    { v: "weekly", label: "정기 반복" },
                    { v: "custom_dates", label: "직접 회차 지정" },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.v}
                    type="button"
                    className={`${chipCls} ${
                      termScheduleMode === m.v
                        ? "border-primary text-foreground"
                        : "border-border text-muted-foreground"
                    }`}
                    onClick={() => setTermScheduleMode(m.v)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              {termScheduleMode === "weekly" ? (
                <div className="flex gap-1">
                  {WEEKDAY_OPTIONS.map((w) => (
                    <button
                      key={w.v}
                      type="button"
                      className={`size-8 rounded border text-xs ${
                        termWeekdays.includes(w.v)
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground"
                      }`}
                      onClick={() =>
                        setTermWeekdays((prev) =>
                          prev.includes(w.v) ? prev.filter((d) => d !== w.v) : [...prev, w.v],
                        )
                      }
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      className={controlCls}
                      min={currentTerm?.startDate}
                      max={currentTerm?.endDate}
                      value={newDate}
                      onChange={(e) => setNewDate(e.target.value)}
                    />
                    <button
                      type="button"
                      className={btnSecondaryCls}
                      disabled={!newDate}
                      onClick={() => {
                        if (newDate && !termDates.includes(newDate)) {
                          setTermDates((prev) => [...prev, newDate].sort());
                        }
                        setNewDate("");
                      }}
                    >
                      날짜 추가
                    </button>
                  </div>
                  {termDates.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {termDates.map((d) => (
                        <li
                          key={d}
                          className="flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-1 text-xs"
                        >
                          {d}
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => setTermDates((prev) => prev.filter((x) => x !== d))}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[13px] text-muted-foreground">
                    회차 일정 확인: {termDates.length}개 날짜에 회차가 생성됩니다.
                  </p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="time"
                  className={controlCls}
                  value={termStart}
                  onChange={(e) => setTermStart(e.target.value)}
                />
                <span className="text-muted-foreground">~</span>
                <input
                  type="time"
                  className={controlCls}
                  value={termEnd}
                  onChange={(e) => setTermEnd(e.target.value)}
                />
                <select
                  className={controlCls}
                  value={termInstructor}
                  onChange={(e) => {
                    setTermInstructor(e.target.value);
                    if (e.target.value) setTermInstructorText("");
                  }}
                >
                  <option value="">등록 강사에서 선택</option>
                  {instructors?.map((i) => (
                    <option key={i.principalId} value={i.principalId}>
                      {instructorOptionLabel(i)}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">또는</span>
                <input
                  className={controlCls}
                  placeholder="강사명 직접입력(미등록)"
                  value={termInstructorText}
                  onChange={(e) => {
                    setTermInstructorText(e.target.value);
                    if (e.target.value) setTermInstructor("");
                  }}
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  className={btnPrimaryCls}
                  disabled={upsertTerm.isPending}
                  onClick={saveTermSchedule}
                >
                  기본설정 저장
                </button>
                <button className={btnSecondaryCls} onClick={() => setEditingTerm(false)}>
                  취소
                </button>
              </div>
              {/* §27-28: 기본설정 변경이 기존 회차를 자동으로 바꾸지 않는다는
                  Design Lock 안내. */}
              <p className="text-[13px] text-muted-foreground">
                기본설정을 변경해도 이미 생성된 회차는 자동으로 변경되지 않습니다. 회차 변경은 '회차
                및 출석현황'에서 관리하세요.
              </p>
              <p className="text-[13px] text-muted-foreground">
                강사가 목록에 없나요? 운영설정 &gt; 사용자 관리 &gt; 강사에서 먼저 등록한 뒤 여기서
                연결해 주세요.
              </p>
            </div>
          )}

          {!termsLoading && !cycleId && !currentTerm && (
            <div className="mt-4 border-t border-border pt-4">
              <p className="mb-2 text-sm text-muted-foreground">
                운영구분 정보를 확인할 수 없습니다. 프로그램 설정에서 다시 들어와 주세요.
              </p>
              <button
                onClick={() => navigate({ to: "/attendance/programs" })}
                className={btnSecondaryCls}
              >
                프로그램 설정으로 돌아가기
              </button>
            </div>
          )}
        </Panel>
      )}

      {tab === "수강대상" && (
        <>
          {!currentTerm ? (
            <Panel className="p-6">
              <p className="text-sm text-muted-foreground">
                기본설정이 없어 수강명단을 표시할 수 없습니다. 기본설정 탭에서 먼저 일정을 등록해
                주세요.
              </p>
            </Panel>
          ) : !currentTerm.initialRosterAppliedAt ? (
            <Panel className="p-6">
              <p className="mb-3 text-sm text-muted-foreground">
                이 운영구분은 아직 최초 수강명단이 등록되지 않았습니다.
              </p>
              <button onClick={() => setRosterOpen(true)} className={btnPrimaryCls}>
                수강명단 붙여넣기
              </button>
            </Panel>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="flex gap-1">
                  {(["수강중", "종결", "전체"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setRosterFilter(f)}
                      className={`${chipCls} ${
                        rosterFilter === f
                          ? "border-primary text-foreground"
                          : "border-border text-muted-foreground"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                {selected.length > 0 && (
                  <button
                    onClick={endSelected}
                    disabled={terminate.isPending}
                    className="rounded border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {terminate.isPending ? "처리 중…" : `선택 종결 (${selected.length})`}
                  </button>
                )}
                <div className="ml-auto flex gap-2">
                  <button onClick={() => setAddOpen(true)} className={btnPrimaryCls}>
                    + 수강생 추가
                  </button>
                </div>
              </div>
              <Panel>
                <table className="w-full min-w-[720px] table-fixed text-sm">
                  <colgroup>
                    <col className="w-10" />
                    <col className="w-36" />
                    <col className="w-28" />
                    <col className="w-24" />
                    <col className="w-28" />
                    <col className="w-32" />
                  </colgroup>
                  <thead>
                    <tr className={theadCls}>
                      <th className="px-4 py-2"></th>
                      <th className="px-4 py-2 font-medium">회원번호</th>
                      <th className="px-4 py-2 font-medium">성명</th>
                      <th className="px-4 py-2 font-medium">상태</th>
                      <th className="px-4 py-2 font-medium">종결일</th>
                      <th className="px-4 py-2 font-medium">관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rosterRows.map((r) => (
                      <tr key={r.enrollmentId} className="border-b border-border last:border-0">
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            className="size-4"
                            disabled={!r.active}
                            checked={selected.includes(r.enrollmentId)}
                            onChange={(e) =>
                              setSelected((prev) =>
                                e.target.checked
                                  ? [...prev, r.enrollmentId]
                                  : prev.filter((id) => id !== r.enrollmentId),
                              )
                            }
                          />
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{r.memberCode}</td>
                        <td className="px-4 py-2.5 text-foreground">{r.name}</td>
                        <td className="px-4 py-2.5">
                          <StatusBadge
                            label={r.active ? "수강중" : "종결"}
                            tone={r.active ? "info" : "neutral"}
                          />
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {/* §9: 내부 audit timestamp가 아니라 날짜 단위로만 보여준다. */}
                          {r.endedEffectiveDate ?? "-"}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.active ? (
                            <button
                              onClick={() => terminateOne(r.enrollmentId)}
                              disabled={terminate.isPending}
                              className={btnRowCls}
                            >
                              종결
                            </button>
                          ) : (
                            <div className="flex gap-1.5">
                              <button
                                onClick={() =>
                                  setEditEndDateFor({
                                    enrollmentId: r.enrollmentId,
                                    date: r.endedEffectiveDate ?? "",
                                  })
                                }
                                className={btnRowCls}
                              >
                                종결일 수정
                              </button>
                              <button
                                onClick={() =>
                                  reenrollOne({ memberCode: r.memberCode, name: r.name })
                                }
                                disabled={addEnrollments.isPending}
                                className={btnRowCls}
                              >
                                재등록
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {rosterRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                          해당하는 수강생이 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Panel>
              <AddStudentsDialog
                open={addOpen}
                onOpenChange={setAddOpen}
                operationTermId={currentTerm.id}
              />
              <EndDateFormDialog
                open={!!editEndDateFor}
                onOpenChange={(v) => !v && setEditEndDateFor(null)}
                initialDate={editEndDateFor?.date ?? ""}
                minDate={currentTerm.startDate}
                maxDate={currentTerm.endDate}
                submitting={updateEndDate.isPending}
                onSubmit={submitEndDate}
              />
            </>
          )}
        </>
      )}

      {tab === "회차 및 출석현황" && (
        <SessionsTab
          currentTerm={currentTerm}
          sessions={sessions ?? []}
          navigate={navigate}
          toggleSessionStatus={toggleSessionStatus}
          cancelMissingSession={cancelMissingSession}
          deleteOneSession={deleteOneSession}
          addSession={addSession}
          updateSession={updateSession}
          setBlocked={setBlocked}
        />
      )}

      {currentTerm && (
        <InitialRosterDialog
          open={rosterOpen}
          onOpenChange={setRosterOpen}
          operationTermId={currentTerm.id}
        />
      )}

      <AlertDialog
        open={pendingConfirm !== null}
        onOpenChange={(o) => {
          if (!o) setPendingConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingConfirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pendingConfirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                pendingConfirm?.run();
                setPendingConfirm(null);
              }}
            >
              {pendingConfirm?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BlockedActionDialog state={blocked} onClose={() => setBlocked(null)} />
    </StaffLayout>
  );
}

// §37-51: 회차 및 출석현황. 실제 생성된 Session을 관리하는 실제 운영영역이다.
function SessionsTab({
  currentTerm,
  sessions,
  navigate,
  toggleSessionStatus,
  cancelMissingSession,
  deleteOneSession,
  addSession,
  updateSession,
  setBlocked,
}: {
  currentTerm: { id: string; startDate: string; endDate: string } | undefined;
  sessions: any[];
  navigate: ReturnType<typeof useNavigate>;
  toggleSessionStatus: (s: { id: string; status: string }) => void;
  cancelMissingSession: (sessionId: string) => void;
  deleteOneSession: (sessionId: string) => void;
  addSession: ReturnType<typeof useAddSession>;
  updateSession: ReturnType<typeof useUpdateSession>;
  setBlocked: (b: BlockedAction) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [editSession, setEditSession] = useState<{
    id: string;
    date: string;
    start: string;
    end: string;
  } | null>(null);

  async function submitAdd(date: string, start: string, end: string) {
    if (!currentTerm) return;
    try {
      await addSession.mutateAsync({
        operationTermId: currentTerm.id,
        date,
        startTime: start,
        endTime: end,
      });
      toast.success("회차를 추가했습니다.");
      setAddOpen(false);
    } catch (e: any) {
      toast.error(`추가 실패: ${errorReason(e)}`);
    }
  }

  async function submitEdit(date: string, start: string, end: string) {
    if (!currentTerm || !editSession) return;
    try {
      await updateSession.mutateAsync({
        sessionId: editSession.id,
        operationTermId: currentTerm.id,
        date,
        startTime: start,
        endTime: end,
      });
      toast.success("회차를 수정했습니다.");
      setEditSession(null);
    } catch (e: any) {
      setBlocked({ title: "회차를 수정할 수 없습니다.", reason: errorReason(e) });
      setEditSession(null);
    }
  }

  if (!currentTerm) {
    return (
      <Panel>
        <p className="p-6 text-sm text-muted-foreground">기본설정이 없어 회차가 없습니다.</p>
      </Panel>
    );
  }

  return (
    <>
      {/* §37/§53: 안내문을 이 탭 상단에 항상 그대로 노출한다. */}
      <p className="mb-3 rounded border border-border bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground">
        휴강 회차는 출석·결석 및 실적 집계에서 제외됩니다. 상태를 다시 누르면 휴강을 취소할 수
        있습니다.
      </p>
      <div className="mb-3 flex justify-end">
        <button onClick={() => setAddOpen(true)} className={btnPrimaryCls}>
          + 회차 추가
        </button>
      </div>
      <Panel>
        <table className="w-full min-w-[820px] table-fixed text-sm">
          <colgroup>
            <col className="w-16" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-16" />
            <col className="w-24" />
            <col className="w-14" />
          </colgroup>
          <thead>
            <tr className={theadCls}>
              <th className="px-4 py-2 font-medium">회차</th>
              <th className="px-4 py-2 font-medium">일자</th>
              <th className="px-4 py-2 font-medium">시간</th>
              <th className="px-4 py-2 font-medium">상태</th>
              <th className="px-4 py-2 font-medium">수강인원</th>
              <th className="px-4 py-2 font-medium">출석</th>
              <th className="px-4 py-2 font-medium">결석 합계(신고)</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s: any) => {
              const starts = new Date(s.starts_at);
              const ends = new Date(s.ends_at);
              const statusLabel = sessionStatusLabel(s.status, s.hasSubmission);
              // 강사 입력이 이미 들어온 예정 회차("입력중")는 휴강할 수 없다(서버도 막는다).
              // 그래서 휴강 처리 대상에서 빼고, 대신 그 회차 출석기록을 열어 준다.
              const inProgress = s.status === "scheduled" && s.hasSubmission;
              const clickable =
                (s.status === "scheduled" && !inProgress) ||
                s.status === "missing" ||
                s.status === "cancelled" ||
                inProgress;
              // 누락 배지는 누르면 곧바로 휴강 처리돼 [출석 입력] 옆에서 잘못 누르기 쉬웠다.
              // 휴강 처리는 예정 회차에서만, 누락은 그 회차 출석 입력으로 보낸다.
              const tooltip = inProgress
                ? "클릭하여 출석기록 보기"
                : s.status === "cancelled"
                  ? "클릭하여 휴강 취소"
                  : s.status === "completed"
                    ? undefined
                    : s.status === "missing"
                      ? "클릭하여 출석 입력"
                      : "클릭하여 휴강 처리";
              const dateStr = localDateIso(starts);
              const startStr = starts.toTimeString().slice(0, 5);
              const endStr = ends.toTimeString().slice(0, 5);
              // §11-14/§46: 회차 수정/삭제는 상태가 아니라 dependency
              // 기준이다 -- 예정/누락/휴강이고 강사 출석 제출본이 없으면
              // 가능하다(완료는 final_attendance가 항상 있어 서버가 어차피
              // 막으므로 메뉴에 넣지 않는다).
              const canEditOrDelete =
                (s.status === "scheduled" || s.status === "missing" || s.status === "cancelled") &&
                !s.hasSubmission;
              return (
                <tr key={s.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 text-foreground">{s.session_no}회차</td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {formatDate(starts)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                    {formatTime(starts)}~{formatTime(ends)}
                  </td>
                  <td className="px-4 py-2.5">
                    {/* 상태 배지(완료·정정됨·누락 등)는 한 묶음으로 8px 간격. 누락 배지를
                        누르면 그 회차 출석 입력으로 간다(별도 [출석 입력] 버튼은 두지 않는다). */}
                    <div className="flex items-center gap-2">
                      {clickable ? (
                        <button
                          onClick={() =>
                            s.status === "missing" || inProgress
                              ? navigate({
                                  to: "/attendance/sessions/$sessionId",
                                  params: { sessionId: s.id },
                                })
                              : toggleSessionStatus(s)
                          }
                          title={tooltip}
                          // 누를 수 있는 배지: 마우스를 올리거나 키보드로 고르면 테두리가 진해지고 그림자가 생긴다.
                          className="cursor-pointer rounded [&>span]:transition-shadow hover:[&>span]:border-foreground/40 hover:[&>span]:shadow-sm focus-visible:outline-none focus-visible:[&>span]:border-foreground/40 focus-visible:[&>span]:shadow-sm"
                        >
                          {/* sessionStatusLabel은 예정 상태를 빈 문자열(배지 없음)로
                              돌려준다 -- 강사/Home 화면 등 다른 곳에서 이미 기대하는
                              공용 동작이라 그 함수 자체는 바꾸지 않는다. 다만 이 탭은
                              상태 자체가 휴강 처리의 클릭 대상이 되므로(§39-41),
                              여기서만 로컬로 "예정" 배지를 보충해서 보여준다. */}
                          {statusLabel ? (
                            <SessionStatusBadge status={statusLabel} />
                          ) : (
                            <StatusBadge label="예정" tone="neutral" />
                          )}
                        </button>
                      ) : (
                        <SessionStatusBadge status={statusLabel} />
                      )}
                      {s.hasCorrection && <StatusBadge label="정정됨" tone="warn" />}
                    </div>
                  </td>
                  {/* §18: 그 회차 당시 유효했던 Enrollment 수(현재 active
                      roster 수가 아니다) -- 서버가 session_effective_enrollment_ids
                      기준으로 계산해 내려준다. */}
                  <td className="px-4 py-2.5 text-muted-foreground">{s.enrolledCount}</td>
                  {/* §19-20: FinalAttendance가 확정된(완료) 회차만 값을
                      보여주고, 그 외(예정/누락/휴강)는 "-"다. */}
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {s.status === "completed" ? s.presentCount : "-"}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {s.status === "completed"
                      ? `${s.absentTotalCount}(${s.absentExcusedCount})`
                      : "-"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {/* 할 수 있는 일이 없으면 메뉴 버튼을 아예 두지 않는다(눌러도 빈 메뉴였다). */}
                    {(s.status === "completed" || s.status === "missing" || canEditOrDelete) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label="더보기"
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {s.status === "completed" && (
                          <DropdownMenuItem
                            onClick={() =>
                              navigate({
                                to: "/attendance/sessions/$sessionId",
                                params: { sessionId: s.id },
                              })
                            }
                          >
                            출석 정정
                          </DropdownMenuItem>
                        )}
                        {s.status === "missing" && (
                          <DropdownMenuItem onClick={() => cancelMissingSession(s.id)}>
                            휴강 처리
                          </DropdownMenuItem>
                        )}
                        {canEditOrDelete && (
                          <>
                            <DropdownMenuItem
                              onClick={() =>
                                setEditSession({
                                  id: s.id,
                                  date: dateStr,
                                  start: startStr,
                                  end: endStr,
                                })
                              }
                            >
                              수정
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => deleteOneSession(s.id)}
                            >
                              삭제
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">
                  등록된 회차가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <SessionFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="회차 추가"
        initialDate={currentTerm.startDate}
        initialStart=""
        initialEnd=""
        minDate={currentTerm.startDate}
        maxDate={currentTerm.endDate}
        submitting={addSession.isPending}
        onSubmit={submitAdd}
      />
      <SessionFormDialog
        open={!!editSession}
        onOpenChange={(v) => !v && setEditSession(null)}
        title="회차 수정"
        initialDate={editSession?.date ?? ""}
        initialStart={editSession?.start ?? ""}
        initialEnd={editSession?.end ?? ""}
        minDate={currentTerm.startDate}
        maxDate={currentTerm.endDate}
        submitting={updateSession.isPending}
        onSubmit={submitEdit}
      />
    </>
  );
}

function SessionFormDialog({
  open,
  onOpenChange,
  title,
  initialDate,
  initialStart,
  initialEnd,
  minDate,
  maxDate,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  initialDate: string;
  initialStart: string;
  initialEnd: string;
  minDate: string;
  maxDate: string;
  submitting: boolean;
  onSubmit: (date: string, start: string, end: string) => void;
}) {
  const [date, setDate] = useState(initialDate);
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);

  useEffect(() => {
    if (open) {
      setDate(initialDate);
      setStart(initialStart);
      setEnd(initialEnd);
    }
  }, [open, initialDate, initialStart, initialEnd]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">일자</label>
            <input
              type="date"
              className={`${controlCls} w-full`}
              min={minDate}
              max={maxDate}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="time"
              className={controlCls}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <span className="text-muted-foreground">~</span>
            <input
              type="time"
              className={controlCls}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <button className={btnSecondaryCls} onClick={() => onOpenChange(false)}>
            닫기
          </button>
          <button
            className={btnPrimaryCls}
            disabled={submitting || !date || !start || !end}
            onClick={() => onSubmit(date, start, end)}
          >
            저장
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// §11: 종결일 수정 Dialog.
function EndDateFormDialog({
  open,
  onOpenChange,
  initialDate,
  minDate,
  maxDate,
  submitting,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialDate: string;
  minDate: string;
  maxDate: string;
  submitting: boolean;
  onSubmit: (date: string) => void;
}) {
  const [date, setDate] = useState(initialDate);

  useEffect(() => {
    if (open) setDate(initialDate);
  }, [open, initialDate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>종결일 수정</DialogTitle>
        </DialogHeader>
        <div className="text-sm">
          <label className="mb-1 block text-xs text-muted-foreground">종결일</label>
          <input
            type="date"
            className={`${controlCls} w-full`}
            min={minDate}
            max={maxDate}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <DialogFooter>
          <button className={btnSecondaryCls} onClick={() => onOpenChange(false)}>
            닫기
          </button>
          <button
            className={btnPrimaryCls}
            disabled={submitting || !date}
            onClick={() => onSubmit(date)}
          >
            저장
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
