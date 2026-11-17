import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { activityOptions, reloadNeedsCheck } from "@/lib/mock-data";

export function ReloadProgramInfoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  // 화면 확인용 표시 상태만 사용한다. 실제 파일 파싱·저장은 수행하지 않는다.
  const [fileName, setFileName] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>프로그램 정보 다시 불러오기</DialogTitle>
          <DialogDescription>
            변경된 프로그램 정보는 다음 운영구분 생성 시 기본정보로 사용됩니다. 이미 생성된
            운영구분의 회차에는 반영되지 않습니다.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded border border-dashed border-border px-4 py-5 text-sm">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setFileName("프로그램정보_2026하반기.xlsx")}
              className="rounded border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
            >
              파일 선택
            </button>
            <span className="text-muted-foreground">{fileName ?? "선택된 파일 없음"}</span>
          </div>
        </div>

        {fileName && (
          <>
            <div className="flex gap-2">
              <StatusBadge label="자동연결 28개" tone="success" />
              <StatusBadge label="확인필요 2개" tone="warn" />
            </div>
            <div className="rounded border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">파일 프로그램명</th>
                    <th className="px-3 py-2 font-medium">연결할 활동</th>
                    <th className="px-3 py-2 font-medium">상태</th>
                  </tr>
                </thead>
                <tbody>
                  {reloadNeedsCheck.map((r) => (
                    <tr key={r.file} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 text-foreground">{r.file}</td>
                      <td className="px-3 py-2">
                        <select
                          defaultValue=""
                          className="rounded border border-input bg-card px-2 py-1 text-sm"
                        >
                          <option value="" disabled>
                            활동 선택
                          </option>
                          {activityOptions.map((a) => (
                            <option key={a}>{a}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge label={r.status} tone="warn" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[13px] text-muted-foreground">
              활동명이 파일과 완전히 같으면 자동으로 연결되고, 다르면 연결할 활동을 직접 선택합니다.
            </p>
          </>
        )}

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
          >
            닫기
          </button>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            적용
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
