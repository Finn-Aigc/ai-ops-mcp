# AI Ops MCP 实现方案

## 1. 实现决策摘要

建议采用 TypeScript、Node.js 22、`@modelcontextprotocol/sdk` 和 `ssh2`，新建清晰分层的代码库；参考 `@fangjunjie/ssh-mcp-server@1.9.0` 的连接管理、超时、路径校验和测试思路，但不直接延续其命令行凭据模型和大型单体 `SSHConnectionManager`。

核心技术决策：

1. MCP Server 只接受 `server_id`，不接受认证字段。
2. 配置仓库与凭据仓库完全分离。
3. 认证通过可插拔 `CredentialProvider` 解析。
4. Host key verification 是连接层不可绕过的前置条件。
5. 命令直接通过 `ssh2.exec()` 执行，不进行白名单/黑名单判断。
6. 文件工具保留严格的本地路径边界。
7. 首版优先实现 `exec`，不实现持久交互式 Shell。

## 2. 先行技术验证

正式开发前安排 2 至 3 天 Spike，产出可运行代码和决策记录。

### Spike A：系统凭据库

验证候选跨平台 Node 原生模块是否满足：

- Windows Credential Manager Generic Credential 读写删。
- macOS Keychain 读写删。
- Linux Secret Service 读写删。
- Node.js 22 预编译二进制可用，无需用户安装编译工具。
- npm 包仍在维护，许可证可接受。
- 错误能够区分“凭据不存在”“系统服务不可用”“用户拒绝访问”。

候选顺序：

1. 维护活跃、提供预编译包的跨平台 keyring 模块。
2. 平台原生 Adapter：Windows Credential API、macOS `security`、Linux `secret-tool`。
3. 如 Linux 无 Secret Service，MVP 明确只支持 Agent/私钥文件，不降级到明文密码。

不使用已经停止维护且安装依赖不稳定的库作为唯一实现。最终依赖由 Spike ADR 确定，不在 PRD 中绑定具体包名。

### Spike B：Windows OpenSSH Agent

验证：

- `ssh2` 是否能够通过 Windows 默认 OpenSSH Agent 命名管道认证。
- Agent 服务未运行、无 identity、密钥不匹配时的错误行为。
- 能否可靠读取 identity fingerprint 并选择指定 identity。
- MCP 子进程是否能够继承或推导 Agent 地址。

### Spike C：Host key

验证 `ssh2` 的 `hostHash` 与 `hostVerifier`：

- CLI enrollment 获取 SHA-256 fingerprint。
- 正常连接匹配。
- 指纹变化拒绝。
- 代理连接和重连仍执行校验。

Spike 退出条件：三项都有自动化验证；否则调整 MVP 平台范围，不用自制加密绕过问题。

## 3. 总体架构

```text
AI Platform
    |
    | MCP stdio: server_id + operation
    v
MCP Tool Layer
    |
    v
Operation Service ---------------------> Audit Logger
    |
    +--> Server Repository (metadata only)
    |
    +--> Credential Resolver
    |       +--> SSH Agent Provider
    |       +--> System Keyring Provider
    |       +--> Private Key Provider
    |
    +--> SSH Connection Pool
            +--> Host Key Verifier
            +--> Command Executor
            +--> SFTP Service
```

凭据数据流：

```text
CLI hidden input
    -> System Credential Store
    -> returns credential_ref
    -> config.json stores reference only

MCP call(server_id)
    -> load server metadata
    -> resolve credential in process
    -> ssh2 connect
    -> release secret reference
    -> return operation result only
```

## 4. 建议目录结构

```text
ai-ops-mcp/
  package.json
  tsconfig.json
  src/
    index.ts
    cli/
      index.ts
      commands/
        add.ts
        edit.ts
        remove.ts
        list.ts
        test.ts
        doctor.ts
        trust-host.ts
        logs.ts
      prompts.ts
    config/
      schema.ts
      repository.ts
      permissions.ts
      paths.ts
    credentials/
      types.ts
      resolver.ts
      agent-provider.ts
      system-keyring-provider.ts
      private-key-provider.ts
    ssh/
      connection-pool.ts
      connection-factory.ts
      host-key-verifier.ts
      executor.ts
      sftp-service.ts
      limits.ts
    mcp/
      server.ts
      tools/
        list-servers.ts
        test-connection.ts
        execute-command.ts
        upload-file.ts
        download-file.ts
        list-dir.ts
    audit/
      logger.ts
      schema.ts
      query.ts
      rotation.ts
    errors/
      codes.ts
      app-error.ts
      mapper.ts
    utils/
      fingerprint.ts
      path-boundary.ts
      redaction.ts
      timeout.ts
  test/
    unit/
    integration/
    security/
    e2e/
  docs/
    PRD.md
    IMPLEMENTATION_PLAN.md
    adr/
```

