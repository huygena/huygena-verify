# Changelog

## v0.1.0 · 2026-11-25

First release. Everything runs offline. Specs are draft v0.

- Run manifest spec v0: `schema/manifest.v0.schema.json` and the matching zod `ManifestSchema`. YAML or JSON.
- `parseManifest` and `lintManifest`: schema errors plus rules that catch a run nobody could repeat. Container pinned by tag instead of digest, code pinned to a branch or a short SHA, claims without a tolerance, missing seeds, duplicate claim ids, unfilled `<placeholders>`, a tolerance band that reaches the value of no effect, unknown fields with a suggestion. Each finding has a severity, a rule id and a path.
- `manifestHash`: SHA-256 over RFC 8785 canonical JSON of the parsed manifest, so YAML and JSON spellings of the same data hash the same.
- `hashBundle` and `hashFiles`: content-addressed evidence bundle (`bundle.json`). Sorted POSIX paths, SHA-256 and size per file, and a root hash that equals `sha256sum` output piped into `sha256sum`, so it can be checked with coreutils.
- `verifyBundle` and `diffBundle`: name every modified, added and missing file. Also catches a hand-edited `bundle.json` whose file list no longer hashes to its root.
- `compare`: per-claim verdicts (`Replicated`, `Partially replicated`, `Failed`, `Could not run`) from one or two nodes, with the delta and the reason. With two nodes a verdict is issued only when both agree; otherwise the claim is a mismatch. Draft v0 tolerance rules.
- `verifyCertificate`: certificate v0. Recomputes the manifest hash, the bundle root, each verdict, the attestation report hash and the step outputs. Attestation signature verification and the on-chain lookup are reported as `planned`.
- CLI `huygena-verify`: `manifest`, `hash`, `bundle`, `compare`, `cert`, `init`, `--json` everywhere, documented exit codes.
- `huygena-verify/core` entry point for browsers and edge runtimes (Web Crypto, no Node built-ins).
- `examples/`: a manifest, results from two nodes, an evidence folder, its `bundle.json` and a certificate.
