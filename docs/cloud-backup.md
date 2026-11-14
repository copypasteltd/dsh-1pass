# 加密云备份 / Encrypted cloud backups

本功能是由当前 DSH 主机上传的**加密保险库文件快照**，不是托管式云密码管理服务，也不是多设备双向同步。默认关闭。无需引入云厂商 SDK。

## 使用入口

构建并安装当前 checkout 后，打开 **设置 → 凭据库 → 备份 → 加密云备份**。每个命名库独立配置，最多 8 个目标：

- GitHub：已初始化分支的**私有仓库**，通过 Contents API 写入。
- S3：AWS S3 或兼容服务，使用 AWS Signature V4。
- R2：Cloudflare R2 S3 API，签名区域自动采用 auto。
- OSS：阿里云 OSS **原生 V4 签名**，不是把 OSS 当作 AWS S3。

先在运行 DSH 的服务环境设置访问凭证，再在界面中填写它们的**环境变量名**。不要把令牌、Access Key、Secret Key 的实际值填进界面、模型消息、Git 配置或本文档。环境变量需要由 DSH 服务继承；设置后通常需重启服务。

配置仅保存环境变量名称、目标地址、调度参数。不会把凭证值送回浏览器或写进配置。配置位于库目录下隐藏的 .cloud-backup 子目录，按库文件绝对路径散列区分；重命名会迁移本地配置，删除库会撤销对应的本地自动备份授权。**删除目标或库不会删除远端备份。**

## GitHub 设置

1. 预先创建一个专用私有仓库，至少提交一次 README 以初始化目标分支。
2. 创建只允许访问该仓库的 fine-grained PAT，授予 Contents read/write；仓库元信息必须可读。
3. 在 DSH 服务环境中设置一个变量，例如 DSH_VAULT_GITHUB_TOKEN（值不写入本文）。
4. 添加 GitHub 目标，填写 owner、repo、已存在的 branch、非空目录前缀，以及变量名。

每次上传前重新检查仓库 private=true，不缓存私有状态。只支持 github.com 公共 API，暂不支持 GitHub Enterprise 自定义 API 地址。

**Git 历史限制**：保留策略只删除当前分支目录中的旧快照；旧提交仍可能保存原加密数据。仓库也可能被之后改成公开。请保持私有、限制令牌范围；需要彻底擦除历史时应按 GitHub 的流程单独处理，不要认为“保留 10 份”等于历史只剩 10 份。高频写入会产生提交并消耗 API 配额，GitHub 目标建议只启用间隔备份。

## S3 / R2 / OSS 设置

| 类型 | Endpoint 示例（区域 API origin，不含 bucket/path） | Region | 寻址 |
|---|---|---|---|
| AWS S3 | https://s3.us-east-1.amazonaws.com | us-east-1 | 通常 virtual-host；需要时开启 path-style |
| Cloudflare R2 | https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com | auto | 按服务支持选择；path-style 通常适用 |
| 阿里云 OSS | https://oss-cn-hangzhou.aliyuncs.com | cn-hangzhou | 推荐 virtual-host，勿把 bucket 重复写进 endpoint |

填写 bucket、远端目录前缀、Access Key ID 环境变量名、Secret Access Key 环境变量名。临时凭证还需 Session Token 的环境变量名。R2 为该 bucket 的 S3 API credentials，不是普通 Cloudflare 管理 API token。

权限至少包括：在指定 bucket/prefix 下上传对象；列出该前缀对象；删除该前缀对象以执行保留策略。AWS 常见权限为 s3:PutObject、s3:ListBucket（prefix 限制）、s3:DeleteObject。使用私有 bucket 并启用账户/桶的 public-access block；本插件不会替你创建桶或修改 ACL。

只接受 HTTPS origin，不允许 URL 内凭证、预签名 URL、查询参数、片段或额外路径，不跟随重定向。拒绝 localhost、常见元数据地址和私网字面 IP。**自定义域名的 DNS/路由仍由部署者信任**，并未进行 DNS 固定或提供网络沙箱；请只配置由你控制的对象存储服务，不要接收不可信来源给出的 endpoint。

## 自动触发与状态

