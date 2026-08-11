const { ipcRenderer } = require('electron');

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
let limits = {}; // { accountIndex: resetTime }

// Topic-aware baselines: key = "acc{index}_{url}" -> block count when we arrived
let arrivedBaselines = {};

let pendingSwitchTarget = null;
let pendingDeltaText = "";
let pendingDeltaImages = [];
let pendingDeltaTarget = null;

// Initialize
ipcRenderer.invoke('get-accounts-count').then(count => {
    totalAccounts = count;
    renderAccountList();
});
loadTopics();

// --- FAB Sync Button Click (with topic selection) ---
if (pasteDeltaContainer) {
    pasteDeltaContainer.addEventListener('click', async () => {
        if (pendingDeltaTarget === null || pendingDeltaText === "") return;
        
        // Hide BrowserView so popup is visible (BrowserView sits on top of HTML)
        ipcRenderer.send('hide-active-view');
        
        // Get list of chats from TARGET account's sidebar
        const chatList = await ipcRenderer.invoke('get-chat-list', pendingDeltaTarget);
        
        // Build selection options
        let inputOptions = { '__current__': '📌 දැනට open chat එක (Current Chat)' };
        chatList.forEach((chat) => {
            inputOptions[chat.url] = '💬 ' + chat.title;
        });
        
        // Show topic selection popup
        const { value: selectedChat } = await Swal.fire({
            title: '🎯 Chat එකක් තෝරන්න',
            html: `<p style="text-align:left;">Account ${pendingDeltaTarget + 1} එකේ <b>මොන chat එකටද</b> context sync කරන්න ඕනේ?</p>`,
            input: 'select',
            inputOptions: inputOptions,
            inputValue: '__current__',
            showCancelButton: true,
            confirmButtonText: '✅ Sync කරන්න',
            cancelButtonText: 'අවලංගු කරන්න',
            confirmButtonColor: '#10a37f',
            inputValidator: (value) => {
                if (!value) return 'කරුණාකරලා chat එකක් තෝරන්න!';
            }
        });
        
        // Show BrowserView back
        ipcRenderer.send('show-active-view');
        
        if (!selectedChat) return; // User cancelled
        
        // Navigate to selected chat if it's not "current"
        if (selectedChat !== '__current__') {
            ipcRenderer.send('navigate-view', { accountIndex: pendingDeltaTarget, url: selectedChat });
            
            // Wait for page to load
            Swal.fire({
                title: 'Chat එකට යනවා...',
                text: 'Page load වෙනකම් ඉන්න...',
                allowOutsideClick: false,
                timer: 2500,
                timerProgressBar: true,
                didOpen: () => { Swal.showLoading(); }
            });
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
        
        // Now sync!
        ipcRenderer.send('sync-context', { 
            targetAccount: pendingDeltaTarget, 
            diffText: pendingDeltaText,
            images: pendingDeltaImages 
        });
        
        // Reset and hide
        pendingDeltaText = "";
        pendingDeltaImages = [];
        pendingDeltaTarget = null;
        pasteDeltaContainer.style.display = 'none';
    });
}

// --- Account Dropdown Logic ---
accountSelect.addEventListener('change', (e) => {
    const indexToSwitch = parseInt(e.target.value);
    if (indexToSwitch !== activeAccountIndex) {
        pendingSwitchTarget = indexToSwitch;
        
        // Hide FAB if showing
        if (pasteDeltaContainer) pasteDeltaContainer.style.display = 'none';
        
        // Hide the BrowserView so popups are visible to the user
        ipcRenderer.send('hide-active-view');
        
        // Extract chat from CURRENT account before leaving
        ipcRenderer.send('request-chat-history', activeAccountIndex);
        
        Swal.fire({
            title: 'Syncing Context...',
            text: 'Extracting chat from current account...',
            allowOutsideClick: false,
            didOpen: () => { Swal.showLoading(); }
        });
    }
});

addAccountBtn.addEventListener('click', () => {
    if (totalAccounts < 5) {
        ipcRenderer.send('add-account');
    } else {
        Swal.fire('Limit Reached', 'You can only add up to 5 accounts.', 'info');
    }
});

ipcRenderer.on('account-added', (event, newIndex) => {
    totalAccounts = newIndex + 1;
    renderAccountList();
    Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: `Account ${newIndex + 1} added!`,
        showConfirmButton: false,
        timer: 2000
    });
});

ipcRenderer.on('account-switched', (event, index) => {
    activeAccountIndex = index;
    renderAccountList();
});

