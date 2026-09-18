/**
 * One-shot migration: legacy ~/.config/opencode/brain/memory.md -> brain.db facts.
 * Secrets are NEVER imported (skip-list below). Safe to re-run: existing facts
 * merge via upsert instead of duplicating.
 * Usage: node dist/scripts/migrate-memory.js [memory.md path] [db path]
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Brain } from "../src/index.js";
import type { FactCategory } from "../src/types.js";

const MAX_MEMORY_FILE_BYTES = 1_000_000;

// Lines matching any of these are secrets/credentials — skipped with a warning.
const SECRET_PATTERNS = [
  /api[_-]?hash/i,
  /api[_-]?id/i,
  /bot[_-]?token/i,
  /ghp_[A-Za-z0-9]+/,
  /:+[A-Za-z0-9_-]{20,}/, // token-like "id:SECRET"
  /пароль/i,
  /секрет/i,
  /password/i,
  /secret/i,
  /токен/i,
];

const memoryPath = resolve(process.argv[2] ?? join(homedir(), ".config", "opencode", "brain", "memory.md"));
const dbPath = resolve(process.argv[3] ?? join(homedir(), ".config", "opencode", "brain", "brain.db"));

function isSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function guessCategory(text: string): FactCategory {
  const t = text.toLowerCase();
  if (/предпочт|люблю|нравится|prefer|язык:/.test(t)) return "preference";
  if (/(^|\s)@[\w_]+/.test(t) || /аккаунт|account|пользовател/.test(t)) return "user";
  if (/проект|репо|mcp|плагин|project|repo|конфиг|opencode|номер/.test(t)) return "project";
  return "other";
}

const stat = statSync(memoryPath);
if (!stat.isFile()) throw new Error(`Not a file: ${memoryPath}`);
if (stat.size > MAX_MEMORY_FILE_BYTES) {
  throw new Error(`memory.md too large (${stat.size} bytes, limit ${MAX_MEMORY_FILE_BYTES})`);
}

const raw = readFileSync(memoryPath, "utf-8");
const bullets = raw
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("- "))
  .map((l) => l.slice(2).trim())
  .filter((l) => l.length > 1);

const brain = Brain.open(dbPath);
try {
  let added = 0;
  let skipped = 0;
  for (const b of bullets) {
    if (isSecret(b)) {
      skipped++;
      console.warn(`[migrate] skipped secret-like line: ${b.slice(0, 40)}…`);
      continue;
    }
    brain.rememberFact({ category: guessCategory(b), content: b, confidence: 0.8 });
    added++;
  }
  console.log(`Migrated ${added} facts (${skipped} secret-like lines skipped) to ${dbPath}`);
} finally {
  brain.close();
}
