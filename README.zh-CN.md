# AI Ops MCP

[English](README.md) | [简体中文](README.zh-CN.md)

AI Ops MCP 是本地 SSH 凭据代理和 stdio MCP Server。AI 客户端通过稳定的 `server_id` 使用 SSH 与 SFTP，无需接收密码、私钥内容或私钥口令。

> [!WARNING]
> AI Ops MCP 保护认证边界，但不会判断、审批或拦截远程命令。命令以所配置 SSH 账号的权限执行。请使用专用低权限账号，并在服务器端实施权限控制。

`0.1.0` 仅以源码形式发布，未发布到 npm。

## 功能

- 交互式录入服务器并固定可信 Host key
- 支持 SSH Agent、系统凭据库密码和私钥认证
- 集成 Windows Credential Manager、macOS Keychain 和 Linux Secret Service
- 连接复用、单服务器及全局并发限制
- 远程命令、上传、下载和目录列表
- 本地/远程路径边界、超时、输出与文件大小限制
- 结构化审计日志和稳定的公开错误码

## 安全模型

密码和私钥口令通过隐藏输入获取，并保存到操作系统凭据库。普通配置文件只保存非敏感连接元数据，且采用私有文件权限。私钥始终保留在本地文件中，只在建立连接时读取。录入服务器时必须确认 Host key 指纹，后续指纹变化会被拒绝。

MCP 接口不能枚举或导出凭据。本地文件操作默认只允许 MCP 进程的工作目录，可按服务器追加本地和远程根目录。审计日志可能包含命令与路径，应作为运维数据保护。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

该模型不能防御已攻陷的本地用户账号、包含敏感内容的远程输出、已攻陷的远端主机，也不会阻止使用合法 SSH 权限执行破坏性命令。

## 环境要求

- Node.js 22 或 24
- Git 和可访问的 SSH Server
- 已通过可信渠道核验的 SSH Host key 指纹
- 三种受支持认证方式之一
- Linux 密码/口令用户需运行 Secret Service provider

Windows Credential Manager 已在 Windows 10 与 Node.js 24 上完成验证。macOS Keychain 和 Linux Secret Service 仍需要更多真机反馈。

## 安装与构建

```bash
git clone https://github.com/Finn-Aigc/ai-ops-mcp.git
cd ai-ops-mcp
npm ci
npm run typecheck
npm test
npm run build
npm link
ai-ops doctor
```

`npm link` 会在本机提供 `ai-ops` 和 `ai-ops-mcp`。开发 CLI 时使用 `npm run dev -- --help`；构建后可使用 `npm start -- --help`。

## 认证方式

### SSH Agent

先向系统 Agent 加载密钥，再执行 `ai-ops add --auth agent`，或直接导入 OpenSSH 的最终配置：

```bash
ai-ops import-ssh my-host-alias
```

### 系统凭据库密码

```bash
ai-ops add --id dev-box --host ssh.example.com --user deploy --auth password
```

密码只通过交互方式输入，不能作为命令行参数传递。

### 私钥文件

```bash
ai-ops add --id dev-key --host ssh.example.com --user deploy \
  --auth private-key --key <path-to-private-key>
```

私钥保留在指定路径。若私钥已加密，口令会通过交互方式获取并保存到系统凭据库。

## CLI 参考

| 命令 | 用途 |
| --- | --- |
| `ai-ops add` | 添加服务器并确认 Host key |
| `ai-ops import-ssh <alias>` | 导入 OpenSSH 配置并使用 Agent 认证 |
| `ai-ops list [--json]` | 列出别名和凭据状态 |
| `ai-ops show <id>` | 显示非敏感服务器元数据 |
| `ai-ops test <id>` | 测试连接 |
| `ai-ops edit <id>` | 更新元数据、路径范围或凭据 |
| `ai-ops remove <id>` | 删除服务器和已保存凭据 |
| `ai-ops trust-host <id>` | 替换已核验的 Host key 指纹 |
| `ai-ops doctor [--json]` | 诊断配置、凭据库和 Agent |
| `ai-ops logs` | 查询审计事件 |

完整参数请运行 `ai-ops <command> --help`。不要通过命令行参数自动传入密码或口令。

## MCP 客户端配置

完成 `npm link` 后，在任意 stdio MCP 客户端中配置：

```json
{
  "mcpServers": {
    "ai-ops": {
      "command": "ai-ops-mcp"
    }
  }
}
```

开发阶段如不使用 link，请先构建，再以 `node` 为命令，并把 `"<absolute-path-to-repository>/dist/mcp-entry.js"` 作为唯一参数。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `list_servers` | 列出服务器别名和状态，不暴露凭据 |
| `test_connection` | 测试指定 `server_id` |
| `execute_command` | 执行任意远程命令 |
| `upload_file` | 从允许的本地根目录上传文件 |
| `download_file` | 下载文件到允许的本地根目录 |
| `list_dir` | 列出允许的远程目录 |

默认限制为：单命令 30 秒、命令合计输出 10 MiB、单文件 100 MiB、单服务器四个并发操作、全局 16 个并发操作。可按服务器调整限制。

## 故障排查

- 首先运行 `ai-ops doctor`，检查凭据库、Agent、配置和服务器状态。
- `HOST_KEY_MISMATCH`：通过可信渠道核验新指纹，再运行 `ai-ops trust-host <id>`。
- `AGENT_UNAVAILABLE`：启动 SSH Agent，并使用 `ssh-add` 加载密钥。
- `CREDENTIAL_STORE_UNAVAILABLE`：解锁或启动系统凭据服务。
- `LOCAL_PATH_NOT_ALLOWED` / `REMOTE_PATH_NOT_ALLOWED`：使用 `ai-ops edit <id> --allowed-local ... --allowed-remote ...` 更新范围。
- MCP 进程立即退出：运行 `npm run build`，检查配置中的可执行文件或绝对入口路径。

## 本地 Live E2E

真实 SSH E2E 不接入 GitHub Actions。请使用隔离的应用目录和专用低权限测试账号；该账号需能在 `/tmp` 创建临时文件，并能更新自身的 `~/.ssh/authorized_keys`：

```powershell
$env:AI_OPS_HOME = "<isolated-ai-ops-home>"
$env:AI_OPS_E2E_SERVER_ID = "test-server"
npm run build
npm run test:e2e:core
npm run test:e2e:mcp
npm run test:e2e:auth
npm run test:e2e:agent
npm run test:e2e:cleanup
```

测试使用唯一临时资源，并在 `finally` 中清理。禁止使用生产凭据或配置。更多信息见 [CONTRIBUTING.md](CONTRIBUTING.md)、[docs/PRD.md](docs/PRD.md) 和 [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)。

## 许可证

[MIT](LICENSE) © 2026 AI Ops MCP contributors。