## 5. 核心接口

### 5.1 服务器配置

```typescript
type AuthConfig =
  | {
      type: "agent";
      publicKeyFingerprint?: string;
    }
  | {
      type: "systemCredential";
      credentialRef: string;
    }
  | {
      type: "privateKey";
      privateKeyPath: string;
      passphraseRef?: string;
    };

interface ServerConfig {
  id: string;
  name: string;
  group?: string;
  host: string;
  port: number;
  username: string;
  auth: AuthConfig;
  hostKey: {
    algorithm: string;
    fingerprint: string;
  };
  allowedLocalPaths?: string[];
  allowedRemotePaths?: string[];
  limits?: Partial<ConnectionLimits>;
}
```

使用 Zod 进行运行时校验，并增加拒绝秘密字段的递归检查。即使未知字段被配置文件带入，也不得透传到日志。

### 5.2 凭据 Provider

```typescript
type ResolvedCredential =
  | { type: "agent"; agentSocket: string; publicKeyFingerprint?: string }
  | { type: "password"; password: string }
  | { type: "privateKey"; privateKey: Buffer; passphrase?: string };

interface CredentialProvider {
  supports(server: ServerConfig): boolean;
  resolve(server: ServerConfig): Promise<ResolvedCredential>;
  diagnose(server: ServerConfig): Promise<CredentialDiagnosis>;
}
```

约束：

- `ResolvedCredential` 不实现 JSON 序列化输出。
- 不把凭据对象挂在全局配置或长期连接元数据上。
- 日志工具只接受预定义字段，禁止传递 Provider 返回值。
- 密码字符串无法在 JavaScript 中可靠清零，因此安全承诺应限定为“尽快释放引用”；私钥 `Buffer` 使用后执行 `fill(0)`。

### 5.3 Host key verifier

```typescript
interface HostKeyVerifier {
  verify(server: ServerConfig, rawHostKey: Buffer): boolean;
  inspect(rawHostKey: Buffer): {
    algorithm: string;
    fingerprint: string;
  };
}
```

连接工厂必须要求 `hostKey` 存在。只有 CLI enrollment 使用的独立探测方法允许未知 key，并且该方法不得暴露给 MCP。

### 5.4 连接池

```typescript
interface ConnectionPool {
  acquire(serverId: string): Promise<SSHConnectionLease>;
  invalidate(serverId: string, reason: string): Promise<void>;
  closeAll(): Promise<void>;
}
```

池 key 至少包含：

```text
server_id
host
port
username
auth config revision
host key fingerprint
```

配置或凭据变更后使旧连接失效。

## 6. 系统凭据库设计

### 6.1 命名规则

```text
service: ai-ops-mcp
account: server/<server_id>/password
account: server/<server_id>/private-key-passphrase
```

`credential_ref` 是逻辑引用，不携带 secret：

```text
keyring://ai-ops-mcp/server/dev-vps/password
```

### 6.2 生命周期

添加：

1. CLI 隐藏输入 secret。
2. 先写凭据库。
3. 再原子写配置文件。
4. 配置写入失败时删除刚创建的凭据，避免孤儿数据。

更新：

1. 写入临时 credential key。
2. 测试连接。
3. 原子更新配置引用。
4. 删除旧 credential key。

删除：

1. 用户确认目标服务器。
2. 删除配置。
3. 删除对应 credential。
4. 审计记录只记录引用类型，不记录引用值。

### 6.3 失败处理

