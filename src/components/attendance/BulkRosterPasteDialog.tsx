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
import { btnPrimaryCls, btnSecondaryCls, controlCls } from "@/components/layout/StaffLayout";
import { useApplyBulkRosterForCycle, type CycleProgramStatusRow } from "@/lib/programs-data";
import { parsePastedTable } from "@/lib/paste-parse";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

// Manual QA Gap Fix §9-12: 프로그램 설정 메인 화면에서 여러 Program의
// 수강명단을 한 번에 등록한다. "복사 붙여넣기"와 "Excel 업로드" 두 방식 모두
// 제공하되, 같은 검증/적용 로직(validateRows + apply_bulk_roster_for_cycle)을
// 공유해 두 방식이 서로 다른 업무규칙을 갖지 않게 한다. 이 운영구분에 선택된
// Program만 대상이며, 프로그램명 매칭은 정확일치만 허용한다(유사도 추측 금지, §12).
//
// 오류 제외 등록: 확인이 필요한 행이 있어도 전체를 막지 않고, 그 행이 속한
// Program을 통째로 빼고 나머지 Program만 등록한다. 오류 행만 빼면 그 Program이
// 일부 수강생이 누락된 채 "최초등록 완료"가 되고, 빠진 사람은 이후 [수강생
// 추가]로 다음 예정 회차부터만 들어갈 수 있기 때문이다. 제외된 Program은
// 미등록으로 남으므로 고친 뒤 전체를 다시 붙여넣으면 그 Program만 1회차부터
// 등록된다(이미 등록된 Program은 자동 제외). 프로그램명이 빈 행은 어느 Program
// 명단인지 알 수 없어 제외 대상을 정할 수 없으므로 전체를 막는다.

type RowKind = "ok" | "duplicate" | "row_error" | "program_error" | "no_program";

type ParsedRow = {
  programName: string;
  memberCode: string;
  name: string;
  kind: RowKind;
  error: string | undefined;
};

const ALREADY_APPLIED = "이미 최초 수강명단이 등록된 프로그램입니다.";

const COLUMNS = [
  { key: "program_name", aliases: ["프로그램명"] },
  { key: "member_code", aliases: ["회원번호", "회원코드"] },
  { key: "name", aliases: ["성명"] },
];

// Excel/붙여넣기 어느 쪽에서 왔든 {program_name, member_code, name} triple만
// 받아 동일한 규칙으로 검증한다. 서버(apply_bulk_roster_for_cycle)는 한 행이라도
// 틀리면 전체를 되돌리므로, 서버가 거부할 조건은 여기서 모두 먼저 걸러낸다.
function validateRows(
  raw: { program_name: string; member_code: string; name: string }[],
  programs: CycleProgramStatusRow[],
): ParsedRow[] {
  const byName = new Map(programs.map((p) => [p.name.trim(), p]));
  // 프로그램+회원번호 -> 처음 나온 성명. 프로그램·회원번호·성명이 모두 같은
  // 행이 반복되면 단순 중복으로 보고 한 번만 등록한다(누락이 생기지 않는다).
  const seen = new Map<string, string>();

  return raw.map((r) => {
    const programName = r.program_name.trim();
    const memberCode = r.member_code.trim();
    const name = r.name.trim();
    const program = byName.get(programName);
    const row = (kind: RowKind, error?: string): ParsedRow => ({
      programName,
      memberCode,
      name,
      kind,
      error,
    });

    if (!programName) return row("no_program", "프로그램명 없음");
    if (!program) return row("program_error", "현재 운영구분에 포함되지 않은 프로그램입니다.");
    if (!program.hasTerm)
      return row("program_error", "프로그램 기본설정이 아직 등록되지 않았습니다.");
    if (program.initialRosterApplied) return row("program_error", ALREADY_APPLIED);
    if (!memberCode) return row("row_error", "회원번호 없음");
    if (memberCode.length > 40) return row("row_error", "회원번호가 너무 깁니다(40자 이내).");
    if (!name) return row("row_error", "성명 없음");

    const key = `${programName} ${memberCode}`;
    const seenName = seen.get(key);
    if (seenName === undefined) {
      seen.set(key, name);
      return row("ok");
    }
    if (seenName === name) return row("duplicate");
    return row("row_error", "같은 프로그램 안에 회원번호가 같은데 성명이 다릅니다.");
  });
}

type ExcludedProgram = { name: string; rowCount: number; reason: string };

