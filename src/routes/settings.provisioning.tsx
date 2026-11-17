import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  StaffLayout,
  Panel,
  PanelHeader,
  btnPrimaryCls,
  btnRowCls,
  btnSecondaryCls,
  controlCls,
  theadCls,
} from "@/components/layout/StaffLayout";
import { formatDate } from "@/lib/format";
import { OrgSettingsTabs } from "@/components/layout/OrgSettingsTabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAuth } from "@/lib/auth";
import {
  useOrganizationCodes,
  useProvisioningInvites,
  useIssueProvisioningInvite,
  useRevokeProvisioningInvite,
  type OrganizationCodeRow,
  type ProvisioningInviteRow,
} from "@/lib/provisioning-data";
import { toast } from "sonner";
import { errorReason } from "@/lib/error-message";

// 기관 초기등록 초대코드 관리(공급자 기관 전용). 도입 기관에 /provision 주소를
// 그대로 안내하기 위한 화면이다 -- 기관마다 1회용 코드를 발급하고, 아직 쓰이지
// 않은 코드는 여기서 바로 취소할 수 있다.
//
// 화면 가드는 UX일 뿐이다. 실제 권한(is_supplier_admin)은 모든 서버함수가
// 호출자 토큰으로 다시 검사한다.
export const Route = createFileRoute("/settings/provisioning")({
  head: () => ({
    meta: [
      { title: "기관 초기등록 — WellLink" },
      { name: "description", content: "도입 기관에 보낼 초기등록 초대코드를 발급·관리합니다." },
    ],
  }),
  component: ProvisioningPage,
});

// 다른 화면과 같은 공통 버튼·입력칸(36px)을 쓴다.
const btnCls = btnSecondaryCls;
const primaryBtn = btnPrimaryCls;
const inputCls = `${controlCls} w-full`;
const th = "px-4 py-2 text-left text-xs font-medium text-muted-foreground";
const td = "px-4 py-2.5 text-foreground";

const STATUS_LABEL: Record<ProvisioningInviteRow["status"], string> = {
  active: "사용 가능",
  used: "사용됨",
  revoked: "취소됨",
  expired: "만료됨",
};

const fmtDate = (iso: string) => formatDate(iso);

