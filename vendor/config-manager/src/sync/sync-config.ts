/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2 (635c2e66388c9ec5929071d05e01abd77779366d).
 * Full permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adaptation: browser-only structural boundary; no host I/O.
 */

import type { S3CompatProvider, SYNC_CHANNELS, GistProvider } from '../utils/shared-constants.ts';
export type { S3CompatProvider } from '../utils/shared-constants.ts';
export type SyncTransportType = (typeof SYNC_CHANNELS)[number];
export interface CloudS3ChannelView {
  provider: S3CompatProvider;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  pathStyle: boolean;
  /** 密钥已在 credentials 里（只回布尔） */
  secretStored: boolean;
}
export interface CloudGistChannelView {
  provider: GistProvider;
  gistId: string;
  apiBaseUrl: string;
  filePrefix: string;
  secretStored: boolean;
}
export type CloudConfigIssueCode =
  | 'cloud.providerUnknown'
  | 'cloud.endpointRequired'
  | 'cloud.endpointInvalid'
  | 'cloud.endpointUserinfo'
  | 'cloud.regionRequired'
  | 'cloud.bucketRequired'
  | 'cloud.bucketInvalid'
  | 'cloud.prefixInvalid'
  | 'cloud.accessKeyIdRequired'
  | 'cloud.gistIdRequired'
  | 'cloud.gistIdInvalid'
  | 'cloud.apiBaseUrlInvalid'
  | 'cloud.secretWriterRequired';
