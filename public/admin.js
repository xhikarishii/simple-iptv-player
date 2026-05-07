let globalUsers = [];
let globalPlaylists = [];
let dynamicSecretKey = null;

let newEditor, editEditor;

function initEditors() {
    // Setup Create Playlist Editor
    newEditor = ace.edit("newPlaylistChannels");
    newEditor.setTheme("ace/theme/one_dark"); // Matches the dark UI
    newEditor.session.setMode("ace/mode/json");
    newEditor.getSession().setUseWorker(false); // Prevents CSP worker errors

    // Set default JSON template
    newEditor.setValue('[\n  {\n    "name": "Channel 1",\n    "logo": "http://img.com/logo.png",\n    "url": "http://stream.com/live.m3u8",\n    "cat": "Sports",\n    "key": "keyID:keyVal"\n  }\n]', -1);

    // Setup Edit Playlist Editor
    editEditor = ace.edit("editPlaylistChannels");
    editEditor.setTheme("ace/theme/one_dark");
    editEditor.session.setMode("ace/mode/json");
    editEditor.getSession().setUseWorker(false);

    // Ensure editors resize properly on mobile orientation changes to prevent cutting
    window.addEventListener('resize', () => {
        if (newEditor) newEditor.resize();
        if (editEditor) editEditor.resize();
    });
}

function getAuthHeaders() {
    return {
        'Authorization': `Bearer ${sessionStorage.getItem('jwtToken') || localStorage.getItem('jwtToken')}`,
        'Content-Type': 'application/json'
    };
}

// --- TOKEN REFRESH ---

function parseJwtPayload(token) {
    try {
        return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) { return null; }
}

let _adminRefreshTimer = null;

function scheduleAdminTokenRefresh(token) {
    if (_adminRefreshTimer) clearTimeout(_adminRefreshTimer);
    const payload = parseJwtPayload(token);
    if (!payload || !payload.exp) return;
    const delay = Math.max(0, (payload.exp * 1000) - (60 * 60 * 1000) - Date.now());
    _adminRefreshTimer = setTimeout(silentAdminRefreshToken, delay);
}

async function silentAdminRefreshToken() {
    const inLocal = !!localStorage.getItem('jwtToken');
    const currentToken = localStorage.getItem('jwtToken') || sessionStorage.getItem('jwtToken');
    if (!currentToken) return;
    try {
        const res = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        if (!res.ok) { window.location.href = '/'; return; }
        const { token: newToken } = await res.json();
        if (inLocal) localStorage.setItem('jwtToken', newToken);
        else sessionStorage.setItem('jwtToken', newToken);
        // Refresh the derived client key
        const checkRes = await fetch('/api/auth/check', {
            headers: { 'Authorization': `Bearer ${newToken}` }
        });
        if (checkRes.ok) {
            const checkData = await checkRes.json();
            dynamicSecretKey = checkData.clientKey;
        }
        scheduleAdminTokenRefresh(newToken);
    } catch (e) {
        console.error('Admin token refresh failed:', e);
    }
}


