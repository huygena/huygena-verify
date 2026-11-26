import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { version } from "../package.json";
import { hashBundle, verifyBundle } from "./bundle-node";
import { parseBundle, serializeBundle, type BundleDiff } from "./bundle-core";
import { verifyCertificate } from "./certificate-node";
import { compare, CompareError, DEFAULT_PARTIAL_FACTOR, f, type CompareReport } from "./compare";
import { normalizeSha256 } from "./hash";
import { lintManifest, manifestHash, parseDocument, type Finding, type LintReport } from "./manifest";
import { MANIFEST_TEMPLATE } from "./template";
import { NodeResultsSchema, type Bundle, type Manifest, type NodeResults } from "./schema";

/** Exit codes. Documented in README "Exit codes". */
const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

class UsageError extends Error {}

interface Args {
  cmd: string | undefined;
  positional: string[];
  json: boolean;
  out?: string;
  expect?: string;
  manifest?: string;
  bundle?: string;
  ignore: string[];
  partialFactor?: number;
  force: boolean;
  strict: boolean;
  color: boolean;
  help: boolean;
  version: boolean;
}

const HELP = `huygena-verify ${version}
Check a scientific replication without trusting anyone. Offline.

Usage
  huygena-verify manifest <file>                      validate and lint a run manifest (YAML or JSON)
  huygena-verify hash <dir> [-o bundle.json]          hash an evidence folder into a content-addressed bundle
  huygena-verify bundle <dir> --expect <bundle.json|root>
                                                      re-hash a folder and name every modified, added or missing file
  huygena-verify compare <manifest> <results.json> [<results-b.json>]
                                                      per-claim verdicts from re-run values (one or two nodes)
  huygena-verify cert <certificate.json> [--manifest <file>] [--bundle <dir>]
                                                      re-check a certificate: manifest hash, bundle root, verdicts
  huygena-verify init [file]                          write a manifest template (default manifest.yaml)

Options
  --json                 machine-readable output on stdout
  -o, --out <file>       hash: write bundle.json here
  --expect <x>           bundle: expected bundle.json path or a sha256 root
  --manifest <file>      cert: manifest to recompute the hash and the verdicts from
  --bundle <dir>         cert: evidence folder to recompute the bundle root from
  --ignore <glob>        hash, bundle, cert: extra ignore pattern, repeatable (.git is always ignored)
  --partial-factor <n>   compare: default partial band as a multiple of the tolerance (default ${DEFAULT_PARTIAL_FACTOR}, draft)
  --strict               manifest: warnings also fail
  --force                init: overwrite an existing file
  --no-color             plain output (also NO_COLOR=1)
  -h, --help             this help
  -v, --version          print the version

Exit codes
  0  passed
  1  a check failed: lint errors, bundle differs, a claim is not Replicated or the nodes disagree, a certificate check failed
  2  usage or input error: bad arguments, unreadable file, invalid JSON/YAML

Spec: https://github.com/huygena/huygena-verify/blob/main/SPEC.md
`;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: undefined,
    positional: [],
    json: false,
    ignore: [],
    force: false,
    strict: false,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    help: false,
    version: false,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const [flag, inline] = t.startsWith("--") && t.includes("=") ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] : [t, undefined];
    const take = () => (inline !== undefined ? inline : value(i++, flag));
    switch (flag) {
      case "--json":
        a.json = true;
        break;
      case "-o":
      case "--out":
        a.out = take();
        break;
      case "--expect":
        a.expect = take();
        break;
      case "--manifest":
        a.manifest = take();
        break;
      case "--bundle":
        a.bundle = take();
        break;
      case "--ignore":
        a.ignore.push(take());
        break;
      case "--partial-factor": {
        const raw = take();
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) throw new UsageError(`--partial-factor must be a number >= 1, got ${raw}`);
        a.partialFactor = n;
        break;
      }
      case "--strict":
        a.strict = true;
        break;
      case "--force":
        a.force = true;
        break;
      case "--no-color":
        a.color = false;
        break;
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-v":
      case "--version":
        a.version = true;
        break;
      default:
        if (t.startsWith("-") && t !== "-") throw new UsageError(`unknown option ${t}`);
        if (a.cmd === undefined) a.cmd = t;
        else a.positional.push(t);
    }
  }
  return a;
}

