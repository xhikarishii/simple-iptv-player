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

const AES_KEY = crypto.createHash('sha256').update(SECRET_KEY).digest();

app.use(express.json({
    limit: '100mb'
}));
app.use(express.urlencoded({
    limit: '100mb',
    extended: true
}));
app.use(express.static(path.join(__dirname, 'public')));

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization'] ?.split(' ')[1];
    if (!token) return res.status(401).json({
        error: 'Log in required'
    });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({
            error: 'Session expired'
        });
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({
        error: 'Admin only'
    });
    next();
};

function encryptPayload(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

const db = new sqlite3.Database(path.join(__dirname, 'data', 'iptv.db'));
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, userId INTEGER, name TEXT, channels TEXT, sharedWith TEXT DEFAULT '[]', epg TEXT DEFAULT '')`);

    db.run(`ALTER TABLE playlists ADD COLUMN epg TEXT DEFAULT ''`, (err) => {}); // Add EPG column if it doesn't exist
    // Safely add the column to existing databases (ignores the error if it already exists)
    db.run(`ALTER TABLE playlists ADD COLUMN sharedWith TEXT DEFAULT '[]'`, (err) => {});

    db.get("SELECT count(*) as count FROM users", (err, row) => {
        if (row.count === 0) {
            const pass = bcrypt.hashSync('admin123', 10);
            db.run(`INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')`, [pass]);
        }
    });
});

app.post('/api/login', (req, res) => {
    const {
        username,
        password
    } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            const token = jwt.sign({
                id: user.id,
                username: user.username,
                role: user.role
            }, JWT_SECRET);
            res.json({
                token,
                role: user.role
            });
        } else res.status(401).json({
            error: 'Invalid credentials'
        });
    });
});

app.get('/api/auth/check', authenticateToken, (req, res) => {
    res.json({
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        clientKey: process.env.SECRET_KEY
    });
});

app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
    db.all("SELECT id, username, role FROM users", (err, rows) => res.json(rows));
});

app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    const {
        username,
        password,
        role
    } = req.body;
    const hash = await bcrypt.hash(password, 10);
    db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, hash, role], () => res.sendStatus(201));
});

app.put('/api/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
    const {
        newPassword
    } = req.body;
    if (!newPassword) return res.status(400).json({
        error: 'New password required'
    });
    try {
        const hash = await bcrypt.hash(newPassword, 10);
        db.run(`UPDATE users SET password = ? WHERE id = ?`, [hash, req.params.id], (err) => {
            if (err) return res.status(500).json({
                error: err.message
            });
            res.json({
                message: 'Password updated'
            });
        });
    } catch (e) {
        res.status(500).json({
            error: 'Error securing password'
        });
    }
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
    const userId = req.params.id;
    if (userId === '1') return res.status(403).json({
        error: 'Cannot delete primary admin.'
    });
    db.run(`DELETE FROM users WHERE id = ?`, [userId], (err) => {
        if (err) return res.status(500).json({
            error: err.message
        });
        db.run(`DELETE FROM playlists WHERE userId = ?`, [userId], () => res.json({
            message: 'User deleted'
        }));
    });
});

app.get('/api/playlists', authenticateToken, (req, res) => {
    // Fetch all playlists, then filter them in Node to easily handle the JSON array logic
    db.all("SELECT * FROM playlists", [], (err, rows) => {
        if (err) return res.status(500).json({
            error: err.message
        });

        let filteredRows = rows;
        if (req.user.role !== 'admin') {
            filteredRows = rows.filter(r => {
                const shared = JSON.parse(r.sharedWith || '[]');
                // Allow if they are the owner OR if their ID is in the shared array
                return r.userId === req.user.id || shared.includes(req.user.id) || shared.includes(String(req.user.id));
            });
        }

        const rawData = filteredRows.map(r => ({
            ...r,
            channels: JSON.parse(r.channels || '[]'),
            sharedWith: JSON.parse(r.sharedWith || '[]')
        }));

        res.json({
            payload: encryptPayload(JSON.stringify(rawData))
        });
    });
});

app.post('/api/playlists', authenticateToken, requireAdmin, (req, res) => {
    const {
        userId,
        name,
        channels,
        sharedWith,
        epg
    } = req.body;
    const sharedStr = JSON.stringify(sharedWith || []);
    db.run(`INSERT INTO playlists (userId, name, channels, sharedWith, epg) VALUES (?, ?, ?, ?, ?)`,
        [userId, name, JSON.stringify(channels), sharedStr, epg || ''],
        () => res.sendStatus(201)
    );
});

app.put('/api/playlists/:id', authenticateToken, requireAdmin, (req, res) => {
    const {
        userId,
        name,
        channels,
        sharedWith,
        epg
    } = req.body;
    const sharedStr = JSON.stringify(sharedWith || []);
    db.run(`UPDATE playlists SET userId=?, name=?, channels=?, sharedWith=?, epg=? WHERE id=?`,
        [userId, name, JSON.stringify(channels), sharedStr, epg || '', req.params.id],
        () => res.sendStatus(200)
    );
});

app.delete('/api/playlists/:id', authenticateToken, requireAdmin, (req, res) => {
    db.run(`DELETE FROM playlists WHERE id=?`, [req.params.id], () => res.sendStatus(200));
});

app.listen(port);