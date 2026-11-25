import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundleListing,
  bundleRoot,
  compareUtf8,
  createIgnore,
  diffBundle,
  hashBundle,
  hashFiles,
  makeBundle,
  parseBundle,
  serializeBundle,
  verifyBundle,
} from "../src/index";

// Fixed vectors, computed independently with Python hashlib.
const HELLO = "sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"; // "hello\n"
const WORLD = "sha256:e258d248fda94c63753607f7c4494ee0fcbe92f1a76bfdac795c9d84101eb317"; // "world\n"
const ROOT_1 = "sha256:c565d5de8cfcca4d37d6dd978b301ec960e6e5919e0a36eb1d2d9e535e007d67";
const ROOT_UNICODE = "sha256:cdf95ecf1c11101cf0ab1d6332436d7705c8f4afc2e79324c12abd470d7f569e";
const EMPTY = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("bundle root (fixed vectors)", () => {
  it("hashes the sha256sum-style listing", async () => {
    const b = await hashFiles([
      { path: "dir/b.txt", data: "world\n" },
      { path: "a.txt", data: "hello\n" },
    ]);
    expect(b.files).toEqual([
      { path: "a.txt", sha256: HELLO, size: 6 },
      { path: "dir/b.txt", sha256: WORLD, size: 6 },
    ]);
    expect(bundleListing(b.files)).toBe(`${HELLO.slice(7)}  a.txt\n${WORLD.slice(7)}  dir/b.txt\n`);
    expect(b.root).toBe(ROOT_1);
  });

  it("normalizes Windows and ./ paths to the same root", async () => {
    const b = await hashFiles([
      { path: ".\\dir\\b.txt", data: "world\n" },
      { path: "./a.txt", data: "hello\n" },
    ]);
    expect(b.root).toBe(ROOT_1);
    expect(b.files.map((f) => f.path)).toEqual(["a.txt", "dir/b.txt"]);
  });

  it("sorts by UTF-8 bytes (LC_ALL=C), not UTF-16", async () => {
    // U+FF61 is EF BD A1 in UTF-8, U+1F600 is F0 9F 98 80. UTF-16 order would put the emoji first.
    expect(["\u{1F600}.txt", "｡.txt"].sort(compareUtf8)).toEqual(["｡.txt", "\u{1F600}.txt"]);
    expect(["\u{1F600}.txt", "｡.txt"].sort()).toEqual(["\u{1F600}.txt", "｡.txt"]);
    const b = await hashFiles([
      { path: "\u{1F600}.txt", data: "y" },
      { path: "｡.txt", data: "x" },
    ]);
    expect(b.root).toBe(ROOT_UNICODE);
  });

  it("the empty bundle has the SHA-256 of the empty string", async () => {
    expect(await bundleRoot([])).toBe(EMPTY);
  });

  it("rejects unsafe or ambiguous paths", async () => {
    for (const p of ["../x", "/etc/passwd", "a//b", "a/./b", "line\nbreak", ""]) {
      await expect(hashFiles([{ path: p, data: "x" }])).rejects.toThrow();
    }
    await expect(makeBundle([{ path: "a\\b", sha256: HELLO, size: 1 }])).rejects.toThrow(/backslash/);
    await expect(makeBundle([{ path: "a", sha256: HELLO, size: 1 }, { path: "a", sha256: WORLD, size: 1 }])).rejects.toThrow(/duplicate/);
  });

  it("serializes deterministically and round-trips through parseBundle", async () => {
    const b = await hashFiles([{ path: "a.txt", data: "hello\n" }], ["*.tmp"]);
    const text = serializeBundle(b);
    expect(serializeBundle(parseBundle(JSON.parse(text)))).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    expect(() => parseBundle({ spec: "bundle.v0" })).toThrow(/not a bundle.v0/);
  });
});

describe("ignore patterns", () => {
  it("matches names at any depth, anchored paths, globs and directories", () => {
    const ig = createIgnore(["*.tmp", "/build", "cache/", "logs/**/*.gz", "a?c"]);
    expect(ig("x.tmp", false)).toBe(true);
    expect(ig("deep/dir/x.tmp", false)).toBe(true);
    expect(ig("build", true)).toBe(true);
    expect(ig("src/build", true)).toBe(false);
    expect(ig("cache", true)).toBe(true);
    expect(ig("cache", false)).toBe(false);
    expect(ig("logs/a/b/c.gz", false)).toBe(true);
    expect(ig("logs/c.gz", false)).toBe(true);
    expect(ig("abc", false)).toBe(true);
    expect(ig("abbc", false)).toBe(false);
  });
});

