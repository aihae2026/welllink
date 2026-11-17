import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  Home,
  ClipboardList,
  FileBarChart,
  Sparkles,
  Settings,
  User,
  Menu,
  LogOut,
} from "lucide-react";
import { RequireAuth, useAuth } from "@/lib/auth";
import { useAttendanceSettings } from "@/lib/org-settings-data";

type NavItem = { label: string; to: string };
type NavGroup = { label: string; icon: typeof Home; to?: string; items?: NavItem[] };

// 본선(v1.0) 일반 직원 Sidebar. 결석관리 사용 여부(§ 출결관리 설정)에 따라
// "결석 관리" 항목을 조건부로 넣는다 -- attendanceEnabled=false면 항목 자체를
// 숨긴다(§14). 신고결석을 끈 기관은 "신고결석 관리" 탭이 없으므로 메뉴가
// 곧바로 "결석 주의대상" 탭으로 진입한다.
function buildNav(attendanceEnabled: boolean, excusedAbsenceEnabled: boolean): NavGroup[] {
  return [
    { label: "홈", icon: Home, to: "/" },
    {
      label: "출석관리",
      icon: ClipboardList,
      items: [
        { label: "프로그램 설정", to: "/attendance/programs" },
        ...(attendanceEnabled
          ? [
              {
                label: "결석 관리",
                to: excusedAbsenceEnabled ? "/attendance/excused" : "/attendance/absence",
              },
            ]
          : []),
      ],
    },
    {
      label: "사업실적",
      icon: FileBarChart,
      items: [
        { label: "실적내역", to: "/performance/records" },
        { label: "실적보고", to: "/performance/report" },
      ],
    },
    { label: "AI 사업평가", icon: Sparkles, to: "/evaluation/records" },
  ];
}

// Core Setup Model Simplification § Phase 5A: 운영설정은 Sidebar에 하위메뉴
//없이 단일 진입점 하나만 노출한다(기본정보/사업·활동 관리/사용자 관리/담당자
// 배정은 그 안의 Tab으로 통합됨, OrgSettingsTabs 참고). 기관설정/사용자관리는
// 여전히 서로 독립된 권한축이므로(§운영설정 Permission), 아래 두 flag 중
// 하나라도 있어야 "운영설정" 항목 자체가 보이고, 실제로 접근 가능한 첫 Tab으로
// 진입시킨다 -- legacy 계정처럼 한쪽 권한만 있는 경우에도 접근 불가능한
// 기본정보로 먼저 보내 막히게 하지 않는다.
const OPERATIONS_PATHS = ["/settings/organization", "/settings/users", "/settings/provisioning"];

