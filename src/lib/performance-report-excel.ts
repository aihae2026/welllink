// 실적보고 화면의 요약/사업구조별 상세를 서식 있는 엑셀(두 시트)로 내려받는다.
// 수치는 화면이 이미 계산한 값을 그대로 받는다 -- 여기서는 배치와 서식만 한다.
// exceljs는 크기가 커서 버튼을 누를 때만 브라우저용 단일 파일을 불러온다.
import type { Borders, Cell, Worksheet } from "exceljs";
import type { ReportMetric } from "@/lib/performance-data";

export type ExcelTreeLevel = "unit" | "major" | "middle" | "activity";

export type ExcelReportRow = {
  label: string;
  level: ExcelTreeLevel;
  plan: ReportMetric;
  actual: ReportMetric;
  ytd: ReportMetric;
};

export type ExcelReportInput = {
  fileName: string;
  title: string;
  periodText: string;
  annual: boolean;
  actualLabel: string;
  // 달성 기준 비율(분기 = 분기×25%, 월 = 월수÷12, 연간 = 100%)과 안내문에 쓸 표기.
  targetRatio: number;
  targetLabel: string;
  summary: { plan: ReportMetric; actual: ReportMetric; ytd: ReportMetric };
  rows: ExcelReportRow[];
};

const METRIC_KEYS = ["count", "unique", "total"] as const;
const METRIC_LABELS = ["건", "실인원", "연인원"];

const COLOR = {
  headerFill: "FFF1F5F9",
  unitFill: "FFE2E8F0",
  majorFill: "FFF8FAFC",
  border: "FFCBD5E1",
  muted: "FF64748B",
  achieved: "FF2563EB",
  missed: "FFDC2626",
};

const thin = { style: "thin" as const, color: { argb: COLOR.border } };
const allBorders: Partial<Borders> = { top: thin, left: thin, bottom: thin, right: thin };

const INDENT: Record<ExcelTreeLevel, number> = { unit: 0, major: 1, middle: 2, activity: 3 };

function styleHeader(cell: Cell) {
  cell.font = { bold: true, size: 10 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR.headerFill } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.border = allBorders;
}

function setMetric(cell: Cell, v: number | null) {
  cell.value = v === null ? "미입력" : v;
  if (v !== null) cell.numFmt = "#,##0";
  else cell.font = { color: { argb: COLOR.muted } };
  cell.alignment = { horizontal: "right", vertical: "middle" };
  cell.border = allBorders;
}

// 화면과 같게 달성률 = 누계 ÷ 연간계획, 계획이 없거나 0이면 "-"(무색).
function setRate(cell: Cell, actual: number | null, plan: number | null, targetRatio: number) {
  cell.alignment = { horizontal: "right", vertical: "middle" };
  cell.border = allBorders;
  if (plan === null || plan === 0 || actual === null) {
    cell.value = "-";
    return;
  }
  const ratio = actual / plan;
  cell.value = ratio;
  cell.numFmt = "0.0%";
  cell.font = { color: { argb: ratio >= targetRatio - 1e-9 ? COLOR.achieved : COLOR.missed } };
}

function writeTitle(ws: Worksheet, input: ExcelReportInput, lastCol: number) {
  ws.mergeCells(1, 1, 1, lastCol);
  const title = ws.getCell(1, 1);
  title.value = input.title;
  title.font = { bold: true, size: 14 };
  ws.mergeCells(2, 1, 2, lastCol);
  const period = ws.getCell(2, 1);
  period.value = input.periodText;
  period.font = { size: 10, color: { argb: COLOR.muted } };
}

// 머리줄 두 줄(그룹명 / 건·실인원·연인원)을 startCol부터 그린다.
function writeGroupHeaders(ws: Worksheet, row: number, startCol: number, groups: string[]) {
  groups.forEach((g, gi) => {
    const col = startCol + gi * 3;
    ws.mergeCells(row, col, row, col + 2);
    const cell = ws.getCell(row, col);
    cell.value = g;
    for (let i = 0; i < 3; i++) {
      styleHeader(ws.getCell(row, col + i));
      const sub = ws.getCell(row + 1, col + i);
      sub.value = METRIC_LABELS[i];
      styleHeader(sub);
    }
  });
}

