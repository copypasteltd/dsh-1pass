/** SPDX-License-Identifier: MIT. Copyright (c) 2026 xiajiajun516.
 * From dsh-config-manager 0.8.2 commit 635c2e66388c9ec5929071d05e01abd77779366d.
 * Full permission and warranty notice: vendor/config-manager/LICENSE. */
import type { SyncPullReport, SyncPushPreview, SyncPushReport } from '../../sync/sync-engine.ts';
import type { SyncTransportType as HostSyncTransportType } from '../../sync/sync-config.ts';
import type { CloudGistChannelView, CloudS3ChannelView } from '../../sync/sync-config.ts';
import type { PathMapping, PlanItemKind, SessionFormatDisposition } from '../../core/types.ts';
import type { SectionId } from '../../schema/types.ts';
import type { ConsultReport } from '../../core/migration-consult.ts';
import type { ExportPreviewResponse } from '../api.ts';
import type { UiT } from '../../ui/i18n.ts';
import type { TranslateNS } from '../client-types.ts';
const CLOUD_SYNC_ERROR_KEYS = {
  SYNC_ENCRYPT_PASSWORD_REQUIRED: 'error.encryptPassword',
  SYNC_DECRYPT_PASSWORD_REQUIRED: 'error.decryptPassword',
  SYNC_CHANNEL_UNCONFIGURED: 'error.configuration',
  SYNC_CONFIG_SAVE_REQUIRED: 'error.configuration',
  SYNC_CONFIG_INVALID: 'error.configInvalid',
  SYNC_SELECTION_EMPTY: 'error.selection',
  SYNC_BUSY: 'error.busy',
  SYNC_LOCKED: 'error.locked',
  SYNC_SCOPE_CHANGED: 'error.scopeChanged',
  SYNC_CONFIG_NOT_AUTHORIZED: 'error.access',
  SYNC_CONFIG_REVOKED: 'error.scopeChanged',
  SYNC_PUSH_PREVIEW_REQUIRED: 'error.previewAgain',
  SYNC_PREVIEW_EXPIRED: 'error.previewAgain',
  SYNC_TARGET_CHANGED: 'error.previewAgain',
  SYNC_LOCAL_CHANGED: 'error.previewAgain',
  SYNC_REMOTE_CHANGED: 'error.previewAgain',
  SYNC_CREDENTIAL_PROVIDER_UNAVAILABLE: 'error.credentials',
  SYNC_CREDENTIAL_TIMEOUT: 'error.credentials',
  SYNC_SECRET_READ_FAILED: 'error.credentials',
  SYNC_SECRET_WRITE_FAILED: 'error.credentials',
  SYNC_GIT_FAILED: 'error.gitFailed',
  SYNC_GIT_PUSH_REJECTED: 'error.gitRejected',
  SYNC_GIT_BRANCH: 'error.gitBranch',
  SYNC_GIT_BUSY: 'error.gitBusy',
  SYNC_GIT_DIRTY: 'error.gitDirty',
  SYNC_GIT_WORKDIR: 'error.gitWorkdir',
  SYNC_GIT_TIMEOUT: 'error.gitTimeout',
  SYNC_GIT_UNAVAILABLE: 'error.gitUnavailable',
  GITHUB_NOT_AUTHORIZED: 'error.access',
  GITHUB_CREDENTIAL_WRITE_FAILED: 'error.credentials',
} as const;
/** Extract only known machine codes from an RPC envelope; never return its raw text. */
export function cloudSyncErrorCode(error: unknown): keyof typeof CLOUD_SYNC_ERROR_KEYS | undefined {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const tokens = new Set(text.split(/[^A-Z0-9_]+/u));
  return (Object.keys(CLOUD_SYNC_ERROR_KEYS) as Array<keyof typeof CLOUD_SYNC_ERROR_KEYS>).find(code => tokens.has(code));
}
export function cloudSyncErrorMessage(error: unknown, t: TranslateNS<'config-manager-sync'>): string {
  const code = cloudSyncErrorCode(error);
  return t(code ? CLOUD_SYNC_ERROR_KEYS[code] : 'error.requestFailed');
}
import { repoCreateBody } from '../../ui/sync-repository-picker.ts';
export interface RequestOptions { timeoutMs?: (number) | undefined; workDirDetail?: (boolean) | undefined; signal?: (AbortSignal) | undefined; timeoutKey?: (string) | undefined }
export type CloudSyncCall = (action: string, payload?: (unknown) | undefined) => Promise<unknown>;
export const SYNC_CREDENTIAL_REF = 'PASSWORDVAULT_SYNC_TOKEN';
export const SYNC_WEBDAV_CREDENTIAL_REF = 'PASSWORDVAULT_SYNC_WEBDAV_PASSWORD';
export type SyncTransportType = HostSyncTransportType;
export interface SyncStatusResponse {
  ok: boolean;
  /**
   * 方案 A：是否存在同步基线（本地祖先指针；宿主只回布尔，绝不回快照 id）。
   * **缺省 undefined = 未知 → 一律按「无基准」处理**，走老导入确认路径（fail-safe）。
   */
  hasBaseline?: (boolean) | undefined;
  /** 是否已保存过仓库/通道配置（sync-config.json；任一通道配置过即为 true） */
  configured: boolean;
  /** git 通道：已配置的仓库地址（不含 token，可回显；与当前通道无关，配置过即返回） */
  repoUrl?: (string) | undefined;
  /** git 通道：仓库内子目录前缀（'' / 缺省 = 仓库根；issue 131，供表单回填） */
  subdir?: (string) | undefined;
  /** git 通道：DSH credentials 中是否已存在 token（describe 只报状态，值永不返回） */
  credentialConfigured: boolean;
  credentialWritable: boolean;
  /** webdav 通道：配置状态（url 可回显，username 非敏感；password 值永不返回；
   *  与当前通道无关，配置过即返回，供 git ↔ webdav 切换时回填表单） */
  webdav?: (WebDavStatusResponse) | undefined;
  /**
   * 云端点通道 s3 的非密配置视图（**只有 secretStored 布尔，绝无 AccessKey Secret 值**）。
   * 配置过即返回（与当前活动通道无关），供表单在各通道间切换时回填。
   */
  s3?: (CloudS3ChannelView) | undefined;
  /** 云端点通道 gist 的非密配置视图（**只有 secretStored 布尔，绝无 token 值**）。 */
  gist?: (CloudGistChannelView) | undefined;
  /** 已保存的云端点 provider 清单（只有名字；切换 provider 时回填用） */
  cloudSavedProviders?: (string[]) | undefined;
  /** sync-state.lastSyncAt；'' = 从未同步 */
  lastSyncAt?: (string) | undefined;
  /** sync-state.sections 条目数 */
  sectionCount: number;
  transport?: ({ type: string; ref: string }) | undefined;
  /** 上次选择的同步通道（磁盘 ui-prefs.json；UI 回填优先于此，localStorage 仅兜底） */
  lastSyncChannel?: (SyncTransportType) | undefined;
  /** 可同步分区目录（「高级/自定义导出」勾选列表；host adapters 唯一事实源，只含 portable） */
  syncSections?: (SyncSectionInfo[]) | undefined;
  /** 当前分区选择（当前激活通道；UI 回填用，自动同步与手动 push 共用） */
  syncSelection?: (SyncSelectionPayload) | undefined;
  /** 全部通道的分区选择（git/webdav 各自独立；UI 按当前 tab 取对应通道） */
  syncSelectionByChannel?: (Record<SyncTransportType, SyncSelectionPayload>) | undefined;
  /** 全部通道的「同步密码是否已保存」状态（只回布尔，密码值永不回传浏览器） */
  syncCredentialsByChannel?: (Record<SyncTransportType, SyncPasswordState>) | undefined;
  /** 自动同步当前状态（当前激活通道；供 UI 顶部开关回填；§3.9） */
  autosync?: (AutosyncStatusResponse) | undefined;
  /** 全部通道的自动同步状态（git/webdav 各自独立；UI 按当前 tab 取对应通道） */
  autosyncByChannel?: (Record<SyncTransportType, AutosyncStatusResponse>) | undefined;
  /**
   * issue #79：git 工作副本与配置地址的关系（host 只读自检）。
   *  - `{ facts }` = 自检成功（origin 是否已跟随 repoUrl）
   *  - `{ error }` = 自检读不出来（git 不可用 / 工作副本异常）——**如实回传**，不伪装成「不存在」
   */
  workDir?: ({ facts: SyncWorkDirFacts } | { error: string }) | undefined;
}
export interface SyncWorkDirFacts {
  /** 工作副本路径 */
  path: string;
  /** `.git` 是否存在 */
  exists: boolean;
  /** 当前 origin（读不出 → null） */
  origin: string | null;
  /** 单独配置的 push URL（未单独配置 → null） */
  pushUrl: string | null;
  /** fetch / push 地址是否都已跟随 repoUrl */
  match: boolean;
  /** 未上行的本地提交数（仅 detail 自检时给出，否则 null） */
  ahead: number | null;
  /** 工作树是否有未提交改动（仅 detail 自检时给出，否则 null） */
  dirty: boolean | null;
  /** 远端分支上的快照数（仅 detail 自检时给出，否则 null；issue #104 建议 3） */
  remoteSnapshots: number | null;
}
export interface SyncPasswordState {
  /** 加密备份密码是否已保存到本机凭据库（DSH credentials） */
  encryptPasswordConfigured: boolean;
  /** 解密密码是否已保存到本机凭据库 */
  decryptPasswordConfigured: boolean;
}
export interface SyncSelectionPayload {
  /** 目标通道（git/webdav 各自独立的模式与勾选；缺省 git） */
  transport?: (SyncTransportType) | undefined;
  mode: 'default' | 'advanced';
  /** 高级模式勾选分区；default 模式可为空数组 */
  sections: SectionId[];
  /** sessions（历史会话）分区同步「最新 N 个会话」上限；缺省 5 */
  sessionsLimit?: (number) | undefined;
  /**
   * 显式点名的会话单元 id（非空时优先于 sessionsLimit；空数组 = 回到「最新 N 个」模式）。
   * 与导出选择器的单元 id 同一命名空间（sessions:<projectKey>/<sessionId>）。
   */
  sessionsInclude?: (string[]) | undefined;
  /** 手动推送默认加密快照（开关持久化；密码存 DSH credentials，见下） */
  encrypt?: (boolean) | undefined;
  /** 手动推送默认导出真实凭据值（必须同时 encrypt） */
  includeSecrets?: (boolean) | undefined;
  /**
   * 加密备份密码（可选）：非空 → 写入本机凭据库（DSH credentials）后长期复用。
   * 只走请求体内存传输，绝不写入同步文件 / 日志 / 响应。
   */
  encryptPassword?: (string) | undefined;
  /** 解密密码（可选）：非空 → 写入本机凭据库，拉取加密快照时自动使用 */
  decryptPassword?: (string) | undefined;
  /** 主动删除已保存的加密密码（用户取消勾选「加密备份」时） */
  clearEncryptPassword?: (boolean) | undefined;
  /** 主动删除已保存的解密密码（用户点「删除已保存密码」时） */
  clearDecryptPassword?: (boolean) | undefined;
  /** 响应/状态回填：密码是否已保存在本机凭据库（只回布尔，绝不回值） */
  encryptPasswordConfigured?: (boolean) | undefined;
  decryptPasswordConfigured?: (boolean) | undefined;
}
export interface WebDavStatusResponse {
  /** 上次使用的服务器地址（可回显；不含 userinfo） */
  url?: (string) | undefined;
  /** 上次使用的用户名（非敏感，可回显；供表单回填） */
  username?: (string) | undefined;
  /** 是否已填过用户名（布尔；便于 UI 提示徽章） */
  usernameConfigured: boolean;
  /** DSH credentials 中是否已存在密码（值永不返回） */
  passwordConfigured: boolean;
}
export interface SyncConfigSaveResponse {
  ok: boolean;
  configured: boolean;
  transport: SyncTransportType;
  /** git 通道：token 是否已配置（值永不返回） */
  credentialConfigured: boolean;
  /** webdav 通道：username/password 是否已配置（值永不返回；git 通道为 undefined） */
  webdav?: ({
    usernameConfigured: boolean;
    passwordConfigured: boolean;
  }) | undefined;
  /** 云端点通道保存后的非密视图（只带 secretStored 布尔，绝无密钥值） */
  s3?: (CloudS3ChannelView) | undefined;
  gist?: (CloudGistChannelView) | undefined;
}
export interface SyncChannelClearResponse {
  ok: boolean;
  /** 被断开的通道 */
  cleared: SyncTransportType;
  /** 该通道之前是否有配置（false = 本来就没配；幂等成功，不算失败） */
  removed: boolean;
  /** 断开后是否**还有**别的通道配置（false = 已无任何通道，页面应显示「未配置」） */
  configured: boolean;
  /** 断开后的活动通道（被删的是活动通道时已自动切到剩下的那条） */
  transport: SyncTransportType;
}
export interface SyncSectionInfo {
  id: SectionId;
  /** 展示名（host adapter displayName） */
  displayName: string;
  portability: 'portable' | 'deviceSpecific' | 'platformSpecific';
  defaultIncluded: boolean;
}
export interface SyncPushPayload {
  /** 通道类型；缺省 'git' */
  transport?: (SyncTransportType) | undefined;
  repoUrl?: (string) | undefined;
  token?: (string) | undefined;
  /** webdav 通道字段（transport='webdav' 时使用；扁平顶层） */
  url?: (string) | undefined;
  username?: (string) | undefined;
  password?: (string) | undefined;
  /** 仅同步指定分区（缺省 = 全部 portable 推荐分区；即「默认/快速导出」vs「自定义导出」） */
  sections?: (SectionId[]) | undefined;
  /**
   * sessions（历史会话）分区选项。**只有显式提供它**，sessions 才被允许进入同步通道；
   * limit = 只带「最新 N 个会话」（缺省 5；0 = 不带）。未提供 → 会话分区按普通
   * 非 portable 分区跳过并告警（安全默认：内容敏感的会话绝不悄悄随同步上行）。
   *
   * include（显式点名的会话单元 id，形如 sessions:<projectKey>/<sessionId>）非空时
   * **优先于 limit** —— 用户点名的对话必须赢（宿主侧见 SyncEngineOptions 的说明）。
   */
  sessions?: ({ limit?: (number) | undefined; include?: (string[]) | undefined }) | undefined;
  /** 加密快照（sections 载荷整体加密；开启时必须提供 encryptPassword） */
  encrypt?: (boolean) | undefined;
  /** 加密密码（仅本次请求体内存传输，Host 绝不落盘/落日志；encrypt=true 时必填） */
  encryptPassword?: (string) | undefined;
  /** 导出真实凭据值（必须同时 encrypt=true，否则 Host 拒绝：密钥绝不明文进同步通道） */
  includeSecrets?: (boolean) | undefined;
  /* ---------------- 云端点通道（s3 / gist）字段：与宿主 parseSyncBody 的扁平形状一致 ---------------- */
  /** s3：具体兼容商（s3 / oss / cos / minio / kodo） */
  provider?: (string) | undefined;
  endpoint?: (string) | undefined;
  region?: (string) | undefined;
  bucket?: (string) | undefined;
  /** 对象键前缀（缺省 = 根前缀） */
  prefix?: (string) | undefined;
  /** AccessKey ID（标识符，可回显；不是密钥） */
  accessKeyId?: (string) | undefined;
  /** path-style 寻址（缺省跟随兼容商变体） */
  pathStyle?: (boolean) | undefined;
  /** 显式覆盖签名方言（高级覆盖；宿主忽略非法值） */
  dialectId?: ('aws4' | 'oss4') | undefined;
  /** gist：目标 gist id */
  gistId?: (string) | undefined;
  /** gist：GitHub API 根（缺省 https://api.github.com） */
  apiBaseUrl?: (string) | undefined;
  /** gist：文件名前缀（缺省 dsh-sync） */
  filePrefix?: (string) | undefined;
  /**
   * 云端点密钥（s3 的 AccessKey Secret / gist 的 token）：**只写**。
   * 仅请求体内存传输；宿主写入 DSH credentials 槽位（cloudSecretRef）后即丢弃。
   * 响应、配置文件与日志里永远只有 `secretStored` 布尔。
   */
  secret?: (string) | undefined;
}
export interface SyncPullPayload extends SyncPushPayload {
  strategy?: ('merge' | 'replace' | 'skipExisting') | undefined;
  snapshotId?: (string) | undefined;
  /** 解密密码（拉取/一键同步遇到加密快照时提供；仅内存传输，绝不落盘） */
  decryptPassword?: (string) | undefined;
}
export interface SyncProbeSuccess {
  ok: true
  transport: string
  /** 结论（可直接展示的成功文案） */
  message: string
  /** 附加提醒（例如「该 S3 兼容端点应把 region 填成 xxx」），有值时界面按 warn 级展示 */
  hint?: (string) | undefined
  /** 远端已有快照数（取得时回传） */
  snapshotCount?: (number) | undefined
  /** 自检过程中**自动创建**的远端目录（webdav 幂等 MKCOL；界面须逐条说明，绝不静默写远端） */
  createdCollections?: (string[]) | undefined
}
export interface SyncProbeFailure {
  ok: false
  error: string
  /**
   * **能力边界标记**：该通道不提供连通性自检（传输层未实现 probe）。
   *
   * 与故障**严格区分**：true = 这个通道没有这项能力（中性提示，同步功能不受影响）；
   * 缺省/undefined = 真的没连通（按故障展示）。界面据此选 info 而不是「操作失败」。
   */
  unsupported?: (boolean) | undefined
}
export type SyncProbeResult = SyncProbeSuccess | SyncProbeFailure
export interface SyncSnapshotsListResponse {
  ok: boolean;
  /** 按 createdAt 倒序（最新在前） */
  snapshots: SyncSnapshotLite[];
  /** 当前本地祖先指针（sync-state.lastSnapshotId），用于高亮当前基线 */
  currentSnapshotId?: (string) | undefined;
  /**
   * 远端**存在但读不出来**的快照（issue #59）。
   *
   * 为什么必须回传：列表跳过坏文件是必要防御，但静默跳过会让「推送成功 + 列表为空」
   * 变成自相矛盾且无从自查的状态。有值即代表「远端列表不完整」，界面须如实告知。
   */
  unreadable?: ({ file: string; reason: string }[]) | undefined;
}
export interface SyncSnapshotLite {
  id: string;
  createdAt: string;
  sectionCount: number;
  platform: string;
  dshVersion: string;
  /**
   * cloud-sync 借鉴项 ⑥：推送方设备身份（宿主从快照 manifest 读出）。
   * **旧快照没有这两个字段** —— 界面必须据此不显示设备行，绝不把 undefined 渲染成文案、
   * 也不显示空串占位。
   */
  deviceName?: (string) | undefined;
  /** 稳定设备 id（换主机名/改机器名都不变；用于认出「同一台设备」）。 */
  deviceId?: (string) | undefined;
}
export interface SyncStartPayload extends SyncPushPayload {
  /** 缺省 = 最新快照；传入则对该历史快照拉取 */
  snapshotId?: (string) | undefined;
  /**
   * 会话格式处置（T1）。**一键同步显式传 `guide`**：差异确认弹窗是本流程唯一的决策界面，
   * 而预览发生在它出现之前 —— 用缺省 abort 会让用户什么都看不到就被拒。真正的阻断语义
   * 由 apply-items 上同名字段承担（此刻已有决策界面），服务端两处都会校验。
   */
  sessionFormatDisposition?: (SessionFormatDisposition) | undefined;
}
export interface SyncStartResponse {
  ok: boolean;
  /** 差异确认会话 id：后续 apply-items / cancel 引用 */
  syncSessionId: string;
  /** 被拉取的远端快照 id */
  snapshotId: string;
  items: SyncConfirmItem[];
  /** 是否包含任何需人工决策项 */
  needsReview: boolean;
  compatibility: 'excellent' | 'good' | 'partial' | 'unsupported';
  message?: (string) | undefined;
  /**
   * 预览失败的**结构化原因**（issue #116）：`'remote-empty'` = 远端还没有任何快照 —— 首次同步的正常起点，
   * UI 据此引导「先推送」而不是报「同步失败」。没有 reason 的失败按 message 原样展示。
   */
  reason?: ('remote-empty') | undefined;
}
export interface SyncConfirmItem {
  itemId: string;
  adapter: SectionId;
  kind: PlanItemKind;
  description: string;
  /** 变更详情（如插件「当前 1.1 vs 导入 1.6」），与导入恢复向导展示一致 */
  detail?: (string) | undefined;
  severity: 'info' | 'warning' | 'error';
  /** 默认采纳方向；Conflict/MissingSecret 等人工项默认 false */
  defaultAdopt: boolean;
  /** 用户最终决策（缺省 = defaultAdopt） */
  adopt: boolean;
  /** 冲突项内联解决所需详情（仅 Conflict 项非空） */
  conflict?: (SyncConflictDetail) | undefined;
  /** 该项若采用将写入的目标摘要 */
  target?: ({ adapter: SectionId; ref: string }) | undefined;
}
export interface SyncConflictDetail {
  path: string;
  kind: 'key' | 'file' | 'section';
  local?: (unknown) | undefined;
  remote?: (unknown) | undefined;
  ancestor?: (unknown) | undefined;
  diff?: (string) | undefined;
}
export interface ApplyItemsPayload {
  syncSessionId: string;
  /** 每项的最终采纳决策（未列出项视为 adopt=false） */
  adoptions: SyncItemAdoption[];
  /**
   * 会话格式处置（T1）。一键同步当前恒传 `guide`（确认页尚无三选一控件；服务端已按
   * `abort`/`skip`/`guide` 三态校验）。缺省（不传）由宿主按插件配置项 → abort 决定。
   */
  sessionFormatDisposition?: (SessionFormatDisposition) | undefined;
}
export interface SyncItemAdoption {
  itemId: string;
  adopt: boolean;
  /** 冲突项解决方案（仅当该项是 Conflict 且 adopt=true 时必须）。
   *  与导入恢复向导一致：keepLocal=保留当前 / useRemote=使用导入；跳过 = adopt=false。 */
  resolution?: ('useRemote' | 'keepLocal') | undefined;
}
export interface ApplyItemsResponse {
  ok: boolean;
  applied: string[];
  skipped: string[];
  needsRestart: boolean;
  warnings: string[];
  /** 应用前快照 id（UI 一键回滚用） */
  restoreId: string;
  /** 任一失败是否整体回滚 */
  rolledBack: boolean;
  failed: { itemId: string; message?: (string) | undefined }[];
  /**
   * 未生效项（issue #56）：`status='warning'` 的计划项 —— 非致命但确实没写进去
   * （典型：插件安装失败，而排在它后面的步骤因此不会执行）。
   * `ok` 不会因它变 false，所以界面必须单独拿这个字段把「部分成功」讲出来。
   * 旧宿主不返回 → undefined（按「无未生效项」处理，不误报）。
   */
  ineffective?: ({ itemId: string; adapter: string; message?: (string) | undefined }[]) | undefined;
  /**
   * 「整体回滚是否完整」（诚实性，2026-10）。`rolledBack=true` 只说「触发了整体回滚」，
   * 不代表每一项都补偿成功（典型：原本已存在的凭据值 DSH 不可回读 → 无法自动恢复）。
   * 此时引擎把失败项并入 `warnings`，并置 `rollbackFull=false`；界面据此**不得**
   * 显示成「已整体回滚」，必须列出未恢复项。
   * 旧宿主不返回 → undefined（按旧的「已整体回滚」文案处理，不误报）。
   */
  rollbackFull?: (boolean) | undefined;
  result: unknown;
}
export interface SyncRollbackResponse {
  ok: boolean;
  /** 是否**每一项**都补偿成功（false = 部分回滚，配置可能停留在中间状态） */
  full: boolean;
  /**
   * 未回滚项（full=false 时非空）。`reason` = 为什么没能恢复；`manualHint` = 人工怎么补
   * （如「请重新补录该凭据」）。旧宿主不返回 → undefined（按「无未回滚项」处理）。
   */
  failed?: (SyncRollbackFailedItem[]) | undefined;
  /** 同步历史写入失败（回滚本身已完成；仅提示） */
  historyWriteError?: (string) | undefined;
}
export interface SyncRollbackFailedItem {
  /** 形如 `<adapter>:<ref>` */
  item: string;
  reason: string;
  manualHint?: (string) | undefined;
}
export type MergeConflictReason =
  | 'both-modified'
  | 'modify-delete'
  | 'delete-modify'
  | 'no-ancestor'
  | 'binary'
  | 'format'
  | 'array'
  | 'section';
