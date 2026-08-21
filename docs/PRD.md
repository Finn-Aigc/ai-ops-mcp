# AI Ops MCP 产品需求文档

| 项目 | 内容 |
| --- | --- |
| 产品名称 | AI Ops MCP（项目名：`ai-ops-mcp`） |
| 产品定位 | 面向 AI 编程平台的本地 SSH 凭据代理与远程操作桥接器 |
| 文档版本 | v0.1.0 项目说明 |
| 日期 | 2026-08-20 |
| 参考基线 | `@fangjunjie/ssh-mcp-server@1.9.0` |
| 目标用户 | 个人开发者、小团队，管理自有测试、个人和低风险服务器 |

## 1. 产品摘要

AI Ops MCP 是一个运行在用户本机的 MCP Server。用户通过 CLI 预先配置服务器及认证方式，AI 平台只使用 `server_id` 调用远程命令和文件传输工具，不直接接收 SSH 密码、私钥内容或私钥口令。

产品核心价值是凭据隔离和连接复用，不判断远程命令是否安全，也不尝试通过命令白名单、黑名单或字符串分类器限制 Shell 行为。

一句话定义：

> 为 AI 提供可用的 SSH 能力，为用户保管认证边界。

## 2. 背景与问题

支持 MCP 的 AI 编程平台已经能够执行本地开发任务，但远程服务器操作通常仍依赖以下方式：

1. 用户把服务器地址、账号和密码直接发给 AI。
2. 用户把密码写入 MCP 客户端配置或命令行参数。
3. 用户让 AI 直接读取私钥文件并调用 `ssh`。
4. 用户在 AI 和传统 SSH 客户端之间反复复制命令与结果。

这些方式存在共同问题：

- 密码和口令可能进入对话、进程参数、日志或配置同步。
- 私钥内容可能被具有本地文件读取能力的 AI 获取。
- 不同 AI 平台需要重复配置连接细节。
- 缺少统一的服务器别名、连接状态和审计记录。
- 传统 SSH MCP 项目通常完成了执行层，却把明文密码留在 JSON 或 MCP 启动参数中。

## 3. 产品目标

### 3.1 核心目标

- AI 通过稳定的 `server_id` 使用 SSH/SFTP，不需要认证凭据。
- 密码和私钥口令保存在操作系统凭据库，不写入普通 JSON、命令行参数或日志。
- 私钥认证优先复用系统 `ssh-agent` 或 Windows OpenSSH Agent。
- 首次连接由用户在 CLI 中确认服务器 Host key fingerprint，后续指纹变化时拒绝连接。
- 提供接近传统 SSH 客户端的“一次录入、日常无感”体验。
- 支持 Codex、Claude Code 等使用 stdio MCP 的平台。

### 3.2 次要目标

- 支持多服务器、分组和连接状态检查。
- 支持远程命令、上传、下载和目录列表。
- 限制 MCP 文件工具能够访问的本地与远程路径范围。
- 提供结构化审计日志和稳定错误码。
- 连接池、超时、输出上限和自动重连具备可预测行为。

## 4. 非目标与责任边界

MVP 明确不做：

- 命令白名单、黑名单或只读/写入分类。
- 危险命令识别或拦截。
- 写操作二次确认和审批流。
- 企业堡垒机、RBAC、多用户协作和云端凭据同步。
- Web 管理界面和交互式终端。
- 生产服务器安全治理替代方案。
- 防御已经获得当前操作系统用户权限的恶意程序。

产品必须明确告知用户：

> AI Ops MCP 隔离 SSH 认证凭据，但不会判断 AI 提交的远程命令是否安全。命令以配置的 SSH 账号权限执行。用户应通过低权限账号、远端文件权限、`sudoers`、容器和环境隔离控制影响范围。

## 5. 威胁模型

### 5.1 需要防范

- 用户误把 SSH 密码或私钥口令发送到 AI 对话。
- 凭据出现在 MCP 启动参数和普通配置文件中。
- MCP 工具响应、错误信息或审计日志泄露认证凭据。
- AI 通过 MCP 接口枚举或导出凭据。
- SSH 中间人攻击导致凭据发送到未知服务器。
- AI 通过文件工具读取本地任意文件或覆盖工作区外文件。
- 无限制命令输出、并发或文件传输造成明显的本地资源耗尽。

### 5.2 不承诺防范

- 已控制当前用户账户或能够读取进程内存的本地攻击者。
- AI 使用合法 SSH 权限执行破坏性命令。
- 远程命令输出本身包含 Token、环境变量或业务敏感信息。
- 远端主机已经被入侵。
- 操作系统凭据库自身的安全漏洞。

