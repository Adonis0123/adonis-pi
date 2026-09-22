# adonis-pi Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pi a daily-usable fourth host by shipping the adonis-pi Pi Package: permission gate, attention notify, `AskUserQuestion` tool, `pin` launcher, provider templates, and a verified acceptance run in the user's main repo.

**Architecture:** One public repo is a Pi Package loaded by the official pi via `settings.json` `packages`. Four extensions (one concern each) share `lib/config.ts` (single config entry `adonis-pi.json`) and `lib/notify.ts` (Claude-dialect hook JSON piped to an external notifier). A POSIX `bin/pin` materialises templates into `$PI_CODING_AGENT_DIR` once and reports drift afterwards.

**Tech Stack:** TypeScript ESM (loaded by pi through jiti, no build), `typebox` 1.x for tool schemas, `tsx --test` + `node:test` for tests, POSIX sh for `bin/pin`, Node ≥ 22.19.

**Spec:** `docs/specs/2026-09-22-adonis-pi-phase1-design.md` (terms in `CONTEXT.md`, decisions in `docs/adr/0001`, `0002`).

## Global Constraints

- Node `>=22.19.0` (pi 0.87.0 requirement). Local machine has 22.22.3.
- pi is installed from npm pinned to `@earendil-works/pi-coding-agent@0.87.0` (Task 1 Step 3; it was not on this machine's PATH at plan time); this repo never modifies pi. `pin doctor` warns when `pi --version` is outside `0.87.x`, because 0.86 → 0.87 changed `SessionEntry` and the settle semantics extensions rely on. `package.json` pins devDependencies to exactly `0.87.0` (what tests and typecheck ran against) and declares `peerDependencies` as `^0.87.0` (the compatibility range this package claims; pi supplies these modules at runtime).
- Repo Layer must contain no absolute user paths, no secrets, no Feishu ids. Task 10 greps for the macOS home prefix, `sk-` key prefixes and Feishu `ou_` / `oc_` ids and must return nothing.
- Account Layer files are copied from `templates/` only when absent; never overwritten by any script.
- Secrets live only in `$PI_CODING_AGENT_DIR/proxy.env` with mode `600`; no extension reads that file or `process.env` directly except through `lib/config.ts` `$VAR` resolution.
- Every extension is `extensions/<name>/index.ts`, default-exporting `(pi: ExtensionAPI) => void`, listed explicitly in `package.json` `pi.extensions`.
- Extensions never block the agent loop on network: notifier is spawned detached with a 10 s kill timer, and its environment is filtered: no variable ending in `_API_KEY` or `_AUTH_TOKEN`, none starting with `ANTHROPIC_` or `OPENAI_`.
- The permission gate is a guard against operator mistakes, not a security boundary. It inspects `bash` command text and `write`/`edit` paths only; it does not prevent reads, symlink tricks or writes performed through shell commands. The spec states this and the README repeats it.
- No git commit is made unless the user has authorised committing for the execution session (user rule). Commit steps below are executed only under that authorisation; otherwise leave the tree staged and say so.
- Language: code, file names, commit messages in English; user-facing docs in Chinese.

## Review Focus

1. A `bash` command that hides the dangerous word after a newline, a leading space, a pipe, `&&`, or inside `bash -c '…'`: the gate splits the command into segments and tests each one, so `  sudo x`, `ls\nsudo x`, `echo hi | sudo tee f` and `bash -c 'sudo x'` are all caught. Test in Task 4.
2. `adonis-pi.json` missing or malformed on first launch: extensions must fall back to template defaults and warn once, never crash pi. Test in Task 2 and Task 4.
3. `AskUserQuestion` called with `multiSelect: true`, zero selections, then Enter: the panel stays open and nothing is returned; only Esc cancels. Test in Task 5.
4. `agent_settled` whose last assistant message has `stopReason: "error"` with a transient message (rate limit), or `stopReason: "aborted"` (user interrupted): must send nothing. Test in Task 6.
5. `pin setup 1` run twice, second time with a user-edited `settings.json` (4-space indent, extra `theme` key): the file keeps the user's keys and indentation; only the `packages` entry is added when missing. Test in Task 7.

---

### Task 1: Package scaffold and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tests/helpers/fake-pi.ts`
- Create: `tests/scaffold.test.ts`
- Modify: `.gitignore` (already ignores `node_modules/`; no change expected, verify)

**Interfaces:**
- Produces: `createFakePi(): { pi: ExtensionAPI; emit(event: string, payload: object, ctx: object): Promise<unknown>; tools: Map<string, ToolDefinitionLike> }` and `fakeCtx(overrides?: object): ExtensionContextLike` used by every later test.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "adonis-pi",
  "version": "0.1.0",
  "description": "Pi Package: permission gate, attention notify, AskUserQuestion tool and multi-account launcher for pi",
  "license": "MIT",
  "type": "module",
  "keywords": ["pi-package"],
  "engines": { "node": ">=22.19.0" },
  "bin": { "pin": "./bin/pin" },
  "pi": {
    "extensions": [
      "./extensions/permission-gate/index.ts",
      "./extensions/attention-notify/index.ts",
      "./extensions/ask-user-question/index.ts",
      "./extensions/startup-check/index.ts"
    ]
  },
  "scripts": {
    "test": "tsx --test --test-concurrency=1 tests/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "^0.87.0",
    "@earendil-works/pi-tui": "^0.87.0",
    "typebox": "^1.3.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.87.0",
    "@earendil-works/pi-tui": "0.87.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typebox": "^1.3.0",
    "typescript": "^5.6.0"
  }
}
```

`typebox` and `@earendil-works/pi-tui` are provided to extensions by pi at runtime (virtual module mapping, per pi `docs/extensions.md`); they are devDependencies here only so tests and typecheck resolve them, and peerDependencies so the contract is declared. `--test-concurrency=1` keeps test files sequential because several of them set `PI_CODING_AGENT_DIR` and share the runtime-config cache.

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["lib/**/*.ts", "extensions/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Install pi globally, install dev dependencies and confirm pi-tui is resolvable**

Run: `npm install -g @earendil-works/pi-coding-agent@0.87.0 && pi --version`, then `npm install` in the repo root
Expected: `pi --version` prints `0.87.0`; `node_modules/@earendil-works/pi-tui/package.json` and `node_modules/@earendil-works/pi-coding-agent/package.json` both report version `0.87.0`. Glance at `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts` once for `SessionEntry` and `ToolDefinition` before Tasks 5 and 6.

- [ ] **Step 4: Write the fake pi helper**

`tests/helpers/fake-pi.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

export interface ToolDefinitionLike {
  name: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: any,
  ) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }>;
}

export function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinitionLike>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool(tool: ToolDefinitionLike) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerShortcut() {},
    sendMessage() {},
    appendEntry() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  async function emit(event: string, payload: object, ctx: object): Promise<unknown> {
    let result: unknown;
    for (const h of handlers.get(event) ?? []) {
      const r = await h({ type: event, ...payload }, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }
  return { pi: pi as unknown as ExtensionAPI, emit, tools };
}

export function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/fake-project",
    ui: {
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => {},
      setStatus: () => {},
      custom: async () => null,
    },
    sessionManager: {
      getSessionFile: () => "/tmp/fake-sessions/abc12345-session.jsonl",
      getEntries: () => [],
    },
    ...overrides,
  };
}
```

- [ ] **Step 5: Write the scaffold test**

`tests/scaffold.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";

test("package.json lists exactly the four phase-1 extensions", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.pi.extensions, [
    "./extensions/permission-gate/index.ts",
    "./extensions/attention-notify/index.ts",
    "./extensions/ask-user-question/index.ts",
    "./extensions/startup-check/index.ts",
  ]);
});

test("typebox is importable in tests", () => {
  const schema = Type.Object({ a: Type.String() });
  assert.equal(schema.type, "object");
});

test("fake pi collects handlers and returns the last defined result", async () => {
  const { pi, emit } = createFakePi();
  pi.on("tool_call" as any, async () => undefined);
  pi.on("tool_call" as any, async () => ({ block: true, reason: "x" }));
  const result = await emit("tool_call", { toolName: "bash", input: {} }, fakeCtx());
  assert.deepEqual(result, { block: true, reason: "x" });
});
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: 3 tests pass; `tsc` exits 0.

- [ ] **Step 7: Commit (only if authorised)**

```bash
git add package.json package-lock.json tsconfig.json tests/
git commit -m "chore: scaffold pi package with test harness"
```

---

### Task 2: Config loader, schema and template

**Files:**
- Create: `lib/config.ts`
- Create: `config.schema.json`
- Create: `templates/adonis-pi.json`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `interface AdonisPiConfig { agentsMd: string; permissionGate: { mode: "ask" | "block"; denyCommands: string[]; protectedPaths: string[] }; notify: { command: string | undefined; kinds: { confirm: boolean; fail: boolean; idle: boolean }; idleDelaySeconds: number }; askUserQuestion: { enabled: boolean } }`
  - `agentDir(env?: NodeJS.ProcessEnv): string` — `$PI_CODING_AGENT_DIR` expanded, else `~/.pi/agent`
  - `expandTilde(p: string): string`
  - `resolveEnvRef(value: unknown, env?: NodeJS.ProcessEnv): unknown` — `"$VAR"` / `"${VAR}"` → env value or `undefined`
  - `loadTemplate(): AdonisPiConfig`
  - `loadConfig(opts?: { path?: string; env?: NodeJS.ProcessEnv }): AdonisPiConfig` — throws `ConfigError` on invalid file
  - `class ConfigError extends Error`

- [ ] **Step 1: Write the template**

`templates/adonis-pi.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/Adonis0123/adonis-pi/main/config.schema.json",
  "agentsMd": "",
  "permissionGate": {
    "mode": "ask",
    "denyCommands": [
      "^\\s*(\\w+=\\S*\\s+)*((env|command|exec|nohup|time)\\s+)*sudo\\b",
      "^\\s*rm\\s+(\\S+\\s+)*(/|~|\\$HOME)(/\\*)?/?(\\s|$)",
      "^\\s*git\\s+(-C\\s+\\S+\\s+)?push\\b.*(\\s(--force|--force-with-lease)\\b|\\s-[a-zA-Z]*f[a-zA-Z]*\\b|\\s\\+\\S+)",
      "^\\s*chmod\\s+(-R\\s+)?0?777\\b",
      "^\\s*dd\\s+if="
    ],
    "protectedPaths": ["~/.ssh/**", "~/.aws/**"]
  },
  "notify": {
    "command": "$ADONIS_PI_NOTIFY_CMD",
    "kinds": { "confirm": true, "fail": true, "idle": false },
    "idleDelaySeconds": 60
  },
  "askUserQuestion": { "enabled": true }
}
```

`notify.kinds.idle: true` requires `confirm: true`; the notifier classifies confirm-vs-idle from the same Stop event, so idle alone cannot be honoured.

- [ ] **Step 2: Write the JSON Schema (editor aid, mirrors the validator)**

`config.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "adonis-pi config",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string" },
    "agentsMd": { "type": "string", "description": "Path to the AGENTS.md that pin setup links into the account dir. Empty = not linked." },
    "permissionGate": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "mode": { "enum": ["ask", "block"] },
        "denyCommands": { "type": "array", "items": { "type": "string" } },
        "protectedPaths": { "type": "array", "items": { "type": "string" } }
      }
    },
    "notify": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "command": { "type": "string", "description": "Notifier executable. Use \"$VAR\" to read from the environment." },
        "kinds": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "confirm": { "type": "boolean" },
            "fail": { "type": "boolean" },
            "idle": { "type": "boolean" }
          }
        },
        "idleDelaySeconds": { "type": "integer", "minimum": 0 }
      }
    },
    "askUserQuestion": {
      "type": "object",
      "additionalProperties": false,
      "properties": { "enabled": { "type": "boolean" } }
    }
  }
}
```

- [ ] **Step 3: Write the failing tests**