function writeNotes(ws: Worksheet, startRow: number, lastCol: number, input: ExcelReportInput) {
  const notes = [
    '상위 사업의 값은 하위 활동 값의 합으로 표시합니다. 계획이 없는 경우 "미입력", 달성률은 "-"로 표시합니다.',
    `달성률은 누계 ÷ 연간계획이며, ${input.targetLabel} 이상이면 파란색(달성), 미만이면 빨간색(미달)으로 표시합니다(분기별 25%씩, 월은 월수÷12, 연간은 100% 기준).`,
  ];
  notes.forEach((text, i) => {
    const r = startRow + i;
    ws.mergeCells(r, 1, r, lastCol);
    const cell = ws.getCell(r, 1);
    cell.value = text;
    cell.font = { size: 9, color: { argb: COLOR.muted } };
    // 병합 칸보다 긴 안내문이 잘리지 않게 두 줄 높이로 줄바꿈한다.
    cell.alignment = { vertical: "top", wrapText: true };
    ws.getRow(r).height = 30;
  });
}

export async function downloadPerformanceReportExcel(input: ExcelReportInput) {
  const { default: ExcelJS } = await import("exceljs/dist/exceljs.min.js");
  const wb = new ExcelJS.Workbook();
  wb.creator = "WellLink";
  wb.created = new Date();

  const groups = input.annual
    ? ["연간계획", input.actualLabel]
    : ["연간계획", input.actualLabel, "누계"];
  const metricsOf = (x: { plan: ReportMetric; actual: ReportMetric; ytd: ReportMetric }) =>
    input.annual ? [x.plan, x.actual] : [x.plan, x.actual, x.ytd];
  const allGroups = [...groups, "달성률"];

  // ---- 시트 1: 실적 요약 ----
  const summary = wb.addWorksheet("실적 요약", { views: [{ showGridLines: false }] });
  const summaryLastCol = allGroups.length * 3;
  summary.columns = Array.from({ length: summaryLastCol }, () => ({ width: 11 }));
  writeTitle(summary, input, summaryLastCol);
  writeGroupHeaders(summary, 4, 1, allGroups);
  const sRow = summary.getRow(6);
  metricsOf(input.summary).forEach((m, gi) => {
    METRIC_KEYS.forEach((k, i) => setMetric(sRow.getCell(gi * 3 + 1 + i), m[k]));
  });
  METRIC_KEYS.forEach((k, i) => {
    const cell = sRow.getCell(groups.length * 3 + 1 + i);
    setRate(cell, input.summary.ytd[k], input.summary.plan[k], input.targetRatio);
    cell.font = { ...cell.font, bold: true };
  });
  writeNotes(summary, 8, summaryLastCol, input);

  // ---- 시트 2: 사업구조별 상세 ----
  const detail = wb.addWorksheet("사업구조별 상세", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 5, showGridLines: false }],
  });
  const detailLastCol = 1 + allGroups.length * 3;
  detail.columns = [
    { width: 36 },
    ...Array.from({ length: allGroups.length * 3 }, () => ({ width: 10 })),
  ];
  writeTitle(detail, input, detailLastCol);
  detail.mergeCells(4, 1, 5, 1);
  detail.getCell(4, 1).value = "사업/활동";
  styleHeader(detail.getCell(4, 1));
  styleHeader(detail.getCell(5, 1));
  detail.getCell(4, 1).alignment = { horizontal: "left", vertical: "middle" };
  writeGroupHeaders(detail, 4, 2, allGroups);

  let r = 6;
  for (const row of input.rows) {
    const xr = detail.getRow(r);
    const labelCell = xr.getCell(1);
    labelCell.value = row.label;
    labelCell.alignment = { horizontal: "left", vertical: "middle", indent: INDENT[row.level] };
    labelCell.border = allBorders;
    labelCell.font = {
      bold: row.level !== "activity",
      size: row.level === "unit" ? 12 : row.level === "major" ? 11 : 10,
    };
    metricsOf(row).forEach((m, gi) => {
      METRIC_KEYS.forEach((k, i) => setMetric(xr.getCell(2 + gi * 3 + i), m[k]));
    });
    METRIC_KEYS.forEach((k, i) =>
      setRate(xr.getCell(2 + groups.length * 3 + i), row.ytd[k], row.plan[k], input.targetRatio),
    );
    const fill =
      row.level === "unit" ? COLOR.unitFill : row.level === "major" ? COLOR.majorFill : null;
    if (fill) {
      for (let c = 1; c <= detailLastCol; c++) {
        xr.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      }
    }
    r++;
  }
  if (input.rows.length === 0) {
    detail.mergeCells(r, 1, r, detailLastCol);
    detail.getCell(r, 1).value = "조회된 실적이 없습니다.";
    r++;
  }
  writeNotes(detail, r + 1, detailLastCol, input);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = input.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