## 6. 目标用户与场景

### 6.1 目标用户

- 使用 Codex、Claude Code 等 AI 编程平台的个人开发者。
- 管理 1 至 50 台 VPS、NAS、测试机或开发环境的小团队成员。
- 理解基本 SSH 概念，但不希望手工管理 Agent 生命周期和多套 MCP 配置。

### 6.2 核心场景

1. 用户添加服务器并选择密码认证，密码进入系统凭据库。
2. 用户导入 `~/.ssh/config` 中已有的 Host，并使用 Agent 认证。
3. AI 调用 `execute_command` 查看服务状态或完成部署操作。
4. AI 在允许路径内上传配置或下载日志。
5. Host key 发生变化时，连接被拒绝，用户通过 CLI 检查和更新。
6. 用户通过审计日志确认 AI 在什么时间对哪台服务器执行了什么操作。

## 7. 产品原则

1. **凭据永不进入 MCP Schema**：工具参数和响应中不设计密码、私钥或口令字段。
2. **配置与秘密分离**：普通配置只保存连接元数据和凭据引用。
3. **首次信任由用户建立**：AI 无权接受未知或变化的 Host key。
4. **系统能力优先**：优先复用 Agent 和系统凭据库，不自制可逆密码加密。
5. **默认限制文件边界**：本地文件访问默认限制在 MCP 客户端提供的工作区根目录。
6. **不虚假承诺命令安全**：不把正则匹配包装成安全边界。
7. **失败应清晰可恢复**：错误包含稳定错误码、是否可重试和用户下一步。

## 8. 功能需求

### FR-1：服务器配置管理

仅通过本地 CLI 管理，不向 AI 暴露增删改能力。

CLI 命令：

```text
ai-ops add
ai-ops import-ssh <host-alias>
ai-ops edit <server-id>
ai-ops remove <server-id>
ai-ops list
ai-ops show <server-id>
ai-ops test <server-id>
ai-ops doctor
ai-ops trust-host <server-id>
ai-ops logs
```

要求：

- `server_id` 在本机范围内唯一。
- 密码使用隐藏输入，不接受 `--password <value>`。
- 私钥口令使用隐藏输入，不接受普通命令行参数。
- 删除服务器时同时删除对应系统凭据，经用户确认后执行。
- 支持标签和分组，但不引入权限语义。
- 配置保存后立即进行 schema 校验。

### FR-2：认证方式

MVP 支持三种认证方式：

#### A. SSH Agent

- Linux/macOS 使用 `SSH_AUTH_SOCK`。
- Windows 支持 Windows OpenSSH Agent，自动检测默认命名管道。
- CLI 显示 Agent 是否可用、已加载 identity 数量和目标密钥匹配结果。
- 可选保存公钥 fingerprint，用于限制使用的 identity。

#### B. 系统凭据库密码认证

- Windows：Windows Credential Manager。
- macOS：Keychain。
- Linux 桌面：Secret Service。
- 普通配置只保存 `credential_ref`。
- 获取到的密码只在连接建立期间存在于进程内存，不记录、不返回。

#### C. 私钥文件

- 普通配置可保存私钥路径，但不保存私钥内容。
- 私钥口令保存在系统凭据库，只保存 `passphrase_ref`。
- 无口令私钥允许使用，但 CLI 必须提示其风险。

### FR-3：Host key 信任

- 首次添加或测试服务器时获取 Host key fingerprint。
- CLI 向用户展示主机、端口、算法和 fingerprint。
- 用户确认后保存 fingerprint。
- MCP 调用不得自动信任未知 Host key。
- 指纹变化时返回 `HOST_KEY_MISMATCH`，不得降级连接。
- 更新 fingerprint 必须由 CLI 显式执行并再次确认。

### FR-4：MCP 服务器列表

工具：`list_servers`

默认输出：

```json
{
  "servers": [
    {
      "id": "dev-vps",
      "name": "开发服务器",
      "group": "dev",
      "connected": true,
      "auth_status": "ready"
    }
  ]
}
```

不返回密码、私钥、口令、凭据引用和 Host key。是否返回 `host` 与 `username` 由本地 `expose_connection_metadata` 配置决定，默认不返回。

### FR-5：连接测试

工具：`test_connection`

输入：

```json
{ "server_id": "dev-vps" }
```

输出连接状态、延迟、认证方式类别和可恢复错误，不返回认证细节。