- 凭据库不可用：返回 `CREDENTIAL_STORE_UNAVAILABLE`。
- 凭据不存在：返回 `CREDENTIAL_NOT_FOUND`。
- 用户或系统拒绝读取：返回 `CREDENTIAL_ACCESS_DENIED`。
- 不允许自动回退到 JSON 明文。

## 7. SSH Agent 设计

### 7.1 Agent 发现

- Linux/macOS：读取 `SSH_AUTH_SOCK` 并验证 socket 可连接。
- Windows：优先显式配置，其次检测 OpenSSH Agent 默认命名管道。
- Pageant 支持作为后续兼容项，不进入首版发布门槛。

### 7.2 身份匹配

添加服务器时：

1. 枚举 Agent identities。
2. 计算 SHA-256 fingerprint。
3. 用户选择目标 identity，或在仅有一个 identity 时确认。
4. 配置保存 fingerprint，不保存公钥原文也可完成匹配。

连接时只允许匹配的 identity。若底层 Agent API 无法强制选择，则 Provider 需要实现代理过滤层；不能只把整个 Agent socket 交给 `ssh2` 后声称已锁定 identity。

## 8. Host key enrollment

### 8.1 首次添加

CLI 使用独立探测连接获取服务器 Host key，但不发送密码或私钥认证数据。向用户显示：

```text
host: ssh.example.com:22
algorithm: ssh-ed25519
fingerprint: SHA256:...
```

用户确认后写入配置，再开始认证测试。

### 8.2 正常连接

在 `ssh2` 配置中设置 SHA-256 Host key hash 和 verifier。任何不匹配立即中断，错误不得被通用重连逻辑吞掉。

### 8.3 更新

`ai-ops trust-host <id> --replace`：

1. 显示旧指纹和新指纹。
2. 要求明确确认。
3. 原子更新配置。
4. 关闭该服务器旧连接。
5. 写入审计事件 `host_key_replaced`。

## 9. MCP 工具实现

### 9.1 通用处理管线

```text
Zod input validation
  -> request_id
  -> load server by id
  -> acquire concurrency permit
  -> acquire verified SSH connection
  -> execute operation with timeout/size limit
  -> normalized result
  -> audit event
  -> release permit
```

### 9.2 错误格式

```json
{
  "code": "HOST_KEY_MISMATCH",
  "message": "Server host key does not match the trusted fingerprint.",
  "retriable": false,
  "action": "Run ai-ops trust-host dev-vps --replace after verification."
}
```

稳定错误码：

```text
SERVER_NOT_FOUND
CONFIG_INVALID
CREDENTIAL_NOT_FOUND
CREDENTIAL_STORE_UNAVAILABLE
CREDENTIAL_ACCESS_DENIED
AGENT_UNAVAILABLE
AGENT_IDENTITY_NOT_FOUND
HOST_KEY_UNTRUSTED
HOST_KEY_MISMATCH
SSH_CONNECTION_TIMEOUT
SSH_AUTHENTICATION_FAILED
COMMAND_TIMEOUT
OUTPUT_LIMIT_EXCEEDED
LOCAL_PATH_NOT_ALLOWED
REMOTE_PATH_NOT_ALLOWED
LOCAL_FILE_EXISTS
SFTP_TIMEOUT
CONCURRENCY_LIMIT
INTERNAL_ERROR
```

### 9.3 命令执行

- 使用 `ssh2.exec()`，命令字符串直接发送给远端 SSH Server。
- `cwd` 使用独立的 POSIX shell quoting 函数生成 `cd -- <quoted-directory> && <command>`；目录值不得直接拼接，quoting 函数需要覆盖单引号、换行和控制字符测试。
- 绝不通过本地 `child_process.exec()` 拼接 `ssh` 命令。
- 超时后关闭 SSH channel；不要自动再次执行命令。
- 连接级错误发生在确认命令尚未发送前时，最多重连一次。

### 9.4 文件边界

本地路径验证流程：

1. 拒绝空字符串和 NUL。
2. `path.resolve()` 得到绝对路径。
3. 对已存在路径调用 `realpath()`。
4. 下载新文件时对父目录调用 `realpath()`。
5. 使用路径分段比较，而不是字符串前缀比较。
6. Windows 路径比较处理大小写和 junction。
7. 验证通过后再打开文件，尽量降低 TOCTOU 窗口。

远程路径：

