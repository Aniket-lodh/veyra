/**
 * Marks the CommonJS build output as CommonJS.
 *
 * The package root declares `"type": "module"`, so every `.js` file under
 * `dist/` is treated as ESM. The `dist/cjs` build is compiled with
 * `module: CommonJS`, so it needs its own `package.json` that scopes
 * `"type": "commonjs"` to that directory. Without it, Node would parse the
 * CommonJS output as ESM and throw on the first `require`.
 *
 * This script is intentionally dependency-free so it can run in CI and in a
 * `prepublishOnly` hook without installing anything.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cjsDir = resolve(here, '..', 'dist', 'cjs');

await mkdir(cjsDir, { recursive: true });
await writeFile(
  resolve(cjsDir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);

console.log('wrote dist/cjs/package.json');
