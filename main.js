const { app, BrowserWindow, BrowserView, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let browserViews = [];
let activeAccountIndex = 0;
let totalAccountSlots = 2;
let isViewAttached = false;

const MAX_ACCOUNTS = 5;
const MAX_IMAGES_PER_SYNC = 20;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB per image (base64)
const TOPBAR_HEIGHT = 60;

// SEC-2 FIX: Strict base64 data URI validator for images
const SAFE_DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

// Sync files on Desktop - easy to find for upload
const SYNC_FILE_PATH = path.join(app.getPath('desktop'), 'Gemini_App_History.txt');
const SYNC_PDF_PATH = path.join(app.getPath('desktop'), 'Gemini_App_Media.pdf');

// Persist account count so app remembers added accounts after restart
const accountCountPath = path.join(app.getPath('userData'), 'account_count.json');

// Default Hardcoded Config (Guarantees appConfig is NEVER null even if file missing)
const FALLBACK_CONFIG = {
    version: 3,
    hideNativeSidebar: false,
    selectors: {
        editor: 'rich-textarea .ql-editor, rich-textarea [contenteditable="true"], .ql-editor, [contenteditable="true"], [role="textbox"]',
        sendButton: 'button[aria-label*="Send" i], .send-button',
        chatContainer: 'chat-app, main',
        chatNodes: 'user-query, model-response, [data-message-author], message-content',
        avatarClass: 'avatar',
        chatListLinks: 'a[href*="/app/"]',
        limitContainers: '[role="alert"], [aria-live], snack-bar-container, mat-snack-bar-container, .mat-mdc-snack-bar-container, input-container, .input-area-container, bottom-container',
        sidebarElements: 'mat-sidenav:not(mat-sidenav-content), side-navigation-drawer, navigation-drawer',
        sidebarContent: 'mat-sidenav-content, .mat-drawer-content',
        hamburgerMenu: 'button[aria-label="Main menu" i], .hamburger-menu',
        mainContent: 'main, .mat-sidenav-content'
    },
    regex: {
        limitMessages: [
            "You've reached your limit",
            "You’ve reached your limit",
            "reached your Gemini",
            "reached your usage limit"
        ],
        limitReset: 'try again (?:at|after)\\s+([\\d:]+\\s*[AP]M|[A-Za-z]+\\s+\\d+(?:,\\s*[\\d:]+\\s*[AP]M)?)'
    }
};

let appConfig = FALLBACK_CONFIG;
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-selectors.json');

// SEC-G3 FIX: Remote config DISABLED by default
const CONFIG_URL = null;

async function loadAppConfig() {
    if (CONFIG_URL) {
        try {
            const response = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(3000) });
            if (response.ok) {
                const fetched = await response.json();
                if (fetched && fetched.selectors && typeof fetched.selectors === 'object') {
                    appConfig = Object.assign({}, FALLBACK_CONFIG, fetched, {
                        selectors: Object.assign({}, FALLBACK_CONFIG.selectors, fetched.selectors),
                        regex: Object.assign({}, FALLBACK_CONFIG.regex, fetched.regex || {})
                    });
                    return;
                }
            }
        } catch (e) {
            // Fallback to local config
        }
    }

    try {
        if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
            const local = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
            if (local && local.selectors && typeof local.selectors === 'object') {
                appConfig = Object.assign({}, FALLBACK_CONFIG, local, {
                    selectors: Object.assign({}, FALLBACK_CONFIG.selectors, local.selectors),
                    regex: Object.assign({}, FALLBACK_CONFIG.regex, local.regex || {})
                });
            }
        }
    } catch (e) {
        appConfig = FALLBACK_CONFIG;
    }
}

function getSavedAccountCount() {
    try {
        if (fs.existsSync(accountCountPath)) {
            const data = JSON.parse(fs.readFileSync(accountCountPath, 'utf8'));
            const parsed = Number.isInteger(data.count) ? data.count : 2;
            return Math.max(2, Math.min(parsed, MAX_ACCOUNTS));
        }
    } catch (e) { /* use default */ }
    return 2;
}

function saveAccountCount(count) {
    try {
        const userDataDir = app.getPath('userData');
        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }
        fs.writeFileSync(accountCountPath, JSON.stringify({ count: count }), 'utf8');
    } catch (e) { /* ignore */ }
}