`tests/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { agentDir, expandTilde, resolveEnvRef, loadTemplate, loadConfig, ConfigError } from "../lib/config.ts";

test("agentDir honours PI_CODING_AGENT_DIR and expands ~", () => {
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/.pi-002/agent" }), join(homedir(), ".pi-002/agent"));
  assert.equal(agentDir({}), join(homedir(), ".pi", "agent"));
});

test("expandTilde only touches a leading ~", () => {
  assert.equal(expandTilde("~/x"), join(homedir(), "x"));
  assert.equal(expandTilde("/a/~/x"), "/a/~/x");
});

test("resolveEnvRef resolves $VAR and ${VAR}, leaves plain strings", () => {
  const env = { FOO: "bar" };
  assert.equal(resolveEnvRef("$FOO", env), "bar");
  assert.equal(resolveEnvRef("${FOO}", env), "bar");
  assert.equal(resolveEnvRef("$MISSING", env), undefined);
  assert.equal(resolveEnvRef("literal", env), "literal");
  assert.equal(resolveEnvRef(3, env), 3);
});

test("loadTemplate returns the shipped defaults with ask mode", () => {
  const t = loadTemplate();
  assert.equal(t.permissionGate.mode, "ask");
  assert.equal(t.notify.kinds.idle, false);
  assert.equal(t.agentsMd, "");
});

test("loadConfig merges account file over template and resolves env refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, JSON.stringify({ agentsMd: "~/rules.md", notify: { kinds: { idle: true } } }));
  const cfg = loadConfig({ path: file, env: { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh" } });
  assert.equal(cfg.agentsMd, join(homedir(), "rules.md"));
  assert.equal(cfg.notify.command, "/opt/notify.sh");
  assert.equal(cfg.notify.kinds.idle, true);
  assert.equal(cfg.notify.kinds.confirm, true);
  assert.equal(cfg.permissionGate.denyCommands.length, 5);
});

test("loadConfig with a missing file returns the template", () => {
  const cfg = loadConfig({ path: "/nonexistent/adonis-pi.json", env: {} });
  assert.equal(cfg.permissionGate.mode, "ask");
  assert.equal(cfg.notify.command, undefined);
});

test("loadConfig rejects an invalid mode with ConfigError naming the field", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, JSON.stringify({ permissionGate: { mode: "yolo" } }));
  assert.throws(() => loadConfig({ path: file, env: {} }), (e: unknown) => e instanceof ConfigError && /permissionGate\.mode/.test((e as Error).message));
});

test("loadConfig rejects idle without confirm", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, JSON.stringify({ notify: { kinds: { confirm: false, idle: true } } }));
  assert.throws(() => loadConfig({ path: file, env: {} }), (e: unknown) => e instanceof ConfigError && /idle requires/.test((e as Error).message));
});

test("loadConfig rejects malformed JSON with ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, "{ not json");
  assert.throws(() => loadConfig({ path: file, env: {} }), ConfigError);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx tsx --test tests/config.test.ts`
Expected: FAIL, cannot find module `../lib/config.ts`.

- [ ] **Step 5: Implement lib/config.ts**

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PermissionGateConfig {
  mode: "ask" | "block";
  denyCommands: string[];
  protectedPaths: string[];
}
export interface NotifyConfig {
  command: string | undefined;
  kinds: { confirm: boolean; fail: boolean; idle: boolean };
  idleDelaySeconds: number;
}
export interface AdonisPiConfig {
  agentsMd: string;
  permissionGate: PermissionGateConfig;
  notify: NotifyConfig;
  askUserQuestion: { enabled: boolean };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`adonis-pi config: ${message}`);
    this.name = "ConfigError";
  }
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.PI_CODING_AGENT_DIR;
  return v ? expandTilde(v) : join(homedir(), ".pi", "agent");
}

const ENV_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

export function resolveEnvRef(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value !== "string") return value;
  const m = ENV_REF.exec(value);
  if (!m) return value;
  return env[m[1]];
}

const TEMPLATE_PATH = fileURLToPath(new URL("../templates/adonis-pi.json", import.meta.url));

export function loadTemplate(): AdonisPiConfig {
  const raw = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
  delete raw.$schema;
  return raw as AdonisPiConfig;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k] as Json, v) : v;
  }
  return out;
}

function expectType(path: string, value: unknown, type: "string" | "boolean" | "number" | "string[]"): void {
  const ok =
    type === "string[]"
      ? Array.isArray(value) && value.every((x) => typeof x === "string")
      : typeof value === type;
  if (!ok) throw new ConfigError(`${path} must be ${type}`);
}

function validate(raw: Json): asserts raw is Json & AdonisPiConfig {
  const known = ["agentsMd", "permissionGate", "notify", "askUserQuestion"];
  for (const k of Object.keys(raw)) {
    if (!known.includes(k)) throw new ConfigError(`unknown key "${k}"`);
  }
  expectType("agentsMd", raw.agentsMd, "string");
  const pg = raw.permissionGate as Json;
  if (!isObject(pg)) throw new ConfigError("permissionGate must be an object");
  if (pg.mode !== "ask" && pg.mode !== "block") throw new ConfigError('permissionGate.mode must be "ask" or "block"');
  expectType("permissionGate.denyCommands", pg.denyCommands, "string[]");
  expectType("permissionGate.protectedPaths", pg.protectedPaths, "string[]");
  for (const re of pg.denyCommands as string[]) {
    try {
      new RegExp(re);
    } catch {
      throw new ConfigError(`permissionGate.denyCommands contains an invalid regex: ${re}`);
    }
  }
  const n = raw.notify as Json;
  if (!isObject(n)) throw new ConfigError("notify must be an object");
  if (n.command !== undefined) expectType("notify.command", n.command, "string");
  const kinds = n.kinds as Json;
  if (!isObject(kinds)) throw new ConfigError("notify.kinds must be an object");
  for (const k of ["confirm", "fail", "idle"]) expectType(`notify.kinds.${k}`, kinds[k], "boolean");
  if (kinds.idle === true && kinds.confirm !== true) throw new ConfigError("notify.kinds.idle requires notify.kinds.confirm (the notifier decides confirm-vs-idle from the same Stop event)");
  expectType("notify.idleDelaySeconds", n.idleDelaySeconds, "number");
  const aq = raw.askUserQuestion as Json;
  if (!isObject(aq)) throw new ConfigError("askUserQuestion must be an object");
  expectType("askUserQuestion.enabled", aq.enabled, "boolean");
}

export function loadConfig(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): AdonisPiConfig {
  const env = opts.env ?? process.env;
  const path = opts.path ?? join(agentDir(env), "adonis-pi.json");
  const template = loadTemplate() as unknown as Json;
  let merged: Json = template;
  if (existsSync(path)) {
    let account: unknown;
    try {
      account = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ConfigError(`${path} is not valid JSON (${(e as Error).message})`);
    }
    if (!isObject(account)) throw new ConfigError(`${path} must contain a JSON object`);
    delete account.$schema;
    merged = deepMerge(template, account);
  }
  validate(merged);
  const cfg = merged as AdonisPiConfig;
  const command = resolveEnvRef(cfg.notify.command, env);
  cfg.notify.command = typeof command === "string" && command.length > 0 ? expandTilde(command) : undefined;
  const agentsMd = resolveEnvRef(cfg.agentsMd, env);
  cfg.agentsMd = typeof agentsMd === "string" ? expandTilde(agentsMd) : "";
  return cfg;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/config.test.ts && npm run typecheck`
Expected: 9 tests pass.

- [ ] **Step 7: Commit (only if authorised)**

```bash
git add lib/config.ts config.schema.json templates/adonis-pi.json tests/config.test.ts
git commit -m "feat(config): single config entry with template defaults and env refs"
```

---

### Task 3: Notifier bridge (`lib/notify.ts`)

**Files:**
- Create: `lib/notify.ts`
- Create: `tests/fixtures/capture-notify.sh`
- Test: `tests/notify.test.ts`

**Interfaces:**
- Consumes: `NotifyConfig` from Task 2.
- Produces:
  - `interface SessionRef { sessionId: string; cwd: string }`
  - `sessionRef(ctx: { cwd: string; sessionManager: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } }): SessionRef` — prefers `getSessionId()`, falls back to the session file basename, then `"nosession"`
  - `buildPayload(kind: "question" | "permission" | "fail" | "stop" | "mark", ref: SessionRef, extra: Record<string, unknown>): Record<string, unknown>`
  - `classifyError(message: string): "authentication_failed" | "billing_error" | "model_not_found" | undefined`
  - `sendNotify(notify: NotifyConfig, args: string[], payload: Record<string, unknown>, opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): boolean` — returns `false` when `notify.command` is unset (nothing spawned); the child env is `filterEnv(env)`
  - `filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv` — drops keys ending in `_API_KEY` / `_AUTH_TOKEN` and keys starting with `ANTHROPIC_` / `OPENAI_`
  - `lastAssistantText(messages: ReadonlyArray<{ role: string; content?: unknown; stopReason?: string; errorMessage?: string }>): { text: string; stopReason?: string; errorMessage?: string } | undefined`

- [ ] **Step 1: Write the capture fixture**

`tests/fixtures/capture-notify.sh` (make executable with `chmod +x`):

```sh
#!/bin/sh
# Test double for the notifier: records argv and stdin into $CAPTURE_FILE.
{
  printf 'ARGS %s\n' "$*"
  printf 'STDIN '
  cat
  printf '\nENV AGENT_ATTENTION_IDLE=%s AGENT_ATTENTION_IDLE_DELAY=%s\n' "${AGENT_ATTENTION_IDLE:-}" "${AGENT_ATTENTION_IDLE_DELAY:-}"
  printf 'SECRETS %s\n' "$(env | grep -E '(_API_KEY|_AUTH_TOKEN)=|^(ANTHROPIC|OPENAI)_' | cut -d= -f1 | sort | tr '\n' ' ')"
} >> "$CAPTURE_FILE"
```

- [ ] **Step 2: Write the failing tests**

`tests/notify.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { buildPayload, classifyError, filterEnv, sendNotify, sessionRef, lastAssistantText } from "../lib/notify.ts";

const CAPTURE = fileURLToPath(new URL("./fixtures/capture-notify.sh", import.meta.url));
const notifyCfg = (command: string | undefined, idle = false) => ({
  command,
  kinds: { confirm: true, fail: true, idle },
  idleDelaySeconds: 45,
});

async function waitFor(file: string) {
  // The fixture writes several lines; SECRETS is the last one, so wait for it instead of the file's existence.
  for (let i = 0; i < 100; i++) {
    if (existsSync(file) && readFileSync(file, "utf8").includes("SECRETS")) break;
    await sleep(20);
  }
  return readFileSync(file, "utf8");
}

test("sessionRef prefers getSessionId, then the session file basename, then nosession", () => {
  assert.equal(sessionRef({ cwd: "/p", sessionManager: { getSessionId: () => "sid-1", getSessionFile: () => "/s/x.jsonl" } }).sessionId, "sid-1");
  const ref = sessionRef({ cwd: "/p", sessionManager: { getSessionFile: () => "/s/2026-09-22T10-00-00_abc.jsonl" } });
  assert.equal(ref.sessionId, "2026-09-22T10-00-00_abc");
  assert.equal(ref.cwd, "/p");
  assert.equal(sessionRef({ cwd: "/p", sessionManager: {} }).sessionId, "nosession");
});

test("filterEnv strips provider secrets and keeps everything else", () => {
  const out = filterEnv({ GLM_API_KEY: "a", KIMI_API_KEY: "b", ANTHROPIC_AUTH_TOKEN: "c", OPENAI_BASE_URL: "d", ADONIS_PI_NOTIFY_CMD: "/n", PATH: "/bin", HOME: "/h" });
  assert.deepEqual(out, { ADONIS_PI_NOTIFY_CMD: "/n", PATH: "/bin", HOME: "/h" });
});

test("buildPayload emits Claude-dialect hook JSON per kind", () => {
  const ref = { sessionId: "s1", cwd: "/p" };
  assert.deepEqual(buildPayload("question", ref, { tool_input: { questions: [{ question: "A or B?" }] } }), {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/p", tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "A or B?" }] },
  });
  assert.deepEqual(buildPayload("permission", ref, { tool_name: "bash", tool_input: { command: "sudo x" } }), {
    hook_event_name: "PermissionRequest", session_id: "s1", cwd: "/p", tool_name: "bash", tool_input: { command: "sudo x" },
  });
  assert.deepEqual(buildPayload("fail", ref, { error: "billing_error", error_details: "402" }), {
    hook_event_name: "StopFailure", session_id: "s1", cwd: "/p", error: "billing_error", error_details: "402",
  });
  assert.deepEqual(buildPayload("stop", ref, { last_assistant_message: "done?" }), {
    hook_event_name: "Stop", session_id: "s1", cwd: "/p", last_assistant_message: "done?",
  });
  assert.deepEqual(buildPayload("mark", ref, { tool_name: "read" }), {
    hook_event_name: "PostToolUse", session_id: "s1", cwd: "/p", tool_name: "read",
  });
});

test("classifyError maps actionable provider errors and ignores transient ones", () => {
  assert.equal(classifyError("401 Unauthorized: invalid api key"), "authentication_failed");
  assert.equal(classifyError("HTTP 403 forbidden"), "authentication_failed");
  assert.equal(classifyError("402 insufficient balance"), "billing_error");
  assert.equal(classifyError("You exceeded your current quota"), "billing_error");
  assert.equal(classifyError("model k3-9m does not exist"), "model_not_found");
  assert.equal(classifyError("429 rate limit exceeded"), undefined);
  assert.equal(classifyError("500 overloaded"), undefined);
});

test("lastAssistantText joins text blocks of the last assistant message", () => {
  const r = lastAssistantText([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "text", text: "b" }], stopReason: "stop" },
    { role: "toolResult", content: [] },
  ]);
  assert.deepEqual(r, { text: "a\nb", stopReason: "stop", errorMessage: undefined });
  assert.equal(lastAssistantText([{ role: "user", content: "x" }]), undefined);
});

test("sendNotify spawns the command with --agent pi, pipes JSON, passes idle env, strips secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-notify-"));
  const file = join(dir, "capture.txt");
  const env = { ...process.env, CAPTURE_FILE: file, GLM_API_KEY: "leak", ANTHROPIC_API_KEY: "leak2" };
  const sent = sendNotify(notifyCfg(CAPTURE, true), ["--agent", "pi", "--mark"], { hook_event_name: "PostToolUse" }, { env });
  assert.equal(sent, true);
  const out = await waitFor(file);
  assert.match(out, /^ARGS --agent pi --mark$/m);
  assert.match(out, /^STDIN \{"hook_event_name":"PostToolUse"\}$/m);
  assert.match(out, /^ENV AGENT_ATTENTION_IDLE=1 AGENT_ATTENTION_IDLE_DELAY=45$/m);
  assert.match(out, /^SECRETS $/m);
});

