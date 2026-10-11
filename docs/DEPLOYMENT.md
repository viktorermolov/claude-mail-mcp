# Deployment: Raspberry Pi + Cloudflare Tunnel + Access Managed OAuth

Target layout:

```
claude.ai ──HTTPS──▶ Cloudflare edge
                      ├─ Access app (Managed OAuth: DCR + PKCE + login policy)
                      └─ Tunnel ──▶ cloudflared (Pi) ──▶ 127.0.0.1:3220 claude-mail-mcp
                                                          └─▶ imap.mail.me.com:993
```

No ports are opened on the router; no nginx or Let's Encrypt is needed.

## 1. Node and service user

```bash
# Node LTS into /opt/node (official arm64 tarball, checksum verified)
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin mailmcp
sudo install -d -o root -g root -m 755 /opt/claude-mail-mcp
sudo install -d -o root -g mailmcp -m 750 /etc/claude-mail-mcp
```

Build on any machine with `npm ci && npm run build && npm prune --omit=dev`, then copy `dist/`, `node_modules/` and `package.json` to `/opt/claude-mail-mcp` (owned by root, read-only for the service).

## 2. Configuration

`/etc/claude-mail-mcp/env` (root:mailmcp, 640) — copy of `.env.example` with real values.

`/etc/claude-mail-mcp/accounts.json` (mailmcp:mailmcp, **600**) — see `deploy/accounts.example.json`. Put the app-specific password here, on the server only:

```bash
sudo install -o mailmcp -g mailmcp -m 600 /dev/null /etc/claude-mail-mcp/accounts.json
sudoedit /etc/claude-mail-mcp/accounts.json
```

The server hot-reloads the file on change.

## 3. systemd

```bash
sudo cp deploy/claude-mail-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-mail-mcp
curl -s http://127.0.0.1:3220/health    # {"status":"ok"}
```

## 4. Cloudflare Tunnel (locally managed)

```bash
cloudflared tunnel login                       # once, opens a browser
cloudflared tunnel create mail-mcp
cloudflared tunnel route dns mail-mcp mail.example.com
```

Install `deploy/cloudflared/config.yml` as `/etc/cloudflared/mail-mcp.yml` (fill in the tunnel UUID and hostname), the credentials JSON next to it readable only by the `cloudflared` user, and `deploy/cloudflared/cloudflared-mail-mcp.service`.

Only `/mcp` is routed to the origin; every other path returns 404 at the edge.

## 5. Cloudflare Access with Managed OAuth

Zero Trust → Access controls → Applications → Add → **Self-hosted**:

- Domain: `mail.example.com`
- Policy: **Allow**, Include → Emails → your address (nothing else)
- Login method: One-time PIN or an identity provider you already use
- Advanced settings → **Managed OAuth**: on
  - Allowed redirect URIs: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
  - Localhost / loopback clients: off
  - Access token lifetime: 15 min; grant session duration: as you like (e.g. 30 days)

Copy the application's **AUD tag** into `CF_ACCESS_AUD` and your team domain into `CF_ACCESS_TEAM_DOMAIN`, then `sudo systemctl restart claude-mail-mcp`.

## 6. Verify

```bash
# Without going through Access: rejected by the origin
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3220/mcp   # 401
# Through the tunnel without logging in: Access refuses
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mail.example.com/mcp  # 401/403
```

Then in claude.ai: Settings → Connectors → Add custom connector → `https://mail.example.com/mcp`. The OAuth login opens the Access page; after login the ten tools appear.
