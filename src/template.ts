/** Written by `huygena-verify init`. Every <placeholder> is a lint error until it is filled in. */
export const MANIFEST_TEMPLATE = `# Huygena run manifest, spec v0 (draft). Field reference: SPEC.md
# Check it with: huygena-verify manifest manifest.yaml
spec: manifest.v0

# DOI (10.xxxx/...), arXiv id (arxiv:2101.00001) or bioRxiv DOI (10.1101/...).
paper: "doi:<doi>"

# One entry per number in the paper you want checked.
# tolerance is written BEFORE the run: abs, rel (fraction of |reported|), or both (added).
claims:
  - id: table_2.auroc
    description: "<what this number is>"
    reported: 0.912          # value printed in the paper
    tolerance: 0.005         # same as { abs: 0.005 }
    null_value: 0.5          # value of no effect; AUROC 0.5 is chance
  - id: figure_3b.slope
    reported: 0.84
    tolerance: { abs: 0.01, rel: 0.02 }
    # partial: { abs: 0.06 } # optional band for "Partially replicated"; default is 3x the tolerance band (draft)

env:
  # Pin the container by digest, not by tag: name@sha256:<64 hex> or sha256:<64 hex>.
  container: "<registry/image>@sha256:<digest>"
  # Pin the code by full commit SHA, not by branch.
  code: "github.com/<org>/<repo>@<40-character commit sha>"
  # Every dataset by SHA-256.
  data:
    - "sha256:<dataset hash>"
  # Random seeds. Write [] only if no step draws random numbers.
  seeds: [0, 1, 2]
  # command: ["python", "reproduce.py", "--all"]

run:
  where: gpu-tee             # gpu-tee on Huygena, local for a re-run kit
  confirm: independent-node  # a second node re-runs before any verdict
`;
