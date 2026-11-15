# Encrypted vault HOST transports

## Scope and API

The host-only factory is [transports.ts](../src/cloud-sync/transports.ts) (import as shown below). It implements the shared `VaultSyncTransport` contract: `list()`, `upload(snapshot, expectedHead?)`, `download(id)`, `delete(id)` and `probe()`. Git additionally implements `workdirFacts()` and `resetWorkdir(mode, confirm)`.

~~~ts
import { createVaultSyncTransport, snapshotContentHash, metaFromSnapshot, remoteIndexVersion } from './transports.ts'

const transport = createVaultSyncTransport({
  config: { transport: 'git', repoUrl: 'https://example.org/private/vault.git', branch: 'main', subdir: '1pass' },
  stateDir: '/absolute/dedicated/vault-channel-state',
  credentials: { getSecret: async () => hostCredentialProvider.getTransportSecret() },
  signal: abortController.signal,
})
~~~

Construction performs validation only, never credential reads, processes or remote requests. The caller owns credential storage, write/read authorization, scheduling, per-channel mutation serialization, and cancellation. Network operations read token/password/S3 secret exclusively through `credentials.getSecret()`. This module has no plaintext-config secret fallback. Never return this provider or secret to the client. Reads still require the caller's policy approval.

Optional factory-only host controls (not saved in config):

- `timeoutMs`: 1–120000 ms per credential read, HTTP exchange or Git process; default 30000. HTTP includes streamed body consumption. Injected implementations ignoring AbortSignal are bounded by a racing timer. A complete operation can contain multiple bounded exchanges.
- `fetch`: injectable fetch; defaults to the host global fetch. Tests must inject mocks, not connect remotely.
- `allowInsecureHttpForTests: true`: accepts HTTP only on loopback AND only with injected fetch. Does not enable HTTP Git subprocess requests.
- `allowLocalGitForTests: true`: accepts absolute local bare Git fixture paths only. Not a general file transport.

## Vault-only documents

The wire document requires `format: '1pass-cloud-snapshot-v1'`, a unique safe `id`, canonical UTC `createdAt`, `contentHash`, `manifest` and `encryptedPayload`. Manifest requires schema version 1, `encrypted: true`, the channel name, bounded vault/device/platform/version labels, and exactly `sections: ['vault']`. Metadata has exactly id, timestamp, content hash, manifest and sectionCount=1. Unknown fields, config-manager documents, plaintext sections, invalid metadata and duplicate IDs are rejected rather than skipped.

The transport never decrypts. Payloads use the vault's current envelope: version 1, scrypt `{ algo: 'scrypt', n: 32768, r: 8, p: 1, saltHex }` (16-byte salt), and lowercase hexadecimal nonce (12 bytes), tag (16 bytes) and ciphertext. `snapshotContentHash(snapshot)` returns SHA-256 of recursive key-sorted canonical JSON of the complete envelope EXCLUDING contentHash. It can be used to fill that field before upload. `metaFromSnapshot(snapshot)` validates the existing hash and derives authoritative metadata. Download independently validates the envelope hash and compares the complete derived metadata against its index entry. The hash detects corruption, not malicious replacement of BOTH hash and document; AES-GCM verification after decrypt remains the caller's responsibility.

HTTP responses/request bodies are bounded to 21 MiB. Complete encrypted snapshot wire documents are bounded to 20 MiB + 64 KiB, ciphertext hexadecimal to 20 MiB (10 MiB encrypted payload), and the index to 10 MiB / 5000 entries. These separate bounds account for the vault engine's hexadecimal expansion of a 10 MiB plaintext limit without accepting unbounded responses. IDs are at most 128 safe characters; reserved filenames, Windows device filenames, unsafe prefixes, traversal and URL-embedded credentials are rejected. Defaults isolate this plugin from dsh-config-manager: `1pass` namespace/prefix, never the original config-manager namespace.

## Channel configuration and behavior

### Git: actual clone / fetch / ff-only / commit / push