export type MergeSectionDecision = 'useRemote' | 'keepLocal' | 'merge' | 'skip' | 'conflict';
export interface MergePreviewConflict {
  /** 冲突位置：JSON 分区是 top-level key；FilesSection 是 relativePath。 */
  path: string;
  kind: 'key' | 'file';
  reason?: (MergeConflictReason) | undefined;
  localPreview: string;
  remotePreview: string;
  ancestorPreview: string;
}
export interface MergePreviewSection {
  id: SectionId;
  decision: MergeSectionDecision;
  /** 自动合并并入的变更点数量（仅自动合并成功时有意义） */
  autoMerged?: (number) | undefined;
  conflictCount: number;
  conflicts: MergePreviewConflict[];
}
export interface MergePreviewSummary {
  auto: number;
  review: number;
  conflicts: number;
  skipped: number;
}
export interface MergePreviewPayload {
  /** 远端快照 id；缺省 = 最新 */
  snapshotId?: (string) | undefined;
  /** 解密密码（仅当远端快照加密时使用；缺省 = 已保存的 DECRYPT 凭据） */
  decryptPassword?: (string) | undefined;
  /** 跨机路径映射（与一键同步同一口径） */
  pathMappings?: (PathMapping[]) | undefined;
}
export interface MergePreviewResponse {
  ok: boolean;
  snapshotId: string;
  /** 是否存在共同基准快照（false = 退化为两方比较，双侧不一致一律按冲突） */
  hasAncestor: boolean;
  sections: MergePreviewSection[];
  summary: MergePreviewSummary;
  /** 失败/降级原因（仅在 ok=false 等场景出现） */
  message?: (string) | undefined;
  /** 失败的结构化原因（issue 116）：`'remote-empty'` = 远端还没有任何快照 —— 首次同步的正常起点，不是故障。 */
  reason?: ('remote-empty') | undefined;
}
export type MergeResolutionActionWire = 'keepLocal' | 'useRemote' | 'useMerged' | 'skip';
export interface MergeResolution {
  id: string;
  action: MergeResolutionActionWire;
}
export interface MergeApplyPayload extends MergePreviewPayload {
  resolutions: MergeResolution[];
}
export interface MergeApplyResponse {
  ok: boolean;
  applied: string[];
  skipped: string[];
  needsRestart?: (boolean) | undefined;
  warnings: string[];
  /** 执行前快照 id（界面一键回滚用） */
  restoreId?: (string) | undefined;
  /** 任一失败是否整体回滚 */
  rolledBack?: (boolean) | undefined;
  /** 整体回滚是否完整（false = 有项未恢复，见 warnings；缺省 = 旧宿主未回传） */
  rollbackFull?: (boolean) | undefined;
  /** 执行后仍待裁决的分区（下次同步仍会出现） */
  pendingConflicts: SectionId[];
  failed?: ({ itemId: string; message?: (string) | undefined }[]) | undefined;
  ineffective?: ({ itemId: string; adapter: string; message?: (string) | undefined }[]) | undefined;
  historyWriteError?: (string) | undefined;
}
export type AutosyncInterval = '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h';
export type AutosyncRunStatus = 'success' | 'skipped' | 'failed' | 'partial';
export type AutosyncAutoApplyTier = 'low' | 'medium';
export type AutosyncConflictPolicy = 'ask' | 'local';
export interface AutosyncStatusResponse {
  enabled: boolean;
  interval: AutosyncInterval;
  /** 真·自动同步：本地改动即时触发（缺省 true；host 读取层已补缺省） */
  realtime?: (boolean) | undefined;
  /** realtime 下的远端轮询间隔（ms；缺省 60000） */
  remoteCheckMs?: (number) | undefined;
  /** 自动应用的最高风险等级（缺省 medium：plugins/mcp 也自动落盘） */
  autoApplyTier?: (AutosyncAutoApplyTier) | undefined;
  /** 双侧都改时的策略（缺省 local：保留本机并推上去） */
  conflictPolicy?: (AutosyncConflictPolicy) | undefined;
  lastRunAt?: (string) | undefined;
  lastRunStatus?: (AutosyncRunStatus) | undefined;
  lastRunMessage?: (string) | undefined;
  /**
   * issue #79：本轮跳过的**结构化原因码**（界面按码取字典，绝不渲染裸枚举）。
   * 取值与同步历史的 skipReason 同一套：conflict / mutation-locked / encrypted /
   * unconfigured / upToDate / unchanged。
   */
  lastRunSkipReason?: (string) | undefined;
  /** 跳过涉及的分区数（当前仅 conflict：远端另有 N 个分区待确认） */
  lastRunSkipCount?: (number) | undefined;
  consecutiveFailures: number;
  /** 距上次自动同步已过 ms（host 计算，供 UI 倒计时/立即触发判断） */
  elapsedMs: number;
  lastRunHistoryId?: (string) | undefined;
}
export interface AutosyncUpdatePayload {
  /** 目标通道（git/webdav 各自独立的开关/间隔/状态；缺省 git） */
  transport?: (SyncTransportType) | undefined;
  enabled: boolean;
  interval?: (AutosyncInterval) | undefined;
  startupMinIntervalMs?: (number) | undefined;
  /** 本地改动即时触发（缺省 true） */
  realtime?: (boolean) | undefined;
  /** realtime 下的远端轮询间隔（ms；宿主 clamp 到 15s–1h） */
  remoteCheckMs?: (number) | undefined;
  /** 自动应用等级（缺省 medium） */
  autoApplyTier?: (AutosyncAutoApplyTier) | undefined;
  /** 冲突策略（缺省 local） */
  conflictPolicy?: (AutosyncConflictPolicy) | undefined;
}
export interface AutosyncHistoryEntry {
  /** 触发该次运行的同步通道（git / webdav；旧记录缺省 undefined） */
  transport?: (SyncTransportType) | undefined;
  direction: 'pull' | 'push' | 'both';
  status: 'success' | 'skipped' | 'failed' | 'partial';
  /** 跳过原因（冲突项 / 缺失依赖 / Install / 错误 / 无远端 / 网络） */
  skipReason?: (string) | undefined;
  /** 被跳过的冲突分区 id（冲突跳过时列出） */
  conflictedSections?: (string[]) | undefined;
  /** 本次自动合并实际写入的分区 */
  appliedSections?: (string[]) | undefined;
  /** 本次 push 产生的快照 id */
  pushedSnapshotId?: (string) | undefined;
  /** 本次 pull 来源快照 id */
  pulledSnapshotId?: (string) | undefined;
  error?: (string) | undefined;
  notifiedAt?: (string) | undefined;
  /** 本次触发时的连续失败计数 */
  failureCountAtRun: number;
  createdAt: string;
}
export interface SyncHistoryEntry {
  id: string;
  createdAt: string;
  kind: 'push' | 'pull' | 'apply' | 'autosync' | 'rollback';
  sectionCount?: (number) | undefined;
  reviewCount?: (number) | undefined;
  /** 快照类条目的触发通道（git / webdav；旧快照缺省 undefined） */
  transport?: (string) | undefined;
  autosync?: (AutosyncHistoryEntry) | undefined;
}
export interface SyncHistoryResponse {
  entries: SyncHistoryEntry[];
}
export interface GithubDeviceFlowStartResponse {
  /** 随机 flowId：后续 poll/cancel 凭它引用宿主侧登记的 device_code */
  flowId: string;
  /** 一次性用户码（用户在 GitHub 授权页输入） */
  userCode: string;
  /** GitHub 授权页 URL（用户浏览器打开） */
  verificationUri: string;
  /** 设备码过期秒数 */
  expiresIn: number;
  /** GitHub 建议轮询间隔秒数 */
  interval: number;
}
export type GithubPollStatus = 'pending' | 'success' | 'denied' | 'expired' | 'error';
export interface GithubPollResponse {
  status: GithubPollStatus;
  /** pending：下次轮询前应等待的毫秒数 */
  pollDelayMs?: (number) | undefined;
  /** 终止态错误码（GitHub error code） */
  errorCode?: (string) | undefined;
  /** 终止态可展示消息（来自 GitHub error_description / 宿主文案，不含秘密） */
  message?: (string) | undefined;
  /** success 时恒 true（凭据已配置）；便于 UI 直接刷新状态 */
  credentialConfigured?: (boolean) | undefined;
}
export interface GithubValidateResponse {
  ok: boolean;
  /** token 是否存在于 DSH credentials */
  configured: boolean;
  /** token 是否有效（GitHub GET /user 成功；configured=false 时恒 false） */
  valid: boolean;
  /** GitHub 登录名（valid=true 时；非敏感展示位） */
  login?: (string) | undefined;
}
export interface GithubRepositorySummary {
  /** owner/name */
  fullName: string;
  /** 仓库主页（展示用） */
  htmlUrl: string;
  /** 提交值：clone URL（https 形态，不含凭据） */
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  fork: boolean;
  /** 最近一次 push（ISO 8601；空仓库 → 空串） */
  pushedAt: string;
  /** 最近一次更新（ISO 8601；缺字段 → 空串） */
  updatedAt: string;
}
export interface GithubRepositoriesResponse {
  ok: boolean;
  repos: GithubRepositorySummary[];
}
export interface GithubCreateRepositoryResponse {
  ok: boolean;
  repo: GithubRepositorySummary;
}
export class SyncApi {
  private readonly pushPlans = new Map<string, string>();
  private readonly mergePlans = new Map<string, string>();
  private channel(payload: unknown): string { if (payload !== null && typeof payload === 'object' && 'transport' in payload && typeof payload.transport === 'string') return payload.transport; return 'git'; }
  constructor(readonly t: UiT, private readonly call: CloudSyncCall) {}
  async status(opts: RequestOptions & { workDirDetail?: (boolean) | undefined } = {}): Promise<SyncStatusResponse> {
    return this.call('status', { ...opts, workDirDetail: opts.workDirDetail !== false }) as Promise<SyncStatusResponse>;
  }

