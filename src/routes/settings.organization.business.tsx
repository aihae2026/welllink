import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { OrgSettingsTabs } from "@/components/layout/OrgSettingsTabs";
import {
  DIRECT_ENTRY_BADGE_CLS,
  TREE_INDENT,
  TREE_LEVEL_CLS,
  TREE_MAJOR_SECTION_CLS,
  TREE_ROW_BG_CLS,
  TREE_UNIT_SECTION_CLS,
} from "@/lib/business-tree-visual";
import { useAuth } from "@/lib/auth";
import {
  useBusinessStructure,
  useCreateActivity,
  useCreateBusinessNode,
  useCreateUnitBusiness,
  useDeleteActivity,
  useDeleteBusinessNode,
  useDeleteUnitBusiness,
  useOrganizationBasic,
  useUpdateActivity,
  useUpdateBusinessNode,
  useUpdateUnitBusiness,
} from "@/lib/org-settings-data";
import { normalizeBusinessTreeForUi, groupTreeByUnitBusiness } from "@/lib/business-tree-normalize";
import { BusinessStructureExcelDialog } from "@/components/management/BusinessStructureExcelDialog";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

export const Route = createFileRoute("/settings/organization/business")({
  head: () => ({ meta: [{ title: "사업·활동 관리 — WellLink" }] }),
  component: BusinessStructurePage,
});

type DeleteTarget = { kind: "unit" | "node" | "activity"; id: string; name: string };

// 단위사업 선택의 "전체" 값 -- 실제 단위사업 id(uuid)와 겹치지 않는다.
const ALL_UNITS = "__all__";

// Manual QA Gap Fix §6: 사업구조 화면 전체에서 추가/수정 Editor는 한 번에
// 1개만 연다. 새 Editor를 열면 기존 Editor는 닫는다(미저장 입력이 있으면
// 최소한의 확인을 거친다 -- §6).
type EditorState =
  | { type: "addUnit" }
  | {
      type: "addNode";
      parentId: string | null;
      uiLevel: "대분류" | "중분류";
      unitBusinessId: string | undefined;
    }
  | { type: "addActivity"; middleId: string }
  | { type: "renameUnit"; id: string }
  | { type: "renameNode"; id: string }
  | { type: "renameActivity"; id: string }
  | null;

