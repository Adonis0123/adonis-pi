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
