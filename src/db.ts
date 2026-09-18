import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_VERSION } from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  started_at TEXT,
  ended_at TEXT,
  summary TEXT NOT NULL,
  decisions TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  summary, decisions, outcome,
  content='episodes', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, summary, decisions, outcome)
  VALUES (new.id, new.summary, COALESCE(new.decisions, ''), COALESCE(new.outcome, ''));
END;

CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, summary, decisions, outcome)
  VALUES ('delete', old.id, old.summary, COALESCE(old.decisions, ''), COALESCE(old.outcome, ''));
END;

CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE OF summary, decisions, outcome ON episodes
WHEN old.summary IS NOT new.summary OR old.decisions IS NOT new.decisions OR old.outcome IS NOT new.outcome
BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, summary, decisions, outcome)
  VALUES ('delete', old.id, old.summary, COALESCE(old.decisions, ''), COALESCE(old.outcome, ''));
  INSERT INTO episodes_fts(rowid, summary, decisions, outcome)
  VALUES (new.id, new.summary, COALESCE(new.decisions, ''), COALESCE(new.outcome, ''));
END;

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  content_norm TEXT NOT NULL UNIQUE,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_episode_id INTEGER REFERENCES episodes(id) ON DELETE SET NULL,
  reinforcements INTEGER NOT NULL DEFAULT 1,
  embedding BLOB, -- reserved for Phase 4 (sqlite-vec)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  content,
  content='facts', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts
WHEN old.content IS NOT new.content
BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  mistake TEXT NOT NULL,
  cause TEXT,
  rule TEXT NOT NULL,
  triggers TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS rules_fts USING fts5(
  title, mistake, rule, triggers,
  content='rules', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS rules_ai AFTER INSERT ON rules BEGIN
  INSERT INTO rules_fts(rowid, title, mistake, rule, triggers)
  VALUES (new.id, new.title, new.mistake, new.rule, COALESCE(new.triggers, ''));
END;

CREATE TRIGGER IF NOT EXISTS rules_ad AFTER DELETE ON rules BEGIN
  INSERT INTO rules_fts(rules_fts, rowid, title, mistake, rule, triggers)
  VALUES ('delete', old.id, old.title, old.mistake, old.rule, COALESCE(old.triggers, ''));
END;

CREATE TRIGGER IF NOT EXISTS rules_au AFTER UPDATE OF title, mistake, rule, triggers ON rules
WHEN old.title IS NOT new.title OR old.mistake IS NOT new.mistake
  OR old.rule IS NOT new.rule OR old.triggers IS NOT new.triggers
BEGIN
  INSERT INTO rules_fts(rules_fts, rowid, title, mistake, rule, triggers)
  VALUES ('delete', old.id, old.title, old.mistake, old.rule, COALESCE(old.triggers, ''));
  INSERT INTO rules_fts(rowid, title, mistake, rule, triggers)
  VALUES (new.id, new.title, new.mistake, new.rule, COALESCE(new.triggers, ''));
END;
`;

export function openDatabase(dbPath: string): Database.Database {
  if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
    throw new Error("dbPath must be a non-empty string");
  }
  const inMemory = dbPath === ":memory:";
  const resolved = inMemory ? dbPath : resolve(dbPath);
  if (!inMemory) {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  // Lightweight migration: episodes.updated_at added after v1 schema.
  const cols = db.prepare("PRAGMA table_info(episodes)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "updated_at")) {
    db.exec(
      "ALTER TABLE episodes ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
    );
  }

  // Atomic version init (safe under concurrent openers).
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (row === undefined) {
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(SCHEMA_VERSION)
      );
    } else if (row.value !== String(SCHEMA_VERSION)) {
      throw new Error(
        `Unsupported brain schema version: '${row.value}' (code supports ${SCHEMA_VERSION}). ` +
          `Migrate or delete the database file.`
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors after a failed BEGIN
    }
    db.close();
    throw err;
  }
  return db;
}

/** Flush WAL to the main db file. Best-effort: reports busy/locked, never throws. */
export function checkpoint(db: Database.Database): { status: string } {
  try {
    // better-sqlite3 returns an object for single-row pragmas, array otherwise.
    const res = db.pragma("wal_checkpoint(TRUNCATE)") as
      | { busy: number }
      | { busy: number }[];
    const row = Array.isArray(res) ? res[0] : res;
    if (row === undefined) return { status: "ok" };
    if (row?.busy !== 0) return { status: "busy" };
    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}
