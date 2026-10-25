import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { TimeTag } from "../contracts/tags";

// Map migrations through 0003; these definitions do not migrate the DB.
// The AFTER DELETE tombstone trigger remains authoritative in the SQL migration.
export const timeSessions = sqliteTable(
  "time_sessions",
  {
    id: text("id").primaryKey().notNull(),
    clientRequestId: text("client_request_id").notNull().unique(),
    mode: text("mode", { enum: ["stopwatch", "timer", "manual"] }).notNull(),
    status: text("status", {
      enum: ["running", "awaiting_description", "saved", "discarded"],
    }).notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    timerSeconds: integer("timer_seconds"),
    deadlineAtMs: integer("deadline_at_ms"),
    endedAtMs: integer("ended_at_ms"),
    description: text("description"),
    version: integer("version").notNull().default(1),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    draftDescription: text("draft_description"),
    tag: text("tag").$type<TimeTag>(),
    startTag: text("start_tag").$type<TimeTag>(),
  },
  (table) => [
    uniqueIndex("time_sessions_one_open")
      .on(sql`(1)`)
      .where(sql`${table.status} IN ('running', 'awaiting_description')`),
    index("time_sessions_saved_start").on(table.startedAtMs).where(sql`${table.status} = 'saved'`),
    index("time_sessions_saved_end").on(table.endedAtMs).where(sql`${table.status} = 'saved'`),
    check("mode_values", sql`${table.mode} IN ('stopwatch', 'timer', 'manual')`),
    check(
      "status_values",
      sql`${table.status} IN ('running', 'awaiting_description', 'saved', 'discarded')`,
    ),
    check("started_at_ms_nonnegative", sql`${table.startedAtMs} >= 0`),
    check("version_positive", sql`${table.version} >= 1`),
    check("created_at_ms_nonnegative", sql`${table.createdAtMs} >= 0`),
    check("updated_at_ms_order", sql`${table.updatedAtMs} >= ${table.createdAtMs}`),
    check(
      "draft_description_length",
      sql`${table.draftDescription} IS NULL OR length(${table.draftDescription}) BETWEEN 1 AND 500`,
    ),
    check(
      "tag_values",
      sql`${table.tag} IS NULL OR ${table.tag} IN ('work', 'housework', 'self_development', 'chores', 'hobby', 'relaxation')`,
    ),
    check(
      "start_tag_values",
      sql`${table.startTag} IS NULL OR ${table.startTag} IN ('work', 'housework', 'self_development', 'chores', 'hobby', 'relaxation')`,
    ),
    check(
      "timer_metadata",
      sql`(${table.mode} IN ('stopwatch', 'manual') AND ${table.timerSeconds} IS NULL AND ${table.deadlineAtMs} IS NULL)
        OR (${table.mode} = 'timer' AND ${table.timerSeconds} BETWEEN 1 AND 86400
          AND ${table.deadlineAtMs} IS NOT NULL
          AND (${table.status} IN ('saved', 'discarded')
            OR ${table.deadlineAtMs} = ${table.startedAtMs} + ${table.timerSeconds} * 1000))`,
    ),
    check("manual_saved", sql`${table.mode} != 'manual' OR ${table.status} = 'saved'`),
    check(
      "status_fields",
      sql`(${table.status} = 'running' AND ${table.endedAtMs} IS NULL AND ${table.description} IS NULL)
        OR (${table.status} = 'awaiting_description' AND ${table.endedAtMs} > ${table.startedAtMs} AND ${table.description} IS NULL)
        OR (${table.status} = 'saved' AND ${table.endedAtMs} > ${table.startedAtMs}
          AND ${table.endedAtMs} - ${table.startedAtMs} <= 31622400000
          AND ${table.description} IS NOT NULL AND length(trim(${table.description})) BETWEEN 1 AND 500)
        OR (${table.status} = 'discarded' AND ${table.endedAtMs} > ${table.startedAtMs} AND ${table.description} IS NULL)`,
    ),
    check(
      "timer_end",
      sql`${table.mode} = 'stopwatch' OR ${table.status} IN ('saved', 'discarded')
        OR ${table.endedAtMs} IS NULL OR ${table.endedAtMs} <= ${table.deadlineAtMs}`,
    ),
  ],
);

export const deletedClientRequestIds = sqliteTable("deleted_client_request_ids", {
  clientRequestId: text("client_request_id").primaryKey().notNull(),
});

// Literal, trusted status predicates keep the existing partial indexes eligible.
// Do not replace the IN predicate with parameter placeholders or OR expressions.
export const openSessionPredicate = sql`${timeSessions.status} IN ('running', 'awaiting_description')`;
export const savedRecordPredicate = sql`${timeSessions.status} = 'saved'`;
