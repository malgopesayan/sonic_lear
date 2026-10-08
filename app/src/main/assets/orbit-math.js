// SonicLayer orbit math — shared by content.js (drives the real PannerNode)
// and popup.js (drives the visual indicator). Kept in one file so audio and
// visual can never drift out of sync with each other.
//
// Coordinate convention matches the Web Audio API's default listener
// orientation (facing -Z): negative Z = in front of the listener,
// positive Z = behind. This lets us reuse Z's sign as a legitimate
// front/back cue elsewhere (see content.js's frontBackFilter).
(function (global) {
    const TWO_PI = Math.PI * 2;
    const BASE_FREQ = 0.05; // Hz, orbit frequency at speed = 1x

    // Three fixed, non-commensurate frequencies (no common period) used to
    // build smooth pseudo-random wander. This is NOT true randomness — it's
    // a deterministic sum of slow sine waves that never repeats on any
    // human-noticeable timescale and never jumps or clicks. A real RNG-driven
    // (e.g. Perlin noise) generator would need an AudioWorklet; this gets
    // ~95% of the perceptual effect at a fraction of the complexity and CPU.
    const JITTER_FREQS = [0.017, 0.029, 0.043];

    function jitterAxis(t, speed, freqIdxA, freqIdxB, phase) {
        const f0 = JITTER_FREQS[freqIdxA] * speed;
        const f1 = JITTER_FREQS[freqIdxB] * speed;
        return 0.6 * Math.sin(TWO_PI * f0 * t) + 0.4 * Math.sin(TWO_PI * f1 * t + (phase || 0));
    }

    // params: { mode, speed, radius, elevation, depth, randomness,
    //           manualAz, manualEl, manualDist }
    // Returns { x, y, z, distance } in "room units" (roughly meters for
    // panner distance-model purposes).
    function computePosition(t, params) {
        const p = params || {};
        const mode = p.mode || 'circle';
        const speed = p.speed != null ? p.speed : 1;
        const radius = p.radius != null ? p.radius : 3;
        const elevationBase = p.elevation != null ? p.elevation : 0;
        const depth = p.depth != null ? p.depth : 1;
        const randomness = (p.randomness != null ? p.randomness : 0) / 100;

        if (mode === 'manual') {
            const az = (p.manualAz || 0) * Math.PI / 180;
            const el = (p.manualEl || 0) * Math.PI / 180;
            const dist = p.manualDist != null ? p.manualDist : 3;
            const x = dist * Math.sin(az) * Math.cos(el);
            const z = -dist * Math.cos(az) * Math.cos(el);
            const y = dist * Math.sin(el);
            return { x: x, y: y, z: z, distance: dist };
        }

        const theta = TWO_PI * BASE_FREQ * speed * t;
        let x = 0, z = 0;

        if (mode === 'figure8') {
            x = radius * Math.sin(theta);
            z = (radius * depth * 0.5) * Math.sin(2 * theta);
        } else if (mode === 'spiral') {
            const rMod = radius * (1 + 0.4 * Math.sin(TWO_PI * 0.012 * speed * t));
            x = rMod * Math.sin(theta);
            z = rMod * Math.cos(theta) * depth;
        } else if (mode === 'random') {
            x = jitterAxis(t, speed, 0, 1, 0) * radius;
            z = jitterAxis(t, speed, 1, 2, 1.7) * radius * depth;
        } else {
            // 'circle' (default / fallback for unknown modes)
            x = radius * Math.sin(theta);
            z = radius * Math.cos(theta) * depth;
        }

        // Gentle elevation "bob" for realism on every orbiting mode.
        let y = elevationBase + Math.sin(TWO_PI * (BASE_FREQ * speed / 3) * t) * 0.6;

        // Layered randomness jitter on top of any oscillating mode
        // (Random Smooth mode is already jitter-driven, so skip doubling up).
        if (randomness > 0 && mode !== 'random') {
            x += jitterAxis(t, speed, 0, 1, 0) * radius * 0.35 * randomness;
            z += jitterAxis(t, speed, 1, 2, 1.7) * radius * depth * 0.35 * randomness;
            y += jitterAxis(t, speed, 2, 0, 0.9) * 0.8 * randomness;
        }

        const distance = Math.sqrt(x * x + y * y + z * z) || 0.001;
        return { x: x, y: y, z: z, distance: distance };
    }

    global.SonicLayerOrbit = { computePosition: computePosition };
})(typeof window !== 'undefined' ? window : this);
