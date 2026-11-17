import type { ReactNode } from "react";
import { RequireInstructorAuth, useInstructorAuth } from "@/lib/instructor-session";

// "9/10(목)"
function formatShortDate(d: Date) {
  const weekday = d.toLocaleDateString("ko-KR", { weekday: "short" });
  return `${d.getMonth() + 1}/${d.getDate()}(${weekday})`;
}

// 강사 화면은 휴대폰 사용이 전제라 화면 안에 "← 뒤로" 링크를 두지 않는다 -- 기기의
// 뒤로가기를 쓴다. 날짜는 머리줄 제목 앞에 한 번만 보여준다("9/10(목) 오늘 수업").
export function InstructorLayout({
  title,
  date,
  children,
}: {
  title: string;
  date?: Date | null;
  children: ReactNode;
}) {
  return (
    <RequireInstructorAuth>
      <InstructorLayoutInner title={title} date={date ?? null}>
        {children}
      </InstructorLayoutInner>
    </RequireInstructorAuth>
  );
}

function InstructorLayoutInner({
  title,
  date,
  children,
}: {
  title: string;
  date: Date | null;
  children: ReactNode;
}) {
  const { instructorProfile, signOut } = useInstructorAuth();
  return (
    <div className="min-h-screen bg-background">
      {/* 머리줄은 항상 한 줄 -- 아주 좁은 폰(360px 미만)에서는 강사 이름을 숨긴다. */}
      <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-2 border-b border-border bg-card px-4">
        <h1 className="min-w-0 truncate text-xl font-semibold text-foreground">
          {date && `${formatShortDate(date)} `}
          {title}
        </h1>
        <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
          <span className="hidden text-base text-muted-foreground min-[360px]:inline">
            {instructorProfile?.name ?? "강사"}
          </span>
          <button
            onClick={() => signOut()}
            className="rounded px-3 py-2 text-base text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            로그아웃
          </button>
        </div>
      </header>
      <main className="px-4 py-4 pb-8">{children}</main>
    </div>
  );
}
