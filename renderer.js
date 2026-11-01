// renderer.js — Uses window.electronAPI (exposed via contextBridge in preload-main.js)
// SEC-G1, SEC-2, QA-1, QA-2, QA-5 & QA-6 Fixed

// DOM Elements
const accountSelect = document.getElementById('account-select');
const addAccountBtn = document.getElementById('add-account-btn');
const pasteDeltaContainer = document.getElementById('paste-delta-container');
const pasteDeltaText = document.getElementById('paste-delta-text');

// State
let activeAccountIndex = 0;
let totalAccounts = 2;
let limits = {};
let notifiedLimits = {}; // QA-2 FIX: Prevents repeated Limit Reached modal loops

// Topic-aware baselines: key = "acc{index}_{url}" -> block count when we arrived
let arrivedBaselines = {};

let pendingSwitchTarget = null;
let pendingDeltaText = '';
let pendingDeltaImages = [];
let pendingDeltaTarget = null;

let isSyncing = false;
let switchTimeoutId = null;
let loadingPopupTimer = null;

// SEC-2 FIX: HTML-escape helper for safe SweetAlert HTML rendering
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setSyncButtonVisible(visible) {
    if (!pasteDeltaContainer) return;
    if (visible) {
        pasteDeltaContainer.classList.remove('hidden');
    } else {
        pasteDeltaContainer.classList.add('hidden');
    }
}

// Initialize account list
window.electronAPI.getAccountsCount().then(function(count) {
    totalAccounts = count;
    renderAccountList();
});

