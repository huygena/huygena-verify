import { parseDocument as parseYamlDocument } from "yaml";
import type { z } from "zod";
import { canonicalJson } from "./canonical";
import { isSha256Ref, sha256Hex } from "./hash";
import { MANIFEST_SPEC, ManifestSchema, type Claim, type Manifest, type Tolerance } from "./schema";
import { hasNumericBand, hasRmsd, numericBand, withinBand } from "./tolerance";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  /** Stable rule id, e.g. `container-not-pinned`. Listed in SPEC.md. */
  code: string;
  message: string;
  /** Where in the manifest, e.g. `claims[1].tolerance`. Empty for the whole document. */
  path: string;
}

export class DocumentParseError extends Error {
  override name = "DocumentParseError";
}

/**
 * Parse YAML or JSON text into plain JSON data. YAML 1.2 core schema, so JSON
 * input parses the same way. Duplicate keys are an error. Dates stay strings.
 */
export function parseDocument(text: string): unknown {
  const doc = parseYamlDocument(text, { schema: "core", uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    const e = doc.errors[0]!;
    const line = e.linePos?.[0];
    throw new DocumentParseError(line ? `line ${line.line}, column ${line.col}: ${e.message}` : e.message);
  }
  return doc.toJS({ maxAliasCount: 100 });
}

export interface ParsedManifest {
  /** True when the document parsed and matches the v0 schema. Lint rules are separate: see `lintManifest`. */
  ok: boolean;
  /** The document as parsed. This is what `manifestHash` hashes. */
  raw: unknown;
  /** The schema-checked manifest, or null when it does not match. */
  manifest: Manifest | null;
  /** Syntax and schema errors. */
  findings: Finding[];
}

/** Parse YAML/JSON text (or an already parsed value) and check it against the v0 schema. */
export function parseManifest(input: string | unknown): ParsedManifest {
  let raw: unknown;
  if (typeof input === "string") {
    try {
      raw = parseDocument(input);
    } catch (err) {
      return { ok: false, raw: undefined, manifest: null, findings: [finding("error", "syntax", (err as Error).message, "")] };
    }
  } else {
    raw = input;
  }
  const res = ManifestSchema.safeParse(raw);
  if (!res.success) return { ok: false, raw, manifest: null, findings: zodFindings(res.error) };
  return { ok: true, raw, manifest: res.data, findings: [] };
}

/**
 * The manifest hash anchored on a certificate:
 *
 *   "sha256:" + hex(SHA-256(UTF-8(canonicalJson(parsed document))))
 *
 * YAML and JSON spellings of the same data, key order, whitespace and comments
 * do not change it. Any change to a value does. See SPEC.md, "Manifest hash".
 */
export async function manifestHash(input: string | unknown): Promise<string> {
  const raw = typeof input === "string" ? parseDocument(input) : input;
  return `sha256:${await sha256Hex(canonicalJson(raw))}`;
}

export interface LintReport {
  /** No errors. Warnings and info do not make a manifest invalid. */
  ok: boolean;
  errors: number;
  warnings: number;
  infos: number;
  findings: Finding[];
  /** The schema-checked manifest when it matched the schema. */
  manifest: Manifest | null;
}

/** Schema check plus the rules in SPEC.md "Lint rules". Accepts text, a parsed value or a `ParsedManifest`. */
export function lintManifest(input: string | unknown | ParsedManifest): LintReport {
  const parsed = isParsed(input) ? input : parseManifest(input);
  const findings: Finding[] = [...parsed.findings];
  if (parsed.raw !== undefined) placeholders(parsed.raw, "", findings);
  if (parsed.manifest) rules(parsed.manifest, findings);
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const errors = count("error");
  return { ok: errors === 0, errors, warnings: count("warning"), infos: count("info"), findings, manifest: parsed.manifest };
}

function isParsed(x: unknown): x is ParsedManifest {
  return typeof x === "object" && x !== null && "findings" in x && "raw" in x && "manifest" in x && "ok" in x;
}

function finding(severity: Severity, code: string, message: string, path: string): Finding {
  return { severity, code, message, path };
}

function fmtPath(parts: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const p of parts) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

function zodFindings(error: z.ZodError): Finding[] {
  return error.issues.map((i) => {
    let message = i.message;
    if (i.code === "invalid_type" && message.includes("received undefined")) message = "required field is missing";
    return finding("error", "schema", message, fmtPath(i.path));
  });
}

const PLACEHOLDER = /<[^<>\s][^<>]*>/;

function placeholders(value: unknown, path: string, out: Finding[]): void {
  if (typeof value === "string") {
    const m = PLACEHOLDER.exec(value);
    if (m) out.push(finding("error", "placeholder", `placeholder ${m[0]} was never filled in`, path));
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => placeholders(v, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) placeholders(v, path ? `${path}.${k}` : k, out);
  }
}

const KNOWN = {
  top: ["spec", "paper", "title", "claims", "env", "run"],
  claim: ["id", "description", "type", "reported", "unit", "tolerance", "partial", "null_value", "reference"],
  tolerance: ["abs", "rel", "rmsd"],
  env: ["container", "code", "data", "seeds", "command", "params"],
  run: ["where", "confirm"],
};

function unknownKeys(obj: object, known: string[], path: string, out: Finding[]): void {
  for (const k of Object.keys(obj)) {
    if (known.includes(k) || k.startsWith("x_") || k.startsWith("x-")) continue;
    const near = known.find((n) => editDistance(n, k) <= 2);
    const hint = near ? ` Did you mean "${near}"?` : " Prefix extensions with x_ to silence this.";
    out.push(finding("warning", "unknown-field", `unknown field "${k}".${hint}`, path ? `${path}.${k}` : k));
  }
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

const PAPER_PATTERNS = [
  /^(doi:)?10\.\d{4,9}\/\S+$/i, // DOI, incl. bioRxiv 10.1101/...
  /^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i, // arXiv new style
  /^arxiv:[a-z-]+(\.[a-z]{2})?\/\d{7}(v\d+)?$/i, // arXiv old style
];

const CODE_RE = /^(?<repo>[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\/[^\s@/]+(?:\/[^\s@/]+)+)@(?<ref>[^\s@]+)$/i;

function rules(m: Manifest, out: Finding[]): void {
  unknownKeys(m, KNOWN.top, "", out);
  if (m.spec === undefined) out.push(finding("info", "spec-missing", `add spec: ${MANIFEST_SPEC} so readers know which rules apply`, "spec"));

  if (!PLACEHOLDER.test(m.paper) && !PAPER_PATTERNS.some((re) => re.test(m.paper))) {
    out.push(finding("error", "paper-format", `"${m.paper}" is not a DOI (10.xxxx/...), arXiv id or bioRxiv DOI`, "paper"));
  }

  // env
  unknownKeys(m.env, KNOWN.env, "env", out);
  const c = m.env.container;
  if (!PLACEHOLDER.test(c)) {
    const digest = c.startsWith("sha256:") ? c : c.includes("@sha256:") ? c.slice(c.indexOf("@") + 1) : null;
    if (digest === null) {
      out.push(
        finding("error", "container-not-pinned", `container "${c}" is pinned by tag, and tags can be moved. Pin it by digest: name@sha256:<hex>`, "env.container"),
      );
    } else if (!isSha256Ref(digest)) {
      out.push(finding("error", "container-digest-invalid", "container digest must be sha256: followed by 64 lowercase hex characters", "env.container"));
    }
  }

  const code = m.env.code;
  if (!PLACEHOLDER.test(code)) {
    const match = CODE_RE.exec(code);
    if (!match?.groups) {
      out.push(finding("error", "code-format", `code "${code}" must look like host/org/repo@<commit>, e.g. github.com/org/repo@<40 hex>`, "env.code"));
    } else {
      const ref = match.groups.ref!;
      if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(ref)) {
        // full commit sha (SHA-1 or SHA-256 object format)
      } else if (/^[0-9a-f]{7,39}$/i.test(ref)) {
        out.push(finding("error", "code-short-sha", `"${ref}" is an abbreviated commit. Use the full 40-character SHA; short ones can become ambiguous`, "env.code"));
      } else {
        out.push(finding("error", "code-not-pinned", `"${ref}" is a branch or tag, not a commit. Branches move; pin the full commit SHA`, "env.code"));
      }
    }
  }

  const data = m.env.data;
  if (!data || data.length === 0) {
    out.push(finding("warning", "data-missing", "no datasets pinned by hash. Data fetched at run time can change between runs", "env.data"));
  } else {
    const seen = new Set<string>();
    data.forEach((d, i) => {
      const p = typeof d === "string" ? `env.data[${i}]` : `env.data[${i}].sha256`;
      const h = typeof d === "string" ? d : d.sha256;
      if (PLACEHOLDER.test(h)) return;
      if (!isSha256Ref(h)) out.push(finding("error", "data-hash-invalid", `"${h}" is not sha256: followed by 64 lowercase hex characters`, p));
      if (seen.has(h)) out.push(finding("warning", "data-duplicate", "this dataset hash is listed twice", p));
      seen.add(h);
    });
  }

  const seeds = m.env.seeds;
  if (seeds === undefined) {
    out.push(finding("warning", "seeds-missing", "no random seeds recorded. Write seeds: [] if the pipeline is fully deterministic", "env.seeds"));
  } else if (seeds.length === 0) {
    out.push(finding("info", "seeds-empty", "seeds is empty: fine only if no step draws random numbers", "env.seeds"));
  } else if (new Set(seeds).size !== seeds.length) {
    out.push(finding("warning", "seeds-duplicate", "the same seed is listed more than once", "env.seeds"));
  }

  // claims
  const ids = new Map<string, number>();
  m.claims.forEach((claim, i) => {
    const p = `claims[${i}]`;
    unknownKeys(claim, KNOWN.claim, p, out);
    const first = ids.get(claim.id);
    if (first !== undefined) out.push(finding("error", "claim-duplicate-id", `claim id "${claim.id}" is already used by claims[${first}]`, `${p}.id`));
    else ids.set(claim.id, i);
    if (/\s/.test(claim.id)) out.push(finding("warning", "claim-id-format", "claim ids should not contain spaces", `${p}.id`));
    for (const key of ["tolerance", "partial"] as const) {
      const t = claim[key];
      if (t !== undefined && typeof t === "object") unknownKeys(t, KNOWN.tolerance, `${p}.${key}`, out);
    }
    claimRules(claim, p, out);
  });

  // run
  unknownKeys(m.run, KNOWN.run, "run", out);
  if (!["gpu-tee", "local"].includes(m.run.where)) {
    out.push(finding("info", "run-where-unknown", `run.where "${m.run.where}" is not one of gpu-tee, local`, "run.where"));
  }
  if (m.run.confirm !== "independent-node") {
    out.push(
      finding("warning", "run-no-confirm", "without confirm: independent-node there is no second run, and verdicts stay unconfirmed", "run.confirm"),
    );
  }
}

function claimRules(claim: Claim, p: string, out: Finding[]): void {
  const type = claim.type ?? "numeric";
  const tol = claim.tolerance;

  if (type === "numeric") {
    if (claim.reported === undefined) out.push(finding("error", "claim-no-reported", "numeric claim has no reported value", `${p}.reported`));
    if (tol === undefined) {
      out.push(finding("error", "claim-no-tolerance", "claim has no tolerance. Write it before the run, or any result can be argued to match", `${p}.tolerance`));
      return;
    }
    if (hasRmsd(tol)) out.push(finding("error", "tolerance-wrong-kind", "rmsd only applies to structure claims", `${p}.tolerance.rmsd`));
    if (!hasNumericBand(tol)) {
      out.push(finding("error", "tolerance-empty", "tolerance needs abs or rel", `${p}.tolerance`));
      return;
    }
    if (claim.reported === undefined) return;
    const band = numericBand(tol, claim.reported);
    const nullValue = claim.null_value ?? 0;
    if (band === 0) {
      out.push(finding("warning", "tolerance-zero", "tolerance is zero: only a bit-for-bit match counts, which re-runs on other hardware rarely give", `${p}.tolerance`));
    } else if (claim.reported !== nullValue && withinBand(claim.reported - nullValue, band, claim.reported)) {
      out.push(
        finding(
          "warning",
          "tolerance-crosses-null",
          `band ±${fmt(band)} reaches the value of no effect (${nullValue}): a re-run showing no effect would still count as Replicated`,
          `${p}.tolerance`,
        ),
      );
    }
    if (claim.partial !== undefined) partialRules(claim.partial, band, claim.reported, p, out);
  } else if (type === "structure") {
    out.push(finding("info", "claim-type-draft", "structure claims are draft in v0: the re-run value is an RMSD in angstrom", `${p}.type`));
    if (tol === undefined) out.push(finding("error", "claim-no-tolerance", "structure claim has no tolerance; set tolerance.rmsd", `${p}.tolerance`));
    else if (!hasRmsd(tol)) out.push(finding("error", "tolerance-wrong-kind", "structure claims need tolerance.rmsd (angstrom)", `${p}.tolerance`));
    if (claim.reference === undefined) out.push(finding("warning", "claim-no-reference", "structure claim has no reference (PDB id or file hash)", `${p}.reference`));
  } else {
    out.push(finding("info", "claim-type-draft", "figure claims are draft in v0: figures are not compared automatically, results must carry a reviewer verdict", `${p}.type`));
    if (claim.reference === undefined) out.push(finding("warning", "claim-no-reference", "figure claim has no reference (file hash of the paper's figure)", `${p}.reference`));
  }
}

function partialRules(partial: Tolerance, band: number, reported: number, p: string, out: Finding[]): void {
  if (!hasNumericBand(partial)) {
    out.push(finding("error", "tolerance-empty", "partial band needs abs or rel", `${p}.partial`));
    return;
  }
  if (numericBand(partial, reported) <= band) {
    out.push(finding("error", "partial-narrower", "partial band must be wider than the tolerance band, or Partially replicated can never be reached", `${p}.partial`));
  }
}

function fmt(n: number): string {
  return Number(n.toPrecision(6)).toString();
}
