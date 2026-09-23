import { z } from "zod";

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const MAX_RECORD_OR_QUERY_DURATION_MS = 366 * 24 * 60 * 60 * 1_000;

const epochMsSchema = z.int().positive().max(MAX_TIMESTAMP_MS);
const descriptionSchema = z.string().trim().min(1).max(500);

export const sessionIdSchema = z.uuid();
export const recordIdSchema = sessionIdSchema;

const clientRequestIdSchema = z.uuid();

export const startSessionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("stopwatch"),
    clientRequestId: clientRequestIdSchema,
  }),
  z.strictObject({
    mode: z.literal("timer"),
    timerSeconds: z.int().min(1).max(86_400),
    clientRequestId: clientRequestIdSchema,
  }),
]);

export const saveSessionSchema = z.strictObject({
  description: descriptionSchema,
});

function validRecordInterval<Fields extends { startedAtMs: number; endedAtMs: number }>(
  schema: z.ZodType<Fields>,
) {
  return schema
    .refine((value) => value.endedAtMs > value.startedAtMs, {
      message: "The end time must be after the start time.",
      path: ["endedAtMs"],
    })
    .refine((value) => value.endedAtMs - value.startedAtMs <= MAX_RECORD_OR_QUERY_DURATION_MS, {
      message: "The record duration exceeds 366 days.",
      path: ["endedAtMs"],
    });
}

export const createRecordSchema = validRecordInterval(
  z.strictObject({
    startedAtMs: epochMsSchema,
    endedAtMs: epochMsSchema,
    description: descriptionSchema,
    clientRequestId: clientRequestIdSchema,
  }),
);

export const editRecordSchema = validRecordInterval(
  z.strictObject({
    startedAtMs: epochMsSchema,
    endedAtMs: epochMsSchema,
    description: descriptionSchema,
    expectedVersion: z.int().positive(),
  }),
);

export const deleteRecordSchema = z.strictObject({
  expectedVersion: z.int().positive(),
});

const epochMsQuerySchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform((value) => Number(value))
  .pipe(epochMsSchema);

export const recordsQuerySchema = z
  .strictObject({
    startMs: epochMsQuerySchema,
    endMs: epochMsQuerySchema,
  })
  .refine((value) => value.endMs > value.startMs, {
    message: "The end time must be after the start time.",
    path: ["endMs"],
  })
  .refine((value) => value.endMs - value.startMs <= MAX_RECORD_OR_QUERY_DURATION_MS, {
    message: "The query range exceeds 366 days.",
    path: ["endMs"],
  });

export type StartSessionInput = z.infer<typeof startSessionSchema>;
export type SaveSessionInput = z.infer<typeof saveSessionSchema>;
export type CreateRecordInput = z.infer<typeof createRecordSchema>;
export type EditRecordInput = z.infer<typeof editRecordSchema>;
export type DeleteRecordInput = z.infer<typeof deleteRecordSchema>;
export type RecordsQuery = z.infer<typeof recordsQuerySchema>;
