# PodCutter: notes for Claude Code

PodCutter is an AutoPod-style Premiere Pro panel (CEP, Windows). It does multicam cutting from mic waveforms and transcript cleanup, all offline. ffmpeg and whisper.cpp are bundled at packaging time.

The user is David Ward (Memoria Press, podcast "Classical et cetera"). Fuller status, user guide and roadmap live in the claude.ai project "AutoPod-Clone" (`claude/PodDirector-*.md`), and in `docs/USER_GUIDE.md` and `ROADMAP.md` here.

**Renamed from PodDirector in 0.18.** The user-facing name is PodCutter everywhere. These stay as they were, on purpose:
- The extension ID `com.poddirector.panel`, which keeps the panel's saved settings (localStorage).
- The `PD.*` host namespace, `PD_UI`, and the `pd.` storage keys.
- The `[PD]` marker prefixes, so Clear markers finds old ones.
- The temp cache folder names and the `poddirector-setup` file kind.
- The GitHub repo `memoria-productions/poddirector` (`updater.DEFAULT_REPO`), and the local folder `#poddirector`.

Upgrading from the old name:
- Releases 0.18.0–0.21.1 also attached the package as `PodDirector-…zip` for pre-rename updaters. From 0.21.2 only `PodCutter-…zip` is attached; a panel still on 0.17 or older must be installed by hand. The updater still accepts either name.
- `install.ps1` removes the old `extensions\PodDirector` folder.
- The panel copies `Documents\PodDirector` to `Documents\PodCutter` once, skipping the research data in `edits`, `motion` and `compare`.
## Layout
- `engine/` pure JS, used by both the panel and Node. Exports work in both:
  - `director.js` — the cutting engine (`plan`, `planRange`, `toEditPayload`, presets, `VERSION`);
  - `analyzer.js` — ffmpeg waveform curves;
  - `motion.js` — camera motion and thumbnails;
  - `framing.js` — who's in the shot;
  - `transcript.js` — cleanup cues;
  - `transcriber.js` — whisper;
  - `updater.js`.
- `host/host.jsx`: ExtendScript, ES3 only (no `let`, arrow functions or `JSON` builtins; a polyfill is included). Exposes `PD.*` functions. It uses QE `razor` for cuts and `clip.disabled` for camera switching.
- `client/`: the panel UI (`index.html`, `panel.js`, `ui-config.js`, `viz.js`, `demo.js` for browser testing without Premiere).
- `cli/podcutter.js`: offline tuning. `plan` replays an exported analysis (`*.podcutter.json`, from Multicam > "Export analysis for Claude") with presets or `--set` overrides; `cleanup` scans a transcript.
- `tests/`: `node --test tests/*.test.js`. `host.test.js` runs host.jsx against a fake Premiere. Fixture `tests/fixtures/ce244.txt` is a real episode transcript (Premiere TXT export).
- `install/`: `install.ps1` and the .bat launchers. `scripts/` covers vendor fetch, packaging, and the Windows smoke/update tests used in CI.

## Conventions
- **Version bump:** `engine/director.js` (`VERSION`), `package.json`, and `CSXS/manifest.xml` (2 places), all together.
- **Before committing:** run `npm test`. For UI changes, open `client/index.html` in a browser (demo mode) and check for console errors.
- **Releases:** push to `main`, then `git tag vX.Y.Z` and `git push origin vX.Y.Z`. CI (`.github/workflows/build.yml`) tests, packages `PodCutter-X.Y.Z-Windows.zip`, smoke-tests it on Windows, and creates the GitHub release. The in-panel updater reads those releases.
- **Tags:** only tag the commit whose version matches the tag. If a tag lands on the wrong commit, delete the GitHub release first, then the tag (local and remote), then re-tag.
- **Docs:** user-facing changes get a line in `docs/USER_GUIDE.md` and `ROADMAP.md`.
- **Line endings:** `.bat` files must stay CRLF (see `.gitattributes`).

## The user's show setup
- **Sequences:** the episode sequence is nested into a master between the intro and outro. PodCutter runs on the inner sequence, with In/Out marks around the conversation.
- **Cameras:**
  - V1 is the static wide, with the movement check off. It is the bottom track: the layered cut (v0.6.0) never razors it.
  - V2 is the operated dolly/solo cam, with "Check for movement" and "Follows speaker" on.
- **Mics:** VOX1–VOX4 (Martin, Tanya, Jessica, Paul) are channels 1–4 of one camera file. A7 is sfx.
- **Style feedback so far:**
  - fewer cuts overall, which led to "Max cuts / min";
  - longer wides, which led to "Minimum wide", 5 s by default;
  - a camera change across removed sections;
  - the dolly is only used when it's on whoever is talking.
