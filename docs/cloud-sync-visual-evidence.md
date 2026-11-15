# Cloud-sync original-reference visual evidence

## Verdict

The test imports the **original dsh-config-manager 0.8.2 full SyncPanel**, not a recreation, and compares it with the real password-vault CloudSyncPanel. The original full browser graph bundled and ran; the permitted card/dialog-only fallback was **not needed**.

Measured result: **15 paired states / 30 PNGs**. Ten baseline/mobile/configuration-dialog cases have **zero changed RGB pixels and zero normalized DOM/geometry differences**. The imported vault CSS embedded-ancestor probe also has zero changed pixels. Four configured cases are **not** 100% pixel-identical; exact differences are below.

This is synthetic visual/component evidence, **not** full application, transport, authentication, cryptography or cloud integration verification. No real vault, stored credential, login or remote endpoint was used.

## Commands and outcomes

Run from the repository root with the existing installed dependencies:

~~~sh
npx --no-install tsdown --config tests/e2e/cloud-sync.config.ts
node tests/e2e/cloud-sync-visual.mjs
~~~

The runner accepts DSH_TEST_CHROME for a different installed Chrome path. It installs no dependencies and starts no server.

- Original full-panel import probe: **exit 0**.
- Paired fixture build, including final production shellMain/pagePad wrappers: **exit 0**.
- Fifteen-state renderer after that wrapper fix: **exit 0**, zero page errors, no unexpected synthetic API action, no external HTTP request, all pages/context/browser closed.
- Final source-only fixture cleanup corrected its synthetic catalog fields to the actual typed displayName/portability/defaultIncluded contract and added source-hash recording; its bundle rebuild: **exit 0**. Per the parent's stop-reruns instruction, no further matrix was run after this non-production fixture cleanup. The screenshot metrics below belong to the tested bundle SHA-256 **a7bd66a2390689b539ae29e245f4c9b1e56786590a56d261c9768637e5be6a41**, as pinned in the measured manifest, not a claim that a later rebuilt bundle was rendered.

An initial exploratory renderer stopped after 12 pairs on an obsolete Chinese merge-button label in the test. It also closed browser/context in finally. The observed labels “从远端合并到本机” and “推送到远端” were used in successful corrected runs. This was a test locator error, not an inferred product defect. Existing tsdown external/noExternal deprecation and third-party use-client directive warnings did not fail the builds.

Sources: [renderer](<../tests/e2e/cloud-sync-render.tsx>), [scoped build configuration](<../tests/e2e/cloud-sync.config.ts>), [Playwright runner](<../tests/e2e/cloud-sync-visual.mjs>), measured manifest (local generated artifact: `lib/cloud-sync-visual/manifest.json`).

## Method and isolation

