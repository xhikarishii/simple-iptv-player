let player;
let allChannelsData = [];
let allPlaylists = [];
let dynamicSecretKey = null;
let lastPlayedUrl = null;
let lastPlayedKey = null;
let currentUserId = null;

async function verify() {
    const token = localStorage.getItem('jwtToken');
    if (!token) return showLogin();
    
    try {
        const res = await fetch('/api/auth/check', { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) {
            const data = await res.json();
            
            // 1. Set global session data FIRST
            dynamicSecretKey = data.clientKey; 
            currentUserId = String(data.id); 
            
            // Update desktop header elements
            document.getElementById('currentUserDisplay').innerText = `👤 ${data.username}`; // Desktop
            document.getElementById('adminLink').style.display = data.role === 'admin' ? 'inline-block' : 'none'; // Desktop
            document.getElementById('loginModal').style.display = 'none';
            document.getElementById('playerUI').style.display = 'grid';

            // 2. Start the player engine
            await initApp(); 
            
            // 3. Load data and trigger the resume logic
            await loadPlaylists(); 
        } else { showLogin(); }
    } catch (e) { showLogin(); }
}

function showLogin() {
    localStorage.removeItem('jwtToken');
    document.getElementById('playerUI').style.display = 'none';
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
    if (checkDevTools()) return; 

    try {
        const res = await fetch('/api/playlists', { 
            headers: { 'Authorization': `Bearer ${localStorage.getItem('jwtToken')}` } 
        });
        const data = await res.json();
        
        if (data.payload) {
            allPlaylists = decryptPayload(data.payload);
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

    listElement.innerHTML = channels.map(channel => {
        const keyStr = channel.key ? encodeURIComponent(channel.key) : '';
        const logo = channel.logo || 'https://via.placeholder.com/54/1e293b/ffffff?text=TV';
        return `
            <li class="channel-card" onclick="playChannel('${channel.url}', '${keyStr}')">
                <img src="${logo}" class="channel-logo" loading="lazy" onerror="this.onerror=null;this.src='https://via.placeholder.com/54/1e293b/ffffff?text=TV';">
                <div class="channel-meta">
                    <span class="channel-name">${channel.name}</span>
                    <span class="channel-cat">${channel.cat || 'Uncategorized'}</span>
                </div>
            </li>`;
    }).join('');
}

async function playChannel(url, encodedKeyStr, isAutoplay = false) {
    lastPlayedUrl = url;
    lastPlayedKey = encodedKeyStr;

    // Update Now Playing Overlay
    for (const pl of allPlaylists) {
        const match = pl.channels.find(c => c.url === url);
        if (match) {
            document.getElementById('nowPlayingName').innerText = match.name;
            document.getElementById('nowPlayingCat').innerText = match.cat || 'Uncategorized';
            document.getElementById('nowPlayingLogo').src = match.logo || 'https://via.placeholder.com/54/1e293b/ffffff?text=TV';
            break;
        }
    }

    const video = document.getElementById('video');
    
    // Clear any previous error overlays immediately
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