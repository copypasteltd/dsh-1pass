/** SPDX-License-Identifier: MIT
 * Copyright (c) 2026 xiajiajun516
 * Derived from dsh-config-manager 0.8.2, commit 635c2e66388c9ec5929071d05e01abd77779366d.
 * Full MIT permission and warranty notice: vendor/config-manager/LICENSE.
 * Vault adapter: no config-manager HTTP or host I/O.
 */
import type { SectionId, Manifest } from '../schema/types.ts';
export type TombstoneKind = 'session' | 'workspace';
export interface ExportUnit {
  /** 全局唯一 id（`<section>:<单元路径>` / `plugin:<包名>` / `workspace:<id>` …） */
  id: string;
  /** 展示名（包名 / 目录名 / 工作区标题） */
  label: string;
  /** 副标题补充（版本 / 绝对路径等自行格式化的信息；**不要放 UI 文案模板**，文案由 i18n 负责） */
  detail?: (string) | undefined;
  /** 成员文件数（文件类单元用；UI 据此渲染「N 个文件」） */
  fileCount?: (number) | undefined;
  /** 单元体积（字节；文件类 = 成员文件合计） */
  sizeBytes: number;
  /** 原子组：必须与本单元同进同出的其它单元 id（如 pnpm-workspace.yaml ↔ patch 文件） */
  lockedWith?: (string[]) | undefined;
  /**
   * 本单元**拥有的会话 id**（工作区单元专用；issue #45）。
   *
   * 用途：勾选联动 —— 勾了会话就自动勾上它所属的工作区，取消工作区就取消它的会话。
   * 取值 = 工作区记录 sessionIds 原样（`session-<uuid>` 形态，与会话单元 id 的末段目录名归一化后配对），
   * 不翻译路径（跨机时路径不可靠）。
   */
  sessionIds?: (string[]) | undefined;
  /**
   * 本单元 **path 的 cwd 目录键**（`projectKeyOf(path)`；工作区单元专用；issue #45）。
   *
   * 为什么需要第二判据：DSH 的 `sessionIds` **只登记了一部分会话**（真机实测：一次可选择 570 条会话里
   * 只有 23 条落在 sessionIds 内），而 DSH 自己按「会话 cwd 的目录键 == 工作区 path 的目录键」把会话显示在
   * 工作区下。勾选联动必须与**显示口径**一致，否则用户在界面上看到对话挂在某工作区下、勾它却不联动。
   */
  projectKey?: (string) | undefined;
  /**
   * 分组名（同分区内的二级分组；如 sessions 按工作区聚合——用户要求「按工作区分类对话」）。
   *
   * 语义：**纯展示层分组**，不参与勾选/导出契约（契约只认 id）。缺省 = 该单元按现有方式
   * 平铺渲染（skills / pluginFiles 等分区行为逐像素不变）。分组名是宿主直出的原始字符串
   * （工作区标题 / 项目键），UI 渲染前同样要过 redact()。
   */
  group?: (string) | undefined;
  /**
   * 父对话的会话裸键（`sessionIdKey(目录名)`；**只有 `origin='subagent'` 的子代理会话才有值**）。
   *
   * 用途：导出选择器里的「父 ↔ 子会话」勾选联动（勾父自动勾上它的子代理会话；勾子自动带上父）。
   * 为什么必须由宿主下发：父子关系只存在于 DSH 的会话存储里（`SessionStoreFacade.parentRelations()`），
   * 浏览器侧无从推断 —— 不下发时联动静默失效，界面勾选与包内容就会不一致（用户实测：勾 2 条、
   * 包里 41 条）。非 sessions 分区 / 非子代理会话一律不设该字段（不猜）。
   */
  parentSessionId?: (string) | undefined;
  /**
   * 空白会话（**从未提问过**；只有 sessions 分区的单元可能有值）。
   *
   * 用途：DSH 自己给这类会话的标题就是本地化的「新会话」（`session.new`），没有标题可显示。
   * 只下发**事实**，不下发文案 —— 界面按当前语言显示（与 DSH 同口径），绝不用 uuid 冒充标题。
   */
  blank?: (boolean) | undefined;
  /**
   * 该插件**声明的第三方数据区域**（只有 \`plugin:<包名>\` 单元可能有值；导出选择器「按插件看」用）。
   *
   * 用途：选择器要在**不读任何数据目录**的前提下画出「插件 → 数据目录 / 大文件」的树骨架 ——
   * 区域清单来自来源注册表（内置来源表 + 插件自述 dsh.dataDirs），是静态知识，零额外 I/O；
   * 体积与「实际有没有内容」等该分区的清单到货后再填。
   *
   * 语义：**纯展示**，不参与勾选/导出契约（契约只认 id）。这里是「注册表说它应该在哪儿」，
   * **不是**「磁盘上确实有」—— 界面必须把两者分开渲染（unread / 无内容 / 已读到）。
   */
  relatedAreas?: (readonly PluginAreaRef[]) | undefined;
}
export interface PluginAreaRef {
  section: 'pluginData' | 'pluginAssets';
  /** home 相对 POSIX 路径 —— 就是该分区单元的 id 后缀（\`pluginData:.mnemon/runtime\` 的末段） */
  relPath: string;
  role: 'config' | 'assets';
}
export interface SensitiveHit { path: string; field: string; }
export interface SecretScanner {
  /** 递归扫描 + 剥离敏感字段值；返回清洗后的数据与命中清单（不泄值） */
  scanAndRedact(data: unknown): { sanitized: unknown; hits: SensitiveHit[] };
  /** 文本级扫描（文件类分区内容），供强化版使用 */
  scanText?(text: string): SensitiveHit[];
}
export type PlanItemKind =
  | 'Create' | 'Update' | 'Skip' | 'Conflict' | 'Install'
  | 'MissingSecret' | 'MissingDependency' | 'PathMapping' | 'Warning' | 'Error';
