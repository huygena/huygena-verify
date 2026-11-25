import { describe, expect, it } from "vitest";
import { compare, CompareError, ManifestSchema, type Claim, type ClaimResult, type Manifest, type NodeResults } from "../src/core";

function manifest(...claims: Claim[]): Manifest {
  return ManifestSchema.parse({
    paper: "doi:10.5555/x",
    claims,
    env: { container: `sha256:${"0".repeat(64)}`, code: `github.com/o/r@${"a".repeat(40)}` },
    run: { where: "gpu-tee", confirm: "independent-node" },
  });
}

const node = (name: string, claims: Record<string, ClaimResult>): NodeResults => ({ node: name, claims });
const one = (claim: Claim, value: ClaimResult, opts = {}) => compare(manifest(claim), node("a", { [claim.id]: value }), opts).claims[0]!;

const auroc: Claim = { id: "auroc", reported: 0.912, tolerance: 0.005, null_value: 0.5 };

describe("verdict table, one node (draft v0 rules)", () => {
  const cases: Array<[string, Claim, ClaimResult, string]> = [
    ["exact match", auroc, 0.912, "Replicated"],
    ["inside the band", auroc, 0.9104, "Replicated"],
    ["on the upper edge (inclusive, float-safe)", auroc, 0.917, "Replicated"],
    ["on the lower edge", auroc, 0.907, "Replicated"],
    ["just outside, same side of 0.5", auroc, 0.9171, "Partially replicated"],
    ["on the partial edge (3x band)", auroc, 0.897, "Partially replicated"],
    ["outside the partial band", auroc, 0.85, "Failed"],
    ["rel tolerance, inside", { id: "x", reported: 200, tolerance: { rel: 0.02 } }, 203.9, "Replicated"],
    ["rel tolerance, outside", { id: "x", reported: 200, tolerance: { rel: 0.02 } }, 204.1, "Partially replicated"],
    ["abs + rel are added", { id: "x", reported: 100, tolerance: { abs: 1, rel: 0.01 } }, 102, "Replicated"],
    ["sign flips across 0", { id: "slope", reported: 0.02, tolerance: 0.01 }, -0.02, "Failed"],
    ["opposite side of null_value 1 (ratio)", { id: "hr", reported: 0.71, tolerance: 0.03, null_value: 1 }, 1.04, "Failed"],
    ["explicit partial band", { id: "x", reported: 10, tolerance: 0.1, partial: 2 }, 11.5, "Partially replicated"],
    ["explicit partial band, outside", { id: "x", reported: 10, tolerance: 0.1, partial: 2 }, 12.5, "Failed"],
    ["reported equals null_value: no direction check", { id: "d", reported: 0, tolerance: 0.1 }, -0.2, "Partially replicated"],
    ["null value", auroc, null, "Could not run"],
    ["error with reason", auroc, { error: "dataset not public" }, "Could not run"],
    ["object without value", auroc, {}, "Could not run"],
  ];
  it.each(cases)("%s", (_name, claim, value, verdict) => {
    expect(one(claim, value).verdict).toBe(verdict);
  });

  it("reports the delta and the bands", () => {
    const c = one(auroc, 0.9104);
    expect(c.nodes[0]!.delta).toBeCloseTo(-0.0016, 10);
    expect(c.band).toBe(0.005);
    expect(c.partialBand).toBeCloseTo(0.015, 12);
  });

  it("keeps the reason for Could not run", () => {
    expect(one(auroc, { error: "dataset not public" }).reason).toContain("dataset not public");
  });

  it("a claim missing from the results could not run", () => {
    const r = compare(manifest(auroc), node("a", {}));
    expect(r.claims[0]).toMatchObject({ verdict: "Could not run" });
    expect(r.claims[0]!.reason).toContain("no value reported by a");
  });

  it("one node gives a verdict but never confirms it", () => {
    const c = one(auroc, 0.912);
    expect(c).toMatchObject({ verdict: "Replicated", confirmed: false, label: "unverified", mismatch: false });
  });

  it("partialFactor is explicit and overridable; 1 turns the default partial band off", () => {
    expect(one(auroc, 0.9171, { partialFactor: 1 }).verdict).toBe("Failed");
    expect(one(auroc, 0.88, { partialFactor: 10 }).verdict).toBe("Partially replicated");
    expect(() => one(auroc, 0.9, { partialFactor: 0.5 })).toThrow(CompareError);
  });
});

