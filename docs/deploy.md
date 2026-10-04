# Deploying `mcp.roo.bz`

Runbook for hosting the Roo MCP HTTP endpoint on the existing Amazon Linux box
(the one serving Sendy). The MCP server is a thin Node process behind a
reverse proxy that terminates TLS.

## Topology

```
client (Claude Code CLI, Claude Desktop, etc.)
     │  https://mcp.roo.bz/mcp   (x-api-key: USER_KEY)
     ▼
nginx (TLS, Let's Encrypt)
     │  http://127.0.0.1:8787/mcp
     ▼
node ./dist/http/node-server.js   (systemd unit `roo-mcp`)
     │  https://api.roo.bz/v1/...
     ▼
Roo API
```

- Node process binds to **loopback only** (`127.0.0.1:8787`) — never faces the
  public internet directly. Firewall need not change.
- Stateless per request. No DB, no cache, no persisted state.
- Memory ~ 50–100 MB resident. Will not disturb Sendy.

## Prerequisites on the box

- Node ≥ 18 (`node --version`). If older, install from NodeSource or nvm.
- `git`
- `nginx` (already present for Sendy — we add one `server {}` block)
- `certbot` + nginx plugin (already present if Sendy uses Let's Encrypt)
- A system user to own the service, e.g. `roo-mcp`:
  ```bash
  sudo useradd --system --home /opt/roo-mcp --shell /usr/sbin/nologin roo-mcp
  sudo mkdir -p /opt/roo-mcp && sudo chown roo-mcp:roo-mcp /opt/roo-mcp
  ```

## One-time install

### 1. Clone and build

```bash
sudo -u roo-mcp bash -lc '
  cd /opt/roo-mcp &&
  git clone https://github.com/dzisner/roo-mcp.git app &&
  cd app &&
  npm ci &&
  npm run build
'
```

### 2. systemd unit

Create `/etc/systemd/system/roo-mcp.service`:

```ini
[Unit]
Description=Roo MCP HTTP server
After=network.target

[Service]
Type=simple
User=roo-mcp
Group=roo-mcp
WorkingDirectory=/opt/roo-mcp/app
Environment=NODE_ENV=production
Environment=ROO_MCP_HOST=127.0.0.1
Environment=ROO_MCP_PORT=8787
ExecStart=/usr/bin/node ./dist/http/node-server.js
Restart=on-failure
RestartSec=5s

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/opt/roo-mcp/app

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now roo-mcp
sudo systemctl status roo-mcp
curl http://127.0.0.1:8787/health   # expect {"ok":true}
```

### 3. DNS

Add an **A record** at the DNS provider for `roo.bz`:

```
mcp.roo.bz    A    <public-ip-of-box>
```

Wait for propagation (`dig +short mcp.roo.bz` returns the box's IP).

### 4. nginx vhost

Create `/etc/nginx/conf.d/mcp.roo.bz.conf`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name mcp.roo.bz;

    # Let certbot handle this and the TLS redirect; placeholder for first-time cert issuance.
    location / {
        return 404;
    }
}
```

Reload nginx, then issue the certificate:

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d mcp.roo.bz
```

certbot rewrites the file to add TLS. Then **replace** `/etc/nginx/conf.d/mcp.roo.bz.conf`
with (keeping certbot's cert paths in the ssl_certificate / ssl_certificate_key lines):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name mcp.roo.bz;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name mcp.roo.bz;

    ssl_certificate     /etc/letsencrypt/live/mcp.roo.bz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.roo.bz/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Long timeouts for MCP SSE streams (server→client notifications).
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;      # SSE must not be buffered
    proxy_http_version 1.1;

    location = /mcp {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Pass the client's API key through unchanged.
        proxy_pass_request_headers on;
    }

    location = /health {
        proxy_pass http://127.0.0.1:8787;
        access_log off;
    }

    location / {
        return 404;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5. Verify

From a laptop (NOT the server):

```bash
export ROO_API_KEY=<your real roo key>
bash scripts/smoke-http.sh https://mcp.roo.bz
```

Expect all 5 checks green.

## Deploying a new version

```bash
sudo -u roo-mcp bash -lc '
  cd /opt/roo-mcp/app &&
  git fetch --tags && git pull --ff-only &&
  npm ci --omit=dev --no-audit --no-fund &&
  npm run build
'
sudo systemctl restart roo-mcp
sudo journalctl -u roo-mcp -n 20 --no-pager   # confirm startup line
curl -fsS https://mcp.roo.bz/health
```

The restart is a cold swap (a few hundred ms of unavailability). For zero-downtime
we'd run two workers behind nginx on different ports — not worth it until there's
real traffic to protect.

## Rollback

```bash
sudo -u roo-mcp bash -lc 'cd /opt/roo-mcp/app && git log --oneline -5'
sudo -u roo-mcp bash -lc 'cd /opt/roo-mcp/app && git reset --hard <sha>'
sudo -u roo-mcp bash -lc 'cd /opt/roo-mcp/app && npm ci --omit=dev && npm run build'
sudo systemctl restart roo-mcp
```

## Observability

- **Access log:** `journalctl -u roo-mcp -f` streams the Node stdout (one line per request:
  method, path, status, ms). Headers and bodies are never logged.
- **Error log:** same place; stderr is interleaved. certbot's nginx logs are the usual
  `/var/log/nginx/*`.
- **Health:** `curl https://mcp.roo.bz/health` — just verifies the Node process is up and
  nginx is wired correctly. Does not check that the Roo API is reachable; use the smoke
  test for that.

## Rotating secrets

There are no server-side secrets. The Node process holds no API keys — every request
brings its own key via the `x-api-key` header, which is used once to call Roo's API
and then dropped. If a user's key is compromised, they revoke it in app.roo.bz. There
is nothing to rotate on the server.
