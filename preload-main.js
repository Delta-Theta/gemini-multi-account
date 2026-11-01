// preload-main.js — Secure bridge between main process and renderer
// SEC-G1 & SEC-8 Fix: Least-privilege contextBridge API with duplicate-listener prevention
const { contextBridge, ipcRenderer } = require('electron');

const MAX_ACCOUNTS = 5;

contextBridge.exposeInMainWorld('electronAPI', {
    // === Send messages to main process ===
    switchAccount: (index) => {
        if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < MAX_ACCOUNTS) {
            ipcRenderer.send('switch-account', index);
        }
    },
    hideActiveView: () => ipcRenderer.send('hide-active-view'),
    showActiveView: () => ipcRenderer.send('show-active-view'),
    addAccount: () => ipcRenderer.send('add-account'),
    syncContext: (data) => {
        if (data && typeof data === 'object') {
            ipcRenderer.send('sync-context', {
                targetAccount: data.targetAccount,
                diffText: typeof data.diffText === 'string' ? data.diffText : '',
                images: Array.isArray(data.images) ? data.images : []
            });
        }
    },
    navigateView: (data) => {
        if (
            data &&
            typeof data.url === 'string' &&
            data.url.startsWith('https://gemini.google.com/') &&
            typeof data.accountIndex === 'number' &&
            Number.isInteger(data.accountIndex) &&
            data.accountIndex >= 0 &&
            data.accountIndex < MAX_ACCOUNTS
        ) {
            ipcRenderer.send('navigate-view', {
                accountIndex: data.accountIndex,
                url: data.url
            });
        }
    },
    requestChatHistory: (index) => {
        if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < MAX_ACCOUNTS) {
            ipcRenderer.send('request-chat-history', index);
        }
    },
    openSyncFolder: () => ipcRenderer.send('open-sync-folder'),

    // === Invoke (async, returns Promise) ===
    getChatList: (index) => {
        if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < MAX_ACCOUNTS) {
            return ipcRenderer.invoke('get-chat-list', index);
        }
        return Promise.resolve([]);
    },
    getAccountsCount: () => ipcRenderer.invoke('get-accounts-count'),

    // === Event listeners (SEC-8 FIX: prevent duplicate listener registration) ===
    onAccountAdded: (callback) => {
        if (typeof callback !== 'function') return;
        ipcRenderer.removeAllListeners('account-added');
        ipcRenderer.on('account-added', (_event, newIndex) => callback(newIndex));
    },
    onAccountSwitched: (callback) => {
        if (typeof callback !== 'function') return;
        ipcRenderer.removeAllListeners('account-switched');
        ipcRenderer.on('account-switched', (_event, index) => callback(index));
    },
    onViewEvent: (callback) => {
        if (typeof callback !== 'function') return;
        ipcRenderer.removeAllListeners('view-event');
        ipcRenderer.on('view-event', (_event, data) => callback(data));
    },
    onFileReady: (callback) => {
        if (typeof callback !== 'function') return;
        ipcRenderer.removeAllListeners('file-ready');
        ipcRenderer.on('file-ready', (_event, data) => callback(data));
    }
});
