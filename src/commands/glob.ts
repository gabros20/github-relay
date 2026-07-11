// A tiny glob matcher for digest's `--include`/`--exclude` (design §3.11) and
// default-exclude filtering. Supports `*` (within one path segment), `**`
// (across segments, zero or more), `?` (one character), literal text
// otherwise. No dependency — this is deliberately narrower than a full glob
// implementation (no `{a,b}`/`[abc]` classes), which is all digest needs.

function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` — optionally eat a following slash so `src/**/*.ts` matches `src/x.ts` too.
        pattern += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (c === '?') {
      pattern += '[^/]';
    } else {
      pattern += c?.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** True if `path` matches the glob `pattern`. Pure, stateless — no filesystem access. */
export function globMatch(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}
