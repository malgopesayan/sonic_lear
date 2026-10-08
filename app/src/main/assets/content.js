let audioCtx, source, analyzer, gainNode, panner, limiter, bassNode, eqNodes = [];
let spaceGain; // Room ambience (early reflections) wet amount
let spaceDelay1, spaceDelay2, spaceDelay3, spaceTapGain1, spaceTapGain2, spaceTapGain3, spaceReflectSum;

// SPATIAL ENGINE (8D Orbit) — tick-driven, see startOrbitTick()/orbitTick()
let orbitTimerId = null;
let orbitStartAudioTime = 0;
let orbitAccumulatedTime = 0;
let orbitEnabled = false;
let orbitParams = { mode: 'circle', speed: 1, radius: 3, elevation: 0, depth: 1, randomness: 0, manualAz: 0, manualEl: 0, manualDist: 3 };
let lastOrbitDistance = null;
let lastOrbitTickTime = null;
let airAbsorbFilter, dopplerDelay, elevShelfFilter, frontBackFilter;
let orbitReverbSend, orbitReverbReturn;

// Advanced Effects
let reverbNode, reverbGain, reverbWet, reverbDry;
let chorusDelay, chorusLFO, chorusGain, chorusDepthGain, chorusWet, chorusDry;
let delayNode, delayFeedback, delayGain, delayWet, delayDry;
let phaserFilters = [], phaserLFO, phaserDepthGain, phaserGain;

// Multiband Compressor (Mastering)
let mbLowFilter, mbMidHP, mbMidLP, mbHighFilter;
let mbCompLow, mbCompMid, mbCompHigh;
let mbTrimLow, mbTrimMid, mbTrimHigh;
let mbSum, mbDry, mbWet, mbOutput;

// True Stereo Widener (Mid/Side) + spatial switch
let widenSplitter, msLg, msRg, msLgS, msRgSInv, midSum, sideSum, sideWidthGain, sideInvForR, LoutSum, RoutSum, stereoMerger;
let widenerSwitch, pannerSwitch, preLimiterSum;

// RMS Auto-Leveler (not true LUFS — see README)
let autoGainNode, levelAnalyser;
let autoLevelTimer = null;
let autoLevelEnabled = false;
let autoLevelTargetDb = -18;

const FREQ_LIST = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
let currentVideo = null;
let isEngineInitialized = false;

// Initialize on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
} else {
    startObserver();
}

