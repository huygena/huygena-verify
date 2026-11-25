import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { lintManifest, parseManifest } from "../src/core";

const example = readFileSync(new URL("../examples/manifest.yaml", import.meta.url), "utf8");

// The example from the Huygena docs (Manifest page), verbatim.
const DOCS_EXAMPLE = `# Example manifest. Field names are a draft and may change.
paper: "doi:<doi>"
claims:
  - id: table_2.auroc
    reported: 0.912        # value printed in the paper
    tolerance: 0.005       # stated per claim
  - id: figure_3b.slope
    reported: 0.84
    tolerance: 0.02
env:
  container: "sha256:<pinned>"
  code: "github.com/<org>/<repo>@<commit>"
  data:
    - "sha256:<dataset-hash>"
  seeds: [0, 1, 2]
run:
  where: gpu-tee
  confirm: independent-node`;

const SHA = `sha256:${"1".repeat(64)}`;
const COMMIT = "3".repeat(40);

function base(): Record<string, any> {
  return {
    spec: "manifest.v0",
    paper: "doi:10.5555/x",
    claims: [{ id: "c1", reported: 0.912, tolerance: 0.005, null_value: 0.5 }],
    env: { container: `ghcr.io/o/i@${SHA}`, code: `github.com/o/r@${COMMIT}`, data: [SHA], seeds: [0] },
    run: { where: "gpu-tee", confirm: "independent-node" },
  };
}

function codes(doc: unknown) {
  return lintManifest(doc).findings.map((f) => `${f.severity}:${f.code}:${f.path}`);
}

describe("parseManifest", () => {
  it("accepts the example with no findings", () => {
    const r = lintManifest(example);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.manifest?.claims).toHaveLength(6);
  });

  it("parses the docs example and flags every unfilled placeholder", () => {
    const parsed = parseManifest(DOCS_EXAMPLE);
    expect(parsed.ok).toBe(true);
    const r = lintManifest(parsed);
    const placeholders = r.findings.filter((f) => f.code === "placeholder").map((f) => f.path);
    expect(placeholders).toEqual(["paper", "env.container", "env.code", "env.data[0]"]);
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.code === "spec-missing" && f.severity === "info")).toBe(true);
  });

  it("reports YAML syntax errors with a position", () => {
    const r = parseManifest("paper: [unclosed\n");
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ severity: "error", code: "syntax" });
  });

  it("rejects duplicate keys", () => {
    const r = parseManifest("paper: a\npaper: b\n");
    expect(r.findings[0]?.code).toBe("syntax");
  });

  it("gives schema errors a path", () => {
    const doc = base();
    doc.claims[0].tolerance = -1;
    delete doc.env.code;
    const r = parseManifest(doc);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.path)).toEqual(expect.arrayContaining(["claims[0].tolerance", "env.code"]));
  });

  it("requires at least one claim", () => {
    const doc = base();
    doc.claims = [];
    expect(parseManifest(doc).findings[0]?.path).toBe("claims");
  });

  it("reads JSON and YAML the same way", () => {
    expect(lintManifest(JSON.stringify(base())).findings).toEqual(lintManifest(stringify(base())).findings);
  });
});

