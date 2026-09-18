import type Database from "better-sqlite3";
import { openDatabase } from "./db.js";
import {
  clampConfidence,
  isFactCategory,
  type Fact,
  type FactCategory,
  type NewEpisode,
  type NewFact,
  type NewRule,
  type RecallHit,
  type Rule,
} from "./types.js";

export const INJECTION_BUDGET_TOKENS = 3750;

/** Convert free text into a safe FTS5 MATCH query (AND of quoted phrases). */
export function toFtsQuery(query: string): string {
  const terms = query
    .split(/[\s"()*^:]+/)
    .map((t) => t.replace(/[^0-9A-Za-zА-Яа-яЁё_+-]+/g, " ").trim())
    .flatMap((t) => t.split(/\s+/))
    .filter((t) => t.length > 0)
    .slice(0, 20);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must not be empty`);
  return trimmed;
}

export class Brain {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(dbPath: string): Brain {
    return new Brain(openDatabase(dbPath));
  }

  close(): void {
    this.db.close();
  }

  // ---- L1: episodes ----

  logEpisode(input: NewEpisode): number {
    const sessionId = requireNonEmpty(input.sessionId, "sessionId");
    const summary = requireNonEmpty(input.summary, "summary");
    try {
      const info = this.db
        .prepare(
          `INSERT INTO episodes (session_id, started_at, ended_at, summary, decisions, outcome)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId,
          input.startedAt ?? null,
          input.endedAt ?? null,
          summary,
          input.decisions ?? null,
          input.outcome ?? null
        );
      return Number(info.lastInsertRowid);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        throw new Error(`Episode for session '${sessionId}' already exists`);
      }
      throw err;
    }
  }

  recentEpisodes(limit = 5): { id: number; sessionId: string; summary: string }[] {
    const n = Math.max(1, Math.min(50, Math.floor(limit)));
    return this.db
      .prepare("SELECT id, session_id AS sessionId, summary FROM episodes ORDER BY id DESC LIMIT ?")
      .all(n) as { id: number; sessionId: string; summary: string }[];
  }

  // ---- L2: facts ----

  rememberFact(input: NewFact): Fact {
    if (!isFactCategory(input.category)) {
      throw new Error(`Unknown fact category: '${input.category}'`);
    }
    const content = requireNonEmpty(input.content, "content");
    const confidence = clampConfidence(input.confidence ?? 0.5);

    const existing = this.db
      .prepare("SELECT * FROM facts WHERE content = ?")
      .get(content) as Fact | undefined;

    if (existing) {
      const merged = clampConfidence(Math.max(existing.confidence, confidence));
      this.db
        .prepare(
          `UPDATE facts SET confidence = ?, reinforcements = reinforcements + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
        )
        .run(merged, existing.id);
      return this.getFact(existing.id) as Fact;
    }

    const info = this.db
      .prepare(
        "INSERT INTO facts (category, content, confidence, source_episode_id) VALUES (?, ?, ?, ?)"
      )
      .run(input.category as FactCategory, content, confidence, input.sourceEpisodeId ?? null);
    return this.getFact(Number(info.lastInsertRowid)) as Fact;
  }

  getFact(id: number): Fact | undefined {
    return this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Fact | undefined;
  }

  topFacts(limit = 30): Fact[] {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.db
      .prepare(
        "SELECT * FROM facts ORDER BY confidence DESC, reinforcements DESC, id DESC LIMIT ?"
      )
      .all(n) as Fact[];
  }

  // ---- L3: rules ----

  addRule(input: NewRule): number {
    const title = requireNonEmpty(input.title, "title");
    const mistake = requireNonEmpty(input.mistake, "mistake");
    const rule = requireNonEmpty(input.rule, "rule");
    const info = this.db
      .prepare(
        "INSERT INTO rules (title, mistake, cause, rule, triggers, confirmed) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(title, mistake, input.cause ?? null, rule, input.triggers ?? null, input.confirmed ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  confirmRule(id: number): boolean {
    const info = this.db.prepare("UPDATE rules SET confirmed = 1 WHERE id = ?").run(id);
    return info.changes > 0;
  }

  confirmedRules(): Rule[] {
    return this.db.prepare("SELECT * FROM rules WHERE confirmed = 1 ORDER BY id DESC").all() as Rule[];
  }

  // ---- recall (FTS5 across all levels) ----

  recall(query: string, limit = 8): RecallHit[] {
    const fts = toFtsQuery(query);
    if (fts.length === 0) return [];
    const n = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT 'fact' AS kind, f.id AS id, ('[' || f.category || '] ' || substr(f.content, 1, 80)) AS title,
                snippet(facts_fts, 0, '<b>', '</b>', '…', 24) AS snippet, rank AS rank
         FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ?
         UNION ALL
         SELECT 'rule', r.id, r.title,
                snippet(rules_fts, 2, '<b>', '</b>', '…', 24), rank
         FROM rules_fts JOIN rules r ON r.id = rules_fts.rowid WHERE rules_fts MATCH ?
         UNION ALL
         SELECT 'episode', e.id, ('session ' || e.session_id),
                snippet(episodes_fts, 0, '<b>', '</b>', '…', 24), rank
         FROM episodes_fts JOIN episodes e ON e.id = episodes_fts.rowid WHERE episodes_fts MATCH ?
         ORDER BY rank LIMIT ?`
      )
      .all(fts, fts, fts, n) as RecallHit[];
    return rows;
  }

  // ---- forget ----

  forget(kind: "fact" | "rule" | "episode", id: number): boolean {
    if (kind !== "fact" && kind !== "rule" && kind !== "episode") {
      throw new Error(`Unknown memory kind: '${kind}'`);
    }
    const table = kind === "fact" ? "facts" : kind === "rule" ? "rules" : "episodes";
    const info = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  // ---- injection snapshot (budgeted, ~3.5-4k tokens) ----

  snapshot(maxTokens = INJECTION_BUDGET_TOKENS): string {
    const sections: string[] = [];
    let used = 0;
    const push = (text: string): boolean => {
      const cost = estimateTokens(text);
      if (used + cost > maxTokens) return false;
      sections.push(text);
      used += cost;
      return true;
    };

    const rules = this.confirmedRules();
    if (rules.length > 0) {
      const lines = rules.map((r) => `- [${r.title}] ${r.rule}`).join("\n");
      if (!push(`## Правила (не нарушать)\n${lines}`)) return sections.join("\n\n");
    }

    const factLines: string[] = [];
    for (const f of this.topFacts(40)) {
      const line = `- [${f.category}] ${f.content}`;
      const extra = factLines.length === 0 ? estimateTokens("## Факты\n") : 0;
      const cost = estimateTokens(line + "\n") + extra;
      if (used + cost > maxTokens) break;
      factLines.push(line);
      used += cost;
    }
    if (factLines.length > 0) sections.push(`## Факты\n${factLines.join("\n")}`);

    const episodes = this.recentEpisodes(3);
    for (const e of episodes) {
      if (!push(`## Прошлая сессия ${e.sessionId}\n${e.summary.slice(0, 600)}`)) break;
    }
    return sections.join("\n\n");
  }
}

export type { Database };
export * from "./types.js";
