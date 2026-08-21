# Repository Guidelines

## Project Structure & Module Organization

This Node.js 22+ TypeScript project provides an SSH CLI and MCP server. Production code lives in `src/`: CLI commands are in `src/cli`, MCP integration in `src/mcp`, and SSH transport in `src/ssh`; configuration, credentials, auditing, and services have dedicated directories. `src/index.ts` is the CLI entry point and `src/mcp-entry.ts` starts MCP. Unit tests live in `test/unit`, live SSH scripts in `test/e2e`, and design notes in `docs/`. Do not edit generated `dist/` or `node_modules/` content.

## Build, Test, and Development Commands

- `npm install` installs locked dependencies from `package-lock.json`.
- `npm run dev` runs the CLI directly through `tsx`.
- `npm run typecheck` checks strict TypeScript types without emitting files.
- `npm run build` cleans `dist/` and compiles the project.
- `npm test` runs all `test/**/*.test.ts` files with Node's test runner.
- `npm start` runs the compiled CLI from `dist/index.js`.
- `npm run test:e2e:core` (and `:mcp`, `:auth`, `:agent`, `:cleanup`) runs live SSH integration scenarios.

Before live tests, build the project and set an isolated `AI_OPS_HOME` plus `AI_OPS_E2E_SERVER_ID`; never point tests at a production configuration.

## Coding Style & Naming Conventions

Use ESM TypeScript with explicit `.js` suffixes in relative imports, two-space indentation, double quotes, and semicolons. The compiler enables `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`; do not weaken these settings. Name files in kebab-case (`path-boundary.ts`), classes and types in PascalCase, and functions and variables in camelCase. No formatter or linter is configured, so match adjacent code and run `npm run typecheck`.

## Testing Guidelines

Use `node:test` with `node:assert/strict`. Name unit files `<feature>.test.ts` and place them in `test/unit`. Cover success paths, validation failures, secret handling, path boundaries, and cleanup behavior. There is no configured coverage threshold; every behavioral change should include a focused regression test. Live E2E scripts must use unique temporary resources and remove them in `finally` blocks.

## Commit & Pull Request Guidelines

Use imperative Conventional Commit subjects such as `fix: reject paths outside configured roots` or `test: cover credential fallback`. Keep commits single-purpose. Pull requests should explain behavior and risk, link issues, list verification commands, and call out configuration or security effects. Include terminal output for CLI changes. Never commit passwords, passphrases, private keys, local configuration, or audit logs.