// ---------- output helpers ----------

let useColor = false;
const sgr = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = sgr("1");
const dim = sgr("2");
const red = sgr("31");
const green = sgr("32");
const yellow = sgr("33");

const out: string[] = [];
const say = (line = "") => out.push(line);
const kv = (k: string, v: string) => say(`${dim(k.padEnd(10))}${v}`);

/** Display path relative to the working directory, POSIX style. */
function show(p: string): string {
  const r = relative(process.cwd(), resolve(p));
  return (r && !r.startsWith("..") ? r : resolve(p)).split(sep).join("/");
}

function tag(t: "PASS" | "FAIL" | "WARN" | "INFO" | "SKIP" | "PLAN" | "ERROR"): string {
  const s = t.padEnd(5);
  if (t === "PASS") return green(s);
  if (t === "FAIL" || t === "ERROR") return red(s);
  if (t === "WARN") return yellow(s);
  return dim(s);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function table(rows: string[][], indent = "  "): void {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(c).length)));
  for (const r of rows) say(indent + r.map((c, i) => (i === r.length - 1 ? c : c + " ".repeat(widths[i]! - visible(c).length))).join("  ").trimEnd());
}

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

async function readData(path: string): Promise<unknown> {
  const text = await readText(path);
  try {
    return parseDocument(text);
  } catch (err) {
    throw new UsageError(`${path}: ${(err as Error).message}`);
  }
}

function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------- commands ----------

async function cmdManifest(a: Args): Promise<number> {
  const file = a.positional[0];
  if (!file) throw new UsageError("usage: huygena-verify manifest <file>");
  const text = await readText(file);
  const report = lintManifest(text);
  let hash: string | null = null;
  try {
    hash = await manifestHash(text);
  } catch {
    hash = null;
  }
  const failed = !report.ok || (a.strict && report.warnings > 0);
  if (a.json) {
    emitJson({ file, hash, ...report, ok: !failed });
    return failed ? EXIT.failed : EXIT.ok;
  }
  kv("manifest", show(file));
  const m = report.manifest;
  if (m) {
    kv("paper", m.paper);
    const types = new Map<string, number>();
    for (const c of m.claims) types.set(c.type ?? "numeric", (types.get(c.type ?? "numeric") ?? 0) + 1);
    kv("claims", `${m.claims.length} (${[...types].map(([t, n]) => `${n} ${t}`).join(", ")})`);
  }
  if (hash) kv("hash", hash);
  kv("lint", lintCounts(report));
  printFindings(report.findings);
  say();
  if (failed) say(`${tag("FAIL")} ${report.ok ? "warnings present and --strict is set" : `${plural(report.errors, "error")}: fix them before this manifest is run`}`);
  else say(`${tag("PASS")} manifest is valid${report.warnings ? `, with ${plural(report.warnings, "warning")}` : ""}`);
  return failed ? EXIT.failed : EXIT.ok;
}

