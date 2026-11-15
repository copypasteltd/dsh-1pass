# 1.11.1 — verification and local installation

- Full suite: 897 passed, 5 skipped, 46 test files, exit0.
- Specialized post-fix regression: 198 passed across parser, token/session lifecycle, Gateway, editor helpers, DOM editor and import UI.
- Strict TypeScript check, host CLI build and final browser build passed.
- Secret-source scan, tracked-file/commit scan, unused-export scan and diff whitespace passed. Private-key fixtures contain short synthetic placeholder text only.
- Isolated network-blocked browser passed: password vs certificate templates, masked importer preview, no page errors and no narrow-screen document overflow. All browser fixtures synthetic; no real vault writes.
- Current DSH web profile installed/enabled dsh-vault1.11.1 through its supported plugin manager. Actual Settings → 密码管理(1pass) shows v1.11.1 and 快速导入. Plugin-only disable/enable reloaded its backend without restarting DSH; it now requires the user's master password again. The new preview route changed from old-backend404 to HTTP200 after reload and returns the expected create/unlock-required error while unopened; no live import write was submitted. Unlocked preview/commit behavior is covered by isolated synthetic Gateway/browser tests.
- Local archive: dsh-vault-1.11.1.tgz, 379539 bytes; SHA-256 05b40074f536fab9c83d66c91bc80111b26c5de7aa3cf3ce9b23bd170c8fed02.

Earlier runner startup timeouts and two synthetic-key scan false positives were diagnosed and resolved; only the final successful run above is release evidence. No real credentials were read, no cloud backups enabled, and no public GitHub release or source push was performed. Model read-approval policy is unchanged.