test("sendNotify is a no-op when the command is unset", () => {
  assert.equal(sendNotify(notifyCfg(undefined), ["--agent", "pi"], {}), false);
});

test("sendNotify swallows a missing executable instead of throwing", () => {
  assert.equal(sendNotify(notifyCfg("/nonexistent/notifier"), ["--agent", "pi"], {}), true);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test tests/notify.test.ts`
Expected: FAIL, cannot find module `../lib/notify.ts`.

- [ ] **Step 4: Implement lib/notify.ts**

```ts
import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { NotifyConfig } from "./config.ts";

export interface SessionRef {
  sessionId: string;
  cwd: string;
}

export type PayloadKind = "question" | "permission" | "fail" | "stop" | "mark";

const EVENT_NAME: Record<PayloadKind, string> = {
  question: "PreToolUse",
  permission: "PermissionRequest",
  fail: "StopFailure",
  stop: "Stop",
  mark: "PostToolUse",
};

export function sessionRef(ctx: {
  cwd: string;
  sessionManager: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined };
}): SessionRef {
  const id = ctx.sessionManager.getSessionId?.();
  if (id) return { sessionId: id, cwd: ctx.cwd };
  const file = ctx.sessionManager.getSessionFile?.();
  const sessionId = file ? basename(file).replace(/\.jsonl$/, "") : "nosession";
  return { sessionId, cwd: ctx.cwd };
}

const SECRET_KEY = /(_API_KEY|_AUTH_TOKEN)$|^(ANTHROPIC|OPENAI)_/;

export function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_KEY.test(k)) out[k] = v;
  return out;
}

export function buildPayload(kind: PayloadKind, ref: SessionRef, extra: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = { hook_event_name: EVENT_NAME[kind], session_id: ref.sessionId, cwd: ref.cwd };
  if (kind === "question") base.tool_name = "AskUserQuestion";
  return { ...base, ...extra };
}

export function classifyError(message: string): "authentication_failed" | "billing_error" | "model_not_found" | undefined {
  const m = message.toLowerCase();
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|authentication|invalid[ _]api[ _]key/.test(m)) return "authentication_failed";
  if (/\b402\b|insufficient|quota|billing|balance|payment/.test(m)) return "billing_error";
  if (/model\b.*\b(not found|does not exist|not exist|unknown)|\b404\b.*model/.test(m)) return "model_not_found";
  return undefined;
}

interface MessageLike {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

export function lastAssistantText(messages: ReadonlyArray<MessageLike>): { text: string; stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const blocks = Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : [];
    const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
    return { text, stopReason: m.stopReason, errorMessage: m.errorMessage };
  }
  return undefined;
}

export function sendNotify(
  notify: NotifyConfig,
  args: string[],
  payload: Record<string, unknown>,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): boolean {
  if (!notify.command) return false;
  const env = {
    ...filterEnv(opts.env ?? process.env),
    AGENT_ATTENTION_IDLE: notify.kinds.idle ? "1" : "0",
    AGENT_ATTENTION_IDLE_DELAY: String(notify.idleDelaySeconds),
  };
  try {
    const child = spawn(notify.command, args, { stdio: ["pipe", "ignore", "ignore"], detached: true, env });
    child.on("error", () => {});
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, opts.timeoutMs ?? 10_000);
    child.on("exit", () => clearTimeout(timer));
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
    child.unref();
  } catch {
    // Never let a notifier failure reach the agent loop.
  }
  return true;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `chmod +x tests/fixtures/capture-notify.sh && npx tsx --test tests/notify.test.ts && npm run typecheck`
Expected: 8 tests pass.

- [ ] **Step 6: Commit (only if authorised)**

```bash
git add lib/notify.ts tests/notify.test.ts tests/fixtures/capture-notify.sh
git commit -m "feat(notify): Claude-dialect hook payloads piped to an external notifier"
```

---

### Task 4: Permission gate extension

**Files:**
- Create: `extensions/permission-gate/index.ts`
- Create: `extensions/permission-gate/match.ts`
- Create: `lib/runtime-config.ts`
- Test: `tests/permission-gate.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `loadTemplate`, `ConfigError`, `expandTilde` (Task 2); `sendNotify`, `buildPayload`, `sessionRef` (Task 3); `createFakePi`, `fakeCtx` (Task 1).
- Produces:
  - `lib/runtime-config.ts`: `getRuntimeConfig(ctx: { hasUI: boolean; ui: { notify(msg: string, level: "info" | "warning" | "error"): void } }): AdonisPiConfig` — loads once per process, falls back to template on `ConfigError`, warns once through `ctx.ui.notify`. `resetRuntimeConfigForTests(): void`.
  - `extensions/permission-gate/match.ts`: `globToRegExp(glob: string): RegExp`; `segments(command: string): string[]` — splits on newlines, `;`, `&&`, `||`, `|`, and additionally yields the quoted body of `sh -c '…'` / `bash -c "…"` / `zsh -c` wrappers; `matchToolCall(event: { toolName: string; input: Record<string, unknown> }, cfg: PermissionGateConfig, cwd: string): { reason: string; detail: string } | undefined` — each deny regex is tested against every segment.

- [ ] **Step 1: Write the failing tests**

`tests/permission-gate.test.ts`:

```ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";
import { globToRegExp, matchToolCall, segments } from "../extensions/permission-gate/match.ts";
import { loadTemplate } from "../lib/config.ts";
import { resetRuntimeConfigForTests } from "../lib/runtime-config.ts";
import permissionGate from "../extensions/permission-gate/index.ts";

const CAPTURE = fileURLToPath(new URL("./fixtures/capture-notify.sh", import.meta.url));
const gate = () => loadTemplate().permissionGate;

beforeEach(() => resetRuntimeConfigForTests());

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
  const passes = ["git push origin feature", "rm -rf node_modules", "rm -rf ./build/", "rm -rf /tmp/x", "rm -rf ~/x", "echo sudo", "grep sudo README.md", "chmod 755 bin/pin"];
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

