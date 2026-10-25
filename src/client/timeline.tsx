import type { CSSProperties } from "react";
import type { CalendarRecord } from "./api";
import {
  addDays,
  dayRange,
  formatTokyoDateTimeInput,
  layoutDayRecords,
  TIMELINE_HOUR_HEIGHT,
  tokyoDateKey,
  weekStart,
} from "./calendar-core";
import type { CalendarView } from "./calendar-store";
import { TagBadge, tagLabel } from "./tags";

export function recordLabel(record: CalendarRecord): string {
  return `${record.description}${record.tag ? `、タグ：${tagLabel(record.tag)}` : ""}、${formatTokyoDateTimeInput(record.startedAtMs).replace("T", " ")} から ${formatTokyoDateTimeInput(record.endedAtMs).replace("T", " ")} まで。編集する`;
}
export function Timeline({
  records,
  dateKey,
  view,
  edit,
}: {
  records: readonly CalendarRecord[];
  dateKey: string;
  view: CalendarView;
  edit: (id: string) => void;
}) {
  const first = view === "week" ? weekStart(dateKey) : dateKey;
  const days = Array.from({ length: view === "week" ? 7 : 1 }, (_, index) => addDays(first, index));
  const today = tokyoDateKey(Date.now());
  const dateHeading = (date: string) =>
    new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    }).format(dayRange(date).startMs);
  return (
    <div
      id="timeline-inner"
      className={`timeline-inner${view === "week" ? " week" : ""}`}
      style={
        {
          "--timeline-hour-height": `${TIMELINE_HOUR_HEIGHT}px`,
          "--timeline-day-height": `${24 * TIMELINE_HOUR_HEIGHT}px`,
        } as CSSProperties
      }
    >
      <div className="timeline-head">
        <div className="timeline-head-spacer" aria-hidden="true" />
        {days.map((date) => (
          <div key={date} className={`timeline-day-heading${date === today ? " today" : ""}`}>
            {dateHeading(date)}
          </div>
        ))}
      </div>
      <div className="timeline-body">
        <div className="timeline-axis">
          {Array.from({ length: 24 }, (_, hour) => hour).map((hour) => (
            <span key={hour} className="timeline-hour" style={{ top: `${(hour / 24) * 100}%` }}>
              {`${String(hour).padStart(2, "0")}:00`}
            </span>
          ))}
        </div>
        {days.map((date) => {
          const range = dayRange(date);
          return (
            <div key={date} className={`timeline-day${date === today ? " today" : ""}`}>
              {layoutDayRecords(records, date).map((item) => (
                <button
                  key={item.record.id}
                  type="button"
                  className="timeline-event"
                  aria-label={recordLabel(item.record)}
                  title={recordLabel(item.record)}
                  style={{
                    top: `${item.visualTopPercent}%`,
                    height: `${item.visualHeightPercent}%`,
                    left: `${item.visualLeftPercent}%`,
                    width: `${item.visualWidthPercent}%`,
                  }}
                  onClick={() => edit(item.record.id)}
                >
                  <span className="timeline-event-title">{item.record.description}</span>
                  <span className="timeline-event-meta">
                    <TagBadge tag={item.record.tag} />
                    <span className="timeline-event-time">
                      {`${item.clippedStartMs === range.startMs ? "00:00" : formatTokyoDateTimeInput(item.clippedStartMs).slice(11, 16)}–${item.clippedEndMs === range.endMs ? "24:00" : formatTokyoDateTimeInput(item.clippedEndMs).slice(11, 16)}`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
