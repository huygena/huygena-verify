import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BundlePathError, checkBundlePath, diffBundle, makeBundle, type BundleDiff } from "./bundle-core";
import { createIgnore, DEFAULT_IGNORE } from "./glob";
import type { Bundle, BundleFile } from "./schema";

export interface HashBundleOptions {
  /** Extra ignore patterns (SPEC.md, "Ignore rules"). Recorded in bundle.json so `verifyBundle` applies the same ones. `.git` is always ignored. */
  ignore?: readonly string[];
  /** Called for entries that are not regular files (symlinks, sockets, devices). They are not part of the bundle. */
  onSkip?: (path: string, reason: string) => void;
}

/**
 * Hash every regular file under `dir` into a deterministic bundle: sorted
 * relative POSIX paths, SHA-256 and size per file, and the root hash defined
 * in SPEC.md. Symlinks are not followed. Files are streamed, so size is not
 * limited by memory.
 */
export async function hashBundle(dir: string, options: HashBundleOptions = {}): Promise<Bundle> {
  const ignore = [...(options.ignore ?? [])];
  const skip = createIgnore([...DEFAULT_IGNORE, ...ignore]);
  const files: BundleFile[] = [];

  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const err = checkBundlePath(relPath);
      if (err) throw new BundlePathError(`${JSON.stringify(relPath)}: ${err}`);
      const absPath = join(abs, e.name);
      if (e.isDirectory()) {
        if (!skip(relPath, true)) await walk(absPath, relPath);
      } else if (e.isFile()) {
        if (!skip(relPath, false)) files.push({ path: relPath, ...(await hashFile(absPath)) });
      } else if (!skip(relPath, false)) {
        options.onSkip?.(relPath, e.isSymbolicLink() ? "symlink (not followed)" : "not a regular file");
      }
    }
  }

  const st = await lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  await walk(dir, "");
  return makeBundle(files, ignore);
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: `sha256:${h.digest("hex")}`, size };
}

/**
 * Re-hash `dir` and compare it with an expected bundle.json value or a bare
 * root hash. Reports which files were modified, added or missing. With only a
 * root hash it can say whether the bundle matches, not which file changed.
 */
export async function verifyBundle(dir: string, expected: Bundle | string, options: HashBundleOptions = {}): Promise<BundleDiff> {
  const ignore = [...(typeof expected === "string" ? [] : (expected.ignore ?? [])), ...(options.ignore ?? [])];
  const actual = await hashBundle(dir, { ...options, ignore: [...new Set(ignore)] });
  return diffBundle(actual, expected);
}
