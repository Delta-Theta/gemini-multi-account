const { app, BrowserWindow, BrowserView, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let browserViews = [];
let activeAccountIndex = 0;
const MAX_ACCOUNTS = 5;

// Sync files on Desktop - easy to find, always overwritten
const SYNC_FILE_PATH = path.join(app.getPath('desktop'), 'context_sync.txt');
const SYNC_PDF_PATH = path.join(app.getPath('desktop'), 'context_sync_images.pdf');

// Persist account count so app remembers added accounts after restart
const accountCountPath = path.join(app.getPath('userData'), 'account_count.json');

// Global app config for Dynamic Selectors (Remote Config)
let appConfig = null;
const CONFIG_URL = "https://raw.githubusercontent.com/antigravity/gemini-config/main/selectors.json"; // Placeholder for cloud URL
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-selectors.json');

async function loadAppConfig() {
    try {
        console.log('[CONFIG] Fetching remote config from:', CONFIG_URL);
        // Simulate a fetch with a short timeout to prevent startup lag
        const response = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(3000) });
        if (response.ok) {
            appConfig = await response.json();
            console.log('[CONFIG] Successfully loaded remote config version:', appConfig.version);
            return;
        }
    } catch (e) {
        console.log('[CONFIG] Remote fetch failed or timed out. Falling back to local defaults.');
    }
    
    // Fallback to local default-selectors.json
    try {
        if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
            appConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
            console.log('[CONFIG] Loaded local fallback config version:', appConfig.version);
        } else {
            console.error('[CONFIG] CRITICAL ERROR: default-selectors.json not found!');
        }
    } catch (e) {
        console.error('[CONFIG] Error parsing local config:', e);
    }
}

function getSavedAccountCount() {
    try {
        const p = path.join(app.getPath('userData'), 'account_count.json');
        console.log('[ACCOUNTS] Reading count from:', p);
        if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            console.log('[ACCOUNTS] Saved count:', data.count);
            return Math.max(2, Math.min(data.count || 2, MAX_ACCOUNTS));
        } else {
            console.log('[ACCOUNTS] No saved count file found, defaulting to 2');
        }
    } catch (e) {
        console.error('[ACCOUNTS] Error reading account count:', e);
    }
    return 2;
}

function saveAccountCount(count) {
    try {
        var userDataDir = app.getPath('userData');
        // Ensure directory exists
        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }
        var filePath = path.join(userDataDir, 'account_count.json');
        fs.writeFileSync(filePath, JSON.stringify({ count: count }));
        console.log('[ACCOUNTS] Saved count:', count, 'to:', filePath);
    } catch (e) {
        console.error('[ACCOUNTS] Error saving account count:', e);
    }
}

// Simple local database for topics
const dbPath = path.join(app.getPath('userData'), 'topics.json');
let topicsDb = { topics: [] };

if (fs.existsSync(dbPath)) {
    try {
        topicsDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } catch (e) {
        console.error('Error reading topics.json:', e);
    }
}

function saveDb() {
    fs.writeFileSync(dbPath, JSON.stringify(topicsDb, null, 2));
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        title: "Gemini Seamless Multi-Account",
        autoHideMenuBar: true
    });

    mainWindow.loadFile('index.html');

    // Initialize accounts - restore saved count (includes previously added accounts)
    const savedCount = getSavedAccountCount();
    for (let i = 0; i < savedCount; i++) {
        createBrowserView(i);
    }

    mainWindow.on('resize', updateViewBounds);
    
    // Set initially active account
    switchAccount(0);
}

function createBrowserView(index) {
    if (browserViews[index]) return; // Already exists

    const view = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            partition: 'persist:gemini-account-' + index // Separate sessions for each account
        }
    });

    browserViews[index] = view;
    view.webContents.loadURL('https://gemini.google.com/app');
}

function updateViewBounds() {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    const activeView = browserViews[activeAccountIndex];
    if (activeView) {
        activeView.setBounds({ x: 250, y: 60, width: bounds.width - 250 - 16, height: bounds.height - 60 - 39 });
    }
}

function switchAccount(index) {
    if (index >= 0 && index < browserViews.length && browserViews[index]) {
        if (browserViews[activeAccountIndex]) {
            mainWindow.removeBrowserView(browserViews[activeAccountIndex]);
        }
        
        activeAccountIndex = index;
        mainWindow.addBrowserView(browserViews[activeAccountIndex]);
        updateViewBounds();
        
        mainWindow.webContents.send('account-switched', index);
    }
}

