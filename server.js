require('dotenv').config();
const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-jwt-secret';
const SECRET_KEY = process.env.SECRET_KEY || 'fallback-encryption-key';

// --- STARTUP SECRET VALIDATION ---
// Fail loudly on boot rather than silently running with known-weak secrets.
if (JWT_SECRET === 'fallback-jwt-secret' || SECRET_KEY === 'fallback-encryption-key') {
    console.error('[SECURITY] FATAL: Default fallback secrets are in use. Set JWT_SECRET and SECRET_KEY in your .env file.');
    process.exit(1);
}
if (JWT_SECRET.length < 32 || SECRET_KEY.length < 32) {
    console.error('[SECURITY] FATAL: JWT_SECRET and SECRET_KEY must each be at least 32 characters. Regenerate them.');
    process.exit(1);
}

// --- RATE LIMITER (in-memory, per IP) ---
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000; // 10 minutes

function isRateLimited(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record || now > record.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + LOCKOUT_MS });
        return false;
    }
    if (record.count >= MAX_LOGIN_ATTEMPTS) return true;
    record.count++;
    return false;
}

function clearAttempts(ip) {
    loginAttempts.delete(ip);
}

// Periodically prune expired entries to avoid memory growth
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of loginAttempts.entries()) {
        if (now > record.resetAt) loginAttempts.delete(ip);
    }
}, 5 * 60 * 1000);

// --- KEY DERIVATION ---
// The raw SECRET_KEY is NEVER sent to clients.
//
// Per-session key derivation:
//   clientKey (hex)  = HMAC-SHA256(SECRET_KEY, jwtToken)  <- sent to client
//   sessionAesKey    = SHA256(clientKey_hex)               <- used for AES-256 encryption
//
// Client-side (CryptoJS) decryption:
//   aesKey = CryptoJS.SHA256(clientKey)  <- matches sessionAesKey exactly

function deriveClientKey(token) {
    return crypto.createHmac('sha256', SECRET_KEY).update(token).digest('hex');
}

function deriveSessionAesKey(token) {
    const hmacHex = deriveClientKey(token);
    return crypto.createHash('sha256').update(hmacHex).digest(); // 32 raw bytes for AES-256
}

function encryptPayload(text, aesKey) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Log in required' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Session expired' });
        req.token = token; // preserve raw token for key derivation
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
};

const db = new sqlite3.Database(path.join(__dirname, 'data', 'iptv.db'));
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, userId INTEGER, name TEXT, channels TEXT, sharedWith TEXT DEFAULT '[]', epg TEXT DEFAULT '')`);
    db.run(`ALTER TABLE playlists ADD COLUMN epg TEXT DEFAULT ''`, (err) => {});
    db.run(`ALTER TABLE playlists ADD COLUMN sharedWith TEXT DEFAULT '[]'`, (err) => {});
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

    db.get("SELECT count(*) as count FROM users", (err, row) => {
        if (row.count === 0) {
            const pass = bcrypt.hashSync('admin123', 12); // 12 rounds
            db.run(`INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')`, [pass]);
        }
    });

    db.get("SELECT value FROM settings WHERE key = 'userAgent'", (err, row) => {
        if (!row) {
            db.run(`INSERT INTO settings (key, value) VALUES ('userAgent', 'AppleCoreMedia/1.0.0.19K362 (Apple TV; U; CPU OS 15_4 like Mac OS X; en_us)')`);
        }
    });
});

// --- AUTH ---

app.post('/api/login', (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    if (isRateLimited(ip)) {
        return res.status(429).json({ error: 'Too many login attempts. Please wait 10 minutes.' });
    }

    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            clearAttempts(ip);
            const token = jwt.sign(
                { id: user.id, username: user.username, role: user.role },
                JWT_SECRET,
                { expiresIn: '12h' }
            );
            res.json({ token, role: user.role });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

app.get('/api/auth/check', authenticateToken, (req, res) => {
    // Derive a per-session key from the token. The raw SECRET_KEY is never sent.
    res.json({
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        clientKey: deriveClientKey(req.token)
    });
});

// Silent token refresh — issues a fresh 12h token for the same user
app.post('/api/auth/refresh', authenticateToken, (req, res) => {
    const newToken = jwt.sign(
        { id: req.user.id, username: req.user.username, role: req.user.role },
        JWT_SECRET,
        { expiresIn: '12h' }
    );
    res.json({ token: newToken });
});

// --- USERS ---

app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
    db.all("SELECT id, username, role FROM users", (err, rows) => res.json(rows));
});

