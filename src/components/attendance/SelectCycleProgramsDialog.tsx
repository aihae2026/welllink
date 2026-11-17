import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { btnPrimaryCls, btnSecondaryCls } from "@/components/layout/StaffLayout";
import { useSelectableProgramsForCycle, useAddOperationCyclePrograms } from "@/lib/programs-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

// Manual QA Gap Fix §2-3: 운영구분을 생성한다고 전체 Program이 자동으로
// 포함되지 않는다. 실제 운영할 Program만 여기서 선택한다 -- 선택하지 않은
// Program에는 운영정보/회차를 만들지 않는다.
export function SelectCycleProgramsDialog({
  open,
  onOpenChange,
  operationCycleId,
  cycleLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  operationCycleId: string;
  cycleLabel: string;
}) {
  const { data: selectable, isLoading } = useSelectableProgramsForCycle(
    open ? operationCycleId : null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const add = useAddOperationCyclePrograms();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allIds = selectable?.map((p) => p.programId) ?? [];
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = !allSelected && allIds.some((id) => selected.has(id));

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(allIds));
  }

  function close() {
    onOpenChange(false);
    setSelected(new Set());
  }

  async function submit() {
    if (selected.size === 0) return;
    try {
      const n = await add.mutateAsync({
        operationCycleId,
        programIds: [...selected],
      });
      toast.success(`프로그램 ${n}개를 이 운영구분에 추가했습니다.`);
      close();
    } catch (e: any) {
      toast.error(`추가 실패: ${errorReason(e)}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[80vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{cycleLabel}에 운영할 프로그램 선택</DialogTitle>
          <DialogDescription>
            {cycleLabel}에서 운영할 프로그램을 선택하세요. 운영설정 &gt; 사업·활동 관리에 등록된
            출석연동 활동을 불러옵니다.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {isLoading && <p className="p-3 text-sm text-muted-foreground">불러오는 중...</p>}
          {!isLoading && (selectable?.length ?? 0) === 0 && (
            <p className="p-3 text-sm text-muted-foreground">
              추가할 수 있는 프로그램이 없습니다. 이미 전부 선택되었거나, 사업·활동 관리에서 먼저
              출석연동 활동을 등록해 주세요.
            </p>
          )}
          {allIds.length > 0 && (
            <label className="flex items-center gap-2 border-b px-2 pb-2 pt-1.5 text-sm font-medium hover:bg-muted/60">
              <input
                type="checkbox"
                className="size-4"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={toggleAll}
              />
              전체 선택
              <span className="font-normal text-muted-foreground">
                ({selected.size}/{allIds.length})
              </span>
            </label>
          )}
          {selectable?.map((p) => (
            <label
              key={p.programId}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60"
            >
              <input
                type="checkbox"
                className="size-4"
                checked={selected.has(p.programId)}
                onChange={() => toggle(p.programId)}
              />
              {p.name}
            </label>
          ))}
        </div>

        <DialogFooter>
          <button className={btnSecondaryCls} onClick={close}>
            닫기
          </button>
          <button
            className={btnPrimaryCls}
            disabled={selected.size === 0 || add.isPending}
            onClick={submit}
          >
            선택한 프로그램 가져오기
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
