let player;
let allChannelsData = [];
let allPlaylists = [];
let dynamicSecretKey = null;
let lastPlayedUrl = null;
let lastPlayedKey = null;
let currentUserId = null;
let epgDataCache = {}; // Cache for parsed EPG data

async function verify() {
    const token = localStorage.getItem('jwtToken');
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

            // 2. Start the player engine
            await initApp(); 
            
            // 3. Load data and trigger the resume logic (epg loading happens inside)
            await loadPlaylists(); 

            toggleAppLoader(false);
        } else { showLogin(); }
    } catch (e) { showLogin(); }
}

function showLogin() {
    localStorage.removeItem('jwtToken');
    document.getElementById('playerUI').style.display = 'none';
    toggleAppLoader(false);

    document.getElementById('loginModal').style.display = 'flex';

    if (typeof player !== 'undefined' && player) {
        player.unload(); // Instantly kills the active stream and audio
    }

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
        localStorage.setItem('jwtToken', data.token);
        verify();
    } else {
        document.getElementById('loginResult').innerText = 'Invalid credentials';
    }
}

async function initApp() {
    shaka.polyfill.installAll();
    if (shaka.Player.isBrowserSupported()) {
        const video = document.getElementById('video');
        const ui = video['ui'];
        const controls = ui.getControls();
        player = controls.getPlayer();

        // Upgraded CORS Proxy Filter (Handles HTTP Mixed Content & Root-Relative Paths)
        let currentUpstreamProtocol = '';
        let currentUpstreamHost = '';

        player.getNetworkingEngine().registerRequestFilter((type, request) => {
            const url = request.uris[0];

            // 1. External URLs (The Mixed Content Fixer)
            if (url.startsWith('http') && !url.includes(window.location.host)) {
                // Save the upstream destination to fix broken relative paths later
                try {
                    const urlObj = new URL(url);
                    currentUpstreamProtocol = urlObj.protocol.replace(':', '');
                    currentUpstreamHost = urlObj.host;
                } catch (e) {}

                // Force the insecure request through our secure Nginx proxy
                request.uris[0] = window.location.origin + '/proxy/' + url;
            }

            // 2. Root-Relative Path Fixer
            // If the browser accidentally resolved a path against our player's root domain
            else if (url.startsWith(window.location.origin) && !url.includes('/proxy/') && !url.includes('/api/')) {
                if (currentUpstreamHost) {
                    const brokenPath = url.replace(window.location.origin, '');
                    // Reconstruct the proper proxy URL using the saved upstream host
                    request.uris[0] = window.location.origin + '/proxy/' + currentUpstreamProtocol + '://' + currentUpstreamHost + brokenPath;
                }
            }
        });

        ui.configure({
            'controlPanelElements': ['play_pause', 'time_and_duration', 'spacer', 'caption', 'quality', 'language', 'fullscreen', 'overflow_menu']
        });

        player.addEventListener('error', (e) => handlePlaybackError(e.detail));
        await loadPlaylists();
    }
}

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
    //if (checkDevTools()) return; 

    try {
        const res = await fetch('/api/playlists', { 
            headers: { 'Authorization': `Bearer ${localStorage.getItem('jwtToken')}` } 
        });
        const data = await res.json();
        
        if (data.payload) {
            allPlaylists = decryptPayload(data.payload);
            await loadAllEpgData(allPlaylists); // Load EPG data for all playlists
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
            // Use the proxy for EPG URLs as well, as they can be HTTP or external
            const proxiedEpgUrl = window.location.origin + '/proxy/' + epgUrl;
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

async function playChannel(url, encodedKeyStr, isAutoplay = false) {
    // Update Now Playing Overlay
    let currentPlaylistEpgUrl = '';
    for (const pl of allPlaylists) {
        const match = pl.channels.find(c => c.url === url);
        if (match) {
            document.getElementById('nowPlayingName').innerText = match.name;
            document.getElementById('nowPlayingCat').innerText = match.cat || 'Uncategorized';
            document.getElementById('nowPlayingLogo').src = match.logo || 'https://via.placeholder.com/54/1e293b/ffffff?text=TV';
            
            // Update EPG program info
            currentPlaylistEpgUrl = pl.epg;
            const program = getProgramForChannel(match.epgId, currentPlaylistEpgUrl);
            const programInfo = document.getElementById('nowPlayingProgram');
            const progressContainer = document.getElementById('programProgressContainer');

            if (programInfo) {
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
            }

            break;
        }
    }

    try {
        lastPlayedUrl = url;
        lastPlayedKey = encodedKeyStr;
        const video = document.getElementById('video');
        const hint = document.getElementById('unmuteHint');
        
        document.getElementById('videoErrorOverlay').style.display = 'none';

        if (currentUserId) {
            localStorage.setItem(`lastChannel_${currentUserId}`, url);
            localStorage.setItem(`lastKey_${currentUserId}`, encodedKeyStr || '');
        }

        // Auto-close sidebar on mobile after selection
        const sidebar = document.querySelector('.sidebar');
        if (window.innerWidth <= 1100 && sidebar && sidebar.classList.contains('active')) {
            toggleSidebar();
        }

        await player.unload();
        player.resetConfiguration();
        
        const keyString = encodedKeyStr ? decodeURIComponent(encodedKeyStr).trim() : null;
        if (keyString) {
            if (keyString.startsWith('http')) {
                player.configure({ drm: { servers: { 'org.w3.clearkey': keyString } } });
            } else if (keyString.includes(':')) {
                const [keyId, keyVal] = keyString.split(':');
                player.configure({ drm: { clearKeys: { [keyId.trim()]: keyVal.trim() } } });
            }
        }

        // Add aggressive retry parameters directly to this load attempt
        await player.load(url);

        // Standard browsers require a user gesture for audio. 
        // We try to play; if it fails, we mute and try again automatically.
        if (isAutoplay) {
            video.muted = true; // Start muted to guarantee it plays
            await video.play();
            hint.style.display = 'flex'; // Show the button so the user can turn sound on
        } else {
            // User manually clicked a channel, try to play with sound
            video.muted = false;
            try {
                await video.play();
                hint.style.display = 'none';
            } catch (e) {
                // If the browser still blocks it, fallback to muted + hint
                video.muted = true;
                await video.play();
                hint.style.display = 'flex';
            }
        }

    } catch (e) { 
        // Only show the error overlay if this isn't a simple 'abort' error
        if (e.code !== shaka.util.Error.Code.LOAD_INTERRUPTED) {
            handlePlaybackError(e); 
        }
    }
}

function handlePlaybackError(error) {
    const overlay = document.getElementById('videoErrorOverlay');
    document.getElementById('errorTitle').innerText = `Error Code: ${error.code}`;
    document.getElementById('errorDescription').innerText = error.code === 6001 ? "HTTPS is required for DRM streams." : "Failed to load the stream.";
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
}

function toggleAppLoader(show) {
    const loader = document.getElementById('appLoader');
    if (!loader) return;
    loader.style.opacity = show ? '1' : '0';
    loader.style.visibility = show ? 'visible' : 'hidden';
}

function toggleHeaderMenu() {
    const menu = document.getElementById('mobileSlidingMenu');
    const backdrop = document.getElementById('menuBackdrop');
    if (menu) menu.classList.toggle('active');
    if (backdrop) backdrop.classList.toggle('active');
}

document.addEventListener('DOMContentLoaded', verify);

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
    const before = new Date().getTime();
    debugger;
    if (new Date().getTime() - before > 100) {
        triggerSecurityViolation();
        return true;
    }
    return false;
}
setInterval(checkDevTools, 1000);