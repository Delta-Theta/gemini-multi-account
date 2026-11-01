const { ipcRenderer } = require('electron');

// SEC-1 FIX: Only execute preload logic on Google Gemini's origin
if (window.location.origin === 'https://gemini.google.com') {
    let currentUrl = window.location.href;
    let lastReportedResetTime = null;
    let debounceTimer = null;

    // Fetch Config from Main Process
    const appConfig = ipcRenderer.sendSync('get-config') || {};
    const selectors = appConfig.selectors || {};
    const regexConfig = appConfig.regex || {};

    const regexStr = regexConfig.limitReset || 'try again (?:at|after)\\s+([\\d:]+\\s*[AP]M)';
    let limitRegex;
    try {
        limitRegex = new RegExp(regexStr, 'i');
    } catch (e) {
        limitRegex = /try again (?:at|after)\s+([\d:]+\s*[AP]M)/i;
    }

    const limitMsgs = Array.isArray(regexConfig.limitMessages) && regexConfig.limitMessages.length > 0
        ? regexConfig.limitMessages
        : ["You've reached your limit", "You’ve reached your limit", "reached your usage limit"];

    // SEC-6 FIX: Strict CSS selector sanitizer (blocks ; \ { } url() @import etc.)
    function sanitizeSelector(str) {
        if (!str || typeof str !== 'string') return '';
        return str
            .replace(/[{};\\]/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/url\s*\(/gi, '')
            .replace(/@import/gi, '')
            .replace(/expression\s*\(/gi, '')
            .replace(/javascript:/gi, '')
            .trim();
    }

    // Optional native sidebar hiding (OFF by default so Gemini's own sidebar & menus work seamlessly)
    function injectStylesIfConfigured() {
        if (!appConfig.hideNativeSidebar) return;
        if (document.getElementById('antigravity-custom-styles')) return;

        const sidebarSel = sanitizeSelector(selectors.sidebarElements || '');
        const sidebarContentSel = sanitizeSelector(selectors.sidebarContent || '');
        const hamburgerSel = sanitizeSelector(selectors.hamburgerMenu || '');
        const mainSel = sanitizeSelector(selectors.mainContent || '');

        let cssRules = '';
        if (sidebarSel) {
            cssRules += sidebarSel + ' { display: none !important; width: 0 !important; min-width: 0 !important; visibility: hidden !important; } ';
        }
        if (sidebarContentSel) {
            cssRules += sidebarContentSel + ' { margin-left: 0 !important; width: 100% !important; max-width: 100% !important; } ';
        }
        if (hamburgerSel) {
            cssRules += hamburgerSel + ' { display: none !important; } ';
        }
        if (mainSel) {
            cssRules += mainSel + ' { width: 100% !important; max-width: none !important; } ';
        }
        if (!cssRules) return;

        const style = document.createElement('style');
        style.id = 'antigravity-custom-styles';
        style.textContent = cssRules;
        if (document.head) {
            document.head.appendChild(style);
        }
    }

    function checkUrlChange() {
        if (window.location.href !== currentUrl) {
            currentUrl = window.location.href;
            try {
                const urlObj = new URL(currentUrl);
                const chatId = urlObj.pathname.split('/').pop();
                if (chatId && chatId !== 'app') {
                    ipcRenderer.send('from-preload-to-main', { type: 'url-changed', url: currentUrl });
                }
            } catch (e) { /* ignore malformed URL */ }
        }
    }

    // QA-2 & QA-3 FIX: Lightweight, debounced quota banner check (no lag during streaming, no infinite popup loop, no false positives on chat messages)
    function checkLimitBanner() {
        if (!document.body) return;

        const containerSelector = selectors.limitContainers || '[role="alert"], [aria-live], snack-bar-container, mat-snack-bar-container, input-container, .input-area-container, bottom-container';
        let candidateText = '';

        try {
            const containers = document.querySelectorAll(containerSelector);
            for (let i = 0; i < containers.length; i++) {
                // Skip if container is inside a user or AI chat message bubble
                if (containers[i].closest('user-query, model-response, message-content')) continue;
                const txt = containers[i].textContent;
                if (txt && txt.length < 1500) {
                    candidateText += ' ' + txt;
                }
            }
        } catch (e) { /* selector fallback */ }

        const hasLimitMsg = candidateText && limitMsgs.some((msg) => candidateText.includes(msg));

        if (hasLimitMsg) {
            const match = candidateText.match(limitRegex);
            const resetTime = (match && match[1]) ? match[1].trim() : 'Soon';

            // QA-2 FIX: Only notify ONCE per limit state so popup never loops every 2 seconds
            if (lastReportedResetTime !== resetTime) {
                lastReportedResetTime = resetTime;
                ipcRenderer.send('from-preload-to-main', { type: 'limit-reached', resetTime: resetTime });
            }
        } else if (lastReportedResetTime !== null) {
            // Reset tracking if banner disappears (e.g., quota reset)
            lastReportedResetTime = null;
        }
    }

    // Debounce DOM mutations so streaming responses run at full native speed without lag
    const observer = new MutationObserver(() => {
        checkUrlChange();
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            checkLimitBanner();
        }, 1200);
    });

    window.addEventListener('popstate', checkUrlChange);

    function startObserver() {
        injectStylesIfConfigured();
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver);
    } else {
        startObserver();
    }
}
