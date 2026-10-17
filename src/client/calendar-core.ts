export interface CalendarLayoutRecord {
  readonly id: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}
export interface TimeRange {
  readonly startMs: number;
  readonly endMs: number;
}
export interface DayLayout<T extends CalendarLayoutRecord> {
  record: T;
  clippedStartMs: number;
  clippedEndMs: number;
  topPercent: number;
  heightPercent: number;
  visualTopPercent: number;
  visualHeightPercent: number;
  leftPercent: number;
  widthPercent: number;
  visualLeftPercent: number;
  visualWidthPercent: number;
}

// Toki stores instants as UTC epoch milliseconds. Modern Asia/Tokyo is UTC+09:00
// with no daylight-saving transitions; using UTC arithmetic keeps these calendar
// operations independent of the device's own time zone.
const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
// Share the rendered scale with the lane calculation: enlarging only in CSS
// would let adjacent short records cover each other's labels and click targets.
export const TIMELINE_HOUR_HEIGHT = 120;
export const TIMELINE_MIN_EVENT_HEIGHT = 44;
const MIN_VISIBLE_PERCENT = (TIMELINE_MIN_EVENT_HEIGHT / (24 * TIMELINE_HOUR_HEIGHT)) * 100;

function validInstant(value: number): boolean {
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime());
}

