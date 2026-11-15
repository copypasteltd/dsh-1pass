import type { QuickImportOptions } from './quick-import.ts'
export type { QuickImportOptions } from './quick-import.ts'
/** Never includes a password or raw source line. */
export interface QuickImportPreviewRow {
  line: number; title?: string; username?: string; host?: string; ip?: string; port?: string; tags?: string[]; hasPassword?: boolean
  status: 'ready' | 'duplicate' | 'invalid'; error?: string; warning?: string
}
export interface QuickImportPreview {
  token: string; expiresAt: number; vaultName: string; rows: QuickImportPreviewRow[]; valid: number; invalid: number; duplicates: number; ignored: number
}
export interface QuickImportCommitResult {
  added: number; skipped: number; lines: Array<{ line: number; status: 'added' | 'skipped' }>; note: string
}
export interface QuickImportApi {
  previewQuickImport(text: string, options: QuickImportOptions): Promise<QuickImportPreview>
  commitQuickImport(token: string, lines: number[], confirm: boolean): Promise<QuickImportCommitResult>
  discardQuickImport?(token: string): Promise<{ discarded: boolean }>
}
