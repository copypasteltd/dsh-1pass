# Password-vault cloud sync UI adoption

## Authorization and scope

This is the explicitly authorized **write implementation**, not a read-only analysis. The reference UI/flow is adopted while data remains exclusively PASSWORDVAULT and encryption remains mandatory. No credential, browser, remote repository, or cloud operation was performed during implementation or tests.

Reference: dsh-config-manager **0.8.2**, exact commit `635c2e66388c9ec5929071d05e01abd77779366d`. The reference checkout was left unchanged (verified clean Git status). License: MIT, copyright (c) 2026 xiajiajun516. The complete original permission/warranty notice is retained in [vendor LICENSE](<../vendor/config-manager/LICENSE>). Copied/derived sources carry their copyright, SPDX and license path; the CSS is intentionally copied byte-for-byte without an added banner and is covered by the adjacent license and this manifest.

## Integration contract

[CloudSyncPanel](<../src/client/CloudSyncPanel.tsx>) exports exactly:

```ts
interface CloudSyncPanelProps {
  t: VaultTranslate
  cloudSyncCall: (action: string, payload?: unknown) => Promise<unknown>
  readonly: boolean
  locked: boolean
  unavailable: boolean
  vaultName: string
  onBusyChange?: (busy: boolean) => void
}
```

[SyncPanel](<../vendor/config-manager/src/client/sync/SyncPanel.tsx>) retains the reference public props `api: SyncApi`, `t: TranslateNS<'config-manager-sync'>`, `cmT`. The wrapper supplies the exact reference section class, vault-scoped Radix modal portal root, and original ToastViewport.

The facade keeps class [SyncApi](<../vendor/config-manager/src/client/sync/sync-api.ts>) and `t: UiT`; HTTP calls are replaced by the supplied host facade. Exact action names are:

`status/workdirReset/probe/exportPreview/push/pushPreview/pull/download/deleteSnapshot/githubStart/githubPoll/githubCancel/githubValidate/githubListRepositories/githubCreateRepository/history/snapshotsList/sync/applyItems/cancel/autosyncStatusAll/autosyncStatus/autosyncUpdate/saveSelection/saveConfig/clearChannel/saveUiPrefs/rollback/mergePreview/applyMerge/consult`.

Original request bodies are retained: scalar flow/session arguments become their original body objects; exportPreview uses `{only}`; createRepository always requests private; clearChannel uses `{transport,clear:true}`. Merge requests already carry the explicit channel body in the reference and keep it. Push/merge preview planId is held in memory per channel and returned by the matching explicit confirmation action. The parent host is the authoritative guard, encryption, persistence, transport, compare-and-swap and preview-validity implementation.

## Preserved rendering and approved adaptations

- Original SyncPanel JSX composition, four cards in **git → webdav → s3 → gist** order, original unconfigured layout, original configured-card folding/default expansion, original custom Select, InfoHint, Icon/MorphIcon, Motion, modal headers/body/footer, toast, connection probe, workdir, log, merge and confirmation views. No native-control redraw.
- The channel configuration dialog still renders only the opening channel; no channel tabs are introduced.
- [config-manager CSS](<../vendor/config-manager/src/client/config-manager.module.css>) is **235,484 bytes**, SHA-256 `29154793e4ebfd38e21bdedee1588663ae129e1a9523e43e8c3ad36d7f19e607`, identical to the reference.
- The only catalog item is `vault`, displayed through the original section-label shim as **密码库 / Password vault**. No settings/plugins/MCP export capability is advertised. Pure UI metadata/type helpers are narrowed to browser-safe structural declarations rather than importing Node I/O graphs. Original compatibility helper functions are extracted without the unused import controller.
- Original encryption checkbox remains in the original SecurityOptionsCard layout but is checked/disabled with a short truthful encryption-required hint. DSH credential export checkbox is unchecked/disabled: vault entries are already the encrypted payload; DSH credentials are not exported separately. Host payload policy forces `encrypt:true/includeSecrets:false` and removes unrelated session/plugin controls.
- The original remote-snapshots library patch routes through [VaultRemoteHistory](<../vendor/config-manager/src/client/VaultRemoteHistory.tsx>): a real per-channel remote list using original ArtifactRowView, ConsultCard, SyncConfirmView and delete confirmation. Remote content is never rendered as plaintext. Only actual supported pull/consult/delete capabilities are exposed; encrypted file download remains available through the facade, not an invented browser download action.
- Strict-optional type compatibility uses explicit `| undefined` on reference optional props, not `any`, `ts-nocheck`, or weakened project compiler options. Original deep-icon declaration shims are included.

