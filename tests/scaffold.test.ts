import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("ADR 0002 rule 3 as an import graph: nothing pi loads at runtime imports the launcher-only modules", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(root, "extensions"));
  walk(join(root, "lib"));
  const runtime = files.filter((p) => !p.endsWith("/lib/environment.ts"));
  assert.ok(runtime.length >= 10);
  for (const p of runtime) {
    const src = readFileSync(p, "utf8");
    assert.doesNotMatch(src, /from "[^"]*\/(environment)\.ts"/, `${p.slice(root.length)} reads machine state (proxy.env, KimiCU) that only bin/pin may touch`);
    assert.doesNotMatch(src, /from "[^"]*\/bin\//, `${p.slice(root.length)} imports the launcher`);
    if (p.includes("/extensions/")) assert.doesNotMatch(src, /readFileSync\([^)]*proxy\.env/, `${p.slice(root.length)} must not read the Secret Layer`);
  }
});
