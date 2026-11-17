import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { btnPrimaryCls } from "@/components/layout/StaffLayout";

// Program Settings Final Design Lock §52: 모든 Action 차단상황에서 raw
// DB/RPC/FK 오류(SQLSTATE, constraint명, UUID, stack trace 등)를 그대로
// 보여주지 않고, "무엇을 할 수 없는지" + "왜 할 수 없는지"를 담은 안내
// Popup을 공통 컴포넌트 하나로 통일해서 보여준다. Toast만 잠깐 띄우고
// 끝내지 않는다.
export type BlockedAction = { title: string; reason: string } | null;

export function BlockedActionDialog({
  state,
  onClose,
}: {
  state: BlockedAction;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!state} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{state?.reason}</p>
        <DialogFooter>
          <button className={btnPrimaryCls} onClick={onClose}>
            확인
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
