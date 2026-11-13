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
| F01 | `/mcp` must reject unauthenticated requests cleanly and enforce scope on Bearer tokens                | Done    | 6    | 401 unauth, 403 insufficient_scope, 405 on non-POST — all gated.                                      |
| F02 | Refresh-token rotation + replay detection + family revocation                                         | Done    | 7    | Rotation, family revocation, client-id binding, legacy-schema reject (`v: 2` marker). Concurrent-rotation race documented below.  |
| F03 | Authorization codes are single-use                                                                    | Done    | 7    | Conditional put burns the code BEFORE PKCE / redirect_uri / client_id checks.                         |
| F04 | Webhook / preview-link secrets must not round-trip back to the model                                  | Done    | 6    | `redactAddOnForModel` scrubs endpoint path/query, header values, queryString, body. Host preserved.   |
| F05 | Shortlink IDs must be validated against the Roo alphabet/length before hitting the API                | Done    | 6    | `validateRooId` enforces base64 alphabet + length 4-256; `encodeRooId` runs it on every call.         |
| F06 | Retire the unused Node HTTP transport (`src/http/node-server.ts`)                                     | Done    | 1    | Removed in wave-1 (473da95).                                                                          |
| F07 | `/authorize` must carry CSP, Referrer-Policy, be CSRF-safe, enforce loopback-port tolerance           | Done    | 7    | Headers, loopback tolerance, RFC 8707 resource binding, redirect-back error contract per §4.1.2.1.    |
| F08 | Rate-limit the OAuth plane (`/register`, `/authorize`, `/token`)                                      | Done    | 8    | Two layers: API Gateway stage throttles (edge DoS cap) + per-IP DDB counters (per-source policy).     |
| F09 | Deploy pipeline must not run with AWS credentials on PR branches                                      | Done    | 5    | Split into `.github/workflows/ci.yml` (no secrets) + `deploy.yml` (push-to-main only).                |
| F10 | Published npm package name is scoped (`@roo-bz/roo-mcp`), docs and install snippets match             | Done    | 8    | /health exposes version + build SHA so a client can verify which build is live.                       |
| F11 | OAuth / `/mcp` error paths must not leak crypto errors or stack traces                                | Done    | 8    | JWE decrypt failures normalize to 401; rotation runbook in [ROTATION.md](ROTATION.md).                |
| F12 | MCP tool annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) audit  | Done    | 6    | All 14 tools annotated; gate asserts coverage per file.                                               |

## Known gaps

- **Concurrent refresh rotation (F02).** A client that races two refresh requests against the same token will see one succeed and the other fail as `invalid_grant` with the family revoked. This is OAuth 2.1-compliant reuse-detection; the UX cost (legitimate client has to reconnect after a rare race) is accepted. A "one-chance window" that would tolerate the race without weakening detection is not implemented today.

## Regression gate

`npm run test:gate` runs `scripts/regression-gate.ts` in-process (no network,
no AWS). CI runs it on every push and pull request. When a wave lands a new
behavior, its PR adds an assertion to the gate so the behavior cannot regress
silently.

## Reporting a new issue

Email `security@roo.bz`. Please do not open a public issue for suspected
vulnerabilities.
