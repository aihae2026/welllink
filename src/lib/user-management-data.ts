import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { compareName } from "./format";
import { provisionInstructorServerFn } from "./instructor-auth";
import {
  provisionStaffServerFn,
  resetStaffPasswordServerFn,
  updateStaffInfoServerFn,
} from "./staff-management-server";

// Pre-Final Gate: 직원/강사 계정관리 실제 Supabase data layer. is_system_admin=true
// 사용자만 호출 가능(모든 RPC/서버함수가 서버에서 다시 권한을 검사한다 -- 이 파일은
// 그 결과를 화면에 붙이기만 한다).

export type BusinessRole = "staff" | "department_manager" | "global_manager" | "global_viewer";

export type StaffAccountRow = {
  principalId: string;
  name: string;
  email: string | null;
  businessRole: BusinessRole;
  isSystemAdmin: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
};

export function useStaffAccounts() {
  return useQuery({
    queryKey: ["staff-accounts"],
    queryFn: async (): Promise<StaffAccountRow[]> => {
      const { data, error } = await supabase.rpc("list_staff_accounts");
      if (error) throw error;
      const rows: StaffAccountRow[] = (data ?? []).map((r: any) => ({
        principalId: r.out_principal_id,
        name: r.out_name,
        email: r.out_email,
        businessRole: r.out_business_role,
        isSystemAdmin: r.out_is_system_admin,
        isActive: r.out_is_active,
        mustChangePassword: r.out_must_change_password,
        createdAt: r.out_created_at,
      }));
      // 직원 목록은 이름 가나다순.
      return rows.sort((a, b) => compareName(a.name, b.name));
    },
  });
}

async function currentAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("AUTH_REQUIRED");
  return token;
}

export function useProvisionStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      organizationId: string;
      name: string;
      email: string;
      businessRole: BusinessRole;
      isSystemAdmin: boolean;
    }) => {
      const accessToken = await currentAccessToken();
      const result = await provisionStaffServerFn({
        data: { callerAccessToken: accessToken, ...input },
      });
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff-accounts"] }),
  });
}

export function useUpdateStaffRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      principalId: string;
      businessRole: BusinessRole;
      isSystemAdmin: boolean;
      reason: string;
    }) => {
      const { error } = await supabase.rpc("update_staff_role", {
        p_principal_id: input.principalId,
        p_business_role: input.businessRole,
        p_is_system_admin: input.isSystemAdmin,
        p_reason: input.reason,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff-accounts"] }),
  });
}

export function useUpdateStaffInfo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { principalId: string; name: string; email: string }) => {
      const accessToken = await currentAccessToken();
      const result = await updateStaffInfoServerFn({
        data: { callerAccessToken: accessToken, ...input },
      });
      if (!result.ok) throw new Error(result.message);
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff-accounts"] }),
  });
}

export function useSetStaffActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { principalId: string; isActive: boolean }) => {
      const { error } = await supabase.rpc("set_staff_active", {
        p_principal_id: input.principalId,
        p_is_active: input.isActive,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff-accounts"] }),
  });
}

export function useResetStaffPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (principalId: string) => {
      const accessToken = await currentAccessToken();
      const result = await resetStaffPasswordServerFn({
        data: { callerAccessToken: accessToken, principalId },
      });
      if (!result.ok) throw new Error(result.message);
      return result.tempPassword;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["staff-accounts"] }),
  });
}

export type InstructorAccountRow = {
  principalId: string;
  name: string;
  phoneLast4: string;
  isActive: boolean;
  pinSet: boolean;
  pinLocked: boolean;
  // 강사가 6자리 새 PIN을 만들었는지(관리자가 시작코드를 재발급하면 다시 false).
  pinConfirmed: boolean;
  // 시작코드 만료 시각(ISO). null이면 시작코드가 발급되지 않은 상태, undefined면 이 값을 주지 않는 DB.
  startCodeExpiresAt?: string | null;
  createdAt: string;
};

function formatMonthDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function instructorPinStatus(
  i: Pick<InstructorAccountRow, "pinSet" | "pinLocked" | "pinConfirmed" | "startCodeExpiresAt">,
  now: Date = new Date(),
): {
  label: string;
  tone: "danger" | "warn" | "success";
} {
  if (i.pinLocked) return { label: "잠금", tone: "danger" };
  if (!i.pinSet) return { label: "설정필요", tone: "warn" };
  if (!i.pinConfirmed) {
    // 시작코드를 주지 않는 이전 DB에서는 예전처럼 "첫 로그인 전"으로 보인다.
    if (i.startCodeExpiresAt === undefined) return { label: "첫 로그인 전", tone: "warn" };
    if (i.startCodeExpiresAt === null) return { label: "시작코드 필요", tone: "warn" };
    if (new Date(i.startCodeExpiresAt).getTime() <= now.getTime()) {
      return { label: "시작코드 만료", tone: "danger" };
    }
    return { label: `시작코드 발급(~${formatMonthDay(i.startCodeExpiresAt)})`, tone: "warn" };
  }
  return { label: "사용중", tone: "success" };
}

export function useInstructorAccounts() {
  return useQuery({
    queryKey: ["instructor-accounts"],
    queryFn: async (): Promise<InstructorAccountRow[]> => {
      const { data, error } = await supabase.rpc("list_instructor_accounts");
      if (error) throw error;
      const rows: InstructorAccountRow[] = (data ?? []).map((r: any) => ({
        principalId: r.out_principal_id,
        name: r.out_name,
        phoneLast4: r.out_phone_last4,
        isActive: r.out_is_active,
        pinSet: r.out_pin_set,
        pinLocked: r.out_pin_locked,
        // 함수가 아직 이 값을 주지 않는 DB에서는 기존처럼 "사용중"으로 본다.
        pinConfirmed: r.out_pin_confirmed ?? true,
        startCodeExpiresAt: r.out_start_code_expires_at,
        createdAt: r.out_created_at,
      }));
      // 강사 목록·강사 선택칸 모두 이름 가나다순.
      return rows.sort((a, b) => compareName(a.name, b.name));
    },
  });
}

export function useProvisionInstructor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { organizationId: string; name: string; phoneLast4: string }) => {
      const accessToken = await currentAccessToken();
      const result = await provisionInstructorServerFn({
        data: { callerAccessToken: accessToken, ...input },
      });
      if (!result.ok) throw new Error(result.message);
      // 시작코드는 관리자 화면의 안내 창에서 한 번만 보여 준다(다른 곳에 저장하지 않는다).
      return { principalId: result.principalId, startCode: result.startCode, expiresAt: result.expiresAt };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instructor-accounts"] }),
  });
}

// 시작코드 발급·재발급(= 예전의 "PIN 초기화"). 새 코드를 만들면 이전 코드와 기존 PIN은 즉시 쓸 수 없다.
// 돌려주는 코드는 이 호출의 결과로만 존재한다 -- 다시 조회할 방법이 없다.
export function useIssueInstructorStartCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (principalId: string) => {
      const { data, error } = await supabase.rpc("issue_instructor_start_code", {
        p_principal_id: principalId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : undefined;
      if (!row?.out_code) throw new Error("시작코드를 받지 못했습니다.");
      return {
        startCode: row.out_code as string,
        expiresAt: row.out_expires_at as string,
        sessionsRevoked: row.out_sessions_revoked === true,
      };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instructor-accounts"] }),
  });
}

export function useSetInstructorActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { principalId: string; isActive: boolean }) => {
      const { error } = await supabase.rpc("set_instructor_active", {
        p_principal_id: input.principalId,
        p_is_active: input.isActive,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["instructor-accounts"] }),
  });
}