describe("two nodes", () => {
  const m = manifest(auroc, { id: "ece", reported: 0.031, tolerance: 0.004 }, { id: "ext", reported: 0.874, tolerance: 0.01 });
  const a = node("node-a", { auroc: 0.9104, ece: 0.0335, ext: { error: "not public" } });
  const b = node("node-b", { auroc: 0.9109, ece: 0.0362, ext: { error: "not public" } });
  const r = compare(m, [a, b]);

  it("issues a verdict only when both nodes agree", () => {
    expect(r.claims[0]).toMatchObject({ verdict: "Replicated", confirmed: true, label: "replicated", mismatch: false });
    expect(r.claims[0]!.nodeDelta).toBeCloseTo(0.0005, 10);
  });

  it("flags a mismatch and gives no verdict when they disagree", () => {
    expect(r.claims[1]).toMatchObject({ verdict: null, mismatch: true, confirmed: false, label: "unverified" });
    expect(r.claims[1]!.nodes.map((n) => n.verdict)).toEqual(["Replicated", "Partially replicated"]);
    expect(r.claims[1]!.reason).toMatch(/nodes disagree/);
  });

  it("agreeing on Could not run is a verdict, but not a replicated step", () => {
    expect(r.claims[2]).toMatchObject({ verdict: "Could not run", confirmed: true, label: "unverified" });
  });

  it("summarizes counts and mismatches", () => {
    expect(r.summary).toEqual({
      total: 3,
      counts: { Replicated: 1, "Partially replicated": 0, Failed: 0, "Could not run": 1 },
      mismatches: 1,
      twoNodes: true,
      allReplicated: false,
    });
    expect(r.rules).toEqual({ version: "v0-draft", partialFactor: 3 });
  });

  it("allReplicated only when every claim is Replicated", () => {
    const ok = compare(manifest(auroc), [node("a", { auroc: 0.912 }), node("b", { auroc: 0.913 })]);
    expect(ok.summary.allReplicated).toBe(true);
  });

  it("rejects the same node twice and more than two nodes", () => {
    expect(() => compare(m, [a, a])).toThrow(/independent node/);
    expect(() => compare(m, [a, b, node("c", {})])).toThrow(/1 or 2 nodes/);
  });
});

describe("edge cases", () => {
  it("notes result ids that are not in the manifest", () => {
    const r = compare(manifest(auroc), node("a", { auroc: 0.912, typo: 1 }));
    expect(r.notes[0]).toContain('"typo"');
  });

  it("ignores a verdict sent for a numeric claim", () => {
    const r = compare(manifest(auroc), node("a", { auroc: { value: 0.5, verdict: "Replicated" } }));
    expect(r.claims[0]!.verdict).toBe("Failed");
    expect(r.notes[0]).toContain("ignored");
  });

  it("throws on a manifest that cannot be compared", () => {
    expect(() => compare(manifest({ id: "x", reported: 1 }), node("a", {}))).toThrow(/no abs\/rel tolerance/);
  });

  it("structure claims compare RMSD against tolerance.rmsd (draft)", () => {
    const s: Claim = { id: "s", type: "structure", tolerance: { rmsd: 2 }, reference: "pdb:1abc" };
    expect(one(s, 1.4).verdict).toBe("Replicated");
    expect(one(s, 2).verdict).toBe("Replicated");
    expect(one(s, 5.9).verdict).toBe("Partially replicated");
    expect(one(s, 6.5).verdict).toBe("Failed");
    expect(one(s, -1).verdict).toBe("Could not run");
  });

  it("figure claims take a reviewer verdict (draft), or could not run without one", () => {
    const f: Claim = { id: "f", type: "figure", reference: `sha256:${"2".repeat(64)}` };
    expect(one(f, { verdict: "Partially replicated", note: "trend holds, smaller effect" })).toMatchObject({ verdict: "Partially replicated" });
    expect(one(f, 0.9).verdict).toBe("Could not run");
  });
});
