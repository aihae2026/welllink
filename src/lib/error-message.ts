// 실패 알림에 붙일 이유. DB 함수가 보내는 한국어 이유("이미 같은 이름의 …")는 그대로
// 보여주고, 한글이 없는 원문(네트워크·권한·제약 위반 등 영어 시스템 오류)은 일반 안내로 바꾼다.
export function errorReason(e: unknown, fallback = "잠시 후 다시 시도해 주세요."): string {
  const raw =
    typeof e === "string"
      ? e
      : e && typeof e === "object" && "message" in e
        ? String((e as { message?: unknown }).message ?? "")
        : "";
  return /[가-힣]/.test(raw) ? raw : fallback;
}
