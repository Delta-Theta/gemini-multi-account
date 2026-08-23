const { app, BrowserWindow, BrowserView, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let browserViews = [];
let activeAccountIndex = 0;
const MAX_ACCOUNTS = 5;
const MAX_IMAGES_PER_SYNC = 20;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB per image (base64)

// Sync files on Desktop - easy to find, always overwritten
const SYNC_FILE_PATH = path.join(app.getPath('desktop'), 'Gemini_App_History.txt');
const SYNC_PDF_PATH = path.join(app.getPath('desktop'), 'Gemini_App_Media.pdf');

// Persist account count so app remembers added accounts after restart
const accountCountPath = path.join(app.getPath('userData'), 'account_count.json');

// Default Hardcoded Config (Guarantees appConfig is NEVER null even if file missing)
const FALLBACK_CONFIG = {
    version: 1,
    selectors: {
        editor: 'rich-textarea, .ql-editor, [contenteditable="true"], [role="textbox"]',
        sendButton: 'button[aria-label*="Send"], button[aria-label*="send"], .send-button',
        chatContainer: 'chat-app',
        chatNodes: 'user-query, model-response, [data-message-author], message-content',
        avatarClass: 'avatar',
        sidebarElements: 'navigation-drawer, side-navigation-drawer, [data-test-id="conversation-list"], .mat-drawer, nav',
        hamburgerMenu: '[aria-label="Main menu"], .hamburger-menu',
        mainContent: 'main, .page-content, .main-content',
        chatListLinks: 'a[href*="/app/"]'
    },
    regex: {
        limitMessages: ["You've reached your limit", "limit reached"],
        limitReset: "try again at ([\\d:]+\\s[AP]M)"
    }
};

// Global app config for Dynamic Selectors
let appConfig = FALLBACK_CONFIG;
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-selectors.json');

// SEC-G3 FIX: Remote config DISABLED — the placeholder URL didn't point to a real repo.
// If you want remote config, host your own selectors.json and set the URL below:
// const CONFIG_URL = "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/selectors.json";
const CONFIG_URL = null;

async function loadAppConfig() {
    // Remote config fetch (only if a real URL is configured)
    if (CONFIG_URL) {
        try {
            const response = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(3000) });
            if (response.ok) {
                const fetched = await response.json();
                // Validate config schema before using
                if (fetched && fetched.selectors && typeof fetched.selectors === 'object') {
                    appConfig = fetched;
                    return;
                }
            }
        } catch (e) {
            // Fallback to local
        }
    }
    
    // Local default-selectors.json
    try {
        if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
            const local = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
            if (local && local.selectors) {
                appConfig = local;
            }
        }
    } catch (e) {
        // Use built-in FALLBACK_CONFIG
    }
}

function getSavedAccountCount() {
    try {
        if (fs.existsSync(accountCountPath)) {
            const data = JSON.parse(fs.readFileSync(accountCountPath, 'utf8'));
            return Math.max(2, Math.min(data.count || 2, MAX_ACCOUNTS));
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
        fs.writeFileSync(accountCountPath, JSON.stringify({ count: count }));
    } catch (e) { /* ignore */ }
}

// Simple local database for topics
const dbPath = path.join(app.getPath('userData'), 'topics.json');
let topicsDb = { topics: [] };

if (fs.existsSync(dbPath)) {
    try {
        topicsDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        if (!Array.isArray(topicsDb.topics)) {
            topicsDb.topics = [];
        }
    } catch (e) {
        topicsDb = { topics: [] };
    }
}

function saveDb() {
    try {
        fs.writeFileSync(dbPath, JSON.stringify(topicsDb, null, 2));
    } catch (e) { /* ignore */ }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            // SEC-G1 FIX: Secure Electron configuration
            preload: path.join(__dirname, 'preload-main.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        title: "Gemini Seamless Multi-Account",
        autoHideMenuBar: true
    });

    mainWindow.loadFile('index.html');

    // Initialize accounts - restore saved count
    const savedCount = getSavedAccountCount();
    for (let i = 0; i < savedCount; i++) {
        createBrowserView(i);
    }

    mainWindow.on('resize', updateViewBounds);
    switchAccount(0);
}

