# Deployment: Docker Compose + Cloudflare Tunnel + Access Managed OAuth

```
claude.ai ──HTTPS──▶ Cloudflare edge
                      ├─ Access app (Managed OAuth: DCR + PKCE + login policy)
                      └─ Tunnel ──▶ cloudflared container ──(compose network)──▶ mail-mcp container
                                                                                  └─▶ imap.mail.me.com:993
```

No ports are published on the host and none are opened on the router; no nginx or Let's Encrypt is needed.

The steps below are in the order that works: the server needs the Access application's AUD tag before its first start.

> **Host trust.** The container isolates the credentials from the network and from ordinary host users, but any account in the host's `docker` group (or with root) can read them. Keep that group to people and services you would trust with the mailbox.

## 1. Cloudflare Access application with Managed OAuth

Zero Trust → Access controls → Applications → Add → **Self-hosted**:

- Domain: `mail.example.com` (the hostname the tunnel will serve; it does not need to exist yet)
- Policy: **Allow**, Include → Emails → your address (nothing else)
- Login method: One-time PIN or an identity provider you already use
- Advanced settings → **Managed OAuth**: on
  - Allowed redirect URIs: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`
  - Localhost / loopback clients: off
  - Access token lifetime: default (15 min); grant session duration: e.g. 2 weeks

Note the application's **AUD tag** and your team domain (`<team>.cloudflareaccess.com`).

## 2. Host user and checkout

The container runs as a dedicated unprivileged host user, so the credentials file can be readable by that user only.

```bash
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mailmcp
git clone https://github.com/<you>/claude-mail-mcp.git && cd claude-mail-mcp
cp .env.example .env    # MAILMCP_UID/GID (from `id mailmcp`), CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, ALLOWED_EMAILS
```

## 3. Credentials

```bash
sudo install -d -o mailmcp -g mailmcp -m 700 secrets
sudo install -o mailmcp -g mailmcp -m 600 deploy/accounts.example.json secrets/accounts.json
sudoedit secrets/accounts.json   # put the app-specific password into imap.pass
```

`secrets/` is git-ignored and mounted read-only into the container. The server hot-reloads the file on change; if a save is invalid, it keeps the previous accounts and logs why (and a broken file at startup is reported by the tools instead of crash-looping).

## 4. Start the server

```bash
docker buildx build --allow network.host --network host --pull -t claude-mail-mcp:local .
docker compose up -d --no-build
docker compose ps                # mail-mcp: healthy
```

The build runs on the host network so `npm ci` can use the host's resolver (on hosts whose DNS upstreams are IPv6-only the default build network can't resolve). Since Docker 29 that needs the explicit `--allow network.host` entitlement, which `docker compose build` cannot pass, so the image is built with `docker buildx` and compose only runs it. On hosts with ordinary DNS, `docker compose up -d --build` also works.

The container has a read-only root filesystem, drops all capabilities, runs with `no-new-privileges`, and the runtime image (distroless) has no shell.

## 5. Cloudflare Tunnel (locally managed)

```bash
cloudflared tunnel login                       # once, opens a browser
cloudflared tunnel create mail-mcp
cloudflared tunnel route dns mail-mcp mail.example.com
```

Put `deploy/cloudflared/config.yml` (UUID and hostname filled in) and the tunnel credentials JSON into `./cloudflared/`, and delete `cert.pem` afterwards (it can manage every tunnel of the zone). The credentials file must be readable by the cloudflared image's user (uid 65532) only:

```bash
chmod 600 cloudflared/*.json && sudo chown -R 65532:65532 cloudflared && sudo chmod 700 cloudflared
docker compose --profile tunnel up -d
```

Only `/mcp` is routed to the server; every other path returns 404 at the edge.

## 6. Verify

```bash
# Through the tunnel without logging in: Access refuses
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mail.example.com/mcp   # 401
```

Then in claude.ai: Settings → Connectors → Add custom connector → `https://mail.example.com/mcp`. The OAuth login opens the Access page; after login the tools appear (eleven mail tools, plus three read-only calendar tools with `CALENDAR_ICLOUD=on`).

## Updating

Deploy a commit you have looked at, not whatever is on `main`, and keep the previous image for a one-command rollback:

```bash
git fetch origin
git log --oneline HEAD..origin/main          # what would change
git diff HEAD <reviewed-sha>                 # the whole diff: package.json scripts run during the build
git merge --ff-only <reviewed-sha>
docker tag claude-mail-mcp:local claude-mail-mcp:prev
docker buildx build --allow network.host --network host --pull -t claude-mail-mcp:local .
docker compose --profile tunnel up -d --no-build
docker compose ps                            # mail-mcp: healthy
```

Merge only commits whose CI is green (`main` is protected: changes land through pull requests with passing `test` and `docker` checks). If the checkout is owned by root so that the desktop/Samba user can't modify the code that gets built, run the `git` steps with `sudo`; the build and compose steps only need read access.

Rollback (checkout first, so compose.yaml matches the old image): `git reset --hard <previous-sha> && docker tag claude-mail-mcp:prev claude-mail-mcp:local && docker compose --profile tunnel up -d --no-build`.

Base images and cloudflared are pinned by digest; Dependabot proposes bumps (with a 7-day cooldown) as pull requests, and a weekly CI run fails when a new npm advisory affects a runtime dependency. On a fork, Dependabot version updates must be switched on by hand: Settings → Advanced Security → Dependabot version updates.
