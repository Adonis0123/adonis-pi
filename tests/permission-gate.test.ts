import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";
import { globToRegExp, matchToolCall, segments } from "../extensions/permission-gate/match.ts";
import { loadTemplate } from "../lib/config.ts";
import permissionGate from "../extensions/permission-gate/index.ts";
import { fakeNotifier } from "./helpers/fake-pi.ts";

const gate = () => loadTemplate().permissionGate;

test("globToRegExp expands ~ and handles ** and *", () => {
  const re = globToRegExp("~/.ssh/**");
  assert.ok(re.test(join(homedir(), ".ssh/id_ed25519")));
  assert.ok(re.test(join(homedir(), ".ssh/sub/dir/file")));
  assert.ok(!re.test(join(homedir(), ".sshx/file")));
  assert.ok(globToRegExp("/tmp/*.env").test("/tmp/a.env"));
  assert.ok(!globToRegExp("/tmp/*.env").test("/tmp/sub/a.env"));
});

test("segments splits on newlines, separators and shell -c wrappers", () => {
  assert.deepEqual(segments("a; b && c || d | e\nf"), ["a", " b ", " c ", " d ", " e", "f"]);
  assert.deepEqual(segments("bash -c 'sudo rm x'"), ["bash -c 'sudo rm x'", "sudo rm x"]);
  assert.deepEqual(segments('sh -c "ls | sudo tee f"'), ['sh -c "ls | sudo tee f"', "ls ", " sudo tee f"]);
  assert.deepEqual(segments("if a; then b; fi"), ["a", " b", " fi"]);
  assert.deepEqual(segments("x=$(a) & (b)"), ["x=", "a", "b"]);
});

test("deny regexes hit in every segment shape (Review Focus 1)", () => {
  const hits = [
    "rm -rf ~/*",
    "npm test && git push origin main --force",
    "ls; sudo rm x",
    "  sudo ls",
    "ls\nsudo x",
    "echo hi | sudo tee /etc/x",
    "bash -c 'sudo rm x'",
    "FOO=1 env sudo x",
    "git -C /tmp/x push --force",
    "git push -f",
    "git push -uf origin x",
    "git push origin +main",
    "rm -rf ~/",
    "rm -rf ~",
    "rm -r -f /",
    "rm -rf $HOME/*",
    "chmod -R 777 .",
    "chmod 0777 f",
    "dd if=/dev/zero of=/dev/disk2",
    // chained with a single &, keyword-prefixed, subshell, command substitution, quoted/braced $HOME
    "echo hi & sudo reboot",
    "if true; then sudo reboot; fi",
    "while true; do sudo x; done",
    "time sudo ls",
    "(sudo reboot)",
    "x=$(sudo id)",
    'rm -rf "$HOME"',
    "rm -rf ${HOME}/",
    "rm -rf '~'",
  ];
  for (const command of hits) {
    const hit = matchToolCall({ toolName: "bash", input: { command } }, gate(), "/p");
    assert.ok(hit, `expected a hit for: ${command}`);
    assert.match(hit!.reason, /denyCommands/);
  }
});

test("quoted text containing a separator is a known false positive in ask mode (documented, not fixed)", () => {
  // `echo "a | sudo b"` is split at the pipe because segments() does not parse quotes; the gate asks, the user says yes.
  assert.ok(matchToolCall({ toolName: "bash", input: { command: 'echo "a | sudo b"' } }, gate(), "/p"));
});

test("ordinary commands and other tools pass", () => {
  const passes = ["git push origin feature", "git push --force --dry-run origin HEAD", "git push -f --dry-run", "rm -rf node_modules", "rm -rf ./build/", "rm -rf /tmp/x", "rm -rf ~/x", "rm -rf ${HOME}/x", "echo sudo", "grep sudo README.md", "chmod 755 bin/pin", "if true; then echo ok; fi", "echo $(date)"];
  for (const command of passes) {
    assert.equal(matchToolCall({ toolName: "bash", input: { command } }, gate(), "/p"), undefined, `unexpected hit for: ${command}`);
  }
  assert.equal(matchToolCall({ toolName: "read", input: { path: join(homedir(), ".ssh/config") } }, gate(), "/p"), undefined);
});

