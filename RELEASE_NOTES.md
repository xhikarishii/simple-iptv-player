# Release Notes - v1.0.5

This release focuses on major performance optimizations, TV mode enhancements, and improved stability for high-resolution displays.

## 🚀 Key Improvements

### 📺 TV & Big Screen Experience
- **Optimized UI Scaling**: Elements are now larger and better scaled for big screens and 4K displays.
- **Revamped Iconography**: New high-quality icons for a cleaner, more modern TV interface.
- **Manual Mode Toggle**: Added a user setting to manually switch between TV and Desktop modes.
- **Improved UA Detection**: Better identification of Smart TVs and set-top boxes for automatic mode switching.

### ⚡ Performance & Stability
- **Local Dependency Bundling**: Scripts and styles are now loaded locally instead of via CDN, improving load times and offline reliability.
- **Shaka Player Optimizations**: Enabled Adaptive Bitrate (ABR) for smoother playback and faster channel switching.
- **Nginx Enhancements**: Further optimizations to the internal proxy for better stream handling.

### 🛠️ Player & EPG Updates
- **Resolution Badge**: The "Now Playing" overlay now displays the current stream resolution.
- **Aspect Ratio Control**: Fixed issues with aspect ratio toggling and container resizing.
- **EPG Fallbacks**: Improved labeling for channels when no EPG program data is found.

### 🔒 Security
- **Encryption Refactor**: Overhauled the encryption logic for both server-side storage and client-side communication.

---
*For more details, check the commit history on GitHub.*
