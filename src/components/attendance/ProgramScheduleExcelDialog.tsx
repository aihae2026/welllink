import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { btnPrimaryCls, btnSecondaryCls } from "@/components/layout/StaffLayout";
import { useUpsertOperationTermForCycle, type CycleProgramStatusRow } from "@/lib/programs-data";
import { useInstructorAccounts } from "@/lib/user-management-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

// Program Operations Redesign § Step 2: Excel First. 화면에서 29개를 직접 입력하는
// 긴 표를 주 workflow로 쓰지 않는다 -- 템플릿 다운로드 -> 작성 -> 업로드 -> Preview
// (오류 우선 표시) -> 적용의 순서로만 진행한다.
// Manual QA Gap Fix §19: 주 2회 이상(예: 월,목) 운영을 지원한다 -- 요일 컬럼을
// 쉼표로 구분된 복수값으로 받는다(DB weekdays[]는 이미 배열이었다 -- 이 화면이
// 1개로 제한하던 것만 푼다).

const WEEKDAY_TO_NUM: Record<string, number> = {
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
  일: 7,
};
const NUM_TO_WEEKDAY: Record<number, string> = {
  1: "월",
  2: "화",
  3: "수",
  4: "목",
  5: "금",
  6: "토",
  7: "일",
};

// "월,목" / "월, 목" / "월" 모두 허용. 하나라도 못 알아보는 요일이 있으면
// 전체를 무효로 처리한다(부분 인식으로 얼버무리지 않는다).
function parseWeekdays(label: string): number[] | null {
  const parts = label
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = WEEKDAY_TO_NUM[part];
    if (!n) return null;
    if (!nums.includes(n)) nums.push(n);
  }
  return nums.sort((a, b) => a - b);
}

type ParsedRow = {
  programName: string;
  programId: string | null;
  weekdayLabel: string;
  weekdays: number[] | null;
  startTime: string | null;
  endTime: string | null;
  instructorName: string;
  instructorId: string | null;
  // Manual QA Gap Fix §6-7: 등록 강사와 정확히 1명 매칭되지 않으면(0명 또는
  // 2명 이상) 이 이름을 텍스트로 그대로 저장한다 -- 강사 미등록을 이유로 행을
  // 오류 처리하지 않는다(§7). 2명 이상(동명이인)만 "확인 필요"로 막는다.
  instructorNameText: string | null;
  error: string | undefined;
};

