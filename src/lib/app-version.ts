import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

// 새 버전이 배포돼도 이미 열려 있던 탭(강사 태블릿 등)은 페이지를 다시 불러오기 전까지
// 옛 코드로 계속 돈다 -- 로그인/로그아웃도 화면 이동일 뿐이라 코드가 바뀌지 않는다.
// 배포본 HTML의 시작 파일 이름(/assets/index-<해시>.js)은 빌드마다 바뀌므로, 지금 탭이
// 불러온 이름과 비교해 다르면 새로고침한다.
//
// 새로고침 시점(입력 중인 내용이 날아가지 않게):
// - 화면 이동이 끝났을 때(이동 전 확인창은 이미 지난 뒤)
// - 탭이 다시 보일 때는 강사 화면·로그인·홈에서만(강사 출석은 누르는 즉시 저장된다)

const ENTRY_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;
// 같은 새 버전으로 한 번만 새로고침한다(캐시 때문에 옛 파일이 또 오면 반복하지 않게).
const RELOADED_FOR_KEY = "welllink:reloaded-for-entry";

function loadedEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/index-"]',
  );
  return el?.getAttribute("src")?.match(ENTRY_RE)?.[0] ?? null;
}

async function fetchDeployedEntry(): Promise<string | null> {
  const res = await fetch(`/login?v=${Date.now()}`, { cache: "no-store", credentials: "omit" });
  if (!res.ok) return null;
  return (await res.text()).match(ENTRY_RE)?.[0] ?? null;
}

function readReloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

function reloadFor(entry: string) {
  try {
    sessionStorage.setItem(RELOADED_FOR_KEY, entry);
  } catch {
    // 저장이 막혀도 새로고침은 한다.
  }
  window.location.reload();
}

function reloadsOnReturn(pathname: string): boolean {
  return pathname === "/" || pathname === "/login" || pathname.startsWith("/instructor");
}

export function useReloadOnNewVersion() {
  const router = useRouter();

  useEffect(() => {
    const current = loadedEntry();
    if (!current) return; // 개발 서버 등 빌드 파일이 없는 환경

    let pendingEntry: string | null = null;
    let lastCheck = 0;

    const check = async () => {
      if (pendingEntry || Date.now() - lastCheck < MIN_CHECK_GAP_MS) return;
      lastCheck = Date.now();
      try {
        const deployed = await fetchDeployedEntry();
        if (deployed && deployed !== current && readReloadedFor() !== deployed) {
          pendingEntry = deployed;
        }
      } catch {
        // 네트워크 오류는 다음 확인 때 다시 본다.
      }
    };

    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      await check();
      if (pendingEntry && reloadsOnReturn(window.location.pathname)) reloadFor(pendingEntry);
    };

    const unsubscribe = router.subscribe("onResolved", () => {
      if (pendingEntry) reloadFor(pendingEntry);
    });
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    void check();

    return () => {
      unsubscribe();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [router]);
}