test("write/edit into protected paths are flagged, relative paths resolve against cwd", () => {
  const hit = matchToolCall({ toolName: "write", input: { path: "~/.aws/credentials", content: "x" } }, gate(), "/p");
  assert.ok(hit);
  assert.match(hit!.reason, /protectedPaths/);
  assert.ok(matchToolCall({ toolName: "edit", input: { path: ".ssh/config" } }, { ...gate(), protectedPaths: ["/p/.ssh/**"] }, "/p"));
  assert.equal(matchToolCall({ toolName: "write", input: { path: "src/a.ts" } }, gate(), "/p"), undefined);
});

test("ask mode: confirm=true lets the call through, confirm=false blocks with the user's denial", async () => {
  const { pi, emit } = createFakePi();
  permissionGate(pi);
  let asked = 0;
  const yes = fakeCtx({ ui: { ...fakeCtx().ui, confirm: async () => { asked++; return true; } } });
  assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, yes), undefined);
  assert.equal(asked, 1);
  const no = fakeCtx({ ui: { ...fakeCtx().ui, confirm: async () => false } });
  const r = (await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, no)) as { block: boolean; reason: string };
  assert.equal(r.block, true);
  assert.match(r.reason, /denied/i);
});

test("non-UI mode blocks without asking", async () => {
  const { pi, emit } = createFakePi();
  permissionGate(pi);
  const ctx = fakeCtx({ hasUI: false, mode: "print" });
  const r = (await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, ctx)) as { block: boolean };
  assert.equal(r.block, true);
});

test("off mode lets a deny-listed call through without asking or notifying", async () => {
  const n = fakeNotifier({}, { permissionGate: { ...gate(), mode: "off" } });
  const { pi, emit } = createFakePi();
  permissionGate(pi, n.deps);
  let asked = 0;
  const ctx = fakeCtx({ ui: { ...fakeCtx().ui, confirm: async () => { asked++; return false; } } });
  assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, ctx), undefined);
  assert.equal(asked, 0);
  assert.equal(n.sent.length, 0);
});

test("block mode from an account config blocks even with UI, and a broken config warns once and falls back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-gate-"));
  writeFileSync(join(dir, "adonis-pi.json"), JSON.stringify({ permissionGate: { mode: "block" } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { pi, emit } = createFakePi();
    permissionGate(pi);
    const r = (await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, fakeCtx())) as { block: boolean };
    assert.equal(r.block, true);

    await sleep(15); // a different mtime lets the session notice the rewrite
    writeFileSync(join(dir, "adonis-pi.json"), "{ broken");
    const warnings: string[] = [];
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => warnings.push(m), confirm: async () => true } });
    const { pi: pi2, emit: emit2 } = createFakePi();
    permissionGate(pi2);
    await emit2("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, ctx);
    await emit2("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, ctx);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /adonis-pi config/);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

test("asking sends a PermissionRequest notification in the TUI, none in rpc, and never when the user is not asked", async () => {
  const notifier = fakeNotifier();
  const { pi, emit } = createFakePi();
  permissionGate(pi, notifier.deps);
  await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, fakeCtx());
  assert.equal(notifier.sent.length, 1);
  assert.deepEqual(notifier.sent[0].args, ["--agent", "pi"]);
  assert.equal(notifier.sent[0].payload.hook_event_name, "PermissionRequest");
  assert.deepEqual(notifier.sent[0].payload.tool_input, { command: "sudo ls" });
  await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, fakeCtx({ mode: "rpc" }));
  assert.equal(notifier.sent.length, 1, "rpc prompts but does not notify");
  await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, fakeCtx({ mode: "print", hasUI: false }));
  assert.equal(notifier.sent.length, 1, "a block without a prompt notifies nobody");
});

