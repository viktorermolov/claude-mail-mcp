# Deployment: Docker Compose + Cloudflare Tunnel + Access Managed OAuth

```
claude.ai ──HTTPS──▶ Cloudflare edge
                      ├─ Access app (Managed OAuth: DCR + PKCE + login policy)
                      └─ Tunnel ──▶ cloudflared container ──(compose network)──▶ mail-mcp container
                                                                                  └─▶ imap.mail.me.com:993
```

No ports are published on the host and none are opened on the router; no nginx or Let's Encrypt is needed.

## 1. Host user and checkout

The container runs as a dedicated unprivileged host user, so the credentials file can be readable by that user only.

```bash
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mailmcp
git clone https://github.com/<you>/claude-mail-mcp.git && cd claude-mail-mcp
cp .env.example .env          # fill in MAILMCP_UID/GID (id mailmcp), Access values, ALLOWED_EMAILS
```

## 2. Credentials

```bash
sudo install -d -o mailmcp -g mailmcp -m 700 secrets
sudo install -o mailmcp -g mailmcp -m 600 deploy/accounts.example.json secrets/accounts.json
sudoedit secrets/accounts.json   # put the app-specific password into imap.pass
```

`secrets/` is git-ignored and mounted read-only into the container. The server hot-reloads the file on change.

## 3. Start the server

```bash
docker compose up -d --build
docker compose ps                # mail-mcp: healthy
```

The container has a read-only root filesystem, drops all capabilities, runs with `no-new-privileges`, and the runtime image (distroless) has no shell.

## 4. Cloudflare Tunnel (locally managed)

```bash
cloudflared tunnel login                       # once, opens a browser
cloudflared tunnel create mail-mcp
cloudflared tunnel route dns mail-mcp mail.example.com
```

Put `deploy/cloudflared/config.yml` (UUID and hostname filled in) and the tunnel credentials JSON into `./cloudflared/`. The credentials file must be readable by the cloudflared image's user (uid 65532) only:

```bash
sudo chown -R 65532:65532 cloudflared && sudo chmod 700 cloudflared && sudo chmod 600 cloudflared/*.json
```

Only `/mcp` is routed to the server; every other path returns 404 at the edge.

## 5. Cloudflare Access with Managed OAuth

Zero Trust → Access controls → Applications → Add → **Self-hosted**:

- Domain: `mail.example.com`
- Policy: **Allow**, Include → Emails → your address (nothing else)
- Login method: One-time PIN or an identity provider you already use
- Advanced settings → **Managed OAuth**: on
  - Allowed redirect URIs: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
  - Localhost / loopback clients: off
  - Access token lifetime: 15 min; grant session duration: as you like (e.g. 30 days)

Copy the application's **AUD tag** into `CF_ACCESS_AUD` and your team domain into `CF_ACCESS_TEAM_DOMAIN` in `.env`, then:

```bash
docker compose --profile tunnel up -d
```

## 6. Verify

```bash
# Through the tunnel without logging in: Access refuses
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mail.example.com/mcp   # 401/403
```

Then in claude.ai: Settings → Connectors → Add custom connector → `https://mail.example.com/mcp`. The OAuth login opens the Access page; after login the eight tools appear.
