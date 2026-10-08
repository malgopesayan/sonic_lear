const FREQS = [32, 64, 125, 250, 500, '1k', '2k', '4k', '8k', '16k'];

// EQ presets: [10-band gains], bass engine amount, voice focus amount
const PRESETS = {
    manual:    { eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],           bass: 0,  voice: 0 },
    balanced:  { eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],           bass: 0,  voice: 0 },
    bass:      { eq: [6, 5, 4, 3, 0, 0, 0, 0, 0, 0],           bass: 8,  voice: 0 },
    treble:    { eq: [-2, -2, -1, 0, 1, 2, 3, 4, 5, 5],        bass: 0,  voice: 0 },
    night:     { eq: [-3, -3, -2, -1, 0, 1, 2, 2, 1, -1],      bass: 0,  voice: 4 },
    rock:      { eq: [4, 3, 2, 1, 0, 0, 1, 2, 3, 4],           bass: 4,  voice: 0 },
    soft:      { eq: [0, 1, 2, 3, 2, 1, 0, 0, 0, 0],           bass: 2,  voice: 2 },
    classic:   { eq: [0, 0, 0, 0, 0, 0, -1, -2, -3, -4],       bass: 0,  voice: 4 },
    jazz:      { eq: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],         bass: 3,  voice: 2 },
    electronic:{ eq: [5, 4, 2, 0, 2, 0, 2, 4, 5, 6],           bass: 6,  voice: 0 },
    hiphop:    { eq: [7, 6, 3, 1, 0, -1, 0, 1, 2, 2],          bass: 9,  voice: 1 },
    lofi:      { eq: [2, 2, 1, 0, -1, -2, -3, -4, -5, -6],     bass: 3,  voice: 1 },
    vocal:     { eq: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -2],       bass: 0,  voice: 10 },
    podcast:   { eq: [-4, -3, -1, 1, 3, 4, 3, 1, -1, -3],      bass: 0,  voice: 9 },
    cinema:    { eq: [2, 1, 0, 0, 1, 3, 3, 1, 1, 2],           bass: 3,  voice: 7 },
    fps:       { eq: [-2, -1, 1, 3, 4, 5, 4, 2, 1, 0],         bass: 1,  voice: 5 },
    rpg:       { eq: [3, 2, 1, 1, 0, 1, 2, 2, 3, 3],           bass: 5,  voice: 2 }
};

const REVERB_ROOMS = {
    room:      { duration: 0.8, decay: 1.6 },
    hall:      { duration: 2.2, decay: 2.5 },
    plate:     { duration: 1.4, decay: 1.8 },
    cathedral: { duration: 4.5, decay: 4.0 }
};

const SITE_NAMES = {
    'www.youtube.com': 'YOUTUBE',
    'soundcloud.com': 'SOUNDCLOUD',
    'www.twitch.tv': 'TWITCH',
    'vimeo.com': 'VIMEO'
};

let currentHostname = null;

// Fire-and-forget message send to the content script; swallow "no receiver" errors
// (e.g. on tabs the extension isn't injected into) instead of spamming the console.
function sendToTab(message, callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
            if (chrome.runtime.lastError) {
                if (callback) callback(null);
                return;
            }
            if (callback) callback(response);
        });
    });
}

function defaultPayload() {
    return {
        eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        gain: 1, voice: 0, width: 0, limit: -10, bass: 0,
        eightD: false, preset: 'manual',
        orbit: { mode: 'circle', speed: 1, radius: 3, elevation: 0, depth: 1, randomness: 0, manualAz: 0, manualEl: 0, manualDist: 3 },
        delay: { enabled: false, time: 500, feedback: 30, mix: 40 },
        reverb: { enabled: false, room: 'hall', mix: 25 },
        chorus: { enabled: false, rate: 1, depth: 6, mix: 25 },
        phaser: { enabled: false, rate: 0.5, depth: 50, freq: 800 },
        mastering: {
            compressor: { enabled: false, amount: 40, trimLow: 0, trimMid: 0, trimHigh: 0 },
            autoLevel: { enabled: false, target: -18 }
        }
    };
}

