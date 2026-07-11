// A tiny glob matcher for digest's `--include`/`--exclude` (design §3.11) and
// default-exclude filtering. Supports `*` (within one path segment), `**`
// (across segments, zero or more), `?` (one character), literal text
// otherwise. No dependency — this is deliberately narrower than a full glob
// implementation (no `{a,b}`/`[abc]` classes), which is all digest needs.

function globToRegExp(glob: string): RegExp {
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        // `**/` — zero or more whole path segments, so `**/node_modules/**`
        // matches both `node_modules/x` and `a/b/node_modules/x`, but never
        // a false-positive substring match like `xnode_modules/x` (the
        // group must end on an actual `/` boundary, not any character run).
        pattern += '(?:.*/)?';
        i += 3;
      } else {
        // A trailing/bare `**` — anything, including further `/` segments.
        pattern += '.*';
        i += 2;
      }
      continue;
    }
    if (c === '*') {
      pattern += '[^/]*';
    } else if (c === '?') {
      pattern += '[^/]';
    } else {
      pattern += c?.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    i += 1;
  }
  return new RegExp(`^${pattern}$`);
}

/** True if `path` matches the glob `pattern`. Pure, stateless — no filesystem access. */
export function globMatch(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}