function lintCounts(r: LintReport): string {
  return `${plural(r.errors, "error")}, ${plural(r.warnings, "warning")}, ${r.infos} info`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function printFindings(findings: Finding[]): void {
  if (!findings.length) return;
  say();
  const rows = findings.map((x) => [tag(x.severity === "error" ? "ERROR" : x.severity === "warning" ? "WARN" : "INFO"), x.path || "(document)", dim(x.code)]);
  const widths = [5, Math.max(...rows.map((r) => visible(r[1]!).length)), Math.max(...rows.map((r) => visible(r[2]!).length))];
  findings.forEach((x, i) => {
    const r = rows[i]!;
    say(`  ${r[0]} ${r[1]!.padEnd(widths[1]!)}  ${r[2]}${" ".repeat(widths[2]! - visible(r[2]!).length)}  ${x.message}`);
  });
}

async function cmdHash(a: Args): Promise<number> {
  const dir = a.positional[0];
  if (!dir) throw new UsageError("usage: huygena-verify hash <dir> [-o bundle.json]");
  const ignore = [...a.ignore];
  // Keep the output file out of the bundle it describes.
  if (a.out) {
    const rel = relative(resolve(dir), resolve(a.out));
    // On Windows a path on another drive comes back absolute (C:\\...), so check isAbsolute too.
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) ignore.push(`/${rel.split(sep).join("/")}`);
  }
  const skipped: string[] = [];
  const bundle = await hashBundleOrUsage(dir, ignore, (p, r) => skipped.push(`${p}: ${r}`));
  if (a.out) await writeFile(a.out, serializeBundle(bundle));
  if (a.json) {
    emitJson(a.out ? { wrote: a.out, root: bundle.root, files: bundle.files.length, skipped } : { ...bundle, skipped });
    return EXIT.ok;
  }
  const total = bundle.files.reduce((s, x) => s + x.size, 0);
  kv("bundle", show(dir));
  kv("files", `${bundle.files.length}, ${fmtSize(total)}`);
  if (bundle.ignore?.length) kv("ignore", bundle.ignore.join(", "));
  if (bundle.files.length <= 40) {
    say();
    table(bundle.files.map((x) => [dim(x.sha256.slice(7, 19)), fmtSize(x.size), x.path]));
  }
  for (const s of skipped) say(`  ${tag("SKIP")} ${s}`);
  say();
  kv("root", bold(bundle.root));
  if (a.out) kv("wrote", show(a.out));
  return EXIT.ok;
}

