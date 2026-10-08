// Emulates chrome.runtime.onMessage for content.js inside the page.
(function () {
    var listeners = [];
    try { window.chrome = window.chrome || {}; } catch (e) {}
    window.chrome.runtime = { lastError: null, onMessage: { addListener: function (fn) { listeners.push(fn); } } };
    window.__sonicDeliver = function (msg) {
        var resp;
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](msg, {}, function (r) { resp = r; }); } catch (e) { console.error('SonicLayer', e); }
        }
        return resp;
    };
})();
