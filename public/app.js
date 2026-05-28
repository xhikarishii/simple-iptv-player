let player;
let uiControls;
let allChannelsData = [];
let currentFilteredChannels = [];
let allPlaylists = [];
let dynamicSecretKey = null;
let lastPlayedUrl = null;
let lastPlayedKey = null;
let currentUserId = null;
let epgDataCache = {}; // Cache for parsed EPG data
let epgUpdateInterval = null;
let overlayIdleTimer = null;
let channelOverlayIndex = 0;
let epgChannelIndex = 0; // Vertical row selection
let epgProgramIndex = 0; // Horizontal card selection
let playerClickTimer = null;
let globalSettings = {};
let aspectRatioIndex = 0;
const aspectRatios = [
    { label: 'Source', fit: 'contain', ratio: 'auto' },
    { label: '16:9', fit: 'fill', ratio: '16/9' },
    { label: '4:3', fit: 'fill', ratio: '4/3' },
    { label: 'Fill', fit: 'fill', ratio: 'auto' }
];

// --- TOKEN REFRESH ---

function parseJwtPayload(token) {
    try {
        return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) { return null; }
}

let _refreshTimer = null;

function scheduleTokenRefresh(token) {
    if (_refreshTimer) clearTimeout(_refreshTimer);

    const payload = parseJwtPayload(token);
    if (!payload || !payload.exp) return;

    // Refresh 1 hour before the token expires
    const refreshAt = (payload.exp * 1000) - (60 * 60 * 1000);
    const delay = Math.max(0, refreshAt - Date.now());

    _refreshTimer = setTimeout(silentRefreshToken, delay);
}

async function silentRefreshToken() {
    const inLocal = !!localStorage.getItem('jwtToken');
    const currentToken = localStorage.getItem('jwtToken') || sessionStorage.getItem('jwtToken');
    if (!currentToken) return;

    try {
        const res = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });

        if (!res.ok) { showLogin(); return; }

        const { token: newToken } = await res.json();

        // Store in the same place as the original
        if (inLocal) localStorage.setItem('jwtToken', newToken);
        else sessionStorage.setItem('jwtToken', newToken);

        // Update the derived client key with the new token
        const checkRes = await fetch('/api/auth/check', {
            headers: { 'Authorization': `Bearer ${newToken}` }
        });
        if (checkRes.ok) {
            const checkData = await checkRes.json();
            dynamicSecretKey = checkData.clientKey;
        }

        // Schedule the next refresh cycle
        scheduleTokenRefresh(newToken);
    } catch (e) {
        console.error('Silent token refresh failed:', e);
    }
}

async function verify() {
    // Phase 1: early UA-only detection — applies TV mode to the login screen
    // before any settings are fetched. No layoutMode override is available yet.
    detectTvMode();

    const token = sessionStorage.getItem('jwtToken') || localStorage.getItem('jwtToken');
    if (!token) return showLogin();

    try {
        const res = await fetch('/api/auth/check', { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) {
            const data = await res.json();

            toggleAppLoader(true);

            // 1. Set global session data FIRST
            dynamicSecretKey = data.clientKey;
            currentUserId = String(data.id);

            // Update desktop header elements
            document.getElementById('currentUserDisplay').innerHTML = `<i class="fi fi-rr-user" style="font-size:0.9rem;"></i> ${data.username}`; // Desktop
            document.getElementById('adminLink').style.display = data.role === 'admin' ? 'inline-block' : 'none'; // Desktop

            // Update mobile header elements
            document.getElementById('mobileUserDisplay').innerHTML = `<i class="fi fi-rr-user" style="font-size:0.9rem;"></i> ${data.username}`;
            document.getElementById('mobileAdminLink').style.display = data.role === 'admin' ? 'block' : 'none';

            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('playerUI').style.display = 'grid';

            // 1.5 Fetch global settings
            try {
                const settingsRes = await fetch('/api/settings', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                globalSettings = await settingsRes.json();

                // IMMEDIATELY enforce security policies before proceeding
                if (globalSettings.debugMode !== 'true') {
                    if (checkDevTools()) return; // checkDevTools handles triggerSecurityViolation
                }
            } catch (e) {
                console.error("Error loading settings:", e);
            }

            // 1.6 Phase 2: re-run detection now that layoutMode from settings is known.
            // This enforces "Always TV" / "Always Browser" overrides if configured.
            detectTvMode();

            // 1.7 Load local preferences (like aspect ratio)
            loadLocalPreferences();

            // 2. Start the player engine (Note: initApp no longer calls loadPlaylists internally)
            await initApp();

            // 3. Load data and trigger the resume logic (epg loading happens inside)
            await loadPlaylists();

            toggleAppLoader(false);

            // 4. Schedule silent token refresh — keeps the session alive without re-login
            scheduleTokenRefresh(token);
        } else if (res.status === 401 || res.status === 403) {
            showLogin();
        } else {
            console.error('Server error during auth check');
            const loader = document.getElementById('appLoader');
            if (loader) loader.innerHTML = "<h3 style='color:red;'>Server Error. Please refresh.</h3>";
        }
    } catch (e) {
        console.error('Network error during auth check', e);
        const loader = document.getElementById('appLoader');
        if (loader) loader.innerHTML = "<h3 style='color:red;'>Network Error. Please refresh.</h3>";
    }
}

function showLogin() {
    localStorage.removeItem('jwtToken');
    sessionStorage.removeItem('jwtToken');
    const playerUI = document.getElementById('playerUI');
    if (playerUI) {
        playerUI.style.display = 'none';
        playerUI.style.filter = '';
        playerUI.style.pointerEvents = 'auto';
    }
    toggleAppLoader(false);

    document.getElementById('loginModal').style.display = 'flex';

    const noPlaylistModal = document.getElementById('noPlaylistModal');
    if (noPlaylistModal) noPlaylistModal.style.display = 'none';

    if (typeof player !== 'undefined' && player) {
        player.unload(); // Instantly kills the active stream and audio
    }

    if (epgUpdateInterval) clearInterval(epgUpdateInterval);

    // Wipe sensitive data and reset state
    allChannelsData = [];
    dynamicSecretKey = null;
    lastPlayedUrl = null;
    lastPlayedKey = null;

    // Clear the sidebar UI so the next user doesn't see a ghost playlist
    const playlistEl = document.getElementById('playlist');
    if (playlistEl) playlistEl.innerHTML = '';
}

function logout() {
    showLogin();
}

async function submitLogin() {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const rememberMe = document.getElementById('loginRemember').checked;
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            username,
            password
        })
    });
    if (res.ok) {
        const data = await res.json();
        toggleAppLoader(true);
        if (rememberMe) {
            localStorage.setItem('jwtToken', data.token);
            sessionStorage.removeItem('jwtToken');
        } else {
            sessionStorage.setItem('jwtToken', data.token);
            localStorage.removeItem('jwtToken');
        }
        verify();
    } else {
        document.getElementById('loginResult').innerText = 'Invalid credentials';
    }
}

/**
 * Returns a Shaka Player configuration object optimized for the selected profile.
 */
function getShakaConfiguration(profile) {
    const config = {
        streaming: {
            jumpLargeGaps: true,
            smallGapLimit: 0.5,
            jumpSmallGaps: true,
            durationBackoff: 1,
            stallEnabled: true,
            stallThreshold: 0.3,
            stallSkip: 0.1,
            lowLatencyMode: false,
            inaccurateManifestTolerance: 10,
            retryParameters: {
                maxAttempts: 4,
                baseDelay: 500,
                backoffFactor: 1.3,
                fuzzFactor: 0.3,
                timeout: 10000,
            }
        },
        manifest: {
            retryParameters: {
                maxAttempts: 4,
                baseDelay: 300,
                backoffFactor: 1.3,
                fuzzFactor: 0.3,
                timeout: 10000,
            },
            ignoreDrmInfo: false,
            defaultPresentationDelay: 2,
            dash: {
                ignoreMinBufferTime: true,
                autoCorrectDrift: true,
                ignoreSuggestedPresentationDelay: true,
                enableFastSwitching: true,
            }
        },
        abr: {
            enabled: true,
            defaultBandwidthEstimate: 1000000,
            bandwidthUpgradeTarget: 0.85,
            bandwidthDowngradeTarget: 0.90,
            switchInterval: 3,
            restrictions: { minBandwidth: 0 }
        }
    };

    switch (profile) {
        case 'adaptive': // Low Latency + Fast ABR
            config.streaming.bufferingGoal = 2;
            config.streaming.rebufferingGoal = 0.5;
            config.streaming.liveSync = {
                enabled: true,
                targetLatency: 3,
                targetLatencyTolerance: 0.5,
                maxPlaybackRate: 1.1,
                minPlaybackRate: 0.95,
            };
            config.streaming.retryParameters.timeout = 5000;
            config.manifest.defaultPresentationDelay = 1.5;
            config.abr.switchInterval = 1;
            config.abr.bandwidthUpgradeTarget = 0.90;
            break;

        case 'highest': // Quality Optimization — Forced Highest Resolution
            config.streaming.bufferingGoal = 60; // Max buffer for stability
            config.streaming.rebufferingGoal = 20;
            config.abr.enabled = false; // Disable ABR to prevent downscaling
            config.manifest.defaultPresentationDelay = 20;
            break;

        case 'stability': // Stability Optimization for far/unstable servers
            config.streaming.bufferingGoal = 45; // 45 seconds of buffer
            config.streaming.rebufferingGoal = 15;
            config.streaming.liveSync = { enabled: false };
            config.streaming.retryParameters.maxAttempts = 15;
            config.streaming.retryParameters.timeout = 30000;
            config.manifest.retryParameters.maxAttempts = 15;
            config.manifest.retryParameters.timeout = 30000;
            config.abr.defaultBandwidthEstimate = 500000; // Start at 500kbps
            config.abr.bandwidthUpgradeTarget = 0.70; // Be very careful about upgrading
            config.abr.bandwidthDowngradeTarget = 0.98; // Drop fast if speed dips
            config.manifest.defaultPresentationDelay = 15;
            break;

        case 'auto':
        default: // Balanced
            config.streaming.bufferingGoal = 6;
            config.streaming.rebufferingGoal = 2;
            config.streaming.liveSync = {
                enabled: true,
                targetLatency: 5,
                targetLatencyTolerance: 1.5,
                maxPlaybackRate: 1.1,
                minPlaybackRate: 0.9,
            };
            break;
    }

    return config;
}

