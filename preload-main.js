// preload-main.js — Secure bridge between main process and renderer
// SEC-G1 Fix: contextBridge exposes ONLY specific APIs, not full Node.js access
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // === Send messages to main process ===
    switchAccount: (index) => {
        if (typeof index === 'number' && index >= 0 && index < 5) {
            ipcRenderer.send('switch-account', index);
        }
    },
    hideActiveView: () => ipcRenderer.send('hide-active-view'),
    showActiveView: () => ipcRenderer.send('show-active-view'),
    addAccount: () => ipcRenderer.send('add-account'),
    syncContext: (data) => {
        // Validate data shape before sending
        if (data && typeof data === 'object') {
            ipcRenderer.send('sync-context', {
                targetAccount: data.targetAccount,
                diffText: typeof data.diffText === 'string' ? data.diffText : '',
                images: Array.isArray(data.images) ? data.images : []
            });
        }
    },
    navigateView: (data) => {
        if (data && typeof data.url === 'string' && typeof data.accountIndex === 'number') {
            ipcRenderer.send('navigate-view', data);
        }
    },
    requestChatHistory: (index) => {
        if (typeof index === 'number') {
            ipcRenderer.send('request-chat-history', index);
        }
    },
    navigateTopic: (data) => {
        if (data && data.topicId) {
            ipcRenderer.send('navigate-topic', data);
        }
    },
    saveTopicUrl: (data) => ipcRenderer.send('save-topic-url', data),
    openSyncFolder: () => ipcRenderer.send('open-sync-folder'),

    // === Invoke (async, returns Promise) ===
    getChatList: (index) => ipcRenderer.invoke('get-chat-list', index),
    getTopics: () => ipcRenderer.invoke('get-topics'),
    getAccountsCount: () => ipcRenderer.invoke('get-accounts-count'),

    // === Event listeners (one-way from main to renderer) ===
    onAccountAdded: (callback) => {
        ipcRenderer.on('account-added', (_event, newIndex) => callback(newIndex));
    },
    onAccountSwitched: (callback) => {
        ipcRenderer.on('account-switched', (_event, index) => callback(index));
    },
    onViewEvent: (callback) => {
        ipcRenderer.on('view-event', (_event, data) => callback(data));
    },
    onFileReady: (callback) => {
        ipcRenderer.on('file-ready', (_event, data) => callback(data));
    }
});