test("denyTools: direct MCP tools by name, proxy calls by the mcp tool argument; native tools and read-only proxy ops pass", () => {
  const cfg = { ...gate(), denyTools: ["figma_use_figma", "figma_generate_*", "kimi-cu_click"] };
  // direct tool (adapter directTools: true registers `<server>_<tool>`)
  let hit = matchToolCall({ toolName: "figma_use_figma", input: { code: "x" } }, cfg, "/p");
  assert.ok(hit);
  assert.match(hit!.reason, /denyTools figma_use_figma/);
  assert.ok(matchToolCall({ toolName: "figma_generate_figma_design", input: {} }, cfg, "/p"));
  assert.ok(matchToolCall({ toolName: "kimi-cu_click", input: { app: "com.apple.finder", index: 3 } }, cfg, "/p"));
  assert.equal(matchToolCall({ toolName: "kimi-cu_get_app_state", input: { app: "x" } }, cfg, "/p"), undefined);
  // proxy meta-tool: the real target sits in input.tool
  hit = matchToolCall({ toolName: "mcp", input: { tool: "figma_use_figma", args: { code: "x" } } }, cfg, "/p");
  assert.ok(hit);
  assert.match(hit!.detail, /^figma_use_figma \{"code":"x"\}/);
  assert.equal(matchToolCall({ toolName: "mcp", input: { tool: "deepwiki_ask_question", args: {} } }, cfg, "/p"), undefined);
  assert.equal(matchToolCall({ toolName: "mcp", input: { search: "figma" } }, cfg, "/p"), undefined, "search/describe/connect carry no target and the defaults never name the meta-tool");
  assert.ok(matchToolCall({ toolName: "mcp", input: { connect: "kimi-cu" } }, { ...cfg, denyTools: ["mcp"] }, "/p"), "a rule literally named mcp gates every Bridge operation, connect included");
  // pi's own tools never go through denyTools even when a glob would match their name
  assert.equal(matchToolCall({ toolName: "bash", input: { command: "echo figma_use_figma" } }, { ...cfg, denyTools: ["*"] }, "/p"), undefined);
  assert.equal(matchToolCall({ toolName: "AskUserQuestion", input: { questions: [] } }, { ...cfg, denyTools: ["*"] }, "/p"), undefined);
  // the shipped template gates Figma canvas writes and nothing of kimi-cu / deepwiki
  assert.ok(matchToolCall({ toolName: "figma_create_new_file", input: {} }, gate(), "/p"));
  assert.equal(matchToolCall({ toolName: "kimi-cu_type_text", input: { text: "x" } }, gate(), "/p"), undefined);
  assert.equal(matchToolCall({ toolName: "mcp", input: { tool: "deepwiki_ask_question" } }, gate(), "/p"), undefined);
});

test("ask mode confirms an MCP hit in both shapes and notifies with the target tool name", async () => {
  const n = fakeNotifier({}, { permissionGate: { ...gate(), denyTools: ["kimi-cu_click"] } });
  const { pi, emit } = createFakePi();
  permissionGate(pi, n.deps);
  const asked: string[] = [];
  const ctx = fakeCtx({ ui: { ...fakeCtx().ui, confirm: async (_t: string, m: string) => { asked.push(m); return false; } } });
  let r = (await emit("tool_call", { toolName: "kimi-cu_click", input: { app: "a", index: 1 } }, ctx)) as { block: boolean };
  assert.equal(r.block, true);
  r = (await emit("tool_call", { toolName: "mcp", input: { tool: "kimi-cu_click", args: { app: "a", index: 1 } } }, ctx)) as { block: boolean };
  assert.equal(r.block, true);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /kimi-cu_click \{"app":"a","index":1\}/);
  assert.equal(n.sent.length, 2);
  assert.deepEqual((n.sent[1].payload as any).tool_input, { tool: "kimi-cu_click" });
});

test("a broken adonis-pi.json turns ask into block for every hit, including MCP tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-gate-"));
  writeFileSync(join(dir, "adonis-pi.json"), "{ broken");
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { pi, emit } = createFakePi();
    permissionGate(pi);
    let asked = 0;
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, confirm: async () => { asked++; return true; } } });
    const r = (await emit("tool_call", { toolName: "figma_use_figma", input: {} }, ctx)) as { block: boolean; reason: string };
    assert.equal(r.block, true);
    assert.match(r.reason, /permission gate/);
    assert.equal(asked, 0, "no confirm: the account's rules are unreadable, so hits are blocked outright");
    assert.equal(await emit("tool_call", { toolName: "kimi-cu_get_app_state", input: {} }, ctx), undefined, "non-hits still pass");
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});
