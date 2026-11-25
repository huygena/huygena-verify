import { normalizeSha256, sha256Hex, utf8 } from "./hash";
import { BUNDLE_SPEC, BundleSchema, type Bundle, type BundleFile } from "./schema";

export class BundlePathError extends Error {
  override name = "BundlePathError";
}

/**
 * Check one bundle path: relative, POSIX `/` separators, no empty, `.` or `..`
 * segments, no backslash, no control characters (they would break the listing).
 * Returns an error message, or null when the path is fine.
 */
export function checkBundlePath(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes("\\")) return "backslash in path (not portable; use / as the separator)";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control character in path";
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `invalid segment "${seg}"`;
  }
  return null;
}

/**
 * Normalize a path given by a caller (for example from a Windows tool or a zip
 * listing): `\` becomes `/`, a leading `./` is dropped. Then it must pass `checkBundlePath`.
 */
export function normalizeBundlePath(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  const err = checkBundlePath(p);
  if (err) throw new BundlePathError(`${JSON.stringify(path)}: ${err}`);
  return p;
}

/** Compare two strings by their UTF-8 bytes, which is what `LC_ALL=C sort` does. */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const x = utf8(a);
  const y = utf8(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

/**
 * The canonical listing the root hash is taken over. One line per file, sorted
 * by the UTF-8 bytes of the path:
 *
 *   <64 hex sha256><space><space><path>\n
 *
 * This is byte-for-byte the output of GNU `sha256sum` for the same files, so the
 * root can be reproduced with coreutils. See SPEC.md, "Bundle root".
 */
export function bundleListing(files: readonly BundleFile[]): string {
  const sorted = [...files].sort((a, b) => compareUtf8(a.path, b.path));
  let out = "";
  for (const f of sorted) out += `${f.sha256.slice("sha256:".length)}  ${f.path}\n`;
  return out;
}

/** root = "sha256:" + hex(SHA-256(UTF-8(bundleListing(files)))). */
export async function bundleRoot(files: readonly BundleFile[]): Promise<string> {
  return `sha256:${await sha256Hex(bundleListing(files))}`;
}

/**
 * Build a bundle.json value from per-file hashes: validates and sorts the paths,
 * rejects duplicates, computes the root. The output is deterministic.
 */
export async function makeBundle(files: readonly BundleFile[], ignore: readonly string[] = []): Promise<Bundle> {
  const seen = new Set<string>();
  const clean: BundleFile[] = [];
  for (const f of files) {
    const err = checkBundlePath(f.path);
    if (err) throw new BundlePathError(`${JSON.stringify(f.path)}: ${err}`);
    if (seen.has(f.path)) throw new BundlePathError(`duplicate path ${JSON.stringify(f.path)}`);
    seen.add(f.path);
    const sha = normalizeSha256(f.sha256);
    if (!sha) throw new BundlePathError(`${JSON.stringify(f.path)}: invalid sha256 ${JSON.stringify(f.sha256)}`);
    clean.push({ path: f.path, sha256: sha, size: f.size });
  }
  clean.sort((a, b) => compareUtf8(a.path, b.path));
  const bundle: Bundle = { spec: BUNDLE_SPEC, algorithm: "sha256", root: await bundleRoot(clean), files: clean };
  if (ignore.length) bundle.ignore = [...ignore];
  return bundle;
}

/** Hash in-memory files (browser, edge, tests). Paths are normalized with `normalizeBundlePath`. */
export async function hashFiles(entries: ReadonlyArray<{ path: string; data: Uint8Array | string }>, ignore: readonly string[] = []): Promise<Bundle> {
  const files: BundleFile[] = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? utf8(e.data) : e.data;
    files.push({ path: normalizeBundlePath(e.path), sha256: `sha256:${await sha256Hex(data)}`, size: data.byteLength });
  }
  return makeBundle(files, ignore);
}

/** Serialize a bundle exactly as the CLI writes bundle.json: 2-space JSON, fixed key order, trailing newline. */
export function serializeBundle(bundle: Bundle): string {
  const ordered: Bundle = {
    spec: bundle.spec,
    algorithm: bundle.algorithm,
    root: bundle.root,
    ...(bundle.ignore?.length ? { ignore: bundle.ignore } : {}),
    files: bundle.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Parse and schema-check a bundle.json value. Throws with the first problem. */
export function parseBundle(value: unknown): Bundle {
  const res = BundleSchema.safeParse(value);
  if (!res.success) {
    const i = res.error.issues[0]!;
    throw new Error(`not a ${BUNDLE_SPEC} file: ${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  return res.data;
}

export interface ModifiedFile {
  path: string;
  expected: { sha256: string; size: number };
  actual: { sha256: string; size: number };
}

export interface BundleDiff {
  /** Everything matches: same root, same files, and the expected bundle is internally consistent. */
  ok: boolean;
  /** Only a root hash was given, so differing files cannot be named. */
  rootOnly: boolean;
  expectedRoot: string;
  actualRoot: string;
  /** False when the expected bundle.json's file list does not hash to its own root, i.e. it was edited by hand. */
  expectedConsistent: boolean;
  modified: ModifiedFile[];
  added: BundleFile[];
  missing: BundleFile[];
  /** Files with the same hash in both. */
  unchanged: number;
}

/** Compare an actual bundle with an expected bundle.json or a bare root hash. */
export async function diffBundle(actual: Bundle, expected: Bundle | string): Promise<BundleDiff> {
  if (typeof expected === "string") {
    const root = normalizeSha256(expected);
    if (!root) throw new Error(`expected root ${JSON.stringify(expected)} is not a SHA-256`);
    const ok = root === actual.root;
    return {
      ok,
      rootOnly: true,
      expectedRoot: root,
      actualRoot: actual.root,
      expectedConsistent: true,
      modified: [],
      added: [],
      missing: [],
      unchanged: ok ? actual.files.length : 0,
    };
  }
  const recomputed = await bundleRoot(expected.files);
  const expectedConsistent = recomputed === expected.root;
  const want = new Map(expected.files.map((f) => [f.path, f]));
  const have = new Map(actual.files.map((f) => [f.path, f]));
  const modified: ModifiedFile[] = [];
  const added: BundleFile[] = [];
  const missing: BundleFile[] = [];
  let unchanged = 0;
  for (const f of actual.files) {
    const w = want.get(f.path);
    if (!w) added.push(f);
    else if (w.sha256 !== f.sha256) modified.push({ path: f.path, expected: { sha256: w.sha256, size: w.size }, actual: { sha256: f.sha256, size: f.size } });
    else unchanged++;
  }
  for (const f of expected.files) if (!have.has(f.path)) missing.push(f);
  const ok = expectedConsistent && actual.root === expected.root && !modified.length && !added.length && !missing.length;
  return { ok, rootOnly: false, expectedRoot: expected.root, actualRoot: actual.root, expectedConsistent, modified, added, missing, unchanged };
}
