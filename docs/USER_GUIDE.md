# PodCutter: User Guide

PodCutter is a Premiere Pro panel that edits multicam podcasts for you. It reads each person's microphone waveform, works out who is talking, and switches camera angles to match. You can tune the cutting style and preview it before anything touches your timeline. A second tool, **Cleanup**, reads a transcript of the show and flags the spots where someone said "cut that", restarted a sentence, or went off the record.

Everything runs on your own computer. There are no accounts, no internet connection, and nothing else to install.

> **PodCutter used to be called PodDirector** (up to version 0.17). Updating from PodDirector works as usual, though that one update needs a Premiere restart.
> - Afterwards, the panel is under **Window → Extensions → PodCutter**, and the old PodDirector entry is gone.
> - Your presets, setups and transcripts are copied from `Documents\PodDirector` to `Documents\PodCutter` the first time it opens. The old folder is left alone, so delete it whenever you like.
> - Markers and sequence copies made by PodDirector still work with Clear markers and Recut.

---

## 1. Install (Windows)

1. Close Premiere Pro.
2. Unzip `PodCutter-…-Windows.zip`.
3. Double-click **Install PodCutter.bat**. If Windows SmartScreen warns you, click **More info → Run anyway**.
4. Start Premiere and open **Window → Extensions → PodCutter**.

To remove it, double-click **Uninstall PodCutter.bat**. Your presets and transcripts in `Documents\PodCutter` are kept.

Requirements: Premiere Pro 2022 or newer on 64-bit Windows 10 or 11. The installer only changes your own user account, so it doesn't need admin rights.

---

## 2. Lay out your sequence

| Track | What goes there |
|---|---|
| **V1, V2, V3…** | One camera per track, synced and spanning the whole show. Example: V1 Wide, V2 Host close-up, V3 Guest close-up. |
| **A1, A2…** | One **microphone per person** (lav, dynamic mic, or a recorder channel). |
| Above the cameras | Graphics and lower thirds are fine there. PodCutter only touches the tracks you list as cameras. |

PodCutter cuts by enabling one camera track at a time. Keep the camera tracks stacked with no gaps.

Tips:

- **Sync first.** Use Premiere's *Synchronize* by audio, or a sync plugin, before you run PodCutter.
- **Camera scratch audio is skipped automatically.** Audio that comes from the same files as your camera clips isn't treated as a speaker mic.
- **All the mics in one file?** A recorder (Zoom, Rodecaster) or a camera with an XLR adapter often puts every mic in one multichannel file, which Premiere spreads across tracks (A1 = Ch 1, A2 = Ch 2…). PodCutter detects this and gives each speaker its own channel; you can check it in the channel menu next to each speaker. If it ever reads **All ch** for such a file, every speaker hears the same mix and the cut barely changes. PodCutter now warns about that after analysis.

---

## 3. Multicam workflow

1. **Scan sequence** reads the active sequence and makes a first guess at who's who. Audio tracks with **VOX** in their name (VOX1, VOX2…) are taken as the speaker mics first. Tracks named like SFX, music, mix, or room are skipped.
2. **Show setup** (top card) chooses how the speakers and cameras are set up:
   - **Auto-detect** uses every voice track it finds.
   - **1 / 2 / 3 / 4+ subjects** takes that many VOX tracks and switches the cutting style to one tuned for that many people.
   - **Save as…** stores the current speakers (names, tracks, per-speaker settings), cameras, and style as a named setup, such as "Classical et cetera". Pick it from the list on any episode. Tracks are matched by name, so VOX1 is always Martin. Once saved, a setup is **applied automatically** to new sequences whose track names match. The trash icon next to a saved setup deletes it.
3. **Speakers:** name each mic and check its track and channel. **+ Speaker** adds one, the trash icon next to ⚙ removes one (after you confirm), and ⚙ opens that speaker's settings.
4. **Cameras:** for each camera, tick the people it shows. The trash icon removes a camera. Tick **Static** for a camera that stays on its shot with no operator, such as a close-up locked on one person; it turns off **Follows speaker**. **Check for movement** can stay on alongside it when the shot itself moves (a slider or a slow push-in).
   - One person ticked = that person's **close-up**.
   - Everyone ticked = the **wide** shot.
   - Two people ticked = a **two-shot**, used when exactly those two talk over each other.
   - A person with two close-up cameras gets **angle rotation** between them.
   - **Follows speaker:** for a camera whose operator re-frames on whoever is talking. It counts as a close-up of every speaker, but never as a group shot or a listener reaction.
   - **Check for movement:** turn this on for a dolly, slider, gimbal, or handheld camera. PodCutter reads its picture and only cuts to it when it's steady (section 4, *Moving cameras*). Leave it off for locked-off cameras like a static wide: that skips the video analysis for them, and they're never held back.
