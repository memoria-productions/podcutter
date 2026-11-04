# PodCutter

An open, offline, AutoPod-style multicam editor for Adobe Premiere Pro, plus transcript-based cleanup.

- **Multicam:** reads each speaker's mic waveform and switches between camera tracks to follow the conversation. It handles bleed, crosstalk, interjections and reaction shots, cutaways during long monologues, angle rotation, pacing presets, per-speaker priority, and manual locks. It previews live in the panel, then builds the cut on a duplicate sequence.
- **Cleanup:** transcribes offline with a bundled whisper.cpp, or loads SRT/VTT/TXT, then flags production breakdowns (talk about the show instead of the topic, from the first signal to the clean restart), producer or internal talk, "cut that" / "start over" / off-the-record / false starts, dead handoffs and self-corrections, as red range markers and an edit report.
- **Self-contained:** the Windows build ships ffmpeg, whisper.cpp, and the models. There's no internet, no Python, and no local AI service.

Users: see **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)**. Plans: see [ROADMAP.md](ROADMAP.md).

## Layout

```
CSXS/manifest.xml        CEP extension manifest (Premiere 2022+)
host/host.jsx            ExtendScript: read sequence, markers, duplicate, razor, enable/disable
client/                  Panel UI (index.html, panel.js, viz.js, ui-config.js, demo.js)
engine/director.js       Cutting engine (pure JS, no deps), the heart of it
engine/analyzer.js       ffmpeg -> per-track loudness curves (dB/25 ms), disk-cached
engine/motion.js         ffmpeg -> camera-motion curves (pan/tilt/dolly/zoom, subject motion rejected)
engine/transcriber.js    Timeline mix -> whisper.cpp (word timestamps + Silero VAD)
engine/transcript.js     Transcript parsing + breakdowns, leaks, cut cues, restarts, small trims
cli/podcutter.js       Offline tuning: plan / compare presets / cleanup
tests/                   node:test suites (engine, analyzer+ffmpeg, transcript)
install/                 Windows installer (per-user, sets PlayerDebugMode)
scripts/                 fetch-vendor.sh, package-windows.sh
vendor/                  (not in git) bundled ffmpeg / whisper / models
```

## How the cutting engine decides

1. **Calibrate** each mic: noise floor (10th percentile) and speech level (98th percentile). A mic that only ever hears bleed is referenced against the loudest mic, so the bleed never looks like speech.
2. **Detect:** a mic is "talking" when it's above its threshold *and* within `crosstalkWindowDb` of the loudest normalized mic (bleed rejection). Speaker priority (`biasDb`) is added here.
3. **Smooth:** bridge gaps under `holdSec` and drop blips under `attackSec`.
4. **Classify:** short bursts while someone else holds the floor are **interjections**. Everything else is a turn.
5. **Floor model:** solo, group, or silence segments. Overlaps shorter than `crosstalkMinSec` go to whoever already had the floor. Silence holds the shot, then goes wide after `wideAfterSilenceSec`. Turns shorter than `reactionDelaySec` don't trigger a switch.
6. **Shots:** a solo segment goes to that speaker's close-up (rotating between angles if they have several). A group goes to the smallest camera that shows everyone talking, i.e. a two-shot before the wide.
7. **Reactions:** interjections become reaction shots, with probability, spacing, and per-speaker switches.
8. **Cutaways:** shots longer than `maxShotSec` get a wide, listener, or alternate angle, placed at the quietest moment near evenly spaced targets.
9. **Timing:** speech-onset cuts shift by `cutTimingSec`. Optionally opens on the wide.
9b. **Moving cameras:** each moving camera's motion curve is median-filtered and classed as steady, slow, or fast. A cut to it waits (holding the previous shot, up to `maxWaitSec`) until it has been steady for `settleSec`. Fast moves, and slow ones if `slowMovesOnAir` is off, are replaced by the wide or another static angle. Minimum-shot cleanup never puts a moving camera back on air.
10. **Cleanup:** shortest-first minimum-shot absorption, manual locks, frame snapping.

## Develop

```bash
npm test                                   # 30 tests; media tests need ffmpeg on PATH
open client/index.html                     # panel runs in a browser in demo mode
node cli/podcutter.js presets
node cli/podcutter.js plan "Episode.podcutter.json" --compare calm,balanced,lively
node cli/podcutter.js plan "Episode.podcutter.json" --preset lively --set minShotSec=2.5 --set biasDb.Host=3 --out tuned.json
node cli/podcutter.js cleanup transcript.srt --csv cuts.csv
bash scripts/fetch-vendor.sh               # MODEL=small.en for higher accuracy
bash scripts/package-windows.sh            # -> dist/PodCutter-x.y.z-Windows.zip
```

Load the unpacked extension during development by copying (or symlinking) this folder into `%APPDATA%\Adobe\CEP\extensions\PodCutter` and running `install.ps1` once to enable `PlayerDebugMode`.

## Releases (GitHub Actions)

Every push runs the tests. Every push to `main` also builds the Windows zip, installs it on a real Windows runner, and runs `scripts/smoke-test.js` against the bundled ffmpeg and whisper. Pushing a tag publishes a GitHub Release with the installer attached:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Share this link for the newest installer: https://github.com/memoria-productions/podcutter/releases/latest

## Tuning with Claude

In the panel, click **Export analysis for Claude**. That writes `Documents\PodCutter\<sequence>.podcutter.json`, which contains downsampled mic curves, your config, calibration, stats, and the shot list. Claude can run the CLI against that file to compare styles, then write a tuned config that you load back in with **Settings → Import settings JSON**.

MIT licensed. See THIRD_PARTY_NOTICES.md for bundled components and credits (Podclip, Cutcast).