function inviteLink(code: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/provision?invite=${code}`;
}

type CodeCheck =
  | { kind: "ok" }
  | { kind: "taken"; org: OrganizationCodeRow }
  | { kind: "pending"; invite: ProvisioningInviteRow };

// 입력 중인 기관코드를 기존 기관 / 아직 살아있는 초대와 대조한다. 최종 판정은
// 서버(issueProvisioningInviteServerFn)가 다시 하므로 여기서는 안내만 한다.
function checkOrgCode(
  code: string,
  orgs: OrganizationCodeRow[],
  invites: ProvisioningInviteRow[],
): CodeCheck {
  if (!code) return { kind: "ok" };
  const org = orgs.find((o) => o.orgCode === code);
  if (org) return { kind: "taken", org };
  const invite = invites.find((r) => r.status === "active" && r.orgCode === code);
  if (invite) return { kind: "pending", invite };
  return { kind: "ok" };
}

function ProvisioningPage() {
  const { staffProfile } = useAuth();
  const isSupplierAdmin = !!staffProfile?.isSupplierAdmin;
  const { data: invites, isLoading, error } = useProvisioningInvites(isSupplierAdmin);
  const orgCodes = useOrganizationCodes(isSupplierAdmin);
  const issue = useIssueProvisioningInvite();
  const revoke = useRevokeProvisioningInvite();

  const [orgCode, setOrgCode] = useState("");
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<ProvisioningInviteRow | null>(null);

  if (!isSupplierAdmin) {
    return (
      <StaffLayout title="운영설정">
        <Panel className="p-6">
          <p className="text-sm text-muted-foreground">
            이 화면은 WellLink 공급자 기관의 관리자만 접근할 수 있습니다.
          </p>
        </Panel>
      </StaffLayout>
    );
  }

  const codeCheck = checkOrgCode(orgCode, orgCodes.data ?? [], invites ?? []);
  const codeBlocked = codeCheck.kind === "taken" || codeCheck.kind === "pending";

  const handleIssue = async () => {
    try {
      const invite = await issue.mutateAsync({ orgCode, label });
      setIssued(invite);
      setOrgCode("");
      setLabel("");
    } catch (e) {
      toast.error(errorReason(e, "초대코드를 발급하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    }
  };

  const handleRevoke = async (row: ProvisioningInviteRow) => {
    try {
      await revoke.mutateAsync(row.id);
      toast.success("초대코드를 취소했습니다.");
    } catch (e) {
      toast.error(errorReason(e, "취소하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what}을(를) 복사했습니다.`);
    } catch {
      toast.error("복사할 수 없습니다. 직접 선택해 복사해 주세요.");
    }
  };

  return (
    <StaffLayout title="운영설정">
      <OrgSettingsTabs active="provisioning" />
      <p className="mb-4 text-sm text-muted-foreground">
        도입 기관에 보낼 초기등록 초대코드를 발급합니다. 코드 1개로 기관 1개만 만들 수 있고,
        발급일로부터 14일이 지나면 자동으로 만료됩니다.
      </p>

      <Panel className="mb-4">
        <PanelHeader title="새 초대코드 발급" />
        <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="orgCode">
              기관코드 (공급자 지정)
            </label>
            <input
              id="orgCode"
              className={`${inputCls} font-mono`}
              placeholder="well002"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={orgCode}
              onChange={(e) => setOrgCode(e.target.value.trim().toLowerCase())}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="label">
              메모 (내부용, 선택)
            </label>
            <input
              id="label"
              className={inputCls}
              placeholder="○○노인복지관 2026 도입"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <button
            className={primaryBtn}
            onClick={handleIssue}
            disabled={issue.isPending || !orgCode || codeBlocked}
          >
            {issue.isPending ? "발급 중..." : "발급"}
          </button>
        </div>
        {codeCheck.kind === "taken" && (
          <p className="px-4 pb-2 text-sm text-destructive">
            이미 사용 중인 기관코드입니다 —{" "}
            <span className="font-medium">{codeCheck.org.name}</span>
            {codeCheck.org.isSupplier && " (공급자 기관)"}
          </p>
        )}
        {codeCheck.kind === "pending" && (
          <p className="px-4 pb-2 text-sm text-destructive">
            이 기관코드로 아직 사용되지 않은 초대코드가 있습니다
            {codeCheck.invite.label ? ` (${codeCheck.invite.label})` : ""}. 발급 이력에서 기존
            초대를 취소한 뒤 다시 발급해 주세요.
          </p>
        )}
        <p className="px-4 pb-4 text-[13px] text-muted-foreground">
          기관코드는 강사 로그인에 쓰이는 공개 코드입니다. 영문 소문자/숫자/하이픈 3~32자이며, 이
          코드는 수신 기관이 변경할 수 없습니다. 메모는 공급자만 보며 기관에는 노출되지 않습니다.
        </p>
      </Panel>

      {issued && (
        <Panel className="mb-4">
          <PanelHeader
            title="발급 완료 — 아래 링크를 기관 담당자에게 전달하세요"
            action={
              <button className={btnCls} onClick={() => setIssued(null)}>
                닫기
              </button>
            }
          />
          <div className="space-y-3 p-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">초대 링크</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-foreground">
                  {inviteLink(issued.code)}
                </code>
                <button className={btnCls} onClick={() => copy(inviteLink(issued.code), "링크")}>
                  복사
                </button>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">초대코드 (전화 안내용)</div>
              <div className="flex items-center gap-2">
                <code className="font-mono text-base font-medium text-foreground">
                  {issued.code}
                </code>
                <button className={btnCls} onClick={() => copy(issued.code, "코드")}>
                  복사
                </button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              기관코드 <span className="font-mono">{issued.orgCode}</span> · 유효기간{" "}
              {fmtDate(issued.expiresAt)}까지
            </p>
          </div>
        </Panel>
      )}

      <Panel className="mb-4">
        <PanelHeader title="사용 중인 기관코드" />
        {orgCodes.isLoading && <p className="p-4 text-sm text-muted-foreground">불러오는 중...</p>}
        {orgCodes.error && (
          <p className="p-4 text-sm text-destructive">
            {errorReason(orgCodes.error, "조회에 실패했습니다.")}
          </p>
        )}
        {orgCodes.data && orgCodes.data.length > 0 && (
          <table className="w-full min-w-[660px] table-fixed text-sm">
            <colgroup>
              <col className="w-[150px]" />
              <col />
              <col className="w-[100px]" />
              <col className="w-[120px]" />
            </colgroup>
            <thead>
              <tr className={theadCls}>
                <th className={th}>기관코드</th>
                <th className={th}>기관명</th>
                <th className={th}>구분</th>
                <th className={th}>등록일</th>
              </tr>
            </thead>
            <tbody>
              {orgCodes.data.map((org) => (
                <tr key={org.orgCode} className="border-b border-border last:border-0">
                  <td className={`${td} font-mono`}>{org.orgCode}</td>
                  <td className={td}>{org.name}</td>
                  <td className={td}>
                    {org.isSupplier ? (
                      <StatusBadge label="공급자" tone="info" />
                    ) : (
                      <span className="text-muted-foreground">도입 기관</span>
                    )}
                  </td>
                  <td className={`${td} text-muted-foreground`}>{fmtDate(org.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="발급 이력" />
        {isLoading && <p className="p-4 text-sm text-muted-foreground">불러오는 중...</p>}
        {error && (
          <p className="p-4 text-sm text-destructive">
            {errorReason(error, "조회에 실패했습니다.")}
          </p>
        )}
        {invites && invites.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">아직 발급한 초대코드가 없습니다.</p>
        )}
        {invites && invites.length > 0 && (
          <table className="w-full min-w-[860px] table-fixed text-sm">
            <colgroup>
              <col className="w-[180px]" />
              <col className="w-[140px]" />
              <col />
              <col className="w-[90px]" />
              <col className="w-[130px]" />
              <col className="w-[90px]" />
            </colgroup>
            <thead>
              <tr className={theadCls}>
                <th className={th}>초대코드</th>
                <th className={th}>기관코드</th>
                <th className={th}>메모</th>
                <th className={th}>상태</th>
                <th className={th}>유효기간</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className={`${td} font-mono`}>{row.code}</td>
                  <td className={`${td} font-mono`}>{row.orgCode}</td>
                  <td className={`${td} text-muted-foreground`}>{row.label ?? "-"}</td>
                  <td className={td}>
                    <StatusBadge
                      label={STATUS_LABEL[row.status]}
                      tone={row.status === "active" ? "success" : "neutral"}
                    />
                  </td>
                  <td className={`${td} text-muted-foreground`}>{fmtDate(row.expiresAt)}</td>
                  <td className={`${td} text-right`}>
                    {row.status === "active" && (
                      <>
                        <button
                          className={`${btnRowCls} mr-1`}
                          onClick={() => copy(inviteLink(row.code), "링크")}
                        >
                          링크 복사
                        </button>
                        <button
                          className={btnRowCls}
                          onClick={() => handleRevoke(row)}
                          disabled={revoke.isPending}
                        >
                          취소
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </StaffLayout>
  );
}