5. **Analyze** range: set **In and Out marks** on the sequence around the episode itself, and PodCutter cuts only between them. The intro, outro and anything else outside the marks are left exactly as they are (the preview greys them out). Choose **Whole sequence** in the menu above the Analyze button to ignore the marks. The marks are followed live: Analyze reads the whole sequence once, so when you move In or Out in Premiere, the range, preview and planned cut update by themselves within a second. There's no need to scan or analyze again.
6. **Analyze waveforms** reads the mic audio. It also checks any moving cameras for movement, which decodes their video at low resolution: allow a few minutes per hour of footage the first time. The first run takes a little while. After that the results are cached, so changing settings is instant.
7. **Tune the style** (section 4). The preview strip updates live.
   - **Click** the preview to move Premiere's playhead to that moment.
   - **Drag** across a range, then pick a camera to **lock** it there. "Auto" unlocks it.
8. **Preview as markers** drops a colored marker at every cut, so you can scrub through in Premiere before committing.
9. **Build cut on a copy** duplicates your sequence as "… - PodCutter", razors the camera tracks at every cut, and enables the right camera for each shot. **Your original sequence is never changed.** If a camera track's eye (track output) was off in the original, the copy would still hide it, so Build and Recut turn the eye on for every camera track they cut, and the status line says so. After a scan, the camera row notes *eye off in the sequence* for any camera track that's hidden.
   - The **bottom camera track** (V1) is always the wide, and it's left whole and enabled: Premiere shows the top-most enabled clip, so the wide shows through wherever the cameras above it are switched off. Only the cameras above it are razored, and only where they actually switch on or off. Content cuts already in the footage stay as they are. With a wide on V1 and the solo cam on V2, that's one track instead of two and far fewer edits. **Scan sequence** sets up the bottom camera as the wide, and its camera row says *bottom, kept whole*. As a safety check, the Cameras card shows a warning if V1 isn't the static wide: V1 is empty, no camera is set to V1, or the V1 camera doesn't show everyone, follows the speaker, or has Check for movement on. If you see it, check the sequence and put a static wide camera on V1. **The 24-70 is always the wide.** At every Scan, PodCutter reads each camera file's lens from Sony's metadata (the `M01.XML` sidecar, or the copy inside the MP4) and makes the camera shot on the 24-70 the static wide: it shows everyone, with Check for movement and Follows speaker off, whichever track or multicam angle it's on. With two cameras, the other one becomes the follow cam with Check for movement on. Each camera row shows its lens. On a multicam, the wide can be any angle. With stacked tracks, a 24-70 that isn't on V1 can't be kept whole, so builds cut every camera track and the Cameras card warns about it. The switch, **Leave the bottom camera whole**, is under Cutting style → Advanced → **Timeline**; leave it on. Turning it off razors every camera track at every cut, including the wide.
10. **Recut** to try a different style or fix a few shots. Adjust the preview, then click **Recut "… - PodCutter"**. This changes the same copy in place instead of making a new one, so if you've already nested that copy into your master timeline, the nest picks up the new cut automatically. Old edit points stay behind as invisible through-edits. **Undo recut** puts the previous version back (the last 5 are kept). Recut overwrites any cameras you switched by hand in that copy, so lock those shots in the preview first (drag across them and pick a camera).

---

## 4. Tuning the style

The **Cutting style** card shows only the few controls you'll usually touch: a mode, the close-ups/wide slider, **Max cuts / min**, **Minimum close-up**, **Minimum wide**, and a **Feature** slider for each person. Everything else is under **Advanced**, which stays folded until you open it. If you've changed anything in there, the Advanced heading says how many settings, and those groups open by themselves. Controls you've changed from the mode turn blue. Double-click any slider to put it back to the mode's default (speaker and cleanup sliders go back to theirs). Click **Save** to store your own preset.

### Mode

Pick the mode closest to the show; it sets every setting at once. The line under it explains what it does.

