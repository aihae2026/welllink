// 화면 확인용 Mock Data (Backend 없음, 업무로직 없음)

export const operationTerms = ["2026년 하반기", "2026년 상반기"];

// 현재 운영차수는 초기 수강명단 등록이 완료된 상태로 둔다.
export const currentTermRosterRegistered = true;

export type ProgramRow = {
  id: string;
  name: string;
  schedule: string;
  instructor: string;
  sessionCount: string;
  status: string;
  students: string;
  absenceRule: { unexcused: number; excused: number };
};

// 회차 수 / 수강생 수 / 출석상태는 아래 sessionsByProgram · rosterByProgram Mock과 일치시킨다.
export const programRows: ProgramRow[] = [
  {
    id: "p1",
    name: "노래교실",
    schedule: "월 09:50~10:40",
    instructor: "강사 A",
    sessionCount: "4회",
    status: "누락 1",
    students: "4명",
    absenceRule: { unexcused: 2, excused: 5 },
  },
  {
    id: "p2",
    name: "스마트폰(초급)",
    schedule: "화 10:00~10:50",
    instructor: "강사 B",
    sessionCount: "4회",
    status: "누락 1",
    students: "3명",
    absenceRule: { unexcused: 2, excused: 5 },
  },
  {
    id: "p3",
    name: "요가교실",
    schedule: "수 14:00~14:50",
    instructor: "강사 A",
    sessionCount: "3회",
    status: "예정",
    students: "3명",
    absenceRule: { unexcused: 2, excused: 5 },
  },
];

export const todayClasses = [
  {
    id: "s1",
    program: "노래교실",
    time: "09:50~10:40",
    round: "12회차",
    status: "예정",
    students: 4,
  },
  {
    id: "s2",
    program: "스마트폰(초급)",
    time: "10:00~10:50",
    round: "9회차",
    status: "저장됨",
    students: 3,
  },
];

// 강사 화면은 이름만 노출한다. (회원코드 노출 금지)
export type InstructorRosterEntry = { id: string; name: string; excused?: boolean };

export const rosterByInstructorSession: Record<string, InstructorRosterEntry[]> = {
  s1: [
    { id: "s1-1", name: "이용자 A" },
    { id: "s1-2", name: "이용자 B" },
    { id: "s1-3", name: "이용자 C", excused: true },
    { id: "s1-4", name: "이용자 D" },
  ],
  s2: [
    { id: "s2-1", name: "이용자 F", excused: true },
    { id: "s2-2", name: "이용자 G" },
    { id: "s2-3", name: "이용자 H" },
  ],
};

export const getInstructorRoster = (sessionId: string): InstructorRosterEntry[] =>
  rosterByInstructorSession[sessionId] ?? [];


// 프로그램 상세 — 수강명단 (프로그램별로 구분)
export type RosterRow = { code: string; name: string; status: "수강중" | "종결" };

// 프로그램 상세 — 회차 (회차 id는 프로그램 간 중복되지 않는다)
export type SessionRow = { id: string; round: string; date: string; time: string; status: string };

export const rosterByProgram: Record<string, RosterRow[]> = {
  p1: [
    { code: "2026-00123", name: "이용자 A", status: "수강중" },
    { code: "2026-00125", name: "이용자 B", status: "수강중" },
    { code: "2026-00131", name: "이용자 C", status: "수강중" },
    { code: "2026-00142", name: "이용자 D", status: "수강중" },
    { code: "2026-00108", name: "이용자 E", status: "종결" },
  ],
  p2: [
    { code: "2026-00210", name: "이용자 F", status: "수강중" },
    { code: "2026-00214", name: "이용자 G", status: "수강중" },
    { code: "2026-00219", name: "이용자 H", status: "수강중" },
    { code: "2026-00221", name: "이용자 I", status: "종결" },
  ],
  p3: [
    { code: "2026-00305", name: "이용자 J", status: "수강중" },
    { code: "2026-00311", name: "이용자 K", status: "수강중" },
    { code: "2026-00318", name: "이용자 L", status: "수강중" },
  ],
};

