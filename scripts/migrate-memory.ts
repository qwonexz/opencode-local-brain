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
import { sliceCodePoints } from "../src/index.js";
import type { FactCategory } from "../src/types.js";

const MAX_MEMORY_FILE_BYTES = 1_000_000;

// Lines matching any of these are secrets/credentials — skipped with a warning.
// NOTE: blocklist, not allowlist — it reduces accidents but cannot catch
// every obfuscation (leet-speak, split tokens, raw base64). Never migrate
// files you haven't eyeballed.
const SECRET_PATTERNS = [
  /api[\s_-]*hash/i,
  /api[\s_-]*id/i,
  /bot[\s_-]*token/i,
  /access[\s_-]*token/i,
  /private[\s_-]*key/i,
  /mnemonic|seed[\s_-]*phrase/i,
  /passwd|pwd|passwords?/i,
  /secrets?/i,
  /токены?/i,
  /секреты?/i,
  /пароли?/i,
  /ghp_[A-Za-z0-9]+/,
  /gho_[A-Za-z0-9]+/,
  /:+[A-Za-z0-9_-]{20,}/, // token-like "id:SECRET"
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
  let truncated = 0;
  bullets.forEach((b, i) => {
    try {
      if (isSecret(b)) {
        skipped++;
        // Never print secret content — index only.
        console.warn(`[migrate] skipped secret-like line #${i}`);
        return;
      }
      let content = b;
      if (content.length > 7900) {
        content = `${sliceCodePoints(content, 7900)}…`;
        truncated++;
      }
      brain.rememberFact({ category: guessCategory(content), content, confidence: 0.8 });
      added++;
    } catch (err) {
      skipped++;
      console.warn(`[migrate] skipped line #${i}: ${err instanceof Error ? err.message : "error"}`);
    }
  });
  console.log(
    `Migrated ${added} facts (${skipped} skipped, ${truncated} truncated) to ${dbPath}`
  );
} finally {
  brain.close();
}
