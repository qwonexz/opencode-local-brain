import type Database from "better-sqlite3";
import { checkpoint, openDatabase } from "./db.js";
import {
  LIMITS,
  MAX_REINFORCEMENTS,
  clampLimit,
  isFactCategory,
  normalizeContent,
  parseConfidence,
  requireId,
  requireText,
  type Fact,
  type FactCategory,
  type NewEpisode,
  type NewFact,
  type NewRule,
  type RecallHit,
  type Rule,
} from "./types.js";

export const INJECTION_BUDGET_TOKENS = 3750;

/**
 * Rough token estimate. ASCII ~4 chars/token; Cyrillic/CJK/emoji carry
 * more tokens per char, so they are weighted ~2.5x. Over-estimating keeps
 * the injection snapshot inside the real model budget.
 */
export function estimateTokens(text: string): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    units += code <= 0x7f ? 1 : 2.5;
  }
  return Math.ceil(units / 4);
}

/** Optional ISO-8601-ish timestamp (≤64 chars) or null. Rejects garbage. */
function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const clean = value.trim().slice(0, 64);
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)?$/.test(clean)) {
    throw new Error(`${field} must be an ISO-8601 date string`);
  }
  return clean;
}

/** Slice by code points — never splits surrogate pairs / graphemes. */
export function sliceCodePoints(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join("");
}

