import { compare, CompareError } from "./compare";
import { manifestHash, parseManifest } from "./manifest";
import { RULES_VERSION, CertificateSchema, normalizeStepLabel, type Bundle, type Certificate, type NodeResults } from "./schema";

export type CheckStatus = "pass" | "fail" | "skipped" | "planned";

export interface CertificateCheck {
  /** Stable id: schema, manifest-hash, claims-match, verdicts, confirmation, bundle-root, attestation-file, step-outputs, attestation-signature, onchain-record. */
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface CertificateReport {
  /** No check failed. `skipped` and `planned` checks do not fail a certificate, but they are not passes either. */
  ok: boolean;
  certificate: Certificate | null;
  checks: CertificateCheck[];
  counts: Record<CheckStatus, number>;
}

export interface VerifyCertificateOptions {
  /** The run manifest, as YAML/JSON text or a parsed value. Enables manifest-hash, claims-match and verdicts. */
  manifest?: string | unknown;
  /** The evidence bundle, e.g. from `hashBundle` or `hashFiles`. Enables bundle-root, attestation-file and step-outputs. */
  bundle?: Bundle;
}

/**
 * Re-check a certificate.v0 offline: recompute the manifest hash and the
 * evidence bundle root and compare them with the certificate, check that each
 * verdict follows from the re-run values and the manifest's tolerances, and
 * that the attestation report and step outputs are in the bundle.
 *
 * Attestation signature verification (NVIDIA, Intel TDX) and the on-chain
 * lookup are not implemented: they are reported as `planned`, never as passes.
 */
export async function verifyCertificate(cert: unknown, options: VerifyCertificateOptions = {}): Promise<CertificateReport> {
  const checks: CertificateCheck[] = [];
  const add = (id: string, status: CheckStatus, detail: string) => checks.push({ id, status, detail });

  const parsed = CertificateSchema.safeParse(cert);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    add("schema", "fail", `not a certificate.v0: ${i.path.join(".") || "(root)"}: ${i.message}`);
    return finish(null, checks);
  }
  const c = parsed.data;
  add("schema", "pass", "certificate.v0 shape");

  // Confirmation: a verdict needs an independent second node.
  if (c.nodes.confirming === null) add("confirmation", "fail", "no confirming node; verdicts are issued only after an independent re-run");
  else if (c.nodes.confirming === c.nodes.primary) add("confirmation", "fail", `confirming node is the primary node (${c.nodes.primary})`);
  else add("confirmation", "pass", `${c.nodes.primary} confirmed by ${c.nodes.confirming}`);

  // Manifest checks.
  if (options.manifest === undefined) {
    for (const id of ["manifest-hash", "claims-match", "verdicts"]) add(id, "skipped", "no manifest given");
  } else {
    let hash: string | null = null;
    try {
      hash = await manifestHash(options.manifest);
    } catch (err) {
      add("manifest-hash", "fail", `manifest could not be read: ${(err as Error).message}`);
    }
    if (hash !== null) {
      add("manifest-hash", hash === c.manifest ? "pass" : "fail", hash === c.manifest ? `${hash} matches` : `manifest hashes to ${hash}, certificate says ${c.manifest}`);
    }
    const pm = parseManifest(options.manifest);
    if (!pm.manifest) {
      add("claims-match", "fail", `manifest does not match the v0 schema: ${pm.findings[0]?.path}: ${pm.findings[0]?.message}`);
      add("verdicts", "skipped", "manifest is not valid");
    } else {
      const m = pm.manifest;
      const problems: string[] = [];
      if (m.paper !== c.paper) problems.push(`paper is ${c.paper} on the certificate, ${m.paper} in the manifest`);
      const mIds = new Map(m.claims.map((x) => [x.id, x]));
      const cIds = new Set(c.claims.map((x) => x.id));
      for (const id of mIds.keys()) if (!cIds.has(id)) problems.push(`claim ${id} is in the manifest but not on the certificate`);
      for (const cl of c.claims) {
        const mc = mIds.get(cl.id);
        if (!mc) problems.push(`claim ${cl.id} is on the certificate but not in the manifest`);
        else if (cl.reported !== undefined && mc.reported !== cl.reported) problems.push(`claim ${cl.id} reported ${cl.reported}, manifest says ${mc.reported}`);
      }
      add("claims-match", problems.length ? "fail" : "pass", problems.length ? problems.join("; ") : `${c.claims.length} claims, same ids and reported values as the manifest`);
      verdictCheck(c, m, add);
    }
  }