function renderAccountList() {
    accountSelect.innerHTML = '';
    for (let i = 0; i < totalAccounts; i++) {
        const option = document.createElement('option');
        option.value = i;
        
        let text = `Account ${i + 1}`;
        if (limits[i]) {
            text += ` (Limited - Resets at ${limits[i]})`;
        }
        option.innerText = text;
        
        if (i === activeAccountIndex) option.selected = true;
        
        accountSelect.appendChild(option);
    }
}

// --- Topic Sidebar Logic ---
newChatBtn.addEventListener('click', () => {
    const newId = 'topic_' + Date.now();
    ipcRenderer.send('navigate-topic', { topicId: newId });
    loadTopics();
});

async function loadTopics() {
    const topics = await ipcRenderer.invoke('get-topics');
    topicList.innerHTML = '';
    
    topics.forEach(topic => {
        const li = document.createElement('li');
        li.innerText = topic.id.replace('topic_', 'Chat ');
        li.className = 'topic-item';
        li.addEventListener('click', () => {
            ipcRenderer.send('navigate-topic', { topicId: topic.id });
            document.querySelectorAll('.topic-item').forEach(el => el.classList.remove('active'));
            li.classList.add('active');
        });
        topicList.appendChild(li);
    });
}

// --- Main Event Handler ---
ipcRenderer.on('view-event', (event, data) => {
    if (data.type === 'limit-reached') {
        const resetTime = data.resetTime;
        limits[data.accountIndex] = resetTime;
        renderAccountList();
        
        if (data.accountIndex === activeAccountIndex) {
            // Hide BrowserView so popup is visible
            ipcRenderer.send('hide-active-view');
            Swal.fire({
                title: 'Limit Reached!',
                text: `This account is limited. Resets at ${resetTime}. Please select another account from the top menu.`,
                icon: 'warning'
            }).then(() => {
                ipcRenderer.send('show-active-view');
            });
        }

    } else if (data.type === 'chat-history-data') {
        const payload = data.blocks || { chatBlocks: [], images: [] };
        // Handle old array format fallback just in case
        const isLegacy = Array.isArray(data.blocks);
        const blocks = isLegacy ? data.blocks : (payload.chatBlocks || []);
        const images = isLegacy ? [] : (payload.images || []);
        const currentImagesLength = images.length;
        const viewUrl = data.viewUrl || 'default';
        
        const currentLength = blocks.length;
        
        if (pendingSwitchTarget === null) {
            // ===== BASELINE RECORDING =====
            const topicKey = `acc${data.accountIndex}_${viewUrl}`;
            arrivedBaselines[topicKey] = currentLength;
            arrivedBaselines[topicKey + '_imgs'] = currentImagesLength;
            
        } else {
            // ===== LEAVING ACCOUNT - CALCULATE DELTA & PROMPT =====
            const topicKey = `acc${activeAccountIndex}_${viewUrl}`;
            const baseline = arrivedBaselines[topicKey] || 0;
            const baselineImgs = arrivedBaselines[topicKey + '_imgs'] || 0;
            
            // Helper function to show sync button
            function showSyncButton() {
                if (pasteDeltaContainer && pasteDeltaText && pendingDeltaText) {
                    var imgCount = pendingDeltaImages.length;
                    // Count roughly the number of messages being synced
                    var msgCount = pendingDeltaText.split('\n\n---\n\n').length;
                    var btnLabel = 'Sync Context (' + msgCount + ' msgs';
                    if (imgCount > 0) {
                        btnLabel += ', ' + imgCount + ' imgs';
                    }
                    btnLabel += ')';
                    pasteDeltaText.textContent = btnLabel;
                    pasteDeltaContainer.style.display = 'flex';
                }
            }

            // Helper function to handle the actual switch and cleanup
            function executeSwitch(targetIndex) {
                Swal.close();
                ipcRenderer.send('switch-account', targetIndex);
                
                // Show the new BrowserView after switching
                setTimeout(() => {
                    ipcRenderer.send('show-active-view');
                }, 200);
                
                // After arriving at new account, record its baseline too
                setTimeout(() => {
                    ipcRenderer.send('request-chat-history', targetIndex);
                }, 1500);
            }

            if (currentLength > 0) {
                const savedSwitchTarget = pendingSwitchTarget; // Save before async!
                const newMsgsCount = currentLength - baseline;
                const hasNewOnly = (baseline > 0 && newMsgsCount > 0 && newMsgsCount < currentLength);
                
                Swal.close(); // Close the loading popup before showing the options
                
                if (hasNewOnly) {
                    // We have a baseline AND there are NEW messages beyond it.
                    // Show choice: ALL vs NEW
                    Swal.fire({
                        title: 'Sync Options',
                        text: `You have ${newMsgsCount} new messages (total ${currentLength}). Sync the ENTIRE chat or ONLY the NEW messages?`,
                        icon: 'question',
                        showCancelButton: true,
                        showDenyButton: true,
                        confirmButtonText: `Sync ALL (${currentLength})`,
                        denyButtonText: `Sync NEW (${newMsgsCount})`,
                        cancelButtonText: 'Skip',
                        reverseButtons: false,
                        allowOutsideClick: false
                    }).then((result) => {
                        if (result.isConfirmed) {
                            // Sync ALL
                            pendingDeltaText = blocks.join('\n\n---\n\n');
                            pendingDeltaImages = images;
                            pendingDeltaTarget = savedSwitchTarget;
                            showSyncButton();
                        } else if (result.isDenied) {
                            // Sync NEW only
                            pendingDeltaText = blocks.slice(baseline).join('\n\n---\n\n');
                            pendingDeltaImages = images.slice(baselineImgs);
                            pendingDeltaTarget = savedSwitchTarget;
                            showSyncButton();
                        }
                        // If cancelled (Skip), don't sync anything
                        
                        arrivedBaselines[topicKey] = currentLength;
                        arrivedBaselines[topicKey + '_imgs'] = currentImagesLength;
                        executeSwitch(savedSwitchTarget);
                        pendingSwitchTarget = null;
                    });
                } else {
                    // No baseline OR no new messages beyond baseline.
                    // Show choice: Sync ALL or Skip
                    Swal.fire({
                        title: 'Sync Context?',
                        text: `${currentLength} messages found. Sync the entire chat to the next account?`,
                        icon: 'question',
                        showCancelButton: true,
                        confirmButtonText: `Sync ALL (${currentLength})`,
                        cancelButtonText: 'Skip',
                        allowOutsideClick: false
                    }).then((result) => {
                        if (result.isConfirmed) {
                            pendingDeltaText = blocks.join('\n\n---\n\n');
                            pendingDeltaImages = images;
                            pendingDeltaTarget = savedSwitchTarget;
                            showSyncButton();
                        }
                        // If cancelled (Skip), don't sync anything
                        
                        arrivedBaselines[topicKey] = currentLength;
                        arrivedBaselines[topicKey + '_imgs'] = currentImagesLength;
                        executeSwitch(savedSwitchTarget);
                        pendingSwitchTarget = null;
                    });
                }
            } else {
                // Nothing to sync
                executeSwitch(pendingSwitchTarget);
                pendingSwitchTarget = null;
            }
        }

    } else if (data.type === 'url-changed') {
        // Could be used for auto topic tracking
    }
});