### FR-6：远程命令执行

工具：`execute_command`

输入：

```json
{
  "server_id": "dev-vps",
  "command": "uptime",
  "cwd": "/srv/app",
  "timeout_ms": 30000
}
```

输出：

```json
{
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "signal": null,
  "duration_ms": 182,
  "truncated": false
}
```

行为要求：

- 不进行命令语义分类。
- 默认超时 30 秒，最大可请求超时由本地配置限制。
- stdout 与 stderr 总大小默认上限 10 MiB。
- 超限时终止 channel，并明确标记 `truncated`。
- 不使用本地 Shell 拼接 SSH 命令。

### FR-7：文件传输

工具：

- `upload_file(server_id, local_path, remote_path)`
- `download_file(server_id, remote_path, local_path)`
- `list_dir(server_id, remote_path)`

要求：

- 本地路径必须落在允许根目录内，并解析符号链接后验证。
- 默认允许根目录为当前 MCP 工作区。
- 远程路径必须是绝对 POSIX 路径。
- 服务器可以配置 `allowed_remote_paths`；未配置时允许 SSH 账号可访问的路径，但 CLI 和 `doctor` 给出明确提示。
- 下载不得覆盖已存在文件，除非工具参数显式设置 `overwrite=true`。
- 文件大小和传输超时可配置。
- MVP 不支持目录递归传输。

### FR-8：审计日志

每次 MCP 调用记录 JSON Lines：

```json
{
  "timestamp": "2026-08-20T10:30:00.000Z",
  "request_id": "uuid",
  "server_id": "dev-vps",
  "action": "execute_command",
  "command": "uptime",
  "result": "success",
  "exit_code": 0,
  "duration_ms": 182
}
```

要求：

- 不记录密码、私钥、口令和凭据引用。
- 默认记录完整命令，但支持 `audit.command_mode=hash`。
- 文件路径可记录，文件内容不可记录。
- 按天滚动，默认保留 30 天。
- CLI 支持按服务器、动作和时间过滤。

### FR-9：环境诊断

`ai-ops doctor` 检查：

- Node.js 和运行平台版本。
- 系统凭据库 Provider 可用性。
- SSH Agent/Windows OpenSSH Agent 状态。
- 已配置服务器的凭据引用是否存在。
- 配置文件权限。
- Host key 是否已建立信任。
- 审计目录是否可写。
- MCP 客户端配置是否包含明文密码模式。

诊断默认只报告，不自动修改系统服务或管理员设置。

## 9. 非功能需求

### NFR-1：安全

- 禁止通过 CLI 参数接收密码和私钥口令。
- 禁止将 secret 放入环境变量作为正式认证方式。
- 所有日志字段采用允许列表，不序列化完整连接配置。
- 凭据对象使用后释放引用，避免长期缓存明文密码。
- Host key verification 必须覆盖所有 SSH 与 SFTP 连接。
- 配置文件采用当前用户最小访问权限；Windows 使用 ACL，Unix 使用 `0600`。

### NFR-2：兼容性

- 本地：Windows 10/11、macOS 当前及前一主要版本、主流 Linux 桌面发行版。
- 目标：Linux/macOS SSH Server。
- Node.js：22 LTS 起。
- MCP：stdio transport。

### NFR-3：性能与可靠性

- 除 SSH 握手外，本地请求处理 P95 小于 50 ms。
- 同一服务器复用连接。
- 连接断开后执行一次受控重连，不自动重复可能已经执行的命令。
- 默认每台服务器并发 channel 上限 4，全局上限 16。
- MCP Server 收到 stdio EOF 或终止信号后关闭连接并刷新审计日志。

### NFR-4：易用性

- 熟悉 SSH 的用户可通过一次 `import-ssh` 完成 Agent 连接。
- 密码用户通过一次隐藏输入完成凭据保存。
- 添加服务器流程在成功情况下不超过 2 分钟。
- 错误消息同时包含原因和可执行的修复建议。

### NFR-5：可维护性

- Credential Provider、SSH 层、MCP 层和 CLI 层相互隔离。
- 核心模块单元测试覆盖率不低于 80%。
- 凭据泄露防护、Host key 和路径边界必须有独立安全测试。

## 10. 配置模型

`~/.ai-ops/config.json` 示例：