| Mode | Good for |
|---|---|
| **Balanced discussion** | Most conversational podcasts (the default). |
| **Calm discussion** | Long, unhurried talks. Long shots, ignores small reactions, leans toward the wide. |
| **Lively discussion** | Banter and back-and-forth. Quick switching and lots of reaction shots. |
| **Rapid cutting** | Cuts straight to whoever speaks or reacts. Works best with a static close-up camera on each person. Once any camera is ticked **Static**, the panel warns you about anyone who has no static camera showing just them. |
| **Interview** | A host asks, a guest answers at length. Holds on the answer and cuts to the host listening now and then. Raise the guest's **Feature** slider. |
| **Stay on the speaker** | Only cuts when the speaker changes: no wides on pauses, no cutaways, no reactions. |
| **Three people / Roundtable (4+)** | Tuned for bigger tables; Roundtable uses more wides. |
| **Solo / monologue** | One person talking. |
| **Wide + dolly handoffs** | Learned from 35 finished Classical et cetera edits, for a static wide plus an operated camera. The wide covers each change of speaker, starting 1.5 s before the next person comes in. The new speaker gets their solo 4.5 s into their turn, and short turns stay on the wide. Shots are long (8 s minimum, wides 9 s), with no monologue cutaways, and only group reactions cut away. |
| **Social clips** | Very fast cutting for shorts. |

### The main sliders

- **Close-ups / wide:** leans the whole cut one way. Toward **wide**, some speaker turns play on the static wide (they break to the close-up if they run long), overlaps and pauses reach the wide sooner, and wides stay up longer. Toward **close-ups**, overlaps and pauses stay on the person talking; all the way over, two people talking at once stays on the louder one. In the preview, turns played on the wide are labelled "wide turn".
- **Feature** (one per person): who gets more screen time. Raise it for a special guest. A featured person wins close calls, the camera switches to them sooner, their reactions are shown more often, cutaways to a listener pick them first (up to three times as often), and their own long answers are interrupted less. Lower it to show someone less. This replaces the old **Priority** setting, and existing values carry over.
- **Max cuts / min:** a hard limit on how many cuts can happen in any minute. When a stretch is busier than that, PodCutter drops the least important cuts first: reactions, then pause wides, cutaways, overlaps, then the shortest speaker shots. Cuts forced by camera movement stay. **This is the setting to use when the edit feels too busy.**
- **Minimum close-up** (formerly *Minimum shot* under Switching): a close-up, or any other shot, shorter than this gets absorbed into a neighbor, so the camera never flicks to someone for a moment. Reaction shots use their own length, and cuts forced by a moving camera (a dolly reframe) ignore it. Each person can have their own under ⚙ (**Min close-up**).
- **Minimum wide**: every wide shot stays up at least this long (default 5 s), running on into the next shot when needed. Wides forced by a moving dolly, short overlaps and pauses no longer flash by; it never runs over a locked shot or a reaction shot.

  **Content cut warning.** If footage has already been removed from the timeline, a piece left between two cuts can be shorter than the minimum. Nothing can hold a shot that long there without crossing a cut. After a scan, PodCutter checks the wide camera's clips for content cuts: places where the next clip jumps to a different point in the source, or to another file. Razor cuts that keep the footage continuous don't count, nor do cuts outside the In/Out range. If any piece is too short, a warning appears under **Minimum wide**. **Short sections between content cuts**, at the top of the Cleanup tab, lists each one with its length; click it to jump there. The check uses the longer of Minimum wide and Minimum close-up, and updates as you move them.

  Both minimums range from 2 to 20 seconds. In the fast modes (**Rapid cutting**, **Lively discussion**, **Social clips**) Minimum close-up instead runs from 0.5 to 10 seconds, so quick reactions and back-and-forth can stay short.

  Under the preview, **Shots by reason** shows what's causing the cuts. Lots of "reactions" means lower **Reaction frequency**, set **Interjections** to *Ignore*, or *lower* **Interjection length** (a longer setting turns more remarks into reaction shots). Lots of "dolly moving" means the operator reframes often; that's not a setting problem.

### Switching (Advanced)

- **Reaction delay:** how long a new voice has to keep talking before the camera follows. Raise it if the edit feels jumpy. Lower it if the camera is late to the new speaker.
- **Cut timing:** where the cut lands relative to the first word. Slightly negative (−0.1 s) cuts just before they speak, which feels natural. Positive values cut a beat after, like a live switcher reacting.
- **Solo after:** on a change of speaker, stay on the wide and cut to the new speaker's close-up only once they've talked this long. Turns too short for that stay on the wide. In your finished edits it's about 5 s (0 = straight to the close-up).
- **Wide before handoff:** with Solo after on, go to the wide this long before the next person starts, as the last speaker winds down.

