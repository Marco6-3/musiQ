# AGENTS.md

## Writing Rules

- Write `README` and `README.md` in Simplified Chinese by default.
- Use English for README files only when the user explicitly asks for English in the current conversation.
- Do not fabricate progress, test results, runtime results, or capability boundaries. Say clearly when something is unverified.

## Current Project State

- Project name: `music`.
- Platform: Windows desktop music player, plus Android local WebView APK.
- Stack: Electron + Express 5 + static frontend/PWA under `webroot/`, with `android/` bundling `webroot/` into a native WebView shell.
- Local backend default port: `41731`.
- The backend can run with plain Node. It does not need the old Electron Node wrapper.
- Database: `sql.js` WASM SQLite. Do not restore `better-sqlite3`, native SQLite rebuilds, or Electron ABI workarounds.
- Web/PWA mode must use HTTPS deployment for iPhone; keep Electron APIs behind feature detection and out of browser-only paths.
- Android APK builds do not embed the Node/Express backend. The default local build starts a lightweight Java local server on phone loopback, serves bundled `webroot/`, stores auth/favorites/playlists/history locally, and uses an Android-side lightweight dispatcher. Default Android playback should prefer NetEase/GD-Studio full audio; Kuwo/Kugou are useful for search/fallback but preview-sized playback URLs must be rejected and retried through GD-Studio. Migu code is present but currently marked unreachable in this environment. `MUSIC_ANDROID_WEB_URL` / `-PmusicWebUrl=...` can still override this for remote Web/PWA testing.

## Cloud Server Notes

- Cloud-server details for this workstation are local-only and must not be pushed to GitHub.
- Put hostnames, usernames, SSH ports, deployment paths, sudo passwords, API tokens, and any other sensitive values in `AGENTS.local.md`.
- `AGENTS.local.md` is intentionally ignored by git. Read it only when a task explicitly requires deployment or server access.
- Do not paste secrets from `AGENTS.local.md` into commits, pull requests, issue comments, logs, screenshots, or chat summaries.
- If deployment instructions change but do not include secrets, document the reusable procedure here and keep the secret values in `AGENTS.local.md`.

## Common Commands

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
```

Fallback testing flags:

```powershell
npm run probe:sources -- --disable-gdstudio
npm run probe:sources -- --disable-unm
npm run probe:sources -- --disable-meting
npm run probe:sources -- --disable-lrclib
```

## Architecture Notes

- `src/main.js`: Electron main process, window lifecycle, backend startup, window-state persistence, tray entry, cache-aware reload.
- `src/server/index.js`: Express backend, static frontend serving, PHP-compatible routes, music API proxy.
- `src/server/agent-assistant.js`: protected `/php/agent_assistant.php` assistant route. It parses song/playlist requests with DeepSeek/OpenAI-compatible config from environment variables, `AGENTS.local.md`, or local Claude Code settings; never commit API keys.
- `src/server/database.js`: persistent `sql.js` database wrapper with debounced non-transaction writes and immediate transaction/close flush.
- `src/server/offline-cache.js`: user-requested offline audio cache. Adding or syncing playlist songs never downloads audio; only the protected `/php/offline_track.php` action queues a download at `br=999`. Legacy playlist-driven cache rows are removed on backend startup.
- `src/server/source-providers/`: music provider implementations and dispatcher.
- `src/server/source-providers/lrclib.js`: lyrics-only LRCLIB fallback provider; it needs song name/artist metadata and is not a search or playback URL source.
- `src/server/api-monitor.js`: provider health checks, writes `api_status`.
- `src/server/play-history.js`: `/php/play_history.php` play-history routes.
- `webroot/js/source-selector.js`: source selector UI.
- `webroot/js/pwa.js`: PWA registration, standalone detection, install/update/network prompts.
- `webroot/sw.js`: Service Worker app shell cache; do not cache music audio URLs or third-party music API responses.
- `webroot/manifest.webmanifest`: iPhone/standalone PWA metadata.
- `android/`: native Android WebView wrapper project for debug/release APK builds. It serves bundled `webroot/` through `LocalMusicServer`, includes `MusicPlaybackService` for foreground media playback/MediaSession controls, and must stay lightweight without embedded Node/Express or native SQLite.
- `scripts/build-android-debug.ps1`: Windows helper that uses Android Studio JBR/Android SDK when present and copies the debug APK to `dist/android/music-android-debug.apk`.
- `scripts/build-android-release.ps1`: Windows helper that creates/uses ignored local signing files and copies the signed release APK to `dist/android/music-android-release.apk`.
- `tests/database-persistence.test.js`: `node:test` coverage for `sql.js` persist behavior.
- `start-music.cmd`: Windows one-click startup script with first-run dependency install.

## Change Rules

- Do not commit `.claude/`; it is Claude Code local worktree/cache state.
- Do not commit Android signing material such as `android/signing.properties`, `android/*.jks`, or `android/*.keystore`.
- If runtime architecture, startup commands, database technology, or provider structure changes, update both `AGENTS.md` and `CLAUDE.md` in the same change.
- Before merging Claude worktree changes, run:

```powershell
npm run probe:backend
npm run probe:sources
```

- If a worktree is based on older architecture and mentions `better-sqlite3` or `scripts/electron-node.js`, migrate the feature into the current `sql.js` architecture instead of accepting the old runtime path directly.



## Playback reliability update

- Lossless `/api.php?types=url&br=999` requests pass through `Dispatcher.url`, probe candidate streams concurrently, and may return the first verified lossless candidate without waiting for slower adapters. HQ proxy requests preserve source-specific adapter ordering.
- Audio verification uses bounded streaming reads (4 KiB) and byte signatures. A URL suffix, Content-Type, bitrate, or MP4 container alone must not establish lossless encoding. Unknown MP4/ALAC streams stay conservatively unverified as lossless.
- `refresh=1` on URL requests bypasses response caches; it is stripped before calling providers. Never serve stale URL responses after an upstream failure. Frontend URL cache TTL is 45 seconds.
- Shared Windows/Web/PWA UI uses a red accent and neutral dark library layout. Keep main script/CSS version strings synchronized with `webroot/sw.js` and bump its cache version for releases.
- Run `node --test tests/playback-reliability.test.js tests/music-api.test.js` for deterministic regressions. Browser layout QA, Windows packaging, and physical iPhone background playback require separate validation before release.
