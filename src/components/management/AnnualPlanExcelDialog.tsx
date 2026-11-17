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
import { useBatchUpsertAnnualPlan, type AnnualPlanActivityRow } from "@/lib/performance-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

// Final Batch A §28-31: 연간계획은 1년에 한 번 대량입력하는 데이터이므로
// Program 운영정보 Excel 등록(ProgramScheduleExcelDialog)과 동일한 패턴을
// 그대로 재사용한다 -- 다운로드 -> 작성 -> 업로드 -> Preview(오류 우선) ->
// 적용. 단위사업/대분류/중분류/활동명으로 행을 매칭한다(사용자가 activity
// id를 직접 입력하지 않도록).

type ParsedRow = {
  majorName: string;
  middleName: string;
  activityName: string;
  activityId: string | null;
  count: number | null;
  unique: number | null;
  total: number | null;
  error: string | undefined;
};

function parseIntOrNull(raw: unknown): { value: number | null; ok: boolean } {
  if (raw === "" || raw === undefined || raw === null) return { value: null, ok: true };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { value: null, ok: false };
  return { value: n, ok: true };
}

// 업로드 행 매칭 key. 공백·줄바꿈을 모두 뺀 이름으로 비교한다 -- 이름에 Excel
// 셀 줄바꿈(Alt+Enter)이 섞여 있거나 템플릿을 거치며 줄바꿈 문자가 바뀌어도
// (\r\n -> \r\r\n), 띄어쓰기만 달라도 같은 활동으로 본다. 열 이름 매칭과 같은 규칙.
function matchKey(name: string): string {
  return name.replace(/\s+/g, "");
}

