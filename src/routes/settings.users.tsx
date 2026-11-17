import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  StaffLayout,
  Panel,
  PanelHeader,
  btnPrimaryCls,
  btnSecondaryCls,
  controlCls,
  theadCls,
} from "@/components/layout/StaffLayout";
import { OrgSettingsTabs } from "@/components/layout/OrgSettingsTabs";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import {
  useStaffAccounts,
  useInstructorAccounts,
  useProvisionStaff,
  useUpdateStaffInfo,
  useUpdateStaffRole,
  useSetStaffActive,
  useResetStaffPassword,
  useProvisionInstructor,
  useIssueInstructorStartCode,
  useSetInstructorActive,
  type BusinessRole,
  type StaffAccountRow,
  type InstructorAccountRow,
  instructorPinStatus,
} from "@/lib/user-management-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

export const Route = createFileRoute("/settings/users")({
  head: () => ({
    meta: [
      { title: "사용자 관리 — WellLink" },
      { name: "description", content: "직원·강사 계정과 접근권한을 관리합니다." },
      { property: "og:title", content: "사용자 관리 — WellLink" },
      { property: "og:description", content: "직원·강사 계정 및 접근권한 관리 화면." },
    ],
  }),
  component: UsersPage,
});

// 다른 화면과 같은 공통 버튼·입력칸(36px)을 쓴다.
const btnCls = btnSecondaryCls;
const primaryBtn = btnPrimaryCls;
const inputCls = `${controlCls} w-full`;
const th = "px-4 py-2 text-left text-xs font-medium text-muted-foreground";
const td = "px-4 py-2.5 text-foreground";

// Core Setup Model Simplification § Phase 4B: 사용자-facing 직원 권한은 "관리자"
// (business_role=global_manager, is_system_admin=true) / "일반"
// (business_role=staff, is_system_admin=false) 두 개만 노출한다. 두 내부값은
// 이 화면에서 항상 하나의 선택(Permission)에서 함께 파생되며, 신규 UI는 raw
// enum(department_manager/global_viewer)이나 is_system_admin 체크박스를 절대
// 별도로 노출하지 않는다. 기존 legacy 조합(department_manager/global_viewer/
// global_manager+false 등)을 가진 실제 계정은 이번 Phase에서 임의로 변환하지
// 않으므로, 그런 계정은 "관리자"도 "일반"도 아닌 "기존 권한"(선택 불가능한
// 과도기 표시)으로만 보여준다 -- 실제로 권한을 변경하는 순간에만 canonical
// 모델로 전환된다.
type Permission = "admin" | "general";
const PERMISSION_OPTIONS: { value: Permission; label: string }[] = [
  { value: "admin", label: "관리자" },
  { value: "general", label: "일반" },
];
const permissionLabel = (p: Permission) => (p === "admin" ? "관리자" : "일반");
function permissionOf(row: {
  businessRole: BusinessRole;
  isSystemAdmin: boolean;
}): Permission | "legacy" {
  if (row.businessRole === "global_manager" && row.isSystemAdmin === true) return "admin";
  if (row.businessRole === "staff" && row.isSystemAdmin === false) return "general";
  return "legacy";
}
function permissionToRaw(p: Permission): { businessRole: BusinessRole; isSystemAdmin: boolean } {
  return p === "admin"
    ? { businessRole: "global_manager", isSystemAdmin: true }
    : { businessRole: "staff", isSystemAdmin: false };
}