test("block mode from an account config blocks even with UI, and a broken config warns once and falls back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-gate-"));
  writeFileSync(join(dir, "adonis-pi.json"), JSON.stringify({ permissionGate: { mode: "block" } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { pi, emit } = createFakePi();
    permissionGate(pi);
    const r = (await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, fakeCtx())) as { block: boolean };
    assert.equal(r.block, true);

    resetRuntimeConfigForTests();
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

test("asking sends a PermissionRequest notification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-gate-"));
  const capture = join(dir, "capture.txt");
  writeFileSync(join(dir, "adonis-pi.json"), JSON.stringify({ notify: { command: CAPTURE } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CAPTURE_FILE = capture;
  try {
    const { pi, emit } = createFakePi();
    permissionGate(pi);
    await emit("tool_call", { toolName: "bash", input: { command: "sudo ls" } }, fakeCtx());
    const { readFileSync, existsSync } = await import("node:fs");
    const { setTimeout: sleep } = await import("node:timers/promises");
    for (let i = 0; i < 50 && !existsSync(capture); i++) await sleep(20);
    const out = readFileSync(capture, "utf8");
    assert.match(out, /"hook_event_name":"PermissionRequest"/);
    assert.match(out, /"tool_name":"bash"/);
    assert.match(out, /"tool_input":\{"command":"sudo ls"\}/);
    assert.match(out, /^ARGS --agent pi$/m);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.CAPTURE_FILE;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/permission-gate.test.ts`
Expected: FAIL, cannot find module `../extensions/permission-gate/match.ts`.

- [ ] **Step 3: Implement lib/runtime-config.ts**

```ts
import { ConfigError, loadConfig, loadTemplate, type AdonisPiConfig } from "./config.ts";

let cached: AdonisPiConfig | undefined;
let warned = false;

export function getRuntimeConfig(ctx: { hasUI: boolean; ui: { notify(msg: string, level: "info" | "warning" | "error"): void } }): AdonisPiConfig {
  if (cached) return cached;
  try {
    cached = loadConfig();
  } catch (e) {
    cached = loadTemplate();
    if (!warned && ctx.hasUI) {
      warned = true;
      const msg = e instanceof ConfigError ? e.message : `adonis-pi config: ${(e as Error).message}`;
      ctx.ui.notify(`${msg} — using template defaults`, "warning");
    }
  }
  return cached;
}

export function resetRuntimeConfigForTests(): void {
  cached = undefined;
  warned = false;
}
```

- [ ] **Step 4: Implement extensions/permission-gate/match.ts**

```ts
import { isAbsolute, resolve } from "node:path";
import { expandTilde, type PermissionGateConfig } from "../../lib/config.ts";

export function globToRegExp(glob: string): RegExp {
  const expanded = expandTilde(glob);
  let re = "";
  for (let i = 0; i < expanded.length; i++) {
    const c = expanded[i];
    if (c === "*") {
      if (expanded[i + 1] === "*") {
        re += ".*";
        i++;
        if (expanded[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const PATH_TOOLS = new Set(["write", "edit"]);
const SEPARATOR = /\r?\n|;|&&|\|\||\|/;
const SHELL_C = /\b(?:ba|z|da)?sh\s+-[a-zA-Z]*c[a-zA-Z]*\s+(['"])([\s\S]*?)\1/g;

/**
 * Split a command into the pieces a deny rule should see: each separated command, plus the body of
 * any `sh -c '…'` wrapper (recursively). Wrapper bodies are masked before splitting so a `|` inside
 * the quotes does not break the quoted text; the outer pieces keep their original wording.
 */
export function segments(command: string): string[] {
  const out: string[] = [];
  const wrappers: { token: string; original: string; body: string }[] = [];
  const masked = command.replace(SHELL_C, (original, _quote: string, body: string) => {
    const token = `\u0000${wrappers.length}\u0000`;
    wrappers.push({ token, original, body });
    return token;
  });
  for (const part of masked.split(SEPARATOR)) {
    if (part.trim().length === 0) continue;
    let text = part;
    for (const w of wrappers) text = text.replace(w.token, w.original);
    out.push(text);
  }
  for (const w of wrappers) out.push(...segments(w.body));
  return out;
}

export function matchToolCall(
  event: { toolName: string; input: Record<string, unknown> },
  cfg: PermissionGateConfig,
  cwd: string,
): { reason: string; detail: string } | undefined {
  if (event.toolName === "bash") {
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const pieces = segments(command);
    for (const pattern of cfg.denyCommands) {
      const re = new RegExp(pattern);
      const hit = pieces.find((piece) => re.test(piece));
      if (hit !== undefined) {
        return { reason: `command matches denyCommands /${pattern}/`, detail: hit.trim() };
      }
    }
    return undefined;
  }
  if (PATH_TOOLS.has(event.toolName)) {
    const raw = typeof event.input.path === "string" ? event.input.path : typeof event.input.file_path === "string" ? event.input.file_path : "";
    if (!raw) return undefined;
    const expanded = expandTilde(raw);
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    for (const glob of cfg.protectedPaths) {
      if (globToRegExp(glob).test(abs)) {
        return { reason: `path matches protectedPaths ${glob}`, detail: abs };
      }
    }
  }
  return undefined;
}
```

- [ ] **Step 5: Implement extensions/permission-gate/index.ts**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRuntimeConfig } from "../../lib/runtime-config.ts";
import { buildPayload, sendNotify, sessionRef } from "../../lib/notify.ts";
import { matchToolCall } from "./match.ts";

export default function permissionGate(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const cfg = getRuntimeConfig(ctx);
    const hit = matchToolCall({ toolName: event.toolName, input: event.input as Record<string, unknown> }, cfg.permissionGate, ctx.cwd);
    if (!hit) return;

    if (cfg.permissionGate.mode === "block" || !ctx.hasUI) {
      return { block: true, reason: `adonis-pi permission gate: ${hit.reason}` };
    }

    if (cfg.notify.kinds.confirm) {
      const input = event.input as Record<string, unknown>;
      const summary = typeof input.command === "string" ? { command: input.command.slice(0, 200) } : typeof input.path === "string" ? { path: input.path } : {};
      sendNotify(cfg.notify, ["--agent", "pi"], buildPayload("permission", sessionRef(ctx), { tool_name: event.toolName, tool_input: summary }));
    }
    const allowed = await ctx.ui.confirm("Permission gate", `${hit.reason}\n\n${hit.detail}\n\nAllow this call?`);
    if (!allowed) {
      return { block: true, reason: `User denied: ${hit.reason}` };
    }
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/permission-gate.test.ts && npm run typecheck`
Expected: 10 tests pass. If `tsc` complains that `event.input` is not indexable for some union members, keep the `as Record<string, unknown>` cast and move on. The deny list is a mistake guard: `segments()` does not evaluate shell, so `$(echo sudo) x` or aliases still pass; the spec says so.

- [ ] **Step 7: Smoke-load in real pi (no config yet)**

Run: `cd /tmp && npx --yes @earendil-works/pi-coding-agent --no-extensions -e ~/coding/adonis-pi/extensions/permission-gate/index.ts -p "say ok" 2>&1 | tail -5`
Expected: pi starts and prints a reply, no extension load error. (If `-p` requires a provider login, the load error check still holds: any `Failed to load extension` line fails this step.)

- [ ] **Step 8: Commit (only if authorised)**

```bash
git add lib/runtime-config.ts extensions/permission-gate tests/permission-gate.test.ts
git commit -m "feat(permission-gate): config-driven deny rules with ask/block modes"
```

---

### Task 5: `AskUserQuestion` tool extension

**Files:**
- Create: `extensions/ask-user-question/index.ts`
- Create: `extensions/ask-user-question/state.ts`
- Create: `extensions/ask-user-question/ui.ts`
- Test: `tests/ask-user-question.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers, `getRuntimeConfig` (Task 4), `sendNotify`/`buildPayload`/`sessionRef` (Task 3).
- Produces:
  - `state.ts`: `interface QuestionInput { header?: string; question: string; options: { label: string; description?: string }[]; multiSelect?: boolean }`; `interface QuestionState { cursor: number; checked: Set<number>; editing: boolean; draft: string }`; `type Key = "up" | "down" | "space" | "enter" | "escape"`; `initialState(): QuestionState`; `reduce(q: QuestionInput, s: QuestionState, key: Key): { state: QuestionState; done?: Answer | null }`; `interface Answer { selected: string[]; custom?: string }`; `OTHER_LABEL = "Other (type your own)"`.
  - `ui.ts`: `askOne(ctx: ExtensionContextLike, q: QuestionInput, index: number, total: number): Promise<Answer | null>` — TUI panel via `ctx.ui.custom`; `askOneRpc(ctx, q, index, total): Promise<Answer | null>` — fallback for `hasUI && mode !== "tui"` (RPC) using `ctx.ui.select` (rows rendered as `label — description`) plus `ctx.ui.input` for the Other entry; a multi-select question degrades to one pick and the returned `Answer.note` says so, which `formatAnswers` appends and `details` carries.
  - `index.ts`: default export registering tool `AskUserQuestion`; `formatAnswers(questions: QuestionInput[], answers: (Answer | null)[]): string`.

- [ ] **Step 1: Write the failing tests**

`tests/ask-user-question.test.ts`:

```ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";
import { initialState, reduce, OTHER_LABEL, type QuestionInput } from "../extensions/ask-user-question/state.ts";
import askUserQuestion, { formatAnswers } from "../extensions/ask-user-question/index.ts";
import { resetRuntimeConfigForTests } from "../lib/runtime-config.ts";

beforeEach(() => resetRuntimeConfigForTests());

const single: QuestionInput = { header: "Approach", question: "Which?", options: [{ label: "A" }, { label: "B", description: "slower" }] };
const multi: QuestionInput = { ...single, multiSelect: true };

test("single-select: down + enter returns the second option", () => {
  let s = initialState();
  s = reduce(single, s, "down").state;
  const r = reduce(single, s, "enter");
  assert.deepEqual(r.done, { selected: ["B"] });
});

test("single-select: enter on the trailing Other opens the editor; escape closes it, escape again cancels", () => {
  let s = initialState();
  s = reduce(single, s, "down").state;
  s = reduce(single, s, "down").state; // cursor on Other (index 2)
  let r = reduce(single, s, "enter");
  assert.equal(r.state.editing, true);
  assert.equal(r.done, undefined);
  r = reduce(single, r.state, "escape");
  assert.equal(r.state.editing, false);
  r = reduce(single, r.state, "escape");
  assert.equal(r.done, null);
});

test("multi-select: space toggles, enter with selections returns them in option order", () => {
  let s = initialState();
  s = reduce(multi, s, "space").state; // A
  s = reduce(multi, s, "down").state;
  s = reduce(multi, s, "space").state; // B
  s = reduce(multi, s, "up").state;
  s = reduce(multi, s, "space").state; // untoggle A
  s = reduce(multi, s, "space").state; // toggle A again
  const r = reduce(multi, s, "enter");
  assert.deepEqual(r.done, { selected: ["A", "B"] });
});

test("multi-select: enter with nothing checked does not finish (Review Focus 3)", () => {
  const r = reduce(multi, initialState(), "enter");
  assert.equal(r.done, undefined);
  assert.equal(r.state.editing, false);
});

test("cursor is clamped to [0, options.length] where the last slot is Other", () => {
  let s = initialState();
  s = reduce(single, s, "up").state;
  assert.equal(s.cursor, 0);
  for (let i = 0; i < 10; i++) s = reduce(single, s, "down").state;
  assert.equal(s.cursor, 2);
});

test("formatAnswers writes one line per question with header, joins multi answers, marks custom", () => {
  const text = formatAnswers([single, multi, single], [{ selected: ["A"] }, { selected: ["A", "B"] }, { selected: [], custom: "C please" }]);
  assert.equal(text, ["Q1 Approach: A", "Q2 Approach: A, B", `Q3 Approach: ${OTHER_LABEL} — C please`].join("\n"));
});

test("tool registers as AskUserQuestion with a Claude-compatible schema", () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const tool = tools.get("AskUserQuestion");
  assert.ok(tool);
  const schema = tool!.parameters as any;
  assert.equal(schema.properties.questions.type, "array");
  const q = schema.properties.questions.items.properties;
  assert.ok(q.question && q.options && q.header && q.multiSelect);
});

test("non-UI mode returns an error text and null answers", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single] }, undefined, undefined, fakeCtx({ mode: "print", hasUI: false }));
  assert.match(r.content[0].text!, /not available/i);
  assert.doesNotMatch(r.content[0].text!, /recommended/i);
  assert.deepEqual((r.details as any).answers, [null]);
});

test("RPC mode (hasUI but no TUI) falls back to ctx.ui.select and never calls custom", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  let customCalls = 0;
  const ctx = fakeCtx({ mode: "rpc", hasUI: true, ui: { ...fakeCtx().ui, custom: async () => { customCalls++; return null; }, select: async () => "B" } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single] }, undefined, undefined, ctx);
  assert.equal(customCalls, 0);
  assert.equal(r.content[0].text, "Q1 Approach: B");
});

test("RPC mode Other goes through ctx.ui.input", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const ctx = fakeCtx({ mode: "rpc", hasUI: true, ui: { ...fakeCtx().ui, select: async () => OTHER_LABEL, input: async () => "C please" } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single] }, undefined, undefined, ctx);
  assert.equal(r.content[0].text, `Q1 Approach: ${OTHER_LABEL} — C please`);
});

test("RPC mode shows descriptions in the select rows and marks a degraded multi-select in content and details", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  let rows: string[] = [];
  const ctx = fakeCtx({ mode: "rpc", hasUI: true, ui: { ...fakeCtx().ui, select: async (_t: string, options: string[]) => { rows = options; return "B — slower"; } } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [multi] }, undefined, undefined, ctx);
  assert.deepEqual(rows, ["A", "B — slower", OTHER_LABEL]);
  assert.equal(r.content[0].text, "Q1 Approach: B (single pick; multi-select unavailable in this mode)");
  assert.equal((r.details as any).answers[0].note, "single pick; multi-select unavailable in this mode");
});

test("UI mode asks each question through ctx.ui.custom in order and formats the result", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const scripted = [{ selected: ["B"] }, { selected: ["A", "B"] }];
  let calls = 0;
  const ctx = fakeCtx({ ui: { ...fakeCtx().ui, custom: async () => scripted[calls++] } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single, multi] }, undefined, undefined, ctx);
  assert.equal(calls, 2);
  assert.equal(r.content[0].text, "Q1 Approach: B\nQ2 Approach: A, B");
});

test("a cancelled question stops the sequence and reports it", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const ctx = fakeCtx({ ui: { ...fakeCtx().ui, custom: async () => null } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single, multi] }, undefined, undefined, ctx);
  assert.match(r.content[0].text!, /cancelled/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/ask-user-question.test.ts`
Expected: FAIL, cannot find module `../extensions/ask-user-question/state.ts`.

- [ ] **Step 3: Implement state.ts (pure, no pi-tui)**

```ts
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionInput {
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}
export interface Answer {
  selected: string[];
  custom?: string;
  /** Set when the answer was collected in a degraded way (e.g. RPC single pick for a multi-select). */
  note?: string;
}
export interface QuestionState {
  cursor: number;
  checked: Set<number>;
  editing: boolean;
  draft: string;
}
export type Key = "up" | "down" | "space" | "enter" | "escape";

export const OTHER_LABEL = "Other (type your own)";

export function initialState(): QuestionState {
  return { cursor: 0, checked: new Set(), editing: false, draft: "" };
}

export function otherIndex(q: QuestionInput): number {
  return q.options.length;
}

export function reduce(q: QuestionInput, s: QuestionState, key: Key): { state: QuestionState; done?: Answer | null } {
  const other = otherIndex(q);
  if (s.editing) {
    if (key === "escape") return { state: { ...s, editing: false, draft: "" } };
    if (key === "enter") {
      const custom = s.draft.trim();
      if (!custom) return { state: { ...s, editing: false, draft: "" } };
      return { state: s, done: { selected: selectedLabels(q, s), custom } };
    }
    return { state: s };
  }
  switch (key) {
    case "up":
      return { state: { ...s, cursor: Math.max(0, s.cursor - 1) } };
    case "down":
      return { state: { ...s, cursor: Math.min(other, s.cursor + 1) } };
    case "space": {
      if (!q.multiSelect || s.cursor === other) return { state: s };
      const checked = new Set(s.checked);
      checked.has(s.cursor) ? checked.delete(s.cursor) : checked.add(s.cursor);
      return { state: { ...s, checked } };
    }
    case "enter": {
      if (s.cursor === other) return { state: { ...s, editing: true } };
      if (!q.multiSelect) return { state: s, done: { selected: [q.options[s.cursor].label] } };
      if (s.checked.size === 0) return { state: s };
      return { state: s, done: { selected: selectedLabels(q, s) } };
    }
    case "escape":
      return { state: s, done: null };
  }
}

function selectedLabels(q: QuestionInput, s: QuestionState): string[] {
  return [...s.checked].sort((a, b) => a - b).map((i) => q.options[i].label);
}

/** Text typed into the editor is fed through here (not a Key). */
export function setDraft(s: QuestionState, draft: string): QuestionState {
  return { ...s, draft };
}
```

- [ ] **Step 4: Implement ui.ts (pi-tui component built on the reducer; adapted from pi's `examples/extensions/question.ts`)**

```ts
import { Editor, type EditorTheme, Key as TuiKey, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { initialState, OTHER_LABEL, otherIndex, reduce, setDraft, type Answer, type Key, type QuestionInput, type QuestionState } from "./state.ts";

interface UiLike {
  ui: { custom<T>(factory: (tui: any, theme: any, kb: any, done: (v: T) => void) => any): Promise<T> };
}

export function askOne(ctx: UiLike, q: QuestionInput, index: number, total: number): Promise<Answer | null> {
  return ctx.ui.custom<Answer | null>((tui, theme, _kb, done) => {
    let state: QuestionState = initialState();
    let cached: string[] | undefined;

    const editorTheme: EditorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);
    editor.onSubmit = (value: string) => step("enter", value);

    function refresh() {
      cached = undefined;
      tui.requestRender();
    }

    function step(key: Key, draft?: string) {
      if (draft !== undefined) state = setDraft(state, draft);
      const r = reduce(q, state, key);
      state = r.state;
      if (r.done !== undefined) {
        done(r.done);
        return;
      }
      if (!state.editing) editor.setText("");
      refresh();
    }

    function handleInput(data: string) {
      if (state.editing) {
        if (matchesKey(data, TuiKey.escape)) return step("escape");
        editor.handleInput(data);
        state = setDraft(state, editor.getText());
        refresh();
        return;
      }
      if (matchesKey(data, TuiKey.up)) return step("up");
      if (matchesKey(data, TuiKey.down)) return step("down");
      if (matchesKey(data, TuiKey.enter)) return step("enter");
      if (matchesKey(data, TuiKey.escape)) return step("escape");
      if (data === " ") return step("space");
    }

    function render(width: number): string[] {
      if (cached) return cached;
      const w = Math.max(1, width);
      const lines: string[] = [];
      const add = (prefix: string, text: string) => {
        const pw = visibleWidth(prefix);
        const wrapped = wrapTextWithAnsi(text, Math.max(1, w - pw));
        wrapped.forEach((l: string, i: number) => lines.push(`${i === 0 ? prefix : " ".repeat(pw)}${l}`));
      };
      lines.push(theme.fg("accent", "─".repeat(w)));
      const title = `${q.header ? `${q.header} · ` : ""}(${index + 1}/${total})`;
      add(" ", theme.fg("muted", title));
      add(" ", theme.fg("text", q.question));
      lines.push("");
      const rows = [...q.options.map((o) => o.label), OTHER_LABEL];
      rows.forEach((label, i) => {
        const isOther = i === otherIndex(q);
        const cursor = i === state.cursor ? theme.fg("accent", "> ") : "  ";
        const box = q.multiSelect && !isOther ? (state.checked.has(i) ? "[x] " : "[ ] ") : "";
        const color = i === state.cursor ? "accent" : "text";
        add(cursor, theme.fg(color, `${box}${i + 1}. ${label}${isOther && state.editing ? " ✎" : ""}`));
        const desc = q.options[i]?.description;
        if (desc) add("     ", theme.fg("muted", desc));
      });
      if (state.editing) {
        lines.push("");
        add(" ", theme.fg("muted", "Your answer:"));
        for (const l of editor.render(Math.max(1, w - 2))) lines.push(` ${l}`);
      }
      lines.push("");
      const hint = state.editing
        ? "Enter to submit • Esc to go back"
        : q.multiSelect
          ? "↑↓ move • Space toggle • Enter confirm • Esc cancel"
          : "↑↓ move • Enter select • Esc cancel";
      add(" ", theme.fg("dim", hint));
      lines.push(theme.fg("accent", "─".repeat(w)));
      cached = lines;
      return lines;
    }

    return { render, invalidate: () => (cached = undefined), handleInput };
  });
}

/** RPC fallback: dialogs exist (select/input) but custom panels do not. */
export async function askOneRpc(
  ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined>; input(title: string, placeholder?: string): Promise<string | undefined> } },
  q: QuestionInput,
  index: number,
  total: number,
): Promise<Answer | null> {
  const note = q.multiSelect ? "single pick; multi-select unavailable in this mode" : undefined;
  const title = `${q.header ? `${q.header} · ` : ""}(${index + 1}/${total}) ${q.question}${note ? ` [${note}]` : ""}`;
  const rows = q.options.map((o) => (o.description ? `${o.label} — ${o.description}` : o.label));
  const picked = await ctx.ui.select(title, [...rows, OTHER_LABEL]);
  if (picked === undefined) return null;
  if (picked !== OTHER_LABEL) {
    const idx = rows.indexOf(picked);
    const label = idx >= 0 ? q.options[idx].label : picked;
    return note ? { selected: [label], note } : { selected: [label] };
  }
  const custom = await ctx.ui.input("Your answer");
  if (custom === undefined || custom.trim() === "") return null;
  return note ? { selected: [], custom: custom.trim(), note } : { selected: [], custom: custom.trim() };
}
```

`Editor.getText()` exists on pi-tui 0.87 (verified by the Grok review against the type declarations).

- [ ] **Step 5: Implement index.ts**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../lib/runtime-config.ts";
import { buildPayload, sendNotify, sessionRef } from "../../lib/notify.ts";
import { OTHER_LABEL, type Answer, type QuestionInput } from "./state.ts";
import { askOne, askOneRpc } from "./ui.ts";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Short explanation shown under the label" })),
});
const QuestionSchema = Type.Object({
  header: Type.Optional(Type.String({ description: "Very short topic label, max ~12 chars" })),
  question: Type.String({ description: "The complete question, ending with a question mark" }),
  options: Type.Array(OptionSchema, { description: "2-4 mutually exclusive choices; an Other/free-text entry is added automatically" }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing several options" })),
});
const Params = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, description: "Questions asked one after another" }),
});

interface Details {
  answers: (Answer | null)[];
}

export function formatAnswers(questions: QuestionInput[], answers: (Answer | null)[]): string {
  return questions
    .map((q, i) => {
      const a = answers[i];
      const label = q.header ?? q.question;
      if (!a) return `Q${i + 1} ${label}: (cancelled)`;
      const parts = [...a.selected];
      if (a.custom !== undefined) parts.push(`${OTHER_LABEL} — ${a.custom}`);
      return `Q${i + 1} ${label}: ${parts.join(", ")}${a.note ? ` (${a.note})` : ""}`;
    })
    .join("\n");
}

export default function askUserQuestion(pi: ExtensionAPI) {
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask user",
    description:
      "Ask the user one or more structured questions and wait for their choices. Use it when a decision is the user's to make and the options are known. Each question shows its options plus a free-text entry.",
    promptSnippet: "Ask the user to choose between concrete options",
    parameters: Params,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const questions = params.questions as QuestionInput[];
      const cfg = getRuntimeConfig(ctx);
      if (!ctx.hasUI || !cfg.askUserQuestion.enabled) {
        return {
          content: [{ type: "text", text: "Error: AskUserQuestion UI not available (non-interactive mode or disabled). Ask the question in plain text and stop; do not choose for the user." }],
          details: { answers: questions.map(() => null) } as Details,
        };
      }
      const ask = ctx.mode === "tui" ? askOne : askOneRpc;
      if (cfg.notify.kinds.confirm) {
        sendNotify(cfg.notify, ["--agent", "pi"], buildPayload("question", sessionRef(ctx), { tool_input: { questions: questions.map((q) => ({ question: q.question, header: q.header })) } }));
      }
      const answers: (Answer | null)[] = [];
      for (let i = 0; i < questions.length; i++) {
        const a = await ask(ctx as any, questions[i], i, questions.length);
        answers.push(a);
        if (a === null) {
          while (answers.length < questions.length) answers.push(null);
          return {
            content: [{ type: "text", text: `User cancelled at question ${i + 1}.\n${formatAnswers(questions, answers)}` }],
            details: { answers } as Details,
          };
        }
      }
      return { content: [{ type: "text", text: formatAnswers(questions, answers) }], details: { answers } as Details };
    },
  });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/ask-user-question.test.ts && npm run typecheck`