document.addEventListener('DOMContentLoaded', () => {
    const eqRoot = document.getElementById('eq-root');

    FREQS.forEach((f, i) => {
        const div = document.createElement('div');
        div.className = 'eq-band';
        div.innerHTML = `
            <input type="range" class="eq-slider" data-idx="${i}" min="-15" max="15" value="0">
            <span class="eq-label">${f}</span>
        `;
        eqRoot.appendChild(div);
    });

    let isActive = true;

    // ---- Tabs ----
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });

    // ---- Determine site + load its profile ----
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url) {
            loadProfile(null);
            return;
        }
        try {
            currentHostname = new URL(tab.url).hostname;
            document.getElementById('site-badge').innerText = SITE_NAMES[currentHostname] || 'UNSUPPORTED SITE';
            document.getElementById('profile-badge').innerText = currentHostname;
        } catch (e) {
            document.getElementById('site-badge').innerText = 'UNKNOWN';
        }
        loadProfile(currentHostname);
    });

    function loadProfile(hostname) {
        chrome.storage.local.get(['power', 'profiles', 'defaultProfile'], (result) => {
            if (result.power !== undefined) {
                isActive = result.power;
                updatePowerUI();
            }
            const profiles = result.profiles || {};
            const payload = (hostname && profiles[hostname]) || result.defaultProfile || defaultPayload();
            applyPayloadToUI(payload);
            refreshSubPanels();
            // Push current state to the tab so the content script matches what's shown
            // (harmless no-op if the tab has no content script).
            sendUpdate({ persist: false });
        });
    }

    function applyPayloadToUI(s) {
        if (s.eq) {
            document.querySelectorAll('.eq-slider').forEach((el, i) => {
                if (s.eq[i] !== undefined) el.value = s.eq[i];
            });
        }
        setIfDefined('gain', s.gain);
        setIfDefined('voice', s.voice);
        setIfDefined('width', s.width);
        setIfDefined('limit', s.limit);
        setIfDefined('bass', s.bass);
        if (s.eightD !== undefined) document.getElementById('eightD').checked = s.eightD;
        if (s.preset) document.getElementById('presets').value = s.preset;

        if (s.orbit) {
            document.getElementById('orbit-mode').value = s.orbit.mode || 'circle';
            setIfDefined('orbit-speed', s.orbit.speed);
            setIfDefined('orbit-radius', s.orbit.radius);
            setIfDefined('orbit-elevation', s.orbit.elevation);
            setIfDefined('orbit-depth', s.orbit.depth);
            setIfDefined('orbit-randomness', s.orbit.randomness);
            setIfDefined('orbit-az', s.orbit.manualAz);
            setIfDefined('orbit-el', s.orbit.manualEl);
            setIfDefined('orbit-dist', s.orbit.manualDist);
        }

        if (s.delay) {
            document.getElementById('delay-enable').checked = !!s.delay.enabled;
            setIfDefined('delay-time', s.delay.time);
            setIfDefined('delay-feedback', s.delay.feedback);
            setIfDefined('delay-mix', s.delay.mix);
        }
        if (s.reverb) {
            document.getElementById('reverb-enable').checked = !!s.reverb.enabled;
            if (s.reverb.room) document.getElementById('reverb-room').value = s.reverb.room;
            setIfDefined('reverb-mix', s.reverb.mix);
        }
        if (s.chorus) {
            document.getElementById('chorus-enable').checked = !!s.chorus.enabled;
            setIfDefined('chorus-rate', s.chorus.rate);
            setIfDefined('chorus-depth', s.chorus.depth);
            setIfDefined('chorus-mix', s.chorus.mix);
        }
        if (s.phaser) {
            document.getElementById('phaser-enable').checked = !!s.phaser.enabled;
            setIfDefined('phaser-rate', s.phaser.rate);
            setIfDefined('phaser-depth', s.phaser.depth);
            setIfDefined('phaser-freq', s.phaser.freq);
        }
        if (s.mastering) {
            const c = s.mastering.compressor || {};
            document.getElementById('mbcomp-enable').checked = !!c.enabled;
            setIfDefined('mbcomp-amount', c.amount);
            setIfDefined('mbcomp-low', c.trimLow);
            setIfDefined('mbcomp-mid', c.trimMid);
            setIfDefined('mbcomp-high', c.trimHigh);

            const al = s.mastering.autoLevel || {};
            document.getElementById('autolevel-enable').checked = !!al.enabled;
            setIfDefined('autolevel-target', al.target);
        }
    }

    function setIfDefined(id, val) {
        if (val !== undefined && val !== null) document.getElementById(id).value = val;
    }

    function refreshSubPanels() {
        toggle('delay-controls', document.getElementById('delay-enable').checked);
        toggle('reverb-controls', document.getElementById('reverb-enable').checked);
        toggle('chorus-controls', document.getElementById('chorus-enable').checked);
        toggle('phaser-controls', document.getElementById('phaser-enable').checked);
        toggle('mbcomp-controls', document.getElementById('mbcomp-enable').checked);
        toggle('autolevel-controls', document.getElementById('autolevel-enable').checked);
        refreshOrbitModePanels();
    }

    function refreshOrbitModePanels() {
        const isManual = document.getElementById('orbit-mode').value === 'manual';
        document.getElementById('orbit-motion-controls').style.display = isManual ? 'none' : 'block';
        document.getElementById('orbit-manual-controls').style.display = isManual ? 'block' : 'none';
    }

    function toggle(id, open) {
        document.getElementById(id).classList.toggle('open', !!open);
    }

    // ---- Preset selection ----
    document.getElementById('presets').addEventListener('change', (e) => {
        const presetKey = e.target.value;
        if (presetKey === 'manual') return;
        const preset = PRESETS[presetKey];
        if (!preset) return;

        document.querySelectorAll('.eq-slider').forEach((el, i) => {
            if (preset.eq[i] !== undefined) el.value = preset.eq[i];
        });
        if (preset.bass !== undefined) document.getElementById('bass').value = preset.bass;
        if (preset.voice !== undefined) document.getElementById('voice').value = preset.voice;

        sendUpdate();
    });

    // ---- Power toggle ----
    function updatePowerUI() {
        const btn = document.getElementById('power');
        const txt = document.getElementById('power-text');
        if (!btn) return;
        if (isActive) {
            btn.classList.remove('offline');
            txt.innerText = 'ONLINE';
        } else {
            btn.classList.add('offline');
            txt.innerText = 'OFFLINE';
        }
    }

    document.getElementById('power').addEventListener('click', () => {
        isActive = !isActive;
        chrome.storage.local.set({ power: isActive });
        updatePowerUI();
        sendUpdate();
    });

    document.getElementById('orbit-mode').addEventListener('change', () => {
        refreshOrbitModePanels();
        sendUpdate();
    });

    // ---- Effect enable toggles (open/close their sub-panels) ----
    [
        ['delay-enable', 'delay-controls'],
        ['reverb-enable', 'reverb-controls'],
        ['chorus-enable', 'chorus-controls'],
        ['phaser-enable', 'phaser-controls'],
        ['mbcomp-enable', 'mbcomp-controls'],
        ['autolevel-enable', 'autolevel-controls']
    ].forEach(([toggleId, panelId]) => {
        document.getElementById(toggleId).addEventListener('change', (e) => {
            toggle(panelId, e.target.checked);
            sendUpdate();
        });
    });

    // ---- Build payload from current UI state ----
    function buildPayload() {
        const eqVals = Array.from(document.querySelectorAll('.eq-slider')).map(s => parseFloat(s.value));
        const room = REVERB_ROOMS[document.getElementById('reverb-room').value] || REVERB_ROOMS.hall;

        return {
            eq: eqVals,
            gain: document.getElementById('gain').value,
            voice: document.getElementById('voice').value,
            width: document.getElementById('width').value,
            limit: document.getElementById('limit').value,
            bass: document.getElementById('bass').value,
            eightD: document.getElementById('eightD').checked,
            preset: document.getElementById('presets').value,
            orbit: {
                mode: document.getElementById('orbit-mode').value,
                speed: document.getElementById('orbit-speed').value,
                radius: document.getElementById('orbit-radius').value,
                elevation: document.getElementById('orbit-elevation').value,
                depth: document.getElementById('orbit-depth').value,
                randomness: document.getElementById('orbit-randomness').value,
                manualAz: document.getElementById('orbit-az').value,
                manualEl: document.getElementById('orbit-el').value,
                manualDist: document.getElementById('orbit-dist').value
            },
            delay: {
                enabled: document.getElementById('delay-enable').checked,
                time: document.getElementById('delay-time').value,
                feedback: document.getElementById('delay-feedback').value,
                mix: document.getElementById('delay-mix').value
            },
            reverb: {
                enabled: document.getElementById('reverb-enable').checked,
                room: document.getElementById('reverb-room').value,
                size: room.duration * 50,
                decay: room.decay,
                mix: document.getElementById('reverb-mix').value
            },
            chorus: {
                enabled: document.getElementById('chorus-enable').checked,
                rate: document.getElementById('chorus-rate').value,
                depth: document.getElementById('chorus-depth').value,
                mix: document.getElementById('chorus-mix').value
            },
            phaser: {
                enabled: document.getElementById('phaser-enable').checked,
                rate: document.getElementById('phaser-rate').value,
                depth: document.getElementById('phaser-depth').value,
                freq: document.getElementById('phaser-freq').value
            },
            mastering: {
                compressor: {
                    enabled: document.getElementById('mbcomp-enable').checked,
                    amount: document.getElementById('mbcomp-amount').value,
                    trimLow: document.getElementById('mbcomp-low').value,
                    trimMid: document.getElementById('mbcomp-mid').value,
                    trimHigh: document.getElementById('mbcomp-high').value
                },
                autoLevel: {
                    enabled: document.getElementById('autolevel-enable').checked,
                    target: document.getElementById('autolevel-target').value
                }
            }
        };
    }

    function updateLabels(data) {
        document.getElementById('l-gain').innerText = data.gain;
        const w = parseFloat(data.width);
        document.getElementById('l-width').innerText = w === 0 ? 'Normal' : (w < 0 ? `Narrow ${w}` : `Wide +${w}`);
        document.getElementById('l-limit').innerText = data.limit + "dB";
        document.getElementById('l-bass').innerText = data.bass;
        document.getElementById('l-voice').innerText = data.voice;

        document.getElementById('l-delay-time').innerText = data.delay.time + "ms";
        document.getElementById('l-delay-feedback').innerText = data.delay.feedback + "%";
        document.getElementById('l-delay-mix').innerText = data.delay.mix + "%";

        document.getElementById('l-reverb-mix').innerText = data.reverb.mix + "%";
        document.getElementById('l-chorus-rate').innerText = data.chorus.rate + "Hz";
        document.getElementById('l-chorus-depth').innerText = data.chorus.depth + "ms";
        document.getElementById('l-chorus-mix').innerText = data.chorus.mix + "%";
        document.getElementById('l-phaser-rate').innerText = data.phaser.rate + "Hz";
        document.getElementById('l-phaser-depth').innerText = data.phaser.depth;
        document.getElementById('l-phaser-freq').innerText = data.phaser.freq + "Hz";

        document.getElementById('l-mbcomp-amount').innerText = data.mastering.compressor.amount;
        document.getElementById('l-mbcomp-low').innerText = data.mastering.compressor.trimLow + "dB";
        document.getElementById('l-mbcomp-mid').innerText = data.mastering.compressor.trimMid + "dB";
        document.getElementById('l-mbcomp-high').innerText = data.mastering.compressor.trimHigh + "dB";
        document.getElementById('l-autolevel-target').innerText = data.mastering.autoLevel.target + "dB";

        document.getElementById('l-orbit-speed').innerText = parseFloat(data.orbit.speed).toFixed(2) + "×";
        document.getElementById('l-orbit-radius').innerText = parseFloat(data.orbit.radius).toFixed(1);
        document.getElementById('l-orbit-elevation').innerText = parseFloat(data.orbit.elevation).toFixed(2);
        document.getElementById('l-orbit-depth').innerText = parseFloat(data.orbit.depth).toFixed(1) + "×";
        document.getElementById('l-orbit-randomness').innerText = data.orbit.randomness + "%";
        document.getElementById('l-orbit-az').innerText = data.orbit.manualAz + "°";
        document.getElementById('l-orbit-el').innerText = data.orbit.manualEl + "°";
        document.getElementById('l-orbit-dist').innerText = parseFloat(data.orbit.manualDist).toFixed(1);
    }

    // ---- Persist (per-site) + send to content script ----
    function sendUpdate(opts) {
        const persist = !opts || opts.persist !== false;
        const payload = buildPayload();
        updateLabels(payload);

        if (persist) {
            chrome.storage.local.get(['profiles', 'defaultProfile'], (result) => {
                const profiles = result.profiles || {};
                if (currentHostname) profiles[currentHostname] = payload;
                chrome.storage.local.set({ profiles, defaultProfile: payload });
            });
        }

        sendToTab(Object.assign({ type: 'SET_AUDIO', enabled: isActive }, payload));
    }

    document.querySelectorAll('input').forEach(el => el.addEventListener('input', () => {
        if (el.classList.contains('eq-slider') || el.id === 'bass' || el.id === 'voice') {
            document.getElementById('presets').value = 'manual';
        }
        sendUpdate();
    }));
    document.getElementById('reverb-room').addEventListener('change', () => sendUpdate());

    // ---- Reset (this popup's controls, applies to current site) ----
    function resetAll() {
        document.querySelectorAll('.eq-slider').forEach(el => el.value = 0);
        applyPayloadToUI(defaultPayload());
        refreshSubPanels();
        sendUpdate();
    }
    document.getElementById('activate').addEventListener('click', resetAll);
    document.getElementById('reset-preset').addEventListener('click', resetAll);

    // ---- Reset just this site's saved profile ----
    document.getElementById('reset-site').addEventListener('click', () => {
        if (!currentHostname) return;
        chrome.storage.local.get(['profiles'], (result) => {
            const profiles = result.profiles || {};
            delete profiles[currentHostname];
            chrome.storage.local.set({ profiles }, () => {
                loadProfile(currentHostname);
            });
        });
    });

    // ---- Import / Export ----
    document.getElementById('export-settings').addEventListener('click', () => {
        chrome.storage.local.get(['profiles', 'defaultProfile'], (result) => {
            const exportData = {
                soniclayerExport: true,
                version: 1,
                exportedAt: new Date().toISOString(),
                profiles: result.profiles || {},
                defaultProfile: result.defaultProfile || defaultPayload()
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'soniclayer-settings.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
    });

    document.getElementById('import-settings').addEventListener('click', () => {
        document.getElementById('import-file-input').click();
    });

    document.getElementById('import-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (!data || !data.soniclayerExport) {
                    alert('This does not look like a SonicLayer export file.');
                    return;
                }
                chrome.storage.local.set({
                    profiles: data.profiles || {},
                    defaultProfile: data.defaultProfile || defaultPayload()
                }, () => {
                    loadProfile(currentHostname);
                });
            } catch (err) {
                alert('Could not read that file — is it valid JSON?');
            }
        };
        reader.readAsText(file);
        e.target.value = ''; // allow re-importing the same filename later
    });

    // ---- 3D Orbit Indicator ----
    // Mirrors the same shared orbit-math.js formulas the content script uses
    // to drive the real panner. This is a visual simulation running on its
    // own clock (performance.now()), not a live telemetry read from the
    // audio thread — Web Audio doesn't expose a way to read back an
    // AudioParam's current value cheaply, and for a periodic deterministic
    // path like this, a mirrored simulation looks identical in practice.
    const orbitCanvas = document.getElementById('orbit-canvas');
    const orbitCtx = orbitCanvas.getContext('2d');
    const elevMarker = document.getElementById('elev-marker');
    const orbitStartPerf = performance.now();
    let orbitVisualAlive = true;

    function currentOrbitParams() {
        return {
            mode: document.getElementById('orbit-mode').value,
            speed: parseFloat(document.getElementById('orbit-speed').value),
            radius: parseFloat(document.getElementById('orbit-radius').value),
            elevation: parseFloat(document.getElementById('orbit-elevation').value),
            depth: parseFloat(document.getElementById('orbit-depth').value),
            randomness: parseFloat(document.getElementById('orbit-randomness').value),
            manualAz: parseFloat(document.getElementById('orbit-az').value),
            manualEl: parseFloat(document.getElementById('orbit-el').value),
            manualDist: parseFloat(document.getElementById('orbit-dist').value)
        };
    }

    function drawOrbitIndicator() {
        if (!orbitVisualAlive) return;
        const w = orbitCanvas.width, h = orbitCanvas.height;
        const cx = w / 2, cy = h / 2;
        const maxR = Math.min(w, h) / 2 - 14;

        orbitCtx.clearRect(0, 0, w, h);

        // Reference rings + crosshair (top-down view; "front" = up on screen)
        orbitCtx.strokeStyle = 'rgba(255,255,255,0.12)';
        orbitCtx.lineWidth = 1;
        [0.33, 0.66, 1].forEach(f => {
            orbitCtx.beginPath();
            orbitCtx.arc(cx, cy, maxR * f, 0, Math.PI * 2);
            orbitCtx.stroke();
        });
        orbitCtx.beginPath();
        orbitCtx.moveTo(cx, cy - maxR); orbitCtx.lineTo(cx, cy + maxR);
        orbitCtx.moveTo(cx - maxR, cy); orbitCtx.lineTo(cx + maxR, cy);
        orbitCtx.stroke();

        // Listener (center)
        orbitCtx.fillStyle = 'rgba(255,255,255,0.6)';
        orbitCtx.beginPath();
        orbitCtx.arc(cx, cy, 3, 0, Math.PI * 2);
        orbitCtx.fill();
        orbitCtx.fillStyle = 'rgba(255,255,255,0.35)';
        orbitCtx.font = '8px sans-serif';
        orbitCtx.fillText('FRONT', cx - 14, cy - maxR - 3);

        const isOn = document.getElementById('eightD').checked;
        const t = (performance.now() - orbitStartPerf) / 1000;
        const params = currentOrbitParams();
        const pos = window.SonicLayerOrbit ? window.SonicLayerOrbit.computePosition(t, params) : { x: 0, y: 0, z: -3, distance: 3 };

        // Scale room-units to screen pixels; clamp so wide radii stay on-canvas
        const scale = maxR / 8;
        const px = cx + Math.max(-maxR, Math.min(maxR, pos.x * scale));
        // z negative = front = up on screen, so flip sign
        const py = cy + Math.max(-maxR, Math.min(maxR, pos.z * scale));

        const dotAlpha = isOn ? 1 : 0.25;
        const dotRadius = 5 + Math.max(0, Math.min(3, (4 - pos.distance) * 0.6)); // closer = slightly bigger

        const grad = orbitCtx.createRadialGradient(px, py, 0, px, py, dotRadius * 2.2);
        grad.addColorStop(0, `rgba(0,242,255,${dotAlpha})`);
        grad.addColorStop(1, 'rgba(0,242,255,0)');
        orbitCtx.fillStyle = grad;
        orbitCtx.beginPath();
        orbitCtx.arc(px, py, dotRadius * 2.2, 0, Math.PI * 2);
        orbitCtx.fill();

        orbitCtx.fillStyle = `rgba(189,0,255,${dotAlpha})`;
        orbitCtx.beginPath();
        orbitCtx.arc(px, py, dotRadius, 0, Math.PI * 2);
        orbitCtx.fill();

        // Elevation bar: map roughly -3..+3 units to the 150px bar (0 = middle)
        const barHeight = 150;
        const elevFrac = Math.max(-1, Math.min(1, pos.y / 3));
        const markerTop = (barHeight / 2) - (elevFrac * (barHeight / 2 - 8)) - 5;
        elevMarker.style.top = markerTop + 'px';
        elevMarker.style.opacity = isOn ? '1' : '0.3';

        requestAnimationFrame(drawOrbitIndicator);
    }
    requestAnimationFrame(drawOrbitIndicator);
    window.addEventListener('unload', () => { orbitVisualAlive = false; });

    // ---- Visualizer ----
    const canvas = document.getElementById('viz');
    const ctx = canvas.getContext('2d');

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
    }
    window.addEventListener('resize', resize);
    resize();

    function getGradient(c, height) {
        const g = c.createLinearGradient(0, height, 0, 0);
        g.addColorStop(0, '#00f2ff');
        g.addColorStop(0.5, '#bd00ff');
        g.addColorStop(1, '#ffffff');
        return g;
    }

    let vizAlive = true;
    function draw() {
        if (!vizAlive) return;
        sendToTab({ type: 'GET_VIZ' }, (response) => {
            if (response && response.data) {
                const width = canvas.width / (window.devicePixelRatio || 1);
                const height = canvas.height / (window.devicePixelRatio || 1);
                ctx.clearRect(0, 0, width, height);
                const barWidth = width / response.data.length;
                ctx.fillStyle = getGradient(ctx, height);
                response.data.forEach((v, i) => {
                    const val = v / 255;
                    const h = val * height;
                    ctx.fillRect(i * barWidth, height - h, barWidth - 1, h);
                });
            }
        });
        requestAnimationFrame(draw);
    }
    draw();
    window.addEventListener('unload', () => { vizAlive = false; });
});
