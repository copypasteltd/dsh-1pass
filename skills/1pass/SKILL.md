---
name: "1pass"
description: "Use /1pass to find existing local dsh-vault credentials by title, host or ID and read only task-required login, SSH, API or TOTP fields. 默认只报告非秘密摘要；为明确授权的任务安全取用凭据，不回显密码、不自动连接、不导出整库。"
---

# /1pass — 本地凭据取用 / Local credential use

Retrieve existing local password-vault information for the current task. This skill is not a credential store, an SSH client, or permission to run unrelated operations.

## 快速指定 / Invocation

- `/1pass demo-server`: find and report a non-secret summary only; do not fetch its password or connect.
- `/1pass demo-server 只要主机、用户名和端口`: read only those non-secret fields.
- `/1pass 使用 demo-server 连接并检查系统版本，不改配置`: retrieve only the authentication needed for that authorized connection, then verify its result.
- `/1pass 使用 demo-api 调用我指定的接口，不显示 key`: use its key for that request without echoing it.
- `/1pass demo-account 的一次性验证码`: generate a current code; do not read the long-lived TOTP seed.

A bare name is a summary request, not a login. Skill selection grants no extra execution or external-write authority.

## 1. 找到正确条目 / Resolve the correct entry

1. Call `vault_search({query:"demo-server",limit:10})`. Without a query, ask for a name or purpose instead of enumerating the whole vault.
2. Inspect returned `id/title/kind/host/port/username/sshAuth` summaries. Prefer an exact title or ID. Search may return multiple fuzzy matches; never silently pick the first.
3. For ambiguous results, show only the candidate titles/types and necessary non-secret distinctions, then ask the user to choose. Do not read secrets to guess. If absent, report not found; do not invent or automatically save a credential.
4. Bind subsequent reads to the confirmed ID. If the vault locks, changes, or the task target changes, re-confirm before using a previously read secret.

Use search then confirmed-ID get for this skill. Do not fall back to `vault_fill`: it cannot bind the confirmed ID and does not share every ID-scoped high-sensitivity read approval path. If search/get is unavailable or approval cannot be obtained, stop and explain the missing safe capability.

## 2. 最少字段读取 / Minimum field access

For ordinary queries, summaries are enough. When missing non-secret fields are needed, call `vault_get` with an explicit list:

~~~json
{"id":"<ID returned by search>","fields":["title","kind","host","port","username","sshAuth"]}
~~~

Only read secrets just before the confirmed consumer needs them. Never omit `fields` merely for convenience. Older plugin builds may return arbitrary custom values in search summaries: treat unexpected fields as potentially secret, never quote them, and do not claim that no secret reached the tool response on such a build.

| Task | Required distinctions and fields |
|---|---|
| Website login | Only needed `url/username/email/password`; verify the intended domain before submitting. |
| SSH password | `host/port/username/sshAuth/password`. A server password is not the vault master password. |
| SSH key/certificate | `host/port/username/sshAuth/privateKey`; add `certificate/keyPassphrase` only if needed. Do not enter a key as a password. |
| API/OAuth | Only necessary `apiKey/secret/accessToken/refreshToken`; verify the service and endpoint. Refreshing tokens or changing remote state still needs task authorization. |
| One-time code | Prefer `vault_totp({id:"<confirmed ID>"})`; do not retrieve `otpSecret`. Codes are sensitive too. |
| Custom field | Model-tool field filtering is top-level; do not assume `fields.someName` works. Reading the whole custom map may expose unrelated secrets. Prefer an authorized CLI single-field consumer or explain the limitation. |

Missing fields are a reason to ask or stop, not to invent values. `redact:true` and `--mask` are convenience masks, not guarantees that arbitrary custom data is sanitized.

## 3. 安全交接 / Safe use and verification

- Prefer a consumer process that obtains its required field privately, or pass the tool value directly to a tool supporting secret input. Do not route secrets through chat, screenshots, debug output, clipboard history or command-line arguments.
- Never interpolate a password/token/private key into a shell command, URL, Git remote or inline Authorization argument. Disable shell tracing. Pipes/stdin/short-lived child environments still require appropriate tool support; do not call them universally invisible.
- For SSH, verify a new/changed host-key fingerprint instead of disabling host checking. Native `ssh` may require interactive password entry unsupported by the available execution tool. Explain this limitation; do not install a workaround or display the password just to finish.
- Use a temporary private-key file only when the authorized consumer requires it, with restricted permissions, no overwrite, and finally cleanup. Do not silently create a permanent secret file.
- Verify that login/request actually completed before saying connected/succeeded. Report the selected entry, authentication type, authorized action and non-secret outcome; finding a record is not a successful connection.
- Never write secret values into repository files, README, Skill, Git commits, audit details or final answers. Minimize their lifetime and do not dump variables on failure.

## 4. 锁库与权限 / Availability and permission

- Unopened/locked vault: ask the user to open/unlock it in Settings → Password Manager (1pass) / 设置 → 密码管理(1pass). Never ask for the master password in chat or read host configuration/encrypted files to bypass it.
- Follow actual runtime approval rules. Ordinary read and write rules differ in ASK mode. If a high-sensitivity read requires approval, wait; rejection, skipped approval or unavailable approval is not authorization.
- READONLY permits allowed reads, not adds/updates/deletes. Do not change access mode, enable tool groups or export the vault just to retrieve a record.
- If vault tools are absent, state that the plugin/tools need enabling; this skill itself registers no credential or SSH tools.
- Changing entries, auto-capture, bulk export and GitHub sync require separate user intent. Do not look in Git history instead of the current local vault.

## Optional standalone CLI / 独立脚本

Use only when the CLI is installed, the process already has a legitimate secure unlock source, and a script consumer is needed:

~~~sh
dsh-vault get "demo-server" --field host
dsh-vault get "demo-server" --field username
dsh-vault get "demo-server" --field port
~~~

`show`/`list --json` omit secret fields, notes and custom maps, but still expose the full public metadata projection. Metadata can itself be sensitive, so use explicit fields for this workflow. Bare `get` outputs the primary secret. Prefer explicit `--field`; do not run bare get for a summary, `--all`, or unrelated vault-wide `env`.

The standalone CLI does not inherit the GUI's in-memory key. Its master-password sources are `--password-stdin`, process `DSH_VAULT_MASTER_PASSWORD` / `DSH_VAULT_PASSWORD`, then an interactive prompt. Use an existing authorized safe source; never put the master password in commands/chat/persistent config. Without a safe source, prefer unlocked plugin tools or let the user run the CLI in their own local terminal.

Secret stdout must be captured privately by the consumer, not returned to the model as terminal output. The CLI is a direct file client and does not promise DSH per-tool approval inheritance; never use it to bypass locking, approval, readonly or a refusal. CLI `--field fields.customName` can select one custom value; model-tool filtering is different.

## 默认交付 / Default response

Summary: “Found demo-server: SSH, host…, username…, port…, password/key authentication. No secrets read; not connected.”

After use: “Used the entry for the requested operation without echoing authentication material; verified result…”. On failure distinguish no match, ambiguity, locked vault, missing fields, unsupported safe consumer, connection failure or permission failure, without exposing secrets.