async function initApp() {
    shaka.polyfill.installAll();
    if (shaka.Player.isBrowserSupported()) {
        const video = document.getElementById('video');
        player = new shaka.Player(video);

        // Apply saved aspect ratio immediately
        applyAspectRatio();

        // Apply dynamic configuration based on global settings
        const shakaProfile = globalSettings.shakaConfig || 'auto';
        player.configure(getShakaConfiguration(shakaProfile));

        player.addEventListener('trackschanged', populateTracks);
        // Update resolution badge whenever ABR switches quality mid-stream
        player.addEventListener('adaptation', updateResolutionBadge);
        video.addEventListener('resize', updateResolutionBadge);

        video.addEventListener('play', () => document.getElementById('btnPlayPause').innerHTML = '<i class="fi fi-sr-pause"></i>');
        video.addEventListener('pause', () => document.getElementById('btnPlayPause').innerHTML = '<i class="fi fi-sr-play"></i>');
        video.addEventListener('volumechange', () => document.getElementById('btnMute').innerHTML = video.muted || video.volume === 0 ? '<i class="fi fi-sr-volume-mute"></i>' : '<i class="fi fi-sr-volume"></i>');

        // Upgraded CORS Proxy Filter (Handles HTTP Mixed Content & Root-Relative Paths)
        let currentUpstreamProtocol = '';
        let currentUpstreamHost = '';

        player.getNetworkingEngine().registerRequestFilter((type, request) => {
            const url = request.uris[0];
            if (!url) return;

            // 1. External URLs (The Mixed Content Fixer & UA Spoofing)
            // NEVER proxy a URL that is already proxied or belongs to our own host
            const isProxied = url.includes('/proxy/') || url.includes(window.location.host);
            const isExternal = (url.startsWith('http://') || url.startsWith('https://')) && !isProxied;
            const isHostInsecure = window.location.protocol === 'http:';

            // We MUST use the proxy if:
            // a) It's HTTP (to avoid Mixed Content blocks on HTTPS sites)
            // b) We are on an HTTP host (to avoid CORS issues with HTTPS streams)
            // c) We have a custom User-Agent to spoof (browsers won't let us spoof UA directly on cross-origin requests)
            const proxyHttps = globalSettings.proxyHttps !== 'false'; // Default to true
            const shouldProxy = url.startsWith('http://') || (url.startsWith('https://') && proxyHttps && isExternal && (globalSettings.userAgent || isHostInsecure));

            if (shouldProxy && isExternal) {
                // Save the upstream destination to fix broken relative paths later
                try {
                    const urlObj = new URL(url);
                    currentUpstreamProtocol = urlObj.protocol.replace(':', '');
                    currentUpstreamHost = urlObj.host;
                } catch (e) { }

                // Construct the proxied URL
                let proxiedUrl = window.location.origin + '/proxy/' + url;

                // Append the User-Agent as a query parameter for the Nginx proxy to consume
                // ONLY if it's not already there
                if (globalSettings.userAgent && !proxiedUrl.includes('ua=')) {
                    proxiedUrl += (proxiedUrl.includes('?') ? '&' : '?') + 'ua=' + encodeURIComponent(globalSettings.userAgent);
                }

                request.uris[0] = proxiedUrl;
            }

            // 2. Root-Relative Path Fixer
            // If the browser accidentally resolved a path against our player's root domain
            else if (url.startsWith(window.location.origin) && !url.includes('/proxy/') && !url.includes('/api/')) {
                if (currentUpstreamHost) {
                    const brokenPath = url.replace(window.location.origin, '');
                    // Reconstruct the proper proxy URL using the saved upstream host
                    let proxiedUrl = window.location.origin + '/proxy/' + currentUpstreamProtocol + '://' + currentUpstreamHost + brokenPath;

                    if (globalSettings.userAgent) {
                        proxiedUrl += (proxiedUrl.includes('?') ? '&' : '?') + 'ua=' + encodeURIComponent(globalSettings.userAgent);
                    }
                    request.uris[0] = proxiedUrl;
                }
            }
        });

        // Note: playback errors are handled inside playChannel's retry loop — not here.
    }
}

/**
 * Shows the Now Playing overlay and resets the auto-hide timer.
 */
function resetOverlayIdleTimer() {
    const overlay = document.getElementById('nowPlayingOverlay');
    if (!overlay) return;

    overlay.classList.add('active');
    if (overlayIdleTimer) clearTimeout(overlayIdleTimer);

    overlayIdleTimer = setTimeout(() => {
        overlay.classList.remove('active');
    }, 5000); // Hide after 5 seconds of inactivity
}

// Keep overlay visible while mouse is moving in normal browser mode
document.addEventListener('DOMContentLoaded', () => {
    const playerArea = document.querySelector('.player-area');
    if (!playerArea) return;

    // Only reset the idle timer on mouse movement — no click/tap interception
    playerArea.addEventListener('mousemove', () => {
        if (!document.body.classList.contains('tv-mode')) resetOverlayIdleTimer();
    });
});

function decryptPayload(encryptedPayload) {
    if (!dynamicSecretKey) throw new Error("Encryption key not loaded");
    const parts = encryptedPayload.split(':');
    const iv = CryptoJS.enc.Hex.parse(parts[0]);
    const encrypted = CryptoJS.enc.Hex.parse(parts[1]);
    const key = CryptoJS.SHA256(dynamicSecretKey);
    const cipherParams = CryptoJS.lib.CipherParams.create({
        ciphertext: encrypted
    });
    const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
        iv: iv,
        format: CryptoJS.format.OpenSSL
    });
    return JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
}

async function loadPlaylists() {
    try {
        const res = await fetch('/api/playlists', {
            headers: { 'Authorization': `Bearer ${sessionStorage.getItem('jwtToken') || localStorage.getItem('jwtToken')}` }
        });
        const data = await res.json();

        if (data.payload) {
            allPlaylists = decryptPayload(data.payload);

            // Block initialization until all EPG data is loaded and parsed
            await loadAllEpgData(allPlaylists);

            // Refresh UI components that depend on EPG data
            if (lastPlayedUrl) updateNowPlayingEPG(true);
        }

        const playlistSelector = document.getElementById('playlistSelector');
        if (playlistSelector && allPlaylists.length > 0) {
            playlistSelector.innerHTML = allPlaylists.map((p, i) =>
                `<option value="${i}">${p.name}</option>`
            ).join('');

            renderCurrentPlaylist();

            // --- THE FIX: ADD A SETTLE DELAY FOR AUTOPLAY ---
            setTimeout(() => {
                const savedUrl = localStorage.getItem(`lastChannel_${currentUserId}`);
                const savedKey = localStorage.getItem(`lastKey_${currentUserId}`);

                let foundChannel = null;
                let foundPlaylistIndex = 0;

                allPlaylists.forEach((pl, idx) => {
                    const match = pl.channels.find(c => c.url === savedUrl);
                    if (match) {
                        foundChannel = match;
                        foundPlaylistIndex = idx;
                    }
                });

                if (foundChannel) {
                    playlistSelector.value = foundPlaylistIndex;
                    renderCurrentPlaylist();
                    playChannel(foundChannel.url, savedKey, true);
                } else if (allPlaylists[0].channels.length > 0) {
                    const first = allPlaylists[0].channels[0];
                    playChannel(first.url, first.key ? encodeURIComponent(first.key) : '', true);
                }
            }, 800); // 800ms delay gives the proxy and Shaka time to breathe
        } else {
            const modal = document.getElementById('noPlaylistModal');
            if (modal) {
                modal.style.display = 'flex';
                document.getElementById('playerUI').style.filter = 'blur(10px)';
                document.getElementById('playerUI').style.pointerEvents = 'none';
            }
        }
    } catch (e) {
        console.error("Load error:", e);
    }
}