- 只接受绝对 POSIX 路径。
- 使用 `path.posix.normalize()`。
- 远端符号链接无法仅靠字符串验证完全控制，因此 `allowed_remote_paths` 只作为范围约束，不宣传为完整沙箱。

## 10. 配置与原子写入

配置位置：

```text
Windows: %APPDATA%\ai-ops\config.json
macOS:   ~/Library/Application Support/ai-ops/config.json
Linux:   $XDG_CONFIG_HOME/ai-ops/config.json
```

日志位置遵循对应平台数据目录。

写入流程：

1. 在同目录创建随机临时文件。
2. 写入完整 JSON。
3. flush 并设置权限。
4. 原子 rename 替换目标文件。
5. Windows 设置只允许当前用户访问的 ACL；Unix 设置 `0600`。

配置包含 `version`，启动时执行显式 migration，不静默忽略未知高版本。

## 11. 审计与脱敏

审计事件采用显式 schema，不允许直接记录异常对象、SSH 配置或 MCP 原始请求。

```typescript
interface AuditEvent {
  timestamp: string;
  requestId: string;
  serverId: string;
  action: string;
  outcome: "success" | "failure";
  durationMs: number;
  command?: string;
  localPath?: string;
  remotePath?: string;
  exitCode?: number;
  errorCode?: string;
}
```

脱敏测试必须覆盖：

- password 和 passphrase。
- private key PEM 内容。
- proxy URL userinfo。
- Credential reference。
- SSH keyboard-interactive response。
- Node 错误的 `cause` 和对象 inspect 输出。

## 12. CLI 实现

建议使用 `commander` 或 Node `parseArgs`，交互输入使用具备隐藏输入能力且维护活跃的库。

### `ai-ops add`

状态机：

```text
collect metadata
  -> select auth method
  -> validate credential provider
  -> probe host key
  -> user trust confirmation
  -> test authentication
  -> persist credential
  -> persist config
```

实际持久化时要避免测试成功后配置失败导致不一致，可采用临时凭据引用和提交/回滚流程。

### `ai-ops doctor`

所有检查返回统一状态：

```text
OK
WARN
ERROR
```

支持 `--json`，便于故障报告，但 JSON 仍不得包含秘密或完整凭据引用。

## 13. 依赖建议

| 领域 | 建议 |
| --- | --- |
| MCP | `@modelcontextprotocol/sdk` |
| SSH/SFTP | `ssh2` |
| Schema | `zod` |
| CLI | `commander` 或 Node `parseArgs` |
| UUID | Node `crypto.randomUUID()` |
| 指纹 | Node `crypto` |
| 凭据库 | 由 Spike ADR 决定 |
| 日志 | 自定义 JSONL writer 或轻量结构化 logger |
| 测试 | Node test runner 或 Vitest |

避免为简单能力引入大型框架。连接池、超时和日志滚动可以在边界清晰的前提下自行实现。

## 14. 对参考项目的复用策略

参考项目采用 ISC 许可证，可以合法复用，但必须保留相应版权和许可证信息。建议以设计借鉴和小范围移植为主，不直接 fork 后持续堆叠。

| 参考模块 | 策略 | 原因 |
| --- | --- | --- |
| MCP stdio 注册 | 借鉴 | 实现直接、风险低 |
| SSH 连接与 keepalive | 移植测试思路，重新分层 | 原实现连接管理器过大 |
| 命令超时和输出限制 | 借鉴/移植 | 已解决常见边界问题 |
| SFTP 上传下载 | 借鉴 | API 使用成熟 |
| 本地路径 realpath 校验 | 移植并补 Windows 测试 | 安全价值高 |
| 远端路径范围 | 借鉴并降低安全承诺 | 无法完全处理远端符号链接 |
| 白名单/黑名单 | 不复用 | 不属于产品范围 |
| 命令行 password/passphrase | 删除 | 与凭据隔离目标冲突 |
| JSON 凭据配置 | 删除 | 与系统凭据库设计冲突 |
| `ssh_config` 自制解析器 | MVP 仅有限导入 | 完整语义复杂，避免假兼容 |
| 状态自动采集 | 后置 | 会产生额外远端命令和噪声 |

