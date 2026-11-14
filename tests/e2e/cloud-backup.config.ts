import base from '../../tsdown.config.ts'
import { fileURLToPath } from 'node:url'
export default {
  ...base,
  name: 'cloud-backup-offline-preview',
  entry: { cloud: fileURLToPath(new URL('./cloud-backup-render.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../../lib/cloud-preview', import.meta.url)),
  external: [],
  noExternal: () => true,
  format: 'iife',
  outputOptions: { entryFileNames: 'cloud.js' },
}
