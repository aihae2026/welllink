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
import {
  useAddEnrollments,
  useOperationTermSessions,
  usePreviewAddEnrollments,
  type ExistingMemberState,
} from "@/lib/programs-data";
import { parsePastedTable } from "@/lib/paste-parse";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

// 수강생 추가: "붙여넣기"와 "직접 입력" 모두 [내용 확인] -> 미리보기 -> 추가 순서로
// 같은 검증을 거친다. add_enrollments는 한 행이라도 틀리면 전체를 되돌리고, 이미
// 있는 회원번호면 입력한 성명을 보지 않고 기존 회원으로 등록한다. 그래서 등록 전에
// preview_add_enrollments로 회원번호별 기존 성명/수강 상태를 받아 대조하고, 서버가
// 거부하거나 다른 사람이 들어갈 수 있는 행은 빼고 나머지만 보낸다. 최초 수강명단과
// 달리 "등록 완료" 잠금이 없어서, 뺀 행은 고친 뒤 다시 추가하면 된다.

type InputRow = { code: string; name: string };

type RowKind = "new" | "existing" | "reenroll" | "skip" | "review";

type CheckedRow = {
  code: string;
  name: string;
  existingName: string | null;
  kind: RowKind;
  reason: string | undefined;
};

const KIND_LABEL: Record<"new" | "existing" | "reenroll", string> = {
  new: "신규",
  existing: "기존 회원",
  reenroll: "재등록",
};

const COLUMNS = [
  { key: "member_code", aliases: ["회원번호", "회원코드"] },
  { key: "name", aliases: ["성명"] },
];

const compactName = (s: string) => s.replace(/\s/g, "");

function parsePaste(text: string): InputRow[] {
  const { rows } = parsePastedTable(text, COLUMNS);
  return rows.map((r) => ({ code: r["member_code"] ?? "", name: r["name"] ?? "" }));
}

// 서버 조회 없이 형식만으로 거를 수 있는 오류. 이 오류가 없는 회원번호만 조회한다.
function formatError(code: string): string | undefined {
  if (!code) return "회원번호 없음";
  if (code.length > 40) return "회원번호가 너무 깁니다(40자 이내).";
  return undefined;
}

function classifyRows(input: InputRow[], existing: Map<string, ExistingMemberState>): CheckedRow[] {
  const rows = input.map((r) => ({ code: r.code.trim(), name: r.name.trim() }));

  // 같은 회원번호에 서로 다른 성명이 적혀 있으면 어느 쪽이 맞는지 알 수 없으므로
  // 그 회원번호의 모든 줄을 확인 필요로 둔다(띄어쓰기 차이는 같은 이름으로 본다).
  const namesByCode = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.code || !r.name) continue;
    const names = namesByCode.get(r.code) ?? new Set<string>();
    names.add(compactName(r.name));
    namesByCode.set(r.code, names);
  }
  const accepted = new Set<string>();

  return rows.map((r) => {
    const member = existing.get(r.code) ?? null;
    const row = (kind: RowKind, reason?: string): CheckedRow => ({
      code: r.code,
      name: r.name,
      existingName: member?.name ?? null,
      kind,
      reason,
    });

    const fmt = formatError(r.code);
    if (fmt) return row("review", fmt);
    if ((namesByCode.get(r.code)?.size ?? 0) > 1)
      return row("review", "같은 회원번호인데 성명이 다릅니다.");
    if (member?.activeInTerm) return row("skip", "이미 이 프로그램을 수강 중입니다.");
    if (!member && !r.name) return row("review", "신규 회원번호는 성명이 필요합니다.");
    if (member && r.name && compactName(r.name) !== compactName(member.name))
      return row("review", `기존 회원 성명(${member.name})과 다릅니다.`);

    if (accepted.has(r.code)) return row("skip", "같은 회원번호가 반복되어 한 번만 추가합니다.");
    accepted.add(r.code);
    if (!member) return row("new");
    return row(member.endedInTerm ? "reenroll" : "existing");
  });
}

type SessionLike = { session_no: number; starts_at: string; status: string };

