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
