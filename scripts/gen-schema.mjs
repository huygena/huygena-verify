// Writes schema/*.json from the zod schemas. Run after a build: pnpm schema
import { writeFileSync } from "node:fs";
import { jsonSchemas } from "../dist/core.js";

for (const [file, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(new URL(`../schema/${file}`, import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schema/${file}`);
}
