-- Additive only: retain every existing row, index and deletion tombstone/trigger.
-- Draft fields do not weaken the saved-description/status CHECK from 0002.
ALTER TABLE time_sessions ADD COLUMN draft_description TEXT
  CONSTRAINT draft_description_length CHECK (
    draft_description IS NULL OR length(draft_description) BETWEEN 1 AND 500
  );
ALTER TABLE time_sessions ADD COLUMN tag TEXT
  CONSTRAINT tag_values CHECK (
    tag IS NULL OR tag IN ('work', 'housework', 'self_development', 'chores', 'hobby', 'relaxation')
  );
-- Keep the original start payload stable even if the final tag is changed.
ALTER TABLE time_sessions ADD COLUMN start_tag TEXT
  CONSTRAINT start_tag_values CHECK (
    start_tag IS NULL OR start_tag IN ('work', 'housework', 'self_development', 'chores', 'hobby', 'relaxation')
  );
