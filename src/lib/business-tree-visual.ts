// 담당자 배정/사업구조 UX Gap Closure §16-19: 대분류/중분류/소분류/Activity 네
// 레벨을 색상이 아니라 font-size/weight/들여쓰기/여백만으로 구분한다. 사업·활동
// 관리, 담당자 배정, 실적보고, 연간계획 등록이 각자 다른 트리 렌더링 구조를 쓰고
// 있어 하나의 공통 컴포넌트로 묶기보다, 레벨별 className만 여기서 공유해 네
// 화면의 위계 표현을 일관되게 맞춘다.

export const TREE_LEVEL_CLS = {
  unit: "text-base font-bold text-foreground",
  major: "text-[15px] font-bold text-foreground",
  middle: "text-sm font-semibold text-foreground",
  minor: "text-sm font-medium text-foreground/90",
  activity: "text-sm font-normal text-foreground",
} as const;

// 들여쓰기(px). 단위사업 -> 대분류 -> 중분류 -> Activity 순으로 한 단계씩 더 들어간다.
export const TREE_INDENT = { unit: 8, major: 24, middle: 40, minor: 56, activity: 80 } as const;

// 단위사업은 최상위 그룹 구분선을 겸한다(첫 항목은 구분선 없음).
export const TREE_UNIT_SECTION_CLS =
  "mt-4 border-t border-border pt-4 first:mt-0 first:border-t-0 first:pt-0";

// 대분류는 단위사업 내부의 좀 더 옅은 구분선을 겸한다(첫 항목은 구분선 없음).
export const TREE_MAJOR_SECTION_CLS =
  "mt-3 border-t border-border/70 pt-3 first:mt-0 first:border-t-0 first:pt-0";

// Activity가 summary(직접등록형) 방식일 때 붙이는 최소 배지. 새 배지 체계를
// 만들지 않고 기존 StatusBadge 톤 팔레트만 재사용한다.
export const DIRECT_ENTRY_BADGE_CLS =
  "ml-1.5 rounded border border-border bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground";

// Manual QA Gap Fix §8: 대분류/중분류 행에 아주 옅은 배경 tint를 더해 글자
// weight+들여쓰기만으로는 부족했던 레벨 구분을 보강한다. 사업마다 다른 색을
// 쓰지 않고 레벨당 정확히 하나의 농도만 쓰며, 기존 navy 계열 --primary 위에서만
// 움직인다(소분류/Activity는 흰색 기반 그대로 -- tint 없음). 사업·활동 관리
// 화면에서만 사용한다 -- 실적보고/연간계획 등 이 상수 파일을 공유하는 다른
// 화면의 기존 표현에는 영향을 주지 않는다(기존 export는 그대로 둔다).
export const TREE_ROW_BG_CLS = {
  major: "bg-primary/[0.05]",
  middle: "bg-primary/[0.02]",
} as const;
