# dsh-1pass · Encrypted credentials for DeepSeek Harness

[English](<README.md>) | [简体中文](<README-zh.md>)

**A local-first password workbench, 113 discoverable model tools, a script-friendly CLI, and a least-disclosure /1pass skill.**

Package/plugin/CLI name: **dsh-vault**. Settings name: **Password Manager (1pass)** / **密码管理(1pass)**.
Repository: [copypasteltd/dsh-1pass](https://github.com/copypasteltd/dsh-1pass).
Current source version: **1.12.2**; this describes the source tree, **not a claim that a v1.12.2 GitHub Release or npm publication exists**.
“1pass” is this project's workbench/skill name, not the commercial 1Password product; 1Password is a supported import/export format.

> Keep master passwords, batch credentials and cloud transport tokens out of chat. Enter them in the local GUI or an authorized secret-input channel. Finding a credential is not permission to connect, deploy, export, or change an account.

## Contents

- [What it does](#what-it-does)
- [Install and build](#install-and-build)
- [First unlock and language](#first-unlock-and-language)
- [/1pass workflow](#1pass-workflow)
- [Credential model](#credential-model)
- [GUI pages and operation GIFs](#gui-pages-and-operation-gifs)
- [Encrypted cloud sync](#encrypted-cloud-sync)
- [Local and legacy backups](#local-and-legacy-backups)
- [Access and security](#access-and-security)
- [Command line](#command-line)
- [Environment export](#environment-export)
- [Tool profiles](#tool-profiles)
- [Tools](#tools)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development and publishing](#development-and-publishing)
- [Further reading and license](#further-reading-and-license)

## What it does

- Stores logins, SSH password/private-key credentials, API keys, OAuth tokens, TOTP seeds, cards, cookies and custom fields locally, encrypted with **AES-256-GCM + scrypt**.
- Offers a bilingual, host-theme-aware workbench: search, favorites, tags, type-specific editors, masked previews, attachments, history, security reports and trash.
- Provides **Git, WebDAV, S3-compatible storage and Gist** encrypted entry-snapshot sync, with preview, explicit confirmation, three-way merge and per-channel automatic-sync controls.
- Imports browser/password-manager data and exports portable formats; distinguishes encrypted backups from plaintext migration files.
- Lets an assistant discover summaries before reading a narrowly selected field, and lets an authorized consumer fetch its own secret through the CLI.
- Registers only **11 core tools by default**, not the complete 113-tool catalog. Optional groups expose management, I/O, sessions and vault-file operations when needed.
- Keeps existing encrypted vaults and environment-based deployments usable; first-use GUI setup does not require placing a password in configuration.

**Different stores, different responsibilities:** DSH host credentials (provider tokens and sync credential slots) are **not** the same as 1pass entries. A token stored in DSH's own credentials service is not automatically an entry searchable with vault_search, and vice versa.

## Install and build

### Requirements

- **Node.js >= 20** and a compatible DeepSeek Harness installation for the plugin UI/model tools.
- npm or pnpm for source builds; **Git on PATH** for the Git sync channel.
- Optional **playwright-core** and an available supported browser for opening manual browser-login sessions. Ordinary CLI reads do not require a browser.
- The package's declared DSH peer services must be provided by the host/profile; a standalone CLI read does not start the DSH GUI.

### Build this repository

The commands below use the source version in this repository rather than assuming the registry is current:

~~~sh
git clone git@github.com:copypasteltd/dsh-1pass.git
cd dsh-1pass
npm install --ignore-scripts
npm run build
node lib/cli.js --help
~~~

The build script compiles host code and the browser bundle. Ignoring install scripts makes the subsequent build explicit. Equivalent project scripts are available through pnpm.

### Install into a DSH profile

After the build, run from the checkout root; replace web with your actual profile:

~~~sh
dsh plugin --profile web add .
~~~

If DSH itself is invoked through pnpm in your installation, use pnpm dsh in place of dsh. The bundle patch inserts the vault plugin row; do not add a duplicate row by hand.

A release package can also be installed by its real tarball path:

~~~sh
npm pack
dsh plugin --profile web add ./dsh-vault-1.12.2.tgz
~~~

This filename follows the current manifest; packing/building locally does not publish a release. A registry install such as dsh plugin --profile web add dsh-vault installs the **registry's version**, which may differ from this source tree.
Git-dependency installs run prepare to build; pnpm's build-approval policy may block that script. Prefer an explicit source build/tarball if you cannot review the requested build approval.

### Make the CLI available

| Installation | Invocation |
|---|---|
| Built source checkout | node lib/cli.js list or npm run vault -- list |
| Plugin installed as a profile dependency | dsh plugin --profile web exec dsh-vault list |
| Globally installed package | dsh-vault list |

A manually linked folder need not create the profile's executable shim. Use the source CLI or reinstall through the normal plugin dependency route rather than assuming a command exists.
The registry/global route is convenient, but check dsh-vault --version before relying on current-source features.

## First unlock and language

1. Enable the plugin and open **Settings → Password Manager (1pass)** (Chinese: **设置 → 密码管理(1pass)**).
2. If no vault exists, enter and confirm a nonempty master password. If it exists, enter its existing master password. A strength warning is advisory; choose a strong unique password anyway.
3. The first-use form sends it to the local DSH host and keeps runtime unlock material in memory, not browser storage, URLs, model arguments or a plaintext config row.
4. After a host restart, re-enter it unless you deliberately configured an environment-based unlock path. Use Lock and auto-lock for idle protection.
5. Change **DSH's interface language** to English or 简体中文 in the host's language/preferences settings, then return to 1pass. The plugin follows the host locale; there is no independent per-vault language selector. This README and its [GUI guide](<docs/gui-guide.md>) have matching Chinese counterparts.

**GUI unlocked does not imply standalone CLI unlocked.** A separate CLI process opens the file itself and needs its own master-password input. It does not read the GUI's memory or automatically inherit a host credential slot.

## /1pass workflow

The reusable skill source is [skills/1pass/SKILL.md](<skills/1pass/SKILL.md>).
Import/create it through your DSH installation's normal Skills interface, using the skill name **1pass** and that source. Merely cloning this repository or installing the plugin does **not** automatically install a local skill. If skill creation is denied by your permissions, ask the user to enable that path; do not bypass it by writing the host's skill directory.

Examples use synthetic titles and documentation-only hosts, not real accounts:

~~~text
/1pass demo-server
/1pass demo-server only host username port
/1pass use demo-api for authorized task
~~~

The workflow is deliberately ordered:

1. **Summary first:** search for demo-server; show the matching title, kind and non-secret identity/host summary, not the password.
2. **Disambiguate:** if several entries match, let the user choose an id/title and the intended target. Do not guess across vaults or similarly named servers.
3. **Minimal fields, just in time:** a metadata request needs only host/username/port. Read an API key, password, private key or current TOTP only when the authorized consumer actually needs it.
4. **Safe handoff:** prefer having that consumer call dsh-vault get itself, or a direct approved paste; do not echo the secret in the answer, logs, URLs or command arguments.
5. **Verify the operation:** say “credential located” when that is all that happened. Say “SSH connected” only after the SSH/remote tool actually reports success. A vault read neither opens a connection nor verifies credentials.

Example model-tool sequence (illustrative arguments, not an automatic connection):

~~~json
{"query":"demo-server","kind":"ssh"}
{"id":"<chosen-entry-id>","fields":["host","username","port"]}
~~~

For an installed CLI, dsh-vault get demo-server --field host reads exactly that field. Secret fields belong inside the authorized consuming process. --mask is only a partial preview: it can retain prefixes and leave custom/metadata values readable; it is not a secret-free existence test. If the safe chosen-id read is denied or unavailable, stop rather than falling back to vault_fill or a broad export.
A skill supplies guidance, not a new authorization boundary, network tool or bypass for locked/readonly vaults.

## Credential model

An entry has a title, id, kind and any relevant fields. Titles need not be unique; use the id when ambiguous.

| Type / field group | Stored data and intended use |
|---|---|
| login | username, email, phone, password, url |
| ssh / password | host, optional ip, port, username, sshAuth=password, password |
| ssh / certificate or private key | host, ip, port, username, sshAuth=certificate, privateKey, optional certificate and keyPassphrase |
| api-key / secret | apiKey or secret, optional owner/url/notes |
| oauth | accessToken, refreshToken, expiresAt (epoch milliseconds), client metadata in fields |
| TOTP | otpSecret as Base32 or a single-account otpauth://totp/ setup URI; it may coexist with another type |
| card | cardNumber, cardExpiry, cardCvv, cardHolder; summary omits number/CVV |
| cookie | Browser-session cookies; treat cookie values as account credentials |
| custom | Arbitrary fields, including preserved nested values; do not place secrets in titles/tags |
| Organization | tags, favorite, icon, color, notes, sensitivity and rotationDays |
| Script naming | envKeys (positional exact names), or legacy envKey shorthand; env tag opts into batch env export |
| History and files | Previous passwords and attachments remain encrypted entry content |

SSH “certificate” means an optional **OpenSSH user certificate**, not a website TLS certificate. Private-key shape checking is not proof of server login. Host and IP are separate fields; port must be 1–65535.
TOTP expects a **setup seed**, not today's six-digit code. Current supported setup URIs use SHA-1; QR images, otpauth-migration:// multi-account exports and unsupported algorithms are not silently accepted.
Templates save field structure/hints, **not actual passwords, private keys, card values or custom-field contents**.

## GUI pages and operation GIFs

Start with the complete [English GUI operation guide](<docs/gui-guide.md>); every page, workflow, language step and safety boundary is covered there.
Four main destinations are **Home, Passwords, Cloud sync, Settings**. Width-dependent **More**, Home quick actions and the command palette expose the remaining tasks.

| Page / task | What to do there |
|---|---|
| Home | Inspect vault/count/health/backup status; open quick actions and recent activity |
| Passwords | Search, combine type/tag/favorite/due/risk filters, sort, expand rows and use row actions |
| Credential editor | Choose a template, edit type-specific fields, reveal deliberately, attach files, set TOTP/metadata |
| Quick import | Parse local pasted lines, inspect masked results, select valid nonduplicates, then confirm |
| Security | Inspect weak/reused passwords, missing 2FA, HTTP URLs, expiry, duplicates and breach checks |
| Import / export | Preview supported formats, choose overwrite deliberately, and distinguish plaintext exports |
| Cloud sync | Configure four transports, encryption passwords, preview/confirm, merge, history and autosync |
| Local backups | Create/list/restore/delete encrypted local copies; legacy cloud backup is migration-only |
| Settings | Manage named vaults, access mode, auto-capture, auto-lock, tool profile and recovery-code status |
| Tags | Use Passwords tag manager or Settings summaries to rename/remove tags across entries |
| Sessions | Open manual-login windows, collect/save cookies, inspect/export/import/prune, then close windows |
| Activity / history | Filter read/search/write activity and inspect recent events; not a durable forensic ledger |
| Trash | Restore one/all entries, or explicitly confirm permanent removal |
| About | Inspect package/version, local-storage explanation and attribution |
| Command palette | Search pages/actions; navigate without hunting through overflow controls |

The six paired GIFs below are **synthetic-fixture demonstrations of the UI**, not recordings of a real vault, live GitHub authorization, or end-to-end cloud success. The same fixture can render a successful-looking preview without contacting a provider. GIFs and guides are available in the GitHub repository/source checkout; do not assume the npm package bundles the media.

### 1. Overview, navigation and language

![Synthetic English demo: home, navigation and language](<docs/media/overview-en.gif>)

### 2. Credentials, templates and quick import

![Synthetic English demo: credentials and masked quick import](<docs/media/credentials-en.gif>)

### 3. Import and export

![Synthetic English demo: transfer previews and export warnings](<docs/media/transfer-en.gif>)

### 4. Cloud sync

![Synthetic English demo: transport setup, preview and merge](<docs/media/cloud-sync-en.gif>)

### 5. Security, activity, local backup and trash

![Synthetic English demo: security checks and history tasks](<docs/media/security-history-en.gif>)

### 6. Settings and sessions

![Synthetic English demo: policies, tools and session management](<docs/media/settings-sessions-en.gif>)

Keyboard: **Ctrl/Cmd+K** opens the command palette; **Ctrl/Cmd+N** creates an entry when not typing and when writable/unlocked. Palette arrows/Enter choose a command; Escape closes the active plugin overlay. Main tabs support arrow/Home/End focus navigation. See the guide for scope and text-editor exceptions.

## Encrypted cloud sync

**Current Cloud sync is not the old raw-file uploader.** It serializes a custom full **entry snapshot**, then encrypts it with a **separate sync password**. It includes active entries, trash, password history, cookies and attachments; it does **not** copy the original vault document byte-for-byte or upload unrelated DSH settings/plugins/MCP/session configuration.
A second device needs the same sync decryption password but can use a different local vault master password.

Snapshot format is 1pass-cloud-snapshot-v1. **Metadata is plaintext:** snapshot id/time/content hash, channel, vault/device labels, platform/version labels and section information remain visible; encrypted payload uses AES-256-GCM + scrypt. Use non-sensitive vault/device names. The local merge baseline/ancestor is also stored encrypted.
Transport authentication and sync passwords are saved in **DSH host credential slots**, not sent back as editable plaintext configuration and not automatically created as 1pass entries.

### Configure a channel

1. Open Cloud sync and choose Git, WebDAV, S3 or Gist.
2. Save non-secret destination settings and supply credentials in the masked configuration dialog. Set the channel's encryption/decryption password; do not paste it into chat.
3. Probe/refresh to establish the actual target state. A read probe is not proof of write permission.
4. Select the vault section; encryption is mandatory. Preview the first push or pull and explicitly confirm it.
5. Only after a reviewed manual round trip should you consider enabling automatic sync.

| Channel | Configuration and boundaries |
|---|---|
| Git | Actual clone/fetch/ff-only/commit/non-force push. HTTPS token or existing SSH key/agent; default branch is **auto-detected from remote HEAD**, unless explicitly set. Default subdirectory **1pass**. No force push or automatic destructive reset. |
| WebDAV | HTTPS URL, username, password, prefix (default 1pass). Strong ETag conditional index writes; missing/weak ETag means a documented non-atomic window. |
| S3 compatible | Provider, endpoint, region, bucket, prefix, access-key id and secret, addressing/dialect settings. AWS-style conditional writes depend on server support. OSS index updates use a pre-write HEAD check, **not atomic CAS**. |
| Gist | Gist id and token, default file prefix 1pass. Read/merge/write/verify helps but **cannot prevent overwriting an unseen concurrent write**. Prefer private/secret destinations; metadata/history still exist. |

### Preview, confirm and merge

Push previews bind the local memory/disk revision, destination/selection and the **whole remote index version**. A local edit, target change or newly observed remote write makes a stale confirmation fail; refresh and preview again rather than forcing it.
Pull/one-click sync downloads, validates and decrypts on the host, compares entry ids with the encrypted common ancestor, then shows masked change/conflict summaries.
Choose keep-local/use-remote or the offered safe merged result. Passwords, private keys and arrays are not guessed by text concatenation. Unconfirmed items remain local and do not advance the baseline. Remote deletion proposals require human review.
A safety backup precedes local application; remote history and local rollback are separate controls. Inspect remote snapshots/history before choosing an older snapshot or deleting one.

### Automatic sync and honest limits

- Off by default, independently configured per channel: interval, debounced local writes, remote checks, startup cadence, conflict policy and auto-apply tier.
- Startup/remote polling are pull-only, not a fresh permission to upload. The initial missing-baseline sync needs manual confirmation.
- Low-risk tier does not automatically apply vault changes. “Local wins” is an explicit conflict-policy choice, not conflict detection being disabled.
- Lock, readonly, vault/target changes and disposal invalidate in-flight authority/previews. An ambiguous timeout needs inspection before retry.
- Git push rejection and WebDAV/AWS-style conditional requests protect races when supported. Gist, OSS and no-ETag endpoints retain stated post-read races; this is **not a distributed lock**.
- Default snapshot retention keeps recent snapshots (10); pruning failure is reported separately. **Deleting Git/Gist files does not erase historical ciphertext**, and object-store versions may retain it too.

Technical details: [transport contracts](<docs/cloud-sync-transports.md>), [sync implementation notes](<docs/cloud-sync.md>) and [UI adoption](<docs/cloud-sync-ui-adoption.md>). Implementation notes include historical verification reports; they are not fresh live-account results for your installation.

## Local and legacy backups

Open **Local backups** from Home or the command palette. Create an encrypted copy, inspect its timestamp/owning vault, then choose restore **merge** (default, copy entries in) or **replace** (whole-vault overwrite, safety copy first). Overwrite/merge choices are not interchangeable; review duplicates and the active vault before confirming.
Local backups are copies of the encrypted local vault file and need its corresponding master password. They are distinct from separately password-encrypted cloud entry snapshots.
The **Legacy cloud backup (migration only)** foldout retains the older one-way GitHub Contents/S3/OSS/R2 uploader. It is not two-way sync, does not establish the new merge baseline and does not automatically authorize a new channel destination.
See the [legacy cloud-backup guide](<docs/cloud-backup.md>) only for that migration path.

## Access and security

### Access is not the tool profile

| Access mode | Meaning |
|---|---|
| ask (default) | Ordinary model reads are free; add/update/delete and other guarded writes ask through DSH's approval channel. It does **not** ask before every password read. |
| readonly | Read/search/code generation remain available; guarded vault mutations are rejected in tools/UI. It is **not** a “metadata only” mode or an OS sandbox. |
| auto | Ordinary reads/writes need no per-call write confirmation. Enable only for a trusted workflow. |

Id-scoped sensitive reads such as get/clipboard/TOTP/password-history/attachment of a **high-sensitivity** entry are confirmation-gated in ask and auto. This is not a universal gate around every possible bulk/export/CLI read path; prefer minimal fields and a restricted tool profile.
GUI buttons are direct user operations with their own confirmation/readonly rules, not necessarily model-tool approval prompts. A CLI with file/key access is a separate process and is not governed by the model's tool allow-list.
Auto-capture defaults off. Enabling it instructs the assistant to offer to save deliberately shared credentials; it is not permission to harvest unrelated secrets or save without the user's preference/consent.

### Cryptography and privacy

- Node's built-in crypto implements scrypt and authenticated AES-256-GCM. Random nonces and a verification envelope detect wrong passwords/tampering; serialized/atomic writes and file locking protect normal concurrent writes.
- Encrypted-at-rest does not mean metadata/configuration is all encrypted. Vault filenames, access/profile files, recovery-code hash and cloud snapshot metadata can be visible. Keep titles/tags/notes/custom metadata non-secret when they may be searched or displayed.
- Model summary projections omit standard password/key/token/TOTP fields and custom-field values; the GUI still supports custom data. A user can mistakenly put a secret into a title, URL or other metadata, so even summaries can be sensitive. Do not quote them unnecessarily.
- Password strength and Watchtower-style risk badges are heuristics, not guarantees. The three-star row indicator scores passwords/PINs, not machine-generated API keys or private keys.
- Online breach checking sends the **first five SHA-1 hex characters** to api.pwnedpasswords.com with Add-Padding; matching is local. The full hash/password/entry is not sent, but the service sees your IP and prefix. Padding hides response-size signals, not that disclosure. Choose offline checking to avoid the request; the common-password list is much smaller.
- Copies, downloads, session exports and consumer process memory are plaintext exposure points. A clipboard feature does not make clipboard-history software safe.

### Limits and recovery

This plugin runs in the DSH process. It does not isolate secrets from other trusted plugins, tools running as your OS user, compromised hosts, screenshots, log capture or a model that already received a secret. Use least privilege, trusted plugins, OS permissions, separate accounts/devices and prompt discipline.
The issued “recovery code” stores only a hash and verifies **possession**; it **cannot derive the encryption key, decrypt a lost-password vault, or reset the master password**. Keep your master password and tested encrypted backups independently safe.
OS keychain/helper-command custody is discussed in the [master-key custody design draft](<docs/master-key-custody.md>); it is **not an implemented automatic-unlock feature** in the current CLI.

## Command line

### Read only what the consumer needs

Examples below assume the dsh-vault executable is installed. In a checkout, substitute node lib/cli.js.

~~~sh
dsh-vault --version
dsh-vault list --json
dsh-vault show demo-server
dsh-vault get demo-server --field host
dsh-vault get demo-server --field username
dsh-vault get demo-server --field port
dsh-vault get demo-api --mask
dsh-vault totp demo-api --json
dsh-vault verify
~~~

| Command | Output / caution |
|---|---|
| list, show | Projected identity/metadata and presence indicators; standard secret fields and notes/custom fields are omitted, but user-entered metadata can still be sensitive |
| get <id/title/env-name> | Primary secret by default; --field selects one field, including fields.name; ambiguous names fail |
| get ... --json | Wraps that selected value; **does not redact** it |
| get ... --all | Full entry JSON with secrets; avoid for routine automation |
| totp <entry> | Current code only; --json adds digits, period and remaining seconds; itself sensitive |
| verify | Checks master password; status on stderr and no credential output on stdout |
| env | Only env-tagged entries; --keys-only / --mask / --explain help inspect selection |
| export-env <path> | Writes plaintext env output (mode 0600 where supported), not an encrypted backup |

Success data goes to stdout and diagnostics to stderr. Exit codes: 0 success, 1 runtime/lookup/decryption failure, 2 invalid usage.
Do not enable shell tracing, print command substitutions, or capture a secret command's stdout into a published transcript. A consumer should fetch and use the value without logging it or placing it into process arguments/URLs.
--mask is a masked preview, not guaranteed zero disclosure: some values retain a prefix and custom/metadata fields can remain readable. --all prints the full entry even alongside --mask. For bulk name-only checks use env --keys-only.

### Standalone master-password inputs

The CLI resolves **--password-stdin → DSH_VAULT_MASTER_PASSWORD → DSH_VAULT_PASSWORD → interactive hidden prompt**. Without a TTY and without an explicit source it fails. It does not read plugin configuration, use the GUI's runtime key or automatically query OS keychain custody.
Use an authorized secret provider/input mechanism, never a literal master password in shell history, a screenshot, chat or committed script. Environment values can be inherited by child processes and seen by same-user tooling; stdin is not a claim of process isolation.
--vault selects a named vault; --path selects a specific vault document. DSH_HOME determines the default home, then vault/default.json. Selecting another file does not authorize reading another user's vault.

## Environment export

**One value:** get demo-api needs no env tag. **Batch shell environment:** env intentionally includes only entries tagged env, keeping unrelated cards, notes and logins out of the shell.
Set envKeys in the editor when the consumer needs an exact name, such as DEMO_API_KEY; envKey is the older one-name shorthand. Names are positional to exported fields, valid identifiers, at most eight, and unique. Unspecified names are derived from the title and standard field suffixes (API_KEY, ACCESS_TOKEN, REFRESH_TOKEN, PRIVATE_KEY, PASSWORD).
Do not confuse the name shown by list with an exported value: list distinguishes tagged/exported and untagged/not-exported entries.

~~~sh
dsh-vault env --keys-only
dsh-vault env --mask
dsh-vault env --explain
dsh-vault env --file ./demo.env
dsh-vault export-env ./demo.env
~~~

The last two commands write **plaintext**; exclude the file from version control, restrict permissions and remove it after use. File output can overwrite its target; choose an intentional destination. Do not source an untrusted imported env file blindly.
For a reviewed POSIX shell export, preserve the CLI's quoting:

~~~sh
# First inspect the key names and intended entries, without values.
dsh-vault env --keys-only
# Run only in the authorized shell; never log the expanded output.
set -a
eval "$(dsh-vault env)"
set +a
~~~

Do **not** use export $(dsh-vault env): word splitting corrupts spaces/quotes. This is POSIX-shell syntax, not PowerShell syntax. Prefer a consumer reading a single field when it avoids broad environment exposure.

## Tool profiles

Change **Settings → Model tools** in 1pass. Profile registration updates at runtime and is persisted in the vault directory's tools.json; the catalog is process-wide, **not a separate model catalog per named vault**.

| Profile | Registered tools |
|---|---|
| Basic (default) | Core: **11** |
| Standard | Core + management: **64** |
| Full | All five groups: **113** |
| Custom | Core **11**, plus selected management **53**, import/export **27**, sessions **8**, files **14** |

Tool availability is not authorization. ask/readonly/auto, locking, explicit target permission and destructive-action confirmations still apply. GUI-only quick import/cloud-sync controllers do not expose their entire batch payload as model tools.

## Tools

All **113** tools registered by the current source are discoverable below, even when the active profile exposes only a subset. Group membership follows CORE_TOOLS / IO_TOOLS / SESSION_TOOLS / FILE_TOOLS; everything else is management. Import/export/session results may contain plaintext secrets; check fields and destination before use.

### Core / Basic — 11

| Tool | Purpose |
|---|---|
| `vault_list` | List available vaults in the vault directory (one .json file per vault, excluding access/meta/export files) |
| `vault_search` | Search identity/metadata, tags and custom values; optional kind/time/favorite filters. Returns summaries, not password/key/token values. |
| `vault_get` | Read an entry by id; request only needed fields, or redact. Full reads can return every stored secret. |
| `vault_add` | Add an entry (any combination of fields; empty strings/arrays are ignored) |
| `vault_update` | Update fields by id (unprovided fields kept; empty string clears a field; `title` is renamable; `rotationDays: 0` clears rotation = never rotate) |
| `vault_delete` | Soft-delete an entry (moves it to the trash, still encrypted on disk) |
| `vault_fill` | Match a target and directly return requested credentials, potentially secrets. It does not provide the same chosen-id sensitive-read gate; never use it to bypass an approval or as the /1pass fallback. |
| `vault_clipboard` | Return one field for direct clipboard handoff; it does not by itself guarantee a safe system paste or clipboard erasure. |
| `vault_totp` | Generate a TOTP from a stored or supplied Base32/setup URI; code lifetime and URI settings matter. |
| `vault_generate_password` | Generate a strong random password (length/classes/grouping) **or a memorable passphrase** (`passphrase: true`, EFF-style word list, `words`/`separator`/`wordDigits`) |
| `vault_strength` | Zero-dependency password strength estimate (score 0–100, weak/fair/strong/very strong) |

### Management / Standard and Full — 53

| Tool | Purpose |
|---|---|
| `vault_compare` | Compare two entries field by field (`onlyA`/`onlyB`/`differ`/`equal`) — field names only, never secret values |
| `vault_rename` | Rename an entry in one call (shortcut for `vault_update`) |
| `vault_restore` | Restore one soft-deleted entry from trash. |
| `vault_purge` | Permanently remove one trashed entry from the current vault; independent backups/history may retain copies. |
| `vault_restore_recent` | Undo the most recent soft deletion. |
| `vault_lock` | Lock the active vault and clear its in-memory decryption key. |
| `vault_unlock` | Reopen the vault using host-configured unlock material; never ask the model to receive the master password. |
| `vault_password_history` | List an entry's previous passwords (1Password/Bitwarden-style, newest first, capped at 10; current password excluded) |
| `vault_password_rollback` | Restore an entry password to a stored history entry (current password is archived first, so it is reversible) |
| `vault_apply_tags` | Bulk add/remove/replace tags on every entry matching a query (dry-run supported, no secrets) |
| `vault_totp_uri` | Build an otpauth:// provisioning URI for a stored or bare TOTP secret |
| `vault_rotation` | Report expired / due-for-rotation / expiring-soon credentials; `soonWindowDays` (1-90, default 7) tunes the soon horizon (no secrets) |
| `vault_health` | Vault health scan: weak/reused passwords, missing 2FA, insecure http:// sites, and an overall security score (0–100) |
| `vault_watchtower` | Watchtower-style per-entry risk analysis (1Password/Bitwarden-inspired): flags short/weak passwords, keyboard sequences, embedded years, common passwords, reuse, http:// sites, missing 2FA, expiry — with a 0–100 score and good/warn/poor verdict (no secrets); entry rows show ⚠ badges |
| `vault_breach_check` | Watchtower-style breach scan against Have I Been Pwned (k-anonymity: only the SHA-1 prefix leaves the machine), with an offline common-password fallback |
| `vault_integrity` | Verify the on-disk vault file decrypts correctly and matches the in-memory store |
| `vault_merge` | Merge one entry into another; `keepSource: true` keeps the source after merging |
| `vault_attach` | Attach a file as encrypted entry content. |
| `vault_attachments` | List attachment names and sizes, not contents. |
| `vault_attachment` | Read one attachment; its content can be sensitive. |
| `vault_detach` | Remove an attachment from an entry. |
| `vault_quick_add` | Fast capture (title + one secret) with optional tags/notes |
| `vault_expiry` | Set/clear expiry (`expiresAt: 0` removes it) |
| `vault_stats` | Overview counts incl. `trashCount` (no secrets) |
| `vault_verify` | Verify one entry or audit every entry (`all: true`) for per-kind completeness, port/expiry sanity (no secrets) |
| `vault_duplicates` | Find duplicate groups: `mode` = `both` (default) / `title` / `content` (no secrets) |
| `vault_report` | Printable inventory with expiry/rotation columns and a stats footer (no secrets) |
| `vault_match_url` | Find login entries matching a URL (Bitwarden/1Password-style: exact host, subdomain, parent domain, path-prefix; www./port normalization) with a 0–100 score — never returns the password |
| `vault_env` | Render env-tagged entries as shell-quoted KEY=VALUE lines; plaintext unless mask is requested. |
| `vault_copy` | Copy an entry (secrets included) into another named vault |
| `vault_templates` | Built-in + user-defined templates (save/list/remove), KeePassXC-style; built-ins now include Wi-Fi, Server, Database, Identity, Bank account, Card (1Password-inspired) |
| `vault_notes` | Append to or replace the free-form notes of an entry (a convenient shortcut for vault_update) |
| `vault_changes` | List vault activity within a time window (default 24h): entries created, updated, or soft-deleted, newest first |
| `vault_find` | Fuzzy-find entries: matching ignores case, punctuation and whitespace, so `gh` reaches `GitHub` |
| `vault_mask` | Heuristically redact likely secrets in text; not a proof that all sensitive information was found. |
| `vault_history` | Show recent activity on the vault within this process, newest first: mutations (add/update/delete/restore/purge/merge/rollback) plus reads (read, totp), searches and vault switches. Records only the action, entry title and timestamp — never passwords, keys, usernames or other secret values |
| `vault_recent` | List the most recently created or updated entries (newest first), as secret-free summaries |
| `vault_pin` | Pin (favorite) an entry so it ranks first in search and list |
| `vault_unpin` | Unpin an entry (remove its favorite flag) |
| `vault_tags` | List every tag used across entries with the number of entries per tag |
| `vault_generate_username` | Generate a random username or an anonymous email suggestion |
| `vault_rotate_password` | Generate a new strong password, store it on the entry, and return the new value for the caller to hand to the target service |
| `vault_touch` | Mark an entry as recently used (update its updatedAt without changing content) |
| `vault_note_secret` | Store a single secret under a generated title (a one-off note without naming it) |
| `vault_search_advanced` | Search with multiple optional criteria: title substring, username/email substring, kind, tag, created-after/before (epoch millis), and favorite-only |
| `vault_count` | Return the number of active entries (optionally filtered by kind and/or tag) |
| `vault_set_icon` | Set the UI icon (emoji) and/or accent color on an entry |
| `vault_describe` | Describe an entry in plain language (kind, identity, host/url, tags, expiry) without revealing secrets |
| `vault_last_modified` | List entries most recently modified (updatedAt), newest first |
| `vault_has` | Quickly check whether the vault contains a credential matching a title/username/host (substring, or exact title when exact is set) |
| `vault_autofill_check` | Check whether the vault has a credential usable for a URL/host: returns the best matching entry (username/email only, never the secret) or a not-found verdict |
| `vault_undelete_all` | Restore ALL soft-deleted (trashed) entries back to the active set |
| `vault_get_many` | Read multiple entries by id, returning only the requested fields for each |

### Import and export / Full or Custom — 27

| Tool | Purpose |
|---|---|
| `vault_import_csv` | Bulk-import credentials from a CSV file (custom columns become fields; `overwrite: true` merges fields into existing entries instead of duplicating) |
| `vault_bulk_delete` | Soft-delete entries matching a query/kind/tag or explicit ids; `confirm: true` required (dry-run by default); trashed entries are restorable |
| `vault_export` | Portable encrypted backup/migration of the whole vault (separate export password) |
| `vault_import` | Portable encrypted backup/migration of the whole vault (separate export password) |
| `vault_export_bitwarden` | Bitwarden/Vaultwarden JSON interop (full field mapping, overwrite support) |
| `vault_import_bitwarden` | Bitwarden/Vaultwarden JSON interop (full field mapping, overwrite support) |
| `vault_import_bitwarden_encrypted` | Decrypt a Bitwarden password-protected JSON export (PBKDF2/Argon2id + HKDF → AES-256-CBC + HMAC) and import it; pass the export passphrase |
| `vault_import_manager_csv` | Password-manager CSV auto-detected by header: Bitwarden (`login_uri`/`login_username`/…), 1Password 8, Dashlane, NordPass, Keeper, LastPass (`fav`/`grouping`/`extra`); dryRun preview |
| `vault_import_kdbx` | KeePass KDBX: 3.1 and 4.x, AES-KDF or Argon2 (RFC 9106), AES-256-CBC or ChaCha20 payload, keyfile support |
| `vault_export_1password` | Export entries as a 1Password 1PUX archive (ZIP + export.data) for import into 1Password or re-import here; item categories map to login / credit card / API credential / server |
| `vault_import_1password` | 1Password 1PUX (ZIP) and legacy 1PIF text exports |
| `vault_import_1pif` | 1Password 1PUX (ZIP) and legacy 1PIF text exports |
| `vault_import_enpass` | Enpass JSON export (folders → tags, typed fields, TOTP) |
| `vault_import_keepass_xml` | KeePass 2.x XML export (plaintext or `********` masked values) |
| `vault_import_chrome` | Import passwords from Chrome's Login Data (macOS keychain / Linux keyring or `peanuts` / Windows DPAPI) or the macOS Keychain (internet passwords `inet` by default — the ones that actually back website logins — or generic `genp` via `classes`; session cache + preview, no prompt spam); every file import supports `dryRun` preview |
| `vault_import_keychain` | Import passwords from Chrome's Login Data (macOS keychain / Linux keyring or `peanuts` / Windows DPAPI) or the macOS Keychain (internet passwords `inet` by default — the ones that actually back website logins — or generic `genp` via `classes`; session cache + preview, no prompt spam); every file import supports `dryRun` preview |
| `vault_import_firefox` | Firefox profile import (logins.json + key4.db, NSS 3DES / PBES2-AES, primary-password aware) |
| `vault_export_totp` | List every entry that has a TOTP secret, with its title and issuer label |
| `vault_bulk_export` | Export ALL entries (including secrets) as a JSON file for audit or migration |
| `vault_export_browser` | Export login entries in the browser password-manager CSV format (name,url,username,password) for importing into Chrome/Firefox/Edge |
| `vault_migrate_keepass` | Export entries in KeePass 2.x import CSV format (Group,Title,Username,Password,URL,Notes) for migrating into KeePass |
| `vault_export_keepass_xml` | Export entries as a KeePassXC-compatible XML document (KeePass 2.x schema) |
| `vault_import_browser` | Import a browser password-manager CSV (name,url,username,password — Chrome/Firefox/ Edge export format) |
| `vault_export_wallet` | Export entries as a directory tree of files compatible with pass (the standard Unix password manager): one file per entry containing the password, with metadata in comments |
| `vault_import_wallet` | Import entries from a pass directory tree: each .gpg file (or plaintext file) becomes an entry titled by its filename; the first line is the password, remaining lines are parsed as login:/email:/url: metadata. Returns added/skipped |
| `vault_export_env` | Write env-flagged entries (tags contain "env") to a .env file at the given path as KEY=VALUE lines (values shell-quoted) |
| `vault_export_csv` | Export vault entries to a CSV file (the same shape vault_import_csv accepts), optionally filtered by kind |

### Browser sessions / Full or Custom — 8

| Tool | Purpose |
|---|---|
| `vault_session_open` | Open a real headed browser window at a URL so the user can log in manually (password, 2FA, captcha) — the portable way to capture login state for sites that block embedding — requires the optional `playwright-core` |
| `vault_session_collect` | Collect cookies from a plugin-opened login window and save a cookie entry; user login happens first. |
| `vault_session_import` | Save session cookies from pasted JSON (devtools export shape) or a raw `Cookie` header string — the no-browser alternative |
| `vault_session_import_file` | Import a Netscape cookie-jar file (curl `-b` / wget / browser-extension export; the same format `vault_session_export` writes) |
| `vault_session_list` | List saved login sessions with cookie counts, expired and expiring-in-7d counts (no values) |
| `vault_session_export` | Export a saved session as a `Cookie` header value, a Netscape cookie-jar file (curl `-b`), raw JSON (Playwright `addCookies` shape), or a ready-to-run Playwright snippet |
| `vault_session_close` | Close an open browser login session (collected cookies stay in the vault) |
| `vault_session_prune` | Remove expired cookies from a saved session (session cookies are kept); `preview: true` reports without writing |

### Backups and vault files / Full or Custom — 14

| Tool | Purpose |
|---|---|
| `vault_recovery_code` | Issue a code once and persist only its SHA-256 hash; regeneration invalidates the old code. This is NOT a decryption key or master-password reset. |
| `vault_verify_recovery` | Check code possession against the saved hash; does not decrypt or unlock the vault. |
| `vault_recovery_status` | Report whether a recovery code is set and its issue time; never the code. |
| `vault_rekey` | Upgrade the vault to fresh scrypt KDF parameters in place |
| `vault_switch` | Switch the active vault for this session |
| `vault_backup` | Create an encrypted local vault-file backup with bounded retention (default 10). |
| `vault_backup_now` | Create an encrypted local backup immediately. |
| `vault_restore_backup` | Restore from a backup: `mode: "merge"` (default) copies the backup entries INTO the current vault so they appear in the entries list; `mode: "replace"` overwrites the whole vault with a safety snapshot first |
| `vault_vault_rename` | Rename a named vault; the active vault follows the move. |
| `vault_vault_delete` | Permanently delete a named vault file; default vault is protected. |
| `vault_search_system` | Search Chrome / Keychain for sites & usernames — never exposes passwords |
| `vault_backup_status` | Report how many days have passed since the last backup file was written (1Password-style backup reminder; new-style `<vault>-backups-<date>.json` and legacy `vault-backup-<epoch>.json` names are both recognized). Returns daysSinceBackup and a suggestion |
| `vault_search_history` | Search including soft-deleted (trashed) entries, marked with their deleted state |
| `vault_backups` | List encrypted backup paths/timestamps, recognizing current and legacy names. |

## Configuration

For a normal GUI setup, use the first-use password form. For deliberate environment-based deployments, keep **only the variable name**, never its value, in the profile:

~~~yaml
- id: vault
  name: dsh-vault
  config:
    masterPasswordEnv: DSH_VAULT_PASSWORD
    accessMode: ask
    autoCapture: false
    tools: basic
    lockTimeoutSeconds: 300
~~~

The installed bundle already supplies a vault row; this is its configuration shape, not a request to add another duplicate row.

| Option | Meaning |
|---|---|
| masterPasswordEnv | Host environment variable naming the unlock material; must be available to that host process |
| masterPassword | Inline secret supported for compatibility, **not recommended**; plaintext configs leak through source control/backups/screenshots |
| path / name | Explicit vault path or name; default DSH_HOME/vault/default.json |
| accessMode | readonly / ask (default) / auto; persisted GUI policy overrides fallback config |
| autoCapture | false by default; offer credential capture only with user consent |
| lockTimeoutSeconds | Idle-lock timeout; 0/absent disables; GUI policy can override |
| tools | basic / standard / full / custom; persisted profile choice wins |
| exportPasswordEnv | Environment-variable reference for separate portable export/import password |
| backupRetention | Encrypted local backup count, default 10 |

Protect configuration and vault directories with appropriate POSIX permissions or Windows ACLs. An environment reference reduces accidental source-file exposure; it does not hide the secret from the host process or same-user tooling.

## Troubleshooting

| Symptom | Check next |
|---|---|
| Settings section absent | Plugin enabled in the profile actually serving this DSH; host and client artifacts built/loaded; no duplicate plugin row |
| Locked after restart | Re-enter the master password in the local form or configure the intended host environment; do not ask an assistant to receive it |
| CLI command not found | Use source invocation or a normal installed profile/global executable; a linked checkout may lack a shim |
| CLI cannot unlock though GUI can | Separate process: check its vault path and authorized password input, not the GUI status |
| No env values | Only env-tagged entries are exported; inspect list and env --keys-only |
| A tool is missing | Basic registers 11; switch to Standard, Full or a narrow Custom group deliberately |
| Import cannot confirm | Vault unlocked/writable, preview fresh and selection valid; locked/stale/changed-input previews must be regenerated |
| Git read works, push fails | Read probe is not write permission; inspect token/SSH scope, selected repository/branch and local ahead/diverged facts; no force push |
| Sync says local/remote changed | Refresh state, inspect conflicts and generate a new preview; do not reuse old approval |
| Colors/text look wrong after update | Refresh the existing DSH page after installing rebuilt artifacts; starting an unrelated server does not update it |
| Recovery code verified but vault still locked | Expected: code-possession proof is not decryption or a password reset |

## Development and publishing

Project scripts are declared in [package.json](<package.json>); no fixed test-count claim is made here.

~~~sh
npm run typecheck
npm test -- tests/readme-tools.spec.ts
npm test
npm run build
npm run scan:secrets
npm pack
~~~

The focused README test checks exact coverage, five-group membership and heading counts against the registered source tools. Broader tests/builds belong to the release owner; running a synthetic fixture does not verify your real cloud account.
Inspect the tarball contents before distribution, retain license notices, never commit real vaults/env files/recorded credentials, and publish/push only with the owner's authorization. Local source version, npm publication and GitHub Releases are three distinct states.
Browser-session support is optional; importing a password-manager file does not prove every source format/platform combination works on your machine. Keep the original export safely until a test restore is verified.

## Further reading and license

- [English GUI guide](<docs/gui-guide.md>) · [简体中文 GUI 指南](<docs/gui-guide-zh.md>)
- [/1pass skill source](<skills/1pass/SKILL.md>)
- [Editor, TOTP and quick-import implementation notes](<docs/credential-editor-quick-import.md>) (Chinese)
- [Current cloud-sync notes](<docs/cloud-sync.md>) (Chinese) · [Transport contracts](<docs/cloud-sync-transports.md>) (English)
- [Legacy one-way cloud backups](<docs/cloud-backup.md>) · [GUI integration/reference notes](<docs/gui-reference.md>)
- [Master-key custody design draft—not an implemented feature](<docs/master-key-custody.md>) (Chinese)
- [MIT license](<LICENSE>) · [Third-party notices](<NOTICE>)

The workbench and sync UI include attributed MIT-derived dsh-config-manager components. This does not imply affiliation with that project, DSH, or 1Password.

[English](<README.md>) | [简体中文](<README-zh.md>) · [Back to contents](#contents)