function requireDate(value: number): Date {
  if (!validInstant(value)) throw new RangeError("Invalid epoch milliseconds");
  const date = new Date(value);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    throw new RangeError("Year must be between 0001 and 9999");
  }
  return date;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function utcDateKey(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`;
}

function dateKeyUtcMidnight(dateKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) throw new RangeError("Invalid calendar date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError("Invalid calendar date");
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError("Invalid calendar date");
  }
  return date.getTime();
}

export function tokyoDateKey(epochMs: number): string {
  return utcDateKey(requireDate(epochMs + TOKYO_OFFSET_MS));
}

export function addDays(dateKey: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError("Invalid day offset");
  const date = new Date(dateKeyUtcMidnight(dateKey));
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateKey(requireDate(date.getTime()));
}

export function weekStart(dateKey: string): string {
  const date = new Date(dateKeyUtcMidnight(dateKey));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return addDays(dateKey, -daysSinceMonday);
}

export function dayRange(dateKey: string): TimeRange {
  const startMs = dateKeyUtcMidnight(dateKey) - TOKYO_OFFSET_MS;
  return { startMs, endMs: startMs + DAY_MS };
}

export function weekRange(dateKey: string): TimeRange {
  const startMs = dayRange(weekStart(dateKey)).startMs;
  return { startMs, endMs: startMs + 7 * DAY_MS };
}

export function formatTokyoDateTimeInput(epochMs: number): string {
  const local = requireDate(epochMs + TOKYO_OFFSET_MS);
  return `${utcDateKey(local)}T${twoDigits(local.getUTCHours())}:${twoDigits(local.getUTCMinutes())}:${twoDigits(local.getUTCSeconds())}`;
}

export function formatTokyoMinuteInput(epochMs: number): string {
  return formatTokyoDateTimeInput(epochMs).slice(0, 16);
}

export function parseTokyoMinuteInput(value: string): number | null {
  const epochMs = parseTokyoDateTimeInput(value);
  return epochMs === null ? null : Math.floor(epochMs / 60_000) * 60_000;
}

export function parseTokyoDateTimeInput(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) return null;
  try {
    const utcMs =
      dateKeyUtcMidnight(match[1] ?? "") +
      hour * 3_600_000 +
      minute * 60_000 +
      second * 1_000 -
      TOKYO_OFFSET_MS;
    return validInstant(utcMs) ? utcMs : null;
  } catch {
    return null;
  }
}

// Keep real instants separate from visual boxes. Minimum-height boxes need their
// own overlap lanes, including adjacent seconds and records at the day boundary;
// neither enlargement nor clipping may change persisted times or edit values.
export function layoutDayRecords<T extends CalendarLayoutRecord>(
  records: readonly T[],
  dateKey: string,
): DayLayout<T>[] {
  const { startMs, endMs } = dayRange(dateKey);
  const entries: Array<DayLayout<T> & { originalIndex: number; lane: number }> = [];
  records.forEach((record, originalIndex) => {
    if (
      record === null ||
      !validInstant(record.startedAtMs) ||
      record.endedAtMs === null ||
      !validInstant(record.endedAtMs) ||
      record.endedAtMs <= record.startedAtMs
    ) {
      return;
    }
    const clippedStartMs = Math.max(record.startedAtMs, startMs);
    const clippedEndMs = Math.min(record.endedAtMs, endMs);
    if (clippedStartMs >= clippedEndMs) return;
    const topPercent = ((clippedStartMs - startMs) / DAY_MS) * 100;
    const heightPercent = ((clippedEndMs - clippedStartMs) / DAY_MS) * 100;
    const visualHeightPercent = Math.max(heightPercent, MIN_VISIBLE_PERCENT);
    entries.push({
      record,
      clippedStartMs,
      clippedEndMs,
      topPercent,
      heightPercent,
      visualTopPercent: Math.min(topPercent, 100 - visualHeightPercent),
      visualHeightPercent,
      leftPercent: 0,
      widthPercent: 100,
      visualLeftPercent: 0,
      visualWidthPercent: 100,
      originalIndex,
      lane: 0,
    });
  });
  entries.sort(
    (a, b) =>
      a.clippedStartMs - b.clippedStartMs ||
      a.clippedEndMs - b.clippedEndMs ||
      a.originalIndex - b.originalIndex,
  );

  let groupStart = 0;
  while (groupStart < entries.length) {
    const first = entries[groupStart];
    if (first === undefined) break;
    let groupEnd = groupStart + 1;
    let latestEndMs = first.clippedEndMs;
    while (groupEnd < entries.length) {
      const next = entries[groupEnd];
      if (next === undefined || next.clippedStartMs >= latestEndMs) break;
      latestEndMs = Math.max(latestEndMs, next.clippedEndMs);
      groupEnd += 1;
    }

    const laneEnds: number[] = [];
    for (let index = groupStart; index < groupEnd; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      let lane = laneEnds.findIndex((endMs) => endMs <= entry.clippedStartMs);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(entry.clippedEndMs);
      } else {
        laneEnds[lane] = entry.clippedEndMs;
      }
      entry.lane = lane;
    }
    const width = 100 / laneEnds.length;
    for (let index = groupStart; index < groupEnd; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      entry.leftPercent = entry.lane * width;
      entry.widthPercent = width;
    }
    groupStart = groupEnd;
  }

  const visuals = entries
    .map((entry, index) => ({
      index,
      start: entry.visualTopPercent,
      end: entry.visualTopPercent + entry.visualHeightPercent,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  let visualGroupStart = 0;
  while (visualGroupStart < visuals.length) {
    const first = visuals[visualGroupStart];
    if (first === undefined) break;
    let visualGroupEnd = visualGroupStart + 1;
    let latestVisualEnd = first.end;
    while (visualGroupEnd < visuals.length) {
      const next = visuals[visualGroupEnd];
      if (next === undefined || next.start >= latestVisualEnd) break;
      latestVisualEnd = Math.max(latestVisualEnd, next.end);
      visualGroupEnd += 1;
    }

    const laneEnds: number[] = [];
    const lanes: number[] = [];
    for (let index = visualGroupStart; index < visualGroupEnd; index += 1) {
      const visual = visuals[index];
      if (visual === undefined) continue;
      let lane = laneEnds.findIndex((end) => end <= visual.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(visual.end);
      } else {
        laneEnds[lane] = visual.end;
      }
      lanes.push(lane);
    }
    const width = 100 / laneEnds.length;
    for (let index = visualGroupStart; index < visualGroupEnd; index += 1) {
      const visual = visuals[index];
      const entry = visual === undefined ? undefined : entries[visual.index];
      if (entry === undefined) continue;
      entry.visualLeftPercent = (lanes[index - visualGroupStart] ?? 0) * width;
      entry.visualWidthPercent = width;
    }
    visualGroupStart = visualGroupEnd;
  }

  return entries.map(({ originalIndex: _originalIndex, lane: _lane, ...entry }) => entry);
}
