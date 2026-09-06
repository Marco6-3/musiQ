# CLAUDE.md

This file gives Claude Code repository-specific guidance for this project.

## Project Overview

`music` is a Windows desktop music player rebuilt with Electron, an Express 5 local backend, and a static frontend/PWA under `webroot/`. It also has an Android WebView debug APK under `android/` that can serve bundled `webroot/` assets through a lightweight on-device Java server.

The current backend runs locally and can be started with plain Node. Web/PWA mode should be deployed over HTTPS for iPhone Safari/Home Screen use. Do not reintroduce the old Electron Node wrapper or native SQLite dependency path.

## Commands

```powershell
npm start
npm run dev
npm run server
npm run web:start
npm test
npm run test:pwa
npm run probe:sources
npm run probe:backend
npm run qa:electron
npm run android:debug
npm run android:release
npm run dist
npm run build
npm run pack
npm run installer
```

Fallback testing flags:

```powershell
npm run probe:sources -- --disable-gdstudio
npm run probe:sources -- --disable-unm
npm run probe:sources -- --disable-meting
npm run probe:sources -- --disable-lrclib
```

## Architecture

### Electron

- `src/main.js`: Electron main process, window lifecycle, splash screen, backend startup, version polling, window-state persistence, tray entry, cache-aware reload.
- `src/preload.js`: exposes safe renderer APIs through `contextBridge`.
- `src/renderer/desktop-shell.js`: frameless window controls and desktop-specific UI behavior.

### Backend

- `src/server/index.js`: Express backend. It serves `webroot/`, implements PHP-compatible routes, and proxies music API requests.
- `src/server/agent-assistant.js`: protected `/php/agent_assistant.php` assistant route. It uses DeepSeek/OpenAI-compatible config from environment variables, `AGENTS.local.md`, or local Claude Code settings; keep API keys out of git.
- `src/server/database.js`: persistent SQLite-like storage using `sql.js` WASM. Non-transaction writes are debounced, while transaction commits and close flush immediately. This avoids native module and Electron ABI problems.
- `src/server/offline-cache.js`: user-requested offline audio cache. Adding or syncing playlist songs never downloads audio; only the protected `/php/offline_track.php` action queues a download at `br=999`. Legacy playlist-driven cache rows are removed on backend startup.
- `src/server/api-monitor.js`: periodic music source health checks, writing to `api_status`.
- `src/server/play-history.js`: `/php/play_history.php` route for record, recent, top, and clear actions.

### Music Providers

Provider code lives in `src/server/source-providers/`.

- `base.js`: provider interface.
- `dispatcher.js`: fallback or race dispatch strategy.
- `gdstudio.js`: `music-api.gdstudio.xyz` provider.
- `meting.js`: `@meting/core` multi-platform provider.
- `unm.js`: local UNM resolver using `@unblockneteasemusic/server`.
- `lyric-fallback.js`: wraps UNM with Meting lyric and cover fallback.
- `lrclib.js`: lyrics-only LRCLIB fallback. It requires song name/artist metadata and should not be treated as a search or playback URL source.
- `unm-external.js`: optional external UNM service provider, disabled by default.
- `index.js`: `createDefaultDispatcher()` factory from `src/config.js`.

### Frontend

- `webroot/index.html`: app shell.
- `webroot/js/main.js`: main player UI and API client.
- `webroot/js/source-selector.js`: source selector UI layered over the native source select.
- `webroot/js/pwa.js`: Service Worker registration, standalone detection, install/update/network prompts.
- `webroot/sw.js`: Service Worker app shell cache. It must not cache music audio URLs or third-party music API responses.
- `webroot/manifest.webmanifest`: Web/PWA metadata for standalone installation.
- `tests/database-persistence.test.js`: `node:test` coverage for `sql.js` persist behavior.

### Android