function BusinessStructurePage() {
  const { staffProfile } = useAuth();
  const canAccess = staffProfile?.businessRole === "global_manager";
  const { data: basic } = useOrganizationBasic();
  const [yearId, setYearId] = useState<string | null>(null);
  const activeYearId = yearId ?? basic?.years[0]?.id ?? null;
  const [selectedUnitId, setSelectedUnitId] = useState<string>(ALL_UNITS);
  const [excelOpen, setExcelOpen] = useState(false);

  const { data, isLoading } = useBusinessStructure(activeYearId);
  const createNode = useCreateBusinessNode();
  const updateNode = useUpdateBusinessNode();
  const deleteNode = useDeleteBusinessNode();
  const createActivity = useCreateActivity();
  const updateActivity = useUpdateActivity();
  const deleteActivity = useDeleteActivity();
  const createUnit = useCreateUnitBusiness();
  const updateUnit = useUpdateUnitBusiness();
  const deleteUnit = useDeleteUnitBusiness();

  const tree = useMemo(
    () =>
      normalizeBusinessTreeForUi(
        data?.nodes ?? [],
        (data?.activities ?? []).map((a) => ({ ...a, businessNodeId: a.business_node_id })),
      ),
    [data],
  );
  const majorUnitBusinessId = useMemo(() => {
    const map: Record<string, string> = {};
    (data?.nodes ?? []).forEach((n) => {
      if (n.node_type === "major") map[n.id] = n.unit_business_id;
    });
    return map;
  }, [data]);
  const unitTree = useMemo(
    () => groupTreeByUnitBusiness(data?.units ?? [], tree, majorUnitBusinessId),
    [data, tree, majorUnitBusinessId],
  );
  const showAllUnits = selectedUnitId === ALL_UNITS;
  const activeUnit = showAllUnits
    ? null
    : (unitTree.find((u) => u.id === selectedUnitId) ?? unitTree[0] ?? null);
  const visibleUnits = showAllUnits ? unitTree : activeUnit ? [activeUnit] : [];

  const [editor, setEditor] = useState<EditorState>(null);
  const [editorOriginal, setEditorOriginal] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [activityName, setActivityName] = useState("");
  const [activityMethod, setActivityMethod] = useState<"attendance" | "summary">("attendance");
  const [unitName, setUnitName] = useState("");
  const [renameUnitDraft, setRenameUnitDraft] = useState("");
  const [renameNodeDraft, setRenameNodeDraft] = useState("");
  const [renameActivityDraft, setRenameActivityDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [collapsedMiddles, setCollapsedMiddles] = useState<Record<string, boolean>>({});

  function hasUnsavedDraft(): boolean {
    if (!editor) return false;
    switch (editor.type) {
      case "addUnit":
        return unitName.trim() !== "";
      case "addNode":
        return nodeName.trim() !== "";
      case "addActivity":
        return activityName.trim() !== "";
      case "renameUnit":
        return renameUnitDraft.trim() !== editorOriginal.trim();
      case "renameNode":
        return renameNodeDraft.trim() !== editorOriginal.trim();
      case "renameActivity":
        return renameActivityDraft.trim() !== editorOriginal.trim();
    }
  }

  // 다른 Editor를 새로 열 때 호출한다. 미저장 입력값이 있으면 최소 확인을
  // 거친다(§6) -- 취소 버튼은 명시적 폐기 의도이므로 이 확인 없이 바로
  // setEditor(null)을 호출한다. prepareDraft는 전환이 실제로 승인된 뒤에만
  // 실행한다 -- 먼저 draft 상태를 지워버리면, 사용자가 확인창에서 "취소"를
  // 눌러 기존 Editor를 계속 쓰려 해도 입력값이 이미 사라져 있는 문제가 있었다.
  function openEditor(next: EditorState, prepareDraft?: () => void) {
    if (hasUnsavedDraft() && !window.confirm("작성 중인 내용을 저장하지 않고 닫을까요?")) {
      return;
    }
    prepareDraft?.();
    setEditor(next);
  }

  function openAddUnit() {
    openEditor({ type: "addUnit" }, () => setUnitName(""));
  }
  function openAddNode(
    parentId: string | null,
    uiLevel: "대분류" | "중분류",
    unitBusinessId?: string,
  ) {
    openEditor({ type: "addNode", parentId, uiLevel, unitBusinessId }, () => setNodeName(""));
  }
  function openAddActivity(middleId: string) {
    openEditor({ type: "addActivity", middleId }, () => {
      setActivityName("");
      setActivityMethod("attendance");
    });
  }
  function openRenameUnit(id: string, name: string) {
    openEditor({ type: "renameUnit", id }, () => {
      setRenameUnitDraft(name);
      setEditorOriginal(name);
    });
  }
  function openRenameNode(id: string, name: string) {
    openEditor({ type: "renameNode", id }, () => {
      setRenameNodeDraft(name);
      setEditorOriginal(name);
    });
  }
  function openRenameActivity(id: string, name: string) {
    openEditor({ type: "renameActivity", id }, () => {
      setRenameActivityDraft(name);
      setEditorOriginal(name);
    });
  }

  async function submitNode() {
    if (editor?.type !== "addNode" || !activeYearId || !nodeName.trim()) return;
    const nodeType = editor.uiLevel === "대분류" ? "major" : "middle";
    try {
      await createNode.mutateAsync({
        businessYearId: activeYearId,
        parentId: editor.parentId,
        nodeType,
        name: nodeName.trim(),
        unitBusinessId: editor.unitBusinessId,
      });
      toast.success("추가했습니다.");
      setEditor(null);
      setNodeName("");
    } catch (e: any) {
      toast.error(`추가 실패: ${errorReason(e)}`);
    }
  }

  async function submitActivity() {
    if (editor?.type !== "addActivity" || !activeYearId || !activityName.trim()) return;
    try {
      await createActivity.mutateAsync({
        businessYearId: activeYearId,
        businessNodeId: editor.middleId,
        name: activityName.trim(),
        defaultPerformanceMethod: activityMethod,
      });
      toast.success("활동을 추가했습니다.");
      setEditor(null);
      setActivityName("");
    } catch (e: any) {
      // activities는 사업연도 안에서 이름이 unique -- DB 제약 위반 원문 대신 안내한다.
      const msg = String(e.message ?? "").includes("activities_business_year_id_name_key")
        ? "같은 사업연도에 같은 이름의 활동이 이미 있습니다."
        : errorReason(e);
      toast.error(`추가 실패: ${msg}`);
    }
  }

  async function submitUnit() {
    if (!activeYearId || !unitName.trim()) return;
    try {
      const newUnitId = await createUnit.mutateAsync({
        businessYearId: activeYearId,
        name: unitName.trim(),
      });
      toast.success("단위사업을 추가했습니다.");
      setEditor(null);
      setUnitName("");
      setSelectedUnitId(newUnitId);
    } catch (e: any) {
      toast.error(`추가 실패: ${errorReason(e)}`);
    }
  }

  async function saveUnitRename(id: string) {
    if (!renameUnitDraft.trim()) return;
    try {
      await updateUnit.mutateAsync({ id, name: renameUnitDraft.trim() });
      toast.success("단위사업 이름을 수정했습니다.");
      setEditor(null);
    } catch (e: any) {
      toast.error(`수정 실패: ${errorReason(e)}`);
    }
  }

  async function toggleNodeActive(n: { id: string; name: string; isActive: boolean }) {
    try {
      await updateNode.mutateAsync({ id: n.id, name: n.name, isActive: !n.isActive });
    } catch (e: any) {
      toast.error(`변경 실패: ${errorReason(e)}`);
    }
  }

  async function saveNodeRename(n: { id: string; isActive: boolean }) {
    if (!renameNodeDraft.trim()) return;
    try {
      await updateNode.mutateAsync({
        id: n.id,
        name: renameNodeDraft.trim(),
        isActive: n.isActive,
      });
      toast.success("이름을 수정했습니다.");
      setEditor(null);
    } catch (e: any) {
      toast.error(`수정 실패: ${errorReason(e)}`);
    }
  }

  async function toggleActivityActive(a: { id: string; name: string; is_active: boolean }) {
    try {
      await updateActivity.mutateAsync({ id: a.id, name: a.name, isActive: !a.is_active });
    } catch (e: any) {
      toast.error(`변경 실패: ${errorReason(e)}`);
    }
  }

  async function saveActivityRename(a: { id: string; is_active: boolean }) {
    if (!renameActivityDraft.trim()) return;
    try {
      await updateActivity.mutateAsync({
        id: a.id,
        name: renameActivityDraft.trim(),
        isActive: a.is_active,
      });
      toast.success("이름을 수정했습니다.");
      setEditor(null);
    } catch (e: any) {
      toast.error(`수정 실패: ${errorReason(e)}`);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.kind === "unit") await deleteUnit.mutateAsync(deleteTarget.id);
      else if (deleteTarget.kind === "node") await deleteNode.mutateAsync(deleteTarget.id);
      else await deleteActivity.mutateAsync(deleteTarget.id);
      toast.success(`"${deleteTarget.name}"을(를) 삭제했습니다.`);
      setDeleteTarget(null);
    } catch (e: any) {
      toast.error(`삭제 실패: ${errorReason(e)}`);
      setDeleteTarget(null);
    }
  }

  if (staffProfile && !canAccess) {
    return (
      <StaffLayout title="운영설정">
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">이 화면은 관리자만 접근할 수 있습니다.</p>
        </Panel>
      </StaffLayout>
    );
  }

  return (
    <StaffLayout title="운영설정">
      <OrgSettingsTabs active="business" />
      <p className="mb-1 text-sm text-muted-foreground">기관의 사업구조를 구성하고 관리합니다.</p>
      {/* Manual QA Gap Fix §4: 사업구조 계층을 짧은 breadcrumb로 안내한다(긴 설명 없이). */}
      <p className="mb-4 text-[13px] text-muted-foreground">
        <span className="font-medium text-foreground/80">
          단위사업 〉 대분류 〉 중분류 〉 소분류(활동)
        </span>{" "}
        — 위 순서대로 기관의 사업구조를 구성합니다.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className={controlCls}
          value={activeYearId ?? ""}
          onChange={(e) => setYearId(e.target.value)}
        >
          {basic?.years.map((y) => (
            <option key={y.id} value={y.id}>
              {y.year}년
            </option>
          ))}
        </select>
        {unitTree.length > 0 && (
          <select
            className={controlCls}
            value={showAllUnits ? ALL_UNITS : (activeUnit?.id ?? "")}
            onChange={(e) => setSelectedUnitId(e.target.value)}
          >
            <option value={ALL_UNITS}>단위사업 전체</option>
            {unitTree.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        )}
        {/* WellLink Business Structure UX Simplification: 신규 사업구조 생성은
            Excel 등록으로만 받는다 -- "+ 단위사업 추가" 개별 입력 버튼은 숨김
            (기존 데이터 조회/수정/삭제 및 백엔드 RPC는 그대로 유지). */}
        <button className={`${btnPrimaryCls} ml-auto`} onClick={() => setExcelOpen(true)}>
          Excel로 사업구조 등록
        </button>
      </div>

      <Panel>
        <PanelHeader title="사업구조" />
        <div className="px-4 py-3 text-sm">
          {isLoading && <p className="text-muted-foreground">불러오는 중...</p>}
          {!isLoading && unitTree.length === 0 && (
            <p className="text-muted-foreground">
              등록된 단위사업이 없습니다. 위 "Excel로 사업구조 등록"으로 먼저 등록해 주세요.
            </p>
          )}
          {visibleUnits.map((unit) => (
            <div key={unit.id} className={TREE_UNIT_SECTION_CLS}>
              <div
                className="flex items-center justify-between py-1.5 pr-2"
                style={{ paddingLeft: TREE_INDENT.unit }}
              >
                {editor?.type === "renameUnit" && editor.id === unit.id ? (
                  <span className="flex items-center gap-1.5">
                    <input
                      className={`${controlCls} w-40`}
                      value={renameUnitDraft}
                      onChange={(e) => setRenameUnitDraft(e.target.value)}
                      autoFocus
                    />
                    <button
                      className="text-xs text-primary hover:underline"
                      onClick={() => saveUnitRename(unit.id)}
                    >
                      저장
                    </button>
                    <button
                      className="text-xs text-muted-foreground hover:underline"
                      onClick={() => setEditor(null)}
                    >
                      취소
                    </button>
                  </span>
                ) : (
                  <span className={TREE_LEVEL_CLS.unit}>{unit.name}</span>
                )}
                {!(editor?.type === "renameUnit" && editor.id === unit.id) && (
                  <MoreMenu
                    onRename={() => openRenameUnit(unit.id, unit.name)}
                    onDelete={() => setDeleteTarget({ kind: "unit", id: unit.id, name: unit.name })}
                  />
                )}
              </div>
              {unit.majors.length === 0 ? (
                <p
                  className="pt-1 text-xs text-muted-foreground"
                  style={{ paddingLeft: TREE_INDENT.major }}
                >
                  등록된 대분류가 없습니다.
                </p>
              ) : (
                unit.majors.map((maj) => (
                  <div key={maj.id} className={TREE_MAJOR_SECTION_CLS}>
                    <div
                      className={`flex items-center justify-between rounded py-1.5 pr-2 ${TREE_ROW_BG_CLS.major}`}
                      style={{ paddingLeft: TREE_INDENT.major }}
                    >
                      {editor?.type === "renameNode" && editor.id === maj.id ? (
                        <span className="flex items-center gap-1.5">
                          <input
                            className={`${controlCls} w-40`}
                            value={renameNodeDraft}
                            onChange={(e) => setRenameNodeDraft(e.target.value)}
                            autoFocus
                          />
                          <button
                            className="text-xs text-primary hover:underline"
                            onClick={() => saveNodeRename(maj)}
                          >
                            저장
                          </button>
                          <button
                            className="text-xs text-muted-foreground hover:underline"
                            onClick={() => setEditor(null)}
                          >
                            취소
                          </button>
                        </span>
                      ) : (
                        <span
                          className={`${TREE_LEVEL_CLS.major} ${
                            maj.isActive ? "" : "text-muted-foreground line-through"
                          }`}
                        >
                          {maj.name}
                        </span>
                      )}
                      {!(editor?.type === "renameNode" && editor.id === maj.id) && (
                        <MoreMenu
                          onRename={() => openRenameNode(maj.id, maj.name)}
                          onDelete={() =>
                            setDeleteTarget({ kind: "node", id: maj.id, name: maj.name })
                          }
                          onToggle={() => toggleNodeActive(maj)}
                          toggleLabel={maj.isActive ? "비활성화" : "활성화"}
                        />
                      )}
                    </div>
                    {maj.middles.map((mid) => {
                      const isCollapsed = collapsedMiddles[mid.id] ?? true;
                      return (
                        <div key={mid.id}>
                          <div
                            className={`flex items-center justify-between rounded py-1.5 pr-2 ${TREE_ROW_BG_CLS.middle}`}
                            style={{ paddingLeft: TREE_INDENT.middle }}
                          >
                            <button
                              type="button"
                              className="flex items-center gap-1.5 text-left"
                              onClick={() =>
                                setCollapsedMiddles((p) => ({ ...p, [mid.id]: !isCollapsed }))
                              }
                            >
                              <span className="text-xs text-muted-foreground">
                                {isCollapsed ? "▸" : "▾"}
                              </span>
                              {editor?.type === "renameNode" && editor.id === mid.id ? (
                                <input
                                  className={`${controlCls} w-40`}
                                  value={renameNodeDraft}
                                  onChange={(e) => setRenameNodeDraft(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  autoFocus
                                />
                              ) : (
                                <span
                                  className={`${TREE_LEVEL_CLS.middle} ${
                                    mid.isActive ? "" : "text-muted-foreground line-through"
                                  }`}
                                >
                                  {mid.name}
                                </span>
                              )}
                              <span className="text-xs text-muted-foreground">
                                ({mid.activities.length})
                              </span>
                            </button>
                            {editor?.type === "renameNode" && editor.id === mid.id ? (
                              <span className="flex items-center gap-2">
                                <button
                                  className="text-xs text-primary hover:underline"
                                  onClick={() => saveNodeRename(mid)}
                                >
                                  저장
                                </button>
                                <button
                                  className="text-xs text-muted-foreground hover:underline"
                                  onClick={() => setEditor(null)}
                                >
                                  취소
                                </button>
                              </span>
                            ) : (
                              <MoreMenu
                                onRename={() => openRenameNode(mid.id, mid.name)}
                                onDelete={() =>
                                  setDeleteTarget({ kind: "node", id: mid.id, name: mid.name })
                                }
                                onToggle={() => toggleNodeActive(mid)}
                                toggleLabel={mid.isActive ? "비활성화" : "활성화"}
                              />
                            )}
                          </div>
                          {!isCollapsed && (
                            <>
                              {mid.activities.map((a) => (
                                <div
                                  key={a.id}
                                  className="flex items-center justify-between py-1 pr-2 hover:bg-muted/60"
                                  style={{ paddingLeft: TREE_INDENT.activity }}
                                >
                                  {editor?.type === "renameActivity" && editor.id === a.id ? (
                                    <span className="flex flex-col gap-1 py-0.5">
                                      <span className="flex items-center gap-1.5">
                                        <input
                                          className={`${controlCls} w-40`}
                                          value={renameActivityDraft}
                                          onChange={(e) => setRenameActivityDraft(e.target.value)}
                                          autoFocus
                                        />
                                        <button
                                          className="text-xs text-primary hover:underline"
                                          onClick={() => saveActivityRename(a)}
                                        >
                                          저장
                                        </button>
                                        <button
                                          className="text-xs text-muted-foreground hover:underline"
                                          onClick={() => setEditor(null)}
                                        >
                                          취소
                                        </button>
                                      </span>
                                      {/* 출석(강사 제출·확정)이나 실적 기록이 있는 활동은
                                            서버(update_activity)가 이름 변경을 거부한다 -- 지난
                                            기록의 이름까지 바뀌기 때문. 기록 전이면 허용된다. */}
                                      <span className="text-xs text-muted-foreground">
                                        이름을 바꾸면 프로그램명도 함께 바뀝니다. 이미 출석이나 실적
                                        기록이 있는 활동은 이름을 바꿀 수 없으니, 이름이 바뀐
                                        프로그램은 "+ 활동 추가"로 새 활동을 추가해 주세요.
                                      </span>
                                    </span>
                                  ) : (
                                    <>
                                      <span className="flex items-center">
                                        <span
                                          className={`${TREE_LEVEL_CLS.activity} ${
                                            a.is_active ? "" : "text-muted-foreground line-through"
                                          }`}
                                        >
                                          {a.name}
                                        </span>
                                        {a.default_performance_method === "summary" && (
                                          <span className={DIRECT_ENTRY_BADGE_CLS}>직접 등록</span>
                                        )}
                                      </span>
                                      <MoreMenu
                                        onRename={() => openRenameActivity(a.id, a.name)}
                                        onDelete={() =>
                                          setDeleteTarget({
                                            kind: "activity",
                                            id: a.id,
                                            name: a.name,
                                          })
                                        }
                                        onToggle={() => toggleActivityActive(a)}
                                        toggleLabel={a.is_active ? "비활성화" : "활성화"}
                                      />
                                    </>
                                  )}
                                </div>
                              ))}
                              {/* 단위사업/대분류/중분류 개별 추가는 계속 Excel 등록으로만
                                    받는다. 활동만 개별 추가를 연다 -- 이름이 바뀐 프로그램은
                                    기존 활동 이름을 고치지 않고 새 활동으로 등록하기 때문. */}
                              {editor?.type === "addActivity" && editor.middleId === mid.id ? (
                                <InlineAddEditor
                                  label="활동 이름"
                                  indent={TREE_INDENT.activity}
                                  value={activityName}
                                  onChange={setActivityName}
                                  onSave={submitActivity}
                                  onCancel={() => setEditor(null)}
                                  saving={createActivity.isPending}
                                  extra={
                                    <select
                                      className={controlCls}
                                      value={activityMethod}
                                      onChange={(e) =>
                                        setActivityMethod(
                                          e.target.value as "attendance" | "summary",
                                        )
                                      }
                                    >
                                      <option value="attendance">출석연동</option>
                                      <option value="summary">직접 등록</option>
                                    </select>
                                  }
                                />
                              ) : (
                                <div className="py-1" style={{ paddingLeft: TREE_INDENT.activity }}>
                                  <button
                                    type="button"
                                    className="text-xs text-primary hover:underline"
                                    onClick={() => openAddActivity(mid.id)}
                                  >
                                    + 활동 추가
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>"{deleteTarget?.name}"을(를) 삭제할까요?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            하위에 연결된 사업·활동 또는 운영 데이터가 있으면 삭제할 수 없습니다.
          </p>
          <DialogFooter>
            <button className={btnSecondaryCls} onClick={() => setDeleteTarget(null)}>
              닫기
            </button>
            <button
              className={btnDangerCls}
              disabled={deleteUnit.isPending || deleteNode.isPending || deleteActivity.isPending}
              onClick={confirmDelete}
            >
              {deleteUnit.isPending || deleteNode.isPending || deleteActivity.isPending
                ? "처리 중…"
                : "삭제"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BusinessStructureExcelDialog
        open={excelOpen}
        onOpenChange={setExcelOpen}
        businessYearId={activeYearId}
      />
    </StaffLayout>
  );
}

// Manual QA Gap Fix §7: 행마다 반복되던 "수정/삭제/비활성화" 텍스트 나열을
// "…" More menu 하나로 통합한다. onToggle이 없으면(단위사업) 활성화/비활성화
// 항목 자체를 만들지 않는다 -- 단위사업에는 그 개념이 없다.
function MoreMenu({
  onRename,
  onDelete,
  onToggle,
  toggleLabel,
}: {
  onRename: () => void;
  onDelete: () => void;
  onToggle?: () => void;
  toggleLabel?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="더 보기"
        >
          <MoreHorizontal className="size-4" strokeWidth={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        <DropdownMenuItem onSelect={onRename}>수정</DropdownMenuItem>
        {onToggle && <DropdownMenuItem onSelect={onToggle}>{toggleLabel}</DropdownMenuItem>}
        <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
          삭제
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Manual QA Gap Fix §5: 추가하려는 부모 바로 아래에, 해당 레벨만큼 indent해
// inline Editor를 표시한다(Tree와 떨어진 상단 공용 영역이 아니라).
function InlineAddEditor({
  label,
  indent,
  value,
  onChange,
  onSave,
  onCancel,
  saving,
  extra,
}: {
  label: string;
  indent: number;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  extra?: ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 py-1.5 pr-2 text-sm"
      style={{ paddingLeft: indent }}
    >
      <input
        className={controlCls}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
      />
      {extra}
      <button className={btnPrimaryCls} onClick={onSave} disabled={saving}>
        저장
      </button>
      <button className={btnSecondaryCls} onClick={onCancel}>
        취소
      </button>
    </div>
  );
}