function startObserver() {
    attemptInit();
    const observer = new MutationObserver(() => {
        attemptInit();
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}

function dbToLinear(db) {
    return Math.pow(10, db / 20);
}

function attemptInit() {
    const media = document.querySelector('video, audio');
    if (media && media !== currentVideo) {
        console.log("SonicLayer: New media element detected.");
        initEngine(media);
    }
}

function initEngine(videoEl) {
    if (!videoEl) return;
    if (currentVideo === videoEl && isEngineInitialized) return;

    try {
        if (!videoEl.dataset.connected) {
            try { videoEl.crossOrigin = "anonymous"; } catch (e) { /* some hosts disallow this after load */ }
            videoEl.dataset.connected = "true";
        }

        if (!audioCtx) {
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (err) {
                console.error("SonicLayer: Could not create AudioContext", err);
                return;
            }
        } else if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        // Reuse or create source
        if (!source || currentVideo !== videoEl) {
            try {
                if (source) source.disconnect();
                source = audioCtx.createMediaElementSource(videoEl);
            } catch (err) {
                console.warn("SonicLayer: Source already connected or bound", err);
                // If it fails with "already bound", we can still try to continue if source is valid
                if (!source) {
                    console.error("SonicLayer: Could not attach to this media element (it may be DRM-protected).");
                    return;
                }
            }
        }

        currentVideo = videoEl;
        setupAudioGraph();

        // Initial connection: Direct to output (bypass effects)
        // This will be updated by updateEngineState() when settings are received
        source.connect(audioCtx.destination);

        isEngineInitialized = true;

        console.log("SonicLayer: Engine Attached");

    } catch (e) {
        console.error("SonicLayer: Init Error", e);
    }
}

function setupAudioGraph() {
    if (eqNodes.length > 0) return;

    // 1. Bass Node
    bassNode = audioCtx.createBiquadFilter();
    bassNode.type = "lowshelf";
    bassNode.frequency.value = 80;
    bassNode.gain.value = 0;

    let lastNode = bassNode;

    // 2. EQ Chain
    FREQ_LIST.forEach(f => {
        const filter = audioCtx.createBiquadFilter();
        filter.type = (f < 100) ? "lowshelf" : (f > 8000) ? "highshelf" : "peaking";
        filter.frequency.value = f;
        filter.gain.value = 0;
        lastNode.connect(filter);
        eqNodes.push(filter);
        lastNode = filter;
    });

    // 3. Output Chain (Limiter/Compressor)
    // -------------------------------------------------------------------------
    // WORKING PRINCIPLE (Audio Engineering Standard):
    // 1. THRESHOLD (dB): The level above which compression starts.
    // 2. RATIO (X:1): Controls how much gain reduction happens above threshold.
    // 3. ATTACK (ms): How fast compression starts after signal crosses threshold (controls punch).
    // 4. RELEASE (ms): How fast compression stops after signal falls below threshold (controls smoothness).
    // 5. KNEE (dB): Controls how gradually compression starts (Hard vs Soft).
    // 6. MAKEUP GAIN (dB): Restores lost loudness after compression (not directly in this API, handled by gainNode).
    // Signal Path: Panner -> Compressor -> Analyzer -> Output
    // -------------------------------------------------------------------------

    // 3. Output Chain (Limiter/Compressor)
    // -------------------------------------------------------------------------
    // REFACTOR: switching to PannerNode (HRTF) for True 3D Audio
    // This replaces manual filtering with browser-native 3D processing.
    // -------------------------------------------------------------------------

    // Use standard 3D Panner
    panner = audioCtx.createPanner();
    panner.panningModel = 'HRTF'; // Real binaural rendering, native to the browser
    panner.distanceModel = 'linear';
    panner.refDistance = 1;
    panner.maxDistance = 20; // tuned to our orbit's ~1-8 unit coordinate scale
    panner.rolloffFactor = 1;
    panner.coneInnerAngle = 360;

    limiter = audioCtx.createDynamicsCompressor();
    gainNode = audioCtx.createGain();

    // NOTE: panner is connected further down, once the stereo widener / 8D
    // switch stage exists (see "OUTPUT STAGE" section near the end of this
    // function). Connecting it here would double-route audio.

    analyzer = audioCtx.createAnalyser();
    analyzer.fftSize = 256;

    // =========================================================================
    // SPATIAL ENGINE — supplementary cues feeding the HRTF panner
    // -------------------------------------------------------------------------
    // Real ITD/ILD localization comes from the panner's built-in HRTF
    // convolution itself (Chrome ships a real binaural dataset — we don't
    // reimplement that). These three filters add the *supplementary* cues a
    // non-personalized HRTF is known to be weak on:
    //   - airAbsorbFilter: gentle distance-linked high-frequency roll-off.
    //     Real atmospheric absorption is inaudible at room-scale distances;
    //     this is a stylized cue, tuned for perceptual effect, not physics.
    //   - dopplerDelay: tiny velocity-linked delay modulation. True Doppler
    //     shift at these orbit speeds (a few "meters"/sec) is a fraction of
    //     a Hz — inaudible. This is the same stylized trick commercial 8D
    //     effects use to sell the illusion of motion, kept subtle enough to
    //     not sound like pitch-bending.
    //   - elevShelfFilter / frontBackFilter: subtle spectral shelving tied to
    //     elevation and front/back position. This approximates the pinna
    //     (outer-ear) filtering that real ears add and generic HRTF datasets
    //     under-represent, which is the main cause of front-back confusion
    //     in non-personalized binaural audio.
    // All are driven from orbitTick() below, updated ~20x/sec with smoothed
    // AudioParam ramps — cheap (a handful of trig ops), never audio-thread
    // work, so CPU stays low.
    // =========================================================================
    airAbsorbFilter = audioCtx.createBiquadFilter();
    airAbsorbFilter.type = 'lowpass';
    airAbsorbFilter.frequency.value = 18000;
    airAbsorbFilter.Q.value = 0.707;

    dopplerDelay = audioCtx.createDelay(0.05);
    dopplerDelay.delayTime.value = 0.003;

    elevShelfFilter = audioCtx.createBiquadFilter();
    elevShelfFilter.type = 'highshelf';
    elevShelfFilter.frequency.value = 6000;
    elevShelfFilter.gain.value = 0;

    frontBackFilter = audioCtx.createBiquadFilter();
    frontBackFilter.type = 'peaking';
    frontBackFilter.frequency.value = 4000;
    frontBackFilter.Q.value = 0.9;
    frontBackFilter.gain.value = 0;

    // EARLY REFLECTIONS (3 short taps, decreasing gain) — cheap externalization
    // cue. Real rooms give the brain several closely-spaced early echoes
    // before the diffuse reverb tail; a single 30ms tap (the old version)
    // reads as "delay," three taps reads as "space."
    spaceDelay1 = audioCtx.createDelay(0.1); spaceDelay1.delayTime.value = 0.012;
    spaceDelay2 = audioCtx.createDelay(0.1); spaceDelay2.delayTime.value = 0.019;
    spaceDelay3 = audioCtx.createDelay(0.1); spaceDelay3.delayTime.value = 0.027;
    spaceTapGain1 = audioCtx.createGain(); spaceTapGain1.gain.value = 0.25;
    spaceTapGain2 = audioCtx.createGain(); spaceTapGain2.gain.value = 0.15;
    spaceTapGain3 = audioCtx.createGain(); spaceTapGain3.gain.value = 0.08;
    spaceReflectSum = audioCtx.createGain(); spaceReflectSum.gain.value = 1;
    spaceGain = audioCtx.createGain(); spaceGain.gain.value = 0; // master wet amount, toggled with 8D

    // Small dedicated room-ambience send: reuses the Reverb effect's
    // convolver (built below) at a low, fixed level while 8D is active, so
    // Orbit always has a bit of its own space even if the user hasn't
    // turned the main Reverb effect on. Independent of the user's Reverb
    // enabled/mix settings.
    orbitReverbSend = audioCtx.createGain(); orbitReverbSend.gain.value = 0;
    orbitReverbReturn = audioCtx.createGain(); orbitReverbReturn.gain.value = 0.5;

    // =========================================================================
    // 5. ADVANCED EFFECTS CHAIN
    // =========================================================================

    // REVERB (Convolver-based Room Simulation)
    // -------------------------------------------------------------------------
    function createImpulseResponse(duration, decay) {
        const sampleRate = audioCtx.sampleRate;
        const length = sampleRate * duration;
        const impulse = audioCtx.createBuffer(2, length, sampleRate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);

        for (let i = 0; i < length; i++) {
            const n = i / sampleRate;
            left[i] = (Math.random() * 2 - 1) * Math.exp(-n / decay);
            right[i] = (Math.random() * 2 - 1) * Math.exp(-n / decay);
        }
        return impulse;
    }

    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = createImpulseResponse(2, 2); // 2s duration, 2s decay

    reverbWet = audioCtx.createGain();
    reverbWet.gain.value = 0; // Off by default

    reverbDry = audioCtx.createGain();
    reverbDry.gain.value = 1; // Full dry signal

    reverbGain = audioCtx.createGain();
    reverbGain.gain.value = 1;

    // CHORUS (Delay + LFO Modulation)
    // -------------------------------------------------------------------------
    chorusDelay = audioCtx.createDelay(0.1);
    chorusDelay.delayTime.value = 0.02; // 20ms base delay

    chorusLFO = audioCtx.createOscillator();
    chorusLFO.type = 'sine';
    chorusLFO.frequency.value = 1; // 1Hz rate

    chorusDepthGain = audioCtx.createGain();
    chorusDepthGain.gain.value = 0; // Off by default (depth control)

    chorusWet = audioCtx.createGain();
    chorusWet.gain.value = 0;

    chorusDry = audioCtx.createGain();
    chorusDry.gain.value = 1;

    chorusGain = audioCtx.createGain();
    chorusGain.gain.value = 1;

    // Wire Chorus LFO
    chorusLFO.connect(chorusDepthGain);
    chorusDepthGain.connect(chorusDelay.delayTime);
    chorusLFO.start();

    // DELAY/ECHO (Delay + Feedback Loop)
    // -------------------------------------------------------------------------
    delayNode = audioCtx.createDelay(2.0);
    delayNode.delayTime.value = 0.5; // 500ms

    delayFeedback = audioCtx.createGain();
    delayFeedback.gain.value = 0; // Off by default

    delayWet = audioCtx.createGain();
    delayWet.gain.value = 0;

    delayDry = audioCtx.createGain();
    delayDry.gain.value = 1;

    delayGain = audioCtx.createGain();
    delayGain.gain.value = 1;

    // Wire Delay Feedback
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);

    // PHASER (AllPass Filters + LFO)
    // -------------------------------------------------------------------------
    phaserFilters = [];
    for (let i = 0; i < 6; i++) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'allpass';
        filter.frequency.value = 800; // Center frequency
        filter.Q.value = 1;
        phaserFilters.push(filter);
    }

    phaserLFO = audioCtx.createOscillator();
    phaserLFO.type = 'sine';
    phaserLFO.frequency.value = 0.5; // 0.5Hz rate

    phaserDepthGain = audioCtx.createGain();
    phaserDepthGain.gain.value = 0; // Off by default

    phaserGain = audioCtx.createGain();
    phaserGain.gain.value = 1;

    // Wire Phaser LFO to all filters
    phaserFilters.forEach(filter => {
        phaserLFO.connect(phaserDepthGain);
        phaserDepthGain.connect(filter.frequency);
    });
    phaserLFO.start();

    // =========================================================================
    // MULTIBAND COMPRESSOR (Mastering) — Low <250Hz / Mid 250-4000Hz / High >4000Hz
    // Each band gets its own DynamicsCompressorNode + makeup trim, then sums.
    // A dry path lets it fully bypass when disabled (avoids coloring audio
    // when the user hasn't opted in).
    // =========================================================================
    mbLowFilter = audioCtx.createBiquadFilter();
    mbLowFilter.type = 'lowpass';
    mbLowFilter.frequency.value = 250;

    mbMidHP = audioCtx.createBiquadFilter();
    mbMidHP.type = 'highpass';
    mbMidHP.frequency.value = 250;
    mbMidLP = audioCtx.createBiquadFilter();
    mbMidLP.type = 'lowpass';
    mbMidLP.frequency.value = 4000;
    mbMidHP.connect(mbMidLP);

    mbHighFilter = audioCtx.createBiquadFilter();
    mbHighFilter.type = 'highpass';
    mbHighFilter.frequency.value = 4000;

    mbCompLow = audioCtx.createDynamicsCompressor();
    mbCompMid = audioCtx.createDynamicsCompressor();
    mbCompHigh = audioCtx.createDynamicsCompressor();
    [mbCompLow, mbCompMid, mbCompHigh].forEach(c => {
        c.threshold.value = -24; c.knee.value = 12; c.ratio.value = 3; c.attack.value = 0.01; c.release.value = 0.2;
    });

    mbTrimLow = audioCtx.createGain(); mbTrimLow.gain.value = 1;
    mbTrimMid = audioCtx.createGain(); mbTrimMid.gain.value = 1;
    mbTrimHigh = audioCtx.createGain(); mbTrimHigh.gain.value = 1;

    mbSum = audioCtx.createGain(); mbSum.gain.value = 1;
    mbDry = audioCtx.createGain(); mbDry.gain.value = 1; // bypass by default
    mbWet = audioCtx.createGain(); mbWet.gain.value = 0;
    mbOutput = audioCtx.createGain(); mbOutput.gain.value = 1;

    lastNode.connect(mbLowFilter);
    lastNode.connect(mbMidHP);
    lastNode.connect(mbHighFilter);
    lastNode.connect(mbDry);

    mbLowFilter.connect(mbCompLow); mbCompLow.connect(mbTrimLow); mbTrimLow.connect(mbSum);
    mbMidLP.connect(mbCompMid); mbCompMid.connect(mbTrimMid); mbTrimMid.connect(mbSum);
    mbHighFilter.connect(mbCompHigh); mbCompHigh.connect(mbTrimHigh); mbTrimHigh.connect(mbSum);

    mbSum.connect(mbWet);
    mbDry.connect(mbOutput);
    mbWet.connect(mbOutput);

    // Main signal path from EQ, now passing through the (bypassable) multiband stage
    let effectsInput = mbOutput;

    // REVERB ROUTING (Parallel Wet/Dry)
    effectsInput.connect(reverbDry);
    effectsInput.connect(reverbNode);
    reverbNode.connect(reverbWet);
    reverbDry.connect(reverbGain);
    reverbWet.connect(reverbGain);

    // CHORUS ROUTING (Parallel Wet/Dry)
    let chorusInput = reverbGain;
    chorusInput.connect(chorusDry);
    chorusInput.connect(chorusDelay);
    chorusDelay.connect(chorusWet);
    chorusDry.connect(chorusGain);
    chorusWet.connect(chorusGain);

    // DELAY ROUTING (Parallel Wet/Dry)
    let delayInput = chorusGain;
    delayInput.connect(delayDry);
    delayInput.connect(delayNode);
    delayNode.connect(delayWet);
    delayDry.connect(delayGain);
    delayWet.connect(delayGain);

    // PHASER ROUTING (Serial through filters)
    let phaserInput = delayGain;
    phaserFilters.forEach((filter, i) => {
        if (i === 0) {
            phaserInput.connect(filter);
        } else {
            phaserFilters[i - 1].connect(filter);
        }
    });
    phaserFilters[phaserFilters.length - 1].connect(phaserGain);

    // =========================================================================
    // OUTPUT STAGE: True Stereo Widener (Mid/Side) <-> 8D Panner switch -> Auto-Leveler -> Limiter
    // -------------------------------------------------------------------------
    // Only one of {widener path, panner path} is audible at a time:
    //   - 8D Orbit ON  -> panner path (HRTF spatial motion; panner downmixes
    //                     to mono internally, so width isn't meaningful here)
    //   - 8D Orbit OFF -> widener path (genuine L/R mid-side processing)
    // Previously "Stereo Width" nudged the 3D panner's X position, which is
    // really a balance/pan effect, not stereo widening. This replaces that
    // with real mid/side encode -> width scale -> decode.
    // =========================================================================
    widenSplitter = audioCtx.createChannelSplitter(2);
    phaserGain.connect(widenSplitter);

    msLg = audioCtx.createGain(); msLg.gain.value = 0.5;      // L -> mid contribution
    msRg = audioCtx.createGain(); msRg.gain.value = 0.5;      // R -> mid contribution
    msLgS = audioCtx.createGain(); msLgS.gain.value = 0.5;    // L -> side contribution
    msRgSInv = audioCtx.createGain(); msRgSInv.gain.value = -0.5; // -R -> side contribution

    widenSplitter.connect(msLg, 0);
    widenSplitter.connect(msRg, 1);
    widenSplitter.connect(msLgS, 0);
    widenSplitter.connect(msRgSInv, 1);

    midSum = audioCtx.createGain(); midSum.gain.value = 1;
    sideSum = audioCtx.createGain(); sideSum.gain.value = 1;
    msLg.connect(midSum); msRg.connect(midSum);
    msLgS.connect(sideSum); msRgSInv.connect(sideSum);

    sideWidthGain = audioCtx.createGain(); sideWidthGain.gain.value = 1; // 0=mono .. 1=normal .. 2=extra wide
    sideSum.connect(sideWidthGain);

    sideInvForR = audioCtx.createGain(); sideInvForR.gain.value = -1;
    sideWidthGain.connect(sideInvForR);

    LoutSum = audioCtx.createGain(); LoutSum.gain.value = 1;
    RoutSum = audioCtx.createGain(); RoutSum.gain.value = 1;
    midSum.connect(LoutSum); sideWidthGain.connect(LoutSum);       // L' = mid + side
    midSum.connect(RoutSum); sideInvForR.connect(RoutSum);         // R' = mid - side

    stereoMerger = audioCtx.createChannelMerger(2);
    LoutSum.connect(stereoMerger, 0, 0);
    RoutSum.connect(stereoMerger, 0, 1);

    preLimiterSum = audioCtx.createGain(); preLimiterSum.gain.value = 1;

    widenerSwitch = audioCtx.createGain(); widenerSwitch.gain.value = 1; // audible by default (8D off)
    pannerSwitch = audioCtx.createGain(); pannerSwitch.gain.value = 0;   // muted by default

    stereoMerger.connect(widenerSwitch);
    widenerSwitch.connect(preLimiterSum);

    // Panner feed passes through the supplementary spatial cue chain first
    // (air absorption -> stylized doppler -> elevation shelf -> front/back).
    // See the big comment above these nodes' creation for what's real HRTF
    // vs. stylized cue.
    phaserGain.connect(airAbsorbFilter);
    airAbsorbFilter.connect(dopplerDelay);
    dopplerDelay.connect(elevShelfFilter);
    elevShelfFilter.connect(frontBackFilter);
    frontBackFilter.connect(panner);
    panner.connect(pannerSwitch);
    pannerSwitch.connect(preLimiterSum);

    // 3-tap early reflections (room ambience for externalization), active
    // only while 8D Orbit is on (spaceGain toggled in the message handler).
    phaserGain.connect(spaceDelay1);
    phaserGain.connect(spaceDelay2);
    phaserGain.connect(spaceDelay3);
    spaceDelay1.connect(spaceTapGain1); spaceTapGain1.connect(spaceReflectSum);
    spaceDelay2.connect(spaceTapGain2); spaceTapGain2.connect(spaceReflectSum);
    spaceDelay3.connect(spaceTapGain3); spaceTapGain3.connect(spaceReflectSum);
    spaceReflectSum.connect(spaceGain);
    spaceGain.connect(panner);

    // Small dedicated room-ambience send, reusing the Reverb effect's
    // convolver (built further up) at a fixed low level while 8D is active.
    phaserGain.connect(orbitReverbSend);
    orbitReverbSend.connect(reverbNode);
    reverbNode.connect(orbitReverbReturn);
    orbitReverbReturn.connect(preLimiterSum);

    // AUTO-LEVELER (RMS-based, not true LUFS — see README)
    autoGainNode = audioCtx.createGain(); autoGainNode.gain.value = 1;
    levelAnalyser = audioCtx.createAnalyser();
    levelAnalyser.fftSize = 1024;

    preLimiterSum.connect(autoGainNode);
    autoGainNode.connect(levelAnalyser); // tap for metering, doesn't affect audio path
    autoGainNode.connect(limiter);

    limiter.connect(analyzer);
    analyzer.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    // NOTE: Source connection is handled by updateEngineState() based on enabled state
    // This ensures proper routing whether extension is ONLINE or OFFLINE
}

