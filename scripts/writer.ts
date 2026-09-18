#!/usr/bin/env node
/**
 * Detached session writer: turns an opencode session into L1/L2/L3 memories.
 * Usage: node dist/scripts/writer.js <sessionId>
 *
 * Flow: opencode export --sanitize -> cheap model (opencode run) summarizes
 * to JSON -> upsertEpisode + rememberFact (confidence capped) +
 * addRule (ALWAYS unconfirmed). Never auto-confirms L3 rules.
 *
 * Guards: skips own "brain-writer:" sessions, trivial sessions (<2 user
 * messages or <200 chars of transcript), missing sessions.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Brain } from "../src/index.js";
import { isSecretLike } from "../src/secrets.js";

const BRAIN_DIR = join(homedir(), ".config", "opencode", "brain");
const OPENCODE_BIN = join(homedir(), ".opencode", "bin", "opencode");
const DB_PATH = process.env.BRAIN_DB ?? join(BRAIN_DIR, "brain.db");
const LOG_PATH = join(BRAIN_DIR, "writer.log");
const WRITER_MODEL = process.env.BRAIN_WRITER_MODEL ?? "opencode/big-pickle";
const WRITER_TITLE_PREFIX = "brain-writer:";
const REGISTRY_PATH = join(BRAIN_DIR, "writer-sessions.json");
const MAX_FACTS_PER_SESSION = 20;
const MAX_RULES_PER_SESSION = 10;

const MIN_USER_MESSAGES = 2;
const MIN_TRANSCRIPT_CHARS = 200;
const MAX_TRANSCRIPT_CHARS = 30_000;

function log(msg: string): void {
  mkdirSync(BRAIN_DIR, { recursive: true });
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

function run(cmd: string, args: string[], input?: string, timeoutMs = 300_000): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    cwd: homedir(), // session list/export are cwd-scoped; pin to $HOME
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Secure temp file: O_CREAT|O_EXCL (no symlink following, no clobbering),
 * mode 0600 (transcripts may contain secrets). Returns path; caller unlinks.
 */
function secureTempFile(prefix: string, suffix: string): string {
  mkdirSync(BRAIN_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 10; attempt++) {
    const name = `${prefix}-${process.pid}-${Date.now()}-${attempt}${suffix}`;
    const full = join(BRAIN_DIR, name);
    try {
      const fd = openSync(full, "wx", 0o600);
      closeSync(fd);
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("Could not create secure temp file");
}

/** Remove stale writer temp files left by crashes (kill -9 / reboot). */
function cleanStaleTempFiles(): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(BRAIN_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!/^(writer|export)-ses_[A-Za-z0-9]+(-\d+){2,3}(\.txt|\.json)?$/.test(e)) continue;
    const full = join(BRAIN_DIR, e);
    try {
      const age = now - statSync(full).mtimeMs;
      if (age > 60 * 60 * 1000) unlinkSync(full);
    } catch {
      // best-effort
    }
  }
}

interface ExportedMessage {
  info?: { role?: string };
  parts?: { type?: string; text?: string }[];
}
interface SessionExport {
  info?: { id?: string; title?: string };
  messages?: ExportedMessage[];
}

interface WriterOutput {
  summary?: string;
  decisions?: string;
  outcome?: string;
  facts?: { category?: string; content?: string }[];
  mistakes?: { title?: string; mistake?: string; cause?: string; rule?: string }[];
}

function extractTranscript(exp: SessionExport): { userMessages: number; text: string } {
  let userMessages = 0;
  const lines: string[] = [];
  for (const m of exp.messages ?? []) {
    const role = m.info?.role ?? "?";
    if (role === "user") userMessages++;
    if (role !== "user" && role !== "assistant") continue;
    for (const p of m.parts ?? []) {
      if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
        lines.push(`[${role}] ${p.text.trim().slice(0, 4000)}`);
      }
    }
  }
  return { userMessages, text: lines.join("\n").slice(0, MAX_TRANSCRIPT_CHARS) };
}