function createBrowserView(index) {
    if (browserViews[index]) return;

    const view = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            partition: 'persist:gemini-account-' + index
        }
    });

    browserViews[index] = view;
    view.webContents.loadURL('https://gemini.google.com/app');
}

let isViewAttached = false;

function updateViewBounds() {
    if (!mainWindow || !isViewAttached) return;
    const bounds = mainWindow.getBounds();
    const activeView = browserViews[activeAccountIndex];
    if (activeView) {
        activeView.setBounds({ x: 250, y: 60, width: Math.max(100, bounds.width - 250 - 16), height: Math.max(100, bounds.height - 60 - 39) });
    }
}

function attachActiveView() {
    if (!mainWindow || isViewAttached) return;
    const activeView = browserViews[activeAccountIndex];
    if (activeView) {
        mainWindow.addBrowserView(activeView);
        isViewAttached = true;
        updateViewBounds();
    }
}

function detachActiveView() {
    if (!mainWindow || !isViewAttached) return;
    const activeView = browserViews[activeAccountIndex];
    if (activeView) {
        mainWindow.removeBrowserView(activeView);
        isViewAttached = false;
    }
}

function switchAccount(index) {
    if (typeof index === 'number' && index >= 0 && index < browserViews.length && browserViews[index]) {
        detachActiveView();
        activeAccountIndex = index;
        attachActiveView();
        mainWindow.webContents.send('account-switched', index);
    }
}

// SEC-G7 FIX: Helper to validate IPC sender is our main window
function isFromMainWindow(event) {
    return mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id;
}

