/**
 * copy-vendor.js
 *
 * Copies and/or minifies dist files from node_modules into public/vendor/.
 * Strategy per package:
 *
 *   shaka-player  — use the closure-compiled .min.js / minified CSS that the
 *                   package already ships (better than re-running Terser on it)
 *   pako          — already ships pako.min.js, copy as-is
 *   crypto-js     — ships only the unminified bundle, so we run Terser on it
 *   @fontsource   — CSS and WOFF2 are already optimised upstream
 *
 * CSS files get a lightweight regex strip (comments + redundant whitespace).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const NM     = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'public', 'vendor');

// ── helpers ──────────────────────────────────────────────────────────────────

function mkdir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Copy a file verbatim. */
function copy(src, dest) {
    if (!fs.existsSync(src)) { console.warn(`  [WARN] not found, skipping: ${src}`); return; }
    mkdir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    console.log(`  copy   ${path.relative(ROOT, dest)}  (${kb(src)})`);
}

/** Minify a JS file with Terser and write to dest. */
async function minifyJs(src, dest) {
    if (!fs.existsSync(src)) { console.warn(`  [WARN] not found, skipping: ${src}`); return; }
    const { minify } = require('terser');
    const code = fs.readFileSync(src, 'utf8');
    const result = await minify(code, {
        compress: { drop_console: false, passes: 2 },
        mangle: true,
        format: { comments: false },
    });
    mkdir(path.dirname(dest));
    fs.writeFileSync(dest, result.code, 'utf8');
    console.log(`  minify ${path.relative(ROOT, dest)}  ${kb(src)} → ${kbStr(result.code)}`);
}

/** Strip CSS comments and collapse whitespace. */
function minifyCss(src, dest) {
    if (!fs.existsSync(src)) { console.warn(`  [WARN] not found, skipping: ${src}`); return; }
    let css = fs.readFileSync(src, 'utf8');
    css = css
        .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
        .replace(/\s*([{};:,>~+])\s*/g, '$1')  // space around punctuation
        .replace(/\s{2,}/g, ' ')           // collapse runs of whitespace
        .replace(/^\s+|\s+$/gm, '')        // leading/trailing per line
        .trim();
    mkdir(path.dirname(dest));
    fs.writeFileSync(dest, css, 'utf8');
    console.log(`  css    ${path.relative(ROOT, dest)}  (${kbStr(css)})`);
}

function kb(filePath)   { return kbStr(fs.readFileSync(filePath)); }
function kbStr(data)    { return `${(Buffer.byteLength(data) / 1024).toFixed(1)} KB`; }

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\nBuilding vendor assets...\n');

    // ── Shaka Player ─────────────────────────────────────────────────────────
    // Use the compiled output — already aggressively optimised.
    copy(
        path.join(NM, 'shaka-player/dist/shaka-player.ui.js'),
        path.join(VENDOR, 'shaka-player.ui.js')
    );

    // ── mux.js ───────────────────────────────────────────────────────────────
    // Required by Shaka for TS stream support
    copy(
        path.join(NM, 'mux.js/dist/mux.min.js'),
        path.join(VENDOR, 'mux.min.js')
    );
    minifyCss(
        path.join(NM, 'shaka-player/dist/controls.css'),
        path.join(VENDOR, 'shaka-controls.css')
    );

    // ── pako ─────────────────────────────────────────────────────────────────
    // Already ships a .min.js — copy verbatim.
    copy(
        path.join(NM, 'pako/dist/pako.min.js'),
        path.join(VENDOR, 'pako.min.js')
    );

    // ── crypto-js ────────────────────────────────────────────────────────────
    // Only ships unminified; run Terser.
    await minifyJs(
        path.join(NM, 'crypto-js/crypto-js.js'),
        path.join(VENDOR, 'crypto-js.min.js')
    );

    // ── @fontsource/inter ─────────────────────────────────────────────────────
    // CSS @font-face sheets: minify.  WOFF2 binaries: copy verbatim.
    const interSrc  = path.join(NM, '@fontsource/inter');
    const interDest = path.join(VENDOR, 'fonts', 'inter');

    for (const weight of ['400', '600', '800']) {
        minifyCss(
            path.join(interSrc, `${weight}.css`),
            path.join(interDest, `${weight}.css`)
        );
    }

    const filesDir = path.join(interSrc, 'files');
    if (fs.existsSync(filesDir)) {
        mkdir(path.join(interDest, 'files'));
        for (const f of fs.readdirSync(filesDir)) {
            // Copy only latin WOFF2 to keep bundle size down (~500 KB vs ~2 MB)
            if (f.includes('latin') && f.endsWith('.woff2')) {
                copy(path.join(filesDir, f), path.join(interDest, 'files', f));
            }
        }
    }

    console.log('\nVendor build complete.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