/**
 * Parses XMLTV date format (YYYYMMDDHHMMSS [+-]HHMM) into a JS Date object
 */
function parseXmltvDate(dateStr) {
    if (!dateStr) return null;
    // Regex: YYYYMMDDHHMMSS (optional seconds) (optional timezone offset)
    const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-]\d{2,4}))?$/);
    if (match) {
        const [_, y, m, d, h, min, s, tz] = match;
        let iso = `${y}-${m}-${d}T${h}:${min}:${s || '00'}`;

        if (tz) {
            const formattedTz = tz.length === 3 ? tz + ":00" : tz.slice(0, 3) + ":" + tz.slice(3);
            iso += formattedTz;
        } else {
            // If no timezone, assume UTC to avoid local timezone issues
            iso += 'Z'; // Or could assume local, but UTC is safer for consistent comparison
        }

        const date = new Date(iso);
        return isNaN(date.getTime()) ? null : date;
    }
    return null;
}

/**
 * Maps Shaka Player error codes and categories to user-friendly messages.
 */
function getFriendlyErrorMessage(error) {
    if (!error) return "An unknown error occurred.";

    // Handle Shaka Player specific errors
    if (error instanceof shaka.util.Error || (error.category !== undefined && error.code !== undefined)) {
        if (error.category === shaka.util.Error.Category.NETWORK) {
            if (error.code === 1001) return "Network Error: The stream URL is unreachable (HTTP 404/500) or proxy is down.";
            if (error.code === 1002) return "Network Error: The request timed out. The server might be too slow.";
            return "Network Error: The stream could not be reached. Please check your internet connection or proxy settings.";
        }
        if (error.category === shaka.util.Error.Category.DRM) {
            if (error.code === 6001) return "Security Error: This encrypted stream requires a secure (HTTPS) connection to play.";
            if (error.code === 6007) return "DRM Error: The hardware does not support the required protection level.";
            return `DRM Error: The license for this encrypted stream could not be acquired. (Code: ${error.code})`;
        }
        if (error.category === shaka.util.Error.Category.MANIFEST) {
            if (error.code === 4000) return "Format Error: The playlist manifest is empty or invalid.";
            return "Format Error: The playlist manifest contains unsupported stream formats or is corrupted.";
        }
        if (error.category === shaka.util.Error.Category.STREAMING) {
            return "Streaming Error: The connection was lost while segmenting the video data.";
        }
        if (error.category === shaka.util.Error.Category.PLAYER) {
            if (error.code === 3016) return "Playback Error: The browser lacks the required decoders for this video format.";
            return `Player Error: A critical internal error occurred. (Code: ${error.code})`;
        }
        return `Playback Error: ${error.message || 'An unexpected issue occurred.'} (Code: ${error.code})`;
    }

    // Handle generic Javascript errors
    return error.message || "An unexpected playback error occurred.";
}

/**
 * Formats a Date object to HH:MM
 */
function formatTime(date) {
    if (!date) return '--:--';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function loadAllEpgData(playlists) {
    const uniqueEpgUrls = [...new Set(playlists.flatMap(p => p.epg ? p.epg.split(',').map(u => u.trim()).filter(Boolean) : []))];
    const parser = new DOMParser();

    for (const epgUrl of uniqueEpgUrls) {
        if (epgDataCache[epgUrl]) continue; // Already loaded

        try {
            // Always proxy EPG requests — external EPG servers don't send CORS headers,
            // so both http:// and https:// URLs will fail without the proxy.
            const isExternal = epgUrl.startsWith('http://') || epgUrl.startsWith('https://');
            let proxiedEpgUrl = isExternal
                ? window.location.origin + '/proxy/' + epgUrl
                : epgUrl;

            // Append User-Agent if proxied
            if (isExternal && globalSettings.userAgent) {
                proxiedEpgUrl += (proxiedEpgUrl.includes('?') ? '&' : '?') + 'ua=' + encodeURIComponent(globalSettings.userAgent);
            }

            const res = await fetch(proxiedEpgUrl);
            if (!res.ok) throw new Error(`Failed to fetch EPG from ${epgUrl}`);

            const buffer = await res.arrayBuffer();
            let xmlText;

            if (epgUrl.endsWith('.gz')) {
                try {
                    const decompressed = pako.ungzip(new Uint8Array(buffer));
                    xmlText = new TextDecoder().decode(decompressed);
                } catch (err) {
                    console.warn(`Pako decompression failed for ${epgUrl}, attempting to read as plain text.`, err);
                    xmlText = new TextDecoder().decode(buffer);
                }
            } else {
                xmlText = new TextDecoder().decode(buffer);
            }

            const xmlDoc = parser.parseFromString(xmlText, "text/xml");
            const programmes = xmlDoc.getElementsByTagName('programme');

            const parsedEpg = {};

            // Populate programmes using the 'channel' attribute which maps to our epgId
            for (let i = 0; i < programmes.length; i++) {
                const programme = programmes[i];
                const channelId = programme.getAttribute('channel');
                if (!channelId) continue;

                if (!parsedEpg[channelId]) parsedEpg[channelId] = [];

                const start = parseXmltvDate(programme.getAttribute('start'));
                const stop = parseXmltvDate(programme.getAttribute('stop'));
                const title = programme.getElementsByTagName('title')[0]?.textContent || 'No Title';
                const desc = programme.getElementsByTagName('desc')[0]?.textContent || '';

                parsedEpg[channelId].push({ start, stop, title, desc });
            }
            epgDataCache[epgUrl] = parsedEpg;
        } catch (e) {
            console.error(`Error loading or parsing EPG from ${epgUrl}:`, e);
        }
    }
}

function getProgramForChannel(epgId, epgUrlString) {
    if (!epgId || !epgUrlString) return null;
    const now = new Date();
    const urls = epgUrlString ? epgUrlString.split(',').map(u => u.trim()).filter(Boolean) : [];

    for (const url of urls) {
        const cache = epgDataCache[url];
        if (!cache) continue;

        // Try case-insensitive lookup
        const cacheKey = Object.keys(cache).find(k => k.trim().toLowerCase() === String(epgId).trim().toLowerCase());
        const channelEpg = cacheKey ? cache[cacheKey] : null;

        if (channelEpg) {
            for (const program of channelEpg) {
                if (program.start && program.stop && now >= program.start && now < program.stop) {
                    return program;
                }
            }
        }
    }
    return null;
}

function updateNowPlayingEPG(isInitialLoad = false) {
    if (!lastPlayedUrl) return;

    let match = null;
    let playlistEpg = '';
    for (const pl of allPlaylists) {
        match = pl.channels.find(c => c.url === lastPlayedUrl);
        if (match) {
            playlistEpg = pl.epg;
            break;
        }
    }

    if (!match) return;

    const program = getProgramForChannel(match.epgId, playlistEpg);
    const programInfo = document.getElementById('nowPlayingProgram');
    const progressContainer = document.getElementById('programProgressContainer');
    const overlay = document.getElementById('nowPlayingOverlay');

    if (programInfo) {
        const oldTitle = programInfo.dataset.currentTitle || '';
        const newTitle = program ? program.title : 'No Program Information';

        if (program) {
            programInfo.innerHTML = `<i class="fi fi-rr-broadcast" style="color:var(--primary);"></i> ${program.title}`;
            programInfo.classList.remove('no-program');
            if (progressContainer) {
                const now = new Date();
                const pct = Math.min(Math.max(((now - program.start) / (program.stop - program.start)) * 100, 0), 100);
                document.getElementById('programProgressFill').style.width = pct + '%';
                document.getElementById('programStartTime').innerText = formatTime(program.start);
                document.getElementById('programEndTime').innerText = formatTime(program.stop);
                progressContainer.style.display = 'block';
            }
        } else {
            programInfo.innerText = 'No Program Information';
            programInfo.classList.add('no-program');
            if (progressContainer) progressContainer.style.display = 'none';
        }

        // Detect program change and show overlay briefly
        if (!isInitialLoad && oldTitle && oldTitle !== newTitle && overlay) {
            overlay.classList.add('show-temporary');
            if (overlay.dataset.timeoutId) clearTimeout(overlay.dataset.timeoutId);
            overlay.dataset.timeoutId = setTimeout(() => {
                overlay.classList.remove('show-temporary');
            }, 10000);
        }
        programInfo.dataset.currentTitle = newTitle;
    }
}

function renderCurrentPlaylist() {
    const index = document.getElementById('playlistSelector').value;
    const selected = allPlaylists[index];
    if (!selected) return;

    document.getElementById('channelSearch').value = '';
    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';

    const categories = [...new Set(selected.channels.map(c => c.cat || 'Uncategorized'))];
    document.getElementById('categoryFilter').innerHTML = '<option value="all">All Categories</option>' +
        categories.map(c => `<option value="${c}">${c}</option>`).join('');

    renderChannels(selected.channels);
}

function switchPlaylist() {
    const selector = document.getElementById('playlistSelector');
    if (!selector || allPlaylists.length === 0) return;

    document.getElementById('channelSearch').value = '';
    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';

    const index = selector.value;
    const selectedPlaylist = allPlaylists[index];
    const channels = selectedPlaylist.channels || [];

    // Render Categories
    const categories = [...new Set(channels.map(c => c.cat || 'Uncategorized'))];
    document.getElementById('categoryFilter').innerHTML = '<option value="all">All Categories</option>' +
        categories.map(c => `<option value="${c}">${c}</option>`).join('');

    renderChannels(channels);

    // --- ENHANCED RESUME LOGIC ---
    const savedUrl = localStorage.getItem(`lastChannel_${currentUserId}`);
    const savedKey = localStorage.getItem(`lastKey_${currentUserId}`);

    // Check if the saved channel actually exists in THIS playlist
    const resumeChannel = channels.find(c => c.url === savedUrl);

    if (resumeChannel) {
        playChannel(resumeChannel.url, savedKey);
    } else if (channels.length > 0) {
        // Only autoplay first channel if we HAVEN'T already started playing something
        // (Prevents the first channel from overriding a resume in progress)
        if (!player.getAssetUri()) {
            const first = channels[0];
            playChannel(first.url, first.key ? encodeURIComponent(first.key) : '');
        }
    }
}

function filterChannels() {
    const playlistIndex = document.getElementById('playlistSelector').value;
    const selectedCat = document.getElementById('categoryFilter').value;
    const searchQuery = document.getElementById('channelSearch').value.toLowerCase();
    const channels = allPlaylists[playlistIndex].channels || [];

    // Show/hide the clear button based on search input length
    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) {
        clearBtn.style.display = searchQuery.length > 0 ? 'block' : 'none';
    }

    const filtered = channels.filter(c => {
        const matchesCat = selectedCat === 'all' || (c.cat || 'Uncategorized') === selectedCat;
        const matchesSearch = c.name.toLowerCase().includes(searchQuery);
        return matchesCat && matchesSearch;
    });

    renderChannels(filtered);
}