// SEC-1 FIX: Validate URLs allowed to load inside Gemini BrowserViews (Gemini + Google Sign-In)
function isAllowedInAppUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();

        if (
            host === 'gemini.google.com' ||
            host === 'accounts.google.com' ||
            host === 'myaccount.google.com' ||
            host === 'consent.google.com' ||
            host === 'gds.google.com' ||
            host === 'ogs.google.com'
        ) {
            return true;
        }
        // Regional Google account domains & Google SetSID session cookie sync
        if (/^accounts\.google\.[a-z.]+$/i.test(host)) return true;
        if (host === 'accounts.youtube.com' && parsed.pathname.startsWith('/accounts/')) return true;
        if (host === 'www.google.com' && parsed.pathname.startsWith('/accounts/')) return true;

        return false;
    } catch (e) {
        return false;
    }
}

function isSafeExternalHttpUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (e) {
        return false;
    }
}

// SEC-G7 & SEC-4 FIX: Sender validation helpers
function isFromMainWindow(event) {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && event && event.sender && event.sender.id === mainWindow.webContents.id);
}

function isFromBrowserView(event) {
    if (!event || !event.sender) return false;
    return browserViews.some((v) => v && !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
}

function isValidAccountIndex(index) {
    return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < totalAccountSlots;
}

// QA-3, QA-8 & SEC-1 FIX: Lazy-load BrowserViews on demand with sandbox, clean Chrome UA & external link guard
function ensureBrowserView(index) {
    if (!isValidAccountIndex(index)) return null;
    if (browserViews[index] && !browserViews[index].webContents.isDestroyed()) {
        return browserViews[index];
    }

    const view = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            partition: 'persist:gemini-account-' + index
        }
    });

    // QA-8 FIX: Use standard Chrome User-Agent so Google Sign-In doesn't block Electron UA
    const defaultUA = view.webContents.getUserAgent();
    const cleanUA = defaultUA
        .replace(/\s*Electron\/[\d.]+/gi, '')
        .replace(/\s*gemini-multi-account\/[\d.]+/gi, '');
    view.webContents.setUserAgent(cleanUA);

    // SEC-1 FIX: Intercept popup windows (open external links safely in OS browser)
    view.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedInAppUrl(url)) {
            view.webContents.loadURL(url);
            return { action: 'deny' };
        }
        if (isSafeExternalHttpUrl(url)) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    // SEC-1 FIX: Prevent main-frame navigation away from Gemini / Google Auth
    view.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedInAppUrl(url)) {
            event.preventDefault();
            if (isSafeExternalHttpUrl(url)) {
                shell.openExternal(url);
            }
        }
    });

    browserViews[index] = view;
    view.webContents.loadURL('https://gemini.google.com/app');
    return view;
}

// QA-7 FIX: Use getContentBounds() for exact pixel-perfect sizing across DPI scaling & maximize
function updateViewBounds() {
    if (!mainWindow || mainWindow.isDestroyed() || !isViewAttached) return;
    const contentBounds = mainWindow.getContentBounds();
    const activeView = browserViews[activeAccountIndex];
    if (activeView && !activeView.webContents.isDestroyed()) {
        activeView.setBounds({
            x: 0,
            y: TOPBAR_HEIGHT,
            width: Math.max(100, contentBounds.width),
            height: Math.max(100, contentBounds.height - TOPBAR_HEIGHT)
        });
    }
}

function scheduleBoundsUpdate() {
    updateViewBounds();
    setTimeout(updateViewBounds, 60);
}

function attachActiveView() {
    if (!mainWindow || mainWindow.isDestroyed() || isViewAttached) return;
    const activeView = ensureBrowserView(activeAccountIndex);
    if (activeView) {
        mainWindow.addBrowserView(activeView);
        isViewAttached = true;
        updateViewBounds();
    }
}

function detachActiveView() {
    if (!mainWindow || mainWindow.isDestroyed() || !isViewAttached) return;
    const activeView = browserViews[activeAccountIndex];
    if (activeView) {
        try {
            mainWindow.removeBrowserView(activeView);
        } catch (e) { /* ignore if already detached */ }
        isViewAttached = false;
    }
}