Expected: 13 tests pass. `promptSnippet` and `executionMode: "sequential"` are present in the 0.87 `ToolDefinition` type (verified by both peer reviews). Since pi 0.86 `details` must be JSON-compatible: `Answer` objects carry `custom` / `note` only when set (never an `undefined` value), which the code above already guarantees; keep it that way.

- [ ] **Step 7: Commit (only if authorised)**

The manual TUI check needs a logged-in provider and therefore runs as Task 7 Step 8.

```bash
git add extensions/ask-user-question tests/ask-user-question.test.ts
git commit -m "feat(ask-user-question): Claude-compatible structured question tool"
```

---

### Task 6: Attention notify extension

**Files:**
- Create: `extensions/attention-notify/index.ts`
- Test: `tests/attention-notify.test.ts`

**Interfaces:**
- Consumes: `getRuntimeConfig` (Task 4); `sendNotify`, `buildPayload`, `sessionRef`, `classifyError`, `lastAssistantText` (Task 3); Task 1 helpers.
- Produces: `lastAssistantFromBranch(entries: ReadonlyArray<{ type: string; message?: { role: string; content?: unknown; stopReason?: string; errorMessage?: string } }>)` and `decideSettled(entries, kinds): { kind: "fail"; error: string; details: string } | { kind: "stop"; text: string } | undefined` (both exported for tests).
- Why `agent_settled` and not `agent_end`: `agent_end` fires after every low-level run, including runs that pi will immediately retry or continue; `agent_settled` fires once when nothing more will happen automatically (confirmed against pi 0.87 by both peer reviews). `agent_settled` carries no messages, so the last assistant message is read from `ctx.sessionManager.getBranch()`.

- [ ] **Step 1: Write the failing tests**

`tests/attention-notify.test.ts`:

```ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";
import attentionNotify, { decideSettled, lastAssistantFromBranch } from "../extensions/attention-notify/index.ts";
import { resetRuntimeConfigForTests } from "../lib/runtime-config.ts";

const CAPTURE = fileURLToPath(new URL("./fixtures/capture-notify.sh", import.meta.url));
const kinds = { confirm: true, fail: true, idle: false };
const asst = (text: string, stopReason = "stop", errorMessage?: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const toolResult = () => ({ type: "message", message: { role: "toolResult", content: [] } });

beforeEach(() => resetRuntimeConfigForTests());

test("lastAssistantFromBranch picks the last assistant message entry, ignoring later tool results and non-message entries", () => {
  const entries = [user("hi"), asst("first"), toolResult(), asst("second"), toolResult(), { type: "custom", customType: "x" }];
  assert.deepEqual(lastAssistantFromBranch(entries), { text: "second", stopReason: "stop", errorMessage: undefined });
  assert.equal(lastAssistantFromBranch([user("hi")]), undefined);
});

test("decideSettled: actionable provider error → fail", () => {
  assert.deepEqual(decideSettled([asst("", "error", "401 invalid api key")], kinds), { kind: "fail", error: "authentication_failed", details: "401 invalid api key" });
});

test("decideSettled: transient error or user abort → nothing (Review Focus 4)", () => {
  assert.equal(decideSettled([asst("", "error", "429 rate limit")], kinds), undefined);
  assert.equal(decideSettled([asst("", "error", "500 overloaded, retrying")], kinds), undefined);
  assert.equal(decideSettled([asst("partial", "aborted")], kinds), undefined);
});

test("decideSettled: normal end → stop with the last assistant text", () => {
  assert.deepEqual(decideSettled([asst("first"), toolResult(), asst("需要你拍板\n选 A？")], kinds), { kind: "stop", text: "需要你拍板\n选 A？" });
});

test("decideSettled: kinds gate both branches; Stop is sent only when confirm is on", () => {
  assert.equal(decideSettled([asst("", "error", "401")], { ...kinds, fail: false }), undefined);
  assert.equal(decideSettled([asst("done")], { confirm: false, fail: true, idle: false }), undefined);
  assert.equal(decideSettled([asst("需要你拍板\n选？")], { confirm: false, fail: true, idle: true }), undefined);
  assert.deepEqual(decideSettled([asst("done")], { confirm: true, fail: true, idle: true }), { kind: "stop", text: "done" });
});

async function withCapture(run: (capture: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-attn-"));
  const capture = join(dir, "capture.txt");
  writeFileSync(join(dir, "adonis-pi.json"), JSON.stringify({ notify: { command: CAPTURE } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CAPTURE_FILE = capture;
  try {
    await run(capture);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.CAPTURE_FILE;
  }
}
async function read(capture: string) {
  for (let i = 0; i < 50 && !existsSync(capture); i++) await sleep(20);
  return existsSync(capture) ? readFileSync(capture, "utf8") : "";
}
const ctxWithBranch = (entries: unknown[], overrides: Record<string, unknown> = {}) =>
  fakeCtx({ sessionManager: { ...fakeCtx().sessionManager, getBranch: () => entries }, ...overrides });

test("agent_settled sends Stop with last_assistant_message in TUI mode", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("agent_settled", {}, ctxWithBranch([user("go"), asst("all done?")]));
    const out = await read(capture);
    assert.match(out, /"hook_event_name":"Stop"/);
    assert.match(out, /"last_assistant_message":"all done\?"/);
    assert.match(out, /^ARGS --agent pi$/m);
  });
});

test("agent_settled sends StopFailure with a mapped error code", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("agent_settled", {}, ctxWithBranch([asst("", "error", "402 insufficient balance")]));
    const out = await read(capture);
    assert.match(out, /"hook_event_name":"StopFailure"/);
    assert.match(out, /"error":"billing_error"/);
  });
});

test("agent_end sends nothing (only agent_settled reports)", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("agent_end", { messages: [] }, ctxWithBranch([asst("mid-run")]));
    await sleep(150);
    assert.equal(existsSync(capture), false);
  });
});

test("tool_result marks activity with --mark and PostToolUse", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("tool_result", { toolName: "read", toolCallId: "c1", content: [] }, fakeCtx());
    const out = await read(capture);
    assert.match(out, /^ARGS --agent pi --mark$/m);
    assert.match(out, /"hook_event_name":"PostToolUse"/);
    assert.match(out, /"tool_name":"read"/);
  });
});

test("nothing is sent outside TUI mode", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("agent_settled", {}, ctxWithBranch([asst("x")], { mode: "print", hasUI: false }));
    await emit("tool_result", { toolName: "read" }, fakeCtx({ mode: "rpc", hasUI: true }));
    await sleep(150);
    assert.equal(existsSync(capture), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/attention-notify.test.ts`
Expected: FAIL, cannot find module `../extensions/attention-notify/index.ts`.

- [ ] **Step 3: Implement the extension**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRuntimeConfig } from "../../lib/runtime-config.ts";
import { buildPayload, classifyError, lastAssistantText, sendNotify, sessionRef } from "../../lib/notify.ts";

type Kinds = { confirm: boolean; fail: boolean; idle: boolean };
type Decision = { kind: "fail"; error: string; details: string } | { kind: "stop"; text: string } | undefined;
interface BranchEntry {
  type: string;
  message?: { role: string; content?: unknown; stopReason?: string; errorMessage?: string };
}

export function lastAssistantFromBranch(entries: ReadonlyArray<BranchEntry>) {
  const messages = entries.filter((e) => e.type === "message" && e.message).map((e) => e.message!);
  return lastAssistantText(messages);
}

export function decideSettled(entries: ReadonlyArray<BranchEntry>, kinds: Kinds): Decision {
  const last = lastAssistantFromBranch(entries);
  if (!last) return undefined;
  if (last.stopReason === "aborted") return undefined; // the user interrupted; nobody is waiting on a notification
  if (last.stopReason === "error") {
    if (!kinds.fail) return undefined;
    const code = classifyError(last.errorMessage ?? "");
    return code ? { kind: "fail", error: code, details: last.errorMessage ?? "" } : undefined;
  }
  // The notifier turns one Stop into either confirm or idle; with confirm off we cannot send Stop at all
  // (config validation already rejects idle-without-confirm).
  if (!kinds.confirm) return undefined;
  return { kind: "stop", text: last.text };
}

