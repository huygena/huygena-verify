import { z } from "zod";
import { BundleSchema, CertificateSchema, ManifestSchema, NodeResultsSchema } from "./schema";

const BASE = "https://raw.githubusercontent.com/huygena/huygena-verify/main/schema/";

const SCHEMAS = {
  "manifest.v0.schema.json": { schema: ManifestSchema, title: "Huygena run manifest v0 (draft)" },
  "results.v0.schema.json": { schema: NodeResultsSchema, title: "Huygena node results v0 (draft)" },
  "bundle.v0.schema.json": { schema: BundleSchema, title: "Huygena evidence bundle v0 (draft)" },
  "certificate.v0.schema.json": { schema: CertificateSchema, title: "Huygena replication certificate v0 (draft)" },
} as const;

/** JSON Schema (draft 2020-12) for each v0 document, generated from the zod schemas. Keys are the file names in schema/. */
export function jsonSchemas(): Record<keyof typeof SCHEMAS, Record<string, unknown>> {
  const out = {} as Record<keyof typeof SCHEMAS, Record<string, unknown>>;
  for (const [file, { schema, title }] of Object.entries(SCHEMAS) as [keyof typeof SCHEMAS, (typeof SCHEMAS)[keyof typeof SCHEMAS]][]) {
    const js = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
    const { $schema, ...rest } = js;
    out[file] = { $schema, $id: BASE + file, title, ...rest };
  }
  return out;
}