- 启用开关默认为关闭；填写配置不会上传，显式保存开启的配置才授权后续自动上传。
- 写入触发：成功保存加密库后合并约 2 秒内的写入，覆盖模型工具、GUI 及导入等共用存储层的路径；备份过程中有新写入会安排后续一次上传。
- 间隔触发：0 表示关闭，否则 5–10080 分钟。间隔从加载配置/上一次任务结束开始计算，不是系统 cron；停机时不执行，不追补停机期间每个时点。
- 重启时恢复配置库和同目录已有命名库的间隔任务；新库在访问/写入后注册。
- **DSH 主机必须运行**；不用保持浏览器页面打开。外部程序直接修改库文件不会产生本进程通知，但下一次间隔备份会读取最新加密文件。
- 只读模式暂停上传。设置和手动上传需库解锁；已授权的后台任务可以在锁库期间复制**已加密文件**，不会为备份自动解锁。
- 点击“立即上传加密快照”只使用已保存配置，能重试失败目标；各目标结果独立，单个失败不会影响其他目标，也不会让本地条目保存失败。
- 显示运行中、各目标上次成功/失败、保留策略警告、下次间隔时间。状态在当前进程内保存，重启后重置；配置持久化。
- 没有无限自动重试循环；失败后等待下一次写入/间隔，或手动重试。HTTP 每次有 20 秒限时，单轮任务有 120 秒预算。关闭/修改配置或卸载插件会中止当前请求并清理定时器。

## 快照与保留策略

只读取库文件本身，不上传目录、环境变量、主密码、云配置、明文导出或审计旁车。数据上传前检查严格的加密信封结构；不会把任意 JSON 当作备份。条目 UUID、KDF 参数和条目数量属于库格式元数据，远端仍能观察快照大小与时间。

路径使用配置前缀 + 由库 KDF 盐散列得到的不透明命名空间 + 唯一时间戳文件名，不使用条目标题或本地绝对路径。重命名库保持远端命名空间；重新派生 KDF/rekey 会产生新命名空间，旧命名空间不会自动清理。

每个目标、每个命名空间保留 1–100 份快照。只有完全列举后，才删除本命名空间内严格符合本插件文件名规则的旧快照，不处理其他对象。远端列表超过安全上限（对象存储最多 10 页；GitHub Contents 目录 1000 条上限）会跳过清理并显示警告。单轮最多删除 100 份，后续需再次备份或自行清理。

上传成功但清理失败，会标为成功并附警告，而不是要求重复上传。对象存储开启 versioning/软删除后，删除可能只是增加 delete marker，历史版本需要单独设置生命周期；本插件不保证物理擦除。

原始快照上限 20 MiB；GitHub 还有包含 base64 的请求体 20 MiB 限制，因此可接受原文件约 15 MiB。较大附件会增加库体积，超限会拒绝上传，不会分割或上传明文。

## 恢复流程

当前新增功能负责**上传与保留**，不提供从云端浏览/一键下载恢复。恢复时：

1. 用 GitHub 或云存储控制台下载所需快照，保留原始字节。
2. 在隔离目录保留当前库副本，不覆盖唯一一份数据。
3. 用该快照对应的主密码打开该 JSON，或复制到新的库路径后通过插件/CLI 读取。
4. 核对条目后再切换正式路径；不要把 JSON 作为明文导入。

这些远端快照仍需要**主密码**；现有 recoveryCode 只是代码持有校验，不是解密替代钥匙，忘记主密码不能靠它解密备份。

## 开发验证 / Verification

新增测试全部使用合成库和离线 fetch stub：签名向量、私有仓库拒绝、密文逐字节上传、错误脱敏、分页清理隔离、超时取消、调度合并、配置变更/卸载、权限、GUI 表单与状态轮询。真实 GitHub/S3/OSS/R2 账号未接入，交付不意味着真实服务端兼容性已在你的账号上验证。

运行 pnpm typecheck、pnpm build、pnpm test。真实浏览器登录会话 E2E 需另外显式设置 DSH_E2E_BROWSER=1；默认测试不打开用户浏览器。

## English summary

Opt-in per-vault encrypted snapshot backups support private initialized GitHub repositories, S3/R2 via AWS SigV4, and Alibaba OSS via native OSS V4. Configure destinations under Settings → Vault → Backup. Credentials are resolved from host environment-variable names; never enter secret values in the form. Enable on-change uploads and/or a 5–10080-minute interval (0 disables the interval), with 1–100 snapshots retained per destination/namespace. Saving arms future triggers; it does not upload immediately. Manual upload retries saved destinations. The DSH process must remain running. Readonly pauses uploads; previously authorized background jobs copy ciphertext even while the vault is locked. Rename migrates settings; deletion revokes local opt-in, not remote history. Git history and bucket versions can retain deleted ciphertext. Recovery currently requires downloading a snapshot with your provider tools and opening it with the original master password. Offline tests are not a live-cloud certification.
