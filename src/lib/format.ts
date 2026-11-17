// 직원 화면 공통 날짜·시간 표기. 날짜는 "2026-09-15", 시간은 24시간제 "15:00"으로 통일한다
// (강사 화면은 "오전 09:30"을 그대로 쓴다). 브라우저 시간대와 상관없이 한국 시간 기준.
const KST = "Asia/Seoul";

/**
 * 목록 이름 정렬(가나다순). DB의 `order by name`과 같은 순서라 영문·숫자·괄호로 시작하는
 * 이름(AI기초, (비)건강백세…)이 한글보다 앞에 온다. localeCompare("ko")는 한글을 앞에 둬서
 * 화면마다 순서가 달라지므로 쓰지 않는다.
 */
export function compareName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: KST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: KST,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "2026-09-15" */
export function formatDate(value: string | Date): string {
  return dateFmt.format(typeof value === "string" ? new Date(value) : value);
}

/** "15:00" */
export function formatTime(value: string | Date): string {
  return timeFmt.format(typeof value === "string" ? new Date(value) : value);
}

/** "2026-09-15 15:00" */
export function formatDateTime(value: string | Date): string {
  return `${formatDate(value)} ${formatTime(value)}`;
}
