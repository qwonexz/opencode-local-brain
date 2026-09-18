#!/usr/bin/env node
/**
 * brain MCP server: exposes local layered memory to opencode agents.
 * Tools: brain_recall / brain_remember / brain_forget.
 *
 * Env:
 *   BRAIN_DB — path to brain.db (default ~/.config/opencode/brain/brain.db)
 *
 * The server opens the DB lazily per request and closes it afterwards,
 * so concurrent writers (plugin, writer daemon) never hold a stale handle.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Brain } from "./index.js";

const DB_PATH = process.env.BRAIN_DB ?? join(homedir(), ".config", "opencode", "brain", "brain.db");

function withBrain<T>(fn: (brain: Brain) => T): T {
  const brain = Brain.open(DB_PATH);
  try {
    return fn(brain);
  } finally {
    brain.close();
  }
}

const server = new McpServer({ name: "local-brain", version: "0.1.0" });

server.registerTool(
  "brain_recall",
  {
    description:
      "Search local memory (facts, confirmed rules, past session summaries) by free-text query. Returns ranked hits with [[highlighted]] snippets. Use before answering questions about the user, projects, or past work — and when a past mistake might be relevant.",
    inputSchema: {
      query: z.string().min(1).max(500).describe("Free-text search query"),
      limit: z.number().int().min(1).max(20).default(8).describe("Max hits"),
    },
  },
  ({ query, limit }) => {
    const hits = withBrain((b) => b.recall(query, limit));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(hits, null, 2) }],
    };
  }
);

server.registerTool(
  "brain_remember",
  {
    description:
      "Store a durable fact about the user, projects, preferences, or environment (L2 semantic memory). Duplicates merge automatically. Do NOT store secrets, tokens, passwords, or credentials — they are rejected.",
    inputSchema: {
      category: z.enum(["user", "project", "preference", "environment", "other"]),
      content: z.string().min(1).max(8000),
      confidence: z.number().min(0).max(1).default(0.5),
    },
  },
  ({ category, content, confidence }) => {
    const fact = withBrain((b) => b.rememberFact({ category, content, confidence }));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(fact, null, 2) }],
    };
  }
);

server.registerTool(
  "brain_forget",
  {
    description: "Delete one memory entry by kind and id. Use when the user asks to forget something.",
    inputSchema: {
      kind: z.enum(["fact", "rule", "episode"]),
      id: z.number().int().positive(),
    },
  },
  ({ kind, id }) => {
    const deleted = withBrain((b) => b.forget(kind, id));
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ deleted }, null, 2) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
