import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  StaffLayout,
  AbsenceTabs,
  Panel,
  FilterBar,
  chipCls,
  controlCls,
  btnSecondaryCls,
  theadCls,
  ListState,
} from "@/components/layout/StaffLayout";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
  useAbsenceAlertList,
  useDismissAbsenceAlert,
  useDismissAbsenceAlerts,
  useReactivateAbsenceAlert,
} from "@/lib/attendance-data";
import { useAttendanceSettings } from "@/lib/org-settings-data";
import { OperationCycleSelector } from "@/components/attendance/OperationCycleSelector";
import { useOperationCycleSelection } from "@/lib/operation-cycle-selection";
import { toast } from "sonner";
import { compareName } from "@/lib/format";

export const Route = createFileRoute("/attendance/absence")({
  // 운영연도/운영구분 선택값은 URL로 들고 다닌다 -- 신고결석 관리 탭과
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
      { name: "description", content: "기준 임박·기준 도달 관리대상과 알림상태를 관리합니다." },
      { property: "og:title", content: "결석 관리 — WellLink" },
      { property: "og:description", content: "결석 기준 임박·도달 대상 관리 화면." },
    ],
  }),
  component: AbsencePage,
});

function AbsencePage() {
  const [filter, setFilter] = useState<"전체" | "기준 도달" | "기준 임박">("전체");
  // 234명이 한 줄씩 쌓여 있어 사람을 찾기 어려웠다 -- 이름 검색과 프로그램 선택을 둔다.
  const [nameQuery, setNameQuery] = useState("");
  const [programFilter, setProgramFilter] = useState("전체");
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
  const {
    data,
    isLoading: listLoading,
    isError: listError,
    isFetching: listFetching,
    refetch: refetchList,
  } = useAbsenceAlertList(activeCycleId);
  const dismiss = useDismissAbsenceAlert();
  const dismissMany = useDismissAbsenceAlerts();
  const reactivate = useReactivateAbsenceAlert();
  // 일괄 끄기용 선택. 필터·검색·운영구분을 바꾸면 비운다(보이지 않는 사람이 선택된 채
  // 끄이는 일을 막는다).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const clearSelection = () => setSelectedIds(new Set());
  const { data: attendanceSettings } = useAttendanceSettings();

  const withState = (data ?? []).map((r) => ({
    ...r,
    state: (r.unexcusedReached || r.excusedReached ? "기준 도달" : "기준 임박") as
      "기준 도달" | "기준 임박",
  }));

  const counts = {
    전체: withState.length,
    "기준 도달": withState.filter((r) => r.state === "기준 도달").length,
    "기준 임박": withState.filter((r) => r.state === "기준 임박").length,
  };
  const programNames = [...new Set(withState.map((r) => r.programName))].sort(compareName);
  const query = nameQuery.trim();
  const rows = withState.filter(
    (r) =>
      (filter === "전체" || r.state === filter) &&
      (programFilter === "전체" || r.programName === programFilter) &&
      (query === "" || r.userName.includes(query)),
  );
  // 이미 꺼진 사람은 끌 것이 없으므로 선택 대상에서 뺀다.
  const selectableRows = rows.filter((r) => r.alertActive);
  const selectedRows = selectableRows.filter((r) => selectedIds.has(r.enrollmentId));
  const allSelected = selectableRows.length > 0 && selectedRows.length === selectableRows.length;
  const headerChecked: boolean | "indeterminate" = allSelected
    ? true
    : selectedRows.length > 0
      ? "indeterminate"
      : false;

  const toggleAllVisible = () => {
    setSelectedIds(allSelected ? new Set() : new Set(selectableRows.map((r) => r.enrollmentId)));
  };
  const toggleOne = (enrollmentId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(enrollmentId)) next.delete(enrollmentId);
      else next.add(enrollmentId);
      return next;
    });
  };

  const dismissSelected = async () => {
    const ids = selectedRows.map((r) => r.enrollmentId);
    if (ids.length === 0) return;
    try {
      const changed = await dismissMany.mutateAsync(ids);
      clearSelection();
      toast.success(`${changed}명의 알림을 껐습니다.`);
    } catch {
      toast.error("알림을 끄지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  };

  const toggleAlert = async (row: (typeof withState)[number]) => {
    try {
      if (row.alertActive) {
        await dismiss.mutateAsync(row.enrollmentId);
        toast.success(`${row.userName} 님의 알림을 껐습니다.`);
      } else {
        await reactivate.mutateAsync(row.enrollmentId);
        toast.success(`${row.userName} 님의 알림을 켰습니다.`);
      }
    } catch {
      toast.error("알림을 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");
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

  return (
    <StaffLayout title="결석 관리">
      <OperationCycleSelector
        years={years}
        cycles={cycles}
        cyclesLoading={cyclesLoading}
        activeYearId={activeYearId}
        activeCycleId={activeCycleId}
        onYearChange={(nextYearId) => {
          clearSelection();
          // 새 연도·운영구분에 없는 프로그램이 필터에 남아 "대상 없음"으로 보이지 않게 비운다.
          setProgramFilter("전체");
          navigate({ search: { yearId: nextYearId, cycleId: undefined } });
        }}
        onCycleChange={(nextCycleId) => {
          clearSelection();
          setProgramFilter("전체");
          navigate({ search: { yearId: activeYearId ?? undefined, cycleId: nextCycleId } });
        }}
        period={
          activeCycle ? { startDate: activeCycle.startDate, endDate: activeCycle.endDate } : null
        }
      />
      <AbsenceTabs
        active="absence"
        showExcusedTab={attendanceSettings?.excusedAbsenceEnabled ?? true}
        search={tabSearch}
      />
      <p className="mb-4 text-sm text-muted-foreground">
        설정한 결석 기준에 도달한 이용자를 확인합니다.
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
            {(["전체", "기준 도달", "기준 임박"] as const).map((f) => (
              <button
                key={f}
                onClick={() => {
                  setFilter(f);
                  clearSelection();
                }}
                className={`${chipCls} ${
                  filter === f
                    ? "border-primary text-foreground"
                    : "border-border text-muted-foreground"
                }`}
              >
                {f} {counts[f]}
              </button>
            ))}
            <input
              className={`${controlCls} w-40`}
              placeholder="이용자 이름 검색"
              value={nameQuery}
              onChange={(e) => {
                setNameQuery(e.target.value);
                clearSelection();
              }}
            />
            <select
              className={controlCls}
              value={programFilter}
              onChange={(e) => {
                setProgramFilter(e.target.value);
                clearSelection();
              }}
            >
              <option value="전체">프로그램 전체</option>
              {programNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </FilterBar>

          {/* 일괄 끄기: 지금 보이는 목록(필터·검색 결과) 중 알림이 켜진 사람만 고를 수 있다.
              휴대폰에는 표 머리줄이 없으므로 "전체 선택"을 여기에 둔다. */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <label
              className={`flex min-h-9 items-center gap-2 text-sm ${
                selectableRows.length === 0
                  ? "cursor-not-allowed text-muted-foreground/60"
                  : "cursor-pointer text-muted-foreground"
              }`}
            >
              <Checkbox
                checked={headerChecked}
                onCheckedChange={toggleAllVisible}
                disabled={selectableRows.length === 0}
                aria-label="보이는 목록 전체 선택"
              />
              전체 선택
              <span className="text-xs">
                (알림 켜짐 {selectableRows.length}명 중 {selectedRows.length}명 선택)
              </span>
            </label>
            <button
              type="button"
              className={btnSecondaryCls}
              disabled={selectedRows.length === 0 || dismissMany.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              {dismissMany.isPending ? "끄는 중..." : `선택한 ${selectedRows.length}명 알림 끄기`}
            </button>
          </div>

          {/* 휴대폰(640px 미만)은 표 대신 두 줄 카드: 이용자·프로그램 + 관리상태 / 결석 수 + 알림 스위치.
              알림 스위치는 "알림" 글자까지 누를 수 있게 44px 높이로 잡는다. 태블릿·데스크탑은 아래 표 그대로다. */}
          <Panel className="sm:hidden">
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.enrollmentId} className="flex gap-3 px-4 pt-2.5 pb-1">
                  <div className="pt-0.5">
                    <Checkbox
                      className="size-5"
                      checked={selectedIds.has(r.enrollmentId) && r.alertActive}
                      onCheckedChange={() => toggleOne(r.enrollmentId)}
                      disabled={!r.alertActive}
                      aria-label={`${r.userName} 선택`}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 text-sm">
                        <span className="font-medium text-foreground">{r.userName}</span>
                        <span className="text-muted-foreground"> · {r.programName}</span>
                      </p>
                      <StatusBadge
                        label={r.state}
                        tone={r.state === "기준 도달" ? "danger" : "warn"}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm text-muted-foreground">
                        결석 {r.unexcusedCount}회 · 신고결석 {r.excusedCount}회
                      </p>
                      <label className="-mr-2 flex min-h-11 shrink-0 cursor-pointer items-center gap-2 px-2 text-sm text-muted-foreground">
                        알림
                        <Switch
                          checked={r.alertActive}
                          onCheckedChange={() => toggleAlert(r)}
                          aria-label={`${r.userName} 알림`}
                        />
                      </label>
                    </div>
                  </div>
                </li>
              ))}
              {rows.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <ListState
                    loading={listLoading}
                    error={listError}
                    retrying={listFetching}
                    onRetry={() => refetchList()}
                    empty={
                      query || programFilter !== "전체"
                        ? "검색 조건에 맞는 대상이 없습니다."
                        : "표시할 대상이 없습니다."
                    }
                  />
                </li>
              )}
            </ul>
          </Panel>

          <Panel className="hidden sm:block">
            {/* 프로그램 열에 290px 이상이 남게 잡는다(최장 프로그램명 약 186px). */}
            <table className="w-full min-w-[984px] table-fixed text-sm">
              <colgroup>
                <col className="w-[44px]" />
                <col className="w-[120px]" />
                <col />
                <col className="w-[90px]" />
                <col className="w-[100px]" />
                <col className="w-[120px]" />
                <col className="w-[110px]" />
              </colgroup>
              <thead>
                <tr className={theadCls}>
                  <th className="py-2 pl-4 font-medium">
                    <Checkbox
                      className="align-middle"
                      checked={headerChecked}
                      onCheckedChange={toggleAllVisible}
                      disabled={selectableRows.length === 0}
                      aria-label="보이는 목록 전체 선택"
                    />
                  </th>
                  <th className="px-4 py-2 font-medium">이용자</th>
                  <th className="px-4 py-2 font-medium">프로그램</th>
                  <th className="px-4 py-2 font-medium">결석</th>
                  <th className="px-4 py-2 font-medium">신고결석</th>
                  <th className="px-4 py-2 font-medium">관리상태</th>
                  <th className="px-4 py-2 font-medium">알림</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.enrollmentId} className="border-b border-border last:border-0">
                    <td className="py-1.5 pl-4">
                      <Checkbox
                        className="align-middle"
                        checked={selectedIds.has(r.enrollmentId) && r.alertActive}
                        onCheckedChange={() => toggleOne(r.enrollmentId)}
                        disabled={!r.alertActive}
                        aria-label={`${r.userName} 선택`}
                      />
                    </td>
                    <td className="px-4 py-1.5 text-foreground">{r.userName}</td>
                    <td className="px-4 py-1.5 text-muted-foreground">{r.programName}</td>
                    <td className="px-4 py-1.5 text-muted-foreground">{r.unexcusedCount}회</td>
                    <td className="px-4 py-1.5 text-muted-foreground">{r.excusedCount}회</td>
                    <td className="px-4 py-1.5">
                      <StatusBadge
                        label={r.state}
                        tone={r.state === "기준 도달" ? "danger" : "warn"}
                      />
                    </td>
                    {/* 상태 배지와 버튼이 같은 말을 써서 헷갈렸다 -- 스위치 하나로 합쳤다.
                        알림을 꺼도 결석 횟수와 관리상태는 그대로다(서버도 알림 기록만 건드린다). */}
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={r.alertActive}
                          onCheckedChange={() => toggleAlert(r)}
                          aria-label={`${r.userName} 알림`}
                        />
                        <span className="text-xs text-muted-foreground">
                          {r.alertActive ? "켬" : "끔"}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      <ListState
                        loading={listLoading}
                        error={listError}
                        retrying={listFetching}
                        onRetry={() => refetchList()}
                        empty={
                          query || programFilter !== "전체"
                            ? "검색 조건에 맞는 대상이 없습니다."
                            : "표시할 대상이 없습니다."
                        }
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
          <p className="mt-3 text-[13px] text-muted-foreground">
            알림을 꺼도 결석 횟수와 관리상태(기준 임박/기준 도달)는 그대로이며 목록에도 계속
            표시됩니다. 새로운 결석이 생기면 알림이 다시 켜집니다.
          </p>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>선택한 {selectedRows.length}명의 알림을 끌까요?</AlertDialogTitle>
                <AlertDialogDescription>
                  결석 횟수와 관리상태는 그대로이며, 이후 새로운 결석이 생기면 알림이 다시 켜집니다.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>닫기</AlertDialogCancel>
                <AlertDialogAction onClick={dismissSelected}>알림 끄기</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </StaffLayout>
  );
}