function startOrbitTick() {
    if (orbitTimerId) return;
    orbitStartAudioTime = audioCtx.currentTime;
    lastOrbitDistance = null;
    lastOrbitTickTime = null;
    orbitTimerId = setInterval(orbitTick, 50); // 20Hz — cheap trig, smoothed via AudioParam ramps
    orbitTick(); // apply immediately instead of waiting 50ms for first frame
}

function stopOrbitTick() {
    if (orbitTimerId) {
        clearInterval(orbitTimerId);
        orbitTimerId = null;
        if (audioCtx) orbitAccumulatedTime += (audioCtx.currentTime - orbitStartAudioTime);
    }
    // Smoothly recenter so nothing is left mid-orbit when switching back to the widener path
    if (panner && audioCtx) {
        panner.positionX.setTargetAtTime(0, audioCtx.currentTime, 0.3);
        panner.positionY.setTargetAtTime(0, audioCtx.currentTime, 0.3);
        panner.positionZ.setTargetAtTime(-1, audioCtx.currentTime, 0.3);
    }
    if (elevShelfFilter && audioCtx) elevShelfFilter.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
    if (frontBackFilter && audioCtx) frontBackFilter.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
    if (airAbsorbFilter && audioCtx) airAbsorbFilter.frequency.setTargetAtTime(18000, audioCtx.currentTime, 0.3);
}

