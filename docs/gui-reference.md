# GUI reference inspection and adaptation

Inspected 2026-11-15: xiajiajun516/dsh-config-manager installed version 0.8.2; read-only reference checkout HEAD 635c2e6. The source is MIT licensed; retained notice in NOTICE. The reference checkout is ignored and not part of a release.

## Verified integration contract

The current reference registers exactly one settings.section through ctx.slots.inject and ctx.slots.register, with a unique id, label, locale namespace and injected API face. It does not create a settings.plugins.tab. DSH owns the outer Settings dialog and its close button.

The new section is named 密码管理(1pass), id onepass. The browser implementation registers settings.vault locale and uses the same slot lifecycle; business calls retain the vault/* RPC surface. A runtime-only first-use password form allows the Settings section to mount without an environment variable. It never exposes the master password as a model tool argument or persists it in web storage/configuration. Existing environment deployment remains supported; runtime opening lasts for the current host process.

## GUI logic adopted

- Four primary destinations with a segmented navigation strip, real width measurement and a More overflow menu; ARIA tab/tabpanel relationships and keyboard navigation.
- Four icon actions: command palette, activity, history and about. Ctrl/Cmd+K command search; shortcuts avoid stealing text editing.
- Full-width task surfaces scoped to their origin page, rather than narrow drawers; closing/returning restores the underlying main view.
- A persistent password business engine retains search, CRUD, templates, password generation, TOTP, attachments, imports/exports, backups, permissions, sessions, audit and trash. No reference configuration-manager write/sync/marketplace operation is copied.
- In-plugin masked input and confirmation dialogs use a plugin-root stacking context, focus trap, Escape and focus restoration. No native browser prompts and no body-level overlays beneath the host Settings mask.
- Reference density, semantic DSH theme tokens, 24/28/32px control geometry, compact cards/table rows, scoped scrolling and status footer.
- Only nonsecret navigation state may be stored in sessionStorage. Credential values/drafts, master passwords, recovery codes and import passwords remain memory-only.

## Inspection evidence

Reference files: src/client/index.ts (settings.section registration at lines189–196), ConfigManagerSection.tsx (four-tab shell, measured navigation, full-width tasks and status), config-manager.module.css (token scales/shell/buttons/cards/dialog geometry), common/Modal.tsx and common/Select.tsx (plugin-root portal constraints), src/ui/nav-model.ts (overflow algorithm), run-store.ts (explicit nonsecret serialization), common/ConfirmDialog.tsx and CommandPalette.tsx (focus/keyboard logic).

Observed in the existing DSH URL without triggering backup/migration actions: Settings → 备份与迁移 exposes 首页/产物库/同步/环境, command/activity/history/about icons, one main scrolling content area and a status footer. Screenshot comparison uses the same host theme and dialog geometry.

The shell and interaction organization follow the reference; content and actions necessarily remain password-management operations. This is not a claim that a password manager performs the reference plugin's backup/migration/profile/marketplace functionality.