- `android/`: native Android WebView wrapper. Its default builds serve bundled `webroot/` from a lightweight Java loopback server, use `MusicPlaybackService` for Android foreground media playback/MediaSession controls, and must not embed Node/Express or native SQLite.
- `scripts/build-android-debug.ps1`: Windows helper for debug APK builds. It prefers Android Studio JBR and copies the APK to `dist/android/music-android-debug.apk`.
- `scripts/build-android-release.ps1`: Windows helper for signed release APK builds. It creates/uses ignored local signing files and copies the APK to `dist/android/music-android-release.apk`.
- The default Android URL is `local`, which starts the on-device server and opens `http://127.0.0.1:<port>/?source=android`. It stores auth/favorites/playlists/history locally and uses an Android-side lightweight dispatcher. Android default playback should prefer NetEase/GD-Studio full audio; Kuwo/Kugou are useful for search/fallback but preview-sized playback URLs must be rejected and retried through GD-Studio. Migu code is present but currently marked unreachable in this environment. Use `MUSIC_ANDROID_WEB_URL` or `-PmusicWebUrl=...` only when intentionally testing a remote Web/PWA backend.

## Database

The project uses `sql.js`, not `better-sqlite3`.

Data locations:

- Desktop mode: `%APPDATA%/music/server-data/`
- Standalone backend: `data/` in the repo, ignored by git

Tables are created automatically. Core tables include `users`, `favorites`, `playlists`, `playlist_songs`, `offline_tracks`, `api_status`, and `play_history`.

## Important Notes

- `npm run server` uses plain Node and should work without Electron.
- `npm run web:start` is the same plain Node Express backend for Web/PWA deployment; use HTTPS and same-origin APIs where possible.
- `npm run android:debug` builds a debug Android APK; `npm run android:release` builds a locally signed release APK. Both require Android SDK and do not include the Node/Express backend.
- `scripts/electron-node.js` was removed and should not be restored.
- `start-music.cmd` is the Windows one-click startup script and installs dependencies on first launch.
- Verification codes are written to `<dataDir>/email_log.txt`; SMTP is not implemented.
- `.claude/` is a local Claude Code worktree/cache directory and must not be committed.
- Android signing material such as `android/signing.properties`, `android/*.jks`, and `android/*.keystore` must stay local and ignored.
- If architecture, commands, database technology, or provider behavior changes, update both `CLAUDE.md` and `AGENTS.md`.

## Review Checklist

Before merging Claude worktree changes:

```powershell
npm run probe:backend
npm run probe:sources
```

If a worktree is based on older code that mentions `better-sqlite3`, Electron ABI rebuilds, or `scripts/electron-node.js`, migrate the feature into the current `sql.js` architecture instead of directly accepting the old runtime path.



## Playback reliability update

- Lossless `/api.php?types=url&br=999` requests pass through `Dispatcher.url`, probe candidate streams concurrently, and may return the first verified lossless candidate without waiting for slower adapters. HQ proxy requests preserve source-specific adapter ordering.
- Audio verification uses bounded streaming reads (4 KiB) and byte signatures. A URL suffix, Content-Type, bitrate, or MP4 container alone must not establish lossless encoding. Unknown MP4/ALAC streams stay conservatively unverified as lossless.
- `refresh=1` on URL requests bypasses response caches; it is stripped before calling providers. Never serve stale URL responses after an upstream failure. Frontend URL cache TTL is 45 seconds.
- Shared Windows/Web/PWA UI uses a red accent and neutral dark library layout. Keep main script/CSS version strings synchronized with `webroot/sw.js` and bump its cache version for releases.
- Run `node --test tests/playback-reliability.test.js tests/music-api.test.js` for deterministic regressions. Browser layout QA, Windows packaging, and physical iPhone background playback require separate validation before release.

## UI preview

- `npm run dev` still launches Electron. With `--host`, it starts the Vite visual fixture server; `npm run preview:ui` starts that server directly (Node 20.19+ or 22.12+).
- `scripts/preview-ui.mjs` serves the real frontend with development-only deterministic songs, original placeholder text and synthetic silent WAV audio. It never connects real accounts or production providers.
- `/__qa?width=390&height=844` embeds the frontend at the requested viewport for repeatable layout review. This is browser layout QA, not native Windows/iPhone or live-source validation.
