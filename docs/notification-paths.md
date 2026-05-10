---
title: Notification paths
status: locked
audience: operators (JJ, future consumer-onboarding)
related:
  - bin/dream.js (notifyMacOS + notifyTelegram + notifyAll)
  - schedulers/launchd.plist.template
  - SUCCESS-CRITERIA.md (sign-off gate observation)
date: 2026-05-10
---

# Notification paths

The dream worker fires a notification at every terminal point of a run so
the operator (JJ today; future consumers tomorrow) knows what happened
without having to crack open `.dream-log.md`. Notifications are best-
effort: **failure to notify NEVER fails the run.**

## Channels

| Channel | When | Configured via |
|---|---|---|
| macOS Notification Center | end of run, all terminal points | none — fires automatically on darwin (silenced by `--no-notify` or `DREAM_NO_NOTIFY=1`) |
| Telegram bot | end of run, all terminal points | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` env vars (silent skip if absent) |
| `.dream-log.md` (always-on) | end of every run | written by `finalizeAuditVerdicts` regardless of notification config |
| `archive/dreams/<date>/event.json` | end of every run | canonical machine-readable record |

The two interactive channels (macOS, Telegram) exist for **observability**.
The two file-based channels exist for **forensics + recovery**. Both pairs
are independent.

## Terminal points

Every run lands at exactly one of four exits:

| Exit | Verdict | Trigger | Notification message |
|---|---|---|---|
| 0 | SKIP | dual-gate skipped (quiet day or recent successful run) | `SKIP — <gate reason>` |
| 0 | PASS | full pipeline passed cleanly | `PASS — swept N, deleted M` |
| 0 | WARN | Stage A or Stage B emitted warn-only findings | `WARN — Stage A K findings, Stage B L, swept N` |
| 5 | FAIL | Stage A or Stage B FAIL, OR sweep aborted | `FAIL — <first finding hint>; see archive/dreams/<date>/` |

Internal errors (uncaught exceptions, lock conflicts, git-tag conflicts)
exit non-zero (codes 2-4) and do NOT fire a user-facing notification —
they're operator-side problems and surface via launchd's `StandardErrorPath`
log file plus stderr. (Future: route exit-4 internal errors to a separate
"alarm" channel.)

## macOS Notification Center

### How it works

`bin/dream.js` calls `osascript -e 'display notification "<msg>" with title "<title>"'`
at each terminal point. The AppleScript helper runs detached + unref'd so
the worker doesn't block on it.

### Notification format

- Title: `dream-mgmt YYYY-MM-DD`
- Body: ≤240 chars, single line, terminal-point-specific (see table above)

Notifications accumulate in Notification Center, so a morning skim shows
the last N nights at a glance.

### First-time install

macOS may prompt once: *"Script Editor wants to send notifications."*
Approve to silence future prompts. After that, notifications appear
automatically when the launchd agent fires the worker.

### Suppression

- `--no-notify` flag: suppress ALL notifications (umbrella)
- `DREAM_NO_NOTIFY=1` env var: same as flag
- Tests (`npm test`) inject the env automatically — no bubbles during CI

## Telegram bot

### How it works

`bin/dream.js` POSTs to `https://api.telegram.org/bot<TOKEN>/sendMessage`
with chat ID + Markdown-formatted text. Native `fetch` (Node 18+); no
SDK, no dependency. 5-second timeout; failure is silent.

### Notification format

```
*dream-mgmt 2026-05-10*
```
PASS — swept 5, deleted 2
```
```

(The body is wrapped in a fenced code block for monospace skim-friendly
display in Telegram clients. Markdown title is bolded.)

### One-time setup

1. Open Telegram, message `@BotFather`, send `/newbot`.
2. Pick a name + username for your bot. BotFather returns a token like
   `123456789:ABCdefGHIjklmnopqrSTUvwxyz0123456789`.
3. Send any message to your new bot from your account.
4. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser.
5. Copy the `chat.id` from the JSON response (a positive integer for
   direct chats; negative for groups).
6. Configure the launchd plist's `EnvironmentVariables` with both:
   ```xml
   <key>TELEGRAM_BOT_TOKEN</key>
   <string>123456789:ABCdef...</string>
   <key>TELEGRAM_CHAT_ID</key>
   <string>987654321</string>
   ```
7. Reload the plist:
   ```
   launchctl bootout gui/$(id -u)/com.jj.dream
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jj.dream.plist
   ```

### Reusing an existing bot vs dedicated bot

Two options, equally valid:

- **Reuse Hermes' bot** (`@hermes_chiefofstaff_bot` or similar): fewer
  bots to manage, but dream-mgmt notifications mix into the Hermes
  thread. Use a Telegram group + thread topic to separate.
- **Dedicated dream-mgmt bot** (`@your_dream_mgmt_bot`): cleaner
  separation, dedicated Notification Center thread. Recommended if
  you'll watch the dream verdicts daily.

### Suppression

- `--no-telegram` flag: suppress JUST Telegram (keep macOS bubble)
- `DREAM_NO_TELEGRAM=1` env var: same as flag
- `--no-notify` / `DREAM_NO_NOTIFY=1`: suppress everything (umbrella)
- Empty / unset env vars: silent skip (the channel is "not configured")

## Adding a new channel

Each channel is a function in `bin/dream.js` that takes
`{ title, message, suppress }` and is fire-and-forget. Adding e.g. an
email channel:

1. Implement `notifyEmail({ title, message, suppress })` in `bin/dream.js`
2. Call it from inside `notifyAll(...)`
3. Wire its env vars (e.g. `EMAIL_RELAY_HOST`, `EMAIL_TO`)
4. Document in this file
5. Add tests that suppress it (env var) so CI doesn't actually send

The dispatch function `notifyAll` is the single call site; channel
expansion is one function + one wire-up line.

## Failure modes (and what NOT to worry about)

| Scenario | Behavior |
|---|---|
| `osascript` not on PATH | macOS path skipped; Telegram still fires |
| macOS Notification permission denied | macOS path silently fails; Telegram still fires |
| Telegram bot token invalid | Telegram path silently fails; macOS still fires |
| Telegram API rate-limited | Silent fail (timeout-bounded at 5s) |
| No network at 3am | Telegram silent fail; macOS still fires (local-only) |
| Headless / launchd-without-GUI | macOS path silently fails; Telegram still fires |

**Rule**: every channel is best-effort + independent. The dream worker's
exit code is determined by the run's verdict + sweep state, NEVER by
notification success. The `.dream-log.md` + `event.json` files are the
source of truth for forensic recovery.

## SUCCESS-CRITERIA sign-off observation

Per SUCCESS-CRITERIA.md sign-off gate, the operator (JJ) confirms over
7 nights:

1. **Each morning's notification** matches the actual `.dream-log.md`
   verdict (no missing notifications, no wrong-verdict bubbles).
2. **PASS-frequency** is consistent with healthy operation (most nights
   PASS, occasional WARN, FAIL is rare and surfaces real issues).
3. **At least one PASS surfaces a real (not fixture) pattern promotion**
   that survives the 24h `/memory-demote` window.

Notifications are the operator's primary ergonomic surface for the
sign-off gate. If JJ ever notices a verdict notification that contradicts
the on-disk record, that's a P0 bug to investigate immediately.
