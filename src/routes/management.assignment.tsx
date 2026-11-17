import { createFileRoute, redirect } from "@tanstack/react-router";

// Home Dashboard Closure §0: 담당자 배정은 v1.0 사용자-facing 기능에서 제거하기로
// 확정했다(Final Batch A §7 — Tab/Sidebar entry는 이미 제거됨). 이 legacy route로의
// 직접 진입만 남아 있던 구멍을 닫는다 -- UI route만 닫을 뿐 backend(activity_assignments
// table/이력/assign·unassign RPC/관련 데이터 조회 hook)는 전혀 건드리지 않는다.
export const Route = createFileRoute("/management/assignment")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/organization/business" });
  },
});
