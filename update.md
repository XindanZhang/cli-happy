# Updating + Restarting (CLI vs Server)

This is a quick checklist for what to rebuild/restart depending on what you changed.

---

## If you changed CLI code (this repo)

The CLI runs from `dist/`, so you need to rebuild after edits.

```bash
cd ~/cli-happy
yarn build
```

### If you run the CLI via the background daemon

Restarting the daemon is usually enough to pick up the new `dist/` build:

```bash
happy daemon stop
happy daemon start
```

### If you run the CLI directly (no daemon)

```bash
node ./bin/happy.mjs <args>
```

Example:

```bash
node ./bin/happy.mjs auth login --force
```

### If you want `happy` to point to this repo globally

One-time link:

```bash
cd ~/cli-happy
npm link
```

Then rebuild + run anywhere:

```bash
cd ~/cli-happy && yarn build
happy <args>
```

---

## If you changed the server/tunnel setup (mobile auth / QR)

Restarting the **CLI daemon does not restart** your self-hosted backend or Cloudflare tunnel.

### Restart Happy Server (backend)

```bash
launchctl unload -w ~/Library/LaunchAgents/com.happy.server.plist
launchctl load -w ~/Library/LaunchAgents/com.happy.server.plist
```

### Restart Cloudflare tunnel

```bash
launchctl unload -w ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
launchctl load -w ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
```

### Quick health checks

```bash
curl -fsSL http://localhost:3005/
curl -fsSL https://happy.<your-domain>/
```

