import { build } from 'esbuild'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [host, browser] = await Promise.all([
  build({
    entryPoints: ['src/host.ts'], outfile: 'dist/host.js', bundle: true, format: 'esm',
    platform: 'node', target: 'node24', metafile: true,
  }),
  build({
    entryPoints: ['src/client.tsx'], bundle: true, format: 'cjs', platform: 'browser',
    external: ['react', 'react/*'], write: false, metafile: true,
  }),
])

const bundledPackages = new Set()
for (const { metafile } of [host, browser]) {
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) {
      const packageRoot = input.match(/^(?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+(?=\/)/)?.[0]
      if (packageRoot) bundledPackages.add(packageRoot)
    }
  }
}

const notices = await Promise.all([...bundledPackages].map(async (directory) => {
  const { name, version } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const names = await readdir(directory)
  const licenseFiles = names.filter(name => /^(?:license|copying)(?:\.|$)/i.test(name)).sort()
  if (licenseFiles.length === 0) throw new Error(`Missing license for bundled dependency ${name}@${version}`)
  const noticeFiles = names.filter(name => /^notice(?:\.|$)/i.test(name)).sort()
  const texts = await Promise.all([...licenseFiles, ...noticeFiles].map(async (file) =>
    (await readFile(join(directory, file), 'utf8')).trim(),
  ))
  return `${name}@${version}\n\n${texts.join('\n\n')}`
}))

await Promise.all([
  writeFile('dist/client.js',
    `window.__ModuleLoader__.load({ id: '@zhyx91/docwen-dsh', factory(require) {
const module = { exports: {} };
${browser.outputFiles[0].text}
return module.exports;
} });
`),
  writeFile('dist/THIRD-PARTY-NOTICES.txt', `${notices.sort().join('\n\n---\n\n')}\n`),
])