app.whenReady().then(async () => {
    // SEC-G6 FIX: Auto-start DISABLED by default.
    // Uncomment below if you want the app to start with Windows:
    // app.setLoginItemSettings({ openAtLogin: true, path: app.getPath("exe") });

    await loadAppConfig();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ========== IPC Handlers ==========

ipcMain.on('switch-account', (event, index) => {
    if (!isFromMainWindow(event)) return;
    switchAccount(index);
});

ipcMain.on('get-config', (event) => {
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
    const nextIndex = browserViews.length;
    if (nextIndex < MAX_ACCOUNTS) {
        createBrowserView(nextIndex);
        saveAccountCount(browserViews.length);
        mainWindow.webContents.send('account-added', nextIndex);
    }
});

// ========== SYNC CONTEXT (FILE-BASED) ==========
ipcMain.on('sync-context', async (event, data) => {
    if (!isFromMainWindow(event)) return;
    const { targetAccount, diffText, images } = data || {};
    
    // SEC-G10 FIX: Limit image count and size
    const rawImgs = images || [];
    const imgArray = rawImgs.slice(0, MAX_IMAGES_PER_SYNC).filter(function(img) {
        return img && img.data && typeof img.data === 'string' && img.data.length < MAX_IMAGE_SIZE_BYTES;
    });
    
    const targetView = browserViews[targetAccount];
    if (!targetView) return;

    let pdfWin = null;
    try {
        // Focus the editor (Dynamic Config)
        await targetView.webContents.executeJavaScript(
            '(function() {' +
            '  var config = ' + JSON.stringify(appConfig.selectors) + ';' +
            '  var editorSelectors = (config.editor || "").split(",").map(function(s) { return s.trim(); });' +
            '  var editor = null;' +
            '  for (var i = 0; i < editorSelectors.length; i++) {' +
            '    if (!editorSelectors[i]) continue;' +
            '    editor = document.querySelector(editorSelectors[i]);' +
            '    if (editor) break;' +
            '  }' +
            '  if (editor) { editor.focus(); editor.click(); return true; }' +
            '  return false;' +
            '})()'
        );

        // Save text context safely
        try {
            fs.writeFileSync(SYNC_FILE_PATH, diffText || "", 'utf8');
        } catch (e) { /* ignore file write error */ }
        
        let hasPdf = false;
        
        // Generate PDF if there are images
        if (imgArray.length > 0) {
            hasPdf = true;
            
            var htmlParts = [];
            htmlParts.push('<!DOCTYPE html><html><head><meta charset="utf-8"><style>');
            htmlParts.push('body { font-family: sans-serif; text-align: center; background: #fff; padding: 20px; margin: 0; }');
            htmlParts.push('.image-container { margin-bottom: 40px; page-break-inside: avoid; }');
            htmlParts.push('h2 { color: #333; margin-bottom: 10px; font-size: 24px; font-weight: bold; }');
            htmlParts.push('img { max-width: 100%; max-height: 800px; border: 2px solid #ccc; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }');
            htmlParts.push('</style></head><body>');
            htmlParts.push('<h1 style="color: #10a37f; margin-bottom: 30px;">Chat Images Reference</h1>');
            
            imgArray.forEach(function(img) {
                // SEC-G4: Sanitize image name to prevent HTML injection
                var safeName = String(img.name || 'Image').replace(/[<>&"']/g, '');
                htmlParts.push('<div class="image-container">');
                htmlParts.push('<h2>[' + safeName + ']</h2>');
                htmlParts.push('<img src="' + img.data + '" />');
                htmlParts.push('</div>');
            });
            
            htmlParts.push('</body></html>');
            var htmlString = htmlParts.join('\n');

            pdfWin = new BrowserWindow({ show: false });
            await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlString));
            
            await new Promise(function(resolve) { setTimeout(resolve, 1500); });
            
            const pdfBuffer = await pdfWin.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4'
            });
            
            try {
                fs.writeFileSync(SYNC_PDF_PATH, pdfBuffer);
            } catch (e) { /* ignore */ }
        }

        // Type the prompt
        var promptText;
        if (hasPdf) {
            promptText = "\u0d9a\u0dbb\u0dd4\u0dab\u0dcf\u0d9a\u0dbb\u0dbd\u0dcf \u0db8\u0dda attach \u0d9a\u0dbb\u0db4\u0dd4 \u0dc6\u0dba\u0dd2\u0dbd\u0dca 2\u0d9a\u0db8 \u0db6\u0dbd\u0db1\u0dca\u0db1. .txt \u0dc6\u0dba\u0dd2\u0dbd\u0dca \u0d91\u0d9a\u0dda \u0dad\u0dd2\u0dba\u0dd9\u0db1 Chat history \u0d91\u0d9a \u0d9a\u0dd2\u0dba\u0dc0\u0dbd\u0dcf, \u0d91\u0d9a\u0dda \u0db1\u0dd0\u0dc0\u0dad\u0dd4\u0dab \u0dad\u0dd0\u0db1 \u0d89\u0daf\u0db1\u0dca \u0d9a\u0dad\u0dcf \u0d9a\u0dbb\u0db1\u0dca\u0db1. \u0db4\u0dd2\u0db1\u0dca\u0dad\u0dd6\u0dbb \u0d9c\u0dd0\u0db1 \u0dc3\u0db3\u0dc4\u0db1\u0d9a\u0dca \u0dad\u0dd2\u0db6\u0dd4\u0dab\u0ddc\u0dad\u0dca, \u0d85\u0db1\u0dd2\u0dad\u0dca PDF \u0d91\u0d9a\u0dd9\u0db1\u0dca \u0d91\u0dda \u0d85\u0daf\u0dcf\u0dc5 \u0db4\u0dd2\u0db1\u0dca\u0dad\u0dd6\u0dbb\u0dba \u0db6\u0dbd\u0db1\u0dca\u0db1.";
        } else {
            promptText = "\u0d9a\u0dbb\u0dd4\u0dab\u0dcf\u0d9a\u0dbb\u0dbd\u0dcf \u0db8\u0dda attach \u0d9a\u0dbb\u0db4\u0dd4 \u0dc6\u0dba\u0dd2\u0dbd\u0dca \u0d91\u0d9a\u0dda \u0dad\u0dd2\u0dba\u0dd9\u0db1 Chat history \u0d91\u0d9a \u0d9a\u0dd2\u0dba\u0dc0\u0dbd\u0dcf, \u0d91\u0d9a\u0dda \u0db1\u0dd0\u0dc0\u0dad\u0dd4\u0dab \u0dad\u0dd0\u0db1 \u0d89\u0daf\u0db1\u0dca \u0d9a\u0dad\u0dcf \u0d9a\u0dbb\u0db1\u0dca\u0db1.";
        }
            
        setTimeout(function() {
            if (targetView && !targetView.webContents.isDestroyed()) {
                targetView.webContents.insertText(promptText);
            }
        }, 300);

        // Notify renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-ready', { 
                textPath: SYNC_FILE_PATH,
                pdfPath: hasPdf ? SYNC_PDF_PATH : null
            });
        }
    } catch (e) {
        // Sync failed silently
    } finally {
        if (pdfWin && !pdfWin.isDestroyed()) {
            pdfWin.destroy();
        }
    }
});

