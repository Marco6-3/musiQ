(() => {
    'use strict';

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const audio = $('#audio');
    const root = document.documentElement;
    const fallbackCover = 'public/music-default.png';
    const fallbackArtwork = 'public/icons/icon-192.png';
    const mediaArtwork = window.__musicMediaArtwork || null;
    const musiqRuntime = window.__musiqRuntime || createRuntimeFallback();
    const pwaDebugEnabled = new URLSearchParams(window.location.search).get('debugPwa') === '1';
    const mediaSessionActions = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward', 'stop'];
    const runtimeConfig = readRuntimeConfig();
    const storage = {
        token: 'music_token',
        userId: 'music_user_id',
        volume: 'music_volume',
        queue: 'music_queue'
    };
    const legacyStorage = {
        token: ['musiq_token', 'xcloud_token', 'auth_token'],
        userId: ['musiq_user_id', 'xcloud_user_id', 'user_id'],
        volume: ['musiq_volume', 'xcloud_volume'],
        queue: ['musiq_queue', 'xcloud_queue']
    };
    const publicPostPaths = new Set([
        'php/register_verification.php',
        'php/register.php',
        'php/login.php',
        'php/logout.php',
        'php/verify_token.php',
        'php/forgot_password.php'
    ]);

    const state = {
        view: 'home',
        currentUser: null,
        token: readLocalValue(storage.token, legacyStorage.token) || '',
        queue: readJson(storage.queue, [], legacyStorage.queue),
        currentIndex: -1,
        currentSong: null,
        searchResults: [],
        homeSongs: [],
        favorites: [],
        playlists: [],
        activePlaylistName: null,
        lyrics: [],
        activeLyricIndex: -1,
        lastLyricScrollAt: 0,
        playMode: 'order',
        isLoading: false,
        pendingPlaylistSong: null,
        stallTimer: 0,
        qualityRetryLevel: 0,
        currentQuality: '999',
        recentPlays: [],
        weeklyFavorites: [],
        historyLoading: false,
        historyLoadedForUser: '',
        playerStatus: '准备就绪',
        progressDragging: false,
        progressDragInput: null,
        playRequestId: 0,
        lastPlayableUrl: '',
        lastKnownPlaybackTime: 0,
        playbackIntent: false,
        lastLifecycleHiddenAt: 0,
        lastLifecycleHiddenTime: 0,
        lifecycleRecoveryTimer: 0,
        lifecycleRecoveryToken: 0,
        mediaSessionResumeInFlight: false,
        cloudSyncTimer: 0,
        cloudSyncInFlight: false,
        agentMessages: [],
        agentBusy: false,
        agentUsage: null,
        renamingPlaylistName: null,
        resumeWatchdogTimer: 0,
        playbackWatchdogTimer: 0,
        playbackWatchdogToken: 0,
        playbackWatchdogRetries: 0,
        endedRecoveryRetries: 0,
        nextPrefetchTimer: 0,
        nextAudioPrewarmStatus: '',
        nextAudioPrewarmUrl: '',
        lastBufferingToastAt: 0,
        lastMediaPositionUpdateAt: 0,
        lastBackgroundTickAt: 0,
        sourceDiagnostics: {
            musicSource: '',
            cache: '',
            requestAt: '',
            providers: {},
            error: ''
        },
        lowPowerMode: document.hidden,
        mediaSessionHandlersRegistered: false
    };
    const COVER_CACHE_MAX = 200;
    const coverCache = new Map();
    const coverInflight = new Map();
    const AUDIO_URL_CACHE_MAX = 24;
    const AUDIO_URL_CACHE_TTL_MS = 10 * 60 * 1000;
    const USER_SYNC_LIMITS = {
        favorites: 10000,
        playlists: 300,
        playlistSongs: 10000,
        recentPlays: 1000,
        queue: 500
    };
    const audioUrlCache = new Map();

    function coverCacheSet(key, value) {
        if (coverCache.size >= COVER_CACHE_MAX) {
            // Evict oldest entry
            const oldest = coverCache.keys().next().value;
            coverCache.delete(oldest);
        }
        coverCache.set(key, value);
    }

    // O(1) favorites lookup Set: "source:id"
    const favoriteKeys = new Set();

    function rebuildFavoriteKeys() {
        favoriteKeys.clear();
        for (const item of state.favorites) {
            favoriteKeys.add(`${item.source || 'netease'}:${item.id}`);
        }
    }

    // Reusable offscreen canvas for cover theme extraction
    const _coverCanvas = document.createElement('canvas');
    _coverCanvas.width = 24;
    _coverCanvas.height = 24;
    const _coverCtx = _coverCanvas.getContext('2d', { willReadFrequently: true });
    const _coverImage = new Image();
    _coverImage.crossOrigin = 'anonymous';
    _coverImage.decoding = 'async';
    const coverResolveQueue = [];
    const maxConcurrentCoverResolves = 4;
    let activeCoverResolves = 0;
    let songCoverObserver = null;

    const toplists = [
        ['soaring', '飙升榜', '正在被更多人听见'],
        ['new', '新歌榜', '新鲜发布'],
        ['original', '原创榜', '独立表达'],
        ['hot', '热歌榜', '高频循环'],
        ['douyin', '抖音排行榜', '短视频热播歌曲'],
        ['qq_music', 'QQ音乐热歌榜', 'QQ巅峰榜热歌'],
        ['rap', '说唱榜', '节奏和态度'],
        ['electronic', '电音榜', '夜间能量']
    ];

    const els = {
        viewTitle: $('#view-title'),
        viewRoot: $('#view-root'),
        searchForm: $('#search-form'),
        searchInput: $('#search-input'),
        sourceSelect: $('#source-select'),
        qualitySelect: $('#quality-select'),
        loginOpen: $('#login-open-btn'),
        mobileLoginOpen: $('#mobile-login-open-btn'),
        logout: $('#logout-btn'),
        mobileLogout: $('#mobile-logout-btn'),
        userChip: $('#user-chip'),
        mobileUserChip: $('#mobile-user-chip'),
        userName: $('#user-name'),
        mobileUserName: $('#mobile-user-name'),
        userAvatar: $('#user-avatar'),
        mobileUserAvatar: $('#mobile-user-avatar'),
        queueList: $('#queue-list'),
        clearQueue: $('#clear-queue-btn'),
        sideCover: $('#side-cover'),
        sideTitle: $('#side-title'),
        sideArtist: $('#side-artist'),
        dockSong: $('#dock-song'),
        dockCover: $('#dock-cover'),
        dockTitle: $('#dock-title'),
        dockArtist: $('#dock-artist'),
        dockStatus: $('#dock-status'),
        play: $('#play-btn'),
        prev: $('#prev-btn'),
        next: $('#next-btn'),
        mode: $('#mode-btn'),
        favorite: $('#favorite-btn'),
        addPlaylist: $('#add-playlist-btn'),
        queueOpen: $('#queue-open-btn'),
        expand: $('#expand-btn'),
        progress: $('#progress-slider'),
        currentTime: $('#current-time'),
        durationTime: $('#duration-time'),
        volume: $('#volume-slider'),
        playerModal: $('#player-modal'),
        expandedCover: $('#expanded-cover'),
        expandedTitle: $('#expanded-title'),
        expandedArtist: $('#expanded-artist'),
        expandedPlay: $('#expanded-play-btn'),
        expandedPrev: $('#expanded-prev-btn'),
        expandedNext: $('#expanded-next-btn'),
        expandedStatus: $('#expanded-status'),
        expandedQuality: $('#expanded-quality'),
        expandedProgress: $('#expanded-progress-slider'),
        expandedCurrentTime: $('#expanded-current-time'),
        expandedDurationTime: $('#expanded-duration-time'),
        lyricBox: $('#lyric-box'),
        authModal: $('#auth-modal'),
        loginForm: $('#login-form'),
        registerForm: $('#register-form'),
        resetPasswordForm: $('#reset-password-form'),
        sendRegisterCode: $('#send-register-code'),
        sendResetCode: $('#send-reset-code'),
        playlistModal: $('#playlist-modal'),
        playlistChoiceList: $('#playlist-choice-list'),
        createPlaylistForm: $('#create-playlist-form'),
        toast: $('#toast'),
        sourceStatus: $('#source-status-btn'),
        sourceDiagnosticsRefresh: $('#source-diagnostics-refresh'),
        diagMusicSource: $('#diag-music-source'),
        diagCache: $('#diag-cache'),
        diagRequestAt: $('#diag-request-at'),
        providerStatusList: $('#provider-status-list'),
        pwaDiagnostics: $('#pwa-diagnostics'),
        pwaDiagnosticsGrid: $('#pwa-diagnostics-grid'),
        pwaCopyDiagnostics: $('#pwa-copy-diagnostics'),
        pwaClearState: $('#pwa-clear-state'),
        pwaClearQueue: $('#pwa-clear-queue'),
        pwaReload: $('#pwa-reload'),
        inAppPlaybackModal: $('#in-app-playback-modal'),
        inAppPlaybackSteps: $('#in-app-playback-steps'),
        copySafariLink: $('#copy-safari-link-btn'),
        showIosInstallSteps: $('#show-ios-install-steps-btn'),
        browseOnly: $('#browse-only-btn')
    };

    init();

    function init() {
        refreshRuntimeState();
        audio.volume = Number(readLocalValue(storage.volume, legacyStorage.volume) || 70) / 100;
        els.volume.value = String(Math.round(audio.volume * 100));
        bindEvents();
        bindRuntimeEvents();
        verifySession();
        renderShell();
        const launchParams = new URLSearchParams(window.location.search);
        const initialView = ['home', 'search', 'favorites', 'playlists', 'agent'].includes(launchParams.get('view'))
            ? launchParams.get('view')
            : 'home';
        renderView(initialView);
        markRouteRestore();
        loadToplist('soaring', true);
        if (launchParams.get('panel') === 'queue') {
            setTimeout(() => openModal('queue-modal'), 0);
        }
        setupMediaSessionHandlers();
        applyRuntimePlaybackGuidance();
        initPwaDiagnostics();
    }

    function bindEvents() {
        $$('.nav-item').forEach((button) => {
            button.addEventListener('click', () => {
                if (button.dataset.view === 'playlists') state.activePlaylistName = null;
                renderView(button.dataset.view);
            });
        });

        els.searchForm.addEventListener('submit', (event) => {
            event.preventDefault();
            searchSongs(els.searchInput.value.trim());
        });

        els.play.addEventListener('click', togglePlay);
        els.expandedPlay.addEventListener('click', togglePlay);
        els.prev.addEventListener('click', playPrevious);
        els.expandedPrev.addEventListener('click', playPrevious);
        els.next.addEventListener('click', playNext);
        els.expandedNext.addEventListener('click', playNext);
        els.mode.addEventListener('click', cyclePlayMode);
        els.favorite.addEventListener('click', toggleFavorite);
        els.addPlaylist.addEventListener('click', () => openPlaylistDialog(state.currentSong));
        els.queueOpen.addEventListener('click', () => openModal('queue-modal'));
        els.expand.addEventListener('click', () => openModal('player-modal'));
        els.dockSong?.addEventListener('click', () => {
            if (state.currentSong) openModal('player-modal');
        });
        els.dockSong?.addEventListener('keydown', (event) => {
            if ((event.key === 'Enter' || event.key === ' ') && state.currentSong) {
                event.preventDefault();
                openModal('player-modal');
            }
        });
        els.clearQueue.addEventListener('click', clearQueue);
        bindQueueActions();
        els.loginOpen.addEventListener('click', () => openModal('auth-modal'));
        els.mobileLoginOpen?.addEventListener('click', () => openModal('auth-modal'));
        els.logout.addEventListener('click', logout);
        els.mobileLogout?.addEventListener('click', logout);
        els.sourceStatus.addEventListener('click', showSourceStatus);
        els.sourceDiagnosticsRefresh?.addEventListener('click', () => refreshSourceDiagnostics({ force: true }));
        els.pwaCopyDiagnostics?.addEventListener('click', copyPwaDiagnostics);
        els.pwaClearState?.addEventListener('click', clearLocalPwaState);
        els.pwaClearQueue?.addEventListener('click', clearPlaybackQueueForDiagnostics);
        els.pwaReload?.addEventListener('click', () => window.location.reload());
        els.copySafariLink?.addEventListener('click', copySafariLaunchLink);
        els.showIosInstallSteps?.addEventListener('click', () => {
            if (els.inAppPlaybackSteps) els.inAppPlaybackSteps.hidden = false;
        });
        els.browseOnly?.addEventListener('click', () => closeModal('in-app-playback-modal'));
        bindWindowControls();
        bindWheelForwarding();
        bindResizePerformanceMode();
        bindBottomSheetGestures();

        bindProgressSlider(els.progress);
        bindProgressSlider(els.expandedProgress);
        window.addEventListener('pointerup', commitProgressSeek, { passive: true });
        window.addEventListener('pointercancel', cancelProgressDrag, { passive: true });

        els.volume.addEventListener('input', () => {
            audio.volume = Number(els.volume.value) / 100;
            localStorage.setItem(storage.volume, els.volume.value);
        });
        els.qualitySelect.addEventListener('change', () => {
            if (state.currentSong) showToast(`下一首将使用${qualityLabel(els.qualitySelect.value)}`);
        });

        audio.addEventListener('play', () => {
            state.playbackIntent = true;
            musiqRuntime.markAudioError?.('');
            rememberPlaybackSnapshot();
            setPlayerStatus('正在播放');
            updatePlayButtons();
            updateMediaSessionMetadata({ afterPlaybackStart: true });
            updateMediaSessionPlaybackState();
            updateMediaSessionPositionState({ force: true });
            notifyAndroidPlayback('playing');
            renderPwaDiagnostics();
        });
        audio.addEventListener('pause', () => {
            rememberPlaybackSnapshot();
            setPlayerStatus(state.currentSong ? '已暂停' : '准备就绪');
            if (state.currentSong && canUseFullMediaSession()) setupMediaSessionHandlers();
            updatePlayButtons();
            updateMediaSessionPlaybackState();
            updateMediaSessionPositionState({ force: true });
            notifyAndroidPlayback(state.currentSong ? 'paused' : 'stopped');
            renderPwaDiagnostics();
        });
        audio.addEventListener('timeupdate', () => {
            if (document.hidden) {
                const now = Date.now();
                if (now - state.lastBackgroundTickAt < 5000) return;
                state.lastBackgroundTickAt = now;
                rememberPlaybackSnapshot();
                updateMediaSessionPositionState();
                return;
            }
            rememberPlaybackSnapshot();
            updateProgress();
            updateMediaSessionPositionState();
        });
        audio.addEventListener('loadedmetadata', () => {
            rememberPlaybackSnapshot();
            updateProgress();
            updateMediaSessionPositionState({ force: true });
        });
        audio.addEventListener('ended', handleEnded);
        audio.addEventListener('waiting', handleBuffering);
        audio.addEventListener('stalled', handleBuffering);
        audio.addEventListener('canplay', clearBuffering);
        audio.addEventListener('playing', clearBuffering);
        audio.addEventListener('error', () => {
            stopPlaybackIntent();
            musiqRuntime.markAudioError?.(audio.error?.code || '');
            setPlayerStatus('播放失败');
            updateMediaSessionPlaybackState();
            notifyAndroidPlayback('stopped');
            renderPwaDiagnostics();
            showToast('播放失败，音乐源暂时不可用', 'error');
        });

        $$('.close-btn').forEach((button) => {
            button.addEventListener('click', () => closeModal(button.dataset.closeModal));
        });
        $$('.modal').forEach((modal) => {
            modal.addEventListener('click', (event) => {
                if (event.target === modal) closeModal(modal.id);
            });
        });

        $$('.tab-btn').forEach((button) => {
            button.addEventListener('click', () => switchAuthTab(button.dataset.authTab));
        });
        els.loginForm.addEventListener('submit', handleLogin);
        els.registerForm.addEventListener('submit', handleRegister);
        els.resetPasswordForm?.addEventListener('submit', handleResetPassword);
        els.sendRegisterCode.addEventListener('click', sendRegisterCode);
        els.sendResetCode?.addEventListener('click', sendResetCode);
        els.createPlaylistForm.addEventListener('submit', createPlaylistAndAdd);

        document.addEventListener('keydown', (event) => {
            if (event.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
                event.preventDefault();
                togglePlay();
            }
            if (event.key === 'Escape') $$('.modal.open').forEach((modal) => closeModal(modal.id));
        });
    }

    function bindRuntimeEvents() {
        window.addEventListener('pageshow', (event) => {
            refreshRuntimeState();
            musiqRuntime.pageshowPersisted = Boolean(event.persisted);
            markRouteRestore();
            setupMediaSessionHandlers();
            if (state.currentSong && (audio.src || state.lastPlayableUrl)) {
                updateMediaSessionMetadata({ afterPlaybackStart: true });
                scheduleLifecyclePlaybackRecovery('pageshow');
            }
            if (isIosInAppPlaybackBlocked()) stopBlockedRuntimeMedia();
            renderShell();
            renderPwaDiagnostics();
            if (musiqRuntime.reinstallRecommended) {
                showToast('建议删除旧图标后从 Safari 重新添加 music 到主屏幕');
            }
        });

        document.addEventListener('visibilitychange', () => {
            state.lowPowerMode = document.hidden;
            refreshRuntimeState();
            document.body.classList.toggle('is-low-power-runtime', state.lowPowerMode && !audio.paused);
            if (document.hidden) {
                state.lastLifecycleHiddenAt = Date.now();
                state.lastLifecycleHiddenTime = rememberPlaybackSnapshot();
                if (state.currentSong && !audio.paused && !audio.ended) state.playbackIntent = true;
                if (state.currentSong && !audio.paused && musiqRuntime.isIOS && musiqRuntime.isStandalonePwa) {
                    scheduleNextAudioPrefetch({ immediate: true });
                }
                if (state.currentSong && (audio.src || state.lastPlayableUrl) && canUseFullMediaSession()) {
                    setupMediaSessionHandlers();
                    updateMediaSessionMetadata({ afterPlaybackStart: true });
                    updateMediaSessionPlaybackState();
                } else if (!state.currentSong) {
                    clearOrDegradeMediaSession('hidden-paused');
                }
                scheduleLifecyclePlaybackRecovery('hidden');
                renderPwaDiagnostics();
                return;
            }

            updatePlayButtons();
            updateProgress();
            if (state.currentSong && (audio.src || state.lastPlayableUrl)) {
                setupMediaSessionHandlers();
                updateMediaSessionMetadata({ afterPlaybackStart: true });
                scheduleLifecyclePlaybackRecovery('visible');
            }
            renderPwaDiagnostics();
        });

        window.addEventListener('pagehide', (event) => {
            if (!event.persisted || !state.currentSong) return;
            state.lastLifecycleHiddenAt = Date.now();
            state.lastLifecycleHiddenTime = rememberPlaybackSnapshot();
        });

        window.addEventListener('musiq-runtime:manifest', renderPwaDiagnostics);
        navigator.serviceWorker?.addEventListener?.('controllerchange', () => {
            refreshRuntimeState();
            renderPwaDiagnostics();
        });
    }

    function bindWindowControls() {
        $('#app-minimize-btn')?.addEventListener('click', (event) => {
            if (event.currentTarget.dataset.electronBound) return;
            if (window.electronAPI?.minimize) window.electronAPI.minimize();
            else showToast('浏览器预览不支持最小化，请在 exe 中使用');
        });
        $('#app-maximize-btn')?.addEventListener('click', (event) => {
            if (event.currentTarget.dataset.electronBound) return;
            if (window.electronAPI?.maximize) window.electronAPI.maximize();
            else showToast('浏览器预览不支持最大化，请在 exe 中使用');
        });
        $('#app-close-btn')?.addEventListener('click', (event) => {
            if (event.currentTarget.dataset.electronBound) return;
            if (window.electronAPI?.close) window.electronAPI.close();
            else showToast('浏览器预览不支持关闭窗口，请在 exe 中使用');
        });
        if (window.electronAPI?.onWindowMaximized) {
            window.electronAPI.onWindowMaximized((maximized) => {
                const button = $('#app-maximize-btn');
                if (!button) return;
                button.textContent = maximized ? '❐' : '□';
                button.title = maximized ? '还原' : '最大化';
                button.setAttribute('aria-label', button.title);
            });
        }
    }

    function bindWheelForwarding() {
        document.addEventListener('wheel', (event) => {
            const scrollable = event.target.closest('#view-root, .queue-list, .lyric-box, .app-shell, .modal.open');
            if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) return;
            if (!els.viewRoot || els.viewRoot.scrollHeight <= els.viewRoot.clientHeight) return;
            els.viewRoot.scrollTop += event.deltaY;
        }, { passive: true });
    }

    function bindResizePerformanceMode() {
        let resizeTimer = 0;

        window.addEventListener('resize', () => {
            document.body.classList.add('is-window-resizing');
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                document.body.classList.remove('is-window-resizing');
            }, 180);
        }, { passive: true });
    }

    function bindBottomSheetGestures() {
        $$('.queue-drawer, .expanded-player, .auth-card, .playlist-dialog, .source-diagnostics').forEach((panel) => {
            let startY = 0;
            let dragging = false;

            panel.addEventListener('touchstart', (event) => {
                if (!event.touches.length || panel.scrollTop > 0) return;
                startY = event.touches[0].clientY;
                dragging = true;
            }, { passive: true });

            panel.addEventListener('touchmove', (event) => {
                if (!dragging || !event.touches.length) return;
                const deltaY = event.touches[0].clientY - startY;
                if (deltaY <= 0 || panel.scrollTop > 0) return;
                panel.style.transform = `translateY(${Math.min(deltaY, 120)}px)`;
                event.preventDefault();
            }, { passive: false });

            panel.addEventListener('touchend', (event) => {
                if (!dragging) return;
                dragging = false;
                const modal = panel.closest('.modal');
                const touch = event.changedTouches[0];
                const deltaY = touch ? touch.clientY - startY : 0;
                panel.style.transform = '';
                if (deltaY > 88 && modal) closeModal(modal.id);
            }, { passive: true });
        });
    }

    async function verifySession() {
        const persistedAuth = await readPersistedAuthState();
        if (!state.token && persistedAuth.token) state.token = persistedAuth.token;
        const userId = readLocalValue(storage.userId, legacyStorage.userId) || persistedAuth.userId || '';
        if (!state.token) {
            if (userId) clearUser();
            else updateUserUI();
            return;
        }

        try {
            const data = await apiPost('php/verify_token.php', { token: state.token, user_id: userId || '' });
            if (data.success && data.user) {
                setUser(data.user, state.token);
            } else {
                clearUser();
            }
        } catch {
            clearUser();
        }
    }

    function setUser(user, token, options = {}) {
        const previousUserId = state.currentUser?.id ? String(state.currentUser.id) : '';
        state.currentUser = user;
        state.token = token || state.token;
        state.favorites = normalizeSongList(user.favorites || []);
        rebuildFavoriteKeys();
        state.playlists = playlistsFromUser(user);
        applyUserSyncState(user.sync_state, { replaceQueue: Boolean(options.replaceQueue) });
        if (String(user.id) !== previousUserId) {
            state.recentPlays = [];
            state.weeklyFavorites = [];
            state.historyLoadedForUser = '';
        }
        localStorage.setItem(storage.userId, String(user.id));
        if (state.token) localStorage.setItem(storage.token, state.token);
        persistAuthState({ userId: String(user.id), token: state.token });
        updateUserUI();
        renderShell();
        renderView(state.view);
        loadUserHistory({ silent: true });
    }

    function clearUser() {
        clearTimeout(state.cloudSyncTimer);
        state.cloudSyncTimer = 0;
        state.cloudSyncInFlight = false;
        state.currentUser = null;
        state.token = '';
        state.favorites = [];
        rebuildFavoriteKeys();
        state.playlists = [];
        state.recentPlays = [];
        state.weeklyFavorites = [];
        state.historyLoadedForUser = '';
        removeLocalKeys(storage.token, storage.userId, legacyStorage.token, legacyStorage.userId, 'username');
        clearPersistedAuthState();
        updateUserUI();
    }

    function updateUserUI() {
        const loggedIn = Boolean(state.currentUser);
        els.loginOpen.hidden = loggedIn;
        els.userChip.hidden = !loggedIn;
        if (els.mobileLoginOpen) els.mobileLoginOpen.hidden = loggedIn;
        if (els.mobileUserChip) els.mobileUserChip.hidden = !loggedIn;
        if (!loggedIn) return;
        const username = state.currentUser.username || 'music用户';
        const avatar = state.currentUser.avatar || 'public/avatars/default1.png';
        els.userName.textContent = username;
        els.userAvatar.src = avatar;
        if (els.mobileUserName) els.mobileUserName.textContent = username;
        if (els.mobileUserAvatar) els.mobileUserAvatar.src = avatar;
    }

    function renderShell() {
        renderQueue();
        renderPlayer();
    }

    function renderView(view) {
        state.view = view;
        markRouteRestore();
        if (view !== 'playlists') state.activePlaylistName = null;
        $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
        const titles = {
            home: '为今晚找一首歌',
            search: '搜索音乐',
            favorites: '我的收藏',
            playlists: '我的歌单',
            agent: '助手'
        };
        els.viewTitle.textContent = titles[view] || titles.home;

        if (view === 'home') renderHome();
        if (view === 'search') renderSearch();
        if (view === 'favorites') renderFavorites();
        if (view === 'agent') renderAgent();
        if (view === 'playlists') {
            const activePlaylist = state.playlists.find((item) => item.name === state.activePlaylistName);
            if (activePlaylist) openPlaylistView(activePlaylist.name);
            else renderPlaylists();
        }
    }

    function renderHome() {
        els.viewRoot.innerHTML = `
            <div class="hero-strip">
                <div class="feature-card">
                    <h2>深色玻璃播放器，连接网易云与酷我音乐。</h2>
                    <p>搜索、播放、收藏、歌单和歌词都保留在本地桌面体验里。当前播放器颜色会跟随封面自动变化。</p>
                </div>
                <div class="stat-card">
                    <span class="eyebrow">Library</span>
                    <strong>${state.queue.length}</strong>
                    <span class="meta">队列中的歌曲</span>
                </div>
            </div>
            ${renderHomeHistory()}
            <div class="section-head">
                <div>
                    <h2>推荐榜单</h2>
                    <p class="meta">点击榜单即可拉取网易云实时歌曲</p>
                </div>
            </div>
            <div class="toplist-grid">
                ${toplists.map(([type, title, desc]) => `
                    <button class="toplist-card" data-toplist="${escapeHtml(type)}">
                        <p class="eyebrow">${escapeHtml(type)}</p>
                        <h3>${escapeHtml(title)}</h3>
                        <p class="meta">${escapeHtml(desc)}</p>
                    </button>
                `).join('')}
            </div>
            <div class="section-head" style="margin-top:18px">
                <div>
                    <h2>榜单歌曲</h2>
                    <p class="meta" id="home-list-subtitle">${state.homeSongs.length ? '点击播放或加入队列' : '正在等待加载'}</p>
                </div>
            </div>
            <div id="home-song-list">${renderSongList(state.homeSongs, 'home')}</div>
        `;

        $$('[data-toplist]', els.viewRoot).forEach((button) => {
            button.addEventListener('click', () => loadToplist(button.dataset.toplist));
        });
        $('#refresh-history-btn')?.addEventListener('click', () => loadUserHistory({ force: true }));
        bindSongActions(els.viewRoot);
        hydrateSongCardCovers(els.viewRoot);
        ensureHomeHistoryLoaded();
    }

    function renderHomeHistory() {
        if (!state.currentUser) return '';

        const loadingText = state.historyLoading ? '<p class="meta">正在同步播放历史...</p>' : '';
        return `
            <div class="section-head" style="margin-top:18px">
                <div>
                    <h2>播放历史</h2>
                    <p class="meta">最近播放和本周常听仅在登录后同步</p>
                </div>
                <button class="ghost-btn" id="refresh-history-btn">刷新历史</button>
            </div>
            ${loadingText}
            <div class="home-history-grid">
                <section class="home-history-section">
                    <div class="section-head">
                        <div>
                            <h3>最近播放</h3>
                            <p class="meta">${state.recentPlays.length ? `${state.recentPlays.length} 首` : '暂无记录'}</p>
                        </div>
                    </div>
                    ${renderSongList(state.recentPlays, 'recent')}
                </section>
                <section class="home-history-section">
                    <div class="section-head">
                        <div>
                            <h3>本周常听</h3>
                            <p class="meta">${state.weeklyFavorites.length ? '按播放次数排序' : '暂无记录'}</p>
                        </div>
                    </div>
                    ${renderSongList(state.weeklyFavorites, 'weekly')}
                </section>
            </div>
        `;
    }

    function renderSearch() {
        els.viewRoot.innerHTML = `
            <div class="section-head">
                <div>
                    <h2>搜索结果</h2>
                    <p class="meta">${state.searchResults.length ? `共 ${state.searchResults.length} 首` : '输入关键词后回车搜索'}</p>
                </div>
            </div>
            ${state.isLoading ? loadingState('正在搜索音乐') : renderSongList(state.searchResults, 'search')}
        `;
        bindSongActions(els.viewRoot);
        hydrateSongCardCovers(els.viewRoot);
    }

    function renderFavorites() {
        if (!state.currentUser) {
            els.viewRoot.innerHTML = emptyState('登录后可以同步收藏', '收藏会保存在本地 SQLite 数据库里。');
            return;
        }
        els.viewRoot.innerHTML = `
            <div class="section-head">
                <div>
                    <h2>我的收藏</h2>
                    <p class="meta">${state.favorites.length ? `${state.favorites.length} 首收藏歌曲` : '还没有收藏歌曲'}</p>
                </div>
            </div>
            ${renderSongList(state.favorites, 'favorites')}
        `;
        bindSongActions(els.viewRoot);
        hydrateSongCardCovers(els.viewRoot);
    }

    function renderPlaylists() {
        state.activePlaylistName = null;
        if (!state.currentUser) {
            els.viewRoot.innerHTML = emptyState('登录后可以管理歌单', '创建、重命名、删除和添加歌曲都会走现有接口。');
            return;
        }
        els.viewRoot.innerHTML = `
            <div class="section-head">
                <div>
                    <h2>我的歌单</h2>
                    <p class="meta">${state.playlists.length ? `${state.playlists.length} 个歌单` : '还没有歌单'}</p>
                </div>
                <button class="primary-btn" id="new-playlist-view-btn">新建歌单</button>
            </div>
            <div class="playlist-grid">
                ${state.playlists.map((playlist) => {
                    const isRenaming = state.renamingPlaylistName === playlist.name;
                    return `
                        <div class="playlist-card" data-playlist-name="${escapeAttr(playlist.name)}" ${isRenaming ? 'data-renaming="1"' : 'role="button" tabindex="0"'}>
                            ${isRenaming ? `
                                <form class="playlist-rename-form" data-playlist-rename-form>
                                    <p class="eyebrow">${playlist.songs.length} songs</p>
                                    <input class="playlist-rename-input" name="new_name" value="${escapeAttr(playlist.name)}" maxlength="60" aria-label="新的歌单名称">
                                    <div class="playlist-rename-actions">
                                        <button class="primary-btn" type="submit">保存</button>
                                        <button class="ghost-btn" type="button" data-action="cancel-rename">取消</button>
                                    </div>
                                </form>
                            ` : `
                                <div class="playlist-card-content">
                                    <p class="eyebrow">${playlist.songs.length} songs</p>
                                    <h3>${escapeHtml(playlist.name)}</h3>
                                    <p class="meta">点击查看歌曲</p>
                                </div>
                                <button class="playlist-rename-btn icon-btn" type="button" data-action="rename-playlist" title="重命名歌单" aria-label="重命名 ${escapeAttr(playlist.name)}">✎</button>
                            `}
                        </div>
                    `;
                }).join('') || emptyState('暂无歌单', '从播放器或歌曲列表添加第一首歌。')}
            </div>
        `;

        $('#new-playlist-view-btn')?.addEventListener('click', async () => {
            const name = prompt('请输入歌单名称');
            if (!name) return;
            await createPlaylist(name.trim());
            renderPlaylists();
        });
        $$('.playlist-card', els.viewRoot).forEach((card) => {
            const renameForm = $('[data-playlist-rename-form]', card);
            if (renameForm) {
                renameForm.addEventListener('submit', async (event) => {
                    event.preventDefault();
                    await renamePlaylist(card.dataset.playlistName, renameForm.elements.new_name.value);
                });
                $('[data-action="cancel-rename"]', card)?.addEventListener('click', () => {
                    state.renamingPlaylistName = null;
                    renderPlaylists();
                });
                return;
            }

            card.addEventListener('click', (event) => {
                if (event.target.closest('[data-action="rename-playlist"]')) return;
                openPlaylistView(card.dataset.playlistName);
            });
            card.addEventListener('keydown', (event) => {
                if (event.target.closest('[data-action="rename-playlist"]')) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openPlaylistView(card.dataset.playlistName);
            });
            card.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                renamePlaylist(card.dataset.playlistName);
            });
            $('[data-action="rename-playlist"]', card)?.addEventListener('click', (event) => {
                event.stopPropagation();
                state.renamingPlaylistName = card.dataset.playlistName;
                renderPlaylists();
            });
        });
        const renameInput = $('.playlist-rename-input', els.viewRoot);
        if (renameInput) {
            renameInput.focus();
            renameInput.select();
        }
    }

    function renderAgent() {
        if (!state.currentUser) {
            els.viewRoot.innerHTML = emptyState('登录后可以使用助手', '助手会把结果写入你的歌单。');
            return;
        }

        const playlistOptions = state.playlists.map((playlist) => `
            <option value="${escapeAttr(playlist.name)}">${escapeHtml(playlist.name)}</option>
        `).join('');
        const usageLabel = state.agentUsage?.unlimited
            ? '无限额度'
            : state.agentUsage
                ? `今日剩余 ${state.agentUsage.remaining}/${state.agentUsage.limit}`
                : String(state.currentUser.username || '').toLowerCase() === 'mingzhe'
                    ? '无限额度'
                    : '每日 2 次';
        els.viewRoot.innerHTML = `
            <div class="agent-workspace">
                <div class="section-head">
                    <div>
                        <h2>Agent 助手</h2>
                        <p class="meta">${state.agentBusy ? '处理中' : `${state.playlists.length} 个歌单 · ${usageLabel}`}</p>
                    </div>
                    <select id="agent-playlist-select" class="agent-playlist-select">
                        <option value="">自动识别歌单</option>
                        ${playlistOptions}
                    </select>
                </div>
                <div class="agent-thread" id="agent-thread">
                    ${state.agentMessages.length
                        ? state.agentMessages.map(renderAgentMessage).join('')
                        : emptyState('暂无对话', '输入歌曲和歌单后发送。')}
                    ${state.agentBusy ? '<div class="agent-message assistant"><span>正在处理...</span></div>' : ''}
                </div>
                <form class="agent-form" id="agent-form">
                    <textarea id="agent-input" maxlength="2000" rows="3" placeholder="输入歌曲和歌单，或查看某个歌单里的歌曲"></textarea>
                    <button class="primary-btn" type="submit" ${state.agentBusy ? 'disabled' : ''}>发送</button>
                </form>
            </div>
        `;

        $('#agent-form')?.addEventListener('submit', sendAgentMessage);
        const thread = $('#agent-thread');
        if (thread) thread.scrollTop = thread.scrollHeight;
    }

    function renderAgentMessage(message) {
        const result = message.result || {};
        const added = normalizeSongList(result.added_songs || []);
        const existing = normalizeSongList(result.existing_songs || []);
        const playlistSongs = result.action === 'query_playlist_songs'
            ? normalizeSongList(result.playlist_songs || [])
            : [];
        const unresolved = result.unresolved_songs || [];
        const details = [
            ...added.map((song) => `<li>已添加：${escapeHtml(song.name)} · ${escapeHtml(formatArtists(song.artist))}</li>`),
            ...existing.map((song) => `<li>已存在：${escapeHtml(song.name)} · ${escapeHtml(formatArtists(song.artist))}</li>`),
            ...playlistSongs.map((song, index) => `<li>${index + 1}. ${escapeHtml(song.name)}${formatArtists(song.artist) ? ` · ${escapeHtml(formatArtists(song.artist))}` : ''}</li>`),
            ...unresolved.map((song) => `<li>未找到：${escapeHtml(song.title || song.name || '')}${song.artist ? ` · ${escapeHtml(song.artist)}` : ''}</li>`)
        ].join('');
        return `
            <div class="agent-message ${escapeAttr(message.role || 'assistant')}">
                <span>${escapeHtml(message.text || '')}</span>
                ${details ? `<ul>${details}</ul>` : ''}
            </div>
        `;
    }

    async function sendAgentMessage(event) {
        event.preventDefault();
        const input = $('#agent-input');
        const playlistSelect = $('#agent-playlist-select');
        const text = String(input?.value || '').trim();
        if (!text || state.agentBusy) return;

        state.agentMessages.push({ role: 'user', text });
        state.agentBusy = true;
        renderAgent();

        try {
            const data = await apiPost('php/agent_assistant.php', {
                user_id: state.currentUser.id,
                message: text,
                playlist_name: playlistSelect?.value || '',
                source: els.sourceSelect?.value || 'netease'
            });
            if (!data.success) throw new Error(data.message || '助手处理失败');
            if (data.agent_usage) state.agentUsage = data.agent_usage;
            if (data.user) {
                state.currentUser = data.user;
                state.favorites = normalizeSongList(data.user.favorites || []);
                rebuildFavoriteKeys();
                state.playlists = playlistsFromUser(data.user);
                updateUserUI();
                renderShell();
                scheduleCloudSync();
            }
            state.agentMessages.push({
                role: 'assistant',
                text: data.reply || data.message || '已处理',
                result: data
            });
        } catch (error) {
            state.agentMessages.push({
                role: 'assistant',
                text: error.message || '助手处理失败'
            });
        } finally {
            state.agentBusy = false;
            renderAgent();
        }
    }

    async function openPlaylistView(name) {
        const playlist = state.playlists.find((item) => item.name === name);
        if (!playlist) return;
        state.activePlaylistName = name;
        const songs = normalizeSongList(playlist.songs);
        els.viewRoot.innerHTML = `
            <div class="section-head">
                <div>
                    <button class="text-btn" id="back-playlists">← 返回歌单</button>
                    <h2>${escapeHtml(name)}</h2>
                    <p class="meta">${songs.length} 首歌曲</p>
                </div>
                <button class="ghost-btn" id="rename-playlist-btn">重命名歌单</button>
                <button class="ghost-btn" id="delete-playlist-btn">删除歌单</button>
            </div>
            ${renderSongList(songs, 'playlist')}
        `;
        $('#back-playlists').addEventListener('click', () => {
            state.activePlaylistName = null;
            renderPlaylists();
        });
        $('#rename-playlist-btn').addEventListener('click', () => renamePlaylist(name));
        $('#delete-playlist-btn').addEventListener('click', () => deletePlaylist(name));
        bindSongActions(els.viewRoot);
        hydrateSongCardCovers(els.viewRoot);
    }

    function renderSongList(songs, context) {
        if (!songs.length) return emptyState('暂无歌曲', '可以从搜索或榜单添加歌曲。');
        return `
            <div class="song-list">
                ${songs.map((song, index) => renderSongCard(song, index, context)).join('')}
            </div>
        `;
    }

    function renderSongCard(song, index, context) {
        const isPlaying = state.currentSong && sameSong(state.currentSong, song);
        const cover = getCoverUrl(song, 120);
        const playlistButton = context === 'playlist'
            ? '<button class="icon-btn" data-action="remove-playlist" title="从歌单移除" aria-label="从歌单移除">−</button>'
            : '<button class="icon-btn" data-action="playlist" title="添加到歌单">≡</button>';
        return `
            <article class="song-card ${isPlaying ? 'playing' : ''}" data-song="${encodeSong(song)}" data-context="${escapeAttr(context)}">
                ${cover ? `<img class="song-cover" src="${escapeAttr(cover)}" alt="">` : `<div class="song-index">${index + 1}</div>`}
                <div>
                    <div class="song-title">${escapeHtml(song.name || '未知歌曲')}</div>
                    <div class="song-subtitle">${escapeHtml(formatArtists(song.artist))} · ${escapeHtml(song.album || song.source || '')}</div>
                </div>
                <div class="song-actions">
                    <button class="icon-btn play-icon-btn" data-action="play" title="播放" aria-label="播放"></button>
                    <button class="icon-btn" data-action="queue" title="加入队列">＋</button>
                    <button class="icon-btn" data-action="favorite" title="收藏">${isFavorite(song) ? '♥' : '♡'}</button>
                    ${playlistButton}
                </div>
            </article>
        `;
    }

    function hydrateSongCardCovers(scope) {
        resetSongCoverObserver();
        const observer = getSongCoverObserver();
        $$('.song-card', scope).forEach((card) => {
            const img = $('.song-cover', card);
            if (!img || img.dataset.coverHydrated === '1') return;

            const song = decodeSong(card.dataset.song);
            if (!song?.pic_id || song.cover_url || /^https?:\/\//.test(song.pic_id) || song.pic_id.startsWith('uploads/')) {
                img.dataset.coverHydrated = '1';
                return;
            }

            if (observer) observer.observe(card);
            else hydrateVisibleSongCardCover(card);
        });
    }

    function getSongCoverObserver() {
        if (!('IntersectionObserver' in window)) return null;
        if (songCoverObserver) return songCoverObserver;
        songCoverObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                songCoverObserver.unobserve(entry.target);
                hydrateVisibleSongCardCover(entry.target);
            });
        }, {
            root: els.viewRoot,
            rootMargin: '180px 0px',
            threshold: 0.01
        });
        return songCoverObserver;
    }

    function resetSongCoverObserver() {
        if (!songCoverObserver) return;
        songCoverObserver.disconnect();
        songCoverObserver = null;
    }

    function hydrateVisibleSongCardCover(card) {
        const img = $('.song-cover', card);
        if (!img || img.dataset.coverHydrated === '1') return;

        const song = decodeSong(card.dataset.song);
        if (!song?.pic_id || song.cover_url || /^https?:\/\//.test(song.pic_id) || song.pic_id.startsWith('uploads/')) {
            img.dataset.coverHydrated = '1';
            return;
        }

        img.dataset.coverHydrated = '1';
        resolveCachedCoverUrl(song, 120).then((coverUrl) => {
            if (!coverUrl || coverUrl === fallbackCover || !card.isConnected) return;
            const latestSong = decodeSong(card.dataset.song);
            if (!sameSong(latestSong, song)) return;

            latestSong.cover_url = coverUrl;
            card.dataset.song = encodeSong(latestSong);
            swapImageWhenLoaded(img, coverUrl);
        });
    }

    function swapImageWhenLoaded(img, src) {
        const probe = new Image();
        probe.onload = () => {
            if (img.isConnected) img.src = src;
        };
        probe.src = src;
    }

    async function resolveCachedCoverUrl(song, size = 300) {
        const key = coverCacheKey(song, size);
        if (coverCache.has(key)) return coverCache.get(key);
        if (coverInflight.has(key)) return coverInflight.get(key);

        const request = enqueueCoverResolve(() => resolveCoverUrl(song, size))
            .then((coverUrl) => {
                coverCacheSet(key, coverUrl);
                return coverUrl;
            })
            .finally(() => {
                coverInflight.delete(key);
            });
        coverInflight.set(key, request);
        return request;
    }

    function coverCacheKey(song, size) {
        return `${song.source || 'netease'}:${song.pic_id}:${size}`;
    }

    function enqueueCoverResolve(task) {
        return new Promise((resolve, reject) => {
            coverResolveQueue.push({ task, resolve, reject });
            pumpCoverResolveQueue();
        });
    }

    function pumpCoverResolveQueue() {
        while (activeCoverResolves < maxConcurrentCoverResolves && coverResolveQueue.length) {
            const item = coverResolveQueue.shift();
            activeCoverResolves += 1;
            Promise.resolve()
                .then(item.task)
                .then(item.resolve, item.reject)
                .finally(() => {
                    activeCoverResolves -= 1;
                    pumpCoverResolveQueue();
                });
        }
    }

    function bindSongActions(scope) {
        if (scope.dataset.songActionsBound === '1') return;
        scope.dataset.songActionsBound = '1';

        scope.addEventListener('dblclick', (event) => {
            const card = event.target.closest?.('.song-card');
            if (!card || !scope.contains(card)) return;
            const song = decodeSong(card.dataset.song);
            playSong(song, { list: songsForCard(card) });
        });

        scope.addEventListener('click', (event) => {
            const button = event.target.closest?.('[data-action]');
            if (!button || !scope.contains(button)) return;
            const card = button.closest('.song-card');
            if (!card || !scope.contains(card)) return;

            event.stopPropagation();
            const song = decodeSong(card.dataset.song);
            const action = button.dataset.action;
            if (action === 'play') playSong(song, { list: songsForCard(card) });
            if (action === 'queue') enqueue(song);
            if (action === 'favorite') toggleFavorite(song);
            if (action === 'playlist') openPlaylistDialog(song);
            if (action === 'remove-playlist') removeSongFromActivePlaylist(song);
        });
    }

    function songsForCard(card) {
        const list = card.closest('.song-list');
        const songs = list ? normalizeSongList($$('.song-card', list).map((item) => decodeSong(item.dataset.song))) : [];
        return songs.length ? songs : songsForContext(card.dataset.context);
    }

    function songsForContext(context) {
        if (context === 'search') return state.searchResults;
        if (context === 'favorites') return state.favorites;
        if (context === 'home') return state.homeSongs;
        if (context === 'recent') return state.recentPlays;
        if (context === 'weekly') return state.weeklyFavorites;
        if (context === 'playlist') return currentPlaylistSongs();
        return state.queue.length ? state.queue : [state.currentSong].filter(Boolean);
    }

    function currentPlaylistSongs() {
        if (state.view !== 'playlists') return [];
        const playlistName = state.activePlaylistName || $('.section-head h2', els.viewRoot)?.textContent;
        const playlist = state.playlists.find((item) => item.name === playlistName);
        return playlist ? playlist.songs : [];
    }

    async function searchSongs(keyword) {
        if (!keyword) {
            renderView('search');
            return;
        }
        state.view = 'search';
        state.isLoading = true;
        renderView('search');
        try {
            const params = {
                types: 'search',
                source: els.sourceSelect.value,
                name: keyword,
                count: 30
            };
            const data = await apiGet('api.php', params);
            state.searchResults = normalizeSongList(Array.isArray(data) ? data : data.data || []);
        } catch (error) {
            showToast(error.message || '搜索失败', 'error');
            state.searchResults = [];
        } finally {
            state.isLoading = false;
            renderView('search');
        }
    }

    async function loadToplist(type, silent = false) {
        if (!silent) showToast('正在加载榜单...');
        try {
            const data = await apiGet('php/toplist.php', { type });
            state.homeSongs = normalizeSongList(data.data || []);
            if (state.view === 'home') renderHome();
        } catch (error) {
            if (!silent) showToast(error.message || '榜单加载失败', 'error');
        }
    }

    function ensureHomeHistoryLoaded() {
        if (!state.currentUser || state.historyLoading) return;
        if (state.historyLoadedForUser === String(state.currentUser.id)) return;
        loadUserHistory({ silent: true });
    }

    async function loadUserHistory({ force = false, silent = false } = {}) {
        if (!state.currentUser || state.historyLoading) return;
        const userId = String(state.currentUser.id);
        if (!force && state.historyLoadedForUser === userId) return;

        state.historyLoading = true;
        if (state.view === 'home' && !silent) renderHome();

        try {
            const [recent, top] = await Promise.all([
                apiPost('php/play_history.php', {
                    action: 'recent',
                    user_id: userId,
                    limit: 8
                }),
                apiPost('php/play_history.php', {
                    action: 'top',
                    user_id: userId,
                    days: 7,
                    limit: 8
                })
            ]);
            state.recentPlays = normalizeSongList(recent.history || []);
            state.weeklyFavorites = normalizeSongList(top.songs || []);
            state.historyLoadedForUser = userId;
        } catch (error) {
            state.historyLoadedForUser = userId;
            if (!silent) showToast(error.message || '播放历史加载失败', 'error');
        } finally {
            state.historyLoading = false;
            if (state.view === 'home') renderHome();
        }
    }

    async function playSong(song, options = {}) {
        if (!song || !song.id) return;
        if (guardPlaybackForRuntime()) return;
        const playRequestId = state.playRequestId + 1;
        state.playRequestId = playRequestId;
        state.playbackWatchdogRetries = 0;
        state.endedRecoveryRetries = 0;
        const previousSong = state.currentSong;
        const list = normalizeSongList(options.list || []);
        if (list.length) {
            state.queue = uniqueSongs(list);
            state.currentIndex = Math.max(0, state.queue.findIndex((item) => sameSong(item, song)));
        } else if (!state.queue.some((item) => sameSong(item, song))) {
            state.queue.push(song);
            state.currentIndex = state.queue.length - 1;
        } else {
            state.currentIndex = state.queue.findIndex((item) => sameSong(item, song));
        }
        state.currentSong = normalizeSong(song);
        state.qualityRetryLevel = 0;
        state.currentQuality = normalizeRequestedQuality(els.qualitySelect.value);
        state.lyrics = [];
        state.activeLyricIndex = -1;
        setPlayerStatus('正在解析音源');
        saveQueue();
        renderShell();
        renderLyrics();
        updatePlayingSongCards(previousSong, state.currentSong);

        try {
            let metadata = beginPlaybackMetadataLoad(state.currentSong);
            let urlData;
            try {
                urlData = await getAudioUrlForPlayback(state.currentSong, state.currentQuality, {
                    silentFallbackToast: Boolean(options.autoAdvance)
                });
            } catch (error) {
                if (!isCurrentPlayRequest(playRequestId)) return;
                const fallbackSong = await resolvePlaybackFallbackSong(state.currentSong);
                if (!isCurrentPlayRequest(playRequestId)) return;
                if (!fallbackSong) throw error;

                setPlayerStatus('正在换源');
                showToast(`当前音乐源不可用，已切换到酷我：${fallbackSong.name}`);
                const originalSong = state.currentSong;
                const beforeFallbackSong = state.currentSong;
                state.currentSong = {
                    ...fallbackSong,
                    original_title: originalSong.original_title || originalSong.name,
                    original_artist: originalSong.original_artist || formatArtists(originalSong.artist)
                };
                if (state.currentIndex >= 0) state.queue[state.currentIndex] = state.currentSong;
                saveQueue();
                renderShell();
                updatePlayingSongCards(beforeFallbackSong, state.currentSong);

                metadata = beginPlaybackMetadataLoad(state.currentSong);
                urlData = await getAudioUrlForPlayback(state.currentSong, '320', {
                    silentFallbackToast: Boolean(options.autoAdvance)
                });
            }
            if (!isCurrentPlayRequest(playRequestId)) return;
            const url = urlData.url || urlData.data?.url;
            if (!url) throw new Error('没有可用播放地址');
            state.currentQuality = String(urlData.br || state.currentQuality);
            updateQualityBadge(urlData);
            setPlayerStatus('正在连接播放器');
            audio.preload = 'auto';
            audio.src = url;
            rememberPlayableUrl(url);
            audio.load();
            await playAudioWithRuntimeGuard({
                notAllowedMessage: musiqRuntime.isIOS
                    ? 'iPhone Safari 需要再次点按播放按钮开始播放'
                    : '浏览器阻止了自动播放，请再次点按播放按钮',
                genericMessage: '播放失败'
            });
            if (!isCurrentPlayRequest(playRequestId)) {
                audio.pause();
                return;
            }
            updateMediaSessionMetadata({ afterPlaybackStart: true });
            startPlaybackWatchdog({
                reason: options.autoAdvance ? 'auto-advance' : 'play-song',
                song: state.currentSong,
                startedAt: 0
            });
            scheduleNextAudioPrefetch({ immediate: musiqRuntime.isIOS });
            recordSuccessfulPlay(state.currentSong);
            applyPlaybackMetadataWhenReady(playRequestId, state.currentSong, metadata);
        } catch (error) {
            if (!isCurrentPlayRequest(playRequestId)) return;
            const message = error?.userMessage || error.message || '播放失败';
            if (error?.name === 'NotAllowedError') {
                setPlayerStatus('点按播放继续');
                showToast(message, 'error');
                return;
            }
            setPlayerStatus('播放失败');
            updateMediaSessionPlaybackState();
            notifyAndroidPlayback('stopped');
            showToast(message, 'error');
        }
    }

    function isCurrentPlayRequest(playRequestId) {
        return Number(playRequestId) === state.playRequestId;
    }

    function beginPlaybackMetadataLoad(song) {
        const target = normalizeSong(song);
        return {
            song: target,
            cover: resolveCoverUrl(target).catch(() => target.cover_url || ''),
            lyric: apiGet('api.php', {
                types: 'lyric',
                source: target.source || 'netease',
                id: target.lyric_id || target.id,
                name: target.name || '',
                artist: formatArtists(target.artist),
                album: target.album || ''
            }).catch(() => ({ lyric: '' }))
        };
    }

    function applyPlaybackMetadataWhenReady(playRequestId, song, metadata) {
        Promise.all([metadata.cover, metadata.lyric]).then(([coverUrl, lyricData]) => {
            if (playRequestId !== state.playRequestId || !sameSong(state.currentSong, song)) return;
            if (coverUrl) {
                state.currentSong.cover_url = coverUrl;
                const queueSong = state.queue[state.currentIndex];
                if (queueSong && sameSong(queueSong, state.currentSong)) queueSong.cover_url = coverUrl;
                renderShell();
                updateRenderedSongCardCover(state.currentSong, coverUrl);
            }
            state.lyrics = parseLyrics(lyricData.lyric || lyricData.lrc?.lyric || '');
            renderLyrics();
        }).catch(() => {
            // Metadata is non-critical; playback has already started.
        });
    }

    function recordSuccessfulPlay(song) {
        if (!state.currentUser || !song?.id) return;
        apiPost('php/play_history.php', {
            action: 'record',
            user_id: state.currentUser.id,
            ...songPayload(song)
        }).then(() => {
            state.historyLoadedForUser = '';
            loadUserHistory({ silent: true });
        }).catch((error) => {
            console.warn('[play-history] record failed:', error.message || error);
        });
    }

    function updatePlayingSongCards(previousSong, currentSong) {
        const cards = new Set([
            ...findRenderedSongCards(previousSong),
            ...findRenderedSongCards(currentSong),
            ...$$('.song-card.playing', els.viewRoot)
        ]);
        cards.forEach((card) => {
            const cardSong = decodeSong(card.dataset.song);
            card.classList.toggle('playing', Boolean(currentSong && sameSong(cardSong, currentSong)));
        });
    }

    function updateRenderedSongCardCover(song, coverUrl) {
        if (!song || !coverUrl || coverUrl === fallbackCover) return;
        findRenderedSongCards(song).forEach((card) => {
            const cardSong = decodeSong(card.dataset.song);
            if (!cardSong) return;
            cardSong.cover_url = coverUrl;
            card.dataset.song = encodeSong(cardSong);
            const img = $('.song-cover', card);
            if (img) {
                img.dataset.coverHydrated = '1';
                swapImageWhenLoaded(img, coverUrl);
            }
        });
    }

    function findRenderedSongCards(song) {
        if (!song) return [];
        return $$('.song-card', els.viewRoot).filter((card) => sameSong(decodeSong(card.dataset.song), song));
    }

    function togglePlay() {
        if (guardPlaybackForRuntime()) return;
        if (!state.currentSong) {
            const first = state.queue[0] || state.homeSongs[0] || state.searchResults[0];
            if (first) playSong(first, { list: state.queue.length ? state.queue : state.homeSongs });
            return;
        }
        if (audio.paused) {
            resumeCurrentPlayback().catch((error) => {
                if (error?.name === 'RuntimePlaybackBlocked') return;
                setPlayerStatus(error?.name === 'NotAllowedError' ? '点按播放继续' : '播放失败');
                showToast(error?.name === 'NotAllowedError' ? '请点按播放按钮开始播放' : '播放失败', 'error');
            });
        } else {
            pausePlaybackIntentionally();
        }
    }

    function pausePlaybackIntentionally() {
        stopPlaybackIntent();
        audio.pause();
    }

    function stopPlaybackIntent() {
        state.playbackIntent = false;
        clearTimeout(state.lifecycleRecoveryTimer);
        state.lifecycleRecoveryTimer = 0;
        state.lifecycleRecoveryToken += 1;
    }

    function notifyAndroidPlayback(playbackState) {
        const bridge = window.MusicAndroid;
        if (!bridge || typeof bridge.updatePlayback !== 'function') return;
        const song = state.currentSong || {};
        try {
            bridge.updatePlayback(
                playbackState,
                String(song.name || 'music'),
                String(formatArtists(song.artist) || song.artist || '正在播放')
            );
        } catch {}
    }

    function handleAndroidMediaCommand(command) {
        if (command === 'play') {
            if (audio.paused) togglePlay();
            return;
        }
        if (command === 'pause') {
            if (!audio.paused) pausePlaybackIntentionally();
            return;
        }
        if (command === 'next') {
            playNext({ fromMediaSession: true });
            return;
        }
        if (command === 'previous') {
            playPrevious();
            return;
        }
        if (command === 'stop') {
            pausePlaybackIntentionally();
            audio.removeAttribute('src');
            audio.load();
            setPlayerStatus('准备就绪');
            updatePlayButtons();
            clearOrDegradeMediaSession('android-stop');
            notifyAndroidPlayback('stopped');
            renderPwaDiagnostics();
        }
    }

    window.musicAndroidHandleCommand = handleAndroidMediaCommand;

    async function resumeCurrentPlayback({ fromMediaSession = false } = {}) {
        if (guardPlaybackForRuntime()) {
            const error = new Error('Playback is blocked in iOS in-app browsers');
            error.name = 'RuntimePlaybackBlocked';
            throw error;
        }
        if (!state.currentSong) return;
        if (state.mediaSessionResumeInFlight) return;
        state.playbackIntent = true;
        state.mediaSessionResumeInFlight = true;
        const resumeAt = rememberPlaybackSnapshot();

        try {
            setupMediaSessionHandlers();
            if (!audio.src && state.lastPlayableUrl) {
                audio.src = state.lastPlayableUrl;
                audio.load();
                restoreAudioPositionWhenReady(resumeAt);
            }

            if (!audio.src || audio.networkState === HTMLMediaElement.NETWORK_EMPTY || audio.error) {
                await refreshCurrentPlaybackStream({ resumeAt, reason: 'empty-media-element' });
            } else {
                restoreAudioPositionWhenReady(resumeAt);
                await playAudioWithRuntimeGuard();
                updateMediaSessionMetadata({ afterPlaybackStart: true });
            }

            if (fromMediaSession) watchMediaSessionResume(resumeAt);
        } catch (error) {
            if (error?.name === 'NotAllowedError' || error?.name === 'RuntimePlaybackBlocked') throw error;
            await refreshCurrentPlaybackStream({ resumeAt, reason: 'resume-play-failed' });
            if (fromMediaSession) watchMediaSessionResume(resumeAt);
        } finally {
            state.mediaSessionResumeInFlight = false;
        }
    }

    async function refreshCurrentPlaybackStream({ resumeAt = 0, reason = '' } = {}) {
        if (!state.currentSong) return;
        const playRequestId = state.playRequestId;
        const targetSong = normalizeSong(state.currentSong);
        const requested = normalizeRequestedQuality(state.currentQuality || els.qualitySelect.value);
        setPlayerStatus(['silent-resume-watchdog', 'auto-advance-silent', 'premature-ended'].includes(reason) ? '正在恢复声音' : '正在恢复播放');
        const data = await getAudioUrlForPlayback(state.currentSong, requested, {
            forceRefresh: reason === 'auto-advance-silent' || reason === 'silent-resume-watchdog' || reason === 'premature-ended',
            silentFallbackToast: true
        });
        if (!isCurrentPlayRequest(playRequestId) || !sameSong(state.currentSong, targetSong)) return;
        const url = data.url || data.data?.url;
        if (!url) throw new Error('没有可用播放地址');
        state.currentQuality = String(data.br || requested);
        updateQualityBadge(data);
        audio.preload = 'auto';
        audio.src = url;
        rememberPlayableUrl(url);
        audio.load();
        restoreAudioPositionWhenReady(resumeAt);
        await playAudioWithRuntimeGuard();
        if (!isCurrentPlayRequest(playRequestId) || !sameSong(state.currentSong, targetSong)) {
            audio.pause();
            return;
        }
        updateMediaSessionMetadata({ afterPlaybackStart: true });
        if (reason === 'auto-advance-silent' || reason === 'silent-resume-watchdog' || reason === 'premature-ended') {
            startPlaybackWatchdog({
                reason,
                song: state.currentSong,
                startedAt: Number.isFinite(audio.currentTime) ? audio.currentTime : 0
            });
        }
    }

    function watchMediaSessionResume(previousTime) {
        clearTimeout(state.resumeWatchdogTimer);
        if (!musiqRuntime.isIOS || !state.currentSong) return;
        const startedAt = Number.isFinite(previousTime) ? previousTime : audio.currentTime || 0;
        state.resumeWatchdogTimer = setTimeout(() => {
            if (!state.currentSong || audio.paused) return;
            const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
            const advanced = currentTime > startedAt + 0.3;
            if (advanced && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
            refreshCurrentPlaybackStream({
                resumeAt: currentTime || startedAt,
                reason: 'silent-resume-watchdog'
            }).catch(() => {
                setPlayerStatus('点按播放继续');
                showToast('后台恢复播放失败，请回到 music 内再点一次播放', 'error');
            });
        }, 1800);
    }

    function scheduleLifecyclePlaybackRecovery(reason = '') {
        clearTimeout(state.lifecycleRecoveryTimer);
        state.lifecycleRecoveryTimer = 0;
        const token = state.lifecycleRecoveryToken + 1;
        state.lifecycleRecoveryToken = token;

        if (!musiqRuntime.isIOS || !state.playbackIntent || !state.currentSong) return;
        if (!(audio.src || state.lastPlayableUrl)) return;

        const expectsHidden = reason === 'hidden';
        const delay = expectsHidden ? 900 : 180;
        state.lifecycleRecoveryTimer = setTimeout(() => {
            state.lifecycleRecoveryTimer = 0;
            if (token !== state.lifecycleRecoveryToken) return;
            if (!state.playbackIntent || !state.currentSong) return;
            if (expectsHidden !== document.hidden) return;

            const resumeAt = Math.max(
                Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
                Number(state.lastLifecycleHiddenTime || state.lastKnownPlaybackTime || 0)
            );
            if (!audio.paused && !audio.error && audio.networkState !== HTMLMediaElement.NETWORK_EMPTY) {
                if (!expectsHidden) watchMediaSessionResume(resumeAt);
                updateMediaSessionPlaybackState();
                return;
            }

            resumeCurrentPlayback({ fromMediaSession: true }).catch((error) => {
                updateMediaSessionPlaybackState();
                if (!document.hidden && error?.name === 'NotAllowedError') {
                    setPlayerStatus('点按播放继续');
                    showToast('iPhone 已暂停后台音频，请点按播放继续', 'error');
                }
            });
        }, delay);
    }

    function startPlaybackWatchdog({ reason = '', song = state.currentSong, startedAt = 0 } = {}) {
        clearTimeout(state.playbackWatchdogTimer);
        const shouldWatch = reason === 'auto-advance'
            || reason === 'auto-advance-silent'
            || reason === 'silent-resume-watchdog'
            || reason === 'premature-ended'
            || (musiqRuntime.isIOS && !musiqRuntime.isStandalonePwa)
            || document.hidden;
        if (!shouldWatch || !song) return;

        const token = state.playbackWatchdogToken + 1;
        state.playbackWatchdogToken = token;
        const targetSong = normalizeSong(song);
        const startTime = Number.isFinite(startedAt) ? startedAt : 0;

        state.playbackWatchdogTimer = setTimeout(() => {
            if (token !== state.playbackWatchdogToken) return;
            if (!state.currentSong || !sameSong(state.currentSong, targetSong)) return;
            if (audio.paused) return;

            const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
            const advanced = currentTime > startTime + 0.3;
            if (advanced && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                state.playbackWatchdogRetries = 0;
                return;
            }

            if (state.playbackWatchdogRetries >= 1) {
                audio.pause();
                setPlayerStatus('点按播放继续');
                updatePlayButtons();
                updateMediaSessionPlaybackState();
                showToast('自动切到下一首时没有恢复声音，请点按播放继续', 'error');
                renderPwaDiagnostics();
                return;
            }

            state.playbackWatchdogRetries += 1;
            refreshCurrentPlaybackStream({
                resumeAt: currentTime > 0 ? currentTime : 0,
                reason: 'auto-advance-silent'
            }).catch(() => {
                audio.pause();
                setPlayerStatus('点按播放继续');
                updatePlayButtons();
                updateMediaSessionPlaybackState();
                showToast('自动切歌恢复失败，请回到 music 内再点一次播放', 'error');
                renderPwaDiagnostics();
            });
        }, reason === 'auto-advance' ? 2400 : 1800);
    }

    function restoreAudioPositionWhenReady(seconds) {
        const target = Number(seconds);
        if (!Number.isFinite(target) || target <= 0) return;
        const expectedSrc = audio.currentSrc || audio.src || '';
        const apply = () => {
            if (expectedSrc && (audio.currentSrc || audio.src || '') !== expectedSrc) return;
            try {
                if (Number.isFinite(audio.duration) && audio.duration > 0) {
                    audio.currentTime = Math.min(target, Math.max(0, audio.duration - 0.5));
                } else {
                    audio.currentTime = target;
                }
            } catch {}
        };
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
            apply();
            return;
        }
        audio.addEventListener('loadedmetadata', apply, { once: true });
    }

    function rememberPlayableUrl(url) {
        if (url) state.lastPlayableUrl = url;
    }

    function isCurrentOfflineLosslessStream() {
        const src = audio.currentSrc || audio.src || state.lastPlayableUrl || '';
        if (!src) return false;
        try {
            const url = new URL(src, window.location.href);
            return url.origin === window.location.origin
                && url.pathname.startsWith('/offline/audio/')
                && url.pathname.endsWith('/alac.m4a');
        } catch {
            return false;
        }
    }

    function rememberPlaybackSnapshot() {
        const src = audio.currentSrc || audio.src || '';
        if (src) state.lastPlayableUrl = src;
        if (Number.isFinite(audio.currentTime)) state.lastKnownPlaybackTime = audio.currentTime;
        return state.lastKnownPlaybackTime;
    }

    function resetPlaybackSnapshot() {
        state.lastPlayableUrl = '';
        state.lastKnownPlaybackTime = 0;
        clearTimeout(state.resumeWatchdogTimer);
        clearTimeout(state.playbackWatchdogTimer);
        clearTimeout(state.nextPrefetchTimer);
        stopPlaybackIntent();
        state.resumeWatchdogTimer = 0;
        state.playbackWatchdogTimer = 0;
        state.nextPrefetchTimer = 0;
        state.playbackWatchdogRetries = 0;
        state.endedRecoveryRetries = 0;
    }

    function playPrevious() {
        if (guardPlaybackForRuntime()) return;
        if (!state.queue.length) return;
        if (state.playMode === 'random') state.currentIndex = Math.floor(Math.random() * state.queue.length);
        else state.currentIndex = Math.max(0, state.currentIndex - 1);
        playSong(state.queue[state.currentIndex], { list: state.queue });
    }

    function playNext(options = {}) {
        if (guardPlaybackForRuntime()) return;
        if (!state.queue.length) return;
        if (state.playMode === 'random') {
            state.currentIndex = Math.floor(Math.random() * state.queue.length);
        } else {
            state.currentIndex = state.currentIndex + 1;
            if (state.currentIndex >= state.queue.length) state.currentIndex = 0;
        }
        playSong(state.queue[state.currentIndex], {
            list: state.queue,
            autoAdvance: Boolean(options.autoAdvance),
            fromMediaSession: Boolean(options.fromMediaSession)
        });
    }

    function handleEnded() {
        if (shouldRecoverFromPrematureEnded()) {
            recoverFromPrematureEnded();
            return;
        }
        state.endedRecoveryRetries = 0;
        if (state.playMode === 'single') {
            if (guardPlaybackForRuntime()) return;
            audio.currentTime = 0;
            playAudioWithRuntimeGuard().catch(() => {});
            return;
        }
        if (state.queue.length > 1 || state.playMode === 'loop' || state.playMode === 'random') {
            playNext({ autoAdvance: true });
        } else {
            stopPlaybackIntent();
            clearOrDegradeMediaSession('ended');
            notifyAndroidPlayback('stopped');
        }
    }

    function shouldRecoverFromPrematureEnded() {
        if (!state.currentSong || audio.error) return false;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (duration <= 20) return false;
        const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        const lastKnown = Number.isFinite(state.lastKnownPlaybackTime) ? state.lastKnownPlaybackTime : 0;
        const observed = lastKnown > 0 ? Math.min(current || lastKnown, lastKnown) : current;
        const remaining = duration - observed;
        const tolerance = Math.max(3, Math.min(8, duration * 0.02));
        return remaining > tolerance;
    }

    function recoverFromPrematureEnded() {
        state.endedRecoveryRetries += 1;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        const lastKnown = Number.isFinite(state.lastKnownPlaybackTime) ? state.lastKnownPlaybackTime : 0;
        const resumeAt = Math.max(0, Math.min(lastKnown || current || 0, duration > 0 ? duration - 1 : Number.MAX_SAFE_INTEGER));

        if (state.endedRecoveryRetries > 2) {
            audio.pause();
            setPlayerStatus('点按播放继续');
            updatePlayButtons();
            updateMediaSessionPlaybackState();
            updateMediaSessionPositionState({ force: true });
            showToast('音频还没结束但 iPhone 提前停止了播放，请点按继续', 'error');
            renderPwaDiagnostics();
            return;
        }

        setPlayerStatus('正在恢复声音');
        showToast('检测到 iPhone 提前停止音频，正在从当前位置恢复');
        refreshCurrentPlaybackStream({
            resumeAt,
            reason: 'premature-ended'
        }).catch(() => {
            audio.pause();
            setPlayerStatus('点按播放继续');
            updatePlayButtons();
            updateMediaSessionPlaybackState();
            updateMediaSessionPositionState({ force: true });
            showToast('恢复播放失败，请回到 music 内再点一次播放', 'error');
            renderPwaDiagnostics();
        });
    }

    function handleBuffering() {
        if (!state.currentSong || audio.paused) return;
        setPlayerStatus('正在缓冲');
        updateMediaSessionPlaybackState();
        updateMediaSessionPositionState({ force: true });
        const now = Date.now();
        if (now - state.lastBufferingToastAt > 6000) {
            showToast('正在缓冲当前音乐源...');
            state.lastBufferingToastAt = now;
        }
        clearTimeout(state.stallTimer);
        const stallTimeout = musiqRuntime.isIOS && isCurrentOfflineLosslessStream() ? 16_000 : 6500;
        state.stallTimer = setTimeout(() => {
            recoverHighQualityStream();
        }, stallTimeout);
    }

    function clearBuffering() {
        clearTimeout(state.stallTimer);
        state.stallTimer = 0;
        if (state.currentSong) {
            setPlayerStatus(audio.paused ? '已暂停' : '正在播放');
            updateMediaSessionPlaybackState();
        }
    }

    async function recoverHighQualityStream() {
        if (guardPlaybackForRuntime()) return;
        if (!state.currentSong || audio.paused) return;
        const requested = normalizeRequestedQuality(state.currentQuality || els.qualitySelect.value);
        const keepIosLosslessFirst = musiqRuntime.isIOS && isCurrentOfflineLosslessStream() && state.qualityRetryLevel === 0;
        const retryQuality = requested === '999' && state.qualityRetryLevel === 0 && !keepIosLosslessFirst ? '320' : requested;
        state.qualityRetryLevel += 1;
        const resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        setPlayerStatus(keepIosLosslessFirst ? '正在恢复无损' : (retryQuality === '320' && requested === '999' ? '已切换 HQ' : '正在刷新音源'));
        showToast(keepIosLosslessFirst
            ? '正在重新连接 iPhone 无损音频'
            : (retryQuality === '320' && requested === '999'
            ? 'SQ 源不稳定，已切换到极高 HQ 继续播放'
            : '正在刷新高音质播放直链'));

        try {
            const data = await apiGet('api.php', {
                types: 'url',
                source: state.currentSong.source || 'netease',
                id: state.currentSong.url_id || state.currentSong.id,
                br: retryQuality,
                name: state.currentSong.name || '',
                artist: formatArtists(state.currentSong.artist),
                album: state.currentSong.album || '',
                duration: Number(state.currentSong.duration || 0)
            });
            const url = data.url || data.data?.url;
            if (!url) return;
            if (Number(data.br || retryQuality) < 320) {
                showToast('当前音乐源没有 HQ/SQ 音质，请换源或换版本', 'error');
                return;
            }
            state.currentQuality = String(data.br || retryQuality);
            updateQualityBadge(data);
            audio.src = url;
            rememberPlayableUrl(url);
            audio.load();
            const expectedSrc = audio.src || url;
            audio.addEventListener('loadedmetadata', () => {
                if ((audio.currentSrc || audio.src || '') !== expectedSrc) return;
                if (resumeAt > 0 && Number.isFinite(audio.duration)) {
                    audio.currentTime = Math.min(resumeAt, Math.max(0, audio.duration - 0.5));
                }
                updateMediaSessionPositionState({ force: true });
                playAudioWithRuntimeGuard({ genericMessage: '高音质重试播放失败' })
                    .catch(() => showToast('高音质重试播放失败', 'error'));
            }, { once: true });
        } catch {
            showToast('高音质重试失败，请手动切换到 HQ 或换源', 'error');
        }
    }

    async function getAudioUrlForPlayback(song, quality, options = {}) {
        const requested = normalizeRequestedQuality(quality);
        const cached = options.forceRefresh ? null : getCachedAudioUrl(song, requested);
        if (cached) return cached;
        const data = await fetchPreferredAudioUrl(song, requested, options);
        setCachedAudioUrl(song, requested, data);
        return data;
    }

    async function fetchPreferredAudioUrl(song, quality, options = {}) {
        const requested = normalizeRequestedQuality(quality);
        try {
            const data = await fetchAudioUrl(song, requested);
            if ((data.url || data.data?.url) && Number(data.br || requested) >= 320) return data;
        } catch (error) {
            if (requested !== '999') throw error;
        }

        if (requested === '999') {
            if (!options.silentFallbackToast) showToast('SQ 源不可用，已切换到极高 HQ');
            const data = await fetchAudioUrl(song, '320');
            if (Number(data.br || 0) < 320) throw new Error('当前音乐源没有 HQ/SQ 音质');
            if (!options.skipQualityStateUpdate) state.currentQuality = String(data.br || '320');
            return data;
        }

        throw new Error('没有可用播放地址');
    }

    function fetchAudioUrl(song, quality) {
        return apiGet('api.php', {
            types: 'url',
            source: song.source || 'netease',
            id: song.url_id || song.id,
            br: quality,
            name: song.name || '',
            artist: formatArtists(song.artist),
            album: song.album || '',
            duration: Number(song.duration || 0)
        });
    }

    function getCachedAudioUrl(song, quality) {
        const key = audioUrlCacheKey(song, quality);
        const hit = audioUrlCache.get(key);
        if (!hit) return null;
        if (Date.now() - hit.createdAt > AUDIO_URL_CACHE_TTL_MS) {
            audioUrlCache.delete(key);
            return null;
        }
        audioUrlCache.delete(key);
        audioUrlCache.set(key, hit);
        return hit.data;
    }

    function setCachedAudioUrl(song, quality, data) {
        const url = data?.url || data?.data?.url;
        if (!url) return;
        const key = audioUrlCacheKey(song, quality);
        audioUrlCache.set(key, { data, createdAt: Date.now() });
        const resolvedQuality = normalizeRequestedQuality(data.br || quality);
        const resolvedKey = audioUrlCacheKey(song, resolvedQuality);
        if (resolvedKey !== key) audioUrlCache.set(resolvedKey, { data, createdAt: Date.now() });
        while (audioUrlCache.size > AUDIO_URL_CACHE_MAX) {
            audioUrlCache.delete(audioUrlCache.keys().next().value);
        }
    }

    function audioUrlCacheKey(song, quality) {
        const target = normalizeSong(song || {});
        return [
            target.source || 'netease',
            target.url_id || target.id,
            normalizeRequestedQuality(quality),
            target.name || '',
            formatArtists(target.artist),
            target.album || ''
        ].join('|');
    }

    function scheduleNextAudioPrefetch({ immediate = false } = {}) {
        clearTimeout(state.nextPrefetchTimer);
        const nextSong = predictedNextSong();
        if (!nextSong) return;
        const quality = normalizeRequestedQuality(state.currentQuality || els.qualitySelect.value);
        state.nextPrefetchTimer = setTimeout(() => {
            getAudioUrlForPlayback(nextSong, quality, {
                silentFallbackToast: true,
                skipQualityStateUpdate: true
            })
                .then((data) => prewarmNextAudioForBackgroundPlayback(data))
                .catch(() => {
                    // Prefetch is opportunistic; normal playback still resolves the URL.
                });
        }, immediate || musiqRuntime.isIOS ? 0 : 1200);
    }

    async function prewarmNextAudioForBackgroundPlayback(data) {
        const url = data?.url || data?.data?.url;
        if (!url || !musiqRuntime.isIOS) return;

        let target;
        try {
            target = new URL(url, window.location.href);
        } catch {
            return;
        }
        if (target.origin !== window.location.origin || !target.pathname.startsWith('/offline/audio/')) return;

        state.nextAudioPrewarmUrl = target.pathname;
        state.nextAudioPrewarmStatus = 'pending';
        renderPwaDiagnostics();

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
            const response = await fetch(target.href, {
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { Range: 'bytes=0-65535' },
                signal: controller.signal
            });
            state.nextAudioPrewarmStatus = response.status === 206 || response.ok
                ? `ok:${response.status}`
                : `http:${response.status}`;
        } catch (error) {
            state.nextAudioPrewarmStatus = error?.name === 'AbortError' ? 'timeout' : 'failed';
        } finally {
            clearTimeout(timeout);
            renderPwaDiagnostics();
        }
    }

    function predictedNextSong() {
        if (!state.queue.length || state.currentIndex < 0) return null;
        if (state.playMode === 'random') return null;
        if (state.queue.length < 2 && state.playMode !== 'loop') return null;
        let nextIndex = state.currentIndex + 1;
        if (nextIndex >= state.queue.length) nextIndex = 0;
        const nextSong = state.queue[nextIndex];
        if (!nextSong || sameSong(nextSong, state.currentSong)) return null;
        return nextSong;
    }

    async function resolvePlaybackFallbackSong(song) {
        if (!song || (song.source || 'netease') === 'kuwo') return null;
        const keyword = [song.original_title || song.name, firstArtist(song)].filter(Boolean).join(' ');
        if (!keyword.trim()) return null;

        try {
            const data = await apiGet('api.php', {
                types: 'search',
                source: 'kuwo',
                name: keyword,
                count: 8
            });
            const candidates = normalizeSongList(Array.isArray(data) ? data : data.data || []);
            return chooseBestFallbackSong(candidates, song);
        } catch {
            return null;
        }
    }

    function chooseBestFallbackSong(candidates, originalSong) {
        if (!Array.isArray(candidates) || !candidates.length) return null;
        const targetTitle = normalizeSearchText(originalSong.original_title || originalSong.name);
        const targetArtists = artistList(originalSong.artist).map(normalizeSearchText).filter(Boolean);

        return candidates.find((candidate) => {
            const candidateTitle = normalizeSearchText(candidate.name);
            const candidateArtists = artistList(candidate.artist).map(normalizeSearchText);
            const titleMatches = candidateTitle === targetTitle || candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle);
            const artistMatches = !targetArtists.length || targetArtists.some((artist) =>
                candidateArtists.some((candidateArtist) => candidateArtist.includes(artist) || artist.includes(candidateArtist))
            );
            return titleMatches && artistMatches;
        }) || candidates[0];
    }

    function firstArtist(song) {
        return artistList(song.artist)[0] || '';
    }

    function artistList(artist) {
        if (Array.isArray(artist)) return artist.map((item) => String(item || '').trim()).filter(Boolean);
        return String(artist || '').split(/[\/,，、&＆]+/).map((item) => item.trim()).filter(Boolean);
    }

    function normalizeSearchText(value) {
        return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[·・,，/／&＆()（）\[\]【】《》<>「」『』-]/g, '');
    }

    function cyclePlayMode() {
        const order = ['order', 'loop', 'single', 'random'];
        state.playMode = order[(order.indexOf(state.playMode) + 1) % order.length];
        const labels = { order: '顺序', loop: '循环', single: '单曲', random: '随机' };
        els.mode.textContent = labels[state.playMode];
        showToast(`播放模式：${labels[state.playMode]}`);
    }

    function enqueue(song) {
        if (!song) return;
        if (!state.queue.some((item) => sameSong(item, song))) {
            state.queue.push(normalizeSong(song));
            saveQueue();
            renderQueue();
        }
        showToast('已加入播放队列', 'success');
    }

    function clearQueue() {
        state.queue = state.currentSong ? [state.currentSong] : [];
        state.currentIndex = state.currentSong ? 0 : -1;
        saveQueue();
        renderQueue();
    }

    function clearPlaybackQueueForDiagnostics() {
        pausePlaybackIntentionally();
        audio.removeAttribute('src');
        audio.load();
        resetPlaybackSnapshot();
        state.queue = [];
        state.currentSong = null;
        state.currentIndex = -1;
        state.lyrics = [];
        setPlayerStatus('准备就绪');
        clearOrDegradeMediaSession('queue-cleared');
        saveQueue();
        renderShell();
        renderView(state.view);
        renderPwaDiagnostics();
        showToast('已清理播放器队列', 'success');
    }

    function renderQueue() {
        els.queueList.innerHTML = state.queue.map((song, index) => `
            <div class="queue-song ${state.currentSong && sameSong(state.currentSong, song) ? 'active' : ''}" data-index="${index}">
                <span class="queue-song-number">${index + 1}</span>
                <div>
                    <div class="song-title">${escapeHtml(song.name || '未知歌曲')}</div>
                    <div class="song-subtitle">${escapeHtml(formatArtists(song.artist))}</div>
                </div>
                <button class="queue-remove-btn" data-action="remove-queue" title="从播放队列移除">×</button>
            </div>
        `).join('') || `<div class="empty-state">播放队列为空</div>`;
    }

    function bindQueueActions() {
        if (els.queueList.dataset.queueActionsBound === '1') return;
        els.queueList.dataset.queueActionsBound = '1';
        els.queueList.addEventListener('click', (event) => {
            const removeButton = event.target.closest?.('[data-action="remove-queue"]');
            if (removeButton && els.queueList.contains(removeButton)) {
                event.stopPropagation();
                const item = removeButton.closest('.queue-song');
                removeQueueSong(Number(item?.dataset.index));
                return;
            }

            const item = event.target.closest?.('.queue-song');
            if (!item || !els.queueList.contains(item)) return;
            const index = Number(item.dataset.index);
            playSong(state.queue[index], { list: state.queue });
        });
    }

    function removeQueueSong(index) {
        if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) return;
        const removedCurrent = state.currentIndex === index;
        state.queue.splice(index, 1);

        if (!state.queue.length) {
            pausePlaybackIntentionally();
            audio.removeAttribute('src');
            audio.load();
            resetPlaybackSnapshot();
            state.currentSong = null;
            state.currentIndex = -1;
            setPlayerStatus('准备就绪');
            updateMediaSessionMetadata();
            saveQueue();
            renderShell();
            renderView(state.view);
            return;
        }

        if (removedCurrent) {
            const nextIndex = Math.min(index, state.queue.length - 1);
            playSong(state.queue[nextIndex], { list: state.queue });
            return;
        }

        if (index < state.currentIndex) state.currentIndex -= 1;
        saveQueue();
        renderQueue();
    }

    function renderPlayer() {
        const song = state.currentSong;
        const cover = song ? getCoverUrl(song, 300) : fallbackCover;
        const title = song?.name || '未选择歌曲';
        const artist = song ? formatArtists(song.artist) : '未知艺术家';
        [els.dockCover, els.sideCover, els.expandedCover].forEach((img) => {
            setPlayerCover(img, cover, song);
        });
        [els.dockTitle, els.sideTitle, els.expandedTitle].forEach((el) => {
            el.textContent = title;
        });
        [els.dockArtist, els.sideArtist, els.expandedArtist].forEach((el) => {
            el.textContent = artist;
        });
        [els.dockStatus, els.expandedStatus].forEach((el) => {
            if (el) el.textContent = state.playerStatus || '准备就绪';
        });
        els.favorite.textContent = song && isFavorite(song) ? '♥' : '♡';
        updateQualityBadge();
        updatePlayButtons();
        if (!(document.hidden && !audio.paused)) updateCoverTheme(cover);
        updateMediaSessionPlaybackState();
    }

    function setPlayerCover(img, cover, song) {
        if (!img) return;
        const target = normalizeCoverUrl(cover) || fallbackCover;
        img.onerror = () => {
            img.onerror = null;
            img.src = fallbackCover;
            if (song?.cover_url && normalizeCoverUrl(song.cover_url) === target) {
                song.cover_url = '';
                const queueSong = state.queue[state.currentIndex];
                if (queueSong && sameSong(queueSong, song)) queueSong.cover_url = '';
                updateMediaSessionMetadata({ afterPlaybackStart: !audio.paused });
            }
        };
        img.src = target;
    }

    function updatePlayButtons() {
        const playing = !audio.paused;
        [els.play, els.expandedPlay].forEach((button) => {
            if (!button) return;
            button.textContent = '';
            button.classList.toggle('is-playing', playing);
            button.title = playing ? '暂停' : '播放';
            button.setAttribute('aria-label', playing ? '暂停' : '播放');
        });
    }

    function updateProgress() {
        if (document.hidden && !audio.paused) return;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        if (!state.progressDragging) updateProgressDisplays(current, duration);
        updateActiveLyric(current);
    }

    function setPlayerStatus(status) {
        state.playerStatus = status || '准备就绪';
        [els.dockStatus, els.expandedStatus].forEach((el) => {
            if (el) el.textContent = state.playerStatus;
        });
    }

    function bindProgressSlider(slider) {
        if (!slider) return;
        slider.addEventListener('pointerdown', beginProgressDrag);
        slider.addEventListener('input', handleProgressInput);
        slider.addEventListener('change', commitProgressSeek);
    }

    function updateProgressDisplays(current, duration, activeSlider = null) {
        [els.currentTime, els.expandedCurrentTime].forEach((el) => {
            if (el) el.textContent = formatTime(current);
        });
        [els.durationTime, els.expandedDurationTime].forEach((el) => {
            if (el) el.textContent = formatTime(duration);
        });
        const value = duration ? String(Math.round((current / duration) * 1000)) : '0';
        [els.progress, els.expandedProgress].forEach((slider) => {
            if (!slider || slider === activeSlider) return;
            slider.value = value;
        });
    }

    function beginProgressDrag(event) {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        state.progressDragging = true;
        state.progressDragInput = event?.currentTarget || event?.target || null;
    }

    function handleProgressInput(event) {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        const slider = event?.currentTarget || state.progressDragInput || els.progress;
        if (!state.progressDragging) state.progressDragInput = slider;
        const preview = progressValueToSeconds(slider);
        updateProgressDisplays(preview, audio.duration, slider);
        if (!state.progressDragging) commitProgressSeek();
    }

    function commitProgressSeek(event) {
        const slider = state.progressDragInput || event?.currentTarget || document.activeElement;
        const isProgressSlider = slider === els.progress || slider === els.expandedProgress;
        if (!state.progressDragging && !isProgressSlider) return;
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
            audio.currentTime = progressValueToSeconds(slider);
        }
        state.progressDragging = false;
        state.progressDragInput = null;
        updateProgress();
        updateMediaSessionPositionState({ force: true });
    }

    function cancelProgressDrag() {
        if (!state.progressDragging) return;
        state.progressDragging = false;
        state.progressDragInput = null;
        updateProgress();
        updateMediaSessionPositionState({ force: true });
    }

    function progressValueToSeconds(slider = els.progress) {
        return (Number(slider?.value || 0) / 1000) * audio.duration;
    }

    async function toggleFavorite(song = state.currentSong) {
        if (!song) return;
        if (!state.currentUser) {
            openModal('auth-modal');
            showToast('请先登录后再收藏', 'error');
            return;
        }
        const favorite = isFavorite(song);
        try {
            await apiPost('php/favorite.php', {
                action: favorite ? 'remove' : 'add',
                user_id: state.currentUser.id,
                ...songPayload(song)
            });
            if (favorite) {
                state.favorites = state.favorites.filter((item) => !sameSong(item, song));
                favoriteKeys.delete(`${song.source || 'netease'}:${song.id}`);
            } else {
                state.favorites.unshift(normalizeSong(song));
                favoriteKeys.add(`${song.source || 'netease'}:${song.id}`);
            }
            updateUserCollections();
            showToast(favorite ? '已取消收藏' : '已收藏', 'success');
            renderShell();
            renderView(state.view);
        } catch (error) {
            showToast(error.message || '收藏失败', 'error');
        }
    }

    function openPlaylistDialog(song) {
        if (!song) return;
        if (!state.currentUser) {
            openModal('auth-modal');
            showToast('请先登录后再添加歌单', 'error');
            return;
        }
        state.pendingPlaylistSong = song;
        els.playlistChoiceList.innerHTML = state.playlists.map((playlist) => `
            <button class="playlist-choice" data-name="${escapeAttr(playlist.name)}">
                ${escapeHtml(playlist.name)} · ${playlist.songs.length} 首
            </button>
        `).join('') || `<div class="empty-state">还没有歌单，可以直接新建。</div>`;
        $$('.playlist-choice', els.playlistChoiceList).forEach((button) => {
            button.addEventListener('click', () => addSongToPlaylist(button.dataset.name, state.pendingPlaylistSong));
        });
        openModal('playlist-modal');
    }

    async function createPlaylistAndAdd(event) {
        event.preventDefault();
        const name = new FormData(els.createPlaylistForm).get('name').trim();
        if (!name) return;
        try {
            await createPlaylist(name);
            if (state.pendingPlaylistSong) await addSongToPlaylist(name, state.pendingPlaylistSong);
            els.createPlaylistForm.reset();
        } catch (error) {
            showToast(error.message || '创建歌单失败', 'error');
        }
    }

    async function createPlaylist(name) {
        const data = await apiPost('php/playlist.php', {
            action: 'create',
            user_id: state.currentUser.id,
            name
        });
        if (!data.success) throw new Error(data.message || '创建歌单失败');
        if (!state.playlists.some((item) => item.name === name)) {
            state.playlists.unshift({ name, songs: [] });
        }
        updateUserCollections();
        showToast('歌单已创建', 'success');
        return data;
    }

    async function addSongToPlaylist(name, song) {
        const idData = await apiPost('php/get_playlist_id.php', {
            user_id: state.currentUser.id,
            playlist_name: name
        });
        if (!idData.success) throw new Error(idData.message || '歌单不存在');
        const data = await apiPost('php/playlist.php', {
            action: 'add_song',
            user_id: state.currentUser.id,
            playlist_id: idData.playlist_id,
            ...songPayload(song)
        });
        if (!data.success) throw new Error(data.message || '添加失败');
        const playlist = state.playlists.find((item) => item.name === name);
        if (playlist && !playlist.songs.some((item) => sameSong(item, song))) playlist.songs.unshift(normalizeSong(song));
        updateUserCollections();
        closeModal('playlist-modal');
        showToast('已添加到歌单', 'success');
        if (state.view === 'playlists') renderPlaylists();
    }

    async function removeSongFromActivePlaylist(song) {
        const playlistName = state.activePlaylistName;
        const playlist = state.playlists.find((item) => item.name === playlistName);
        if (!state.currentUser || !playlist) {
            showToast('当前歌单不存在', 'error');
            return;
        }

        try {
            const idData = await apiPost('php/get_playlist_id.php', {
                user_id: state.currentUser.id,
                playlist_name: playlistName
            });
            if (!idData.success) throw new Error(idData.message || '歌单不存在');

            const data = await apiPost('php/playlist.php', {
                action: 'remove_song',
                user_id: state.currentUser.id,
                playlist_id: idData.playlist_id,
                ...songPayload(song)
            });
            if (!data.success) throw new Error(data.message || '移除失败');

            playlist.songs = playlist.songs.filter((item) => !sameSong(item, song));
            updateUserCollections();
            openPlaylistView(playlistName);
            showToast('已从歌单移除', 'success');
        } catch (error) {
            showToast(error.message || '移除失败', 'error');
        }
    }

    async function renamePlaylist(oldName, requestedName) {
        const newName = typeof requestedName === 'string'
            ? requestedName
            : prompt('请输入新的歌单名称', oldName);
        const trimmedName = String(newName || '').trim();
        if (!trimmedName) return;
        if (trimmedName === oldName) {
            state.renamingPlaylistName = null;
            renderPlaylists();
            return;
        }
        const data = await apiPost('php/rename_playlist.php', {
            user_id: state.currentUser.id,
            old_name: oldName,
            new_name: trimmedName
        });
        if (!data.success) {
            showToast(data.message || '重命名失败', 'error');
            return;
        }
        const playlist = state.playlists.find((item) => item.name === oldName);
        if (playlist) playlist.name = trimmedName;
        if (state.activePlaylistName === oldName) state.activePlaylistName = trimmedName;
        state.renamingPlaylistName = null;
        updateUserCollections();
        renderPlaylists();
    }

    async function deletePlaylist(name) {
        if (!confirm(`确定删除歌单“${name}”？`)) return;
        const idData = await apiPost('php/get_playlist_id.php', {
            user_id: state.currentUser.id,
            playlist_name: name
        });
        if (!idData.success) return showToast(idData.message || '歌单不存在', 'error');
        const data = await apiPost('php/playlist.php', {
            action: 'delete',
            user_id: state.currentUser.id,
            playlist_id: idData.playlist_id
        });
        if (!data.success) return showToast(data.message || '删除失败', 'error');
        state.playlists = state.playlists.filter((item) => item.name !== name);
        updateUserCollections();
        renderPlaylists();
    }

    function updateUserCollections() {
        if (!state.currentUser) return;
        state.currentUser.favorites = state.favorites;
        state.currentUser.playlists = Object.fromEntries(state.playlists.map((item) => [item.name, item.songs]));
        scheduleCloudSync();
    }

    function buildUserSyncPayload() {
        return {
            favorites: state.favorites.slice(0, USER_SYNC_LIMITS.favorites),
            playlists: Object.fromEntries(state.playlists.slice(0, USER_SYNC_LIMITS.playlists).map((item) => [
                item.name,
                normalizeSongList(item.songs || []).slice(0, USER_SYNC_LIMITS.playlistSongs)
            ])),
            recent_plays: state.recentPlays.slice(0, USER_SYNC_LIMITS.recentPlays),
            sync_state: {
                queue: state.queue.slice(0, USER_SYNC_LIMITS.queue),
                client_state: {
                    current_song: state.currentSong ? normalizeSong(state.currentSong) : null,
                    current_index: state.currentIndex,
                    quality: els.qualitySelect?.value || '',
                    play_mode: state.playMode,
                    updated_at: new Date().toISOString()
                }
            }
        };
    }

    function applyUserSyncState(syncState, { replaceQueue = false } = {}) {
        const cloudQueue = uniqueSongs(syncState?.queue || []).slice(0, USER_SYNC_LIMITS.queue);
        if (!cloudQueue.length) return;
        if (!replaceQueue && state.queue.length) return;
        state.queue = cloudQueue;
        state.currentIndex = state.currentSong
            ? Math.max(0, state.queue.findIndex((item) => sameSong(item, state.currentSong)))
            : -1;
        saveQueue({ skipCloudSync: true });
    }

    function scheduleCloudSync(delay = 1500) {
        if (!state.currentUser || !state.token) return;
        clearTimeout(state.cloudSyncTimer);
        state.cloudSyncTimer = setTimeout(() => {
            state.cloudSyncTimer = 0;
            syncUserToCloud(buildUserSyncPayload(), { silent: true });
        }, delay);
    }

    async function syncUserToCloud(payload = buildUserSyncPayload(), { replaceQueue = false, silent = false } = {}) {
        if (!state.currentUser || !state.token || state.cloudSyncInFlight) return false;
        state.cloudSyncInFlight = true;
        try {
            const data = await apiPost('php/sync_bundle.php', {
                user_id: state.currentUser.id,
                action: 'merge',
                payload: JSON.stringify(payload)
            });
            if (!data.success) throw new Error(data.message || '云同步失败');
            if (data.user) {
                state.currentUser = data.user;
                state.favorites = normalizeSongList(data.user.favorites || []);
                rebuildFavoriteKeys();
                state.playlists = playlistsFromUser(data.user);
                applyUserSyncState(data.sync_state || data.user.sync_state, { replaceQueue });
                updateUserUI();
                renderShell();
                renderView(state.view);
            }
            if (Array.isArray(data.recent_plays)) {
                state.recentPlays = normalizeSongList(data.recent_plays);
                state.historyLoadedForUser = String(state.currentUser.id);
                if (state.view === 'home') renderHome();
            }
            return true;
        } catch (error) {
            if (!silent) showToast(error.message || '云同步失败', 'error');
            return false;
        } finally {
            state.cloudSyncInFlight = false;
        }
    }

    async function handleLogin(event) {
        event.preventDefault();
        const form = Object.fromEntries(new FormData(els.loginForm));
        const localSnapshot = buildUserSyncPayload();
        try {
            const data = await apiPost('php/login.php', form);
            if (!data.success || data.need_email_verification) {
                showToast(data.message || '登录失败', 'error');
                return;
            }
            setUser(data.user, data.token);
            const synced = await syncUserToCloud(localSnapshot, { replaceQueue: true, silent: true });
            closeModal('auth-modal');
            showToast(synced ? '登录成功，已同步本地数据' : '登录成功', 'success');
        } catch (error) {
            showToast(error.message || '登录失败', 'error');
        }
    }

    async function sendRegisterCode() {
        const email = new FormData(els.registerForm).get('email');
        if (!email) return showToast('请先填写邮箱', 'error');
        els.sendRegisterCode.disabled = true;
        try {
            const data = await apiPost('php/register_verification.php', { email });
            showToast(data.message || (data.success ? '验证码已发送' : '发送失败'), data.success ? 'success' : 'error');
        } catch (error) {
            showToast(error.message || '发送失败', 'error');
        } finally {
            setTimeout(() => {
                els.sendRegisterCode.disabled = false;
            }, 1200);
        }
    }

    async function handleRegister(event) {
        event.preventDefault();
        const form = Object.fromEntries(new FormData(els.registerForm));
        const localSnapshot = buildUserSyncPayload();
        try {
            const data = await apiPost('php/register.php', form);
            if (!data.success) {
                showToast(data.message || '注册失败', 'error');
                return;
            }
            setUser(data.user, data.token);
            const synced = await syncUserToCloud(localSnapshot, { replaceQueue: true, silent: true });
            closeModal('auth-modal');
            showToast(synced ? '注册成功，已同步本地数据' : '注册成功', 'success');
        } catch (error) {
            showToast(error.message || '注册失败', 'error');
        }
    }

    async function sendResetCode() {
        const email = String(new FormData(els.resetPasswordForm).get('email') || '').trim();
        if (!email) return showToast('请先填写邮箱', 'error');
        els.sendResetCode.disabled = true;
        try {
            const data = await apiPost('php/forgot_password.php', {
                action: 'send_code',
                email
            });
            showToast(data.message || (data.success ? '验证码已发送' : '发送失败'), data.success ? 'success' : 'error');
        } catch (error) {
            showToast(error.message || '发送失败', 'error');
        } finally {
            setTimeout(() => {
                els.sendResetCode.disabled = false;
            }, 1200);
        }
    }

    async function handleResetPassword(event) {
        event.preventDefault();
        const form = Object.fromEntries(new FormData(els.resetPasswordForm));
        const email = String(form.email || '').trim();
        if (!email) return showToast('请填写邮箱', 'error');
        try {
            const data = await apiPost('php/forgot_password.php', {
                action: 'reset_password',
                email,
                code: form.code,
                new_password: form.new_password
            });
            if (!data.success) {
                showToast(data.message || '重置失败', 'error');
                return;
            }
            els.resetPasswordForm.reset();
            switchAuthTab('login');
            showToast('密码已重置，请重新登录', 'success');
        } catch (error) {
            showToast(error.message || '重置失败', 'error');
        }
    }

    function logout() {
        clearUser();
        showToast('已退出登录');
        renderView(state.view);
    }

    function switchAuthTab(tab) {
        $$('.tab-btn').forEach((button) => button.classList.toggle('active', button.dataset.authTab === tab));
        els.loginForm.classList.toggle('hidden', tab !== 'login');
        els.registerForm.classList.toggle('hidden', tab !== 'register');
        els.resetPasswordForm?.classList.toggle('hidden', tab !== 'reset');
    }

    async function showSourceStatus() {
        openModal('source-diagnostics-modal');
        renderSourceDiagnostics();
        await refreshSourceDiagnostics({ silent: true });
    }

    async function refreshSourceDiagnostics({ force = false, silent = false } = {}) {
        if (!force && state.sourceDiagnostics.loading) return;
        state.sourceDiagnostics.loading = true;
        state.sourceDiagnostics.error = '';
        renderSourceDiagnostics();

        try {
            const data = await apiGet('api_check/api_doubtful.php');
            state.sourceDiagnostics.providers = data && typeof data === 'object' ? data : {};
        } catch (error) {
            state.sourceDiagnostics.providers = {};
            state.sourceDiagnostics.error = error.message || '无法获取源状态';
            if (!silent) showToast(state.sourceDiagnostics.error, 'error');
        } finally {
            state.sourceDiagnostics.loading = false;
            renderSourceDiagnostics();
        }
    }

    function renderSourceDiagnostics() {
        if (!els.diagMusicSource || !els.providerStatusList) return;

        els.diagMusicSource.textContent = state.sourceDiagnostics.musicSource || '暂无';
        els.diagCache.textContent = state.sourceDiagnostics.cache || '暂无';
        els.diagRequestAt.textContent = state.sourceDiagnostics.requestAt || '暂无';

        if (state.sourceDiagnostics.loading) {
            els.providerStatusList.innerHTML = loadingState('正在刷新音源状态');
            return;
        }

        if (state.sourceDiagnostics.error) {
            els.providerStatusList.innerHTML = emptyState('无法获取源状态', state.sourceDiagnostics.error);
            return;
        }

        const providers = Object.entries(state.sourceDiagnostics.providers || {});
        els.providerStatusList.innerHTML = providers.map(([source, item]) => {
            const searchStatus = statusMeta(item?.search);
            const playStatus = statusMeta(item?.play);
            const secondLabel = searchStatus.label === 'N/A' ? '歌词' : '播放';
            return `
                <div class="provider-row">
                    <div>
                        <strong>${escapeHtml(item?.name || source)}</strong>
                        <span class="provider-meta">last_check: ${escapeHtml(item?.last_check || '暂无')}</span>
                    </div>
                    <div class="provider-pills">
                        <span class="status-pill ${searchStatus.className}">搜索 ${searchStatus.label}</span>
                        <span class="status-pill ${playStatus.className}">${secondLabel} ${playStatus.label}</span>
                    </div>
                </div>
            `;
        }).join('') || emptyState('暂无音源检测记录', '后台监控完成后会显示每个 provider 的状态。');
    }

    function statusMeta(value) {
        if (value === true || value === 'true') return { className: 'ok', label: 'OK' };
        if (value === null || value === 'n/a') return { className: '', label: 'N/A' };
        return { className: 'bad', label: 'FAIL' };
    }

    function recordSourceHeaders(headers = {}) {
        const musicSource = headers.musicSource || '';
        const cache = headers.cache || '';
        if (!musicSource && !cache) return;

        state.sourceDiagnostics.musicSource = musicSource || '未返回';
        state.sourceDiagnostics.cache = cache || '未返回';
        state.sourceDiagnostics.requestAt = new Date().toLocaleString('zh-CN');
        renderSourceDiagnostics();
    }

    function renderLyrics() {
        state.activeLyricIndex = -1;
        els.lyricBox.classList.toggle('is-empty', state.lyrics.length === 0);
        els.lyricBox.innerHTML = state.lyrics.length
            ? state.lyrics.map((line, index) => `
                <div class="lyric-line" data-lyric-index="${index}">
                    <span>${escapeHtml(line.text)}</span>
                </div>
            `).join('')
            : `<div class="empty-state">暂无歌词</div>`;
        updateActiveLyric(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    }

    function updateActiveLyric(current) {
        if (document.hidden && !audio.paused) return;
        if (!state.lyrics.length || !els.playerModal.classList.contains('open')) return;
        let active = 0;
        for (let i = 0; i < state.lyrics.length; i += 1) {
            if (state.lyrics[i].time <= current) active = i;
            else break;
        }
        if (active === state.activeLyricIndex) return;
        // Only toggle two elements instead of iterating all lines
        const prevLine = $(`.lyric-line[data-lyric-index="${state.activeLyricIndex}"]`, els.lyricBox);
        if (prevLine) prevLine.classList.remove('active');
        state.activeLyricIndex = active;
        const activeLine = $(`.lyric-line[data-lyric-index="${active}"]`, els.lyricBox);
        if (!activeLine) return;
        activeLine.classList.add('active');
        const now = performance.now();
        const shouldSmooth = now - state.lastLyricScrollAt > 420;
        state.lastLyricScrollAt = now;
        const targetTop = activeLine.offsetTop - (els.lyricBox.clientHeight / 2) + (activeLine.clientHeight / 2);
        els.lyricBox.scrollTo({
            top: Math.max(0, targetTop),
            behavior: shouldSmooth ? 'smooth' : 'auto'
        });
    }

    function updateQualityBadge(data) {
        if (!els.expandedQuality) return;
        const quality = String(data?.br || state.currentQuality || els.qualitySelect.value || '999');
        const size = Number(data?.size || 0);
        const sizeText = size ? ` · ${formatBytes(size)}` : '';
        const offlineText = data?.offline ? ' · 本地' : '';
        els.expandedQuality.textContent = `${qualityLabel(quality, data)}${sizeText}${offlineText}`;
    }

    function normalizeRequestedQuality(value) {
        const normalized = String(value || '').toLowerCase();
        if (['999', 'flac', 'lossless', 'sq'].includes(normalized)) return '999';
        const numeric = Number(normalized || 0);
        return numeric >= 900 ? '999' : '320';
    }

    function qualityLabel(value, metadata = null) {
        const codec = String(metadata?.codec || '').toLowerCase();
        const numeric = Number(value || 0);
        const hasVerifiedMetadata = metadata && (
            metadata.verified_audio
            || codec
            || typeof metadata.lossless === 'boolean'
        );
        if (hasVerifiedMetadata) {
            if (metadata.lossless === true || (metadata.verified_audio && ['flac', 'wav', 'alac'].includes(codec))) {
                return `无损 SQ${codec ? ` ${codec.toUpperCase()}` : ''}`;
            }
            if (codec === 'mp3') return '极高 HQ MP3';
            if (codec === 'm4a' || codec === 'aac') return '极高 HQ AAC';
            if (codec === 'ogg') return '高音质 OGG';
            if (metadata.lossless === false) return numeric >= 320 ? '极高 HQ' : '标准音质';
        }

        if (numeric >= 900) return '无损 SQ';
        if (numeric >= 800) return `无损 SQ ${numeric}K`;
        if (numeric >= 320) return '极高 HQ';
        if (numeric >= 192) return '标准音质';
        return '省流音质';
    }

    function formatBytes(value) {
        if (!value) return '';
        if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
        return `${Math.round(value / 1024)} KB`;
    }

    function updateCoverTheme(src) {
        if (document.hidden && !audio.paused) return;
        if (!src) return setAccent(30, 215, 96);
        _coverImage.onload = () => {
            try {
                _coverCtx.drawImage(_coverImage, 0, 0, 24, 24);
                const data = _coverCtx.getImageData(0, 0, 24, 24).data;
                let r = 0;
                let g = 0;
                let b = 0;
                let count = 0;
                for (let i = 0; i < data.length; i += 16) {
                    const alpha = data[i + 3];
                    if (alpha < 120) continue;
                    const brightness = data[i] + data[i + 1] + data[i + 2];
                    if (brightness < 48 || brightness > 720) continue;
                    r += data[i];
                    g += data[i + 1];
                    b += data[i + 2];
                    count += 1;
                }
                if (!count) return setAccent(30, 215, 96);
                setAccent(Math.round(r / count), Math.round(g / count), Math.round(b / count));
            } catch {
                setAccent(30, 215, 96);
            }
        };
        _coverImage.onerror = () => setAccent(30, 215, 96);
        _coverImage.src = src;
    }

    function setAccent(r, g, b) {
        const [nr, ng, nb] = boostColor(r, g, b);
        root.style.setProperty('--accent-rgb', `${nr}, ${ng}, ${nb}`);
        root.style.setProperty('--accent', `rgb(${nr}, ${ng}, ${nb})`);
        root.style.setProperty('--cover-glow', `rgba(${nr}, ${ng}, ${nb}, 0.34)`);
        const luminance = (0.299 * nr + 0.587 * ng + 0.114 * nb) / 255;
        root.style.setProperty('--accent-contrast', luminance > 0.62 ? '#07110d' : '#f5fff9');
    }

    function boostColor(r, g, b) {
        const max = Math.max(r, g, b);
        const factor = max < 120 ? 1.45 : 1.12;
        return [r, g, b].map((value) => Math.max(44, Math.min(235, Math.round(value * factor))));
    }

    function refreshRuntimeState() {
        return musiqRuntime.refresh?.() || musiqRuntime;
    }

    function isIosInAppPlaybackBlocked() {
        refreshRuntimeState();
        return Boolean(musiqRuntime.isIOS && musiqRuntime.isInAppBrowser);
    }

    function guardPlaybackForRuntime() {
        if (!isIosInAppPlaybackBlocked()) return false;
        stopBlockedRuntimeMedia();
        showInAppPlaybackModal();
        return true;
    }

    function stopBlockedRuntimeMedia() {
        try {
            pausePlaybackIntentionally();
            audio.removeAttribute('src');
            audio.load();
        } catch {}
        resetPlaybackSnapshot();
        musiqRuntime.mediaSessionEnabled = false;
        musiqRuntime.mediaSessionBlockedReason = 'in-app-browser';
        musiqRuntime.clearMediaSession?.('in-app-browser');
        setPlayerStatus('仅浏览模式');
        updatePlayButtons();
        renderPwaDiagnostics();
    }

    function playAudioWithRuntimeGuard(options = {}) {
        if (guardPlaybackForRuntime()) {
            const error = new Error(options.runtimeBlockedMessage || 'Playback is blocked in iOS in-app browsers');
            error.name = 'RuntimePlaybackBlocked';
            error.userMessage = options.notAllowedMessage || options.genericMessage || '请在 Safari 或已添加到主屏幕的 PWA 中播放';
            return Promise.reject(error);
        }
        return audio.play().catch((error) => {
            if (error?.name === 'NotAllowedError' && options.notAllowedMessage) {
                error.userMessage = options.notAllowedMessage;
            } else if (options.genericMessage) {
                error.userMessage = options.genericMessage;
            }
            throw error;
        });
    }

    function setupMediaSessionHandlers() {
        refreshRuntimeState();
        if (!musiqRuntime.hasMediaSession) return;

        if (isIosInAppPlaybackBlocked()) {
            musiqRuntime.clearMediaSession?.('in-app-browser');
            return;
        }

        if (!canUseFullMediaSession()) {
            clearMediaSessionActionHandlers();
            musiqRuntime.mediaSessionEnabled = false;
            musiqRuntime.mediaSessionBlockedReason = mediaSessionUnavailableReason();
            return;
        }

        const handlers = {
            play: () => resumeCurrentPlayback({ fromMediaSession: true }).catch(() => {}),
            pause: () => {
                rememberPlaybackSnapshot();
                pausePlaybackIntentionally();
            },
            previoustrack: () => playPrevious(),
            nexttrack: () => playNext({ fromMediaSession: true }),
            seekto: (details) => {
                if (!Number.isFinite(details?.seekTime) || !Number.isFinite(audio.duration)) return;
                audio.currentTime = Math.max(0, Math.min(details.seekTime, audio.duration));
                updateProgress();
            }
        };

        Object.entries(handlers).forEach(([action, handler]) => {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                // Older Safari versions expose only part of the Media Session API.
            }
        });
        state.mediaSessionHandlersRegistered = true;
        musiqRuntime.mediaSessionEnabled = true;
        musiqRuntime.mediaSessionBlockedReason = '';
    }

    function updateMediaSessionMetadata({ afterPlaybackStart = false } = {}) {
        refreshRuntimeState();
        if (!musiqRuntime.hasMediaSession) return;

        if (isIosInAppPlaybackBlocked()) {
            musiqRuntime.clearMediaSession?.('in-app-browser');
            return;
        }

        const song = state.currentSong;
        if (!song) {
            clearOrDegradeMediaSession('no-song');
            return;
        }

        const fullSession = canUseFullMediaSession();
        if (!fullSession) {
            clearOrDegradeMediaSession(mediaSessionUnavailableReason());
            return;
        }

        if (!afterPlaybackStart && audio.paused) {
            updateMediaSessionPlaybackState();
            return;
        }

        setupMediaSessionHandlers();

        const preferredArtwork = chooseMediaArtwork(song);
        if (trySetMediaMetadata(song, preferredArtwork)) {
            updateMediaSessionPlaybackState();
            return;
        }
        trySetMediaMetadata(song, absolutizeAssetUrl(fallbackArtwork));
        updateMediaSessionPlaybackState();
    }

    function updateMediaSessionPlaybackState() {
        refreshRuntimeState();
        if (!musiqRuntime.hasMediaSession) return;

        const fullSession = canUseFullMediaSession();
        if (isIosInAppPlaybackBlocked()) {
            musiqRuntime.clearMediaSession?.('in-app-browser');
            renderPwaDiagnostics();
            return;
        }
        try {
            navigator.mediaSession.playbackState = state.currentSong && audio.src && fullSession
                ? (audio.ended ? 'none' : (audio.paused ? 'paused' : 'playing'))
                : 'none';
        } catch {}
        updateMediaSessionPositionState();
        renderPwaDiagnostics();
    }

    function updateMediaSessionPositionState({ force = false } = {}) {
        if (!musiqRuntime.hasMediaSession || !canUseFullMediaSession()) return;
        if (typeof navigator.mediaSession?.setPositionState !== 'function') return;

        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (duration <= 0) return;

        const now = Date.now();
        if (!force && now - state.lastMediaPositionUpdateAt < 1000) return;

        const current = Number.isFinite(audio.currentTime) ? audio.currentTime : state.lastKnownPlaybackTime || 0;
        const position = Math.max(0, Math.min(current, duration));
        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1,
                position
            });
            state.lastMediaPositionUpdateAt = now;
        } catch {}
    }

    function clearOrDegradeMediaSession(reason = '') {
        refreshRuntimeState();
        if (!musiqRuntime.hasMediaSession) return;
        clearMediaSessionActionHandlers();
        musiqRuntime.mediaSessionEnabled = false;
        musiqRuntime.mediaSessionBlockedReason = reason || mediaSessionUnavailableReason();
        try {
            navigator.mediaSession.playbackState = 'none';
        } catch {}
        try {
            navigator.mediaSession.metadata = null;
        } catch {}
        renderPwaDiagnostics();
    }

    function clearMediaSessionActionHandlers() {
        if (!musiqRuntime.hasMediaSession) return;
        mediaSessionActions.forEach((action) => {
            try {
                navigator.mediaSession.setActionHandler(action, null);
            } catch {}
        });
        state.mediaSessionHandlersRegistered = false;
    }

    function canUseFullMediaSession() {
        return Boolean(musiqRuntime.canUseFullMediaSession?.()
            || (musiqRuntime.hasMediaSession
                && musiqRuntime.isSecureContext
                && !musiqRuntime.isInAppBrowser
                && (musiqRuntime.isStandalonePwa || musiqRuntime.isSafari || !musiqRuntime.isIOS)));
    }

    function mediaSessionUnavailableReason() {
        if (!musiqRuntime.hasMediaSession) return 'no-media-session';
        if (!musiqRuntime.isSecureContext) return 'insecure-context';
        if (musiqRuntime.isInAppBrowser) return 'in-app-browser';
        if (!musiqRuntime.isStandalonePwa && musiqRuntime.isIOS && !musiqRuntime.isSafari) return 'ios-non-safari-browser';
        if (!musiqRuntime.isStandalonePwa && !musiqRuntime.isIOS) return 'not-standalone-pwa';
        return '';
    }

    function trySetMediaMetadata(song, artwork) {
        if (typeof MediaMetadata !== 'function') return false;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: song.name || '未知歌曲',
                artist: formatArtists(song.artist),
                album: song.album || 'music',
                artwork: buildArtworkSet(artwork)
            });
            musiqRuntime.markMetadata?.({
                title: song.name || '未知歌曲',
                artwork
            });
            return true;
        } catch {
            return false;
        }
    }

    function buildArtworkSet(src) {
        const artwork = absolutizeAssetUrl(src || fallbackArtwork);
        return mediaArtwork?.buildSet(artwork, { fallback: fallbackArtwork }) || [{ src: artwork }];
    }

    function chooseMediaArtwork(song) {
        const candidate = absolutizeAssetUrl(song.cover_url || getCoverUrl(song, 512) || fallbackArtwork);
        const fallback = absolutizeAssetUrl(fallbackArtwork);
        return mediaArtwork?.resolve(candidate, { fallback }) || fallback;
    }

    function absolutizeAssetUrl(value) {
        try {
            const url = new URL(normalizeCoverUrl(value) || fallbackCover, window.location.href);
            if (window.location.protocol === 'https:' && url.protocol === 'http:') {
                return new URL(fallbackArtwork, window.location.href).href;
            }
            return url.href;
        } catch {
            return fallbackCover;
        }
    }

    function showInAppPlaybackModal() {
        if (els.inAppPlaybackSteps) els.inAppPlaybackSteps.hidden = true;
        openModal('in-app-playback-modal');
    }

    function copySafariLaunchLink() {
        const url = canonicalSafariLaunchUrl();
        writeClipboard(url).then(() => {
            showToast('已复制 Safari 打开链接', 'success');
        }).catch(() => {
            showToast('复制失败，请手动复制地址栏链接', 'error');
        });
    }

    function canonicalSafariLaunchUrl() {
        const url = new URL(window.location.href);
        const clean = new URL('/?source=pwa', url.origin);
        const view = url.searchParams.get('view');
        const panel = url.searchParams.get('panel');
        const debugPwa = url.searchParams.get('debugPwa');
        if (view) clean.searchParams.set('view', view);
        if (panel) clean.searchParams.set('panel', panel);
        if (debugPwa) clean.searchParams.set('debugPwa', debugPwa);
        return clean.href;
    }

    async function writeClipboard(text) {
        if (navigator.clipboard?.writeText && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('copy failed');
    }

    function applyRuntimePlaybackGuidance() {
        refreshRuntimeState();
        document.body.classList.toggle('is-safari-browser-pwa-candidate', Boolean(
            musiqRuntime.isIOS && musiqRuntime.isSafari && !musiqRuntime.isStandalonePwa
        ));
        if (isIosInAppPlaybackBlocked()) {
            stopBlockedRuntimeMedia();
            return;
        }
        if (musiqRuntime.isIOS && musiqRuntime.isSafari && !musiqRuntime.isStandalonePwa && !state.currentSong) {
            setPlayerStatus('添加到主屏幕体验更好');
        }
    }

    function initPwaDiagnostics() {
        if (!pwaDebugEnabled) {
            renderPwaDiagnostics();
            return;
        }
        if (els.pwaDiagnostics) els.pwaDiagnostics.hidden = false;
        renderPwaDiagnostics();
        setTimeout(() => openModal('source-diagnostics-modal'), 0);
    }

    function renderPwaDiagnostics() {
        if (!els.pwaDiagnosticsGrid) return;
        if (!pwaDebugEnabled && els.pwaDiagnostics?.hidden) return;
        if (els.pwaDiagnostics) els.pwaDiagnostics.hidden = false;

        const diagnostics = collectPwaDiagnostics();
        els.pwaDiagnosticsGrid.innerHTML = Object.entries(diagnostics).map(([label, value]) => `
            <div>
                <span>${escapeHtml(label)}</span>
                <strong>${escapeHtml(formatDiagnosticValue(value))}</strong>
            </div>
        `).join('');
    }

    function collectPwaDiagnostics() {
        refreshRuntimeState();
        const audioSrc = audio.currentSrc || audio.src || '';
        let audioHost = '';
        try {
            audioHost = audioSrc ? new URL(audioSrc, window.location.href).host : '';
        } catch {
            audioHost = 'invalid-url';
        }
        return {
            UA: musiqRuntime.ua || navigator.userAgent || '',
            appVersion: musiqRuntime.appVersion || '',
            isIOS: musiqRuntime.isIOS,
            isSafari: musiqRuntime.isSafari,
            isStandalonePwa: musiqRuntime.isStandalonePwa,
            isInAppBrowser: musiqRuntime.isInAppBrowser,
            inAppHost: musiqRuntime.inAppHost || '',
            isSecureContext: musiqRuntime.isSecureContext,
            hasMediaSession: musiqRuntime.hasMediaSession,
            mediaSessionEnabled: musiqRuntime.mediaSessionEnabled,
            mediaSessionBlockedReason: musiqRuntime.mediaSessionBlockedReason || '',
            'serviceWorker.controller': musiqRuntime.serviceWorkerController,
            'manifest id': musiqRuntime.manifestId || '',
            'manifest start_url': musiqRuntime.manifestStartUrl || '',
            'current URL': window.location.href,
            referrer: document.referrer || '',
            'last metadata title': musiqRuntime.lastMetadataTitle || '',
            'last metadata artwork': musiqRuntime.lastMetadataArtwork || '',
            'audio.paused': audio.paused,
            'audio.src host': audioHost,
            'last playable url': state.lastPlayableUrl ? 'set' : '',
            'last playback time': Number(state.lastKnownPlaybackTime || 0).toFixed(1),
            'playback intent': state.playbackIntent,
            'last lifecycle hidden at': state.lastLifecycleHiddenAt ? new Date(state.lastLifecycleHiddenAt).toISOString() : '',
            'audio url cache size': audioUrlCache.size,
            'next audio prewarm': state.nextAudioPrewarmStatus || '',
            'next audio prewarm url': state.nextAudioPrewarmUrl || '',
            'playback watchdog retries': state.playbackWatchdogRetries,
            'document.visibilityState': document.visibilityState,
            'pageshow persisted flag': musiqRuntime.pageshowPersisted,
            'last audio error code': musiqRuntime.lastAudioErrorCode || '',
            'last route restore time': musiqRuntime.lastRouteRestoreTime || ''
        };
    }

    function formatDiagnosticValue(value) {
        if (value === true) return 'true';
        if (value === false) return 'false';
        return value ?? '';
    }

    function copyPwaDiagnostics() {
        const diagnostics = collectPwaDiagnostics();
        const text = Object.entries(diagnostics)
            .map(([key, value]) => `${key}: ${formatDiagnosticValue(value)}`)
            .join('\n');
        writeClipboard(text).then(() => {
            showToast('已复制 PWA 诊断信息', 'success');
        }).catch(() => {
            showToast('复制诊断信息失败', 'error');
        });
    }

    async function clearLocalPwaState() {
        const removableKeys = [
            'music_ios_install_dismissed',
            'musiq_ios_install_dismissed',
            'music_pwa_update_dismissed',
            'musiq_pwa_update_dismissed'
        ];
        removableKeys.forEach((key) => localStorage.removeItem(key));
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys
                .filter((key) => key.startsWith('music-pwa-') || key.startsWith('musiq-pwa-'))
                .map((key) => caches.delete(key)));
        }
        renderPwaDiagnostics();
        showToast('已清理本地 PWA 状态', 'success');
    }

    function markRouteRestore() {
        musiqRuntime.markRouteRestore?.();
        renderPwaDiagnostics();
    }

    function createRuntimeFallback() {
        const fallback = {
            refresh() {
                const ua = navigator.userAgent || '';
                this.ua = ua;
                this.isIOS = /iPad|iPhone|iPod/.test(ua)
                    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                this.isStandalonePwa = window.navigator.standalone === true
                    || window.matchMedia?.('(display-mode: standalone)').matches === true;
                this.inAppHost = detectFallbackInAppHost(ua);
                this.isInAppBrowser = Boolean(this.inAppHost);
                this.isSafari = /Safari/i.test(ua)
                    && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Android/i.test(ua)
                    && !this.isInAppBrowser;
                this.isSecureContext = Boolean(window.isSecureContext);
                this.hasMediaSession = 'mediaSession' in navigator;
                this.serviceWorkerController = Boolean(navigator.serviceWorker?.controller);
                return this;
            },
            canUseFullMediaSession() {
                this.refresh();
                return Boolean(this.hasMediaSession
                    && this.isSecureContext
                    && !this.isInAppBrowser
                    && (this.isStandalonePwa || this.isSafari || !this.isIOS));
            },
            clearMediaSession(reason = '') {
                this.mediaSessionEnabled = false;
                this.mediaSessionBlockedReason = reason;
            },
            markMetadata({ title = '', artwork = '' } = {}) {
                this.lastMetadataAt = new Date().toISOString();
                this.lastMetadataTitle = title;
                this.lastMetadataArtwork = artwork;
            },
            markAudioError(errorCode) {
                this.lastAudioErrorCode = errorCode ? String(errorCode) : '';
            },
            markRouteRestore() {
                this.lastRouteRestoreTime = new Date().toISOString();
            },
            appVersion: '2026.07.12.1',
            mediaSessionEnabled: false,
            mediaSessionBlockedReason: ''
        };
        return fallback.refresh();
    }

    function detectFallbackInAppHost(ua) {
        if (typeof window.AlipayJSBridge !== 'undefined') return 'alipay';
        if (typeof window.AlipayJSBridgeReady !== 'undefined') return 'alipay';
        if (typeof window.WeixinJSBridge !== 'undefined') return 'wechat';
        if (/AlipayClient|AliApp\(AP\/|\bAliApp\b|AlipayDefined|APWebView|\bNebula\b|\bmPaaS\b/i.test(ua)) return 'alipay';
        if (/MicroMessenger/i.test(ua)) return 'wechat';
        if (/\bQQ\//i.test(ua)) return 'qq';
        if (/Weibo/i.test(ua)) return 'weibo';
        if (/DingTalk/i.test(ua)) return 'dingtalk';
        if (/Feishu|Lark/i.test(ua)) return 'feishu';
        if (/UCBrowser/i.test(ua)) return 'uc';
        if (/Quark/i.test(ua)) return 'quark';
        if (/Baidu/i.test(ua)) return 'baidu';
        if (/SogouMobileBrowser/i.test(ua)) return 'sogou';
        return '';
    }

    function readRuntimeConfig() {
        const metaApiBase = document.querySelector('meta[name="music-api-base-url"]')?.content
            || document.querySelector('meta[name="musiq-api-base-url"]')?.content
            || '';
        let globalConfig = {};
        if (window.__MUSIC_CONFIG__ && typeof window.__MUSIC_CONFIG__ === 'object') {
            globalConfig = window.__MUSIC_CONFIG__;
        } else if (window.__MUSIQ_CONFIG__ && typeof window.__MUSIQ_CONFIG__ === 'object') {
            globalConfig = window.__MUSIQ_CONFIG__;
        }
        return {
            apiBaseUrl: normalizeApiBaseUrl(globalConfig.apiBaseUrl || globalConfig.api_base_url || metaApiBase),
            musicApiBaseUrl: normalizeApiBaseUrl(globalConfig.musicApiBaseUrl || globalConfig.music_api_base_url || ''),
            credentials: globalConfig.credentials || 'same-origin'
        };
    }

    function normalizeApiBaseUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    function buildApiUrl(path, params = {}) {
        const cleanPath = String(path || '').replace(/^\/+/, '');
        const query = new URLSearchParams(params).toString();
        const baseUrl = cleanPath === 'api.php' && runtimeConfig.musicApiBaseUrl
            ? runtimeConfig.musicApiBaseUrl
            : runtimeConfig.apiBaseUrl;
        if (!baseUrl) return query ? `${cleanPath}?${query}` : cleanPath;

        const base = baseUrl.endsWith('/')
            ? baseUrl
            : `${baseUrl}/`;
        const url = new URL(cleanPath, base);
        if (query) url.search = query;
        return url.toString();
    }

    function isApiPath(path, target) {
        return String(path || '').replace(/^\/+/, '') === target;
    }

    async function apiGet(path, params = {}) {
        const result = await apiGetWithMeta(path, params);
        if (isApiPath(path, 'api.php') || isApiPath(path, 'php/toplist.php')) recordSourceHeaders(result.headers);
        return result.data;
    }

    async function apiGetWithMeta(path, params = {}) {
        const response = await fetch(buildApiUrl(path, params), {
            credentials: runtimeConfig.credentials,
            cache: 'no-store'
        });
        const data = await parseResponse(response);
        return {
            data,
            headers: {
                musicSource: response.headers.get('X-Music-Source') || '',
                cache: response.headers.get('X-Cache') || response.headers.get('X-Toplist-Cache') || ''
            }
        };
    }

    async function apiPost(path, body = {}) {
        const cleanPath = String(path || '').replace(/^\/+/, '');
        const payload = { ...body };
        if (state.token && !payload.token && !publicPostPaths.has(cleanPath)) {
            payload.token = state.token;
        }
        const response = await fetch(buildApiUrl(path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            credentials: runtimeConfig.credentials,
            body: new URLSearchParams(payload)
        });
        return parseResponse(response);
    }

    async function parseResponse(response) {
        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            throw new Error(text || `HTTP ${response.status}`);
        }
        if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
        return data;
    }

    function normalizeSongList(list) {
        return (Array.isArray(list) ? list : []).map(normalizeSong).filter((song) => song.id);
    }

    function normalizeSong(song) {
        const source = song.source || els.sourceSelect?.value || 'netease';
        return {
            id: String(song.id || song.song_id || ''),
            name: song.name || song.song_name || song.song_title || song.title || '未知歌曲',
            artist: song.artist || song.song_artist || [],
            album: song.album || '',
            duration: Number(song.duration || 0),
            pic_id: String(song.pic_id || song.pic || song.song_cover || ''),
            cover_url: normalizeCoverUrl(
                song.cover_url
                || song.cover
                || (/^https?:\/\//.test(String(song.pic || '')) ? song.pic : '')
            ),
            source,
            url_id: String(song.url_id || song.id || ''),
            lyric_id: String(song.lyric_id || song.id || ''),
            original_title: song.original_title || '',
            original_artist: song.original_artist || ''
        };
    }

    function songPayload(song) {
        const normalized = normalizeSong(song);
        return {
            song_id: normalized.id,
            id: normalized.id,
            source: normalized.source,
            song_title: normalized.name,
            song_name: normalized.name,
            name: normalized.name,
            song_artist: formatArtists(normalized.artist),
            artist: formatArtists(normalized.artist),
            album: normalized.album,
            song_cover: normalized.pic_id,
            pic_id: normalized.pic_id,
            original_title: normalized.original_title || normalized.name,
            original_artist: normalized.original_artist || formatArtists(normalized.artist)
        };
    }

    function playlistsFromUser(user) {
        if (Array.isArray(user.playlists)) {
            return user.playlists.map((item) => ({
                name: item.name,
                songs: normalizeSongList(item.songs || [])
            }));
        }
        return Object.entries(user.playlists || {}).map(([name, songs]) => ({
            name,
            songs: normalizeSongList(songs)
        }));
    }

    function sameSong(a, b) {
        return a && b && String(a.id) === String(b.id) && (a.source || 'netease') === (b.source || 'netease');
    }

    function uniqueSongs(list) {
        const seen = new Set();
        return normalizeSongList(list).filter((song) => {
            const key = `${song.source}:${song.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function isFavorite(song) {
        const key = `${song.source || 'netease'}:${song.id}`;
        return favoriteKeys.has(key);
    }

    function getCoverUrl(song, size = 300) {
        if (!song?.pic_id) return fallbackCover;
        if (song.cover_url) return normalizeCoverUrl(song.cover_url);
        if (/^https?:\/\//.test(song.pic_id) || song.pic_id.startsWith('uploads/')) return normalizeCoverUrl(song.pic_id);
        return fallbackCover;
    }

    async function resolveCoverUrl(song, size = 300) {
        if (!song) return fallbackCover;
        if (song.cover_url) return normalizeCoverUrl(song.cover_url);
        if (!song.pic_id) return fallbackCover;
        if (/^https?:\/\//.test(song.pic_id) || song.pic_id.startsWith('uploads/')) return normalizeCoverUrl(song.pic_id);
        try {
            const data = await apiGet('api.php', {
                types: 'pic',
                source: song.source || 'netease',
                id: song.pic_id,
                size
            });
            return normalizeCoverUrl(data.url) || fallbackCover;
        } catch {
            return fallbackCover;
        }
    }

    function normalizeCoverUrl(value) {
        return String(value || '')
            .replace(/^http:\/\/(img\d+)\.sycdn\.kuwo\.cn\//i, 'https://$1.kuwo.cn/')
            .replace(/^http:\/\/(img\d+)\.kuwo\.cn\//i, 'https://$1.kuwo.cn/');
    }

    function formatArtists(artist) {
        if (Array.isArray(artist)) return artist.join(' / ');
        return String(artist || '未知艺术家');
    }

    function parseLyrics(raw) {
        return String(raw || '').split(/\r?\n/).map((line) => {
            const match = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?]\s*(.*)$/);
            if (!match) return null;
            const minutes = Number(match[1]);
            const seconds = Number(match[2]);
            const ms = Number((match[3] || '0').padEnd(3, '0'));
            const text = match[4].trim();
            if (!text) return null;
            return { time: minutes * 60 + seconds + ms / 1000, text };
        }).filter(Boolean);
    }

    function formatTime(value) {
        const total = Math.max(0, Math.floor(value || 0));
        const minutes = String(Math.floor(total / 60)).padStart(2, '0');
        const seconds = String(total % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    }

    function encodeSong(song) {
        return encodeURIComponent(JSON.stringify(normalizeSong(song)));
    }

    function decodeSong(value) {
        if (!value) return null;
        try {
            return normalizeSong(JSON.parse(decodeURIComponent(value)));
        } catch {
            try {
                const textarea = document.createElement('textarea');
                textarea.innerHTML = value;
                return normalizeSong(JSON.parse(textarea.value));
            } catch {
                return null;
            }
        }
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function escapeAttr(value) {
        return escapeHtml(value).replace(/`/g, '&#96;');
    }

    function emptyState(title, detail = '') {
        return `<div class="empty-state"><div><strong>${escapeHtml(title)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</div></div>`;
    }

    function loadingState(text) {
        return `<div class="empty-state">${escapeHtml(text)}...</div>`;
    }

    function openModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        if (id === 'player-modal') renderLyrics();
        if (id === 'queue-modal') renderQueue();
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        updateModalBodyLock();
    }

    function closeModal(id) {
        const modal = document.getElementById(id);
        if (!modal) return;
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        updateModalBodyLock();
    }

    function updateModalBodyLock() {
        document.body.classList.toggle('modal-open', Boolean($('.modal.open')));
    }

    let toastTimer = 0;
    function showToast(message, type = 'info') {
        if (document.hidden && !audio.paused && type === 'info') return;
        clearTimeout(toastTimer);
        els.toast.textContent = message;
        els.toast.className = `toast show ${type}`;
        toastTimer = setTimeout(() => {
            els.toast.className = 'toast';
        }, 2600);
    }

    function saveQueue(options = {}) {
        localStorage.setItem(storage.queue, JSON.stringify(state.queue.slice(0, USER_SYNC_LIMITS.queue)));
        if (!options.skipCloudSync) scheduleCloudSync();
    }

    function readLocalValue(key, legacyKey) {
        const value = localStorage.getItem(key);
        if (value !== null) return value;
        for (const candidate of flattenKeys(legacyKey)) {
            const legacyValue = localStorage.getItem(candidate);
            if (legacyValue !== null) {
                localStorage.setItem(key, legacyValue);
                return legacyValue;
            }
        }
        return null;
    }

    function removeLocalKeys(...keys) {
        for (const key of flattenKeys(keys)) {
            localStorage.removeItem(key);
        }
    }

    function flattenKeys(keys) {
        if (!keys) return [];
        return Array.isArray(keys) ? keys.flatMap(flattenKeys) : [keys];
    }

    async function readPersistedAuthState() {
        try {
            if (!window.electronAPI?.getAuthState) return {};
            const value = await window.electronAPI.getAuthState();
            if (!value || typeof value !== 'object') return {};
            return {
                token: typeof value.token === 'string' ? value.token : '',
                userId: value.userId ? String(value.userId) : ''
            };
        } catch {
            return {};
        }
    }

    function persistAuthState(authState) {
        try {
            if (window.electronAPI?.setAuthState) window.electronAPI.setAuthState(authState);
        } catch {
            // 浏览器调试环境没有 Electron 存储时继续使用 localStorage。
        }
    }

    function clearPersistedAuthState() {
        try {
            if (window.electronAPI?.clearAuthState) window.electronAPI.clearAuthState();
        } catch {
            // 浏览器调试环境没有 Electron 存储时无需处理。
        }
    }

    function readJson(key, fallback, legacyKey) {
        try {
            const value = JSON.parse(readLocalValue(key, legacyKey) || '');
            return value ?? fallback;
        } catch {
            return fallback;
        }
    }
})();