function switchAccount(index) {
    if (!isValidAccountIndex(index)) return;
    detachActiveView();
    activeAccountIndex = index;
    ensureBrowserView(index);
    attachActiveView();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('account-switched', index);
    }
}

function createWindow() {
    totalAccountSlots = getSavedAccountCount();

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 640,
        minHeight: 480,
        webPreferences: {
            preload: path.join(__dirname, 'preload-main.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
        },
        title: 'Gemini Seamless Multi-Account',
        autoHideMenuBar: true
    });

    // Block unexpected popups/navigation on the main shell window
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

    mainWindow.on('resize', updateViewBounds);
    mainWindow.on('maximize', scheduleBoundsUpdate);
    mainWindow.on('unmaximize', scheduleBoundsUpdate);
    mainWindow.on('enter-full-screen', scheduleBoundsUpdate);
    mainWindow.on('leave-full-screen', scheduleBoundsUpdate);

    mainWindow.on('closed', () => {
        isViewAttached = false;
        browserViews = [];
        mainWindow = null;
    });

    mainWindow.loadFile('index.html');

    // QA-3 FIX: Only load Account 1 on startup (other accounts lazy-load on demand for instant startup & low RAM)
    ensureBrowserView(0);
    switchAccount(0);
}

// QA-3 FIX: Single Instance Lock prevents double-launch cache corruption & slowdowns
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        await loadAppConfig();
        createWindow();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
}

// ========== IPC Handlers ==========

ipcMain.on('switch-account', (event, index) => {
    if (!isFromMainWindow(event)) return;
    switchAccount(index);
});

ipcMain.on('get-config', (event) => {
    if (!isFromBrowserView(event) && !isFromMainWindow(event)) {
        event.returnValue = null;
        return;
    }
    event.returnValue = appConfig || FALLBACK_CONFIG;
});

ipcMain.on('hide-active-view', (event) => {
    if (!isFromMainWindow(event)) return;
    detachActiveView();
});

ipcMain.on('show-active-view', (event) => {
    if (!isFromMainWindow(event)) return;
    attachActiveView();
});

ipcMain.on('add-account', (event) => {
    if (!isFromMainWindow(event)) return;
    if (totalAccountSlots < MAX_ACCOUNTS) {
        const nextIndex = totalAccountSlots;
        totalAccountSlots += 1;
        saveAccountCount(totalAccountSlots);
        mainWindow.webContents.send('account-added', nextIndex);
    }
});

