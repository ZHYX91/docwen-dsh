import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

const [, browser] = await Promise.all([
  build({ entryPoints: ['src/host.ts'], outfile: 'dist/host.js', bundle: true, format: 'esm', platform: 'node', target: 'node24' }),
  build({
    entryPoints: ['src/client.tsx'], bundle: true, format: 'cjs', platform: 'browser',
    external: ['react', 'react/*'], write: false,
  }),
])
await writeFile('dist/client.js',
  `window.__ModuleLoader__.load({ id: '@zhyx91/docwen-dsh', factory(require) {
const module = { exports: {} };
${browser.outputFiles[0].text}
return module.exports;
} });
`)
