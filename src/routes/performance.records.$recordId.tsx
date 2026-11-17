import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  StaffLayout,
  Panel,
  PanelHeader,
  btnDangerCls,
  btnPrimaryCls,
  btnRowCls,
  btnSecondaryCls,
  controlCls,
} from "@/components/layout/StaffLayout";
import { formatDateTime } from "@/lib/format";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  methodLabel,
  usePerformanceRecordDetail,
  useUpdateSummaryPerformance,
  useCancelPerformance,
  useRestorePerformance,
} from "@/lib/performance-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

export const Route = createFileRoute("/performance/records/$recordId")({
  // 실적내역에서 넘어온 조회 조건. 이 화면에서는 쓰지 않고 [← 실적내역]에 그대로 돌려준다.
  validateSearch: (
    search: Record<string, unknown>,
  ): { yearId?: string; from?: string; to?: string; unitId?: string } => ({
    ...(typeof search["yearId"] === "string" ? { yearId: search["yearId"] } : {}),
    ...(typeof search["from"] === "string" ? { from: search["from"] } : {}),
    ...(typeof search["to"] === "string" ? { to: search["to"] } : {}),
    ...(typeof search["unitId"] === "string" ? { unitId: search["unitId"] } : {}),
  }),
  head: () => ({
    meta: [
      { title: "실적 상세 — WellLink" },
      { name: "description", content: "실적내역에서 진입하는 실적 상세 화면입니다." },
      { property: "og:title", content: "실적 상세 — WellLink" },
      { property: "og:description", content: "산출근거와 등록내용을 확인하는 실적 상세." },
    ],
  }),
  component: RecordDetailPage,
});

const labelCls = "w-28 shrink-0 pt-2 text-sm text-muted-foreground";
const rowCls = "flex items-start gap-3 border-b border-border px-4 py-3 last:border-0";
const inputCls = controlCls;
const valueCls = "pt-1.5 text-sm text-foreground";

