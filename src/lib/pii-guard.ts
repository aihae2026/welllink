// AI 사업평가 "AI 참고사항" 개인정보 검사.
// 클라이언트(evaluation.new.tsx)와 서버(ai-evaluation-server.ts) 양쪽에서 이 모듈을
// 그대로 재사용한다 -- client validation은 UX 편의일 뿐 보안 경계가 아니므로, 서버도
// 반드시 같은 규칙으로 다시 검사한다(§17: PII Guard는 client만 믿지 않는다).
//
// 참고사항은 외부 AI(Gemini)로 전송되고 평가 기록에 저장된다. 그래서 두 단계로 나눈다.
// - 차단(detectBlockedPii): 형식이 정확해 오탐이 거의 없는 식별번호·연락처. 무조건 막는다.
// - 경고(detectPiiWarnings + 서버의 회원명 대조): 오탐이 있을 수 있어 사용자가
//   "개인정보가 아니다"라고 확인해야만 진행한다.

export type BlockedPiiKind =
  | "resident_number"
  | "birth_gender"
  | "passport"
  | "driver_license"
  | "phone"
  | "email"
  | "member_code";

export type PiiWarningKind = "member_name" | "address" | "birth_date" | "health";

export type PiiMatch<K extends string> = { kind: K; text: string };

export const BLOCKED_PII_LABEL: Record<BlockedPiiKind, string> = {
  resident_number: "주민등록번호",
  birth_gender: "생년월일-성별(주민등록번호 앞자리)",
  passport: "여권번호",
  driver_license: "운전면허번호",
  phone: "전화번호",
  email: "이메일",
  member_code: "회원번호",
};

export const PII_WARNING_LABEL: Record<PiiWarningKind, string> = {
  member_name: "회원명",
  address: "주소",
  birth_date: "생년월일",
  health: "건강정보",
};

function pushUnique<K extends string>(out: PiiMatch<K>[], kind: K, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (out.some((m) => m.kind === kind && m.text === trimmed)) return;
  out.push({ kind, text: trimmed });
}

// ---------------------------------------------------------------------------
// 차단

// 주민등록번호·외국인등록번호 모양: YYMMDD + (구분자) + 성별자리 1~8 + 뒷자리(숫자 6개 또는 가림).
const RESIDENT_NUMBER_RE =
  /(?<!\d)(\d{2})(\d{2})(\d{2})(\s*-\s*|)([1-8])(\d{6}|[*xX●○•]{1,6})?(?![\d*xX●○•])/g;
// 날짜 뒤에 순번을 붙인 표기(260915-1차, 260915-1회차)는 생년월일-성별로 보지 않는다.
const SEQUENCE_SUFFIX_RE = /^\s*(?:차|회|번|호)/;

function isValidBirthDate(yy: string, mm: string, dd: string, genderDigit: string): boolean {
  const century = "1256".includes(genderDigit) ? 1900 : 2000;
  const year = century + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(year, month, 0).getDate();
}

function findResidentNumbers(text: string, out: PiiMatch<BlockedPiiKind>[]) {
  for (const m of text.matchAll(RESIDENT_NUMBER_RE)) {
    const [whole, yy = "", mm = "", dd = "", separator = "", genderDigit = "", tail] = m;
    if (!isValidBirthDate(yy, mm, dd, genderDigit)) continue;
    if (tail) {
      pushUnique(out, "resident_number", whole);
      continue;
    }
    // 뒷자리가 없으면 하이픈이 있어야 한다(숫자 7개만 붙어 있으면 일반 숫자와 구분이 안 된다).
    if (!separator.includes("-")) continue;
    const after = text.slice((m.index ?? 0) + whole.length);
    if (SEQUENCE_SUFFIX_RE.test(after)) continue;
    pushUnique(out, "birth_gender", whole);
  }
}

