# dsh-1pass · DeepSeek Harness 加密凭据管理

[English](<README.md>) | [简体中文](<README-zh.md>)

**本地优先的密码工作台、113 个可发现的模型工具、便于脚本使用的 CLI，以及最小披露的 /1pass 技能。**

软件包／插件／CLI 名称：**dsh-vault**。设置页名称：**密码管理(1pass)** / **Password Manager (1pass)**。
仓库：[copypasteltd/dsh-1pass](https://github.com/copypasteltd/dsh-1pass)。
当前源码版本：**1.12.2**；本文描述当前源码，**不代表 GitHub 已存在 v1.12.2 Release，也不代表 npm 已发布该版本**。
“1pass” 是本项目工作台与技能名称，不是商业产品 1Password；1Password 是支持的导入／导出格式之一。

> 主密码、批量凭据和云端鉴权令牌不要粘贴进聊天。请在本地 GUI 或已授权的秘密输入通道填写。找到凭据不等于获准连接、部署、导出或修改账号。

## 目录

- [功能概览](#功能概览)
- [安装与构建](#安装与构建)
- [首次解锁与语言切换](#首次解锁与语言切换)
- [/1pass 工作流](#1pass-工作流)
- [凭据模型](#凭据模型)
- [GUI 全页面与操作 GIF](#gui-全页面与操作-gif)
- [加密云端同步](#加密云端同步)
- [本地与旧版备份](#本地与旧版备份)
- [访问权限与安全](#访问权限与安全)
- [命令行](#命令行)
- [环境变量导出](#环境变量导出)
- [工具档位](#工具档位)
- [工具](#工具)
- [配置](#配置)
- [故障排查](#故障排查)
- [开发与发布](#开发与发布)
- [延伸文档与许可](#延伸文档与许可)

## 功能概览

- 在本机使用 **AES-256-GCM + scrypt** 保存登录账号、SSH 密码／私钥、API Key、OAuth 令牌、TOTP 设置密钥、银行卡、cookie 与自定义字段。
- 提供跟随宿主主题的中英双语工作台：搜索、收藏、标签、分类型编辑器、遮罩预览、附件、历史、安全报告与回收站。
- 提供 **Git、WebDAV、S3 兼容对象存储、Gist** 四种加密条目快照同步，包含预览、明确确认、三方合并和逐通道自动同步控制。
- 支持浏览器与密码管理器数据迁移，并明确区分加密备份与明文导出文件。
- 让助手先发现摘要、再按需读取最小字段；也可让已授权的消费程序通过 CLI 自行取用秘密。
- 默认只注册 **11 个核心工具**，不把全部 113 个工具塞进上下文；管理、导入导出、会话与库文件操作按需启用。
- 兼容既有加密库与环境变量部署；首次 GUI 设置无需把主密码写进配置。

**不同存储，职责不同：** DSH 宿主凭据（供应商令牌、同步凭据槽）**不是** 1pass 条目。存进 DSH 自身凭据服务的令牌不会自动成为可被 vault_search 搜索的条目，反之亦然。

## 安装与构建

### 环境要求

- **Node.js >= 20**；插件 GUI 与模型工具需要兼容的 DeepSeek Harness。
- 源码构建使用 npm 或 pnpm；Git 同步通道需要 PATH 中可用的 **Git**。
- 打开手动登录窗口需要可选的 **playwright-core** 与可用浏览器；普通 CLI 读取不需要浏览器。
- 软件包声明的 DSH peer 服务由宿主／profile 提供；独立 CLI 读取不会启动 DSH GUI。

### 构建当前仓库

以下安装当前仓库源码，不假设 npm 注册表已经更新：

~~~sh
git clone git@github.com:copypasteltd/dsh-1pass.git
cd dsh-1pass
npm install --ignore-scripts
npm run build
node lib/cli.js --help
~~~

构建脚本会编译宿主代码与浏览器 bundle。先忽略安装脚本、再显式构建，便于核对实际执行；也可使用对应的 pnpm 项目脚本。

### 安装到 DSH profile

构建后在仓库根目录执行，web 请替换为实际使用的 profile：

~~~sh
dsh plugin --profile web add .
~~~

如果你的 DSH 通过 pnpm 启动，把 dsh 换成 pnpm dsh。bundle patch 会插入 vault 插件行，不要手工再加一份相同插件。
也可以把本地实际生成的 tarball 安装到 profile：

~~~sh
npm pack
dsh plugin --profile web add ./dsh-vault-1.12.2.tgz
~~~

文件名来自当前 manifest；本地打包不等于发布 Release。dsh plugin --profile web add dsh-vault 安装的是**注册表中的版本**，可能与当前源码不同。
Git 依赖安装会执行 prepare 构建；pnpm 的构建审批策略可能阻止它。如果无法审阅相应构建许可，优先使用显式源码构建／tarball 路径。

### CLI 的实际入口

| 安装方式 | 调用方式 |
|---|---|
| 已构建源码 | node lib/cli.js list 或 npm run vault -- list |
| 作为 profile 依赖安装 | dsh plugin --profile web exec dsh-vault list |
| 已全局安装软件包 | dsh-vault list |

手工链接文件夹不一定会生成 profile 的可执行 shim。可先用源码 CLI，或通过正常插件依赖安装流程修复，不要假定命令必然存在。
注册表／全局安装很方便，但依赖当前源码功能前先核对 dsh-vault --version。

## 首次解锁与语言切换

1. 启用插件，打开 **设置 → 密码管理(1pass)**（英文：**Settings → Password Manager (1pass)**）。
2. 新库输入并确认非空主密码；已有库输入原来的主密码。强度提醒不阻止保存，但仍应选择强且唯一的口令。
3. 首次表单只把密码发送给本地 DSH 宿主，运行时解锁材料保留在内存，不写入浏览器存储、URL、模型参数或明文配置行。
4. 宿主重启后需要重新输入，除非你主动配置了环境变量解锁。使用锁库与自动锁定减少闲置暴露。
5. 在 **DSH 宿主的语言／偏好设置**切换 English 或简体中文，再回到 1pass。插件跟随宿主 locale，**没有独立的每库语言开关**。本文与[中文 GUI 指南](<docs/gui-guide-zh.md>)均提供对应英文版本。

**GUI 已解锁，不等于独立 CLI 已解锁。** CLI 是另一个进程，直接打开库文件，需要自己的主密码输入。它不会读取 GUI 内存，也不会自动从宿主凭据槽取得解锁密钥。

## /1pass 工作流

可复用技能源码位于 [skills/1pass/SKILL.md](<skills/1pass/SKILL.md>)。
请通过你的 DSH 常规 Skills 导入／创建入口，使用技能名 **1pass** 与该源码。克隆仓库或安装插件**不会自动安装本地技能**。若创建技能被权限拒绝，应请用户开放正规入口，不能改写宿主技能目录绕过。

示例仅使用合成标题与文档保留地址，不涉及真实账号：

~~~text
/1pass demo-server
/1pass demo-server only host username port
/1pass use demo-api for authorized task
~~~

执行顺序刻意保持如下：

1. **先摘要：** 搜索 demo-server，只展示标题、类型与必要的非秘密身份／主机摘要，不读取密码。
2. **再消歧：** 多条匹配时，让用户选择 ID／标题与真实目标；不跨库猜测，不把近似名称当成同一服务器。
3. **最小字段、即时读取：** 元数据请求只需要 host／username／port。只有已授权消费程序确实需要时才读取 API Key、密码、私钥或当前 TOTP。
4. **安全交接：** 优先让消费程序自行调用 dsh-vault get，或直接执行已批准的粘贴；不要在回答、日志、URL 或命令参数中回显秘密。
5. **验证实际操作：** 只找到凭据就说“已找到凭据”；只有 SSH／远程工具真实报告成功才说“SSH 已连接”。读取密码库既不会连接服务器，也不会证明密码正确。

模型工具调用顺序示意（不是自动建立连接）：

~~~json
{"query":"demo-server","kind":"ssh"}
{"id":"<chosen-entry-id>","fields":["host","username","port"]}
~~~

对于已安装 CLI，dsh-vault get demo-server --field host 只读取该字段。秘密字段应由已授权消费进程内部取得。--mask 只是部分预览，可能保留前缀、自定义／元数据也可能不遮罩，不能当作无秘密的存在性检查。安全的选定 ID 读取被拒绝或不可用时应停止，不改用 vault_fill 或大范围导出。
技能提供操作指导，不新增授权边界、网络能力，也不能绕过锁库或只读策略。

## 凭据模型

条目包含 title、id、kind 与相关字段。标题不要求唯一，出现歧义时使用 ID。

| 类型／字段组 | 数据与用途 |
|---|---|
| login | username、email、phone、password、url |
| ssh／密码 | host、可选 ip、port、username、sshAuth=password、password |
| ssh／证书或私钥 | host、ip、port、username、sshAuth=certificate、privateKey、可选 certificate 与 keyPassphrase |
| api-key／secret | apiKey 或 secret，可附属主／网址／备注 |
| oauth | accessToken、refreshToken、expiresAt（毫秒时间戳），客户端元数据存 fields |
| TOTP | otpSecret 为 Base32 或单账号 otpauth://totp/ 设置链接，可与其他类型共存 |
| card | cardNumber、cardExpiry、cardCvv、cardHolder；摘要不含卡号与 CVV |
| cookie | 浏览器会话 cookie；cookie 值本身就是账号凭据 |
| custom | 任意字段，保留嵌套值；不要把秘密放进标题／标签 |
| 组织与策略 | tags、favorite、icon、color、notes、sensitivity、rotationDays |
| 脚本命名 | envKeys 为按顺序指定的精确变量名；兼容旧 envKey；env 标签决定批量导出范围 |
| 历史与文件 | 历史密码与附件作为条目内容加密保存 |

SSH“证书”是可选的 **OpenSSH 用户证书**，不是网站 TLS 证书。私钥文本形状检查不等于登录验证。host 与 ip 独立，端口范围为 1–65535。
TOTP 输入的是**设置密钥**，不是手机今天显示的六位验证码。当前支持的设置链接使用 SHA-1；二维码图片、otpauth-migration:// 多账号迁移与不支持的算法不会被静默当作有效密钥。
模板保存字段结构／提示，**不保存实际密码、私钥、卡号或自定义字段内容**。

## GUI 全页面与操作 GIF

完整逐步说明见[中文 GUI 操作指南](<docs/gui-guide-zh.md>)，覆盖所有页面、工作流、语言切换与安全边界。
四个主入口是**首页、密码簿、云端同步、设置**；窄屏的**更多**、首页快捷操作与命令面板提供其他任务入口。

| 页面／任务 | 可进行的操作 |
|---|---|
| 首页 | 查看库状态、数量、健康与备份提示，打开快捷操作与最近活动 |
| 密码簿 | 搜索，组合类型／标签／收藏／到期／风险筛选，排序、展开与行菜单 |
| 凭据编辑器 | 选模板、填写分类型字段、按需显示秘密、管理附件／TOTP／元数据 |
| 快速导入 | 解析本地粘贴的多行文本，核对遮罩结果，选择有效非重复行，再明确确认 |
| 安全检查 | 弱密码／重复密码、缺少 2FA、HTTP 网址、到期、重复条目与泄漏检查 |
| 导入／导出 | 预览支持的格式，谨慎选择覆盖，辨认明文导出 |
| 云端同步 | 配置四通道与同步密码、预览／确认、合并、远端历史及自动同步 |
| 本地备份 | 创建／列出／恢复／删除本机加密副本；旧版云备份只用于迁移 |
| 设置 | 管理命名库、访问模式、自动捕获、自动锁定、工具档位与恢复码状态 |
| 标签 | 在密码簿标签管理或设置摘要中，批量重命名／移除标签 |
| 会话 | 打开手动登录窗口，收集保存 cookie，查看／导出／导入／清理，再关闭窗口 |
| 活动／历史 | 按读取／搜索／写入筛选事件；不是持久化司法取证账本 |
| 回收站 | 恢复单条／全部，或明确确认永久清除 |
| 关于 | 查看软件包版本、本地存储说明与许可归属 |
| 命令面板 | 搜索页面与操作，无需逐层寻找溢出菜单 |

以下六组中英配对 GIF 是**合成 fixture 的 UI 演示**，不是读取真实密码库、实时 GitHub 授权或真实云账号端到端成功的录屏。fixture 可在未连接供应商时展示预览状态。GIF 与指南位于 GitHub 仓库／源码目录，不应假设 npm 包捆绑媒体。

### 1. 概览、导航与语言

![合成中文演示：首页、导航与语言](<docs/media/overview-zh.gif>)

### 2. 凭据、模板与快速导入

![合成中文演示：凭据与遮罩快速导入](<docs/media/credentials-zh.gif>)

### 3. 导入与导出

![合成中文演示：迁移预览与明文导出警告](<docs/media/transfer-zh.gif>)

### 4. 云端同步

![合成中文演示：四通道、预览与冲突合并](<docs/media/cloud-sync-zh.gif>)

### 5. 安全、活动、本地备份与回收站

![合成中文演示：安全检查与历史任务](<docs/media/security-history-zh.gif>)

### 6. 设置与会话

![合成中文演示：策略、工具档位与会话管理](<docs/media/settings-sessions-zh.gif>)

快捷键：**Ctrl/Cmd+K** 打开命令面板；未在输入文字、且库可写并解锁时，**Ctrl/Cmd+N** 新建条目。面板中方向键／Enter 选择命令，Escape 关闭当前插件浮层；主标签支持方向键／Home／End 移动焦点。作用域与编辑器例外见指南。

## 加密云端同步

**当前云端同步不是旧版原始库文件上传器。** 它序列化完整的**自定义条目快照**，再用**独立同步密码**加密；包含活动条目、回收站、历史密码、cookie 与附件，**不是逐字节复制原始库文件**，也不上传无关的 DSH 设置、插件、MCP 或会话配置。
另一台设备需要相同的同步解密密码，但可以使用不同的本地主密码。

快照格式为 1pass-cloud-snapshot-v1。**元数据是明文：** 快照 ID／时间／内容哈希、通道、库与设备名称、平台／版本标记、分区信息仍可见；载荷使用 AES-256-GCM + scrypt。库与设备名不要包含秘密。合并共同祖先／本地基准也加密保存。
通道鉴权与同步密码保存在 **DSH 宿主凭据槽**，不会作为可编辑明文配置返回，也不会自动成为 1pass 条目。

### 配置一个通道

1. 打开云端同步，选择 Git、WebDAV、S3 或 Gist。
2. 保存非秘密目标设置，在遮罩配置框填入鉴权。设置该通道加密／解密密码，不要粘贴到聊天。
3. 测试／刷新实际目标状态；读探测成功不证明具有写权限。
4. 选择密码库分区，强制加密。首次推送或拉取先预览，再明确确认。
5. 完成人工核对的手动往返之后，再考虑自动同步。

| 通道 | 配置与边界 |
|---|---|
| Git | 真实 clone／fetch／ff-only／commit／非 force push；HTTPS token 或现有 SSH key／agent。分支默认从**远端 HEAD 自动识别**，也可显式指定；默认子目录 **1pass**。不 force push，不自动破坏性重置。 |
| WebDAV | HTTPS URL、用户名、密码、前缀（默认 1pass）；强 ETag 条件写保护索引，缺失／弱 ETag 时存在已说明的非原子窗口。 |
| S3 兼容 | provider、endpoint、region、bucket、prefix、access-key id 与 secret、寻址／签名方言；AWS 风格条件写依赖服务端支持。OSS 索引先 HEAD 再写，**不是原子 CAS**。 |
| Gist | Gist ID 与 token，默认文件前缀 1pass；读／合并／写／验证不能阻止覆盖**尚未观察到的并发写入**。优先私密目标；元数据与历史仍存在。 |

### 预览、确认与合并

推送预览绑定本机内存／磁盘版本、目标／选择项及**整个远端索引版本**。本地编辑、目标变化或新远端写入会使旧确认失效；应刷新重做预览，不应强行提交。
拉取／一键同步在宿主下载、验证与解密，按条目 ID 与加密共同祖先进行三方比较，再显示遮罩的变更／冲突摘要。
选择本机／远端或界面提供的安全合并结果；不会用文本拼接猜测密码、私钥或数组。未确认项保持本机，且不推进基准。远端删除提议需要人工审阅。
本机应用前创建安全副本；远端历史与本机回滚是不同功能。选择旧快照或删除快照前先检查远端列表／历史。

### 自动同步与真实限制

- 默认关闭，逐通道配置周期、本地写入去抖、远端检查、启动频率、冲突策略与自动应用档位。
- 启动／远端轮询只下行，不因启动而取得新的上传授权；首次缺少基准需要人工确认。
- 低风险档不会自动应用密码库变更；“本机优先”是明确选择的冲突策略，不是关闭冲突检测。
- 锁库、只读、换库／换目标和卸载会撤销在途能力及预览。超时结果不确定时先检查状态，再决定是否重试。
- Git push 拒绝和 WebDAV／AWS 条件请求在受支持时保护并发；Gist、OSS、无 ETag 服务仍有读取后的竞态，**不等于分布式锁**。
- 默认保留最近快照（10 个），清理失败单独报告。**删除 Git／Gist 文件不会擦除历史密文**，对象版本也可能保留旧副本。

技术细节：[通道契约](<docs/cloud-sync-transports.md>)、[同步实现说明](<docs/cloud-sync.md>)、[UI 复用说明](<docs/cloud-sync-ui-adoption.md>)。历史验证记录不等于针对你当前安装的实时账号测试。

## 本地与旧版备份

从首页或命令面板打开**本地备份**，创建加密副本、核对时间与所属库，再选择恢复**合并**（默认，把条目复制进当前库）或**替换**（覆盖整库，先保留安全副本）。覆盖与合并不同，确认前检查当前库与重复项。
本地备份是原始本地加密库文件的副本，需要对应主密码；它与独立同步密码加密的云端条目快照不同。
**旧版云备份（仅迁移）**折叠区保留旧单向 GitHub Contents／S3／OSS／R2 上传器。它不是双向同步，不建立新合并基准，也不会自动授权四通道的新目标。
[旧版云备份文档](<docs/cloud-backup.md>)仅适用于该迁移路径。

## 访问权限与安全

### 访问模式不等于工具档位

| 模式 | 含义 |
|---|---|
| ask（默认） | 普通模型读取无需确认；新增／更新／删除等受保护写入走 DSH 审批。**不是每次读取密码都询问**。 |
| readonly | 仍可读取／搜索／生成验证码；工具与 GUI 的受保护修改被拒绝。**不是仅元数据模式，也不是 OS 沙箱**。 |
| auto | 普通读取／写入没有逐次写入审批；只对可信工作流启用。 |

对**高敏感度**条目按 ID 读取 get／剪贴板／TOTP／历史密码／附件等内容，在 ask 与 auto 下有确认门槛；这不是覆盖全部批量／导出／CLI 路径的通用闸门。仍应坚持最小字段与窄工具档位。
GUI 按钮是用户直接操作，执行自己的确认／只读规则，不一定走模型审批提示。拥有库文件和密钥的 CLI 是独立进程，不受模型工具白名单隔离。
自动捕获默认关闭；启用后只是指导助手对主动分享的凭据提出保存建议，不授权搜集无关秘密或违背用户意愿自动保存。

### 加密与隐私

- 使用 Node 内置 crypto 的 scrypt 与认证 AES-256-GCM；随机 nonce 与验证信封检测错误密码／篡改，串行／原子写入与锁保护常规并发。
- 静态加密不代表所有元数据／配置都加密。库文件名、权限／工具档文件、恢复码哈希和云快照元数据可能可见。会被搜索或显示的标题／标签／备注／自定义元数据应避免藏秘密。
- 模型摘要投影省略标准密码／私钥／令牌／TOTP 字段和自定义字段值，GUI 仍支持自定义数据。用户可能误把秘密写进标题、URL 或其他元数据，所以摘要也可能敏感，不应无谓引用。
- 密码强度与 Watchtower 风险标签是启发式提醒，不是安全保证。三颗星指示条目密码／PIN 强度，不给机器生成 API Key 或私钥评分。
- 在线泄漏检查把 **SHA-1 的前五个十六进制字符**发送到 api.pwnedpasswords.com，并附 Add-Padding；匹配在本机完成。不会上传完整哈希、密码或条目，但服务端仍能看到 IP 与前缀。Padding 只降低响应大小信号，不隐藏前缀。离线检查不联网，但常见密码表更小。
- 复制、下载、会话导出与消费程序内存都是明文暴露点。剪贴板功能无法让系统剪贴板历史软件变安全。

### 边界与恢复

插件与 DSH 同进程，不隔离其他可信插件、同 OS 用户工具、被攻陷的主机、截图、日志或已经接收秘密的模型。使用最小权限、可信插件、OS 权限、独立账号／设备和谨慎的提示流程。
“恢复码”只存哈希、验证**持有**，**不能导出解密密钥、打开忘记主密码的库或重置主密码**。独立保管主密码和已经验证可恢复的加密备份。
OS 钥匙串／helper-command 托管见[主密钥托管设计草案](<docs/master-key-custody.md>)；它**不是当前 CLI 已实现的自动解锁功能**。

## 命令行

### 消费程序只读所需字段

以下假设 dsh-vault 已安装；源码目录中替换为 node lib/cli.js。

~~~sh
dsh-vault --version
dsh-vault list --json
dsh-vault show demo-server
dsh-vault get demo-server --field host
dsh-vault get demo-server --field username
dsh-vault get demo-server --field port
dsh-vault get demo-api --mask
dsh-vault totp demo-api --json
dsh-vault verify
~~~

| 命令 | 输出与注意点 |
|---|---|
| list、show | 投影后的身份／元数据与存在性，省略标准秘密、备注／自定义字段；用户填写的元数据本身仍可能敏感 |
| get <id/title/env-name> | 默认输出主秘密；--field 指定单个字段，也支持 fields.name；名称歧义时报错 |
| get ... --json | 包装所选值，**不会自动脱敏** |
| get ... --all | 返回含秘密的完整 JSON；日常自动化避免使用 |
| totp <entry> | 当前验证码；--json 加入位数、周期、剩余秒数；验证码本身敏感 |
| verify | 检查主密码；状态写 stderr，不向 stdout 输出凭据 |
| env | 仅 env 标签条目；--keys-only／--mask／--explain 用于核对范围 |
| export-env <path> | 写明文 env 文件（支持时为 0600），不是加密备份 |

成功数据走 stdout，诊断走 stderr。退出码：0 成功、1 运行／查找／解密失败、2 参数错误。
不要开启 shell trace、打印命令替换结果或把秘密 stdout 收进公开会话。消费程序应取出即用，不记录它，也不把它放入进程参数或 URL。
--mask 是遮罩预览，不保证零披露：部分值保留前缀，自定义／元数据可能不遮罩；同时给 --all 仍打印完整条目。批量检查变量名用 env --keys-only。

### 独立 CLI 的主密码来源

CLI 顺序为 **--password-stdin → DSH_VAULT_MASTER_PASSWORD → DSH_VAULT_PASSWORD → 交互式隐藏输入**。没有 TTY 且没有显式来源时失败；不读插件配置、不复用 GUI 运行时密钥、不自动访问 OS 钥匙串托管。
通过已授权的秘密提供器／输入路径交付，不要把真实主密码写成 shell 历史、截图、聊天或已提交脚本里的字面量。环境值会被子进程继承，也可能被同用户工具查看；stdin 也不代表进程隔离。
--vault 选择命名库，--path 选择指定库文件；DSH_HOME 决定默认主目录，下接 vault/default.json。选择文件不是读取其他用户库的授权。

## 环境变量导出

**单个值：** get demo-api 不要求 env 标签。**批量 shell 环境：** env 故意只导出 env 标签条目，避免把无关卡片、备注和登录信息带入 shell。
消费程序要求精确变量名时，在编辑器填写 envKeys，例如 DEMO_API_KEY；envKey 是旧的单名简写。变量名按导出字段顺序对应，必须是有效标识符、最多八个且不重复。未指定者按标题与标准后缀生成（API_KEY、ACCESS_TOKEN、REFRESH_TOKEN、PRIVATE_KEY、PASSWORD）。
list 显示名字不等于已经导出值：它会区分有标签／会导出和无标签／不导出两组。

~~~sh
dsh-vault env --keys-only
dsh-vault env --mask
dsh-vault env --explain
dsh-vault env --file ./demo.env
dsh-vault export-env ./demo.env
~~~

最后两条会写**明文**，请排除版本控制、限制权限、使用后删除。文件输出可覆盖目标，应有意选择路径；不要直接 source 不可信导入的 env 文件。
对已核对的 POSIX shell 导出，保留 CLI 的引号：

~~~sh
# 先只查看名字与计划导出的条目，不显示值。
dsh-vault env --keys-only
# 仅在已授权的 shell 中使用，绝不记录展开的输出。
set -a
eval "$(dsh-vault env)"
set +a
~~~

**不要**用 export $(dsh-vault env)，单词拆分会破坏空格／引号。这是 POSIX shell 语法，不是 PowerShell。能只读一个字段时，优先避免广泛的环境变量暴露。

## 工具档位

在 1pass 的**设置 → 模型工具**切换；运行时即时更新注册，保存在库目录的 tools.json。模型工具目录属于当前进程，**不是每个命名库独立的一份目录**。

| 档位 | 注册数量 |
|---|---|
| 基础 Basic（默认） | 核心 **11** |
| 标准 Standard | 核心 + 管理，共 **64** |
| 完整 Full | 五组全部，共 **113** |
| 自定义 Custom | 核心 **11**，加所选管理 **53**／导入导出 **27**／会话 **8**／文件 **14** |

工具可见不等于操作获准。ask／readonly／auto、锁库、目标授权与破坏性确认仍然有效。GUI-only 快速导入和云同步控制器不会把整段批量密码作为模型工具参数暴露。

## 工具

当前源码注册的 **113** 个工具均列在下方，即使当前档位仅暴露其中一部分。分组依照 CORE_TOOLS／IO_TOOLS／SESSION_TOOLS／FILE_TOOLS，其余为管理组。导入导出／会话结果可能包含明文秘密，执行前核对字段与目标。

### 核心／基础档 — 11

| 工具 | 说明 |
|---|---|
| `vault_list` | 列出保险库目录下可用的保险库（一个 .json 一个,排除 access/meta/导出等旁车文件） |
| `vault_search` | 搜索身份、元数据、标签和自定义值，可按类型、时间、收藏筛选；返回摘要，不返回密码、密钥或令牌值。 |
| `vault_get` | 按 ID 读取条目；指定最小字段或遮罩。完整读取可能返回全部秘密。 |
| `vault_add` | 新增条目（上述字段任意组合；空字符串/空数组字段会被忽略） |
| `vault_update` | 按 id 更新字段（未提供的字段保留；空字符串清除该字段；`title` 可改名；`rotationDays: 0` 清除轮换 = 永不轮换） |
| `vault_delete` | 软删除条目（移入回收站，磁盘上仍加密保留） |
| `vault_fill` | 匹配目标并直接返回指定凭据，可能含秘密；没有相同的选定 ID 高敏读取闸门，不得用于绕过审批或作为 /1pass 回退。 |
| `vault_clipboard` | 返回单个字段供剪贴板交接；不等于已安全粘贴或已擦除系统剪贴板。 |
| `vault_totp` | 从库内或给定的 Base32／设置链接生成 TOTP；注意验证码有效期与链接参数。 |
| `vault_generate_password` | 生成强随机密码（长度/字符集/分组可选）**或易记口令短语**（`passphrase: true`，EFF 词表，`words`/`separator`/`wordDigits`） |
| `vault_strength` | 零依赖密码强度评估（0–100 分，weak/fair/strong/very strong） |

### 管理／标准档及完整档 — 53

| 工具 | 说明 |
|---|---|
| `vault_compare` | 逐字段比较两个条目（`onlyA`/`onlyB`/`differ`/`equal`）——只返回字段名，绝不返回密钥值 |
| `vault_rename` | 一次调用即可重命名条目（`vault_update` 的快捷方式） |
| `vault_restore` | 从回收站恢复一个软删除条目。 |
| `vault_purge` | 从当前库永久清除一个回收站条目；独立备份或历史仍可能保留副本。 |
| `vault_restore_recent` | 撤销最近一次软删除。 |
| `vault_lock` | 锁定当前库并清除内存中的解密密钥。 |
| `vault_unlock` | 用宿主配置的解锁材料重新打开库；不要让模型接收主密码。 |
| `vault_password_history` | 列出条目的历史密码(1Password/Bitwarden 风格,最新在前,上限 10 条;不含当前密码) |
| `vault_password_rollback` | 将条目密码回滚到某条历史记录(当前密码先归档,可逆) |
| `vault_apply_tags` | 按查询批量增/删/替换条目标签（支持 dry-run，不含密钥） |
| `vault_totp_uri` | 为存储的或裸 TOTP 密钥生成 otpauth:// 配置 URI |
| `vault_rotation` | 报告已过期 / 待轮换 / 即将过期的凭据；`soonWindowDays`（1-90，默认 7）调整即将窗口（不含密钥） |
| `vault_health` | 保险库健康扫描：弱密码/复用凭据、未启用 2FA、不安全的 http:// 站点,以及整体安全评分（0–100） |
| `vault_watchtower` | 每个条目的风险分析(借鉴 1Password Watchtower / Bitwarden):标记弱密码、键盘序列、嵌入年份、常见密码、跨条目复用、http 站点、缺 2FA、过期——带 0–100 评分与 good/warn/poor 判定(不含机密);条目行显示 ⚠ 徽标 |
| `vault_breach_check` | Watchtower 风格泄露扫描：对接 Have I Been Pwned（k-anonymity,仅发送 SHA-1 前缀）,附离线常见密码兜底 |
| `vault_integrity` | 校验磁盘上的保险库文件可正确解密并与内存中的 store 一致 |
| `vault_merge` | 合并一个条目到另一个；`keepSource: true` 保留源条目 |
| `vault_attach` | 将文件作为条目内容加密保存。 |
| `vault_attachments` | 列出附件名称与大小，不读内容。 |
| `vault_attachment` | 读取一个附件；内容可能敏感。 |
| `vault_detach` | 移除条目的一个附件。 |
| `vault_quick_add` | 快速录入（标题 + 一个密钥），支持 tags/notes |
| `vault_expiry` | 设置/清除过期（`expiresAt: 0` 移除） |
| `vault_stats` | 概览计数，含 `trashCount`（不含密钥） |
| `vault_verify` | 校验单个条目或审计全部条目（`all: true`）：按 kind 检查完整性、端口/过期合理性（不含密钥） |
| `vault_duplicates` | 查找重复分组：`mode` = `both`（默认）/ `title` / `content`（不含密钥） |
| `vault_report` | 可打印清单，含到期/轮换列与统计页脚（不含密钥） |
| `vault_match_url` | 按 URL 查找匹配的登录条目（Bitwarden/1Password 风格:精确主机、子域、父域、路径前缀;www./端口归一化）,带 0–100 评分——绝不返回密码 |
| `vault_env` | 把带 env 标签的条目生成带 shell 引号的 KEY=VALUE；除非指定遮罩，否则是明文。 |
| `vault_copy` | 复制条目（含密钥）到另一个命名保险库 |
| `vault_templates` | 内建 + 用户自定义模板（save/list/remove,KeePassXC 风格）;内建模板新增 Wi-Fi、服务器、数据库、身份、银行账户、银行卡（借鉴 1Password） |
| `vault_notes` | 追加或整体替换条目的自由备注（等价于一次 `vault_update`） |
| `vault_changes` | 列出某个时间窗内（默认 24 小时）的库内活动:新增/更新/软删除,最新在前 |
| `vault_find` | 模糊查找:忽略大小写、标点与空白,所以 `gh` 也能命中 `GitHub` |
| `vault_mask` | 启发式遮罩文本中疑似秘密；不能证明已发现全部敏感信息。 |
| `vault_history` | 本进程内的近期活动,最新在前:写操作（增/改/删/恢复/清空/合并/回滚)与读操作（读取、验证码） |
| `vault_recent` | 列出最近新增或更新的条目（最新在前),只含非敏感摘要 |
| `vault_pin` | 收藏（置顶）条目,使其在搜索与列表中排在最前 |
| `vault_unpin` | 取消收藏（移除 favorite 标记） |
| `vault_tags` | 列出全库用到的所有标签及每个标签下的条目数 |
| `vault_generate_username` | 生成随机用户名或匿名邮箱建议 |
| `vault_rotate_password` | 生成新的强密码、写入条目,并把新值返回给调用方交给目标服务 |
| `vault_touch` | 把条目标记为"最近使用"（只更新 updatedAt,不改内容） |
| `vault_note_secret` | 用一个自动生成的标题存一条单独的密钥（临时记一条,不必先想标题） |
| `vault_search_advanced` | 多条件组合搜索:标题子串、用户名/邮箱子串、kind、标签、创建时间区间、仅收藏 |
| `vault_count` | 返回活跃条目数量（可按 kind / 标签过滤） |
| `vault_set_icon` | 设置条目的 UI 图标（emoji）与强调色 |
| `vault_describe` | 用自然语言描述一条目（kind、身份、主机/URL、标签、到期),不泄露任何密钥 |
| `vault_last_modified` | 按最后修改时间列出条目,最新在前 |
| `vault_has` | 快速判断库里是否存在匹配的凭据（标题/用户名/主机子串;`exact` 时按标题精确匹配） |
| `vault_autofill_check` | 判断库里是否有可用于某 URL/主机的凭据:返回最佳匹配条目（只给用户名/邮箱,绝不给密钥）,或明确"没有" |
| `vault_undelete_all` | 把回收站里的条目全部恢复 |
| `vault_get_many` | 按 id 批量读取多个条目,且只返回请求的字段 |

### 导入与导出／完整档或自定义 — 27

| 工具 | 说明 |
|---|---|
| `vault_import_csv` | 从 CSV 批量导入凭据（自定义列变为 fields；`overwrite: true` 合并字段到已有条目，不再产生重复） |
| `vault_bulk_delete` | 按 query/kind/tag 或显式 ids 批量软删除条目;需 `confirm: true`（默认仅试运行）;回收站可恢复 |
| `vault_export` | 整库加密备份/迁移（独立导出密码） |
| `vault_import` | 整库加密备份/迁移（独立导出密码） |
| `vault_export_bitwarden` | Bitwarden/Vaultwarden JSON 互通（完整字段映射,支持覆盖） |
| `vault_import_bitwarden` | Bitwarden/Vaultwarden JSON 互通（完整字段映射,支持覆盖） |
| `vault_import_bitwarden_encrypted` | 解密 Bitwarden 口令保护 JSON 导出（PBKDF2/Argon2id + HKDF → AES-256-CBC + HMAC）并导入,需提供导出口令 |
| `vault_import_manager_csv` | 密码管理器 CSV 自动识别表头：Bitwarden（login_uri/login_username/…）、1Password 8、Dashlane、NordPass、Keeper、LastPass（fav/grouping/extra）；支持 dryRun 预览 |
| `vault_import_kdbx` | KeePass KDBX：3.1 与 4.x、AES-KDF 或 Argon2（RFC 9106）、AES-256-CBC 或 ChaCha20 载荷、支持 keyfile |
| `vault_export_1password` | 导出为 1Password 1PUX 归档（ZIP + export.data）,可导入 1Password 或用 vault_import_1password 再导入;条目类别映射 login/信用卡/API 凭据/服务器 |
| `vault_import_1password` | 1Password 1PUX（ZIP）与旧版 1PIF 文本导出 |
| `vault_import_1pif` | 1Password 1PUX（ZIP）与旧版 1PIF 文本导出 |
| `vault_import_enpass` | Enpass JSON 导出（文件夹→标签、类型化字段、TOTP） |
| `vault_import_keepass_xml` | KeePass 2.x XML 导出（明文或 ****** 掩码值） |
| `vault_import_chrome` | 从 Chrome Login Data（macOS 钥匙串 / Linux 钥匙环或 peanuts / Windows DPAPI）或 macOS 钥匙串导入密码（默认只读互联网密码 `inet`——真正用于网站登录的条目,`classes: ["genp"]` 可改读通用密码；会话缓存 + 预览,避免授权弹窗轰炸）；所有文件导入均支持 dryRun 预览 |
| `vault_import_keychain` | 从 Chrome Login Data（macOS 钥匙串 / Linux 钥匙环或 peanuts / Windows DPAPI）或 macOS 钥匙串导入密码（默认只读互联网密码 `inet`——真正用于网站登录的条目,`classes: ["genp"]` 可改读通用密码；会话缓存 + 预览,避免授权弹窗轰炸）；所有文件导入均支持 dryRun 预览 |
| `vault_import_firefox` | Firefox 配置导入（logins.json + key4.db,NSS 3DES / PBES2-AES,支持主密码） |
| `vault_export_totp` | 列出所有带 TOTP 密钥的条目及其标题与签发方标签 |
| `vault_bulk_export` | 把**全部**条目（含密钥）导出为 JSON 文件,用于审计或迁移 |
| `vault_export_browser` | 按浏览器密码管理器 CSV 格式导出登录条目（name,url,username,password） |
| `vault_migrate_keepass` | 按 KeePass 2.x 导入 CSV 格式导出（Group,Title,Username,Password,URL,Notes） |
| `vault_export_keepass_xml` | 导出为 KeePassXC 兼容的 XML 文档（KeePass 2.x schema） |
| `vault_import_browser` | 导入浏览器密码管理器 CSV（name,url,username,password,Chrome/Firefox/Edge 导出格式） |
| `vault_export_wallet` | 导出为 `pass`(标准 Unix 密码管理器）兼容的目录树:一条目一文件,首行是密码 |
| `vault_import_wallet` | 从 `pass` 目录树导入:每个 .gpg（或明文）文件成为一个条目,文件名即标题,首行是密码 |
| `vault_export_env` | 把带 `env` 标签的条目写成 .env 文件（KEY=VALUE,值做 shell 引号处理） |
| `vault_export_csv` | 把条目导出为 CSV（与 `vault_import_csv` 同格式),可按 kind 过滤 |

### 浏览器会话／完整档或自定义 — 8

| 工具 | 说明 |
|---|---|
| `vault_session_open` | 在真实浏览器窗口中打开指定网址,供用户手动登录（密码、二次验证、验证码）——对禁止嵌入的网站也能捕获登录态（需要可选的 `playwright-core`） |
| `vault_session_collect` | 从插件打开的登录窗口收集 cookie 并存为 cookie 条目；需先由用户完成登录。 |
| `vault_session_import` | 从粘贴的 JSON cookie 数组（开发者工具导出格式）或原始 `Cookie` 头字符串保存会话 cookie——无需浏览器的替代方案 |
| `vault_session_import_file` | 导入 Netscape cookie-jar 文件（curl `-b` / wget / 浏览器扩展导出；与 `vault_session_export` 输出的格式一致） |
| `vault_session_list` | 列出已保存的登录会话、cookie 数量、已过期与 7 天内过期数量（不含值） |
| `vault_session_export` | 将会话导出为 `Cookie` 请求头、Netscape cookie-jar 文件（curl `-b`）、原始 JSON（Playwright `addCookies` 格式）或可直接运行的 Playwright 片段 |
| `vault_session_close` | 关闭已打开的浏览器登录会话（已收集的 cookie 仍保留在保险库中） |
| `vault_session_prune` | 移除已保存会话中的过期 cookie（无过期的会话 cookie 保留）;`preview: true` 只报告不修改 |

### 备份与库文件／完整档或自定义 — 14

| 工具 | 说明 |
|---|---|
| `vault_recovery_code` | 显示一次新代码，仅持久化 SHA-256 哈希；重新生成使旧码失效。它不是解密密钥，也不能重置主密码。 |
| `vault_verify_recovery` | 与已存哈希核对代码持有；不会解密或解锁密码库。 |
| `vault_recovery_status` | 报告是否设置恢复码及签发时间，不返回代码。 |
| `vault_rekey` | 原地升级 scrypt KDF 参数并重加密 |
| `vault_switch` | 为当前会话切换活动保险库 |
| `vault_backup` | 创建原始加密库文件的本地备份，按保留数清理（默认 10）。 |
| `vault_backup_now` | 立即创建一个本地加密备份。 |
| `vault_restore_backup` | 从备份还原:`mode: "merge"`（默认）把备份条目复制进当前库,出现在条目列表;`mode: "replace"` 整体覆盖（先写安全快照） |
| `vault_vault_rename` | 重命名命名库；当前活动库随移动更新。 |
| `vault_vault_delete` | 永久删除一个命名库文件；default 库受保护。 |
| `vault_search_system` | 在 Chrome / 钥匙串中搜索站点与用户名——绝不暴露密码 |
| `vault_backup_status` | 报告距上次备份已过去多少天（1Password 式备份提醒） |
| `vault_search_history` | 搜索时包含已软删除（回收站）的条目,并标注其删除状态 |
| `vault_backups` | 列出加密备份路径与时间，识别当前及旧版命名。 |

## 配置

普通 GUI 使用首次密码表单即可。主动采用环境变量部署时，只把**变量名**放进 profile，不要放值：

~~~yaml
- id: vault
  name: dsh-vault
  config:
    masterPasswordEnv: DSH_VAULT_PASSWORD
    accessMode: ask
    autoCapture: false
    tools: basic
    lockTimeoutSeconds: 300
~~~

bundle 已提供 vault 行；此处展示配置结构，不是让你重复插入插件。

| 选项 | 含义 |
|---|---|
| masterPasswordEnv | 宿主解锁材料的环境变量名；必须对实际宿主进程可见 |
| masterPassword | 兼容内联密码，**不推荐**；明文配置可能被提交、备份或截图 |
| path／name | 显式库路径或库名，默认 DSH_HOME/vault/default.json |
| accessMode | readonly／ask（默认）／auto，已保存 GUI 策略优先于回退配置 |
| autoCapture | 默认 false，捕获主动分享的凭据仍遵循用户意愿 |
| lockTimeoutSeconds | 闲置锁定秒数，0／缺省关闭；GUI 策略可覆盖 |
| tools | basic／standard／full／custom；已保存选择优先 |
| exportPasswordEnv | 独立便携导出／导入密码的环境变量引用 |
| backupRetention | 本地加密备份保留数，默认 10 |

使用适当 POSIX 权限或 Windows ACL 保护配置与库目录。环境引用可减少配置文件意外泄漏，不会向宿主进程或同用户工具隐藏秘密。

## 故障排查

| 现象 | 下一步检查 |
|---|---|
| 找不到设置入口 | 插件是否启用在真正服务当前 DSH 的 profile；宿主和客户端构建是否加载；是否重复注册 |
| 重启后锁定 | 在本地表单重新输入主密码，或配置正确宿主环境；不要让助手接收主密码 |
| CLI 不存在 | 使用源码入口或正常 profile／全局安装；手工链接可能没有 shim |
| GUI 可用但 CLI 解锁失败 | 独立进程：核对其库路径与已授权密码输入，不要以 GUI 状态推断 |
| env 没有值 | 只有 env 标签条目才导出；先看 list 和 env --keys-only |
| 某个工具不可见 | 默认只有 11 个；按需切标准／完整或更窄的自定义组 |
| 导入无法确认 | 检查是否解锁可写、预览新鲜且有有效选择；锁库／修改输入／过期后必须重做 |
| Git 可读但不能推送 | 读探测不等于写权限；核对 token／SSH 范围、仓库／分支、本地 ahead／分叉状态；不要 force push |
| 同步提示本地／远端已变化 | 刷新、检查冲突，重新预览；不要复用旧批准 |
| 更新后样式／文字不对 | 安装重建产物后刷新当前 DSH 页面；另开无关服务不会更新此页面 |
| 恢复码验证成功仍锁定 | 符合设计：代码持有证明不是解密或重置主密码 |

## 开发与发布

项目脚本定义见 [package.json](<package.json>)；本文不承诺固定测试数量。

~~~sh
npm run typecheck
npm test -- tests/readme-tools.spec.ts
npm test
npm run build
npm run scan:secrets
npm pack
~~~

README 专项测试根据注册源码检查全部覆盖、五组成员与标题计数。完整测试／构建由发布负责人执行；合成 fixture 不证明你的真实云账号可用。
发布前检查 tarball 内容、保留许可声明，绝不提交真实库／env 文件／录屏凭据，只在负责人授权后发布／推送。本地源码版本、npm 版本、GitHub Release 是三个不同状态。
浏览器会话支持可选；支持某种导入格式不代表你的全部平台组合均已实测。验证恢复前妥善保留原始导出。

## 延伸文档与许可

- [中文 GUI 指南](<docs/gui-guide-zh.md>) · [English GUI guide](<docs/gui-guide.md>)
- [/1pass 技能源码](<skills/1pass/SKILL.md>)
- [编辑器、TOTP 与快速导入实现说明](<docs/credential-editor-quick-import.md>)
- [当前云端同步说明](<docs/cloud-sync.md>) · [通道实现契约](<docs/cloud-sync-transports.md>)（英文）
- [旧版单向云备份](<docs/cloud-backup.md>) · [GUI 集成与参考说明](<docs/gui-reference.md>)
- [主密钥托管设计草案——不是已实现功能](<docs/master-key-custody.md>)
- [MIT 许可](<LICENSE>) · [第三方归属声明](<NOTICE>)

工作台和同步 UI 含保留 MIT 归属的 dsh-config-manager 派生组件；不代表与该项目、DSH 或商业 1Password 存在从属关系。

[English](<README.md>) | [简体中文](<README-zh.md>) · [返回目录](#目录)
