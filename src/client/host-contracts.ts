/**
 * Structural, type-only boundary for the host services consumed by this plugin.
 * Runtime services are injected by DSH; this file does not provide implementations.
 */
import type { ComponentType } from 'react'
import type { VaultLocaleKey } from './locales.ts'
import type { VaultSectionInjected } from './VaultSection.tsx'

export type VaultTranslate = (key: VaultLocaleKey) => string

type Dispose = () => void

export interface RpcConnection {
  rpc: {
    call(path: string, method: string, payload: { args: Record<string, unknown> }, signal?: AbortSignal): Promise<
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string } }
    >
  }
}

export interface VaultHostServices {
  locale: {
    register(namespace: 'settings.vault', dictionaries: { en: Record<VaultLocaleKey, string>; zh: Record<VaultLocaleKey, string> }): Dispose
    bind(namespace: 'settings.vault'): VaultTranslate
  }
  slots: {
    inject(name: 'settings.section', register: () => Dispose): void
    register(options: {
      name: 'settings.section'
      id: string
      order: number
      label: () => string
      locale: 'settings.vault'
      inject: () => VaultSectionInjected
    }, component: ComponentType<VaultSectionInjected>): Dispose
  }
}
