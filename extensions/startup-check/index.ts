import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, configEnvRefs, envRefs, missingEnvRefs } from "../../lib/config.ts";
import { surface } from "../../lib/session.ts";

export { envRefs, missingEnvRefs };

/** Which files of an account reference environment variables that `env` leaves unset: [file label, missing vars]. */
export function missingByFile(dir: string, env: NodeJS.ProcessEnv): [string, string[]][] {
  const out: [string, string[]][] = [];
  const models = join(dir, "models.json");
  if (existsSync(models)) {
    const m = missingEnvRefs(readFileSync(models, "utf8"), env);
    if (m.length) out.push(["models.json", m]);
  }
  // The effective Config = account file merged over the template, so template defaults such as "$ADONIS_PI_NOTIFY_CMD" count too.
  const c = configEnvRefs(join(dir, "adonis-pi.json")).filter((v) => !env[v]);
  if (c.length) out.push(["adonis-pi.json", c]);
  return out;
}

export default function startupCheck(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || !surface(ctx).canPrompt) return;
    const missing = missingByFile(agentDir(), process.env);
    if (missing.length === 0) return;
    const needs = missing.map(([file, vars]) => `${file} needs ${vars.join(", ")}`).join("; ");
    ctx.ui.notify(`adonis-pi: ${needs} but the environment does not set ${missing.flatMap(([, v]) => v).length === 1 ? "it" : "them"}. Launch through \`pin <n>\` so proxy.env is loaded.`, "warning");
  });
}