async function verifyAdmin() {
    const token = sessionStorage.getItem('jwtToken') || localStorage.getItem('jwtToken');
    if (!token) return window.location.href = '/';

    try {
        const res = await fetch('/api/auth/check', {
            headers: getAuthHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            if (data.role !== 'admin') return window.location.href = '/';
            dynamicSecretKey = data.clientKey;

            // Enforce security policies before loading data
            if (await applySecurityPolicies()) return;

            initEditors(); // Initialize the code editors!
            loadData();
            scheduleAdminTokenRefresh(token); // Keep the session alive
        } else if (res.status === 401 || res.status === 403) {
            localStorage.removeItem('jwtToken');
            sessionStorage.removeItem('jwtToken');
            window.location.href = '/';
        } else {
            document.body.innerHTML = "<h2 style='color:red; text-align:center; margin-top:20vh;'>Server Error</h2>";
        }
    } catch (e) {
        console.error('Network error during auth check', e);
        document.body.innerHTML = "<h2 style='color:red; text-align:center; margin-top:20vh;'>Network Error. Please refresh.</h2>";
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

async function loadData() {
    await loadUsers();
    await loadPlaylists();
    await loadSettings();
}

// --- USER MANAGEMENT ---
async function loadUsers() {
    const res = await fetch('/api/users', {
        headers: getAuthHeaders()
    });
    globalUsers = await res.json();

    const userList = document.getElementById('userList');
    const userSelect = document.getElementById('playlistUser');
    const editUserSelect = document.getElementById('editPlaylistUser');
    const sharedSelect = document.getElementById('playlistShared');
    const editSharedSelect = document.getElementById('editPlaylistShared');

    userList.innerHTML = '';
    userSelect.innerHTML = '<option value="">Primary Owner...</option>';
    editUserSelect.innerHTML = '<option value="">Primary Owner...</option>';
    sharedSelect.innerHTML = '';
    editSharedSelect.innerHTML = '';

    globalUsers.forEach(user => {
        const li = document.createElement('li');
        li.className = 'list-item';
        li.innerHTML = `
            <div style="flex: 1; min-width: 200px;">
                <span class="item-title">${user.username}</span>
                <span class="item-meta">Role: ${user.role} | ID: ${user.id}</span>
            </div>
            <div class="action-group">
                <button class="btn-small btn-info" onclick="openPasswordModal(${user.id})">Password</button>
                ${user.id !== 1 ? `<button class="btn-small btn-danger" onclick="deleteUser(${user.id})">Delete</button>` : ''}
            </div>
        `;
        userList.appendChild(li);

        const optionText = `${user.username} (${user.role})`;
        userSelect.appendChild(new Option(optionText, user.id));
        editUserSelect.appendChild(new Option(optionText, user.id));

        sharedSelect.appendChild(new Option(optionText, user.id));
        editSharedSelect.appendChild(new Option(optionText, user.id));
    });
}

async function addUser() {
    const username = document.getElementById('newUsername').value;
    const password = document.getElementById('newPassword').value;
    const role = document.getElementById('newRole').value;
    if (!username || !password) return alert('Fill all fields');

    const res = await fetch('/api/users', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
            username,
            password,
            role
        })
    });
    if (res.ok) {
        document.getElementById('newUsername').value = '';
        document.getElementById('newPassword').value = '';
        loadData();
    } else alert('Error adding user');
}

