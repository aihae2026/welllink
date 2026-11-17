-- 1. search_path 고정
ALTER FUNCTION public.set_updated_at() SET search_path = public;
ALTER FUNCTION public.compute_session_dates(date, date, smallint[]) SET search_path = public;

-- 2. 뷰를 security invoker 로 전환
ALTER VIEW public.v_enrollment_absence_state SET (security_invoker = on);

-- 3. public_holidays RLS
ALTER TABLE public.public_holidays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.public_holidays FROM anon;
GRANT SELECT ON public.public_holidays TO authenticated;
GRANT ALL ON public.public_holidays TO service_role;
DROP POLICY IF EXISTS "public_holidays_select_authenticated" ON public.public_holidays;
CREATE POLICY "public_holidays_select_authenticated"
  ON public.public_holidays FOR SELECT TO authenticated USING (true);

-- 4. 익명(anon) 및 PUBLIC 의 함수 실행 권한 회수, 로그인 사용자에게만 부여
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;