import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hashFiles, verifyCertificate } from "../src/index";

const read = (p: string) => readFileSync(new URL(`../examples/${p}`, import.meta.url), "utf8");
const manifest = read("manifest.yaml");
const cert = () => JSON.parse(read("certificate.json"));
const bundleDir = fileURLToPath(new URL("../examples/evidence", import.meta.url));
const status = (r: Awaited<ReturnType<typeof verifyCertificate>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));

describe("verifyCertificate", () => {
  it("the example certificate passes every offline check", async () => {
    const r = await verifyCertificate(cert(), { manifest, bundleDir });
    expect(r.ok).toBe(true);
    expect(status(r)).toEqual({
      schema: "pass",
      confirmation: "pass",
      "manifest-hash": "pass",
      "claims-match": "pass",
      verdicts: "pass",
      "bundle-root": "pass",
      "attestation-file": "pass",
      "step-outputs": "pass",
      "attestation-signature": "planned",
      "onchain-record": "planned",
    });
    expect(r.counts).toEqual({ pass: 8, fail: 0, skipped: 0, planned: 2 });
  });

  it("never reports attestation signatures or the chain as passed", async () => {
    const r = await verifyCertificate(cert(), { manifest, bundleDir });
    for (const id of ["attestation-signature", "onchain-record"]) {
      expect(r.checks.find((c) => c.id === id)?.status).toBe("planned");
    }
  });

  it("skips what it cannot check without the manifest and the bundle", async () => {
    const r = await verifyCertificate(cert());
    expect(r.ok).toBe(true);
    expect(r.counts.skipped).toBe(6);
  });

  it("catches an edited manifest", async () => {
    const edited = manifest.replace("tolerance: 0.02", "tolerance: 0.06");
    const r = await verifyCertificate(cert(), { manifest: edited });
    expect(r.ok).toBe(false);
    expect(status(r)["manifest-hash"]).toBe("fail");
    // A wider tolerance turns figure_3b.slope into Replicated, which contradicts the certificate.
    expect(r.checks.find((c) => c.id === "verdicts")?.detail).toContain("figure_3b.slope");
  });

  it("catches a verdict that does not follow from the values", async () => {
    const c = cert();
    c.claims.find((x: { id: string }) => x.id === "table_3.hazard_ratio").verdict = "Replicated";
    const r = await verifyCertificate(c, { manifest });
    expect(status(r).verdicts).toBe("fail");
  });

  it("catches a mismatch reported as a verdict", async () => {
    const c = cert();
    const ece = c.claims.find((x: { id: string }) => x.id === "table_4.ece");
    ece.verdict = "Replicated";
    delete ece.mismatch;
    expect(status(await verifyCertificate(c, { manifest })).verdicts).toBe("fail");
  });

  it("catches an edited evidence file through the bundle root and the attestation hash", async () => {
    const files = [
      { path: "attestation/report.json", data: "{}" },
      { path: "logs/node-a.log", data: read("evidence/logs/node-a.log") },
      { path: "logs/node-b.log", data: read("evidence/logs/node-b.log") },
      { path: "outputs/node-a/metrics.json", data: read("evidence/outputs/node-a/metrics.json") },
      { path: "outputs/node-b/metrics.json", data: read("evidence/outputs/node-b/metrics.json") },
    ];
    const r = await verifyCertificate(cert(), { bundle: await hashFiles(files) });
    expect(status(r)).toMatchObject({ "bundle-root": "fail", "attestation-file": "fail", "step-outputs": "pass" });
  });

  it("fails without an independent confirming node", async () => {
    const c = cert();
    c.nodes.confirming = null;
    expect(status(await verifyCertificate(c)).confirmation).toBe("fail");
    c.nodes.confirming = "node-a";
    expect(status(await verifyCertificate(c)).confirmation).toBe("fail");
  });

  it("fails on a claim missing from the certificate", async () => {
    const c = cert();
    c.claims.pop();
    expect(status(await verifyCertificate(c, { manifest }))["claims-match"]).toBe("fail");
  });

  it("rejects something that is not a certificate", async () => {
    const r = await verifyCertificate({ spec: "certificate.v0", run: "x" });
    expect(r.ok).toBe(false);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]!.id).toBe("schema");
  });

  it("accepts the docs spelling of the attested step label", async () => {
    const c = cert();
    c.steps[0].label = "attested, not replicated";
    expect((await verifyCertificate(c)).ok).toBe(true);
  });
});