  async workdirReset(payload: { mode: 'relink' | 'adopt' | 'reclone'; confirm?: (boolean) | undefined }): Promise<{ ok: boolean; mode: string; workDir: { facts: SyncWorkDirFacts } }> {
    return this.call('workdirReset', payload) as Promise<{ ok: boolean; mode: string; workDir: { facts: SyncWorkDirFacts } }>;
  }

  async probe(payload: SyncPushPayload): Promise<SyncProbeResult> {
    return this.call('probe', payload) as Promise<SyncProbeResult>;
  }

  async exportPreview(only?: (SectionId[]) | undefined): Promise<ExportPreviewResponse> {
    return this.call('exportPreview', { only }) as Promise<ExportPreviewResponse>;
  }

  async push(payload: SyncPushPayload, previewPlanId?: string): Promise<SyncPushReport> {
    const channel = this.channel(payload);
    const planId = previewPlanId ?? this.pushPlans.get(channel);
    if (this.pushPlans.get(channel) === planId) this.pushPlans.delete(channel);
    return this.call('push', { ...payload, ...(planId ? { planId } : {}) }) as Promise<SyncPushReport>;
  }

  async pushPreview(payload: SyncPushPayload): Promise<SyncPushPreview & { planId?: string | undefined }> {
    const result = await this.call('pushPreview', { ...payload, preview: true }) as SyncPushPreview & { planId?: (string) | undefined };
    if (result.planId) this.pushPlans.set(this.channel(payload), result.planId); else this.pushPlans.delete(this.channel(payload));
    return result;
  }

