# Contributing to AI Ops MCP

Thank you for helping improve AI Ops MCP. Contributions must preserve its credential-isolation and Host key verification boundaries.

## Development Setup

Use Node.js 22 or 24 and npm:

```bash
git clone https://github.com/Finn-Aigc/ai-ops-mcp.git
cd ai-ops-mcp
npm ci
npm run typecheck
npm test
npm run build
```

Run the CLI from source with `npm run dev -- --help`. Generated `dist/` content is not committed.

## Branches and Commits

Create a focused branch from `main`, such as `fix/host-key-error` or `feat/server-groups`. Use concise, imperative Conventional Commit subjects:

```text
fix: reject paths outside configured roots
test: cover credential fallback
docs: clarify agent setup
```

Keep unrelated changes in separate commits and avoid generated or formatting-only churn.

## Tests

Add focused `node:test` coverage under `test/unit/<feature>.test.ts` for behavioral changes. Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=low
```

Live E2E tests require an isolated `AI_OPS_HOME`, `AI_OPS_E2E_SERVER_ID`, and a dedicated low-privilege SSH account. They are local-only because GitHub Actions must not depend on long-lived servers or SSH credentials. Every live test must create unique resources and clean them in a `finally` block.

## Pull Requests

Open a pull request against `main`. Explain the problem, behavior change, security impact, and verification commands. Link related issues. Include terminal output when CLI behavior changes; screenshots are only needed for visual documentation changes. Keep the pull request small enough to review and update both READMEs when user-facing behavior changes.

## Credential Safety

Never commit passwords, passphrases, private keys, tokens, real server addresses, local configuration, audit logs, `.env` files, or user-specific absolute paths. Use reserved examples such as `ssh.example.com` and placeholders such as `<path-to-private-key>`. Report suspected vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.
