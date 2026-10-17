import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import * as legacy from "../../tests/fixtures/phase48/src/data/records";
import {
  type BaselineRow,
  discardedSession,
  manualRecord,
  openSessionScenarios,
  savedStopwatch,
  savedTimer,
  BASELINE_NOW_MS as NOW,
} from "../../tests/fixtures/toki-baseline";
import * as modern from "../data/records";

const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");

async function snapshot(db: D1Database) {
  return {
    rows: (await db.prepare("SELECT * FROM time_sessions ORDER BY id").all()).results,
    tombstones: (
      await db.prepare("SELECT * FROM deleted_client_request_ids ORDER BY client_request_id").all()
    ).results,
    migrations: (await db.prepare("SELECT * FROM d1_migrations ORDER BY id").all()).results,
    schema: (
      await db
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name",
        )
        .all()
    ).results,
  };
}

async function seed(db: D1Database, rows: readonly BaselineRow[]) {
  await db.prepare("DELETE FROM time_sessions").run();
  await db.prepare("DELETE FROM deleted_client_request_ids").run();
  for (const row of rows) {
    await db
      .prepare(`INSERT INTO time_sessions
      (id, client_request_id, mode, status, started_at_ms, timer_seconds, deadline_at_ms,
       ended_at_ms, description, version, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        row.id,
        row.client_request_id,
        row.mode,
        row.status,
        row.started_at_ms,
        row.timer_seconds,
        row.deadline_at_ms,
        row.ended_at_ms,
        row.description,
        row.version,
        row.created_at_ms,
        row.updated_at_ms,
      )
      .run();
  }
  await db
    .prepare("INSERT INTO deleted_client_request_ids VALUES (?)")
    .bind("30000000-0000-4000-8000-000000000001")
    .run();
}

it("privately exports/restores local D1 and rolls back source without losing any of four open states", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const directory = await mkdtemp(resolve(".tmp/phase55-private-rehearsal-"));
  await chmod(directory, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "TOKI_D1_DATABASE_ID",
    "ALLOWED_EMAIL",
    "TEAM_DOMAIN",
    "POLICY_AUD",
    "CLOUDFLARE_ENV",
  ])
    delete env[key];
  const cli = (args: string[]) =>
    promisify(execFile)(process.execPath, [wrangler, ...args], {
      cwd: directory,
      env,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  const config = resolve(directory, "wrangler.json");
  await writeFile(
    config,
    JSON.stringify({
      name: "toki-restore-local",
      compatibility_date: "2026-08-15",
      workers_dev: false,
      preview_urls: false,
      d1_databases: [
        {
          binding: "DB",
          database_name: "toki-restore-local",
          remote: false,
          migrations_dir: resolve("migrations"),
        },
      ],
    }),
    { flag: "wx", mode: 0o600 },
  );
  // Wrangler 4.124's local export has no --persist-to option: use this isolated
  // config directory's default state path for the source, never the repository DB.
  const sourceState = resolve(directory, ".wrangler/state");
  let source: PlatformProxy<{ DB: D1Database }> | undefined;
  let restored: PlatformProxy<{ DB: D1Database }> | undefined;
  try {
    await cli([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      config,
      "--local",
      "--persist-to",
      sourceState,
    ]);
    source = await getPlatformProxy<{ DB: D1Database }>({
      configPath: config,
      envFiles: [],
      remoteBindings: false,
      persist: { path: resolve(sourceState, "v3") },
    });
    for (const [index, open] of openSessionScenarios.entries()) {
      await seed(source.env.DB, [savedStopwatch, savedTimer, manualRecord, discardedSession, open]);
      const before = await snapshot(source.env.DB);
      await source.dispose();
      source = undefined;
      const backup = resolve(directory, `synthetic-${index}.sql`);
      await cli(["d1", "export", "DB", "--config", config, "--local", "--output", backup]);
      await chmod(backup, 0o600);
      const status = await lstat(backup);
      expect(status.isFile() && !status.isSymbolicLink()).toBe(true);
      expect(status.mode & 0o777).toBe(0o600);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      const hash = createHash("sha256")
        .update(await readFile(backup))
        .digest("hex");
      expect(hash).toMatch(/^[0-9a-f]{64}$/u);

      const target = resolve(directory, `empty-restore-${index}`);
      // Import a full export into an EMPTY local D1; no migrations or remote restore are applied.
      await cli([
        "d1",
        "execute",
        "DB",
        "--config",
        config,
        "--local",
        "--persist-to",
        target,
        "--file",
        backup,
      ]);
      restored = await getPlatformProxy<{ DB: D1Database }>({
        configPath: config,
        envFiles: [],
        remoteBindings: false,
        persist: { path: resolve(target, "v3") },
      });
      const db = restored.env.DB;
      expect(await snapshot(db)).toEqual(before);
      expect((await db.prepare("PRAGMA quick_check").all()).results).toEqual([
        { quick_check: "ok" },
      ]);
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

      // New writes, then an old-source rollback, all against the SAME restored schema.
      expect(await modern.getCurrentSession(db, NOW)).toEqual(
        await legacy.getCurrentSession(db, NOW),
      );
      const edited = await modern.editSavedRecord(
        db,
        savedStopwatch.id,
        {
          startedAtMs: savedStopwatch.started_at_ms,
          endedAtMs: savedStopwatch.ended_at_ms ?? NOW,
          description: "新版で変更・旧版で継続",
          expectedVersion: savedStopwatch.version,
        },
        NOW,
      );
      expect(await legacy.getSession(db, edited.id, NOW)).toEqual(edited);
      const stopped = await legacy.stopSession(db, open.id, NOW + 2_000);
      const saved = await legacy.saveSession(db, stopped.id, "", NOW + 2_001);
      expect(saved.description).toBe("無題");
      expect(await modern.getSession(db, saved.id, NOW + 2_002)).toEqual(saved);
      await legacy.deleteSavedRecord(db, edited.id, edited.version);
      await expect(
        modern.startSession(
          db,
          {
            mode: "stopwatch",
            clientRequestId: savedStopwatch.client_request_id,
          },
          NOW + 3_000,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM deleted_client_request_ids")
            .first<{ n: number }>()
        )?.n,
      ).toBe(2);
      await restored.dispose();
      restored = undefined;
      source = await getPlatformProxy<{ DB: D1Database }>({
        configPath: config,
        envFiles: [],
        remoteBindings: false,
        persist: { path: resolve(sourceState, "v3") },
      });
      expect(await snapshot(source.env.DB)).toEqual(before);
    }
  } finally {
    await source?.dispose();
    await restored?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