function normalizeTime(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  // Excel 시간 셀은 숫자(일의 소수 부분)로 올 수도, "10:00" 문자열로 올 수도 있다.
  if (typeof raw === "number") {
    const totalMinutes = Math.round(raw * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  const s = String(raw).trim();
  const match = s.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function downloadTemplate(programs: CycleProgramStatusRow[]) {
  const header = ["프로그램명", "요일", "시작시간", "종료시간", "강사"];
  const rows = programs.map((p) => [
    p.name,
    p.weekdays.length > 0 ? p.weekdays.map((w) => NUM_TO_WEEKDAY[w] ?? "").join(",") : "",
    p.startTime ? p.startTime.slice(0, 5) : "",
    p.endTime ? p.endTime.slice(0, 5) : "",
    // 계정이 없는 강사도 이름을 그대로 내보낸다 -- 빈 칸으로 나가면 그대로 올렸을 때
    // 이름이 지워졌다. 빈 칸은 이제 "강사 변경 없음"이라는 뜻이다.
    p.instructorName ?? p.instructorNameText ?? "",
  ]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = [{ wch: 22 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "기본설정");
  XLSX.writeFile(wb, "기본설정_템플릿.xlsx");
}

export function ProgramScheduleExcelDialog({
  open,
  onOpenChange,
  operationCycleId,
  programs,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  operationCycleId: string;
  programs: CycleProgramStatusRow[];
}) {
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    ok: number;
    failed: { name: string; message: string }[];
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data: instructors } = useInstructorAccounts();
  const upsert = useUpsertOperationTermForCycle();

  const programByName = new Map(programs.map((p) => [p.name.trim(), p]));
  // Manual QA Gap Fix §5: 이름 완전일치 그룹만 만든다 -- 유사도 추측매칭 금지.
  // 비활성 강사는 자동 연결 대상에서 제외한다(기존 규칙 유지, 다만 못 찾은
  // 것으로만 취급해 텍스트로 저장하고 행을 막지는 않는다).
  const instructorsByName = new Map<string, { principalId: string; isActive: boolean }[]>();
  for (const i of instructors ?? []) {
    if (!i.isActive) continue;
    const key = i.name.trim();
    const list = instructorsByName.get(key) ?? [];
    list.push({ principalId: i.principalId, isActive: i.isActive });
    instructorsByName.set(key, list);
  }

  function parseWorkbook(buffer: ArrayBuffer): ParsedRow[] {
    const wb = XLSX.read(buffer, { type: "array" });
    const firstSheetName = wb.SheetNames[0];
    const sheet = firstSheetName ? wb.Sheets[firstSheetName] : undefined;
    if (!sheet) return [];
    const raw: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const seenPrograms = new Set<string>();
    return raw.map((r) => {
      const key = (k: string) => Object.keys(r).find((rk) => rk.replace(/\s/g, "") === k);
      const programName = String(r[key("프로그램명") ?? ""] ?? "").trim();
      const weekdayLabel = String(r[key("요일") ?? ""] ?? "").trim();
      const startTime = normalizeTime(r[key("시작시간") ?? ""]);
      const endTime = normalizeTime(r[key("종료시간") ?? ""]);
      const instructorCell = String(r[key("강사") ?? ""] ?? "").trim();

      const program = programByName.get(programName);
      // 강사 칸이 비어 있으면 "강사를 바꾸지 않는다"는 뜻으로 보고 화면의 현재 강사를 그대로 쓴다.
      // (예전에는 빈 칸이 "강사 없음"으로 저장돼, 받은 템플릿을 그대로 올리면 이름이 지워졌다.)
      const instructorName =
        instructorCell || program?.instructorName || program?.instructorNameText || "";
      const weekdays = parseWeekdays(weekdayLabel);
      const instructorMatches = instructorName ? (instructorsByName.get(instructorName) ?? []) : [];

      let error: string | undefined;
      if (!programName) error = "프로그램명이 비어 있습니다.";
      else if (!program) error = "이 운영구분에서 해당 프로그램을 찾을 수 없습니다.";
      else if (seenPrograms.has(programName)) error = "같은 파일 안에 프로그램이 중복되었습니다.";
      else if (!weekdays) error = "요일을 확인해 주세요(월~일, 복수는 쉼표로 구분).";
      else if (!startTime) error = "시작시간을 확인해 주세요.";
      else if (!endTime) error = "종료시간을 확인해 주세요.";
      else if (startTime && endTime && endTime <= startTime)
        error = "종료시간은 시작시간보다 늦어야 합니다.";
      else if (instructorMatches.length >= 2)
        error = `동명이인 강사가 있어 확인이 필요합니다: ${instructorName}`;

      if (program && !error) seenPrograms.add(programName);

      const matchedInstructorId =
        instructorMatches.length === 1 ? instructorMatches[0]!.principalId : null;

      return {
        programName,
        programId: program?.programId ?? null,
        weekdayLabel,
        weekdays,
        startTime,
        endTime,
        instructorName,
        instructorId: matchedInstructorId,
        instructorNameText: instructorName && !matchedInstructorId ? instructorName : null,
        error,
      };
    });
  }

  const handleFile = async (file: File) => {
    setFileName(file.name);
    const buffer = await file.arrayBuffer();
    try {
      setRows(parseWorkbook(buffer));
      setApplyResult(null);
    } catch {
      toast.error("파일을 읽을 수 없습니다. Excel(.xlsx) 파일인지 확인해 주세요.");
      setRows(null);
    }
  };

  const errorRows = (rows ?? []).filter((r) => r.error);
  const okRows = (rows ?? []).filter((r) => !r.error);

  function close() {
    onOpenChange(false);
    setRows(null);
    setFileName(null);
    setApplyResult(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function apply() {
    if (okRows.length === 0) return;
    setApplying(true);
    let ok = 0;
    const failed: { name: string; message: string }[] = [];
    for (const r of okRows) {
      try {
        await upsert.mutateAsync({
          operationCycleId,
          programId: r.programId as string,
          weekdays: r.weekdays as number[],
          startTime: r.startTime as string,
          endTime: r.endTime as string,
          instructorPrincipalId: r.instructorId,
          instructorNameText: r.instructorNameText,
        });
        ok += 1;
      } catch (e: any) {
        failed.push({ name: r.programName, message: errorReason(e) });
      }
    }
    setApplying(false);
    setApplyResult({ ok, failed });
    if (failed.length === 0) {
      toast.success(`${ok}개 프로그램의 기본설정을 적용했습니다.`);
    } else {
      toast.error(`${ok}개 적용, ${failed.length}개 실패했습니다. 아래에서 사유를 확인해 주세요.`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>기본설정 일괄등록</DialogTitle>
          <DialogDescription>프로그램별 운영요일·시간·강사를 한 번에 등록합니다.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <button className={btnSecondaryCls} onClick={() => downloadTemplate(programs)}>
            템플릿 다운로드
          </button>
          {/* Manual QA Gap Fix §21: native file input 기본 UI("파일 선택 / 선택된
              파일 없음")가 버튼과 안내문을 구분하기 어려워, 버튼 + 파일명 표시로
              바꾼다. */}
          <button className={btnSecondaryCls} onClick={() => fileInput.current?.click()}>
            Excel 파일 선택
          </button>
          <span className="text-sm text-muted-foreground">
            {fileName ?? "선택된 파일이 없습니다."}
          </span>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              // 같은 파일을 고쳐서 다시 골라도 onChange가 다시 불리도록 비운다.
              e.target.value = "";
            }}
            className="hidden"
          />
        </div>
        <p className="text-[13px] text-muted-foreground">
          운영요일은 여러 개면 쉼표로 구분해 입력합니다(예: 월 / 월,목).
        </p>

        {rows && !applyResult && (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              전체 {rows.length}개 · 정상 {okRows.length}개 · 확인 필요 {errorRows.length}개
            </p>
            {errorRows.length > 0 && (
              <>
                <p className="font-medium text-status-danger-fg">확인이 필요한 행</p>
                <div className="max-h-56 overflow-y-auto rounded border border-status-danger-border bg-status-danger-bg">
                  <table className="w-full table-fixed text-xs">
                    <colgroup>
                      <col className="w-40" />
                      <col />
                    </colgroup>
                    <tbody>
                      {errorRows.map((r, i) => (
                        <tr
                          key={i}
                          className="border-b border-status-danger-border/50 last:border-0"
                        >
                          <td className="px-2 py-1.5">{r.programName || "(프로그램명 없음)"}</td>
                          <td className="px-2 py-1.5 text-status-danger-fg">{r.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {okRows.length > 0 && (
              <p className="text-status-success-fg">
                정상 {okRows.length}개는 적용 버튼을 누르면 반영됩니다.
              </p>
            )}
          </div>
        )}

        {applyResult && (
          <div className="space-y-2 text-sm">
            <p className="text-status-success-fg">{applyResult.ok}개 프로그램에 적용했습니다.</p>
            {applyResult.failed.length > 0 && (
              <>
                <p className="font-medium text-status-danger-fg">적용하지 못한 프로그램</p>
                <div className="max-h-56 overflow-y-auto rounded border border-status-danger-border bg-status-danger-bg">
                  <table className="w-full table-fixed text-xs">
                    <colgroup>
                      <col className="w-40" />
                      <col />
                    </colgroup>
                    <tbody>
                      {applyResult.failed.map((f, i) => (
                        <tr
                          key={i}
                          className="border-b border-status-danger-border/50 last:border-0"
                        >
                          <td className="px-2 py-1.5">{f.name}</td>
                          <td className="px-2 py-1.5 text-status-danger-fg">{f.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <button className={btnSecondaryCls} onClick={close}>
            닫기
          </button>
          {!applyResult && (
            <button
              className={btnPrimaryCls}
              disabled={okRows.length === 0 || applying}
              onClick={apply}
            >
              {applying ? "적용 중..." : rows ? `${okRows.length}개 적용` : "적용"}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
