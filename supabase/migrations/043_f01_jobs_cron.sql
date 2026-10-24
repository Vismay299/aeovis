-- F01: drive /api/jobs/tick every minute from Supabase pg_cron + pg_net.
-- URL and secret live in Supabase Vault (names below); this file holds no secret.
-- Databases without pg_cron/pg_net (CI, local QA) skip the schedule and still apply.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net;
  ELSE
    RAISE NOTICE 'F01: pg_cron/pg_net unavailable; jobs tick schedule not installed';
  END IF;
END $$;

-- plpgsql resolves vault/net at call time, so this compiles without them.
CREATE OR REPLACE FUNCTION public.jobs_tick_http() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_url text; v_secret text; v_request bigint;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'perceev_jobs_tick_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'perceev_cron_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'F01: jobs tick not configured (vault secrets missing)';
    RETURN NULL;
  END IF;
  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000) INTO v_request;
  RETURN v_request;
END $$;
REVOKE ALL ON FUNCTION public.jobs_tick_http() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jobs_tick_http() TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'perceev-jobs-tick';
    PERFORM cron.schedule('perceev-jobs-tick', '* * * * *', 'SELECT public.jobs_tick_http()');
  END IF;
END $$;