ipcMain.on('open-sync-folder', () => {
    shell.showItemInFolder(SYNC_FILE_PATH);
});

// Get list of recent chats from an account's sidebar
ipcMain.handle('get-chat-list', async (event, accountIndex) => {
    const view = browserViews[accountIndex];
    if (!view) return [];
    
    try {
        const items = await view.webContents.executeJavaScript(
            '(function() {' +
            '  var config = ' + JSON.stringify(appConfig.selectors) + ';' +
            '  var items = [];' +
            '  var seen = new Set();' +
            '  var links = document.querySelectorAll(config.chatListLinks);' +
            '  links.forEach(function(link) {' +
            '    var href = link.getAttribute("href");' +
            '    if (!href || href === "/app" || href === "/app/" || seen.has(href)) return;' +
            '    seen.add(href);' +
            '    var title = link.textContent.trim().replace(/\\s+/g, " ");' +
            '    if (title.length > 60) title = title.substring(0, 57) + "...";' +
            '    if (title.length > 0) {' +
            '      items.push({ title: title, url: "https://gemini.google.com" + href });' +
            '    }' +
            '  });' +
            '  return items;' +
            '})()'
        );
        return items;
    } catch (e) {
        return [];
    }
});

// SEC-G9 FIX: URL whitelist — only allow Gemini URLs
ipcMain.on('navigate-view', (event, data) => {
    if (!isFromMainWindow(event)) return;
    const { accountIndex, url } = data;
    if (!url || typeof url !== 'string' || !url.startsWith('https://gemini.google.com/')) {
        return; // Block non-Gemini URLs
    }
    const view = browserViews[accountIndex];
    if (view) {
        view.webContents.loadURL(url);
    }
});