function RecordDetailPage() {
  // 실적내역에서 넘어온 조회 조건을 그대로 돌려준다(목록이 초기화되지 않게).
  const listSearch = Route.useSearch();
  const backToList = { label: "실적내역", to: "/performance/records", search: listSearch } as const;
  const { recordId } = Route.useParams();
  const { data: record, isLoading } = usePerformanceRecordDetail(recordId);
  const update = useUpdateSummaryPerformance();
  const cancel = useCancelPerformance();
  const restore = useRestorePerformance();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [operationDate, setOperationDate] = useState("");
  const [content, setContent] = useState("");
  const [count, setCount] = useState(0);
  const [unique, setUnique] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!record) return;
    setOperationDate(record.operationDate);
    setContent(record.activityContent ?? "");
    setCount(record.countValue);
    setUnique(record.uniquePeopleValue);
    setTotal(record.totalPeopleValue);
  }, [record?.id]);

  if (isLoading) {
    return (
      <StaffLayout title="실적 상세" back={backToList}>
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        </Panel>
      </StaffLayout>
    );
  }

  if (!record) {
    return (
      <StaffLayout title="실적 상세" back={backToList}>
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">해당 실적을 찾을 수 없습니다.</p>
        </Panel>
      </StaffLayout>
    );
  }

  const readOnly = record.status === "cancelled";
  const invalid = unique > total;
  const contentTooLong = content.length > 100;

  if (record.method === "attendance") {
    const info: [string, string][] = [
      ["활동", record.activityName],
      ["등록방식", methodLabel(record.method)],
      ["운영구분", record.operationTermName ?? "-"],
      ["회차", record.sessionNo ? `${record.sessionNo}회차` : "-"],
      ["회차일", record.operationDate],
      ["생성일시", formatDateTime(record.createdAt)],
      ["생성방식", "출석 확정 후 자동 생성"],
    ];
    return (
      <StaffLayout title="실적 상세" back={backToList}>
        <Panel className="mb-4">
          <PanelHeader title="기본정보" />
          <dl className="grid gap-x-10 gap-y-3 px-4 py-4 text-sm sm:grid-cols-2">
            {info.map(([k, v]) => (
              <div key={k} className="flex gap-4 border-b border-border/60 pb-2.5">
                <dt className="w-24 shrink-0 text-muted-foreground">{k}</dt>
                <dd className="text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel className="mb-4">
          <PanelHeader
            title="실적 산출"
            action={
              <Link
                to="/attendance/sessions/$sessionId"
                params={{ sessionId: record.sourceSessionId ?? "" }}
                className={btnRowCls}
              >
                출석기록 보기
              </Link>
            }
          />
          <div className="grid grid-cols-3 gap-4 px-4 py-4">
            {(
              [
                ["건", record.countValue],
                ["실인원", record.uniquePeopleValue],
                ["연인원", record.totalPeopleValue],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="mt-0.5 text-base font-medium tabular-nums text-foreground">
                  {v ?? "-"}
                </div>
              </div>
            ))}
          </div>
          <p className="border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
            출석 확정 결과로 자동 생성된 실적입니다. 출석 정정 시 실적도 자동 반영되며 직접
            수정·취소할 수 없습니다.
          </p>
        </Panel>
      </StaffLayout>
    );
  }

  // 실적이 속한 사업연도(= 달력 연도) 밖으로 날짜를 옮기면 목록·보고서에서 사라진다.
  const recordYear = Number(record.operationDate.slice(0, 4));
  const yearStart = `${recordYear}-01-01`;
  const yearEnd = `${recordYear}-12-31`;
  const dateOutOfYear = operationDate < yearStart || operationDate > yearEnd;
  const canSave =
    !invalid &&
    !contentTooLong &&
    !dateOutOfYear &&
    operationDate.trim() !== "" &&
    !update.isPending;

  const submitUpdate = async () => {
    if (!canSave) return;
    try {
      await update.mutateAsync({
        id: record.id,
        operationDate,
        activityContent: content,
        countValue: count,
        uniquePeopleValue: unique,
        totalPeopleValue: total,
      });
      toast.success("실적을 수정했습니다.");
    } catch (e: any) {
      toast.error(`수정 실패: ${errorReason(e)}`);
    }
  };

  const submitCancel = async () => {
    if (reason.trim() === "") return;
    try {
      await cancel.mutateAsync({ id: record.id, reason });
      toast.success("실적을 취소했습니다.");
      setDialogOpen(false);
      setReason("");
    } catch (e: any) {
      toast.error(`취소 실패: ${errorReason(e)}`);
    }
  };

  const submitRestore = async () => {
    try {
      await restore.mutateAsync(record.id);
      toast.success("실적을 복구했습니다.");
    } catch (e: any) {
      toast.error(`복구 실패: ${errorReason(e)}`);
    }
  };

  return (
    <StaffLayout title="실적 상세" back={backToList}>
      <Panel className="mb-4">
        <PanelHeader
          title="기본정보"
          action={readOnly ? <StatusBadge label="취소됨" tone="danger" /> : undefined}
        />
        <div className={rowCls}>
          <span className={labelCls}>활동</span>
          <span className={valueCls}>{record.activityName}</span>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>등록방식</span>
          <span className={valueCls}>{methodLabel(record.method)}</span>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>운영일자</span>
          {readOnly ? (
            <span className={valueCls}>{record.operationDate}</span>
          ) : (
            <div>
              <input
                type="date"
                value={operationDate}
                min={yearStart}
                max={yearEnd}
                onChange={(e) => setOperationDate(e.target.value)}
                className={inputCls}
              />
              {dateOutOfYear && (
                <p className="mt-1 text-[13px] text-status-danger-fg">
                  {recordYear}년 사업연도 안의 날짜만 저장할 수 있습니다.
                </p>
              )}
            </div>
          )}
        </div>
        <div className={rowCls}>
          <span className={labelCls}>활동내용</span>
          {readOnly ? (
            <span className={valueCls}>{record.activityContent || "-"}</span>
          ) : (
            <div>
              <input
                maxLength={100}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className={`${inputCls} w-96 max-w-full`}
              />
              {contentTooLong && (
                <p className="mt-1 text-xs text-status-danger-fg">
                  활동내용은 100자를 넘을 수 없습니다.
                </p>
              )}
            </div>
          )}
        </div>
        <div className={rowCls}>
          <span className={labelCls}>등록일시</span>
          <span className={valueCls}>{formatDateTime(record.createdAt)}</span>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>등록자</span>
          <span className={valueCls}>{record.creatorName ?? "-"}</span>
        </div>
        {readOnly && (
          <>
            <div className={rowCls}>
              <span className={labelCls}>취소 사유</span>
              <span className={valueCls}>{record.cancelReason ?? "-"}</span>
            </div>
            <div className={rowCls}>
              <span className={labelCls}>취소 일시</span>
              <span className={valueCls}>
                {record.cancelledAt ? formatDateTime(record.cancelledAt) : "-"}
              </span>
            </div>
          </>
        )}
      </Panel>

      <Panel className="mb-4">
        <PanelHeader title="실적 산출값" />
        {readOnly ? (
          <>
            <div className={rowCls}>
              <span className={labelCls}>건</span>
              <span className={valueCls}>{record.countValue}</span>
            </div>
            <div className={rowCls}>
              <span className={labelCls}>실인원</span>
              <span className={valueCls}>{record.uniquePeopleValue}</span>
            </div>
            <div className={rowCls}>
              <span className={labelCls}>연인원</span>
              <span className={valueCls}>{record.totalPeopleValue}</span>
            </div>
          </>
        ) : (
          <>
            <div className={rowCls}>
              <span className={labelCls}>건</span>
              <input
                type="number"
                min={0}
                value={count}
                onChange={(e) => setCount(Math.max(0, Number(e.target.value) || 0))}
                className={`${inputCls} w-28`}
              />
            </div>
            <div className={rowCls}>
              <span className={labelCls}>실인원</span>
              <div>
                <input
                  type="number"
                  min={0}
                  value={unique}
                  onChange={(e) => setUnique(Math.max(0, Number(e.target.value) || 0))}
                  className={`${inputCls} w-28`}
                />
                {invalid && (
                  <p className="mt-1 text-xs text-status-danger-fg">
                    실인원은 연인원보다 클 수 없습니다.
                  </p>
                )}
              </div>
            </div>
            <div className={rowCls}>
              <span className={labelCls}>연인원</span>
              <input
                type="number"
                min={0}
                value={total}
                onChange={(e) => setTotal(Math.max(0, Number(e.target.value) || 0))}
                className={`${inputCls} w-28`}
              />
            </div>
          </>
        )}
      </Panel>

      <div className="flex justify-end gap-2">
        {readOnly ? (
          <button
            disabled={restore.isPending}
            onClick={submitRestore}
            className={btnPrimaryCls}
          >
            복구
          </button>
        ) : (
          <>
            <button
              onClick={() => setDialogOpen(true)}
              className={btnSecondaryCls}
            >
              실적 취소
            </button>
            <button
              disabled={!canSave}
              onClick={submitUpdate}
              className={btnPrimaryCls}
            >
              수정 저장
            </button>
          </>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>실적 취소</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">취소 사유</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={`${inputCls} w-full`}
            />
            <p className="text-[13px] text-muted-foreground">
              취소된 실적은 현재 집계에서 제외되며 기록은 삭제되지 않습니다.
            </p>
          </div>
          <DialogFooter>
            <button
              onClick={() => setDialogOpen(false)}
              className={btnSecondaryCls}
            >
              닫기
            </button>
            <button
              disabled={reason.trim() === "" || cancel.isPending}
              onClick={submitCancel}
              className={btnDangerCls}
            >
              {cancel.isPending ? "처리 중…" : "실적 취소"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </StaffLayout>
  );
}
