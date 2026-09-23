-- Rebuild the table to admit records entered without a measurement. Preserve
-- every existing session, including running and discarded sessions, unchanged.
CREATE TABLE time_sessions_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  client_request_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('stopwatch', 'timer', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'awaiting_description', 'saved', 'discarded')),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  timer_seconds INTEGER,
  deadline_at_ms INTEGER,
  ended_at_ms INTEGER,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (mode IN ('stopwatch', 'manual') AND timer_seconds IS NULL AND deadline_at_ms IS NULL)
    OR
    (mode = 'timer' AND timer_seconds BETWEEN 1 AND 86400
      AND deadline_at_ms IS NOT NULL
      AND (status IN ('saved', 'discarded')
        OR deadline_at_ms = started_at_ms + timer_seconds * 1000))
  ),
  CHECK (mode != 'manual' OR status = 'saved'),
  CHECK (
    (status = 'running' AND ended_at_ms IS NULL AND description IS NULL)
    OR
    (status = 'awaiting_description' AND ended_at_ms > started_at_ms AND description IS NULL)
    OR
    (status = 'saved' AND ended_at_ms > started_at_ms
      AND ended_at_ms - started_at_ms <= 31622400000
      AND description IS NOT NULL AND length(trim(description)) BETWEEN 1 AND 500)
    OR
    (status = 'discarded' AND ended_at_ms > started_at_ms AND description IS NULL)
  ),
  -- A saved timer record can be edited past its original deadline.
  CHECK (mode = 'stopwatch' OR status IN ('saved', 'discarded')
    OR ended_at_ms IS NULL OR ended_at_ms <= deadline_at_ms)
);

INSERT INTO time_sessions_v2
  (id, client_request_id, mode, status, started_at_ms, timer_seconds,
   deadline_at_ms, ended_at_ms, description, version, created_at_ms, updated_at_ms)
SELECT id, client_request_id, mode, status, started_at_ms, timer_seconds,
       deadline_at_ms, ended_at_ms, description, version, created_at_ms, updated_at_ms
FROM time_sessions;

DROP TABLE time_sessions;
ALTER TABLE time_sessions_v2 RENAME TO time_sessions;

CREATE UNIQUE INDEX time_sessions_one_open
  ON time_sessions ((1))
  WHERE status IN ('running', 'awaiting_description');

CREATE INDEX time_sessions_saved_start
  ON time_sessions (started_at_ms)
  WHERE status = 'saved';

CREATE INDEX time_sessions_saved_end
  ON time_sessions (ended_at_ms)
  WHERE status = 'saved';

-- A deleted record must not reappear if its original create/start request is
-- replayed after an uncertain network response. Keep only the request UUID.
CREATE TABLE deleted_client_request_ids (
  client_request_id TEXT PRIMARY KEY NOT NULL
);

CREATE TRIGGER time_sessions_remember_deleted_request
AFTER DELETE ON time_sessions
BEGIN
  INSERT INTO deleted_client_request_ids (client_request_id)
  VALUES (OLD.client_request_id);
END;