function orbitTick() {
    if (!audioCtx || !panner || !window.SonicLayerOrbit) return;

    const t = orbitAccumulatedTime + (audioCtx.currentTime - orbitStartAudioTime);
    const pos = window.SonicLayerOrbit.computePosition(t, orbitParams);
    const now = audioCtx.currentTime;
    const RAMP = 0.06; // slightly longer than the 50ms tick so ramps overlap smoothly, no zipper

    panner.positionX.setTargetAtTime(pos.x, now, RAMP);
    panner.positionY.setTargetAtTime(pos.y, now, RAMP);
    panner.positionZ.setTargetAtTime(pos.z, now, RAMP);

    // Air absorption: closer = brighter, farther = a bit darker. Stylized —
    // see the big comment where airAbsorbFilter is created.
    const freq = Math.max(2500, Math.min(18000, 18000 - pos.distance * 900));
    airAbsorbFilter.frequency.setTargetAtTime(freq, now, 0.15);

    // Elevation spectral cue: higher = a touch brighter, lower = a touch darker.
    const elevGainDb = Math.max(-4, Math.min(4, pos.y * 2.2));
    elevShelfFilter.gain.setTargetAtTime(elevGainDb, now, 0.15);

    // Front/back spectral cue: sounds from behind (z > 0, see orbit-math.js's
    // coordinate convention) lose a little presence-band energy, the way a
    // real outer ear partially shadows rearward sound.
    const frontBackDb = Math.max(-3, Math.min(3, -pos.z * 1.4));
    frontBackFilter.gain.setTargetAtTime(frontBackDb, now, 0.15);

    // Stylized Doppler: tiny delay-time modulation proportional to radial
    // velocity (distance change per tick). See the big comment above.
    if (lastOrbitDistance !== null && lastOrbitTickTime !== null) {
        const dt = t - lastOrbitTickTime;
        if (dt > 0) {
            const velocity = (pos.distance - lastOrbitDistance) / dt; // units/sec
            const delayTime = Math.max(0.0005, Math.min(0.008, 0.003 + velocity * 0.0004));
            dopplerDelay.delayTime.setTargetAtTime(delayTime, now, 0.1);
        }
    }
    lastOrbitDistance = pos.distance;
    lastOrbitTickTime = t;
}


