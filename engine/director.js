/*
 * PodCutter — multicam cutting engine.
 *
 * Pure JavaScript, no dependencies. Runs in the Premiere CEP panel, in Node
 * (CLI + tests) and anywhere else. Given one loudness curve (dB over time) per
 * speaker microphone and a description of which camera shows whom, it decides
 * which camera is on screen at every moment.
 *
 * Pipeline
 *   1. calibrate     per-mic noise floor / speech level -> auto threshold
 *   2. detect        per-frame "is talking", with bleed rejection
 *   3. smooth        hold (bridge word gaps) + attack (ignore clicks/coughs)
 *   4. classify      speech runs -> turns vs interjections
 *   5. floor model   who has the floor: solo / crosstalk / silence segments
 *   6. shots         segment -> camera (close-up rotation, wides, two-shots)
 *   7. interjections reaction shots of the person who laughed / said "yeah"
 *   8. cutaways      break up long monologues at the quietest breath
 *   9. timing        cut early (anticipate) or late (react), opening wide
 *  10. cleanup       minimum shot length, manual locks, frame snapping
 *
 * Ideas for steps 1, 8 and 10 are adapted from Cutcast (MIT, BoazCohenJ);
 * camera "shows" tagging is adapted from Podclip (MIT, Podclip contributors).
 */
