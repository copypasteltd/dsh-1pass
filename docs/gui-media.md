# GUI operation GIFs / GUI 操作动图

**Synthetic, offline recordings of the actual production UI—not AI images or redrawn interfaces.** All twelve clips import the real VaultWorkbench, VaultSection and CloudSyncPanel with their unchanged CSS and EN/ZH dictionaries. Only the caption banner and orange click ring are extra documentation annotations.

**生产组件的离线合成数据录屏，不是 AI 图片或重绘界面。** 十二个 GIF 使用真实组件、原始 CSS 和中英文字典；顶部说明与点击圈是额外文档标注。

## Gallery / 图集

| Sequence / 主题 | 中文 | English | Actions and states / 操作状态 |
| --- | --- | --- | --- |
| Overview / 总览 | [overview-zh.gif](<media/overview-zh.gif>) | [overview-en.gif](<media/overview-en.gif>) | Home, main navigation, command palette/search, About, recent activity, password list / 首页、导航、命令面板、关于、最近活动、密码簿 |
| Credentials / 凭据 | [credentials-zh.gif](<media/credentials-zh.gif>) | [credentials-en.gif](<media/credentials-en.gif>) | Search, SSH filter, password/certificate/private-key templates, TOTP, masked card editor, cancel draft / 搜索、SSH 筛选与模板、TOTP、遮罩银行卡编辑、取消草稿 |
| Transfer / 导入导出 | [transfer-zh.gif](<media/transfer-zh.gif>) | [transfer-en.gif](<media/transfer-en.gif>) | Masked paste, preview, row selection, explicit confirmation/result, transfer pane, local backup list/action / 遮罩粘贴、预览、选择、确认与结果、导入导出、本地备份 |
| Cloud / 云同步 | [cloud-sync-zh.gif](<media/cloud-sync-zh.gif>) | [cloud-sync-en.gif](<media/cloud-sync-en.gif>) | Four configuration dialogs, mandatory encryption, password prerequisites, push preview, three-way conflict/local decision draft without applying / 四通道配置、强制加密、密码前置条件、推送预览、冲突裁决草稿（不执行） |
| Security/history / 安全活动 | [security-history-zh.gif](<media/security-history-zh.gif>) | [security-history-en.gif](<media/security-history-en.gif>) | Health/finding filter, audit filter, trash restore, permanent-delete confirmation/cancel / 健康报告筛选、活动筛选、回收站恢复、永久删除确认后取消 |
| Settings/sessions / 设置会话 | [settings-sessions-zh.gif](<media/settings-sessions-zh.gif>) | [settings-sessions-en.gif](<media/settings-sessions-en.gif>) | Vault management/rename, access mode, auto-lock, custom tools, recovery confirmation, illustrative manual-login/collect/save/close / 库管理、访问模式、自动锁定、工具组、恢复确认、手动登录说明与合成收集保存 |

## Boundaries / 隔离与诚实边界

- New disposable headless Chrome browser/context. No persistent user profile, real vault, credentials, host bridge, real account or running DSH GUI is opened. Pages/context/browser close in finally blocks, including failures.
- HTTP(S) interception fulfills only the reserved docs-demo.invalid navigation document from an in-memory string and aborts every other page request. Service workers are blocked; background networking features are disabled. No server starts. This proves the page request interception policy, not an OS-level network sandbox.
- Data uses only demo-account, demo-server, demo-api, example.com and reserved 192.0.2.0/24 documentation IPs. Masked values are obvious non-functional sentinels; the card number is all zeros. No usable token shapes, private-key blocks or TOTP setup keys are entered. Empty SSH certificate/private-key fields demonstrate the actual editor.
- Cloud configuration/status, encryption-password persistence, backup/health/audit results, push/merge previews and cookies are invented in-memory responses. They do not prove cloud authorization, encryption, persistence, real transport, account authentication or cookie collection. No cloud push/merge apply runs; configuration dialogs are dismissed. Recovery/permanent-delete confirmations are cancelled.
- Sessions show the actual manual-login instructions, but no site is visited or signed in. Open/Collect/Save only update fixture arrays; the UI result is illustrative, not authentication evidence.
- These are discrete post-action screenshots encoded into real multi-frame looping GIFs, not continuous real-time video. Typing/scroll movement and waits are omitted, animations disabled, readable states held 1.25–1.5 seconds. Output timing is editorial, not a performance benchmark. The manifest records edited time, source-frame hashes, observed panes/masked controls, click geometry and actual DOM click/change events.
- Product copy is preserved, including currently visible unresolved English plural-format fragments in the merge dialog. No production edit or special fixture rewrite hides that limitation.
- Synthetic host-theme tokens support standalone rendering; this is not host-shell integration evidence. Raw frames remain only under ignored lib/docs-demo; public manifest paths are repository-relative, without host usernames/absolute paths. Captured source hashes identify the recording revision; subsequent recorder-only trailing-whitespace cleanup does not alter the recorded frames or GIF hashes.

## Reproduce / 复现

Use existing repository dependencies plus already installed Chrome, ffmpeg and ffprobe. Nothing is installed. Native TypeScript support is needed for the config (Node 24 recommended). The programmatic tsdown API avoids CLI bootstrap delays. From the repository root:

```bash
# Set only if these tools are not already discoverable:
export DSH_TEST_CHROME="/path/to/chrome"
export FFMPEG_PATH="/path/to/ffmpeg"
export FFPROBE_PATH="/path/to/ffprobe"

# Scoped bundle build + six scenarios, both languages:
node scripts/record-docs-gifs.mjs --build

# Optional subset (manifest is replaced with that subset):
node scripts/record-docs-gifs.mjs --lang=zh --only=cloud-sync
```

On native Windows, use normal absolute Windows paths in those environment values. The default Chrome path is the standard Google Chrome location. The recorder uses the programmatic tsdown API, never starts a replacement server, and never rebuilds production artifacts.

- [docs-demo-render.tsx](<../scripts/docs-demo-render.tsx>): isolated synthetic API fixture and production UI mount.
- [docs-demo.config.ts](<../scripts/docs-demo.config.ts>): isolated bundle output, reusing the existing CSS pipeline.
- [record-docs-gifs.mjs](<../scripts/record-docs-gifs.mjs>): actual DOM actions, screenshots, palette GIF encoding, objective size/duration/dimension/loop/frame checks.
- [manifest.json](<media/manifest.json>): source/GIF/frame SHA-256, action/state/timing coverage, ffprobe details, intercepted request counts and cleanup outcome.

All GIFs: 960 × 740, 8 fps, infinite loop, 8–20 seconds, below 4 MiB each. PNGs and concat lists stay under ignored lib/docs-demo; only final GIFs and the public manifest are intended for version control.

所有操作只影响演示文档内存；没有真实账户、云授权、备份持久化或登录成功证明。每个主要状态停留 1.25–1.5 秒，删去了等待及输入过程，不应据此推断真实性能。