// ========== SYNC CONTEXT (SECURE FILE-BASED) ==========
ipcMain.on('sync-context', async (event, data) => {
    if (!isFromMainWindow(event)) return;
    if (!data || typeof data !== 'object') return;

    const { targetAccount, diffText, images } = data;
    if (!isValidAccountIndex(targetAccount)) return;

    const targetView = ensureBrowserView(targetAccount);
    if (!targetView) return;

    // SEC-G10 & SEC-2 FIX: Strictly validate image count, byte size, and base64 data URI format
    const rawImgs = Array.isArray(images) ? images : [];
    const imgArray = rawImgs.slice(0, MAX_IMAGES_PER_SYNC).filter((img) => {
        return (
            img &&
            typeof img.data === 'string' &&
            img.data.length < MAX_IMAGE_SIZE_BYTES &&
            SAFE_DATA_IMAGE_RE.test(img.data)
        );
    });

    let pdfWin = null;
    let tempHtmlPath = null;

    try {
        // Focus the Gemini prompt editor
        await targetView.webContents.executeJavaScript(
            '(function() {' +
            '  var config = ' + JSON.stringify(appConfig.selectors) + ';' +
            '  var editorSelectors = (config.editor || "").split(",").map(function(s) { return s.trim(); });' +
            '  for (var i = 0; i < editorSelectors.length; i++) {' +
            '    if (!editorSelectors[i]) continue;' +
            '    var editor = document.querySelector(editorSelectors[i]);' +
            '    if (editor) { editor.focus(); editor.click(); return true; }' +
            '  }' +
            '  return false;' +
            '})()'
        ).catch(() => false);

        // SEC-5 FIX: Add Privacy Warning header to exported chat history file
        const privacyHeader =
            '====================================================================\n' +
            '[PRIVACY WARNING / ආරක්ෂක අවවාදය]\n' +
            'මෙම ගොනුවේ ඔබගේ පුද්ගලික Gemini සංවාද (Chat History) අඩංගු වේ.\n' +
            'මෙය GitHub, Discord හෝ වෙනත් පොදු තැන්වල Share කිරීමෙන් වළකින්න!\n' +
            'DO NOT share this file publicly — it may contain private data or keys.\n' +
            '====================================================================\n\n';

        const safeDiffText = typeof diffText === 'string' ? diffText : '';
        try {
            fs.writeFileSync(SYNC_FILE_PATH, privacyHeader + safeDiffText, 'utf8');
        } catch (writeErr) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('file-ready', {
                    error: 'Desktop එකට Gemini_App_History.txt Save කිරීමට නොහැකි විය: ' + writeErr.message
                });
            }
            return;
        }

        let hasPdf = false;
        let pdfWarning = null;

        if (imgArray.length > 0) {
            // SEC-2 & QA-5 FIX: Render via temporary local HTML file (supports >2MB images) with javascript: false
            const htmlParts = [
                '<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
                'body { font-family: sans-serif; text-align: center; background: #fff; padding: 20px; margin: 0; }',
                '.image-container { margin-bottom: 40px; page-break-inside: avoid; }',
                'h2 { color: #333; margin-bottom: 10px; font-size: 22px; font-weight: bold; }',
                'img { max-width: 100%; max-height: 800px; border: 2px solid #ccc; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }',
                '</style></head><body>',
                '<h1 style="color: #10a37f; margin-bottom: 30px;">Chat Images Reference</h1>'
            ];

            imgArray.forEach((img, idx) => {
                const safeName = String(img.name || ('Image ' + (idx + 1))).replace(/[<>&"']/g, '');
                const cleanSrc = img.data.replace(/\s+/g, '');
                htmlParts.push('<div class="image-container">');
                htmlParts.push('<h2>[' + safeName + ']</h2>');
                htmlParts.push('<img src="' + cleanSrc + '" />');
                htmlParts.push('</div>');
            });

            htmlParts.push('</body></html>');
            tempHtmlPath = path.join(
                app.getPath('temp'),
                'gemini_sync_media_' + process.pid + '_' + Date.now() + '.html'
            );
            fs.writeFileSync(tempHtmlPath, htmlParts.join('\n'), 'utf8');

            pdfWin = new BrowserWindow({
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    javascript: false,
                    webSecurity: true
                }
            });
            pdfWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

            await pdfWin.loadFile(tempHtmlPath);
            await new Promise((resolve) => setTimeout(resolve, 350));

            const pdfBuffer = await pdfWin.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4'
            });

            try {
                fs.writeFileSync(SYNC_PDF_PATH, pdfBuffer);
                hasPdf = true;
            } catch (pdfErr) {
                pdfWarning = 'Gemini_App_Media.pdf වෙනත් වැඩසටහනක Open වී ඇති නිසා Update කිරීමට නොහැකි විය. එය Close කර නැවත උත්සාහ කරන්න.';
            }
        } else {
            // SEC-5 FIX: Remove stale PDF from previous chat syncs so old images aren't accidentally uploaded
            try {
                if (fs.existsSync(SYNC_PDF_PATH)) {
                    fs.unlinkSync(SYNC_PDF_PATH);
                }
            } catch (e) { /* ignore if locked */ }
        }

        const promptText = hasPdf
            ? '\u0d9a\u0dbb\u0dd4\u0dab\u0dcf\u0d9a\u0dbb\u0dbd\u0dcf \u0db8\u0dda attach \u0d9a\u0dbb\u0db4\u0dd4 \u0dc6\u0dba\u0dd2\u0dbd\u0dca 2\u0d9a\u0db8 \u0db6\u0dbd\u0db1\u0dca\u0db1. Gemini_App_History.txt \u0dc6\u0dba\u0dd2\u0dbd\u0dca \u0d91\u0d9a\u0dda \u0dad\u0dd2\u0dba\u0dd9\u0db1 Chat history \u0d91\u0d9a \u0d9a\u0dd2\u0dba\u0dc0\u0dbd\u0dcf, \u0d91\u0d9a\u0dda \u0db1\u0dd0\u0dc0\u0dad\u0dd4\u0dab \u0dad\u0dd0\u0db1 \u0d89\u0daf\u0db1\u0dca \u0d9a\u0dad\u0dcf \u0d9a\u0dbb\u0db1\u0dca\u0db1. \u0db4\u0dd2\u0db1\u0dca\u0dad\u0dd6\u0dbb \u0d9c\u0dd0\u0db1 \u0dc3\u0db3\u0dc4\u0db1\u0d9a\u0dca \u0dad\u0dd2\u0db6\u0dd4\u0dab\u0ddc\u0dad\u0dca, Gemini_App_Media.pdf \u0d91\u0d9a\u0dd9\u0db1\u0dca \u0d91\u0dda \u0d85\u0daf\u0dcf\u0dc5 \u0db4\u0dd2\u0db1\u0dca\u0dad\u0dd6\u0dbb\u0dba \u0db6\u0dbd\u0db1\u0dca\u0db1.'
            : '\u0d9a\u0dbb\u0dd4\u0dab\u0dcf\u0d9a\u0dbb\u0dbd\u0dcf \u0db8\u0dda attach \u0d9a\u0dbb\u0db4\u0dd4 Gemini_App_History.txt \u0dc6\u0dba\u0dd2\u0dbd\u0dca \u0d91\u0d9a\u0dda \u0dad\u0dd2\u0dba\u0dd9\u0db1 Chat history \u0d91\u0d9a \u0d9a\u0dd2\u0dba\u0dc0\u0dbd\u0dcf, \u0d91\u0d9a\u0dda \u0db1\u0dd0\u0dc0\u0dad\u0dd4\u0dab \u0dad\u0dd0\u0db1 \u0d89\u0daf\u0db1\u0dca \u0d9a\u0dad\u0dcf \u0d9a\u0dbb\u0db1\u0dca\u0db1.';

        setTimeout(() => {
            if (targetView && !targetView.webContents.isDestroyed()) {
                targetView.webContents.insertText(promptText);
            }
        }, 300);

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-ready', {
                textPath: SYNC_FILE_PATH,
                pdfPath: hasPdf ? SYNC_PDF_PATH : null,
                warning: pdfWarning
            });
        }
    } catch (e) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-ready', {
                error: 'Context Sync කිරීමේදී දෝෂයක් ඇති විය: ' + (e && e.message ? e.message : 'Unknown error')
            });
        }
    } finally {
        if (pdfWin && !pdfWin.isDestroyed()) {
            pdfWin.destroy();
        }
        if (tempHtmlPath) {
            try {
                if (fs.existsSync(tempHtmlPath)) fs.unlinkSync(tempHtmlPath);
            } catch (e) { /* ignore */ }
        }
    }
});

