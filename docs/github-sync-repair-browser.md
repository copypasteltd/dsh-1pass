# Git sync repair — connected browser proof

## Scope

This QA fixture is designed to render the actual [CloudSyncPanel](<../src/client/CloudSyncPanel.tsx>) in isolated headless Chrome and exposes an in-memory binding to the actual [VaultCloudSync controller](<../src/cloud-sync/controller.ts>). Configuration persistence, preview, encryption, Git clone/fetch/commit/push, and the second device's decrypt/apply all use the production implementation. Only the credential port is an in-memory synthetic map and the Git remote is a new temporary local bare repository enabled through the transport's explicit test-only option.

No production browser profile, replacement server, external HTTP, GitHub login, real credential, or existing vault is used. The document is fulfilled in memory; all other browser HTTP requests are blocked and host fetch is rejected. This is a connected synthetic browser proof, **not** evidence of live GitHub token permissions or production GUI deployment.

## Reproduce

From the repository root, using the installed Node and dependencies:

~~~sh
node node_modules/tsdown/dist/run.mjs --config tests/e2e/github-connected.config.ts --config-loader native
node tests/e2e/github-connected-browser.mjs
~~~

The Chrome executable defaults to the installed Windows Chrome path; override only with `DSH_TEST_CHROME` when necessary.

## Executed assertions — final native run passed

1. Open the real Git configuration dialog; enter the temporary remote and leave subdirectory blank.
2. With no saved encryption password, Push is disabled and its visible reason is recorded.
3. Fill matching synthetic password and confirmation; Push becomes enabled.
4. Click Push; wait for the actual preview dialog and independently confirm the remote still has zero branches/snapshots.
5. Click confirmation; independently inspect the bare remote's `trunk` branch, dedicated `1pass/index.json` namespace, encrypted snapshot envelope, and absence of plaintext input values.
6. Confirm saved configuration retains the empty UI subdirectory while the transport writes only inside the safe namespace.
7. A second real controller clones, previews, decrypts, and applies that snapshot to a separate synthetic vault.
8. Close browser context/browser, dispose controllers, lock synthetic vaults, and remove the temporary fixture in `finally`.

## Evidence

**Final result: PASS.** The parent rebuilt both host and browser bundles programmatically in the native Node process and executed the real headless Chrome runner. All eight assertions above passed. The run produced `QA_REAL_CLICK_PUSH_AND_SECOND_DEVICE_PASS`, with zero page errors, no external HTTP, preview snapshotCount=0, confirmed snapshotCount=1 on `trunk` under `1pass/`, and second-device decrypted=true. Browser context/browser and temporary fixture were removed in finally.

The initial child-CLI build attempt stalled and was killed; it was not counted as success. The first actual connected Chrome run then reproduced `SYNC_CONFIG_REVOKED`: an encryption-password save cancelled an otherwise legitimate queued Git configuration save. The final controller separates ordinary preview invalidation from lifecycle authorization revocation; the subsequent real browser runs passed. The final full regression passed **1131 tests, zero failures, 5 skipped**, with no unhandled errors.

Machine-readable evidence: final manifest (local generated artifact: `lib/github-connected-qa/manifest.json`). Synthetic screenshots: missing password guidance (local generated artifact: `lib/github-connected-qa/01-missing-password.png`), actual push preview (local generated artifact: `lib/github-connected-qa/02-push-preview.png`), confirmed encrypted push (local generated artifact: `lib/github-connected-qa/03-confirmed-push.png`). This does not claim a real GitHub token has repository write permission; that remains an account-specific check. No real credentials or user vault data were used.

## Sources

- [Browser render entry](<../tests/e2e/github-connected-render.tsx>)
- [UI/host bundle config](<../tests/e2e/github-connected.config.ts>)
- [Real temporary host fixture](<../tests/e2e/github-connected-host.ts>)
- [Headless click runner](<../tests/e2e/github-connected-browser.mjs>)
