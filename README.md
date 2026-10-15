# Flashcards

Self-hosted Anki-style flashcard app with SM-2 spaced repetition. Built for interview-prep pattern cards. Runs on a Raspberry Pi, accessed from iPhone over Tailscale.

- **Stack:** Node.js + Express + SQLite (better-sqlite3). Vanilla JS frontend, no build step.
- **Features:** decks, SM-2 reviews (Again/Hard/Good/Easy), review queue, browse/search, tags, stats, TSV/JSON import, and a `cards/*.json` file-import system so new cards can be added via git.

## Run locally

```bash
npm install
npm start
# → http://127.0.0.1:3002
```

Env vars: `PORT` (default 3002), `HOST` (default 127.0.0.1), `DB_PATH` (default `./data/flashcards.db`).

## Adding cards

**Via git (recommended):** add a JSON file to `cards/`, e.g. `cards/two-pointers.json`:

```json
{
  "deck": "Meta Prep",
  "cards": [
    { "front": "Question?", "back": "Answer.", "tags": "arrays,pattern" }
  ]
}
```

The app imports new files on startup (idempotent — already-imported cards are skipped). After `git pull` on the Pi, either restart the service or hit **⭳ Import** in the Stats view (calls `POST /api/cards/import-files`).

**Via UI:** the ➕ tab adds cards to any deck. **Via API:** `POST /api/cards/batch` with `{deck_id, cards: [{front, back, tags}]}`.

## API

| Method | Route | Purpose |
|---|---|---|
| GET | /api/decks | List decks with due/new counts |
| POST | /api/decks | Create deck `{name}` |
| DELETE | /api/decks/:id | Delete deck (cascades) |
| GET | /api/decks/:id/cards?q=&tag= | Search/browse cards |
| POST | /api/decks/:id/cards | Add card `{front, back, tags}` |
| POST | /api/cards/batch | Bulk add `{deck_id, cards: [...]}` |
| PUT | /api/cards/:id | Edit card |
| DELETE | /api/cards/:id | Delete card |
| GET | /api/decks/:id/review | Next due card (or `{done: true}`) |
| POST | /api/cards/:id/review | Rate `{rating: 1-4}` |
| POST | /api/decks/:id/import | Import TSV/JSON `{format, data}` |
| POST | /api/cards/import-files | Re-import `cards/*.json` |
| GET | /api/stats | Global stats |
| GET | /api/decks/:id/stats | Per-deck stats |
| GET | /api/health | Health check |

## Deploy on the Raspberry Pi 5

Prerequisites: Node 24 LTS (NodeSource), Raspberry Pi OS trixie arm64.

```bash
ssh pi@budgetpi
git clone <repo-url> ~/flashcards
cd ~/flashcards && npm install --omit=dev   # always install on the Pi; never copy node_modules
```

better-sqlite3 v12+ ships prebuilt linux-arm64 binaries for Node 24, so no compilation is normally needed. If it falls back to building: `sudo apt-get install -y build-essential python3`.

### systemd user unit

Save as `~/.config/systemd/user/flashcards.service`:

```ini
[Unit]
Description=Flashcards (Express + SQLite, port 3002)
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h/flashcards
ExecStart=/usr/bin/node %h/flashcards/server.js
Environment=PORT=3002
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now flashcards
systemctl --user status flashcards
journalctl --user -u flashcards -f   # logs
```

### Tailscale (tailnet only — do NOT use funnel)

```bash
tailscale serve --bg --https=8444 http://127.0.0.1:3002
```

Open on iPhone (Tailscale on): **https://budgetpi.tailf012c7.ts.net:8444** → Add to Home Screen.

### Updating

```bash
cd ~/flashcards && git pull --ff-only && npm install --omit=dev && systemctl --user restart flashcards
```

New card files in `cards/` are imported automatically on restart, or via ⭳ Import in the app.

### Backup

The SQLite file lives at `~/flashcards/data/flashcards.db` (gitignored). Back it up alongside the existing `budgetbridge-backup.timer` or with a simple cron:

```bash
cp ~/flashcards/data/flashcards.db ~/backups/flashcards-$(date +%F).db
```

## Troubleshooting

- `npm install` fails on better-sqlite3: install `build-essential python3`, then retry **on the Pi**.
- Port in use: `ss -tlnp | grep 3002`.
- Serve mappings: `tailscale serve status`.
