-- A session becomes a calendar record only after its description is saved.
-- All instants are UTC epoch milliseconds; the UI renders them in Asia/Tokyo.
CREATE TABLE IF NOT EXISTS time_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  client_request_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('stopwatch', 'timer')),
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
    (mode = 'stopwatch' AND timer_seconds IS NULL AND deadline_at_ms IS NULL)
    OR
    (mode = 'timer' AND timer_seconds BETWEEN 1 AND 86400
      AND deadline_at_ms IS NOT NULL
      AND (status IN ('saved', 'discarded')
        OR deadline_at_ms = started_at_ms + timer_seconds * 1000))
  ),
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
  -- A saved record may be moved freely; the original timer deadline is audit data.
  CHECK (mode = 'stopwatch' OR status IN ('saved', 'discarded')
    OR ended_at_ms IS NULL OR ended_at_ms <= deadline_at_ms)
);

-- A constant-key partial unique index makes the one-open-session rule atomic
-- across tabs and devices, including an expired timer awaiting its description.
CREATE UNIQUE INDEX IF NOT EXISTS time_sessions_one_open
  ON time_sessions ((1))
  WHERE status IN ('running', 'awaiting_description');

CREATE INDEX IF NOT EXISTS time_sessions_saved_start
  ON time_sessions (started_at_ms)
  WHERE status = 'saved';

CREATE INDEX IF NOT EXISTS time_sessions_saved_end
  ON time_sessions (ended_at_ms)
  WHERE status = 'saved';
