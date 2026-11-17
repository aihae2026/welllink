import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import {
  issueProvisioningInviteServerFn,
  listOrganizationCodesServerFn,
  listProvisioningInvitesServerFn,
  revokeProvisioningInviteServerFn,
  type OrganizationCodeRow,
  type ProvisioningInviteRow,
} from "./provisioning-server";

// 기관 초기등록 초대코드 data layer. 발급/조회/취소는 전부 서버함수를 거치며
// (provisioning_invites는 RLS deny-all이라 클라이언트에서 직접 읽을 수 없다),
// 권한 판정도 서버에서 다시 한다 -- 이 파일은 결과를 화면에 붙이기만 한다.

export type { OrganizationCodeRow, ProvisioningInviteRow };

async function currentAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("AUTH_REQUIRED");
  return token;
}

const KEY = ["provisioning-invites"];

export function useProvisioningInvites(enabled: boolean) {
  return useQuery({
    queryKey: KEY,
    enabled,
    queryFn: async (): Promise<ProvisioningInviteRow[]> => {
      const accessToken = await currentAccessToken();
      const result = await listProvisioningInvitesServerFn({
        data: { callerAccessToken: accessToken },
      });
      if (!result.ok) throw new Error(result.message);
      return result.invites;
    },
  });
}

// 이미 기관에 배정된 기관코드 목록(발급 전 중복·오타 확인용).
export function useOrganizationCodes(enabled: boolean) {
  return useQuery({
    queryKey: ["provisioning-org-codes"],
    enabled,
    queryFn: async (): Promise<OrganizationCodeRow[]> => {
      const accessToken = await currentAccessToken();
      const result = await listOrganizationCodesServerFn({
        data: { callerAccessToken: accessToken },
      });
      if (!result.ok) throw new Error(result.message);
      return result.organizations;
    },
  });
}

export function useIssueProvisioningInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { orgCode: string; label: string }) => {
      const accessToken = await currentAccessToken();
      const result = await issueProvisioningInviteServerFn({
        data: { callerAccessToken: accessToken, ...input },
      });
      if (!result.ok) throw new Error(result.message);
      return result.invite;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRevokeProvisioningInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      const accessToken = await currentAccessToken();
      const result = await revokeProvisioningInviteServerFn({
        data: { callerAccessToken: accessToken, inviteId },
      });
      if (!result.ok) throw new Error(result.message);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