async function deleteUser(id) {
    if (!confirm('Are you sure? This deletes the user AND their playlists.')) return;
    const res = await fetch(`/api/users/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
    });
    if (res.ok) loadData();
    else alert('Error deleting user.');
}

function openPasswordModal(id) {
    document.getElementById('editUserId').value = id;
    document.getElementById('editNewPassword').value = '';
    document.getElementById('passwordModal').style.display = 'flex';
}

function closePasswordModal() {
    document.getElementById('passwordModal').style.display = 'none';
}

async function submitChangePassword() {
    const id = document.getElementById('editUserId').value;
    const newPassword = document.getElementById('editNewPassword').value;
    if (!newPassword) return alert('Password cannot be empty.');

    const res = await fetch(`/api/users/${id}/password`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({
            newPassword
        })
    });
    if (res.ok) {
        closePasswordModal();
        alert('Password updated.');
    }
}

// --- PLAYLIST MANAGEMENT ---
async function loadPlaylists() {
    try {
        const res = await fetch('/api/playlists', {
            headers: getAuthHeaders()
        });
        const data = await res.json();

        if (data.payload) {
            globalPlaylists = decryptPayload(data.payload); // Save globally
        } else {
            globalPlaylists = [];
        }
        renderPlaylists(globalPlaylists);
    } catch (error) {
        document.getElementById('playlistList').innerHTML = '<li class="list-item" style="color: var(--danger);">Error decrypting playlists.</li>';
    }
}

function renderPlaylists(playlists) {
    const list = document.getElementById('playlistList');
    list.innerHTML = '';

    if (playlists.length === 0) {
        list.innerHTML = '<li class="list-item"><span class="item-meta">No playlists found.</span></li>';
        return;
    }

    playlists.forEach(pl => {
        const li = document.createElement('li');
        li.className = 'list-item';
        const owner = globalUsers.find(u => u.id === pl.userId);
        const ownerName = owner ? owner.username : 'Unknown';

        li.innerHTML = `
            <div>
                <span class="item-title">${pl.name}</span>
                <span class="item-meta">Channels: ${pl.channels ? pl.channels.length : 0} | Owner: ${ownerName}</span>
            </div>
            <div class="action-group">
                <button class="btn-small btn-info" onclick="openEditPlaylistModal(${pl.id})">Edit</button>
                <button class="btn-small btn-danger" onclick="deletePlaylist(${pl.id})">Delete</button>
            </div>
        `;
        list.appendChild(li);
    });
}

async function addPlaylist() {
    const name = document.getElementById('newPlaylistName').value;
    const userId = document.getElementById('playlistUser').value;
    const epg = document.getElementById('newPlaylistEpgUrl').value;
    const channelsStr = newEditor.getValue();

    // Extract array of selected IDs
    const sharedOpts = document.getElementById('playlistShared').selectedOptions;
    const sharedWith = Array.from(sharedOpts).map(opt => parseInt(opt.value));

    if (!name || !userId || !channelsStr) return alert('Please fill in playlist name, owner, and channel data.');

    try {
        const channels = JSON.parse(channelsStr);
        const res = await fetch('/api/playlists', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                userId,
                name,
                channels,
                sharedWith,
                epg
            })
        });
        if (res.ok) {
            document.getElementById('newPlaylistName').value = '';
            document.getElementById('playlistShared').selectedIndex = -1; // Clear selection
            document.getElementById('newPlaylistEpgUrl').value = '';
            newEditor.setValue('[\n  {\n    "name": "Channel 1",\n    "logo": "http://img.com/logo.png",\n    "url": "http://stream.com/live.m3u8",\n    "cat": "Sports",\n    "key": "keyID:keyVal"\n  }\n]', -1);
            loadData();
        } else alert('Error adding playlist');
    } catch (e) {
        alert('Invalid JSON in channels field.');
    }
}

function openEditPlaylistModal(id) {
    const playlistObj = globalPlaylists.find(p => p.id === id);
    if (!playlistObj) return alert("Playlist not found in memory.");

    document.getElementById('editPlaylistId').value = playlistObj.id;
    document.getElementById('editPlaylistName').value = playlistObj.name;
    document.getElementById('editPlaylistEpgUrl').value = playlistObj.epg || '';
    document.getElementById('editPlaylistUser').value = playlistObj.userId;

    // Set the selected options in the multi-select box
    const sharedSelect = document.getElementById('editPlaylistShared');
    const sharedArray = playlistObj.sharedWith || [];
    Array.from(sharedSelect.options).forEach(opt => {
        opt.selected = sharedArray.includes(parseInt(opt.value)) || sharedArray.includes(String(opt.value));
    });

    editEditor.setValue(JSON.stringify(playlistObj.channels, null, 2), -1);
    document.getElementById('editPlaylistModal').style.display = 'flex';
}

function closeEditPlaylistModal() {
    document.getElementById('editPlaylistModal').style.display = 'none';
}

async function submitEditPlaylist() {
    const id = document.getElementById('editPlaylistId').value;
    const name = document.getElementById('editPlaylistName').value;
    const userId = document.getElementById('editPlaylistUser').value;
    const epg = document.getElementById('editPlaylistEpgUrl').value;
    const channelsStr = editEditor.getValue();

    // Extract array of selected IDs
    const sharedOpts = document.getElementById('editPlaylistShared').selectedOptions;
    const sharedWith = Array.from(sharedOpts).map(opt => parseInt(opt.value));

    try {
        const channels = JSON.parse(channelsStr);
        const res = await fetch(`/api/playlists/${id}`, {
            method: 'PUT',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                userId,
                name,
                channels,
                sharedWith,
                epg
            })
        });
        if (res.ok) {
            closeEditPlaylistModal();
            loadData();
        } else alert('Error updating playlist');
    } catch (e) {
        alert('Invalid JSON format.');
    }
}

async function deletePlaylist(id) {
    if (!confirm('Delete this playlist?')) return;
    const res = await fetch(`/api/playlists/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
    });
    if (res.ok) loadData();
    else alert('Error deleting playlist');
}