// ========== CHAT HISTORY EXTRACTION ==========
ipcMain.on('request-chat-history', async (event, accountIndex) => {
    const view = browserViews[accountIndex];
    if (!view) {
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('view-event', { type: 'chat-history-data', blocks: [], accountIndex: accountIndex, viewUrl: '' });
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
            '    if (node.offsetWidth === 0 && node.offsetHeight === 0) return false;' +
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
            '    if (author === "user" || className.includes("user") || tag.includes("user")) {' +
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
            '      if (imgClass.includes(config.avatarClass) || originalImg.width < 20 || originalImg.height < 20) {' +
            '        cloneImg.remove();' +
            '        continue;' +
            '      }' +
            '      const src = originalImg.src;' +
            '' +
            '      var base64 = null;' +
            '      if (src && src.startsWith("data:image")) {' +
            '        base64 = src;' +
            '      } else if (src && (src.startsWith("blob:") || src.startsWith("http"))) {' +
            '        base64 = await getBase64(src);' +
            '      }' +
            '' +
            '      if (!base64) {' +
            '        try { base64 = imgToCanvas(originalImg); } catch(e) {}' +
            '      }' +
            '' +
            '      if (base64) {' +
            '        var label = "\\n[Attached PDF Image " + imageCounter + "]\\n";' +
            '        extractedImages.push({ name: "Image " + imageCounter, data: base64 });' +
            '        var textNode = document.createTextNode(label);' +
            '        cloneImg.parentNode.replaceChild(textNode, cloneImg);' +
            '        imageCounter++;' +
            '      } else {' +
            '        cloneImg.remove();' +
            '      }' +
            '    }' +
            '' +
            '    var text = clone.innerText ? clone.innerText.trim() : (clone.textContent ? clone.textContent.trim() : "");' +
            '    if (text.includes("--- CONTEXT SYNC")) continue;' +
            '    text = text.replace(/^You said\\n/i, "").replace(/^Gemini said\\n/i, "").trim();' +
            '    if (text.length > 5 && !text.includes("Volume") && !text.includes("Good response")) {' +
            '      result.push(role + ":\\n" + text);' +
            '    }' +
            '  }' +
            '' +
            '  var dedupedResult = [...new Set(result)];' +
            '  return { chatBlocks: dedupedResult, images: extractedImages };' +
            '})()'
        );

        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('view-event', { 
                type: 'chat-history-data', 
                blocks: blocks, 
                accountIndex: accountIndex,
                viewUrl: viewUrl
            });
        }
    } catch (e) {
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('view-event', { type: 'chat-history-data', blocks: [], accountIndex: accountIndex, viewUrl: viewUrl });
        }
    }
});

// ========== PRELOAD BRIDGE ==========
ipcMain.on('from-preload-to-main', (event, data) => {
    const accountIndex = browserViews.findIndex(v => v && v.webContents.id === event.sender.id);
    if (accountIndex !== -1) {
        data.accountIndex = accountIndex;
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('view-event', data);
        }
    } else {
        if (mainWindow && mainWindow.webContents) {
             mainWindow.webContents.send('view-event', { type: 'chat-history-data', blocks: [], accountIndex: 0, viewUrl: 'default' });
        }
    }
});

// ========== TOPICS ==========
ipcMain.on('navigate-topic', (event, data) => {
    if (!isFromMainWindow(event)) return;
    const { topicId } = data;
    const topic = topicsDb.topics.find(t => t.id === topicId);
    
    if (topic) {
        browserViews.forEach((view, idx) => {
            if (view && topic.urls && topic.urls[idx]) {
                // SEC-G9: Validate topic URL
                var topicUrl = topic.urls[idx];
                if (typeof topicUrl === 'string' && topicUrl.startsWith('https://gemini.google.com/')) {
                    view.webContents.loadURL(topicUrl);
                }
            } else if (view) {
                view.webContents.loadURL('https://gemini.google.com/app');
            }
        });
    } else {
        browserViews.forEach((view) => {
            if (view) view.webContents.loadURL('https://gemini.google.com/app');
        });
    }
});

ipcMain.on('save-topic-url', (event, data) => {
    if (!isFromMainWindow(event)) return;
    const { topicId, accountIndex, url } = data;
    let topic = topicsDb.topics.find(t => t.id === topicId);
    if (!topic) {
        topic = { id: topicId, urls: {} };
        topicsDb.topics.push(topic);
    }
    topic.urls[accountIndex] = url;
    saveDb();
});

ipcMain.handle('get-topics', () => {
    return topicsDb.topics;
});

ipcMain.handle('get-accounts-count', () => {
    return browserViews.length;
});