  async pull(payload: SyncPullPayload): Promise<SyncPullReport> {
    return this.call('pull', payload) as Promise<SyncPullReport>;
  }

  async download(payload: SyncPullPayload & { name?: (string) | undefined }): Promise<{ ok: boolean; zipPath: string; snapshotId: string }> {
    return this.call('download', payload) as Promise<{ ok: boolean; zipPath: string; snapshotId: string }>;
  }

  async deleteSnapshot(payload: SyncPushPayload & { snapshotId: string }): Promise<{ ok: boolean; snapshotId: string }> {
    return this.call('deleteSnapshot', payload) as Promise<{ ok: boolean; snapshotId: string }>;
  }

  async githubStart(): Promise<GithubDeviceFlowStartResponse> {
    return this.call('githubStart', undefined) as Promise<GithubDeviceFlowStartResponse>;
  }

  async githubPoll(flowId: string): Promise<GithubPollResponse> {
    return this.call('githubPoll', { flowId }) as Promise<GithubPollResponse>;
  }

  async githubCancel(flowId: string): Promise<{ ok: boolean }> {
    return this.call('githubCancel', { flowId }) as Promise<{ ok: boolean }>;
  }

  async githubValidate(): Promise<GithubValidateResponse> {
    return this.call('githubValidate', undefined) as Promise<GithubValidateResponse>;
  }