function planRegistration(rows: ParsedRow[]) {
  const blockingRows = rows.filter((r) => r.kind === "no_program");
  const rowErrorRows = rows.filter((r) => r.kind === "row_error");

  const excludedReason = new Map<string, string>();
  for (const r of rows) {
    if (r.kind === "program_error") excludedReason.set(r.programName, r.error!);
  }
  for (const r of rowErrorRows) {
    if (!excludedReason.has(r.programName)) {
      const n = rowErrorRows.filter((x) => x.programName === r.programName).length;
      excludedReason.set(r.programName, `확인 필요 ${n}행`);
    }
  }

  const rowCountByProgram = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === "no_program") continue;
    rowCountByProgram.set(r.programName, (rowCountByProgram.get(r.programName) ?? 0) + 1);
  }
  const excluded: ExcludedProgram[] = [...excludedReason].map(([name, reason]) => ({
    name,
    rowCount: rowCountByProgram.get(name) ?? 0,
    reason,
  }));

  const kept = (r: ParsedRow) => !excludedReason.has(r.programName);
  const registerRows = rows.filter((r) => r.kind === "ok" && kept(r));

  return {
    blockingRows,
    rowErrorRows,
    registerRows,
    duplicateCount: rows.filter((r) => r.kind === "duplicate" && kept(r)).length,
    programCount: new Set(registerRows.map((r) => r.programName)).size,
    alreadyApplied: excluded.filter((p) => p.reason === ALREADY_APPLIED),
    excludedPrograms: excluded.filter((p) => p.reason !== ALREADY_APPLIED),
  };
}

function parsePaste(text: string, programs: CycleProgramStatusRow[]): ParsedRow[] {
  const { rows } = parsePastedTable(text, COLUMNS);
  return validateRows(
    rows.map((r) => ({
      program_name: r["program_name"] ?? "",
      member_code: r["member_code"] ?? "",
      name: r["name"] ?? "",
    })),
    programs,
  );
}

function parseWorkbook(buffer: ArrayBuffer, programs: CycleProgramStatusRow[]): ParsedRow[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const firstSheetName = wb.SheetNames[0];
  const sheet = firstSheetName ? wb.Sheets[firstSheetName] : undefined;
  if (!sheet) return [];
  const raw: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  const key = (r: any, k: string) => Object.keys(r).find((rk) => rk.replace(/\s/g, "") === k);
  return validateRows(
    raw.map((r) => ({
      program_name: String(r[key(r, "프로그램명") ?? ""] ?? ""),
      member_code: String(r[key(r, "회원번호") ?? key(r, "회원코드") ?? ""] ?? ""),
      name: String(r[key(r, "성명") ?? ""] ?? ""),
    })),
    programs,
  );
}

function downloadTemplate() {
  const header = ["프로그램명", "회원번호", "성명"];
  const rows = [
    ["온기케어", "00123", "이용자A"],
    ["온기케어", "A-1034", "이용자B"],
    ["이음정원", "2026-00123", "이용자C"],
  ];
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "수강명단");
  XLSX.writeFile(wb, "수강명단_템플릿.xlsx");
}