```json
{
  "version": 1,
  "defaults": {
    "command_timeout_ms": 30000,
    "max_output_bytes": 10485760,
    "max_channels_per_server": 4,
    "expose_connection_metadata": false
  },
  "servers": [
    {
      "id": "dev-vps",
      "name": "开发服务器",
      "group": "dev",
      "host": "ssh.example.com",
      "port": 22,
      "username": "deploy",
      "auth": {
        "type": "system_credential",
        "credential_ref": "ai-ops/server/dev-vps/password"
      },
      "host_key": {
        "algorithm": "ssh-ed25519",
        "fingerprint": "SHA256:..."
      },
      "allowed_local_paths": [],
      "allowed_remote_paths": ["/srv/app", "/var/log/myapp"]
    },
    {
      "id": "nas",
      "name": "家庭 NAS",
      "host": "nas.local",
      "port": 22,
      "username": "ops",
      "auth": {
        "type": "agent",
        "public_key_fingerprint": "SHA256:..."
      },
      "host_key": {
        "algorithm": "ssh-ed25519",
        "fingerprint": "SHA256:..."
      }
    }
  ]
}
```

配置文件中禁止出现以下字段：

```text
password
passphrase
private_key_content
secret
token
```

## 11. 用户体验

### 11.1 添加密码服务器

```text
$ ai-ops add
服务器 ID: dev-vps
名称: 开发服务器
地址: ssh.example.com
端口 [22]:
用户名: deploy
认证方式: Password
密码: ********
正在保存到 Windows Credential Manager...
服务器 Host key: ssh-ed25519 SHA256:...
是否信任该指纹? Yes
连接测试成功。
```

### 11.2 导入 Agent 服务器

```text
$ ai-ops import-ssh my-vps
读取 ~/.ssh/config: my-vps -> deploy@ssh.example.com:22
SSH Agent: ready, 2 identities
匹配 identity: SHA256:...
服务器 Host key: ssh-ed25519 SHA256:...
是否信任该指纹? Yes
已添加为 server_id: my-vps
```

### 11.3 Host key 变化

```text
HOST_KEY_MISMATCH
服务器 dev-vps 返回的 Host key 与已保存指纹不同。
连接已拒绝。请在可信渠道确认服务器变更后运行：
ai-ops trust-host dev-vps --replace
```

## 12. 竞品基线与差异化

参考项目 `@fangjunjie/ssh-mcp-server@1.9.0` 已具备：

- `ssh2` 连接、Agent、密码和私钥认证。
- 多服务器、连接复用、超时和 keepalive。
- 命令执行、SFTP 上传下载。
- 本地/远程路径边界和较完整测试。

AI Ops MCP 不以增加更多 SSH 命令为主要差异，而集中解决以下缺口：

- 不在启动参数和 JSON 保存明文密码。
- 系统凭据库抽象和易用 CLI。
- Host key fingerprint 校验。
- Agent 状态检测和身份匹配。
- 结构化审计。
- 对产品安全能力做准确、有限的承诺。

## 13. MVP 范围

MVP 必须完成：

- CLI 服务器增删改查。
- SSH Agent、系统凭据库密码、私钥文件三种认证。
- Host key enrollment 与 verification。
- `list_servers`、`test_connection`、`execute_command`。
- `upload_file`、`download_file`、`list_dir`。
- 本地路径边界和可选远端路径边界。
- 连接池、超时、输出上限和并发上限。
- JSONL 审计日志。
- `doctor`。
- Windows、macOS、Linux 基础兼容测试。

MVP 不包含：

- 命令规则系统。
- 交互式 PTY。
- ProxyJump、复杂 `ssh_config` 完整兼容。
- 2FA/OTP 自动化。
- 云同步和 Web UI。

## 14. 成功指标

- 90% 的测试用户可在 5 分钟内完成安装、添加服务器并执行 `uptime`。
- 正常流程中，MCP 客户端配置、普通配置、日志和工具响应均不出现认证凭据。
- 已配置凭据的用户，日常 AI 调用无需再次输入密码或口令。
- Host key 未信任或发生变化时，连接拒绝率为 100%。
- 本地路径越界和符号链接逃逸测试阻止率为 100%。
- 100 次连续短命令测试中无连接泄漏，成功率不低于 99%。

## 15. 发布门槛

以下任一条件未满足，不发布 v1.0：

- 任一支持平台无法可靠使用系统凭据库，且没有明确降级策略。
- 密码或口令能够通过 MCP 工具、日志或错误栈泄露。
- Host key verification 可被跳过。
- 本地文件路径限制存在已知逃逸。
- MCP Server 崩溃会遗留无法恢复的配置或凭据状态。
- 没有完成真实 SSH Server 的端到端测试。