## Security and scope lifetime

[Vault policy](<../vendor/config-manager/src/client/vault-policy.ts>) denies unknown actions; locked/unavailable deny all host requests; readonly denies mutations. Readonly controls are disabled while configuration can still be inspected. The host independently checks authorization.

[Scoped UI store](<../vendor/config-manager/src/client/run-store.ts>) retains only `channel` in a parsed whitelist. Keys are `dsh.vault.cloudSync.<encoded vaultName>.state.v1` and `.channel`, never original config-manager storage keys. Credentials, encryption/decryption passwords, URLs, previews, decisions and reports are not serialized. All current secret input values remain in memory and are cleared on vault/access scope change, pagehide and unmount. Pending config drafts are discarded on unmount (the reference's unload flush is intentionally removed). Closed-scope requests cannot deliver their response to the new scope.

Server responses are metadata-only/redacted; the UI defense additionally drops secret/entry payloads, conflict raw sides and diffs, masks known draft secrets, and never prints raw error objects. History metadata `entries` is retained, not confused with vault entry values. Conflict preview text is always hidden even if a host incorrectly returns an unredacted preview.

## Dependency ownership

Parent-owned dependencies resolved from exact reference versions: `lucide-react@1.61.0`, `lucide@1.61.0`, `morphicons@2.0.0`, `@radix-ui/react-dialog@1.3.1`. No independent package installation or edits to package/NOTICE/index/backend/store/Workbench/existing CloudBackupPanel/locales were made by this implementation owner.

## Validation evidence

- `npm run typecheck`: **passed**, exit 0 with the host's existing strict options.
- `npx vitest run tests/cloud-sync-reference-ui.spec.ts`: **12 passed**, exit 0. Synthetic ReactDOM only: exact unconfigured card DOM/card order, all four channel dialog fields/no tabs, original default fold behavior, mandatory encryption/disabled DSH export, readonly, locked/scope revocation, remote library route, whitelist storage/no plaintext, unknown-action guard, per-channel preview plan IDs.
- Reference commit/clean tree and exact CSS hash were checked with no mutations. Runtime source scan contains no `any`, `ts-nocheck` or Node I/O imports.
- Parent owns actual browser visual verification and final bundle integration. No deployment/commit/cloud invocation was requested or performed.

## Complete source-copy manifest

The machine-readable [source manifest](<../vendor/config-manager/source-manifest.json>) records original and vendored SHA-256 for each copy/derivation plus new adapter files. Paths below map to the same path under the immutable reference root.

| Vendored source | Reference SHA-256 | Treatment |
| --- | --- | --- |
| [LICENSE](<../vendor/config-manager/LICENSE>) | `66b8183eb5babdfffafe8f4eff62c9a50bef2a7abbbf6fd0e37314160d858375` | exact bytes |
| [src/client/api.ts](<../vendor/config-manager/src/client/api.ts>) | `e2335e526609db46bad0d67ebb4c4e6ec8084f4c777b00ff1de957bfa1a32a5f` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/client-types.ts](<../vendor/config-manager/src/client/client-types.ts>) | `7a449e09d2d8ff64f52caf52c920175fa7988b21e0de79062ae104f36dc6a10c` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/clipboard.ts](<../vendor/config-manager/src/client/common/clipboard.ts>) | `bb81f5d4d7890186f16a2158368010d82159db3ad3de88eb708d7399f23e330c` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/ConfirmDialog.tsx](<../vendor/config-manager/src/client/common/ConfirmDialog.tsx>) | `de0f69affee5ae32803e1b28e3ad5843aac91a57ee867637c6f0337e443db394` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/ContentPicker.tsx](<../vendor/config-manager/src/client/common/ContentPicker.tsx>) | `188c911e0680cf66aa412202f5b9642f6937960c76e5faffb0b60d6e25adecbe` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/ErrorBanner.tsx](<../vendor/config-manager/src/client/common/ErrorBanner.tsx>) | `6a7a1a7b35ec0fa9aac86a3df037934f5438fea7d165bb2c718f89e8db4b50c5` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/floating-bounds.ts](<../vendor/config-manager/src/client/common/floating-bounds.ts>) | `bccee1baa5cbfbb46a4b3d80b18ad9e9d9fcb207b011ba9d2fe2801576de2cda` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/host-primitives.ts](<../vendor/config-manager/src/client/common/host-primitives.ts>) | `168fe7f3c3f4f4b25f2ebaffebd98b856a8fc669a5ec97ebc6c86d0ceb456e39` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/Icon.tsx](<../vendor/config-manager/src/client/common/Icon.tsx>) | `e5ab7a43f2a699ce8cb0a2e293f2af1fc943d29e7da7ccd01782b1be19df01f9` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/InfoHint.tsx](<../vendor/config-manager/src/client/common/InfoHint.tsx>) | `5d2fc0adf64c1262ac97f918e79138ba12997aee204af2990b8cf2889bd0e639` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/menu-align.ts](<../vendor/config-manager/src/client/common/menu-align.ts>) | `aba539a3d17d56753993d21959dcd6570b0e2185f7bbbbfdc6dd5e9bfd3289b3` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/Modal.tsx](<../vendor/config-manager/src/client/common/Modal.tsx>) | `c0bbd6b6a68c91f49537f998639f58fc384c4750da0b77107e291147afe44933` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/MoreMenu.tsx](<../vendor/config-manager/src/client/common/MoreMenu.tsx>) | `f0a52a852639450d72a280cbc200523b74c317cdc0998050beb21a2298c4410c` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/morph-icons.ts](<../vendor/config-manager/src/client/common/morph-icons.ts>) | `9af901e5f05c2b7bd5b5445131550fa7b119a6bdfd57b4aebc940f1986fb6367` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/Motion.tsx](<../vendor/config-manager/src/client/common/Motion.tsx>) | `ff18dd117711a96abb231c08eb2b4f7a72b67fb8273db5905e542051b046c38d` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/section-labels.ts](<../vendor/config-manager/src/client/common/section-labels.ts>) | `f1cffd13ee5cc0518d6a0f039d1aa39e115fa9b587ef847d7da78d0953a95c73` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/Select.tsx](<../vendor/config-manager/src/client/common/Select.tsx>) | `a806816444aa6edf04b252fb4149b53b00758c64bd9ebfb98dc1c77212235f99` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/Skeleton.tsx](<../vendor/config-manager/src/client/common/Skeleton.tsx>) | `1ee91007865bee2f2baa9f503c9f2b541f5aa7fee46b5a65eeb986cebceeaebf` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/toast-store.ts](<../vendor/config-manager/src/client/common/toast-store.ts>) | `668050d19b81d84e7307876022b301318bd77ad9268951b21368b4e0a8729a75` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/toast-types.ts](<../vendor/config-manager/src/client/common/toast-types.ts>) | `bc7f633761ec82fb4b0bddf4c9572a1ade971a77efa4f003baf50bdbc5b8d607` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/ToastViewport.tsx](<../vendor/config-manager/src/client/common/ToastViewport.tsx>) | `7593063b43ddd4cf58f9104d2c850b6e1c8d0cd8f6ff2c7855e55ceadb57f32b` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/common/ui.tsx](<../vendor/config-manager/src/client/common/ui.tsx>) | `2ed492682739df676b1fed3d7b6b8b9995911e3f47f16ff999c501fe4f473914` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/config-manager.module.css](<../vendor/config-manager/src/client/config-manager.module.css>) | `29154793e4ebfd38e21bdedee1588663ae129e1a9523e43e8c3ad36d7f19e607` | exact bytes |
| [src/client/consult/ConsultCard.tsx](<../vendor/config-manager/src/client/consult/ConsultCard.tsx>) | `148d652d17962879b7ed22260b8ec9046c6d45497c6cb0dfa955e57e9c09b3b8` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/css-modules.d.ts](<../vendor/config-manager/src/client/css-modules.d.ts>) | `6385f8c0637d8b4fd61f471591be318dedded38775167621daba81b517eebee6` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/library/ArtifactDetail.tsx](<../vendor/config-manager/src/client/library/ArtifactDetail.tsx>) | `a654d22af2ea1ee6b5f2f1a34c7a5ec5232b9df0ccf2f76371eff296e9f6a16b` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/library/ArtifactRow.tsx](<../vendor/config-manager/src/client/library/ArtifactRow.tsx>) | `27c05213dfb983ddbdc9ef58a2d80bf603f071846af534c3c1bdc8943533f442` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/locales.ts](<../vendor/config-manager/src/client/locales.ts>) | `61ef5d77d57be13dfe0c6d855e9cfb23dcc01517acbd6a0455d854c080c4a7e3` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/lucide-icons.d.ts](<../vendor/config-manager/src/client/lucide-icons.d.ts>) | `6ba5f7cc235813de85b1a87f48b38e6de2a7ea9f33782ca1c132d998cb6bba4f` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/run-store.ts](<../vendor/config-manager/src/client/run-store.ts>) | `53ed35cccfb51353b215848c80b4e3ce6d9432ec76efb9d146c4881231b81f62` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/AutosyncCard.tsx](<../vendor/config-manager/src/client/sync/AutosyncCard.tsx>) | `3c4d4fe2924db7f589bf7b1608db15a891cdbbb61d9240f6a138c45a35498129` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/ChannelClearConfirmDialog.tsx](<../vendor/config-manager/src/client/sync/ChannelClearConfirmDialog.tsx>) | `00fbf0e3a64b440c4f6bf6340118faa7138b7949f5c1cc94f16a4ca856fc3a46` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/ChannelConfigDialog.tsx](<../vendor/config-manager/src/client/sync/ChannelConfigDialog.tsx>) | `46064c7f7460cb46ab9d003064e9d54c36d0e7e80364b23d06013d8b44d2c782` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/config-save-state.ts](<../vendor/config-manager/src/client/sync/config-save-state.ts>) | `f40206d1ceb096c5e9d51c70097cc98b27c6bc6e9178c35d1d7e9e1c01040ff9` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/DecryptPasswordCard.tsx](<../vendor/config-manager/src/client/sync/DecryptPasswordCard.tsx>) | `a147221b5df7afd587faecebc9867d992fb03eae1cc917d0fef076921feee1cf` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/history-model.ts](<../vendor/config-manager/src/client/sync/history-model.ts>) | `2b60ae0d8ec9c33f566e11d6f7329bb3aef9cee91102a3eb22d3f2e07cba8158` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/merge-view.ts](<../vendor/config-manager/src/client/sync/merge-view.ts>) | `7d46929e15663d911867303c5fc6e1aa8c9f44431e57656e3bb2b4782a1f4e49` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/MergeModal.tsx](<../vendor/config-manager/src/client/sync/MergeModal.tsx>) | `166e1c1507da492a21f618ebe7207db1de6332f62d3825a4436400d99bcdaf80` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/MergePreviewView.tsx](<../vendor/config-manager/src/client/sync/MergePreviewView.tsx>) | `3f11fad3ac7bfe49e3083336e15efefe2141a781cc8ad41a8e082485965fde76` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/preview-failure.ts](<../vendor/config-manager/src/client/sync/preview-failure.ts>) | `134085a7380361476c7cc902572e9935e49a037f053bc7fa4dbfb13eb5c1a67a` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/probe-view.ts](<../vendor/config-manager/src/client/sync/probe-view.ts>) | `59c04c40ee7630646dc5896718a77726d0be4c60046f08f3b8ac295277dd8c85` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/PushPreviewCard.tsx](<../vendor/config-manager/src/client/sync/PushPreviewCard.tsx>) | `39785d575eed96f7ec77484be2e79223399d20a941e050ca380166cf9e6016f3` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/remote-device-view.ts](<../vendor/config-manager/src/client/sync/remote-device-view.ts>) | `5347a7b1edee22ef933c5a98232caa25003fcfec86a15d692e2023bc4b42ba23` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SecurityOptionsCard.tsx](<../vendor/config-manager/src/client/sync/SecurityOptionsCard.tsx>) | `cc09b7fba1a87f2af416b68c592c4cc380a55bb6da6a28a4be35b0a47d0c6292` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/sync-api.ts](<../vendor/config-manager/src/client/sync/sync-api.ts>) | `8b5b90a27c6246ffc3d282eaac4ee08bdd7806694fb0822890ea599276572c93` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/sync-entry.ts](<../vendor/config-manager/src/client/sync/sync-entry.ts>) | `c6c0b0f40bbb3059d4fc301d8afa2c32417c6cdbefab7a14234c77ebd4de1431` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/sync-locales.ts](<../vendor/config-manager/src/client/sync/sync-locales.ts>) | `af8c8415317412958ac41f58823638fdbd7ecd53124f42b998c5d0262a0f6a04` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/sync-view.ts](<../vendor/config-manager/src/client/sync/sync-view.ts>) | `20533e6ad8e198155047b14f62aea0dc9ca912f3775b707bafbde624d69887e2` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SyncActivityBar.tsx](<../vendor/config-manager/src/client/sync/SyncActivityBar.tsx>) | `4dadea2958bc9bc6d56603d470bbc3b1e608317137bd59dae48b7fd093cfeafa` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SyncChannelEntryCard.tsx](<../vendor/config-manager/src/client/sync/SyncChannelEntryCard.tsx>) | `b58cc97abe2e8a7db8246db3d0d16f25d5577d21982e6401fdd5560e2b653338` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SyncConfirmView.tsx](<../vendor/config-manager/src/client/sync/SyncConfirmView.tsx>) | `a1e8b6fd87703ff1175537761a3451ecb559fbab89a04cec38bb13d0c4a4f1c8` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SyncLogList.tsx](<../vendor/config-manager/src/client/sync/SyncLogList.tsx>) | `8352380853955f2d8fe22e052ded8d18ce47ef3d406cbd3ccced3ea652625e78` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SyncPanel.tsx](<../vendor/config-manager/src/client/sync/SyncPanel.tsx>) | `1c26f962f420cf55aac138d30508c70c345ad8aa9b8bc10898424922edc29a8d` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SyncProbeRow.tsx](<../vendor/config-manager/src/client/sync/SyncProbeRow.tsx>) | `295d6a23a63ec9af45eccbbbebbd948fb11af24486179c7e15b31d413e13ac3b` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SyncRepositoryPicker.tsx](<../vendor/config-manager/src/client/sync/SyncRepositoryPicker.tsx>) | `8e40b6ce65062d6a78a39c051bbf7490175eecb770c8303f9ba039dc924b5c97` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/SyncSectionPickerDialog.tsx](<../vendor/config-manager/src/client/sync/SyncSectionPickerDialog.tsx>) | `03f467b4e33341cffcfc9a5b2330ffcf057214d452a1b759ae96c39a14649197` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/UnreadableSnapshotsBanner.tsx](<../vendor/config-manager/src/client/sync/UnreadableSnapshotsBanner.tsx>) | `0073189f3530489267a3d65ac4365a8099e0b1a94225df28354904dea03c76b0` | licensed source, type compatibility and/or documented vault adaptation |
| [src/client/sync/WorkDirCard.tsx](<../vendor/config-manager/src/client/sync/WorkDirCard.tsx>) | `93c844b98c82daed6f025644c9e4bea50573a1c3eab405cf524be62ccc39feed` | licensed source, type compatibility and/or documented vault adaptation |
| [src/core/engine-locale.ts](<../vendor/config-manager/src/core/engine-locale.ts>) | `d4aab678c699220454a29db9effca7aa11ff09025bf81bfac912785e62b90ba4` | licensed source, type compatibility and/or documented vault adaptation |
| [src/core/import-defaults.ts](<../vendor/config-manager/src/core/import-defaults.ts>) | `93c1f474d28b6daf5af31bf1be2eabea746f6dd9b0a95ca1f1e1799a0c7005db` | licensed source, type compatibility and/or documented vault adaptation |
| [src/core/migration-consult.ts](<../vendor/config-manager/src/core/migration-consult.ts>) | `7ca8f9d3f6b126004f88f2e8e6803ab70a8972a0473744b213210ef337c0fc8f` | licensed source, type compatibility and/or documented vault adaptation |
| [src/core/msg-types.ts](<../vendor/config-manager/src/core/msg-types.ts>) | `4fe77646c85418a9194797d2c48daf488d0fa7b220198530172928ddab251e3e` | licensed source, type compatibility and/or documented vault adaptation |
| [src/core/session-select.ts](<../vendor/config-manager/src/core/session-select.ts>) | `38eceb127c6271b55b978181f38cb7b9446283da8c032ca28be228f38adf8d81` | licensed source, type compatibility and/or documented vault adaptation |
| [src/core/types.ts](<../vendor/config-manager/src/core/types.ts>) | `e47cc1b32266cc0445e96a8a4eab2e809c21eee173004249218bddc0638fadd8` | licensed source, type compatibility and/or documented vault adaptation |
| [src/schema/types.ts](<../vendor/config-manager/src/schema/types.ts>) | `76407c110bf91c97b1ceddf2c77c04e58a28e8b1dbbb8e720fe297bc5cc6e83e` | licensed source, type compatibility and/or documented vault adaptation |
| [src/security/messages.ts](<../vendor/config-manager/src/security/messages.ts>) | `52073bc129453d564e764ce5123fba3246eb6150fa7060bc4bee5b302b2dfbdd` | licensed source, type compatibility and/or documented vault adaptation |
| [src/security/redaction.ts](<../vendor/config-manager/src/security/redaction.ts>) | `c32cee51456e858caf65a7a7c71ba983375c81de5e11c11153d8372076ad5662` | licensed source, type compatibility and/or documented vault adaptation |
| [src/security/secret-scanner.ts](<../vendor/config-manager/src/security/secret-scanner.ts>) | `085feb457ddd01025808002f7baf0d65c76464c816ae0d8f1e8ac2aa3bf22389` | licensed source, type compatibility and/or documented vault adaptation |
| [src/sync/sync-config.ts](<../vendor/config-manager/src/sync/sync-config.ts>) | `5c528780c5eca2854d08ceddc0f077dc6d5f05ea4a1bd698411e80000590181e` | licensed source, type compatibility and/or documented vault adaptation |
| [src/sync/sync-engine.ts](<../vendor/config-manager/src/sync/sync-engine.ts>) | `edd950588cb87514bcaa20028c8abc7ec85226bb6aadd897510cbd3051dee02e` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/artifact-view.ts](<../vendor/config-manager/src/ui/artifact-view.ts>) | `272b9a36bc3285a794caddb3574aec4e7d44709777a083074385ef2c0007c711` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/badge-tone.ts](<../vendor/config-manager/src/ui/badge-tone.ts>) | `e517162edef4c531924aacc388f7320ce4de1dac4e9ef38df3bbe2434b8810d8` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/errors.ts](<../vendor/config-manager/src/ui/errors.ts>) | `df13325e4e706a206b8bfe13450e40de1067bfb24aa9d205c94fde3adcabf288` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/export-flow.ts](<../vendor/config-manager/src/ui/export-flow.ts>) | `b16a2770f923951ffda1f90ac174736011d96dbaa8673ea7445d8538fe8ba5b8` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/flow.ts](<../vendor/config-manager/src/ui/flow.ts>) | `1d2fee79abc7b5a05b467b6f91357b0cf60fe2ec4f33ddee835de6f232922a40` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/i18n.ts](<../vendor/config-manager/src/ui/i18n.ts>) | `2ea186c6c9d23f644ab708a07518adcb2a227e235f44fe89e4f55e28518c740f` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/import-wizard.ts](<../vendor/config-manager/src/ui/import-wizard.ts>) | `136aa3fd3cf6a1a963ce26f5e5de4a8defaaba9bc3cfc413dd903cfb67727be7` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/menu-placement.ts](<../vendor/config-manager/src/ui/menu-placement.ts>) | `8b1656b038b227845556dda9f05c4711e741b54cf52f3b881eabdee0b740e9e6` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/mid-ellipsis.ts](<../vendor/config-manager/src/ui/mid-ellipsis.ts>) | `b3f1a1f5d40cfe9f3293323791cba5a1ce8a32e932bcf75d76caa72b30a00490` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/migration-consult-view.ts](<../vendor/config-manager/src/ui/migration-consult-view.ts>) | `07dee1d8213f729873c59c7dff3a260f072254f8c4cf7cef8b863ddac66bca61` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/progress.ts](<../vendor/config-manager/src/ui/progress.ts>) | `55e8a769dfc3ac5a9e15957f096c178199104fc6b8a5a751ca1f8960308ff536` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/report.ts](<../vendor/config-manager/src/ui/report.ts>) | `18286408c9d06849aebc1573c7a85ba0332e72bdc0b20f5bbc1be09dcf308beb` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/select-model.ts](<../vendor/config-manager/src/ui/select-model.ts>) | `494785a33af9a80d78f6ee8aec5f799e796cf305212add9329e8616c2aca68a0` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/selection-model.ts](<../vendor/config-manager/src/ui/selection-model.ts>) | `26e8d549e8e6d6ffb0f378fbefc889e5142db235e6fb7cbfc8586ea6a583d2a9` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/session-format-disposition.ts](<../vendor/config-manager/src/ui/session-format-disposition.ts>) | `478510e0ef22fa438198060bb6f65697ba29b2492dc300d3a98c04a4d57d24ea` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/sync-repository-picker.ts](<../vendor/config-manager/src/ui/sync-repository-picker.ts>) | `a0a7135b7b9122e351df232c1ee50e29d0ed2ecb1eee2256993ca37d3cdc99bb` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/sync-settings-view.ts](<../vendor/config-manager/src/ui/sync-settings-view.ts>) | `a051039fe8b7f9d6cd4e6488c076b423e16b0bdba7678065c674e67fa719f3e6` | licensed source, type compatibility and/or documented vault adaptation |
| [src/ui/types.ts](<../vendor/config-manager/src/ui/types.ts>) | `3a7d8c2c734c052956a32014ce77fa9e2b06e61ebb8a140a4f95506c2826d871` | licensed source, type compatibility and/or documented vault adaptation |
| [src/utils/json.ts](<../vendor/config-manager/src/utils/json.ts>) | `46fa32c7f46e90f5aedbec418313155c70fb8fea1a54807314d79b4ef5afb64d` | licensed source, type compatibility and/or documented vault adaptation |
| [src/utils/messages-utils.ts](<../vendor/config-manager/src/utils/messages-utils.ts>) | `07fb787ed2bc1ae81234ae1def84c88fda498a3791b97e7761ab66c37f131e15` | licensed source, type compatibility and/or documented vault adaptation |
| [src/utils/shared-constants.ts](<../vendor/config-manager/src/utils/shared-constants.ts>) | `50cd7b142e1ff4c44070ececcdbbad66133a71c38d6d344ea57d003b064016f1` | licensed source, type compatibility and/or documented vault adaptation |
| [src/utils/time.ts](<../vendor/config-manager/src/utils/time.ts>) | `d6ed5250956adc76fd7ac34afe4f14a2f70f91ec786a106cc00a733f3b683709` | licensed source, type compatibility and/or documented vault adaptation |

New vault-only adapter files (no upstream source copied): [src/client/VaultRemoteHistory.tsx](<../vendor/config-manager/src/client/VaultRemoteHistory.tsx>), [src/client/vault-access.tsx](<../vendor/config-manager/src/client/vault-access.tsx>), [src/client/vault-policy.ts](<../vendor/config-manager/src/client/vault-policy.ts>), [src/client/vault-translations.ts](<../vendor/config-manager/src/client/vault-translations.ts>).
