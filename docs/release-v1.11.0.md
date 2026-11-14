# v1.11.0 — 密码管理(1pass) 工作台与加密云备份

## 界面重构
- 新增 DSH 设置入口 **密码管理(1pass)**。
- 系统阅读并采用 dsh-config-manager 0.8.2 的工作台布局与交互组织：四项主导航、实测宽度“更多”菜单、命令面板、全宽流程面板、底部状态栏和宿主主题 token。
- 原有密码簿搜索、CRUD、密码生成、TOTP、附件、密码历史、导入导出、浏览器会话、审计及回收站继续可用。
- 首次使用可在设置页创建/打开保险库，无需把主密码发给模型或写入配置；仅在当前 DSH 进程内保留，重启后重新输入。仍支持环境变量部署。
- 允许弱密码：主密码只要求非空及创建时两次输入一致。强度评分仅作参考。

## 自动加密云备份
- GitHub 私有仓库、AWS S3/S3 兼容存储、Cloudflare R2、阿里云 OSS 原生 V4。
- 按写入与间隔自动备份、多目标、状态/错误、手动重试、受限远端保留策略。
- 默认关闭；访问凭证只通过环境变量名引用；仅上传原始加密库快照。
- 改配置、卸载、库重命名/删除时正确撤销定时器与请求，并保留待备份写入。

## 安装
从本 Release 下载 dsh-vault-1.11.0.tgz，用本机 DSH 命令安装到 web profile：

    dsh plugin --profile web add /absolute/path/dsh-vault-1.11.0.tgz

然后在插件页启用 dsh-vault，打开 设置 → 密码管理(1pass)。原有加密库格式不变，不覆盖现有数据。

## 注意
- 这是用户自管目标的单向加密备份，不是托管云服务或多设备双向同步。
- Git 历史和对象存储版本历史可能保留已删除的加密快照。
- 恢复云备份需要下载快照并使用对应主密码；恢复码不是解密主密码的替代。
- 真实云账号未配置/上传；离线签名和传输测试不等于你的云账号已通过实测。
- UI 参考项目 MIT 声明完整保留在 NOTICE。

Verification details and any runtime limitations are recorded in the repository documentation.

## Verification
- Strict TypeScript checks and host/browser builds passed.
- Full native Windows regression run: 708 passed, 5 opt-in browser cases skipped.
- Source secret scan and dead-export scan passed.
- Synthetic desktop/mobile command, cloud and setup views rendered with all network blocked.
- Current DSH 0.2.2-rc.1 loaded the workbench; authenticated setupStatus returned configured=false/exists=false and the masked create-vault screen appeared. No real vault password was entered, no cloud upload was executed.