function ErrorRowTable({ rows }: { rows: ParsedRow[] }) {
  return (
    <div className="max-h-56 overflow-y-auto rounded border border-status-danger-border bg-status-danger-bg">
      <table className="w-full table-fixed text-xs">
        <colgroup>
          <col className="w-28" />
          <col className="w-24" />
          <col className="w-20" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-status-danger-border/50 last:border-0">
              <td className="px-2 py-1.5">{r.programName || "-"}</td>
              <td className="px-2 py-1.5">{r.memberCode || "-"}</td>
              <td className="px-2 py-1.5">{r.name || "-"}</td>
              <td className="px-2 py-1.5 text-status-danger-fg">{r.error}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BulkRosterPasteDialog({
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
  const [mode, setMode] = useState<"paste" | "excel">("paste");
  const [pasteText, setPasteText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const apply = useApplyBulkRosterForCycle();

  const plan = planRegistration(rows ?? []);
  const blocked = plan.blockingRows.length > 0;
  const canRegister = !!rows && !blocked && plan.registerRows.length > 0;

  const close = () => {
    onOpenChange(false);
    setPasteText("");
    setFileName(null);
    setRows(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const check = () => {
    setRows(parsePaste(pasteText, programs));
  };

  const handleFile = async (file: File) => {
    setFileName(file.name);
    const buffer = await file.arrayBuffer();
    try {
      setRows(parseWorkbook(buffer, programs));
    } catch {
      toast.error("파일을 읽을 수 없습니다. Excel(.xlsx) 파일인지 확인해 주세요.");
      setRows(null);
    }
  };

  const submit = async () => {
    if (!canRegister) return;
    try {
      const result = await apply.mutateAsync({
        operationCycleId,
        rows: plan.registerRows.map((r) => ({
          program_name: r.programName,
          member_code: r.memberCode,
          name: r.name,
        })),
      });
      toast.success(
        `${result.programCount}개 프로그램에 수강명단 ${result.participantCount}명을 등록했습니다.`,
        plan.excludedPrograms.length > 0
          ? {
              description: `제외한 ${plan.excludedPrograms.length}개 프로그램(${plan.excludedPrograms
                .map((p) => p.name)
                .join(", ")})은 고친 뒤 다시 등록해 주세요.`,
            }
          : undefined,
      );
      close();
    } catch (e: any) {
      toast.error(`등록 실패: ${errorReason(e)}`);
    }
  };

  function switchMode(next: "paste" | "excel") {
    setMode(next);
    setRows(null);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>수강명단 일괄등록</DialogTitle>
          <DialogDescription>
            프로그램명, 회원번호, 성명 열만 반영하며, 다른 열은 저장하지 않습니다. 프로그램별 최초
            등록은 한 번만 가능합니다. 확인이 필요한 행이 있는 프로그램은 제외하고 나머지 프로그램만
            등록합니다.
          </DialogDescription>
          <p className="text-[13px] text-status-warn-fg">
            회원번호가 기존 회원과 같으면 그 회원의 성명이 붙여넣은 성명으로 바뀝니다. 회원번호를
            다시 확인해 주세요.
          </p>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border">
          {(["paste", "excel"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                mode === m
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {m === "paste" ? "복사 붙여넣기" : "Excel 업로드"}
            </button>
          ))}
        </div>

        {mode === "paste" ? (
          <>
            <p className="text-[13px] text-muted-foreground">
              엑셀에서 프로그램명, 회원번호, 성명을 복사해 붙여넣으세요.
            </p>
            <textarea
              className={`${controlCls} h-36 resize-y font-mono text-xs`}
              placeholder={
                "프로그램명\t회원번호\t성명\n온기케어\t00123\t이용자A\n온기케어\tA-1034\t이용자B\n이음정원\t2026-00123\t이용자C"
              }
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
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button className={btnSecondaryCls} onClick={downloadTemplate}>
              템플릿 다운로드
            </button>
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
        )}

        {rows && (
          <div className="space-y-3 text-sm">
            {/* 전체 차단이면 등록/제외 집계가 의미 없으므로 빈 프로그램명 행 수만 보인다. */}
            <p className="text-muted-foreground">
              {blocked ? (
                `전체 ${rows.length}행 · 프로그램명 없음 ${plan.blockingRows.length}행`
              ) : (
                <>
                  전체 {rows.length}행 · 등록 {plan.registerRows.length}명({plan.programCount}개
                  프로그램)
                  {plan.duplicateCount > 0 && ` · 중복 제외 ${plan.duplicateCount}행`}
                  {plan.excludedPrograms.length > 0 &&
                    ` · 제외 프로그램 ${plan.excludedPrograms.length}개`}
                </>
              )}
            </p>

            {blocked ? (
              <>
                <p className="font-medium text-status-danger-fg">
                  프로그램명이 비어 있는 행이 있어 등록할 수 없습니다. 어느 프로그램 명단인지 알 수
                  없으니 프로그램명을 채워 다시 시도해 주세요.
                </p>
                <ErrorRowTable rows={plan.blockingRows} />
              </>
            ) : (
              <>
                {plan.excludedPrograms.length > 0 && (
                  <div className="space-y-2">
                    <p className="font-medium text-status-danger-fg">
                      아래 프로그램은 이번 등록에서 제외됩니다.
                    </p>
                    <div className="max-h-56 overflow-y-auto rounded border border-status-danger-border bg-status-danger-bg">
                      <table className="w-full table-fixed text-xs">
                        <colgroup>
                          <col className="w-40" />
                          <col className="w-16" />
                          <col />
                        </colgroup>
                        <tbody>
                          {plan.excludedPrograms.map((p) => (
                            <tr
                              key={p.name}
                              className="border-b border-status-danger-border/50 last:border-0"
                            >
                              <td className="px-2 py-1.5">{p.name}</td>
                              <td className="px-2 py-1.5">{p.rowCount}행</td>
                              <td className="px-2 py-1.5 text-status-danger-fg">{p.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {plan.rowErrorRows.length > 0 && (
                      <>
                        <p className="font-medium text-foreground">확인이 필요한 행</p>
                        <ErrorRowTable rows={plan.rowErrorRows} />
                      </>
                    )}
                    <p className="text-[13px] text-muted-foreground">
                      고친 뒤 전체를 다시 붙여넣어도 됩니다. 이미 등록된 프로그램은 자동으로
                      제외됩니다.
                    </p>
                  </div>
                )}

                {plan.alreadyApplied.length > 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    이미 최초 수강명단이 등록된 {plan.alreadyApplied.length}개 프로그램(
                    {plan.alreadyApplied.reduce((n, p) => n + p.rowCount, 0)}행)은 제외합니다.
                  </p>
                )}
                {plan.duplicateCount > 0 && (
                  <p className="text-[13px] text-muted-foreground">
                    같은 프로그램·회원번호·성명이 반복된 {plan.duplicateCount}행은 한 번만
                    등록합니다.
                  </p>
                )}

                {plan.registerRows.length > 0 ? (
                  <p className="text-status-success-fg">
                    {plan.programCount}개 프로그램 {plan.registerRows.length}명은 등록 버튼을 누르면
                    반영됩니다.
                  </p>
                ) : (
                  <p className="font-medium text-status-danger-fg">등록할 수 있는 행이 없습니다.</p>
                )}
              </>
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
            {rows ? `${blocked ? 0 : plan.registerRows.length}명 등록` : "등록"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
