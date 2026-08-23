// renderer.js — Uses window.electronAPI (exposed via contextBridge in preload-main.js)
// SEC-G1 FIX: No more require('electron') — uses secure contextBridge API only

// DOM Elements
const accountSelect = document.getElementById('account-select');
const addAccountBtn = document.getElementById('add-account-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const pasteDeltaContainer = document.getElementById('paste-delta-container');
const pasteDeltaText = document.getElementById('paste-delta-text');
const topicList = document.getElementById('topic-list');

// State
let activeAccountIndex = 0;
let totalAccounts = 2;
let limits = {};

// Topic-aware baselines: key = "acc{index}_{url}" -> block count when we arrived
let arrivedBaselines = {};

let pendingSwitchTarget = null;
let pendingDeltaText = "";
let pendingDeltaImages = [];
let pendingDeltaTarget = null;

// Initialize
window.electronAPI.getAccountsCount().then(function(count) {
    totalAccounts = count;
    renderAccountList();
});
loadTopics();

let isSyncing = false;
let switchTimeoutId = null;

// --- FAB Sync Button Click (with topic selection) ---
if (pasteDeltaContainer) {
    pasteDeltaContainer.addEventListener('click', async function() {
        if (isSyncing || pendingDeltaTarget === null || pendingDeltaText === "") return;
        isSyncing = true;
        
        try {
            window.electronAPI.hideActiveView();
            
            var chatList = await window.electronAPI.getChatList(pendingDeltaTarget);
            
            var inputOptions = { '__current__': '\uD83D\uDCCC \u0DAF\u0DD0\u0DB1\u0DA7 open chat \u0D91\u0D9A (Current Chat)' };
            if (Array.isArray(chatList)) {
                chatList.forEach(function(chat) {
                    inputOptions[chat.url] = '\uD83D\uDCAC ' + chat.title;
                });
            }
            
            var result = await Swal.fire({
                title: '\uD83C\uDFAF Chat \u0D91\u0D9A\u0D9A\u0DCA \u0DAD\u0DDD\u0DBB\u0DB1\u0DCA\u0DB1',
                html: '<p style="text-align:left;">Account ' + (pendingDeltaTarget + 1) + ' \u0D91\u0D9A\u0DDA <b>\u0DB8\u0DDD\u0DB1 chat \u0D91\u0D9A\u0DA7\u0DAF</b> context sync \u0D9A\u0DBB\u0DB1\u0DCA\u0DB1 \u0D95\u0DB1\u0DDA?</p>',
                input: 'select',
                inputOptions: inputOptions,
                inputValue: '__current__',
                showCancelButton: true,
                confirmButtonText: '\u2705 Sync \u0D9A\u0DBB\u0DB1\u0DCA\u0DB1',
                cancelButtonText: '\u0D85\u0DC0\u0DBD\u0D82\u0D9C\u0DD4 \u0D9A\u0DBB\u0DB1\u0DCA\u0DB1',
                confirmButtonColor: '#10a37f',
                inputValidator: function(value) {
                    if (!value) return '\u0D9A\u0DBB\u0DD4\u0DAB\u0DCF\u0D9A\u0DBB\u0DBD\u0DCF chat \u0D91\u0D9A\u0D9A\u0DCA \u0DAD\u0DDD\u0DBB\u0DB1\u0DCA\u0DB1!';
                }
            });
            
            window.electronAPI.showActiveView();
            
            var selectedChat = result.value;
            if (!selectedChat) return;
            
            if (selectedChat !== '__current__') {
                window.electronAPI.navigateView({ accountIndex: pendingDeltaTarget, url: selectedChat });
                
                Swal.fire({
                    title: 'Chat \u0D91\u0D9A\u0DA7 \u0DBA\u0DB1\u0DC0\u0DCF...',
                    text: 'Page load \u0DC0\u0DD9\u0DB1\u0D9A\u0DB8\u0DCA \u0D89\u0DB1\u0DCA\u0DB1...',
                    allowOutsideClick: false,
                    timer: 2500,
                    timerProgressBar: true,
                    didOpen: function() { Swal.showLoading(); }
                });
                await new Promise(function(resolve) { setTimeout(resolve, 2500); });
            }
            
            window.electronAPI.syncContext({ 
                targetAccount: pendingDeltaTarget, 
                diffText: pendingDeltaText,
                images: pendingDeltaImages 
            });
            
            pendingDeltaText = "";
            pendingDeltaImages = [];
            pendingDeltaTarget = null;
            pasteDeltaContainer.style.display = 'none';
        } catch (err) {
            window.electronAPI.showActiveView();
        } finally {
            isSyncing = false;
        }
    });
}

// --- Account Dropdown Logic ---
accountSelect.addEventListener('change', function(e) {
    var indexToSwitch = parseInt(e.target.value, 10);
    if (!isNaN(indexToSwitch) && indexToSwitch !== activeAccountIndex) {
        pendingSwitchTarget = indexToSwitch;
        accountSelect.disabled = true;
        
        if (pasteDeltaContainer) pasteDeltaContainer.style.display = 'none';
        
        window.electronAPI.hideActiveView();
        window.electronAPI.requestChatHistory(activeAccountIndex);
        
        Swal.fire({
            title: 'Syncing Context...',
            text: 'Extracting chat from current account...',
            allowOutsideClick: false,
            didOpen: function() { Swal.showLoading(); }
        });

        if (switchTimeoutId) clearTimeout(switchTimeoutId);
        switchTimeoutId = setTimeout(function() {
            if (pendingSwitchTarget !== null) {
                Swal.close();
                accountSelect.disabled = false;
                window.electronAPI.switchAccount(pendingSwitchTarget);
                setTimeout(function() { window.electronAPI.showActiveView(); }, 200);
                pendingSwitchTarget = null;
            }
        }, 8000);
    }
});

addAccountBtn.addEventListener('click', function() {
    if (totalAccounts < 5) {
        window.electronAPI.addAccount();
    } else {
        Swal.fire('Limit Reached', 'You can only add up to 5 accounts.', 'info');
    }
});

window.electronAPI.onAccountAdded(function(newIndex) {
    totalAccounts = newIndex + 1;
    renderAccountList();
    Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: 'Account ' + (newIndex + 1) + ' added!',
        showConfirmButton: false,
        timer: 2000
    });
});