function clearSearch() {
    const searchInput = document.getElementById('channelSearch');
    searchInput.value = '';
    filterChannels();
    searchInput.focus();
}

function renderChannels(channels) {
    currentFilteredChannels = channels; // Track for TV mode navigation
    const listElement = document.getElementById('playlist');
    if (!listElement) return;

    const playlistIndex = document.getElementById('playlistSelector').value;
    const epgUrl = allPlaylists[playlistIndex]?.epg || '';

    listElement.innerHTML = channels.map(channel => {
        const keyStr = channel.key ? encodeURIComponent(channel.key) : '';
        const logo = channel.logo || 'https://via.placeholder.com/54/1e293b/ffffff?text=TV';

        const program = getProgramForChannel(channel.epgId, epgUrl);
        const programHtml = program ? `<span class="channel-program">🔴 ${program.title}</span>` : '';

        return `
            <li class="channel-card" onclick="playChannel('${channel.url}', '${keyStr}')">
                <img src="${logo}" class="channel-logo" loading="lazy" onerror="this.onerror=null;this.src='https://via.placeholder.com/54/1e293b/ffffff?text=TV';">
                <div class="channel-meta">
                    <span class="channel-name">${channel.name}</span>
                    ${programHtml}
                    <span class="channel-cat">${channel.cat || 'Uncategorized'}</span>
                </div>
            </li>`;
    }).join('');
}

let loadGeneration = 0; // Incremented on every playChannel call to invalidate stale retries

async function playChannel(url, encodedKeyStr, isAutoplay = false) {
    // Bump the generation so any in-flight retry loops know they're stale
    const myGeneration = ++loadGeneration;

    // Reset the error UI immediately when a new channel is selected
    document.getElementById('videoErrorOverlay').style.display = 'none';

    // Show "Now Showing" for 10 seconds
    const overlay = document.getElementById('nowPlayingOverlay');
    if (overlay) {
        overlay.classList.add('show-temporary');
        if (overlay.dataset.switchTimeout) clearTimeout(overlay.dataset.switchTimeout);
        overlay.dataset.switchTimeout = setTimeout(() => {
            overlay.classList.remove('show-temporary');
        }, 10000);
    }

    lastPlayedUrl = url;
    lastPlayedKey = encodedKeyStr;

    // Ensure persistent aspect ratio is applied to the video element
    applyAspectRatio();

    if (epgUpdateInterval) clearInterval(epgUpdateInterval);

    for (const pl of allPlaylists) {
        const match = pl.channels.find(c => c.url === url);
        if (match) {
            document.getElementById('nowPlayingName').innerText = match.name;
            document.getElementById('nowPlayingCat').innerText = match.cat || 'Uncategorized';
            document.getElementById('nowPlayingLogo').src = match.logo || 'https://via.placeholder.com/54/1e293b/ffffff?text=TV';
            document.getElementById('nowPlayingProgram').dataset.currentTitle = '';
            updateNowPlayingEPG(true);
            epgUpdateInterval = setInterval(updateNowPlayingEPG, 30000);
            break;
        }
    }

    try {
        const video = document.getElementById('video');
        const hint = document.getElementById('unmuteHint');

        if (currentUserId) {
            localStorage.setItem(`lastChannel_${currentUserId}`, url);
            localStorage.setItem(`lastKey_${currentUserId}`, encodedKeyStr || '');
        }

        // Auto-close sidebar on mobile after selection
        const sidebar = document.querySelector('.sidebar');
        if (window.innerWidth <= 1100 && sidebar && sidebar.classList.contains('active')) {
            toggleSidebar();
        }

        // Safely unload — errors here are non-fatal, we just want a clean slate
        try {
            await player.unload();
            player.resetConfiguration();
        } catch (_) { /* ignore unload errors */ }

        // If another channel was selected while we were unloading, abort silently
        if (myGeneration !== loadGeneration) return;

        // Give the browser/TV hardware a moment to release decoder resources
        await new Promise(resolve => setTimeout(resolve, 300));

        // If another channel was selected during the delay, abort silently
        if (myGeneration !== loadGeneration) return;

        // --- DRM SECURITY CHECK ---
        // Browsers block the EME (Encrypted Media Extensions) API in insecure contexts.
        // If the host is HTTP, DRM playback is technically impossible in most modern browsers.
        const isDrm = encodedKeyStr && encodedKeyStr.trim().length > 0;
        if (isDrm && !window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            console.warn("DRM playback detected in insecure context. This will likely fail.");
            const error = new Error("DRM Requires HTTPS: Browsers block encrypted content on insecure hosts. Please access the player via HTTPS.");
            error.category = shaka.util.Error.Category.DRM;
            error.code = 6001; // INSECURE_CONTEXT
            throw error;
        }

        const keyString = encodedKeyStr ? decodeURIComponent(encodedKeyStr).trim() : null;
        if (keyString) {
            if (keyString.startsWith('http')) {
                player.configure({ drm: { servers: { 'org.w3.clearkey': keyString } } });
            } else if (keyString.includes(':')) {
                const [keyId, keyVal] = keyString.split(':');
                player.configure({ drm: { clearKeys: { [keyId.trim()]: keyVal.trim() } } });
            }
        }

        // Retry loop — up to 5 attempts with a 1.5s delay between each
        const MAX_RETRIES = 5;
        let attempts = 0;
        let success = false;
        const errorOverlay = document.getElementById('videoErrorOverlay');
        const errorTitle = document.getElementById('errorTitle');
        const errorDescription = document.getElementById('errorDescription');

        while (attempts < MAX_RETRIES && !success) {
            // Abort if user switched to a different channel mid-retry
            if (myGeneration !== loadGeneration) return;

            try {
                let loadUrl = url;
                if (url.toLowerCase().split('?')[0].endsWith('.ts')) {
                    const res = await fetch(`/api/stream/hls?url=${encodeURIComponent(url)}`);
                    if (!res.ok) {
                        const errText = await res.text();
                        throw new Error(`TS Transmuxing failed: ${errText}`);
                    }
                    const data = await res.json();
                    loadUrl = data.url;
                }

                await player.load(loadUrl);
                // If the user has selected the 'highest' profile, we disable ABR and manually
                // select the variant with the highest bandwidth.
                if (globalSettings.shakaConfig === 'highest') {
                    const variantTracks = player.getVariantTracks();
                    if (variantTracks.length > 0) {
                        // Sort by bandwidth descending and select the top one
                        variantTracks.sort((a, b) => b.bandwidth - a.bandwidth);
                        player.selectVariantTrack(variantTracks[0], true);
                    }
                }

                // Abort if user switched to a different channel while loading
                if (myGeneration !== loadGeneration) return;
                success = true;

                // --- INITIAL BUFFER DELAY ---
                // For the 'highest' quality profile, we wait a few seconds before starting
                // playback to ensure a healthy initial buffer is established.
                if (globalSettings.shakaConfig === 'highest') {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }

                errorOverlay.style.display = 'none';
            } catch (e) {
                // A new channel was loaded — this load was cancelled intentionally
                if (e.code === shaka.util.Error.Code.LOAD_INTERRUPTED) return;

                // Abort stale retry if another channel was selected
                if (myGeneration !== loadGeneration) return;

                attempts++;

                if (attempts >= MAX_RETRIES) {
                    console.error("Stream load exhausted all retries:", e);
                    throw e; // Exhausted — surface the real error
                }

                // Show a non-alarming "connecting" message during retries
                errorTitle.innerText = `Connecting\u2026 (${attempts}/${MAX_RETRIES})`;
                errorDescription.innerText = `Stream connection attempt failed. Retrying...`;
                errorOverlay.style.display = 'flex';
                const retryBtn = document.querySelector('#videoErrorOverlay .btn-retry');
                if (retryBtn) retryBtn.style.display = 'none';

                await new Promise(r => setTimeout(r, 2000)); // Slightly longer delay to give network/proxy time to recover
            }
        }

        // Standard browsers require a user gesture for audio.
        if (isAutoplay) {
            video.muted = true;
            await video.play();
            hint.style.display = 'flex';
        } else {
            video.muted = false;
            try {
                await video.play();
                hint.style.display = 'none';
            } catch (e) {
                video.muted = true;
                await video.play();
                hint.style.display = 'flex';
            }
        }

    } catch (e) {
        // Don't show an error for a channel we've already moved away from
        if (myGeneration !== loadGeneration) return;

        if (e.code !== shaka.util.Error.Code.LOAD_INTERRUPTED) {
            const retryBtn = document.querySelector('#videoErrorOverlay .btn-retry');
            if (retryBtn) retryBtn.style.display = 'inline-block';
            handlePlaybackError(e);
        }
    }
}