app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    const hash = await bcrypt.hash(password, 12); // 12 rounds
    db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, hash, role], () => res.sendStatus(201));
});

app.put('/api/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'New password required' });
    try {
        const hash = await bcrypt.hash(newPassword, 12);
        db.run(`UPDATE users SET password = ? WHERE id = ?`, [hash, req.params.id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Password updated' });
        });
    } catch (e) {
        res.status(500).json({ error: 'Error securing password' });
    }
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
    const userId = req.params.id;
    if (userId === '1') return res.status(403).json({ error: 'Cannot delete primary admin.' });
    db.run(`DELETE FROM users WHERE id = ?`, [userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM playlists WHERE userId = ?`, [userId], () => res.json({ message: 'User deleted' }));
    });
});

// --- PLAYLISTS ---

app.get('/api/playlists', authenticateToken, (req, res) => {
    db.all("SELECT * FROM playlists", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let filteredRows = rows;
        if (req.user.role !== 'admin') {
            filteredRows = rows.filter(r => {
                const shared = JSON.parse(r.sharedWith || '[]');
                return r.userId === req.user.id || shared.includes(req.user.id) || shared.includes(String(req.user.id));
            });
        }

        const rawData = filteredRows.map(r => ({
            ...r,
            channels: JSON.parse(r.channels || '[]'),
            sharedWith: JSON.parse(r.sharedWith || '[]')
        }));

        // Encrypt with a key derived from THIS request's token — master key never leaves server
        const sessionKey = deriveSessionAesKey(req.token);
        res.json({ payload: encryptPayload(JSON.stringify(rawData), sessionKey) });
    });
});

app.post('/api/playlists', authenticateToken, requireAdmin, (req, res) => {
    const { userId, name, channels, sharedWith, epg } = req.body;
    const sharedStr = JSON.stringify(sharedWith || []);
    db.run(
        `INSERT INTO playlists (userId, name, channels, sharedWith, epg) VALUES (?, ?, ?, ?, ?)`,
        [userId, name, JSON.stringify(channels), sharedStr, epg || ''],
        () => res.sendStatus(201)
    );
});

app.put('/api/playlists/:id', authenticateToken, requireAdmin, (req, res) => {
    const { userId, name, channels, sharedWith, epg } = req.body;
    const sharedStr = JSON.stringify(sharedWith || []);
    db.run(
        `UPDATE playlists SET userId=?, name=?, channels=?, sharedWith=?, epg=? WHERE id=?`,
        [userId, name, JSON.stringify(channels), sharedStr, epg || '', req.params.id],
        () => res.sendStatus(200)
    );
});

app.delete('/api/playlists/:id', authenticateToken, requireAdmin, (req, res) => {
    db.run(`DELETE FROM playlists WHERE id=?`, [req.params.id], () => res.sendStatus(200));
});

// --- SETTINGS ---

app.get('/api/settings', authenticateToken, (req, res) => {
    db.all("SELECT * FROM settings", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const settings = {};
        rows.forEach(r => settings[r.key] = r.value);
        res.json(settings);
    });
});

app.post('/api/settings', authenticateToken, requireAdmin, (req, res) => {
    const settings = req.body;
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    const keys = Object.keys(settings);
    if (keys.length === 0) return res.sendStatus(200);

    let count = 0;
    keys.forEach(key => {
        stmt.run(key, settings[key], (err) => {
            count++;
            if (count === keys.length) {
                stmt.finalize(() => res.sendStatus(200));
            }
        });
    });
});

app.listen(port);