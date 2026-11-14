import base from '../../tsdown.config.ts'
import { fileURLToPath } from 'node:url'
export default { ...base, name: 'onepass-workbench-preview', entry: { workbench: fileURLToPath(new URL('./workbench-render.tsx', import.meta.url)) }, outDir: fileURLToPath(new URL('../../lib/cloud-preview', import.meta.url)), external: [], noExternal: () => true, format: 'iife', outputOptions: { entryFileNames: 'workbench.js' } }