function downloadTemplate(rows: AnnualPlanActivityRow[], unitNames: Map<string, string>) {
  const header = ["단위사업", "대분류", "중분류", "소분류(활동)", "건", "실인원", "연인원"];
  const body = rows.map((r) => [
    (r.unitBusinessId && unitNames.get(r.unitBusinessId)) || "",
    r.majorName,
    r.middleName,
    r.activityName,
    r.count.target ?? "",
    r.unique.target ?? "",
    r.total.target ?? "",
  ]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws["!cols"] = [
    { wch: 22 },
    { wch: 18 },
    { wch: 18 },
    { wch: 22 },
    { wch: 8 },
    { wch: 8 },
    { wch: 8 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "연간계획");
  XLSX.writeFile(wb, "연간계획_템플릿.xlsx");
}

export function AnnualPlanExcelDialog({
  open,
  onOpenChange,
  businessYearId,
  rows,
  unitNames,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  businessYearId: string;
  rows: AnnualPlanActivityRow[];
  /** 단위사업 id -> 이름. 템플릿의 단위사업 열과 업로드 매칭에 쓴다. */
  unitNames: Map<string, string>;
}) {
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    ok: number;
    failed: { name: string; message: string }[];
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const batchSave = useBatchUpsertAnnualPlan();

  // 단위사업/대분류/중분류/활동명 4개 조합으로 매칭한다. 단위사업 칸이 빈
  // 행(단위사업 열이 없던 옛 템플릿 포함)은 대분류/중분류/활동명 3개로
  // 매칭하되, 그 조합이 여러 단위사업에 있으면 매칭하지 않고 오류로 돌린다.
  const byUnitKey = new Map<string, AnnualPlanActivityRow>();
  const byKey = new Map<string, AnnualPlanActivityRow>();
  const ambiguousKeys = new Set<string>();
  for (const r of rows) {
    const k = `${matchKey(r.majorName)}|${matchKey(r.middleName)}|${matchKey(r.activityName)}`;
    const unit = matchKey((r.unitBusinessId && unitNames.get(r.unitBusinessId)) || "");
    byUnitKey.set(`${unit}|${k}`, r);
    if (byKey.has(k)) ambiguousKeys.add(k);
    else byKey.set(k, r);
  }

  function parseWorkbook(buffer: ArrayBuffer): ParsedRow[] {
    const wb = XLSX.read(buffer, { type: "array" });
    const firstSheetName = wb.SheetNames[0];
    const sheet = firstSheetName ? wb.Sheets[firstSheetName] : undefined;
    if (!sheet) return [];
    const raw: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    return raw.map((r) => {
      const key = (k: string) => Object.keys(r).find((rk) => rk.replace(/\s/g, "") === k);
      const unitName = String(r[key("단위사업") ?? ""] ?? "").trim();
      const majorName = String(r[key("대분류") ?? ""] ?? "").trim();
      const middleName = String(r[key("중분류") ?? ""] ?? "").trim();
      const activityName = String(r[key("소분류(활동)") ?? key("활동") ?? ""] ?? "").trim();
      const countRaw = r[key("건") ?? ""];
      const uniqueRaw = r[key("실인원") ?? ""];
      const totalRaw = r[key("연인원") ?? ""];

      const rowKey = `${matchKey(majorName)}|${matchKey(middleName)}|${matchKey(activityName)}`;
      const ambiguous = !unitName && ambiguousKeys.has(rowKey);
      const match = unitName
        ? byUnitKey.get(`${matchKey(unitName)}|${rowKey}`)
        : ambiguous
          ? undefined
          : byKey.get(rowKey);
      const count = parseIntOrNull(countRaw);
      const unique = parseIntOrNull(uniqueRaw);
      const total = parseIntOrNull(totalRaw);

      let error: string | undefined;
      if (!activityName) error = "활동명이 비어 있습니다.";
      else if (ambiguous)
        error = "같은 대분류/중분류/활동명이 여러 단위사업에 있습니다. 단위사업 칸을 채워 주세요.";
      else if (!match)
        error = unitName
          ? "단위사업/대분류/중분류/활동명이 일치하는 활동을 찾을 수 없습니다."
          : "대분류/중분류/활동명이 일치하는 활동을 찾을 수 없습니다.";
      else if (!count.ok) error = "건 값을 확인해 주세요(0 이상 정수, 미입력은 빈 칸).";
      else if (!unique.ok) error = "실인원 값을 확인해 주세요(0 이상 정수, 미입력은 빈 칸).";
      else if (!total.ok) error = "연인원 값을 확인해 주세요(0 이상 정수, 미입력은 빈 칸).";

      return {
        majorName,
        middleName,
        activityName,
        activityId: match?.activityId ?? null,
        count: count.value,
        unique: unique.value,
        total: total.value,
        error,
      };
    });
  }

  const handleFile = async (file: File) => {
    setFileName(file.name);
    const buffer = await file.arrayBuffer();
    try {
      setParsed(parseWorkbook(buffer));
      setApplyResult(null);
    } catch {
      toast.error("파일을 읽을 수 없습니다. Excel(.xlsx) 파일인지 확인해 주세요.");
      setParsed(null);
    }
  };

  const errorRows = (parsed ?? []).filter((r) => r.error);
  const okRows = (parsed ?? []).filter((r) => !r.error);

  function close() {
    onOpenChange(false);
    setParsed(null);
    setFileName(null);
    setApplyResult(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function apply() {
    if (okRows.length === 0) return;
    setApplying(true);
    try {
      const toSave = okRows.map((r) => {
        const original = rows.find((x) => x.activityId === r.activityId);
        return {
          activity_id: r.activityId as string,
          count_target: r.count,
          count_basis: original?.count.basis ?? null,
          unique_target: r.unique,
          unique_basis: original?.unique.basis ?? null,
          total_target: r.total,
          total_basis: original?.total.basis ?? null,
        };
      });
      const count = await batchSave.mutateAsync({ businessYearId, rows: toSave });
      setApplyResult({ ok: count, failed: [] });
      toast.success(`${count}개 활동의 연간계획을 적용했습니다.`);
    } catch (e: any) {
      setApplyResult({ ok: 0, failed: [{ name: "전체", message: errorReason(e) }] });
      toast.error(`적용 실패: ${errorReason(e)}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>연간계획 Excel 등록</DialogTitle>
          <DialogDescription>
            활동별 연간계획(건·실인원·연인원)을 한 번에 등록합니다.
          </DialogDescription>
        </DialogHeader>

        {/* Manual QA Gap Fix §21과 같은 방식: native file input 기본 UI 대신
            버튼 + 파일명 표시(ProgramScheduleExcelDialog와 동일). */}
        <div className="flex flex-wrap items-center gap-2">
          <button className={btnSecondaryCls} onClick={() => downloadTemplate(rows, unitNames)}>
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
        <p className="text-[13px] text-muted-foreground">
          템플릿에는 지금 화면의 활동 {rows.length}개가 들어갑니다. 빈 칸은 미입력으로 처리됩니다.
        </p>

        {parsed && !applyResult && (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              전체 {parsed.length}개 · 정상 {okRows.length}개 · 확인 필요 {errorRows.length}개
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
                          <td className="px-2 py-1.5">{r.activityName || "(활동명 없음)"}</td>
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
            <p className="text-status-success-fg">{applyResult.ok}개 활동에 적용했습니다.</p>
            {applyResult.failed.length > 0 && (
              <p className="text-status-danger-fg">
                {applyResult.failed.map((f) => f.message).join(" ")}
              </p>
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
              {applying ? "적용 중..." : parsed ? `${okRows.length}개 적용` : "적용"}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
