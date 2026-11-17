import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";

// 운영설정 공통 탭 strip(Final Batch A § UX & Policy Closure). 각 탭은
// 독립 route다. 순서 고정: 기본정보 -> 사업·활동 관리 -> 사용자 관리.
// "담당자 배정"(/management/assignment)은 v1.0에서 필수 업무가 아니므로
// 사용자-facing tab에서 제거한다 -- backend(activity_assignments 테이블,
// assign/unassign RPC, 기존 이력)는 삭제하지 않으므로 향후 재도입 가능하고,
// 라우트 자체도 남아있어 기존 링크는 계속 동작한다. "조직 관리"(부서) 탭도
// 동일한 이유로 이미 제거되어 있다 -- 라우트 자체는 유지.
const TABS = [
  { key: "basic", label: "기본정보", to: "/settings/organization" },
  { key: "business", label: "사업·활동 관리", to: "/settings/organization/business" },
  { key: "users", label: "사용자 관리", to: "/settings/users" },
] as const;

// "기관 초기등록"은 공급자 기관에서만 쓰는 탭이다. 고객 기관 관리자에게는 탭
// 자체를 보여주지 않는다 -- 권한 판정 자체는 서버(is_supplier_admin)가 하므로
// 이건 순전히 불필요한 진입점을 숨기기 위한 것이다.
const SUPPLIER_TAB = {
  key: "provisioning",
  label: "기관 초기등록",
  to: "/settings/provisioning",
} as const;

type TabKey = (typeof TABS)[number]["key"] | typeof SUPPLIER_TAB.key;

export function OrgSettingsTabs({ active }: { active: TabKey }) {
  const { staffProfile } = useAuth();
  const showSupplierTab = !!staffProfile?.isSupplierAdmin;
  const tabs = showSupplierTab ? [...TABS, SUPPLIER_TAB] : [...TABS];

  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.key}
          to={t.to}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            active === t.key
              ? "border-primary font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
