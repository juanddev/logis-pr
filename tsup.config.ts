import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  bundle: true,
  // Satu file mandiri: semua dependensi ikut dibundel, tidak ada node_modules saat runtime.
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  minify: false,
  // Dependensi CommonJS (cross-spawn) memanggil require() untuk modul bawaan Node.
  banner: {
    js: "import { createRequire as __logisCreateRequire } from 'node:module';\nconst require = __logisCreateRequire(import.meta.url);",
  },
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});