function handlePlaybackError(error) {
    const overlay = document.getElementById('videoErrorOverlay');
    document.getElementById('errorTitle').innerText = "Unable to Connect";
    document.getElementById('errorDescription').innerText = getFriendlyErrorMessage(error);
    overlay.style.display = 'flex';
}

function retryLastChannel() {
    if (lastPlayedUrl) playChannel(lastPlayedUrl, lastPlayedKey);
}

function unmuteVideo() {
    const video = document.getElementById('video');
    video.muted = false;
    video.volume = 1.0;
    document.getElementById('unmuteHint').style.display = 'none';
}

function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const btn = document.getElementById('mobileMenuBtn');
    if (!sidebar || !btn) return;
    const isActive = sidebar.classList.toggle('active');
    btn.innerHTML = isActive ? '<i class="fi fi-rr-cross-small"></i> Close' : '<i class="fi fi-rr-list"></i> Channels';

    // Prevent background scrolling and reveal issues on mobile
    document.body.style.overflow = isActive ? 'hidden' : '';
}

function detectTvMode() {
    const layoutMode = globalSettings.layoutMode || 'autodetect';

    // Hard overrides — respect admin setting
    if (layoutMode === 'tv') {
        toggleTvMode(true);
        return;
    }
    if (layoutMode === 'browser') {
        return;
    }

    // --- Auto-detect mode: fingerprint the User-Agent ---
    const ua = navigator.userAgent;

    // 0. Guard: if the UA clearly belongs to a desktop or mobile OS, bail out immediately.
    //    This prevents any of the heuristics below from causing false positives on Chrome,
    //    Firefox, Edge, or Safari running on a normal computer or phone.
    const isDefinitelyDesktopOrMobile =
        /Windows NT/i.test(ua) ||          // Windows desktop
        /Macintosh|Mac OS X/i.test(ua) ||  // macOS desktop (includes Safari on Mac)
        /\(iPhone/i.test(ua) ||            // iPhone
        /\(iPad/i.test(ua) ||              // iPad
        /iPod/i.test(ua) ||               // iPod
        // Android without any TV markers = phone/tablet
        (/Android/i.test(ua) && !/TV|Box|AFT|Nexus Player/i.test(ua));

    if (isDefinitelyDesktopOrMobile) return;

    // 1. Authoritative TV/STB platform strings — highly specific, very low false-positive rate
    const tvMarkers = new RegExp([
        'Tizen',                          // Samsung Smart TV
        'WebOS', 'web0S', 'NetCast',     // LG Smart TV
        'HbbTV',                          // European broadcast standard (all Smart TVs)
        'Android.?TV', 'GoogleTV', 'CrKey', // Android TV / Google TV / Chromecast
        'AFT[A-Z0-9]+', 'FireTV', 'Fire OS', // Amazon Fire TV (all model codes)
        'AppleTV',                        // Apple TV (note: no space — avoids false match on "Apple")
        'Roku/?\\d',                      // Roku (with optional version to avoid matching "Roku" in user-set names)
        'Chromecast',                     // Chromecast
        'SonyBRST|BRAVIA',               // Sony Bravia (specific identifiers)
        'NVIDIA.SHIELD',                  // NVIDIA SHIELD (requires dot, avoids bare "SHIELD")
        'Viera',                          // Panasonic Viera (specific to Panasonic TVs)
        'VIDAA',                          // Hisense VIDAA
        'MiTV|MiBOX|MIBOX3',             // Xiaomi Mi TV / Mi Box
        'TCL\\.TV|SmartTV',              // TCL TV / generic SmartTV marker
        'SMART-TV',                       // Generic Smart TV marker
        'Vestel',                         // Vestel OEM TVs (many European brands)
        'Foxxum',                         // Foxxum (Philips/Grundig/Blaupunkt)
        'Arcelik',                        // Arcelik/Beko
        'Orsay',                          // Old Samsung platform
        'PlayStation [3-5]|PS[3-5]',     // PlayStation consoles (specific, avoids partial matches)
        'Xbox',                           // Xbox (fairly specific in UA strings)
    ].join('|'), 'i');

    // 2. Android on a TV device — model codes or explicit TV marker
    const isAndroidTv = /Android/i.test(ua) && (
        /\bAndroid TV\b/i.test(ua) ||
        /\bGoogle TV\b/i.test(ua) ||
        /Nexus Player/i.test(ua) ||
        /\b(AFTB|AFTM|AFTS|AFTN|AFTT|AFTA|AFTDCT|AFTDCX)\b/i.test(ua) ||
        // Android Box: must say "Box" and NOT have "Mobile" in the UA
        (/\bBox\b/i.test(ua) && !/Mobile/i.test(ua))
    );

    // 3. Tightly constrained generic heuristic — only fire if UA explicitly says STB/IPTV/OTT
    //    AND does not contain any desktop/mobile OS marker
    const isGenericTv =
        /(Set-Top.?Box|SetTopBox|10-foot|IPTV|OTT.?Box)/i.test(ua);

    if (tvMarkers.test(ua) || isAndroidTv || isGenericTv) {
        toggleTvMode(true);
    }
}

function toggleTvMode(force) {
    const isTv = force !== undefined ? force : !document.body.classList.contains('tv-mode');
    document.body.classList.toggle('tv-mode', isTv);
    const btn = document.getElementById('tvModeBtn');
    if (btn) btn.innerText = isTv ? 'Exit TV Mode' : 'TV Mode';

    // Update local state for consistency
    globalSettings.layoutMode = isTv ? 'tv' : 'browser';

    // Persist setting to user profile
    const token = sessionStorage.getItem('jwtToken') || localStorage.getItem('jwtToken');
    if (token) {
        fetch('/api/settings/user', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ layoutMode: globalSettings.layoutMode })
        }).catch(err => console.error('Failed to save TV mode preference:', err));
    }

    // Attempt to unmute automatically when entering TV mode
    if (isTv) unmuteVideo();

}

// --- CUSTOM PLAYER CONTROLS ---

function togglePlayPause() {
    const video = document.getElementById('video');
    if (video.paused) {
        video.play();
    } else {
        video.pause();
    }
}

function toggleMute() {
    const video = document.getElementById('video');
    video.muted = !video.muted;
}