Config: `repoUrl`, optional `branch` (when omitted, resolve the remote symbolic HEAD; a genuinely empty remote retains its unborn default branch) and `subdir` (default 1pass). HTTPS, safe `ssh://user@host/path` and scp-style `git@host:owner/repository.git` are supported. SSH uses installed key/agent authentication with BatchMode, strict host-key checking and bounded connection timeout; no token is used for SSH. Noninteractive HTTPS authentication uses a temporary askpass helper containing NO secret, the token in child environment memory, and finally cleanup. No token is placed in argv, remote URL, Git config, commits or logs. Helpers have restricted modes; Windows ACL inheritance still follows the parent state directory, which the host must protect.

The worktree is exactly `stateDir/worktree` with an ownership marker outside it and an exclusive per-state-directory lock. Existing unknown directories, symlinks/junctions and namespace mismatches are rejected. Full clone history is retained locally; sparse checkout limits working files to the configured namespace. Changes are staged/committed ONLY within that namespace. Local identity is command-scoped. Hooks, global credential helpers/config, interactive prompts, tracing environment and HTTP redirects are disabled for spawned Git commands. Each child uses spawn arguments with shell:false, bounded output/time, AbortSignal tree termination and completion collection. Never `git pull`, force push, destructive automatic reset or unrelated-history merge.

Each operation reconciles both fetch and push origins, resolves the configured or remote-default branch, fetches it and merges --ff-only. A populated repository with a broken default HEAD is reported as an error instead of silently creating a new main branch. Push rejection is a conflict; the local encrypted commit remains for inspection/recovery. Identical upload can retry that push. `workdirFacts` is local inspection only: it reports ownership/path, matching sanitized origins, local ahead/dirty facts; `remoteSnapshots: null` honestly indicates no fresh remote count. A changed unknown origin is not echoed (it might contain credentials).

`resetWorkdir('relink', false)` changes origins only. `adopt` requires confirmation and conservatively allows only an already-owned clean history that fast-forwards; it does not fabricate or merge unrelated histories. `reclone` requires explicit confirmation, validates ownership/scope, removes ONLY the owned worktree, and reclones; unpushed commits/local changes will be discarded. An incomplete clone or stale lock requires host inspection, never automatic deletion of unknown content.