describe("lint rules", () => {
  it("a clean manifest has no findings", () => {
    expect(codes(base())).toEqual([]);
  });

  it("container must be pinned by digest", () => {
    const d = base();
    d.env.container = "python:3.11-slim";
    expect(codes(d)).toContain("error:container-not-pinned:env.container");
    d.env.container = "ghcr.io/o/i@sha256:abc";
    expect(codes(d)).toContain("error:container-digest-invalid:env.container");
    d.env.container = SHA;
    expect(codes(d)).toEqual([]);
  });

  it("code must be pinned to a full commit", () => {
    const d = base();
    d.env.code = "github.com/o/r@main";
    expect(codes(d)).toContain("error:code-not-pinned:env.code");
    d.env.code = "github.com/o/r@v1.2.0";
    expect(codes(d)).toContain("error:code-not-pinned:env.code");
    d.env.code = "github.com/o/r@3f2a9c1";
    expect(codes(d)).toContain("error:code-short-sha:env.code");
    d.env.code = "https://github.com/o/r";
    expect(codes(d)).toContain("error:code-format:env.code");
    d.env.code = `gitlab.com/group/sub/repo@${"b".repeat(40)}`;
    expect(codes(d)).toEqual([]);
    d.env.code = `github.com/o/r@${"c".repeat(64)}`;
    expect(codes(d)).toEqual([]);
  });

  it("paper must be a DOI, arXiv id or bioRxiv DOI", () => {
    const d = base();
    for (const ok of ["10.1038/s41586-021-03819-2", "doi:10.1101/2024.01.01.000000", "arxiv:2101.00001", "2101.00001v2", "arxiv:hep-th/9901001"]) {
      d.paper = ok;
      expect(codes(d)).toEqual([]);
    }
    d.paper = "https://example.com/paper.pdf";
    expect(codes(d)).toContain("error:paper-format:paper");
  });

  it("data hashes must be sha256 and not repeated", () => {
    const d = base();
    d.env.data = [SHA, { path: "x.csv", sha256: "md5:abc" }, SHA];
    expect(codes(d)).toEqual(expect.arrayContaining(["error:data-hash-invalid:env.data[1].sha256", "warning:data-duplicate:env.data[2]"]));
    delete d.env.data;
    expect(codes(d)).toContain("warning:data-missing:env.data");
  });

  it("seeds are recorded", () => {
    const d = base();
    delete d.env.seeds;
    expect(codes(d)).toContain("warning:seeds-missing:env.seeds");
    d.env.seeds = [];
    expect(codes(d)).toContain("info:seeds-empty:env.seeds");
    d.env.seeds = [1, 1];
    expect(codes(d)).toContain("warning:seeds-duplicate:env.seeds");
  });

  it("claim ids are unique", () => {
    const d = base();
    d.claims.push({ ...d.claims[0] });
    expect(codes(d)).toContain("error:claim-duplicate-id:claims[1].id");
  });

  it("every numeric claim has a reported value and a tolerance", () => {
    const d = base();
    delete d.claims[0].tolerance;
    delete d.claims[0].reported;
    expect(codes(d)).toEqual(expect.arrayContaining(["error:claim-no-tolerance:claims[0].tolerance", "error:claim-no-reported:claims[0].reported"]));
    d.claims[0] = { id: "c1", reported: 1, tolerance: {} };
    expect(codes(d)).toContain("error:tolerance-empty:claims[0].tolerance");
  });

  it("warns on zero tolerance and on a band that reaches the value of no effect", () => {
    const d = base();
    d.claims[0].tolerance = 0;
    expect(codes(d)).toContain("warning:tolerance-zero:claims[0].tolerance");
    d.claims[0] = { id: "hr", reported: 0.95, tolerance: 0.05, null_value: 1 };
    expect(codes(d)).toContain("warning:tolerance-crosses-null:claims[0].tolerance");
    d.claims[0] = { id: "slope", reported: 0.1, tolerance: { rel: 1 } };
    expect(codes(d)).toContain("warning:tolerance-crosses-null:claims[0].tolerance");
  });

  it("partial band must be wider than the tolerance", () => {
    const d = base();
    d.claims[0].partial = 0.004;
    expect(codes(d)).toContain("error:partial-narrower:claims[0].partial");
    d.claims[0].partial = { abs: 0.02 };
    expect(codes(d)).toEqual([]);
  });

  it("structure and figure claims are marked draft", () => {
    const d = base();
    d.claims = [
      { id: "s", type: "structure", tolerance: 0.5, reference: "pdb:1abc" },
      { id: "f", type: "figure" },
    ];
    expect(codes(d)).toEqual([
      "info:claim-type-draft:claims[0].type",
      "error:tolerance-wrong-kind:claims[0].tolerance",
      "info:claim-type-draft:claims[1].type",
      "warning:claim-no-reference:claims[1].reference",
    ]);
    d.claims[0].tolerance = { rmsd: 2 };
    expect(codes(d)).not.toContain("error:tolerance-wrong-kind:claims[0].tolerance");
  });

  it("flags unknown fields with a suggestion, and allows x_ extensions", () => {
    const d = base();
    d.claims[0].tolerence = 0.01;
    d.x_lab = "ours";
    const r = lintManifest(d);
    const f = r.findings.find((x) => x.code === "unknown-field");
    expect(f).toMatchObject({ severity: "warning", path: "claims[0].tolerence" });
    expect(f?.message).toContain('Did you mean "tolerance"');
    expect(r.findings.filter((x) => x.code === "unknown-field")).toHaveLength(1);
  });

  it("warns when there is no independent confirmation", () => {
    const d = base();
    d.run = { where: "laptop", confirm: "none" };
    expect(codes(d)).toEqual(["info:run-where-unknown:run.where", "warning:run-no-confirm:run.confirm"]);
  });
});
