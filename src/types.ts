// Core domain types + validation helpers for opencode-local-brain.
// L1 = episodic (session logs), L2 = semantic (facts), L3 = deep (rules).

export type FactCategory = "user" | "project" | "preference" | "environment" | "other";

export interface Episode {
  id: number;
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  summary: string;
  decisions: string | null;
  outcome: string | null;
  createdAt: string;
}

export interface NewEpisode {
  sessionId: string;
  startedAt?: string;
  endedAt?: string;
  summary: string;
  decisions?: string;
  outcome?: string;
}

export interface Fact {
  id: number;
  category: FactCategory;
  content: string;
  confidence: number; // 0..1
  sourceEpisodeId: number | null;
  reinforcements: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewFact {
  category: FactCategory;
  content: string;
  confidence?: number;
  sourceEpisodeId?: number;
}

export interface Rule {
  id: number;
  title: string;
  mistake: string;
  cause: string | null;
  rule: string;
  triggers: string | null;
  confirmed: boolean;
  createdAt: string;
}

export interface NewRule {
  title: string;
  mistake: string;
  cause?: string;
  rule: string;
  triggers?: string;
  confirmed?: boolean;
}

export interface RecallHit {
  kind: "fact" | "rule" | "episode";
  id: number;
  title: string;
  snippet: string;
  rank: number;
}

export const SCHEMA_VERSION = 1;

/** Hard input limits (chars) — DoS protection for SQLite/FTS/snapshot. */
export const LIMITS = {
  sessionId: 256,
  summary: 20_000,
  decisions: 20_000,
  outcome: 8_000,
  factContent: 8_000,
  ruleTitle: 500,
  ruleMistake: 8_000,
  ruleCause: 8_000,
  ruleText: 8_000,
  ruleTriggers: 2_000,
} as const;

/** Max reinforcements counter (saturating) — prevents unbounded growth. */
export const MAX_REINFORCEMENTS = 10_000;

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "user",
  "project",
  "preference",
  "environment",
  "other",
]);

export function isFactCategory(value: unknown): value is FactCategory {
  return typeof value === "string" && VALID_CATEGORIES.has(value);
}

/** Normalize text: NFKC, strip control/format chars (keeping ZWJ for emoji), collapse whitespace. */
export function normalizeText(value: string): string {
  const ZWJ = "\u200D";
  const GUARD = "\uE000";
  const strip = (s: string): string =>
    s
      .normalize("NFKC")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  if (!value.includes(ZWJ)) return strip(value);
  if (value.includes(GUARD)) return strip(value); // ultra-rare: drop ZWJ rather than corrupt PUA
  return strip(value.split(ZWJ).join(GUARD)).split(GUARD).join(ZWJ);
}

/** Normalized identity for fact dedup: NFKC + lowercase + collapsed whitespace. */
export function normalizeContent(value: string): string {
  return normalizeText(value).toLowerCase();
}

export function requireText(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const clean = normalizeText(value);
  if (clean.length === 0) throw new Error(`${field} must not be empty`);
  if (clean.length > maxLen) {
    throw new Error(`${field} exceeds ${maxLen} chars (got ${clean.length})`);
  }
  return clean;
}

export function requireId(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function clampLimit(value: unknown, def: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return def;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function parseConfidence(value: unknown, def: number): number {
  if (value === undefined) return def;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("confidence must be a finite number");
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
