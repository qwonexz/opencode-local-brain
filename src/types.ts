// Core domain types for opencode-local-brain.
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

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "user",
  "project",
  "preference",
  "environment",
  "other",
]);

export function isFactCategory(value: string): value is FactCategory {
  return VALID_CATEGORIES.has(value);
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
