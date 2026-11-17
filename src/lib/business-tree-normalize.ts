// Core Setup Model Simplification — Phase 1: Migration Compatibility Prep.
//
// DB migration(20260908020000)이 아직 적용되지 않은 현재는 business_nodes가
// major -> middle -> minor -> activity(legacy) 구조지만, migration 적용 후에는
// major -> middle -> activity(new)로 collapse된다. 이 두 물리 구조를 화면마다
// 각자 해석하지 않도록, 여기서 한 번에 최종 사용자-facing 2단계
// (대분류/중분류) + Activity leaf로 정규화한다.
//
// node_type 문자열("major"/"middle"/"minor")에는 의존하지 않고 순수 부모-자식
// 구조로 판단한다:
//   - 각 root 노드(parent_id = null)의 자식을 본다.
//   - 그 자식이 또 자식(손자)을 갖고 있으면(legacy 3단계) -- 그 자식을
//     대분류로 승격하고 root 자신은 화면에 노출하지 않는다(손자들이 중분류).
//   - 그 자식이 자식이 없으면(migrated 2단계, 또는 아직 빈 중분류) -- root를
//     그대로 대분류로 쓰고 그 자식을 중분류로 쓴다.
// 이 판단은 branch(하위 트리) 단위로 독립적으로 이뤄지므로, 한 조직 안에
// legacy 구조와 새로 생성된 2단계 구조가 섞여 있어도 올바르게 동작한다.

export type RawBusinessNode = {
  id: string;
  parent_id: string | null;
  name: string;
  is_active: boolean;
  sort_order?: number;
};

export type UiUnitBusinessNode<TActivity> = {
  id: string;
  name: string;
  majors: UiMajorNode<TActivity>[];
};

export type UiMiddleNode<TActivity> = {
  id: string; // 실제 business_node id (legacy: minor id / migrated: middle id)
  name: string;
  isActive: boolean;
  activities: TActivity[];
};

export type UiMajorNode<TActivity> = {
  id: string; // 실제 business_node id (legacy: middle id / migrated: major id)
  name: string;
  isActive: boolean;
  middles: UiMiddleNode<TActivity>[];
};

function bySort(a: RawBusinessNode, b: RawBusinessNode) {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0);
}

export function normalizeBusinessTreeForUi<TActivity extends { businessNodeId: string }>(
  nodes: RawBusinessNode[],
  activities: TActivity[],
): UiMajorNode<TActivity>[] {
  const childrenOf = new Map<string, RawBusinessNode[]>();
  const roots: RawBusinessNode[] = [];
  for (const n of nodes) {
    if (n.parent_id) {
      const list = childrenOf.get(n.parent_id) ?? [];
      list.push(n);
      childrenOf.set(n.parent_id, list);
    } else {
      roots.push(n);
    }
  }

  const activitiesByNode = new Map<string, TActivity[]>();
  for (const a of activities) {
    const list = activitiesByNode.get(a.businessNodeId) ?? [];
    list.push(a);
    activitiesByNode.set(a.businessNodeId, list);
  }

  const toMiddle = (n: RawBusinessNode): UiMiddleNode<TActivity> => ({
    id: n.id,
    name: n.name,
    isActive: n.is_active,
    activities: [...(activitiesByNode.get(n.id) ?? [])],
  });

  const result: UiMajorNode<TActivity>[] = [];
  for (const root of [...roots].sort(bySort)) {
    const children = [...(childrenOf.get(root.id) ?? [])].sort(bySort);

    if (children.length === 0) {
      // 아직 하위 중분류가 없는 빈 대분류(생성 직후 등).
      result.push({ id: root.id, name: root.name, isActive: root.is_active, middles: [] });
      continue;
    }

    const legacyMajors: UiMajorNode<TActivity>[] = [];
    const directMiddles: RawBusinessNode[] = [];
    for (const child of children) {
      const grandchildren = childrenOf.get(child.id) ?? [];
      if (grandchildren.length > 0) {
        // legacy 3단계 branch: child(구 middle)가 대분류, 손자(구 minor)들이 중분류.
        // root(구 major)는 이 branch에서 노출하지 않는다.
        legacyMajors.push({
          id: child.id,
          name: child.name,
          isActive: child.is_active,
          middles: [...grandchildren].sort(bySort).map(toMiddle),
        });
      } else {
        // migrated 2단계(또는 아직 빈) branch: root가 대분류, child가 중분류.
        directMiddles.push(child);
      }
    }

    if (directMiddles.length > 0) {
      result.push({
        id: root.id,
        name: root.name,
        isActive: root.is_active,
        middles: directMiddles.sort(bySort).map(toMiddle),
      });
    }
    result.push(...legacyMajors);
  }

  return result;
}

// UnitBusiness ↔ BusinessNode Linkage Closure: 최종 사용자 모델은 단위사업 ->
// 대분류 -> 중분류 -> 소분류(활동)이다. business_nodes.unit_business_id가 각
// 대분류(major)가 어느 단위사업 소속인지 말해주므로, 이미 normalizeBusinessTreeForUi로
// 만든 대분류 목록을 단위사업별로 묶기만 하면 된다. 대분류가 0개인 단위사업도
// 반드시 결과에 포함한다(빈 Tree root로 항상 표시 -- 필터링하지 않음).
export function groupTreeByUnitBusiness<TActivity>(
  units: { id: string; name: string }[],
  majors: UiMajorNode<TActivity>[],
  majorUnitBusinessId: Record<string, string>,
): UiUnitBusinessNode<TActivity>[] {
  const majorsByUnit = new Map<string, UiMajorNode<TActivity>[]>();
  for (const maj of majors) {
    const unitId = majorUnitBusinessId[maj.id];
    if (!unitId) continue;
    const list = majorsByUnit.get(unitId) ?? [];
    list.push(maj);
    majorsByUnit.set(unitId, list);
  }

  // 단위사업은 항상 가나다순으로 보여준다(§ Manual QA Gap Fix #2 2) -- DB
  // sort_order는 바꾸지 않고 화면 표시 순서만 정렬한다. 신규 단위사업도
  // 목록이 다시 그려질 때마다 이 정렬을 거치므로 생성 즉시 올바른 위치에
  // 나타난다.
  return [...units]
    .sort((a, b) => a.name.localeCompare(b.name, "ko-KR"))
    .map((u) => ({
      id: u.id,
      name: u.name,
      majors: majorsByUnit.get(u.id) ?? [],
    }));
}
