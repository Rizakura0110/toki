import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCurrentDatabase } from "../../tests/fixtures/local-database";
import { TIME_TAGS, type TimeTag } from "../contracts/tags";
import {
  createManualRecord,
  deleteSavedRecord,
  discardSession,
  editSavedRecord,
  getCurrentSession,
  listSavedRecords,
  saveSession,
  startSession,
  stopSession,
} from "./records";

const NOW = 1_800_000_000_000;
let database: ReturnType<typeof createCurrentDatabase>;
beforeEach(() => {
  database = createCurrentDatabase();
});
afterEach(() => database.sqlite.close());

describe("initial descriptions and fixed optional tags", () => {
  it.each(["stopwatch", "timer"] as const)(
    "retains %s start data through stop/reload/save and stable replay",
    async (mode) => {
      const { db, sqlite } = database;
      const input = {
        mode,
        ...(mode === "timer" ? { timerSeconds: 1 } : {}),
        clientRequestId: crypto.randomUUID(),
        description: "  最初の内容  ",
        tag: "work" as const,
      };
      const running = await startSession(db, input, NOW);
      expect(running).toMatchObject({
        draftDescription: "最初の内容",
        description: null,
        tag: "work",
      });
      expect(running).not.toHaveProperty("startTag");
      expect(await getCurrentSession(db, NOW + 1)).toEqual(running);
      expect(await startSession(db, { ...input, description: "最初の内容" }, NOW + 1)).toEqual(
        running,
      );
      for (const changed of [
        { description: "changed" },
        { tag: "hobby" as const },
        { tag: null },
      ]) {
        await expect(startSession(db, { ...input, ...changed }, NOW + 2)).rejects.toMatchObject({
          code: "conflict",
        });
      }
      const stopped =
        mode === "timer"
          ? await getCurrentSession(db, NOW + 1000)
          : await stopSession(db, running.id, NOW + 1000);
      expect(stopped).toMatchObject({
        status: "awaiting_description",
        draftDescription: "最初の内容",
        description: null,
        tag: "work",
      });
      const saved = await saveSession(
        db,
        running.id,
        "  追記した内容  ",
        NOW + 1001,
        "self_development",
      );
      expect(saved).toMatchObject({
        status: "saved",
        draftDescription: "最初の内容",
        description: "追記した内容",
        tag: "self_development",
      });
      expect(await startSession(db, input, NOW + 1002)).toEqual(saved);
      expect(
        await saveSession(db, running.id, "追記した内容", NOW + 1003, "self_development"),
      ).toEqual(saved);
      await expect(
        saveSession(db, running.id, "追記した内容", NOW + 1004, "work"),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await saveSession(db, running.id, "追記した内容", NOW + 1005)).toEqual(saved);
      const edited = await editSavedRecord(
        db,
        saved.id,
        {
          startedAtMs: saved.startedAtMs,
          endedAtMs: saved.endedAtMs ?? 0,
          description: "",
          expectedVersion: saved.version,
          tag: null,
        },
        NOW + 1006,
      );
      expect(edited).toMatchObject({
        description: "無題",
        tag: null,
        draftDescription: "最初の内容",
      });
      expect(await startSession(db, input, NOW + 1007)).toEqual(edited);
      expect(sqlite.prepare("SELECT start_tag FROM time_sessions").get()).toEqual({
        start_tag: "work",
      });
      expect(await listSavedRecords(db, NOW, NOW + 2000)).toEqual([edited]);
      await deleteSavedRecord(db, edited.id, edited.version);
      await expect(startSession(db, input, NOW + 1008)).rejects.toMatchObject({ code: "conflict" });
      expect(await listSavedRecords(db, NOW, NOW + 2000)).toEqual([]);
    },
  );

  it.each([undefined, "", " \t\n　"])(
    "allows empty initial content (%s) and old-client untagged saves",
    async (description) => {
      const { db } = database;
      const input = {
        mode: "stopwatch" as const,
        clientRequestId: crypto.randomUUID(),
        ...(description === undefined ? {} : { description }),
      };
      const session = await startSession(db, input, NOW);
      expect(session).toMatchObject({ description: null, draftDescription: null, tag: null });
      expect(await startSession(db, { ...input, description: "" }, NOW + 1)).toEqual(session);
      await stopSession(db, session.id, NOW + 1000);
      expect(await saveSession(db, session.id, "", NOW + 1001)).toMatchObject({
        description: "無題",
        tag: null,
      });
    },
  );

  it("preserves a start tag when a previous client saves without a tag field", async () => {
    const { db } = database;
    const running = await startSession(
      db,
      { mode: "stopwatch", clientRequestId: crypto.randomUUID(), tag: "housework" },
      NOW,
    );
    await stopSession(db, running.id, NOW + 1000);
    expect(await saveSession(db, running.id, "", NOW + 1001)).toMatchObject({
      description: "無題",
      tag: "housework",
    });
  });

  it("can clear the start tag at save and discard a tagged draft without listing it", async () => {
    const { db } = database;
    const input = {
      mode: "stopwatch" as const,
      clientRequestId: crypto.randomUUID(),
      description: "draft",
      tag: "housework" as const,
    };
    const running = await startSession(db, input, NOW);
    await stopSession(db, running.id, NOW + 1000);
    expect(await saveSession(db, running.id, "", NOW + 1001, null)).toMatchObject({
      description: "無題",
      tag: null,
    });
    const other = await startSession(
      db,
      { ...input, clientRequestId: crypto.randomUUID() },
      NOW + 2000,
    );
    await stopSession(db, other.id, NOW + 3000);
    expect(await discardSession(db, other.id, NOW + 3001)).toMatchObject({ status: "discarded" });
    expect((await listSavedRecords(db, NOW, NOW + 4000)).map(({ id }) => id)).toEqual([running.id]);
  });

  it.each(TIME_TAGS)(
    "manually creates, preserves, changes and clears $id with optimistic versions",
    async ({ id: tag }) => {
      const { db } = database;
      const input = {
        startedAtMs: NOW,
        endedAtMs: NOW + 1000,
        description: "",
        clientRequestId: crypto.randomUUID(),
        tag,
      };
      const saved = await createManualRecord(db, input, NOW);
      expect(saved).toMatchObject({ description: "無題", draftDescription: null, tag });
      expect(saved).not.toHaveProperty("startTag");
      expect(await createManualRecord(db, input, NOW + 1)).toEqual(saved);
      await expect(createManualRecord(db, { ...input, tag: null }, NOW + 2)).rejects.toMatchObject({
        code: "conflict",
      });
      const edit = {
        startedAtMs: NOW,
        endedAtMs: NOW + 1000,
        description: "edit",
        expectedVersion: saved.version,
      };
      const preserved = await editSavedRecord(db, saved.id, edit, NOW + 3);
      expect(preserved.tag).toBe(tag);
      await expect(
        editSavedRecord(db, saved.id, { ...edit, tag: null }, NOW + 4),
      ).rejects.toMatchObject({ code: "conflict" });
      const changed = await editSavedRecord(
        db,
        saved.id,
        { ...edit, tag: "chores", expectedVersion: preserved.version },
        NOW + 5,
      );
      expect(changed.tag).toBe("chores");
      const cleared = await editSavedRecord(
        db,
        saved.id,
        { ...edit, tag: null, expectedVersion: changed.version },
        NOW + 6,
      );
      expect(cleared.tag).toBeNull();
      await deleteSavedRecord(db, saved.id, cleared.version);
      await expect(createManualRecord(db, input, NOW + 7)).rejects.toMatchObject({
        code: "conflict",
      });
    },
  );

  it("validates direct repository input and never lets request-ID collisions mix manual/measured data", async () => {
    const { db } = database;
    const clientRequestId = crypto.randomUUID();
    const start = { mode: "stopwatch" as const, clientRequestId };
    for (const description of [null, 123, "a".repeat(501)]) {
      await expect(
        startSession(db, { ...start, description: description as string }, NOW),
      ).rejects.toMatchObject({ code: "validation" });
    }
    const invalidTag = "unknown" as TimeTag;
    await expect(startSession(db, { ...start, tag: invalidTag }, NOW)).rejects.toMatchObject({
      code: "validation",
    });
    const session = await startSession(db, { ...start, description: "x".repeat(500) }, NOW);
    const manual = { startedAtMs: NOW, endedAtMs: NOW + 1000, description: "", clientRequestId };
    await expect(createManualRecord(db, manual, NOW)).rejects.toMatchObject({ code: "conflict" });
    await stopSession(db, session.id, NOW + 1000);
    await expect(saveSession(db, session.id, "", NOW + 1001, invalidTag)).rejects.toMatchObject({
      code: "validation",
    });
    const saved = await saveSession(db, session.id, "", NOW + 1002);
    await expect(
      editSavedRecord(
        db,
        session.id,
        { ...manual, tag: invalidTag, expectedVersion: saved.version },
        NOW + 1003,
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      createManualRecord(
        db,
        { ...manual, clientRequestId: crypto.randomUUID(), tag: invalidTag },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("accepts one of simultaneous differing-payload starts and rejects the other", async () => {
    const { db } = database;
    const input = { mode: "stopwatch" as const, clientRequestId: crypto.randomUUID() };
    const results = await Promise.allSettled([
      startSession(db, { ...input, description: "a", tag: "work" }, NOW),
      startSession(db, { ...input, description: "b", tag: "hobby" }, NOW),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });
});
