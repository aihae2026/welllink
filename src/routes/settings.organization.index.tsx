import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  StaffLayout,
  Panel,
  PanelHeader,
  btnPrimaryCls,
  btnSecondaryCls,
  controlCls,
  btnDangerCls,
} from "@/components/layout/StaffLayout";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { OrgSettingsTabs } from "@/components/layout/OrgSettingsTabs";
import {
  BlockedActionDialog,
  type BlockedAction,
} from "@/components/attendance/BlockedActionDialog";
import { useAuth } from "@/lib/auth";
import {
  useAttendanceSettings,
  useCreateBusinessYear,
  useDeleteBusinessYear,
  useOnboardingStatus,
  useOrganizationBasic,
  useUpdateAttendanceSettings,
  useUpdateBusinessYear,
  useUpdateOperationCycleMode,
  useUpdateOrganizationName,
  type OnboardingStatus,
} from "@/lib/org-settings-data";
import { useOperationCycles, useUpdateOperationCycle } from "@/lib/programs-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

// 운영구분 이름은 자동생성 시 연도 접두어 없이 저장한다("상반기"), 기존
// 기관의 수동생성 이름("2026년 상반기")과 섞여 있을 수 있으므로 표시할
// 때는 접두어를 항상 벗겨서 짧게 보여준다(§7/§10 -- 연도는 selector에서
// 이미 보여주므로 이름에서까지 반복하지 않는다).
function shortCycleLabel(name: string) {
  return name.replace(/^\d{4}년\s*/, "");
}

export const Route = createFileRoute("/settings/organization/")({
  head: () => ({
    meta: [{ title: "운영설정 — WellLink" }],
  }),
  component: OrgBasicPage,
});

// Manual QA Gap Fix — Initial Setup & Program Onboarding §2: 기관 초기설정
// 최종 3단계. 3번(사용자 등록)은 hard gate가 아니다 -- 미완료여도 다른 업무를
// 막지 않으며, Home 진입 여부 판단(index.tsx)에도 쓰이지 않는다.
const CHECKLIST_ITEMS: {
  title: string;
  description: string;
  key: keyof OnboardingStatus;
  to: string;
}[] = [
  {
    title: "기본 운영 설정",
    description: "운영연도와 출결관리 설정",
    key: "hasBasicInfo",
    to: "/settings/organization",
  },
  {
    title: "사업·활동 구성",
    description: "단위사업부터 소분류(활동)까지 구성",
    key: "hasBusinessStructure",
    to: "/settings/organization/business",
  },
  {
    title: "사용자 등록",
    description: "직원 또는 강사 추가 등록",
    key: "hasUsers",
    to: "/settings/users",
  },
];

