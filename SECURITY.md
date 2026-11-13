# Security

Roo MCP's security posture follows the F01-F12 finding register from the
2026-10 internal security review (CTO sign-off 2026-11-12, v2). This file is
the single source of truth for those identifiers; inline comments elsewhere
in the codebase that reference `F0x` tags should match the rows below.

Status legend:

- **Done** — finding is closed; code on `main` implements the fix and the
  regression gate (`scripts/regression-gate.ts`) asserts the behavior.
- **Partial** — foundation is in place; a specific remaining item is called
  out in the row. Wave column names the planned closing wave.
- **Open** — not yet addressed; code on `main` has the gap.

Wave-6 through Wave-9 map to `scratchpad/Revised F01-F12 remediation plan.docx`
(v2.1, shared with Dudi 2026-11-13).

## Register

| ID  | Finding                                                                                               | Status  | Wave | Notes                                                                                                 |
|-----|-------------------------------------------------------------------------------------------------------|---------|------|-------------------------------------------------------------------------------------------------------|
| F01 | `/mcp` must reject unauthenticated requests cleanly and enforce scope on Bearer tokens                | Partial | 6    | 401/403 semantics done. `/mcp` GET/SSE still passes through transport — explicit 405 pending.         |
| F02 | Refresh-token rotation + replay detection + family revocation                                         | Partial | 7    | Rotation + family revocation live. Client-id binding and legacy-refresh reject pending.               |
| F03 | Authorization codes are single-use                                                                    | Partial | 7    | Conditional put in DDB enforces single-use. Order-of-ops fix pending (consume BEFORE PKCE check).     |
| F04 | Webhook / preview-link secrets must not round-trip back to the model                                  | Open    | 6    | Redaction helper written (held on `security-review-wave-4`). Setter preserve-vs-clear semantics TBD.  |
| F05 | Shortlink IDs must be validated against the Roo alphabet/length before hitting the API                | Open    | 6    | No alphabet/length validation today. SSRF URL validator deferred — NOT under F05.                     |
| F06 | Retire the unused Node HTTP transport (`src/http/node-server.ts`)                                     | Done    | 1    | Removed in wave-1 (473da95).                                                                          |
| F07 | `/authorize` must carry CSP, Referrer-Policy, be CSRF-safe, enforce loopback-port tolerance           | Partial | 7    | Headers + loopback tolerance done. Resource-binding on authorization codes + error-contract pending.  |
| F08 | Rate-limit the OAuth plane (`/register`, `/authorize`, `/token`)                                      | Partial | 8    | App-layer limits via DDB counters live. Migration to API Gateway stage throttles pending.             |
| F09 | Deploy pipeline must not run with AWS credentials on PR branches                                      | Done    | 5    | Split into `.github/workflows/ci.yml` (no secrets) + `deploy.yml` (push-to-main only).                |
| F10 | Published npm package name is scoped (`@roo-bz/roo-mcp`), docs and install snippets match             | Partial | 8    | Package.json correct; release identity across `main` / npm tag reconcile still pending.               |
| F11 | OAuth / `/mcp` error paths must not leak crypto errors or stack traces                                | Partial | 8    | JWE decrypt failures normalize to 401. Rotation runbook and HTTP API throttle migration pending.      |
| F12 | MCP tool annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) audit  | Open    | 6    | Audit outstanding; annotations to re-ship from `security-review-wave-4` under correct ID.             |

## Regression gate

`npm run test:gate` runs `scripts/regression-gate.ts` in-process (no network,
no AWS). CI runs it on every push and pull request. When a wave lands a new
behavior, its PR adds an assertion to the gate so the behavior cannot regress
silently.

## Reporting a new issue

Email `security@roo.bz`. Please do not open a public issue for suspected
vulnerabilities.