/** Registry of temp writer titles (second anti-recursion factor). */
function loadWriterRegistry(): Set<string> {
  try {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    // missing/corrupt registry = empty
  }
  return new Set();
}

function registerWriterTitle(title: string): void {
  try {
    const reg = loadWriterRegistry();
    reg.add(title);
    // cap size: keep last 200
    const arr = [...reg].slice(-200);
    writeFileSync(REGISTRY_PATH, JSON.stringify(arr), { encoding: "utf-8", mode: 0o600 });
  } catch {
    // best-effort
  }
}

function parseWriterJson(raw: string): WriterOutput {
  // opencode run --format json emits event lines; the assistant text holds JSON.
  // Strategy: find the largest {...} block.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in writer output");
  return JSON.parse(raw.slice(start, end + 1)) as WriterOutput;
}

const WRITER_PROMPT = `Ты — писарь локальной памяти опенкод-агента. Ниже транскрипт сессии.
Верни ТОЛЬКО валидный JSON без markdown-обёрток:
{
  "summary": "что делали и чем кончилось, 3-8 предложений, русский",
  "decisions": "ключевые решения (или пустая строка)",
  "outcome": "итог: ok / частично / провал + одна строка почему (или пустая строка)",
  "facts": [{"category": "user|project|preference|environment|other", "content": "устойчивый факт"}],
  "mistakes": [{"title": "...", "mistake": "что пошло не так", "cause": "причина", "rule": "правило как не повторить"}]
}
Правила: факты — только устойчивые (не одноразовое); секреты/токены/пароли НЕ писать никуда; если фактов или ошибок нет — пустые массивы.`;

/** Best-effort: delete our temp "brain-writer:" session so transcripts (which
 * may contain secrets from the summarized session) don't linger on disk. */
