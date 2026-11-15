import base from '../../tsdown.config.ts'
import { fileURLToPath } from 'node:url'
const outDir = fileURLToPath(new URL('../../lib/github-connected-qa', import.meta.url))
export default [{
  ...base, name: 'github-connected-browser-qa',
  entry: { browser: fileURLToPath(new URL('./github-connected-render.tsx', import.meta.url)) },
  outDir, external: [], noExternal: () => true, format: 'iife', sourcemap: false,
  outputOptions: { entryFileNames: 'github-connected-ui.js' },
}, {
  name: 'github-connected-host-qa',
  entry: { host: fileURLToPath(new URL('./github-connected-host.ts', import.meta.url)) },
  outDir, platform: 'node', format: 'esm', dts: false, sourcemap: false, clean: false,
  external: [/^node:/, /^@deepseek-ai\//],
  outputOptions: { entryFileNames: 'github-connected-host.mjs' },
}]
