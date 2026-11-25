import { describe, expect, it } from "vitest";
import { canonicalJson, manifestHash, sha256Hex } from "../src/core";

describe("canonicalJson (RFC 8785)", () => {
  it("sorts keys and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });

  it("writes numbers the ECMAScript way", () => {
    expect(canonicalJson([1.0, 1e3, 0.1, -0, 1e21, 1e-7, 0.912])).toBe("[1,1000,0.1,0,1e+21,1e-7,0.912]");
  });

  it("sorts keys by UTF-16 code units (RFC 8785 section 3.2.3 example)", () => {
    const obj = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    // Read the order from the string: Object.keys would move the integer-like key "1" to the front.
    const keys = [...canonicalJson(obj).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(keys).toEqual(["\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);
  });

  it("escapes strings like JSON.stringify", () => {
    expect(canonicalJson({ s: 'a"b\\c\n\u0001' })).toBe('{"s":"a\\"b\\\\c\\n\\u0001"}');
  });

  it("rejects values JSON cannot hold", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/NaN/);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ x: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/dates/);
    expect(() => canonicalJson(10n)).toThrow();
  });
});

describe("manifestHash", () => {
  const yaml = `# comments do not count
spec: manifest.v0
paper: "doi:10.5555/x"
claims:
  - id: c1
    reported: 0.912
    tolerance: 0.005
env:
  container: "sha256:${"0".repeat(64)}"
  code: "github.com/o/r@${"a".repeat(40)}"
  seeds: [0, 1]
run: { where: gpu-tee, confirm: independent-node }
`;
  // Computed independently with Python: json.dumps(doc, sort_keys=True, separators=(",", ":")).
  const CANONICAL =
    '{"claims":[{"id":"c1","reported":0.912,"tolerance":0.005}],"env":{"code":"github.com/o/r@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","container":"sha256:0000000000000000000000000000000000000000000000000000000000000000","seeds":[0,1]},"paper":"doi:10.5555/x","run":{"confirm":"independent-node","where":"gpu-tee"},"spec":"manifest.v0"}';
  const VECTOR = "sha256:1bd272b2ddb1673971e602b99f3e85e773e2dac7fa4ea4c4008673f702c15001";

  it("matches the fixed test vector", async () => {
    expect(await sha256Hex(CANONICAL)).toBe(VECTOR.slice(7));
    expect(await manifestHash(yaml)).toBe(VECTOR);
  });

  it("is the same for YAML and JSON, any key order, any whitespace", async () => {
    const json = JSON.stringify({
      run: { confirm: "independent-node", where: "gpu-tee" },
      env: { seeds: [0, 1], code: `github.com/o/r@${"a".repeat(40)}`, container: `sha256:${"0".repeat(64)}` },
      claims: [{ tolerance: 0.005, reported: 0.912, id: "c1" }],
      paper: "doi:10.5555/x",
      spec: "manifest.v0",
    }, null, 4);
    expect(await manifestHash(json)).toBe(VECTOR);
    expect(await manifestHash(JSON.parse(json))).toBe(VECTOR);
  });

  it("treats 0.0050 and 0.005 as the same number, and any value change as a new hash", async () => {
    expect(await manifestHash(yaml.replace("tolerance: 0.005", "tolerance: 0.0050"))).toBe(VECTOR);
    expect(await manifestHash(yaml.replace("tolerance: 0.005", "tolerance: 0.006"))).not.toBe(VECTOR);
    expect(await manifestHash(yaml.replace("seeds: [0, 1]", "seeds: [1, 0]"))).not.toBe(VECTOR);
  });

  it("keeps YAML dates as strings (core schema)", async () => {
    expect(await manifestHash("d: 2026-11-25\n")).toBe(await manifestHash('{"d":"2026-11-25"}'));
  });
});
