import {
  RULES_VERSION,
  VERDICTS,
  type Claim,
  type ClaimResult,
  type ClaimType,
  type Manifest,
  type NodeResults,
  type StepLabel,
  type Verdict,
} from "./schema";
import { hasNumericBand, hasRmsd, numericBand, withinBand } from "./tolerance";

/**
 * Default width of the Partially replicated band, as a multiple of the claim's
 * tolerance band, for claims that do not set `partial`. Draft v0: a starting
 * point, not a settled rule. Override per claim with `partial`, or per call
 * with `partialFactor`. A factor of 1 turns the default partial band off.
 */
export const DEFAULT_PARTIAL_FACTOR = 3;

export interface CompareOptions {
  /** Default partial band = partialFactor × tolerance band. Default 3 (draft). Must be >= 1. */
  partialFactor?: number;
}

export interface NodeOutcome {
  node: string;
  /** Re-run value. For structure claims this is the RMSD in angstrom. */
  value: number | null;
  /** value - reported for numeric claims; null otherwise. */
  delta: number | null;
  verdict: Verdict;
  reason: string;
}

export interface ClaimComparison {
  id: string;
  type: ClaimType;
  reported: number | null;
  /** Tolerance band: ± for numeric claims, max RMSD for structure claims. */
  band: number | null;
  /** Partially replicated band, same units as `band`. */
  partialBand: number | null;
  /** One entry per node, in the order the results were given. */
  nodes: NodeOutcome[];
  /** The claim's verdict, or null when the two nodes disagree. */
  verdict: Verdict | null;
  /** Two nodes ran and reached different verdicts. Listed in the mismatch log; no verdict is issued. */
  mismatch: boolean;
  /** Two nodes reached the same verdict. */
  confirmed: boolean;
  /** `replicated` when two nodes ran and agree; otherwise `unverified`. This tool never claims `attested only`: it does not check attestation. */
  label: StepLabel;
  reason: string;
  /** |value(A) - value(B)| when both nodes returned a value. */
  nodeDelta: number | null;
}

export interface CompareReport {
  rules: { version: typeof RULES_VERSION; partialFactor: number };
  nodes: string[];
  claims: ClaimComparison[];
  summary: {
    total: number;
    counts: Record<Verdict, number>;
    mismatches: number;
    /** Two nodes were compared. */
    twoNodes: boolean;
    /** Every claim is Replicated (and, with two nodes, both agree). */
    allReplicated: boolean;
  };
  /** Things worth knowing that do not change a verdict, e.g. result ids not in the manifest. */
  notes: string[];
}

export class CompareError extends Error {
  override name = "CompareError";
}

/**
 * Turn re-run values into per-claim verdicts using the tolerances written in
 * the manifest. Pass one node's results, or two (primary and confirming).
 * With two nodes a verdict is issued only when both reach the same one;
 * otherwise the claim is a mismatch. Rules: SPEC.md, "Verdict rules (draft v0)".
 */
export function compare(manifest: Manifest, results: NodeResults | NodeResults[], options: CompareOptions = {}): CompareReport {
  const nodes = Array.isArray(results) ? results : [results];
  if (nodes.length < 1 || nodes.length > 2) throw new CompareError(`expected results from 1 or 2 nodes, got ${nodes.length}`);
  if (nodes.length === 2 && nodes[0]!.node === nodes[1]!.node) {
    throw new CompareError(`both results come from node "${nodes[0]!.node}"; confirmation needs an independent node`);
  }
  const partialFactor = options.partialFactor ?? DEFAULT_PARTIAL_FACTOR;
  if (!Number.isFinite(partialFactor) || partialFactor < 1) throw new CompareError("partialFactor must be a number >= 1");

  const problems = manifest.claims.flatMap((c) => usable(c));
  if (problems.length) throw new CompareError(`manifest cannot be compared: ${problems.join("; ")}`);

  const notes: string[] = [];
  const known = new Set(manifest.claims.map((c) => c.id));
  for (const n of nodes) {
    for (const id of Object.keys(n.claims)) if (!known.has(id)) notes.push(`${n.node} reports "${id}", which is not a claim in the manifest; ignored`);
  }

  const claims = manifest.claims.map((claim) => compareClaim(claim, nodes, partialFactor, notes));
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  let mismatches = 0;
  for (const c of claims) {
    if (c.verdict) counts[c.verdict]++;
    else mismatches++;
  }
  return {
    rules: { version: RULES_VERSION, partialFactor },
    nodes: nodes.map((n) => n.node),
    claims,
    summary: {
      total: claims.length,
      counts,
      mismatches,
      twoNodes: nodes.length === 2,
      allReplicated: mismatches === 0 && counts.Replicated === claims.length,
    },
    notes,
  };
}

function usable(c: Claim): string[] {
  const type = c.type ?? "numeric";
  const t = c.tolerance;
  if (type === "numeric") {
    if (c.reported === undefined) return [`${c.id} has no reported value`];
    if (t === undefined || !hasNumericBand(t)) return [`${c.id} has no abs/rel tolerance`];
  }
  if (type === "structure" && (t === undefined || !hasRmsd(t))) return [`${c.id} has no tolerance.rmsd`];
  return [];
}

