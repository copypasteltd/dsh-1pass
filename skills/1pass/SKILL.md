---
name: "1pass"
description: "通过 /1pass 按名称、主机或 ID 获取本机 dsh-vault 保存的账号、密码、SSH、API Key 和 TOTP 信息，并用于用户指定的登录、连接或接口调用。Look up and use local credentials with the available DSH tools."
---

# /1pass — 本地密码库取用

根据用户指定的名称或用途，从本机 dsh-vault 获取条目；用户要求连接、登录或调用接口时，将获取的字段提供给对应工具完成操作。

## 常见用法

- `/1pass demo-server`：查找这条记录，按用户问题提供信息。
- `/1pass demo-server 的密码`：获取该条目的 password 字段。
- `/1pass demo-server 的主机、用户名、端口`：获取这些连接参数。
- `/1pass 用 demo-server 连接服务器并查看系统版本`：获取连接和认证字段，调用 SSH／远程执行工具。
- `/1pass 用 demo-api 调用指定接口`：获取 API 字段并交给请求工具。
- `/1pass demo-account 验证码`：生成该条目的当前 TOTP 验证码。

## 查找与读取

1. 用 `vault_search` 查找名称、主机、用户名或标签：

~~~json
{"query":"demo-server","limit":10}
~~~

2. 根据返回的 id、title、kind、host、username 确定目标。名称相同且无法区分时，让用户选择；用户直接给出 ID 时可直接读取。
3. 用 `vault_get` 读取选中的 ID。用户指定字段时传 fields；需要完整条目时省略 fields。

~~~json
{"id":"<搜索结果中的 ID>","fields":["host","port","username","sshAuth","password"]}
~~~

其他例子：

~~~json
{"id":"<条目 ID>","fields":["apiKey"]}
{"id":"<条目 ID>","fields":["privateKey","certificate","keyPassphrase"]}
{"id":"<条目 ID>"}
~~~

`vault_get.fields` 选择顶层字段。读取自定义字段对象时使用 `fields:["fields"]`；CLI 可以用 `--field fields.customName` 选择一个自定义字段。

## 将字段用于实际操作

| 类型 | 常用字段 | 使用方式 |
|---|---|---|
| SSH 密码认证 | host、port、username、sshAuth、password | 把连接参数和 password 传给支持密码认证的 SSH／远程执行工具。 |
| SSH 私钥／证书 | host、port、username、privateKey、certificate、keyPassphrase | 依据工具接口提供私钥内容、密钥文件、证书和口令。 |
| 网站登录 | url、username、email、password | 把字段填入对应登录操作。 |
| API Key／OAuth | apiKey、secret、accessToken、refreshToken | 按目标接口要求设置请求参数、Header 或客户端认证配置。 |
| TOTP | 条目 ID | 使用 `vault_totp({id:"<条目 ID>"})` 获取当前验证码。 |

认证字段可以直接用于现有工具的参数、交互输入、stdin 或进程环境；具体选择取决于该工具支持的接口。对于 SSH 密码登录，优先选用具备密码认证接口的客户端；普通 ssh 命令可能需要交互式输入。

执行用户指定的连接或请求后，检查返回结果，再说明完成情况。查找、取值、认证和执行是不同步骤；哪一步失败就报告哪一步及其错误。

## CLI 用法

已安装 `dsh-vault` 时：

~~~sh
dsh-vault list --json
dsh-vault get "demo-server" --field host
dsh-vault get "demo-server" --field username
dsh-vault get "demo-server" --field port
dsh-vault get "demo-server" --field password
dsh-vault get "demo-api" --field apiKey
dsh-vault get "demo-server" --all
dsh-vault totp "demo-account" --json
~~~

`get` 未指定字段时返回条目的主凭据；`--all` 返回完整条目。

独立 CLI 与 GUI 是不同进程，不自动继承 GUI 内存中的解锁材料。CLI 的主密码来源为 `--password-stdin`、`DSH_VAULT_MASTER_PASSWORD`／`DSH_VAULT_PASSWORD` 或本机交互输入。

## 功能未就绪时

- 密码库尚未打开或已锁定：在“设置 → 密码管理(1pass)”打开／解锁后继续。
- 缺少 vault 工具：检查插件是否启用以及当前工具档位是否包含相应功能。
- 找不到条目或缺少连接字段：说明没有匹配的记录或具体缺少哪些字段。
- SSH／API 工具不支持所需认证方式：说明当前工具能力和实际需要的接口。