// SEC-4 FIX: Validate sender before opening Explorer
ipcMain.on('open-sync-folder', (event) => {
    if (!isFromMainWindow(event)) return;
    if (fs.existsSync(SYNC_FILE_PATH)) {
        shell.showItemInFolder(SYNC_FILE_PATH);
    } else {
        shell.openPath(app.getPath('desktop'));
    }
});

// SEC-4 & QA-8 FIX: Validate sender & accountIndex, and normalize relative/absolute chat URLs cleanly
ipcMain.handle('get-chat-list', async (event, accountIndex) => {
    if (!isFromMainWindow(event)) return [];
    if (!isValidAccountIndex(accountIndex)) return [];

    const view = browserViews[accountIndex];
    if (!view || view.webContents.isDestroyed()) return [];

    try {
        const items = await view.webContents.executeJavaScript(
            '(function() {' +
            '  var config = ' + JSON.stringify(appConfig.selectors) + ';' +
            '  var items = [];' +
            '  var seen = new Set();' +
            '  var links = document.querySelectorAll(config.chatListLinks);' +
            '  links.forEach(function(link) {' +
            '    var rawHref = link.getAttribute("href");' +
            '    if (!rawHref) return;' +
            '    var fullUrl;' +
            '    try {' +
            '      fullUrl = new URL(rawHref, "https://gemini.google.com").href;' +
            '    } catch (e) { return; }' +
            '    if (!fullUrl.startsWith("https://gemini.google.com/app/") || fullUrl === "https://gemini.google.com/app/" || seen.has(fullUrl)) return;' +
            '    seen.add(fullUrl);' +
            '    var title = (link.textContent || "").trim().replace(/\\s+/g, " ");' +
            '    if (title.length > 60) title = title.substring(0, 57) + "...";' +
            '    if (title.length > 0) {' +
            '      items.push({ title: title, url: fullUrl });' +
            '    }' +
            '  });' +
            '  return items;' +
            '})()'
        );
        return Array.isArray(items) ? items : [];
    } catch (e) {
        return [];
    }
});

