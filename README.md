# Ink cloud

A million ink particles on paper, breathing with the music. Three.js + WebGL2, GPGPU simulation, Vite + TypeScript.

```
bun install
bun run dev        # http://localhost:5190
bun run build      # dist/
```

## How it works

| Module | What it does |
| --- | --- |
| `src/sim/ParticleSim.ts` | Positions and velocities live in two float textures, updated in one multi-target fragment pass. Particles are emitted from points in the core and trace streaklines through a curl-noise flow. |
| `src/sim/noise.glsl.ts` | Simplex noise with analytic gradient; curl of three fields gives a divergence-free flow. |
| `src/render/InkRenderer.ts` | Particles accumulate ink density into a float target with additive blending, then density becomes darkness with `1 - exp(-density * k)` on a warm paper tone, plus vignette and grain. Depth of field is per-particle sprite size with conserved ink. |
| `src/audio/AudioEngine.ts` | One AnalyserNode; sources: streamed MP3 URL, another tab's audio (screen-capture API, nothing downloaded), a local file, the microphone. |
| `src/audio/BeatDetector.ts` | Spectral flux on 40 to 150 Hz, adaptive threshold (mean + k·std), refractory period; manual BPM clock fallback; attack/release envelope. |
| `src/controls/Overlay.ts` | Glass UI (amazing-glass web components): click-to-play gate, floating toolbar, settings panel. `H` hides everything, `Space` pauses. |
| `src/controls/DebugPanel.ts` | lil-gui bound to `src/params.ts`. |

## Audio sources

- **Stream**: a Creative Commons track from archive.org by default (MonoChromatic, "Immobility", CC BY-NC-SA). Any MP3 URL with CORS headers works.
- **Tab audio**: play "Lumen Chamber" by Deescawa on YouTube in another tab, then pick that tab and tick "Share tab audio". The visuals react live; nothing is downloaded or re-hosted.
- **File** and **Mic**.
- **Silent**: manual BPM clock drives the beat.

## URL flags (useful for testing)

`?autostart=1` skips the gate (silent), `?autostart=stream` starts the default stream (needs Chrome `--autoplay-policy=no-user-gesture-required`), `?bpm=120` manual clock, `?tex=512` particle texture side, `?panel=0` hides settings, `?hud=0` hides the whole interface, `?p.<param>=<value>` presets any tunable from `src/params.ts`, `?bench=<name>&debug=1` prints GPU pass times and beat stats and, in dev, posts a screenshot to `.bench/<name>.png`.

## Performance notes

Measured on an Intel Arc iGPU (Meteor Lake) at 1629x2007 device pixels with GPU timer queries: simulation ~5 ms, stroke pre-pass ~2 ms, strokes ~13 ms, composite ~0.5 ms at 1M particles; ~16 ms total at 262k. The stroke pass is bound by vertex invocations, so the adaptive mode lowers the internal render scale first and then the particle count. The glass toolbar costs about 9 ms per frame on this GPU because Chromium re-renders its backdrop filter every frame; press `H` to hide the interface when you want every frame for the ink.
