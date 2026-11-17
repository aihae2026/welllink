import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { btnPrimaryCls, btnSecondaryCls, controlCls } from "@/components/layout/StaffLayout";
import { useApplyInitialRoster } from "@/lib/programs-data";
import { parsePastedTable } from "@/lib/paste-parse";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

// Manual QA Gap Fix §13-14: 개별 Program의 수강명단은 이제 Excel 파일 업로드가
// 아니라 "엑셀에서 복사 → 붙여넣기"가 기본 방식이다. 이 화면은 프로그램명이
// 이미 확정돼 있으므로 회원번호/성명 두 컬럼만 받는다. 회원번호/성명 두 값만
// 서버로 보낸다 -- 원본을 서버/Storage에 올리지 않고, 다른 열은 애초에 이
// 파싱 단계에서부터 버린다(§14/§27).

type ParsedRow = {
  memberCode: string;
  name: string;
  duplicate: boolean;
  error: string | undefined;
};

const COLUMNS = [
  { key: "member_code", aliases: ["회원번호", "회원코드"] },
  { key: "name", aliases: ["성명"] },
];

function parsePaste(text: string): ParsedRow[] {
  const { rows } = parsePastedTable(text, COLUMNS);
  // 회원번호 -> 처음 나온 성명. 회원번호·성명이 모두 같은 행이 반복되면 단순
  // 중복으로 보고 한 번만 등록한다(누락이 생기지 않는다). 성명이 다르면 오류.
  const seen = new Map<string, string>();
  return rows.map((r) => {
    const memberCode = r["member_code"] ?? "";
    const name = r["name"] ?? "";

    let error: string | undefined;
    let duplicate = false;
    if (!memberCode) error = "회원번호 없음";
    else if (memberCode.length > 40) error = "회원번호가 너무 깁니다(40자 이내).";
    else if (!name) error = "성명 없음";
    else if (!seen.has(memberCode)) seen.set(memberCode, name);
    else if (seen.get(memberCode) === name) duplicate = true;
    else error = "같은 회원번호인데 성명이 다릅니다.";

    return { memberCode, name, duplicate, error };
  });
}

// 최초 수강명단은 "전체 1회 등록"이다. 오류 행이 하나라도 있으면
// 정상 행만 골라 부분등록하지 않는다 -- 일부 수강생이 누락된 채 "최초등록 완료"
// 상태가 되어버리는 데이터 오류를 만들기 때문이다. ERROR가 0건일 때만 전체를 등록한다.
// 단순 중복 행은 오류가 아니다 -- 같은 사람이 이미 한 번 들어가므로 빼고 등록한다.
export function InitialRosterDialog({
  open,
  onOpenChange,
  operationTermId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  operationTermId: string;
}) {
  const [pasteText, setPasteText] = useState("");
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const apply = useApplyInitialRoster();

  const errorRows = (rows ?? []).filter((r) => r.error);
  const errorCount = errorRows.length;
  const duplicateCount = (rows ?? []).filter((r) => r.duplicate).length;
  const registerRows = (rows ?? []).filter((r) => !r.error && !r.duplicate);
  const canRegister = registerRows.length > 0 && errorCount === 0;

  const close = () => {
    onOpenChange(false);
    setPasteText("");
    setRows(null);
  };

  const check = () => {
    setRows(parsePaste(pasteText));
  };

  const submit = async () => {
    if (!canRegister) return;
    try {
      const [applied] = await apply.mutateAsync({
        operationTermId,
        rows: registerRows.map((r) => ({ member_code: r.memberCode, name: r.name })),
        idempotencyKey: `${operationTermId}:${pasteText.length}:${registerRows.length}:${Date.now()}`,
      });
      toast.success(
        `수강명단 ${applied?.participant_count ?? registerRows.length}명이 등록되었습니다.`,
      );
      close();
    } catch (e: any) {
      toast.error(`등록 실패: ${errorReason(e)}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>수강명단 붙여넣기</DialogTitle>
          <DialogDescription>
            엑셀에서 회원번호와 성명을 복사해 붙여넣으면 이 프로그램 수강명단으로 등록합니다.
            회원번호와 성명만 반영하며, 다른 열은 저장하지 않습니다. 이 프로그램의 최초 등록은 한
            번만 가능합니다. 확인이 필요한 행이 하나라도 있으면 전체 등록이 차단됩니다.
          </DialogDescription>
          <p className="text-[13px] text-status-warn-fg">
            회원번호가 기존 회원과 같으면 그 회원의 성명이 붙여넣은 성명으로 바뀝니다. 회원번호를
            다시 확인해 주세요.
          </p>
        </DialogHeader>

        <textarea
          className={`${controlCls} h-32 resize-y font-mono text-xs`}
          placeholder={"회원번호\t성명\n00123\t홍길동\nA-1034\t김영희"}
          value={pasteText}
          onChange={(e) => {
            setPasteText(e.target.value);
            setRows(null);
          }}
        />
        <div>
          <button className={btnSecondaryCls} onClick={check} disabled={!pasteText.trim()}>
            내용 확인
          </button>
        </div>

        {rows && (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              전체 {rows.length}명 · 정상 {registerRows.length}명
              {duplicateCount > 0 && ` · 중복 제외 ${duplicateCount}명`} · 확인 필요 {errorCount}명
            </p>
            {duplicateCount > 0 && (
              <p className="text-[13px] text-muted-foreground">
                회원번호·성명이 같은 {duplicateCount}행은 한 번만 등록합니다.
              </p>
            )}
            {errorCount > 0 ? (
              <>
                <p className="font-medium text-status-danger-fg">
                  확인이 필요한 행이 있어 등록할 수 없습니다. 수정해서 다시 붙여넣어 주세요.
                </p>
                <div className="max-h-56 overflow-y-auto rounded border border-status-danger-border bg-status-danger-bg">
                  <table className="w-full table-fixed text-xs">
                    <colgroup>
                      <col className="w-32" />
                      <col className="w-24" />
                      <col />
                    </colgroup>
                    <tbody>
                      {errorRows.map((r, i) => (
                        <tr
                          key={i}
                          className="border-b border-status-danger-border/50 last:border-0"
                        >
                          <td className="px-2 py-1.5">{r.memberCode || "-"}</td>
                          <td className="px-2 py-1.5">{r.name || "-"}</td>
                          <td className="px-2 py-1.5 text-status-danger-fg">{r.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="text-status-success-fg">
                모든 행이 정상입니다. 등록 버튼을 눌러 전체를 등록해 주세요.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <button onClick={close} className={btnSecondaryCls}>
            닫기
          </button>
          <button
            onClick={submit}
            disabled={!canRegister || apply.isPending}
            className={btnPrimaryCls}
          >
            {rows ? `${registerRows.length}명 등록` : "등록"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
