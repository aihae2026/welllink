import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { ActivityNode, RegistrationMethod, UnitBusinessNode } from "./management-mock";
import { groupTreeByUnitBusiness, normalizeBusinessTreeForUi } from "./business-tree-normalize";

// Final Batch A: 담당자 배정 화면 실제 data layer. management-mock.ts의 트리
// 타입(MajorNode/MiddleNode/MinorNode/ActivityNode)은 그대로 재사용하고, 값만
// 실제 business_nodes/activities/activity_assignments로 채운다.
//
// 이 화면(assign_activity/unassign_activity RPC)은 global_manager(전체) 또는
// department_manager(본인 scope) 권한이 있어야 실제 저장이 된다 --
// can_manage_activity()가 서버에서 다시 검사하므로, 여기서는 화면 노출만
// businessRole로 가드한다.
//
// Core Setup Model Simplification § Phase 3: activity_assignments의 "현재
// 담당자 유일성" 제약이 (activity_id) 단독에서 (activity_id, staff_principal_id)
// 조합으로 완화되어(복수담당 migration) 한 Activity에 여러 직원이 동시에
// current 담당자일 수 있다. assign_activity/unassign_activity 둘 다 특정
// (activity, staff) 조합만 다루고 다른 직원의 배정에는 관여하지 않는다.

const methodLabel: Record<string, RegistrationMethod> = {
  attendance: "출석연동",
  summary: "직접등록(개요)",
};

type BusinessNodeRow = {
  id: string;
  parent_id: string | null;
  node_type: "major" | "middle" | "minor";
  unit_business_id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
};

type ActivityRow = {
  id: string;
  business_node_id: string;
  name: string;
  default_performance_method: string;
  is_active: boolean;
};

type AssignmentRow = {
  activity_id: string;
  staff_principal_id: string;
  principals: { name: string } | null;
};

export type AssignableStaff = { id: string; name: string };

export function useAssignableStaff() {
  return useQuery({
    queryKey: ["assignable-staff"],
    queryFn: async (): Promise<AssignableStaff[]> => {
      const { data, error } = await supabase.rpc("list_assignable_staff");
      if (error) throw error;
      return (data ?? []).map((r: any) => ({ id: r.out_principal_id, name: r.out_name }));
    },
  });
}

export function useAssignmentTree() {
  return useQuery({
    queryKey: ["assignment-tree"],
    queryFn: async (): Promise<{
      tree: UnitBusinessNode[];
      // Activity 1개 <-> 담당자 여러 명(many-to-many)이므로 활동당 배열이다.
      assigneesByActivity: Record<string, { id: string; name: string }[]>;
    }> => {
      const { data: nodes, error: nodesError } = await supabase
        .from("business_nodes")
        .select("id, parent_id, node_type, unit_business_id, name, sort_order, is_active")
        .order("sort_order");
      if (nodesError) throw nodesError;

      const { data: units, error: unitsError } = await supabase
        .from("unit_businesses")
        .select("id, name");
      if (unitsError) throw unitsError;

      const { data: activities, error: activitiesError } = await supabase
        .from("activities")
        .select("id, business_node_id, name, default_performance_method, is_active")
        .order("sort_order");
      if (activitiesError) throw activitiesError;

      // activity_assignments -> principals FK가 staff_principal_id/created_by 2개라
      // embed가 모호하므로 컬럼명 hint로 명시한다.
      const { data: assignments, error: assignmentsError } = await supabase
        .from("activity_assignments")
        .select("activity_id, staff_principal_id, principals!staff_principal_id(name)")
        .is("effective_to", null);
      if (assignmentsError) throw assignmentsError;

      const toActivityNode = (a: ActivityRow): ActivityNode & { businessNodeId: string } => ({
        id: a.id,
        name: a.name,
        method: methodLabel[a.default_performance_method] ?? "출석연동",
        active: a.is_active,
        businessNodeId: a.business_node_id,
      });

      // legacy(major/middle/minor)/new(major/middle) 물리 구조를 모두 최종
      // 대분류->중분류->Activity 2단계로 정규화한 뒤(§ Core Setup Model
      // Simplification Phase 1), business_nodes.unit_business_id로 단위사업
      // 별로 한 번 더 묶는다(§ UnitBusiness ↔ BusinessNode Linkage Closure).
      // 대분류가 0개인 단위사업도 필터링하지 않고 항상 포함한다.
      const nodeRows = (nodes ?? []) as BusinessNodeRow[];
      const normalized = normalizeBusinessTreeForUi(
        nodeRows,
        ((activities ?? []) as ActivityRow[]).map(toActivityNode),
      );
      const majorUnitBusinessId: Record<string, string> = {};
      nodeRows.forEach((n) => {
        if (n.node_type === "major") majorUnitBusinessId[n.id] = n.unit_business_id;
      });
      const grouped = groupTreeByUnitBusiness(units ?? [], normalized, majorUnitBusinessId);

      const tree: UnitBusinessNode[] = grouped.map((unit) => ({
        id: unit.id,
        name: unit.name,
        majors: unit.majors.map((maj) => ({
          id: maj.id,
          name: maj.name,
          active: maj.isActive,
          middles: maj.middles.map((mid) => ({
            id: mid.id,
            name: mid.name,
            active: mid.isActive,
            activities: mid.activities,
          })),
        })),
      }));

      const assigneesByActivity: Record<string, { id: string; name: string }[]> = {};
      for (const row of (assignments ?? []) as unknown as AssignmentRow[]) {
        if (!row.principals) continue;
        const list = assigneesByActivity[row.activity_id] ?? [];
        list.push({ id: row.staff_principal_id, name: row.principals.name });
        assigneesByActivity[row.activity_id] = list;
      }

      return { tree, assigneesByActivity };
    },
  });
}

export function useAssignActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { activityId: string; staffPrincipalId: string }) => {
      const { error } = await supabase.rpc("assign_activity", {
        p_activity_id: input.activityId,
        p_staff_principal_id: input.staffPrincipalId,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["assignment-tree"] }),
  });
}

export function useUnassignActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { activityId: string; staffPrincipalId: string }) => {
      const { error } = await supabase.rpc("unassign_activity", {
        p_activity_id: input.activityId,
        p_staff_principal_id: input.staffPrincipalId,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["assignment-tree"] }),
  });
}