function convertAndLoadM3U() {
    const m3uText = document.getElementById('m3uInput').value;
    if (!m3uText) return alert("Please paste M3U content first.");

    const lines = m3uText.split('\n');
    const channels = [];
    let currentChannel = null;

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            currentChannel = {};
            
            // Extract tvg-logo
            const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
            // Extract EPG ID (Check tvg-id, then tvg-name, then channel-id)
            const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i) || 
                               line.match(/tvg-name="([^"]*)"/i) || 
                               line.match(/channel-id="([^"]*)"/i);
            // Extract group-title (category)
            const groupMatch = line.match(/group-title="([^"]*)"/i);
            // Extract name (text after the last comma)
            const nameMatch = line.match(/,(.*)$/);

            currentChannel.name = nameMatch ? nameMatch[1].trim() : "Unknown Channel";
            currentChannel.logo = logoMatch ? logoMatch[1] : "";
            currentChannel.cat = groupMatch ? groupMatch[1] : "General";
            currentChannel.epgId = tvgIdMatch ? tvgIdMatch[1] : "";
            currentChannel.url = "";
            currentChannel.key = "";
        } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
            if (currentChannel) {
                const rawKey = line.split('=')[1].trim();
                try {
                    // Handle complex JSON license keys (Kodi/ClearKey format)
                    if (rawKey.startsWith('{')) {
                        const keyObj = JSON.parse(rawKey);
                        if (keyObj.keys && keyObj.keys[0]) {
                            const k = keyObj.keys[0];
                            // Extract KID and Key to "kid:key" format for Shaka Player
                            if (k.kid && k.k) {
                                currentChannel.key = `${k.kid}:${k.k}`;
                            } else {
                                currentChannel.key = rawKey;
                            }
                        } else {
                            currentChannel.key = rawKey;
                        }
                    } else {
                        currentChannel.key = rawKey;
                    }
                } catch (e) {
                    // Not JSON, use as-is (could be a license URL or simple kid:key string)
                    currentChannel.key = rawKey;
                }
            }
        } else if (line.startsWith('http')) {
            if (currentChannel) {
                currentChannel.url = line;
                channels.push(currentChannel);
                currentChannel = null;
            }
        }
    });

    if (channels.length > 0) {
        newEditor.setValue(JSON.stringify(channels, null, 2), -1);
        alert(`Successfully converted ${channels.length} channels.`);
    } else {
        alert("No valid channels found in the provided M3U content.");
    }
}

function validateJson(editor) {
    const code = editor.getValue();
    try {
        const parsed = JSON.parse(code);
        if (!Array.isArray(parsed)) {
            alert("Warning: Playlist JSON should be an Array of channel objects.");
            return;
        }
        alert("✅ JSON is valid and correctly formatted.");
    } catch (e) {
        alert("❌ Invalid JSON format:\n" + e.message);
    }
}

function validateNewPlaylistJson() { validateJson(newEditor); }
function validateEditPlaylistJson() { validateJson(editEditor); }

function toggleAdminMenu() {
    const menu = document.getElementById('adminSlidingMenu');
    const backdrop = document.getElementById('adminMenuBackdrop');
    if (menu) {
        const isActive = menu.classList.toggle('active');
        if (backdrop) backdrop.classList.toggle('active');
        document.body.style.overflow = isActive ? 'hidden' : '';
    }
}

