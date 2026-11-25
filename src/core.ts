/**
 * huygena-verify/core: the parts that need no file system. Runs in Node 20+,
 * browsers, Deno, Bun and Cloudflare Workers. Hashing uses Web Crypto.
 */
export { canonicalJson } from "./canonical";
export { sha256Hex, normalizeSha256, isSha256Ref, toHex, utf8 } from "./hash";
export {
  parseDocument,
  parseManifest,
  manifestHash,
  lintManifest,
  DocumentParseError,
  type Finding,
  type Severity,
  type ParsedManifest,
  type LintReport,
} from "./manifest";
export { numericBand, FLOAT_SLACK } from "./tolerance";
export {
  compare,
  CompareError,
  DEFAULT_PARTIAL_FACTOR,
  type CompareOptions,
  type CompareReport,
  type ClaimComparison,
  type NodeOutcome,
} from "./compare";
export {
  bundleListing,
  bundleRoot,
  makeBundle,
  hashFiles,
  diffBundle,
  parseBundle,
  serializeBundle,
  checkBundlePath,
  normalizeBundlePath,
  compareUtf8,
  BundlePathError,
  type BundleDiff,
  type ModifiedFile,
} from "./bundle-core";
export { createIgnore, DEFAULT_IGNORE, type IgnoreMatcher } from "./glob";
export {
  verifyCertificate,
  type CertificateReport,
  type CertificateCheck,
  type CheckStatus,
  type VerifyCertificateOptions,
} from "./certificate";
export { jsonSchemas } from "./json-schema";
export * from "./schema";
