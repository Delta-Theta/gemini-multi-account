const { ipcRenderer } = require('electron');

let lastMessageCount = 0;
let chatHistory = [];
let currentUrl = window.location.href;

// Fetch Remote Config synchronously from Main Process
const appConfig = ipcRenderer.sendSync('get-config');
const selectors = appConfig ? appConfig.selectors : {};
const regexConfig = appConfig ? appConfig.regex : {};

// Inject custom CSS dynamically based on Remote Config
const style = document.createElement('style');
style.innerHTML = `
    /* Hide native sidebar elements robustly */
    ${selectors.sidebarElements || 'navigation-drawer'} { display: none !important; width: 0 !important; }
    
    /* Hide the hamburger menu in the header so user doesn't open the native sidebar */
    ${selectors.hamburgerMenu || '.hamburger-menu'} { display: none !important; }
    
    /* Ensure chat container takes full space */
    ${selectors.mainContent || 'main'} { width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }
`;
document.addEventListener('DOMContentLoaded', () => {
    document.head.appendChild(style);
});

let lastCheckTime = 0;
// Observe DOM for limit messages and new chats
const observer = new MutationObserver(() => {
    // 1. Check for URL changes (Topics)
    if (window.location.href !== currentUrl) {
        currentUrl = window.location.href;
        // Notify main process to save URL for this topic
        const urlObj = new URL(currentUrl);
        const chatId = urlObj.pathname.split('/').pop();
        if (chatId && chatId !== 'app') {
             ipcRenderer.send('from-preload-to-main', { type: 'url-changed', url: currentUrl });
        }
    }

    // 2. Check for "Limit Reached" messages (Throttled to avoid CPU lag!)
    const now = Date.now();
    if (now - lastCheckTime > 1500) {
        lastCheckTime = now;
        const bodyText = document.body.textContent;
        const limitMsgs = regexConfig.limitMessages || ["You've reached your limit"];
        const hasLimitMsg = limitMsgs.some(msg => bodyText.includes(msg));
        
        if (hasLimitMsg) {
            const visibleText = document.body.innerText;
            const regexStr = regexConfig.limitReset || "try again at ([\\d:]+\\s[AP]M)";
            const match = visibleText.match(new RegExp(regexStr, "i"));
            let resetTime = "Unknown";
            if (match && match[1]) {
                resetTime = match[1];
            }
            ipcRenderer.send('from-preload-to-main', { type: 'limit-reached', resetTime });
        }
    }

    // 3. Monitor for new user messages to build context diff
    // In a real robust implementation, we would carefully parse the user-message DOM elements.
    // For this prototype, we will just listen to the input area to capture what the user sends.
});

// Start observing
document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true });
});

// Intercept messages using Capture Phase (true) so we get the text before Gemini clears it
document.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        const input = document.querySelector(selectors.editor || 'textarea');
        if (input) {
            const text = input.textContent || input.value;
            if (text && text.trim().length > 0) {
                chatHistory.push(text);
                ipcRenderer.sendToHost('from-preload', { type: 'new-message', text: text });
            }
        }
    }
}, true);

document.body.addEventListener('click', (e) => {
    const btn = e.target.closest(selectors.sendButton || 'button[aria-label*="Send"]');
    if (btn) {
        const input = document.querySelector(selectors.editor || 'textarea');
        if (input) {
            const text = input.textContent || input.value;
            if (text && text.trim().length > 0) {
                chatHistory.push(text);
                ipcRenderer.sendToHost('from-preload', { type: 'new-message', text: text });
            }
        }
    }
}, true);

// Listen for paste-context from Main
ipcRenderer.on('paste-context', (event, textToPaste) => {
    const chatInput = document.querySelector(selectors.editor || 'textarea');
    const sendButton = document.querySelector(selectors.sendButton || '.send-button');
    
    if (chatInput && sendButton) {
        // Paste the text
        const syncMessage = `[Automated Context Sync]\n${textToPaste}\nPlease acknowledge and continue.`;
        if (chatInput.isContentEditable) {
            chatInput.textContent = syncMessage;
        } else {
            chatInput.value = syncMessage;
        }
        
        // Trigger input event for React/Angular bindings
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        
        // Click send
        setTimeout(() => {
            sendButton.click();
        }, 500);
    }
});

// Note: Chat history extraction is now handled by main.js via executeJavaScript
// to support image extraction alongside text. The old preload listener was removed
// to prevent conflicts.