function UsersPage() {
  const { staffProfile } = useAuth();
  const [tab, setTab] = useState<"직원" | "강사">("직원");

  // RPC(list_staff_accounts/list_instructor_accounts 등)가 서버에서도 다시 검사하므로
  // 이 화면 가드는 UX일 뿐이다 -- 하지만 권한 없는 사용자에게 깨진 빈 표를 보여주는 대신
  // 명확한 접근제한 안내를 보여준다.
  if (!staffProfile?.isSystemAdmin) {
    return (
      <StaffLayout title="운영설정">
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">이 화면은 관리자만 접근할 수 있습니다.</p>
        </Panel>
      </StaffLayout>
    );
  }

  return (
    <StaffLayout title="운영설정">
      <OrgSettingsTabs active="users" />
      <p className="mb-4 text-sm text-muted-foreground">
        사용자를 등록하고 계정 상태와 권한을 관리합니다.
      </p>
      <div className="mb-4 flex gap-1 border-b border-border">
        {(["직원", "강사"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "직원" ? <StaffTab /> : <InstructorTab />}
    </StaffLayout>
  );
}

/* ---------------- 직원 ---------------- */

function StaffTab() {
  const { staffProfile } = useAuth();
  const { data: list } = useStaffAccounts();
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<StaffAccountRow | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState("직원 계정이 생성되었습니다.");

  return (
    <>
      <Panel>
        <PanelHeader
          title="직원 계정"
          action={
            <button className={btnCls} onClick={() => setAddOpen(true)}>
              + 직원 추가
            </button>
          }
        />
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className={theadCls}>
              <th className={th}>이름</th>
              <th className={th}>로그인 이메일</th>
              <th className={th}>권한</th>
              <th className={th}>상태</th>
            </tr>
          </thead>
          <tbody>
            {list?.map((s) => {
              const perm = permissionOf(s);
              return (
                <tr
                  key={s.principalId}
                  onClick={() => setDetail(s)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/60"
                >
                  <td className={td}>{s.name}</td>
                  <td className={td}>{s.email ?? "-"}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge
                      label={perm === "legacy" ? "기존 권한" : permissionLabel(perm)}
                      tone={perm === "legacy" ? "warn" : perm === "admin" ? "info" : "neutral"}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge
                      label={
                        !s.isActive ? "비활성" : s.mustChangePassword ? "첫 로그인 전" : "사용중"
                      }
                      tone={!s.isActive ? "neutral" : s.mustChangePassword ? "warn" : "success"}
                    />
                  </td>
                </tr>
              );
            })}
            {list?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  등록된 직원이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="border-t border-border px-4 py-3 text-[13px] text-muted-foreground">
          관리자는 운영설정을 포함한 모든 기능에 접근 가능하며, 일반은 업무 기능만 접근할 수
          있습니다.
        </p>
      </Panel>

      <AddStaffDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        organizationId={staffProfile?.organizationId ?? ""}
        onCreated={(tempPw) => {
          setAddOpen(false);
          setTempTitle("직원 계정이 생성되었습니다.");
          setTempPassword(tempPw);
        }}
      />

      <StaffDetailDialog
        staff={detail}
        onClose={() => setDetail(null)}
        onResetPassword={(tempPw) => {
          setDetail(null);
          setTempTitle("임시 비밀번호가 재발급되었습니다.");
          setTempPassword(tempPw);
        }}
      />

      <TempPasswordDialog
        title={tempTitle}
        value={tempPassword}
        onClose={() => setTempPassword(null)}
      />
    </>
  );
}

function AddStaffDialog({
  open,
  onOpenChange,
  organizationId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  organizationId: string;
  onCreated: (tempPassword: string) => void;
}) {
  const emptyForm = { name: "", email: "", permission: "general" as Permission };
  const [form, setForm] = useState(emptyForm);
  const [wasOpen, setWasOpen] = useState(open);
  const provision = useProvisionStaff();

  if (open && !wasOpen) {
    setWasOpen(true);
    setForm(emptyForm);
  }
  if (!open && wasOpen) setWasOpen(false);

  const valid = form.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  const submit = async () => {
    if (!valid || provision.isPending) return;
    try {
      const { businessRole, isSystemAdmin } = permissionToRaw(form.permission);
      const result = await provision.mutateAsync({
        organizationId,
        name: form.name,
        email: form.email,
        businessRole,
        isSystemAdmin,
      });
      onCreated(result.tempPassword);
    } catch (e: any) {
      toast.error(`직원 추가 실패: ${errorReason(e)}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>직원 추가</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="이름 *">
            <input
              className={inputCls}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="담당자 F"
            />
          </Field>
          <Field label="로그인 이메일 *">
            <input
              className={inputCls}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="staff.f@example.invalid"
            />
          </Field>
          <Field label="권한 *">
            <select
              className={inputCls}
              value={form.permission}
              onChange={(e) => setForm({ ...form, permission: e.target.value as Permission })}
            >
              {PERMISSION_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="rounded border border-border bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground">
            관리자는 모든 기능을, 일반은 업무 기능을 사용합니다.
          </p>
          <p className="text-[13px] text-muted-foreground">
            직원은 임시 비밀번호로 최초 로그인 후 새 비밀번호를 설정합니다.
          </p>
        </div>
        <DialogFooter>
          <button className={btnCls} onClick={() => onOpenChange(false)}>
            닫기
          </button>
          <button className={primaryBtn} disabled={!valid || provision.isPending} onClick={submit}>
            직원 추가
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StaffDetailDialog({
  staff,
  onClose,
  onResetPassword,
}: {
  staff: StaffAccountRow | null;
  onClose: () => void;
  onResetPassword: (tempPassword: string) => void;
}) {
  // 기존 legacy 계정(예: 부서관리자/전체조회자, 또는 global_manager+false 같은
  // 불일치 조합)은 "관리자"도 "일반"도 아니므로 selection을 빈 값("")으로 시작해
  // 관리자가 실제로 선택지를 명시적으로 고르기 전까지는 저장 버튼이 활성화되지
  // 않게 한다(모달을 열었다 그냥 닫아도 의도치 않게 canonical로 바뀌지 않도록).
  const initialPerm = staff ? permissionOf(staff) : "legacy";
  const [selection, setSelection] = useState<Permission | "">(
    initialPerm === "legacy" ? "" : initialPerm,
  );
  const { staffProfile } = useAuth();
  const [key, setKey] = useState<string | null>(staff?.principalId ?? null);
  const [confirmPerm, setConfirmPerm] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [nameDraft, setNameDraft] = useState(staff?.name ?? "");
  const [emailDraft, setEmailDraft] = useState(staff?.email ?? "");
  const updateRole = useUpdateStaffRole();
  const updateInfo = useUpdateStaffInfo();
  const setActive = useSetStaffActive();
  const resetPassword = useResetStaffPassword();

  if (staff && key !== staff.principalId) {
    setKey(staff.principalId);
    const p = permissionOf(staff);
    setSelection(p === "legacy" ? "" : p);
    setConfirmPerm(false);
    setReason("");
    setNameDraft(staff.name);
    setEmailDraft(staff.email ?? "");
  }
  if (!staff) return null;

  const currentPerm = permissionOf(staff);
  const permChanged = selection !== "" && selection !== currentPerm;
  const infoValid =
    nameDraft.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailDraft.trim());
  const infoChanged =
    infoValid && (nameDraft.trim() !== staff.name || emailDraft.trim() !== (staff.email ?? ""));

  async function saveRole() {
    if (selection === "") return;
    try {
      const { businessRole, isSystemAdmin } = permissionToRaw(selection);
      await updateRole.mutateAsync({
        principalId: staff!.principalId,
        businessRole,
        isSystemAdmin,
        reason,
      });
      toast.success("권한을 변경했습니다.");
      setConfirmPerm(false);
      onClose();
    } catch (e: any) {
      toast.error(`권한 변경 실패: ${errorReason(e)}`);
    }
  }

  // 정보 수정(이름/이메일)은 권한 변경과 별개 액션이라 사유 확인 없이 바로
  // 저장한다. 성공하면 이어서 권한 변경이 있는지 확인해 필요한 경우 그 확인
  // 모달을 연다(§ Manual QA Gap Fix #2 3/4).
  async function saveInfoThenMaybeRole() {
    if (infoChanged) {
      try {
        await updateInfo.mutateAsync({
          principalId: staff!.principalId,
          name: nameDraft.trim(),
          email: emailDraft.trim(),
        });
        toast.success("직원 정보를 수정했습니다.");
      } catch (e: any) {
        toast.error(`정보 수정 실패: ${errorReason(e)}`);
        return;
      }
    }
    if (permChanged) {
      setConfirmPerm(true);
    } else {
      onClose();
    }
  }

  async function toggleActive() {
    if (
      staff!.isActive &&
      !window.confirm(
        `${staff!.name ?? "이 직원"} 계정을 비활성화할까요? 비활성 계정은 로그인할 수 없습니다.`,
      )
    ) {
      return;
    }
    try {
      await setActive.mutateAsync({ principalId: staff!.principalId, isActive: !staff!.isActive });
      toast.success(
        staff!.isActive ? "계정을 비활성화했습니다." : "계정을 사용중으로 변경했습니다.",
      );
      onClose();
    } catch (e: any) {
      toast.error(`상태 변경 실패: ${errorReason(e)}`);
    }
  }

  async function doResetPassword() {
    try {
      const tempPw = await resetPassword.mutateAsync(staff!.principalId);
      onResetPassword(tempPw);
    } catch (e: any) {
      toast.error(`비밀번호 초기화 실패: ${errorReason(e)}`);
    }
  }

  return (
    <>
      <Dialog open={!!staff} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{staff.name} · 직원 상세</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="이름">
              <input
                className={inputCls}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
              />
            </Field>
            <Field label="로그인 이메일">
              <input
                className={inputCls}
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
              />
              {emailDraft.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailDraft.trim()) && (
                <span className="mt-1 block text-xs text-status-danger-fg">
                  올바른 이메일 형식이 아닙니다.
                </span>
              )}
            </Field>
            <Field label="권한">
              <select
                className={inputCls}
                value={selection}
                onChange={(e) => setSelection(e.target.value as Permission)}
              >
                {currentPerm === "legacy" && (
                  <option value="" disabled>
                    권한을 선택하세요 (관리자 · 일반)
                  </option>
                )}
                {PERMISSION_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">
                현재 계정상태:{" "}
                {!staff.isActive ? "비활성" : staff.mustChangePassword ? "첫 로그인 전" : "사용중"}
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>임시 비밀번호로 로그인하면 업무화면 진입 전 새 비밀번호 설정이 강제됩니다.</li>
                <li>관리자는 직원의 비밀번호 원문을 조회하거나 재사용할 수 없습니다.</li>
              </ul>
            </div>
            <div className="flex gap-2">
              <button className={btnCls} onClick={() => setConfirmReset(true)}>
                비밀번호 초기화
              </button>
              {/* 본인 계정은 서버가 비활성화를 막으므로 버튼 자체를 두지 않는다. */}
              {staff.principalId !== staffProfile?.principalId && (
                <button className={btnCls} onClick={toggleActive} disabled={setActive.isPending}>
                  {setActive.isPending
                    ? "처리 중…"
                    : staff.isActive
                      ? "비활성으로 변경"
                      : "사용중으로 변경"}
                </button>
              )}
            </div>
          </div>
          <DialogFooter>
            <button className={btnCls} onClick={onClose}>
              닫기
            </button>
            <button
              className={primaryBtn}
              disabled={!infoValid || updateInfo.isPending}
              onClick={saveInfoThenMaybeRole}
            >
              저장
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmPerm} onOpenChange={setConfirmPerm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>권한 변경 확인</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {selection !== "" && (
              <p className="text-foreground">
                권한 · {currentPerm === "legacy" ? "기존 권한" : permissionLabel(currentPerm)} →{" "}
                {permissionLabel(selection)}
              </p>
            )}
            <Field label="변경사유 *">
              <textarea
                className="min-h-16 w-full rounded border border-input bg-card px-2.5 py-2 text-sm text-foreground"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>
          <DialogFooter>
            <button className={btnCls} onClick={() => setConfirmPerm(false)}>
              닫기
            </button>
            <button
              className={primaryBtn}
              disabled={!reason.trim() || updateRole.isPending}
              onClick={saveRole}
            >
              변경 저장
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>비밀번호 초기화</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            비밀번호를 초기화하면 새로운 일회성 임시 비밀번호가 발급되며, 직원은 최초 로그인 후 새
            비밀번호를 설정해야 합니다. 기존 비밀번호는 조회할 수 없습니다.
          </p>
          <DialogFooter>
            <button className={btnCls} onClick={() => setConfirmReset(false)}>
              닫기
            </button>
            <button
              className={primaryBtn}
              disabled={resetPassword.isPending}
              onClick={() => {
                setConfirmReset(false);
                void doResetPassword();
              }}
            >
              비밀번호 초기화
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TempPasswordDialog({
  title,
  value,
  onClose,
}: {
  title: string;
  value: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const close = () => {
    setCopied(false);
    onClose();
  };
  return (
    <Dialog open={!!value} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className="sm:max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              일회성 임시 비밀번호
            </span>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-border bg-muted px-3 py-2 text-sm">
                {value}
              </code>
              <button
                className={btnCls}
                onClick={async () => {
                  if (value) {
                    try {
                      await navigator.clipboard?.writeText(value);
                    } catch {
                      // 클립보드 권한이 없는 환경에서는 조용히 무시한다(값은 화면에 그대로 보임).
                    }
                  }
                  setCopied(true);
                }}
              >
                {copied ? "복사됨" : "복사"}
              </button>
            </div>
          </div>
          <p className="text-[13px] text-muted-foreground">
            이 임시 비밀번호는 지금 한 번만 표시됩니다. 직원에게 안전한 방법으로 전달해 주세요.
          </p>
          <p className="text-[13px] text-muted-foreground">
            직원은 최초 로그인 후 업무화면에 진입하기 전에 새 비밀번호를 설정해야 합니다.
          </p>
        </div>
        <DialogFooter>
          <button className={primaryBtn} onClick={close}>
            확인
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type StartCodeInfo = {
  title: string;
  instructorName: string;
  code: string;
  expiresAt: string;
  // 재발급일 때만: 열려 있던 로그인 세션을 DB가 종료했는지(false면 남아 있을 수 있음).
  sessionsRevoked?: boolean;
};

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// 강사 시작코드 안내 창. 직원 임시 비밀번호 창과 같은 방식: 닫으면 다시 볼 수 없다.
function StartCodeDialog({ info, onClose }: { info: StartCodeInfo | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const close = () => {
    setCopied(false);
    onClose();
  };
  return (
    <Dialog open={!!info} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className="sm:max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{info?.title}</DialogTitle>
        </DialogHeader>
        {info && (
          <div className="space-y-3">
            <div>
              <span className="mb-1.5 block text-sm font-medium text-foreground">
                {info.instructorName} 강사의 시작코드
              </span>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded border border-border bg-muted px-3 py-3 text-center text-2xl font-semibold tracking-[0.3em]">
                  {info.code}
                </code>
                <button
                  className={btnCls}
                  onClick={async () => {
                    try {
                      await navigator.clipboard?.writeText(info.code);
                    } catch {
                      // 클립보드 권한이 없는 환경에서는 조용히 무시한다(값은 화면에 그대로 보임).
                    }
                    setCopied(true);
                  }}
                >
                  {copied ? "복사됨" : "복사"}
                </button>
              </div>
            </div>
            <p className="text-[13px] text-muted-foreground">
              이 시작코드는 <b className="text-foreground">지금 한 번만</b> 표시됩니다. 창을 닫으면
              다시 볼 수 없으니 강사에게 직접 전달해 주세요. 잃어버렸다면 상세 화면에서 다시 발급할 수
              있습니다.
            </p>
            <p className="text-[13px] text-muted-foreground">
              {formatExpiry(info.expiresAt)}까지 한 번만 쓸 수 있습니다. 강사는 로그인 화면의 PIN 칸에
              이 코드를 넣고, 다음 화면에서 사용할 6자리 PIN을 만듭니다.
            </p>
            {info.sessionsRevoked === false && (
              <p className="rounded border border-border bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground">
                이 강사가 이미 로그인해 있던 기기는 바로 로그아웃되지 않았을 수 있습니다. 그 기기는
                조작이 없으면 60분 뒤 자동으로 로그아웃됩니다.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <button className={primaryBtn} onClick={close}>
            확인
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- 강사 ---------------- */

function InstructorTab() {
  const { staffProfile } = useAuth();
  const { data: list } = useInstructorAccounts();
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<InstructorAccountRow | null>(null);
  const [confirmPin, setConfirmPin] = useState(false);
  // 시작코드는 발급 직후 이 창에서 한 번만 보여 준다(닫으면 다시 볼 수 없다).
  const [startCode, setStartCode] = useState<StartCodeInfo | null>(null);
  const [name, setName] = useState("");
  const [last4, setLast4] = useState("");
  const provision = useProvisionInstructor();
  const issueCode = useIssueInstructorStartCode();
  const setActive = useSetInstructorActive();

  const addValid = name.trim() && /^\d{4}$/.test(last4);
  const currentDetail = detail
    ? (list?.find((i) => i.principalId === detail.principalId) ?? detail)
    : null;

  async function submitAdd() {
    if (!addValid || provision.isPending) return;
    try {
      const created = await provision.mutateAsync({
        organizationId: staffProfile?.organizationId ?? "",
        name: name.trim(),
        phoneLast4: last4,
      });
      setAddOpen(false);
      setStartCode({
        title: "강사 계정이 생성되었습니다.",
        instructorName: name.trim(),
        code: created.startCode,
        expiresAt: created.expiresAt,
      });
    } catch (e: any) {
      toast.error(`강사 추가 실패: ${errorReason(e)}`);
    }
  }

  return (
    <>
      <Panel>
        <PanelHeader
          title="강사 계정"
          action={
            <button
              className={btnCls}
              onClick={() => {
                setName("");
                setLast4("");
                setAddOpen(true);
              }}
            >
              + 강사 추가
            </button>
          }
        />
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className={theadCls}>
              <th className={th}>이름</th>
              <th className={th}>휴대전화 뒤 4자리</th>
              <th className={th}>PIN 상태</th>
              <th className={th}>계정 상태</th>
            </tr>
          </thead>
          <tbody>
            {list?.map((i) => (
              <tr
                key={i.principalId}
                onClick={() => setDetail(i)}
                className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/60"
              >
                <td className={td}>{i.name}</td>
                <td className={td}>{i.phoneLast4}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge
                    label={instructorPinStatus(i).label}
                    tone={instructorPinStatus(i).tone}
                  />
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge
                    label={i.isActive ? "사용중" : "비활성"}
                    tone={i.isActive ? "success" : "neutral"}
                  />
                </td>
              </tr>
            ))}
            {list?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  등록된 강사가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="border-t border-border px-4 py-3 text-[13px] text-muted-foreground">
          강사를 추가하면 6자리 시작코드가 발급됩니다. 강사는 로그인 화면의 PIN 칸에 시작코드를 넣고,
          다음 화면에서 사용할 6자리 PIN을 만듭니다. PIN을 잊은 강사는 시작코드를 다시 발급해 주세요.
        </p>
      </Panel>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>강사 추가</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="이름 *">
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="강사 D"
              />
            </Field>
            <Field label="휴대전화 뒤 4자리 *">
              <input
                className={inputCls}
                inputMode="numeric"
                maxLength={4}
                value={last4}
                onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="0000"
              />
              {last4 && !/^\d{4}$/.test(last4) && (
                <span className="mt-1 block text-xs text-status-danger-fg">
                  숫자 4자리를 입력하세요.
                </span>
              )}
            </Field>
            <p className="rounded border border-border bg-muted/50 px-3 py-2 text-[13px] text-muted-foreground">
              강사를 추가하면 6자리 시작코드가 한 번만 표시됩니다. 강사에게 직접 전달해 주세요.
              시작코드는 7일 동안, 한 번만 쓸 수 있습니다.
            </p>
          </div>
          <DialogFooter>
            <button className={btnCls} onClick={() => setAddOpen(false)}>
              닫기
            </button>
            <button
              className={primaryBtn}
              disabled={!addValid || provision.isPending}
              onClick={submitAdd}
            >
              강사 추가
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!currentDetail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{currentDetail?.name} · 강사 상세</DialogTitle>
          </DialogHeader>
          {currentDetail && (
            <div className="space-y-3">
              <dl className="divide-y divide-border border-y border-border text-sm">
                <Row label="이름" value={currentDetail.name} />
                <Row label="휴대전화 뒤 4자리" value={currentDetail.phoneLast4} />
                <Row
                  label="PIN 상태"
                  value={instructorPinStatus(currentDetail).label}
                />
                <Row label="계정 상태" value={currentDetail.isActive ? "사용중" : "비활성"} />
              </dl>
              <div className="flex gap-2">
                <button
                  className={btnCls}
                  disabled={setActive.isPending}
                  onClick={async () => {
                    if (
                      currentDetail.isActive &&
                      !window.confirm(
                        `${currentDetail.name} 강사 계정을 비활성화할까요? 비활성 강사는 강사 화면에서 출석을 입력할 수 없습니다.`,
                      )
                    ) {
                      return;
                    }
                    try {
                      await setActive.mutateAsync({
                        principalId: currentDetail.principalId,
                        isActive: !currentDetail.isActive,
                      });
                      toast.success("계정 상태를 변경했습니다.");
                    } catch (e: any) {
                      toast.error(`상태 변경 실패: ${errorReason(e)}`);
                    }
                  }}
                >
                  {setActive.isPending
                    ? "처리 중…"
                    : currentDetail.isActive
                      ? "비활성으로 변경"
                      : "사용중으로 변경"}
                </button>
                {currentDetail.isActive && (
                  <button className={btnCls} onClick={() => setConfirmPin(true)}>
                    시작코드 재발급
                  </button>
                )}
              </div>
              <p className="text-[13px] text-muted-foreground">
                PIN과 시작코드는 다시 조회할 수 없으며, 관리자가 PIN을 직접 설정하지 않습니다.
              </p>
            </div>
          )}
          <DialogFooter>
            <button className={btnCls} onClick={() => setDetail(null)}>
              닫기
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmPin} onOpenChange={setConfirmPin}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>시작코드 재발급</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              새 시작코드를 발급하면 이 강사의{" "}
              <b className="text-foreground">지금 PIN과 이전 시작코드는 바로 쓸 수 없게 됩니다.</b>{" "}
              이미 로그인해 있는 기기도 로그아웃됩니다.
            </p>
            <p>강사는 새 시작코드로 로그인한 뒤 6자리 PIN을 다시 만들어야 합니다.</p>
          </div>
          <DialogFooter>
            <button className={btnCls} onClick={() => setConfirmPin(false)}>
              닫기
            </button>
            <button
              className={primaryBtn}
              disabled={issueCode.isPending}
              onClick={async () => {
                if (!currentDetail) return;
                try {
                  const issued = await issueCode.mutateAsync(currentDetail.principalId);
                  setDetail(null);
                  setStartCode({
                    title: "시작코드가 재발급되었습니다.",
                    instructorName: currentDetail.name,
                    code: issued.startCode,
                    expiresAt: issued.expiresAt,
                    sessionsRevoked: issued.sessionsRevoked,
                  });
                } catch (e: any) {
                  toast.error(`시작코드 재발급 실패: ${errorReason(e)}`);
                } finally {
                  setConfirmPin(false);
                }
              }}
            >
              시작코드 재발급
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <StartCodeDialog info={startCode} onClose={() => setStartCode(null)} />
    </>
  );
}

/* ---------------- 공통 ---------------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4 py-2.5">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
