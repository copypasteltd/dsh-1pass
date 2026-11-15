/** Docs-only offline build: imports the production workbench and its exact CSS pipeline. */
import base from '../tsdown.config.ts'
import { fileURLToPath } from 'node:url'
export default { ...base, name: 'onepass-docs-demo', entry: { 'docs-demo': fileURLToPath(new URL('./docs-demo-render.tsx', import.meta.url)) }, outDir: fileURLToPath(new URL('../lib/docs-demo', import.meta.url)), external: [], noExternal: () => true, format: 'iife', sourcemap: false, outputOptions: { entryFileNames: 'docs-demo.js' } }