window.electronAPI.onAccountSwitched(function(index) {
    activeAccountIndex = index;
    renderAccountList();
});

function renderAccountList() {
    accountSelect.innerHTML = '';
    for (var i = 0; i < totalAccounts; i++) {
        var option = document.createElement('option');
        option.value = i;
        
        var text = 'Account ' + (i + 1);
        if (limits[i]) {
            text += ' (Limited - Resets at ' + limits[i] + ')';
        }
        option.innerText = text;
        
        if (i === activeAccountIndex) option.selected = true;
        
        accountSelect.appendChild(option);
    }
}

// --- Topic Sidebar Logic ---
newChatBtn.addEventListener('click', function() {
    var newId = 'topic_' + Date.now();
    window.electronAPI.navigateTopic({ topicId: newId });
    loadTopics();
});

async function loadTopics() {
    var topics = await window.electronAPI.getTopics();
    topicList.innerHTML = '';
    
    topics.forEach(function(topic) {
        var li = document.createElement('li');
        li.innerText = topic.id.replace('topic_', 'Chat ');
        li.className = 'topic-item';
        li.addEventListener('click', function() {
            window.electronAPI.navigateTopic({ topicId: topic.id });
            document.querySelectorAll('.topic-item').forEach(function(el) { el.classList.remove('active'); });
            li.classList.add('active');
        });
        topicList.appendChild(li);
    });
}

