import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { proxyEnvLookup, proxyEnvState, resolveKimiCuBin } from "../lib/environment.ts";

/** Line shapes reviewers produced over six rounds; each is a simple assignment/unset/comment line the parser must judge. */
const CERTAIN_CORPUS = [
  "export A=b # comment",
  'export B="" # comment',
  "export C=$OTHER",
  "export D=b=c",
  "  export E=b",
  "export F=b",
  "F=",
  "G=never-exported",
  'export H="quoted $X"',
  "export I='$literal'",
  'export J="a\\"b"',
  "export L=#literal",
  "export M=$HOME/bin/notify",
  'export N="${HOME}/x"',
  "export O=$HOMEX",
  "export P=gone",
  "unset P",
  "# export Q=1",
];
/** Files with a line the parser refuses to judge; every verdict must then be "unknown". */
const DEGRADED_CORPUS = [
  "export A=b; A=", // a second command on the line
  "export A=b\nexport A=c && unset A", // a command list
  'export A="line1\nline2"', // a value spanning lines
  "export A=b\nif [ -f ~/.x ]; then . ~/.x; fi", // control flow that may change anything
  "export A=b\nexport A B", // export without assignment
  "export A=b\nunset $NAME", // unset of a computed name
  "export A=\\\n\n", // a trailing backslash continues the statement on the next line (shell: A empty)
  "export A=</dev/null", // a redirection, not a value (shell: A empty)
  "export A=\nexport B=${A:=x}", // an assigning expansion sets A as a side effect (shell: A = x)
  "export A=b\nexport B=${A=x}",
  "export A=\nexport B=$((A=1))", // arithmetic expansion can assign too (shell: A = 1)
  "export A=b\nexport B=$(A=1; echo)", // command substitution runs arbitrary code
  "export A=\r\nexport B=b\r\n", // CRLF: the shell keeps \r as part of every value
];
const ODD_BLANKS = ["export A=\u00a0\nexport B=\u000b\n", "export C=x \u00a0\n"];
const HOME_TOUCHED = "unset HOME\nexport A=$HOME/x\nexport HOME=/tmp\nexport B=$HOME/y";

test("proxyEnvState mirrors what `. proxy.env` leaves for pi: set / empty / unknown, exported names only", () => {
  const env = proxyEnvState(CERTAIN_CORPUS.join("\n"));
  assert.equal(env.certain, true);
  assert.deepEqual(
    Object.fromEntries(env.state),
    { A: "set", B: "empty", C: "unknown", D: "set", E: "set", F: "empty", H: "unknown", I: "set", J: "set", L: "set", M: "set", N: "set", O: "unknown" },
    "reviewer line shapes; a # inside the word is literal; $HOME is always set under pin; P was unset; G is not exported; Q is a comment",
  );
  assert.equal(proxyEnvLookup(env, "P"), "empty", "an unset or never-exported name reads as empty in a fully parsed file");
  const odd = proxyEnvState(ODD_BLANKS[0]);
  assert.deepEqual(Object.fromEntries(odd.state), { A: "set", B: "set" }, "a no-break space or vertical tab is a value to the shell, not whitespace");
  assert.equal(odd.certain, true);
  assert.equal(proxyEnvState(ODD_BLANKS[1]).certain, false, "a stray non-ASCII blank after the word is a second argument to export: not a simple line");
  const noHome = proxyEnvState(HOME_TOUCHED);
  assert.deepEqual(Object.fromEntries(noHome.state), { A: "unknown", HOME: "set", B: "unknown" }, "$HOME is only known while the file leaves HOME alone");
  assert.deepEqual([...env.state].filter(([, st]) => st === "set").map(([n]) => n), ["A", "D", "E", "I", "J", "L", "M", "N"]);
});

test("proxyEnvState degrades to unknown instead of guessing when a line is not a simple assignment", () => {
  for (const text of DEGRADED_CORPUS) {
    const env = proxyEnvState(text);
    assert.equal(env.certain, false, text);
    assert.equal(proxyEnvLookup(env, "A"), "unknown", text);
    assert.equal(proxyEnvLookup(env, "NEVER_MENTIONED"), "unknown", `${text}: an unparsed line could have set anything`);
    assert.equal([...env.state.values()].every((st) => st === "unknown"), true, text);
  }
});

/**
 * The oracle: source `text` with `sh` exactly as bin/pin does (`set -eu; set +u; . file; set -u`) in a throwaway
 * environment and report what pi would inherit. Only test fixtures are ever sourced, never a real proxy.env.
 */
function shSource(text: string): { ok: boolean; vars: Map<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-oracle-"));
  const file = join(dir, "fixture.env");
  writeFileSync(file, text);
  const r = spawnSync("sh", ["-c", 'set -eu; set +u; . "$1"; set -u; env -0', "sh", file], { env: { HOME: "/fake/home", PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  const vars = new Map<string, string>();
  for (const entry of (r.stdout ?? "").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) vars.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return { ok: r.status === 0, vars };
}

test("oracle: every proxyEnvState verdict agrees with a real sh sourcing the same text, or says unknown", () => {
  const baseline = shSource("").vars;
  const fixtures = [CERTAIN_CORPUS.join("\n"), ...CERTAIN_CORPUS, ...DEGRADED_CORPUS, ...ODD_BLANKS, HOME_TOUCHED, "export A=b\nexport A=", "export A=x\nunset A\nexport A=y"];
  let compared = 0;
  for (const text of fixtures) {
    const parsed = proxyEnvState(text);
    const sh = shSource(text);
    if (!sh.ok) {
      assert.equal(parsed.certain, false, `${JSON.stringify(text)}: sh refused this file, so a confident parse would be a lie`);
      continue;
    }
    // Names to judge: what the parser exported, what the file added, and inherited names it changed or removed.
    const names = new Set<string>(parsed.state.keys());
    for (const [n, v] of sh.vars) if (!baseline.has(n) || baseline.get(n) !== v) names.add(n);
    for (const n of baseline.keys()) if (!sh.vars.has(n)) names.add(n);
    for (const name of names) {
      const mine = proxyEnvLookup(parsed, name);
      const truth = sh.vars.get(name) ? "set" : "empty";
      assert.ok(mine === "unknown" || mine === truth, `${JSON.stringify(text)}: $${name} parser=${mine} sh=${truth}`);
      compared++;
    }
  }
  assert.ok(compared > 40, `oracle compared ${compared} verdicts`);
  // The oracle itself must be able to disagree: a wrong parser would be caught, not waved through.
  assert.equal(shSource("export Z=1").vars.get("Z"), "1");
  assert.equal(shSource('export Z=""').vars.get("Z"), "");
});

test("resolveKimiCuBin only accepts executable files, from the override, the app bundle or PATH", () => {
  assert.equal(resolveKimiCuBin({ ADONIS_PI_KIMI_CU_BIN: dirname(process.execPath) }), undefined, "a directory is not the executable");
  assert.equal(resolveKimiCuBin({ ADONIS_PI_KIMI_CU_BIN: process.execPath }), process.execPath);
});