function OrgBasicPage() {
  const { staffProfile } = useAuth();
  const canAccess = staffProfile?.businessRole === "global_manager";
  const { data, isLoading } = useOrganizationBasic();
  const { data: onboarding } = useOnboardingStatus();
  const createYear = useCreateBusinessYear();
  const updateYear = useUpdateBusinessYear();
  const deleteYear = useDeleteBusinessYear();
  const updateName = useUpdateOrganizationName();
  const [newYear, setNewYear] = useState("");
  const [addingYear, setAddingYear] = useState(false);
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingYearId, setEditingYearId] = useState<string | null>(null);
  const [yearDraft, setYearDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; year: number } | null>(null);
  const [deleteFailReason, setDeleteFailReason] = useState<string | null>(null);

  // 연도는 최신순으로 정렬해 보여준다(useOrganizationBasic이 이미 year desc로 조회).
  const sortedYears = data?.years ?? [];
  const maxYear = sortedYears.reduce((max, y) => Math.max(max, y.year), 0);
  const effectiveSelectedYearId = selectedYearId ?? sortedYears[0]?.id ?? null;

  if (staffProfile && !canAccess) {
    return (
      <StaffLayout title="운영설정">
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">이 화면은 관리자만 접근할 수 있습니다.</p>
        </Panel>
      </StaffLayout>
    );
  }

  async function addYear() {
    const y = Number(newYear);
    if (!Number.isInteger(y) || y < 2000 || y > 2200) {
      toast.error("연도 값을 확인해 주세요.");
      return;
    }
    try {
      await createYear.mutateAsync(y);
      toast.success(`${y}년을 추가했습니다.`);
      setNewYear("");
      setAddingYear(false);
    } catch (e: any) {
      toast.error(`연도 추가 실패: ${errorReason(e)}`);
    }
  }

  async function saveYear(id: string) {
    const y = Number(yearDraft);
    if (!Number.isInteger(y) || y < 2000 || y > 2200) {
      toast.error("연도 값을 확인해 주세요.");
      return;
    }
    try {
      await updateYear.mutateAsync({ id, year: y });
      toast.success("연도를 수정했습니다.");
      setEditingYearId(null);
    } catch (e: any) {
      toast.error(`수정 실패: ${errorReason(e)}`);
    }
  }

  async function confirmDeleteYear() {
    if (!deleteTarget) return;
    try {
      await deleteYear.mutateAsync(deleteTarget.id);
      toast.success(`${deleteTarget.year}년을 삭제했습니다.`);
      if (selectedYearId === deleteTarget.id) setSelectedYearId(null);
      setDeleteTarget(null);
    } catch (e: any) {
      // dependency guard(RPC)가 이미 친절한 한국어 사유를 던지므로 그 문구를
      // 그대로 보여준다 -- raw DB constraint 이름 같은 건 애초에 노출되지
      // 않는다. toast(잠깐 보이고 사라짐) 대신 [확인]이 있는 Dialog로 명확히
      // 안내하고, 연도/화면 상태는 그대로 두어 바로 재시도할 수 있게 한다.
      setDeleteFailReason(errorReason(e));
      setDeleteTarget(null);
    }
  }

  async function saveName() {
    if (!nameDraft.trim()) return;
    try {
      await updateName.mutateAsync(nameDraft.trim());
      toast.success("기관명을 변경했습니다.");
      setEditingName(false);
    } catch (e: any) {
      toast.error(`변경 실패: ${errorReason(e)}`);
    }
  }

  const allDone = onboarding && CHECKLIST_ITEMS.every((item) => onboarding[item.key]);

  return (
    <StaffLayout title="운영설정">
      <OrgSettingsTabs active="basic" />
      <p className="mb-4 text-sm text-muted-foreground">
        기관명, 운영연도 등 기관의 기본 운영정보를 설정합니다.
      </p>

      {onboarding && !allDone && (
        <Panel className="mb-4">
          <PanelHeader title="기관 초기 설정" />
          <ol className="space-y-2 px-4 py-3 text-sm">
            {CHECKLIST_ITEMS.map((item, i) => {
              const done = onboarding[item.key];
              return (
                <li key={item.key} className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs ${
                      done
                        ? "bg-primary/15 text-primary"
                        : "border border-border text-muted-foreground"
                    }`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <div>
                    {done ? (
                      <span className="text-muted-foreground line-through">{item.title}</span>
                    ) : (
                      <Link to={item.to} className="text-foreground hover:underline">
                        {item.title}
                      </Link>
                    )}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {done ? "완료" : "미완료"}
                    </span>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </Panel>
      )}

      <Panel>
        <PanelHeader title="기본정보" />
        <div className="space-y-4 px-4 py-4 text-sm">
          {isLoading ? (
            <p className="text-muted-foreground">불러오는 중...</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-muted-foreground">기관명</span>
                {editingName ? (
                  <>
                    <input
                      className={controlCls}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      autoFocus
                    />
                    <button
                      className={btnPrimaryCls}
                      disabled={updateName.isPending}
                      onClick={saveName}
                    >
                      저장
                    </button>
                    <button className={btnSecondaryCls} onClick={() => setEditingName(false)}>
                      취소
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-foreground">{data?.organizationName}</span>
                    <button
                      className="text-xs text-primary hover:underline"
                      onClick={() => {
                        setNameDraft(data?.organizationName ?? "");
                        setEditingName(true);
                      }}
                    >
                      기관명 수정
                    </button>
                  </>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-muted-foreground">운영 연도</span>
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  {sortedYears.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      등록된 연도가 없습니다. 첫 연도를 추가해 주세요.
                    </span>
                  ) : (
                    <Select
                      value={effectiveSelectedYearId!}
                      onValueChange={(v) => setSelectedYearId(v)}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sortedYears.map((y) => (
                          <SelectItem key={y.id} value={y.id}>
                            {y.year}년{y.status === "active" ? "" : ` (${y.status})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {addingYear ? (
                    <>
                      <input
                        className={`${controlCls} w-24`}
                        value={newYear}
                        onChange={(e) => setNewYear(e.target.value.replace(/[^0-9]/g, ""))}
                        autoFocus
                      />
                      <button
                        className={btnPrimaryCls}
                        disabled={createYear.isPending}
                        onClick={addYear}
                      >
                        추가
                      </button>
                      <button
                        className={btnSecondaryCls}
                        onClick={() => {
                          setAddingYear(false);
                          setNewYear("");
                        }}
                      >
                        취소
                      </button>
                    </>
                  ) : (
                    <button
                      className="text-xs text-primary hover:underline"
                      onClick={() => {
                        setNewYear(String(maxYear > 0 ? maxYear + 1 : new Date().getFullYear()));
                        setAddingYear(true);
                      }}
                    >
                      + 다음 연도 추가
                    </button>
                  )}

                  {sortedYears.length > 0 && (
                    <Popover open={manageOpen} onOpenChange={setManageOpen}>
                      <PopoverTrigger asChild>
                        <button className={btnSecondaryCls}>관리</button>
                      </PopoverTrigger>
                      <PopoverContent
                        className={`w-72 ${deleteTarget ? "pointer-events-none" : ""}`}
                        align="start"
                      >
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          연도 수정 · 삭제
                        </p>
                        <div className="max-h-64 space-y-1.5 overflow-y-auto">
                          {sortedYears.map((y) =>
                            editingYearId === y.id ? (
                              <div key={y.id} className="flex items-center gap-1.5">
                                <input
                                  className={`${controlCls} w-20`}
                                  value={yearDraft}
                                  onChange={(e) =>
                                    setYearDraft(e.target.value.replace(/[^0-9]/g, ""))
                                  }
                                  autoFocus
                                />
                                <button
                                  className="text-xs text-primary hover:underline"
                                  disabled={updateYear.isPending}
                                  onClick={() => saveYear(y.id)}
                                >
                                  저장
                                </button>
                                <button
                                  className="text-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => setEditingYearId(null)}
                                >
                                  취소
                                </button>
                              </div>
                            ) : (
                              <div key={y.id} className="flex items-center justify-between gap-2">
                                <span className="text-sm text-foreground">
                                  {y.year}년{y.status === "active" ? "" : ` (${y.status})`}
                                </span>
                                <div className="flex shrink-0 gap-2">
                                  <button
                                    className="text-xs text-primary hover:underline"
                                    onClick={() => {
                                      setEditingYearId(y.id);
                                      setYearDraft(String(y.year));
                                    }}
                                  >
                                    수정
                                  </button>
                                  <button
                                    className="text-xs text-muted-foreground hover:text-destructive"
                                    onClick={() => {
                                      setManageOpen(false);
                                      setDeleteTarget({ id: y.id, year: y.year });
                                    }}
                                  >
                                    삭제
                                  </button>
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </Panel>

      <AttendanceSettingsPanel />

      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{deleteTarget?.year}년을 삭제할까요?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            등록된 사업·활동 또는 운영 데이터가 있으면 삭제할 수 없습니다.
          </p>
          <DialogFooter>
            <button className={btnSecondaryCls} onClick={() => setDeleteTarget(null)}>
              닫기
            </button>
            <button
              className={btnDangerCls}
              disabled={deleteYear.isPending}
              onClick={confirmDeleteYear}
            >
              {deleteYear.isPending ? "처리 중…" : "삭제"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteFailReason} onOpenChange={(v) => !v && setDeleteFailReason(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>운영 연도를 삭제할 수 없습니다.</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{deleteFailReason}</p>
          <DialogFooter>
            <button className={btnPrimaryCls} onClick={() => setDeleteFailReason(null)}>
              확인
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StaffLayout>
  );
}

// 입력한 기준으로 임박/도달이 몇 회부터인지 풀어서 보여준다. 임박은 "기준-1회"라
// 기준 1회면 임박 단계가 없다(list_absence_alert_states, 20260910140000).
function absenceThresholdGuide(label: string, raw: string): string | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  if (n === 1) {
    return `${label}은 임박 단계 없이 1회부터 바로 '기준 도달'로 표시되고 알림이 켜집니다.`;
  }
  return `${label} ${n - 1}회가 되면 '기준 임박', ${n}회부터 '기준 도달'로 결석 관리에 표시되고 알림이 켜집니다.`;
}

// Final Batch A §12: 출결관리 설정 -- 결석관리/신고결석 사용 여부와 누적
// 확인 기준값을 기관이 직접 설정한다. 로컬 draft 상태를 두고 "저장"을 눌러야
// 반영한다(스위치를 켜자마자 바로 저장하지 않음 -- 실수로 대량 데이터가
// 노출/숨김되는 것을 막기 위해).
function AttendanceSettingsPanel() {
  const { data: settings, isLoading } = useAttendanceSettings();
  const update = useUpdateAttendanceSettings();
  const [attendanceEnabled, setAttendanceEnabled] = useState(true);
  const [excusedAbsenceEnabled, setExcusedAbsenceEnabled] = useState(true);
  const [unexcusedThreshold, setUnexcusedThreshold] = useState("2");
  const [excusedThreshold, setExcusedThreshold] = useState("5");
  const [dirty, setDirty] = useState(false);

  if (settings && !dirty) {
    if (
      attendanceEnabled !== settings.attendanceEnabled ||
      excusedAbsenceEnabled !== settings.excusedAbsenceEnabled ||
      unexcusedThreshold !== String(settings.unexcusedAbsenceThreshold) ||
      excusedThreshold !== String(settings.excusedAbsenceThreshold)
    ) {
      setAttendanceEnabled(settings.attendanceEnabled);
      setExcusedAbsenceEnabled(settings.excusedAbsenceEnabled);
      setUnexcusedThreshold(String(settings.unexcusedAbsenceThreshold));
      setExcusedThreshold(String(settings.excusedAbsenceThreshold));
    }
  }

  async function save() {
    const unexcused = Number(unexcusedThreshold);
    const excused = Number(excusedThreshold);
    if (
      !Number.isInteger(unexcused) ||
      unexcused < 1 ||
      !Number.isInteger(excused) ||
      excused < 1
    ) {
      toast.error("기준 회수는 1 이상의 숫자여야 합니다.");
      return;
    }
    try {
      await update.mutateAsync({
        attendanceEnabled,
        excusedAbsenceEnabled,
        unexcusedAbsenceThreshold: unexcused,
        excusedAbsenceThreshold: excused,
      });
      toast.success("출결관리 설정을 저장했습니다.");
      setDirty(false);
    } catch (e: any) {
      toast.error(`저장 실패: ${errorReason(e)}`);
    }
  }

  return (
    <Panel className="mt-4">
      <PanelHeader title="출결관리 설정" />
      {/* 순서: 운영구분 방식 → 운영구분 기간 설정 → 결석관리 설정 */}
      {!isLoading && settings && (
        <>
          <OperationCycleModeSection settings={settings} />
          <div className="border-t border-border" />
          <OperationCyclePeriodSection />
          <div className="border-t border-border" />
        </>
      )}
      <div className="space-y-4 px-4 py-4 text-sm">
        {isLoading ? (
          <p className="text-muted-foreground">불러오는 중...</p>
        ) : (
          <>
            <p className="text-muted-foreground">결석관리 설정</p>
            <div className="flex items-center gap-3">
              <span className="w-32 shrink-0 text-muted-foreground">결석관리 사용</span>
              <Switch
                checked={attendanceEnabled}
                onCheckedChange={(v) => {
                  setAttendanceEnabled(v);
                  // 신고결석은 결석관리의 하위 기능 -- 결석관리를 끄면 자동으로 끈다.
                  // 다시 켤 때는 자동으로 켜지 않는다(담당자가 직접 선택).
                  if (!v) setExcusedAbsenceEnabled(false);
                  setDirty(true);
                }}
              />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-32 shrink-0 text-muted-foreground">신고결석 사용</span>
              <Switch
                checked={excusedAbsenceEnabled}
                disabled={!attendanceEnabled}
                onCheckedChange={(v) => {
                  setExcusedAbsenceEnabled(v);
                  setDirty(true);
                }}
              />
            </div>
            <div>
              <p className="mb-2 text-muted-foreground">누적 확인 기준</p>
              <div className="flex flex-wrap items-center gap-4 pl-1">
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">결석(미신고)</span>
                  <input
                    type="number"
                    min={1}
                    className={`${controlCls} w-16`}
                    value={unexcusedThreshold}
                    onChange={(e) => {
                      setUnexcusedThreshold(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <span className="text-muted-foreground">회부터</span>
                </label>
                <label className="flex items-center gap-2">
                  <span className="text-muted-foreground">신고결석</span>
                  <input
                    type="number"
                    min={1}
                    className={`${controlCls} w-16`}
                    value={excusedThreshold}
                    onChange={(e) => {
                      setExcusedThreshold(e.target.value);
                      setDirty(true);
                    }}
                  />
                  <span className="text-muted-foreground">회부터</span>
                </label>
              </div>
              <ul className="mt-2 space-y-0.5 pl-1 text-[13px] text-muted-foreground">
                {[
                  absenceThresholdGuide("결석(미신고)", unexcusedThreshold),
                  absenceThresholdGuide("신고결석", excusedThreshold),
                ]
                  .filter((line): line is string => line !== null)
                  .map((line) => (
                    <li key={line}>{line}</li>
                  ))}
              </ul>
            </div>
            <div>
              <button
                className={btnPrimaryCls}
                disabled={!dirty || update.isPending}
                onClick={save}
              >
                저장
              </button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

// Program Settings Final Design Lock §1/§3/§4: 운영구분 방식(반기제/분기제) +
// 연중 운영구분 추가 여부. "프로그램 운영구분 설정"이라는 별도 큰 영역을
// 만들지 않고 출결관리 설정 Card 안의 하위 설정으로 둔다. 이 값은 이후
// "다음 연도 추가" 시점에만 참조된다 -- 기존 운영연도의 운영구분에는
// 소급 적용되지 않는다(§9).
function OperationCycleModeSection({
  settings,
}: {
  settings: { operationCycleMode: "semester" | "quarter"; includeAnnualCycle: boolean };
}) {
  const update = useUpdateOperationCycleMode();
  const [mode, setMode] = useState(settings.operationCycleMode);
  const [includeAnnual, setIncludeAnnual] = useState(settings.includeAnnualCycle);
  const [dirty, setDirty] = useState(false);

  if (
    !dirty &&
    (mode !== settings.operationCycleMode || includeAnnual !== settings.includeAnnualCycle)
  ) {
    setMode(settings.operationCycleMode);
    setIncludeAnnual(settings.includeAnnualCycle);
  }

  async function save() {
    try {
      const r = await update.mutateAsync({ mode, includeAnnualCycle: includeAnnual });
      // 연도별로 무엇을 했는지 저장 직후에 알려 준다. 방식 변경은 비어 있는
      // 연도만, 연중 추가는 모든 연도, 연중 해제는 비어 있는 연중만.
      const years = (list: number[]) => list.join("·");
      const parts = ["운영구분 방식을 저장했습니다."];
      if (r.appliedYears.length > 0) {
        parts.push(`${years(r.appliedYears)}년 운영구분을 새로 만들었습니다.`);
      }
      if (r.skippedYears.length > 0) {
        parts.push(`${years(r.skippedYears)}년은 이미 프로그램이 등록되어 있어 그대로 두었습니다.`);
      }
      if (r.annualAddedYears.length > 0) {
        parts.push(`${years(r.annualAddedYears)}년에 연중 운영구분을 추가했습니다.`);
      }
      if (r.annualRemovedYears.length > 0) {
        parts.push(`${years(r.annualRemovedYears)}년 연중 운영구분을 없앴습니다.`);
      }
      toast.success(parts.join(" "));
      if (r.annualKeptYears.length > 0) {
        toast.warning(
          `${years(r.annualKeptYears)}년 연중 운영구분에는 프로그램이 있어 없애지 못했습니다. 먼저 해당 프로그램을 정리해 주세요.`,
        );
      }
      setDirty(false);
    } catch (e: any) {
      toast.error(`저장 실패: ${errorReason(e)}`);
    }
  }

  return (
    <div className="space-y-4 px-4 py-4 text-sm">
      <div>
        <p className="mb-2 text-muted-foreground">운영구분 방식</p>
        <RadioGroup
          value={mode}
          onValueChange={(v) => {
            setMode(v as "semester" | "quarter");
            setDirty(true);
          }}
          className="space-y-2 pl-1"
        >
          <label className="flex items-start gap-2">
            <RadioGroupItem value="semester" className="mt-0.5" />
            <span>
              <span className="text-foreground">반기제</span>
              <p className="text-[13px] text-muted-foreground">
                한 해를 상반기와 하반기로 나누어 운영합니다.
              </p>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <RadioGroupItem value="quarter" className="mt-0.5" />
            <span>
              <span className="text-foreground">분기제</span>
              <p className="text-[13px] text-muted-foreground">
                한 해를 1~4분기로 나누어 운영합니다.
              </p>
            </span>
          </label>
        </RadioGroup>
      </div>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={includeAnnual}
          onCheckedChange={(v) => {
            setIncludeAnnual(v === true);
            setDirty(true);
          }}
          className="mt-0.5"
        />
        <span>
          <span className="text-foreground">연중 운영구분 추가</span>
          <p className="text-[13px] text-muted-foreground">
            한 해 전체를 하나의 운영단위로 관리하여 실인원을 연 1회 산정할 프로그램이 있는 경우
            선택합니다.
          </p>
        </span>
      </label>
      <div>
        <button className={btnPrimaryCls} disabled={!dirty || update.isPending} onClick={save}>
          저장
        </button>
      </div>
    </div>
  );
}

// §7-8: 운영구분 기간 설정. 과거 연도를 다시 선택해도 항상 조회 가능하고,
// 수정 가능 여부는 서버가 연결된 업무데이터 기준으로 최종 판단한다(연도가
// 과거냐 현재냐로 클라이언트가 미리 잠그지 않는다).
function OperationCyclePeriodSection() {
  const { data: basic } = useOrganizationBasic();
  const years = basic?.years ?? [];
  const [yearId, setYearId] = useState<string | null>(null);
  const effectiveYearId = yearId ?? years[0]?.id ?? null;
  const { data: cycles, isLoading } = useOperationCycles(effectiveYearId);
  const updateCycle = useUpdateOperationCycle();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [startDraft, setStartDraft] = useState("");
  const [endDraft, setEndDraft] = useState("");
  const [blocked, setBlocked] = useState<BlockedAction>(null);

  function startEdit(c: { id: string; startDate: string; endDate: string }) {
    setEditingId(c.id);
    setStartDraft(c.startDate);
    setEndDraft(c.endDate);
  }

  async function saveEdit(c: { id: string; name: string }) {
    try {
      await updateCycle.mutateAsync({
        id: c.id,
        name: c.name,
        startDate: startDraft,
        endDate: endDraft,
      });
      toast.success("운영기간을 수정했습니다.");
      setEditingId(null);
    } catch (e: any) {
      setBlocked({ title: "운영기간을 수정할 수 없습니다.", reason: errorReason(e) });
    }
  }

  return (
    <div className="px-4 py-4 text-sm">
      <div className="mb-3 flex items-center gap-3">
        <p className="text-muted-foreground">운영구분 기간 설정</p>
        {years.length > 0 && (
          <select
            className="h-8 rounded border border-input bg-card px-2 text-sm"
            value={effectiveYearId ?? ""}
            onChange={(e) => setYearId(e.target.value)}
          >
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {y.year}년
              </option>
            ))}
          </select>
        )}
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">불러오는 중...</p>
      ) : !cycles || cycles.length === 0 ? (
        <p className="text-xs text-muted-foreground">이 연도에 등록된 운영구분이 없습니다.</p>
      ) : (
        <ul className="space-y-2">
          {cycles.map((c) => {
            const label = shortCycleLabel(c.name);
            const isAnnual = label === "연중";
            return (
              <li key={c.id} className="rounded border border-border px-3 py-2">
                {editingId === c.id ? (
                  <div className="space-y-2">
                    <p className="font-medium text-foreground">{label}</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        className={controlCls}
                        value={startDraft}
                        onChange={(e) => setStartDraft(e.target.value)}
                      />
                      <span className="text-muted-foreground">~</span>
                      <input
                        type="date"
                        className={controlCls}
                        value={endDraft}
                        onChange={(e) => setEndDraft(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <button className={btnSecondaryCls} onClick={() => setEditingId(null)}>
                        취소
                      </button>
                      <button
                        className={btnPrimaryCls}
                        disabled={updateCycle.isPending}
                        onClick={() => saveEdit(c)}
                      >
                        저장
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-foreground">{label}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.startDate} ~ {c.endDate}
                      </p>
                    </div>
                    {/* §4: 연중은 원칙적으로 운영연도 전체이므로 기간 수정
                        기능을 제공하지 않아도 된다. */}
                    {!isAnnual && (
                      <button
                        className="shrink-0 text-xs text-primary hover:underline"
                        onClick={() => startEdit(c)}
                      >
                        수정
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <BlockedActionDialog state={blocked} onClose={() => setBlocked(null)} />
    </div>
  );
}
