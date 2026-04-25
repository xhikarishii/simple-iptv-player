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

async function verify() {
    // Detect TV environment immediately on every page load — before auth check,
    // so TV mode styles apply on first visit (login screen) too, not just after refresh.
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
            document.getElementById('currentUserDisplay').innerText = `👤 ${data.username}`; // Desktop
            document.getElementById('adminLink').style.display = data.role === 'admin' ? 'inline-block' : 'none'; // Desktop

            // Update mobile header elements
            document.getElementById('mobileUserDisplay').innerText = `👤 ${data.username}`;
            document.getElementById('mobileAdminLink').style.display = data.role === 'admin' ? 'block' : 'none';

            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('playerUI').style.display = 'grid';

            // 1.5 Fetch global settings
            try {
                const settingsRes = await fetch('/api/settings', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                globalSettings = await settingsRes.json();
            } catch (e) {
                console.error("Error loading settings:", e);
            }

            // 1.7 Load local preferences (like aspect ratio)
            loadLocalPreferences();

            // 2. Start the player engine (Note: initApp no longer calls loadPlaylists internally)
            await initApp();

            // 3. Load data and trigger the resume logic (epg loading happens inside)
            await loadPlaylists();

            toggleAppLoader(false);
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

async function initApp() {
    shaka.polyfill.installAll();
    if (shaka.Player.isBrowserSupported()) {
        const video = document.getElementById('video');
        player = new shaka.Player(video);

        // Apply saved aspect ratio immediately
        applyAspectRatio();

        // Live-streaming optimized configuration — minimal buffer for fast channel switching
        player.configure({
            streaming: {
                // Keep only 3s of back-buffer; no need for rewind on live IPTV
                bufferingGoal: 5,           // Target seconds to buffer ahead
                rebufferingGoal: 2,         // Seconds needed before resuming after a stall
                bufferBehind: 30,           // Max seconds of back-buffer to retain
                jumpLargeGaps: true,        // Auto-skip gaps in live streams
                durationBackoff: 1,         // Retry duration polling faster on live
                retryParameters: {
                    maxAttempts: 5,
                    baseDelay: 1000,
                    backoffFactor: 1.5,
                    fuzzFactor: 0.5,
                    timeout: 15000,
                },
                lowLatencyMode: false,      // Not all IPTV CDNs support LL-HLS; keep off
                inaccurateManifestTolerance: 10,
                stallEnabled: true,
                stallThreshold: 1,          // Detect stalls quickly (1s)
                stallSkip: 0.1,             // Skip 0.1s ahead to recover from micro-stalls
            },
            manifest: {
                retryParameters: {
                    maxAttempts: 5,
                    baseDelay: 500,
                    backoffFactor: 1.5,
                    fuzzFactor: 0.5,
                    timeout: 15000,
                },
                // Allow manifest updates to continue even with minor parse errors
                ignoreDrmInfo: false,
                defaultPresentationDelay: 5, // Join the live stream 5s behind the live edge
            },
        });

        player.addEventListener('trackschanged', populateTracks);

        video.addEventListener('play', () => document.getElementById('btnPlayPause').innerText = '⏸');
        video.addEventListener('pause', () => document.getElementById('btnPlayPause').innerText = '▶');
        video.addEventListener('volumechange', () => document.getElementById('btnMute').innerText = video.muted || video.volume === 0 ? '🔇' : '🔊');

        // Upgraded CORS Proxy Filter (Handles HTTP Mixed Content & Root-Relative Paths)
        let currentUpstreamProtocol = '';
        let currentUpstreamHost = '';

        player.getNetworkingEngine().registerRequestFilter((type, request) => {
            const url = request.uris[0];

            // 1. External URLs (The Mixed Content Fixer & UA Spoofing)
            const isExternal = (url.startsWith('http://') || url.startsWith('https://')) && !url.includes(window.location.host);
            
            // We MUST use the proxy if:
            // a) It's HTTP (to avoid Mixed Content blocks on HTTPS sites)
            // b) We have a custom User-Agent to spoof (browsers won't let us spoof UA directly on cross-origin requests)
            const shouldProxy = url.startsWith('http://') || (isExternal && globalSettings.userAgent);

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
                if (globalSettings.userAgent) {
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
    if (checkDevTools()) return;

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
    if (error.category === shaka.util.Error.Category.NETWORK) {
        return "Network Error: The stream could not be reached. Please check your internet connection or proxy settings.";
    }
    if (error.category === shaka.util.Error.Category.DRM) {
        if (error.code === 6001) return "Security Error: This encrypted stream requires a secure (HTTPS) connection to play.";
        return "DRM Error: The license for this encrypted stream could not be acquired.";
    }
    if (error.category === shaka.util.Error.Category.MANIFEST) {
        return "Format Error: The playlist manifest is invalid or contains unsupported stream formats.";
    }
    if (error.category === shaka.util.Error.Category.STREAMING) {
        return "Streaming Error: The connection was lost while segmenting the video data.";
    }
    return `Playback Error: An unexpected issue occurred. (Code: ${error.code})`;
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
        const newTitle = program ? program.title : 'Live Stream';

        if (program) {
            programInfo.innerText = `🔴 ${program.title}`;
            if (progressContainer) {
                const now = new Date();
                const pct = Math.min(Math.max(((now - program.start) / (program.stop - program.start)) * 100, 0), 100);
                document.getElementById('programProgressFill').style.width = pct + '%';
                document.getElementById('programStartTime').innerText = formatTime(program.start);
                document.getElementById('programEndTime').innerText = formatTime(program.stop);
                progressContainer.style.display = 'block';
            }
        } else {
            programInfo.innerText = 'Live Stream';
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
                await player.load(url);
                // Abort if user switched to a different channel while loading
                if (myGeneration !== loadGeneration) return;
                success = true;
                errorOverlay.style.display = 'none';
            } catch (e) {
                // A new channel was loaded — this load was cancelled intentionally
                if (e.code === shaka.util.Error.Code.LOAD_INTERRUPTED) return;

                // Abort stale retry if another channel was selected
                if (myGeneration !== loadGeneration) return;

                attempts++;

                if (attempts >= MAX_RETRIES) {
                    throw e; // Exhausted — surface the real error
                }

                // Show a non-alarming "connecting" message during retries
                errorTitle.innerText = `Connecting\u2026 (${attempts}/${MAX_RETRIES})`;
                errorDescription.innerText = 'Retrying stream, please wait.';
                errorOverlay.style.display = 'flex';
                document.querySelector('#videoErrorOverlay .btn-retry').style.display = 'none';

                await new Promise(r => setTimeout(r, 1500));
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
            if (retryBtn) retryBtn.style.display = '';
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
    btn.innerText = isActive ? '✕ Close' : '☰ Channels';

    // Prevent background scrolling and reveal issues on mobile
    document.body.style.overflow = isActive ? 'hidden' : '';
}

function detectTvMode() {
    const ua = navigator.userAgent;

    // Explicit markers for major Smart TV platforms, STBs, and Consoles
    const tvMarkers = /SmartTV|SMART-TV|Android ?TV|GoogleTV|AppleTV|Tizen|WebOS|HbbTV|NetCast|Viera|AFT[A-Z]+|FireTV|Fire OS|CrKey|Chromecast|Large Screen|MiTV|MiBOX|SonyBravia|BRAVIA|NVIDIA SHIELD|Roku|PlayStation|Xbox|Nintendo|Vizio|Hisense|Panasonic|Philips|Sharp|VIDAA/i;

    // Heuristic: Check for Android + TV/Box combination
    const isAndroidTv = /Android/i.test(ua) && (/TV/i.test(ua) || /Box/i.test(ua) || /Nexus Player/i.test(ua));

    // Generic fallback: Check if claiming to be TV/STB, but rule out regular desktop/mobile
    const isGenericTv = /(TV|STB|Set-Top Box|10-foot|SetTopBox)/i.test(ua) && !/(iPhone|iPad|iPod|Windows|Mac OS X)/i.test(ua);

    if (tvMarkers.test(ua) || isAndroidTv || isGenericTv) {
        toggleTvMode(true);
    }
}

function toggleTvMode(force) {
    const isTv = force !== undefined ? force : !document.body.classList.contains('tv-mode');
    document.body.classList.toggle('tv-mode', isTv);
    const btn = document.getElementById('tvModeBtn');
    if (btn) btn.innerText = isTv ? 'Exit TV Mode' : 'TV Mode';

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
    if (!video) return;
    
    // Reset any previous custom styles
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.maxWidth = '100%';
    video.style.maxHeight = '100%';
    video.style.margin = 'auto';
    video.style.aspectRatio = ratio.ratio;
    video.style.objectFit = ratio.fit;

    if (ratio.label !== 'Source' && ratio.label !== 'Fill') {
        // For forced ratios, we need to let aspect-ratio drive dimensions within the container
        video.style.width = 'auto';
        video.style.height = 'auto';
    }
}

function loadLocalPreferences() {
    const savedRatio = localStorage.getItem('preferredAspectRatioIndex');
    if (savedRatio !== null) {
        aspectRatioIndex = parseInt(savedRatio);
    }
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
        btnAudio.innerText = `🎧 ${currentAudioTracks[audioTrackIndex].language || 'Unknown'}`;
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
            btnSubtitle.innerText = '💬 Off';
        } else {
            const activeIdx = currentSubtitleTracks.findIndex(t => t.active);
            subtitleTrackIndex = activeIdx !== -1 ? activeIdx : 0;
            btnSubtitle.innerText = `💬 ${currentSubtitleTracks[subtitleTrackIndex].language || currentSubtitleTracks[subtitleTrackIndex].label || 'Unknown'}`;
        }
    } else {
        btnSubtitle.style.display = 'none';
        currentSubtitleTracks = [];
    }
}

function cycleAudioTrack() {
    if (currentAudioTracks.length <= 1) return;

    audioTrackIndex++;
    if (audioTrackIndex >= currentAudioTracks.length) audioTrackIndex = 0;

    const track = currentAudioTracks[audioTrackIndex];
    if (track) {
        player.selectVariantTrack(track, true);
        document.getElementById('btnAudioTrack').innerText = `🎧 ${track.language || 'Unknown'}`;
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
        btnSubtitle.innerText = '💬 Off';
    } else {
        const track = currentSubtitleTracks[subtitleTrackIndex];
        if (track) {
            player.selectTextTrack(track);
            player.setTextTrackVisibility(true);
            btnSubtitle.innerText = `💬 ${track.language || track.label || 'Unknown'}`;
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

    // Update the .playing highlight in the channel sidebar without re-rendering
    const items = document.querySelectorAll('#channelOverlayList .channel-card');
    const totalChannels = currentFilteredChannels.length;
    items.forEach((item, i) => {
        if (i % totalChannels === nextIndex) {
            item.classList.add('playing');
            // Only scroll to view the item in the middle copy (second third)
            const totalItems = items.length;
            if (i >= totalChannels && i < totalChannels * 2) {
                item.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        } else {
            item.classList.remove('playing');
        }
    });

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
        navigateChannel(-1);
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
        navigateChannel(1);
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
            const focused = document.querySelector('#channelOverlayList .channel-card.playing');
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
    document.getElementById('channelModal').style.display = 'none';
}

function updateChannelOverlayFocus() {
    const items = document.querySelectorAll('#channelOverlayList .channel-card');
    items.forEach((item, idx) => {
        if (idx === channelOverlayIndex) {
            item.classList.add('focused');
            // Ensure the focused item is visible during navigation
            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            item.classList.remove('focused');
        }
    });
}

function generateChannelListHtml(channels, epgUrl) {
    return channels.map((channel) => {
        const keyStr = channel.key ? encodeURIComponent(channel.key) : '';
        const logo = channel.logo || 'https://via.placeholder.com/54/1e293b/ffffff?text=TV';

        const program = getProgramForChannel(channel.epgId, epgUrl);
        const programHtml = program ? `<span class="channel-program">🔴 ${program.title}</span>` : '';
        const isPlaying = channel.url === lastPlayedUrl;
        const classes = `channel-card${isPlaying ? ' playing' : ''}`;

        return `
            <li class="${classes}" onclick="playChannel('${channel.url}', '${keyStr}'); closeChannelGuide();">
                <img src="${logo}" class="channel-logo" loading="lazy" onerror="this.onerror=null;this.src='https://via.placeholder.com/54/1e293b/ffffff?text=TV';">
                <div class="channel-meta">
                    <span class="channel-name">${channel.name}</span>
                    ${programHtml}
                    <span class="channel-cat">${channel.cat || 'Uncategorized'}</span>
                </div>
            </li>`;
    }).join('');
}

function renderChannelOverlay() {
    const idx = document.getElementById('playlistSelector').value;
    const playlist = allPlaylists[idx];
    const container = document.getElementById('channelOverlayList');
    if (!playlist) return;

    const epgUrl = playlist.epg || '';

    // Render 3 copies of the playlist to allow for infinite scrolling
    const singleCopyHtml = generateChannelListHtml(playlist.channels, epgUrl);
    container.innerHTML = singleCopyHtml + singleCopyHtml + singleCopyHtml;

    // Scroll to the middle copy, offset to the playing channel
    const scrollContainer = document.getElementById('channelOverlayContainer');
    setTimeout(() => {
        if (!scrollContainer || scrollContainer.scrollHeight === 0) return;
        const thirdHeight = scrollContainer.scrollHeight / 3;
        const currentIdx = playlist.channels.findIndex(c => c.url === lastPlayedUrl);
        // Approximate each item's height and offset within the middle copy
        const itemHeight = scrollContainer.scrollHeight / (playlist.channels.length * 3);
        const offset = currentIdx >= 0 ? (currentIdx * itemHeight) : 0;
        scrollContainer.scrollTop = thirdHeight + offset - (scrollContainer.clientHeight / 2);
    }, 50);
}

// Circular/Infinite Scrolling Logic
document.getElementById('channelOverlayContainer').addEventListener('scroll', function () {
    const scrollContainer = this;
    const totalHeight = scrollContainer.scrollHeight;
    if (totalHeight === 0) return;

    const thirdHeight = totalHeight / 3;

    // If scrolled too high (into the first copy), jump down to the middle copy
    if (scrollContainer.scrollTop < thirdHeight * 0.2) {
        scrollContainer.scrollTop += thirdHeight;
    }
    // If scrolled too low (into the third copy), jump up to the middle copy
    else if (scrollContainer.scrollTop > thirdHeight * 2.8) {
        scrollContainer.scrollTop -= thirdHeight;
    }
});

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
document.addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('keydown', (e) => {
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
    // Bypass debugger check for TV Mode to prevent false positives on slow hardware
    if (document.body.classList.contains('tv-mode')) return false;

    const before = new Date().getTime();
    debugger;
    if (new Date().getTime() - before > 500) { // Increased threshold for stability
        triggerSecurityViolation();
        return true;
    }
    return false;
}
setInterval(checkDevTools, 1000);