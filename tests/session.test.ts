import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createSession, decideNotification, getSession, surface } from "../lib/session.ts";
import { loadTemplate } from "../lib/config.ts";
import { fakeCtx, fakeNotifier } from "./helpers/fake-pi.ts";

const ref = { sessionId: "s1", cwd: "/p" };
const notify = (kinds = { confirm: true, fail: true, idle: false }) => ({ command: "/n", kinds, idleDelaySeconds: 60 });

test("surface: tui prompts, panels and notifies; rpc only prompts; print does nothing", () => {
  assert.deepEqual(surface({ mode: "tui", hasUI: true }), { canPrompt: true, canPanel: true, canNotify: true });
  assert.deepEqual(surface({ mode: "rpc", hasUI: true }), { canPrompt: true, canPanel: false, canNotify: false });
  assert.deepEqual(surface({ mode: "print", hasUI: false }), { canPrompt: false, canPanel: false, canNotify: false });
  assert.deepEqual(surface({ mode: "json", hasUI: false }), { canPrompt: false, canPanel: false, canNotify: false });
});

test("decideNotification: question and permission need kinds.confirm; activity is never gated", () => {
  const off = notify({ confirm: false, fail: true, idle: false });
  assert.equal(decideNotification({ kind: "question", questions: [{ question: "A?" }] }, off, ref), undefined);
  assert.equal(decideNotification({ kind: "permission", toolName: "bash", input: { command: "sudo x" } }, off, ref), undefined);
  assert.deepEqual(decideNotification({ kind: "activity", toolName: "read" }, off, ref), {
    args: ["--agent", "pi", "--mark"],
    payload: { hook_event_name: "PostToolUse", session_id: "s1", cwd: "/p", tool_name: "read" },
  });
  const q = decideNotification({ kind: "question", questions: [{ question: "A?", header: "H" }] }, notify(), ref)!;
  assert.deepEqual(q.payload, { hook_event_name: "PreToolUse", session_id: "s1", cwd: "/p", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "A?", header: "H" }] } });
  const p = decideNotification({ kind: "permission", toolName: "write", input: { path: "~/.ssh/x", content: "secret" } }, notify(), ref)!;
  assert.deepEqual(p.payload.tool_input, { path: "~/.ssh/x" }, "only the path travels, never the content");
});

test("decideNotification: settled follows decideSettled (fail / stop / nothing)", () => {
  const asst = (text: string, stopReason = "stop", errorMessage?: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage } });
  assert.equal(decideNotification({ kind: "settled", entries: [asst("", "error", "429 slow down")] }, notify(), ref), undefined);
  assert.equal(decideNotification({ kind: "settled", entries: [asst("", "error", "401 nope")] }, notify(), ref)!.payload.hook_event_name, "StopFailure");
  assert.equal(decideNotification({ kind: "settled", entries: [asst("done?")] }, notify(), ref)!.payload.last_assistant_message, "done?");
});

test("session.notify: spawns only when the surface can notify and a command is configured", () => {
  const sent: string[][] = [];
  const spawn = (_n: unknown, args: string[]) => void sent.push(args);
  const cfg = { ...loadTemplate(), notify: notify() };
  assert.equal(createSession(fakeCtx() as any, cfg, spawn).notify({ kind: "activity", toolName: "read" }), true);
  assert.equal(createSession(fakeCtx({ mode: "rpc" }) as any, cfg, spawn).notify({ kind: "activity", toolName: "read" }), false);
  assert.equal(createSession(fakeCtx() as any, { ...cfg, notify: { ...notify(), command: undefined } }, spawn).notify({ kind: "activity", toolName: "read" }), false);
  assert.equal(sent.length, 1);
});

test("getSession re-reads adonis-pi.json when it changes, and warns once per broken version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-session-"));
  const file = join(dir, "adonis-pi.json");
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const warnings: string[] = [];
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => warnings.push(m) } }) as any;
    writeFileSync(file, JSON.stringify({ permissionGate: { mode: "block" } }));
    assert.equal(getSession(ctx).config.permissionGate.mode, "block");
    await sleep(15);
    writeFileSync(file, JSON.stringify({ permissionGate: { mode: "ask" } }));
    assert.equal(getSession(ctx).config.permissionGate.mode, "ask", "edit picked up without a restart");
    await sleep(15);
    writeFileSync(file, "{ broken");
    assert.equal(getSession(ctx).config.permissionGate.mode, "block", "template fallback runs the gate in block mode: the account's own Deny rules are unreadable");
    getSession(ctx);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /adonis-pi config/);
    assert.match(warnings[0], /blocks every hit/);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("fakeNotifier helper wires deps so an extension never touches disk or spawns", () => {
  const n = fakeNotifier();
  const s = getSession(fakeCtx() as any, n.deps);
  s.notify({ kind: "activity", toolName: "x" });
  assert.equal(n.sent.length, 1);
});
