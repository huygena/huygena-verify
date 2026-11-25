# huygena-verify spec v0 (draft)

> **Draft.** This is the v0 format used by `huygena-verify` 0.1.0. Field names, lint rules and the tolerance rules can change before Huygena launches. Tolerance rules per claim type are an open item in the [Huygena whitepaper](https://docs.huygena.xyz/open-items); this document proposes a v0 for them and says where a number is a default rather than a decision.

Four JSON documents, each with a JSON Schema in [`schema/`](schema) generated from the zod schemas in [`src/schema.ts`](src/schema.ts):

| Document | `spec` value | Schema | What it is |
|---|---|---|---|
| Run manifest | `manifest.v0` | [`manifest.v0.schema.json`](schema/manifest.v0.schema.json) | What will run, on what, and what the paper claims. Written before the run. |
| Node results | `results.v0` | [`results.v0.schema.json`](schema/results.v0.schema.json) | Re-run values from one node. |
| Evidence bundle | `bundle.v0` | [`bundle.v0.schema.json`](schema/bundle.v0.schema.json) | Content-addressed list of the logs and outputs. |
| Certificate | `certificate.v0` | [`certificate.v0.schema.json`](schema/certificate.v0.schema.json) | The record of a replication: hashes, nodes, verdict per claim. |

All hashes are SHA-256, written `sha256:` followed by 64 lowercase hex characters.

## 1. Run manifest

YAML or JSON. YAML is read with the YAML 1.2 core schema: duplicate keys are an error and dates stay strings. The example from the Huygena docs parses as a v0 manifest unchanged.

```yaml
spec: manifest.v0
paper: "doi:10.5555/huygena.example.0001"
claims:
  - id: table_2.auroc
    reported: 0.912          # value printed in the paper
    tolerance: 0.005         # same as { abs: 0.005 }
    null_value: 0.5          # value of no effect
env:
  container: "ghcr.io/huygena/example-replication@sha256:43fb…2306"
  code: "github.com/huygena/example-replication@363f38da5807127e85f8885bc0172d9cf35b032c"
  data:
    - path: data/cohort_sample.csv
      sha256: "sha256:a77a…a6d0"
  seeds: [0, 1, 2]
run:
  where: gpu-tee
  confirm: independent-node
```

### Fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `spec` | recommended | `"manifest.v0"` | Spec version. |
| `paper` | yes | string | DOI (`10.xxxx/…`, optionally `doi:`), arXiv id (`arxiv:2101.00001`, `2101.00001`, old style `arxiv:hep-th/9901001`) or bioRxiv DOI (`10.1101/…`). |
| `title` | no | string | |
| `claims[]` | yes, at least 1 | object | Each claim to check. |
| `claims[].id` | yes | string | Stable id, e.g. `table_2.auroc`. Unique. |
| `claims[].description` | no | string | |
| `claims[].type` | no | `numeric` (default), `structure`, `figure` | `structure` and `figure` are draft. |
| `claims[].reported` | numeric: yes | number | The value printed in the paper. |
| `claims[].unit` | no | string | |
| `claims[].tolerance` | yes | number or `{ abs?, rel?, rmsd? }` | See [Tolerance rules](#3-tolerance-rules-draft-v0). A bare number means `{ abs: n }`. |
| `claims[].partial` | no | same shape as `tolerance` | Band for Partially replicated. |
| `claims[].null_value` | no | number, default `0` | Value of no effect, for the direction check. `0` for differences and slopes, `1` for ratios, `0.5` for AUROC. |
| `claims[].reference` | structure, figure | string | What the re-run is compared with: a PDB id or a file hash. |
| `env.container` | yes | string | `sha256:<hex>` or `name@sha256:<hex>`. |
| `env.code` | yes | string | `host/org/repo@<full commit sha>`. GitLab subgroups are fine. |
| `env.data[]` | recommended | `"sha256:<hex>"` or `{ sha256, path?, url? }` | Datasets by hash. |
| `env.seeds` | recommended | integer[] | Random seeds. `[]` means the pipeline draws no random numbers. |
| `env.command` | no | string or string[] | Entry point inside the container. |
| `env.params` | no | object | Parameters passed to the pipeline. |
| `run.where` | yes | string | `gpu-tee` (Huygena) or `local` (re-run kit). |
| `run.confirm` | yes | string | `independent-node`, or `none`. |

Keys starting with `x_` or `x-` are extensions: the linter does not flag them, and they are part of the manifest hash.

### Manifest hash

```
manifestHash = "sha256:" + hex( SHA-256( UTF-8( JCS( parsed manifest ) ) ) )
```

- *parsed manifest* is the document as parsed from YAML or JSON, before schema defaults or normalization. Every field counts, including unknown and `x_` fields.
- *JCS* is the JSON Canonicalization Scheme, [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785): object keys sorted by UTF-16 code units, no whitespace, numbers in ECMAScript `Number.prototype.toString` form (`1.0` → `1`, `0.0050` → `0.005`, `1e21` → `1e+21`), strings escaped as `JSON.stringify` does.
- `NaN`, `Infinity` (YAML `.nan`, `.inf`) and non-JSON values are rejected.

So comments, key order, whitespace, quoting and YAML versus JSON do not change the hash. Any change to a value does. Test vector: [`tests/canonical.test.ts`](tests/canonical.test.ts).

### Lint rules

`lintManifest` runs the schema check, then these rules. Errors make a manifest invalid. Warnings and info do not, unless the CLI runs with `--strict`.

| Rule id | Severity | Fires when |
|---|---|---|
| `syntax` | error | YAML/JSON does not parse, or a key is repeated. |
| `schema` | error | The document does not match `manifest.v0.schema.json`. |
| `placeholder` | error | A string still holds a `<placeholder>`, like the docs example. |
| `paper-format` | error | `paper` is not a DOI, arXiv id or bioRxiv DOI. |
| `container-not-pinned` | error | `env.container` uses a tag. Tags can be moved. |
| `container-digest-invalid` | error | The digest is not `sha256:` + 64 hex. |
| `code-format` | error | `env.code` is not `host/org/repo@ref`. |
| `code-not-pinned` | error | The ref is a branch or tag, not a commit. |
| `code-short-sha` | error | The ref is an abbreviated commit (7 to 39 hex). Short SHAs can become ambiguous. |
| `data-hash-invalid` | error | A dataset hash is not `sha256:` + 64 hex. |
| `data-duplicate` | warning | The same dataset hash appears twice. |
| `data-missing` | warning | No datasets pinned. |
| `seeds-missing` | warning | `env.seeds` is absent. |
| `seeds-empty` | info | `env.seeds` is `[]`. |
| `seeds-duplicate` | warning | A seed is listed twice. |
| `claim-duplicate-id` | error | Two claims share an id. |
| `claim-id-format` | warning | A claim id contains whitespace. |
| `claim-no-reported` | error | A numeric claim has no `reported`. |
| `claim-no-tolerance` | error | A claim has no `tolerance`. |
| `tolerance-empty` | error | A numeric tolerance or partial band has neither `abs` nor `rel`. |
| `tolerance-wrong-kind` | error | `rmsd` on a numeric claim, or a structure claim without `rmsd`. |
| `tolerance-zero` | warning | The band is 0: only a bit-for-bit match counts. |
| `tolerance-crosses-null` | warning | The band reaches `null_value`, so a re-run showing no effect would still be Replicated. |
| `partial-narrower` | error | `partial` is not wider than `tolerance`. |
| `claim-type-draft` | info | `structure` or `figure` claim: rules are draft. |
| `claim-no-reference` | warning | A structure or figure claim has no `reference`. |
| `run-where-unknown` | info | `run.where` is not `gpu-tee` or `local`. |
| `run-no-confirm` | warning | `run.confirm` is not `independent-node`. |
| `spec-missing` | info | No `spec` field. |
| `unknown-field` | warning | A field v0 does not define. Suggests the closest known name. |

## 2. Node results

One file per node.

```json
{
  "spec": "results.v0",
  "node": "node-a",
  "manifest": "sha256:3183…fbce",
  "claims": {
    "table_2.auroc": 0.9104,
    "supp_table_2.external_auroc": { "error": "external validation cohort is not public" }
  }
}
```

A claim value is a number, `null`, or an object `{ value?, error?, verdict?, note? }`. `verdict` is read only for figure claims. If `manifest` is present, the CLI checks that it equals the manifest hash.

## 3. Tolerance rules (draft v0)

For a numeric claim with reported value `r`:

```
band         = abs + rel × |r|                   (a bare number is abs; a missing part is 0)
delta        = rerun − r
partial band = band(partial)                     if the claim sets partial
             = partial_factor × band             otherwise
```

- This is the `numpy.isclose` form (`atol + rtol × |b|`) with the paper's value as the reference.
- Bounds are inclusive. Comparisons allow a relative slack of `1e-12` so that a value exactly on the edge counts as inside despite binary floating point (`0.917 − 0.912` is `0.0050000000000000044`). This is a rounding allowance, not a scientific threshold.
- **`partial_factor` defaults to 3.** This is a draft default, not a decision. It is explicit in every report (`rules.partialFactor`), can be set per call (`compare(..., { partialFactor })`, CLI `--partial-factor`), and is recorded on certificates (`rules.partial_factor`). A claim's own `partial` band always wins. `partial_factor: 1` turns the default partial band off.
- **Direction.** A re-run points the same way as the paper when `rerun − null_value` has the same sign as `r − null_value`. If `r` equals `null_value`, there is no direction to check.

Structure claims (draft): the re-run value is the RMSD in angstrom between the paper's structure (`reference`) and the re-run one. `band = tolerance.rmsd`, `partial band = partial.rmsd` or `partial_factor × band`. No direction check.

Figure claims (draft): v0 does not compare figures. The node's result must carry a reviewer `verdict`.

## 4. Verdict rules (draft v0)

### Per node

| Verdict | Numeric claim | Structure claim (draft) |
|---|---|---|
| `Replicated` | `|delta| <= band` | `rmsd <= band` |
| `Partially replicated` | outside `band`, `|delta| <= partial band`, and same direction | `band < rmsd <= partial band` |
| `Failed` | outside `partial band`, or opposite direction | `rmsd > partial band` |
| `Could not run` | no value, `null`, or an `error` (the reason is kept) | same, or a negative RMSD |

"Partially replicated" follows the docs: *the result points the same way but does not fully match.* "Failed" means not reproduced with the published code and data. It never means fraud.

### Two nodes

- Both nodes reach the same verdict: that is the claim's verdict. `confirmed: true`.
- They reach different verdicts: **mismatch**. No verdict is issued (`verdict: null`, `mismatch: true`), and both results are shown. This is the mismatch log in whitepaper utility 20. How a mismatch is resolved is an open item.
- One node only: the verdict is reported but `confirmed: false`.

### Step labels

`compare` labels a claim `replicated` when two nodes ran it and agree, and `unverified` otherwise (one node, a mismatch, or Could not run). It never assigns `attested only`, because it does not check attestation. Certificates may carry all three labels on their steps; `attested, not replicated` is accepted as the docs spelling of `attested only`.

## 5. Evidence bundle

```json
{
  "spec": "bundle.v0",
  "algorithm": "sha256",
  "root": "sha256:f4f9b720e599b451270cf55acf8ce794854e86878e7841d674d047a8a2d8dc4d",
  "files": [
    { "path": "attestation/report.json", "sha256": "sha256:9a9c…4134", "size": 299 }
  ]
}
```

### Paths

- Relative to the bundle folder, `/` as the separator, valid UTF-8.
- No empty, `.` or `..` segments, no leading `/`, no backslash, no control characters. A name that breaks these rules makes hashing fail rather than silently changing.
- Callers that pass paths in (`hashFiles`) may use `\` or a leading `./`; they are normalized to the form above.
- Paths are taken byte for byte. They are not Unicode-normalized, so the root matches `sha256sum` on the same file system. Prefer NFC names if bundles move between macOS and Linux.

### Which files

- Every regular file under the folder, at any depth.
- Symlinks are not followed and not included. Sockets, devices and FIFOs are not included. The CLI lists what it skipped.
- `.git` (directory or file, at any depth) is always ignored.
- Extra ignore patterns are recorded in `ignore`, so verification applies the same ones. Patterns are gitignore-style: `*` and `?` stay within one path segment, `**` crosses segments; a pattern without `/` matches a name at any depth; a pattern with `/` (or a leading `/`) is matched from the bundle root; a trailing `/` matches directories only; a matched directory is skipped entirely.
- `hash -o` inside the folder adds the output file to `ignore`, so `bundle.json` is never part of the bundle it describes.

### Bundle root

The root is SHA-256 over a canonical listing:

```
listing = for each file, sorted by the UTF-8 bytes of its path:
            <64 lowercase hex sha256> <space> <space> <path> <LF>
root    = "sha256:" + hex( SHA-256( listing ) )
```

The listing is byte for byte what GNU `sha256sum` prints for the same files in `LC_ALL=C` order. So the root can be checked without this tool:

```sh
cd examples/evidence
find . -type f ! -path '*/.git/*' ! -name .git -printf '%P\n' \
  | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum
# f4f9b720e599b451270cf55acf8ce794854e86878e7841d674d047a8a2d8dc4d  -
```

(GNU find, sort and xargs. On macOS install coreutils and findutils.)

- File sizes are in `bundle.json` for humans and quick checks; they are not part of the root, since the hash already fixes the content.
- The empty bundle's root is `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Why a listing hash and not a Merkle tree: anyone can recompute it with coreutils, and the bundle names every file anyway. A Merkle tree would allow proofs for a single file without the full list; v0 does not need that.
- `bundle.json` is written with 2-space indentation, fixed key order and a trailing newline, so the same folder always gives the same bytes.

### Verification

`verifyBundle(dir, expected)` re-hashes the folder with the expected bundle's `ignore` list and reports:

- `modified`: same path, different hash (both hashes and sizes shown);
- `added`: in the folder, not in the expected bundle;
- `missing`: in the expected bundle, not in the folder;
- `expectedConsistent: false`: the expected `bundle.json`'s file list does not hash to its own `root`, meaning it was edited by hand.

With only a root hash as the expectation, it can say whether the folder matches, not which file changed.

## 6. Certificate

```json
{
  "spec": "certificate.v0",
  "run": "run_example_0001",
  "paper": "doi:10.5555/huygena.example.0001",
  "issued": "2026-11-25",
  "manifest": "sha256:<manifestHash>",
  "bundle": "sha256:<bundle root>",
  "attestation": { "hash": "sha256:<report hash>", "path": "attestation/report.json", "format": "…" },
  "nodes": { "primary": "node-a", "confirming": "node-b" },
  "rules": { "version": "v0-draft", "partial_factor": 3 },
  "claims": [
    { "id": "table_2.auroc", "reported": 0.912, "values": { "node-a": 0.9104, "node-b": 0.9109 }, "verdict": "Replicated" },
    { "id": "table_4.ece", "reported": 0.031, "values": { "node-a": 0.0335, "node-b": 0.0362 }, "verdict": null, "mismatch": true }
  ],
  "steps": [{ "name": "run-pipeline", "label": "replicated", "outputs": ["outputs/node-a/metrics.json"] }],
  "chain": { "network": null, "contract": null, "tx": null }
}
```

`verifyCertificate(cert, { manifest?, bundle | bundleDir? })` runs these checks. Each is `pass`, `fail`, `skipped` (input not given) or `planned` (not implemented). The certificate is `ok` when nothing fails.

| Check | Needs | What it does |
|---|---|---|
| `schema` | | Shape matches `certificate.v0`. |
| `confirmation` | | A confirming node is named and differs from the primary node. |
| `manifest-hash` | manifest | `manifestHash(manifest)` equals `manifest`. |
| `claims-match` | manifest | Same paper, same claim ids, same reported values. |
| `verdicts` | manifest | Re-runs `compare` on the certificate's per-node values with the manifest's tolerances and `rules.partial_factor`. Every verdict and mismatch flag must match. |
| `bundle-root` | bundle | The bundle root equals `bundle`. |
| `attestation-file` | bundle | The file at `attestation.path` is in the bundle and hashes to `attestation.hash`. |
| `step-outputs` | bundle | Every step output is in the bundle. |
| `attestation-signature` | | **planned.** Checking the report against NVIDIA remote attestation and Intel TDX quote verification. |
| `onchain-record` | | **planned.** Reading run id, hashes and verdicts from the Huygena contract, which is not deployed. |

Planned checks are never reported as passed.

## Versioning

Each document carries its `spec` value. Breaking changes get a new version (`manifest.v1`, …). The verdict rules carry their own version, `v0-draft`; a certificate made under other rules is not re-judged by this tool (`verdicts` is skipped).
