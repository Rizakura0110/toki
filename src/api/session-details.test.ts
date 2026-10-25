import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCurrentDatabase } from "../../tests/fixtures/local-database";
import { handleApiRequest } from "./router";

const ORIGIN = "http://127.0.0.1:8787";
let database: ReturnType<typeof createCurrentDatabase>;
function call(path: string, method = "GET", body?: unknown) {
  return handleApiRequest(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Toki-Client": "web" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { DB: database.db, LOCAL_AUTH_BYPASS: "enabled" },
  );
}
beforeEach(() => {
  database = createCurrentDatabase();
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
});
afterEach(() => {
  database.sqlite.close();
  vi.restoreAllMocks();
});

describe("session details HTTP contracts", () => {
  it("passes drafts and tags through start, stop, save, list and edit without exposing private startTag", async () => {
    const clientRequestId = crypto.randomUUID();
    const response = await call("/api/v1/session", "POST", {
      mode: "stopwatch",
      clientRequestId,
      description: "  事前入力  ",
      tag: "work",
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    const current = await (await call("/api/v1/session")).json();
    expect(current).toMatchObject({
      session: { description: null, draftDescription: "事前入力", tag: "work" },
    });
    expect(JSON.stringify(current)).not.toContain("startTag");
    expect((await call(`/api/v1/session/${session.id}/stop`, "POST", {})).status).toBe(200);
    const saved = await call(`/api/v1/session/${session.id}/save`, "POST", {
      description: "追記",
      tag: "hobby",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      session: { description: "追記", draftDescription: "事前入力", tag: "hobby", version: 3 },
    });
    expect(
      (
        await call(`/api/v1/session/${session.id}/save`, "POST", {
          description: "追記",
          tag: "work",
        })
      ).status,
    ).toBe(409);
    const recordInput = {
      startedAtMs: 1_800_000_000_000,
      endedAtMs: 1_800_000_001_000,
      description: "",
      expectedVersion: 3,
    };
    expect((await call(`/api/v1/records/${session.id}`, "PATCH", recordInput)).status).toBe(200);
    const cleared = await call(`/api/v1/records/${session.id}`, "PATCH", {
      ...recordInput,
      expectedVersion: 4,
      tag: null,
    });
    expect(await cleared.json()).toMatchObject({
      record: { description: "無題", tag: null, version: 5 },
    });
    const listed = await (
      await call("/api/v1/records?startMs=1800000000000&endMs=1800000002000")
    ).json();
    expect(listed).toMatchObject({ records: [{ id: session.id, tag: null }] });
    expect(JSON.stringify(listed)).not.toContain("startTag");
    const manual = await call("/api/v1/records", "POST", {
      ...recordInput,
      expectedVersion: undefined,
      clientRequestId: crypto.randomUUID(),
      tag: "chores",
    });
    expect(manual.status).toBe(201);
    expect(await manual.json()).toMatchObject({
      record: { description: "無題", draftDescription: null, tag: "chores" },
    });
  });

  it("rejects unapproved or multiple tags before any database writes", async () => {
    const prepare = vi.spyOn(database.db, "prepare");
    for (const tag of ["other", ["work", "hobby"], { tag: "work" }]) {
      const response = await call("/api/v1/session", "POST", {
        mode: "timer",
        timerSeconds: 1,
        clientRequestId: crypto.randomUUID(),
        tag,
      });
      expect(response.status).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
  });
});
