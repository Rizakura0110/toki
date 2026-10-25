import { describe, expect, it } from "vitest";
import { createRecordSchema, editRecordSchema, saveSessionSchema, startSessionSchema } from "./api";
import { isTimeTag, TIME_TAGS } from "./tags";

const clientRequestId = "123e4567-e89b-42d3-a456-426614174000";

describe("fixed optional time tags and initial descriptions", () => {
  it("pins the six approved labels and identifiers", () => {
    expect(TIME_TAGS).toEqual([
      { id: "work", label: "仕事" },
      { id: "housework", label: "家事" },
      { id: "self_development", label: "自己研鑽" },
      { id: "chores", label: "雑務" },
      { id: "hobby", label: "趣味の時間" },
      { id: "relaxation", label: "だらけた時間" },
    ]);
  });

  it.each(["stopwatch", "timer"] as const)("accepts optional descriptions for %s", (mode) => {
    const input = { mode, clientRequestId, ...(mode === "timer" ? { timerSeconds: 60 } : {}) };
    expect(startSessionSchema.parse(input)).toEqual(input);
    expect(startSessionSchema.parse({ ...input, description: " \t " }).description).toBe("");
    expect(startSessionSchema.parse({ ...input, description: "  作業  " }).description).toBe(
      "作業",
    );
    expect(startSessionSchema.safeParse({ ...input, description: "a".repeat(500) }).success).toBe(
      true,
    );
    for (const description of [null, 123, {}, "a".repeat(501)]) {
      expect(startSessionSchema.safeParse({ ...input, description }).success).toBe(false);
    }
  });

  const schemas = [
    [startSessionSchema, { mode: "stopwatch", clientRequestId }],
    [startSessionSchema, { mode: "timer", timerSeconds: 60, clientRequestId }],
    [saveSessionSchema, { description: "" }],
    [createRecordSchema, { startedAtMs: 1, endedAtMs: 2, description: "", clientRequestId }],
    [editRecordSchema, { startedAtMs: 1, endedAtMs: 2, description: "", expectedVersion: 1 }],
  ] as const;
  it.each(schemas)(
    "supports omission, explicit clearing and exactly one approved tag",
    (schema, input) => {
      expect(schema.parse(input)).not.toHaveProperty("tag");
      expect(schema.parse({ ...input, tag: null })).toHaveProperty("tag", null);
      for (const { id } of TIME_TAGS) {
        expect(isTimeTag(id)).toBe(true);
        expect(schema.parse({ ...input, tag: id })).toHaveProperty("tag", id);
      }
      for (const tag of ["", "仕事", "WORK", "other", ["work"], {}, 0, true]) {
        expect(isTimeTag(tag)).toBe(false);
        expect(schema.safeParse({ ...input, tag }).success).toBe(false);
      }
    },
  );
});
