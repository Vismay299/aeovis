-- Private provider response snapshots and a durable operator incident inbox.
CREATE TABLE IF NOT EXISTS measurement_evidence (
  observation_id text NOT NULL REFERENCES probe_observations(id),
  attempt_token uuid NOT NULL REFERENCES probe_attempts(lease_token),
  capture_index integer NOT NULL CHECK(capture_index>=0), surface text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','stored','write_failed','expired')),
  object_key text, sha256 text, captured_at timestamptz, expires_at timestamptz, reason text,
  PRIMARY KEY(observation_id,attempt_token,capture_index)
);
CREATE TABLE IF NOT EXISTS measurement_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), engine text NOT NULL, kind text NOT NULL,
  parser_version text NOT NULL, shape_hash text NOT NULL,
  first_observation text NOT NULL REFERENCES probe_observations(id),
  last_observation text NOT NULL REFERENCES probe_observations(id),
  first_seen timestamptz NOT NULL DEFAULT now(),last_seen timestamptz NOT NULL DEFAULT now(),
  occurrences integer NOT NULL DEFAULT 1, acknowledged_at timestamptz,
  UNIQUE(engine,kind,parser_version,shape_hash)
);
ALTER TABLE measurement_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON measurement_evidence,measurement_incidents FROM PUBLIC,anon,authenticated;
GRANT ALL ON measurement_evidence,measurement_incidents TO service_role;
CREATE OR REPLACE FUNCTION record_measurement_incident(p_observation text,p_engine text,p_kind text,p_parser text,p_shape text)
RETURNS void LANGUAGE sql SET search_path=public AS $$
  INSERT INTO measurement_incidents(engine,kind,parser_version,shape_hash,first_observation,last_observation)
  VALUES(p_engine,p_kind,p_parser,p_shape,p_observation,p_observation)
  ON CONFLICT(engine,kind,parser_version,shape_hash) DO UPDATE
    SET last_observation=excluded.last_observation,last_seen=now(),occurrences=measurement_incidents.occurrences+1,acknowledged_at=NULL;
$$;
REVOKE ALL ON FUNCTION record_measurement_incident(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION record_measurement_incident(text,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