export type ItemResolution = 'keepCurrent' | 'useImported' | 'review';
export type GlobalConflictStrategy = 'merge' | 'replace' | 'skipExisting';
export type SessionFormatDisposition = 'abort' | 'skip' | 'guide';
export interface ConflictDecision { itemId: string; resolution: ItemResolution; }
export interface PathMapping {
  oldPrefix: string;
  newPrefix: string;
  appliesTo: ('workspaces' | 'mcp' | 'pluginConfig' | 'skills')[];
}
export interface PathIssue {
  kind: 'missing' | 'platformMismatch' | 'homeMismatch';
  value: string;
  mappedTo?: (string) | undefined;
  /**
   * 这条路径来自哪个分区（目前只有 workspaces / mcp 会被探测出路径问题）。
   *
   * 为什么要有它：导入向导的路径映射页必须**只问这次真的会写盘的路径** ——
   * 用户没勾「工作区」时不该被要求为工作区路径指定新位置（真机反馈：明明没选工作区，
   * 却被列了 7 条工作区路径）。core 只负责如实标注来源，是否要问由调用方结合本次选择决定。
   * 缺省 = 来源未知（旧宿主未回传该字段）→ 调用方按「保守显示」处理。
   */
  section?: (SectionId) | undefined;
}
export interface SnapshotTarget {
  adapter: SectionId;
  ref: string;
  /**
   * patch 行类目标的**所在层**（相对 homeDir 的 POSIX 路径，见 core/patch-layers.ts）。
   *
   * 为什么必须带上：patch 行有两层（home 层 + profile 层），同一 `ref`（lineId）在两层的
   * 原值不同、写入位置也不同。缺省 = 用户层（`cordis.patch.yml`），保持旧调用方行为不变。
   */
  file?: (string) | undefined;
}
export interface PlanItem {
  id: string;                 // 稳定项 id（plugin:pkg / prompt:name / workspace:<id> …）
  /**
   * 「最小可拆单元」id（Phase 2 条目级导入选择，可选）。
   *
   * 为什么需要它：导入选择器不能按裸计划项勾选 —— skills/sessions 的计划项是**逐文件**的
   * （`skills:bar/SKILL.md`、`skills:bar/ref.md`），而用户心智里是一个技能/一次会话。
   * 由适配器用与导出侧 `listUnits()` **同一套** unitIdOf 规则声明单元 id，两端因此自动对齐
   * （排除 `skills:bar` 即排除其全部成员项），UI 无需猜前缀。
   *
   * 缺省 = 本项自身即一个单元（插件包、工作区记录、patch 行等）。
   */
  unitId?: (string) | undefined;
  /**
   * 单元的**展示名**（可选；宿主在计划生成后填充，如 sessions 的「会话标题」）。
   *
   * 为什么由宿主填：会话标题在 DSH 自己的存储里（`$DSH_HOME/storages/session_projcache.json`），
   * 引擎看不到也不该猜。缺省 = UI 退回用单元 id（会话目录名）显示 —— 用户实测「导入页只显示
   * 文件名」就是这个缺省态。纯展示字段：不参与勾选/执行契约。
   */
  label?: (string) | undefined;
  /** 单元的**二级分组名**（可选，同 `/export-preview` 的 `ExportUnit.group` 语义；纯展示）。 */
  group?: (string) | undefined;
  /** 空白会话（从未提问；同 `ExportUnit.blank`，只下发事实、文案由界面本地化）。 */
  blank?: (boolean) | undefined;
  /** 本项对应的**工作区记录拥有的会话 id**（工作区计划项专用；issue #45 勾选联动）。 */
  sessionIds?: (string[]) | undefined;
  /** 本工作区计划项 **path 的 cwd 目录键**（`projectKeyOf(path)`；issue #45 勾选联动第二判据）。 */
  projectKey?: (string) | undefined;
  kind: PlanItemKind;
  adapter: SectionId;
  description: string;
  detail?: (string) | undefined;
  severity: 'info' | 'warning' | 'error';
  /**
   * 本项对应的会话单元**本机读不了**（格式版本高于本机 DSH 支持的版本）。
   *
   * 语义：DSH 读会话时对非本 build 的 `header.version` 直接拒绝，而会话列表静默跳过
   * → 这一项即使写入成功，用户在 DSH 里也看不到这条对话。UI 据此提供「中止 / 跳过 / 引导升级」。
   */
  formatUnsupported?: ({ version: number; target: number }) | undefined;
  conflict?: (ConflictDecision) | undefined;
  pathMapping?: (PathMapping) | undefined;
  missingDependency?: (string) | undefined;
  target?: (SnapshotTarget) | undefined;    // 该项将修改的目标（快照登记用）
}
export interface ImportAnalysis {
  valid: boolean;
  errors: string[];
  warnings: string[];
  compatibility: 'excellent' | 'good' | 'partial' | 'unsupported';
  /**
   * 兼容性判定的**结构化原因**（可选；旧调用方缺省即不展示 —— 界面按原因解释评分，
   * 见 `CompatibilityReason`）。与 `compatibility` 同源，永不单独维护。
   */
  compatibilityReasons?: (CompatibilityReason[]) | undefined;
  /**
   * 备份侧事实（可选）：来源 DSH 版本 / 平台 / schema 版本。
   * 界面用它解释「为什么是部分兼容」（例如跨平台、来源更旧/更新）。
   */
  source?: ({ dshVersion: string; platform: string; schemaVersion: number }) | undefined;
  /** 本机侧对照（可选）：当前 DSH 版本 / 平台。与 `source` 成对展示，缺省则界面不显示对照行。 */
  target?: ({ dshVersion: string; platform: string }) | undefined;
  sectionsInZip: SectionId[];
  /**
   * 备份 manifest 声明启用、但**本版本不认识**的分区 id（不在 `SECTION_IDS` 中）。
   *
   * 语义（G-01/G-02/G-03）：这些分区的数据被跳过、未导入，且**绝不**计入
   * `missingSections` —— 它们并非「备份声明了但文件缺失」，而是「本插件不认识」。
   *
   * 当前用户可见路径是 `warnings` 里的文案键 `import.unsupportedSections`
   * （`ImportWizardView` 直接渲染 `analysis.warnings`）；本字段供第三方实现者与
   * 后续 UI 做结构化展示（例如把「未知分区」与「版本过高」分列）。**尚无 UI 消费点。**
   */
  unsupportedSections: string[];
  /**
   * 已知分区、但其数据 `version` **高于**本版本支持的 1 → 该分区已被跳过（G-05）。
   *
   * 与 `unsupportedSections` 的区别：那个是「本插件不认识这个分区」，这个是
   * 「认识这个分区，但它来自更新的格式」。两者都只告警、不阻断整个 bundle。
   *
   * 当前用户可见路径是 `warnings` 里的文案键 `import.unsupportedSectionVersion`；
   * 本字段供第三方实现者与后续 UI 与 `unsupportedSections` 分列展示。**尚无 UI 消费点。**
   */
  unsupportedVersions: { section: SectionId; version: number }[];
  pluginSummary: { installed: number; toInstall: number };
  pathIssues: PathIssue[];
  secretCount: number;
  dependencyIssues: { item: string; dependency: string }[];
  /** 备份是否加密（manifest.security.encrypted）：加密备份的凭据必须用解密密码恢复 */
  encrypted: boolean;
  /**
   * 会话格式体检摘要（可选；宿主未注入探针 / 本机版本解析不到时为 undefined）。
   *
   * `unreadable` 只含**明确判定读不了**的会话单元（version > 本机支持版本）；
   * `target` 为 null 表示本机版本无法判定（此时不猜、不判读不了）。
   */
  sessionFormats?: ({
    target: number | null;
    unreadable: { unitId: string; version: number }[];
    sampled: number;
    skipped: number;
  }) | undefined;
  /**
   * 凭据可恢复性摘要（issue #39 Feature 2；**可选字段**，旧调用方零改动）。
   *
   * 目的：让宿主不必自己解开 `security/secrets.enc` 再解析 `.credentials.yaml` 才能
   * 判断「包里的凭据能不能自动回填」（那等于把 `.credentials.yaml` 的布局知识复制到
   * 每个宿主，正是 issue #39 的坑）。**只回传 ref 名，永远不回传任何值。**
   *
   *  - `inArchive`：归档声明携带真实凭据值（`manifest.security.containsSecrets`）；
   *  - `refs`：本次分析**实际解出**的凭据 ref 名（宿主未提供解密结果时为 `[]`；
   *    即「包含密码」这一前提不具备时，只能给出 `inArchive=true` 而不能给出名字）；
   *  - `satisfied`：`refs` 中**本机已配置**的子集（无需回填、也无需人工补录）。
   */
  credentials?: ({ inArchive: boolean; refs: string[]; satisfied: string[] }) | undefined;
}
export interface ImportPlan {
  items: PlanItem[];
  globalStrategy: GlobalConflictStrategy;
  pathMappings: PathMapping[];
  /**
   * 本次**自动**加入的基础路径重定基规则（导出机 DSH home → 本机 DSH home；issue #45）。
   *
   * 只读展示用：它已被并入 pathMappings（排在最前，用户映射随后生效）。缺省 = 两边基础路径相同
   * 或旧包没带 sourceHome（此时不做任何自动改写，行为与改造前一致）。
   */
  automaticMappings?: (PathMapping[]) | undefined;
  missingSecrets: { ref: string; required: boolean }[];
  needsRestart: boolean;
  estimatedActions: Record<SectionId, number>;
  /** F4：被删除墓碑（tombstone）过滤掉的计划项（缺省/空数组 = 无过滤；UI 据此提示用户） */
  skippedTombstoned?: (SkippedTombstone[]) | undefined;
}
export interface SkippedTombstone {
  kind: TombstoneKind;
  id: string;
  adapter: SectionId;
}
export interface ExecutedItem {
  itemId: string;
  /** warning = 未应用但非致命（目标不可达等），不计入失败、不触发回滚 */
  status: 'ok' | 'skipped' | 'warning' | 'failed';
  message?: (string) | undefined;
  /** 用户主动跳过（导入中点击「跳过当前插件」）：status 为 skipped 且此标记为 true。
   * 结果页据此区分「用户跳过」与「引擎跳过」，并提供重试入口。 */
  skippedByUser?: (boolean) | undefined;
}
export interface ImportIneffectiveItem {
  /** 计划项 id（含收尾项 `<adapter>:finalizeImport`） */
  itemId: string;
  /** 分区/步骤分类（展示用） */
  adapter: string;
  /** 如实原因（已含可复制的手动修复提示） */
  message?: (string) | undefined;
}
export interface ImportResult {
  ok: boolean;
  executed: ExecutedItem[];
  needsRestart: boolean;
  missingSecrets: string[];
  warnings: string[];
  rollback: RollbackReport | null;
  snapshotId: string | null;
  /**
   * 未生效项（status='warning'；字段只增不改，旧调用方忽略即可）。
   *
   * 与 `ok` 的关系：**不改变** ok 语义（warning 仍不算失败、不触发回滚）——
   * 这里只是把「部分成功」从「一串文字」升级为「可判定的结论」。
   * 空数组时省略该字段（旧行为逐字节不变）。
   */
  ineffective?: (ImportIneffectiveItem[]) | undefined;
  /** F4：本次导入被删除墓碑过滤掉的条目（缺省/空 = 无过滤；UI 据此提示用户） */
  skippedTombstoned?: (SkippedTombstone[]) | undefined;
  /**
   * issue #39：本次导入**从加密归档内解出并回填本机**的凭据条数（字段只增不改）。
   * 缺省 = 未经归档恢复（普通备份 / 用户手工补录），此时不出现该字段。
   * 只回传条数，绝不回传 ref 名或值——结果会进 run 账并回传浏览器。
   */
  credentialsRestored?: (number) | undefined;
  /**
   * 用户在运行中心终止了本次导入（宿主 /runs/cancel 在**计划项边界**协作式取消）。
   * true 时 executed 只覆盖已尝试的项，且 keptPartial 表明用户如何处置已应用部分。
   */
  cancelled?: (boolean) | undefined;
  /**
   * 终止时用户选择「保留已应用项」（cancelled=true 时才有意义）。
   * 保留 = 在安全点停下 + 跑完分区收尾 + 未执行项在 journal 里显式标 skipped。
   * 此时快照**保持可用**（不标 done / 不标 rolled-back），用户可事后在「备份」页手动回滚。
   */
  keptPartial?: (boolean) | undefined;
  /**
   * keptPartial=true 时的启动自洽审计结论（缺省 = 未审计，UI 必须如实说「未验证」）。
   * 字段只增不改：旧客户端忽略它即可。
   */
  bootSafety?: ({
    verdict: 'safe' | 'repaired' | 'unsafe';
    issues: { id: string; severity: 'warn' | 'error'; detail: string; fixed: boolean }[];
    prunedBundles: { name: string; reason: string }[];
    unchecked: string[];
  }) | undefined;
}
export interface RollbackReport {
  full: boolean;
  restored: string[];
  failed: { item: string; reason: string; manualHint?: (string) | undefined }[];
}
export type CompatibilityReason =
  | { kind: 'schemaUnsupported'; schemaVersion: number }
  | { kind: 'crossPlatform'; sourcePlatform: string; targetPlatform: string }
  | { kind: 'missingSections'; sections: SectionId[] }
  | { kind: 'sourceNewer'; sourceDsh: string; targetDsh: string }
  | { kind: 'sourceOlder'; sourceDsh: string; targetDsh: string };
export interface ExportReport {
  included: { section: SectionId; counts: Record<string, number> }[];
  excluded: SectionId[];
  security: {
    secretsExcluded: boolean;
    containsSecrets: boolean;
    encrypted: boolean;
    redactedHits: number;
    /** 本次导出镜像到本机 vault 的敏感文件数（文件级 vault；0 或缺失 = 未镜像） */
    vaultRefreshed?: (number) | undefined;
  };
  file: { name: string; sizeBytes: number };
  warnings: string[];
}
export type Portability = 'portable' | 'deviceSpecific' | 'platformSpecific';
