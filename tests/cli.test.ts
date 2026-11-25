import { fileURLToPath } from "node:url";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/run-cli";

const ex = (p: string) => fileURLToPath(new URL(`../examples/${p}`, import.meta.url));

async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((s) => ((stdout += String(s)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((s) => ((stderr += String(s)), true));
  try {
    const code = await main([...argv, "--no-color"]);
    return { code, stdout, stderr };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

describe("cli", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "huygena-cli-"));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("manifest: passes the example, exit 0", async () => {
    const r = await run("manifest", ex("manifest.yaml"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PASS  manifest is valid");
  });

  it("manifest --json returns the lint report", async () => {
    const r = await run("manifest", ex("manifest.yaml"), "--json");
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ ok: true, errors: 0, hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
  });

  it("init writes a template that fails lint until filled in", async () => {
    const f = join(tmp, "manifest.yaml");
    expect((await run("init", f)).code).toBe(0);
    expect((await run("init", f)).code).toBe(2); // exists, no --force
    const r = await run("manifest", f);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("placeholder");
  });

  it("hash: writes the same bundle.json as examples/", async () => {
    const out = join(tmp, "bundle.json");
    expect((await run("hash", ex("evidence"), "-o", out)).code).toBe(0);
    expect(await readFile(out, "utf8")).toBe(await readFile(ex("bundle.json"), "utf8"));
  });

  it("hash -o inside the folder keeps bundle.json out of its own bundle", async () => {
    const dir = join(tmp, "ev-self");
    await cp(ex("evidence"), dir, { recursive: true });
    const r = await run("hash", dir, "-o", join(dir, "bundle.json"), "--json");
    expect(JSON.parse(r.stdout).root).toBe(JSON.parse(await readFile(ex("bundle.json"), "utf8")).root);
    expect((await run("bundle", dir, "--expect", join(dir, "bundle.json"))).code).toBe(0);
  });

  it("bundle: exit 0 when untouched, 1 with the edited file named", async () => {
    const dir = join(tmp, "ev");
    await cp(ex("evidence"), dir, { recursive: true });
    expect((await run("bundle", dir, "--expect", ex("bundle.json"))).code).toBe(0);
    await writeFile(join(dir, "outputs/node-b/metrics.json"), (await readFile(join(dir, "outputs/node-b/metrics.json"), "utf8")).replace("1.05", "0.72"));
    const r = await run("bundle", dir, "--expect", ex("bundle.json"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("MODIFIED outputs/node-b/metrics.json");
  });

  it("compare: verdict table, exit 1 because not every claim replicated", async () => {
    const r = await run("compare", ex("manifest.yaml"), ex("results.node-a.json"), ex("results.node-b.json"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("MISMATCH");
    expect(r.stdout).toContain("2 Replicated, 1 Partially replicated, 1 Failed, 1 Could not run, 1 mismatch");
  });

  it("compare: flags results produced from a different manifest", async () => {
    const f = join(tmp, "res.json");
    const res = JSON.parse(await readFile(ex("results.node-a.json"), "utf8"));
    res.manifest = `sha256:${"9".repeat(64)}`;
    await writeFile(f, JSON.stringify(res));
    const r = await run("compare", ex("manifest.yaml"), f, "--json");
    expect(JSON.parse(r.stdout).manifestMismatch).toHaveLength(1);
  });

  it("cert: passes the example with manifest and bundle", async () => {
    const r = await run("cert", ex("certificate.json"), "--manifest", ex("manifest.yaml"), "--bundle", ex("evidence"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PLAN   attestation-signature");
  });

  it("usage errors exit 2", async () => {
    expect((await run("nope")).code).toBe(2);
    expect((await run("manifest", "missing.yaml")).code).toBe(2);
    expect((await run("compare", ex("manifest.yaml"))).code).toBe(2);
    expect((await run("hash", ex("evidence"), "--bogus")).code).toBe(2);
    expect((await run("compare", ex("manifest.yaml"), ex("results.node-a.json"), "--partial-factor", "0.5")).code).toBe(2);
  });
});