async function hashBundleOrUsage(dir: string, ignore: string[], onSkip?: (p: string, r: string) => void): Promise<Bundle> {
  if (!existsSync(dir)) throw new UsageError(`${dir} does not exist`);
  try {
    return await hashBundle(dir, { ignore, onSkip });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

async function loadExpected(x: string): Promise<{ expected: Bundle | string; label: string }> {
  const root = normalizeSha256(x);
  if (root && !existsSync(x)) return { expected: root, label: "root hash" };
  const data = await readData(x);
  try {
    return { expected: parseBundle(data), label: show(x) };
  } catch (err) {
    throw new UsageError(`${x}: ${(err as Error).message}`);
  }
}

async function cmdBundle(a: Args): Promise<number> {
  const dir = a.positional[0];
  if (!dir || !a.expect) throw new UsageError("usage: huygena-verify bundle <dir> --expect <bundle.json|sha256 root>");
  if (!existsSync(dir)) throw new UsageError(`${dir} does not exist`);
  const { expected, label } = await loadExpected(a.expect);
  let diff: BundleDiff;
  try {
    diff = await verifyBundle(dir, expected, { ignore: a.ignore });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (a.json) {
    emitJson(diff);
    return diff.ok ? EXIT.ok : EXIT.failed;
  }
  kv("bundle", show(dir));
  kv("expected", `${diff.expectedRoot}  ${dim(`(${label})`)}`);
  kv("actual", diff.actualRoot);
  if (!diff.expectedConsistent) {
    say();
    say(`  ${tag("FAIL")} the expected bundle.json was edited: its file list does not hash to its root`);
  }
  const changes = diff.modified.length + diff.added.length + diff.missing.length;
  if (changes) {
    say();
    for (const m of diff.modified) {
      say(`  ${red("MODIFIED")} ${m.path}`);
      say(`           ${dim("expected")} ${m.expected.sha256}  ${fmtSize(m.expected.size)}`);
      say(`           ${dim("actual  ")} ${m.actual.sha256}  ${fmtSize(m.actual.size)}`);
    }
    for (const x of diff.added) say(`  ${red("ADDED   ")} ${x.path}  ${dim(fmtSize(x.size))}`);
    for (const x of diff.missing) say(`  ${red("MISSING ")} ${x.path}`);
  }
  say();
  if (diff.ok) say(`${tag("PASS")} ${diff.rootOnly ? "root matches" : `all ${plural(diff.unchanged, "file")} match`}`);
  else if (diff.rootOnly) say(`${tag("FAIL")} root differs. Pass the bundle.json instead of the root to see which files changed`);
  else {
    const parts = [`${diff.modified.length} modified`, `${diff.added.length} added`, `${diff.missing.length} missing`];
    say(`${tag("FAIL")} ${changes ? `${plural(changes, "difference")}: ${parts.join(", ")}` : "root differs"}; ${diff.unchanged} unchanged`);
  }
  return diff.ok ? EXIT.ok : EXIT.failed;
}

async function cmdCompare(a: Args): Promise<number> {
  const [mFile, ...rFiles] = a.positional;
  if (!mFile || rFiles.length < 1 || rFiles.length > 2) throw new UsageError("usage: huygena-verify compare <manifest> <results.json> [<results-b.json>]");
  const mText = await readText(mFile);
  const lint = lintManifest(mText);
  if (!lint.manifest || !lint.ok) {
    const first = lint.findings.find((x) => x.severity === "error");
    throw new UsageError(`${mFile} has ${plural(lint.errors, "error")} (first: ${first?.path || "(document)"}: ${first?.message}). Run: huygena-verify manifest ${mFile}`);
  }
  const manifest: Manifest = lint.manifest;
  const hash = await manifestHash(mText);
  const results: NodeResults[] = [];
  for (const rf of rFiles) {
    const res = NodeResultsSchema.safeParse(await readData(rf));
    if (!res.success) {
      const i = res.error.issues[0]!;
      throw new UsageError(`${rf}: not a results.v0 file: ${i.path.join(".") || "(root)"}: ${i.message}`);
    }
    results.push(res.data);
  }
  const hashProblems = results.filter((r) => r.manifest !== undefined && r.manifest !== hash).map((r) => `${r.node} ran manifest ${r.manifest}, not ${hash}`);
  let report: CompareReport;
  try {
    report = compare(manifest, results, { partialFactor: a.partialFactor });
  } catch (err) {
    if (err instanceof CompareError) throw new UsageError(err.message);
    throw err;
  }
  const passed = report.summary.allReplicated && hashProblems.length === 0;
  if (a.json) {
    emitJson({ manifest: { file: mFile, hash }, manifestMismatch: hashProblems, ...report });
    return passed ? EXIT.ok : EXIT.failed;
  }
  kv("manifest", `${show(mFile)}  ${dim(hash)}`);
  kv("nodes", report.nodes.length === 2 ? `${report.nodes.join(", ")} (primary, confirming)` : `${report.nodes[0]} (one node: verdicts are not confirmed)`);
  kv("rules", `${report.rules.version}: partial band = ${report.rules.partialFactor}x tolerance unless the claim sets one`);
  for (const p of hashProblems) say(`  ${tag("FAIL")} ${p}`);
  say();
  const head = ["CLAIM", "REPORTED", "TOLERANCE", ...report.nodes, "VERDICT"].map((h) => dim(h));
  const rows = report.claims.map((c) => {
    const tol = c.band === null ? "-" : c.type === "structure" ? `<=${f(c.band)} Å` : `±${f(c.band)}`;
    const cells = c.nodes.map((n) => (n.value === null ? "-" : n.delta === null ? f(n.value) : `${f(n.value)} (${n.delta >= 0 ? "+" : ""}${f(n.delta)})`));
    const verdict = c.mismatch ? red("MISMATCH") : verdictColor(c.verdict!);
    return [c.id, c.reported === null ? "-" : f(c.reported), tol, ...cells, verdict];
  });
  table([head, ...rows]);
  const notable = report.claims.filter((c) => c.verdict !== "Replicated");
  if (notable.length) {
    say();
    for (const c of notable) say(`  ${dim(c.id + ":")} ${c.reason}`);
  }
  for (const n of report.notes) say(`  ${tag("INFO")} ${n}`);
  say();
  const s = report.summary;
  const parts = Object.entries(s.counts)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v}`);
  if (s.mismatches) parts.push(`${s.mismatches} mismatch${s.mismatches === 1 ? "" : "es"} (no verdict until resolved)`);
  kv("summary", `${plural(s.total, "claim")}: ${parts.join(", ")}`);
  if (passed) say(`${tag("PASS")} every claim Replicated${s.twoNodes ? " on both nodes" : " (one node, unconfirmed)"}`);
  else say(`${tag("FAIL")} not every claim is Replicated${s.mismatches ? " and the nodes disagree on some" : ""}`);
  return passed ? EXIT.ok : EXIT.failed;
}

function verdictColor(v: string): string {
  if (v === "Replicated") return green(v);
  if (v === "Partially replicated") return yellow(v);
  if (v === "Failed") return red(v);
  return dim(v);
}

async function cmdCert(a: Args): Promise<number> {
  const file = a.positional[0];
  if (!file) throw new UsageError("usage: huygena-verify cert <certificate.json> [--manifest <file>] [--bundle <dir>]");
  const cert = await readData(file);
  const manifest = a.manifest ? await readText(a.manifest) : undefined;
  if (a.bundle && !existsSync(a.bundle)) throw new UsageError(`${a.bundle} does not exist`);
  let report;
  try {
    report = await verifyCertificate(cert, { manifest, bundleDir: a.bundle, ignore: a.ignore });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (a.json) {
    emitJson({ file, ...report });
    return report.ok ? EXIT.ok : EXIT.failed;
  }
  kv("cert", show(file));
  const c = report.certificate;
  if (c) {
    kv("run", c.run);
    kv("paper", c.paper);
    kv("nodes", `${c.nodes.primary} + ${c.nodes.confirming ?? "none"}`);
  }
  say();
  const map = { pass: "PASS", fail: "FAIL", skipped: "SKIP", planned: "PLAN" } as const;
  table(report.checks.map((ch) => [tag(map[ch.status]), ch.id, ch.detail]));
  say();
  const n = report.counts;
  const tail = `${n.pass} passed, ${n.fail} failed, ${n.skipped} skipped, ${n.planned} planned`;
  if (report.ok) say(`${tag("PASS")} offline checks hold (${tail}). Planned checks are not done by this version`);
  else say(`${tag("FAIL")} ${tail}`);
  if (n.skipped) say(dim("      Skipped checks need --manifest and --bundle."));
  return report.ok ? EXIT.ok : EXIT.failed;
}

async function cmdInit(a: Args): Promise<number> {
  const file = a.positional[0] ?? "manifest.yaml";
  if (existsSync(file) && !a.force) throw new UsageError(`${file} exists; pass --force to overwrite`);
  await writeFile(file, MANIFEST_TEMPLATE);
  if (a.json) {
    emitJson({ wrote: file });
    return EXIT.ok;
  }
  say(`wrote ${show(file)}`);
  say(`Fill in every <placeholder>, then run: huygena-verify manifest ${show(file)}`);
  return EXIT.ok;
}

/** Run the CLI with `argv` (without node and script). Writes to stdout/stderr and resolves to the exit code. */
export async function main(argv: string[]): Promise<number> {
  out.length = 0;
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`huygena-verify: ${(err as Error).message}\n`);
    return EXIT.usage;
  }
  useColor = a.color && !a.json;
  if (a.version) {
    process.stdout.write(`${version}\n`);
    return EXIT.ok;
  }
  if (a.help || !a.cmd) {
    process.stdout.write(HELP);
    return a.cmd || a.help ? EXIT.ok : EXIT.usage;
  }
  const commands: Record<string, (a: Args) => Promise<number>> = {
    manifest: cmdManifest,
    hash: cmdHash,
    bundle: cmdBundle,
    compare: cmdCompare,
    cert: cmdCert,
    init: cmdInit,
  };
  const run = commands[a.cmd];
  if (!run) {
    process.stderr.write(`huygena-verify: unknown command "${a.cmd}". Run huygena-verify --help\n`);
    return EXIT.usage;
  }
  try {
    const code = await run(a);
    if (out.length) process.stdout.write(`${out.join("\n")}\n`);
    return code;
  } catch (err) {
    if (out.length) process.stdout.write(`${out.join("\n")}\n`);
    if (err instanceof UsageError) {
      process.stderr.write(`huygena-verify: ${err.message}\n`);
      return EXIT.usage;
    }
    process.stderr.write(`huygena-verify: ${(err as Error).stack ?? String(err)}\n`);
    return EXIT.usage;
  }
}
