// Synthetic compatibility records only. Never replace these with a production export.
export const BASELINE_START_MS = Date.UTC(2026, 0, 1, 14, 59, 59, 123);
export const BASELINE_NOW_MS = BASELINE_START_MS + 86_400_000;

export interface BaselineRow {
  id: string;
  client_request_id: string;
  mode: "stopwatch" | "timer" | "manual";
  status: "running" | "awaiting_description" | "saved" | "discarded";
  started_at_ms: number;
  timer_seconds: number | null;
  deadline_at_ms: number | null;
  ended_at_ms: number | null;
  description: string | null;
  version: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export const savedStopwatch: BaselineRow = {
  id: "10000000-0000-4000-8000-000000000001",
  client_request_id: "20000000-0000-4000-8000-000000000001",
  mode: "stopwatch",
  status: "saved",
  started_at_ms: BASELINE_START_MS,
  timer_seconds: null,
  deadline_at_ms: null,
  ended_at_ms: BASELINE_START_MS + 31_234,
  description: "合成データ：読書",
  version: 3,
  created_at_ms: BASELINE_START_MS,
  updated_at_ms: BASELINE_START_MS + 32_000,
};

// Saved timers can be edited beyond the original deadline, which remains audit data.
export const savedTimer: BaselineRow = {
  ...savedStopwatch,
  id: "10000000-0000-4000-8000-000000000002",
  client_request_id: "20000000-0000-4000-8000-000000000002",
  mode: "timer",
  timer_seconds: 1,
  deadline_at_ms: BASELINE_START_MS + 1_000,
  ended_at_ms: BASELINE_START_MS + 60_000,
  description: "合成データ：重複する作業",
  version: 4,
  updated_at_ms: BASELINE_START_MS + 61_000,
};

export const manualRecord: BaselineRow = {
  ...savedStopwatch,
  id: "10000000-0000-4000-8000-000000000003",
  client_request_id: "20000000-0000-4000-8000-000000000003",
  mode: "manual",
  started_at_ms: BASELINE_NOW_MS + 86_400_000,
  ended_at_ms: BASELINE_NOW_MS + 86_460_000,
  description: "無題",
  version: 1,
};

export const discardedSession: BaselineRow = {
  ...savedStopwatch,
  id: "10000000-0000-4000-8000-000000000004",
  client_request_id: "20000000-0000-4000-8000-000000000004",
  status: "discarded",
  description: null,
};

const runningStopwatch: BaselineRow = {
  ...savedStopwatch,
  id: "10000000-0000-4000-8000-000000000005",
  client_request_id: "20000000-0000-4000-8000-000000000005",
  status: "running",
  started_at_ms: BASELINE_NOW_MS,
  ended_at_ms: null,
  description: null,
  version: 1,
  created_at_ms: BASELINE_NOW_MS,
  updated_at_ms: BASELINE_NOW_MS,
};

// Each scenario gets its own DB: the one-open-session constraint is intentional.
export const openSessionScenarios: readonly BaselineRow[] = [
  runningStopwatch,
  {
    ...runningStopwatch,
    mode: "timer",
    timer_seconds: 60,
    deadline_at_ms: BASELINE_NOW_MS + 60_000,
  },
  {
    ...runningStopwatch,
    status: "awaiting_description",
    ended_at_ms: BASELINE_NOW_MS + 1,
    version: 2,
    updated_at_ms: BASELINE_NOW_MS + 1,
  },
  {
    ...runningStopwatch,
    mode: "timer",
    status: "awaiting_description",
    timer_seconds: 1,
    deadline_at_ms: BASELINE_NOW_MS + 1_000,
    ended_at_ms: BASELINE_NOW_MS + 1_000,
    version: 2,
    updated_at_ms: BASELINE_NOW_MS + 1_000,
  },
];

export function expectedSession(row: BaselineRow) {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    mode: row.mode,
    status: row.status,
    startedAtMs: row.started_at_ms,
    timerSeconds: row.timer_seconds,
    deadlineAtMs: row.deadline_at_ms,
    endedAtMs: row.ended_at_ms,
    description: row.description,
    version: row.version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}
