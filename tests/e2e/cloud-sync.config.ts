import base from '../../tsdown.config.ts'
import { fileURLToPath } from 'node:url'

/** Offline IIFE only. Inherits the production LightningCSS CSS-module transform. */
export default {
  ...base,
  name: 'cloud-sync-offline-visual',
  entry: { cloudSync: fileURLToPath(new URL('./cloud-sync-render.tsx', import.meta.url)) },
  outDir: fileURLToPath(new URL('../../lib/cloud-sync-visual', import.meta.url)),
  // Two independent original/vendor CSS modules coexist in one QA bundle.
  // Preserve LightningCSS output; only make its style-tag dedup identity path-specific.
  plugins: base.plugins.map(plugin => plugin.name !== 'dsh-vault-css-modules-inline' ? plugin : {
    ...plugin,
    async load(id: string) {
      const loaded = await plugin.load!.call(this, id)
      return typeof loaded === 'string' ? loaded.replace(/const tagId = [^;]+;/, 'const tagId = ' + JSON.stringify('cloud-sync-qa/' + id) + ';') : loaded
    },
  }),
  external: [],
  noExternal: () => true,
  format: 'iife',
  outputOptions: { entryFileNames: 'cloud-sync.js' },
}