function cleanupWriterSession(sessionId: string): void {
  try {
    const raw = run(OPENCODE_BIN, ["session", "list", "--format", "json", "-n", "30"], undefined, 60_000);
    const sessions = JSON.parse(raw) as { id?: string; title?: string }[];
    for (const s of sessions) {
      if (typeof s.id === "string" && s.title === `${WRITER_TITLE_PREFIX} ${sessionId}`) {
        run(OPENCODE_BIN, ["session", "delete", s.id], undefined, 30_000);
        log(`${sessionId}: temp writer session ${s.id} deleted`);
      }
    }
  } catch {
    // best-effort: a leftover temp session is skipped by future writers anyway
  }
}

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  if (!sessionId || !/^ses_[A-Za-z0-9]{1,64}$/.test(sessionId)) {
    throw new Error("Usage: writer.js <sessionId> (ses_...)");
  }
  cleanStaleTempFiles();

  // Second anti-recursion factor (independent of `opencode run --title`):
  // registry of temp writer titles we created ourselves.
  const registry = loadWriterRegistry();

  // NOTE: no --sanitize here — sanitized transcripts are all [redacted] and
  // useless for summarization. Secrets in the transcript never reach the DB:
  // writer output passes assertNoSecrets per item, and the temp writer
  // session is deleted right after (cleanupWriterSession).
  // NOTE 2: `opencode export` truncates JSON when stdout is a pipe — redirect
  // to a temp file instead. sessionId is regex-validated, safe to interpolate.
  const exportTmp = secureTempFile("export", ".json");
  try {
    run("bash", ["-c", `'${OPENCODE_BIN}' export '${sessionId}' > '${exportTmp}'`], undefined, 60_000);
    var rawExport = readFileSync(exportTmp, "utf-8");
  } finally {
    try {
      unlinkSync(exportTmp);
    } catch {
      // best-effort cleanup
    }
  }
  const exp = JSON.parse(rawExport) as SessionExport;
  const title = exp.info?.title ?? "";
  if (title.startsWith(WRITER_TITLE_PREFIX) || registry.has(title)) {
    log(`${sessionId}: skipped (own writer session)`);
    return;
  }
  const { userMessages, text } = extractTranscript(exp);
  if (userMessages < MIN_USER_MESSAGES || text.length < MIN_TRANSCRIPT_CHARS) {
    log(`${sessionId}: skipped (trivial: ${userMessages} user msgs, ${text.length} chars)`);
    return;
  }

  // Transcript goes via -f attachment (message MUST come first on the CLI,
  // otherwise -f swallows it). The model reads attachments fine.
  const tmp = secureTempFile("writer", ".txt");
  writeFileSync(tmp, `${WRITER_PROMPT}\n\n--- ТРАНСКРИПТ ---\n${text}`, { encoding: "utf-8", mode: 0o600 });
  let out: string;
  try {
    out = run(
      OPENCODE_BIN,
      [
        "run",
        "Резюмируй приложенный файл с транскриптом строго по схеме JSON из него. Ответ — только JSON.",
        "-m",
        WRITER_MODEL,
        "--title",
        `${WRITER_TITLE_PREFIX} ${sessionId}`,
        "-f",
        tmp,
      ],
      undefined,
      300_000
    );
    registerWriterTitle(`${WRITER_TITLE_PREFIX} ${sessionId}`);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
  }

  const data = parseWriterJson(out);
  // Strip prototype-pollution keys from model output before use.
  if (data && typeof data === "object") {
    for (const k of ["__proto__", "constructor", "prototype"]) delete (data as Record<string, unknown>)[k];
    if (Array.isArray(data.facts)) data.facts = data.facts.slice(0, MAX_FACTS_PER_SESSION);
    if (Array.isArray(data.mistakes)) data.mistakes = data.mistakes.slice(0, MAX_RULES_PER_SESSION);
  }
  cleanupWriterSession(sessionId);
  if (!data.summary || typeof data.summary !== "string") {
    throw new Error("Writer produced no summary");
  }

  const brain = Brain.open(DB_PATH);
  try {
    const episodeInput: { sessionId: string; summary: string; decisions?: string; outcome?: string } = {
      sessionId,
      summary: data.summary,
    };
    if (typeof data.decisions === "string" && data.decisions.trim().length > 0) {
      episodeInput.decisions = data.decisions;
    }
    if (typeof data.outcome === "string" && data.outcome.trim().length > 0) {
      episodeInput.outcome = data.outcome;
    }
    const { id, created } = brain.upsertEpisode(episodeInput);
    let facts = 0;
    for (const f of data.facts ?? []) {
      try {
        if (typeof f.content !== "string" || isSecretLike(f.content)) continue;
        const cat = ["user", "project", "preference", "environment", "other"].includes(f.category ?? "")
          ? (f.category as "user" | "project" | "preference" | "environment" | "other")
          : "other";
        const conf = 0.6; // cheap-model cap: writer never assigns high confidence
        brain.rememberFact({ category: cat, content: f.content, confidence: conf, sourceEpisodeId: id });
        facts++;
      } catch {
        // per-fact fail-closed: skip bad items, keep the rest
      }
    }
    let rules = 0;
    for (const m of data.mistakes ?? []) {
      try {
        if (typeof m.title !== "string" || typeof m.mistake !== "string" || typeof m.rule !== "string") continue;
        const ruleInput: { title: string; mistake: string; cause?: string; rule: string; confirmed: boolean } = {
          title: m.title,
          mistake: m.mistake,
          rule: m.rule,
          confirmed: false,
        };
        if (typeof m.cause === "string" && m.cause.trim().length > 0) ruleInput.cause = m.cause;
        brain.addRule(ruleInput);
        rules++;
      } catch {
        // per-rule fail-closed
      }
    }
    log(`${sessionId}: episode ${id} (created=${created}), facts=${facts}, rules=${rules}`);
  } finally {
    brain.close();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    log(`FATAL: ${msg.slice(0, 300)}`);
  } catch {
    // logging must never throw
  }
  process.exitCode = 1;
});
