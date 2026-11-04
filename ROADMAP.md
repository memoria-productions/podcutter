# PodCutter roadmap

## Now (v0.1, Windows)

- Multicam cutting engine with per-speaker and style tuning, a live preview, locks, markers, and a build-on-copy step
- Offline transcription (bundled whisper.cpp) and transcript cleanup suggestions
- Self-contained Windows installer with no admin rights, no internet, and no separately installed AI runtime

## v0.2 (added)

- **Moving cameras:** a camera-motion analyzer (block matching plus a robust global-motion fit, so people moving in frame don't count). Cuts to a dolly or operated camera only once it has settled, waits briefly or goes to the wide during moves, and can keep slow push-ins on air.
- **Follows-speaker cameras:** an operated camera that counts as a close-up of whoever is talking.

## v0.3 (added)

- **Show setups:** built-in setups for 1, 2, 3, and 4+ subjects, plus saved setups matched by track name and applied automatically. VOX-named tracks are preferred as speaker mics.
- Trash icon with confirmation for speakers, cameras, and saved setups.
- **In-panel updater:** checks GitHub releases or a shared update folder, then installs silently.

## v0.3.2 – v0.4 (added)

- Mics that share one multichannel file get one channel per speaker, decided per clip.
- Analyze and cut only between the sequence In/Out marks.
- **Recut** the existing copy in place (keeps nests) and **Undo recut** (last 5 versions).
- Cleanup flags phone and alarm interruptions, including Whisper sound tags.

## v0.5 (added)

- **Who's in the shot** for operated cameras: steady stretches grouped by appearance and named from the audio, editable thumbnails, so the follow cam is used only when it's on the person talking (and can be a reaction shot when it's on a listener).
- Cut away from any camera movement by default (slow moves on air is now opt-in).
- **Max cuts / min** cap (drops the least important cuts first) and a "Shots by reason" breakdown under the preview.
- **Minimum wide**: wide shots run at least 5 s by default.
- Cleanup follows an abandoned tangent from the cut cue to "okay, we're back", and flags pre-show and post-show chatter (v0.5.4).
- The welcome address with the show's name marks the start of the show, with one-click In/Out points (v0.5.5).

## v0.6 (added)

- **Layered cut:** the bottom camera (the wide) stays whole and enabled; only the cameras above it are razored, where they switch. About half the edits with two cameras, and recut cleans up older full cuts.

## v0.7 (added)

- **Simpler cutting style:** the main controls up front (mode, Max cuts / min, Minimum close-up, Minimum wide) and everything else under a collapsible **Advanced** section.
- **Mic confidence:** a collapsible meter per speaker under the preview (level, bleed, borderline and possibly missed speech, weak stretches), with tips.
- **The bottom camera is the wide:** a scan sets it up as the wide, and it's always kept whole. The switch moved to Advanced → Timeline.
- **Content cut warning:** after a scan, flags sections between content cuts in the wide's footage that are shorter than the minimum, under Minimum wide and on the Cleanup tab.
- **Static cameras:** a Static option per camera (works alongside Check for movement).
- **Modes:** new Rapid cutting (once cameras are marked Static, warns if anyone lacks a static close-up) and Interview; presets renamed as modes, each with a description.
- **Close-ups / wide slider:** leans the whole cut toward the speaker close-ups or the static wide (some turns play on the wide).
- **Feature slider per person** (replaces Priority): more screen time for a special guest.

## v0.8 (added)

- **Introduction:** finds the welcome, the host and everyone introduced in the transcript; the cut opens on the host's solo cam, then the wide for the introductions; lower-third name markers with editable name-tag text.
- **Reload instead of restart:** after an update, Reload PodCutter loads the new version in place; Premiere only needs restarting when the manifest changed.

- **Hidden camera tracks (v0.8.1):** Build and Recut turn on track output (the eye) for the camera tracks they cut; the scan notes hidden ones.

- **Multicam by keystrokes, trial (v0.8.2):** reads the Cut to Camera shortcuts from Premiere's .kys file and presses them on a multicam clip (Settings > Multicam by keystrokes), as a first test of cutting real multicam sequences. v0.8.3 finds the shortcuts in a redirected Documents folder, accepts a nest with Multi-Camera enabled, and logs each step.

## v0.9 (added)

- **Build as multicam (experimental):** applies the planned cut to a Multi-Camera nest by pressing Cut to Camera at each angle change (angle = the camera's original track), with progress, Stop, Resume, and a count of the pieces afterwards to check every cut landed. v0.9.1: an option to build only between the multicam sequence's In and Out marks.

## v0.10 (added)

- **In/Out followed live:** waveforms and camera movement are analyzed for the whole sequence once; moving the In/Out marks in Premiere re-plans the preview and cut straight away.
- **Build as multicam skips uncovered stretches** (no multicam footage at the ends or in a gap) instead of refusing.

## v0.11 (added)

- **Reads inside multicam nests:** a nested/multicam sequence's angles become camera tracks mapped onto the timeline, so movement and framing analysis still see the dolly; one click moves a saved setup onto the angles.
- **Camera 2 shots labelled Rose** after any build (option, on by default).

## v0.12 (added)

- **No more silent "steady":** a moving camera with no footage to measure is flagged (red warning, builds refuse) instead of being treated as steady; a sequence whose cameras moved into a nest switches to the nest's angles at Scan.
- **Mark camera moves:** timeline markers over every detected move (red big, orange slow).

## v0.13 (added)

- **The wide is the safety:** after a move, back to the dolly only if it then stays steady (Come back after, 3 s); banter stays wide; reactions on the dolly only when it's steady throughout; cuts to the wide never wait (late cut timing doesn't apply to them).
- **Intro:** the wide holds at least 15 s for the name cards (adjustable); every build marks the welcome.

## v0.14 (added)

- **Recut multicam / Undo multicam cut:** every build retypes all pieces in its range (so leftover edit points can't keep stale angles); the last 5 builds per sequence are kept, and Undo re-applies the previous one (or the wide everywhere after a first build). Rose labels follow.

## v0.15 (added)

- **Reactions to the wide:** a reaction from someone without a usable close-up cuts to the wide instead of being skipped, and two or more listeners reacting together always cut to the wide.
- **Undo and Recut fix:** cuts land on exact frames, so they hit the edit points left by earlier builds instead of leaving one-frame slivers. A click while busy now says so.

## v0.16 (added)

- **Label colour by keystroke:** pick any of the 16 label colours for camera 2 shots. A multicam build selects those pieces and presses your Edit > Label shortcut, since scripts often can't set the colour.
- **Updates:** checks when the panel opens and every 2 hours.
- **Double-click a slider** to reset it to its default.
- **Content cuts already in the timeline are covered:** the camera changes exactly on the cut (off the wide to the solo of whoever speaks next, off a solo to the wide), not just for sections ticked on the Cleanup tab.
- **Stay on the speaker:** a bump on several mics at the same instant is not a reaction; no reaction or cutaway just before the next turn (Hold before next turn).
- **Dolly stays on the last person until it moves** (when there is no Who's in the shot reading), and a follow-cam shot that runs across a change of speaker is checked against whoever has the floor at each moment.
- **Picture names checked by voice:** a long steady dolly stretch named after someone silent while another person talks is treated as on the talker. A follow-cam shot spanning several speakers is split per speaker, so monologue cutaways measure one person's turn. A brief aside over someone who carries on isn't crosstalk.

## v0.21 (added)

- **Knocks on the dolly count as movement:** a lean on the rail shifts the picture 2-3 px at full size in a fraction of a second, too small for the motion reading (it works at 160 px wide). The analyzer now also measures the whole picture's shift at 320 px, to a few hundredths of a pixel, and a knock reads as a slow move so the cut stays off the dolly there. Ep 245 had three between 14:17 and 14:27; on a static wide it never fired. Camera movement is analyzed again once (cache version 9).
- **Label colours per camera:** each camera row has a Label picker (16 colours or none). By default the wide has none and the other cameras Rose, so on episodes where the 24-70 wide is camera 2 the wide no longer turns Rose. Multicam builds press each colour's Edit > Label shortcut; saved setups keep the colours. Replaces "Label camera 2 shots".
- **0.21.3:** the GitHub repository is now `memoria-productions/podcutter`. The updater looks there, follows GitHub's redirects, and falls back to the old name. Panels on 0.21.2 or older can't follow the redirect, so they need this version installed by hand once.
- **0.21.2:** releases attach only `PodCutter-x.y.z-Windows.zip`. The `PodDirector-…zip` copy, kept since 0.18 for panels installed before the rename, is gone; a panel still on 0.17 or older needs one manual install.
- **0.21.1:** Scan no longer freezes the panel. The label note looked up the Premiere shortcuts file several times on every camera redraw, each time launching `reg query` and re-reading the .kys; now the Documents folder is looked up once and the file is parsed once until Premiere saves it again.

## v0.20 (added)

- **Slow creep counts as movement:** the motion analyzer also compares frames a second apart wherever neighbouring frames show nothing, so a dolly creeping at 0.2-1.3 %/s (which used to read as steady) is seen; Steady below now defaults to 0.3 %/s (was 1.2) and goes down to 0.1. Camera movement is analyzed again once (cache version 8), about 15% slower.
- **Restore multicam** replaces Undo multicam cut: the edit points PodCutter's builds left are joined back into whole clips (picture and the multicam's sound), keeping real cuts, and the wide is put on. Undo used to retype angles, leaving every edit point behind.

## v0.19.1 (added)

- **Build as multicam is the build for multicam angles:** with cameras on a multicam's angles it's the blue button, and Build cut on a copy and Recut (stacked tracks only) are hidden.
- **Angle numbers follow the track:** a saved setup could carry another episode's angle number (ep 245: the 24-70 on angle 2 labelled angle 1), which would have typed the wrong camera. Scan, and picking a track, set it from the track.

## v0.19 (added)

- **The 24-70 is always the wide.** Scan reads each camera's lens from Sony's metadata (the sidecar, or the copy inside the MP4) and sets the 24-70 camera up as the static wide, on whichever track or multicam angle it lands; with two cameras the other becomes the follow cam with Check for movement. Camera rows show the lens. Undo multicam cut goes back to the wide's angle (was always camera 1). A stacked 24-70 above V1 is warned about and built unlayered.

## v0.18.2 (added)

- **"Recut multicam" only when the build is really there.** Scan checks that the cuts of the last multicam build are still on the timeline. If they're gone (undone in Premiere, assembled again, or a new sequence that shares an ID with one built before), the record is dropped and the button reads Build as multicam.

## v0.18.1 (added)

- **Multicams whose angles are per-camera nests** (`<ep>_mc` of `<ep>_a_cam` / `<ep>_b_cam`, as PodGrip assembles them) are read down to the camera files. Before, Scan found no angles, so both cameras sat on V1, Build as multicam wasn't offered, and the camera 2 labels didn't apply.
- **"Recut" only when there's something to recut.**
  - "Recut multicam" was offered on a newly opened sequence after a build on another one; it now only shows for a sequence that has been built.
  - A copy deleted from the project is forgotten, so Recut isn't offered for it.

## v0.18 (added)

- **PodDirector is now PodCutter.** The panel, menu item, installer, update packages and Documents folder all use the new name.
  - The first time it opens, the panel copies your presets, setups, transcripts and exports from `Documents\PodDirector` to `Documents\PodCutter`. The old folder is left as it was.
  - Installing (or updating) removes the old PodDirector panel folder.
  - Updating from an installed PodDirector works as usual: each release also carries the package under its old name. That update needs a Premiere restart.
  - Not renamed, so nothing is lost: the extension ID, the panel's saved settings, `[PD]` marker names (Clear markers still finds old ones) and earlier "… - PodDirector" sequence copies, which Recut still finds by their ID.
- **Wide + dolly handoffs** retuned with the dolly footage of 36 past episodes (tools/analyze_past.js, mapped through each edit's multicam to the camera files): wides 9 s minimum (was 12), solo 4.5 s in, back to the dolly 1.5 s after a move. With motion and framing it matches David's camera choice 79% of the time, at 48% wide (David 44%), cutting to the solo 4.6 s into a turn (David 4.6 s), and shows the dolly mid-move 0.1% of the solo time (David 0.1%; 1.7% without motion readings).

## v0.17 (added)

- **Wide + dolly handoffs** mode, learned by lining up 35 finished Classical et cetera edits (tools/prproj.js) with the mic audio. Wide around each change of speaker (from 1.5 s before), the new speaker's solo 5 s in, short turns on the wide, long shots. On audio-only replays it matches David's camera choice 78% of the time (Roundtable: 47%). New settings: Solo after, Wide before handoff.

## v0.16.1 (added)

- A content cut is covered even when the covering camera moves a few seconds later: the cover is cut short before the move (it used to be dropped, leaving the jump).
- The analysis export lists the content cuts found in the timeline.
- **tools/prproj.js:** reads finished edits straight from Premiere project files (no Premiere): every sequence, track and piece, label colours, sources, and the camera angle of each multicam piece. Run over a folder of episodes to learn from past edits. The wide is the angle shot on the 24-70 (Sony sidecar lens); --aperture settles ties by f-number (exiftool, cached).

## Next candidates

- **Jump-cut / silence removal** (AutoPod's "Jump Cut Editor"): ripple-delete silences on every track, using the existing mic analysis
- **Apply accepted cleanup cuts**: optional ripple delete of the accepted transcript ranges on the copy, not only markers
- **Multicam-source output**: switch angles inside a Premiere multicam source sequence instead of enabling tracks
- **Social reframe/export**: vertical and square versions (AutoPod's "Social Media Exporter")
- **Speaker labels in the transcript**: per-mic transcription for exact attribution when bleed is heavy
- **Signed ZXP package**, so `PlayerDebugMode` is not needed
- **UXP migration**: Adobe plans to disable CEP by default in Premiere around Dec 2028
- **Claude / MCP hook**: let Claude call `plan` and `cleanup` directly and push tuned configs into the panel

## Future platforms (logged by request, not started)

- **macOS build**: bundle darwin ffmpeg and whisper.cpp, plus a `.pkg` or shell installer. The engine and panel code are already cross-platform.
- **Linux build** for Premiere-style editors on Linux (the "FilmCraft"/ArtCraft-type clones). This needs a host adapter for that editor's scripting API, or an EDL/FCPXML exporter. The cutting and transcript engines are host-independent pure JavaScript.