  async githubListRepositories(): Promise<GithubRepositoriesResponse> {
    return this.call('githubListRepositories', undefined) as Promise<GithubRepositoriesResponse>;
  }

  async githubCreateRepository(name: string, description = ''): Promise<GithubCreateRepositoryResponse> {
    return this.call('githubCreateRepository', { ...repoCreateBody(name, description), private: true }) as Promise<GithubCreateRepositoryResponse>;
  }

  async history(): Promise<SyncHistoryResponse> {
    return this.call('history', undefined) as Promise<SyncHistoryResponse>;
  }

  async snapshotsList(payload: SyncPushPayload): Promise<SyncSnapshotsListResponse> {
    return this.call('snapshotsList', payload) as Promise<SyncSnapshotsListResponse>;
  }

  async sync(payload: SyncStartPayload): Promise<SyncStartResponse> {
    return this.call('sync', payload) as Promise<SyncStartResponse>;
  }

  async applyItems(payload: ApplyItemsPayload): Promise<ApplyItemsResponse> {
    return this.call('applyItems', payload) as Promise<ApplyItemsResponse>;
  }

  async cancel(syncSessionId: string): Promise<{ ok: boolean }> {
    return this.call('cancel', { syncSessionId }) as Promise<{ ok: boolean }>;
  }