function toggleFullscreen() {
    const wrapper = document.getElementById('videoWrapper');
    if (!document.fullscreenElement) {
        wrapper.requestFullscreen().catch(err => console.error("Error attempting to enable fullscreen:", err));
    } else {
        document.exitFullscreen();
    }
}

function cycleAspectRatio() {
    aspectRatioIndex = (aspectRatioIndex + 1) % aspectRatios.length;
    localStorage.setItem('preferredAspectRatioIndex', aspectRatioIndex);
    applyAspectRatio();
    showRatioIndicator(aspectRatios[aspectRatioIndex].label);
}

function applyAspectRatio() {
    const ratio = aspectRatios[aspectRatioIndex];
    const video = document.getElementById('video');
    const wrapper = document.getElementById('videoWrapper');
    if (!video || !wrapper) return;

    // Measure the actual available space in the wrapper right now
    const wrapperW = wrapper.clientWidth;
    const wrapperH = wrapper.clientHeight;

    // Reset all inline overrides so we start from a clean slate
    video.style.width = '';
    video.style.height = '';
    video.style.maxWidth = '';
    video.style.maxHeight = '';
    video.style.margin = 'auto';
    video.style.objectFit = 'contain';
    video.style.aspectRatio = '';
    video.style.display = 'block';

    if (ratio.label === 'Source') {
        // Let the browser fit the video's native intrinsic dimensions inside the wrapper
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'contain';

    } else if (ratio.label === 'Fill') {
        // Stretch to completely fill the wrapper — may crop if aspect ratios differ
        video.style.width = wrapperW + 'px';
        video.style.height = wrapperH + 'px';
        video.style.objectFit = 'fill';

    } else {
        // Fixed aspect ratio (16:9 or 4:3):
        // Compute the largest box with the target ratio that fits inside the wrapper.
        const [rW, rH] = ratio.ratio.split('/').map(Number);
        const targetRatio = rW / rH;
        const wrapperRatio = wrapperW / wrapperH;

        let vidW, vidH;
        if (wrapperRatio > targetRatio) {
            // Wrapper is wider than the target ratio → constrain by height
            vidH = wrapperH;
            vidW = Math.round(vidH * targetRatio);
        } else {
            // Wrapper is taller than the target ratio → constrain by width
            vidW = wrapperW;
            vidH = Math.round(vidW / targetRatio);
        }

        video.style.width = vidW + 'px';
        video.style.height = vidH + 'px';
        video.style.objectFit = 'fill'; // fill the explicit box we just sized
    }
}

// Re-apply on window resize so ratios stay correct when the user resizes or goes fullscreen
let _ratioResizeObserver = null;
function attachRatioResizeObserver() {
    const wrapper = document.getElementById('videoWrapper');
    if (!wrapper || _ratioResizeObserver) return;
    _ratioResizeObserver = new ResizeObserver(() => {
        // Only re-apply if we're not in Source mode (Source is pure CSS, no pixel math needed)
        if (aspectRatios[aspectRatioIndex].label !== 'Source') {
            applyAspectRatio();
        }
    });
    _ratioResizeObserver.observe(wrapper);
}

function loadLocalPreferences() {
    const savedRatio = localStorage.getItem('preferredAspectRatioIndex');
    if (savedRatio !== null) {
        aspectRatioIndex = parseInt(savedRatio);
    }
    attachRatioResizeObserver();
}


function showRatioIndicator(text) {
    const indicator = document.getElementById('ratioIndicator');
    if (!indicator) return;

    indicator.innerText = text;
    indicator.classList.add('show');

    if (indicator.dataset.timeout) clearTimeout(parseInt(indicator.dataset.timeout));

    const timeout = setTimeout(() => {
        indicator.classList.remove('show');
    }, 2000);

    indicator.dataset.timeout = String(timeout);
}

let currentAudioTracks = [];
let currentSubtitleTracks = [];
let audioTrackIndex = 0;
let subtitleTrackIndex = -1; // -1 means off

function populateTracks() {
    const btnAudio = document.getElementById('btnAudioTrack');
    const btnSubtitle = document.getElementById('btnSubtitleTrack');
    if (!btnAudio || !btnSubtitle) return;

    // Audio Tracks
    const audioTracks = player.getVariantTracks().filter(t => t.type === 'variant');
    currentAudioTracks = [...new Map(audioTracks.map(t => [t.language, t])).values()]; // Filter unique languages

    if (currentAudioTracks.length > 1) {
        btnAudio.style.display = 'block';
        const activeIdx = currentAudioTracks.findIndex(t => t.active);
        audioTrackIndex = activeIdx !== -1 ? activeIdx : 0;
        btnAudio.innerHTML = `<i class="fi fi-rr-headphones"></i> ${currentAudioTracks[audioTrackIndex].language || 'Unknown'}`;
    } else {
        btnAudio.style.display = 'none';
        currentAudioTracks = [];
    }

    // Subtitle Tracks
    currentSubtitleTracks = player.getTextTracks();
    if (currentSubtitleTracks.length > 0) {
        btnSubtitle.style.display = 'block';
        const isVisible = player.isTextTrackVisible();
        if (!isVisible) {
            subtitleTrackIndex = -1;
            btnSubtitle.innerHTML = '<i class="fi fi-rr-subtitles"></i> Off';
        } else {
            const activeIdx = currentSubtitleTracks.findIndex(t => t.active);
            subtitleTrackIndex = activeIdx !== -1 ? activeIdx : 0;
            btnSubtitle.innerHTML = `<i class="fi fi-rr-subtitles"></i> ${currentSubtitleTracks[subtitleTrackIndex].language || currentSubtitleTracks[subtitleTrackIndex].label || 'Unknown'}`;
        }
    } else {
        btnSubtitle.style.display = 'none';
        currentSubtitleTracks = [];
    }

    // Resolution Badge
    updateResolutionBadge();
}

function getResolutionLabel(height) {
    if (!height) return null;
    if (height >= 4320) return { label: '8K', cls: 'res-8k' };
    if (height >= 2160) return { label: '4K', cls: 'res-4k' };
    if (height >= 1440) return { label: '2K', cls: 'res-qhd' };
    if (height >= 1080) return { label: '1080p', cls: 'res-fhd' };
    if (height >= 720) return { label: '720p', cls: 'res-hd' };
    if (height >= 480) return { label: '480p', cls: 'res-sd' };
    if (height >= 360) return { label: '360p', cls: 'res-sd' };
    return { label: `${height}p`, cls: 'res-sd' };
}

function updateResolutionBadge() {
    const badge = document.getElementById('resBadge');
    const video = document.getElementById('video');
    if (!badge || !player || !video) return;

    // Use the actual decoded video height from the element if available,
    // otherwise fallback to the active track's metadata.
    let height = video.videoHeight;
    if (!height || height === 0) {
        const active = player.getVariantTracks().find(t => t.active);
        height = active ? active.height : null;
    }

    const info = getResolutionLabel(height);

    if (info) {
        badge.textContent = info.label;
        badge.className = 'resolution-badge ' + info.cls;
        badge.style.display = 'inline-block';
    } else {
        badge.style.display = 'none';
    }
}

function cycleAudioTrack() {
    if (currentAudioTracks.length <= 1) return;

    audioTrackIndex++;
    if (audioTrackIndex >= currentAudioTracks.length) audioTrackIndex = 0;

    const track = currentAudioTracks[audioTrackIndex];
    if (track) {
        player.selectVariantTrack(track, true);
        document.getElementById('btnAudioTrack').innerHTML = `<i class="fi fi-rr-headphones"></i> ${track.language || 'Unknown'}`;
    }
}

function cycleSubtitleTrack() {
    if (currentSubtitleTracks.length === 0) return;

    subtitleTrackIndex++;
    // Include -1 (Off) in the cycle
    if (subtitleTrackIndex >= currentSubtitleTracks.length) subtitleTrackIndex = -1;

    const btnSubtitle = document.getElementById('btnSubtitleTrack');

    if (subtitleTrackIndex === -1) {
        player.setTextTrackVisibility(false);
        btnSubtitle.innerHTML = '<i class="fi fi-rr-subtitles"></i> Off';
    } else {
        const track = currentSubtitleTracks[subtitleTrackIndex];
        if (track) {
            player.selectTextTrack(track);
            player.setTextTrackVisibility(true);
            btnSubtitle.innerHTML = `<i class="fi fi-rr-subtitles"></i> ${track.language || track.label || 'Unknown'}`;
        }
    }
}

function navigateChannel(direction) {
    if (!currentFilteredChannels || currentFilteredChannels.length === 0) return;

    let index = currentFilteredChannels.findIndex(c => c.url === lastPlayedUrl);

    // Loop logic
    let nextIndex = index + direction;
    if (nextIndex < 0) nextIndex = currentFilteredChannels.length - 1;
    if (nextIndex >= currentFilteredChannels.length) nextIndex = 0;

    const channel = currentFilteredChannels[nextIndex];
    const keyStr = channel.key ? encodeURIComponent(channel.key) : '';
    playChannel(channel.url, keyStr);

    // Reset the idle timer on every navigation action
    resetChannelGuideIdle();
}

