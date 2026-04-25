/**
 * scripts/bundle.js
 * Combines minified JS and CSS files into single bundles for production,
 * and updates the HTML files to point to the bundles.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function bundleIndex() {
    const htmlPath = path.join(PUBLIC, 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    // 1. Combine CSS
    // Note: We deliberately exclude fonts to avoid breaking relative url() paths.
    const cssFiles = [
        'vendor/shaka-controls.css',
        'app.css'
    ];
    let bundledCss = '';
    for (const f of cssFiles) {
        const filePath = path.join(PUBLIC, f);
        if (fs.existsSync(filePath)) {
            bundledCss += fs.readFileSync(filePath, 'utf8') + '\n';
        }
        const regex = new RegExp(`<link[^>]+href=["']/?${f.replace(/\./g, '\\.')}["'][^>]*>\\s*`, 'i');
        html = html.replace(regex, '');
    }
    fs.writeFileSync(path.join(PUBLIC, 'bundle.css'), bundledCss);
    
    // Inject bundle.css before the Flaticon links so they stay at the bottom of the head
    if (html.includes('flaticon.com')) {
        html = html.replace(/(<link[^>]+flaticon)/i, '<link rel="stylesheet" href="bundle.css">\n    $1');
    } else {
        html = html.replace('</head>', '    <link rel="stylesheet" href="bundle.css">\n</head>');
    }

    // 2. Combine JS
    const jsFiles = [
        'vendor/mux.min.js',
        'vendor/shaka-player.ui.js',
        'vendor/crypto-js.min.js',
        'vendor/pako.min.js',
        'app.js'
    ];
    let bundledJs = '';
    for (const f of jsFiles) {
        const filePath = path.join(PUBLIC, f);
        if (fs.existsSync(filePath)) {
            bundledJs += fs.readFileSync(filePath, 'utf8') + ';\n';
        }
        const regex = new RegExp(`<script[^>]+src=["']/?${f.replace(/\./g, '\\.')}["'][^>]*><\\/script>\\s*`, 'i');
        html = html.replace(regex, '');
    }
    fs.writeFileSync(path.join(PUBLIC, 'bundle.js'), bundledJs);
    html = html.replace('</body>', '    <script src="bundle.js"></script>\n</body>');

    fs.writeFileSync(htmlPath, html);
    console.log('✔ Bundled index.html assets (bundle.js, bundle.css)');
}

function bundleAdmin() {
    const htmlPath = path.join(PUBLIC, 'admin.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    // First fix CDN links in admin.html to use our local vendor files
    html = html.replace(
        'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js', 
        '/vendor/crypto-js.min.js'
    );
    html = html.replace(
        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">', 
        '<link rel="stylesheet" href="/vendor/fonts/inter/400.css">\n    <link rel="stylesheet" href="/vendor/fonts/inter/600.css">\n    <link rel="stylesheet" href="/vendor/fonts/inter/800.css">'
    );

    // 1. Combine CSS
    const cssFiles = ['admin.css'];
    let bundledCss = '';
    for (const f of cssFiles) {
        const filePath = path.join(PUBLIC, f);
        if (fs.existsSync(filePath)) {
            bundledCss += fs.readFileSync(filePath, 'utf8') + '\n';
        }
        const regex = new RegExp(`<link[^>]+href=["']/?${f.replace(/\./g, '\\.')}["'][^>]*>\\s*`, 'i');
        html = html.replace(regex, '');
    }
    fs.writeFileSync(path.join(PUBLIC, 'bundle-admin.css'), bundledCss);
    html = html.replace('</head>', '    <link rel="stylesheet" href="bundle-admin.css">\n</head>');

    // 2. Combine JS
    const jsFiles = [
        'vendor/crypto-js.min.js',
        'admin.js'
    ];
    let bundledJs = '';
    for (const f of jsFiles) {
        const filePath = path.join(PUBLIC, f);
        if (fs.existsSync(filePath)) {
            bundledJs += fs.readFileSync(filePath, 'utf8') + ';\n';
        }
        const regex = new RegExp(`<script[^>]+src=["']/?${f.replace(/\./g, '\\.')}["'][^>]*><\\/script>\\s*`, 'i');
        html = html.replace(regex, '');
    }
    fs.writeFileSync(path.join(PUBLIC, 'bundle-admin.js'), bundledJs);
    html = html.replace('</body>', '    <script src="bundle-admin.js"></script>\n</body>');

    fs.writeFileSync(htmlPath, html);
    console.log('✔ Bundled admin.html assets (bundle-admin.js, bundle-admin.css)');
}

try {
    bundleIndex();
    bundleAdmin();
} catch (e) {
    console.error('Error during bundling:', e);
    process.exit(1);
}