function compareClaim(claim: Claim, nodes: NodeResults[], factor: number, notes: string[]): ClaimComparison {
  const type = claim.type ?? "numeric";
  let band: number | null = null;
  let partialBand: number | null = null;
  if (type === "numeric") {
    band = numericBand(claim.tolerance!, claim.reported!);
    partialBand = claim.partial !== undefined && hasNumericBand(claim.partial) ? numericBand(claim.partial, claim.reported!) : factor * band;
  } else if (type === "structure") {
    band = (claim.tolerance as { rmsd: number }).rmsd;
    const p = claim.partial;
    partialBand = p !== undefined && hasRmsd(p) ? p.rmsd : factor * band;
  }

  const outcomes = nodes.map((n) => judge(claim, type, n, band, partialBand, notes));
  const reported = type === "numeric" ? claim.reported! : null;
  const values = outcomes.map((o) => o.value);
  const nodeDelta = values.length === 2 && values[0] != null && values[1] != null ? Math.abs(values[0] - values[1]) : null;
  const base = { id: claim.id, type, reported, band, partialBand, nodes: outcomes, nodeDelta };

  if (outcomes.length === 1) {
    const o = outcomes[0]!;
    return { ...base, verdict: o.verdict, mismatch: false, confirmed: false, label: "unverified", reason: `${o.reason}. One node only: not confirmed` };
  }
  const [a, b] = outcomes as [NodeOutcome, NodeOutcome];
  if (a.verdict !== b.verdict) {
    return {
      ...base,
      verdict: null,
      mismatch: true,
      confirmed: false,
      label: "unverified",
      reason: `nodes disagree: ${a.node} ${a.verdict} (${a.reason}); ${b.node} ${b.verdict} (${b.reason})`,
    };
  }
  const ran = a.verdict !== "Could not run";
  return {
    ...base,
    verdict: a.verdict,
    mismatch: false,
    confirmed: true,
    label: ran ? "replicated" : "unverified",
    reason: a.reason === b.reason ? `${a.reason}, on both nodes` : `${a.node}: ${a.reason}; ${b.node}: ${b.reason}`,
  };
}

interface Value {
  value: number | null;
  error?: string;
  verdict?: Verdict;
  note?: string;
  present: boolean;
}

function read(r: ClaimResult | undefined): Value {
  if (r === undefined) return { value: null, present: false };
  if (r === null) return { value: null, present: true };
  if (typeof r === "number") return { value: r, present: true };
  return { value: r.value ?? null, error: r.error, verdict: r.verdict, note: r.note, present: true };
}

function judge(claim: Claim, type: ClaimType, n: NodeResults, band: number | null, partialBand: number | null, notes: string[]): NodeOutcome {
  const v = read(n.claims[claim.id]);
  const out = (verdict: Verdict, reason: string, delta: number | null = null): NodeOutcome => ({ node: n.node, value: v.value, delta, verdict, reason });

  if (v.error !== undefined) return out("Could not run", v.error);
  if (!v.present) return out("Could not run", `no value reported by ${n.node}`);

  if (type === "figure") {
    if (v.verdict) return out(v.verdict, v.note ?? "reviewer verdict; figures are not compared automatically in v0");
    return out("Could not run", "no reviewer verdict supplied; figures are not compared automatically in v0");
  }
  if (v.verdict) notes.push(`${n.node} sent a verdict for ${type} claim "${claim.id}"; ignored, verdicts are computed from values`);
  if (v.value === null) return out("Could not run", "no value");

  if (type === "structure") {
    const rmsd = v.value;
    if (rmsd < 0) return out("Could not run", `RMSD ${rmsd} is negative, so it is not a valid measurement`);
    if (withinBand(rmsd, band!, rmsd)) return out("Replicated", `RMSD ${f(rmsd)} Å <= ${f(band!)} Å`);
    if (withinBand(rmsd, partialBand!, rmsd)) return out("Partially replicated", `RMSD ${f(rmsd)} Å > ${f(band!)} Å, within partial ${f(partialBand!)} Å`);
    return out("Failed", `RMSD ${f(rmsd)} Å > partial ${f(partialBand!)} Å`);
  }

  const reported = claim.reported!;
  const delta = v.value - reported;
  if (withinBand(delta, band!, reported)) return out("Replicated", `within ±${f(band!)}`, delta);

  const nullValue = claim.null_value ?? 0;
  const sameSide = reported === nullValue || Math.sign(v.value - nullValue) === Math.sign(reported - nullValue);
  const inPartial = withinBand(delta, partialBand!, reported);
  if (inPartial && sameSide) return out("Partially replicated", `outside ±${f(band!)}, within partial ±${f(partialBand!)}, same direction`, delta);
  if (!sameSide) return out("Failed", `opposite side of the value of no effect (${nullValue}) from the paper`, delta);
  return out("Failed", `outside partial ±${f(partialBand!)}`, delta);
}

/** Short number formatting for reasons: up to 6 significant digits, no float noise. */
export function f(n: number): string {
  return Number(n.toPrecision(6)).toString();
}