### Wide and group shots

- **Talking over:** what to show when two or more people talk at once. Go wide, stay on the loudest person, or hold the current shot.
- **Overlap time:** how long the overlap has to last before it counts as crosstalk.
- **Brief aside** (2 s): someone speaking briefly over a person who carries on afterwards isn't crosstalk unless it lasts this long. The shot stays on the person talking.
- **Wide on pauses:** cut to the wide after this much silence.
- **Open on wide:** start the show on the wide shot.

### Content cuts

When you've taken a section out of the episode, the source jumps at that point. Shown on the same camera, that's a jump cut. PodCutter finds these content cuts on the wide's track and changes camera exactly on the cut. Off the wide, it goes to the solo of whoever speaks right after the cut, or a listener if they have none. Off a solo, it goes to the wide. After **Cover shot** seconds it goes back, or carries on to the next natural cut. If the camera it covers with starts moving sooner, the cover ends just before the move instead of being skipped. These show as "cut cover" in the stats. **Across a cut** turns this off. Sections you tick on the Cleanup tab get the same treatment.

### Reactions and interjections

These are listener reactions like "Yeah", laughs, and quick remarks.

- **Interjections:** cut to the person reacting, cut to the wide, or ignore them.
- **Reaction frequency:** the share of interjections that get a shot. This keeps the edit from cutting away constantly.
- **Interjection length:** speech shorter than this, over someone else, counts as an interjection rather than a new turn.
- **No close-up of them:** when the person reacting has no camera of their own, or the dolly isn't on them, *Cut to the wide* (the default) shows the room. *Stay on the speaker* skips the reaction.
- **Several react at once:** when two or more listeners laugh or chime in within a second of each other, *Always cut to the wide* shows the group. These cuts don't count against Reaction frequency. The same short bump on several mics at the same instant is one sound heard everywhere (a knock, a cough, the speaker's own laugh bleeding into the other mics), so it gets no shot at all.
- **Hold before next turn:** no reaction or cutaway this close before someone else takes over. A question running into its answer stays on the person asking, and the next cut is to the person answering.

### Moving cameras

This group appears once **Check for movement** is on for a camera. PodCutter measures how much the *camera* moves (pan, tilt, dolly, push-in, shake) separately from how much the *people* move. Someone gesturing or leaning in front of a steady camera doesn't count as camera movement. The preview shows a movement lane for each moving camera: **green** = steady, **amber** = slow move, **red** = big move.

- **Steady below / Big move above:** the two thresholds, in percent of frame width per second. Between them is a *slow move*, such as a gentle push-in or a drift.
- **Settle time:** how long the camera must be steady before PodCutter cuts to it, so you never land on the tail end of a move.
- **Wait to settle:** if a cut would land mid-move, PodCutter holds the previous shot up to this long. Longer moves go to the wide until the camera settles.
- **Slow moves on air:** keep gentle push-ins on screen once you're on that camera, or cut away from any movement. It's off by default, so any visible reframing or drift cuts to the wide.
- **Leave move early by:** how early to cut away before a big move starts.
- **Come back after** (3 s by default): after a move, PodCutter goes back to the moving camera only if it then stays steady at least this long. During quick banter, the operator keeps swinging between people, so the cut stays on the wide instead of flicking dolly–wide–dolly. Set it to 0 to go back as soon as the camera settles.
- **Who it's on** (when there's no **Who's in the shot** reading): *Whoever it settled on* (the default) assumes the operator only changes who's in frame by moving. Each steady stretch shows whoever was talking as it began. When someone else starts talking, the cut goes to the wide until the operator swings round, instead of holding the dolly on the wrong person. *Whoever is talking* trusts the operator to always be on the speaker. A **Who's in the shot** reading, when you have one, always wins.
- **Check names by voice** (on): the picture reading can lump two people together and name a stretch after the wrong one. An operator frames whoever is talking, so a steady stretch of 8 s or more "on" someone who barely speaks (under 25%), while one other person does most of the talking (50% or more), counts as on the person talking. Shorter holds on a listener are left alone.

The wide is the safety shot. Cutting *to* it never waits for anything: not settle time, not reaction delay, and not a late cut timing. When the dolly starts moving, the cut goes to the wide just before the move. A reaction (a laugh, a "yeah") on the dolly is only used when the dolly is steady for the whole reaction; otherwise it plays on the wide.

Small knocks count too: someone leaning on the dolly rail moves the picture only 2-3 pixels, but PodCutter measures the whole picture's shift to a fraction of a pixel and keeps the dolly off air around a knock, like any other move.

