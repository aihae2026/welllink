import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// 이 파일은 server(SSR)와 browser(client bundle) 양쪽에서 import된다. import.meta.env는
// Vite 빌드 시점에 값이 박히는 client 변수라 로컬 개발에서는 잘 동작하지만, Lovable
// Publish는 이 이름을 build-time에 채워주지 않는다(Cloudflare Worker runtime에
// prefix 없는 SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY만 주입) -- process.env는 그
// Worker runtime(SSR)에서는 읽히지만 browser에는 존재하지 않는 Node 전용 객체라
// client bundle에서 fallback으로 쓸 수 없다. 그래서 이 두 "공개" 값(secret 아님)만
// __root.tsx의 root loader(SSR에서 process.env로 읽음)가 browser로 넘겨주고,
// setSupabasePublicConfig가 그 값을 여기 주입한다. supabase는 그 값이 준비된 뒤
// (AuthProvider의 useEffect, 즉 항상 client-side) 처음 쓰일 때만 생성되는 지연 client다.
let publicConfig: { url: string; key: string } | null = null;

export function setSupabasePublicConfig(config: { url: string; key: string }) {
  publicConfig = config;
}

function resolveConfig(): { url: string; key: string } {
  const url = import.meta.env["VITE_SUPABASE_URL"] ?? publicConfig?.url;
  const key =
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
    import.meta.env["VITE_SUPABASE_ANON_KEY"] ??
    publicConfig?.key;

  if (!url || !key) {
    throw new Error("Supabase 공개 키 환경변수가 설정되지 않았습니다.");
  }
  return { url, key };
}

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!client) {
    const { url, key } = resolveConfig();
    // 공개 client 키(anon/publishable)만 사용한다. service_role key는 절대 이 파일이나
    // 다른 client 코드에 넣지 않는다.
    client = createClient(url, key);
  }
  return client;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});