export default function attentionNotify(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const cfg = getRuntimeConfig(ctx);
    sendNotify(cfg.notify, ["--agent", "pi", "--mark"], buildPayload("mark", sessionRef(ctx), { tool_name: (event as { toolName?: string }).toolName ?? "unknown" }));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const cfg = getRuntimeConfig(ctx);
    const entries = (ctx.sessionManager as { getBranch?: () => BranchEntry[] }).getBranch?.() ?? [];
    const d = decideSettled(entries, cfg.notify.kinds);
    if (!d) return;
    if (d.kind === "fail") {
      sendNotify(cfg.notify, ["--agent", "pi"], buildPayload("fail", sessionRef(ctx), { error: d.error, error_details: d.details.slice(0, 500) }));
    } else {
      sendNotify(cfg.notify, ["--agent", "pi"], buildPayload("stop", sessionRef(ctx), { last_assistant_message: d.text.slice(-4000) }));
    }
  });
}
```

The branch entry shape (`type: "message"`, `message.role`) is what pi's session format documents; confirm the field names against `node_modules/@earendil-works/pi-coding-agent/dist/**/*.d.ts` (`SessionEntry`) when running this task and adjust the `BranchEntry` type if they differ. The notifier decides between confirm (heading `需要你拍板`, `❓ Qn` rounds, trailing question) and idle from `last_assistant_message`; idle stays opt-in through `AGENT_ATTENTION_IDLE`, which `sendNotify` sets from `kinds.idle`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/attention-notify.test.ts && npm test && npm run typecheck`
Expected: all suites pass.

- [ ] **Step 5: Commit (only if authorised)**

```bash
git add extensions/attention-notify tests/attention-notify.test.ts
git commit -m "feat(attention-notify): report settled runs and activity to the notifier"
```

---

### Task 6b: Startup check extension

**Files:**
- Create: `extensions/startup-check/index.ts`
- Test: `tests/startup-check.test.ts`

**Interfaces:**
- Consumes: `agentDir`, `expandTilde` (Task 2); Task 1 helpers.
- Produces: `envRefs(modelsJsonText: string): string[]` — every distinct `VAR` referenced as `"$VAR"` / `"${VAR}"` in `models.json`, sorted; `missingEnvRefs(modelsJsonText: string, env: NodeJS.ProcessEnv): string[]` — the subset that is unset or empty in `env`. Default export registers a `session_start` handler.
- Why: pi resolves `apiKey: "$VAR"` from its own environment. Only `pin` sources `proxy.env`, so `pi` started directly (Orca, muscle memory) has no GLM/Kimi key and fails on the first request with a bare provider error. One warning at startup names the variables and the fix.

- [ ] **Step 1: Write the failing tests**

`tests/startup-check.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";
import startupCheck, { envRefs, missingEnvRefs } from "../extensions/startup-check/index.ts";

const models = JSON.stringify({
  providers: {
    glm: { apiKey: "$GLM_API_KEY", models: [] },
    kimi: { apiKey: "${KIMI_API_KEY}", models: [] },
    local: { apiKey: "literal-key", models: [] },
  },
});

test("envRefs lists each $VAR once, sorted, ignoring literal keys", () => {
  assert.deepEqual(envRefs(models), ["GLM_API_KEY", "KIMI_API_KEY"]);
  assert.deepEqual(envRefs("{ not json"), []);
});

test("missingEnvRefs treats empty strings as missing", () => {
  assert.deepEqual(missingEnvRefs(models, { GLM_API_KEY: "x", KIMI_API_KEY: "" }), ["KIMI_API_KEY"]);
  assert.deepEqual(missingEnvRefs(models, { GLM_API_KEY: "x", KIMI_API_KEY: "y" }), []);
});

async function withAgentDir(modelsText: string | undefined, env: Record<string, string>, run: (notes: string[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-start-"));
  if (modelsText !== undefined) writeFileSync(join(dir, "models.json"), modelsText);
  const saved = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.GLM_API_KEY;
  delete process.env.KIMI_API_KEY;
  Object.assign(process.env, env);
  try {
    const notes: string[] = [];
    await run(notes);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("session_start at startup warns once with the missing variables and the pin hint", async () => {
  await withAgentDir(models, { GLM_API_KEY: "x" }, async () => {
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /KIMI_API_KEY/);
    assert.doesNotMatch(notes[0], /GLM_API_KEY/);
    assert.match(notes[0], /pin <n>/);
  });
});

test("nothing is said when every variable is set, on reload, without UI, or without models.json", async () => {
  await withAgentDir(models, { GLM_API_KEY: "x", KIMI_API_KEY: "y" }, async () => {
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(notes, []);
  });
  await withAgentDir(models, {}, async () => {
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } });
    await emit("session_start", { reason: "reload" }, ctx);
    await emit("session_start", { reason: "startup" }, fakeCtx({ hasUI: false, mode: "print", ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } }));
    assert.deepEqual(notes, []);
  });
  await withAgentDir(undefined, {}, async () => {
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    await emit("session_start", { reason: "startup" }, fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } }));
    assert.deepEqual(notes, []);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/startup-check.test.ts`
Expected: FAIL, cannot find module `../extensions/startup-check/index.ts`.

- [ ] **Step 3: Implement the extension**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../../lib/config.ts";

const ENV_REF = /"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"/g;

export function envRefs(modelsJsonText: string): string[] {
  try {
    JSON.parse(modelsJsonText);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const m of modelsJsonText.matchAll(ENV_REF)) found.add(m[1]);
  return [...found].sort();
}

export function missingEnvRefs(modelsJsonText: string, env: NodeJS.ProcessEnv): string[] {
  return envRefs(modelsJsonText).filter((v) => !env[v]);
}

export default function startupCheck(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || !ctx.hasUI) return;
    const file = join(agentDir(), "models.json");
    if (!existsSync(file)) return;
    const missing = missingEnvRefs(readFileSync(file, "utf8"), process.env);
    if (missing.length === 0) return;
    ctx.ui.notify(
      `adonis-pi: models.json needs ${missing.join(", ")} but the environment does not set ${missing.length === 1 ? "it" : "them"}. Launch through \`pin <n>\` so proxy.env is loaded.`,
      "warning",
    );
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/startup-check.test.ts && npm run typecheck`
Expected: 4 tests pass.

- [ ] **Step 5: Commit (only if authorised)**

```bash
git add extensions/startup-check tests/startup-check.test.ts
git commit -m "feat(startup-check): warn when models.json env refs are unset"
```

---

### Task 7: Templates and `bin/pin` launcher

**Files:**
- Create: `templates/settings.json`
- Create: `templates/models.json`
- Create: `templates/proxy.env.example`
- Create: `bin/pin`
- Create: `bin/lib/settings-packages.mjs`
- Create: `bin/lib/drift.mjs`
- Create: `bin/lib/read-field.mjs`
- Test: `tests/pin.test.ts`

**Interfaces:**
- Produces CLI: `pin <n> [pi args…]`, `pin setup <n>`, `pin doctor <n>` (exit 1 on any `FAIL`), env `PIN_DRY_RUN=1` makes launch print `PI_CODING_AGENT_DIR=<dir>`, one `<VAR>=<set>|<unset>` line per secret variable (never the value), `ARGS …`, and exit 0 without exec.
- Node helpers (invoked by `pin`, argv-only, print to stdout):
  - `settings-packages.mjs <settings.json> <package-abs-path> [--check]` — adds the path to `packages` if absent, rewriting with the file's own indentation (detected from the first indented line; default 2 spaces) and preserving every other key; prints `added` or `present`. With `--check` it writes nothing and prints `present` or `absent` (doctor uses this instead of grepping the file text).
  - `drift.mjs <account-file> <template-file>` — walks both objects recursively and prints one line per dotted key path missing in the account file (`missing permissionGate.denyCommands`) and per unknown path (`extra bogus`); arrays are compared as leaves; `$schema` and `packages` are skipped; exit 0 always.
  - `read-field.mjs <json-file> <dot.path>` — prints the string value or empty.

- [ ] **Step 1: Write templates**

`templates/settings.json` (`enableInstallTelemetry` is on by default in pi; this package turns it off for its accounts):

```json
{
  "packages": [],
  "defaultProvider": "openai-codex",
  "quietStartup": true,
  "enableInstallTelemetry": false
}
```

`templates/models.json` (figures from the provider docs on 2026-09-22: GLM-5.3 1M context / 128K output per docs.bigmodel.cn; Kimi K3 1M context, `max_completion_tokens` default 131072 per platform.kimi.ai. `k3-256k` and `kimi-for-coding` context sizes are inferred from their names and stay `UNVERIFIED`):

```json
{
  "providers": {
    "glm": {
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "api": "anthropic-messages",
      "apiKey": "$GLM_API_KEY",
      "models": [
        { "id": "glm-5.3", "name": "GLM 5.3", "reasoning": true, "input": ["text"], "contextWindow": 1000000, "maxTokens": 131072 }
      ]
    },
    "kimi": {
      "baseUrl": "https://api.kimi.com/coding/v1",
      "api": "anthropic-messages",
      "apiKey": "$KIMI_API_KEY",
      "models": [
        { "id": "k3-1m", "name": "Kimi K3 1M", "reasoning": true, "input": ["text"], "contextWindow": 1000000, "maxTokens": 131072 },
        { "id": "k3-256k", "name": "Kimi K3 256K", "reasoning": true, "input": ["text"], "contextWindow": 262144, "maxTokens": 131072 },
        { "id": "kimi-for-coding", "name": "Kimi for Coding", "reasoning": true, "input": ["text"], "contextWindow": 262144, "maxTokens": 131072 }
      ]
    }
  }
}
```

`templates/proxy.env.example`:

```sh
# adonis-pi secret layer. Copy to $PI_CODING_AGENT_DIR/proxy.env and chmod 600.
# Only `pin` reads this file; values reach pi as environment variables.
export GLM_API_KEY=
export KIMI_API_KEY=
# Path to your notifier (see adonis-pi.json notify.command). Leave empty to disable notifications.
export ADONIS_PI_NOTIFY_CMD=
```

- [ ] **Step 2: Write the failing tests**

`tests/pin.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const PIN = join(ROOT, "bin", "pin");

function env(home: string, extra: Record<string, string> = {}) {
  const fakeBin = join(home, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "pi"), '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo "${FAKE_PI_VERSION:-0.87.0}"; exit 0; fi\nprintf "FAKE_PI %s\\n" "$*"\nenv | grep "^PI_CODING_AGENT_DIR=" || true\n');
  chmodSync(join(fakeBin, "pi"), 0o755);
  return { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, ...extra };
}
function pin(home: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("sh", [PIN, ...args], { env: env(home, extra), encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("setup 1 materialises templates into ~/.pi/agent and registers the package", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  const r = pin(home, ["setup", "1"]);
  assert.equal(r.code, 0, r.out);
  const agent = join(home, ".pi", "agent");
  for (const f of ["settings.json", "models.json", "adonis-pi.json", "proxy.env"]) assert.ok(existsSync(join(agent, f)), f);
  assert.deepEqual(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).packages, [ROOT]);
  assert.equal(lstatSync(join(agent, "proxy.env")).mode & 0o777, 0o600);
  assert.match(r.out, /agentsMd is empty/);
});

test("setup 2 uses ~/.pi-002/agent", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  assert.equal(pin(home, ["setup", "2"]).code, 0);
  assert.ok(existsSync(join(home, ".pi-002", "agent", "settings.json")));
});

test("setup never overwrites an existing account file (Review Focus 5)", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const settings = join(home, ".pi", "agent", "settings.json");
  const edited = JSON.stringify({ packages: [ROOT], defaultProvider: "glm", theme: "light" }, null, 2) + "\n";
  writeFileSync(settings, edited);
  const models = join(home, ".pi", "agent", "models.json");
  writeFileSync(models, "{\"providers\":{}}\n");
  pin(home, ["setup", "1"]);
  assert.equal(readFileSync(settings, "utf8"), edited);
  assert.equal(readFileSync(models, "utf8"), "{\"providers\":{}}\n");
});

test("setup adds a missing packages entry while keeping user keys and 4-space indentation", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const settings = join(home, ".pi", "agent", "settings.json");
  writeFileSync(settings, JSON.stringify({ defaultProvider: "glm", theme: "light" }, null, 4) + "\n");
  pin(home, ["setup", "1"]);
  const text = readFileSync(settings, "utf8");
  const json = JSON.parse(text);
  assert.deepEqual(json, { defaultProvider: "glm", theme: "light", packages: [ROOT] });
  assert.match(text, /^    "defaultProvider"/m);
  assert.doesNotMatch(text, /^  "/m);
});

test("setup links AGENTS.md when agentsMd is set and refuses to replace a real file", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  const rules = join(home, "rules.md");
  writeFileSync(rules, "# rules\n");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: rules }));
  assert.equal(pin(home, ["setup", "1"]).code, 0);
  assert.equal(readlinkSync(join(agent, "AGENTS.md")), rules);
  unlinkSync(join(agent, "AGENTS.md")); // writeFileSync would follow the link and overwrite rules.md
  writeFileSync(join(agent, "AGENTS.md"), "real file\n"); // now a real file where the link was
  const r = pin(home, ["setup", "1"]);
  assert.equal(readFileSync(rules, "utf8"), "# rules\n");
  assert.equal(readFileSync(join(agent, "AGENTS.md"), "utf8"), "real file\n");
  assert.match(r.out, /AGENTS.md is a regular file/);
});