Typical setup, one static wide plus one operated dolly camera: turn on **Check for movement** and **Follows speaker** for the dolly, and leave both off for the wide. The edit then reads: dolly on whoever is talking when it's steady, the wide while the operator re-frames, back to the dolly once it settles.

**Who's in the shot (operated cameras).** An operator doesn't always stay on whoever is talking: they may hold on a listener, or be late moving to the next person. For a camera with **Follows speaker** and **Check for movement** both on, PodCutter also works out who it's pointed at:

- It splits the camera's footage into steady stretches, between moves.
- It groups stretches that look alike, using the colours in the middle of the frame (clothes, skin, hair), so each group is one person.
- It names each group after whoever was usually talking while the camera sat on it.

The camera row then shows a thumbnail per group with that guess. Fix any that are wrong, or choose *Nobody / don't use*. The dolly is then only used while it's on the person talking, so it never shows Jess while Paul is talking. If it happens to be on a listener when they laugh or say "yeah", it can serve as their reaction shot. In the preview, a thin coloured line under the movement lane shows who it was on.

If two people dress alike they may land in the same group; set that group to *Nobody* and PodCutter uses the wide there instead.

If the camera row says *plain background, treated as steady*, the shot doesn't have enough detail behind the subject (a bare wall, a seamless backdrop) to measure camera movement. Watch the result there, and lock any bad moments by dragging on the preview.

### Long monologues

- **Break shots over:** insert a cutaway once a single shot runs longer than this. Cutaways are placed at the quietest breath nearby.
- **Cutaway to:** the wide, a listener, the speaker's other angle, or a mix of all three.

### Voice detection

You rarely need these.

- **Sensitivity:** for speakers on Auto threshold. Raise it if a soft-spoken guest gets missed.
- **Bleed rejection:** a mic this many dB below the loudest is treated as picking up the other person's voice. Lower it if a loud host's voice on the guest's mic causes wrong cuts.
- **Ignore blips under / Bridge gaps under:** ignore coughs and bumps, and keep a turn alive through short pauses between words.
- **Variation seed:** reshuffles the random choices (which reactions get shown, which angles) without changing the style.

### Per-speaker settings (⚙ on each speaker)

- **Threshold:** Auto, or set it by hand. The bar under the speaker shows their noise floor and speech level, and the white line is the threshold.
- **Min close-up:** a minimum close-up length just for this speaker.
- **Reacts on screen:** turn off if this person's "mm-hmm"s shouldn't trigger reaction shots.
- **Use as listener:** turn off if this person shouldn't be shown listening during cutaways.

### Mic confidence

Under the preview stats, **Mic confidence** (click to open or close) rates how well each mic picks up its own speaker, from 0 to 100: **good** (75+), **fair** (55–74) or **poor**. The heading shows the weakest mic, so you can leave it closed and still see when something's wrong. Each person's row shows:

- **Level:** their voice compared with the loudest mic. Far below it usually means they're sitting back from the mic.
- **Separation:** how much louder they are on their own mic than the others are on it. A low number means a lot of bleed, so PodCutter can mix up who's talking.
- **Borderline:** how much of their speech only just clears the threshold. Quieter words may be missed.
- **Maybe missed:** seconds where nobody was detected but their mic was just under the threshold.
- **Weak:** a minute or more where their level ran 10 dB or more below their usual, for example after turning away or leaning back. Click one to jump there and check the cut.

Separation counts for most of the score. The scale was tuned on a year of real episodes. Well-mic'd speakers sit at 25–30 dB of separation. Someone sitting back from the mic, especially beside a voice that carries, drops to 10–14 dB, and that's where cuts to them start going wrong. Level counts for little, because it mostly reflects recorder gain rather than mic technique.

Each row ends with a tip on what to change: usually that speaker's **Threshold** (⚙), **Sensitivity** or **Bleed rejection**. It can't fix the recording itself, but it shows where to check the cut by hand or lock a shot.

### Reading the stats

Under the preview you'll see the number of cuts, cuts per minute, average and longest shot, **screen time per camera**, and **talk time per speaker**. If a speaker talks 40% of the time but only gets 15% screen time, raise their **Feature** slider or lower the reaction frequency.

---

## 5. Cleanup (transcript)

