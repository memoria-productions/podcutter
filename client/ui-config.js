/* Control definitions for the style + cleanup panels. Each maps 1:1 to an engine setting. */
window.PD_UI = {
  // Always visible under the mode; everything in styleGroups sits under "Advanced".
  basicControls: [
    { key: "wideBias", label: "Close-ups / wide", min: -1, max: 1, step: 0.1, ends: ["close-ups", "wide"],
      fmt: function (v) { return v === 0 ? "even" : (v < 0 ? "CU " : "W ") + Math.round(Math.abs(v) * 100) + "%"; },
      help: "Lean the whole cut toward the speaker close-ups or the static wide. Toward the wide, some turns play on the wide and overlaps and pauses reach it sooner. Toward close-ups, overlaps stay on the loudest voice and pauses hold the speaker." },
    { key: "maxCutsPerMin", label: "Max cuts / min", min: 0, max: 20, step: 1, unit: "", zero: "no limit",
      help: "Hard limit on cuts in any minute. When a stretch is busier, the least important cuts are dropped first: reactions, then pause wides, cutaways, overlaps, then the shortest speaker shots. Cuts forced by camera movement stay." },
    { key: "minShotSec", label: "Minimum close-up", min: 2, max: 20, step: 0.5, unit: "s",
      fast: { min: 0.5, max: 10, step: 0.1 }, // range in the fast modes (Rapid, Lively, Social)
      help: "Close-ups (and any other shot) shorter than this get absorbed into a neighbour, so the camera never flicks to someone for a moment. 2–20 s, or 0.5–10 s in the fast modes (Rapid cutting, Lively discussion, Social clips). Reaction shots use their own length, and cuts forced by a moving camera ignore it. Each person can have their own under ⚙ on their speaker row." },
    { key: "minWideSec", label: "Minimum wide", min: 2, max: 20, step: 0.5, unit: "s",
      help: "Every wide shot stays up at least this long, running on into the next shot if needed, so wides forced by a moving camera, overlaps or pauses don't flash by." }
  ],
  featureControl: { label: "Feature", min: -10, max: 10, step: 1, ends: ["less", "more"],
    fmt: function (v) { return v === 0 ? "even" : (v > 0 ? "+" : "") + v; },
    help: "Screen time for this person. Raise it for a special guest: they win close calls, the camera switches to them sooner, their reactions are shown more, listener cutaways favour them, and their own long answers are interrupted less. Lower it to show someone less." },
  styleGroups: [
    { title: "Switching", open: true, controls: [
      { key: "reactionDelaySec", label: "Reaction delay", min: 0, max: 2, step: 0.05, unit: "s",
        help: "How long a new voice must keep talking before the camera switches. Higher = calmer, fewer false switches." },
      { key: "cutTimingSec", label: "Cut timing", min: -0.6, max: 0.6, step: 0.02, unit: "s",
        help: "Where the cut lands relative to the first word. Negative = cut just before they speak (anticipate), positive = a beat after (react)." },
      { key: "soloAfterSec", label: "Solo after", min: 0, max: 10, step: 0.5, unit: "s", zero: "straight away",
        help: "On a change of speaker, stay on the wide and cut to the new speaker's close-up only once they've talked this long. Turns too short for that stay on the wide. Your own edits average about 5 s." },
      { key: "wideLeadSec", label: "Wide before handoff", min: 0, max: 3, step: 0.25, unit: "s", zero: "off",
        help: "With Solo after on: go to the wide this long before the next person starts, as the last speaker winds down." }
    ]},
    { title: "Wide & group shots", open: false, controls: [
      { key: "crosstalkMode", label: "Talking over", type: "select",
        options: [["wide", "Go to the group/wide shot"], ["loudest", "Stay on the loudest"], ["hold", "Hold the current shot"]],
        help: "What to show when two or more people talk at once." },
      { key: "crosstalkMinSec", label: "Overlap time", min: 0.2, max: 4, step: 0.1, unit: "s",
        help: "Overlap must last this long to count as crosstalk." },
      { key: "asideSec", label: "Brief aside", min: 0, max: 5, step: 0.5, unit: "s",
        help: "Someone speaking briefly over a person who carries on afterwards isn't crosstalk unless it lasts this long: the shot stays on the person talking." },
      { key: "wideAfterSilenceSec", label: "Wide on pauses", min: 0, max: 10, step: 0.5, unit: "s", zero: "off",
        help: "Cut to the wide after this much silence. 0 = never." },
      { key: "openOnWideSec", label: "Open on wide", min: 0, max: 15, step: 0.5, unit: "s", zero: "off",
        help: "Start the show on the wide shot for this long." }
    ]},
    { title: "Reactions & interjections", open: false, controls: [
      { key: "interjectionMode", label: "Interjections", type: "select",
        options: [["reaction", "Cut to the person reacting"], ["wide", "Cut to the wide"], ["ignore", "Ignore (stay on speaker)"]],
        help: "“Yeah”, laughs and quick remarks while someone else holds the floor." },
      { key: "interjectionChance", label: "Reaction frequency", min: 0, max: 1, step: 0.05, unit: "%", pct: true,
        help: "Share of interjections that get a reaction shot." },
      { key: "reactionNoCloseup", label: "No close-up of them", type: "select",
        options: [["wide", "Cut to the wide"], ["skip", "Stay on the speaker"]],
        help: "When the person reacting has no camera of their own (or the dolly isn't on them)." },
      { key: "groupReactWide", label: "Several react at once", type: "select",
        options: [["true", "Always cut to the wide"], ["false", "Treat like one reaction"]],
        help: "Two or more people laughing or chiming in within a second of each other is a group moment: show the room." },
      { key: "interjectionMaxSec", label: "Interjection length", min: 0.3, max: 3, step: 0.1, unit: "s",
        help: "Speech bursts shorter than this, over someone else, count as interjections rather than a new turn." },
      { key: "reactionShotSec", label: "Reaction shot", min: 0.6, max: 4, step: 0.1, unit: "s",
        help: "How long a reaction shot stays up." },
      { key: "turnLookaheadSec", label: "Hold before next turn", min: 0, max: 10, step: 0.5, unit: "s", zero: "off",
        help: "No reaction or cutaway this close before someone else takes over (a question running into its answer): stay on the person talking, that cut is coming." }
    ]},
    { title: "Moving cameras", open: false, onlyIfMoving: true, controls: [
      { key: "steadyMaxPct", label: "Steady below", min: 0.1, max: 4, step: 0.05, unit: "%/s",
        help: "Camera motion under this (percent of frame width per second) counts as steady. Lower it to catch slower creeps; raise it if a slightly floaty dolly never counts as steady." },
      { key: "fastMinPct", label: "Big move above", min: 2, max: 30, step: 0.5, unit: "%/s",
        help: "Motion over this is a reposition or whip: always cut away from it." },
      { key: "settleSec", label: "Settle time", min: 0, max: 3, step: 0.1, unit: "s",
        help: "The camera must have been steady this long before PodCutter cuts to it." },
      { key: "guessFraming", label: "Who it's on", type: "select",
        options: [["true", "Whoever it settled on"], ["false", "Whoever is talking"]],
        help: "Without a Who's in the shot reading: an operated camera stays on the person it settled on until it moves again, so when someone else starts talking it's the wide until the operator swings round. \"Whoever is talking\" trusts the operator to always be on the speaker." },
      { key: "checkFramingByAudio", label: "Check names by voice", type: "select",
        options: [["true", "Yes"], ["false", "Trust the picture"]],
        help: "The picture reading can lump two people together and name a stretch after the wrong one. With this on, a steady stretch of 8 s or more \"on\" someone who barely speaks, while one other person does most of the talking, counts as on the person talking." },
      { key: "comeBackSec", label: "Come back after", min: 0, max: 10, step: 0.5, unit: "s", zero: "right away",
        help: "After a move, only go back to the moving camera if it then stays steady at least this long. Shorter stretches stay on the wide, so quick banter while the operator swings between people plays on the wide instead of flicking back and forth." },
      { key: "maxWaitSec", label: "Wait to settle", min: 0, max: 4, step: 0.1, unit: "s",
        help: "If a cut would land mid-move, hold the previous shot up to this long for the camera to settle. Longer moves go to the wide." },
      { key: "slowMovesOnAir", label: "Slow moves on air", type: "select",
        options: [[true, "Keep gentle push-ins/drifts on air"], [false, "Cut away from any movement"]],
        help: "Once on the moving camera, should gentle moves stay on screen?" },
      { key: "movePadSec", label: "Leave move early by", min: 0, max: 1, step: 0.05, unit: "s" }
    ]},
    { title: "Content cuts", open: false, controls: [
      { key: "changeCameraAtCuts", label: "Across a cut", type: "select",
        options: [["true", "Switch camera (hide the jump)"], ["false", "Leave as is"]],
        help: "Content cuts already in the timeline, and sections ticked on the Cleanup tab, join the shots on either side. Switching camera there hides the jump: off the wide to the person talking, or off a close-up to the wide." },
      { key: "jumpCoverSec", label: "Cover shot", min: 1, max: 8, step: 0.5, unit: "s",
        help: "How long the other camera stays up after a content cut before going back (or until the next natural cut)." }
    ]},
    { title: "Long monologues", open: false, controls: [
      { key: "maxShotSec", label: "Break shots over", min: 0, max: 60, step: 1, unit: "s", zero: "never",
        help: "Insert a cutaway when one shot runs longer than this. 0 = never." },
      { key: "cutawayMode", label: "Cutaway to", type: "select",
        options: [["mix", "Mix it up"], ["wide", "Wide shot"], ["reaction", "A listener"], ["alternate", "Speaker's other angle"]] },
      { key: "cutawaySec", label: "Cutaway length", min: 1, max: 8, step: 0.2, unit: "s" },
      { key: "angleVariety", label: "Multiple angles", type: "select",
        options: [["rotate", "Rotate each turn"], ["random", "Random"], ["first", "Always the first"]],
        help: "For speakers with more than one close-up camera." }
    ]},
    { title: "Voice detection", open: false, controls: [
      { key: "sensitivity", label: "Sensitivity", min: 0, max: 1, step: 0.05, unit: "%", pct: true,
        help: "For speakers on Auto threshold: higher picks up quieter speech." },
      { key: "crosstalkWindowDb", label: "Bleed rejection", min: 1, max: 20, step: 0.5, unit: "dB",
        help: "A mic this far below the loudest is treated as bleed, not speech. Lower = stricter." },
      { key: "attackSec", label: "Ignore blips under", min: 0.05, max: 1, step: 0.05, unit: "s",
        help: "Coughs, clicks and bumps shorter than this are ignored." },
      { key: "holdSec", label: "Bridge gaps under", min: 0.1, max: 2, step: 0.05, unit: "s",
        help: "Pauses between words shorter than this don't end a turn." },
      { key: "seed", label: "Variation seed", min: 1, max: 99, step: 1, unit: "",
        help: "Change to reshuffle random choices (reactions, angles) while keeping the same style." }
    ]}
  ],
  cleanupControls: [
    { key: "minConfidence", label: "Min confidence", min: 0, max: 1, step: 0.05, unit: "%", pct: true,
      help: "Hide suggestions below this confidence." },
    { key: "pauseSec", label: "Mistake starts after", min: 0.4, max: 4, step: 0.1, unit: "s",
      help: "A pause this long marks where a botched passage most likely began." },
    { key: "maxLookbackSec", label: "Look back up to", min: 5, max: 120, step: 5, unit: "s" },
    { key: "falseStartWords", label: "Restart match", min: 2, max: 6, step: 1, unit: "words",
      help: "Opening words that must repeat to count as a false start." },
    { key: "padSec", label: "Padding", min: 0, max: 1, step: 0.05, unit: "s" }
  ],
  colors: ["#4f8cff", "#f2994a", "#49c78a", "#bb6bd9", "#eb5757", "#f2c94c", "#56ccf2", "#9b9b9b", "#e07bb5", "#7bd389"],
  // Premiere marker colour index per camera (0 green,1 red,2 purple,3 orange,4 yellow,5 white,6 blue,7 cyan)
  markerColors: [6, 3, 0, 2, 1, 4, 7, 5]
};