let controlsFocusIndex = -1; // -1 = no button focused

function getControlButtons() {
    return Array.from(document.querySelectorAll('#customPlayerControls button'))
        .filter(btn => btn.style.display !== 'none' && btn.offsetParent !== null);
}

function setControlsFocus(index) {
    const buttons = getControlButtons();
    // Clear previous focus
    buttons.forEach(btn => btn.classList.remove('tv-focused'));
    if (index >= 0 && index < buttons.length) {
        controlsFocusIndex = index;
        buttons[index].classList.add('tv-focused');
    } else {
        controlsFocusIndex = -1;
    }
}

function clearControlsFocus() {
    getControlButtons().forEach(btn => btn.classList.remove('tv-focused'));
    controlsFocusIndex = -1;
}

document.addEventListener('keydown', (e) => {
    // If login is showing, don't navigate
    if (document.getElementById('playerUI').style.display === 'none') return;

    // If no playlists, prevent all interaction
    const noPlaylistModal = document.getElementById('noPlaylistModal');
    if (noPlaylistModal && noPlaylistModal.style.display === 'flex') return;

    // All keyboard navigation is TV mode only
    if (!document.body.classList.contains('tv-mode')) return;

    const key = e.key;
    const keyCode = e.keyCode;
    const epg = document.getElementById('epgModal');
    const chModal = document.getElementById('channelModal');
    const isEpgOpen = epg && epg.style.display === 'flex';
    const isChannelOpen = chModal && chModal.style.display === 'flex';

    // Reset idle timer & auto-unmute on any key press in TV mode
    resetOverlayIdleTimer();
    unmuteVideo();

    // D-Pad Up — navigate channel rows in EPG, or previous channel in sidebar
    if (key === 'ArrowUp' || key === 'Up' || keyCode === 38) {
        e.preventDefault();
        if (isEpgOpen) {
            const rows = document.querySelectorAll('.channel-row-epg');
            if (rows.length === 0) return;
            epgChannelIndex = epgChannelIndex > 0 ? epgChannelIndex - 1 : rows.length - 1;
            epgProgramIndex = 0;
            updateEpgOverlayFocus();
            return;
        }
        clearControlsFocus();
        if (!isChannelOpen) openChannelGuide();
        // Move focus up in the virtual window — does NOT play yet
        navigateChannelOverlay(-1);
    }
    // D-Pad Down — navigate channel rows in EPG, or next channel in sidebar
    else if (key === 'ArrowDown' || key === 'Down' || keyCode === 40) {
        e.preventDefault();
        if (isEpgOpen) {
            const rows = document.querySelectorAll('.channel-row-epg');
            if (rows.length === 0) return;
            epgChannelIndex = epgChannelIndex < rows.length - 1 ? epgChannelIndex + 1 : 0;
            epgProgramIndex = 0;
            updateEpgOverlayFocus();
            return;
        }
        clearControlsFocus();
        if (!isChannelOpen) openChannelGuide();
        // Move focus down in the virtual window — does NOT play yet
        navigateChannelOverlay(1);
    }
    // D-Pad Left — navigate program cards left in EPG, or move controls focus
    else if (key === 'ArrowLeft' || key === 'Left' || keyCode === 37) {
        e.preventDefault();
        if (isEpgOpen) {
            const row = document.querySelectorAll('.channel-row-epg')[epgChannelIndex];
            if (!row) return;
            const cards = row.querySelectorAll('.program-card-epg');
            if (cards.length === 0) return;
            epgProgramIndex = epgProgramIndex > 0 ? epgProgramIndex - 1 : 0;
            updateEpgOverlayFocus();
            return;
        }
        if (isChannelOpen) return;
        const buttons = getControlButtons();
        if (buttons.length === 0) return;
        let next = controlsFocusIndex <= 0 ? buttons.length - 1 : controlsFocusIndex - 1;
        setControlsFocus(next);
    }
    // D-Pad Right — navigate program cards right in EPG, or move controls focus
    else if (key === 'ArrowRight' || key === 'Right' || keyCode === 39) {
        e.preventDefault();
        if (isEpgOpen) {
            const row = document.querySelectorAll('.channel-row-epg')[epgChannelIndex];
            if (!row) return;
            const cards = row.querySelectorAll('.program-card-epg');
            if (cards.length === 0) return;
            epgProgramIndex = epgProgramIndex < cards.length - 1 ? epgProgramIndex + 1 : epgProgramIndex;
            updateEpgOverlayFocus();
            return;
        }
        if (isChannelOpen) return;
        const buttons = getControlButtons();
        if (buttons.length === 0) return;
        let next = controlsFocusIndex < 0 || controlsFocusIndex >= buttons.length - 1 ? 0 : controlsFocusIndex + 1;
        setControlsFocus(next);
    }
    // Enter / OK — play focused EPG channel, activate sidebar channel, or press control button
    else if (key === 'Enter' || keyCode === 13) {
        e.preventDefault();
        if (isEpgOpen) {
            // Try focused program card first, else click the channel info row
            const focused = document.querySelector('.program-card-epg.focused, .channel-info-epg.focused');
            if (focused) focused.click();
            return;
        }
        if (isChannelOpen) {
            const focused = document.querySelector('#channelOverlayList .channel-card.focused');
            if (focused) focused.click();
            return;
        }
        if (controlsFocusIndex >= 0) {
            const buttons = getControlButtons();
            if (buttons[controlsFocusIndex]) buttons[controlsFocusIndex].click();
        }
    }
    // Escape — clear focus, close overlays, or exit TV mode
    else if (key === 'Escape' || keyCode === 27) {
        if (controlsFocusIndex >= 0) { clearControlsFocus(); return; }
        if (isEpgOpen) { closeEpgGuide(); return; }
        if (isChannelOpen) { closeChannelGuide(); return; }
        toggleTvMode(false);
    }
});

function openEpgGuide() {
    // Set initial focus to the currently playing channel
    const idx = document.getElementById('playlistSelector').value;
    const playlist = allPlaylists[idx];
    if (playlist) {
        const currentIdx = playlist.channels.findIndex(c => c.url === lastPlayedUrl);
        epgChannelIndex = currentIdx >= 0 ? currentIdx : 0;
        epgProgramIndex = 0; // Default to first program card (usually the 'Live' one)
    }

    renderEpgOverlay();
    document.getElementById('epgModal').style.display = 'flex';
    setTimeout(updateEpgOverlayFocus, 50); // Ensure DOM is rendered before focusing
}

function closeEpgGuide() {
    document.getElementById('epgModal').style.display = 'none';
}

function updateEpgOverlayFocus() {
    const rows = document.querySelectorAll('.channel-row-epg');
    rows.forEach((row, rIdx) => {
        const cards = row.querySelectorAll('.program-card-epg');
        const info = row.querySelector('.channel-info-epg');

        if (rIdx === epgChannelIndex) {
            row.style.background = 'rgba(59, 130, 246, 0.1)';
            // Scroll row into view vertically
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });

            if (cards.length > 0) {
                cards.forEach((card, cIdx) => {
                    if (cIdx === epgProgramIndex) {
                        card.classList.add('focused');
                        // Scroll card into view horizontally within the row
                        card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                    } else {
                        card.classList.remove('focused');
                    }
                });
                info.classList.remove('focused');
            } else {
                // No programs, focus the channel info instead
                info.classList.add('focused');
            }
        } else {
            row.style.background = 'rgba(0,0,0,0.2)';
            cards.forEach(c => c.classList.remove('focused'));
            info.classList.remove('focused');
        }
    });
}

let channelGuideIdleTimer = null;
const CHANNEL_GUIDE_IDLE_MS = 5000; // Auto-close after 5s of no navigation

function resetChannelGuideIdle() {
    if (channelGuideIdleTimer) clearTimeout(channelGuideIdleTimer);
    channelGuideIdleTimer = setTimeout(() => {
        closeChannelGuide();
    }, CHANNEL_GUIDE_IDLE_MS);
}

function openChannelGuide() {
    // Find index of currently playing channel to set initial focus
    const idx = document.getElementById('playlistSelector').value;
    const playlist = allPlaylists[idx];
    const currentIdx = playlist ? playlist.channels.findIndex(c => c.url === lastPlayedUrl) : 0;
    channelOverlayIndex = currentIdx >= 0 ? currentIdx : 0;

    renderChannelOverlay();
    document.getElementById('channelModal').style.display = 'flex';
    resetChannelGuideIdle();
}