app.whenReady().then(async () => {
    // Make the app run automatically when the PC starts (Startup App)
    app.setLoginItemSettings({
        openAtLogin: true,
        path: app.getPath("exe")
    });
    
    await loadAppConfig(); // Load config before creating windows
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers
ipcMain.on('switch-account', (event, index) => {
    switchAccount(index);
});

// Provide config to Preload scripts synchronously
ipcMain.on('get-config', (event) => {
    event.returnValue = appConfig;
});

// Temporarily hide/show BrowserView so SweetAlert popups are visible
ipcMain.on('hide-active-view', () => {
    if (browserViews[activeAccountIndex]) {
        mainWindow.removeBrowserView(browserViews[activeAccountIndex]);
    }
});

ipcMain.on('show-active-view', () => {
    if (browserViews[activeAccountIndex]) {
        mainWindow.addBrowserView(browserViews[activeAccountIndex]);
        updateViewBounds();
    }
});

ipcMain.on('add-account', (event) => {
    const nextIndex = browserViews.length;
    if (nextIndex < MAX_ACCOUNTS) {
        createBrowserView(nextIndex);
        saveAccountCount(browserViews.length); // Persist the new count!
        mainWindow.webContents.send('account-added', nextIndex);
    }
});

// ========== SYNC CONTEXT (FILE-BASED) ==========
ipcMain.on('sync-context', async (event, data) => {
    const { targetAccount, diffText, images } = data;
    const imgArray = images || [];
    const targetView = browserViews[targetAccount];
    if (!targetView) return;

    try {
        // Focus the editor first (Dynamic Remote Config)
        await targetView.webContents.executeJavaScript(
            '(function() {' +
            '  var config = ' + JSON.stringify(appConfig.selectors) + ';' +
            '  var selectors = config.editor.split(",").map(function(s) { return s.trim(); });' +
            '  var editor = null;' +
            '  for (var i = 0; i < selectors.length; i++) {' +
            '    editor = document.querySelector(selectors[i]);' +
            '    if (editor) break;' +
            '  }' +
            '  if (editor) { editor.focus(); editor.click(); return true; }' +
            '  return false;' +
            '})()'
        );

        // Save text context
        fs.writeFileSync(SYNC_FILE_PATH, diffText, 'utf8');
        console.log('Context sync text file written to:', SYNC_FILE_PATH);
        
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
                htmlParts.push('<div class="image-container">');
                htmlParts.push('<h2>[' + img.name + ']</h2>');
                htmlParts.push('<img src="' + img.data + '" />');
                htmlParts.push('</div>');
            });
            
            htmlParts.push('</body></html>');
            var htmlString = htmlParts.join('\n');

            // Create a hidden window to render the HTML to PDF
            const pdfWin = new BrowserWindow({ show: false });
            await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlString));
            
            // Wait briefly to ensure images (base64) are rendered
            await new Promise(function(resolve) { setTimeout(resolve, 1500); });
            
            const pdfBuffer = await pdfWin.webContents.printToPDF({
                printBackground: true,
                pageSize: 'A4'
            });
            
            fs.writeFileSync(SYNC_PDF_PATH, pdfBuffer);
            pdfWin.destroy();
            console.log('Context sync PDF file written to:', SYNC_PDF_PATH);
        }

        // Type the prompt (does NOT auto-send, waits for user to attach files and press Send)
        var promptText;
        if (hasPdf) {
            promptText = "කරුණාකරලා මේ attach කරපු ෆයිල් 2කම බලන්න. .txt ෆයිල් එකේ තියෙන Chat history එක කියවලා, ඒකේ නැවතුණ තැන ඉඳන් කතා කරන්න. පින්තූර ගැන සඳහනක් තිබුණොත්, අනිත් PDF එකෙන් ඒ අදාළ පින්තූරය බලන්න.";
        } else {
            promptText = "කරුණාකරලා මේ attach කරපු ෆයිල් එකේ තියෙන Chat history එක කියවලා, ඒකේ නැවතුණ තැන ඉඳන් කතා කරන්න.";
        }
            
        setTimeout(function() {
            targetView.webContents.insertText(promptText);
        }, 300);

        // Notify renderer to show popup with manual instructions
        mainWindow.webContents.send('file-ready', { 
            textPath: SYNC_FILE_PATH,
            pdfPath: hasPdf ? SYNC_PDF_PATH : null
        });
    } catch (e) {
        console.error('Failed to sync context:', e);
    }
});

// Open file explorer to show the sync file
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
        console.error('Failed to get chat list:', e);
        return [];
    }
});

// Navigate a specific account's view to a URL
ipcMain.on('navigate-view', (event, data) => {
    const { accountIndex, url } = data;
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

    const viewUrl = view.webContents.getURL(); // Current URL = topic identifier

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
            '      console.log("[SYNC DEBUG] getBase64 failed for:", url, e);' +
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
            '      console.log("[SYNC DEBUG] imgToCanvas failed:", e);' +
            '      return null;' +
            '    }' +
            '  }' +
            '' +
            '  console.log("[SYNC DEBUG] Total unique nodes:", uniqueNodes.length);' +
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
            '    console.log("[SYNC DEBUG] Node:", tag, "has", originalImgs.length, "img tags");' +
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
            '      console.log("[SYNC DEBUG] Found img src type:", src ? src.substring(0, 30) : "null", "size:", originalImg.width, "x", originalImg.height);' +
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
            '        console.log("[SYNC DEBUG] Successfully extracted Image", imageCounter);' +
            '        var label = "\\n[Attached PDF හි Image " + imageCounter + " බලන්න]\\n";' +
            '        extractedImages.push({ name: "Image " + imageCounter, data: base64 });' +
            '        var textNode = document.createTextNode(label);' +
            '        cloneImg.parentNode.replaceChild(textNode, cloneImg);' +
            '        imageCounter++;' +
            '      } else {' +
            '        console.log("[SYNC DEBUG] Could not extract image, removing");' +
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
            '  console.log("[SYNC DEBUG] Total images extracted:", extractedImages.length);' +
            '  console.log("[SYNC DEBUG] Total text blocks:", result.length);' +
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
        console.error("Execute JS failed", e);
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
        console.warn("Could not find matching browser view for sender:", event.sender.id);
        if (mainWindow && mainWindow.webContents) {
             mainWindow.webContents.send('view-event', { type: 'chat-history-data', blocks: [] });
        }
    }
});

// ========== TOPICS ==========
ipcMain.on('navigate-topic', (event, data) => {
    const { topicId } = data;
    const topic = topicsDb.topics.find(t => t.id === topicId);
    
    if (topic) {
        browserViews.forEach((view, idx) => {
            if (view && topic.urls && topic.urls[idx]) {
                view.webContents.loadURL(topic.urls[idx]);
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