export const sessionsByProgram: Record<string, SessionRow[]> = {
  p1: [
    { id: "p1-s10", round: "10회차", date: "2026-08-24", time: "09:50~10:40", status: "완료" },
    { id: "p1-s11", round: "11회차", date: "2026-08-31", time: "09:50~10:40", status: "누락" },
    { id: "p1-s12", round: "12회차", date: "2026-09-07", time: "09:50~10:40", status: "예정" },
    { id: "p1-s13", round: "13회차", date: "2026-09-14", time: "09:50~10:40", status: "휴강" },
  ],
  p2: [
    { id: "p2-s07", round: "7회차", date: "2026-08-25", time: "10:00~10:50", status: "완료" },
    { id: "p2-s08", round: "8회차", date: "2026-09-01", time: "10:00~10:50", status: "누락" },
    { id: "p2-s09", round: "9회차", date: "2026-09-08", time: "10:00~10:50", status: "예정" },
    { id: "p2-s10", round: "10회차", date: "2026-09-15", time: "10:00~10:50", status: "예정" },
  ],
  p3: [
    { id: "p3-s05", round: "5회차", date: "2026-08-26", time: "14:00~14:50", status: "완료" },
    { id: "p3-s06", round: "6회차", date: "2026-09-02", time: "14:00~14:50", status: "완료" },
    { id: "p3-s07", round: "7회차", date: "2026-09-09", time: "14:00~14:50", status: "예정" },
  ],
};

export const getRoster = (programId: string): RosterRow[] => rosterByProgram[programId] ?? [];
export const getSessions = (programId: string): SessionRow[] => sessionsByProgram[programId] ?? [];

// sessionId만으로 어느 프로그램의 회차인지 식별한다.
export function findSession(sessionId: string) {
  for (const [programId, sessions] of Object.entries(sessionsByProgram)) {
    const session = sessions.find((s) => s.id === sessionId);
    if (session) return { programId, session, program: programRows.find((p) => p.id === programId) };
  }
  return { programId: undefined, session: undefined, program: undefined } as const;
}


// 프로그램 정보 다시 불러오기 — 확인필요 예시
export const reloadNeedsCheck = [
  { file: "노래교실(오전)", activity: "", status: "확인필요" },
  { file: "스마트폰 기초반", activity: "", status: "확인필요" },
];

export const activityOptions = ["노래교실", "스마트폰(초급)", "요가교실", "건강체조"];

// 운영차수 생성 — 회차 Preview
export type PreviewSession = {
  id: string;
  program: string;
  round: string;
  date: string;
  time: string;
};

export const previewSessions: PreviewSession[] = [
  { id: "pv1", program: "노래교실", round: "1회차", date: "2026-09-07", time: "09:50~10:40" },
  { id: "pv2", program: "노래교실", round: "2회차", date: "2026-09-14", time: "09:50~10:40" },
  { id: "pv3", program: "노래교실", round: "3회차", date: "2026-09-21", time: "09:50~10:40" },
  { id: "pv4", program: "스마트폰(초급)", round: "1회차", date: "2026-09-08", time: "10:00~10:50" },
  { id: "pv5", program: "스마트폰(초급)", round: "2회차", date: "2026-09-15", time: "10:00~10:50" },
  { id: "pv6", program: "요가교실", round: "1회차", date: "2026-09-09", time: "14:00~14:50" },
];

// 사유결석
export type ExcusedRow = {
  id: string;
  date: string;
  program: string;
  user: string;
  round: string;
  past?: boolean;
};

// 모든 사유결석은 프로그램 → 해당 프로그램 수강생 → 해당 회차가 서로 일치한다.
export const excusedRows: ExcusedRow[] = [
  { id: "e1", date: "2026-09-07", program: "노래교실", user: "이용자 C", round: "12회차" },
  { id: "e2", date: "2026-09-08", program: "스마트폰(초급)", user: "이용자 F", round: "9회차" },
  { id: "e3", date: "2026-09-15", program: "스마트폰(초급)", user: "이용자 G", round: "10회차" },
  {
    id: "e4",
    date: "2026-08-26",
    program: "요가교실",
    user: "이용자 J",
    round: "5회차",
    past: true,
  },
  {
    id: "e5",
    date: "2026-08-24",
    program: "노래교실",
    user: "이용자 B",
    round: "10회차",
    past: true,
  },
];


// 결석관리
export type AbsenceRow = {
  id: string;
  user: string;
  program: string;
  unexcused: number;
  excused: number;
  state: "기준 임박" | "기준 도달";
};

// 이용자는 해당 프로그램의 수강명단(rosterByProgram)에 있는 이용자만 사용한다.
export const absenceRows: AbsenceRow[] = [
  { id: "a1", user: "이용자 F", program: "스마트폰(초급)", unexcused: 2, excused: 1, state: "기준 도달" },
  { id: "a2", user: "이용자 D", program: "노래교실", unexcused: 1, excused: 3, state: "기준 임박" },
  { id: "a3", user: "이용자 K", program: "요가교실", unexcused: 1, excused: 4, state: "기준 임박" },

];