// --- Main Event Handler ---
window.electronAPI.onViewEvent(function(data) {
    if (data.type === 'limit-reached') {
        var resetTime = data.resetTime;
        limits[data.accountIndex] = resetTime;
        renderAccountList();
        
        if (data.accountIndex === activeAccountIndex) {
            window.electronAPI.hideActiveView();
            Swal.fire({
                title: 'Limit Reached!',
                text: 'This account is limited. Resets at ' + resetTime + '. Please select another account from the top menu.',
                icon: 'warning'
            }).then(function() {
                window.electronAPI.showActiveView();
            });
        }

    } else if (data.type === 'chat-history-data') {
        var payload = data.blocks || { chatBlocks: [], images: [] };
        var isLegacy = Array.isArray(data.blocks);
        var blocks = isLegacy ? data.blocks : (payload.chatBlocks || []);
        var images = isLegacy ? [] : (payload.images || []);
        var currentImagesLength = images.length;
        var viewUrl = data.viewUrl || 'default';
        var currentLength = blocks.length;
        
        if (pendingSwitchTarget === null) {
            // ===== BASELINE RECORDING =====
            var topicKey = 'acc' + data.accountIndex + '_' + viewUrl;
            arrivedBaselines[topicKey] = currentLength;
            arrivedBaselines[topicKey + '_imgs'] = currentImagesLength;
            
        } else {
            // ===== LEAVING ACCOUNT - CALCULATE DELTA & PROMPT =====
            if (switchTimeoutId) {
                clearTimeout(switchTimeoutId);
                switchTimeoutId = null;
            }
            
            var fromAccountIndex = (typeof data.accountIndex === 'number') ? data.accountIndex : activeAccountIndex;
            var topicKey = 'acc' + fromAccountIndex + '_' + viewUrl;
            var baseline = arrivedBaselines[topicKey] || 0;
            var baselineImgs = arrivedBaselines[topicKey + '_imgs'] || 0;
            
            function showSyncButton() {
                if (pasteDeltaContainer && pasteDeltaText && pendingDeltaText) {
                    var imgCount = (pendingDeltaImages || []).length;
                    var msgCount = pendingDeltaText.split('\n\n---\n\n').filter(Boolean).length;
                    var btnLabel = 'Sync Context (' + msgCount + ' msgs';
                    if (imgCount > 0) {
                        btnLabel += ', ' + imgCount + ' imgs';
                    }
                    btnLabel += ')';
                    pasteDeltaText.textContent = btnLabel;
                    pasteDeltaContainer.style.display = 'flex';
                }
            }

            function executeSwitch(targetIndex) {
                Swal.close();
                if (accountSelect) accountSelect.disabled = false;
                if (typeof targetIndex === 'number') {
                    window.electronAPI.switchAccount(targetIndex);
                    
                    setTimeout(function() {
                        window.electronAPI.showActiveView();
                    }, 200);
                    
                    setTimeout(function() {
                        window.electronAPI.requestChatHistory(targetIndex);
                    }, 1500);
                } else {
                    window.electronAPI.showActiveView();
                }
            }

            if (currentLength > 0) {
                var savedSwitchTarget = pendingSwitchTarget;
                var newMsgsCount = currentLength - baseline;
                var hasNewOnly = (baseline > 0 && newMsgsCount > 0 && newMsgsCount < currentLength);
                
                Swal.close();
                
                if (hasNewOnly) {
                    Swal.fire({
                        title: 'Sync Options',
                        text: 'You have ' + newMsgsCount + ' new messages (total ' + currentLength + '). Sync the ENTIRE chat or ONLY the NEW messages?',
                        icon: 'question',
                        showCancelButton: true,
                        showDenyButton: true,
                        confirmButtonText: 'Sync ALL (' + currentLength + ')',
                        denyButtonText: 'Sync NEW (' + newMsgsCount + ')',
                        cancelButtonText: 'Skip',
                        reverseButtons: false,
                        allowOutsideClick: false
                    }).then(function(result) {
                        if (result.isConfirmed) {
                            pendingDeltaText = blocks.join('\n\n---\n\n');
                            pendingDeltaImages = images;
                            pendingDeltaTarget = savedSwitchTarget;
                            showSyncButton();
                        } else if (result.isDenied) {
                            pendingDeltaText = blocks.slice(baseline).join('\n\n---\n\n');
                            pendingDeltaImages = images.slice(baselineImgs);
                            pendingDeltaTarget = savedSwitchTarget;
                            showSyncButton();
                        }
                        
                        arrivedBaselines[topicKey] = currentLength;
                        arrivedBaselines[topicKey + '_imgs'] = currentImagesLength;
                        executeSwitch(savedSwitchTarget);
                        pendingSwitchTarget = null;
                    });
                } else {
                    Swal.fire({
                        title: 'Sync Context?',
                        text: currentLength + ' messages found. Sync the entire chat to the next account?',
                        icon: 'question',
                        showCancelButton: true,
                        confirmButtonText: 'Sync ALL (' + currentLength + ')',
                        cancelButtonText: 'Skip',
                        allowOutsideClick: false
                    }).then(function(result) {
                        if (result.isConfirmed) {
                            pendingDeltaText = blocks.join('\n\n---\n\n');
                            pendingDeltaImages = images;
                            pendingDeltaTarget = savedSwitchTarget;
                            showSyncButton();
                        }
                        
                        arrivedBaselines[topicKey] = currentLength;
                        arrivedBaselines[topicKey + '_imgs'] = currentImagesLength;
                        executeSwitch(savedSwitchTarget);
                        pendingSwitchTarget = null;
                    });
                }
            } else {
                executeSwitch(pendingSwitchTarget);
                pendingSwitchTarget = null;
            }
        }

    } else if (data.type === 'url-changed') {
        // Could be used for auto topic tracking
    }
});