1. Click **Transcribe timeline**. PodCutter mixes the speaker mics and transcribes them offline with the bundled Whisper model. On a typical laptop that takes a few minutes per hour of audio. You can also **load** a transcript exported from Premiere's Text panel (SRT, VTT, or TXT).
2. PodCutter flags:
   - **Asked to cut:** "cut that", "edit that out", "scratch that", "don't use that", "we'll fix it in post", a bare "David, cut.", and similar phrases.
   - **Abandoned tangents:** when the cue calls out a whole stretch ("maybe we'll cut this part, it's going everywhere"), the cut reaches back up to *Look back up to* (40 s by default), and runs forward to where they say they're back: "bring it back", "let's get back on track", "okay, we're back". Each of those phrases must come within 45 s of the last one. Check the start point: where a tangent began is a judgment call.
   - **Pre-show and post-show chatter:** everything before the welcome address, and short talk after the sign-off ("thanks for joining us… we'll see you next time"). Put your show's name in **Settings > Show name** (it starts as *Classical et cetera*): "welcome to Classical et cetera" then marks the start of the show even when there was a "welcome to the new studio" earlier, and "etc." / "etcetera" spellings match too. These suggestions have a **Set In point at the welcome** / **Set Out point at the sign-off** button, so the multicam Analyze skips the chatter as well.
   - **Restart / retake:** "let me start over", "take two", "from the top", "let me rephrase".
   - **False starts:** a sentence that's begun, abandoned, and restarted with the same words. No spoken cue is needed for these.
   - **Off the record:** from "off the record" until "we're back" or the next long pause.
   - **Interruptions:** phones and alarms ("let me silence my phone", "sorry, that's my alarm", Whisper's own *[phone ringing]* tags), someone at the door, "I have to take this". The suggestion runs from the ring through the "okay, sorry about that", and stops where the conversation picks back up.
   - **Technical chatter:** "hold on", "is the camera still recording?" These are flagged with lower confidence.
3. Each suggestion shows its time range, confidence, and transcript text. **Click** a suggestion to jump Premiere's playhead there. Use the arrow buttons to nudge the start or end by 0.5 s, and untick any you want to keep.
4. Ticked suggestions also feed the multicam cut. Removing a section joins the shot before it to the shot after it, so PodCutter makes sure those two are **different cameras**. Typically it goes to the wide for a few seconds, then back, which hides the jump. You'll see a "cut cover" shot in the preview. The **Content cuts** group in the cutting style turns this on or off and sets how long the cover shot lasts. If you've already built the copy, click **Recut** afterwards so it picks this up.
5. **Mark selected on timeline** adds red range markers. Review them in context, then lift or ripple-delete the ones you agree with. PodCutter never deletes anything for you.
6. **Copy for Claude review** copies the flagged list plus the full transcript, ready to paste into Claude for a second opinion.

### Introduction and name tags

When the transcript has the welcome ("Hello and welcome to … Classical et cetera"), the **Introduction** card finds:

- **The welcome** and who's hosting. The host is whoever says "I'm Jessica Abood" or "my name is …".
- **Everyone they introduce,** in order, with the time each name is said. People are matched by the speaker names on the Multicam tab, so name your speakers. Guests are picked up from phrases like "we're joined by Dr. Malcolm Guite" or "our guest today is …".

With **Open on the host's solo cam, then the wide for the introductions** ticked (the default), the multicam cut opens on the host's close-up, or the follow cam when it's on them and steady, through the welcome. It goes to the wide at the first other name and holds it for at least **Hold the wide at least** seconds (15 by default), so the name cards have time on screen. If the introductions run longer, the wide holds past the last name. Normal cutting picks up after that. Any shots you've locked in the preview still win. Every build (multicam or stacked) also puts a green **Welcome** marker where the host says it.

Each name has a text box for its name tag: type the full name or title, and it's remembered for next time. **Add lower-third markers** drops a yellow 5-second marker at each name, labelled with that text, so you can drop your name tag graphics on them. **Clear name markers** removes them. Name times are estimates when the transcript only has a timecode every 20 seconds or so, as Premiere's text export does. Whisper transcripts carry word timings and land closer.

Add names and jargon under Settings → *Vocabulary hint* to improve transcription accuracy.

---

### Multicam by keystrokes (experimental)

Premiere has no script command to switch a multicam angle, but its **Cut to Camera** shortcuts do it: with the playhead parked on a multicam clip, Cut to Camera N cuts there and switches to camera N. **Settings → Multicam by keystrokes** tests whether PodCutter can drive that on your machine.

1. It shows the shortcuts it found in your keyboard shortcuts file (Ctrl+1 and Ctrl+2 by default). Any letter, digit or symbol key, with any modifiers, works. Arrow and function keys can't be typed yet.
2. Open a sequence with a multicam clip on it (a duplicate is safest) and park the playhead where the trial should start.
3. Click **Run trial**, then click once in the Timeline during the five-second countdown. A pulsing yellow bar at the top of the panel counts down; it turns green ("Cutting — hands off") while PodCutter types. Don't touch the mouse or keyboard until it's done. If another window comes to the front, it stops.
4. It makes the set number of cuts, a few seconds apart, alternating camera 2 and camera 1, then puts the playhead back. The times are in the Log, so you can check each cut landed.

**Pause** is the wait before and after each keypress; raise it if cuts are missed.

#### Build as multicam (experimental)

Once the trial works, **Build as multicam** applies the whole planned cut to a real multicam clip. You get a multicam sequence you can re-switch by hand afterwards. When your cameras are a multicam's angles, it's the main (blue) build button and **Build cut on a copy** is hidden, since that one only switches stacked camera tracks. Each camera builds as the angle its track is: Scan corrects an angle number carried over from a saved setup.

1. **Analyze** the episode as usual, on the sequence with the cameras stacked on V1 and V2.
2. **Duplicate** that sequence in Premiere. In the duplicate, select the camera clips on V1 and V2, **Nest** them, then right-click the nest → **Multi-Camera → Enable**. Nesting keeps every clip at the same time, so the planned shot times still line up.
3. Open the duplicate, and on the Multicam tab click **Build as multicam**. Each camera's angle is its original track: the wide on V1 is camera 1, the dolly on V2 is camera 2.
4. Click once in the Timeline during the yellow countdown, then leave the computer alone. For every angle change, PodCutter parks the playhead and presses your Cut to Camera key. The green bar shows progress and the time left: about 0.6 s per cut at the default Pause, so a few minutes for an episode. **Stop** in the bar, or switching to another window, stops it.
5. Afterwards it counts the pieces on the multicam track and tells you whether every cut landed. If it stopped part-way, or some cuts were missed, **Resume** carries on from where it stopped. Raise **Pause** under Settings first if cuts were being missed.

Each keypress is one undo step in Premiere. Run it on the duplicate, so your stacked-track sequence stays as it was.

**Recut multicam and Restore multicam.** Once a sequence has been built, the button reads **Recut multicam**. Scan checks that the build is still on the timeline: if its cuts are gone (undone in Premiere, or the sequence was assembled again), the button goes back to **Build as multicam**. Change settings, look at the preview, and click it to apply the new plan to the same multicam clip. Cut to Camera only switches up to the next edit point, so a recut also retypes every piece left by earlier builds. Old edit points become invisible through-edits on the same angle. If you click while PodCutter is still busy, the status line says so; wait for the current job to finish. A recut overwrites angles you changed by hand on that stretch, so make hand changes last. The labels follow: pieces now on a camera without a label colour get their original colour back.

**Restore multicam** (click it twice to confirm) takes PodCutter's builds back out. Every edit point the builds left on the multicam is joined back into a whole clip, on the picture and on the multicam's sound, and the wide is put on, with the original label colour. Only through-edits are joined, where the multicam carries straight on: real cuts, like content you removed, a gap or another clip, stay as they are. It covers everything PodCutter built on that sequence, and afterwards the next build is a first build again.

**Analyzing a sequence whose cameras are already nested.** When a video track holds a multicam (or nested) sequence, **Scan** reads inside it. Each of the nest's video tracks becomes an angle: V1 inside is angle 1, V2 is angle 2, and so on, each mapped onto this sequence's timeline. They show up in the camera track menu as *V1 nest angle 1 (Wide)*, *V1 nest angle 2 (Dolly)*, and are analyzed like stacked cameras. An angle can itself be a nest holding that camera's clips, as in a multicam of `246_a_cam` and `246_b_cam` (the way PodGrip assembles it). PodCutter follows it down to the camera files, and the angle is named after that nest. So the dolly is still checked for movement and "who's in the shot", and the cut never lands on it mid-move. If your saved setup still points at the old stacked tracks, the Cameras card says so: click **Use the nest's angles as cameras** (your camera settings are kept), then Analyze again. Build as multicam works straight on that sequence. Build cut on a copy and Recut only work with stacked camera tracks.

If a sequence's cameras get nested after you set it up, and its saved setup still points at tracks that are now empty, **Scan** moves the cameras onto the nest's angles by itself and says so. A camera with **Check for movement** ticked but no footage to measure gets a red warning on its row and after Analyze. Builds refuse to run that way, because the cut would land on it mid-move.

**Mark camera moves** (Multicam tab, below the markers buttons) shows what the movement check found. It puts a marker over every stretch where a moving camera is moving on the analyzed sequence: **red** for big moves (re-frames, whips), **orange** for slow drifts. These are exactly the stretches the cut keeps that camera off air. **Clear PodCutter markers** removes them.

**Label shots by camera** (on by default): after a build, each camera's shots get the label colour picked under **Label** on its row in Cameras, any of Premiere's 16 colours or **No label**. By default the wide has no label and the other cameras are Rose, whichever angle the wide is on, so the solo-cam shots stand out. Saved setups keep the colours. Only the timeline clips change, not the source in the project.

Scripts often can't set a clip's label colour, so a multicam build does it the same way it cuts. Give **Edit > Label > *your colour*** a keyboard shortcut (**Edit > Keyboard Shortcuts**, search "Rose", for example, and press a key combination such as Ctrl+Alt+Shift+R). Once the cuts are typed, PodCutter selects each camera's pieces and presses its colour's shortcut, while the Timeline still has focus. Every colour in use needs a shortcut for this; the note under **Label shots by camera** shows the shortcuts it found and which colours still need one. On a recut or restore, pieces of unlabelled cameras get their original colour back if that colour has a shortcut too. Without a shortcut, and for stacked builds, PodCutter tries the script call and the Log says what happened.

If the multicam clip doesn't reach somewhere the plan does, there's no footage there to switch. This is common at the very end, where the audio or the Out mark runs a few seconds past the cameras. The build skips those stretches and says where. A gap in the middle is skipped too, and the angle is set again where the footage resumes.

**Only between the In and Out marks** (under the button) builds just part of it: set In and Out marks on the multicam sequence, for example around a short test section, or a stretch you want to redo. PodCutter first adds edit points at In and Out. It then sets the angle the plan has at In, and types only the angle changes in between. Since Cut to Camera switches up to the next edit point, nothing after Out changes, including any angles you set by hand.

---

## 6. Updating

PodCutter checks for a newer version a few seconds after the panel opens, and again every 2 hours while it stays open. When one is available, a blue bar at the top offers **Update now**, which downloads and installs it. You can also check by hand under **Settings → Updates**.

Once it's installed, click **Reload PodCutter** in the bar to start using the new version. There's no need to restart Premiere Pro, and your settings are kept. Wait for any build or recut to finish first. The same button is under **Settings → Updates**. Closing the panel and reopening it from **Window → Extensions → PodCutter** does the same thing.

A few updates change how Premiere loads the panel (its manifest), which Premiere only reads at startup. PodCutter detects this. For those updates the bar asks you to save your project and restart Premiere Pro instead.

Updates can come from two places:

- **GitHub releases.** This only works if the GitHub repository is public.
- **An update folder,** such as a shared drive. Put `PodCutter-x.y.z-Windows.zip` files there, and every machine pointed at that folder picks up the newest one. Use this if the repository is private.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| The panel isn't under Window → Extensions | Run the installer again with Premiere closed. |
| "ffmpeg was not found" | Check Settings. The bundled copy should appear there. If antivirus quarantined it, restore it or set a custom path. |
| Very few cuts; the camera barely switches | Check each speaker's channel menu: speakers sharing one multichannel file must each use their own channel, not **All ch**. |
| The camera follows the wrong person | Open ⚙ on that speaker and look at the level bar. If the white threshold line sits inside the bleed, set the threshold manually above it, or lower **Bleed rejection**. |
| Too many quick cuts | Raise **Minimum close-up**, lower **Max cuts / min**, or switch to **Calm discussion**. Under Advanced, raise **Reaction delay**. |
| Reactions feel random | Lower **Reaction frequency**, or turn off **Reacts on screen** for the chatty listener. |
| PodCutter cuts to the dolly while it's still moving | Raise **Settle time**, or lower **Steady below**. |
| The dolly is hardly used | Check its movement lane. If it's mostly amber, raise **Steady below** a little or turn on **Slow moves on air**. |
| Build is slow on a long show | Razoring runs about 20–50 ms per edit. Leave **Leave the bottom camera whole** on: the wide on V1 isn't cut at all, and the cameras above it are only cut where they switch on or off. |

Files (presets, transcripts, exports, cut lists) are saved in **Documents\PodCutter**.
