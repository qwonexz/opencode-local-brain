import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain, estimateTokens } from "../src/index.js";

let dir: string;
let brain: Brain;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-test-"));
  brain = Brain.open(join(dir, "test.db"));
});

afterEach(() => {
  brain.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("episodes (L1)", () => {
  it("logs and lists recent episodes", () => {
    const id = brain.logEpisode({ sessionId: "s1", summary: "did things" });
    assert.equal(id, 1);
    const recent = brain.recentEpisodes();
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.sessionId, "s1");
  });

  it("rejects duplicate sessionId", () => {
    brain.logEpisode({ sessionId: "s1", summary: "one" });
    assert.throws(() => brain.logEpisode({ sessionId: "s1", summary: "two" }), /already exists/);
  });

  it("rejects empty summary", () => {
    assert.throws(() => brain.logEpisode({ sessionId: "s", summary: "  " }), /must not be empty/);
  });
});

describe("facts (L2)", () => {
  it("remembers and merges duplicates halfway", () => {
    const a = brain.rememberFact({ category: "user", content: "likes dark mode", confidence: 0.4 });
    assert.equal(a.confidence, 0.4);
    const b = brain.rememberFact({ category: "user", content: "likes dark mode", confidence: 1 });
    assert.equal(b.id, a.id);
    assert.ok(Math.abs(b.confidence - 0.7) < 1e-9, `got ${b.confidence}`);
    assert.equal(b.reinforcements, 2);
  });

  it("dedups case/whitespace variants", () => {
    const a = brain.rememberFact({ category: "other", content: "Hello  World" });
    const b = brain.rememberFact({ category: "other", content: "hello world" });
    assert.equal(a.id, b.id);
    assert.equal(b.reinforcements, 2);
  });

  it("rejects unknown category", () => {
    assert.throws(
      () => brain.rememberFact({ category: "alien", content: "x" } as never),
      /Unknown fact category/
    );
  });

  it("clamps confidence", () => {
    const f = brain.rememberFact({ category: "other", content: "c", confidence: 99 });
    assert.equal(f.confidence, 1);
  });

  it("rejects NaN confidence and non-string content", () => {
    assert.throws(() => brain.rememberFact({ category: "other", content: "x", confidence: NaN }), /finite/);
    assert.throws(() => brain.rememberFact({ category: "other", content: 42 as never }), /must be a string/);
  });

  it("rejects oversized content", () => {
    assert.throws(
      () => brain.rememberFact({ category: "other", content: "x".repeat(9000) }),
      /exceeds/
    );
  });

  it("episode delete nulls fact source, fact survives", () => {
    const ep = brain.logEpisode({ sessionId: "s1", summary: "work" });
    const f = brain.rememberFact({ category: "other", content: "linked", sourceEpisodeId: ep });
    assert.equal(f.sourceEpisodeId, ep);
    assert.equal(brain.forget("episode", ep), true);
    assert.equal(brain.getFact(f.id)?.sourceEpisodeId, null);
  });
});

describe("rules (L3)", () => {
  it("adds unconfirmed, then confirms", () => {
    const id = brain.addRule({ title: "T", mistake: "M", rule: "R" });
    assert.equal(brain.confirmedRules().length, 0);
    assert.equal(brain.confirmRule(id), true);
    assert.equal(brain.confirmedRules().length, 1);
    assert.equal(brain.confirmRule(9999), false);
  });
});

describe("recall", () => {
  it("finds facts via FTS", () => {
    brain.rememberFact({ category: "project", content: "uses opencode-local-brain repo" });
    const hits = brain.recall("opencode-local-brain");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.kind, "fact");
  });

  it("returns empty on blank query", () => {
    assert.deepEqual(brain.recall("   "), []);
  });

  it("survives FTS special characters without SQLITE_ERROR", () => {
    brain.rememberFact({ category: "other", content: "note about (parens) and *stars*" });
    for (const q of [`"quoted"`, "(a OR b)", "a*b", "col:test", "^caret", "a+b-c"]) {
      brain.recall(q); // must not throw
    }
  });

  it("finds cyrillic content", () => {
    brain.rememberFact({ category: "user", content: "пользователь любит тёмную тему" });
    const hits = brain.recall("тёмную тему");
    assert.ok(hits.some((h) => h.kind === "fact"));
  });

  it("boosts rules above verbose episodes", () => {
    brain.logEpisode({
      sessionId: "e1",
      summary: "very long episode about deploy deploy deploy ".repeat(50),
    });
    brain.addRule({ title: "Deploy", mistake: "rushed deploy", rule: "always deploy", confirmed: true });
    const hits = brain.recall("deploy");
    assert.ok(hits.length > 0);
    assert.equal(hits[0]?.kind, "rule");
  });
});

describe("forget", () => {
  it("deletes and reports", () => {
    const f = brain.rememberFact({ category: "other", content: "temp" });
    assert.equal(brain.forget("fact", f.id), true);
    assert.equal(brain.forget("fact", f.id), false);
    assert.throws(() => brain.forget("nope" as never, 1), /Unknown memory kind/);
  });
});

describe("validation", () => {
  it("falls back on NaN/Infinity limits", () => {
    brain.logEpisode({ sessionId: "s", summary: "x" });
    assert.equal(brain.recentEpisodes(NaN).length, 1);
    assert.equal(brain.topFacts(Infinity).length, 0);
    assert.deepEqual(brain.recall("x", NaN).length >= 0, true);
  });

  it("rejects invalid ids", () => {
    assert.throws(() => brain.getFact(0), /positive integer/);
    assert.throws(() => brain.forget("fact", -3), /positive integer/);
    assert.throws(() => brain.confirmRule(1.5), /positive integer/);
    assert.throws(() => brain.forget("nope" as never, 1), /Unknown memory kind/);
  });

  it("snapshot rejects tiny budgets", () => {
    assert.throws(() => brain.snapshot(10), />= 50/);
  });
});

describe("snapshot", () => {
  it("stays within token budget", () => {
    for (let i = 0; i < 100; i++) {
      brain.rememberFact({ category: "other", content: `fact number ${i} with some padding text here` });
    }
    const snap = brain.snapshot(500);
    assert.ok(estimateTokens(snap) <= 500, `snapshot exceeded budget: ${estimateTokens(snap)}`);
    assert.match(snap, /## Факты/);
  });

  it("stays within budget on cyrillic content", () => {
    for (let i = 0; i < 60; i++) {
      brain.rememberFact({ category: "other", content: `факт номер ${i} с довольно длинным текстом для проверки` });
    }
    const snap = brain.snapshot(500);
    assert.ok(estimateTokens(snap) <= 500, `cyrillic snapshot exceeded budget: ${estimateTokens(snap)}`);
  });

  it("prioritizes confirmed rules first", () => {
    brain.addRule({ title: "R", mistake: "M", rule: "always do R", confirmed: true });
    const snap = brain.snapshot(120);
    assert.match(snap, /## Правила/);
  });
});
