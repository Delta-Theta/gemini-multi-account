const { ipcRenderer } = require('electron');

let currentUrl = window.location.href;

// Fetch Remote Config synchronously from Main Process
const appConfig = ipcRenderer.sendSync('get-config');
const selectors = (appConfig && appConfig.selectors) ? appConfig.selectors : {};
const regexConfig = (appConfig && appConfig.regex) ? appConfig.regex : {};

// Precompile regex once
const regexStr = regexConfig.limitReset || "try again at ([\\d:]+\\s[AP]M)";
const limitRegex = new RegExp(regexStr, "i");
const limitMsgs = regexConfig.limitMessages || ["You've reached your limit", "limit reached"];

// Inject custom CSS dynamically based on Remote Config
function injectStyles() {
    if (document.getElementById('antigravity-custom-styles')) return;
    const style = document.createElement('style');
    style.id = 'antigravity-custom-styles';
    style.innerHTML = `
        /* Hide native sidebar elements robustly */
        ${selectors.sidebarElements || 'navigation-drawer'} { display: none !important; width: 0 !important; }
        
        /* Hide the hamburger menu in the header */
        ${selectors.hamburgerMenu || '.hamburger-menu'} { display: none !important; }
        
        /* Ensure chat container takes full space */
        ${selectors.mainContent || 'main'} { width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }
    `;
    if (document.head) {
        document.head.appendChild(style);
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            if (document.head) document.head.appendChild(style);
        });
    }
}
injectStyles();

let lastCheckTime = 0;
// Observe DOM for limit messages and URL changes (Throttled)
const observer = new MutationObserver(() => {
    const now = Date.now();
    
    // 1. Check for URL changes (Topics)
    if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        try {
            const urlObj = new URL(currentUrl);
            const chatId = urlObj.pathname.split('/').pop();
            if (chatId && chatId !== 'app') {
                ipcRenderer.send('from-preload-to-main', { type: 'url-changed', url: currentUrl });
            }
        } catch (e) {}
    }

    // 2. Check for "Limit Reached" messages (Throttled to once every 2 seconds to avoid CPU lag)
    if (now - lastCheckTime > 2000) {
        lastCheckTime = now;
        if (!document.body) return;
        const bodyText = document.body.textContent || "";
        const hasLimitMsg = limitMsgs.some(msg => bodyText.includes(msg));
        
        if (hasLimitMsg) {
            const visibleText = document.body.innerText || bodyText;
            const match = visibleText.match(limitRegex);
            let resetTime = "Unknown";
            if (match && match[1]) {
                resetTime = match[1];
            }
            ipcRenderer.send('from-preload-to-main', { type: 'limit-reached', resetTime });
        }
    }
});

// Start observing when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        injectStyles();
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    });
} else {
    injectStyles();
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    }
}
