// Env Refs (CONTEXT.md): which environment variables an Account's files reference, computed once for every consumer
// (`pin doctor` checks them against proxy.env, startup-check against pi's environment, `pin --dry-run` prints them).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configEnvRefs, envRefs } from "./config.ts";
import { mcpEnvRefs, readMcpConfig } from "./mcp.ts";

/** The Account Layer files that may reference environment variables, in report order. */
export type RefFile = "models.json" | "adonis-pi.json" | "mcp.json";
export interface AccountRef {
  file: RefFile;
  name: string;
}

/**
 * Every `$VAR` an account's files reference, grouped by file in a fixed order, names sorted and unique per file.
 * models.json and the effective Config (account merged over the Template) use pi's whole-string `$VAR`/`${VAR}`;
 * mcp.json uses the Bridge's `${VAR}`/`$env:VAR`/`{env:VAR}` anywhere in a string. An unreadable mcp.json contributes
 * nothing: reporting the broken file is `pin doctor`'s job, not a missing variable.
 */
export function accountRefs(dir: string): AccountRef[] {
  const out: AccountRef[] = [];
  const add = (file: RefFile, names: string[]) => out.push(...names.map((name) => ({ file, name })));
  const models = join(dir, "models.json");
  if (existsSync(models)) add("models.json", envRefs(readFileSync(models, "utf8")));
  add("adonis-pi.json", configEnvRefs(join(dir, "adonis-pi.json")));
  const mcp = join(dir, "mcp.json");
  if (existsSync(mcp)) {
    try {
      add("mcp.json", mcpEnvRefs(readMcpConfig(mcp)));
    } catch {}
  }
  return out;
}
