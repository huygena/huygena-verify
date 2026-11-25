# huygena-verify

Check a scientific replication without trusting anyone. Validate the run manifest, hash the evidence, catch any edited file, recompute every verdict from the numbers, and re-check a certificate. Offline, in Node or in the browser.

`huygena-verify` is the open verification library behind [Huygena](https://preview.huygena.xyz), the replication market for science. Huygena re-runs published computational papers on attested GPUs, has an independent node re-run them, and records a verdict per claim. This tool is how anyone checks that record on their own machine.

- **Manifest spec v0 and linter.** JSON Schema plus rules that catch a run nobody could repeat: a container pinned by tag, code pinned to a branch, a claim without a tolerance, no seeds.
- **Content-addressed evidence.** A deterministic `bundle.json` with a root hash you can recompute with `sha256sum`.
- **Tamper detection.** Names every modified, added and missing file.
- **Verdicts from the numbers.** `Replicated`, `Partially replicated`, `Failed` or `Could not run` per claim, from one node or two. Two nodes that disagree get no verdict: the claim is listed as a mismatch.
- **Certificate check.** Recomputes the manifest hash, the bundle root and every verdict, and says plainly which checks are not built yet.

## 30-second demo

```sh
git clone https://github.com/huygena/huygena-verify && cd huygena-verify
pnpm install                      # also builds dist/
alias huygena-verify="node $PWD/dist/cli.js"
```

`examples/` holds an illustrative replication: a manifest with six claims, results from two nodes, the evidence folder, its `bundle.json` and a certificate. The paper and values are made up (`10.5555` is the DOI prefix Crossref reserves for examples). All output below is real.

**1. Is the manifest something anyone could re-run?**

```console
$ huygena-verify manifest examples/manifest.yaml
manifest  examples/manifest.yaml
paper     doi:10.5555/huygena.example.0001
claims    6 (6 numeric)
hash      sha256:3183bd7cd87ba9fcafeed9723ab55255e3d07bcf4b76be55c1759c72d911fbce
lint      0 errors, 0 warnings, 0 info

PASS  manifest is valid
```

A sloppy one, with a container pinned by tag, code pinned to a branch and a typo, does not pass:

```console
$ huygena-verify manifest manifest.yaml
manifest  manifest.yaml
paper     doi:10.1234/abc
claims    2 (2 numeric)
hash      sha256:a0759ba6966b69f4a44078ee8619a9f27998de25f9020baea9999eb3a2cc5cfb
lint      4 errors, 3 warnings, 1 info

  INFO  spec                 spec-missing          add spec: manifest.v0 so readers know which rules apply
  ERROR env.container        container-not-pinned  container "python:3.11-slim" is pinned by tag, and tags can be moved. Pin it by digest: name@sha256:<hex>
  ERROR env.code             code-not-pinned       "main" is a branch or tag, not a commit. Branches move; pin the full commit SHA
  WARN  env.data             data-missing          no datasets pinned by hash. Data fetched at run time can change between runs
  WARN  env.seeds            seeds-missing         no random seeds recorded. Write seeds: [] if the pipeline is fully deterministic
  ERROR claims[0].tolerance  claim-no-tolerance    claim has no tolerance. Write it before the run, or any result can be argued to match
  WARN  claims[1].tolerence  unknown-field         unknown field "tolerence". Did you mean "tolerance"?
  ERROR claims[1].tolerance  claim-no-tolerance    claim has no tolerance. Write it before the run, or any result can be argued to match

FAIL  4 errors: fix them before this manifest is run
```

**2. What do the re-runs say, claim by claim?**

```console
$ huygena-verify compare examples/manifest.yaml examples/results.node-a.json examples/results.node-b.json
manifest  examples/manifest.yaml  sha256:3183bd7cd87ba9fcafeed9723ab55255e3d07bcf4b76be55c1759c72d911fbce
nodes     node-a, node-b (primary, confirming)
rules     v0-draft: partial band = 3x tolerance unless the claim sets one

  CLAIM                        REPORTED  TOLERANCE  node-a            node-b            VERDICT
  table_2.auroc                0.912     ±0.005     0.9104 (-0.0016)  0.9109 (-0.0011)  Replicated
  table_2.auprc                0.687     ±0.01374   0.6791 (-0.0079)  0.6802 (-0.0068)  Replicated
  figure_3b.slope              0.84      ±0.02      0.79 (-0.05)      0.788 (-0.052)    Partially replicated
  table_3.hazard_ratio         0.71      ±0.03      1.04 (+0.33)      1.05 (+0.34)      Failed
  table_4.ece                  0.031     ±0.004     0.0335 (+0.0025)  0.0362 (+0.0052)  MISMATCH
  supp_table_2.external_auroc  0.874     ±0.01      -                 -                 Could not run

  figure_3b.slope: outside ±0.02, within partial ±0.06, same direction, on both nodes
  table_3.hazard_ratio: opposite side of the value of no effect (1) from the paper, on both nodes
  table_4.ece: nodes disagree: node-a Replicated (within ±0.004); node-b Partially replicated (outside ±0.004, within partial ±0.012, same direction)
  supp_table_2.external_auroc: external validation cohort is not public (data access agreement required), on both nodes

summary   6 claims: 2 Replicated, 1 Partially replicated, 1 Failed, 1 Could not run, 1 mismatch (no verdict until resolved)
FAIL  not every claim is Replicated and the nodes disagree on some
```

**3. Hash the evidence. Then try to change it.**

```console
$ huygena-verify hash examples/evidence
bundle    examples/evidence
files     5, 1.7 KB

  9a9cc7603dc9  299 B  attestation/report.json
  acb135bfe6d8  476 B  logs/node-a.log
  0eaa3431d067  476 B  logs/node-b.log
  96efa86a1906  222 B  outputs/node-a/metrics.json
  8022af710e70  223 B  outputs/node-b/metrics.json

root      sha256:f4f9b720e599b451270cf55acf8ce794854e86878e7841d674d047a8a2d8dc4d
```

Copy the folder, quietly "fix" the hazard ratio node B measured, add a note and drop a log:

```console
$ cp -r examples/evidence evidence-copy
$ sed -i 's/1.05/0.72/' evidence-copy/outputs/node-b/metrics.json
$ echo "looks fine" > evidence-copy/notes.txt
$ rm evidence-copy/logs/node-b.log
$ huygena-verify bundle evidence-copy --expect examples/bundle.json
bundle    evidence-copy
expected  sha256:f4f9b720e599b451270cf55acf8ce794854e86878e7841d674d047a8a2d8dc4d  (examples/bundle.json)
actual    sha256:c2436f2e806afc52bfc327ff5025707fbe79dbd1c39b69e6e39f769b7dbe220d

  MODIFIED outputs/node-b/metrics.json
           expected sha256:8022af710e70521b29079a2cfc1259f773f8aa6f76bad01ed4ab21cb0ae7a03e  223 B
           actual   sha256:57db054c6a26cef5f9dd9b354fca1e74ee825f0b8d95edb4d6d9992d7bfcbd81  223 B
  ADDED    notes.txt  11 B
  MISSING  logs/node-b.log

FAIL  3 differences: 1 modified, 1 added, 1 missing; 3 unchanged
```

Same size, one digit changed: caught.

**4. Re-check the certificate.**

```console
$ huygena-verify cert examples/certificate.json --manifest examples/manifest.yaml --bundle examples/evidence
cert      examples/certificate.json
run       run_example_0001
paper     doi:10.5555/huygena.example.0001
nodes     node-a + node-b

  PASS   schema                 certificate.v0 shape
  PASS   confirmation           node-a confirmed by node-b
  PASS   manifest-hash          sha256:3183bd7cd87ba9fcafeed9723ab55255e3d07bcf4b76be55c1759c72d911fbce matches
  PASS   claims-match           6 claims, same ids and reported values as the manifest
  PASS   verdicts               6 verdicts follow from the re-run values and the manifest tolerances (rules v0-draft)
  PASS   bundle-root            sha256:f4f9b720e599b451270cf55acf8ce794854e86878e7841d674d047a8a2d8dc4d matches (5 files)
  PASS   attestation-file       attestation/report.json hashes to the attestation hash
  PASS   step-outputs           4 outputs of 2 steps are in the bundle (2 replicated)
  PLAN   attestation-signature  not implemented in this version: checking the report against NVIDIA remote attestation and Intel TDX quote verification
  PLAN   onchain-record         not implemented: Huygena contracts are not deployed yet, so there is no record to read

PASS  offline checks hold (8 passed, 0 failed, 0 skipped, 2 planned). Planned checks are not done by this version
```

Change one verdict in `certificate.json` and `verdicts` fails. Change one tolerance in the manifest and `manifest-hash` fails. The example attestation report is a placeholder file, and the certificate says so (`"format": "placeholder"`).

## Install

From GitHub for now. npm is coming.

```sh
npm i github:huygena/huygena-verify     # or: pnpm add github:huygena/huygena-verify
npx huygena-verify --help
```

The `prepare` script builds `dist/` on install. Node 20 or newer. Two runtime dependencies: [`zod`](https://zod.dev) and [`yaml`](https://eemeli.org/yaml/).

## Library

```ts
import { readFile } from "node:fs/promises";
import { lintManifest, manifestHash, compare, hashBundle, verifyBundle, verifyCertificate, NodeResultsSchema } from "huygena-verify";

const text = await readFile("manifest.yaml", "utf8");
const load = async (f: string) => NodeResultsSchema.parse(JSON.parse(await readFile(f, "utf8")));
const [nodeA, nodeB] = [await load("results.node-a.json"), await load("results.node-b.json")];

const lint = lintManifest(text);              // schema + lint rules
if (!lint.ok) console.log(lint.findings);      // [{ severity, code, message, path }]
console.log(await manifestHash(text));         // "sha256:3183bd7c…"

const report = compare(lint.manifest!, [nodeA, nodeB]);   // results.v0 objects
for (const c of report.claims) console.log(c.id, c.verdict ?? "mismatch", c.reason);

const bundle = await hashBundle("evidence", { ignore: ["*.tmp"] });
const diff = await verifyBundle("evidence", bundle);       // or a bare root hash
console.log(diff.modified, diff.added, diff.missing);

const cert = JSON.parse(await readFile("certificate.json", "utf8"));
const check = await verifyCertificate(cert, { manifest: text, bundleDir: "evidence" });
console.log(check.ok, check.checks);
```

In a browser or a Worker, import from `huygena-verify/core`. It has no Node built-ins and hashes with Web Crypto. Hash files the user drops in with `hashFiles`:

```ts
import { hashFiles, diffBundle, verifyCertificate } from "huygena-verify/core";

const bundle = await hashFiles(await Promise.all(
  [...fileList].map(async (f) => ({ path: f.webkitRelativePath || f.name, data: new Uint8Array(await f.arrayBuffer()) }))
));
const report = await verifyCertificate(cert, { manifest: manifestText, bundle });
```

### API

| Export | Signature | Entry |
|---|---|---|
| `parseManifest` | `(input: string \| unknown) => ParsedManifest` | both |
| `lintManifest` | `(input: string \| unknown \| ParsedManifest) => LintReport` | both |
| `manifestHash` | `(input: string \| unknown) => Promise<string>` | both |
| `canonicalJson` | `(value: unknown) => string` (RFC 8785) | both |
| `compare` | `(manifest: Manifest, results: NodeResults \| NodeResults[], options?: { partialFactor?: number }) => CompareReport` | both |
| `hashFiles` | `(entries: { path: string; data: Uint8Array \| string }[], ignore?: string[]) => Promise<Bundle>` | both |
| `makeBundle`, `bundleRoot`, `bundleListing` | build a bundle from per-file hashes; compute its root and listing | both |
| `diffBundle` | `(actual: Bundle, expected: Bundle \| string) => Promise<BundleDiff>` | both |
| `parseBundle`, `serializeBundle` | read and write `bundle.json` | both |
| `verifyCertificate` | core: `(cert: unknown, { manifest?, bundle? }) => Promise<CertificateReport>`; Node also takes `bundleDir`, `ignore` | both |
| `hashBundle` | `(dir: string, { ignore?, onSkip? }?) => Promise<Bundle>` | Node |
| `verifyBundle` | `(dir: string, expected: Bundle \| string, { ignore? }?) => Promise<BundleDiff>` | Node |
| `ManifestSchema`, `NodeResultsSchema`, `BundleSchema`, `CertificateSchema` | zod schemas, with TS types `Manifest`, `NodeResults`, `Bundle`, `Certificate`, … | both |
| `jsonSchemas` | `() => Record<file, JSONSchema>`, the files in [`schema/`](schema) | both |
| `VERDICTS`, `STEP_LABELS`, `DEFAULT_PARTIAL_FACTOR`, `RULES_VERSION` | constants | both |

"Node" exports come from `huygena-verify`; "both" are also in `huygena-verify/core`.

## CLI

```
huygena-verify manifest <file>                          validate and lint a run manifest (YAML or JSON)
huygena-verify hash <dir> [-o bundle.json]              hash an evidence folder into a bundle
huygena-verify bundle <dir> --expect <bundle.json|root> name every modified, added or missing file
huygena-verify compare <manifest> <results.json> [<results-b.json>]
                                                        per-claim verdicts from one or two nodes
huygena-verify cert <certificate.json> [--manifest f] [--bundle dir]
                                                        re-check a certificate
huygena-verify init [file]                              write a manifest template
```

| Option | Applies to | |
|---|---|---|
| `--json` | all | Machine-readable report on stdout. |
| `-o, --out <file>` | `hash` | Write `bundle.json`. Inside the folder, it is ignored automatically. |
| `--expect <x>` | `bundle` | A `bundle.json` path, or a root hash. With a root hash, files cannot be named. |
| `--manifest <file>`, `--bundle <dir>` | `cert` | Enable the manifest and bundle checks. |
| `--ignore <glob>` | `hash`, `bundle`, `cert` | Extra ignore pattern, repeatable. `.git` is always ignored. |
| `--partial-factor <n>` | `compare` | Default partial band as a multiple of the tolerance. Default 3 (draft). |
| `--strict` | `manifest` | Warnings also fail. |
| `--force` | `init` | Overwrite. |
| `--no-color` | all | Plain output. `NO_COLOR=1` works too. Color is only used on a terminal. |

Output is plain text with `PASS`, `FAIL`, `WARN`, `INFO`, `SKIP` and `PLAN` tags, readable without color.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Passed. |
| `1` | A check failed: lint errors (or warnings with `--strict`), the bundle differs, a claim is not Replicated or the nodes disagree, a certificate check failed. |
| `2` | Usage or input error: bad arguments, missing or unreadable file, invalid JSON or YAML, a manifest with errors given to `compare`. |

`compare` exits `1` unless every claim is Replicated. A Failed verdict is a valid result, not a tool error; the exit code is there so CI can tell the two apart.

## Verdict rules (draft v0)

For a numeric claim, `band = abs + rel × |reported|` from the manifest, and `delta = rerun − reported`.

| Verdict | When |
|---|---|
| `Replicated` | `|delta| <= band` |
| `Partially replicated` | outside `band`, inside the partial band, and on the same side of `null_value` as the paper |
| `Failed` | outside the partial band, or on the other side of `null_value` |
| `Could not run` | no value, or the node reported an error. The reason is kept. |

- The partial band is the claim's `partial` if set, else **3 × band**. That 3 is a draft default, not a decision: it is printed in every report, overridable with `--partial-factor`, and recorded on certificates.
- `null_value` is the value of no effect: 0 by default, 1 for ratios, 0.5 for AUROC.
- Bounds are inclusive, with a `1e-12` relative allowance for binary floating point.
- **Two nodes:** a verdict only when both nodes reach the same one. Otherwise the claim is a mismatch with no verdict, and both results are shown.
- One node: a verdict, marked unconfirmed.
- Structure claims (RMSD in angstrom against `tolerance.rmsd`) and figure claims (reviewer verdict) are draft.

Full rules: [SPEC.md, sections 3 and 4](SPEC.md#3-tolerance-rules-draft-v0).

## Bundle root

The root is SHA-256 over the `sha256sum` listing of the bundle, sorted by path bytes:

```
<sha256 hex>  <path>\n      one line per file, LC_ALL=C order
root = "sha256:" + sha256(listing)
```

So you do not have to trust this tool to check it:

```console
$ cd examples/evidence
$ find . -type f ! -path '*/.git/*' ! -name .git -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum
f4f9b720e599b451270cf55acf8ce794854e86878e7841d674d047a8a2d8dc4d  -
```

CI runs this check on every push, and the tests pin fixed vectors computed with Python's `hashlib`. Path rules, ignore patterns and edge cases: [SPEC.md, section 5](SPEC.md#5-evidence-bundle).

The manifest hash is SHA-256 over the RFC 8785 canonical JSON of the parsed manifest, so YAML and JSON spellings of the same data give the same hash. [SPEC.md, section 1](SPEC.md#manifest-hash).

## How it fits Huygena

1. A funder posts a bounty on a paper. Huygena's agent writes the **run manifest**: container by digest, code by commit, data by hash, seeds, and each claim with its tolerance. `huygena-verify manifest` is the gate for that file.
2. The manifest runs in a GPU TEE, and an independent node re-runs it. Each node's values are a **results** file. `compare` turns them into verdicts.
3. Logs and outputs are stored by hash as an **evidence bundle**. `hash` and `bundle` compute and check its root.
4. The **certificate** anchors the manifest hash, the bundle root, the attestation hash, the confirming node and the verdicts on-chain. `cert` re-checks all of it that can be checked offline.

Website: [preview.huygena.xyz](https://preview.huygena.xyz). Docs: [docs.huygena.xyz](https://docs.huygena.xyz), in particular [Manifest](https://docs.huygena.xyz/manifest), [Verdicts](https://docs.huygena.xyz/verdicts) and [Verify a certificate](https://docs.huygena.xyz/guides/verify).

## Status

Huygena is pre-launch. This is version 0.1.0 and the specs are draft v0.

**Works today, offline:**

- Manifest schema, linter and canonical hash.
- Evidence bundle hashing, verification and tamper reports, matching `sha256sum`.
- Per-claim verdicts from one or two nodes, with mismatch detection.
- Certificate checks: manifest hash, bundle root, verdict recomputation, attestation report hash, step outputs, confirming node.
- The core runs in browsers and edge runtimes.

**Planned, not implemented:**

- **Attestation signature verification.** Checking the NVIDIA and Intel TDX attestation report against the vendors' verification services. Today `cert` checks that the report file is the one the certificate names, not that its signature is valid. It reports `attestation-signature` as `planned`.
- **On-chain lookup.** Reading a certificate's record from the Huygena contract. The contracts are not deployed. `onchain-record` is reported as `planned`.
- Automated figure comparison, and final tolerance rules per claim type. Both are open items in the whitepaper.

Planned checks are never counted as passes.

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm schema        # regenerate schema/*.json after changing src/schema.ts
```

Security reports: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE). Copyright 2026 Huygena.