// --- File Ready Popup (for large context syncs) ---
ipcRenderer.on('file-ready', (event, data) => {
    var fileInfo = '';
    if (data.pdfPath) {
        fileInfo = 'ෆයිල් 2කම (txt එකයි pdf එකයි)';
    } else {
        fileInfo = 'context_sync.txt ෆයිල් එක';
    }
    
    var pdfLine = '';
    if (data.pdfPath) {
        pdfLine = '<br>🖼️ PDF File: <code style="font-size:10px;">' + data.pdfPath + '</code>';
    }

    var htmlContent = '<div style="text-align:left; font-size:14px;">' +
        '<p>Chat history එක Desktop එකට Save වුණා! දැන් මේ පියවර අනුගමනය කරන්න:</p>' +
        '<ol style="margin-top:8px;">' +
        '<li>Gemini chat box එකේ <b>"+"</b> බොත්තම ඔබන්න.</li>' +
        '<li><b>"Upload files"</b> ඔබන්න.</li>' +
        '<li>Desktop එකේ තියෙන <b>' + fileInfo + '</b> තෝරලා Open ඔබන්න.</li>' +
        '<li>Prompt එක ඉබේම type වෙලා තියෙනවා - දැන් <b>Send</b> ඔබන්න!</li>' +
        '</ol>' +
        '<p style="margin-top:12px; font-size:11px; color:#aaa;">' +
        '📁 Text File: <code style="font-size:10px;">' + data.textPath + '</code>' +
        pdfLine +
        '</p>' +
        '</div>';

    // Hide BrowserView so popup is visible
    ipcRenderer.send('hide-active-view');
    
    Swal.fire({
        title: data.pdfPath ? '📄 Context & Images Ready!' : '📄 Context Ready!',
        html: htmlContent,
        icon: 'success',
        confirmButtonText: 'OK, මම Upload කරන්නම් ✅',
        confirmButtonColor: '#10a37f',
    }).then(() => {
        ipcRenderer.send('show-active-view');
    });
});

