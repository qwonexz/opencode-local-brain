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
  it("remembers and reinforces duplicates", () => {
    const a = brain.rememberFact({ category: "user", content: "likes dark mode" });
    assert.equal(a.confidence, 0.5);
    const b = brain.rememberFact({ category: "user", content: "likes dark mode", confidence: 0.9 });
    assert.equal(b.id, a.id);
    assert.equal(b.confidence, 0.9);
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
});

describe("forget", () => {
  it("deletes and reports", () => {
    const f = brain.rememberFact({ category: "other", content: "temp" });
    assert.equal(brain.forget("fact", f.id), true);
    assert.equal(brain.forget("fact", f.id), false);
    assert.throws(() => brain.forget("nope" as never, 1), /Unknown memory kind/);
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
});