  async autosyncStatusAll(): Promise<Record<SyncTransportType, AutosyncStatusResponse>> {
    return this.call('autosyncStatusAll', undefined) as Promise<Record<SyncTransportType, AutosyncStatusResponse>>;
  }

  async autosyncStatus(transport: SyncTransportType = 'git'): Promise<AutosyncStatusResponse> {
    return this.call('autosyncStatus', { transport }) as Promise<AutosyncStatusResponse>;
  }

  async autosyncUpdate(payload: AutosyncUpdatePayload): Promise<AutosyncStatusResponse> {
    return this.call('autosyncUpdate', payload) as Promise<AutosyncStatusResponse>;
  }

  async saveSelection(payload: SyncSelectionPayload): Promise<SyncSelectionPayload> {
    return this.call('saveSelection', payload) as Promise<SyncSelectionPayload>;
  }

  async saveConfig(payload: SyncPushPayload): Promise<SyncConfigSaveResponse> {
    return this.call('saveConfig', payload) as Promise<SyncConfigSaveResponse>;
  }

  async clearChannel(channel: SyncTransportType): Promise<SyncChannelClearResponse> {
    return this.call('clearChannel', { transport: channel, clear: true }) as Promise<SyncChannelClearResponse>;
  }

  async saveUiPrefs(payload: { lastSyncChannel?: (SyncTransportType) | undefined }): Promise<{ ok: boolean; lastSyncChannel?: (SyncTransportType) | undefined }> {
    return this.call('saveUiPrefs', payload) as Promise<{ ok: boolean; lastSyncChannel?: (SyncTransportType) | undefined }>;
  }

  async rollback(payload: { restoreId: string }): Promise<SyncRollbackResponse> {
    return this.call('rollback', payload) as Promise<SyncRollbackResponse>;
  }

  async mergePreview(payload: MergePreviewPayload = {}): Promise<MergePreviewResponse> {
    const result = await this.call('mergePreview', payload) as MergePreviewResponse & { planId?: (string) | undefined };
    if (result.planId) this.mergePlans.set(this.channel(payload), result.planId); else this.mergePlans.delete(this.channel(payload));
    return result;
  }

  async applyMerge(payload: MergeApplyPayload): Promise<MergeApplyResponse> {
    const channel = this.channel(payload);
    const planId = this.mergePlans.get(channel); this.mergePlans.delete(channel);
    return this.call('applyMerge', { ...payload, ...(planId ? { planId } : {}) }) as Promise<MergeApplyResponse>;
  }

  async consult(input: { type: 'remote-snapshot'; id: string; snapshotId?: (string) | undefined; transport?: SyncTransportType }): Promise<ConsultReport> {
    return this.call('consult', input) as Promise<ConsultReport>;
  }
}
