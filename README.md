# 📺 Simple IPTV Player

A self-hosted IPTV web player built for people who actually want to watch TV, not mess with configs all day. Runs in Docker, plays your streams, and stays out of the way.

---

## What it does

- Plays HLS and DASH streams using [Shaka Player](https://github.com/shaka-project/shaka-player)
- Supports ClearKey DRM for encrypted streams
- Built-in EPG (Program Guide) — supports multiple XML/XML.gz sources
- Routes `http://` streams through an internal Nginx proxy so they work on HTTPS without "Mixed Content" errors
- Remembers which channel each user was watching and picks up where they left off
- Works on mobile, desktop, and Smart TVs

---

## Features

**Player**
- Custom player controls (no default Shaka UI) — play/pause, mute, audio & subtitle track cycling, EPG button
- Audio and subtitle tracks cycle through with icon buttons (🎧 / 💬) — only shows when multiple tracks are available
- Now Playing overlay shows channel logo, current program, times, and a live progress bar
- Stream retry logic — tries up to 5 times before showing an error, with a "Connecting…" message in between
- Tuned buffer settings for live IPTV — starts playback faster, recovers from stalls quickly

**TV Mode**
- Auto-detects Smart TVs, Android TV, Tizen, WebOS, FireTV, and similar set-top boxes
- Channel list becomes a slim sidebar (not a full-screen overlay) — video stays visible behind it
- Full D-Pad navigation with ⬆️ ⬇️ for channels, ⬅️ ➡️ for player controls and EPG programs, ↩️ Enter to confirm, ⎋ Escape to go back
- Channel sidebar auto-closes after 5 seconds of no input
- Now Playing overlay is centered, compact, and sized for a 10-foot display
- No mouse or touch interaction — remote-only controls

**EPG / Program Guide**
- Open with the 📅 button in the player controls
- D-Pad navigates the grid: Up/Down for channel rows, Left/Right for program cards, Enter to play

**Security**
- JWT auth with role-based access (admin / user)
- Playlist data is encrypted — clients only get decryption keys after login
- Anti-debugging protection: opening DevTools triggers a security lockout (can be disabled for local dev)
- JS is minified and mangled on Docker build

**Admin Panel**
- Manage users, playlists, and EPG sources
- Built-in M3U importer — parses channel names, logos, categories, EPG IDs, and DRM keys automatically
- Ace Editor with JSON syntax highlighting for manual playlist editing
- Shared playlists — assign to one user or share across multiple

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla JS, Shaka Player, Ace Editor, CryptoJS |
| Backend | Node.js + Express, SQLite |
| Proxy | Nginx (Alpine) |
| Deployment | Docker + Docker Compose |

---

## Setup

### Requirements
- Docker and Docker Compose

### 1. Create a `.env` file

```env
PORT=3000
JWT_SECRET=your_super_secret_jwt_token
SECRET_KEY=your_aes_encryption_key_string
```

### 2. Start it up

```bash
docker-compose up -d --build
```

Then open `http://your-server-ip:8587`

### 3. Default login

```
Username: admin
Password: admin123
```

> **Change the admin password immediately** after first login via the Admin Panel → User Management.

---

## Project Structure

```
├── data/               # SQLite database (persisted)
├── public/
│   ├── index.html      # Player UI
│   ├── admin.html      # Admin dashboard
│   ├── app.js          # Player logic
│   └── admin.js        # Admin logic
├── server.js           # Express API
├── nginx.conf          # Reverse proxy config
├── Dockerfile          # Multi-stage build
└── docker-compose.yml  # Service orchestration
```

---

## Recent Changes (v1.0.5)

This version brings major performance optimizations and a better big-screen experience:

- **Local Bundling**: All scripts and styles are now bundled locally (no more CDN dependencies).
- **ABR Support**: Shaka Player now uses Adaptive Bitrate for smoother playback.
- **Big Screen UI**: Improved scaling and larger elements for 4K and large TVs.
- **Resolution Badge**: See the current stream quality (HD/SD/etc) in the overlay.
- **Manual Mode Toggle**: Force TV or Desktop mode via user settings.
- **Encryption Refactor**: More robust security for playlist data.

See [`RELEASE_NOTES.md`](./RELEASE_NOTES.md) for the full breakdown.

---

## Dev Note

Anti-debugging is on by default. If DevTools makes the player lock up on you, comment out the `checkDevTools()` calls in the `.js` files and rebuild.

---

## Troubleshooting

### Docker: "Failed to Setup IP tables"

If you see an error like `Failed to Setup IP tables: Unable to enable ACCEPT OUTGOING rule`, it usually means your host's firewall (like `firewalld` or `ufw`) was restarted after Docker, which wiped Docker's custom iptables chains.

**Fix:** Restart the Docker daemon on your host:
```bash
sudo systemctl restart docker
```

If you are using **Docker-in-Docker (DinD)**, ensure the parent container is running with `--privileged`.

### Playback: "Unable to Connect"

The player retries failed streams up to 5 times. If it still fails, check:
1. **Mixed Content**: If your server is on HTTPS, the stream must also be HTTPS or routed through the built-in Nginx proxy.
2. **CORS**: Many IPTV providers block direct browser access. The player automatically attempts to use a proxy, but the proxy must have access to the upstream URL.
3. **DRM**: Encrypted streams require valid ClearKey/Widevine credentials and a secure context (HTTPS).