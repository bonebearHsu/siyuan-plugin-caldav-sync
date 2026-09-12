# CalDAV Calendar & Tasks for SiYuan

Manage calendars and todos on your CalDAV server (Radicale / Nextcloud / Baikal / DAViCal / Synology / iCloud with app password) directly inside SiYuan: **two-way sync**, **month / week / day views**, **task view**, **full editing**, and one-click insertion of today's schedule into your daily note.

## Features

- **Two-way sync**: local edits are pushed back (merged upload), server changes pulled periodically (default every 15 min) and on demand
- **Incremental sync**: uses `sync-collection` + sync-token when available, falls back to `PROPFIND` + `calendar-multiget`
- **Four views**: month, week (time grid + current-time line), day, and task view (grouped by overdue / today / tomorrow / next 7 days / later / no date)
- **Full editing**: title, calendar, all-day, start/end, recurrence (day/week/month/year + interval + weekdays + end conditions), reminders, location, tags, notes, priority, status, completion
- **Multiple calendars**: color-coded, individually toggleable, default calendar for new items
- **Recurring events**: RRULE expansion with EXDATE support
- **Daily note integration**: insert today's schedule & todos into the daily note
- **Two request channels**: SiYuan kernel proxy (no CORS) by default, automatic fallback to direct browser requests

## Install

1. Install from SiYuan marketplace ("Settings → Marketplace → Downloaded"), or unzip `package.zip` into `workspace/data/plugins/siyuan-plugin-caldav-sync/`
2. Restart SiYuan, click the "Calendar & Tasks" dock icon on the left; view buttons open the calendar tab in the main window

## Configuration

"Settings → CalDAV Sync" or the gear icon on the panel:

| Option | Description |
| --- | --- |
| Server URL | e.g. `http://192.168.1.10:5232/`, `https://dav.example.com/` |
| Username / Password | Basic auth; use an app-specific password for iCloud / Nextcloud |
| Calendar path | Optional. Leave empty for auto-discovery |
| Request channel | Auto (kernel proxy first) / kernel proxy / direct |
| Auto-sync interval | Minutes, 0 disables |
| Conflict policy | Server-first / local-first on 412 conflicts |
| Sync range | Past N days / future N days |

Click "Test Connection", then "Discover Calendars", pick the calendars you want and save.

### Radicale example

```ini
[auth]
type = htpasswd
htpasswd_filename = /etc/radicale/users
htpasswd_encryption = plain

[server]
hosts = 0.0.0.0:5232
```

If direct requests fail with CORS errors, set the channel to "SiYuan kernel proxy".

## Data & conflicts

- Data is stored in plugin private storage `workspace/data/storage/siyuan-plugin-caldav-sync/caldav-sync-dock.json`, never written into notes
- Server ICS raw text is preserved on edit so unmanaged properties (e.g. ATTENDEE) survive round-trips
- Uploads carry `If-Match` etags; a 412 response is resolved by the configured conflict policy
- Deletions are propagated to the server (local tombstone first, removed after sync)

## Commands (bind hotkeys in "Settings → Hotkeys")

- `Sync CalDAV Now`
- `New Todo`
- `Open Calendar & Tasks`
- `Insert Today's Schedule into Daily Note`

## Notes

- Passwords are stored in plain text in plugin data; use self-hosted / LAN servers or restricted accounts
- Times are written as UTC in ICS; floating times are interpreted in the local timezone
- Desktop only (Android / iOS not adapted yet)

## Development

```bash
npm i
cp .env.example .env   # point VITE_SIYUAN_WORKSPACE_PATH at your SiYuan workspace
npm run build          # produces package.zip
npm test               # core unit tests + loader/UI smoke (jsdom)
npm run e2e:radicale   # or: start a local Radicale, then
npm run test:e2e       # real CalDAV end-to-end against Radicale
```

## License

AGPL-3.0 license
