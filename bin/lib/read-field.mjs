import { readFileSync } from "node:fs";
const [file, path] = process.argv.slice(2);
let v = JSON.parse(readFileSync(file, "utf8"));
for (const k of path.split(".")) v = v?.[k];
process.stdout.write(typeof v === "string" ? v : "");