// 메뉴별 활성 경로 규칙 (상세 route 포함)
function isMenuActive(to: string, pathname: string) {
  switch (to) {
    case "/":
      return pathname === "/";
    case "/attendance/programs":
      return (
        pathname.startsWith("/attendance/programs") || pathname.startsWith("/attendance/sessions")
      );
    case "/attendance/excused":
    case "/attendance/absence":
      return (
        pathname.startsWith("/attendance/excused") || pathname.startsWith("/attendance/absence")
      );
    case "/performance/records":
      return pathname.startsWith("/performance/records") || pathname.startsWith("/performance/new");
    case "/evaluation/records":
      return pathname.startsWith("/evaluation");
    default:
      return pathname.startsWith(to);
  }
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { staffProfile } = useAuth();
  const { data: attendanceSettings } = useAttendanceSettings();
  const canAccessOrgSettings = staffProfile?.businessRole === "global_manager";
  const canAccessUserManagement = staffProfile?.isSystemAdmin === true;
  // 접근 가능한 첫 Tab으로 진입시킨다(대부분의 canonical 관리자는 둘 다 true라
  // "/settings/organization"로 가지만, 기관설정 권한 없이 사용자관리만 있는
  // legacy 계정은 "/settings/users"로 보내 즉시 접근거부 화면을 보지 않게 한다).
  const operationsHref = canAccessOrgSettings
    ? "/settings/organization"
    : canAccessUserManagement
      ? "/settings/users"
      : null;
  // 설정을 아직 불러오는 중에는 항목을 숨기지 않는다(기본값 true로 취급) --
  // 로딩중 깜빡임으로 있던 메뉴가 순간 사라지는 것을 피한다.
  const navGroups = [
    ...buildNav(
      attendanceSettings?.attendanceEnabled ?? true,
      attendanceSettings?.excusedAbsenceEnabled ?? true,
    ),
    ...(operationsHref ? [{ label: "운영설정", icon: Settings, to: operationsHref }] : []),
  ];

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 px-5">
        <span className="text-base font-semibold tracking-tight">WellLink</span>
        <span className="text-xs text-sidebar-foreground/60">v1.0</span>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {navGroups.map((group) => {
          const Icon = group.icon;
          const isAi = group.label === "AI 사업평가" || group.label === "운영설정";
          // "운영설정"은 링크 하나가 대표하지만 그 안의 4개 Tab(기본정보/사업·활동
          // 관리/사용자 관리/담당자 배정) 어느 경로에 있어도 active로 표시한다.
          const active =
            group.label === "운영설정"
              ? OPERATIONS_PATHS.some((p) => pathname.startsWith(p))
              : isMenuActive(group.to!, pathname);
          const topLevel = (
            <Link
              key={group.label}
              to={group.to!}
              onClick={onNavigate}
              className={`flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-sidebar-accent/80 font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/85 hover:bg-sidebar-accent/50"
              }`}
            >
              <Icon className="size-4" strokeWidth={1.5} />
              {group.label}
            </Link>
          );
          if (group.to) {
            if (isAi) {
              return (
                <div key={group.label} className="border-t border-sidebar-border/80 pt-4 mt-2">
                  {topLevel}
                </div>
              );
            }
            return topLevel;
          }
          return (
            <div
              key={group.label}
              className={isAi ? "border-t border-sidebar-border/80 pt-4 mt-2" : undefined}
            >
              <div className="flex items-center gap-2 px-3 py-1 text-xs tracking-tight text-sidebar-foreground/70">
                <Icon className="size-3.5" strokeWidth={1.5} />
                {group.label}
              </div>
              <div className="mt-1 space-y-0.5">
                {group.items?.map((item) => {
                  const active = isMenuActive(item.to, pathname);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={onNavigate}
                      className={`block rounded py-1.5 pl-9 pr-3 text-sm transition-colors ${
                        active
                          ? "bg-sidebar-accent/80 font-medium text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50"
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <SidebarOrgName />
    </div>
  );
}

function SidebarOrgName() {
  const { staffProfile } = useAuth();
  return (
    <div className="border-t border-sidebar-border px-5 py-3 text-xs text-sidebar-foreground/50">
      {staffProfile?.organizationName || "WellLink"}
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-60 lg:block">
      <SidebarContent />
    </aside>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          aria-label="메뉴 열기"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted lg:hidden"
        >
          <Menu className="size-5" strokeWidth={1.5} />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-60 border-0 bg-sidebar p-0 text-sidebar-foreground">
        <SheetTitle className="sr-only">메뉴</SheetTitle>
        <SidebarContent onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

// Batch 0: 직원 Auth를 실제 연결했다. StaffLayout을 쓰는 모든 화면은 이 컴포넌트를
// 통해 자동으로 로그인 상태/직원 계정 연결 여부를 확인한다(개별 route를 건드리지 않음).
// 최종 보안 경계는 Supabase RLS이며, 이 가드는 UX 편의일 뿐이다.
export function StaffLayout({
  title,
  description,
  children,
  back,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  // 설명문 줄 오른쪽 끝에 두는 버튼(예: 실적보고의 연간계획 등록).
  actions?: ReactNode;
  // search: 돌아갈 화면의 탭·운영구분 등. 없으면 주소만 연다.
  back?: { label: string; to: string; search?: Record<string, string | undefined> };
}) {
  return (
    <RequireAuth>
      <div className="min-h-screen bg-background">
        <Sidebar />
        <div className="lg:pl-60">
          <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-card px-4 sm:px-6">
            <div className="flex items-center gap-2">
              <MobileNav />
              <h1 className="text-lg leading-snug font-semibold text-foreground">{title}</h1>
            </div>
            <UserMenu />
          </header>
          <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
            {back && (
              <Link
                to={back.to}
                search={back.search ?? {}}
                className="mb-4 inline-block text-sm text-muted-foreground hover:text-foreground"
              >
                ← {back.label}
              </Link>
            )}
            {actions ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                {description ? (
                  <p className="text-sm text-muted-foreground">{description}</p>
                ) : (
                  <span />
                )}
                <div className="flex items-center gap-2">{actions}</div>
              </div>
            ) : (
              description && <p className="mb-4 text-sm text-muted-foreground">{description}</p>
            )}
            {children}
          </main>
        </div>
      </div>
    </RequireAuth>
  );
}

function UserMenu() {
  const { staffProfile, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
        <User className="size-4" strokeWidth={1.5} />
        {staffProfile?.name ?? "이름 미확인"}
      </div>
      <button
        type="button"
        onClick={async () => {
          await signOut();
          navigate({ to: "/login" });
        }}
        aria-label="로그아웃"
        className="rounded p-1.5 text-muted-foreground hover:bg-muted"
      >
        <LogOut className="size-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`overflow-x-auto rounded border border-border bg-card ${className}`}>
      {children}
    </section>
  );
}

/**
 * 목록 자리에 들어가는 상태 표시. 조회 실패를 "없음"으로 보여 주면 직원이 실제로 자료가
 * 없는 줄 알고 넘어간다 -- 불러오는 중 / 불러오지 못함 / 없음을 구분하고, 실패했을 때는
 * [다시 시도]로 같은 조회를 한 번 더 돌린다.
 */
export function ListState({
  loading,
  error,
  retrying,
  onRetry,
  empty,
}: {
  loading?: boolean;
  error?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
  empty: ReactNode;
}) {
  if (loading) return <>불러오는 중...</>;
  if (error) {
    return (
      <span className="inline-flex flex-col items-center gap-2">
        <span className="text-status-danger-fg">불러오지 못했습니다.</span>
        {onRetry && (
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded border border-border bg-card px-3 text-sm text-foreground hover:bg-muted disabled:opacity-50"
            disabled={retrying}
            onClick={onRetry}
          >
            {retrying ? "불러오는 중…" : "다시 시도"}
          </button>
        )}
      </span>
    );
  }
  return <>{empty}</>;
}

// 공통 Form control / 버튼 클래스. 화면별 높이·radius·font-size를 통일한다.
export const controlCls = "h-9 rounded border border-input bg-card px-2.5 text-sm text-foreground";
export const btnPrimaryCls =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded bg-primary px-3 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:hover:opacity-100";
export const btnSecondaryCls =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded border border-border bg-card px-3 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50";
// 되돌릴 수 없는 확정 버튼(삭제·취소 확정 등)에만 쓴다. 평소 주 버튼(btnPrimaryCls)과
// 같은 크기에 색만 위험 색이다.
export const btnDangerCls =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded bg-status-danger-fg px-3 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:hover:opacity-100";
export const chipCls =
  "inline-flex h-8 items-center rounded border px-2.5 text-xs transition-colors";
// 표 줄 안의 작은 보조 버튼([종결]·[재등록]·[정정] 등).
export const btnRowCls =
  "inline-flex h-7 items-center justify-center rounded border border-border bg-card px-2 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50";
export const theadCls =
  "border-b border-border bg-muted/40 text-left text-xs text-muted-foreground";

// 결석관리 공통 탭: 신고결석 관리(/attendance/excused) · 결석 주의대상(/attendance/absence)
// 결석관리 공통 탭: 신고결석 관리(/attendance/excused) · 결석 주의대상
// (/attendance/absence). 신고결석 사용 OFF면 "신고결석 관리" 탭 자체를
// 숨긴다(§14) -- 미신고결석 기반 결석 주의대상 확인은 그대로 유지된다.
export function AbsenceTabs({
  active,
  showExcusedTab = true,
  search,
}: {
  active: "excused" | "absence";
  showExcusedTab?: boolean;
  // 결석관리 두 탭은 같은 운영연도/운영구분을 공유한다. 탭은 서로 다른
  // route라서 선택값을 URL로 넘겨야 탭 전환 시에도 유지된다.
  search?: { yearId?: string | undefined; cycleId?: string | undefined };
}) {
  const tabs = [
    ...(showExcusedTab
      ? [{ key: "excused", label: "신고결석 관리", to: "/attendance/excused" } as const]
      : []),
    { key: "absence", label: "결석 주의대상", to: "/attendance/absence" } as const,
  ];
  return (
    <div className="mb-4 flex gap-1 border-b border-border">
      {tabs.map((t) => (
        <Link
          key={t.key}
          to={t.to}
          search={search ?? {}}
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

export function FilterBar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-2 rounded border border-border bg-card px-3 py-2.5 ${className}`}
    >
      {children}
    </div>
  );
}

export function PanelHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {action}
    </div>
  );
}

export function PlaceholderShell({ note }: { note: string }) {
  return (
    <Panel className="p-6">
      <p className="text-sm text-muted-foreground">{note}</p>
      <p className="mt-2 text-xs text-muted-foreground/70">
        이 화면은 정보구조 검증용 기본 골격입니다. 상세 업무 UI는 이후 단계에서 추가합니다.
      </p>
    </Panel>
  );
}