test("doctor passes on a fresh setup and fails on a 644 proxy.env", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  let r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /^FAIL/m);
  chmodSync(join(home, ".pi", "agent", "proxy.env"), 0o644);
  r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL proxy.env mode/m);
});

test("doctor reports nested template drift and missing env refs as WARN", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "", bogus: 1, permissionGate: { mode: "ask" } }));
  const r = pin(home, ["doctor", "1"]);
  assert.match(r.out, /^WARN adonis-pi.json drift: .*extra bogus/m);
  assert.match(r.out, /^WARN adonis-pi.json drift: .*missing permissionGate.denyCommands/m);
  assert.match(r.out, /^WARN models.json references \$GLM_API_KEY but proxy.env leaves it empty/m);
});

test("doctor fails when settings.json lacks the packages entry (Review Focus 5)", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], note: ROOT }, null, 2)); // path present elsewhere must not count
  const r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL settings.json packages lacks/m);
});

test("doctor reports the pi version: OK on 0.87.x, WARN on anything else", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  assert.match(pin(home, ["doctor", "1"]).out, /^OK   pi 0\.87\.0 on PATH/m);
  const r = pin(home, ["doctor", "1"], { FAKE_PI_VERSION: "0.88.0" });
  assert.equal(r.code, 0);
  assert.match(r.out, /^WARN pi 0\.88\.0 differs from the tested 0\.87\.x/m);
});

test("launch sources proxy.env, exports PI_CODING_AGENT_DIR and execs pi with args", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "proxy.env"), "export GLM_API_KEY=abc\n");
  chmodSync(join(home, ".pi", "agent", "proxy.env"), 0o600);
  const r = pin(home, ["1", "--model", "glm/glm-5.3"], { PIN_DRY_RUN: "1" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`^PI_CODING_AGENT_DIR=${join(home, ".pi", "agent")}$`, "m"));
  assert.match(r.out, /^GLM_API_KEY=<set>$/m);
  assert.match(r.out, /^KIMI_API_KEY=<unset>$/m);
  assert.doesNotMatch(r.out, /abc/);
  assert.match(r.out, /^ARGS --model glm\/glm-5.3$/m);
});

test("launch refuses a world-readable proxy.env", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  chmodSync(join(home, ".pi", "agent", "proxy.env"), 0o644);
  const r = pin(home, ["1"], { PIN_DRY_RUN: "1" });
  assert.equal(r.code, 1);
  assert.match(r.out, /proxy.env must be mode 600/);
});

test("launch clears inherited provider env unless proxy.env sets it", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const r = pin(home, ["1"], { PIN_DRY_RUN: "1", ANTHROPIC_API_KEY: "leak", OPENAI_API_KEY: "leak2" });
  assert.match(r.out, /^ANTHROPIC_API_KEY=<unset>$/m);
  assert.match(r.out, /^OPENAI_API_KEY=<unset>$/m);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test tests/pin.test.ts`
Expected: FAIL, `bin/pin` not found.

- [ ] **Step 4: Write the node helpers**

`bin/lib/settings-packages.mjs`:

```js
import { readFileSync, writeFileSync } from "node:fs";
const [file, pkg, flag] = process.argv.slice(2);
const text = readFileSync(file, "utf8");
const json = JSON.parse(text);
const indentMatch = /^\n?([ \t]+)"/m.exec(text);
const indent = indentMatch ? indentMatch[1] : "  ";
json.packages = Array.isArray(json.packages) ? json.packages : [];
if (flag === "--check") {
  console.log(json.packages.includes(pkg) ? "present" : "absent");
} else if (json.packages.includes(pkg)) {
  console.log("present");
} else {
  json.packages.push(pkg);
  writeFileSync(file, JSON.stringify(json, null, indent) + (text.endsWith("\n") ? "\n" : ""));
  console.log("added");
}
```

`bin/lib/drift.mjs`:

```js
import { readFileSync } from "node:fs";
const [account, template] = process.argv.slice(2);
const a = JSON.parse(readFileSync(account, "utf8"));
const t = JSON.parse(readFileSync(template, "utf8"));
const skip = new Set(["$schema", "packages"]);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function walk(tpl, acc, prefix) {
  for (const k of Object.keys(tpl)) {
    if (skip.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in acc)) console.log(`missing ${path}`);
    else if (isObj(tpl[k]) && isObj(acc[k])) walk(tpl[k], acc[k], path);
  }
  for (const k of Object.keys(acc)) {
    if (skip.has(k)) continue;
    if (!(k in tpl)) console.log(`extra ${prefix ? `${prefix}.${k}` : k}`);
  }
}
walk(t, a, "");
```

`bin/lib/read-field.mjs`:

```js
import { readFileSync } from "node:fs";
const [file, path] = process.argv.slice(2);
let v = JSON.parse(readFileSync(file, "utf8"));
for (const k of path.split(".")) v = v?.[k];
process.stdout.write(typeof v === "string" ? v : "");
```

- [ ] **Step 5: Write bin/pin**

```sh
#!/bin/sh
# pin — launcher and account maintainer for pi (see docs/specs/2026-09-22-adonis-pi-phase1-design.md §3.4).
#   pin <n> [pi args...]   launch account n   (1 → ~/.pi/agent, n>=2 → ~/.pi-00n/agent)
#   pin setup <n>          materialise templates into the account (never overwrites)
#   pin doctor <n>         check the account; exit 1 on FAIL
set -eu

PIN_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEMPLATES="$PIN_ROOT/templates"
FAMILY=pi

usage() {
  sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'
}

account_dir() {
  case "$1" in
    1) printf '%s/.%s\n' "$HOME" "$FAMILY" ;;
    *) printf '%s/.%s-%03d\n' "$HOME" "$FAMILY" "$1" ;;
  esac
}
agent_dir() { printf '%s/agent\n' "$(account_dir "$1")"; }

mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
expand_tilde() { case "$1" in "~") printf '%s\n' "$HOME" ;; "~/"*) printf '%s/%s\n' "$HOME" "${1#\~/}" ;; *) printf '%s\n' "$1" ;; esac; }

copy_if_absent() { # template-name dest
  if [ -e "$2" ]; then echo "keep  $2"; else cp "$TEMPLATES/$1" "$2"; echo "write $2"; fi
}

do_setup() {
  d=$(agent_dir "$1")
  mkdir -p "$d"
  copy_if_absent settings.json "$d/settings.json"
  copy_if_absent models.json "$d/models.json"
  copy_if_absent adonis-pi.json "$d/adonis-pi.json"
  if [ ! -e "$d/proxy.env" ]; then
    umask 077; cp "$TEMPLATES/proxy.env.example" "$d/proxy.env"; umask 022
    echo "write $d/proxy.env (fill in your keys)"
  else
    echo "keep  $d/proxy.env"
  fi
  chmod 600 "$d/proxy.env"
  echo "packages: $(node "$PIN_ROOT/bin/lib/settings-packages.mjs" "$d/settings.json" "$PIN_ROOT")"
  agents_md=$(node "$PIN_ROOT/bin/lib/read-field.mjs" "$d/adonis-pi.json" agentsMd)
  if [ -z "$agents_md" ]; then
    echo "note  agentsMd is empty in $d/adonis-pi.json — set it to your shared AGENTS.md and rerun setup"
  else
    target=$(expand_tilde "$agents_md")
    if [ -e "$d/AGENTS.md" ] && [ ! -L "$d/AGENTS.md" ]; then
      echo "note  $d/AGENTS.md is a regular file; not replacing it"
    elif [ ! -e "$target" ]; then
      echo "note  agentsMd target $target does not exist; link not created"
    else
      ln -sfn "$target" "$d/AGENTS.md"; echo "link  $d/AGENTS.md -> $target"
    fi
  fi
}

do_doctor() {
  d=$(agent_dir "$1"); fails=0
  ok()   { echo "OK   $*"; }
  warn() { echo "WARN $*"; }
  fail() { echo "FAIL $*"; fails=$((fails + 1)); }
  [ -d "$d" ] || { fail "account dir $d missing (run: pin setup $1)"; echo; exit 1; }
  for f in settings.json models.json adonis-pi.json; do
    if [ -f "$d/$f" ]; then
      drift=$(node "$PIN_ROOT/bin/lib/drift.mjs" "$d/$f" "$TEMPLATES/$f" 2>/dev/null || echo "unparseable")
      if [ -z "$drift" ]; then ok "$f matches template keys"; else warn "$f drift: $(printf '%s' "$drift" | tr '\n' ',' | sed 's/,$//')"; fi
    else
      fail "$f missing"
    fi
  done
  if [ -f "$d/proxy.env" ]; then
    m=$(mode_of "$d/proxy.env")
    [ "$m" = "600" ] && ok "proxy.env mode 600" || fail "proxy.env mode is $m, must be 600"
    for var in $(grep -o '"\$[A-Z_][A-Z0-9_]*"' "$d/models.json" 2>/dev/null | tr -d '"$' | sort -u); do
      if grep -Eq "^export $var=.+" "$d/proxy.env"; then ok "models.json \$$var provided"; else warn "models.json references \$$var but proxy.env leaves it empty"; fi
    done
  else
    warn "proxy.env missing (API providers will not authenticate)"
  fi
  if [ "$(node "$PIN_ROOT/bin/lib/settings-packages.mjs" "$d/settings.json" "$PIN_ROOT" --check 2>/dev/null)" = "present" ]; then ok "settings.json packages includes $PIN_ROOT"; else fail "settings.json packages lacks $PIN_ROOT (run: pin setup $1)"; fi
  if [ -L "$d/AGENTS.md" ]; then
    [ -e "$d/AGENTS.md" ] && ok "AGENTS.md -> $(readlink "$d/AGENTS.md")" || fail "AGENTS.md is a dangling link"
  elif [ -f "$d/AGENTS.md" ]; then warn "AGENTS.md is a regular file (not shared)"
  else warn "AGENTS.md not linked (agentsMd empty?)"; fi
  if command -v pi >/dev/null 2>&1; then
    ver=$(pi --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    case "$ver" in
      0.87.*) ok "pi $ver on PATH ($(command -v pi))" ;;
      "") warn "pi found at $(command -v pi) but its version is unreadable" ;;
      *) warn "pi $ver differs from the tested 0.87.x; run npm test in the package after upgrading pi" ;;
    esac
  else
    fail "pi not on PATH (npm install -g @earendil-works/pi-coding-agent@0.87.0)"
  fi
  [ "$fails" -eq 0 ]
}

do_launch() {
  n=$1; shift
  d=$(agent_dir "$n")
  [ -d "$d" ] || { echo "pin: $d missing; run: pin setup $n" >&2; exit 1; }
  (
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL OPENAI_API_KEY OPENAI_BASE_URL
    if [ -f "$d/proxy.env" ]; then
      m=$(mode_of "$d/proxy.env")
      [ "$m" = "600" ] || { echo "pin: $d/proxy.env must be mode 600 (is $m)" >&2; exit 1; }
      set +u; . "$d/proxy.env"; set -u
    fi
    export PI_CODING_AGENT_DIR="$d"
    if [ "${PIN_DRY_RUN:-0}" = "1" ]; then
      echo "PI_CODING_AGENT_DIR=$d"
      for v in GLM_API_KEY KIMI_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY; do
        if eval "[ -n \"\${$v:-}\" ]"; then echo "$v=<set>"; else echo "$v=<unset>"; fi
      done
      printf 'ARGS %s\n' "$*"
      exit 0
    fi
    exec pi "$@"
  )
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  setup)  do_setup "${1:-1}" ;;
  doctor) do_doctor "${1:-1}" ;;
  ""|-h|--help) usage ;;
  *[!0-9]*) usage; exit 2 ;;
  *) do_launch "$cmd" "$@" ;;
esac
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `chmod +x bin/pin && npx tsx --test tests/pin.test.ts`
Expected: 12 tests pass. On macOS `stat -f '%Lp'` is used; the `stat -c` fallback covers Linux.

- [ ] **Step 7: Run setup for real on this machine and log in**