Probe uses anonymous ls-remote, then authenticated ls-remote if anonymous fails (the reference's private-remote hint). SSH visibility cannot be inferred. Probe proves read reachability, NOT write permission. Deleting files never deletes old ciphertext from Git history.

### WebDAV

Config: `webdavUrl`, `webdavUsername`, optional `prefix` (default 1pass). HTTPS Basic auth; password comes from the credential provider. Layout is `<base>/<prefix>/index.json`, `<id>.json` and a durable content-present marker.

Upload reads the index, puts encrypted snapshot bytes, then conditionally PUTs the merged index. Strong ETag becomes If-Match; initial index uses If-None-Match: *. If the server omits a usable ETag, existing-index writes degrade to non-atomic updates: probe returns an explicit warning. Weak ETags are not misrepresented as usable strong CAS.

Probe can MKCOL the required collection ancestors and reports ONLY paths actually created (201). It never writes snapshots or a probe file. Redirects are manually bounded to five: read credentials are stripped permanently on cross-origin redirects; cross-origin writes and method-changing write redirects are refused. Endpoints and redirects require HTTPS except explicit injected loopback tests.

### S3 / OSS / COS / MinIO / Kodo

Config: `provider`, `endpoint` (origin only), `region`, `bucket`, `prefix` (default 1pass), `accessKeyId`, `pathStyle` and optional `dialectId` (aws4/oss4). AWS/MinIO default region is us-east-1; other providers require region. MinIO defaults path-style and needs explicit endpoint. Other endpoint templates follow reference defaults. Endpoints can be private HTTPS for user-authorized self-hosted storage.

Signing is Node-crypto-only hand-written SigV4. AWS-family signs host plus sent headers with x-amz payload SHA; OSS4 uses x-oss UNSIGNED-PAYLOAD, canonical /bucket/key independent of addressing style, OSS default signed-header selection and exact comma/no-space authorization serialization. Signed requests do not follow redirects.

AWS-compatible index writes use If-Match/If-None-Match. OSS initial index and immutable snapshots use x-oss-forbid-overwrite:true; existing OSS index uses a pre-write HEAD ETag check. OSS has NO atomic existing-object CAS: a HEAD-to-PUT race remains, and probe warns explicitly. Missing ETag disables even that check and is also warned. Gateway conditional-write support must be verified by its operator; mocked tests do not prove any vendor's live endpoint behavior.

### Gist

Config: `gistId`, optional `apiBaseUrl` and `filePrefix` (default 1pass). Files are `1pass-index.json` and `1pass-<id>.json`. Unrelated prefixes are not changed. Truncated individual files use bounded unauthenticated raw downloads from the API origin or gist.githubusercontent.com; overall truncated file listings fail closed.

PATCH NEVER sends conditional headers (the API rejects them). Each mutation GETs, merges, PATCHes index+snapshot/deletion, then GET-verifies expected metadata and file presence; newly added snapshot bytes/hash are checked too. Up to three read/merge/write/verify cycles preserve the union of entries already observed by this operation. A failed verification raises index-conflict. This is NOT atomic: unseen writes in the pre-PATCH window can still be overwritten, and no client-side check can recover facts it never observed. Probe warns explicitly about that residual risk and public Gists. Gist history retains deleted ciphertext.

## Preview-head baseline guard

The controller supplies the WHOLE index version it previewed as optional second upload argument `expectedHead`: `remoteIndexVersion(list)` returns `''` for a known-empty index, otherwise SHA-256 of canonical JSON of `[[id, contentHash], ...]` sorted by id.localeCompare (the shared helper is used to prevent comparator drift). This detects same-id overwrite and older clock-skewed entries that a latest-ID check would miss. Every transport compares this token against its freshly read index BEFORE writing any marker/snapshot/index. Git compares after ensure/fetch under the exclusive workdir lock and before snapshot file mutation/commit/push. A mismatch raises `VaultTransportError` with both code and message `SYNC_REMOTE_CHANGED`; it does not silently absorb a new head and publish a stale local payload. Gist checks before EACH retry PATCH, not only the first cycle. Omission retains compatibility for low-level callers, but controller-authorized writes must pass their preview token. This pre-read guard complements rather than replaces CAS: ETag/Git push still protects the post-read race. OSS/no-ETag/Gist retain the documented post-read non-atomic windows.

## Lost index, conflicts and failures

WebDAV/S3 write a persistent content-present marker BEFORE the first snapshot. It remains after all snapshots are deleted. If the index disappears but the marker (or prior in-memory observation) exists, upload/delete fail BEFORE mutation. Git checks actual namespace contents; Gist checks actual prefix files. Marker reads failing or returning anything other than a definite 404 also fail closed. Administrative deletion of BOTH index and marker, or foreign legacy data never written by this implementation, cannot be distinguished from a fresh namespace without remote listing; do not manually remove that marker.

Delete first conditionally removes the authoritative index reference, then deletes snapshot bytes. A CAS failure never deletes bytes still referenced by the winning index. A subsequent object deletion failure can leave an unreferenced encrypted object, which is safer than a dangling authoritative reference. No implicit GC/retention/force-retry occurs. Unique IDs are immutable: a same-ID/different-content upload fails. A network timeout can leave an unknown remote effect: inspect/reload before retry, especially on weak-CAS channels.

Errors crossing this boundary are locally authored and omit response bodies, child stderr, credential errors and fetch exception text. There is no transport logging. Diagnostics must not bypass this suppression or echo secrets. Reported hints contain only fixed warning text and validated non-secret configuration.

## Tests and attribution

Run `npm test -- --run tests/cloud-sync-transports.spec.ts`. Tests use synthetic encrypted-looking envelopes, injected fetch mocks for all HTTP channels, and temporary LOCAL bare repositories for actual Git round trips; no live vault, remote network, browser, install, deployment or repository commit is required. Process abort tests use a temporary child with no network. Tests cover CAS rejection, hash validation, missing-index refusal, secret suppression, size/timeout/AbortSignal bounds, Gist retry limits, OSS dialect and Git ownership/reset confirmation.

Transport I/O/index/CAS/signing design was adapted from MIT dsh-config-manager 0.8.2, reference HEAD 635c2e6, Copyright (c) 2026 xiajiajun516. The full retained license is in [LICENSE.reference](../src/cloud-sync/transports/LICENSE.reference), and is also embedded in the public factory header so it survives TypeScript host compilation. Generic DSH serialization, plaintext/optional encryption and blob plumbing were deliberately not reused.
