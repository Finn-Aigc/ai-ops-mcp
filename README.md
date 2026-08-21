# AI Ops MCP

[English](README.md) | [简体中文](README.zh-CN.md)

AI Ops MCP is a local SSH credential broker and stdio MCP server. It lets AI clients perform SSH and SFTP operations through stable `server_id` aliases without receiving passwords, private-key contents, or private-key passphrases.

> [!WARNING]
> AI Ops MCP protects the authentication boundary; it does not classify, approve, or block remote commands. Every command runs with the configured SSH account's permissions. Use dedicated, least-privilege accounts and server-side controls.

Version `0.1.0` is distributed from source only. This project is not published to npm.

## Features

- Interactive server enrollment and trusted Host key pinning
- SSH Agent, system credential store password, and private-key authentication
- Windows Credential Manager, macOS Keychain, and Linux Secret Service integration
- Connection pooling with per-server and global concurrency limits
- Remote commands, uploads, downloads, and directory listings
- Local and remote file path boundaries, timeouts, output limits, and file-size limits
- Structured audit logs with stable public error codes

## Security Model

Passwords and private-key passphrases are requested through hidden prompts and stored in the operating system credential store. Non-secret connection metadata is stored in a private local configuration file. Private keys remain files on the local machine and are read only when connecting. Host key fingerprints are confirmed during enrollment and later changes are rejected.

The MCP interface cannot enumerate or export credentials. By default, local file operations are limited to the MCP process working directory; additional local and remote roots can be configured per server. Audit logs may contain commands and paths, so protect them as operational data. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

This model does not protect against a compromised local user account, malicious remote output, a compromised remote host, or destructive commands issued with valid SSH permissions.

## Requirements

- Node.js 22 or 24
- Git and an accessible SSH server
- A verified SSH Host key fingerprint
- One supported authentication method
- Linux password/passphrase users: a running Secret Service provider

Windows Credential Manager has been validated on Windows 10 with Node.js 24. macOS Keychain and Linux Secret Service need broader real-device feedback.

## Install and Build

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

`npm link` exposes `ai-ops` and `ai-ops-mcp` locally. Run `npm run dev -- --help` during CLI development, or `npm start -- --help` after building.

## Authentication

### SSH Agent

Load a key into your system Agent, then either run `ai-ops add --auth agent` or import effective OpenSSH metadata:

```bash
ai-ops import-ssh my-host-alias
```

### System Credential Store Password

```bash
ai-ops add --id dev-box --host ssh.example.com --user deploy --auth password
```

The password is requested interactively and cannot be passed as a command-line value.

### Private Key File

```bash
ai-ops add --id dev-key --host ssh.example.com --user deploy \
  --auth private-key --key <path-to-private-key>
```

The key stays at the provided path. If encrypted, its passphrase is requested interactively and stored in the system credential store.

## CLI Reference

| Command | Purpose |
| --- | --- |
| `ai-ops add` | Add a server and confirm its Host key |
| `ai-ops import-ssh <alias>` | Import effective OpenSSH metadata for Agent auth |
| `ai-ops list [--json]` | List aliases and credential readiness |
| `ai-ops show <id>` | Show non-secret server metadata |
| `ai-ops test <id>` | Test a connection |
| `ai-ops edit <id>` | Update metadata, roots, or stored secrets |
| `ai-ops remove <id>` | Remove metadata and stored credentials |
| `ai-ops trust-host <id>` | Replace a verified Host key fingerprint |
| `ai-ops doctor [--json]` | Diagnose configuration, keyring, and Agent access |
| `ai-ops logs` | Read filtered audit events |

Use `ai-ops <command> --help` for all options. Never automate password or passphrase entry through command arguments.

## MCP Client Configuration

After `npm link`, configure any stdio MCP client with:

```json
{
  "mcpServers": {
    "ai-ops": {
      "command": "ai-ops-mcp"
    }
  }
}
```

For development without linking, build first and use `node` with `"<absolute-path-to-repository>/dist/mcp-entry.js"` as the only argument.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `list_servers` | List configured aliases and readiness without credentials |
| `test_connection` | Test one `server_id` |
| `execute_command` | Run an arbitrary remote command |
| `upload_file` | Upload a file from an allowed local root |
| `download_file` | Download a file into an allowed local root |
| `list_dir` | List an allowed remote directory |

Defaults are 30 seconds per command, 10 MiB combined command output, 100 MiB per file, four concurrent operations per server, and 16 globally. Server settings can reduce or tailor these limits.

## Troubleshooting

- Run `ai-ops doctor` first for keyring, Agent, configuration, and server diagnostics.
- `HOST_KEY_MISMATCH`: verify the new fingerprint out of band, then run `ai-ops trust-host <id>`.
- `AGENT_UNAVAILABLE`: start an SSH Agent and load a key with `ssh-add`.
- `CREDENTIAL_STORE_UNAVAILABLE`: unlock or start the platform credential service.
- `LOCAL_PATH_NOT_ALLOWED` or `REMOTE_PATH_NOT_ALLOWED`: update roots with `ai-ops edit <id> --allowed-local ... --allowed-remote ...`.
- MCP process exits immediately: run `npm run build` and confirm the configured executable or absolute entry path.

## Local Live E2E Tests

Live tests intentionally stay out of GitHub Actions. Use an isolated home and a dedicated, low-privilege server account that may create temporary files under `/tmp` and update its own `~/.ssh/authorized_keys`:

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

Each test uses unique resources and cleans them in `finally` blocks. Never use production credentials or configuration. See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/PRD.md](docs/PRD.md), and [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md).

## License

[MIT](LICENSE) © 2026 AI Ops MCP contributors.