Run (pi itself was installed in Task 1 Step 3):
```sh
export PATH="<repo>/bin:$PATH"   # <repo> = wherever this repository is cloned; also add to your shell rc
pin setup 1
```
Expected: `keep ~/.pi/agent/proxy.env` if one already exists, `write` for the three JSON files, `note agentsMd is empty`. Then edit `~/.pi/agent/adonis-pi.json`: set `agentsMd` to your shared rules file; in `~/.pi/agent/proxy.env` set `ADONIS_PI_NOTIFY_CMD` to your notifier executable (machine-specific values live in the operator's private notes, not here); run `pin setup 1` again and confirm `link ~/.pi/agent/AGENTS.md -> …`. Run `pin doctor 1` → no `FAIL`. Launch `pin 1`, run `/login`, choose the ChatGPT/Codex provider, complete OAuth; then `/model` and confirm `glm/glm-5.3` and `kimi/k3-1m` are listed.

- [ ] **Step 8: Manual TUI check of AskUserQuestion (moved here from Task 5 because it needs the login above)**

Run `pin 1`, then type: `Use the AskUserQuestion tool to ask me whether I prefer A or B, header "Pick".`
Expected: the custom panel renders with `Pick · (1/1)`, arrow keys move, Enter selects, the tool result line reads `Q1 Pick: A` (or B). Then ask for a multi-select question and confirm Space toggles `[x]`, Enter with nothing checked keeps the panel open, Esc cancels. Also trigger the permission gate once: `run: sudo -n true` → the `Permission gate` confirm appears; answer No.

- [ ] **Step 9: Commit (only if authorised)**

```bash
git add templates bin tests/pin.test.ts
git commit -m "feat(pin): account launcher with setup, doctor and template materialisation"
```

---

### Task 8: Notifier contract tests for `--agent pi` and a real send

**Files:**
- Modify: the notifier's own test suite (lives with the notifier, outside this repo). The concrete file path and the exact commands for this machine are in the operator's private notes. If those notes are missing, stop and ask the operator; do not guess a path.

**Interfaces:**
- Consumes: payload shapes from Task 3 `buildPayload`. The notifier must classify them as: `PreToolUse`+`AskUserQuestion` → confirm/question; `PermissionRequest` → confirm/permission; `StopFailure` with an actionable `error` → fail; `Stop` whose `last_assistant_message` carries a decision heading, a `❓ Qn` round or a trailing question → confirm, otherwise idle (opt-in); `PostToolUse` with `--mark` → activity only.

- [ ] **Step 1: Add one test case per payload kind to the notifier's suite**

Use the notifier suite's own assertion helper. Payloads, verbatim (these are what Task 3 produces):

```json
{"hook_event_name":"PreToolUse","session_id":"p1","cwd":"/x/proj","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"选哪个？","header":"Pick"}]}}
{"hook_event_name":"PermissionRequest","session_id":"p1","cwd":"/x/proj","tool_name":"bash","tool_input":{"command":"git push --force"}}
{"hook_event_name":"StopFailure","session_id":"p1","cwd":"/x/proj","error":"authentication_failed","error_details":"401"}
{"hook_event_name":"Stop","session_id":"p1","cwd":"/x/proj","last_assistant_message":"改完了。\n\n需要你拍板\n要不要顺手删旧分支？"}
{"hook_event_name":"Stop","session_id":"p1","cwd":"/x/proj","last_assistant_message":"done"}
{"hook_event_name":"PostToolUse","session_id":"p1","cwd":"/x/proj","tool_name":"read"}
```

Each is invoked with `--agent pi` (the last one also with `--mark`). Expected classifications, in order: confirm/question (card quotes `选哪个？`), confirm/permission, fail, confirm/heading, idle skipped as opt-out, mark.

- [ ] **Step 2: Run the notifier suite**

Expected: green. A failure means the payload shape in Task 3 and the notifier's parser disagree; fix `buildPayload` first, the notifier second.

- [ ] **Step 3: Real send (the user asked for an actual delivery test)**

Run, with `ADONIS_PI_NOTIFY_CMD` exported from your `proxy.env`:
```sh
printf '%s' '{"hook_event_name":"PreToolUse","session_id":"pi-smoke","cwd":"'"$PWD"'","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"adonis-pi 提醒链路冒烟：收到请忽略","header":"Smoke"}]}}' \
  | "$ADONIS_PI_NOTIFY_CMD" --agent pi
```
Expected: the confirm notification arrives on the user's channel labelled `pi` with project `adonis-pi`. Ask the user to confirm receipt; record the timestamp in Task 9's verification file.

- [ ] **Step 4: Commit the notifier suite change in its own repo (only if authorised)**

### Task 9: Acceptance run V1–V7 in the user's main repo

**Files:**
- Create: `docs/verification/2026-09-phase1.md` (results; no absolute user paths, name the repo as “主仓”)

- [ ] **Step 1: Prepare**

Run: `cd <主仓> && git status --short | wc -l` — must be `0` (clean tree) before starting; otherwise stash or pick another clean checkout. Start `pin 1`.

- [ ] **Step 2: V1 — ChatGPT OAuth, read-only question**

The main repo contains `.agents/`, so pi's project-trust prompt (`defaultProjectTrust: "ask"`) appears on the first launch there; answer trust and note it. Then, in pi: `这个仓库的包管理器和测试命令是什么？只读，不改文件。`
Expected: answer names the actual package manager and test script from the repo's `package.json`. Record model id shown in the status line.

- [ ] **Step 3: V2 — small real change with tests**

Pick a one-file, low-risk change agreed with the user (a copy fix or a small util). In pi: describe it and ask the agent to run the relevant test command itself.
Expected: diff limited to the intended file(s); test command executed by the agent and green.

- [ ] **Step 4: V3 — commit skill with AskUserQuestion**

In pi: `/skill:coco-commit`
Expected: the skill's question(s) render through the `AskUserQuestion` panel; choose an option; the produced commit message follows the repo's convention. Do not push.

- [ ] **Step 5: V4 — permission gate**

In pi: `请执行 git push --force --dry-run origin HEAD，我在测试权限门。`
Expected: confirm dialog `Permission gate` appears with the matched pattern; choose No; the agent reports the block reason (`User denied: command matches denyCommands …`) and does not run it.

- [ ] **Step 6: V5 — Feishu confirm while a question waits**

Repeat V3 (or ask the agent any two-option question) and leave the panel open for 30 s.
Expected: Feishu confirm card arrives within ~10 s, labelled `pi`, quoting the question. Answer the panel afterwards; the card's ✅ receipt appears if relay mode is on (Task 8 verified the pipeline; this checks it from inside pi).

- [ ] **Step 7: V6 — GLM and Kimi**

In pi: `/model` → `glm/glm-5.3`, ask `读 package.json，告诉我 test 脚本是什么`; then `/model` → `kimi/k3-1m`, same question. Both must actually call the `read` tool (a tool round trip), not answer from memory.
Expected: both call `read` and answer correctly; no `apiKey` error. If `k3-1m` fails on tool use with `anthropic-messages`, change `"api"` to `"openai-completions"` in **both** `~/.pi/agent/models.json` (the account file pi actually reads; it reloads when you open `/model`) and `templates/models.json`, retry, and record which one worked.

- [ ] **Step 8: V7 — doctor**

Run: `pin doctor 1` → exit 0, no `FAIL`. Then `chmod 644 ~/.pi/agent/proxy.env; pin doctor 1; echo exit=$?` → `FAIL proxy.env mode is 644`, `exit=1`. Restore: `chmod 600 ~/.pi/agent/proxy.env`.

- [ ] **Step 9: Write the results file**

`docs/verification/2026-09-phase1.md` with a table `V1–V7 | 结果 | 备注（模型、时间、偏差）`, plus a `UNVERIFIED` list for anything skipped. Any V that failed stays open; do not mark phase 1 done.

---

### Task 10: Leak check, README install section, public repo

**Files:**
- Create: `scripts/leak-check.sh`
- Modify: `package.json` (add the `leak-check` script)
- Modify: `README.md` (install section already drafted; update if `pin` usage changed)
- Modify: `.gitignore` (`*.env.*` present; add anything new)

- [ ] **Step 1: Write the leak-check script (single source of the patterns; it excludes itself)**

`scripts/leak-check.sh`:

```sh
#!/bin/sh
# Scans everything git would publish (tracked + untracked, not ignored) for secrets and private layout.
# Exit 0 = clean, 1 = findings, 2 = a stray account-layer file is not ignored.
set -u
root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
home_prefix=$(printf '/%s/' Users)
# Each alternative is a complete credential shape or a private-layout marker, never a bare prefix.
pattern="${home_prefix}[A-Za-z0-9._-]+/|sk-[A-Za-z0-9_-]{16,}|[0-9a-f]{32}\.[A-Za-z0-9]{16}|ou_[a-z0-9]{8,}|oc_[a-z0-9]{8,}|hooks\.slack\.com/services/[A-Za-z0-9/]+|open\.feishu\.cn/open-apis/bot/v2/hook/[a-f0-9-]{20,}|discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+|xox[abp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|AKIA[0-9A-Z]{16}"
files=$(git ls-files --cached --others --exclude-standard | grep -v -E '^scripts/leak-check\.sh$|^node_modules/')
status=0
if [ -n "$files" ]; then
  # shellcheck disable=SC2086
  if printf '%s\n' $files | xargs grep -n -E "$pattern" -- 2>/dev/null; then status=1; fi
fi
stray=$(git ls-files --others --exclude-standard | grep -E '(^|/)(proxy\.env|auth\.json|models\.json|adonis-pi\.json|settings\.json|.*\.env(\..*)?)$' | grep -v '^templates/')
if [ -n "$stray" ]; then printf 'stray account-layer file: %s\n' $stray; status=2; fi
[ "$status" -eq 0 ] && echo "leak-check: clean"
exit "$status"
```

Add `"leak-check": "sh scripts/leak-check.sh"` to `package.json` scripts.

- [ ] **Step 2: Prove the scanner catches a planted credential, then run it for real (V8)**

```sh
printf 'token=%s\n' "$(printf 'xox%s-%s' b 1234567890-ABCDEFGHIJ)" > planted.txt
npm run -s leak-check; echo "planted exit=$?"     # expected: prints planted.txt:1 …, planted exit=1
rm planted.txt
printf 'X=1\n' > proxy.env.local; git check-ignore -q proxy.env.local; echo "ignored exit=$?"; rm proxy.env.local   # expected: ignored exit=0
npm run -s leak-check; echo "real exit=$?"        # expected: leak-check: clean, real exit=0
```

`.gitignore` must contain `*.env` and `*.env.*` (covers `proxy.env.local`). `tests/pin.test.ts` uses temp dirs only; if any test hard-codes a home path, fix it.

- [ ] **Step 3: Full test and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Create the public GitHub repo (authorised by the user on 2026-09-22 for the phase-1 close; confirm again in-session before running)**

```sh
cd ~/coding/adonis-pi
gh repo create Adonis0123/adonis-pi --public --source=. --description "Pi Package: permission gate, attention notify, AskUserQuestion tool and multi-account launcher for pi" --push
```
Expected: repo URL printed; `git remote -v` shows origin; first push contains only committed files (Account/Secret layers are ignored).

- [ ] **Step 5: Verify from a clean clone**

Run:
```sh
tmp=$(mktemp -d) && git clone https://github.com/Adonis0123/adonis-pi "$tmp/adonis-pi" && cd "$tmp/adonis-pi" && npm install && npm test
```
Expected: tests pass in the clone and `npm run -s leak-check` prints `leak-check: clean` there too.

---

## Self-review notes

- Spec coverage: P1 → Task 7 (`agentsMd` link); P2 → no code (pi default), documented in README; P3 → Task 4; P4 → Tasks 3, 6, 8; P5 → Task 5; P6 → Task 7 templates + V6; P7 → Task 7; V1–V7 → Task 9; V8 → Task 10; ADR 0002 rules → Task 2 (single config entry, `$VAR`), Task 7 (copy-if-absent, drift, 600).
- Type consistency: `NotifyConfig.kinds` shape is identical in Tasks 2, 3, 6; `sendNotify(notify, args, payload, opts)` signature identical in Tasks 3, 4, 5, 6; `Answer`/`QuestionInput` shared between `state.ts`, `ui.ts`, `index.ts`.
- Review Focus 1 → Task 4 test “deny regexes hit anywhere in a chained command”; 2 → Task 2 “missing file returns template” and Task 4 “broken config warns once”; 3 → Task 5 “enter with nothing checked”; 4 → Task 6 “transient error → nothing”; 5 → Task 7 “never overwrites”.
- Peer review 2026-09-22 (Codex + Grok Build, advisory): adopted — `agent_settled` instead of `agent_end`; `ctx.mode === "tui"` for the custom panel with an RPC `select` fallback; segment-based deny matching with leading-space / newline / pipe / `sh -c` / `git -C` / `+ref` / `rm -rf ~/` cases; notifier env filtering and value-free dry-run; recursive drift; indentation-preserving `packages` write; `unlink` before replacing a symlink in tests; `getSessionId()` preference; tool round-trip in V6; pinned pi version; sequential test files. Rejected — replacing per-extension notify calls with `ui_prompt_start/end` (those events carry only `kind`/`title`, not the question text).
- Re-review 2026-09-22 (both peers): fixed `.gitignore` swallowing `templates/proxy.env.example`, the Task 5 step reference, Review Focus 4 wording, `git push -uf`, `stopReason: "aborted"`, the partial-read race in the notify test; leak check became `scripts/leak-check.sh` with a planted-credential proof; `idle` now requires `confirm`. Grok checked `getSessionId(): string`, the `{ type: "message", message: {…} }` branch entry shape and `pi-tui` as a direct devDependency against the 0.87 types; Task 1 Step 3 and Task 6 Step 3 still tell the implementer to glance at the installed `.d.ts` once.
- First-principles check 2026-09-22 (web + local): pi 0.87.0 is still the latest; added Task 1 global install (pi was not on this machine), Task 6b startup check for unset `$VAR` refs (direct `pi` launches skip `proxy.env`), doctor version check, official `contextWindow`/`maxTokens` figures, the `details` JSON note, the project-trust step in V1, `enableInstallTelemetry: false` in the settings template. Decisions recorded in the spec: pi reads all of `~/.agents/skills` (100 entries vs 72 enabled in the other hosts) and phase 1 accepts that; the agent's own `bash` can print provider keys from its environment, same as today with `acc`, and the gate does not pretend otherwise.
- Known `UNVERIFIED` until execution: `k3-256k` / `kimi-for-coding` context sizes (Task 7 Step 1).
