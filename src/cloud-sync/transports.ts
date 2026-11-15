/*!
 * HOST-only encrypted vault transports; no store or credential persistence policy.
 * Transport I/O, concurrency semantics and signing adapted from dsh-config-manager
 * 0.8.2, reference HEAD 635c2e6, by xiajiajun516. Vault-only encryption, wire format,
 * validation and host boundary adaptations are part of dsh-vault.
 *
 * MIT License
 *
 * Copyright (c) 2026 xiajiajun516
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { VaultSyncTransport } from './types.ts'
import { fail, record, text } from './transports/documents.ts'
import { timeoutMs } from './transports/http.ts'
import type { HostTransportOptions } from './transports/http.ts'
import { GitTransport } from './transports/git.ts'
import { WebDAVTransport } from './transports/webdav.ts'
import { S3Transport } from './transports/s3.ts'
import { GistTransport } from './transports/gist.ts'

export { metaFromSnapshot, snapshotContentHash, remoteIndexVersion, VaultTransportError } from './transports/documents.ts'
export type { HostTransportOptions as VaultHostTransportOptions } from './transports/http.ts'

const FIELDS: Record<string, readonly string[]> = {
  git: ['transport', 'repoUrl', 'subdir', 'branch'],
  webdav: ['transport', 'webdavUrl', 'webdavUsername', 'prefix'],
  s3: ['transport', 'provider', 'endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'pathStyle', 'dialectId'],
  gist: ['transport', 'gistId', 'apiBaseUrl', 'filePrefix'],
}
/** Construct without network/credential I/O. Test-only options are never accepted inside config. */
export function createVaultSyncTransport(options: HostTransportOptions): VaultSyncTransport {
  const config = record(options.config)
  const channel = text(config.transport, 16)
  const allowed = Object.hasOwn(FIELDS, channel) ? FIELDS[channel]! : undefined
  if (!allowed || Object.keys(config).some(k => !allowed.includes(k))) fail('invalid-config', 'Unknown channel or configuration fields. Secrets must be supplied by credentials.getSecret, never plaintext configuration.')
  timeoutMs(options)
  if (!options.credentials || typeof options.credentials.getSecret !== 'function') fail('invalid-config', 'A host credential provider is required.')
  switch (channel) {
    case 'git': return new GitTransport(options)
    case 'webdav': return new WebDAVTransport(options)
    case 's3': return new S3Transport(options)
    case 'gist': return new GistTransport(options)
    default: fail('invalid-config', 'Unknown vault transport channel.')
  }
}
