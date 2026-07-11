import { readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli-entry.ts',
    'mcp-shim': 'src/mcp-shim.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node18',
  // No code splitting: each entry is self-contained, so the in-source entry
  // guard (`shouldRunAsEntry` in src/entry.ts) resolves import.meta.url
  // against argv[1] via realpath when a bin is run. With splitting on, that
  // guard would live in a shared chunk whose URL never matches argv[1]. The
  // guard itself lives ONLY in src/cli-entry.ts and src/mcp-shim.ts (the two
  // actual bin entries) — src/cli.ts and src/index.ts are pure library
  // modules with no self-invoking code, so importing `run` from cli.ts (as
  // mcp-shim.ts and index.ts both do) never risks a second guard firing
  // inside the wrong bundle.
  splitting: false,
  sourcemap: true,
  outDir: 'dist',
  async onSuccess() {
    // Add the shebang to the executable entry points so the global bins run.
    for (const file of ['dist/cli.js', 'dist/mcp-shim.js']) {
      const body = readFileSync(file, 'utf-8');
      if (!body.startsWith('#!')) {
        writeFileSync(file, `#!/usr/bin/env node\n${body}`);
      }
    }
  },
});
