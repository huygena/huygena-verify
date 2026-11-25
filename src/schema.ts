import { z } from "zod";

/** The four verdicts a claim can get. Names are fixed by the Huygena whitepaper. */
export const VERDICTS = ["Replicated", "Partially replicated", "Failed", "Could not run"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Step labels. `attested only` is also written "attested, not replicated" in the docs; both are accepted. */
export const STEP_LABELS = ["replicated", "attested only", "unverified"] as const;
export type StepLabel = (typeof STEP_LABELS)[number];
const STEP_LABEL_INPUTS = [...STEP_LABELS, "attested, not replicated"] as const;

/** Claim types. Only `numeric` has settled rules; `structure` and `figure` are draft in v0. */
export const CLAIM_TYPES = ["numeric", "structure", "figure"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const MANIFEST_SPEC = "manifest.v0";
export const RESULTS_SPEC = "results.v0";
export const BUNDLE_SPEC = "bundle.v0";
export const CERTIFICATE_SPEC = "certificate.v0";
/** Version of the tolerance and verdict rules implemented by `compare`. Draft. */
export const RULES_VERSION = "v0-draft";

const sha256Ref = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected sha256: followed by 64 lowercase hex characters")
  .describe("sha256:<64 lowercase hex>");

const nonNeg = z.number().nonnegative();

export const ToleranceSchema = z
  .union([
    nonNeg.describe("Shorthand for { abs: <number> }."),
    z.looseObject({
      abs: nonNeg.optional().describe("Absolute band: |rerun - reported| <= abs."),
      rel: nonNeg.optional().describe("Relative band as a fraction of |reported| (0.02 = 2%). Added to abs when both are set."),
      rmsd: nonNeg.optional().describe("Structure claims (draft): largest accepted RMSD in angstrom."),
    }),
  ])
  .describe("How far the re-run value may be from the reported value and still count as Replicated. Written before the run.");

export const ClaimSchema = z
  .looseObject({
    id: z.string().min(1).describe("Stable claim id, e.g. table_2.auroc."),
    description: z.string().optional(),
    type: z.enum(CLAIM_TYPES).optional().describe("Default numeric. structure and figure are draft in v0."),
    reported: z.number().optional().describe("The value printed in the paper. Required for numeric claims."),
    unit: z.string().optional(),
    tolerance: ToleranceSchema.optional(),
    partial: ToleranceSchema.optional().describe(
      "Optional band for Partially replicated. Default: partial_factor times the tolerance band (draft).",
    ),
    null_value: z
      .number()
      .optional()
      .describe("Value of no effect, used for the direction check. 0 for differences and slopes, 1 for ratios, 0.5 for AUROC. Default 0."),
    reference: z.string().optional().describe("structure and figure claims: what the re-run is compared with (PDB id, file hash)."),
  })
  .describe("One claim from the paper to check.");

export const DataRefSchema = z.union([
  z.string().describe("sha256:<hex> of a dataset."),
  z.looseObject({
    sha256: z.string(),
    path: z.string().optional(),
    url: z.string().optional(),
  }),
]);

export const EnvSchema = z.looseObject({
  container: z.string().describe("Container image pinned by digest: sha256:<hex> or name@sha256:<hex>."),
  code: z.string().describe("Code at a fixed commit: host/org/repo@<full commit sha>."),
  data: z.array(DataRefSchema).optional().describe("Datasets by hash."),
  seeds: z.array(z.number().int()).optional().describe("Random seeds, so the run can be repeated."),
  command: z.union([z.string(), z.array(z.string())]).optional().describe("Entry point run inside the container."),
  params: z.record(z.string(), z.unknown()).optional().describe("Parameters passed to the pipeline."),
});

export const RunSchema = z.looseObject({
  where: z.string().describe("Where it runs: gpu-tee (Huygena) or local (re-run kit)."),
  confirm: z.string().describe("How it is confirmed: independent-node, or none."),
});

export const ManifestSchema = z
  .looseObject({
    spec: z.literal(MANIFEST_SPEC).optional().describe("Spec version. Recommended."),
    paper: z.string().describe("DOI, arXiv id or bioRxiv DOI."),
    title: z.string().optional(),
    claims: z.array(ClaimSchema).min(1),
    env: EnvSchema,
    run: RunSchema,
  })
  .describe("Huygena run manifest v0 (draft). The contract between the paper and the re-run.");

export const ClaimResultSchema = z.union([
  z.number().describe("The re-run value."),
  z.null().describe("No value: the claim could not be run."),
  z.looseObject({
    value: z.number().nullable().optional(),
    error: z.string().optional().describe("Why the claim could not be run."),
    verdict: z.enum(VERDICTS).optional().describe("figure claims only (draft): verdict from a reviewer, since v0 does not compare figures."),
    note: z.string().optional(),
  }),
]);

export const NodeResultsSchema = z
  .looseObject({
    spec: z.literal(RESULTS_SPEC).optional(),
    node: z.string().min(1).describe("Id of the node that produced these values."),
    manifest: sha256Ref.optional().describe("Manifest hash the node ran. Checked when present."),
    claims: z.record(z.string(), ClaimResultSchema),
  })
  .describe("Re-run values from one node, keyed by claim id.");

export const BundleFileSchema = z.object({
  path: z.string().min(1),
  sha256: sha256Ref,
  size: z.number().int().nonnegative(),
});

export const BundleSchema = z
  .object({
    spec: z.literal(BUNDLE_SPEC),
    algorithm: z.literal("sha256"),
    root: sha256Ref,
    files: z.array(BundleFileSchema),
    ignore: z.array(z.string()).optional(),
  })
  .describe("Content-addressed evidence bundle. root is defined in SPEC.md.");

export const CertificateClaimSchema = z.looseObject({
  id: z.string().min(1),
  reported: z.number().optional(),
  values: z.record(z.string(), z.number().nullable()).optional().describe("Re-run value per node id."),
  verdict: z.enum(VERDICTS).nullable().describe("null while the two nodes disagree."),
  mismatch: z.boolean().optional(),
  reason: z.string().optional(),
});

export const CertificateStepSchema = z.looseObject({
  name: z.string().min(1),
  label: z.enum(STEP_LABEL_INPUTS),
  outputs: z.array(z.string()).optional().describe("Paths in the evidence bundle produced by this step."),
});

export const CertificateSchema = z
  .looseObject({
    spec: z.literal(CERTIFICATE_SPEC),
    run: z.string().min(1),
    paper: z.string(),
    issued: z.string().optional(),
    manifest: sha256Ref.describe("manifestHash of the run manifest."),
    bundle: sha256Ref.describe("Root hash of the evidence bundle."),
    attestation: z.looseObject({
      hash: sha256Ref.nullable().describe("SHA-256 of the attestation report."),
      path: z.string().optional().describe("Where the report sits in the evidence bundle."),
      format: z.string().optional(),
    }),
    nodes: z.looseObject({
      primary: z.string().min(1),
      confirming: z.string().nullable(),
    }),
    rules: z
      .looseObject({
        version: z.string(),
        partial_factor: z.number().positive().optional(),
      })
      .optional(),
    claims: z.array(CertificateClaimSchema).min(1),
    steps: z.array(CertificateStepSchema).optional(),
    chain: z
      .looseObject({
        network: z.string().nullable(),
        contract: z.string().nullable(),
        tx: z.string().nullable(),
      })
      .optional(),
  })
  .describe("Huygena replication certificate v0 (draft).");

export type Tolerance = z.infer<typeof ToleranceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type DataRef = z.infer<typeof DataRefSchema>;
export type Env = z.infer<typeof EnvSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type ClaimResult = z.infer<typeof ClaimResultSchema>;
export type NodeResults = z.infer<typeof NodeResultsSchema>;
export type BundleFile = z.infer<typeof BundleFileSchema>;
export type Bundle = z.infer<typeof BundleSchema>;
export type CertificateClaim = z.infer<typeof CertificateClaimSchema>;
export type CertificateStep = z.infer<typeof CertificateStepSchema>;
export type Certificate = z.infer<typeof CertificateSchema>;

/** Maps the docs spelling "attested, not replicated" to `attested only`. */
export function normalizeStepLabel(label: string): StepLabel {
  return label === "attested, not replicated" ? "attested only" : (label as StepLabel);
}
