/**
 * One-shot migration: legacy ~/.config/opencode/brain/memory.md -> brain.db facts.
 * Usage: node dist/scripts/migrate-memory.js [memory.md path] [db path]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Brain } from "../src/index.js";
import type { FactCategory } from "../src/types.js";

const memoryPath =
  process.argv[2] ?? join(homedir(), ".config", "opencode", "brain", "memory.md");
const dbPath =
  process.argv[3] ?? join(homedir(), ".config", "opencode", "brain", "brain.db");

function guessCategory(text: string): FactCategory {
  const t = text.toLowerCase();
  if (/аккаунт|номер|пользовател|язык|account|user|тг|tg|@/.test(t)) return "user";
  if (/проект|репо|mcp|плагин|project|repo|конфиг|opencode/.test(t)) return "project";
  if (/секрет|токен|пароль|secret|token|600/.test(t)) return "environment";
  if (/предпочт|люблю|нравится|prefer|язык: русский/.test(t)) return "preference";
  return "other";
}

const raw = readFileSync(memoryPath, "utf-8");
const bullets = raw
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("- "))
  .map((l) => l.slice(2).trim())
  .filter((l) => l.length > 1);

const brain = Brain.open(dbPath);
let added = 0;
for (const b of bullets) {
  brain.rememberFact({ category: guessCategory(b), content: b, confidence: 0.8 });
  added++;
}
brain.close();
console.log(`Migrated ${added} facts from ${memoryPath} to ${dbPath}`);
