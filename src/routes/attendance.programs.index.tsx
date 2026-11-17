import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  StaffLayout,
  Panel,
  FilterBar,
  btnPrimaryCls,
  btnSecondaryCls,
  chipCls,
  theadCls,
} from "@/components/layout/StaffLayout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  BlockedActionDialog,
  type BlockedAction,
} from "@/components/attendance/BlockedActionDialog";
import {
  useCycleMissingSessionCounts,
  useOperationCycleProgramStatus,
  useRemoveOperationCycleProgram,
} from "@/lib/programs-data";
import { OperationCycleSelector } from "@/components/attendance/OperationCycleSelector";
import { useOperationCycleSelection } from "@/lib/operation-cycle-selection";
import { useAuth } from "@/lib/auth";
import { ProgramScheduleExcelDialog } from "@/components/attendance/ProgramScheduleExcelDialog";
import { SelectCycleProgramsDialog } from "@/components/attendance/SelectCycleProgramsDialog";
import { BulkRosterPasteDialog } from "@/components/attendance/BulkRosterPasteDialog";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

export const Route = createFileRoute("/attendance/programs/")({
  // 홈 "출석 누락" 숫자를 누르면 ?missing=1로 들어와 누락 필터가 켜진 채 열린다.
  // 고른 연도·운영구분도 주소에 남긴다 -- 상세에 들어갔다 돌아와도 보던 구분이 유지된다.
  validateSearch: (
    search: Record<string, unknown>,
  ): { missing?: "1"; yearId?: string; cycleId?: string } => ({
    ...(search["missing"] === "1" || search["missing"] === true
      ? { missing: "1" as const }
      : {}),
    ...(typeof search["yearId"] === "string" ? { yearId: search["yearId"] } : {}),
    ...(typeof search["cycleId"] === "string" ? { cycleId: search["cycleId"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "프로그램 설정 — WellLink" },
      {
        name: "description",
        content: "연도와 운영구분을 고른 뒤, 프로그램을 불러와 일정과 수강생을 등록하세요.",
      },
      { property: "og:title", content: "프로그램 설정 — WellLink" },
      { property: "og:description", content: "운영구분별 프로그램 가져오기/기본설정/수강명단." },
    ],
  }),
  component: ProgramsPage,
});

const WEEKDAY_LABEL: Record<number, string> = {
  1: "월",
  2: "화",
  3: "수",
  4: "목",
  5: "금",
  6: "토",
  7: "일",
};

function ProgramsPage() {
  const navigate = useNavigate();
  const { missing: missingSearch, yearId: yearSearch, cycleId: cycleSearch } = Route.useSearch();
  const missingOnly = missingSearch === "1";
  const { staffProfile } = useAuth();
  const canManage = staffProfile?.businessRole !== "global_viewer";
  const selectedYearId = yearSearch ?? null;
  const selectedCycleId = cycleSearch ?? null;
  // 선택은 주소가 보관한다(상세에 다녀와도 유지). replace라 뒤로가기 기록이 쌓이지 않는다.
  const setSearch = (next: { missing?: "1"; yearId?: string; cycleId?: string }) =>
    navigate({ to: "/attendance/programs", search: next, replace: true });
  const {
    years,
    cycles,
    cyclesLoading,
    activeYearId,
    activeCycleId,
    activeCycle,
    activeCycleLabel,
  } = useOperationCycleSelection({ yearId: selectedYearId, cycleId: selectedCycleId });

  const { data: status, isLoading: statusLoading } = useOperationCycleProgramStatus(activeCycleId);
  // 누락 회차 수(운영차수별). 목록에서 바로 보이게 하고, 누락만 추려 볼 수 있게 한다.
  const { data: missingCounts } = useCycleMissingSessionCounts(activeCycleId);
  const missingOf = (operationTermId: string | null) =>
    (operationTermId && missingCounts?.[operationTermId]) || 0;

  const [scheduleExcelOpen, setScheduleExcelOpen] = useState(false);
  const [selectProgramsOpen, setSelectProgramsOpen] = useState(false);
  const [bulkRosterOpen, setBulkRosterOpen] = useState(false);
  const [blocked, setBlocked] = useState<BlockedAction>(null);

  const total = status?.length ?? 0;
  const missingProgramCount = (status ?? []).filter((r) => missingOf(r.operationTermId) > 0).length;
  const visibleRows = (status ?? []).filter(
    (r) => !missingOnly || missingOf(r.operationTermId) > 0,
  );

  const removeProgram = useRemoveOperationCycleProgram();

  async function excludeProgram(programId: string, programName: string) {
    if (!activeCycleId) return;
    if (!window.confirm(`"${programName}"을(를) 현재 운영구분에서 제외할까요?`)) return;
    try {
      await removeProgram.mutateAsync({ operationCycleId: activeCycleId, programId });
      toast.success("프로그램을 제외했습니다.");
    } catch (e: any) {
      setBlocked({ title: "프로그램을 제외할 수 없습니다.", reason: errorReason(e) });
    }
  }

  return (
    <StaffLayout
      title="프로그램 설정"
      description="연도와 운영구분을 고른 뒤, 프로그램을 불러와 일정과 수강생을 등록하세요."
    >
      <OperationCycleSelector
        years={years}
        cycles={cycles}
        cyclesLoading={cyclesLoading}
        activeYearId={activeYearId}
        activeCycleId={activeCycleId}
        onYearChange={(yearId) => {
          // 연도를 바꾸면 그 연도에 없는 운영구분·누락 필터는 비운다.
          setSearch({ yearId });
        }}
        onCycleChange={(cycleId) =>
          setSearch({
            ...(missingOnly ? { missing: "1" as const } : {}),
            ...(activeYearId ? { yearId: activeYearId } : {}),
            cycleId,
          })
        }
        period={
          activeCycle ? { startDate: activeCycle.startDate, endDate: activeCycle.endDate } : null
        }
      />

      {cyclesLoading && (
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        </Panel>
      )}

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
          {/* Program Settings Final Design Lock §11: 메인 Action은 딱 세 개
              -- Step Card/진행상태/반복 설명을 두지 않는다. */}
          {canManage && (
            // 휴대폰에서는 [+ 프로그램 가져오기]를 한 줄에 두고 일괄등록 두 개를 그 아래 줄로
            // 모은다(버튼이 2·1개로 어정쩡하게 나뉘지 않게). 640px 이상은 한 줄 그대로.
            <div className="mb-4 flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap">
              <button className={btnPrimaryCls} onClick={() => setSelectProgramsOpen(true)}>
                + 프로그램 가져오기
              </button>
              <div className="flex flex-wrap gap-2">
                <button
                  className={btnSecondaryCls}
                  disabled={total === 0}
                  onClick={() => setScheduleExcelOpen(true)}
                >
                  기본설정 일괄등록
                </button>
                <button
                  className={btnSecondaryCls}
                  disabled={total === 0}
                  onClick={() => setBulkRosterOpen(true)}
                >
                  수강명단 일괄등록
                </button>
              </div>
            </div>
          )}

          {/* 홈 "출석 누락"에서 넘어오거나, 여기서 직접 누락만 추려 본다. */}
          <FilterBar>
            <button
              className={`${chipCls} ${
                missingOnly
                  ? "border-primary text-foreground"
                  : "border-border text-muted-foreground"
              }`}
              onClick={() =>
                setSearch({
                  ...(missingOnly ? {} : { missing: "1" as const }),
                  ...(activeYearId ? { yearId: activeYearId } : {}),
                  ...(activeCycleId ? { cycleId: activeCycleId } : {}),
                })
              }
            >
              누락만 보기 {missingProgramCount}
            </button>
            <span className="text-xs text-muted-foreground">
              {missingOnly
                ? `출석이 들어오지 않아 누락으로 마감된 회차가 있는 프로그램 ${missingProgramCount}개입니다.`
                : `전체 ${total}개`}
            </span>
          </FilterBar>

          <Panel>
            <table className="w-full min-w-[770px] table-fixed text-sm">
              <colgroup>
                <col className="w-[220px]" />
                <col className="w-[180px]" />
                <col className="w-[130px]" />
                <col className="w-[90px]" />
                <col className="w-[90px]" />
                <col className="w-[48px]" />
              </colgroup>
              <thead>
                <tr className={theadCls}>
                  <th className="px-4 py-2 font-medium">프로그램</th>
                  <th className="px-4 py-2 font-medium">일정</th>
                  <th className="px-4 py-2 font-medium">강사</th>
                  <th className="px-4 py-2 font-medium">수강인원</th>
                  <th className="px-4 py-2 font-medium">누락</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {statusLoading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      불러오는 중...
                    </td>
                  </tr>
                )}
                {!statusLoading && total > 0 && missingOnly && visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      이 운영구분에는 누락 회차가 없습니다.
                    </td>
                  </tr>
                )}
                {!statusLoading && total === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                      이 운영구분에 가져온 프로그램이 없습니다. 위 "+ 프로그램 가져오기"로 먼저
                      가져와 주세요.
                    </td>
                  </tr>
                )}
                {visibleRows.map((row) => {
                  const scheduleLabel = !row.hasTerm
                    ? "기본설정 필요"
                    : row.scheduleMode === "custom_dates"
                      ? `직접 지정 · ${row.sessionCount}회 ${row.startTime?.slice(0, 5) ?? ""}~${row.endTime?.slice(0, 5) ?? ""}`
                      : `${row.weekdays.map((w) => WEEKDAY_LABEL[w] ?? "?").join("·")} ${
                          row.startTime?.slice(0, 5) ?? ""
                        }~${row.endTime?.slice(0, 5) ?? ""}`;
                  const instructorState = row.instructorName
                    ? "linked"
                    : row.instructorNameText
                      ? "text"
                      : "none";
                  const instructorLabel = row.instructorName ?? row.instructorNameText;
                  return (
                    <tr
                      key={row.programId}
                      onClick={() =>
                        navigate({
                          to: "/attendance/programs/$programId",
                          params: { programId: row.programId },
                          search: {
                            cycleId: activeCycleId ?? undefined,
                            yearId: activeYearId ?? undefined,
                            missing: missingOnly ? ("1" as const) : undefined,
                            tab: undefined,
                          },
                        })
                      }
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/60"
                    >
                      <td className="px-4 py-2.5 font-medium text-foreground">{row.name}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{scheduleLabel}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {instructorState === "text" ? (
                          <span className="flex flex-col leading-tight">
                            <span>{instructorLabel}</span>
                            <span className="text-xs text-muted-foreground">[계정 없음]</span>
                          </span>
                        ) : (
                          (instructorLabel ?? "-")
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{row.enrollmentCount}명</td>
                      <td className="px-4 py-2.5">
                        {missingOf(row.operationTermId) > 0 ? (
                          <StatusBadge
                            label={`${missingOf(row.operationTermId)}회`}
                            tone="danger"
                          />
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              onClick={(e) => e.stopPropagation()}
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                              aria-label="더보기"
                            >
                              <MoreHorizontal className="size-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem
                              onClick={() =>
                                navigate({
                                  to: "/attendance/programs/$programId",
                                  params: { programId: row.programId },
                                  search: {
                            cycleId: activeCycleId ?? undefined,
                            yearId: activeYearId ?? undefined,
                            missing: missingOnly ? ("1" as const) : undefined,
                            tab: undefined,
                          },
                                })
                              }
                            >
                              프로그램 상세
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => excludeProgram(row.programId, row.name)}
                            >
                              프로그램 제외하기
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>

          {status && (
            <ProgramScheduleExcelDialog
              open={scheduleExcelOpen}
              onOpenChange={setScheduleExcelOpen}
              operationCycleId={activeCycleId}
              programs={status}
            />
          )}
          <SelectCycleProgramsDialog
            open={selectProgramsOpen}
            onOpenChange={setSelectProgramsOpen}
            operationCycleId={activeCycleId}
            cycleLabel={activeCycleLabel}
          />
          {status && (
            <BulkRosterPasteDialog
              open={bulkRosterOpen}
              onOpenChange={setBulkRosterOpen}
              operationCycleId={activeCycleId}
              programs={status}
            />
          )}
        </>
      )}

      <BlockedActionDialog state={blocked} onClose={() => setBlocked(null)} />
    </StaffLayout>
  );
}
