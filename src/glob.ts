/**
 * Small gitignore-style matcher for bundle ignore rules (SPEC.md, "Ignore rules"):
 *
 * - `*` matches anything except `/`, `?` one character except `/`, `**` anything including `/`.
 * - A pattern without `/` (ignoring a trailing one) matches a file or directory name at any depth.
 * - A pattern with `/` is matched against the whole path from the bundle root. A leading `/` is dropped.
 * - A trailing `/` matches directories only.
 * - A matched directory is skipped with everything under it.
 */
export interface IgnoreMatcher {
  /** `path` is the POSIX path relative to the bundle root. */
  (path: string, isDir: boolean): boolean;
}

interface Rule {
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}

function compile(pattern: string): Rule | null {
  let p = pattern.trim().replace(/\\/g, "/");
  if (!p || p.startsWith("#")) return null;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.replace(/\/+$/, "");
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // "**/" matches zero or more directories; a bare "**" matches anything.
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return { re: new RegExp(`^${re}$`), dirOnly, anchored };
}

export function createIgnore(patterns: readonly string[]): IgnoreMatcher {
  const rules = patterns.map(compile).filter((r): r is Rule => r !== null);
  return (path, isDir) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(r.anchored ? path : name)) return true;
    }
    return false;
  };
}

/** Always ignored, by spec: version control metadata. */
export const DEFAULT_IGNORE = [".git"] as const;