/** Convert free text into a safe FTS5 MATCH query (AND of quoted phrases). */
export function toFtsQuery(query: string): string {
  const terms = query
    .normalize("NFKC")
    .split(/[\s"()*^:]+/)
    .flatMap((t) => t.split(/[^\p{L}\p{N}_+-]+/u))
    .map((t) => t.replace(/^[+-]+/, "").trim().slice(0, 64))
    .filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t))
    // Drop 1-char noise, except CJK-ish scripts where 1 char is meaningful.
    .filter((t) => t.length >= 2 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(t))
    .slice(0, 20);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

const FACT_COLUMNS = `id, category, content, confidence,
  source_episode_id AS sourceEpisodeId, reinforcements,
  created_at AS createdAt, updated_at AS updatedAt`;

// Ranking weights: FTS5 rank is NEGATIVE (lower = better). Weights scale the
// magnitude, so rules (few, precious) sink to the top and verbose episodes
// float down: rule 1.3 (more negative), fact 1.0, episode 0.7.
const KIND_WEIGHT: Record<RecallHit["kind"], number> = {
  rule: 1.3,
  fact: 1.0,
  episode: 0.7,
};

const TABLES = { fact: "facts", rule: "rules", episode: "episodes" } as const;
export type MemoryKind = keyof typeof TABLES;

export class Brain {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(dbPath: string): Brain {
    return new Brain(openDatabase(dbPath));
  }

  close(): void {
    try {
      checkpoint(this.db);
    } finally {
      this.db.close();
    }
  }

  // ---- L1: episodes ----
  // NOTE: deleting an episode sets facts.source_episode_id to NULL
  // (ON DELETE SET NULL) — facts survive, provenance is dropped.

  logEpisode(input: NewEpisode): number {
    const sessionId = requireText(input.sessionId, "sessionId", LIMITS.sessionId);
    const summary = requireText(input.summary, "summary", LIMITS.summary);
    const startedAt = optionalDate(input.startedAt, "startedAt");
    const endedAt = optionalDate(input.endedAt, "endedAt");
    const decisions =
      input.decisions === undefined ? null : requireText(input.decisions, "decisions", LIMITS.decisions);
    const outcome =
      input.outcome === undefined ? null : requireText(input.outcome, "outcome", LIMITS.outcome);
    try {
      const info = this.db
        .prepare(
          `INSERT INTO episodes (session_id, started_at, ended_at, summary, decisions, outcome)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(sessionId, startedAt, endedAt, summary, decisions, outcome);
      return Number(info.lastInsertRowid);
    } catch (err) {
      if (
        err instanceof Error &&
        (err as Error & { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        throw new Error(`Episode for session '${sessionId}' already exists`);
      }
      throw err;
    }
  }

  recentEpisodes(limit = 5): { id: number; sessionId: string; summary: string }[] {
    const n = clampLimit(limit, 5, 1, 50);
    return this.db
      .prepare("SELECT id, session_id AS sessionId, summary FROM episodes ORDER BY id DESC LIMIT ?")
      .all(n) as { id: number; sessionId: string; summary: string }[];
  }

  // ---- L2: facts ----
  // Dedup is by normalized content (NFKC + lowercase + collapsed space),
  // so trivial variants ("X" vs "x", double spaces) merge instead of duplicating.
  // Re-remembering moves confidence halfway toward the new value (no max-spam)
  // and saturates the reinforcement counter.

  rememberFact(input: NewFact): Fact {
    if (!isFactCategory(input.category)) {
      throw new Error(`Unknown fact category: '${String(input.category)}'`);
    }
    const content = requireText(input.content, "content", LIMITS.factContent);
    const confidence = parseConfidence(input.confidence, 0.5);
    const norm = normalizeContent(content);

    const info = this.db
      .prepare(
        `INSERT INTO facts (category, content, content_norm, confidence, source_episode_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(content_norm) DO UPDATE SET
           content = excluded.content,
           confidence = min(1.0, max(0.0, confidence + (excluded.confidence - confidence) * 0.5)),
           reinforcements = min(reinforcements + 1, ${MAX_REINFORCEMENTS}),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      )
      .run(
        input.category as FactCategory,
        content,
        norm,
        confidence,
        input.sourceEpisodeId === undefined ? null : requireId(input.sourceEpisodeId, "sourceEpisodeId")
      );
    // Merge path (row existed): lastInsertRowid is stale, look up by norm.
    // Insert path: lastInsertRowid is the new id.
    const row = this.db.prepare(`SELECT ${FACT_COLUMNS} FROM facts WHERE content_norm = ?`).get(
      norm
    ) as Fact | undefined;
    if (row === undefined) throw new Error("Failed to store fact");
    void info;
    return row;
  }

  getFact(id: number): Fact | undefined {
    const row = this.db.prepare(`SELECT ${FACT_COLUMNS} FROM facts WHERE id = ?`).get(requireId(id, "id"));
    return row as Fact | undefined;
  }

  topFacts(limit = 30): Fact[] {
    const n = clampLimit(limit, 30, 1, 200);
    return this.db
      .prepare(
        `SELECT ${FACT_COLUMNS} FROM facts ORDER BY confidence DESC, reinforcements DESC, id DESC LIMIT ?`
      )
      .all(n) as Fact[];
  }

  // ---- L3: rules ----

  addRule(input: NewRule): number {
    const title = requireText(input.title, "title", LIMITS.ruleTitle);
    const mistake = requireText(input.mistake, "mistake", LIMITS.ruleMistake);
    const rule = requireText(input.rule, "rule", LIMITS.ruleText);
    const cause = input.cause === undefined ? null : requireText(input.cause, "cause", LIMITS.ruleCause);
    const triggers =
      input.triggers === undefined ? null : requireText(input.triggers, "triggers", LIMITS.ruleTriggers);
    const info = this.db
      .prepare(
        "INSERT INTO rules (title, mistake, cause, rule, triggers, confirmed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(title, mistake, cause, rule, triggers, input.confirmed === true ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  confirmRule(id: number): boolean {
    const info = this.db.prepare("UPDATE rules SET confirmed = 1 WHERE id = ?").run(requireId(id, "id"));
    return info.changes > 0;
  }

  confirmedRules(limit = 50): Rule[] {
    const n = clampLimit(limit, 50, 1, 200);
    const rows = this.db
      .prepare(
        `SELECT id, title, mistake, cause, rule, triggers,
         confirmed, created_at AS createdAt FROM rules WHERE confirmed = 1 ORDER BY id DESC LIMIT ?`
      )
      .all(n) as (Omit<Rule, "confirmed"> & { confirmed: number })[];
    return rows.map((r) => ({ ...r, confirmed: r.confirmed === 1 }));
  }

  // ---- recall (FTS5 across all levels) ----

  recall(query: string, limit = 8): RecallHit[] {
    const fts = toFtsQuery(query);
    if (fts.length === 0) return [];
    const n = clampLimit(limit, 8, 1, 50);
    // One query per table (each LIMIT n): weighting happens in JS AFTER
    // retrieval, so a rule can never be cut off by a raw cross-table LIMIT.
    const factRows = this.db
      .prepare(
        `SELECT 'fact' AS kind, f.id AS id, ('[' || f.category || '] ' || substr(f.content, 1, 80)) AS title,
                snippet(facts_fts, 0, '[[', ']]', '…', 24) AS snippet, bm25(facts_fts) AS rank
         FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(fts, n) as RecallHit[];
    const ruleRows = this.db
      .prepare(
        `SELECT 'rule' AS kind, r.id AS id, r.title AS title,
                snippet(rules_fts, -1, '[[', ']]', '…', 24) AS snippet, bm25(rules_fts) AS rank
         FROM rules_fts JOIN rules r ON r.id = rules_fts.rowid WHERE rules_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(fts, n) as RecallHit[];
    const episodeRows = this.db
      .prepare(
        `SELECT 'episode' AS kind, e.id AS id, ('session ' || e.session_id) AS title,
                snippet(episodes_fts, -1, '[[', ']]', '…', 24) AS snippet, bm25(episodes_fts) AS rank
         FROM episodes_fts JOIN episodes e ON e.id = episodes_fts.rowid WHERE episodes_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(fts, n) as RecallHit[];
    return [...factRows, ...ruleRows, ...episodeRows]
      .map((r) => ({ ...r, rank: r.rank * KIND_WEIGHT[r.kind] }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, n);
  }

  // ---- forget ----

  forget(kind: MemoryKind, id: number): boolean {
    const table = TABLES[kind];
    if (table === undefined) {
      throw new Error(`Unknown memory kind: '${String(kind)}'`);
    }
    const info = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(requireId(id, "id"));
    return info.changes > 0;
  }

  // ---- injection snapshot (budgeted, 3.5-4k tokens) ----
  // Priority: confirmed rules > facts > recent episodes. Stops mid-list
  // when the budget is exhausted; never exceeds maxTokens.

  snapshot(maxTokens = INJECTION_BUDGET_TOKENS): string {
    if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens < 50) {
      throw new Error("maxTokens must be a finite number >= 50");
    }
    // 15% safety margin: estimateTokens is heuristic, real BPE tokenizers
    // (esp. on Cyrillic/CJK/emoji) may count higher.
    const budget = Math.floor(maxTokens * 0.85);
    const blocks: string[] = [];
    let used = 0;
    // Account for the exact "\n\n" separators join() will insert.
    const pushBlock = (block: string): boolean => {
      const sep = blocks.length === 0 ? 0 : estimateTokens("\n\n");
      const cost = estimateTokens(block) + sep;
      if (used + cost > budget) return false;
      blocks.push(block);
      used += cost;
      return true;
    };

    const ruleLines = this.confirmedRules().map((r) => `- [${r.title}] ${r.rule}`);
    if (ruleLines.length > 0) {
      pushBlock(`## Правила (не нарушать)\n${ruleLines.join("\n")}`);
    }

    // Facts: rebuild the candidate block each iteration (n ≤ 40, cheap)
    // so the budget check sees the EXACT final string incl. separators.
    const factLines: string[] = [];
    const factsSep = blocks.length === 0 ? 0 : estimateTokens("\n\n");
    for (const f of this.topFacts(40)) {
      // Line-level guard: never budget unbounded text.
      const line = sliceCodePoints(`- [${f.category}] ${f.content}`, 300);
      const candidate = `## Факты\n${[...factLines, line].join("\n")}`;
      if (used + factsSep + estimateTokens(candidate) > budget) break;
      factLines.push(line);
    }
    if (factLines.length > 0) {
      const block = `## Факты\n${factLines.join("\n")}`;
      blocks.push(block);
      used += factsSep + estimateTokens(block);
    }

    for (const e of this.recentEpisodes(3)) {
      const block = `## Прошлая сессия ${sliceCodePoints(e.sessionId, 64)}\n${sliceCodePoints(e.summary, 600)}`;
      if (!pushBlock(block)) break;
    }
    return blocks.join("\n\n");
  }
}

export type { Database };
export * from "./types.js";
