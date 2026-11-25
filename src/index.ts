/**
 * huygena-verify: check a scientific replication without trusting anyone.
 * Node entry: everything in `huygena-verify/core` plus the file system layer.
 */
export * from "./core";
// The Node `verifyCertificate` also accepts `bundleDir`; it replaces the core one here.
export { verifyCertificate, type VerifyCertificateNodeOptions } from "./certificate-node";
export { hashBundle, verifyBundle, type HashBundleOptions } from "./bundle-node";
