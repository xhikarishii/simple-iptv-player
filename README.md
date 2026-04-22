# 📺 Streamline IPTV Web Player

A premium, containerized IPTV web application designed for high-performance streaming, robust security, and multi-user management. This stack is optimized to bypass common browser security restrictions while maintaining a sleek, modern UI.

---

## 🚀 Key Features

### **Playback & Delivery**
* **Shaka Player Integration:** High-fidelity playback for HLS and DASH streams with full **ClearKey DRM** support.
* **Insecure Stream Proxy:** Custom Nginx reverse proxy allows `http://` streams to play on `https://` domains without "Mixed Content" blocks.
* **User-Specific Session Resume:** Remembers and autoplays the last channel watched by each specific user.
* **Smart Autoplay:** Automatically handles aggressive browser autoplay policies by starting muted and providing a "Click to Unmute" hint.

### **Security & Anti-Tamper**
* **Playlist Encryption:** Playlist data is encrypted on the server; clients only get the keys after successful authentication.
* **Anti-Debugging Trap:** Synchronous "Gatekeeper" logic detects if Developer Tools are open and nukes the session memory to protect stream URLs.
* **Terser Mangling:** Frontend JavaScript is minified and variable-mangled during the Docker build process to hinder reverse engineering.
* **JWT Authentication:** Secure token-based sessions with Role-Based Access Control (RBAC).

### **Management & UI**
* **Shared Playlists:** Admins can assign playlists to primary owners or share them across multiple secondary users.
* **Integrated Code Editor:** Built-in **Ace Editor** with JSON syntax highlighting for professional-grade playlist management.
* **Mobile-First Design:** Fully responsive Glassmorphism UI that adapts for Cinema Mode on Desktop and App-like performance on Mobile.

---

## 🏗 Stack Architecture

* **Frontend:** Vanilla JS, Shaka Player, Ace Editor, CryptoJS.
* **Backend:** Node.js (Express), SQLite3 (Database).
* **Proxy:** Nginx (Alpine-based) with custom CORS & Protocol headers.
* **Deployment:** Docker & Docker Compose.

---

## 🛠 Deployment Instructions

### 1. Prerequisites
Ensure you have **Docker** and **Docker Compose** installed on your server.

### 2. Environment Setup
Create a `.env` file in the project root:

```env
PORT=3000
JWT_SECRET=your_super_secret_jwt_token
SECRET_KEY=your_aes_encryption_key_string
```
### 3. Deploy the Stack
Build and start the containers:

```
docker-compose up -d --build
```

The application will be accessible at http://your-server-ip:8587.

### 4. Initial Credentials

Username: `admin`
Password: `admin123`

Note: Change the admin password immediately in the User Management section of the Admin Panel.

---

## 📁 Directory Structure

```
├── data/               # Persistent SQLite database
├── public/
│   ├── index.html      # Main Player UI
│   ├── admin.html      # Admin Dashboard
│   ├── app.js          # Player Logic (Mangled on build)
│   └── admin.js        # Admin Logic (Mangled on build)
├── server.js           # Express API & Backend
├── nginx.conf          # Reverse Proxy Configuration
├── Dockerfile          # Multi-stage build process
└── docker-compose.yml  # Service orchestration
```

## ⚠️ Important Note

**Anti-Debugging** is active. If you open the browser console (F12) while on the Player or Admin pages, the "Security Violation" screen will trigger and data fetching will be blocked. To debug, you must temporarily comment out the checkDevTools calls in the .js files and rebuild.