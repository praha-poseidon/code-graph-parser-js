import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { EndpointRule } from "./endpoint-rule.js";

export async function loadEndpointRules(rulesDir: string): Promise<EndpointRule[]> {
  if (!fs.existsSync(rulesDir)) {
    return [];
  }

  const entries = fs.readdirSync(rulesDir, { withFileTypes: true });
  const rules: EndpointRule[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ya?ml|json)$/i.test(entry.name)) continue;

    const filePath = path.join(rulesDir, entry.name);
    const text = fs.readFileSync(filePath, "utf8");
    const parsed = entry.name.endsWith(".json") ? JSON.parse(text) : YAML.parseAllDocuments(text).map((doc) => doc.toJSON());
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const value of values.flat()) {
      if (value && typeof value === "object") {
        rules.push(value as EndpointRule);
      }
    }
  }
  return rules;
}