const BLOCKED_PATTERNS: { kind: BlockedPiiKind; re: RegExp }[] = [
  // 여권번호: 구형 M12345678, 신형(2021~) M123A4567
  { kind: "passport", re: /(?<![A-Za-z0-9])[MSRODG](?:\d{8}|\d{3}[A-Z]\d{4})(?![A-Za-z0-9])/g },
  // 운전면허번호: 11-22-333333-44
  { kind: "driver_license", re: /(?<!\d)\d{2}-\d{2}-\d{6}-\d{2}(?!\d)/g },
  // 휴대전화
  { kind: "phone", re: /(?<!\d)01[016-9][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g },
  // 일반전화(지역번호)·070. 1588 같은 대표번호는 지역번호로 시작하지 않아 걸리지 않는다.
  {
    kind: "phone",
    re: /(?<!\d)\(?(?:02|0(?:3[1-3]|4[1-4]|5[1-5]|6[1-4])|070)\)?[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g,
  },
  { kind: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  // 회원번호 YYYY-##### (하이픈 없는 9자리도 명단 등록에서 받으므로 함께 막는다)
  { kind: "member_code", re: /(?<!\d)(?:19|20)\d{2}-?\d{5}(?!\d)/g },
];

export function detectBlockedPii(text: string): PiiMatch<BlockedPiiKind>[] {
  if (!text) return [];
  const out: PiiMatch<BlockedPiiKind>[] = [];
  findResidentNumbers(text, out);
  for (const { kind, re } of BLOCKED_PATTERNS) {
    for (const m of text.matchAll(re)) pushUnique(out, kind, m[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 경고 (패턴). 회원명은 기관 명단이 필요해 서버(findMemberNames)에서만 검사한다.

// 번호 바로 뒤에 붙으면 주소가 아니라 횟수·인원 같은 수량으로 본다(경로 3회, 활동 2-3월).
const QUANTITY_UNIT =
  "(?![\\d-])(?!\\s*(?:회|명|건|개|차|년|월|일|시|분|초|세|%|퍼센트|곳|종|주|학기|반|번째|등|위|가지|배|원|만|천|인|기))";

const ADDRESS_PATTERNS: RegExp[] = [
  // 도로명 + 건물번호: 테헤란로 123, 논현로85길 12-3. 조사 "으로"(강당으로 12)는 뺀다.
  new RegExp(`[가-힣A-Za-z0-9]+(?<!으)(?:로|길)\\s*\\d+(?:-\\d+)?${QUANTITY_UNIT}`, "g"),
  // 지번: 역삼동 123-45, 역삼동 123번지
  new RegExp(`[가-힣]+(?:동|리)\\s*\\d+(?:-\\d+|\\s*번지)${QUANTITY_UNIT}`, "g"),
  // 아파트 동·호수: 101동 1203호
  /\d+\s*동\s*\d+\s*호/g,
];

const BIRTH_DATE_PATTERNS: RegExp[] = [
  // 1945년생, 45년생 (2026년생활체육 같은 붙여 쓴 낱말은 뺀다)
  /(?<!\d)(?:19|20)?\d{2}\s?년생(?!활|산|명|존|계|필|애|태|성|각)/g,
  // 생년월일: 1945.03.02 / 생일 45-3-2 / 출생 1945년
  /(?:생년월일|생일|출생)[^\n]{0,10}?\d{2,4}\s*[.\-/년]\s*\d{1,2}/g,
  // 1945.3.2생, 3월 2일생
  /(?:\d{2,4}[.\-/]\d{1,2}[.\-/]\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일)\s*생(?![가-힣])/g,
];

// 건강 단어. 예방·교육 프로그램 이름(치매예방교실 등)은 개인 건강정보가 아니므로 뺀다.
const HEALTH_KEYWORD_RE =
  /(?:치매|인지\s*저하|경도\s*인지|입원|퇴원|수술|투석|뇌졸중|중풍|뇌경색|파킨슨|우울증|장애\s*등급|요양\s*등급|항암|암\s*(?:진단|수술|치료|환자|투병)|골절|확진)(?!\s*(?:예방|교육|교실|프로그램|인식|안심|파트너))/;
// 한 문장 안에 특정 개인을 가리키는 말이 있어야 경고한다(코로나로 휴강 → 경고 없음).
const PERSON_REFERENCE_RE =
  /어르신|회원|수강생|이용자|참여자|대상자|할머니|할아버지|[가-힣]{1,4}\s*(?:님|씨)(?![가-힣])|[가-힣][○OoXx*]{1,2}/;

function splitSentences(text: string): string[] {
  // 날짜의 점(2026.09.15)에서는 자르지 않는다.
  return text.split(/(?<!\d)[.!?](?!\d)|\n/);
}

export function detectPiiWarnings(text: string): PiiMatch<PiiWarningKind>[] {
  if (!text) return [];
  const out: PiiMatch<PiiWarningKind>[] = [];
  for (const re of ADDRESS_PATTERNS) {
    for (const m of text.matchAll(re)) pushUnique(out, "address", m[0]);
  }
  for (const re of BIRTH_DATE_PATTERNS) {
    for (const m of text.matchAll(re)) pushUnique(out, "birth_date", m[0]);
  }
  for (const sentence of splitSentences(text)) {
    if (HEALTH_KEYWORD_RE.test(sentence) && PERSON_REFERENCE_RE.test(sentence)) {
      const s = sentence.trim();
      pushUnique(out, "health", s.length > 40 ? `${s.slice(0, 40)}…` : s);
    }
  }
  return out;
}

// 회원명: 세 글자 이상 이름만 대조한다(두 글자 이름은 일반 단어와 겹친다).
export const MEMBER_NAME_MIN_LENGTH = 3;

export function findMemberNames(text: string, names: Iterable<string>): PiiMatch<"member_name">[] {
  if (!text) return [];
  const out: PiiMatch<"member_name">[] = [];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, "");
    if (name.length < MEMBER_NAME_MIN_LENGTH) continue;
    if (text.includes(name)) pushUnique(out, "member_name", name);
  }
  return out;
}
