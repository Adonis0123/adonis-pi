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
