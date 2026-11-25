import { hashBundle } from "./bundle-node";
import { verifyCertificate as verifyCertificateCore, type CertificateReport, type VerifyCertificateOptions } from "./certificate";

export interface VerifyCertificateNodeOptions extends VerifyCertificateOptions {
  /** Directory holding the evidence bundle. It is hashed with `hashBundle` and compared with the certificate. */
  bundleDir?: string;
  /** Extra ignore patterns used when hashing `bundleDir`. */
  ignore?: readonly string[];
}

/** `verifyCertificate` from the core, plus `bundleDir`: hashes the evidence folder for you. */
export async function verifyCertificate(cert: unknown, options: VerifyCertificateNodeOptions = {}): Promise<CertificateReport> {
  const { bundleDir, ignore, ...rest } = options;
  const bundle = bundleDir !== undefined ? await hashBundle(bundleDir, { ignore }) : rest.bundle;
  return verifyCertificateCore(cert, { ...rest, bundle });
}
