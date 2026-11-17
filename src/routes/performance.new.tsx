import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  StaffLayout,
  Panel,
  btnPrimaryCls,
  btnSecondaryCls,
  controlCls,
} from "@/components/layout/StaffLayout";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  methodLabel,
  useActivityTreeForYear,
  useBusinessYears,
  useCreateSummaryPerformance,
} from "@/lib/performance-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

export const Route = createFileRoute("/performance/new")({
  head: () => ({
    meta: [
      { title: "실적 직접 등록 — WellLink" },
      {
        name: "description",
        content: "활동을 선택하면 등록방식에 맞는 실적 등록 화면이 표시됩니다.",
      },
      { property: "og:title", content: "실적 직접 등록 — WellLink" },
      { property: "og:description", content: "활동별 실적 등록 화면." },
    ],
  }),
  component: NewPerformancePage,
});

const labelCls = "w-28 shrink-0 pt-2 text-sm text-muted-foreground";
const rowCls = "flex items-start gap-3 px-4 py-3 border-b border-border last:border-0";
const inputCls = controlCls;

// 기기(한국) 시간 기준 오늘. toISOString()은 표준시라 오전 9시 전에는 어제가 채워졌다.
function todayIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function NewPerformancePage() {
  const { data: years } = useBusinessYears();
  const [businessYearId, setBusinessYearId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!businessYearId && years && years.length > 0) {
      setBusinessYearId((years.find((y) => y.status === "active") ?? years[0])?.id);
    }
  }, [years, businessYearId]);

  const { data: tree } = useActivityTreeForYear(businessYearId);
  const [unitId, setUnitId] = useState("");
  const [majorId, setMajorId] = useState("");
  const [middleId, setMiddleId] = useState("");
  const [activityId, setActivityId] = useState("");

  // 윗단계를 바꾸면 아랫단계는 비우고, 선택지가 하나뿐인 단계는 자동으로 고른다.
  const pick = <T extends { id: string }>(list: T[], id: string) =>
    list.find((x) => x.id === id) ?? (list.length === 1 ? list[0] : undefined);
  const units = tree ?? [];
  const unit = pick(units, unitId);
  const majors = unit?.majors ?? [];
  const major = pick(majors, majorId);
  const middles = major?.middles ?? [];
  const middle = pick(middles, middleId);
  const activities = middle?.activities ?? [];
  const activity = pick(activities, activityId);

  const levelSelect = (
    placeholder: string,
    list: { id: string; name: string }[],
    value: string | undefined,
    onChange: (id: string) => void,
    disabled: boolean,
  ) => (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`${inputCls} max-w-full disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <option value="">{placeholder}</option>
      {list.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );

  return (
    <StaffLayout title="실적 직접 등록" back={{ label: "실적내역", to: "/performance/records" }}>
      <Panel className="mb-4">
        <div className={rowCls}>
          <span className={labelCls}>활동</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {levelSelect(
              "사업",
              units,
              unit?.id,
              (id) => {
                setUnitId(id);
                setMajorId("");
                setMiddleId("");
                setActivityId("");
              },
              units.length === 0,
            )}
            {levelSelect(
              "대분류",
              majors,
              major?.id,
              (id) => {
                setMajorId(id);
                setMiddleId("");
                setActivityId("");
              },
              !unit,
            )}
            {levelSelect(
              "중분류",
              middles,
              middle?.id,
              (id) => {
                setMiddleId(id);
                setActivityId("");
              },
              !major,
            )}
            {levelSelect("활동", activities, activity?.id, setActivityId, !middle)}
            {activity && <StatusBadge label={methodLabel(activity.method)} tone="info" />}
          </div>
        </div>
      </Panel>

      {!activity && (
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">
            활동을 선택하면 해당 활동의 등록방식에 맞는 화면이 표시됩니다.
          </p>
        </Panel>
      )}

      {activity && activity.method === "attendance" && (
        <Panel className="p-6">
          <p className="text-sm text-foreground">이 활동은 출석연동 활동입니다.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            출석이 확정되면 실적이 자동으로 만들어집니다. 이 화면에서 직접 등록할 수 없습니다.
          </p>
          <Link
            to="/attendance/programs"
            className="mt-4 inline-block rounded border border-border px-3 py-1.5 text-sm text-foreground"
          >
            프로그램 보기
          </Link>
        </Panel>
      )}

      {activity && activity.method === "summary" && (
        <SummaryForm
          activityId={activity.id}
          activityName={activity.name}
          year={years?.find((y) => y.id === businessYearId)?.year}
        />
      )}
    </StaffLayout>
  );
}

function SummaryForm({
  activityId,
  activityName,
  year,
}: {
  activityId: string;
  activityName: string;
  year: number | undefined;
}) {
  const navigate = useNavigate();
  const create = useCreateSummaryPerformance();
  const [operationDate, setOperationDate] = useState(todayIso());
  const [content, setContent] = useState("");
  const [count, setCount] = useState(1);
  const [unique, setUnique] = useState(0);
  const [total, setTotal] = useState(0);
  const invalid = unique > total;
  const contentTooLong = content.length > 100;
  // 사업연도 밖 날짜로 저장하면 실적내역·실적보고 어디에도 보이지 않는다 -- 화면에서 막는다.
  const yearStart = year ? `${year}-01-01` : undefined;
  const yearEnd = year ? `${year}-12-31` : undefined;
  const dateOutOfYear =
    !!yearStart && !!yearEnd && (operationDate < yearStart || operationDate > yearEnd);

  const numInput = (value: number, set: (n: number) => void) => (
    <input
      type="number"
      min={0}
      value={value}
      onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))}
      className={`${inputCls} w-28`}
    />
  );

  const canSave =
    !invalid &&
    !contentTooLong &&
    !dateOutOfYear &&
    operationDate.trim() !== "" &&
    !create.isPending;

  const submit = async () => {
    if (!canSave) return;
    try {
      const id = await create.mutateAsync({
        activityId,
        operationDate,
        activityContent: content,
        countValue: count,
        uniquePeopleValue: unique,
        totalPeopleValue: total,
      });
      toast.success("실적을 등록했습니다.");
      navigate({ to: "/performance/records/$recordId", params: { recordId: id } });
    } catch (e: any) {
      toast.error(`등록 실패: ${errorReason(e)}`);
    }
  };

  return (
    <>
      <Panel>
        <div className={rowCls}>
          <span className={labelCls}>활동</span>
          <span className="pt-1.5 text-sm text-foreground">{activityName}</span>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>등록방식</span>
          <span className="pt-1.5 text-sm text-foreground">직접 등록</span>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>운영일자</span>
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
                {year}년 사업연도 안의 날짜만 등록할 수 있습니다.
              </p>
            )}
          </div>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>활동내용</span>
          <div>
            <input
              maxLength={100}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="예: 치매예방 열린강좌"
              className={`${inputCls} w-96 max-w-full`}
            />
            {contentTooLong && (
              <p className="mt-1 text-xs text-status-danger-fg">
                활동내용은 100자를 넘을 수 없습니다.
              </p>
            )}
          </div>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>건</span>
          {numInput(count, setCount)}
        </div>
        <div className={rowCls}>
          <span className={labelCls}>실인원</span>
          <div>
            {numInput(unique, setUnique)}
            {invalid && (
              <p className="mt-1 text-xs text-status-danger-fg">
                실인원은 연인원보다 클 수 없습니다.
              </p>
            )}
          </div>
        </div>
        <div className={rowCls}>
          <span className={labelCls}>연인원</span>
          {numInput(total, setTotal)}
        </div>
      </Panel>
      <div className="mt-4 flex justify-end gap-2">
        <Link
          to="/performance/records"
          className={btnSecondaryCls}
        >
          취소
        </Link>
        <button
          disabled={!canSave}
          onClick={submit}
          className={btnPrimaryCls}
        >
          실적 저장
        </button>
      </div>
    </>
  );
}