// --- Topbar Sync Context Button Click ---
if (pasteDeltaContainer) {
    pasteDeltaContainer.addEventListener('click', async function() {
        if (isSyncing || pendingDeltaTarget === null || pendingDeltaText === '') return;
        isSyncing = true;

        try {
            window.electronAPI.hideActiveView();

            var chatList = await window.electronAPI.getChatList(pendingDeltaTarget);

            var inputOptions = { '__current__': '\uD83D\uDCCC \u0DAF\u0DD0\u0DB1\u0DA7 open chat \u0D91\u0D9A (Current Chat)' };
            if (Array.isArray(chatList)) {
                chatList.forEach(function(chat) {
                    if (chat && chat.url && chat.title) {
                        inputOptions[chat.url] = '\uD83D\uDCAC ' + chat.title;
                    }
                });
            }

            var result = await Swal.fire({
                title: '\uD83C\uDFAF Chat \u0D91\u0D9A\u0D9A\u0DCA \u0DAD\u0DDD\u0DBB\u0DB1\u0DCA\u0DB1',
                html: '<p style="text-align:left;">Account ' + (Number(pendingDeltaTarget) + 1) + ' \u0D91\u0D9A\u0DDA <b>\u0DB8\u0DDC\u0DB1 chat \u0D91\u0D9A\u0DA7\u0DAF</b> context sync \u0D9A\u0DBB\u0DB1\u0DCA\u0DB1 \u0D95\u0DB1\u0DDA?</p>',
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

            var selectedChat = result.value;
            if (!selectedChat) {
                window.electronAPI.showActiveView();
                return;
            }

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

            window.electronAPI.showActiveView();

            window.electronAPI.syncContext({
                targetAccount: pendingDeltaTarget,
                diffText: pendingDeltaText,
                images: pendingDeltaImages
            });

            pendingDeltaText = '';
            pendingDeltaImages = [];
            pendingDeltaTarget = null;
            setSyncButtonVisible(false);
        } catch (err) {
            window.electronAPI.showActiveView();
        } finally {
            isSyncing = false;
        }
    });
}

// --- Account Dropdown Logic (QA-1 FIX: Extract BEFORE detaching view) ---
accountSelect.addEventListener('change', function(e) {
    var indexToSwitch = parseInt(e.target.value, 10);
    if (!isNaN(indexToSwitch) && indexToSwitch !== activeAccountIndex) {
        pendingSwitchTarget = indexToSwitch;
        accountSelect.disabled = true;

        setSyncButtonVisible(false);

        // Request chat history FIRST while BrowserView is still attached and visible
        window.electronAPI.requestChatHistory(activeAccountIndex);

        // Only show loading modal if extraction takes >250ms (e.g., chats with large images)
        if (loadingPopupTimer) clearTimeout(loadingPopupTimer);
        loadingPopupTimer = setTimeout(function() {
            if (pendingSwitchTarget !== null) {
                window.electronAPI.hideActiveView();
                Swal.fire({
                    title: 'Syncing Context...',
                    text: 'Extracting chat from current account...',
                    allowOutsideClick: false,
                    didOpen: function() { Swal.showLoading(); }
                });
            }
        }, 250);

        if (switchTimeoutId) clearTimeout(switchTimeoutId);
        switchTimeoutId = setTimeout(function() {
            if (loadingPopupTimer) {
                clearTimeout(loadingPopupTimer);
                loadingPopupTimer = null;
            }
            if (pendingSwitchTarget !== null) {
                var target = pendingSwitchTarget;
                pendingSwitchTarget = null;
                Swal.close();
                accountSelect.disabled = false;
                window.electronAPI.switchAccount(target);
                setTimeout(function() { window.electronAPI.showActiveView(); }, 150);
            }
        }, 8000);
    }
});

addAccountBtn.addEventListener('click', function() {
    if (totalAccounts < 5) {
        window.electronAPI.addAccount();
    } else {
        window.electronAPI.hideActiveView();
        Swal.fire('Limit Reached', 'You can only add up to 5 accounts.', 'info').then(function() {
            window.electronAPI.showActiveView();
        });
    }
});

window.electronAPI.onAccountAdded(function(newIndex) {
    totalAccounts = newIndex + 1;
    renderAccountList();
    if (addAccountBtn) {
        addAccountBtn.textContent = '\u2713';
        addAccountBtn.style.borderColor = '#10a37f';
        addAccountBtn.style.color = '#10a37f';
        setTimeout(function() {
            addAccountBtn.textContent = '+';
            addAccountBtn.style.borderColor = '';
            addAccountBtn.style.color = '';
        }, 1200);
    }
});

window.electronAPI.onAccountSwitched(function(index) {
    activeAccountIndex = index;
    renderAccountList();
    // Show Sync button only if there is a pending delta meant for this account
    if (pendingDeltaText && pendingDeltaTarget === activeAccountIndex) {
        setSyncButtonVisible(true);
    } else {
        setSyncButtonVisible(false);
    }
});

function renderAccountList() {
    accountSelect.innerHTML = '';
    for (var i = 0; i < totalAccounts; i++) {
        var option = document.createElement('option');
        option.value = i;

        var text = 'Account ' + (i + 1);
        if (limits[i]) {
            text += ' (Limited - Resets ' + limits[i] + ')';
        }
        option.textContent = text;

        if (i === activeAccountIndex) option.selected = true;

        accountSelect.appendChild(option);
    }
}

// --- Main Event Handler ---
window.electronAPI.onViewEvent(function(data) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'limit-reached') {
        var resetTime = data.resetTime || 'Soon';
        var accIdx = data.accountIndex;
        limits[accIdx] = resetTime;
        renderAccountList();

        // QA-2 FIX: Only show popup ONCE per limit state so user is never trapped in a loop
        if (accIdx === activeAccountIndex && notifiedLimits[accIdx] !== resetTime) {
            notifiedLimits[accIdx] = resetTime;
            window.electronAPI.hideActiveView();
            Swal.fire({
                title: 'Limit Reached!',
                text: 'Account ' + (accIdx + 1) + ' limit reached (Resets: ' + resetTime + '). ඉහළ මෙනුවෙන් වෙනත් Account එකක් තෝරන්න.',
                icon: 'warning',
                confirmButtonColor: '#10a37f'
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
            var baseKey = 'acc' + data.accountIndex + '_' + viewUrl;
            arrivedBaselines[baseKey] = currentLength;
            arrivedBaselines[baseKey + '_imgs'] = currentImagesLength;

        } else {
            // ===== LEAVING ACCOUNT - CALCULATE DELTA & PROMPT =====
            if (loadingPopupTimer) {
                clearTimeout(loadingPopupTimer);
                loadingPopupTimer = null;
            }
            if (switchTimeoutId) {
                clearTimeout(switchTimeoutId);
                switchTimeoutId = null;
            }

            var fromAccountIndex = (typeof data.accountIndex === 'number') ? data.accountIndex : activeAccountIndex;
            var topicKey = 'acc' + fromAccountIndex + '_' + viewUrl;
            var baseline = arrivedBaselines[topicKey] || 0;
            var baselineImgs = arrivedBaselines[topicKey + '_imgs'] || 0;

            function updateSyncButtonLabel() {
                if (pasteDeltaContainer && pasteDeltaText && pendingDeltaText) {
                    var imgCount = (pendingDeltaImages || []).length;
                    var msgCount = pendingDeltaText.split('\n\n---\n\n').filter(Boolean).length;
                    var btnLabel = 'Sync Context (' + msgCount + ' msgs';
                    if (imgCount > 0) {
                        btnLabel += ', ' + imgCount + ' imgs';
                    }
                    btnLabel += ')';
                    pasteDeltaText.textContent = btnLabel;
                    setSyncButtonVisible(true);
                }
            }

            function executeSwitch(targetIndex) {
                Swal.close();
                if (accountSelect) accountSelect.disabled = false;
                if (typeof targetIndex === 'number') {
                    window.electronAPI.switchAccount(targetIndex);

                    setTimeout(function() {
                        window.electronAPI.showActiveView();
                    }, 150);

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

                window.electronAPI.hideActiveView();
                Swal.close();

                if (hasNewOnly) {
                    Swal.fire({
                        title: 'Sync Options',
                        text: 'අලුත් පණිවිඩ ' + newMsgsCount + 'ක් ඇත (මුළු පණිවිඩ ' + currentLength + '). මුළු Chat එකම Sync කරන්නද නැත්නම් අලුත් කොටස පමණක්ද?',
                        icon: 'question',
                        showCancelButton: true,
                        showDenyButton: true,
                        confirmButtonText: 'Sync ALL (' + currentLength + ')',
                        denyButtonText: 'Sync NEW (' + newMsgsCount + ')',
                        cancelButtonText: 'Skip (නිකන් මාරු වෙන්න)',
                        reverseButtons: false,
                        allowOutsideClick: false
                    }).then(function(result) {
                        if (result.isConfirmed) {
                            pendingDeltaText = blocks.join('\n\n---\n\n');
                            pendingDeltaImages = images;
                            pendingDeltaTarget = savedSwitchTarget;
                            updateSyncButtonLabel();
                        } else if (result.isDenied) {
                            pendingDeltaText = blocks.slice(baseline).join('\n\n---\n\n');
                            pendingDeltaImages = images.slice(baselineImgs);
                            pendingDeltaTarget = savedSwitchTarget;
                            updateSyncButtonLabel();
                        } else {
                            pendingDeltaText = '';
                            pendingDeltaImages = [];
                            pendingDeltaTarget = null;
                        }

                        arrivedBaselines[topicKey] = currentLength;
                        arrivedBaselines[topicKey + '_imgs'] = currentImagesLength;
                        pendingSwitchTarget = null;
                        executeSwitch(savedSwitchTarget);
                    });
                } else {
                    Swal.fire({
                        title: 'Sync Context?',
                        text: 'පණිවිඩ ' + currentLength + 'ක් හමු වුණා. මෙම Chat එක ඊළඟ Account එකට Sync කරන්නද?',
                        icon: 'question',
                        showCancelButton: true,
                        confirmButtonText: 'Sync ALL (' + currentLength + ')',
                        cancelButtonText: 'Skip (නිකන් මාරු වෙන්න)',
                        allowOutsideClick: false
                    }).then(function(result) {
                        if (result.isConfirmed) {
                            pendingDeltaText = blocks.join('\n\n---\n\n');
                            pendingDeltaImages = images;
                            pendingDeltaTarget = savedSwitchTarget;
                            updateSyncButtonLabel();
                        } else {
                            pendingDeltaText = '';
                            pendingDeltaImages = [];
                            pendingDeltaTarget = null;
                        }

                        arrivedBaselines[topicKey] = currentLength;
                        arrivedBaselines[topicKey + '_imgs'] = currentImagesLength;
                        pendingSwitchTarget = null;
                        executeSwitch(savedSwitchTarget);
                    });
                }
            } else {
                var directTarget = pendingSwitchTarget;
                pendingSwitchTarget = null;
                executeSwitch(directTarget);
            }
        }
    }
});

// --- File Ready Popup (QA-5, QA-6 & SEC-2 FIXED) ---
window.electronAPI.onFileReady(function(data) {
    if (!data || typeof data !== 'object') return;

    window.electronAPI.hideActiveView();

    if (data.error) {
        Swal.fire({
            title: '\u26A0\uFE0F File Save Error',
            text: data.error,
            icon: 'error',
            confirmButtonColor: '#10a37f'
        }).then(function() {
            window.electronAPI.showActiveView();
        });
        return;
    }

    // QA-6 FIX: Show exact Desktop filenames (Gemini_App_History.txt & Gemini_App_Media.pdf)
    var fileInfo = data.pdfPath
        ? 'ෆයිල් 2කම (Gemini_App_History.txt සහ Gemini_App_Media.pdf)'
        : 'Gemini_App_History.txt ෆයිල් එක';

    var pdfLine = data.pdfPath
        ? '<br>\uD83D\uDDBC\uFE0F PDF File: <code style="font-size:10px;">' + escapeHtml(data.pdfPath) + '</code>'
        : '';

    var warningBanner = data.warning
        ? '<p style="margin-top:8px; padding:8px; background:#3a2818; color:#ffb74d; border-radius:6px; font-size:12px;">\u26A0\uFE0F ' + escapeHtml(data.warning) + '</p>'
        : '';

    var htmlContent = '<div style="text-align:left; font-size:14px;">' +
        '<p>Chat history එක Desktop එකට Save වුණා! දැන් මේ පියවර අනුගමනය කරන්න:</p>' +
        '<ol style="margin-top:8px; padding-left:20px; line-height:1.6;">' +
        '<li>Gemini chat box එකේ <b>"+"</b> බොත්තම ඔබන්න.</li>' +
        '<li><b>"Upload files"</b> ඔබන්න.</li>' +
        '<li>Desktop එකේ තියෙන <b>' + escapeHtml(fileInfo) + '</b> තෝරලා Open ඔබන්න.</li>' +
        '<li>Prompt එක ඉබේම type වෙලා තියෙනවා — දැන් <b>Send</b> ඔබන්න!</li>' +
        '</ol>' +
        warningBanner +
        '<p style="margin-top:12px; font-size:11px; color:#aaa;">' +
        '\uD83D\uDCC1 Text File: <code style="font-size:10px;">' + escapeHtml(data.textPath) + '</code>' +
        pdfLine +
        '</p>' +
        '</div>';

    Swal.fire({
        title: data.pdfPath ? '\uD83D\uDCC4 Context & Images Ready!' : '\uD83D\uDCC4 Context Ready!',
        html: htmlContent,
        icon: 'success',
        showDenyButton: true,
        confirmButtonText: 'OK, මම Upload කරන්නම් \u2705',
        denyButtonText: '\uD83D\uDCC2 Desktop Folder එක පෙන්වන්න',
        confirmButtonColor: '#10a37f',
        denyButtonColor: '#333537'
    }).then(function(res) {
        if (res.isDenied) {
            window.electronAPI.openSyncFolder();
        }
        window.electronAPI.showActiveView();
    });
});