// SEC-G9 & SEC-4 FIX: Strict URL origin/prefix check & null-safe destructuring
ipcMain.on('navigate-view', (event, data) => {
    if (!isFromMainWindow(event)) return;
    if (!data || typeof data !== 'object') return;
    const { accountIndex, url } = data;
    if (!isValidAccountIndex(accountIndex)) return;
    if (!url || typeof url !== 'string' || !url.startsWith('https://gemini.google.com/')) {
        return;
    }
    const view = ensureBrowserView(accountIndex);
    if (view) {
        view.webContents.loadURL(url);
    }
});

// ========== CHAT HISTORY EXTRACTION (QA-1 & SEC-4 FIXED) ==========
ipcMain.on('request-chat-history', async (event, accountIndex) => {
    if (!isFromMainWindow(event)) return;
    if (!isValidAccountIndex(accountIndex)) return;

    const view = browserViews[accountIndex];
    if (!view || view.webContents.isDestroyed()) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('view-event', {
                type: 'chat-history-data',
                blocks: { chatBlocks: [], images: [] },
                accountIndex: accountIndex,
                viewUrl: ''
            });
        }
        return;
    }

    const viewUrl = view.webContents.getURL();

    try {
        const blocks = await view.webContents.executeJavaScript(
            '(async () => {' +
            '  const config = ' + JSON.stringify(appConfig.selectors) + ';' +
            '  const chatContainer = document.querySelector(config.chatContainer) || document.body;' +
            '  const nodes = Array.from(chatContainer.querySelectorAll(config.chatNodes));' +
            '  const uniqueNodes = nodes.filter((node, index, self) => {' +
            '    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;' +
            '    return !self.some((otherNode, otherIndex) => {' +
            '      return index !== otherIndex && otherNode.contains(node);' +
            '    });' +
            '  });' +
            '' +
            '  const result = [];' +
            '  const extractedImages = [];' +
            '  let imageCounter = 1;' +
            '' +
            '  async function getBase64(url) {' +
            '    try {' +
            '      const response = await fetch(url);' +
            '      const blob = await response.blob();' +
            '      return new Promise((resolve) => {' +
            '        const reader = new FileReader();' +
            '        reader.onloadend = () => resolve(reader.result);' +
            '        reader.onerror = () => resolve(null);' +
            '        reader.readAsDataURL(blob);' +
            '      });' +
            '    } catch (e) {' +
            '      return null;' +
            '    }' +
            '  }' +
            '' +
            '  function imgToCanvas(imgEl) {' +
            '    try {' +
            '      const canvas = document.createElement("canvas");' +
            '      canvas.width = imgEl.naturalWidth || imgEl.width || 300;' +
            '      canvas.height = imgEl.naturalHeight || imgEl.height || 300;' +
            '      const ctx = canvas.getContext("2d");' +
            '      ctx.drawImage(imgEl, 0, 0);' +
            '      return canvas.toDataURL("image/png");' +
            '    } catch (e) {' +
            '      return null;' +
            '    }' +
            '  }' +
            '' +
            '  for (const el of uniqueNodes) {' +
            '    let role = "AI";' +
            '    const author = el.dataset ? el.dataset.messageAuthor : "";' +
            '    const className = (typeof el.className === "string") ? el.className.toLowerCase() : "";' +
            '    const tag = el.tagName.toLowerCase();' +
            '    if (author === "user" || tag === "user-query" || className.includes("user-query") || className.includes("user") || tag.includes("user")) {' +
            '      role = "User";' +
            '    }' +
            '' +
            '    const clone = el.cloneNode(true);' +
            '    const originalImgs = Array.from(el.querySelectorAll("img"));' +
            '    const cloneImgs = Array.from(clone.querySelectorAll("img"));' +
            '' +
            '    for (let i = 0; i < originalImgs.length; i++) {' +
            '      const originalImg = originalImgs[i];' +
            '      const cloneImg = cloneImgs[i];' +
            '      if (!cloneImg) continue;' +
            '      const imgClass = (typeof originalImg.className === "string") ? originalImg.className.toLowerCase() : "";' +
            '      const w = originalImg.naturalWidth || originalImg.width || 0;' +
            '      const h = originalImg.naturalHeight || originalImg.height || 0;' +
            '      if (imgClass.includes(config.avatarClass) || (w > 0 && w < 24) || (h > 0 && h < 24)) {' +
            '        cloneImg.remove();' +
            '        continue;' +
            '      }' +
            '      const src = originalImg.src;' +
            '' +
            '      let base64 = null;' +
            '      if (src && src.startsWith("data:image")) {' +
            '        base64 = src;' +
            '      } else if (src && (src.startsWith("blob:") || src.startsWith("http"))) {' +
            '        base64 = await getBase64(src);' +
            '      }' +
            '' +
            '      if (!base64) {' +
            '        try { base64 = imgToCanvas(originalImg); } catch (e) {}' +
            '      }' +
            '' +
            '      if (base64 && base64.startsWith("data:image/")) {' +
            '        const label = "\\n[Attached PDF Image " + imageCounter + "]\\n";' +
            '        extractedImages.push({ name: "Image " + imageCounter, data: base64 });' +
            '        if (cloneImg.parentNode) {' +
            '          cloneImg.parentNode.replaceChild(document.createTextNode(label), cloneImg);' +
            '        }' +
            '        imageCounter++;' +
            '      } else {' +
            '        cloneImg.remove();' +
            '      }' +
            '    }' +
            '' +
            '    clone.querySelectorAll("button, [role=\\"button\\"], [role=\\"toolbar\\"], message-actions, mat-icon, svg, script, style, noscript, .action-buttons, .response-footer").forEach((uiEl) => uiEl.remove());' +
            '' +
            '    let text = clone.innerText ? clone.innerText.trim() : (clone.textContent ? clone.textContent.trim() : "");' +
            '    if (!text || text.includes("--- CONTEXT SYNC")) continue;' +
            '    text = text.replace(/^You said\\s*/i, "").replace(/^Gemini said\\s*/i, "").trim();' +
            '    if (text.length >= 1) {' +
            '      result.push(role + ":\\n" + text);' +
            '    }' +
            '  }' +
            '' +
            '  return { chatBlocks: result, images: extractedImages };' +
            '})()'
        );

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('view-event', {
                type: 'chat-history-data',
                blocks: blocks,
                accountIndex: accountIndex,
                viewUrl: viewUrl
            });
        }
    } catch (e) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('view-event', {
                type: 'chat-history-data',
                blocks: { chatBlocks: [], images: [] },
                accountIndex: accountIndex,
                viewUrl: viewUrl
            });
        }
    }
});

