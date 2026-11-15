# Password Manager (1pass) · GUI operation guide

[English](<gui-guide.md>) | [简体中文](<gui-guide-zh.md>) · [Project README](<../README.md>)

This guide describes the **current 1.12.2 source workbench**, not an assertion that this version has a GitHub Release, registry publication, or successful live-cloud test.
Open **DSH Settings → Password Manager (1pass)**. The Chinese section is **设置 → 密码管理(1pass)**.
The package/plugin is called **dsh-vault**; “1pass” is this project's workbench and skill name, not the commercial 1Password product.

> All animations use synthetic fixture data. No real vault, real GitHub OAuth approval, real repository push, or live cloud round trip is established by these GIFs. They demonstrate controls and states, not account connectivity. Media is available in the GitHub repository/source checkout; do not assume the npm package includes it.

## Contents

1. [Language, layout and navigation](#language-layout-and-navigation)
2. [Create, unlock and lock](#create-unlock-and-lock)
3. [Home](#home)
4. [Passwords: search, filters and row actions](#passwords-search-filters-and-row-actions)
5. [Credential editor and templates](#credential-editor-and-templates)
6. [Quick import](#quick-import)
7. [Security and breach-check privacy](#security-and-breach-check-privacy)
8. [Import / export](#import--export)
9. [Cloud sync: setup, preview and merge](#cloud-sync-setup-preview-and-merge)
10. [Local backups and legacy cloud backup](#local-backups-and-legacy-cloud-backup)
11. [Settings, vaults, permissions and recovery](#settings-vaults-permissions-and-recovery)
12. [Tags](#tags)
13. [Sessions](#sessions)
14. [Activity, history and trash](#activity-history-and-trash)
15. [About, command palette and keys](#about-command-palette-and-keys)
16. [Safe assistant / CLI handoff](#safe-assistant--cli-handoff)
17. [Troubleshooting and completion checklist](#troubleshooting-and-completion-checklist)

## Language, layout and navigation

1. Open DSH's own **language/preferences** setting and choose **English** or **简体中文**.
2. Return to the password manager; its labels follow the host locale. There is no separate per-vault language switch in 1pass.
3. Use the matching document: [English](<gui-guide.md>) / [简体中文](<gui-guide-zh.md>). Changing documentation language does not itself change the application locale.
4. The four main destinations are **Home**, **Passwords**, **Cloud sync**, **Settings**.
5. On narrow views, measured navigation moves destinations into **More**. This is overflow, not a missing feature.
6. Home quick actions and the command palette open task views: **Security**, **Import / export**, **Sessions**, **Activity**, **Trash**, **Quick import**, **Local backups**, **About**.
7. A task uses the workbench's full content area. **Back** returns to the originating main page; close the task rather than the outer DSH Settings dialog when you want to stay in 1pass.
8. The footer shows ready/loading/error/locked/working states. “Status unavailable” is not evidence of an empty vault.

Only non-secret navigation is remembered for the tab. Secrets, editor drafts and import passwords are not intentionally persisted in browser storage.
Take special care with screen sharing, clipboard history and browser extensions: they are outside the encrypted-at-rest guarantee.

![Synthetic English demo: navigation, overview and language](<media/overview-en.gif>)

## Create, unlock and lock

### First use

1. Wait for the initial status check. If it fails, use **Retry** rather than treating it as a new empty vault.
2. If no vault exists, enter a nonempty **Master password** and confirmation, then **Create vault**.
3. If a vault exists, enter that vault's existing master password and **Open vault**. Do not create a different file to “fix” an incorrect password.
4. A weak-password warning is advisory. For real use choose a strong unique master password and store it independently.
5. The form sends the value to the local host; it is not a model-tool argument, URL or browser-storage entry.

### During and after a session

- **Lock vault** prevents further entry reads/writes until reopened. Choose an idle auto-lock interval in Settings.
- A host restart loses runtime-only GUI unlock material. Re-enter the password, or use a deliberately configured environment-based deployment.
- Changing the browser's language/theme does not decrypt or migrate the vault.
- A separately launched CLI does not acquire the GUI's in-memory key. It needs its own authorized password input.
- Never paste a master password into chat or a bug report, and never put it in a repository configuration row.

**Expected result:** the workbench loads entry summaries and reports the real active vault. An unlock failure should remain a failure, not be rewritten as success by an assistant.

## Home

Home is the starting overview, not a second credential store.

1. Check the active vault name, entry count, access state and local-encryption status.
2. Read the health/weak/reused/backup counters as prompts for investigation, not a proof that the vault is safe.
3. Use **New entry** for a single credential and **Quick import** for local multi-line input.
4. Open **Security**, **Import / export**, **Local backups**, **Sessions** or **Trash** from quick actions.
5. Inspect recent activity; use the Activity task for filtering and more events.
6. Use Refresh if the displayed state is stale after an external authorized write.

No Home card establishes that an SSH password works or that a cloud target is writable.

## Passwords: search, filters and row actions

### Find one entry

1. Open **Passwords** and enter a title, username, host, URL or useful metadata term.
2. Use **type** and **tag** selectors to narrow the result.
3. Combine **favorites**, **due/expired** and **risk/issues** filters as needed; clear them if a known entry appears missing.
4. Choose alphabetical, recently modified, recently created or smart/favorite ordering.
5. Review the result count; use **Load more** for remaining rows. A partial visible page is not the complete inventory.
6. Expand the intended row to inspect its summary and actions. Titles can repeat; check the entry identity/host and id where available.

Search and list views omit standard secret fields, but metadata itself may be sensitive. A user can also accidentally type a secret into a title, URL or note; never promise that arbitrary metadata is harmless.

### Use row controls deliberately

| Control | What it does / what to check |
|---|---|
| Star | Add/remove a favorite; this modifies the entry |
| Expand | Open row details, not a remote connection |
| Edit | Load the intended entry into the editor |
| Copy password/key/token/card | Retrieve the relevant value and write it to the clipboard; avoid clipboard-history exposure |
| Copy all fields | Broader plaintext exposure; use only if all those fields are authorized |
| TOTP | Generate a short-lived code; check the countdown before use |
| TOTP provisioning URI | Exposes the long-lived setup seed, not just a temporary code |
| Password history | Inspect older passwords; rollback is a write and archives the current password |
| Attachments | List/download/remove files; a download is plaintext outside the vault |
| Clone | Create a separate copy with secrets; review identity and remove unnecessary copies |
| Delete | Soft-delete to Trash, not erase backups/history |

Some actions live in the **⋯ row menu** or expanded row. Availability follows the entry type and whether the vault is locked/read-only.
Risk/expiry badges can open the corresponding entry for correction. A three-star strength indicator is advisory and applies to passwords/PINs, not machine-generated API keys/private keys.

### Multiple entries

Selection mode supports bulk favorites, tags, delete and selected-field CSV export. Verify the selected count and filter scope first.
Bulk deletion is still soft deletion. CSV output can contain plaintext passwords even when the list was masked.

## Credential editor and templates

Open **New entry** or **Edit**, then choose a **template/type** before filling the relevant fields.
Template descriptions are hints, not default credential values. Saving a template stores field structure, not the entry's actual secrets.

### Common steps

1. Give the entry an unambiguous synthetic-safe title such as **demo-server** for a test fixture.
2. Select the correct type/template. Fill only fields required by that credential.
3. Keep secret fields masked; use **Show** only when you need visual verification and no one else can see the screen.
4. Add tags/notes that identify purpose without embedding extra secrets.
5. Expand **Advanced** for sensitivity, expiry, rotation, favorite, icon/color and exact environment-variable names.
6. Review validation beside the relevant field. Weak password strength does not itself block saving.
7. Choose **Save** or Ctrl/Cmd+Enter. Use **Cancel** deliberately to leave; Escape does not silently discard editor secrets.
8. Verify the saved summary, not a printed password, to confirm the intended entry changed.

### Type-specific fields

| Template / type | Fields and caveats |
|---|---|
| Login | Username/email/phone, password, website, optional TOTP |
| SSH (password) | Host, optional separate IP, port, username and login password |
| SSH (certificate / private key) | Host/IP/port/user, multi-line PEM/OpenSSH private key, optional OpenSSH user certificate and key passphrase |
| API key | apiKey, optional URL/account; use **demo-api** for demonstrations |
| OAuth | Access/refresh tokens, expiry, client/scope/token URL metadata as appropriate |
| TOTP / Google Authenticator | Title and Base32 setup key or single-account otpauth://totp/ URI; no login password required |
| Card | Number, expiry, CVV and holder; revealing/exporting them is sensitive |
| Generic secret | One secret plus purpose metadata |
| Cookie | Use Sessions for capture/import and cookie management; do not confuse a session cookie with a password |
| Custom | Additional fields; untouched nested original data is preserved rather than silently stringified/dropped |

For SSH, a sample host is **example.com**, with a documentation IP such as **192.0.2.10** and port **22**.
“Certificate” means an **OpenSSH user certificate**, not TLS. Basic private-key format validation does not connect to a server or prove that the key is accepted.
Switching SSH authentication may remove inactive password/private-key draft values; review the explicit confirmation. Existing TOTP and unrelated stored fields should not be lost through an ordinary edit.

### TOTP specifics

- Enter the long-lived setup secret, **not** a six-digit code currently displayed on a phone.
- Current supported URI algorithm is SHA-1; digits/period/issuer/account from a supported URI are retained.
- QR image input and Google Authenticator **otpauth-migration://** multi-account bundles are not supported by this editor.
- Other credential types also have a separate two-factor section. A missing login password does not invalidate a TOTP-only entry.
- Copying a provisioning URI reveals the seed; choose a current code instead when that is all the task requires.

### Attachments and history

Attach a private key, certificate or recovery document only when its storage is authorized. Attachments are base64 content inside the encrypted entry, not a public download URL.
A downloaded attachment is a new plaintext file. Removing it from the current entry does not erase historical backups or cloud snapshots.
Password history may contain old-but-still-usable credentials; do not include it in screenshots or incident reports unnecessarily.

![Synthetic English demo: type-specific editor, TOTP and quick import](<media/credentials-en.gif>)

## Quick import

Use **Home / Passwords → Quick import**, or the command palette. Paste real batch credentials **only here**, not into chat.
This is a GUI-only masked preview/confirmation workflow, not a model tool that needs your entire batch.

### Format and examples

Default format:

~~~text
{user}@{host}:{port}|{pwd}|{tag/nick_name}
~~~

Synthetic examples:

~~~text
deploy@example.com:22|DEMO-NOT-A-REAL-PASSWORD|demo-server
operator@192.0.2.10:2200|DEMO-SECOND-NOT-REAL|demo-alias
~~~

The value after the colon is a **port**, not an IP. Host may itself be a hostname or IP; use the host-IP preset if alias and real IP must be separate.
Choose host:port, host-only, host:IP or IP:port presets instead of expecting a parser to guess.
The default host:port format still needs the colon when relying on a default port; the host-only preset avoids that punctuation.

| Placeholder | Meaning |
|---|---|
| {user} / {username} | Account username |
| {host} | Hostname or IP; bracket IPv6 when a port follows |
| {port} | Port; default SSH port can be set, otherwise 22 |
| {ip} | Separate real IP, never guessed to be a port |
| {pwd} / {password} | Password; leading/trailing spaces and Unicode preserved |
| {tag} / {tags} | Comma-separated tags |
| {nick_name} / {nickname} / {title} | Display title |
| {tag/nick_name} | Whole final value used as one tag and title |

Backslash escapes the next character. Escape a literal separator as \| and a literal backslash as \\.
Quotes are ordinary data, not CSV quoting; they do not protect an unescaped separator.
Blank lines and whole-line # comments are ignored. A batch is bounded to **500 entries / 1 MiB UTF-8**.

### Preview → select → confirm

1. Choose format, credential kind and default port; paste the batch.
2. **Parse preview**. Review original line numbers, host/IP/user/port/tags and status. The preview reports password presence, **not its value**.
3. Fix invalid lines. Exact duplicate identities are disabled/skipped, not silently overwritten with a new password.
4. Select only valid nonduplicate rows you intend to save.
5. Enter the confirmation step and explicitly confirm the selected count.
6. Inspect added/skipped totals. Successful input is cleared; do not paste/import it again just because the list is filtered.

Duplicate identity accounts for kind, host, IP, port and username. This is not a “replace existing password” operation.
Preview authority lasts **five minutes**, only in memory. Input changes/repreview, lock, vault change, permission change or plugin close revoke it.
A stale preview needs a fresh parse. If a confirmation result is uncertain, inspect first and retain the original confirmation context rather than starting a second independent import.

## Security and breach-check privacy

Open **Security** from Home or the command palette.

1. Read the overall health score and lists of weak/reused passwords, missing 2FA, HTTP URLs and rotation/expiry findings.
2. Click a report entry/badge to open the relevant credential; identify the target before editing.
3. Inspect duplicate groups before merging. A merge changes entry data; keep a backup when in doubt.
4. Export a metadata/security report only to an authorized path. Even a secret-free report reveals inventory titles and service use.
5. Treat scores as screening aids. “No findings” is not a penetration test or proof of account safety.

### Online breach check

When initiating a breach check, review the online/offline confirmation. Online checking contacts **api.pwnedpasswords.com** with the first **five hex characters of SHA-1(password)**, using Add-Padding; suffix matching is local.
The password, full hash and entry identity are not sent, but your IP and hash bucket prefix are visible to the service/network path. Padding obscures response size, **not** those facts.
Offline checking uses a bundled common-password list and avoids the network request; it has much smaller coverage. Cached/common-list results may not require a request.
Do not use a screenshot of synthetic “breached” fixture entries as evidence that real credentials were checked.

![Synthetic English demo: security, activity, local backups and trash](<media/security-history-en.gif>)

## Import / export

Open **Import / export**. Paths refer to files on the **DSH host**, not an arbitrary file on another device showing the GUI.

### Import safely

1. Make a local encrypted backup and confirm the active target vault before a large migration.
2. Choose a format/source: browser stores, 1Password 1PUX/legacy 1PIF, Bitwarden JSON/password-protected JSON, KeePass KDBX/XML, Enpass or manager CSV.
3. Prefer **Preview** where offered; supply the file path and any required source password/keyfile through the local masked input.
4. Review parsed counts and identity summaries. Preview does not establish that all masked/missing source fields were recoverable.
5. For manager CSV, inspect the masked row preview and explicitly confirm the import. For other importers, follow that source's own preview/overwrite/confirmation prompts.
6. Choose **overwrite** only if updating existing matching credentials is intended. A preview button is not a write, and an Import button is not universally a row-selection workflow.
7. Review added/updated/skipped totals and test a small sample without printing the secrets.

Chrome/Firefox/Keychain imports depend on source-platform permissions, encryption/keychain availability and, where needed, source primary passwords. Do not repeatedly approve OS prompts without checking what is being requested.
KeePass XML values exported as ******** cannot be magically recovered. Keep source exports protected until a verified restore/migration is complete.

### Export warning

**CSV, 1Password 1PUX, ordinary Bitwarden JSON, browser CSV, KeePass XML, env files and cookie exports can contain plaintext secrets. A ZIP container is not encryption.**

1. Choose a destination intentionally; host paths may be outside the browser's download directory.
2. For CSV, select only the required fields/entries; excluding a password field does not make every other metadata field harmless.
3. Read the plaintext warning and confirm only the authorized export.
4. Restrict access, exclude it from Git/sync directories, and remove the temporary plaintext after use.
5. For an encrypted portable backup use the encrypted vault export path/tool with its separate password, not a similarly named plaintext migration button.

![Synthetic English demo: import previews and plaintext-export confirmation](<media/transfer-en.gif>)

## Cloud sync: setup, preview and merge

Open the main **Cloud sync** page. This is a four-channel encrypted **entry-snapshot** system, not the legacy raw vault-file uploader.

### Understand what leaves the device

- A custom snapshot includes **all entries**, including trash, password history, cookies and attachments, encrypted with a **separate channel sync password**.
- It is **not a raw copy of the original encrypted vault document**. Local master passwords may differ across devices; shared sync decryption material must match the uploaded snapshot.
- It does not export unrelated DSH host settings, plugins, MCP configuration or conversation sessions.
- The envelope/index still expose plaintext snapshot ids/times/hashes, transport, vault/device labels, platform/version/section metadata. Avoid sensitive labels.
- The encrypted common ancestor/baseline enables three-way comparison; it is not a server-side account credential.
- Authentication tokens and sync passwords belong to **DSH host credential slots**, not automatically to searchable 1pass entries.

### Configure and save

1. Select a channel card and open its configuration dialog. It edits **that channel**, not all channels at once.
2. Fill the destination and masked authentication fields. Existing stored secrets appear as configured/saved status, not as a round-tripped token value.
3. Wait for the save receipt / use the explicit save action where offered. Some destination changes are debounced autosaves: **closing is not an upload**, and an unsaved/failed receipt is not success.
4. Set/save the encryption and decryption password in the security cards. Use the same appropriate sync password on the other device; it is not your local vault master password by implication.
5. Keep the **vault** section selected and encryption enabled; plaintext upload is not offered.
6. Probe/refresh and read warnings. A successful read probe does **not** demonstrate write rights.

| Channel | Fields / authentication / namespace |
|---|---|
| Git | Repository URL and subdirectory (default **1pass**); token for HTTPS or existing SSH key/agent for SSH. Branch defaults to remote HEAD auto-detection unless explicitly configured. |
| WebDAV | HTTPS endpoint, username, password, prefix (default **1pass**). Probe may create required collections; it is not guaranteed side-effect-free. |
| S3 | Provider, endpoint/region, bucket, prefix, access-key id, masked secret, addressing/dialect choices. Verify the endpoint belongs to the intended service. |
| Gist | Gist id, token, optional API base and file prefix (default **1pass**). Public Gists expose metadata/ciphertext publicly; prefer a private/secret target. |

### GitHub sign-in and repository selection

The Git configuration can offer **GitHub device authorization**, a private-repository picker and private-repository creation alongside manual URL/token entry.
Start sign-in only for the intended account, open the displayed verification URL, and complete approval **yourself**. Treat the device code and auth UI as sensitive; do not post them in an issue/chat.
Wait for the configured/authenticated result before listing repositories. Check the owner, selected private repo and URL before saving.
Creating a private repository is a remote write and needs intentional confirmation. Logging in or selecting a repository does not itself upload your vault.
SSH URLs use the installed SSH environment, not a token fetched from a 1pass SSH entry. Strict host-key checks can fail until the host environment is correctly configured; do not disable them to hide an error.

### Manual push

1. Confirm the channel, destination, vault scope and saved sync password.
2. Open **Push preview**. Review the snapshot scope/count and visible metadata.
3. Confirm the preview only if the intended vault and destination match.
4. Wait for the actual result. A saved config, green fixture badge or preview is not proof of a remote push.
5. Refresh the remote snapshot list/history to inspect the outcome. If the effect is unknown after timeout, inspect before retrying.

The preview binds local memory/disk revision, channel/target/selection and the **whole remote index version**. A local edit or changed remote index invalidates stale authorization.
If the remote contains unmerged changes, sync/merge first; do not force an old local snapshot over them.

### Pull, one-click sync and merge

1. Refresh remote snapshots and choose the intended latest or historical snapshot.
2. Pull / sync / merge preview downloads, validates and decrypts on the host.
3. Review create/update/conflict summaries. Secret values are masked; verify ids/identity instead of guessing from hidden values.
4. Select **keep local**, **use remote** or a safe offered merge result. Password/private-key/array conflicts are not text-concatenated.
5. Confirm the chosen entries and destructive deletion proposals explicitly. Unconfirmed items stay local.
6. The host creates a safety copy, checks local/disk/remote preview facts and applies the accepted changes.
7. A fully accepted result can advance the encrypted baseline; unresolved items do not advance it. Check pending/conflict warnings before declaring sync complete.

Remote history is not local audit history. Inspect a snapshot before restoring/merging it, and distinguish rollback from deleting remote bytes.
Local edits after a sync can make rollback stale; the UI must not silently overwrite them.

### Automatic sync

Off by default and configured per channel. Review interval, startup cadence, realtime local-write debounce/remote polling, conflict policy and automatic-apply tier.
The first sync without a baseline is manual. Startup/remote polling are **pull-only**; interval/local-write triggers can be bidirectional under configured authorization.
The low-risk tier does not automatically apply vault changes. “Local wins” is an explicit policy, not a promise that all conflicts are harmless.
Locked/readonly/unavailable vaults, target changes and plugin unload invalidate active capabilities. Inspect failure/skip counters rather than assuming background work happened.

### Race, retention and workdir limits

| Mechanism | Actual guarantee / limit |
|---|---|
| Git | fetch/ff-only/non-force push protects branch races; no force push, automatic destructive reset or unrelated-history merge |
| WebDAV | Strong ETag conditional index write; no usable ETag means a non-atomic window |
| AWS-style S3 | Conditional requests protect supported endpoints; compatibility must be verified by the operator |
| OSS | Existing-index HEAD-to-PUT check is **not atomic CAS**; an intervening write can still race |
| Gist | Read/merge/PATCH/verify retries preserve observed facts, not unseen concurrent writes; **not atomic CAS** |
| Retention | Keeps recent snapshots by policy (default 10); pruning failure is a separate warning, not rollback of a successful upload |

Git/Gist historical ciphertext survives file deletion; object versions/backups may too. Snapshot cleanup is not cryptographic erasure.
For Git errors inspect the **owned workdir facts**. Relink changes origins; confirmed adopt requires a safe clean/fast-forward history; **reclone discards unpushed/local work** and requires explicit confirmation. Never delete unknown workdirs/stale locks or force push merely to make the status green.

![Synthetic English demo: channel setup, push preview and masked merge](<media/cloud-sync-en.gif>)

## Local backups and legacy cloud backup

Open **Local backups** from Home or the command palette.

1. Create a backup and check the resulting timestamp/owning vault.
2. Inspect available copies; current dated names and older backup naming are recognized.
3. Choose **Restore** and review **merge** versus **replace**. Merge copies entries into the active vault; replace overwrites the whole vault after a safety snapshot.
4. Select overwrite only when you intend to update colliding entries.
5. Verify the restored summary/count and a small authorized sample.
6. Delete a backup only after confirming you have another tested recovery path; backup deletion does not remove every independent copy.

A local backup copies the original encrypted local vault file and needs the matching master password. A cloud-sync entry snapshot is a different format encrypted with its separate sync password.
The **Legacy cloud backup (migration only)** foldout retains one-way GitHub Contents/S3/OSS/R2 behavior. It does not do current bidirectional sync or establish a merge baseline. New channels do not inherit that destination's authorization automatically.
See the [legacy backup guide](<cloud-backup.md>) for old-format recovery; do not relabel it as a current sync snapshot.

## Settings, vaults, permissions and recovery

### Named vaults

1. Inspect the active vault marker before creating, switching, renaming or deleting a named vault.
2. Create/switch only the intended name. A similarly named file is not permission to read another account's vault.
3. Rename follows the active vault where appropriate; sync state uses identity mappings so a rename does not blindly discard its baseline.
4. Delete requires explicit intent; the default vault is protected. A deleted/recreated name does not automatically inherit old upload authorization.
5. Back up before destructive vault operations. Per-entry Trash cannot restore a permanently deleted vault file by itself.

### Access and capture

| Setting | Meaning |
|---|---|
| ask | Default. Ordinary reads free; guarded model writes ask. **Not confirmation before every password read.** |
| readonly | Reads/search/TOTP remain; guarded mutations rejected in tools/UI. Not a metadata-only mode or OS isolation. |
| auto | Ordinary read/write operations without per-call write prompts; reserved for a trusted workflow. |
| Auto-capture | Off by default. Offer to save deliberately shared credentials according to user consent; not permission to harvest secrets. |
| Auto-lock | Never / 1 / 5 / 15 / 30 minutes / 1 hour; runtime timeout controls idle locking. |

High-sensitivity id-scoped model reads, such as vault_get, have an additional runtime approval gate in ask/auto. This does not wrap every bulk/export/CLI path; do not choose vault_fill as a workaround for a denied/missing safe read.
Direct GUI actions use their own confirmation/readonly rules. A tool catalog is not an operating-system boundary.

### Model-tool profile

- **Basic: 11** core tools.
- **Standard: 64** = core + 53 management.
- **Full: 113** = core + management + 27 import/export + 8 sessions + 14 files.
- **Custom:** core always present; select only needed optional groups.

The change applies at runtime and persists in the vault directory's tools.json. The tool catalog is **process-wide**, not an independently isolated catalog for each named vault. Profile changes do not grant target/network authorization.

### Recovery-code controls

The access/utility action area offers **Generate recovery code** and **Verify recovery code**; it may appear with the Passwords utility/status controls rather than as a separate Settings subpage.
Generate only when ready to store the shown code offline; regeneration invalidates the old one. The application stores only its SHA-256 hash and can verify possession.
**It cannot decrypt a lost-password vault, derive the master key or reset the master password.** Verification success does not unlock the vault. Keep the actual master password and tested backups safe.
OS keychain/helper-command custody remains a [design draft](<master-key-custody.md>), not an implemented GUI-to-CLI automatic unlock path.

## Tags

1. In Passwords, select a tag filter to scope the list, or open the **tag manager**.
2. Review the tag's entry count before **Rename** or **Remove tag**.
3. Rename affects matching entries across the active vault; removing a tag does **not** delete those entries.
4. Settings also shows tag summaries/rename shortcuts. Selection mode can add a tag to selected entries.
5. The env tag has operational meaning: it opts entries into batch CLI environment export. Do not add it indiscriminately.

Tags, titles and notes are searchable/displayable metadata. Avoid embedding passwords or private infrastructure details in them.

## Sessions

Sessions stores cookie credentials, not DSH conversation sessions. Opening a login window needs optional playwright-core and an available supported browser on the host.

### Manual login → collect → save → close

1. Enter an authorized URL such as **https://example.com** and choose **Open**.
2. Complete the website's login, 2FA and captcha **manually** in the plugin-opened browser window.
3. Return to 1pass and give the open session a clear title.
4. Choose **Collect / Save**. Inspect the saved-cookie count; zero means no usable cookie data was collected, not a successful account session.
5. Close the no-longer-needed login window through the session close action. Saved cookies remain encrypted in the vault.

A window opening is not proof of successful login, and cookie collection does not verify the website still accepts the session.

### Manage saved sessions

- List cookie counts, expired/expiring status and timestamps without values.
- Open details only when authorized; cookie domains/flags/expiry can be sensitive even before values are copied.
- Export as **Cookie header**, **Netscape jar** or **Playwright** data/snippet only to the intended consumer. Clipboard/export content is plaintext account access material.
- Paste supported JSON or a raw Cookie header with a title to import; this is a secret input, never a chat attachment for debugging.
- **Prune** confirms removal of expired cookies; session cookies without a fixed expiry are kept.
- Delete a saved session when no longer needed. Pruning/deleting local cookies does not revoke server-side sessions; use the service's logout/revoke controls where required.

![Synthetic English demo: settings, tools and cookie-session management](<media/settings-sessions-en.gif>)

## Activity, history and trash

### Activity / history

Open the activity/history icon or Home action, then filter **All / Read / Search / Write** or a specific operation. Load more events when needed.
Events record action, title/id and time rather than secret values. They are recent process activity, not a durable tamper-proof audit trail, proof of remote login or proof of cloud success.
Do not confuse **password history** (secret historical values), **local activity**, **backups**, and **remote snapshot history**.

### Trash

1. Open **Trash** and identify the deleted entry.
2. Use **Restore** for one, or **Restore all** for the active vault's trash.
3. Use **Purge** / **Empty trash** only after reviewing the permanent-removal confirmation.
4. Verify the active list/trash count after completion.

Soft-deleted entries remain encrypted in the vault and are included in full cloud entry snapshots. Purging the current entry does not erase old local backups, remote snapshots or Git/Gist history.

## About, command palette and keys

About shows package/version and storage/attribution explanations. A version label is not evidence that that version has been published as a Release.

| Key / control | Scope |
|---|---|
| Ctrl/Cmd+K | Workbench command palette when not typing and not inside an editor/import transaction |
| Ctrl/Cmd+N | New entry when not typing, unlocked and writable |
| Palette Up/Down, Enter | Move through / execute a matching enabled command |
| Escape in palette/dialog | Close the active plugin overlay and restore focus where supported |
| Main-tab Left/Right, Home/End | Move tab focus; activate the desired tab using its button |
| Ctrl/Cmd+Enter in editor | Save the editor |
| Escape in editor | Does not discard unsaved secret drafts; use explicit Cancel |
| Search Enter / Escape | Remember submitted search / clear query and related selectors within the search control |

The host owns the outer Settings window; browser/OS shortcuts may also be reserved. Shortcuts avoid ordinary text input rather than stealing typing.
The palette contains main pages, task pages, new, search, refresh and lock. Locked/readonly/busy operations are disabled instead of bypassing the policy.

## Safe assistant / CLI handoff

Import the repository's [/1pass skill source](<../skills/1pass/SKILL.md>) through the normal DSH Skills UI. Plugin installation alone does not install a local skill.

~~~text
/1pass demo-server
/1pass demo-server only host username port
/1pass use demo-api for authorized task
~~~

Use **summary → disambiguate → chosen-id minimal fields just in time → authorized consumer → verify real result**.
Never substitute target matching/full-entry reads to bypass a denied or unavailable safe read. Never claim “SSH connected” from a successful vault search.

For an installed CLI, dsh-vault get demo-server --field host reads one metadata field. A consumer should obtain a secret internally and avoid logging stdout or putting it in URLs/process arguments.
CLI master-password sources are --password-stdin, DSH_VAULT_MASTER_PASSWORD, DSH_VAULT_PASSWORD, then an interactive prompt. It does not automatically share a GUI key.
--mask retains prefixes for some fields and can leave custom/metadata values readable; --all prints the full entry even if --mask is also supplied. Prefer explicit --field or env --keys-only, not masking as a universal secrecy barrier.
Detailed [CLI and env instructions](<../README.md#command-line>) explain invocation, quoting and input requirements.

## Troubleshooting and completion checklist

| Problem | Safe next action |
|---|---|
| Known entry missing | Clear filters/search and verify active vault; do not recreate a duplicate immediately |
| Input preview expired | Reparse and reselect; do not reuse a stale token |
| Readonly blocks import/edit | Ask the user to change policy intentionally; do not route around it through another tool |
| Cloud “saved” but no snapshot | Saved configuration is not push; perform reviewed preview/confirmation and inspect remote result |
| Git read works but push fails | Check write scope/branch/workdir facts; no force push or unknown-workdir deletion |
| Sync changed/conflict warning | Refresh local and remote state and build a new preview |
| Session window did not authenticate | User completes login; verify cookie count and actual consumer result separately |
| Recovery code did not unlock | Expected; possession verification is not decryption |
| Wrong language | Change DSH host locale and return; do not look for a per-entry language field |

Before leaving: save or explicitly cancel drafts, close manual-login windows, remove unnecessary plaintext exports, check operation results and lock the vault when appropriate.

[English](<gui-guide.md>) | [简体中文](<gui-guide-zh.md>) · [Project README](<../README.md>) · [Back to contents](#contents)