function closeChannelGuide() {
    if (channelGuideIdleTimer) clearTimeout(channelGuideIdleTimer);
    cancelZap(); // discard any pending auto-play
    document.getElementById('channelModal').style.display = 'none';
}

// Zap delay: how long after the last D-pad move before auto-playing the focused channel.
const ZAP_DELAY_MS = 800;
let _zapTimer = null;

function cancelZap() {
    if (_zapTimer) { clearTimeout(_zapTimer); _zapTimer = null; }
}

function playFocusedOverlayChannel() {
    cancelZap();
    const idx = document.getElementById('playlistSelector').value;
    const playlist = allPlaylists[idx];
    if (!playlist || !playlist.channels.length) return;
    const channel = playlist.channels[channelOverlayIndex];
    if (!channel) return;
    const keyStr = channel.key ? encodeURIComponent(channel.key) : '';
    playChannel(channel.url, keyStr);
    // Re-render so the .playing class updates in the window
    renderChannelOverlay();
}

function navigateChannelOverlay(direction) {
    const idx = document.getElementById('playlistSelector').value;
    const playlist = allPlaylists[idx];
    if (!playlist || !playlist.channels.length) return;

    const total = playlist.channels.length;
    channelOverlayIndex = ((channelOverlayIndex + direction) % total + total) % total;
    renderChannelOverlay();
    resetChannelGuideIdle();

    // Start (or restart) the zap timer — fires if the user stops navigating
    cancelZap();
    _zapTimer = setTimeout(playFocusedOverlayChannel, ZAP_DELAY_MS);
}


// Virtual 5-slot window: always renders exactly VISIBLE_COUNT items centred on
// channelOverlayIndex. No scrolling, no DOM cloning — just pure index math.
const OVERLAY_VISIBLE = 5;

function renderChannelOverlay() {
    const idx = document.getElementById('playlistSelector').value;
    const playlist = allPlaylists[idx];
    const container = document.getElementById('channelOverlayList');
    if (!playlist || !container) return;

    const channels = playlist.channels;
    const total = channels.length;
    const epgUrl = playlist.epg || '';
    const half = Math.floor(OVERLAY_VISIBLE / 2);

    const html = [];
    for (let slot = 0; slot < OVERLAY_VISIBLE; slot++) {
        // Wrap index with modular arithmetic — loop seamlessly at boundaries
        const chIdx = ((channelOverlayIndex - half + slot) % total + total) % total;
        const channel = channels[chIdx];
        const isFocused = slot === half;
        const isPlaying = channel.url === lastPlayedUrl;

        const keyStr = channel.key ? encodeURIComponent(channel.key) : '';
        const logo = channel.logo || 'https://via.placeholder.com/54/1e293b/ffffff?text=TV';
        const program = getProgramForChannel(channel.epgId, epgUrl);
        const programHtml = program
            ? `<span class="channel-program" style="display:block;"><i class="fi fi-rr-signal-stream ch-epg-icon"></i>${program.title}</span>`
            : '';

        const classes = [
            'channel-card',
            isFocused ? 'focused' : '',
            isPlaying ? 'playing' : '',
        ].filter(Boolean).join(' ');

        html.push(`
            <li class="${classes}"
                onclick="playChannel('${channel.url}', '${keyStr}'); closeChannelGuide();">
                <img src="${logo}" class="channel-logo" loading="lazy"
                    onerror="this.onerror=null;this.src='https://via.placeholder.com/54/1e293b/ffffff?text=TV';">
                <div class="channel-meta">
                    <span class="channel-name">${channel.name}</span>
                    ${programHtml}
                    <span class="channel-cat">${channel.cat || 'Uncategorized'}</span>
                </div>
            </li>`);
    }

    container.innerHTML = html.join('');
}

// updateChannelOverlayFocus is now a no-op alias — renderChannelOverlay handles focus inline
function updateChannelOverlayFocus() {
    renderChannelOverlay();
}


function renderEpgOverlay() {
    const idx = document.getElementById('playlistSelector').value;
    const playlist = allPlaylists[idx];
    const container = document.getElementById('epgOverlayContainer');
    if (!playlist) return;

    const urls = playlist.epg ? playlist.epg.split(',').map(u => u.trim()).filter(Boolean) : [];
    const now = new Date();

    if (!playlist.channels || playlist.channels.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:50px; color:var(--text-dim);">No channels in this playlist.</div>';
        return;
    }

    container.innerHTML = `<div class="epg-grid">` + playlist.channels.map((ch, rIdx) => {
        let programs = [];
        for (const url of urls) {
            const cache = epgDataCache[url];
            if (!cache) continue;
            const cacheKey = Object.keys(cache).find(k => k.toLowerCase() === (ch.epgId || '').toLowerCase());
            if (cacheKey) {
                // Show current and upcoming programs (limit to 12)
                programs = cache[cacheKey].filter(p => p.stop > now).sort((a, b) => a.start - b.start).slice(0, 12);
                break;
            }
        }

        const programHtml = programs.length > 0 ? programs.map((p, pIdx) => {
            const isLive = now >= p.start && now < p.stop;
            const keyStr = ch.key ? encodeURIComponent(ch.key) : '';
            const isFocused = (rIdx === epgChannelIndex && pIdx === epgProgramIndex) ? 'focused' : '';
            return `
                <div class="program-card-epg ${isLive ? 'active' : ''} ${isFocused}" onclick="playChannel('${ch.url}', '${keyStr}'); closeEpgGuide();">
                    <span class="program-title-epg">${isLive ? '🔴 ' : ''}${p.title}</span>
                    <span class="program-time-epg">${formatTime(p.start)} - ${formatTime(p.stop)}</span>
                </div>
            `;
        }).join('') : '<div style="color: var(--text-dim); font-size: 0.85rem; padding-left: 5px;">Schedule unavailable</div>';

        return `
            <div class="channel-row-epg">
                <div class="channel-info-epg" onclick="playChannel('${ch.url}', '${ch.key ? encodeURIComponent(ch.key) : ''}'); closeEpgGuide();" style="cursor: pointer;">
                    <img src="${ch.logo || 'https://via.placeholder.com/44/1e293b/ffffff?text=TV'}" class="channel-logo-epg" onerror="this.onerror=null;this.src='https://via.placeholder.com/44/1e293b/ffffff?text=TV'">
                    <span class="channel-name-epg">${ch.name}</span>
                </div>
                <div class="program-timeline">
                    ${programHtml}
                </div>
            </div>
        `;
    }).join('') + `</div>`;
}

function toggleAppLoader(show) {
    const loader = document.getElementById('appLoader');
    if (!loader) return;
    loader.style.opacity = show ? '1' : '0';
    loader.style.visibility = show ? 'visible' : 'hidden';

    // Prevent background scrolling while the loading screen is visible
    document.body.style.overflow = show ? 'hidden' : '';
}

function toggleHeaderMenu() {
    const menu = document.getElementById('mobileSlidingMenu');
    const backdrop = document.getElementById('menuBackdrop');
    if (menu) {
        const isActive = menu.classList.toggle('active');
        if (backdrop) backdrop.classList.toggle('active');
        document.body.style.overflow = isActive ? 'hidden' : '';
    }
}

// app.js is loaded at the end of <body>, so the DOM is fully ready at this point.
// Calling verify() directly is more reliable than using DOMContentLoaded, which
// may have already fired by the time this deferred script executes.
verify();

// --- ANTI-DEBUGGING SAFEGUARDS ---
document.addEventListener('contextmenu', event => {
    if (globalSettings.debugMode !== 'true') event.preventDefault();
});
document.addEventListener('keydown', (e) => {
    if (globalSettings.debugMode === 'true') return;
    if (e.keyCode === 123 || (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) || (e.ctrlKey && e.keyCode === 85)) {
        e.preventDefault();
        return false;
    }
});

function triggerSecurityViolation() {
    document.body.innerHTML = "<h2 style='color:red; text-align:center; margin-top:20vh;'>Security Violation: Debugging Tools Prohibited</h2>";
    if (typeof player !== 'undefined' && player) player.destroy();
    allChannelsData = [];
    dynamicSecretKey = null;
}

function checkDevTools() {
    // Bypass debugger check if debug mode is enabled
    if (globalSettings.debugMode === 'true') return false;

    // Bypass debugger check for TV Mode to prevent false positives on slow hardware
    if (document.body.classList.contains('tv-mode')) return false;

    // Detect docked DevTools by checking window dimension differences
    const threshold = 160;
    const widthDiff = window.outerWidth - window.innerWidth > threshold;
    const heightDiff = window.outerHeight - window.innerHeight > threshold;

    // Detect undocked DevTools using debugger timing check
    const start = performance.now();
    debugger;
    const end = performance.now();

    if (widthDiff || heightDiff || (end - start > 100)) {
        triggerSecurityViolation();
        return true;
    }
    return false;
}
setInterval(checkDevTools, 1000);