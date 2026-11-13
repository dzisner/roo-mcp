# Rotation runbook

Operational procedures for the long-lived secrets and runtimes this service
depends on. F11 in [SECURITY.md](SECURITY.md).

## JWE encryption key

All OAuth artifacts (authorization codes, access tokens, refresh tokens,
client registrations) are JWEs encrypted directly with `A256GCM` using a
32-byte symmetric key held in GitHub Actions as the repository secret
`JWE_KEY`. The Lambda reads it from the env var `ROO_MCP_JWE_KEY` on cold
start.

### When to rotate

- **Suspected disclosure** (log leak, lost laptop, former maintainer): rotate
  immediately.
- **Scheduled**: every 12 months.
- **Never required by code change** — token payload schema is versioned
  separately (refresh `v: 2` marker, F02).

### Procedure

The service supports two keys live at once — `ROO_MCP_JWE_KEY` (used for mint
and tried first on decrypt) and `ROO_MCP_JWE_KEY_PREVIOUS` (tried on decrypt
if current fails). Rotation walks a token through both windows so no client
is forced to reconnect.

1. **Generate the new key** locally:
   ```bash
   openssl rand -base64 32
   ```
   Copy the output. Do not paste it into chat, a terminal that logs,
   or anywhere other than GitHub's secret editor in the next step.

2. **Promote the current key to PREVIOUS**. In GitHub → repo → Settings →
   Secrets and variables → Actions:
   - Open `JWE_KEY`, copy its current value.
   - Create / update `JWE_KEY_PREVIOUS` with that value.
   - Update `JWE_KEY` with the new value from step 1.

3. **Trigger a deploy**:
   ```bash
   gh workflow run deploy.yml
   ```
   Or push any no-op commit that touches a file in deploy.yml's `paths` filter.

4. **Verify**:
   ```bash
   curl -s https://mcp.roo.bz/health | jq
   ```
   The response should show the new build's `sha` and `version`. Test an
   existing OAuth session (any Claude/ChatGPT instance already connected) —
   token exchange should still succeed because the token was minted under the
   now-PREVIOUS key.

5. **Hold for 90 days.** Every refresh token issued before the rotation
   expires within 90 days (`REFRESH_TTL_SECONDS` in `src/oauth/token.ts`).
   After that window every outstanding token has been re-minted under the
   new key.

6. **Drop PREVIOUS.** In GitHub Secrets, set `JWE_KEY_PREVIOUS` to an empty
   string (SAM's `[[ -n "$JWE_KEY_PREVIOUS" ]]` guard in deploy.yml then skips
   passing the parameter). Trigger another deploy. Now only the new key is
   known to the service.

### What breaks if you rotate wrong

- **Forget to promote current → PREVIOUS**: every outstanding OAuth session
  dies immediately. Clients must reconnect. Not a security problem; a UX
  outage.
- **Drop PREVIOUS too early (< 90 days)**: same as above for every client
  that hadn't refreshed since the original rotation.
- **Reuse an old key as the new one**: tokens minted under that key value
  are indistinguishable from freshly-minted ones. Treat it as never-rotated.

## Lambda runtime

Currently `nodejs22.x`, `arm64`. AWS supports each managed runtime for ~24
months post-GA; deprecation emails arrive ~6 months ahead.

### When to rotate

- AWS deprecation email arrives (don't wait for the final date — rotate in
  the next deploy window).
- Node LTS adds a feature `jose` or the AWS SDK depends on.
- A CVE lands against the current Node version.

### Procedure

1. Bump `Globals.Function.Runtime` in [template.yaml](template.yaml) to the
   next supported `nodejsNN.x`.
2. Bump `BuildProperties.Target` under `RooMcpFunction.Metadata` to match
   (`node22` → `node24` etc.).
3. Bump `engines.node` in [package.json](package.json) if the new runtime's
   minimum is higher than what we declare.
4. Bump `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`
   `node-version` to the same.
5. Run the full regression gate locally (`npm run test:gate`). Push, let CI
   confirm, deploy.
6. `curl https://mcp.roo.bz/health` — `sha` should change; everything else
   stable.

## Operational data

- **DynamoDB grants table** (`roo-mcp-RooMcpGrantsTable-*`): all items carry
  TTL. No manual cleanup needed, no scheduled compaction. Items past their
  TTL may linger up to ~48h before DDB's sweeper drops them (`grants.ts`
  defensively re-checks TTL on read).
- **CloudWatch logs**: retention is AWS default (never expire) unless you
  explicitly set a log group retention policy. Set to 30 days unless there
  is a reason to keep longer.