// --- SETTINGS MANAGEMENT ---
async function loadSettings() {
    const res = await fetch('/api/settings', { headers: getAuthHeaders() });
    const settings = await res.json();
    
    const uaSelect = document.getElementById('settingUserAgent');
    const customUA = document.getElementById('customUserAgent');
    
    if (settings.userAgent) {
        // Check if the current UA is one of the predefined ones
        let found = false;
        Array.from(uaSelect.options).forEach(opt => {
            if (opt.value === settings.userAgent) {
                uaSelect.value = opt.value;
                found = true;
            }
        });
        
        if (!found) {
            uaSelect.value = 'custom';
            customUA.value = settings.userAgent;
            document.getElementById('customUAContainer').style.display = 'block';
        } else {
            document.getElementById('customUAContainer').style.display = 'none';
        }
    }

    // Layout Mode
    const layoutSelect = document.getElementById('settingLayoutMode');
    if (settings.layoutMode && layoutSelect) {
        layoutSelect.value = settings.layoutMode;
    }

    // Shaka Config
    const shakaSelect = document.getElementById('settingShakaConfig');
    if (settings.shakaConfig && shakaSelect) {
        shakaSelect.value = settings.shakaConfig;
    }

    // Proxy HTTPS
    const proxyHttpsSelect = document.getElementById('settingProxyHttps');
    if (proxyHttpsSelect && settings.hasOwnProperty('proxyHttps')) {
        proxyHttpsSelect.value = String(settings.proxyHttps);
        toggleProxyHttpsNotice();
    }

    // Debug Mode
    const debugSelect = document.getElementById('settingDebugMode');
    if (debugSelect && settings.hasOwnProperty('debugMode')) {
        debugSelect.value = String(settings.debugMode);
    }
}

function toggleProxyHttpsNotice() {
    const select = document.getElementById('settingProxyHttps');
    const notice = document.getElementById('proxyHttpsNotice');
    if (select && notice) {
        notice.style.display = select.value === 'false' ? 'block' : 'none';
    }
}

function handleUADropdownChange() {
    const uaSelect = document.getElementById('settingUserAgent');
    const customContainer = document.getElementById('customUAContainer');
    customContainer.style.display = uaSelect.value === 'custom' ? 'block' : 'none';
}

async function saveSettings() {
    const uaSelect = document.getElementById('settingUserAgent');
    const customUA = document.getElementById('customUserAgent').value;
    const layoutSelect = document.getElementById('settingLayoutMode');
    const shakaSelect = document.getElementById('settingShakaConfig');
    const proxyHttpsSelect = document.getElementById('settingProxyHttps');
    const debugSelect = document.getElementById('settingDebugMode');
    
    const userAgent = uaSelect.value === 'custom' ? customUA : uaSelect.value;
    const layoutMode = layoutSelect ? layoutSelect.value : 'autodetect';
    const shakaConfig = shakaSelect ? shakaSelect.value : 'auto';
    const proxyHttps = proxyHttpsSelect ? proxyHttpsSelect.value : 'true';
    const debugMode = debugSelect ? debugSelect.value : 'false';
    
    if (!userAgent) return alert('User-Agent cannot be empty');

    const res = await fetch('/api/settings', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ userAgent, layoutMode, shakaConfig, proxyHttps, debugMode })
    });

    if (res.ok) {
        alert('Settings saved successfully');
    } else {
        alert('Error saving settings');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    verifyAdmin();
    
    // Add listener for Proxy HTTPS setting to show/hide notice
    const proxyHttpsSelect = document.getElementById('settingProxyHttps');
    if (proxyHttpsSelect) {
        proxyHttpsSelect.addEventListener('change', toggleProxyHttpsNotice);
    }
});

// --- ANTI-DEBUGGING SAFEGUARDS ---
function triggerSecurityViolation() {
    document.body.innerHTML = "<h2 style='color:red; text-align:center; margin-top:20vh;'>Security Violation: Debugging Tools Prohibited</h2>";
    dynamicSecretKey = null;
    globalUsers = [];
    globalPlaylists = [];
}

function checkDevTools(debugMode) {
    if (debugMode === 'true') return false;

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

async function applySecurityPolicies() {
    const res = await fetch('/api/settings', { headers: getAuthHeaders() });
    const settings = await res.json();
    
    if (settings.debugMode === 'true') return false;

    // Initial check
    if (checkDevTools(settings.debugMode)) return true;

    document.addEventListener('contextmenu', event => event.preventDefault());
    document.addEventListener('keydown', (e) => {
        if (e.keyCode === 123 || (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) || (e.ctrlKey && e.keyCode === 85)) {
            e.preventDefault();
            return false;
        }
    });

    setInterval(() => checkDevTools(settings.debugMode), 1000);
    return false;
}