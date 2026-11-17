// Manual QA Gap Fix §10-11: Excel에서 표를 복사해 그대로 붙여넣는 입력을
// 파싱한다. Excel 복사는 열을 탭(\t), 행을 줄바꿈으로 구분한다. 헤더 행이
// 포함돼 있으면(별칭까지 인식) 열 순서를 헤더 기준으로 재배치하고, 헤더가
// 없으면 호출자가 지정한 고정 순서를 그대로 데이터로 취급한다.

export type PasteColumnSpec = { key: string; aliases: string[] };

export function parsePastedTable(
  text: string,
  columns: PasteColumnSpec[],
): { rows: Record<string, string>[]; headerDetected: boolean } {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.split("\t").map((c) => c.trim()));
  const nonEmpty = lines.filter((l) => l.some((c) => c !== ""));
  if (nonEmpty.length === 0) return { rows: [], headerDetected: false };

  const first = nonEmpty[0]!;
  const normalize = (s: string) => s.replace(/\s/g, "");
  const headerIdx = columns.map((c) =>
    first.findIndex((cell) => c.aliases.includes(normalize(cell))),
  );
  const headerDetected = headerIdx.every((i) => i !== -1);

  const dataLines = headerDetected ? nonEmpty.slice(1) : nonEmpty;
  const colIdx = headerDetected ? headerIdx : columns.map((_, i) => i);

  const rows = dataLines.map((line) => {
    const obj: Record<string, string> = {};
    columns.forEach((c, i) => {
      obj[c.key] = (line[colIdx[i]!] ?? "").trim();
    });
    return obj;
  });
  return { rows, headerDetected };
}