// --- File Ready Popup ---
window.electronAPI.onFileReady(function(data) {
    var fileInfo = '';
    if (data.pdfPath) {
        fileInfo = '\u0DC6\u0DBA\u0DD2\u0DBD\u0DCA 2\u0D9A\u0DB8 (txt \u0D91\u0D9A\u0DBA\u0DD2 pdf \u0D91\u0D9A\u0DBA\u0DD2)';
    } else {
        fileInfo = 'context_sync.txt \u0DC6\u0DBA\u0DD2\u0DBD\u0DCA \u0D91\u0D9A';
    }
    
    var pdfLine = '';
    if (data.pdfPath) {
        pdfLine = '<br>\uD83D\uDDBC\uFE0F PDF File: <code style="font-size:10px;">' + data.pdfPath + '</code>';
    }

    var htmlContent = '<div style="text-align:left; font-size:14px;">' +
        '<p>Chat history \u0D91\u0D9A Desktop \u0D91\u0D9A\u0DA7 Save \u0DC0\u0DD4\u0DAB\u0DCF! \u0DAF\u0DD0\u0DB1\u0DCA \u0DB8\u0DDA \u0DB4\u0DD2\u0DBA\u0DC0\u0DBB \u0D85\u0DB1\u0DD4\u0D9C\u0DB8\u0DB1\u0DBA \u0D9A\u0DBB\u0DB1\u0DCA\u0DB1:</p>' +
        '<ol style="margin-top:8px;">' +
        '<li>Gemini chat box \u0D91\u0D9A\u0DDA <b>"+"</b> \u0DB6\u0DDD\u0DAD\u0DCA\u0DAD\u0DB8 \u0D94\u0DB6\u0DB1\u0DCA\u0DB1.</li>' +
        '<li><b>"Upload files"</b> \u0D94\u0DB6\u0DB1\u0DCA\u0DB1.</li>' +
        '<li>Desktop \u0D91\u0D9A\u0DDA \u0DAD\u0DD2\u0DBA\u0DD9\u0DB1 <b>' + fileInfo + '</b> \u0DAD\u0DDD\u0DBB\u0DBD\u0DCF Open \u0D94\u0DB6\u0DB1\u0DCA\u0DB1.</li>' +
        '<li>Prompt \u0D91\u0D9A \u0D89\u0DB6\u0DDA\u0DB8 type \u0DC0\u0DD9\u0DBD\u0DCF \u0DAD\u0DD2\u0DBA\u0DD9\u0DB1\u0DC0\u0DCF - \u0DAF\u0DD0\u0DB1\u0DCA <b>Send</b> \u0D94\u0DB6\u0DB1\u0DCA\u0DB1!</li>' +
        '</ol>' +
        '<p style="margin-top:12px; font-size:11px; color:#aaa;">' +
        '\uD83D\uDCC1 Text File: <code style="font-size:10px;">' + data.textPath + '</code>' +
        pdfLine +
        '</p>' +
        '</div>';

    window.electronAPI.hideActiveView();
    
    Swal.fire({
        title: data.pdfPath ? '\uD83D\uDCC4 Context & Images Ready!' : '\uD83D\uDCC4 Context Ready!',
        html: htmlContent,
        icon: 'success',
        confirmButtonText: 'OK, \u0DB8\u0DB8 Upload \u0D9A\u0DBB\u0DB1\u0DCA\u0DB1\u0DB8\u0DCA \u2705',
        confirmButtonColor: '#10a37f',
    }).then(function() {
        window.electronAPI.showActiveView();
    });
});
