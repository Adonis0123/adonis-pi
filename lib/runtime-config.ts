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
