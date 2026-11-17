type Tone = "neutral" | "info" | "success" | "warn" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  info: "border-status-info-border bg-status-info-bg text-status-info-fg",
  success: "border-status-success-border bg-status-success-bg text-status-success-fg",
  warn: "border-status-warn-border bg-status-warn-bg text-status-warn-fg",
  danger: "border-status-danger-border bg-status-danger-bg text-status-danger-fg",
};

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium ${TONE[tone]}`}
    >
      {label}
    </span>
  );
}

const SESSION_TONE: Record<string, Tone> = {
  입력중: "info",
  완료: "success",
  누락: "danger",
  휴강: "neutral",
};

// 회차 상태: 수업 전(빈 문자열)/입력중/완료/누락/휴강. 빈 상태는 배지를
// 그리지 않는다("수업 전"이라는 사실 자체를 굳이 강조하지 않는다).
export function SessionStatusBadge({ status }: { status: string }) {
  if (!status) return null;
  return <StatusBadge label={status} tone={SESSION_TONE[status] ?? "neutral"} />;
}
