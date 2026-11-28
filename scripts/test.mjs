import { build } from 'esbuild'
import { readdir, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const tests = (await readdir('test')).filter((name) => name.endsWith('.test.ts')).sort()
if (!tests.length) throw new Error('No test entry points were found.')
await mkdir('dist/tests', { recursive: true })
await build({
  entryPoints: tests.map((name) => path.join('test', name)),
  outdir: 'dist/tests',
  platform: 'node',
  target: 'node24',
  bundle: true,
  format: 'esm',
  banner: { js: "import { createRequire as createBundledRequire } from 'node:module'; const require = createBundledRequire(import.meta.url);" },
  outExtension: { '.js': '.mjs' },
  external: ['react', 'react/*'],
})
const result = spawnSync(
  process.execPath,
  ['--test', ...tests.map((name) => path.join('dist/tests', name.replace(/\.ts$/u, '.mjs')))],
  {
    stdio: 'inherit',
  },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