1. **Actual original UI:** the reference checkout is read-only. The vault side imports the real [CloudSyncPanel](<../src/client/CloudSyncPanel.tsx>). Both receive the same synthetic status data and vault-specific translation callback. This isolates component/layout preservation, not unchanged original wording everywhere.
2. **Reference wrapper:** verified the original [ConfigManagerSection:595–603](<https://github.com/xiajiajun516/dsh-config-manager/blob/635c2e66388c9ec5929071d05e01abd77779366d/src/client/ConfigManagerSection.tsx#L595-L603>) shellMain/pagePad chain, then used its unchanged CSS on both sides. The base rule is 12px top / 16px side/bottom; at the measured 564px viewport its existing responsive rules produce 12px horizontal inset (first card x=12, width=540). Test wrappers use div elements for structural parity; the full original ARIA tab shell, navigation and task panel are not mounted. The real shellMain scroll region has overflow-y:auto; the security state asserts a positive scrollTop of 550.
3. **Host tokens:** DSH token names and explicit synthetic light/dark values are identical and body-scoped on both sides. They are not sampled from the user's running host theme. Optional host primitives take their original local fallback; no live module loader or browser profile is connected.
4. **Production CSS pipeline:** extends the existing tsdown + LightningCSS pattern. Only the style-tag dedup identity is made path-specific so the independent reference/vendor modules coexist. No CSS declaration is restyled. CSS byte-equality is asserted. Original and vendor SHA-256 are both **29154793e4ebfd38e21bdedee1588663ae129e1a9523e43e8c3ad36d7f19e607**. Actual rendering—not this hash alone—is the parity evidence.
5. **Exact pixels:** decoded 8-bit RGB comparison, zero tolerance, **no masks, exclusions or text replacement**. Changed bounds and 64px-tile counts remain in comparison JSON. Desktop denominator 406,080; mobile denominator 280,800 pixels. Alpha is not compared; the fixture has an opaque body background.
6. **DOM and geometry:** records nonzero-geometry, CSS-visible rendered nodes, including offscreen/clipped descendants. Only CSS-module path-hash prefixes are normalized and generated ids/aria-controls omitted. Local class name, role, ARIA label, text, values, checked/disabled state, geometry rounded to 0.01px, font, foreground, background and border radius remain. The hash normalizer uses the last underscore because the hash itself can contain underscores. Baseline/dialog equality after this correction is measured, not assumed.
7. **Real handlers, synthetic typed port:** configuration buttons open the real dialogs. Configured merge/push buttons execute their real component handlers into explicit in-memory responses. The reference does not instantiate its HTTP SyncApi. Unexpected requests throw rather than returning no-op success. No password/token is typed; snapshot/plan identifiers and URLs are synthetic non-credentials. Conflict previews are literal redaction placeholders.
8. **Isolation:** ephemeral headless Chrome context, no persistent profile, service workers blocked, only synthetic document navigation fulfilled in memory; other requests are aborted. Successful measured run recorded 30 in-memory document requests and no other HTTP attempts, zero page errors, zero unexpected fake calls. Pages close in finally; context/browser close in nested finally. No browser bridge/live tab is used.

## Final measured matrix

All viewports have height 720. Raw pixel results have **no approved-difference masking**.

| State / width | Changed pixels | Percent | DOM differences | Outcome |
| --- | ---: | ---: | ---: | --- |
| Unconfigured zh light / 564 | 0 | 0% | 0 | Exact |
| Unconfigured zh dark / 564 | 0 | 0% | 0 | Exact |
| Unconfigured en light / 564 | 0 | 0% | 0 | Exact |
| Unconfigured en dark / 564 | 0 | 0% | 0 | Exact |
| Mobile zh light / 390 | 0 | 0% | 0 | Exact |
| Mobile en dark / 390 | 0 | 0% | 0 | Exact |
| Git configuration dialog / 564 | 0 | 0% | 0 | Exact; 64 modal nodes |
| WebDAV configuration dialog / 564 | 0 | 0% | 0 | Exact; 51 modal nodes |
| S3 configuration dialog / 564 | 0 | 0% | 0 | Exact; 81 modal nodes |
| Gist configuration dialog / 564 | 0 | 0% | 0 | Exact; 53 modal nodes |
| Configured Git top / 564 | 245 | 0.060333% | 2 | Mandatory encryption state and truthful wording |
| Configured security scrolled / 564 | 497 | 0.122390% | 2 | Mandatory encryption state and truthful wording; original row geometry retained |
| Merge conflict modal / 564 | 1,272 | 0.313239% | 5 whole-tree | Vault labels and underlying security controls |
| Push preview modal / 564 | 664 | 0.163515% | 3 whole-tree | Vault label and underlying security controls |
| Real vault CSS embedded ancestor / 564 | 0 | 0% | 1 | Intentional root class/inherited font only |

All 30 documents have no horizontal document overflow. A single wrapper root is asserted. The legacy encrypted-cloud-backup heading is absent; this is not a claim to prove all parent local-backup separation because those sibling blocks are intentionally not mounted here.

### Precise configured differences

**Final top viewport:** encryption is checked and disabled. The original password-clear warning row is retained at the same geometry, with truthful wording that vault encryption is mandatory. Final changed area is 245 pixels; the earlier 24.75px warning-removal reflow has been corrected.

**Final security scrolled:** both mandatory encryption and inapplicable DSH credential export controls are non-editable. Original card/row geometry is retained; final changed area is 497 pixels (0.122390%). These are explicitly approved vault-safety adaptations, not zero-difference claims.

**Merge modal:** 66 nodes on both sides; only three modal DOM differences. The original closed section-label registry does not contain the newly approved vault id, so reference renders “vault”, adapter “密码库”. Title width **32.45 → 39px** at (62,333.25); adjacent 需裁决 badge x **102.45 → 109**; group ARIA label changes vault → 密码库 with unchanged box. All other modal properties compare equal. Underlying security pixels remain visible through the scrim, so the full-frame difference is larger than the label alone. Exact modal deltas (local generated artifact: `lib/cloud-sync-visual/merge-conflict.modal-comparison.json`).

**Push preview:** 21 modal nodes on each side. Sole modal difference is “vault · 2” → “密码库 · 2”; box unchanged at (94,413.69), 401 × 20.38. Full-frame raw difference also includes underlying security controls. Exact modal delta (local generated artifact: `lib/cloud-sync-visual/push-preview.modal-comparison.json`).

**Embedded ancestor:** imports real [VaultSection stylesheet](<../src/client/VaultSection.module.css>) and applies its embedded class on the vault side. Zero changed pixels after cloud-wrapper selector exclusions. Root class/inherited font (16px → 12.5px) differs; descendant UI/geometry matches. This is a selector-collision probe, not full VaultSection/VaultWorkbench integration evidence.

## Artifacts

The manifest (local generated artifact: `lib/cloud-sync-visual/manifest.json`) lists every state. Each has reference/vault PNGs, reference/vault DOM JSON (including fixture calls), and whole-frame comparison JSON; modal states additionally have modal comparison JSON.

Representative pairs:

- Main original (local generated artifact: `lib/cloud-sync-visual/unconfigured-zh-light-reference.png`) / vault (local generated artifact: `lib/cloud-sync-visual/unconfigured-zh-light-vault.png`)
- Git original (local generated artifact: `lib/cloud-sync-visual/dialog-git-reference.png`) / vault (local generated artifact: `lib/cloud-sync-visual/dialog-git-vault.png`)
- WebDAV original (local generated artifact: `lib/cloud-sync-visual/dialog-webdav-reference.png`) / vault (local generated artifact: `lib/cloud-sync-visual/dialog-webdav-vault.png`)
- S3 original (local generated artifact: `lib/cloud-sync-visual/dialog-s3-reference.png`) / vault (local generated artifact: `lib/cloud-sync-visual/dialog-s3-vault.png`)
- Gist original (local generated artifact: `lib/cloud-sync-visual/dialog-gist-reference.png`) / vault (local generated artifact: `lib/cloud-sync-visual/dialog-gist-vault.png`)
- Security original (local generated artifact: `lib/cloud-sync-visual/configured-security-reference.png`) / vault (local generated artifact: `lib/cloud-sync-visual/configured-security-vault.png`)
- Merge original (local generated artifact: `lib/cloud-sync-visual/merge-conflict-reference.png`) / vault (local generated artifact: `lib/cloud-sync-visual/merge-conflict-vault.png`)
- Push preview original (local generated artifact: `lib/cloud-sync-visual/push-preview-reference.png`) / vault (local generated artifact: `lib/cloud-sync-visual/push-preview-vault.png`)

## Explicitly not proved

- Live installed DSH shell appearance/theme, navigation, full parent mounting/local-backup separation or real host CSS load order beyond the imported-ancestor probe.
- Network transports, authentication/OAuth, real token validation, secret storage, encryption algorithm/persistence, automatic-sync scheduling, actual push/apply/restore/rollback/download/history.
- Every configured channel, every locale/theme/mobile dialog combination, wheel/touch scrolling, complete keyboard/focus/screen-reader behavior or animation quality (reduced motion is fixed).
- Pixel identity outside the exact cases above. Configured differences are retained and explained, not masked. QA changed only its three new e2e files and this new document; production/vendor/reference/package edits belong to the parent or other contributors, not this work.
## Final parent verification

The final measured manifest supersedes the earlier exploratory bundle figures above. Current complete regression: **1098 passed, 5 skipped**, exit0. Current DSH web profile installed/enabled1.12.0 and only dsh-vault was reloaded; real cloudSyncCall(status) returned HTTP200/ok:true, four channels and vault-only catalog. No real credentials or cloud upload were used. Final live GUI clicks were revoked by human intervention; no uncertain click was replayed. Actual account login/upload and unlocked host-theme visual acceptance remain user-run checks.
