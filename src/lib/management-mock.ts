// 담당자 배정 화면(management.assignment.tsx)이 실제 데이터를 담는 데 쓰는 트리
// 타입과 flattenActivities()만 남긴다. 이 파일이 원래 제공하던 Mock 데이터
// (businessTree/staffList/annualPlan/historyEntries 등)는 화면이 전부 실제
// 데이터로 교체되면서 더 이상 쓰이지 않아 제거했다(§ 운영 UX Gap Closure 41.
// Scope/Mock Audit — dead legacy mock을 남겨 실제 구현과 혼동되지 않게 한다).
//
// Core Setup Model Simplification § Phase 1: 최종 사용자-facing 계층은
// 대분류(Major) -> 중분류(Middle) -> 소분류(Activity) 2단계 + leaf다. business_nodes
// 물리 구조가 legacy(major/middle/minor)든 new(major/middle)든 business-tree-normalize.ts가
// 이 모양으로 정규화해 주므로, 여기 타입에는 더 이상 별도 Minor 레벨이 없다.

export type RegistrationMethod = "출석연동" | "직접등록(명단)" | "직접등록(개요)";

export type ActivityNode = {
  id: string;
  name: string;
  method: RegistrationMethod;
  active: boolean;
};

export type MiddleNode = { id: string; name: string; active: boolean; activities: ActivityNode[] };
export type MajorNode = { id: string; name: string; active: boolean; middles: MiddleNode[] };
// UnitBusiness ↔ BusinessNode Linkage Closure: 최종 사용자 계층은 단위사업 ->
// 대분류 -> 중분류 -> 소분류(활동) 4단계다.
export type UnitBusinessNode = { id: string; name: string; majors: MajorNode[] };

export type FlatActivity = {
  id: string;
  name: string;
  path: string;
  method: RegistrationMethod;
  active: boolean;
};

export function flattenActivities(tree: UnitBusinessNode[]): FlatActivity[] {
  const out: FlatActivity[] = [];
  for (const unit of tree)
    for (const maj of unit.majors)
      for (const mid of maj.middles)
        for (const act of mid.activities)
          out.push({
            id: act.id,
            name: act.name,
            path: `${unit.name} > ${maj.name} > ${mid.name}`,
            method: act.method,
            active: act.active,
          });
  return out;
}