如果直接复制代码，建立 `THIRD_PARTY_NOTICES.md`，记录来源文件、版本、commit 和许可证。

## 15. 测试策略

### 15.1 单元测试

- 配置 schema 和版本迁移。
- Credential Provider 路由。
- fingerprint 计算与比较。
- 错误映射和脱敏。
- 本地/远程路径边界。
- 超时、输出计数和并发 semaphore。
- 审计 schema 和过滤。

### 15.2 集成测试

使用临时 OpenSSH Server 容器或测试虚拟机：

- 密码认证。
- Agent 认证。
- 带口令私钥认证。
- Host key 匹配、未知和变化。
- 命令成功、非零退出、stderr、超时和超限。
- 上传、下载、目录列表、覆盖保护。
- 连接断开和重连。

Windows Agent 与系统凭据库测试必须在真实 Windows CI runner 运行，不能只用 mock。

### 15.3 安全回归测试

- MCP 工具枚举不到 secret 字段。
- 配置和日志扫描不出现测试密码。
- CLI 进程参数不出现测试密码。
- 错误栈和 debug 日志不出现测试密码。
- Host key mismatch 绝不重试到非校验连接。
- `..`、符号链接、junction、大小写和不存在父目录的路径逃逸。
- 超大 stdout/stderr 和文件传输不会无限占用内存。

### 15.4 端到端测试

每个平台至少验证：

```text
install
-> ai-ops add/import-ssh
-> configure MCP client
-> list_servers
-> execute_command uptime
-> upload/download
-> inspect audit log
-> remove server and credential
```

## 16. 实施阶段

### 阶段 0：技术验证，2-3 天

- 完成 Keyring、Windows Agent、Host key 三个 Spike。
- 输出 ADR 和平台支持结论。
- 建立最小 CI 矩阵。

退出条件：三类关键依赖都获得可执行证据。

### 阶段 1：凭据与配置基础，4-5 天

- 项目脚手架、schema、配置原子写入。
- Credential Provider 接口。
- 系统凭据库 Provider。
- Agent Provider。
- Host key enrollment/verifier。
- `add/list/test/doctor`。

退出条件：三个平台至少各有一种认证方式完成 CLI 连接测试。

### 阶段 2：MCP 命令闭环，3-4 天

- stdio MCP Server。
- `list_servers`、`test_connection`、`execute_command`。
- 连接池、超时、输出和并发限制。
- 基础审计。

退出条件：Codex 或 Claude Code 中完成 `uptime`，全过程无明文凭据落盘或进入 MCP 配置。

### 阶段 3：文件传输，3-4 天

- SFTP 服务。
- 本地和远程路径验证。
- 上传、下载、目录列表。
- 文件覆盖、大小和超时限制。

退出条件：路径逃逸安全测试全部通过。

### 阶段 4：跨平台与发布，4-6 天

- Windows/macOS/Linux 真实环境 E2E。
- 安装包和 MCP 客户端配置文档。
- 错误消息、doctor 和迁移体验完善。
- 安全回归与第三方许可证整理。

预计 MVP：单人约 3 至 4 周。系统凭据库原生依赖若需要自行编写 Windows N-API Adapter，增加约 1 周。

## 17. 首个可交付纵切

第一条纵向功能只做：

```text
Windows
-> OpenSSH Agent
-> CLI 添加 server_id
-> 用户确认 Host key
-> MCP execute_command
-> JSONL audit
```

先证明凭据不进入 AI/MCP 配置的完整闭环，再加入密码凭据库和 SFTP。这样能够尽早验证产品核心，而不是先实现大量 SSH 功能。

## 18. Definition of Done

MVP 完成需要同时满足：

- 所有 MCP Schema 无凭据输入字段。
- 普通配置无 secret。
- 密码和私钥口令只存在于系统凭据库及短期进程内存。
- Host key 未信任或不匹配时无法连接。
- Agent、密码、私钥三种认证至少在声明支持的平台通过 E2E。
- 命令、SFTP、路径边界、超时、输出和并发测试通过。
- 审计日志通过自动化 secret 扫描。
- `doctor` 能定位 Agent、Keyring、Host key 和配置权限问题。
- README 准确声明能力与非目标。
- 完成第三方许可证和供应链依赖审查。
