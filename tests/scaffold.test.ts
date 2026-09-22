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
