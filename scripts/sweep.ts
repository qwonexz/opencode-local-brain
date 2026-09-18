#!/usr/bin/env node
/**
 * Sweep fallback: finds sessions missing from L1 episodes and runs the
 * writer for each. Triggered by systemd timer (every 30 min) and covers
 * sessions the plugin hook missed (crash, --pure mode, old sessions).
 *
 * Skips: "brain-writer:" sessions, sessions updated <10 min ago (active),
 * sessions already logged AND unchanged since logging is handled by upsert
 * (writer re-runs only when session updated after the episode was written).
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Brain } from "../src/index.js";

const BRAIN_DIR = join(homedir(), ".config", "opencode", "brain");
const OPENCODE_BIN = join(homedir(), ".opencode", "bin", "opencode");
const DB_PATH = process.env.BRAIN_DB ?? join(BRAIN_DIR, "brain.db");
const LOG_PATH = join(BRAIN_DIR, "writer.log");
const WRITER_JS = join(homedir(), "Projects", "opencode-local-brain", "dist", "scripts", "writer.js");
const ACTIVE_GRACE_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 30;

function log(msg: string): void {
  mkdirSync(BRAIN_DIR, { recursive: true });
  appendFileSync(LOG_PATH, `${new Date().toISOString()} [sweep] ${msg}\n`);
}

interface ListedSession {
  id?: string;
  title?: string;
  updated?: number;
}

function main(): void {
  const raw = execFileSync(OPENCODE_BIN, ["session", "list", "--format", "json", "-n", String(MAX_SESSIONS)], {
    encoding: "utf-8",
    cwd: homedir(),
    timeout: 60_000,
  });
  const sessions = JSON.parse(raw) as ListedSession[];
  const now = Date.now();
  const brain = Brain.open(DB_PATH);
  let freshness: Map<string, number>;
  try {
    freshness = brain.episodeFreshness();
  } finally {
    brain.close();
  }

  let queued = 0;
  for (const s of sessions) {
    if (typeof s.id !== "string" || !/^ses_[A-Za-z0-9]{1,64}$/.test(s.id)) continue;
    if ((s.title ?? "").startsWith("brain-writer:")) continue;
    if (typeof s.updated === "number" && now - s.updated < ACTIVE_GRACE_MS) continue;
    const loggedAt = freshness.get(s.id);
    if (loggedAt !== undefined) {
      // Known session: re-run the writer only if the session changed after logging.
      // Unit normalization: opencode `updated` is ms, but tolerate seconds.
      const updatedMs =
        typeof s.updated === "number" ? (s.updated < 1e12 ? s.updated * 1000 : s.updated) : NaN;
      if (!Number.isFinite(updatedMs) || updatedMs <= loggedAt) continue;
      log(`re-queue stale episode for ${s.id}`);
    }
    try {
      const child = spawn("node", [WRITER_JS, s.id], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, BRAIN_DB: DB_PATH },
      });
      child.unref();
      queued++;
      log(`queued writer for ${s.id} (${(s.title ?? "").slice(0, 60)})`);
    } catch (err) {
      log(`failed to queue ${s.id}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    }
  }
  log(`sweep done, queued=${queued}`);
}

try {
  main();
} catch (err) {
  try {
    log(`FATAL: ${err instanceof Error ? err.message.slice(0, 300) : "error"}`);
  } catch {
    // never throw from logger
  }
  process.exitCode = 1;
}
