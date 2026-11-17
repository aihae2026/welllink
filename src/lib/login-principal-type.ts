import { useEffect, useState } from "react";
import { supabase } from "./supabase";

// 지금 로그인한 계정이 직원·강사 중 어느 사용자로 연결돼 있는지.
// 같은 브라우저에서 강사로 로그인한 채 직원 화면을 열거나(그 반대), 연결 정보가 없는
// 계정으로 들어왔을 때 막힘 화면에서 알맞은 안내와 이동 버튼을 고르는 데만 쓴다.
// principals는 같은 기관 사용자끼리 조회 가능하다(RLS "같은 조직 principal 조회").
export type LoginPrincipalType = "staff" | "instructor" | "none";

export function useLoginPrincipalType(userId: string | undefined, enabled: boolean) {
  const [type, setType] = useState<LoginPrincipalType | null>(null);

  useEffect(() => {
    if (!enabled || !userId) return;
    let active = true;
    supabase
      .from("principals")
      .select("principal_type")
      .eq("auth_user_id", userId)
      .eq("is_active", true)
      .limit(1)
      .then(({ data }) => {
        if (!active) return;
        const found = data?.[0]?.principal_type;
        setType(found === "staff" || found === "instructor" ? found : "none");
      });
    return () => {
      active = false;
    };
  }, [userId, enabled]);

  return type;
}