(function (root, factory) {
  // CEP panels with Node enabled define both window and module: export to both.
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodCutter = api;
  else if (root) root.PodCutter = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SILENT_DB = -120;

  // ---------------------------------------------------------------- presets

  var DEFAULT_STYLE = {
    // Detection
    sensitivity: 0.5,          // 0..1, higher = quieter speech counts (auto thresholds)
    crosstalkWindowDb: 6,      // mics within this many dB of the loudest both count; further below = bleed
    attackSec: 0.2,            // speech must last this long to register (ignores clicks, coughs)
    holdSec: 0.6,              // bridge gaps between words shorter than this
    // Switching
    reactionDelaySec: 0.4,     // a new speaker must hold the floor this long before we switch
    cutTimingSec: -0.12,       // where the cut lands vs speech onset: negative = before (anticipate)
    minShotSec: 2.0,           // shortest shot allowed (absorbed into neighbours otherwise)
    maxCutsPerMin: 0,          // hard cap on cuts in any 60 s window (0 = no cap); drops the least important cuts first
    // Group / wide behaviour
    crosstalkMode: "wide",     // "wide" | "loudest" | "hold"
    crosstalkMinSec: 1.0,      // overlap must last this long before it counts as crosstalk
    asideSec: 2.0,             // ...or this long when the same person talks before and after it (a brief aside over them)
    minWideSec: 5.0,           // a wide shot stays up at least this long, running into the next shot if needed (0 = use minimum shot)
    wideAfterSilenceSec: 3.0,  // go wide after this much silence (0 = never)
    openOnWideSec: 3.0,        // open the show on the wide for this long (0 = off)
    // Interjections ("yeah", laughs, quick questions)
    interjectionMaxSec: 1.2,   // speech bursts shorter than this, over someone else, are interjections
    interjectionMode: "reaction", // "ignore" | "reaction" | "wide"
    interjectionChance: 0.6,   // 0..1 share of eligible interjections that get a shot
    reactionShotSec: 1.6,      // length of a reaction shot
    reactionNoCloseup: "wide", // "wide" | "skip": a reaction from someone without a usable close-up (the dolly is on the speaker)
    groupReactWide: true,      // two or more listeners reacting at once (a laugh round the table) always cut to the wide
    turnLookaheadSec: 4.0,     // no reaction or cutaway this close before the next turn: stay on the speaker, that cut is coming
    // Handoffs (two-camera shows): wide around the change of speaker, the new speaker's solo once they've settled in
    soloAfterSec: 0,           // a new speaker gets their solo this long into their turn; until then the wide (0 = straight away)
    wideLeadSec: 0,            // ...and the wide starts this long before they do, as the last speaker winds down
    // Long monologues
    maxShotSec: 18,            // break a single shot longer than this (0 = never)
    cutawayMode: "mix",        // "wide" | "reaction" | "alternate" | "mix"
    cutawaySec: 3.0,           // cutaway length
    // Angles
    angleVariety: "rotate",    // "first" | "rotate" | "random"  (speakers with several close-ups)
    wideBias: 0,               // -1..1: negative keeps to close-ups, positive favours the wide (some turns play on it)
    // Moving cameras (dolly, slider, handheld, operated cams) — needs camera motion analysis
    steadyMaxPct: 0.3,         // below this much camera motion (% of frame width per second) = steady (slow creep reads from ~0.2)
    fastMinPct: 6,             // above this = a real move/reposition; never on air
    settleSec: 0.6,            // camera must have been steady this long before we cut to it
    maxWaitSec: 1.5,           // hold the previous shot up to this long waiting for the camera to settle
    comeBackSec: 3.0,          // after a move, only go back to the moving camera if it then stays usable this long (banter: stay wide)
    slowMovesOnAir: false,     // once on the shot, may gentle moves (push-ins, drifts) stay on air? off: operator reframes look sloppy
    movePadSec: 0.2,           // leave a move this early / come back this late
    parkedSec: 2.0,            // a follow cam still on someone at least this long is parked on them: a safe zone, no settling needed
    parkedWideSec: 3.0,        // a wide that hands back to a follow cam parked on the talker only needs this long (not minWideSec)
    guessFraming: true,        // without "who's in the shot", a follow cam stays on whoever it settled on until it moves again
    checkFramingByAudio: true, // a long steady stretch "on" someone silent while another does the talking is on the talker
    // Cleanup cuts (sections that will be removed)
    changeCameraAtCuts: true,  // the shots either side of a removed section must be different cameras (no jump cut)
    jumpCoverSec: 3.0,         // how long the covering shot stays up before going back (or until the next cut)
    // Misc
    seed: 7,
    snapToFrames: true
  };

  // Modes: a starting point for the whole style. "needs" flags a camera setup the mode relies on;
  // "fast" modes allow close-ups under 2 s (the panel's Minimum close-up range follows it).
  var PRESETS = {
    balanced: { label: "Balanced discussion", description: "The default: follows the conversation, wides on overlaps and long pauses.", style: {} },
    calm: {
      label: "Calm discussion",
      description: "Long, unhurried shots. Waits before switching, ignores small reactions, breaks long answers with the wide.",
      style: { reactionDelaySec: 0.8, minShotSec: 3.5, crosstalkMinSec: 1.6, wideAfterSilenceSec: 4,
               interjectionMode: "ignore", interjectionChance: 0.3, maxShotSec: 30, cutawayMode: "wide",
               cutawaySec: 4, cutTimingSec: -0.05, holdSec: 0.9, wideBias: 0.3 }
    },
    lively: {
      label: "Lively discussion",
      description: "Banter and back-and-forth: quick switches, plenty of reaction shots.",
      fast: true,
      style: { reactionDelaySec: 0.25, minShotSec: 1.4, crosstalkMinSec: 0.7, wideAfterSilenceSec: 2,
               interjectionMode: "reaction", interjectionChance: 0.85, reactionShotSec: 1.3, maxShotSec: 12,
               cutawayMode: "mix", cutawaySec: 2.4, cutTimingSec: -0.15, holdSec: 0.45, wideBias: -0.2 }
    },
    rapid: {
      label: "Rapid cutting",
      description: "Cuts straight to whoever speaks or reacts, staying on close-ups. Needs a static close-up camera on each person.",
      needs: "closeups", fast: true,
      style: { reactionDelaySec: 0.2, minShotSec: 1.0, crosstalkMode: "loudest", crosstalkMinSec: 0.5, wideAfterSilenceSec: 0,
               minWideSec: 2, openOnWideSec: 2, interjectionMode: "reaction", interjectionChance: 0.9, reactionShotSec: 1.1,
               maxShotSec: 8, cutawayMode: "reaction", cutawaySec: 1.8, cutTimingSec: -0.15, holdSec: 0.35, wideBias: -0.7 }
    },
    interview: {
      label: "Interview",
      description: "A host asks, a guest answers at length. Holds on the answer, cuts to the host listening now and then. Raise the guest's Feature slider.",
      style: { reactionDelaySec: 0.6, minShotSec: 2.5, crosstalkMode: "hold", crosstalkMinSec: 1.4, wideAfterSilenceSec: 4,
               interjectionMode: "reaction", interjectionChance: 0.35, reactionShotSec: 1.8, maxShotSec: 20,
               cutawayMode: "reaction", cutawaySec: 3, holdSec: 0.8 }
    },
    hostFocus: {
      label: "Stay on the speaker",
      description: "Only cuts when the speaker changes: no cutaways, no reactions, no pause wides.",
      style: { reactionDelaySec: 0.6, minShotSec: 2.5, crosstalkMode: "loudest", wideAfterSilenceSec: 0,
               interjectionMode: "ignore", maxShotSec: 0, openOnWideSec: 2, wideBias: -0.3 }
    },
    trio: {
      label: "Three people",
      description: "Balanced, tuned for three voices.",
      style: { reactionDelaySec: 0.35, minShotSec: 2, crosstalkMinSec: 0.9, interjectionChance: 0.5, maxShotSec: 16,
               wideAfterSilenceSec: 3 }
    },
    panel: {
      label: "Roundtable (4+ people)",
      description: "Busy tables: shorter shots, more wides to keep everyone in the picture.",
      style: { reactionDelaySec: 0.35, minShotSec: 2, crosstalkMinSec: 0.7, wideAfterSilenceSec: 2.5, interjectionChance: 0.4,
               maxShotSec: 15, cutawayMode: "wide", openOnWideSec: 4, wideBias: 0.2 }
    },
    solo: {
      label: "Solo / monologue",
      description: "One person talking: holds the shot, changes angle now and then to keep it moving.",
      style: { reactionDelaySec: 0.6, minShotSec: 3, crosstalkMode: "hold", wideAfterSilenceSec: 0, interjectionMode: "ignore",
               maxShotSec: 20, cutawayMode: "mix", cutawaySec: 4, openOnWideSec: 3 }
    },
    handoff: {
      label: "Wide + dolly handoffs",
      description: "Learned from 35 finished Classical et cetera edits and their dolly footage: the wide around each change of speaker, the new speaker's solo once they've settled in, short turns on the wide, long unhurried shots. For a static wide plus an operated camera.",
      needs: "wide",
      style: { soloAfterSec: 4.5, wideLeadSec: 1.5, crosstalkMinSec: 3, minWideSec: 9, parkedWideSec: 4.5, minShotSec: 8, comeBackSec: 1.5,
               interjectionMode: "reaction", interjectionChance: 0, groupReactWide: true, maxShotSec: 0 }
    },
    social: {
      label: "Social clips",
      description: "Very fast cutting for short vertical clips.",
      fast: true,
      style: { reactionDelaySec: 0.15, minShotSec: 1.0, crosstalkMinSec: 0.6, wideAfterSilenceSec: 1.5,
               openOnWideSec: 0, interjectionMode: "reaction", interjectionChance: 1, reactionShotSec: 1.0,
               maxShotSec: 7, cutawayMode: "alternate", cutawaySec: 2, cutTimingSec: -0.18, holdSec: 0.35, wideBias: -0.5 }
    }
  };
  /** Style preset that suits a given number of people on mic. */
  function presetForSubjects(n) { return n <= 1 ? "solo" : n === 2 ? "balanced" : n === 3 ? "trio" : "panel"; }

  var DEFAULT_SPEAKER = {
    thresholdDb: null,      // null = auto-calibrate
    biasDb: 0,              // feature, -10..10: positive = more screen time (wins close calls, switched to sooner,
                            // shown reacting/listening more, cut away from less); negative = less
    minShotSec: null,       // override global minimum for this speaker's shots
    interjections: true,    // can this speaker's "yeah"/laughs trigger reaction shots
    reactionShots: true,    // may be shown listening (cutaways / reactions)
    enabled: true           // false = ignore this mic entirely
  };

  function merge(base) {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
    }
    return out;
  }

  function styleFromPreset(name, overrides) {
    var preset = PRESETS[name] || PRESETS.balanced;
    return merge(DEFAULT_STYLE, preset.style, overrides);
  }

  /**
   * wideBias leans the detailed settings toward the wide or the close-ups. Toward the wide, overlaps and pauses
   * reach the wide sooner and it stays up longer; toward close-ups, they need longer and the strongest setting
   * stays on the loudest voice when people talk over each other. (Turns played on the wide: buildShots.)
   */
  function applyWideBias(style) {
    var b = clamp(Number(style.wideBias) || 0, -1, 1);
    if (!b) return style;
    var s = merge(style);
    if (b > 0) {
      s.crosstalkMinSec = style.crosstalkMinSec * (1 - 0.5 * b);
      if (style.wideAfterSilenceSec > 0) s.wideAfterSilenceSec = style.wideAfterSilenceSec * (1 - 0.5 * b);
      s.minWideSec = (style.minWideSec || 0) * (1 + 0.6 * b);
    } else {
      var k = -b;
      s.crosstalkMinSec = style.crosstalkMinSec * (1 + 1.5 * k);
      if (style.wideAfterSilenceSec > 0) s.wideAfterSilenceSec = style.wideAfterSilenceSec * (1 + 2 * k);
      s.minWideSec = (style.minWideSec || 0) * (1 - 0.6 * k);
      if (k >= 0.75 && style.crosstalkMode === "wide") s.crosstalkMode = "loudest";
    }
    return s;
  }

  /** A speaker's feature setting (biasDb) as -1..1. */
  function featureOf(sp) { return clamp((Number(sp && sp.biasDb) || 0) / 10, -1, 1); }

  // ------------------------------------------------------------------ utils

  function percentile(values, p) {
    if (!values.length) return SILENT_DB;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Small deterministic RNG (mulberry32) so the same settings give the same cut.
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) < 0) return false;
    return true;
  }
  function isSuperset(big, small) {
    for (var i = 0; i < small.length; i++) if (big.indexOf(small[i]) < 0) return false;
    return true;
  }

  // ------------------------------------------------------ 1. calibration

  function calibrate(curves, speakers, style) {
    var stats = speakers.map(function (sp) {
      var c = curves[sp.id] || [];
      var valid = [];
      // Subsample long curves for speed; percentiles don't need every frame.
      var stride = Math.max(1, Math.floor(c.length / 40000));
      for (var i = 0; i < c.length; i += stride) if (c[i] > -100) valid.push(c[i]);
      return { floor: percentile(valid, 0.10), speech: percentile(valid, 0.98), coverage: valid.length };
    });
    var loudest = -Infinity;
    stats.forEach(function (s) { if (s.coverage && s.speech > loudest) loudest = s.speech; });
    var sens = clamp(style.sensitivity, 0, 1);
    return speakers.map(function (sp, i) {
      var s = stats[i];
      // A mic that only ever hears the others would otherwise treat bleed as its speech level.
      var reference = Math.max(s.speech, loudest - 10);
      var range = Math.max(12, reference - s.floor);
      var auto = s.floor + range * (0.6 - 0.4 * sens);
      var threshold = (sp.thresholdDb === null || sp.thresholdDb === undefined || sp.thresholdDb === "auto")
        ? auto : Number(sp.thresholdDb);
      return {
        id: sp.id, floorDb: round1(s.floor), speechDb: round1(s.speech), referenceDb: round1(reference),
        autoThresholdDb: round1(auto), thresholdDb: round1(threshold)
      };
    });
  }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  // ------------------------------------------------- 2+3. detect + smooth

  function detectActivity(curves, speakers, cal, style, frames) {
    var n = speakers.length;
    var raw = speakers.map(function () { return new Uint8Array(frames); });
    var rel = new Float32Array(n);
    var above = new Uint8Array(n);
    for (var t = 0; t < frames; t++) {
      var loudestRel = -Infinity;
      for (var s = 0; s < n; s++) {
        var c = curves[speakers[s].id];
        var db = c && t < c.length ? c[t] : SILENT_DB;
        above[s] = db > cal[s].thresholdDb ? 1 : 0;
        rel[s] = db - cal[s].referenceDb + (speakers[s].biasDb || 0);
        if (above[s] && rel[s] > loudestRel) loudestRel = rel[s];
      }
      for (s = 0; s < n; s++) {
        if (above[s] && rel[s] >= loudestRel - style.crosstalkWindowDb) raw[s][t] = 1;
      }
    }
    return raw;
  }

  /** Fill gaps <= maxGap frames, then drop runs < minRun frames. Returns runs [[start,end), ...]. */
  function smoothRuns(active, maxGap, minRun) {
    var runs = [];
    var start = -1;
    for (var t = 0; t <= active.length; t++) {
      var on = t < active.length && active[t] === 1;
      if (on && start < 0) start = t;
      if (!on && start >= 0) { runs.push([start, t]); start = -1; }
    }
    var bridged = [];
    for (var i = 0; i < runs.length; i++) {
      var last = bridged[bridged.length - 1];
      if (last && runs[i][0] - last[1] <= maxGap) last[1] = runs[i][1];
      else bridged.push([runs[i][0], runs[i][1]]);
    }
    return bridged.filter(function (r) { return r[1] - r[0] >= minRun; });
  }

  // ---------------------------------------------------- 4. classify runs

  function classifyRuns(runsBySpeaker, speakers, style, fr) {
    var maxInterj = Math.round(style.interjectionMaxSec * fr);
    var near = Math.round(Math.max(style.holdSec, 0.5) * fr);
    // A run is an interjection if it's short and someone else is talking around it.
    function othersTalking(si, a, b) {
      for (var o = 0; o < runsBySpeaker.length; o++) {
        if (o === si) continue;
        var rs = runsBySpeaker[o];
        for (var k = 0; k < rs.length; k++) {
          var r = rs[k];
          if (r[1] - r[0] <= maxInterj) continue; // another short burst doesn't hold the floor
          if (r[0] <= a + near && r[1] >= b - near) return true;
        }
      }
      return false;
    }
    var main = [], interj = [];
    runsBySpeaker.forEach(function (runs, si) {
      main.push([]);
      runs.forEach(function (r) {
        if (r[1] - r[0] <= maxInterj && othersTalking(si, r[0], r[1])) {
          interj.push({ speaker: si, start: r[0], end: r[1] });
        } else {
          main[si].push(r);
        }
      });
    });
    interj.sort(function (a, b) { return a.start - b.start; });
    return { main: main, interjections: interj };
  }

  // ------------------------------------------------------ 5. floor model

  function floorSegments(mainRuns, speakers, style, fr, frames) {
    var n = speakers.length;
    // Per-frame active set (bitmask) from the main runs.
    var mask = new Uint32Array(frames);
    for (var s = 0; s < n; s++) {
      mainRuns[s].forEach(function (r) {
        for (var t = r[0]; t < Math.min(r[1], frames); t++) mask[t] |= (1 << s);
      });
    }
    // Run-length encode.
    var segs = [];
    var cur = -1, start = 0;
    for (var t = 0; t <= frames; t++) {
      var m = t < frames ? mask[t] : -2;
      if (m !== cur) {
        if (t > 0) segs.push({ start: start, end: t, mask: cur });
        cur = m; start = t;
      }
    }
    segs.forEach(function (sg) {
      sg.speakers = [];
      for (var s2 = 0; s2 < n; s2++) if (sg.mask & (1 << s2)) sg.speakers.push(s2);
      sg.kind = sg.speakers.length === 0 ? "silence" : (sg.speakers.length === 1 ? "solo" : "group");
      sg.onset = true;
    });

    // Short overlaps are not crosstalk: give them to whoever already had the floor.
    // An aside (someone speaks briefly over a person who carries on afterwards) isn't crosstalk either.
    var minX = Math.round(style.crosstalkMinSec * fr), aside = Math.round(Math.max(style.asideSec || 0, style.crosstalkMinSec) * fr);
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      var prev = segs[i - 1], next = segs[i + 1];
      var heldThrough = prev && next && prev.kind === "solo" && next.kind === "solo" && prev.speakers[0] === next.speakers[0] &&
        g.speakers.indexOf(prev.speakers[0]) >= 0;
      if (g.kind !== "group" || g.end - g.start >= (heldThrough ? aside : minX)) continue;
      var holder = null;
      if (prev && prev.kind === "solo" && g.speakers.indexOf(prev.speakers[0]) >= 0) holder = prev.speakers[0];
      else if (next && next.kind === "solo" && g.speakers.indexOf(next.speakers[0]) >= 0) holder = next.speakers[0];
      else holder = g.speakers[0];
      g.kind = "solo"; g.speakers = [holder];
    }
    segs = mergeSegs(segs);

    // Silence: hold the shot, or go wide once it has lasted wideAfterSilenceSec.
    var wideAfter = Math.round(style.wideAfterSilenceSec * fr);
    var minShot = Math.round(style.minShotSec * fr);
    var out = [];
    segs.forEach(function (sg, idx) {
      if (sg.kind !== "silence") { out.push(sg); return; }
      var isLeading = idx === 0;
      if (wideAfter > 0 && sg.end - sg.start > wideAfter && !isLeading) {
        // Start the wide early enough that it survives the minimum shot length.
        var wideStart = sg.start + wideAfter;
        if (sg.end - wideStart < minShot) wideStart = Math.max(sg.start + Math.round(0.5 * fr), sg.end - minShot);
        out.push({ start: sg.start, end: wideStart, kind: "hold", speakers: [], onset: false });
        out.push({ start: wideStart, end: sg.end, kind: "pause", speakers: [], onset: false });
      } else {
        out.push({ start: sg.start, end: sg.end, kind: isLeading ? "pause" : "hold", speakers: [], onset: false });
      }
    });
    segs = mergeSegs(out);

    // Reaction delay: a speaker change that doesn't last long enough isn't a switch. Featured speakers are switched to sooner.
    for (i = 1; i < segs.length; i++) {
      var sgm = segs[i];
      if (sgm.kind !== "solo") continue;
      var delay = Math.round(style.reactionDelaySec * (1 - 0.5 * featureOf(speakers[sgm.speakers[0]])) * fr);
      if (sgm.end - sgm.start < delay) {
        // keep only if the speaker keeps talking after a brief hold (handled by merge)
        var after = segs[i + 1];
        var continues = after && after.kind === "hold" && segs[i + 2] && segs[i + 2].kind === "solo" &&
          segs[i + 2].speakers[0] === sgm.speakers[0];
        if (!continues) { sgm.kind = "hold"; sgm.speakers = []; sgm.onset = false; }
      }
    }
    return mergeSegs(segs);
  }

  function segKey(sg) { return sg.kind + ":" + sg.speakers.join(","); }
  function mergeSegs(segs) {
    var out = [];
    segs.forEach(function (sg) {
      if (sg.end <= sg.start) return;
      var last = out[out.length - 1];
      if (last && segKey(last) === segKey(sg) && last.end === sg.start) last.end = sg.end;
      else out.push({ start: sg.start, end: sg.end, kind: sg.kind, speakers: sg.speakers.slice(), onset: sg.onset });
    });
    return out;
  }

  // ------------------------------------------------------- 6. cameras

  function cameraIndex(cameras, speakers) {
    var ids = speakers.map(function (s) { return s.id; });
    var cams = cameras.filter(function (c) { return c.enabled !== false; }).map(function (c) {
      var shows = (c.shows || []).map(function (id) { return ids.indexOf(id); }).filter(function (x) { return x >= 0; });
      return { cam: c, shows: shows };
    });
    // "Follow" cams (an operator re-frames on whoever is talking) count as a close-up of every speaker,
    // but never as a group shot and never as a listener/reaction shot.
    var fixed = cams.filter(function (c) { return !c.cam.follows; });
    var follow = cams.filter(function (c) { return c.cam.follows; });
    var widest = null;
    (fixed.length ? fixed : cams).forEach(function (c) { if (!widest || c.shows.length > widest.shows.length) widest = c; });
    function fixedCloseups(si) {
      return fixed.filter(function (c) { return c.shows.length === 1 && c.shows[0] === si; }).map(function (c) { return c.cam.id; });
    }
    return {
      list: cams,
      widest: widest ? widest.cam.id : null,
      hasWide: !!(widest && widest.shows.length > 1),
      isFollow: function (id) { return follow.some(function (c) { return c.cam.id === id; }); },
      fixedCloseups: fixedCloseups,
      closeups: function (si) {
        return fixedCloseups(si).concat(follow.map(function (c) { return c.cam.id; }));
      },
      cover: function (set) {
        if (set.length === 1 && follow.length && !fixedCloseups(set[0]).length) {
          var direct = fixed.filter(function (c) { return sameSet(c.shows, set); });
          if (!direct.length) return follow[0].cam.id;
        }
        var best = null;
        fixed.forEach(function (c) {
          if (sameSet(c.shows, set)) { if (!best || best.exact !== true) best = { id: c.cam.id, size: c.shows.length, exact: true }; return; }
          if (isSuperset(c.shows, set) && (!best || (!best.exact && c.shows.length < best.size))) best = { id: c.cam.id, size: c.shows.length };
        });
        return best ? best.id : null;
      }
    };
  }

  function buildShots(segs, speakers, cameras, style, ctx) {
    var ci = cameraIndex(cameras, speakers);
    var rand = ctx.rand;
    var rotation = {};
    var current = null;
    var shots = [];

    function closeupFor(si, avoid) {
      var list = ci.closeups(si);
      if (!list.length) return ci.cover([si]);
      if (list.length === 1 || style.angleVariety === "first") return list[0];
      if (style.angleVariety === "random") {
        var pool = list.filter(function (id) { return id !== avoid; });
        return pool[Math.floor(rand() * pool.length)] || list[0];
      }
      rotation[si] = ((rotation[si] === undefined ? -1 : rotation[si]) + 1) % list.length;
      return list[rotation[si]];
    }

    // Toward the wide, a share of speaker turns plays on it (own RNG so other random choices don't shift).
    var wideShare = ci.hasWide ? Math.max(0, Number(style.wideBias) || 0) * 0.5 : 0;
    var wideRand = rng((style.seed || 1) + 7919);
    var minTurn = Math.round(Math.max(style.minShotSec, 2) * ctx.fr);

    segs.forEach(function (sg) {
      var cam = null, reason = sg.kind;
      if (sg.kind === "solo") {
        var si = sg.speakers[0];
        var already = current && current.speakers && current.speakers.length === 1 && current.speakers[0] === si;
        reason = "speaker";
        if (already) { cam = current.cameraId; reason = current.reason === "wide-turn" ? "wide-turn" : "speaker"; }
        else if (wideShare > 0 && sg.end - sg.start >= minTurn &&
                 wideRand() < wideShare * (1 - 0.5 * Math.max(0, featureOf(speakers[si])))) {
          cam = ci.widest; reason = "wide-turn";
        } else cam = closeupFor(si, current && current.cameraId);
      } else if (sg.kind === "group") {
        reason = "crosstalk";
        if (style.crosstalkMode === "wide") cam = ci.cover(sg.speakers) || ci.widest;
        else if (style.crosstalkMode === "loudest") {
          var loud = loudestOver(ctx, sg.speakers, sg.start, sg.end);
          cam = (current && current.speakers && current.speakers.length === 1 && current.speakers[0] === loud)
            ? current.cameraId : closeupFor(loud);
        } else cam = current ? current.cameraId : ci.cover(sg.speakers);
      } else if (sg.kind === "pause") {
        reason = "pause";
        cam = ci.hasWide ? ci.widest : (current ? current.cameraId : ci.widest);
      } else { // hold
        reason = current ? current.reason : "pause";
        cam = current ? current.cameraId : ci.widest;
      }
      if (!cam) cam = current ? current.cameraId : ci.widest;
      var shot = { start: sg.start, end: sg.end, cameraId: cam, reason: reason,
                   speakers: sg.kind === "hold" && current ? current.speakers : sg.speakers.slice(),
                   onset: sg.onset && sg.kind !== "hold" };
      if (sg.kind === "hold" && current) shot.reason = current.reason;
      shots.push(shot);
      current = shot;
    });
    return { shots: mergeShots(shots), ci: ci };
  }

  function loudestOver(ctx, set, a, b) {
    var best = set[0], bestV = -Infinity;
    set.forEach(function (si) {
      var c = ctx.curves[ctx.speakers[si].id] || [];
      var sum = 0, n = 0;
      for (var t = a; t < b && t < c.length; t++) { sum += c[t] - ctx.cal[si].referenceDb; n++; }
      var v = (n ? sum / n : -Infinity) + (ctx.speakers[si].biasDb || 0);
      if (v > bestV) { bestV = v; best = si; }
    });
    return best;
  }

  function mergeShots(shots) {
    var out = [];
    shots.forEach(function (s) {
      if (s.end <= s.start) return;
      var last = out[out.length - 1];
      if (last && last.cameraId === s.cameraId && last.end === s.start && !last.locked && !s.locked &&
          (last.reason === "reaction") === (s.reason === "reaction")) {
        last.end = s.end;
        // A shot that opens on a breath or overlap but settles on one speaker is a speaker shot.
        if ((last.reason === "pause" || last.reason === "hold" || last.reason === "crosstalk") && (s.reason === "speaker" || s.reason === "wide-turn")) {
          last.reason = s.reason; last.speakers = s.speakers.slice();
        } else if (last.reason === "speaker" && s.reason === "speaker") {
          // e.g. a follow cam that stays up across a change of speaker
          (s.speakers || []).forEach(function (x) { if (last.speakers.indexOf(x) < 0) last.speakers.push(x); });
        }
      } else out.push(copyShot(s));
    });
    return out;
  }
  function copyShot(s) {
    return { start: s.start, end: s.end, cameraId: s.cameraId, reason: s.reason,
             speakers: (s.speakers || []).slice(), onset: !!s.onset, locked: !!s.locked, keepShort: !!s.keepShort };
  }

  /** Replace [a,b) with a new shot, splitting whatever was there. */
  function insertShot(shots, ins) {
    var out = [];
    shots.forEach(function (s) {
      if (s.end <= ins.start || s.start >= ins.end) { out.push(s); return; }
      if (s.start < ins.start) { var l = copyShot(s); l.end = ins.start; out.push(l); }
      if (s.end > ins.end) { var r = copyShot(s); r.start = ins.end; r.onset = false; out.push(r); }
    });
    out.push(ins);
    out.sort(function (x, y) { return x.start - y.start; });
    return out;
  }

  function shotAt(shots, t) {
    var lo = 0, hi = shots.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (shots[mid].end <= t) lo = mid + 1;
      else if (shots[mid].start > t) hi = mid - 1;
      else return shots[mid];
    }
    return null;
  }

  // ---------------------------------------------------- 7. interjections

  function applyInterjections(shots, interj, speakers, style, ctx) {
    if (style.interjectionMode === "ignore") return shots;
    var fr = ctx.fr;
    var len = Math.round(style.reactionShotSec * fr);
    var lead = Math.round(0.15 * fr);
    var lastEnd = -Infinity, near = Math.round(1.0 * fr), used = {};
    var ci = ctx.ci;
    interj.forEach(function (ij, idx) {
      if (used[idx]) return;
      var sp = speakers[ij.speaker];
      if (!sp.interjections) return;
      // Several listeners reacting together (a laugh round the table) is a group moment: the wide, every time.
      var group = [idx];
      if (style.groupReactWide && ci.hasWide) {
        interj.forEach(function (o, k) {
          if (k !== idx && !used[k] && o.speaker !== ij.speaker && speakers[o.speaker].interjections &&
              o.start <= ij.end + near && o.end >= ij.start - near) group.push(k);
        });
      }
      group.forEach(function (k) { used[k] = true; });
      // The same short bump on several mics at the same instant is one sound heard everywhere (a knock, a cough, the
      // speaker's own laugh bleeding into the other mics), not people reacting: no shot at all.
      var sync = Math.round(0.15 * fr), blip = Math.round(0.6 * fr);
      if (group.length > 1 && group.every(function (k) { var o = interj[k]; return o.end - o.start < blip && Math.abs(o.start - ij.start) <= sync; })) return;
      var isGroup = group.length > 1;
      var roll = ctx.rand();
      if (!isGroup && roll > style.interjectionChance * (1 + featureOf(sp))) return;
      var gs = ij.start, ge = ij.end;
      group.forEach(function (k) { gs = Math.min(gs, interj[k].start); ge = Math.max(ge, interj[k].end); });
      var host = shotAt(shots, gs);
      if (!host || host.locked || host.reason === "crosstalk" || host.reason === "pause") return;
      if (!isGroup && host.speakers.length === 1 && host.speakers[0] === ij.speaker) return; // already on them
      var a = Math.max(gs - lead, host.start);
      var b = Math.min(Math.max(ge + lead, a + len), host.end);
      if (a < lastEnd + Math.round(style.minShotSec * fr)) return; // don't stack reactions
      // Leave room so the host shot survives on both sides, and stay on the speaker when the next turn is about to
      // start anyway (a question running into its answer): that cut is coming, a reaction just before it is churn.
      var room = Math.round(Math.min(style.minShotSec, 1.0) * fr);
      if (a - host.start < room || host.end - b < Math.max(room, Math.round(style.turnLookaheadSec * fr))) return;
      var cam = null, reason = "reaction";
      if (isGroup || style.interjectionMode === "wide") { cam = ci.widest; reason = "interjection-wide"; }
      else {
        cam = ci.fixedCloseups(ij.speaker)[0] || framedOn(ctx, ij.speaker, a, b);
        // Same camera is fine only for a follow cam that's pointed at the listener (it'll be off the speaker anyway).
        if (!cam || (cam === host.cameraId && !ci.isFollow(cam))) {
          // No usable close-up of them (the dolly is on the speaker): show the reaction on the wide instead.
          if (style.reactionNoCloseup !== "skip" && ci.hasWide) { cam = ci.widest; reason = "interjection-wide"; } else return;
        }
      }
      if (!cam || (cam === host.cameraId && !ci.isFollow(cam))) return; // already on that shot
      shots = insertShot(shots, { start: a, end: b, cameraId: cam, reason: reason,
        speakers: group.map(function (k) { return interj[k].speaker; }), onset: false, locked: false, keepShort: true });
      lastEnd = b;
    });
    return shots;
  }

  /**
   * A follow cam picked for two speakers in a row makes one long shot. Split it where the floor changes hands, so
   * a "monologue" is one person's turn (not a whole exchange) and each piece is checked against its own speaker.
   */
  function splitByFloor(shots, ctx) {
    var out = [];
    shots.forEach(function (s) {
      if (s.locked || s.reason !== "speaker" || !s.speakers || s.speakers.length < 2) { out.push(s); return; }
      var fl = ctx.floor, from = s.start, who = -1;
      for (var f = s.start; f < s.end; f++) {
        var w = fl[f];
        if (w < 0) continue;
        if (who >= 0 && w !== who) {
          var p = copyShot(s); p.start = from; p.end = f; p.speakers = [who]; p.onset = s.onset && from === s.start;
          out.push(p); from = f;
        }
        who = w;
      }
      var last = copyShot(s); last.start = from; last.onset = s.onset && from === s.start;
      if (who >= 0) last.speakers = [who];
      out.push(last);
    });
    return out;
  }

  // ------------------------------------------------------- 8. cutaways

  function applyCutaways(shots, speakers, style, ctx) {
    if (!(style.maxShotSec > 0)) return shots;
    var fr = ctx.fr;
    var cutLen = Math.round(style.cutawaySec * fr);
    var minShot = Math.round(style.minShotSec * fr);
    var result = [];
    var pick = 0;
    shots.forEach(function (s) {
      var length = s.end - s.start;
      var onWide = s.reason === "wide-turn";
      // Featured speakers are cut away from less (up to twice as long between cutaways).
      var f = s.speakers.length === 1 ? featureOf(speakers[s.speakers[0]]) : 0;
      var maxLen = Math.round(style.maxShotSec * (f > 0 ? 1 + f : 1 + 0.5 * f) * fr);
      if (s.locked || (s.reason !== "speaker" && !onWide) || length <= maxLen) { result.push(s); return; }
      var count = Math.floor(length / maxLen);
      var cursor = s.start;
      var first = true;
      for (var k = 1; k <= count; k++) {
        var target = s.start + Math.round(length * k / (count + 1)) - (cutLen >> 1);
        var at = quietestFrame(ctx, target, cursor + minShot, s.end - Math.max(minShot, Math.round(style.turnLookaheadSec * fr)) - cutLen);
        if (at === null) continue;
        // A turn played on the wide breaks to the speaker's close-up instead.
        var cam = onWide ? ctx.ci.closeups(s.speakers[0])[0] : cutawayCamera(s, speakers, style, ctx, pick++);
        if (!cam || cam === s.cameraId) continue;
        var left = copyShot(s); left.start = cursor; left.end = at; left.onset = first && s.onset; first = false;
        result.push(left);
        result.push({ start: at, end: at + cutLen, cameraId: cam, reason: "cutaway", speakers: s.speakers.slice(), onset: false, locked: false });
        cursor = at + cutLen;
      }
      var rest = copyShot(s); rest.start = cursor; rest.onset = first && s.onset;
      result.push(rest);
    });
    return result;
  }

  function cutawayCamera(s, speakers, style, ctx, n) {
    var ci = ctx.ci;
    var si = s.speakers[0];
    var listeners = [], weights = [], total = 0;
    for (var i = 0; i < speakers.length; i++) {
      if (i !== si && speakers[i].reactionShots !== false && ci.fixedCloseups(i).length) {
        // Featured listeners are picked more often (up to 3x), played-down ones less.
        var w = Math.pow(3, featureOf(speakers[i]));
        listeners.push(i); weights.push(w); total += w;
      }
    }
    var listener = null;
    if (listeners.length) {
      var r = ctx.rand() * total;
      for (var j = 0; j < listeners.length; j++) { r -= weights[j]; if (r < 0 || j === listeners.length - 1) { listener = listeners[j]; break; } }
    }
    var alt = ci.closeups(si).filter(function (id) { return id !== s.cameraId; });
    var options = {
      wide: ci.hasWide ? ci.widest : null,
      reaction: listener !== null ? ci.fixedCloseups(listener)[0] : null,
      alternate: alt.length ? alt[n % alt.length] : null
    };
    var order;
    if (style.cutawayMode === "mix") {
      var cycle = ["wide", "reaction", "alternate"];
      order = cycle.slice(n % 3).concat(cycle.slice(0, n % 3));
    } else order = [style.cutawayMode, "wide", "alternate", "reaction"];
    for (var k = 0; k < order.length; k++) if (options[order[k]]) return options[order[k]];
    return null;
  }

  /** Frame in [min,max] closest to target where all mics are quietest (cut on a breath). */
  function quietestFrame(ctx, target, min, max) {
    if (max < min) return null;
    var win = Math.round(4 * ctx.fr);
    var from = Math.max(min, target - win), to = Math.min(max, target + win);
    if (to < from) return clamp(target, min, max);
    var best = from, bestScore = Infinity;
    var step = Math.max(1, Math.round(ctx.fr / 20));
    for (var t = from; t <= to; t += step) {
      var loud = -Infinity;
      for (var s = 0; s < ctx.speakers.length; s++) {
        var c = ctx.curves[ctx.speakers[s].id];
        if (c && t < c.length && c[t] > loud) loud = c[t];
      }
      var score = loud + Math.abs(t - target) / ctx.fr * 1.5;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // -------------------------------------------------------- 9. timing

  function applyTiming(shots, style, ctx) {
    var off = Math.round(style.cutTimingSec * ctx.fr);
    if (off !== 0) {
      for (var i = 1; i < shots.length; i++) {
        var s = shots[i];
        if (!s.onset || s.locked || shots[i - 1].locked) continue;
        // The wide is the safety shot: a cut to it can come early (anticipate) but is never made to wait.
        if (off > 0 && s.cameraId === ctx.ci.widest) continue;
        var prev = shots[i - 1];
        var nb = clamp(s.start + off, prev.start + 1, s.end - 1);
        prev.end = nb; s.start = nb;
      }
    }
    var open = Math.round(style.openOnWideSec * ctx.fr);
    if (open > 0 && ctx.ci.hasWide && shots.length) {
      var firstEnd = Math.min(open, shots[shots.length - 1].end);
      // Extend to the next natural cut if it's close, to avoid a tiny leftover.
      var s0 = shotAt(shots, firstEnd);
      if (s0 && s0.end - firstEnd < Math.round(style.minShotSec * ctx.fr)) firstEnd = s0.end;
      shots = insertShot(shots, { start: 0, end: firstEnd, cameraId: ctx.ci.widest, reason: "opening", speakers: [], onset: false, locked: false });
    }
    return shots;
  }

  // ------------------------------------------------ 9b. moving cameras

  var STEADY = 0, SLOW = 1, FAST = 2;

  /** Per moving camera: motion curve -> steady/slow/fast state on the decision grid. */
  function buildStability(input, cameras, style, ctx) {
    var out = {}, info = {};
    var motion = input.cameraMotion || {};
    cameras.forEach(function (c) {
      var m = motion[c.id];
      if (!c.moving || !m || !m.values || !m.values.length) return;
      var v = m.values, n = v.length, mhop = m.hopSec;
      // Median over ~0.8 s ignores single-frame glitches (a hand crossing frame, a compression hiccup).
      var med = new Float32Array(n), known = 0;
      for (var i = 0; i < n; i++) {
        var win = [];
        for (var k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) if (!isNaN(v[k])) win.push(v[k]);
        win.sort(function (a, b) { return a - b; });
        med[i] = win.length ? win[win.length >> 1] : NaN;
        if (!isNaN(v[i])) known++;
      }
      // If the picture is usually readable, an unreadable stretch means something big is changing:
      // treat it as a slow move. If it's rarely readable (plain backdrop), we can't judge: assume steady.
      var readable = known / n >= 0.5;
      var st = new Uint8Array(n), counts = [0, 0, 0];
      for (i = 0; i < n; i++) {
        var x = med[i];
        st[i] = isNaN(x) ? (readable ? SLOW : STEADY) : (x >= style.fastMinPct ? FAST : (x > style.steadyMaxPct ? SLOW : STEADY));
        counts[st[i]]++;
      }
      var grid = new Uint8Array(ctx.frames);
      for (var f = 0; f < ctx.frames; f++) { var j = Math.floor(f / ctx.fr / mhop); grid[f] = j < n ? st[j] : STEADY; }
      out[c.id] = grid;
      info[c.id] = { hopSec: mhop, states: Array.prototype.slice.call(st),
        steadyPct: round1(100 * counts[0] / n), slowPct: round1(100 * counts[1] / n), fastPct: round1(100 * counts[2] / n),
        // No readings at all: nothing on the track to measure (e.g. the camera moved into a multicam nest).
        // Its moves can't be avoided, which the panel says loudly; a plain backdrop is just lowDetail.
        lowDetail: !readable && known > 0, noFootage: known === 0 };
    });
    return { grid: out, info: info };
  }

  /**
   * Where a moving camera is moving, from a plan's stability info: [{ startSec, endSec, kind: "big" | "slow" }] in
   * sequence time. Moves closer than joinSec merge; shorter than minSec are dropped (single-frame glitches).
   */
  function cameraMoves(result, cameraId, opts) {
    opts = opts || {};
    var info = result.stability && result.stability[cameraId];
    if (!info || !info.states) return [];
    var hop = info.hopSec, off = info.offsetSec || 0, joinSec = opts.joinSec === undefined ? 0.5 : opts.joinSec;
    var minSec = opts.minSec === undefined ? 0.3 : opts.minSec, out = [];
    for (var i = 0; i < info.states.length;) {
      var s = info.states[i];
      if (s === STEADY) { i++; continue; }
      var j = i, big = false;
      while (j < info.states.length && info.states[j] !== STEADY) { if (info.states[j] === FAST) big = true; j++; }
      var a = off + i * hop, b = off + j * hop, last = out[out.length - 1];
      if (last && a - last.endSec <= joinSec) { last.endSec = b; if (big) last.kind = "big"; }
      else out.push({ startSec: a, endSec: b, kind: big ? "big" : "slow" });
      i = j;
    }
    return out.filter(function (m) { return m.endSec - m.startSec >= minSec; })
      .map(function (m) { return { startSec: round3(m.startSec), endSec: round3(m.endSec), kind: m.kind }; });
  }

  function stabilityHelpers(stab, style, ctx) {
    var settle = Math.max(1, Math.round(style.settleSec * ctx.fr));
    var pad = Math.round(style.movePadSec * ctx.fr);
    function state(cam, f) { var g = stab.grid[cam]; return g && f >= 0 && f < g.length ? g[f] : STEADY; }
    function onAir(cam, f) { var s = state(cam, f); return s === STEADY || (s === SLOW && style.slowMovesOnAir); }
    function settled(cam, f) {
      if (!stab.grid[cam]) return true;
      for (var k = Math.max(0, f - settle); k <= f; k++) if (state(cam, k) !== STEADY) return false;
      return true;
    }
    function okFrom(cam, f) { for (var k = f; k <= f + pad; k++) if (!onAir(cam, k)) return false; return true; }
    function canShow(cam, a, b) {
      if (!stab.grid[cam]) return true;
      for (var f = a; f < b; f++) if (!onAir(cam, f)) return false;
      return true;
    }
    return { state: state, onAir: onAir, settled: settled, okFrom: okFrom, canShow: canShow, settleFrames: settle,
      has: function (c) { return !!stab.grid[c]; } };
  }

  /** Only cut to a moving camera once it has settled; cut away while it moves. */
  function applyStability(shots, style, ctx) {
    var H = ctx.stable;
    if (!Object.keys(ctx.stability.grid).length) return shots;
    var maxWait = Math.round(style.maxWaitSec * ctx.fr);
    var out = [];
    function fallbackFor(s, a, b) {
      var ci = ctx.ci, cands = [ci.widest];
      (s.speakers || []).forEach(function (si) { cands = cands.concat(ci.fixedCloseups(si)); });
      cands = cands.concat(ci.list.map(function (c) { return c.cam.id; }));
      for (var i = 0; i < cands.length; i++) if (cands[i] && cands[i] !== s.cameraId && H.canShow(cands[i], a, b)) return cands[i];
      return null;
    }
    shots.forEach(function (s) {
      var cam = s.cameraId;
      if (s.locked || !H.has(cam)) { out.push(s); return; }
      var start = s.start;
      // 1) Cutting in mid-move: wait for the camera to settle by holding the previous shot a little longer.
      var prev = out[out.length - 1];
      if (!H.settled(cam, start) && prev && !prev.locked && prev.end === start) {
        for (var t = start + 1; t <= Math.min(s.end - 1, start + maxWait); t++) {
          if (H.settled(cam, t) && H.okFrom(cam, t)) {
            if (H.canShow(prev.cameraId, start, t)) { prev.end = t; start = t; }
            break;
          }
        }
      }
      // 2) Walk the shot: on air while the camera is usable, cut away while it moves, return once settled.
      var pieces = [], on = H.settled(cam, start) && H.okFrom(cam, start), from = start;
      for (var f = start; f < s.end; f++) {
        var want = on ? H.okFrom(cam, f) : (H.settled(cam, f) && H.okFrom(cam, f));
        if (want !== on) { pieces.push({ a: from, b: f, on: on }); from = f; on = want; }
      }
      pieces.push({ a: from, b: s.end, on: on });
      // The wide is the safety. Next to a move, a stretch on the moving camera shorter than comeBackSec isn't
      // worth going back for (quick banter while the operator swings between people): stay on the wide.
      var comeBack = Math.round((style.comeBackSec || 0) * ctx.fr);
      if (comeBack > 0 && pieces.length > 1) {
        var was = pieces.map(function (p) { return p.on; });
        pieces.forEach(function (p, i) {
          var nextToMove = (i > 0 && !was[i - 1]) || (i < pieces.length - 1 && !was[i + 1]);
          if (p.on && nextToMove && p.b - p.a < comeBack) p.on = false;
        });
      }
      // A reaction (a listener's laugh, a "yeah") on an operated camera that isn't steady throughout: use the wide.
      if (s.reason === "reaction" && ctx.ci.isFollow(cam) && pieces.some(function (p) { return !p.on; })) {
        pieces = [{ a: start, b: s.end, on: false }];
      }
      pieces.forEach(function (p, i) {
        if (p.b <= p.a) return;
        var piece = copyShot(s);
        piece.start = p.a; piece.end = p.b; piece.onset = s.onset && p.a === s.start;
        if (!p.on) {
          var fb = fallbackFor(s, p.a, p.b);
          if (fb) { piece.cameraId = fb; piece.reason = "camera-move"; piece.keepShort = true; piece.onset = false; }
        }
        out.push(piece);
        void i;
      });
    });
    return mergeShots(out);
  }

  // ------------------------------------------- 9c. who's in the shot (operated cams)

  /** Per follow camera: who it is pointed at, per decision frame (-1 nobody known, -2 moving / no reading). */
  function buildFraming(input, cameras, speakers, ctx) {
    var grids = {};
    var idx = {}; speakers.forEach(function (sp, i) { idx[sp.id] = i; });
    cameras.forEach(function (c) {
      var list = input.framing && input.framing[c.id];
      if (!list) return;
      var g = new Int16Array(ctx.frames).fill(-2);
      list.forEach(function (st) {
        var who = st.speakerId !== null && st.speakerId !== undefined && idx[st.speakerId] !== undefined ? idx[st.speakerId] : -1;
        for (var f = Math.max(0, Math.round(st.startSec * ctx.fr)); f < Math.min(ctx.frames, Math.round(st.endSec * ctx.fr)); f++) g[f] = who;
      });
      grids[c.id] = g;
    });
    return grids;
  }
  /**
   * Follow cams with motion but no "who's in the shot" reading: the operator only changes who's in frame by moving,
   * so each steady stretch between moves shows whoever was talking as it began (the person they moved to). The dolly
   * isn't on someone new just because they start talking: until it moves, it's still on the last person.
   */
  function guessFraming(ctx, cameras, mainRuns, style) {
    if (!style.guessFraming) return;
    var fr = ctx.fr, look = Math.round(6 * fr);
    cameras.forEach(function (c) {
      var g = ctx.stability.grid[c.id], info = ctx.stability.info[c.id];
      if (ctx.framing[c.id] || !g || !ctx.ci.isFollow(c.id) || info.lowDetail || info.noFootage) return;
      var stretches = [], s = -1;
      for (var f = 0; f <= g.length; f++) {
        // With slow moves allowed on air they're reframes (a push-in), not a move to someone else.
        var steady = f < g.length && (g[f] === STEADY || (g[f] === SLOW && style.slowMovesOnAir));
        if (steady && s < 0) s = f;
        if (!steady && s >= 0) { stretches.push([s, f]); s = -1; }
      }
      if (stretches.length < 3) return; // hardly ever moves: no moves to go by
      var talk = function (si, a, b) {
        var n = 0;
        mainRuns[si].forEach(function (r) { n += Math.max(0, Math.min(r[1], b) - Math.max(r[0], a)); });
        return n;
      };
      var who = function (a, b) {
        var best = -1, most = Math.round(0.5 * fr);
        for (var si = 0; si < mainRuns.length; si++) { var n = talk(si, a, b); if (n > most) { most = n; best = si; } }
        return best;
      };
      var grid = new Int16Array(ctx.frames).fill(-2);
      stretches.forEach(function (st) {
        var on = who(st[0], Math.min(st[1], st[0] + look));
        if (on < 0) on = who(st[0], st[1]);
        for (var f2 = st[0]; f2 < st[1]; f2++) grid[f2] = on;
      });
      ctx.framing[c.id] = grid;
    });
  }

  /**
   * The picture reading can lump two people together (similar shirts, same backdrop) and name a stretch after the
   * wrong one. An operator frames whoever is talking, so a long steady stretch "on" someone who barely speaks
   * while one other person does most of the talking is really on that person.
   */
  function checkFraming(ctx, mainRuns, style) {
    if (!style.checkFramingByAudio) return;
    var fr = ctx.fr, minLen = Math.round(8 * fr);
    Object.keys(ctx.framing).forEach(function (cam) {
      var g = ctx.framing[cam];
      for (var a = 0; a < g.length;) {
        var b = a; while (b < g.length && g[b] === g[a]) b++;
        if (g[a] >= 0 && b - a >= minLen) {
          var talk = mainRuns.map(function (runs) {
            var n = 0; runs.forEach(function (r) { n += Math.max(0, Math.min(r[1], b) - Math.max(r[0], a)); }); return n / (b - a);
          });
          var top = 0; for (var si = 1; si < talk.length; si++) if (talk[si] > talk[top]) top = si;
          if (top !== g[a] && talk[g[a]] < 0.25 && talk[top] >= 0.5) for (var f = a; f < b; f++) g[f] = top;
        }
        a = b;
      }
    });
  }

  /** Can camera `cam` show any of `speakersIdx` over [a, b)? True when we know nothing about its framing. */
  function framingOk(ctx, cam, a, b, speakersIdx) {
    var g = ctx.framing && ctx.framing[cam];
    if (!g) return true;
    for (var f = a; f < b; f++) if (speakersIdx.indexOf(g[f]) < 0) return false;
    return true;
  }
  /** A follow camera that is on speaker `si` for the whole of [a, b), if any. */
  function framedOn(ctx, si, a, b) {
    var ids = Object.keys(ctx.framing || {});
    for (var i = 0; i < ids.length; i++) if (ctx.ci.isFollow(ids[i]) && framingOk(ctx, ids[i], a, b, [si])) return ids[i];
    return null;
  }

  /**
   * Safe zones: where a follow cam with motion readings sits still on one person. Per frame, the frame its current
   * still stretch on that person began (-1: moving, or on nobody known). Settling only matters at the edges of a
   * zone, next to a move; parked well inside one, the camera can be cut to at once.
   */
  function buildParked(ctx, style) {
    var out = {};
    Object.keys(ctx.framing || {}).forEach(function (cam) {
      var g = ctx.framing[cam];
      if (!ctx.ci.isFollow(cam) || !ctx.stable.has(cam)) return;
      var since = new Int32Array(g.length).fill(-1);
      for (var f = 0; f < g.length; f++) {
        var s = ctx.stable.state(cam, f), still = s === STEADY || (s === SLOW && style.slowMovesOnAir);
        if (!still || g[f] < 0) continue;
        since[f] = f > 0 && since[f - 1] >= 0 && g[f - 1] === g[f] ? since[f - 1] : f;
      }
      out[cam] = since;
    });
    return out;
  }
  /** Is follow cam `cam` parked on speaker `si` at frame f (still on them for parkedSec, and staying usable)? */
  function parkedOn(ctx, cam, si, f) {
    var since = ctx.parked && ctx.parked[cam], g = ctx.framing && ctx.framing[cam];
    if (!since || f < 0 || f >= since.length || since[f] < 0 || g[f] !== si) return false;
    var need = Math.max(ctx.stable.settleFrames, Math.round((ctx.style.parkedSec || 0) * ctx.fr));
    return f - since[f] >= need && ctx.stable.okFrom(cam, f);
  }

  /** Is follow cam `cam` parked on whoever holds the floor at frame f (or takes it within the next second)? */
  function parkedOnTalker(ctx, cam, f) {
    if (!ctx.parked || !ctx.parked[cam]) return false;
    for (var k = f; k < Math.min(ctx.frames, f + Math.round(ctx.fr)); k++) if (ctx.floor[k] >= 0) return parkedOn(ctx, cam, ctx.floor[k], f);
    return false;
  }

  /** Follow cams: replace the stretches where the camera is on someone other than the person in the shot. */
  function applyFraming(shots, style, ctx) {
    if (!ctx.framing || !Object.keys(ctx.framing).length) return shots;
    var out = [];
    var canShow = ctx.stable ? ctx.stable.canShow : function () { return true; };
    shots.forEach(function (s) {
      var g = ctx.framing[s.cameraId];
      if (!g || s.locked || !s.speakers || !s.speakers.length) { out.push(s); return; }
      // A follow cam can carry one shot across a change of speaker: check it against whoever has the floor at
      // each moment (in pauses, anyone the shot is about).
      var fl = ctx.floor, okAt = function (f) {
        var who = fl && s.reason === "speaker" ? fl[f] : -1;
        return who >= 0 ? g[f] === who : s.speakers.indexOf(g[f]) >= 0;
      };
      var pieces = [], from = s.start, on = okAt(s.start);
      for (var f = s.start; f < s.end; f++) {
        var ok = okAt(f);
        if (ok !== on) { pieces.push({ a: from, b: f, on: on }); from = f; on = ok; }
      }
      pieces.push({ a: from, b: s.end, on: on });
      pieces.forEach(function (p) {
        var piece = copyShot(s); piece.start = p.a; piece.end = p.b; piece.onset = s.onset && p.a === s.start;
        if (!p.on) {
          var cands = [ctx.ci.widest];
          s.speakers.forEach(function (si) { cands = cands.concat(ctx.ci.fixedCloseups(si)); });
          cands = cands.concat(ctx.ci.list.map(function (c) { return c.cam.id; }));
          for (var i = 0; i < cands.length; i++) {
            var c = cands[i];
            if (c && c !== s.cameraId && canShow(c, p.a, p.b) && framingOk(ctx, c, p.a, p.b, s.speakers)) {
              piece.cameraId = c; piece.reason = "framing"; piece.keepShort = true; piece.onset = false; break;
            }
          }
        }
        out.push(piece);
      });
    });
    return mergeShots(out);
  }

  // --------------------------------------------------- 9c. handoff wide

  /**
   * How David cuts a two-camera show (measured on 35 finished episodes): as one person hands over, go to the wide a
   * little before the next one starts (wideLeadSec), stay there while they get going, and cut to their solo only
   * once they've held the floor for soloAfterSec. A turn too short to leave a solo of at least minShotSec stays on
   * the wide throughout.
   */
  function applyHandoffWide(shots, style, ctx) {
    var after = Math.round((style.soloAfterSec || 0) * ctx.fr);
    if (!(after > 0) || !ctx.ci.hasWide) return shots;
    var wide = ctx.ci.widest, lead = Math.round((style.wideLeadSec || 0) * ctx.fr), minShot = Math.round(style.minShotSec * ctx.fr);
    var canShow = ctx.stable ? ctx.stable.canShow : function () { return true; };
    var out = shots.map(copyShot);
    for (var i = 1; i < out.length; i++) {
      var s = out[i], prev = out[i - 1];
      if (s.locked || s.cameraId === wide || s.reason !== "speaker" || !s.speakers || s.speakers.length !== 1) continue;
      if (prev.speakers && prev.speakers.length === 1 && prev.speakers[0] === s.speakers[0]) continue; // same turn carrying on
      // The wide covers the operator finding the new speaker. If the camera is already parked on them, it isn't needed.
      if (parkedOn(ctx, s.cameraId, s.speakers[0], s.start)) continue;
      var cut = s.start + after;
      var bridge = { start: s.start, end: s.end - cut < minShot ? s.end : cut, cameraId: wide, reason: "handoff",
        speakers: s.speakers.slice(), onset: false, locked: false, keepShort: true };
      if (!canShow(wide, bridge.start, bridge.end)) continue;
      // Go wide a little early, as the last speaker winds down.
      if (lead > 0 && !prev.locked && prev.cameraId !== wide && prev.end - prev.start - lead >= minShot) {
        prev.end -= lead; bridge.start -= lead;
      }
      if (bridge.end >= s.end) { s.cameraId = wide; s.reason = "handoff"; s.start = bridge.start; continue; }
      s.start = bridge.end; s.onset = false;
      out.splice(i, 0, bridge); i++;
    }
    return mergeShots(out);
  }

  // --------------------------------------------------- 9d. wide length

  /** Short wides (forced by a moving camera, quick overlaps, pauses) look like flashes: let each run on to minWideSec. */
  function applyMinWide(shots, style, ctx) {
    var fr = ctx.fr, ci = ctx.ci;
    var need = Math.round((style.minWideSec || 0) * fr);
    if (!ci.hasWide || need <= 0 || need <= Math.round(style.minShotSec * fr)) return shots;
    var wide = ci.widest;
    var canShow = ctx.stable ? ctx.stable.canShow : function () { return true; };
    shots = mergeShots(shots);
    for (var i = 0; i < shots.length; i++) {
      var s = shots[i];
      if (s.cameraId !== wide || s.locked || s.end - s.start >= need) continue;
      // Run forward into the following shots (never over a locked shot). Into a follow cam already parked on the
      // talker, the wide only needs parkedWideSec: the camera is ready, there's nothing to wait for.
      var want = s.start + need, need2 = need, nx = shots[i + 1];
      if (nx && parkedOnTalker(ctx, nx.cameraId, s.end)) {
        need2 = Math.min(need, Math.round((style.parkedWideSec || 0) * fr));
        want = Math.max(s.end, s.start + need2);
      }
      for (var j = i + 1; j < shots.length && s.end < want; j++) {
        var n = shots[j];
        if (n.locked || n.reason === "reaction" || !canShow(wide, n.start, Math.min(n.end, want))) break;
        if (n.cameraId === wide || n.end <= want || n.end - want < Math.round(style.minShotSec * fr) * 0.5) {
          s.end = n.end; n.end = n.start; // swallowed whole (or the leftover would be a flash)
        } else { n.start = want; s.end = want; }
      }
      // Still short (locked shot or end of show ahead): reach back instead.
      if (s.end - s.start < need2) {
        var wantStart = s.end - need2;
        for (var k = i - 1; k >= 0 && s.start > wantStart; k--) {
          var p = shots[k];
          if (p.locked || p.reason === "reaction" || p.end !== s.start || !canShow(wide, Math.max(p.start, wantStart), p.end)) break;
          if (p.start >= wantStart || wantStart - p.start < Math.round(style.minShotSec * fr) * 0.5) { s.start = p.start; p.start = p.end; }
          else { p.end = wantStart; s.start = wantStart; }
        }
      }
      s.keepShort = false;
      shots = shots.filter(function (x) { return x.end > x.start; });
      i = shots.indexOf(s);
    }
    return mergeShots(shots);
  }

  // ------------------------------------------------------- 10. cleanup

  function enforceMinShot(shots, speakers, style, ctx) {
    var fr = ctx.fr;
    function minFor(s) {
      if (s.keepShort) return Math.round(Math.min(style.minShotSec, style.reactionShotSec) * fr);
      var si = s.speakers && s.speakers.length === 1 ? s.speakers[0] : -1;
      var sp = si >= 0 ? speakers[si] : null;
      var v = sp && sp.minShotSec !== null && sp.minShotSec !== undefined && sp.minShotSec !== "" ? Number(sp.minShotSec) : style.minShotSec;
      return Math.round(v * fr);
    }
    shots = mergeShots(shots);
    var guard = shots.length * 4 + 10;
    while (shots.length > 1 && guard-- > 0) {
      var worst = -1, worstDef = 0;
      for (var i = 0; i < shots.length; i++) {
        var s = shots[i];
        if (s.locked) continue;
        var deficit = minFor(s) - (s.end - s.start);
        if (deficit > 0 && (worst < 0 || (s.end - s.start) < (shots[worst].end - shots[worst].start))) { worst = i; worstDef = deficit; }
      }
      if (worst < 0) break;
      var sh = shots[worst], before = shots[worst - 1], after = shots[worst + 1];
      var target = null;
      var canShow = ctx.stable ? ctx.stable.canShow : function () { return true; };
      var okB = before && !before.locked && canShow(before.cameraId, sh.start, sh.end) && framingOk(ctx, before.cameraId, sh.start, sh.end, before.speakers || []);
      var okA = after && !after.locked && canShow(after.cameraId, sh.start, sh.end) && framingOk(ctx, after.cameraId, sh.start, sh.end, after.speakers || []);
      if (okB && okA) target = (before.cameraId === after.cameraId || (before.end - before.start) >= (after.end - after.start)) ? before : after;
      else if (okB) target = before; else if (okA) target = after;
      if (!target) { sh.locked = true; sh._pinned = true; continue; }
      sh.cameraId = target.cameraId; sh.reason = target.reason; sh.speakers = target.speakers.slice(); sh.keepShort = false;
      shots = mergeShots(shots);
    }
    shots.forEach(function (s) { if (s._pinned) { s.locked = false; delete s._pinned; } });
    return shots;
  }

  // -------------------------------------------------- 10b. cleanup cuts

  function splitAt(shots, f) {
    var out = [];
    shots.forEach(function (s) {
      if (f > s.start && f < s.end) {
        var l = copyShot(s), r = copyShot(s); l.end = f; r.start = f; r.onset = false;
        out.push(l, r);
      } else out.push(s);
    });
    return out;
  }

  /**
   * Sections that will be removed (cleanup cuts) join the shot before them to the shot after them. If both are the
   * same camera that's a jump cut, so the shot after the removal switches to another camera (the wide, the
   * speaker's other angle, or anyone else) for a moment, then returns.
   */
  function applyRemovals(shots, removals, style, ctx) {
    if (!removals || !removals.length) return shots;
    var fr = ctx.fr, minShot = Math.round(style.minShotSec * fr);
    var canShow = ctx.stable ? ctx.stable.canShow : function () { return true; };
    // join: a content cut already in the timeline (startSec = endSec): nothing to remove, but the same jump to hide.
    removals.map(function (r) {
      return { a: Math.max(0, Math.round(Math.min(r.startSec, r.endSec) * fr)), b: Math.min(ctx.frames, Math.round(Math.max(r.startSec, r.endSec) * fr)), join: !!r.join };
    }).filter(function (r) { return r.b > r.a || (r.join && r.a > 0); }).sort(function (x, y) { return x.a - y.a; }).forEach(function (r) {
      shots = r.join ? splitAt(shots, r.a) : splitAt(splitAt(shots, r.a), r.b);
      // The removed part itself: mark it so it never merges away (keeps edit points at both ends).
      shots.forEach(function (s) { if (s.start >= r.a && s.end <= r.b && !s.locked) { s.reason = "removed"; s.locked = true; s.removed = true; } });
      if (!style.changeCameraAtCuts || r.a === 0 || r.b >= ctx.frames) return;
      var before = shotAt(shots, r.a - 1), after = shotAt(shots, r.b);
      if (!before || !after || after.cameraId !== before.cameraId || (after.locked && !after.removed)) return;
      var ci = ctx.ci, cands = [ci.widest];
      (after.speakers || []).forEach(function (si) { cands = cands.concat(ci.closeups(si)); });
      cands = cands.concat(ci.list.map(function (c) { return c.cam.id; }));
      var cover = Math.max(minShot, Math.round(style.jumpCoverSec * fr));
      var end = after.end - r.b <= cover + minShot ? after.end : (quietestFrame(ctx, r.b + cover, r.b + minShot, after.end - minShot) || r.b + cover);
      // A camera that's usable from the cut but starts moving before `end` still covers it: cut the cover short
      // (at least the shorter of the minimum shot and Cover shot), rather than leave the jump showing.
      var cam = null, need = Math.min(minShot, Math.round(style.jumpCoverSec * fr));
      for (var i = 0; i < cands.length && !cam; i++) {
        var c = cands[i];
        if (!c || c === before.cameraId) continue;
        var e = r.b;
        while (e < end && canShow(c, e, e + 1)) e++;
        if (e < end) e = Math.max(r.b + need, e - Math.round(style.movePadSec * fr)); // leave before the move starts
        if (e === end || (e - r.b >= need && canShow(c, r.b, e))) { cam = c; end = e; }
      }
      if (!cam) return;
      shots = insertShot(shots, { start: r.b, end: end, cameraId: cam, reason: "jump-cover", speakers: (after.speakers || []).slice(), onset: false, locked: true });
    });
    return shots;
  }

  // ------------------------------------------------------ 10c. cut cap

  // Which shots can be dropped when there are too many cuts, least important first.
  var DROP_ORDER = { reaction: 0, "interjection-wide": 0, pause: 1, hold: 1, cutaway: 2, crosstalk: 3, opening: 4, speaker: 5, "wide-turn": 5 };

  /** Keep every 60 s window at or under maxCutsPerMin cuts by folding the least important shots into a neighbour. */
  function applyCutCap(shots, style, ctx) {
    var cap = style.maxCutsPerMin;
    if (!(cap > 0)) return shots;
    var win = Math.round(60 * ctx.fr), guard = shots.length * 3 + 20;
    var canShow = ctx.stable ? ctx.stable.canShow : function () { return true; };
    var blocked = {};
    while (guard-- > 0) {
      // Busiest 60 s window (cuts = shot starts after the first).
      var starts = shots.slice(1).map(function (s) { return s.start; });
      var worst = -1, worstCount = 0;
      for (var i = 0, j = 0; i < starts.length; i++) {
        while (starts[j] < starts[i] - win) j++;
        if (i - j + 1 > worstCount) { worstCount = i - j + 1; worst = i; }
      }
      if (worstCount <= cap) break;
      var hiT = starts[worst], loT = hiT - win;
      // Least important droppable shot in that window (shortest wins ties).
      var pick = -1, best = Infinity;
      for (var k = 1; k < shots.length - 1; k++) {
        var s = shots[k];
        if (s.end < loT || s.start > hiT || s.locked || blocked[k + ":" + s.start]) continue;
        var rank = DROP_ORDER[s.reason];
        if (rank === undefined) continue; // forced shots: camera moving, wrong framing, removed sections
        var score = rank * 1e6 + (s.end - s.start);
        if (score < best) { best = score; pick = k; }
      }
      if (pick < 0) break;
      var sh = shots[pick], before = shots[pick - 1], after = shots[pick + 1];
      var ok = function (t) {
        return t && !t.locked && canShow(t.cameraId, sh.start, sh.end) && framingOk(ctx, t.cameraId, sh.start, sh.end, t.speakers || []);
      };
      var target = ok(before) && ok(after) ? ((before.end - before.start) >= (after.end - after.start) ? before : after) : (ok(before) ? before : (ok(after) ? after : null));
      if (!target) { blocked[pick + ":" + sh.start] = true; continue; }
      sh.cameraId = target.cameraId; sh.reason = target.reason; sh.speakers = (target.speakers || []).slice(); sh.keepShort = false;
      shots = mergeShots(shots);
      blocked = {};
    }
    return shots;
  }

  /**
   * The show's opening, from the transcript: the host's solo cam through the welcome, then the wide while they
   * introduce everyone (where the lower-third name tags go). intro: { startSec, wideSec, endSec, hostId?, holdSec? }.
   * The wide holds at least holdSec (default 15 s) so the name cards have time on screen. The host is hostId, or
   * whoever talks most during the welcome. A solo shot the camera can't give (a follow cam mid-move or on someone
   * else) is left to the normal cut; manual locks still win.
   */
  function applyIntro(shots, intro, speakers, style, ctx) {
    if (!intro || !(intro.endSec > intro.startSec)) return shots;
    var fr = ctx.fr, ci = ctx.ci;
    var hold = intro.holdSec === undefined || intro.holdSec === null ? 15 : Number(intro.holdSec);
    var a = Math.max(0, Math.round(intro.startSec * fr)), w = Math.round(Math.max(intro.startSec, intro.wideSec) * fr);
    var b = Math.min(ctx.frames, Math.max(Math.round(intro.endSec * fr), w + Math.round(Math.max(hold, style.minWideSec || 0) * fr)));
    if (a >= ctx.frames || b <= a) return shots;
    var canShow = ctx.stable ? ctx.stable.canShow : function () { return true; };
    var si = -1;
    speakers.forEach(function (sp, i) { if (sp.id === intro.hostId) si = i; });
    if (si < 0 && w > a) {
      var best = 0;
      ctx.raw.forEach(function (r, i) {
        var n = 0; for (var t = a; t < w; t++) if (r[t]) n++;
        if (n > best) { best = n; si = i; }
      });
    }
    if (w > a && si >= 0) {
      var cams = ci.closeups(si).filter(function (id) { return canShow(id, a, w) && framingOk(ctx, id, a, w, [si]); });
      if (cams.length) shots = insertShot(shots, { start: a, end: w, cameraId: cams[0], reason: "intro", speakers: [si], onset: true, locked: true });
    }
    if (ci.hasWide && b > w) shots = insertShot(shots, { start: w, end: b, cameraId: ci.widest, reason: "intro-wide", speakers: [], onset: false, locked: true });
    return shots;
  }

  function applyOverrides(shots, overrides, ctx) {
    (overrides || []).forEach(function (o) {
      var a = Math.round(Math.min(o.startSec, o.endSec) * ctx.fr);
      var b = Math.round(Math.max(o.startSec, o.endSec) * ctx.fr);
      a = Math.max(0, a); b = Math.min(ctx.frames, b);
      if (b <= a) return;
      shots = insertShot(shots, { start: a, end: b, cameraId: o.cameraId, reason: "locked", speakers: [], onset: false, locked: true });
    });
    return shots;
  }

  // ------------------------------------------------------------- main

  /**
   * plan(input, config)
   *   input:  { durationSec, hopSec, fps, curves: { speakerId: number[] (dB per hop) } }
   *   config: { speakers: [{id,name,...DEFAULT_SPEAKER}], cameras: [{id,name,videoTrack,shows:[speakerId]}],
   *             preset: "balanced", style: {...overrides}, overrides: [{startSec,endSec,cameraId}] }
   */
  function plan(input, config) {
    var style = applyWideBias(styleFromPreset(config.preset, config.style));
    var hop = input.hopSec;
    var fr = 1 / hop; // analysis frames per second
    var frames = Math.max(1, Math.ceil(input.durationSec / hop));
    var speakers = (config.speakers || []).filter(function (s) { return s.enabled !== false; })
      .map(function (s) { return merge(DEFAULT_SPEAKER, s); });
    var cameras = (config.cameras || []).filter(function (c) { return c.enabled !== false; });
    if (!cameras.length) throw new Error("No cameras configured.");
    if (!speakers.length) throw new Error("No speakers configured.");

    var curves = input.curves;
    var cal = calibrate(curves, speakers, style);
    var raw = detectActivity(curves, speakers, cal, style, frames);
    var runs = raw.map(function (r) {
      return smoothRuns(r, Math.round(style.holdSec * fr), Math.max(1, Math.round(style.attackSec * fr)));
    });
    var classified = classifyRuns(runs, speakers, style, fr);
    var segs = floorSegments(classified.main, speakers, style, fr, frames);

    var ctx = { fr: fr, frames: frames, curves: curves, speakers: speakers, cal: cal, rand: rng(style.seed) };
    // Who has the floor, per frame (-1: nobody / several).
    ctx.floor = new Int16Array(frames).fill(-1);
    segs.forEach(function (sg) { if (sg.kind === "solo") for (var f = sg.start; f < Math.min(sg.end, frames); f++) ctx.floor[f] = sg.speakers[0]; });
    var built = buildShots(segs, speakers, cameras, style, ctx);
    ctx.ci = built.ci;
    ctx.stability = buildStability(input, cameras, style, ctx);
    ctx.stable = stabilityHelpers(ctx.stability, style, ctx);
    ctx.framing = buildFraming(input, cameras, speakers, ctx);
    checkFraming(ctx, classified.main, style);
    guessFraming(ctx, cameras, classified.main, style);
    ctx.style = style;
    ctx.parked = buildParked(ctx, style);
    var shots = splitByFloor(built.shots, ctx);
    shots = applyInterjections(shots, classified.interjections, speakers, style, ctx);
    shots = applyCutaways(shots, speakers, style, ctx);
    shots = applyTiming(shots, style, ctx);
    shots = applyStability(shots, style, ctx);
    shots = applyFraming(shots, style, ctx);
    shots = applyHandoffWide(shots, style, ctx);
    shots = applyMinWide(shots, style, ctx);
    shots = enforceMinShot(shots, speakers, style, ctx);
    shots = applyMinWide(shots, style, ctx);
    shots = applyCutCap(shots, style, ctx);
    shots = applyRemovals(shots, config.removals, style, ctx);
    ctx.raw = raw;
    shots = applyIntro(shots, config.intro, speakers, style, ctx);
    shots = applyOverrides(shots, config.overrides, ctx);
    shots = mergeShots(shots);

    // Convert to seconds, snap to video frames.
    var fps = input.fps || 30;
    var outShots = shots.map(function (s) {
      var a = s.start * hop, b = Math.min(s.end * hop, input.durationSec);
      if (style.snapToFrames) { a = Math.round(a * fps) / fps; b = s.end >= frames ? input.durationSec : Math.round(b * fps) / fps; }
      return { startSec: round3(a), endSec: round3(b), cameraId: s.cameraId, reason: s.reason,
               speakers: (s.speakers || []).map(function (i) { return speakers[i].id; }), locked: !!s.locked };
    }).filter(function (s) { return s.endSec > s.startSec; });
    // Re-stitch after snapping so shots stay contiguous.
    for (var i = 1; i < outShots.length; i++) outShots[i].startSec = outShots[i - 1].endSec;
    outShots = outShots.filter(function (s) { return s.endSec > s.startSec + 1e-6; });
    if (outShots.length) { outShots[0].startSec = 0; }

    return {
      shots: outShots,
      calibration: cal,
      speech: runs.map(function (rs, si) {
        return { speakerId: speakers[si].id, runs: rs.map(function (r) { return [round3(r[0] * hop), round3(r[1] * hop)]; }) };
      }),
      interjections: classified.interjections.map(function (ij) {
        return { speakerId: speakers[ij.speaker].id, startSec: round3(ij.start * hop), endSec: round3(ij.end * hop) };
      }),
      stats: computeStats(outShots, runs, speakers, cameras, input.durationSec, hop),
      confidence: computeConfidence(curves, speakers, cal, raw, runs, fr, frames),
      stability: ctx.stability.info,
      style: style
    };
  }

  /**
   * How well each mic picks up its speaker (mic discipline): a 0..100 score per speaker and the measures behind it.
   *   levelGapDb     their speech level vs the loudest mic (quiet = too far from the mic)
   *   separationDb   their voice on their mic vs the others' voices on it (low = bleed, hard to tell apart)
   *   borderlinePct  share of their speech that only just clears the threshold
   *   missedSec      silence (nobody detected) where their mic sat just under the threshold: likely missed speech
   *   weak           stretches where their speech ran well below their usual level (leaning back, turning away)
   */
  function computeConfidence(curves, speakers, cal, raw, runs, fr, frames) {
    var n = speakers.length;
    var loudest = -Infinity;
    cal.forEach(function (c) { if (c.speechDb > loudest) loudest = c.speechDb; });
    // Talking (raw) and within anyone's turn (runs bridge the gaps between words, which aren't missed speech).
    var anyActive = new Uint8Array(frames), anyTurn = new Uint8Array(frames);
    for (var s = 0; s < n; s++) {
      for (var t = 0; t < frames; t++) if (raw[s][t]) anyActive[t] = 1;
      runs[s].forEach(function (r) { for (var k0 = r[0]; k0 < Math.min(r[1], frames); k0++) anyTurn[k0] = 1; });
    }
    var stride = Math.max(1, Math.floor(frames / 40000));
    var win = Math.round(30 * fr);
    return speakers.map(function (sp, si) {
      var c = curves[sp.id] || [], th = cal[si].thresholdDb;
      var own = [], others = [], border = 0, active = 0, missed = 0;
      var inRun = new Uint8Array(frames);
      runs[si].forEach(function (r) { for (var k = r[0]; k < Math.min(r[1], frames); k++) inRun[k] = 1; });
      for (var t2 = 0; t2 < frames; t2++) {
        var db = t2 < c.length ? c[t2] : SILENT_DB;
        if (raw[si][t2]) {
          active++;
          if (db - th < 4) border++;
          if (t2 % stride === 0) own.push(db);
        } else if (anyActive[t2]) {
          if (t2 % stride === 0) others.push(db);
        } else if (!anyTurn[t2] && db > th - 6 && db > cal[si].floorDb + 10) missed++;
      }
      var ownDb = percentile(own, 0.5), otherDb = others.length ? percentile(others, 0.5) : cal[si].floorDb;
      // Weak stretches: a minute or more (consecutive 30 s windows) where the speech they did get ran 10 dB+ under
      // their usual level. Shorter or smaller dips are just how people talk (tuned on real episodes).
      var weak = [];
      for (var w0 = 0; w0 < frames; w0 += win) {
        var vals = [];
        for (var k2 = w0; k2 < Math.min(frames, w0 + win); k2++) if (inRun[k2] && k2 < c.length) vals.push(c[k2]);
        if (vals.length < 3 * fr || percentile(vals, 0.5) > ownDb - 10) continue;
        var last = weak[weak.length - 1];
        if (last && last[1] === w0) last[1] = Math.min(frames, w0 + win); else weak.push([w0, Math.min(frames, w0 + win)]);
      }
      weak = weak.filter(function (r) { return r[1] - r[0] >= 2 * win - 1; });
      var weakFrames = weak.reduce(function (a, r) { return a + r[1] - r[0]; }, 0);
      var m = {
        levelGapDb: round1(Math.min(0, cal[si].speechDb - loudest)),
        separationDb: round1(own.length ? ownDb - otherDb : 0),
        borderlinePct: Math.round(100 * border / Math.max(1, active)),
        missedSec: round1(missed / fr),
        activeSec: round1(active / fr)
      };
      // Weights and ranges tuned on 41 real episodes (Zoom F6, SM58 then SM7B). Separation carries the score: well
      // mic'd hosts sit at 25-30 dB, a speaker sitting back from the mic with a loud neighbour falls to 10-14 dB.
      // Level mostly reflects recorder gain, not mic discipline, so it counts little.
      var parts = {
        level: clamp(1 + m.levelGapDb / 24, 0, 1),
        separation: clamp((m.separationDb - 8) / 14, 0, 1),
        border: clamp(1 - m.borderlinePct / 40, 0, 1),
        missed: clamp(1 - 4 * missed / Math.max(1, active), 0, 1),
        weak: clamp(1 - 3 * weakFrames / Math.max(1, frames), 0, 1)
      };
      var score = active ? Math.round(100 * (0.6 * parts.separation + 0.1 * parts.border + 0.1 * parts.missed + 0.05 * parts.level + 0.15 * parts.weak)) : 0;
      var hints = [];
      if (!active) hints.push("No speech detected on this mic. Check its track and channel.");
      else {
        if (parts.separation < 0.5) hints.push("The others come through their mic almost as loudly as they do (sitting back from the mic, or a loud neighbour), so cuts to them can be wrong or late. Check their stretches by hand; lowering Bleed rejection can help.");
        if (m.levelGapDb < -15) hints.push("Much quieter than the loudest mic: check the recorder gain on this channel, or they're far from the mic. If they're being missed, lower their Threshold.");
        if (parts.missed < 0.7) hints.push("About " + Math.round(m.missedSec) + " s of possible speech fell just under the threshold. Lower their Threshold a few dB.");
        if (parts.border < 0.4) hints.push("A lot of their speech only just clears the threshold; quieter words may be missed.");
        if (weak.length) hints.push("Their level dropped noticeably in " + weak.length + (weak.length === 1 ? " stretch" : " stretches") + " (turned away or leaned back?). Check the cut there.");
      }
      return { speakerId: sp.id, score: score, label: score >= 75 ? "good" : score >= 55 ? "fair" : "poor", parts: parts,
               levelGapDb: m.levelGapDb, separationDb: m.separationDb, borderlinePct: m.borderlinePct, missedSec: m.missedSec,
               weak: weak.map(function (r) { return [round3(r[0] / fr), round3(r[1] / fr)]; }), hints: hints };
    });
  }

  function computeStats(shots, runs, speakers, cameras, duration, hop) {
    var lengths = shots.map(function (s) { return s.endSec - s.startSec; }).sort(function (a, b) { return a - b; });
    var screen = {}, reasons = {};
    cameras.forEach(function (c) { screen[c.id] = 0; });
    shots.forEach(function (s) {
      screen[s.cameraId] = (screen[s.cameraId] || 0) + (s.endSec - s.startSec);
      reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    });
    var talk = {};
    runs.forEach(function (rs, si) {
      var sum = 0; rs.forEach(function (r) { sum += r[1] - r[0]; });
      talk[speakers[si].id] = round1(100 * sum * hop / Math.max(1e-6, duration));
    });
    var pct = {};
    for (var k in screen) pct[k] = round1(100 * screen[k] / Math.max(1e-6, duration));
    return {
      shots: shots.length,
      cuts: Math.max(0, shots.length - 1),
      cutsPerMinute: round1(Math.max(0, shots.length - 1) / Math.max(1 / 60, duration / 60)),
      avgShotSec: round1(lengths.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, lengths.length)),
      medianShotSec: round1(lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0),
      shortestShotSec: round3(lengths[0] || 0),
      longestShotSec: round1(lengths[lengths.length - 1] || 0),
      screenTimePct: pct,
      talkTimePct: talk,
      reasons: reasons
    };
  }

  /**
   * Content cuts in a camera track: places where the next clip doesn't carry on from where the previous one left
   * off in the source (another file, or a jump in time), i.e. footage was removed. Returns the stretches between
   * content cuts that are shorter than minSec, inside [rangeStart, rangeEnd] if given. Splits that keep the
   * source continuous (razors from a previous build) and gaps or the ends of the track/range are not cuts.
   *   clips: [{ startSec, endSec, inPointSec, mediaPath, speed }]
   *   -> [{ startSec, endSec, lengthSec, cutBefore, cutAfter }]
   */
  function sourcePieces(clips, tol) {
    var list = (clips || []).filter(function (c) { return c.endSec > c.startSec; })
      .slice().sort(function (a, b) { return a.startSec - b.startSec; });
    var pieces = [], cur = null;
    list.forEach(function (c, i) {
      var prev = list[i - 1], cut = false, joined = false;
      if (prev && Math.abs(c.startSec - prev.endSec) <= tol) {
        joined = true;
        var speed = Math.abs(Number(prev.speed) || 1);
        var expected = prev.inPointSec + (prev.endSec - prev.startSec) * speed;
        cut = c.mediaPath !== prev.mediaPath || Math.abs(c.inPointSec - expected) > tol * Math.max(1, speed);
      }
      if (cur && joined && !cut) { cur.endSec = c.endSec; return; }
      if (cur) { cur.cutAfter = cut; pieces.push(cur); }
      cur = { startSec: c.startSec, endSec: c.endSec, cutBefore: cut, cutAfter: false };
    });
    if (cur) pieces.push(cur);
    return pieces;
  }

  /** The times of the content cuts in a camera track (same clip shape as shortSections), in seconds. */
  function contentCuts(clips, opts) {
    opts = opts || {};
    return sourcePieces(clips, 1.5 / (opts.fps || 30)).filter(function (p) { return p.cutBefore; })
      .map(function (p) { return round3(p.startSec); });
  }

  function shortSections(clips, minSec, opts) {
    opts = opts || {};
    var tol = 1.5 / (opts.fps || 30);
    var lo = opts.rangeStart || 0, hi = opts.rangeEnd === undefined || opts.rangeEnd === null ? Infinity : opts.rangeEnd;
    var pieces = sourcePieces(clips, tol);
    var out = [];
    pieces.forEach(function (p) {
      var a = Math.max(p.startSec, lo), b = Math.min(p.endSec, hi);
      if (b <= a) return;
      // A cut only counts inside the range; the range edges (In/Out) aren't cuts.
      var before = p.cutBefore && p.startSec > lo + tol, after = p.cutAfter && p.endSec < hi - tol;
      if ((before || after) && b - a < minSec - 1e-6) {
        out.push({ startSec: round3(a), endSec: round3(b), lengthSec: round1(b - a), cutBefore: before, cutAfter: after });
      }
    });
    return out;
  }

  /** Per video track: which ranges are enabled. Boundaries are video frame numbers. */
  /**
   * Plan only the part of the sequence between startSec and endSec (e.g. the In/Out marks), leaving the
   * rest (intro, outro) alone. The engine runs on that slice as if it were the whole show, so "open on wide"
   * and pauses behave relative to the range; shots come back in sequence time.
   */
  function planRange(input, config, startSec, endSec) {
    var hop = input.hopSec, fps = input.fps || 30;
    var a = Math.max(0, Math.round(startSec * fps) / fps), b = Math.min(input.durationSec, Math.round(endSec * fps) / fps);
    if (!(b - a > 1)) throw new Error("The In/Out range is too short.");
    var f0 = Math.round(a / hop), f1 = Math.round(b / hop);
    var curves = {};
    Object.keys(input.curves).forEach(function (k) { var c = input.curves[k]; curves[k] = c.slice ? c.slice(f0, f1) : Array.prototype.slice.call(c, f0, f1); });
    var motion = {};
    Object.keys(input.cameraMotion || {}).forEach(function (k) {
      var m = input.cameraMotion[k], g0 = Math.round(a / m.hopSec), g1 = Math.round(b / m.hopSec);
      motion[k] = { hopSec: m.hopSec, values: m.values.slice ? m.values.slice(g0, g1) : Array.prototype.slice.call(m.values, g0, g1) };
    });
    var shift = function (list) {
      return (list || []).map(function (o) { return merge(o, { startSec: o.startSec - a, endSec: o.endSec - a }); })
        .filter(function (o) { return o.endSec > 0 && o.startSec < b - a; });
    };
    var cfg = merge(config, { overrides: shift(config.overrides), removals: shift(config.removals),
      intro: config.intro ? merge(config.intro, { startSec: config.intro.startSec - a, wideSec: config.intro.wideSec - a, endSec: config.intro.endSec - a }) : null });
    var framing = {};
    Object.keys(input.framing || {}).forEach(function (k) { framing[k] = shift(input.framing[k]); });
    var r = plan({ durationSec: b - a, hopSec: hop, fps: fps, curves: curves, cameraMotion: motion, framing: framing }, cfg);
    var sh = function (t) { return round3(t + a); };
    r.shots.forEach(function (s) { s.startSec = sh(s.startSec); s.endSec = sh(s.endSec); });
    r.shots[r.shots.length - 1].endSec = round3(b);
    r.speech.forEach(function (sp) { sp.runs = sp.runs.map(function (x) { return [sh(x[0]), sh(x[1])]; }); });
    r.interjections.forEach(function (ij) { ij.startSec = sh(ij.startSec); ij.endSec = sh(ij.endSec); });
    r.confidence.forEach(function (c) { c.weak = c.weak.map(function (x) { return [sh(x[0]), sh(x[1])]; }); });
    Object.keys(r.stability || {}).forEach(function (k) { r.stability[k].offsetSec = a; });
    r.range = { startSec: a, endSec: b };
    return r;
  }

  /**
   * What to type on a multicam track so every piece in [startSec, endSec) ends up on the angle `desired` asks
   * for, even where an earlier build left edit points (a recut, or undoing one). Cut to Camera only switches up
   * to the next edit point, so each existing piece start gets the angle wanted there, as well as every new cut.
   * desired: [{ sec, camera }] (sorted; the angle holds until the next one). starts: piece starts on the track.
   * -> [{ sec, camera }] sorted, one per boundary (within half a frame merged).
   */
  function multicamRetype(desired, starts, startSec, endSec) {
    var want = desired.slice().sort(function (a, b) { return a.sec - b.sec; });
    if (!want.length) return [];
    function angleAt(t) {
      var cam = want[0].camera;
      for (var i = 0; i < want.length && want[i].sec <= t + 1e-3; i++) cam = want[i].camera;
      return cam;
    }
    var points = [startSec];
    want.forEach(function (c) { if (c.sec >= startSec - 1e-3 && c.sec < endSec - 1e-3) points.push(c.sec); });
    (starts || []).forEach(function (s) { if (s > startSec + 1e-3 && s < endSec - 1e-3) points.push(s); });
    points.sort(function (a, b) { return a - b; });
    var out = [];
    points.forEach(function (t) {
      if (out.length && t - out[out.length - 1].sec < 0.02) return;
      out.push({ sec: round3(t), camera: angleAt(t) });
    });
    return out;
  }

  /**
   * Is a recorded multicam build still on the track? Its cut points (inside [startSec, endSec)) should be piece
   * starts there. A Premiere undo, a fresh assembly into the same sequence, or a sequence that shares an ID with
   * one built before leaves the record without the cuts. Most must be there (a few may have been trimmed by hand).
   * desired: [{ sec }]. starts: piece starts on the track. -> true / false (true when there's nothing to check).
   */
  function multicamBuildPresent(desired, starts, startSec, endSec) {
    var pts = (desired || []).filter(function (c) { return c.sec > startSec + 0.05 && c.sec < endSec - 0.05; });
    if (!pts.length) return true;
    var hit = pts.filter(function (c) { return (starts || []).some(function (s) { return Math.abs(s - c.sec) < 0.06; }); }).length;
    return hit * 2 >= pts.length;
  }

  /**
   * The cut as multicam angle changes, for "Build as multicam": one { sec, camera, cameraId } per shot where the
   * angle changes. A camera's angle is its video track + 1 (nesting V1, V2 keeps that order) unless it has its own
   * `angle`. The first shot is included so the cut starts on the right angle (first: true); everything before it
   * (outside the In/Out range) is left alone.
   * range { startSec, endSec } (optional): only that stretch, opening with the planned angle at startSec. The
   * caller razors the multicam track at both ends first, so the angle changes stay inside the range.
   */
  function toMulticamCuts(result, cameras, range) {
    var byId = {};
    cameras.forEach(function (c) { byId[c.id] = c; });
    var angleOf = function (s) { var c = byId[s.cameraId]; return c ? { angle: c.angle || (c.videoTrack + 1), id: c.id } : null; };
    var out = [], prev = null;
    result.shots.forEach(function (s, i) {
      var a = angleOf(s);
      if (!a || a.angle === prev) return;
      out.push({ sec: s.startSec, camera: a.angle, cameraId: a.id, first: i === 0 });
      prev = a.angle;
    });
    if (!range) return out;
    var shots = result.shots, lo = range.startSec, hi = range.endSec, open = null;
    for (var k = 0; k < shots.length && !open; k++) if (shots[k].startSec <= lo + 1e-6 && shots[k].endSec > lo + 1e-6) open = angleOf(shots[k]);
    var res = open ? [{ sec: lo, camera: open.angle, cameraId: open.id, first: true }] : [];
    out.forEach(function (c) {
      if (c.sec <= lo + 1e-3 || c.sec >= hi - 1e-3) return;
      if (!res.length || res[res.length - 1].camera !== c.camera) res.push({ sec: c.sec, camera: c.camera, cameraId: c.cameraId });
    });
    return res;
  }

  /**
   * Edit instructions for the host. Per video track: where to razor and which stretches to enable.
   *
   * Layered (default): Premiere shows the top-most enabled clip, so the bottom camera track (usually the static
   * wide) is never razored or disabled: it shows wherever nothing above it is enabled. A camera above it only
   * needs a razor where its own on/off state changes; while a camera higher up is showing, the ones below are
   * hidden anyway, so they keep whatever state saves a cut. With two cameras only the top one is ever cut.
   * Not layered: every camera track is cut at every shot change and exactly one is enabled (older behaviour).
   */
  function toEditPayload(result, cameras, fps, opts) {
    opts = opts || {};
    var layered = opts.layered !== false;
    var camById = {};
    cameras.forEach(function (c) { camById[c.id] = c; });
    var cuts = [];
    var shots = result.shots.map(function (s) {
      var a = Math.round(s.startSec * fps), b = Math.round(s.endSec * fps);
      if (a > 0) cuts.push(a);
      return { startFrame: a, endFrame: b, videoTrack: camById[s.cameraId] ? camById[s.cameraId].videoTrack : -1, cameraId: s.cameraId };
    });
    // Range plans also cut at the Out mark so whatever follows (outro) stays exactly as it was.
    if (result.range && shots.length) cuts.push(shots[shots.length - 1].endFrame);

    var trackIds = [];
    cameras.forEach(function (c) { if (c.videoTrack >= 0 && trackIds.indexOf(c.videoTrack) < 0) trackIds.push(c.videoTrack); });
    trackIds.sort(function (x, y) { return x - y; });
    var base = layered && trackIds.length > 1 ? trackIds[0] : -1;
    var tracks = trackIds.map(function (t) {
      // Wanted state per shot: true / false / null (hidden under a higher camera: either is fine).
      var want = shots.map(function (sh) {
        if (t === base) return true;
        if (!layered) return sh.videoTrack === t;
        if (sh.videoTrack === t) return true;
        if (sh.videoTrack < 0 || sh.videoTrack < t) return false; // showing a camera below (or the base): stay out of the way
        return null;
      });
      var firstKnown = null;
      for (var i = 0; i < want.length && firstKnown === null; i++) firstKnown = want[i];
      var prev = firstKnown === null ? false : firstKnown;
      want = want.map(function (w) { if (w === null) return prev; prev = w; return w; });
      var segs = [], tc = [];
      shots.forEach(function (sh, k) {
        var last = segs[segs.length - 1];
        if (last && last.enabled === want[k] && last.endFrame === sh.startFrame) last.endFrame = sh.endFrame;
        else { segs.push({ startFrame: sh.startFrame, endFrame: sh.endFrame, enabled: want[k] }); }
      });
      if (t !== base) {
        segs.forEach(function (sg, k) { if (k > 0 || sg.startFrame > 0) tc.push(sg.startFrame); });
        if (result.range && segs.length) tc.push(segs[segs.length - 1].endFrame);
      }
      return { track: t, base: t === base, cuts: tc, segments: segs };
    });
    return {
      layered: layered,
      cameraTracks: cameras.map(function (c) { return c.videoTrack; }),
      cutFrames: cuts,
      shots: shots,
      tracks: tracks
    };
  }

  return {
    VERSION: "0.23.0",
    DEFAULT_STYLE: DEFAULT_STYLE,
    DEFAULT_SPEAKER: DEFAULT_SPEAKER,
    PRESETS: PRESETS,
    styleFromPreset: styleFromPreset,
    shortSections: shortSections, contentCuts: contentCuts,
    presetForSubjects: presetForSubjects,
    plan: plan,
    planRange: planRange,
    toEditPayload: toEditPayload,
    toMulticamCuts: toMulticamCuts,
    multicamRetype: multicamRetype,
    multicamBuildPresent: multicamBuildPresent,
    cameraMoves: cameraMoves,
    _internal: { smoothRuns: smoothRuns, calibrate: calibrate, percentile: percentile, shotAt: shotAt }
  };
});