// ========== PRELOAD BRIDGE (SEC-1 FIXED: Strict Schema Whitelist) ==========
ipcMain.on('from-preload-to-main', (event, data) => {
    if (!data || typeof data !== 'object') return;
    const accountIndex = browserViews.findIndex((v) => v && !v.webContents.isDestroyed() && v.webContents.id === event.sender.id);
    if (accountIndex === -1) return;

    if (data.type === 'limit-reached') {
        const cleanResetTime = typeof data.resetTime === 'string'
            ? data.resetTime.replace(/[<>&"']/g, '').substring(0, 40)
            : 'Soon';
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('view-event', {
                type: 'limit-reached',
                accountIndex: accountIndex,
                resetTime: cleanResetTime
            });
        }
    } else if (data.type === 'url-changed') {
        if (typeof data.url === 'string' && data.url.startsWith('https://gemini.google.com/')) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('view-event', {
                    type: 'url-changed',
                    accountIndex: accountIndex,
                    url: data.url
                });
            }
        }
    }
});

// SEC-4 & QA-3 FIX: Validate sender and return totalAccountSlots (supports lazy-loaded accounts)
ipcMain.handle('get-accounts-count', (event) => {
    if (!isFromMainWindow(event)) return 2;
    return totalAccountSlots;
});
