// Emulates the slice of the chrome.* API that popup.js uses, backed by the
// native AndroidBridge (storage = SharedPreferences, tabs = the in-app WebView).
(function () {
    var cbs = {}, n = 0, vizBusy = false, lastViz = 0;
    window.__sonicCb = function (id, res) {
        var cb = cbs[id]; delete cbs[id];
        if (id < 0) vizBusy = false;
        if (!cb) return;
        if (res === '__norec__') {
            chrome.runtime.lastError = { message: 'no receiver' };
            try { cb(undefined); } finally { chrome.runtime.lastError = null; }
        } else {
            chrome.runtime.lastError = null;
            cb(res === null ? undefined : res);
        }
    };
    window.chrome = {
        runtime: { lastError: null },
        tabs: {
            query: function (q, cb) {
                var url = AndroidBridge.getTabUrl();
                setTimeout(function () { cb([{ id: 1, url: url }]); }, 0);
            },
            sendMessage: function (tabId, msg, cb) {
                var id = ++n;
                if (msg && msg.type === 'GET_VIZ') {
                    // Visualizer polls every animation frame; cap it so the JS
                    // bridge isn't flooded (one request in flight, max ~20/s).
                    var now = Date.now();
                    if (vizBusy || now - lastViz < 50) return;
                    vizBusy = true; lastViz = now; id = -id;
                }
                if (cb) cbs[id] = cb; else if (id < 0) cbs[id] = function () {};
                AndroidBridge.sendToTab(JSON.stringify(msg), id);
            }
        },
        storage: {
            local: {
                get: function (keys, cb) {
                    var r = JSON.parse(AndroidBridge.storageGet(JSON.stringify(keys == null ? null : keys)));
                    if (cb) setTimeout(function () { cb(r); }, 0);
                },
                set: function (obj, cb) {
                    AndroidBridge.storageSet(JSON.stringify(obj));
                    if (cb) setTimeout(cb, 0);
                }
            }
        }
    };
    // Blob-URL "download" links don't work in a WebView; route them to native.
    var origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        var a = this;
        if (a.download && String(a.href).indexOf('blob:') === 0) {
            fetch(a.href).then(function (r) { return r.text(); })
                .then(function (t) { AndroidBridge.saveDownload(a.download, t); });
            return;
        }
        return origClick.apply(a, arguments);
    };
})();