function startAutoLevelLoop() {
    if (autoLevelTimer) return;
    autoLevelTimer = setInterval(() => {
        if (!autoLevelEnabled || !levelAnalyser || !autoGainNode || !audioCtx) return;
        const buf = new Float32Array(levelAnalyser.fftSize);
        levelAnalyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);
        if (rms < 0.0001) return; // silence — don't chase noise floor
        const currentDb = 20 * Math.log10(rms);
        const errorDb = autoLevelTargetDb - currentDb;
        const clampedErrorDb = Math.max(-12, Math.min(12, errorDb));
        const targetLinearGain = Math.pow(10, clampedErrorDb / 20);
        autoGainNode.gain.setTargetAtTime(targetLinearGain, audioCtx.currentTime, 1.5);
    }, 150);
}

function stopAutoLevelLoop() {
    if (autoLevelTimer) { clearInterval(autoLevelTimer); autoLevelTimer = null; }
    if (autoGainNode && audioCtx) autoGainNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.5);
}

function updateEngineState(enabled) {
    if (!source || !gainNode || !bassNode) return;

    try {
        source.disconnect();

        if (enabled) {
            source.connect(bassNode);
            if (currentVideo) {
                currentVideo.style.border = "2px solid #00f2ff";
                currentVideo.style.boxShadow = "0 0 20px rgba(0, 242, 255, 0.3)";
            }
        } else {
            source.connect(audioCtx.destination);
            if (currentVideo) {
                currentVideo.style.border = "none";
                currentVideo.style.boxShadow = "none";
            }
        }
    } catch (e) { console.error("SonicLayer: Routing Error", e); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'RESET') {
        stopAutoLevelLoop();
        autoLevelEnabled = false;
        if (orbitTimerId) { clearInterval(orbitTimerId); orbitTimerId = null; }
        orbitEnabled = false;
        orbitAccumulatedTime = 0;
        lastOrbitDistance = null;
        lastOrbitTickTime = null;
        if (audioCtx) {
            audioCtx.close().then(() => {
                audioCtx = null;
                source = null;
                analyzer = null;
                gainNode = null;
                panner = null;
                limiter = null;
                bassNode = null;
                eqNodes = [];
                spaceDelay1 = spaceDelay2 = spaceDelay3 = null;
                spaceTapGain1 = spaceTapGain2 = spaceTapGain3 = spaceReflectSum = null;
                spaceGain = null;
                airAbsorbFilter = dopplerDelay = elevShelfFilter = frontBackFilter = null;
                orbitReverbSend = orbitReverbReturn = null;
                reverbNode = reverbGain = reverbWet = reverbDry = null;
                chorusDelay = chorusLFO = chorusGain = chorusDepthGain = chorusWet = chorusDry = null;
                delayNode = delayFeedback = delayGain = delayWet = delayDry = null;
                phaserFilters = [];
                phaserLFO = phaserDepthGain = phaserGain = null;
                mbLowFilter = mbMidHP = mbMidLP = mbHighFilter = null;
                mbCompLow = mbCompMid = mbCompHigh = null;
                mbTrimLow = mbTrimMid = mbTrimHigh = null;
                mbSum = mbDry = mbWet = mbOutput = null;
                widenSplitter = msLg = msRg = msLgS = msRgSInv = midSum = sideSum = null;
                sideWidthGain = sideInvForR = LoutSum = RoutSum = stereoMerger = null;
                widenerSwitch = pannerSwitch = preLimiterSum = null;
                autoGainNode = levelAnalyser = null;
                currentVideo = null;
                isEngineInitialized = false;
                attemptInit();
            }).catch(err => console.warn("SonicLayer: reset error", err));
        }
        return;
    }

    if (msg.type === 'SET_AUDIO') {
        if (!isEngineInitialized) attemptInit();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();

        updateEngineState(msg.enabled);

        if (!msg.enabled) {
            if (orbitEnabled) { orbitEnabled = false; stopOrbitTick(); }
            return;
        }

        // Apply EQ
        if (eqNodes.length > 0) {
            msg.eq.forEach((v, i) => { if (eqNodes[i]) eqNodes[i].gain.value = parseFloat(v); });
            if (eqNodes[6]) eqNodes[6].gain.value = parseFloat(msg.eq[6]) + parseFloat(msg.voice);
            if (eqNodes[7]) eqNodes[7].gain.value = parseFloat(msg.eq[7]) + parseFloat(msg.voice);
        }

        // Apply Params
        if (bassNode) bassNode.gain.value = parseFloat(msg.bass || 0);

        if (gainNode) gainNode.gain.value = parseFloat(msg.gain || 1);

        // 8D Orbit <-> Stereo Widener switch
        if (msg.eightD) {
            // Partial (not full) mute of the widener path: true binaural HRTF
            // is not mono-safe by nature (ITD is a phase difference, which
            // combs on mono sum — Dolby Atmos for Headphones and Waves Nx
            // have the same property). Keeping ~15% of the direct stereo
            // signal underneath softens that without undoing the spatial
            // effect.
            if (pannerSwitch) pannerSwitch.gain.setTargetAtTime(1, audioCtx.currentTime, 0.3);
            if (widenerSwitch) widenerSwitch.gain.setTargetAtTime(0.15, audioCtx.currentTime, 0.3);
            if (spaceGain) spaceGain.gain.setTargetAtTime(0.3, audioCtx.currentTime, 1);
            if (orbitReverbSend) orbitReverbSend.gain.setTargetAtTime(0.12, audioCtx.currentTime, 1);

            orbitParams.mode = msg.orbit && msg.orbit.mode || 'circle';
            orbitParams.speed = parseFloat((msg.orbit && msg.orbit.speed) || 1);
            orbitParams.radius = parseFloat((msg.orbit && msg.orbit.radius) || 3);
            orbitParams.elevation = parseFloat((msg.orbit && msg.orbit.elevation) || 0);
            orbitParams.depth = parseFloat((msg.orbit && msg.orbit.depth) || 1);
            orbitParams.randomness = parseFloat((msg.orbit && msg.orbit.randomness) || 0);
            orbitParams.manualAz = parseFloat((msg.orbit && msg.orbit.manualAz) || 0);
            orbitParams.manualEl = parseFloat((msg.orbit && msg.orbit.manualEl) || 0);
            orbitParams.manualDist = parseFloat((msg.orbit && msg.orbit.manualDist) || 3);

            if (!orbitEnabled) { orbitEnabled = true; startOrbitTick(); }
        } else {
            if (pannerSwitch) pannerSwitch.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
            if (widenerSwitch) widenerSwitch.gain.setTargetAtTime(1, audioCtx.currentTime, 0.3);
            if (spaceGain) spaceGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.5);
            if (orbitReverbSend) orbitReverbSend.gain.setTargetAtTime(0, audioCtx.currentTime, 0.5);

            if (orbitEnabled) { orbitEnabled = false; stopOrbitTick(); }

            // True stereo width: -1 (mono) .. 0 (natural) .. 1 (extra wide)
            const w = parseFloat(msg.width || 0);
            const widthMultiplier = Math.max(0, 1 + w); // 0..2
            if (sideWidthGain) sideWidthGain.gain.setTargetAtTime(widthMultiplier, audioCtx.currentTime, 0.1);
        }

        // =====================================================================
        // MASTERING: Multiband Compressor + Auto-Leveler
        // =====================================================================
        if (msg.mastering) {
            const m = msg.mastering;

            if (m.compressor) {
                const enabled = !!m.compressor.enabled;
                const amount = parseFloat(m.compressor.amount || 0); // 0-100
                // Map "Amount" to threshold/ratio; 0 = barely engaged, 100 = heavy
                const threshold = enabled ? (-8 - amount * 0.32) : -24; // -8dB .. -40dB
                const ratio = enabled ? (1.5 + amount * 0.085) : 3;     // 1.5:1 .. 10:1
                [mbCompLow, mbCompMid, mbCompHigh].forEach(c => {
                    if (!c) return;
                    c.threshold.setTargetAtTime(threshold, audioCtx.currentTime, 0.1);
                    c.ratio.setTargetAtTime(ratio, audioCtx.currentTime, 0.1);
                });
                if (mbTrimLow) mbTrimLow.gain.setTargetAtTime(dbToLinear(parseFloat(m.compressor.trimLow || 0)), audioCtx.currentTime, 0.1);
                if (mbTrimMid) mbTrimMid.gain.setTargetAtTime(dbToLinear(parseFloat(m.compressor.trimMid || 0)), audioCtx.currentTime, 0.1);
                if (mbTrimHigh) mbTrimHigh.gain.setTargetAtTime(dbToLinear(parseFloat(m.compressor.trimHigh || 0)), audioCtx.currentTime, 0.1);

                if (mbWet && mbDry) {
                    mbWet.gain.setTargetAtTime(enabled ? 1 : 0, audioCtx.currentTime, 0.1);
                    mbDry.gain.setTargetAtTime(enabled ? 0 : 1, audioCtx.currentTime, 0.1);
                }
            }

            if (m.autoLevel) {
                autoLevelEnabled = !!m.autoLevel.enabled;
                autoLevelTargetDb = parseFloat(m.autoLevel.target || -18);
                if (autoLevelEnabled) startAutoLevelLoop();
                else stopAutoLevelLoop();
            }
        }

        // =====================================================================
        // ADVANCED EFFECTS PARAMETERS
        // =====================================================================

        // REVERB
        if (msg.reverb) {
            if (reverbWet && reverbDry) {
                if (msg.reverb.enabled) {
                    const mix = parseFloat(msg.reverb.mix) / 100;
                    reverbWet.gain.setTargetAtTime(mix, audioCtx.currentTime, 0.1);
                    reverbDry.gain.setTargetAtTime(1 - mix, audioCtx.currentTime, 0.1);

                    // Regenerate impulse response if size/decay changed
                    const size = parseFloat(msg.reverb.size) / 50; // 0-2 range
                    const decay = parseFloat(msg.reverb.decay);

                    function createImpulseResponse(duration, decay) {
                        const sampleRate = audioCtx.sampleRate;
                        const length = sampleRate * duration;
                        const impulse = audioCtx.createBuffer(2, length, sampleRate);
                        const left = impulse.getChannelData(0);
                        const right = impulse.getChannelData(1);
                        for (let i = 0; i < length; i++) {
                            const n = i / sampleRate;
                            left[i] = (Math.random() * 2 - 1) * Math.exp(-n / decay);
                            right[i] = (Math.random() * 2 - 1) * Math.exp(-n / decay);
                        }
                        return impulse;
                    }

                    if (reverbNode) {
                        reverbNode.buffer = createImpulseResponse(size, decay);
                    }
                } else {
                    reverbWet.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
                    reverbDry.gain.setTargetAtTime(1, audioCtx.currentTime, 0.1);
                }
            }
        }

        // CHORUS
        if (msg.chorus) {
            if (chorusLFO && chorusDepthGain && chorusWet && chorusDry) {
                if (msg.chorus.enabled) {
                    const rate = parseFloat(msg.chorus.rate);
                    const depth = parseFloat(msg.chorus.depth) / 1000; // ms to seconds
                    const mix = parseFloat(msg.chorus.mix) / 100;

                    chorusLFO.frequency.setTargetAtTime(rate, audioCtx.currentTime, 0.1);
                    chorusDepthGain.gain.setTargetAtTime(depth, audioCtx.currentTime, 0.1);
                    chorusWet.gain.setTargetAtTime(mix, audioCtx.currentTime, 0.1);
                    chorusDry.gain.setTargetAtTime(1 - mix, audioCtx.currentTime, 0.1);
                } else {
                    chorusDepthGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
                    chorusWet.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
                    chorusDry.gain.setTargetAtTime(1, audioCtx.currentTime, 0.1);
                }
            }
        }

        // DELAY
        if (msg.delay) {
            if (delayNode && delayFeedback && delayWet && delayDry) {
                if (msg.delay.enabled) {
                    const time = parseFloat(msg.delay.time) / 1000; // ms to seconds
                    const feedback = parseFloat(msg.delay.feedback) / 100;
                    const mix = parseFloat(msg.delay.mix) / 100;

                    delayNode.delayTime.setTargetAtTime(time, audioCtx.currentTime, 0.1);
                    delayFeedback.gain.setTargetAtTime(feedback, audioCtx.currentTime, 0.1);
                    delayWet.gain.setTargetAtTime(mix, audioCtx.currentTime, 0.1);
                    delayDry.gain.setTargetAtTime(1 - mix, audioCtx.currentTime, 0.1);
                } else {
                    delayFeedback.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
                    delayWet.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
                    delayDry.gain.setTargetAtTime(1, audioCtx.currentTime, 0.1);
                }
            }
        }

        // PHASER
        if (msg.phaser) {
            if (phaserLFO && phaserDepthGain && phaserFilters.length > 0) {
                if (msg.phaser.enabled) {
                    const rate = parseFloat(msg.phaser.rate);
                    const depth = parseFloat(msg.phaser.depth) * 10; // 0-1000 Hz range
                    const freq = parseFloat(msg.phaser.freq);

                    phaserLFO.frequency.setTargetAtTime(rate, audioCtx.currentTime, 0.1);
                    phaserDepthGain.gain.setTargetAtTime(depth, audioCtx.currentTime, 0.1);

                    // Update center frequency for all filters
                    phaserFilters.forEach(filter => {
                        filter.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.1);
                    });
                } else {
                    phaserDepthGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
                }
            }
        }

        if (limiter) limiter.threshold.value = parseFloat(msg.limit || -10);
    }

    if (msg.type === 'GET_VIZ') {
        if (!analyzer) return sendResponse({ data: [] });
        const data = new Uint8Array(analyzer.frequencyBinCount);
        analyzer.getByteFrequencyData(data);
        sendResponse({ data: Array.from(data.slice(0, 130)) });
    }
    return true;
});