// add_enrollments와 같은 기준: 지금 이후 시작하는 예정 회차 중 가장 앞 회차.
function nextSessionLabel(sessions: SessionLike[]): string | null {
  const now = Date.now();
  const next = sessions
    .filter((s) => s.status === "scheduled" && new Date(s.starts_at).getTime() > now)
    .sort((a, b) => a.session_no - b.session_no)[0];
  if (!next) return null;
  const d = new Date(next.starts_at);
  const weekday = d.toLocaleDateString("ko-KR", { weekday: "short" });
  return `${next.session_no}회차(${d.getMonth() + 1}/${d.getDate()} ${weekday})`;
}

function RowTable({
  rows,
  tone,
  third,
}: {
  rows: CheckedRow[];
  tone: "danger" | "muted" | "plain";
  third: (r: CheckedRow) => string;
}) {
  const box =
    tone === "danger"
      ? "border-status-danger-border bg-status-danger-bg"
      : tone === "muted"
        ? "border-border bg-muted/40 text-muted-foreground"
        : "border-border";
  const line = tone === "danger" ? "border-status-danger-border/50" : "border-border";
  return (
    <div className={`max-h-48 overflow-y-auto rounded border ${box}`}>
      <table className="w-full table-fixed text-xs">
        <colgroup>
          <col className="w-32" />
          <col className="w-24" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-b ${line} last:border-0`}>
              <td className="px-2 py-1.5">{r.code || "-"}</td>
              <td className="px-2 py-1.5">{r.name || r.existingName || "-"}</td>
              <td className={`px-2 py-1.5 ${tone === "danger" ? "text-status-danger-fg" : ""}`}>
                {third(r)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AddStudentsDialog({
  open,
  onOpenChange,
  operationTermId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  operationTermId: string;
}) {
  const [mode, setMode] = useState<"paste" | "manual">("paste");
  const [pasteText, setPasteText] = useState("");
  const [manualRows, setManualRows] = useState<InputRow[]>([{ code: "", name: "" }]);
  const [rows, setRows] = useState<CheckedRow[] | null>(null);
  const add = useAddEnrollments(operationTermId);
  const preview = usePreviewAddEnrollments(operationTermId);
  const { data: sessions } = useOperationTermSessions(operationTermId);

  const startLabel = nextSessionLabel(sessions ?? []);
  const registerRows = (rows ?? []).filter(
    (r) => r.kind === "new" || r.kind === "existing" || r.kind === "reenroll",
  );
  const reviewRows = (rows ?? []).filter((r) => r.kind === "review");
  const skipRows = (rows ?? []).filter((r) => r.kind === "skip");
  const countOf = (k: RowKind) => registerRows.filter((r) => r.kind === k).length;
  const breakdown = (["new", "existing", "reenroll"] as const)
    .filter((k) => countOf(k) > 0)
    .map((k) => `${KIND_LABEL[k]} ${countOf(k)}`)
    .join(" · ");
  const canRegister = registerRows.length > 0 && !!startLabel;

  const input = (): InputRow[] =>
    mode === "paste"
      ? parsePaste(pasteText)
      : manualRows.filter((r) => r.code.trim() || r.name.trim());
  const hasInput = mode === "paste" ? !!pasteText.trim() : input().length > 0;

  const updateManual = (i: number, patch: Partial<InputRow>) => {
    setManualRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setRows(null);
  };

  const close = () => {
    onOpenChange(false);
    setPasteText("");
    setManualRows([{ code: "", name: "" }]);
    setRows(null);
  };

  const check = async () => {
    const inputRows = input();
    const codes = [
      ...new Set(inputRows.map((r) => r.code.trim()).filter((c) => c && !formatError(c))),
    ];
    try {
      const existing =
        codes.length > 0
          ? await preview.mutateAsync(codes)
          : new Map<string, ExistingMemberState>();
      setRows(classifyRows(inputRows, existing));
    } catch (e: any) {
      toast.error(`확인 실패: ${errorReason(e)}`);
    }
  };

  const submit = async () => {
    if (!canRegister) return;
    try {
      const n = await add.mutateAsync(
        registerRows.map((r) => ({ member_code: r.code, name: r.name || r.existingName || "" })),
      );
      toast.success(
        `${n}명을 추가했습니다. ${startLabel}부터 수강합니다.`,
        reviewRows.length > 0
          ? { description: `확인이 필요한 ${reviewRows.length}행은 고친 뒤 다시 추가해 주세요.` }
          : undefined,
      );
      close();
    } catch (e: any) {
      toast.error(`추가 실패: ${errorReason(e)}`);
    }
  };

  function switchMode(next: "paste" | "manual") {
    setMode(next);
    setRows(null);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>수강생 추가</DialogTitle>
          <DialogDescription>
            회원번호와 성명을 붙여넣거나 직접 입력한 뒤 [내용 확인]을 누르면 기존 회원 여부와 성명을
            대조해 보여줍니다. 확인이 필요한 행은 빼고 나머지만 추가하며, 가장 가까운 예정 회차부터
            수강합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border">
          {(["paste", "manual"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                mode === m
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {m === "paste" ? "붙여넣기" : "직접 입력"}
            </button>
          ))}
        </div>

        {mode === "paste" ? (
          <>
            <p className="text-[13px] text-muted-foreground">
              엑셀에서 회원번호와 성명을 복사해 붙여넣으세요.
            </p>
            <textarea
              className={`${controlCls} h-32 resize-y font-mono text-xs`}
              placeholder={"회원번호\t성명\n00123\t홍길동\nA-1034\t김영희"}
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                setRows(null);
              }}
            />
          </>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span>회원번호</span>
              <span>성명</span>
            </div>
            {manualRows.map((r, i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <input
                  value={r.code}
                  onChange={(e) => updateManual(i, { code: e.target.value })}
                  placeholder="예: 00123, A-1034"
                  className="w-full rounded border border-input bg-card px-2 py-1.5 text-sm"
                />
                <input
                  value={r.name}
                  onChange={(e) => updateManual(i, { name: e.target.value })}
                  placeholder="성명(기존 회원은 비워도 됨)"
                  className="w-full rounded border border-input bg-card px-2 py-1.5 text-sm"
                />
              </div>
            ))}
            <button
              onClick={() => setManualRows((prev) => [...prev, { code: "", name: "" }])}
              className="rounded border border-border bg-card px-2.5 py-1 text-xs hover:bg-muted"
            >
              + 행 추가
            </button>
          </div>
        )}

        <div>
          <button
            className={btnSecondaryCls}
            onClick={check}
            disabled={!hasInput || preview.isPending}
          >
            {preview.isPending ? "확인 중..." : "내용 확인"}
          </button>
        </div>

        {rows && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              전체 {rows.length}행 · 추가 {registerRows.length}명{breakdown && `(${breakdown})`}
              {reviewRows.length + skipRows.length > 0 &&
                ` · 제외 ${reviewRows.length + skipRows.length}행`}
            </p>

            {startLabel ? (
              <p className="text-muted-foreground">{startLabel}부터 수강합니다.</p>
            ) : (
              <p className="font-medium text-status-danger-fg">
                추가할 수 있는 예정 회차가 없습니다. 회차 및 출석현황에서 예정 회차를 확인해 주세요.
              </p>
            )}

            {reviewRows.length > 0 && (
              <div className="space-y-1.5">
                <p className="font-medium text-status-danger-fg">
                  확인이 필요한 행 (이번 추가에서 제외)
                </p>
                <RowTable rows={reviewRows} tone="danger" third={(r) => r.reason ?? ""} />
              </div>
            )}

            {skipRows.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">추가하지 않는 행</p>
                <RowTable rows={skipRows} tone="muted" third={(r) => r.reason ?? ""} />
              </div>
            )}

            {registerRows.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-status-success-fg">
                  아래 {registerRows.length}명은 추가 버튼을 누르면 반영됩니다.
                </p>
                <RowTable
                  rows={registerRows}
                  tone="plain"
                  third={(r) => KIND_LABEL[r.kind as keyof typeof KIND_LABEL]}
                />
              </div>
            ) : (
              <p className="font-medium text-status-danger-fg">추가할 수 있는 행이 없습니다.</p>
            )}
          </div>
        )}

        <DialogFooter>
          <button onClick={close} className={btnSecondaryCls}>
            닫기
          </button>
          <button
            onClick={submit}
            disabled={!canRegister || add.isPending}
            className={btnPrimaryCls}
          >
            {rows ? `${registerRows.length}명 추가` : "추가"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