  // Bundle checks.
  if (!options.bundle) {
    for (const id of ["bundle-root", "attestation-file", "step-outputs"]) add(id, "skipped", "no evidence bundle given");
  } else {
    const b = options.bundle;
    add("bundle-root", b.root === c.bundle ? "pass" : "fail", b.root === c.bundle ? `${b.root} matches (${b.files.length} files)` : `bundle hashes to ${b.root}, certificate says ${c.bundle}`);
    const byPath = new Map(b.files.map((f) => [f.path, f]));
    const a = c.attestation;
    if (a.hash === null) add("attestation-file", "fail", "certificate has no attestation hash");
    else if (!a.path) add("attestation-file", "skipped", "certificate does not say where the attestation report is in the bundle");
    else {
      const f = byPath.get(a.path);
      if (!f) add("attestation-file", "fail", `${a.path} is not in the bundle`);
      else add("attestation-file", f.sha256 === a.hash ? "pass" : "fail", f.sha256 === a.hash ? `${a.path} hashes to the attestation hash` : `${a.path} hashes to ${f.sha256}, certificate says ${a.hash}`);
    }
    const steps = c.steps ?? [];
    const outputs = steps.flatMap((s) => (s.outputs ?? []).map((o) => ({ step: s.name, path: o })));
    if (!outputs.length) add("step-outputs", "skipped", "no step outputs listed");
    else {
      const missing = outputs.filter((o) => !byPath.has(o.path));
      add(
        "step-outputs",
        missing.length ? "fail" : "pass",
        missing.length
          ? `not in the bundle: ${missing.map((o) => `${o.path} (${o.step})`).join(", ")}`
          : `${outputs.length} outputs of ${steps.length} steps are in the bundle (${labelSummary(c)})`,
      );
    }
  }

  add(
    "attestation-signature",
    "planned",
    "not implemented in this version: checking the report against NVIDIA remote attestation and Intel TDX quote verification",
  );
  add("onchain-record", "planned", "not implemented: Huygena contracts are not deployed yet, so there is no record to read");
  return finish(c, checks);
}

function verdictCheck(c: Certificate, m: NonNullable<ReturnType<typeof parseManifest>["manifest"]>, add: (id: string, s: CheckStatus, d: string) => void): void {
  const version = c.rules?.version ?? RULES_VERSION;
  if (version !== RULES_VERSION) {
    add("verdicts", "skipped", `certificate uses rules ${version}; this tool implements ${RULES_VERSION}`);
    return;
  }
  const nodeIds = [c.nodes.primary, ...(c.nodes.confirming && c.nodes.confirming !== c.nodes.primary ? [c.nodes.confirming] : [])];
  const results: NodeResults[] = nodeIds.map((node) => ({ node, claims: {} }));
  for (const cl of c.claims) {
    results.forEach((r) => {
      const v = cl.values?.[r.node];
      if (v !== undefined) r.claims[cl.id] = v === null ? { value: null, error: cl.reason ?? "no value" } : v;
      else if (cl.verdict === "Could not run") r.claims[cl.id] = { error: cl.reason ?? "could not run" };
      // Figure claims carry a reviewer verdict, not a number.
      const mc = m.claims.find((x) => x.id === cl.id);
      if ((mc?.type ?? "numeric") === "figure" && cl.verdict) r.claims[cl.id] = { verdict: cl.verdict, note: cl.reason };
    });
  }
  let report;
  try {
    report = compare(m, results, { partialFactor: c.rules?.partial_factor });
  } catch (err) {
    add("verdicts", "fail", err instanceof CompareError ? err.message : String(err));
    return;
  }
  const wrong: string[] = [];
  for (const cl of c.claims) {
    const r = report.claims.find((x) => x.id === cl.id);
    if (!r) continue;
    if (r.mismatch !== (cl.mismatch ?? false) || r.verdict !== cl.verdict) {
      wrong.push(`${cl.id}: certificate says ${cl.verdict ?? "mismatch"}, values give ${r.verdict ?? "mismatch"}`);
    }
  }
  add(
    "verdicts",
    wrong.length ? "fail" : "pass",
    wrong.length ? wrong.join("; ") : `${c.claims.length} verdicts follow from the re-run values and the manifest tolerances (rules ${RULES_VERSION})`,
  );
}

function labelSummary(c: Certificate): string {
  const counts = new Map<string, number>();
  for (const s of c.steps ?? []) {
    const l = normalizeStepLabel(s.label);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts].map(([l, n]) => `${n} ${l}`).join(", ");
}

function finish(certificate: Certificate | null, checks: CertificateCheck[]): CertificateReport {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, skipped: 0, planned: 0 };
  for (const ch of checks) counts[ch.status]++;
  return { ok: counts.fail === 0, certificate, checks, counts };
}
