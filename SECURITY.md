# Security Policy

## Supported Versions

Security fixes are provided for the latest `0.1.x` release line. Users should reproduce issues against the current `main` branch when practical.

## Reporting a Vulnerability

Use GitHub [Private Vulnerability Reporting](https://github.com/Finn-Aigc/ai-ops-mcp/security/advisories/new) to report suspected vulnerabilities. Do not open a public Issue or Discussion for a vulnerability, credential exposure, or sensitive server information.

Include:

- the affected version or commit;
- reproduction steps or a minimal proof of concept;
- expected and observed behavior;
- security impact and prerequisites;
- suggested mitigations, if known.

Remove all real credentials, private keys, hostnames, addresses, usernames, and local paths. The maintainers will acknowledge a complete report when reviewed, coordinate validation and remediation privately, and credit reporters who request attribution. Please allow time for a fix before public disclosure.

## Security Boundaries

AI Ops MCP isolates SSH credentials from MCP clients, pins Host keys, and constrains file paths. It does not judge command safety or replace server-side authorization. Commands run with the configured SSH account's privileges. Use dedicated low-privilege accounts, restrictive `sudoers`, filesystem permissions, and isolated environments.
