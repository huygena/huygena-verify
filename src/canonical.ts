/**
 * Canonical JSON, following RFC 8785 (JSON Canonicalization Scheme, JCS):
 *
 * - object members sorted by key, comparing UTF-16 code units;
 * - no insignificant whitespace;
 * - strings escaped as ECMAScript `JSON.stringify` does;
 * - numbers written as ECMAScript `Number.prototype.toString` writes them
 *   (so `1.0` becomes `1` and `1e3` becomes `1000`);
 * - `NaN`, `Infinity`, `undefined`, functions, symbols and bigints are rejected.
 *
 * This is what makes a YAML manifest and the same manifest written as JSON hash
 * to the same value. See SPEC.md, "Manifest hash".
 */
export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} cannot be represented in canonical JSON`);
      // JSON.stringify uses Number::toString, which is exactly what RFC 8785 requires. -0 becomes "0".
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => write(v, `${path}[${i}]`)).join(",")}]`;
      }
      if (value instanceof Date) throw new TypeError(`${path}: dates are not JSON values; quote them as strings`);
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`${path}: only plain objects can be canonicalized`);
      }
      const obj = value as Record<string, unknown>;
      // Default sort compares UTF-16 code units, as RFC 8785 section 3.2.3 requires.
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) throw new TypeError(`${path}.${k}: undefined is not a JSON value`);
        parts.push(`${JSON.stringify(k)}:${write(v, `${path}.${k}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`${path}: ${typeof value} is not a JSON value`);
  }
}