describe("hashBundle and verifyBundle on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "huygena-verify-"));
    await mkdir(join(dir, "dir"));
    await writeFile(join(dir, "a.txt"), "hello\n");
    await writeFile(join(dir, "dir", "b.txt"), "world\n");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matches the in-memory vector", async () => {
    expect((await hashBundle(dir)).root).toBe(ROOT_1);
  });

  it("always ignores .git, applies --ignore and records it", async () => {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(dir, "scratch.tmp"), "x");
    const b = await hashBundle(dir, { ignore: ["*.tmp"] });
    expect(b.root).toBe(ROOT_1);
    expect(b.ignore).toEqual(["*.tmp"]);
  });

  it.skipIf(process.platform === "win32")("skips symlinks and reports them", async () => {
    await symlink(join(dir, "a.txt"), join(dir, "link.txt"));
    const skipped: string[] = [];
    const b = await hashBundle(dir, { onSkip: (p) => skipped.push(p) });
    expect(b.root).toBe(ROOT_1);
    expect(skipped).toEqual(["link.txt"]);
  });

  it("passes an untouched folder", async () => {
    const expected = await hashBundle(dir);
    const d = await verifyBundle(dir, expected);
    expect(d).toMatchObject({ ok: true, unchanged: 2, modified: [], added: [], missing: [] });
    expect((await verifyBundle(dir, ROOT_1)).ok).toBe(true);
  });

  it("catches a modified file, an added file and a missing file", async () => {
    const expected = await hashBundle(dir);
    await writeFile(join(dir, "a.txt"), "hello!\n");
    await writeFile(join(dir, "new.txt"), "surprise\n");
    await unlink(join(dir, "dir", "b.txt"));
    const d = await verifyBundle(dir, expected);
    expect(d.ok).toBe(false);
    expect(d.modified).toEqual([{ path: "a.txt", expected: { sha256: HELLO, size: 6 }, actual: { sha256: expect.stringMatching(/^sha256:/), size: 7 } }]);
    expect(d.added.map((f) => f.path)).toEqual(["new.txt"]);
    expect(d.missing.map((f) => f.path)).toEqual(["dir/b.txt"]);
    expect(d.unchanged).toBe(0);
  });

  it("with only a root hash, says it differs but cannot name files", async () => {
    await writeFile(join(dir, "a.txt"), "HELLO\n");
    const d = await verifyBundle(dir, ROOT_1.slice(7));
    expect(d).toMatchObject({ ok: false, rootOnly: true, modified: [] });
  });

  it("detects a hand-edited bundle.json whose list no longer hashes to its root", async () => {
    const expected = await hashBundle(dir);
    await writeFile(join(dir, "a.txt"), "forged\n");
    const forged = { ...expected, files: (await hashBundle(dir)).files };
    const d = await diffBundle(await hashBundle(dir), forged);
    expect(d.expectedConsistent).toBe(false);
    expect(d.ok).toBe(false);
  });

  it("verifyBundle applies the ignore list recorded in bundle.json", async () => {
    await writeFile(join(dir, "x.tmp"), "1");
    const expected = await hashBundle(dir, { ignore: ["*.tmp"] });
    await writeFile(join(dir, "x.tmp"), "2");
    expect((await verifyBundle(dir, expected)).ok).toBe(true);
  });

  it.runIf(process.platform === "linux")("root equals coreutils: find | LC_ALL=C sort | xargs sha256sum | sha256sum", async () => {
    await mkdir(join(dir, "sub dir"));
    await writeFile(join(dir, "sub dir", "été.txt"), "summer\n");
    const sh = `cd "$1" && find . -type f ! -path '*/.git/*' ! -name .git -printf '%P\\n' | LC_ALL=C sort | xargs -d '\\n' sha256sum | sha256sum`;
    const outText = execFileSync("sh", ["-c", sh, "sh", dir], { encoding: "utf8" });
    expect((await hashBundle(dir)).root).toBe(`sha256:${outText.slice(0, 64)}`);
  });
});

describe("examples/", () => {
  it("examples/bundle.json matches examples/evidence", async () => {
    const expected = parseBundle(JSON.parse(await readFile(new URL("../examples/bundle.json", import.meta.url), "utf8")));
    const d = await verifyBundle(fileURLToPath(new URL("../examples/evidence", import.meta.url)), expected);
    expect(d.ok).toBe(true);
  });
});
