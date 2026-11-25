import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BundleSchema, CertificateSchema, jsonSchemas, NodeResultsSchema, parseDocument } from "../src/core";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("JSON Schema files", () => {
  it("schema/*.json are generated from the zod schemas (run pnpm schema after changing src/schema.ts)", () => {
    for (const [file, schema] of Object.entries(jsonSchemas())) {
      expect(JSON.parse(read(`schema/${file}`)), file).toEqual(schema);
    }
  });

  it("the manifest schema lists the v0 fields", () => {
    const s = jsonSchemas()["manifest.v0.schema.json"] as { required: string[]; properties: Record<string, unknown> };
    expect(s.required).toEqual(["paper", "claims", "env", "run"]);
    expect(Object.keys(s.properties)).toEqual(["spec", "paper", "title", "claims", "env", "run"]);
  });
});

describe("example files match their schemas", () => {
  it("results, bundle and certificate", () => {
    expect(NodeResultsSchema.safeParse(parseDocument(read("examples/results.node-a.json"))).success).toBe(true);
    expect(NodeResultsSchema.safeParse(parseDocument(read("examples/results.node-b.json"))).success).toBe(true);
    expect(BundleSchema.safeParse(parseDocument(read("examples/bundle.json"))).success).toBe(true);
    expect(CertificateSchema.safeParse(parseDocument(read("examples/certificate.json"))).success).toBe(true);
  });
});
