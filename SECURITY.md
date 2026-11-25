# Security

Please report vulnerabilities privately to **cto@huygena.xyz**. Do not open a public issue.

Include what you found, how to reproduce it and what it affects. We will reply within a few days.

In scope: anything that makes `huygena-verify` report a pass it should not. In particular:

- `verifyBundle` or `bundle` missing a modified, added or removed file, or two different file sets hashing to the same root.
- `manifestHash` giving the same hash for manifests with different values, or different hashes for the same data.
- `compare` or `verifyCertificate` accepting a verdict that does not follow from the values and the tolerances in the manifest.
- Path handling in `hashBundle` that reads outside the folder it was given.

Out of scope for this version: attestation signature verification and on-chain lookups. They are not implemented yet and are reported as `planned`, never as passed.
