/* PodCutter panel controller. */
(function () {
  "use strict";

  var cs = new CSInterface();
  var inPremiere = !!window.__adobe_cep__;
  var hasNode = typeof require === "function" && typeof process !== "undefined";
  var D = window.PodCutter, T = window.PodTranscript, A = window.PodAnalyzer, W = window.PodTranscriber, UI = window.PD_UI;
  var fs = hasNode ? require("fs") : null, path = hasNode ? require("path") : null, os = hasNode ? require("os") : null;
  var MARK_CAM = "[PD] ", MARK_CUT = "[PD cut] ", MARK_NAME = "[PD name] ", MARK_MOVE = "[PD move] ", MARK_INTRO = "[PD intro] ";
  var HOP = 0.025;

  var state = {
    seq: null,
    config: null,
    curves: {},        // "track:channel" -> Float32Array
    motion: {},        // "v:<videoTrack>" -> { hopSec, values } camera motion
    result: null,
    busy: false,
    tx: { segments: null, suggestions: [], off: {}, nudges: {} },
    cleanupOpts: copy(T.DEFAULTS),
    tools: { ffmpeg: null, whisper: null },
    extRoot: null, docsDir: null,
    selection: null
  };

  // ------------------------------------------------------------ helpers
  function $(id) { return document.getElementById(id); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function log(msg) {
    var line = new Date().toLocaleTimeString() + "  " + msg;
    var pre = $("log"); pre.textContent += line + "\n"; pre.scrollTop = pre.scrollHeight;
    if (window.console) console.log("[PodCutter] " + msg);
  }
  function status(text, kind, pct) {
    var s = $("statusText"); s.textContent = text; s.className = kind || "";
    if (pct !== undefined && pct !== null) $("progFill").style.width = Math.round(pct * 100) + "%";
    if (kind === "err") log("ERROR: " + text);
  }
  function fmt(t) { return T.formatTime(t); }
  /**
   * PodCutter was called PodDirector up to 0.17. The first time, copy the old Documents\PodDirector folder's
   * presets, setups, transcripts and exports to Documents\PodCutter. The old folder is left as it was; big data
   * folders kept there by other tools (edits, motion) aren't the panel's and aren't copied.
   */
  function migrateDocs(from, to) {
    var SKIP = { edits: 1, motion: 1, compare: 1 };
    function copy(a, b, top) {
      fs.mkdirSync(b, { recursive: true });
      fs.readdirSync(a).forEach(function (f) {
        if (top && SKIP[f.toLowerCase()]) return;
        var s = path.join(a, f), d = path.join(b, f);
        if (fs.statSync(s).isDirectory()) copy(s, d, false);
        else if (!fs.existsSync(d)) fs.writeFileSync(d, fs.readFileSync(s));
      });
    }
    try {
      if (fs.existsSync(to) || !fs.existsSync(from)) return;
      copy(from, to, true);
      log("Copied your presets, setups and transcripts from " + from + " (PodCutter used to be called PodDirector).");
    } catch (e) { log("Couldn't copy your old PodDirector settings from " + from + ": " + e.message); }
  }

  function store(key, val) { try { localStorage.setItem("pd." + key, JSON.stringify(val)); } catch (e) { /* ignore */ } }
  function load(key, def) { try { var v = localStorage.getItem("pd." + key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  var timers = {};
  function debounce(name, fn, ms) { clearTimeout(timers[name]); timers[name] = setTimeout(fn, ms || 120); }

  function callHost(fn, args) {
    var call = "PD." + fn + "(" + (args || []).map(function (a) { return JSON.stringify(a); }).join(",") + ")";
    return new Promise(function (resolve, reject) {
      if (!inPremiere) return reject(new Error("Not running inside Premiere Pro."));
      cs.evalScript(call, function (res) {
        if (!res || res === "EvalScript error.") return reject(new Error("Premiere script error in " + fn + ". Is host.jsx loaded?"));
        var o;
        try { o = JSON.parse(res); } catch (e) { return reject(new Error("Unexpected reply from Premiere: " + String(res).slice(0, 200))); }
        if (!o.ok) return reject(new Error(o.error || "Unknown Premiere error"));
        resolve(o);
      });
    });
  }
  function guard(fn) {
    return function () {
      if (state.busy) { status("PodCutter is still busy with the last job — wait for it to finish (see the status line and the Log), then try again.", "err"); return; }
      var args = arguments;
      state.busy = true; setButtons();
      Promise.resolve().then(function () { return fn.apply(null, args); })
        .catch(function (e) { status(e.message || String(e), "err", 0); })
        .then(function () { state.busy = false; setButtons(); });
    };
  }

  // -------------------------------------------------------------- setup
  function init() {
    $("ver").textContent = "v" + D.VERSION;
    if (hasNode) {
      state.extRoot = (inPremiere && cs.getExtensionPath()) || path.resolve(__dirname || ".", "..");
      var docs = inPremiere && cs.getUserDocuments();
      // Only trust a real, existing absolute folder; otherwise use the usual Documents folder.
      try { if (!docs || !path.isAbsolute(docs) || !fs.statSync(docs).isDirectory()) docs = null; } catch (e) { docs = null; }
      state.docsDir = path.join(docs || path.join(os.homedir(), "Documents"), "PodCutter");
      migrateDocs(path.join(path.dirname(state.docsDir), "PodDirector"), state.docsDir);
      try { fs.mkdirSync(path.join(state.docsDir, "presets"), { recursive: true }); } catch (e) { /* ignore */ }
      $("docsDir").textContent = state.docsDir;
    }
    $("ffmpegCustom").value = load("ffmpegCustom", "");
    $("modelCustom").value = load("modelCustom", "");
    $("txPrompt").value = load("txPrompt", "");
    state.cleanupOpts = Object.assign(copy(T.DEFAULTS), load("cleanupOpts", {}));
    state.cleanupOpts.showName = load("showName", "Classical et cetera");
    $("showName").value = state.cleanupOpts.showName;

    // tabs
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (x) { x.classList.toggle("active", x === b); });
        Array.prototype.forEach.call(document.querySelectorAll(".page"), function (p) { p.classList.toggle("active", p.id === "page-" + b.dataset.tab); });
        if (b.dataset.tab === "multicam") viz.render();
      });
    });
    $("btnLog").addEventListener("click", function () { $("log").classList.toggle("hidden"); });

    state.config = defaultConfig();
    renderAll();
    renderCleanupControls();
    checkTools();
    if (!inPremiere) {
      status("Not running in Premiere — demo mode. Click Scan to load a sample podcast.", "", 0);
    }
  }

  function defaultConfig() {
    return { preset: "balanced", userPreset: null, style: {}, speakers: [], cameras: [], overrides: [] };
  }

  function checkTools() {
    if (!hasNode) { $("ffmpegPath").textContent = "Node.js unavailable"; return Promise.resolve(); }
    return A.findFfmpeg({ customPath: $("ffmpegCustom").value.trim(), extensionRoot: state.extRoot }).then(function (r) {
      state.tools.ffmpeg = r.ok ? r.path : null;
      $("ffmpegPath").textContent = r.ok ? r.path : "NOT FOUND";
      if (!r.ok) { log("ffmpeg lookup tried: " + (r.tried || []).join(" | ")); status(r.error, "err"); }
      var w = W.locate({ extensionRoot: state.extRoot, modelPath: $("modelCustom").value.trim() });
      state.tools.whisper = w.ok ? w : null;
      $("whisperPath").textContent = w.whisper || "not found";
      $("modelPath").textContent = w.model ? path.basename(w.model) : "not found";
      if (!w.ok) log("Transcriber: " + w.error);
    });
  }

  // --------------------------------------------------------------- scan
  var scan = guard(function () {
    status("Reading the active sequence…", "", 0.05);
    var p = inPremiere ? callHost("getSequenceInfo") : Promise.resolve(window.PD_DEMO.sequence());
    return p.then(function (info) {
      var changed = !state.seq || state.seq.sequenceID !== info.sequenceID;
      state.seq = expandNests(info);
      tagLenses(state.seq);
      forgetDeletedCopy(info.sequenceID);
      forgetUndoneMulticam(info.sequenceID);
      $("seqLabel").textContent = info.name + " · " + info.fps.toFixed(2) + " fps · " + fmt(info.durationSec);
      log("Sequence " + info.name + ": " + info.audioTracks.length + " audio, " + info.videoTracks.filter(function (v) { return !v.virtual; }).length + " video tracks, " + fmt(info.durationSec));
      info.videoTracks.forEach(function (v) {
        if (v.nest) log("V" + (v.index + 1) + " holds the " + (v.nest.multicam ? "multicam" : "nested") + " sequence “" + v.nest.name + "” with " +
          v.nest.angles.length + " angle(s): " + v.nest.angles.map(function (a) { return a.angle + " = " + a.name + " (" + a.clips.length + " clips)"; }).join(", "));
      });
      if (changed) {
        var saved = load("seq." + info.name, null);
        var last = load("lastSetup", null), lastSetup = last ? userSetups()[last] : null;
        if (saved && validConfig(saved, info)) {
          state.config = saved;
          setNote("Restored your last settings for this sequence.");
        } else if (lastSetup && setupMatches(lastSetup, info)) {
          state.config = applySetup(lastSetup, info);
          setNote("Applied your saved setup \u201C" + last + "\u201D (track names match).");
        } else {
          state.config = guessConfig(info);
          setNote(describeGuess(state.config, info));
        }
        state.result = null; state.curves = {}; state.motion = {}; state.framing = {};
        state.tx = { segments: null, suggestions: [], off: {}, nudges: {} };
        loadCachedTranscript();
      }
      // Cameras moved into a multicam nest: a camera left pointing at an empty track can't be seen (nor checked
      // for movement), so follow the cameras into the nest's angles.
      if (nestAngleTracks().length && !usesNest() && state.config.cameras.some(function (c) {
        var t = vtrack(c.videoTrack); return c.enabled !== false && (!t || !t.clipCount);
      })) {
        useNestAngles();
        setNote("Your cameras now sit inside the multicam nest on V" + (nestAngleTracks()[0].nestTrack + 1) +
          ", so PodCutter reads them there: " + state.config.cameras.filter(function (c) { return c.angle; }).map(function (c) { return c.name + " = angle " + c.angle; }).join(", ") + ".");
        log("Cameras switched to the nest's angles (their stacked tracks were empty).");
      }
      // A camera on a nest angle builds as that angle (a saved setup can carry another episode's numbering).
      var angleFixed = false;
      state.config.cameras.forEach(function (c) {
        var t = c.videoTrack >= NEST_BASE ? vtrack(c.videoTrack) : null;
        if (t && t.angle && c.angle !== t.angle) { log("“" + c.name + "” is multicam angle " + t.angle + " (was set to " + c.angle + ")."); c.angle = t.angle; angleFixed = true; }
      });
      if (angleFixed) saveConfig();
      var wideFix = enforceWide();
      if (wideFix) { saveConfig(); setNote(($("setupNote").textContent ? $("setupNote").textContent + " " : "") + wideFix); log(wideFix); }
      var fixedN = fixChannels(state.config, info);
      if (fixedN) {
        saveConfig();
        setNote(($("setupNote").textContent ? $("setupNote").textContent + " " : "") + "Your mics share one multichannel file, so each speaker now reads its own channel (" +
          state.config.speakers.map(function (sp) { return sp.name + " = Ch " + (sp.channel + 1); }).join(", ") + ").");
      }
      renderAll();
      status("Sequence ready. Check speakers and cameras, then Analyze waveforms.", "ok", 0);
    });
  });

  function validConfig(c, info) {
    return c.speakers && c.cameras && c.speakers.every(function (s) { return s.audioTrack < info.audioTracks.length; }) &&
      c.cameras.every(function (cm) { return !!vtrackIn(info, cm.videoTrack); });
  }

  // ------------------------------------------------------- multicam nests
  // A nested (multicam) sequence on a video track: each of its angles becomes a virtual camera track, numbered
  // NEST_BASE + outer track * 16 + angle, with the angle's clips mapped onto this timeline. They're analyzed like
  // stacked camera tracks (movement, who's in the shot) and built with Build as multicam.
  var NEST_BASE = 100;
  function expandNests(info) {
    info.videoTracks.slice().forEach(function (v) {
      if (!v.nest) return;
      v.nestOuter = true;
      v.nest.angles.forEach(function (a) {
        var media = []; a.clips.forEach(function (c) { if (c.mediaPath && media.indexOf(c.mediaPath) < 0) media.push(c.mediaPath); });
        info.videoTracks.push({ index: NEST_BASE + v.index * 16 + a.angle, virtual: true, nestTrack: v.index, angle: a.angle,
          angleName: a.name && !/^(video|v)\s*\d+$/i.test(a.name) ? a.name : null,
          name: "nest angle " + a.angle + (a.name && !/^(video|v)\s*\d+$/i.test(a.name) ? " (" + a.name + ")" : ""),
          clipCount: a.clips.length, clips: a.clips, mediaPaths: media, firstClip: media.length ? media[0].split(/[\\/]/).pop() : null,
          endSec: a.clips.reduce(function (m, c) { return Math.max(m, c.endSec); }, 0) });
      });
    });
    return info;
  }
  // ------------------------------------------------------- the wide by lens
  // The static wide is always shot on the 24-70 (the solos on the 70-200), but which track or multicam angle it
  // lands on varies. Sony's metadata names the lens, so each camera track is tagged with it at Scan.
  var WIDE_LENS = /24-70/;
  function tagLenses(info) {
    if (!hasNode || !A.lensOf) return;
    info.videoTracks.forEach(function (v) {
      if (v.nestOuter) return;
      var lenses = {};
      (v.mediaPaths || []).slice(0, 3).forEach(function (m) { var l = A.lensOf(m); if (l) lenses[l] = (lenses[l] || 0) + 1; });
      var best = null; Object.keys(lenses).forEach(function (l) { if (!best || lenses[l] > lenses[best]) best = l; });
      v.lens = best;
      if (best) log((v.virtual ? "Multicam angle " + v.angle : "V" + (v.index + 1)) + " was shot on the " + best + ".");
    });
  }
  /** The enabled camera on the 24-70, when exactly one is. */
  function lensWide() {
    var hits = state.config.cameras.filter(function (c) { var t = vtrack(c.videoTrack); return c.enabled !== false && t && t.lens && WIDE_LENS.test(t.lens); });
    return hits.length === 1 ? hits[0] : null;
  }
  /** The wide: the 24-70 camera, else the bottom camera that shows everyone. */
  function wideCam() {
    var w = lensWide();
    if (w) return w;
    var cams = state.config.cameras.filter(function (c) { return c.enabled !== false && !c.follows; }).sort(function (a, b) { return angleOfCam(a) - angleOfCam(b); });
    return cams.filter(function (c) { return c.shows.length && c.shows.length >= state.config.speakers.length; })[0] || cams[0] || null;
  }
  /**
   * At Scan: make the 24-70 camera the static wide (everyone, no movement check, not following), whatever track
   * or angle it's on. With two cameras, the other one is then the operated dolly. Returns a note, or null.
   */
  function enforceWide() {
    var wide = lensWide();
    if (!wide || !state.config.speakers.length) return null;
    var all = state.config.speakers.map(function (s) { return s.id; }), notes = [];
    if (wide.follows || wide.moving || !wide.static || wide.shows.length !== all.length) {
      wide.shows = all.slice(); wide.follows = false; wide.moving = false; wide.static = true;
      notes.push("“" + wide.name + "” is the static wide");
    }
    var others = state.config.cameras.filter(function (c) { return c !== wide && c.enabled !== false; });
    // Set as a second wide, or (three or more people) as a close-up of one of them: it's the operated camera.
    var o1 = others.length === 1 ? others[0] : null;
    if (o1 && all.length > 1 && !o1.follows && (o1.shows.length === all.length || (all.length > 2 && !o1.static))) {
      o1.follows = true; o1.moving = true; o1.static = false; o1.shows = [];
      notes.push("“" + o1.name + "” follows the speaker with Check for movement on");
    }
    if (!notes.length) return null;
    var t = vtrack(wide.videoTrack);
    return "Shot on the " + t.lens + ", so " + notes.join("; ") + ".";
  }

  function vtrackIn(info, idx) { return info.videoTracks.filter(function (v) { return v.index === idx; })[0] || null; }
  function vtrack(idx) { return state.seq ? vtrackIn(state.seq, idx) : null; }
  function nestAngleTracks() { return state.seq ? state.seq.videoTracks.filter(function (v) { return v.virtual; }) : []; }
  function usesNest() { return state.config.cameras.some(function (c) { return c.enabled !== false && c.videoTrack >= NEST_BASE; }); }

  /** Point the cameras at the nest's angles, in track order (bottom camera = angle 1), keeping their settings. */
  function useNestAngles() {
    var angles = nestAngleTracks();
    if (!angles.length) return;
    var cams = state.config.cameras.filter(function (c) { return c.videoTrack < NEST_BASE; }).sort(function (a, b) { return a.videoTrack - b.videoTrack; });
    cams.forEach(function (c, i) {
      var t = angles[i];
      if (t) { c.videoTrack = t.index; c.angle = t.angle; } else c.enabled = false;
    });
    state.motion = {}; state.framing = {};
    renderCameras(); renderStyle(); changed();
    status("Cameras now read the nest's angles: " + cams.filter(function (c) { return c.angle; }).map(function (c) { return c.name + " = angle " + c.angle; }).join(", ") +
      ". Analyze again to check the dolly for movement.", "ok");
  }

  var NON_VOICE = /(^|[^a-z])(sfx|fx|music|mus|bed|beds|mix|mixdown|master|room|amb|ambience|ambient|nat|stinger|stem|stems|bgm|song|intro|outro|scratch|camera|cam)([^a-z]|$)/i;
  var VOX = /vox|voice|vocal/i;

  /** Audio tracks most likely to be speaker mics, best first: VOX-named tracks win outright. */
  function voiceTracks(info) {
    var camMedia = {};
    info.videoTracks.forEach(function (v) { (v.mediaPaths || []).forEach(function (m) { camMedia[m] = true; }); });
    var audio = info.audioTracks.filter(function (a) { return a.clips.length && !a.muted; });
    var vox = audio.filter(function (a) { return VOX.test(a.name); });
    if (vox.length) return vox;
    // Otherwise: not camera scratch audio, and not obviously music / sfx / mix tracks.
    var mics = audio.filter(function (a) { return !a.clips.some(function (c) { return camMedia[c.mediaPath]; }) && !NON_VOICE.test(a.name); });
    return mics.length ? mics : audio.filter(function (a) { return !NON_VOICE.test(a.name); });
  }

  /**
   * Multichannel sources (a recorder or camera file carrying several mics): Premiere lays the channels of one
   * file onto consecutive audio tracks (A1 = Ch 1, A2 = Ch 2, ...). Find that group for a track and return its
   * channel number, or null when the track's media isn't shared with other tracks.
   */
  function autoChannel(info, trackIndex) {
    var track = info.audioTracks[trackIndex];
    if (!track || !track.clips.length) return null;
    var votes = {};
    track.clips.slice(0, 6).forEach(function (c) {
      var group = info.audioTracks.filter(function (t) {
        return t.clips.some(function (o) { return o.mediaPath === c.mediaPath && Math.abs(o.startSec - c.startSec) < 0.02 && Math.abs(o.inPointSec - c.inPointSec) < 0.02; });
      }).map(function (t) { return t.index; }).sort(function (a, b) { return a - b; });
      if (group.length > 1) { var k = group.indexOf(trackIndex); votes[k] = (votes[k] || 0) + 1; }
    });
    var best = null, n = 0;
    Object.keys(votes).forEach(function (k) { if (votes[k] > n) { n = votes[k]; best = +k; } });
    return best;
  }
  /** Channel of one clip: its position among the tracks that carry the same file at the same time, or null. */
  function clipChannel(info, trackIndex, clip) {
    var group = info.audioTracks.filter(function (t) {
      return t.clips.some(function (o) { return o.mediaPath === clip.mediaPath && Math.abs(o.startSec - clip.startSec) < 0.02 && Math.abs(o.inPointSec - clip.inPointSec) < 0.02; });
    }).map(function (t) { return t.index; }).sort(function (a, b) { return a - b; });
    return group.length > 1 ? group.indexOf(trackIndex) : null;
  }
  /**
   * The speaker's track with a channel decided per clip: auto mode follows each clip's own layout (the episode's
   * 4-channel file, a mono outro WAV...); a channel picked by hand applies to clips that are part of a group.
   */
  // ------------------------------------------------------------ range
  /** Active analysis range in sequence seconds ({a, b}), or null for the whole sequence. */
  function currentRange() {
    var q = state.seq;
    if (!q || state.config.range === "all") return null;
    var a = q.inSec || 0, b = q.outSec || q.durationSec;
    if (q.inSec == null && q.outSec == null) return null;
    return b - a > 1 ? { a: a, b: b } : null;
  }
  function renderRangeSelect() {
    var s = $("rangeSelect"), q = state.seq; s.innerHTML = "";
    var marks = q && (q.inSec != null || q.outSec != null);
    if (marks) s.appendChild(el("option", { value: "inout", text: "Between In and Out marks (" + fmt(q.inSec || 0) + " \u2013 " + fmt(q.outSec || q.durationSec) + ")" }));
    s.appendChild(el("option", { value: "all", text: "Whole sequence" + (q ? " (" + fmt(q.durationSec) + ")" : "") + (q && !marks ? " \u2014 set In/Out marks to limit" : "") }));
    s.value = marks && state.config.range !== "all" ? "inout" : "all";
    s.disabled = !q;
  }
  /** Trim a track's clips to the analysis range (keeps source in-points in step). */
  function trimToRange(track) {
    var r = currentRange();
    if (!r) return track;
    var out = {}; for (var k in track) out[k] = track[k];
    out.clips = (track.clips || []).filter(function (c) { return c.endSec > r.a && c.startSec < r.b; }).map(function (c) {
      var cc = copy(c), speed = c.speed > 0 ? c.speed : 1;
      if (cc.startSec < r.a) { cc.inPointSec = (cc.inPointSec || 0) + (r.a - cc.startSec) * speed; cc.startSec = r.a; }
      if (cc.endSec > r.b) cc.endSec = r.b;
      return cc;
    });
    return out;
  }

  /** A speaker's mic as clips with their channel. full: the whole sequence (analysis); otherwise trimmed to the range. */
  function speakerTrack(sp, full) {
    var info = state.seq, t = info.audioTracks[sp.audioTrack];
    return (full ? function (x) { return x; } : trimToRange)({ index: t.index, name: t.name, clips: t.clips.map(function (c) {
      var cc = copy(c), auto = clipChannel(info, sp.audioTrack, c);
      if (sp.channelManual) cc.channel = (sp.channel === null || sp.channel === undefined) ? null : (auto === null ? null : sp.channel);
      else cc.channel = auto;
      return cc;
    }) });
  }

  /** Set channels for speakers left on "All ch" whose track is part of a multichannel group. Returns how many changed. */
  function fixChannels(cfg, info) {
    var changedN = 0;
    cfg.speakers.forEach(function (sp) {
      if (sp.channelManual || (sp.channel !== null && sp.channel !== undefined)) return;
      var ch = autoChannel(info, sp.audioTrack);
      if (ch !== null) { sp.channel = ch; changedN++; }
    });
    return changedN;
  }

  /** subjects: optional number of people on mic (4 = "4 or more"). */
  function guessConfig(info, subjects, previous) {
    var cfg = defaultConfig();
    var mics = voiceTracks(info);
    var take = subjects ? (subjects >= 4 ? Math.max(4, Math.min(8, mics.length)) : subjects) : Math.min(8, mics.length);
    var prevByTrack = {};
    ((previous && previous.speakers) || []).forEach(function (sp) { prevByTrack[sp.audioTrack] = sp; });
    mics.slice(0, take).forEach(function (a, i) {
      var generic = /^(audio|a|vox|voice|mic)\s*\d*$/i.test(a.name.trim());
      var prev = prevByTrack[a.index];
      cfg.speakers.push({ id: "S" + (i + 1), name: prev ? prev.name : (generic ? "Speaker " + (i + 1) : a.name), audioTrack: a.index, channel: null,
        thresholdDb: null, biasDb: prev ? prev.biasDb || 0 : 0, minShotSec: null, interjections: true, reactionShots: true, enabled: true });
    });
    if (subjects) cfg.preset = D.presetForSubjects(cfg.speakers.length);
    fixChannels(cfg, info);
    // A multicam nest's angles stand in for the cameras when there is one (the nest track itself isn't a camera).
    var vids = info.videoTracks.filter(function (v) { return v.clipCount > 0 && v.virtual; });
    if (!vids.length) vids = info.videoTracks.filter(function (v) { return v.clipCount > 0 && !v.virtual; });
    var GENERIC = { mic: 1, microphone: 1, audio: 1, lav: 1, track: 1, speaker: 1, cam: 1, camera: 1 };
    function tokens(n) { return n.toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w && !GENERIC[w] && !/^\d+$/.test(w); }); }
    var allIds = cfg.speakers.map(function (s) { return s.id; });
    var next = 0;
    vids.forEach(function (v, i) {
      var nm = v.virtual ? (v.angleName || v.firstClip || "Angle " + v.angle)
        : (v.name && !/^(video|v)\s*\d+$/i.test(v.name)) ? v.name : (v.firstClip || ("V" + (v.index + 1)));
      var words = tokens(nm);
      var shows;
      var byName = cfg.speakers.filter(function (s) { return tokens(s.name).some(function (w) { return words.indexOf(w) >= 0; }); });
      // The bottom camera is always the wide: it stays whole under the others.
      if (i === 0 || /wide|master|group|2.?shot|two.?shot|\ball\b/i.test(nm)) shows = allIds.slice();
      else if (byName.length) shows = byName.map(function (s) { return s.id; });
      else if (next < cfg.speakers.length) shows = [cfg.speakers[next++].id];
      else shows = allIds.slice();
      var moving = /dolly|slider|jib|crane|handheld|hand-held|gimbal|steadicam|roam|rover|moving|operat|follow|track/i.test(nm);
      var follows = i > 0 && /follow|roam|rover|operat/i.test(nm);
      cfg.cameras.push({ id: "C" + (i + 1), name: nm.replace(/\.[a-z0-9]{2,4}$/i, ""), videoTrack: v.index, shows: follows ? [] : shows,
        moving: moving, follows: follows, enabled: true, angle: v.virtual ? v.angle : undefined });
    });
    // One wide plus a single moving camera, several speakers: that camera is almost certainly
    // operated to follow whoever is talking.
    var nonWide = cfg.cameras.filter(function (c) { return c.shows.length !== allIds.length || c.follows; });
    if (cfg.speakers.length > 1 && nonWide.length === 1 && nonWide[0].moving) { nonWide[0].follows = true; nonWide[0].shows = []; }
    cfg.setup = subjects ? "n" + subjects : "auto";
    return cfg;
  }

  function describeGuess(cfg, info) {
    var names = cfg.speakers.map(function (s) { return "A" + (s.audioTrack + 1) + (info.audioTracks[s.audioTrack] ? " " + info.audioTracks[s.audioTrack].name : "") + (s.channel !== null && s.channel !== undefined ? " (Ch " + (s.channel + 1) + ")" : ""); });
    var vox = info.audioTracks.some(function (a) { return VOX.test(a.name); });
    return cfg.speakers.length ? "Found " + cfg.speakers.length + " speaker mic" + (cfg.speakers.length > 1 ? "s" : "") + (vox ? " (VOX tracks)" : "") + ": " + names.join(", ") + "."
      : "No speaker mics found. Name your mic tracks VOX1, VOX2\u2026 or add speakers below.";
  }
  function setNote(t) { var n = $("setupNote"); if (n) n.textContent = t || ""; }

  // ------------------------------------------------------------- setups
  // A setup = who's on which mic track, which camera track shows whom, plus the cutting style.
  // Tracks are matched by name first (so "VOX1 = Martin" carries across episodes), then by position.
  function userSetups() {
    var list = load("setups", {});
    if (hasNode && state.docsDir) {
      try {
        fs.readdirSync(path.join(state.docsDir, "setups")).forEach(function (f) {
          if (!/\.json$/.test(f)) return;
          try { var p = JSON.parse(fs.readFileSync(path.join(state.docsDir, "setups", f), "utf8")); list[p.name || f.replace(/\.json$/, "")] = p; } catch (e) { /* skip */ }
        });
      } catch (e) { /* none yet */ }
    }
    return list;
  }

  function captureSetup(name) {
    var c = state.config, info = state.seq;
    var nameOf = {}; c.speakers.forEach(function (sp) { nameOf[sp.id] = sp.name; });
    return {
      name: name, kind: "poddirector-setup", savedAt: new Date().toISOString(),
      preset: c.preset, style: copy(c.style || {}),
      speakers: c.speakers.map(function (sp) {
        return { name: sp.name, trackName: info.audioTracks[sp.audioTrack] ? info.audioTracks[sp.audioTrack].name : null, audioTrack: sp.audioTrack,
          channel: sp.channel, channelManual: !!sp.channelManual, thresholdDb: sp.thresholdDb, biasDb: sp.biasDb, minShotSec: sp.minShotSec,
          interjections: sp.interjections, reactionShots: sp.reactionShots, enabled: sp.enabled };
      }),
      cameras: c.cameras.map(function (cm) {
        return { name: cm.name, trackName: vtrackIn(info, cm.videoTrack) ? vtrackIn(info, cm.videoTrack).name : null, videoTrack: cm.videoTrack,
          shows: cm.shows.map(function (id) { return nameOf[id]; }).filter(Boolean), moving: !!cm.moving, follows: !!cm.follows, static: !!cm.static, enabled: cm.enabled,
          angle: cm.angle };
      })
    };
  }

  function findTrack(list, name, index) {
    if (name) {
      var n = String(name).trim().toLowerCase();
      for (var i = 0; i < list.length; i++) if (String(list[i].name).trim().toLowerCase() === n) return list[i].index;
    }
    return list.some(function (t) { return t.index === index; }) ? index : -1; // virtual nest-angle tracks aren't at their own position
  }
  function setupMatches(setup, info) {
    return setup.speakers.every(function (s) { return s.trackName && findTrack(info.audioTracks, s.trackName, -1) >= 0; }) &&
      setup.cameras.every(function (c) { return c.trackName && findTrack(info.videoTracks, c.trackName, -1) >= 0; });
  }

  function applySetup(setup, info) {
    var cfg = defaultConfig(), missing = [];
    cfg.preset = setup.preset || "balanced"; cfg.style = copy(setup.style || {}); cfg.setup = "u:" + setup.name;
    var idByName = {};
    setup.speakers.forEach(function (s, i) {
      var t = findTrack(info.audioTracks, s.trackName, s.audioTrack);
      if (t < 0) { missing.push(s.name + " (" + s.trackName + ")"); return; }
      var id = "S" + (i + 1); idByName[s.name] = id;
      cfg.speakers.push({ id: id, name: s.name, audioTrack: t, channel: s.channel === undefined ? null : s.channel, channelManual: !!s.channelManual, thresholdDb: s.thresholdDb === undefined ? null : s.thresholdDb,
        biasDb: s.biasDb || 0, minShotSec: s.minShotSec === undefined ? null : s.minShotSec, interjections: s.interjections !== false,
        reactionShots: s.reactionShots !== false, enabled: s.enabled !== false });
    });
    setup.cameras.forEach(function (c, i) {
      var t = findTrack(info.videoTracks, c.trackName, c.videoTrack);
      if (t < 0) { missing.push(c.name + " (" + c.trackName + ")"); return; }
      cfg.cameras.push({ id: "C" + (i + 1), name: c.name, videoTrack: t, shows: (c.shows || []).map(function (n) { return idByName[n]; }).filter(Boolean),
        moving: !!c.moving, follows: !!c.follows, static: !!c.static, enabled: c.enabled !== false, angle: c.angle });
    });
    cfg._missing = missing;
    return cfg;
  }

  function renderSetupSelect() {
    var s = $("setupSelect"); s.innerHTML = "";
    [["auto", "Auto-detect from track names"], ["n1", "1 subject"], ["n2", "2 subjects"], ["n3", "3 subjects"], ["n4", "4+ subjects"]]
      .forEach(function (o) { s.appendChild(el("option", { value: o[0], text: o[1] })); });
    var ups = userSetups(), names = Object.keys(ups).sort();
    if (names.length) {
      var g = el("optgroup", { label: "Saved setups" });
      names.forEach(function (n) { g.appendChild(el("option", { value: "u:" + n, text: "\u2605 " + n })); });
      s.appendChild(g);
    }
    var cur = state.config.setup || "auto";
    if (cur.indexOf("u:") === 0 && !ups[cur.slice(2)]) cur = "auto";
    s.value = cur;
    $("btnDeleteSetup").classList.toggle("hidden", cur.indexOf("u:") !== 0);
    s.disabled = !state.seq;
  }

  function chooseSetup(v) {
    if (!state.seq) return;
    var prev = state.config;
    if (v === "auto") { state.config = guessConfig(state.seq, null, prev); setNote(describeGuess(state.config, state.seq)); }
    else if (v.charAt(0) === "n") {
      var n = +v.slice(1);
      state.config = guessConfig(state.seq, n, prev);
      var got = state.config.speakers.length;
      setNote((got < n ? "Only found " + got + " voice track" + (got === 1 ? "" : "s") + ". " : "") +
        describeGuess(state.config, state.seq) + " Style set to \u201C" + D.PRESETS[state.config.preset].label + "\u201D.");
    } else {
      var name = v.slice(2), setup = userSetups()[name];
      if (!setup) return;
      state.config = applySetup(setup, state.seq);
      store("lastSetup", name);
      setNote("Applied \u201C" + name + "\u201D." + (state.config._missing.length ? " Not found in this sequence: " + state.config._missing.join(", ") + "." : ""));
    }
    delete state.config._missing;
    state.config.overrides = [];
    renderAll(); changed();
  }

  function saveSetup() {
    if (!state.seq) return;
    var card = $("setupSelect").parentNode;
    if (card.parentNode.querySelector(".inline-input")) return;
    var input = el("input", { placeholder: "Setup name, e.g. Classical et cetera" });
    var wrap = el("div", { class: "inline-input" }, [input,
      el("button", { class: "btn primary small", text: "Save", onclick: function () {
        var name = input.value.trim().replace(/[\\/:*?"<>|]+/g, "-");
        if (!name) return;
        var setup = captureSetup(name);
        var all = load("setups", {}); all[name] = setup; store("setups", all);
        if (hasNode && state.docsDir) {
          try { fs.mkdirSync(path.join(state.docsDir, "setups"), { recursive: true }); fs.writeFileSync(path.join(state.docsDir, "setups", name + ".json"), JSON.stringify(setup, null, 2)); }
          catch (e) { log("Could not write setup file: " + e.message); }
        }
        state.config.setup = "u:" + name; store("lastSetup", name); saveConfig();
        wrap.remove(); renderSetupSelect();
        setNote("Saved \u201C" + name + "\u201D. It will be applied automatically to new sequences whose track names match.");
      } }),
      el("button", { class: "btn ghost small", text: "Cancel", onclick: function () { wrap.remove(); } })]);
    card.parentNode.insertBefore(wrap, card.nextSibling);
    input.focus();
  }

  function deleteSetup() {
    var v = $("setupSelect").value;
    if (v.indexOf("u:") !== 0) return;
    var name = v.slice(2), card = $("setupSelect").parentNode;
    confirmBox(card, "Delete the saved setup \u201C" + name + "\u201D?", "Delete", function () {
      var all = load("setups", {}); delete all[name]; store("setups", all);
      if (hasNode && state.docsDir) { try { fs.unlinkSync(path.join(state.docsDir, "setups", name + ".json")); } catch (e) { /* not on disk */ } }
      if (load("lastSetup", null) === name) store("lastSetup", null);
      state.config.setup = "auto"; saveConfig(); renderSetupSelect();
      setNote("Deleted \u201C" + name + "\u201D. Your current speakers and cameras are unchanged.");
    });
  }

  var TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  function trashButton(title, onClick) {
    var b = el("button", { class: "icon trash", title: title, onclick: onClick });
    b.innerHTML = TRASH_SVG;
    return b;
  }
  /** Inline "are you sure?" that temporarily replaces an element's content. */
  function confirmBox(host, message, yesLabel, onYes) {
    var saved = Array.prototype.slice.call(host.childNodes);
    host.innerHTML = "";
    function restore() { host.innerHTML = ""; saved.forEach(function (n) { host.appendChild(n); }); }
    var box = el("div", { class: "confirm" }, [
      el("span", { text: message }),
      el("button", { class: "btn danger small", text: yesLabel, onclick: function () { onYes(); } }),
      el("button", { class: "btn ghost small", text: "Cancel", onclick: restore })
    ]);
    host.appendChild(box);
    box.querySelector(".btn.danger").focus();
  }

  function saveConfig() { if (state.seq) store("seq." + state.seq.name, state.config); }

  // ------------------------------------------------------------ render
  function renderAll() {
    renderSetupSelect(); renderRangeSelect(); renderSpeakers(); renderCameras(); renderPresetSelect(); renderStyle(); renderLocks(); setButtons(); renderMcRow();
  }

  function colorOf(i) { return UI.colors[i % UI.colors.length]; }
  function trackOptions(kind) {
    if (!state.seq) return [];
    var list = kind === "audio" ? state.seq.audioTracks : state.seq.videoTracks;
    return list.map(function (t) {
      if (t.virtual) return [t.index, "V" + (t.nestTrack + 1) + " " + t.name];
      return [t.index, (kind === "audio" ? "A" : "V") + (t.index + 1) + (t.name && !/^(audio|video|a|v)\s*\d+$/i.test(t.name) ? " · " + t.name : "") + (t.nestOuter ? " (multicam nest)" : "")];
    });
  }
  function select(options, value, onchange, cls) {
    var s = el("select", { class: cls || "", onchange: function () { onchange(s.value); } });
    options.forEach(function (o) { var op = el("option", { value: o[0], text: o[1] }); if (String(o[0]) === String(value)) op.selected = true; s.appendChild(op); });
    return s;
  }
  function changed(replanOnly) { saveConfig(); if (!replanOnly) setButtons(); renderShortWides(); renderV1Warning(); debounce("plan", replan, 120); }

  function renderSpeakers() {
    var box = $("speakerList"); box.innerHTML = "";
    if (!state.config.speakers.length) { box.appendChild(el("div", { class: "muted", text: state.seq ? "No speaker mics found. Add one." : "Scan a sequence to begin." })); return; }
    state.config.speakers.forEach(function (sp, i) {
      var row = el("div", { class: "row" + (sp._open ? " open" : "") });
      row.style.setProperty("--sw", colorOf(i));
      var name = el("input", { class: "name", value: sp.name, oninput: function () { sp.name = name.value; renderCameras(); renderFeature(); changed(true); debounce("intro", runCleanup, 400); } });
      var chans = [["mix", "All ch"], [0, "Ch 1"], [1, "Ch 2"], [2, "Ch 3"], [3, "Ch 4"], [4, "Ch 5"], [5, "Ch 6"], [6, "Ch 7"], [7, "Ch 8"]];
      var main = el("div", { class: "row-main" }, [
        name,
        select(trackOptions("audio"), sp.audioTrack, function (v) {
          sp.audioTrack = +v;
          if (!sp.channelManual && state.seq) sp.channel = autoChannel(state.seq, sp.audioTrack);
          renderSpeakers(); changed();
        }),
        select(chans, sp.channel === null || sp.channel === undefined ? "mix" : sp.channel, function (v) { sp.channel = v === "mix" ? null : +v; sp.channelManual = true; changed(); }),
        el("button", { class: "icon", title: "More settings", text: sp._open ? "▾" : "⚙", onclick: function () { sp._open = !sp._open; renderSpeakers(); } }),
        trashButton("Remove this speaker", function () {
          confirmBox(row, "Remove speaker \u201C" + sp.name + "\u201D? Their mic will be ignored.", "Remove", function () {
            state.config.speakers = state.config.speakers.filter(function (x) { return x !== sp; });
            state.config.cameras.forEach(function (c) { c.shows = c.shows.filter(function (id) { return id !== sp.id; }); });
            renderAll(); changed();
          });
        })
      ]);
      row.appendChild(main);
      var cal = state.result && calFor(sp.id);
      if (cal) {
        var lv = el("div", { class: "level", title: "noise floor → speech level; white line = threshold" });
        var lo = -70, hi = -6, pos = function (db) { return Math.max(0, Math.min(100, (db - lo) / (hi - lo) * 100)); };
        var bar = el("i"); bar.style.left = pos(cal.floorDb) + "%"; bar.style.width = (pos(cal.speechDb) - pos(cal.floorDb)) + "%";
        var th = el("b"); th.style.left = pos(cal.thresholdDb) + "%";
        lv.appendChild(bar); lv.appendChild(th); row.appendChild(lv);
      }
      var more = el("div", { class: "row-more" });
      var auto = sp.thresholdDb === null || sp.thresholdDb === undefined;
      var autoVal = cal ? cal.autoThresholdDb : -45;
      more.appendChild(slider({ label: "Threshold", min: -75, max: -10, step: 1, unit: "dB",
        help: "Level above which this mic counts as talking. Auto calibrates from the noise floor and speech level." },
        auto ? autoVal : sp.thresholdDb, function (v) { sp.thresholdDb = v; changed(true); },
        { autoToggle: auto, onAuto: function (on) { sp.thresholdDb = on ? null : Math.round(autoVal); renderSpeakers(); changed(true); },
          reset: function () { sp.thresholdDb = null; renderSpeakers(); changed(true); } }));
      more.appendChild(slider({ label: "Min close-up", min: 0, max: 20, step: 0.5, unit: "s", zero: "global",
        help: "Minimum length for this speaker's close-ups. 0 = use Minimum close-up under Cutting style." },
        sp.minShotSec || 0, function (v) { sp.minShotSec = v > 0 ? v : null; changed(true); }, { reset: 0 }));
      var chips = el("div", { class: "chips" }, [
        chip("Reacts on screen", sp.interjections !== false, function (on) { sp.interjections = on; changed(true); },
          "Their laughs / “yeah”s can trigger a reaction shot of them"),
        chip("Use as listener", sp.reactionShots !== false, function (on) { sp.reactionShots = on; changed(true); },
          "Can be shown listening during someone else's monologue"),
        chip("Enabled", sp.enabled !== false, function (on) { sp.enabled = on; renderStyle(); changed(); }, "Turn off to ignore this mic")
      ]);
      more.appendChild(chips);
      row.appendChild(more);
      box.appendChild(row);
    });
  }
  function calFor(id) {
    if (!state.result) return null;
    return state.result.calibration.filter(function (c) { return c.id === id; })[0] || null;
  }

  function chip(label, on, cb, title) {
    var c = el("label", { class: "chip" + (on ? " on" : ""), title: title || null });
    var box = el("input", { type: "checkbox" }); box.checked = on;
    box.addEventListener("change", function () { c.classList.toggle("on", box.checked); cb(box.checked); });
    c.appendChild(box); c.appendChild(document.createTextNode(label));
    return c;
  }

  function renderCameras() {
    var box = $("cameraList"); box.innerHTML = "";
    if (!state.config.cameras.length) { box.appendChild(el("div", { class: "muted", text: state.seq ? "No camera tracks. Add one." : "" })); return; }
    var spk = state.config.speakers;
    state.config.cameras.forEach(function (cm, i) {
      var row = el("div", { class: "row" });
      row.style.setProperty("--sw", camColor(i));
      var name = el("input", { class: "name", value: cm.name, oninput: function () { cm.name = name.value; changed(true); } });
      var role = cm.follows ? "follows speaker" : cm.shows.length === 0 ? "unused" : cm.shows.length === 1 ? "close-up" : (cm.shows.length === spk.length ? "wide" : cm.shows.length + "-shot");
      if (cm.static) role = "static " + role;
      if (cm.moving) role += " \u00B7 movement check";
      var isBottom = cm.enabled !== false && cm.videoTrack < NEST_BASE && !state.config.cameras.some(function (o) { return o !== cm && o.enabled !== false && o.videoTrack < cm.videoTrack; });
      var lw = lensWide();
      if (isBottom && state.config.cameras.length > 1 && load("layered", true) !== false && (!lw || lw === cm)) role += " \u00B7 bottom, kept whole";
      if (cm.videoTrack >= NEST_BASE) role += " \u00B7 multicam angle " + (cm.angle || (cm.videoTrack - NEST_BASE) % 16);
      var lensT = vtrack(cm.videoTrack);
      if (lensT && lensT.lens) role += " \u00B7 " + (lensT.lens.match(/\d+-\d+mm|\d+mm/) || [lensT.lens])[0];
      var vt = state.seq && state.seq.videoTracks.filter(function (v) { return v.index === cm.videoTrack; })[0];
      if (vt && vt.hidden && cm.enabled !== false) role += " \u00B7 eye off in the sequence (the cut turns it on)";
      row.appendChild(el("div", { class: "row-main" }, [
        name,
        select(trackOptions("video"), cm.videoTrack, function (v) { cm.videoTrack = +v; var t = vtrack(cm.videoTrack); cm.angle = t && t.virtual ? t.angle : undefined; renderCameras(); changed(); }),
        el("span", { class: "muted small", text: role }),
        trashButton("Remove this camera", function () {
          confirmBox(row, "Remove camera \u201C" + cm.name + "\u201D? PodCutter won't cut to it.", "Remove", function () {
            state.config.cameras = state.config.cameras.filter(function (x) { return x !== cm; });
            renderCameras(); renderStyle(); changed();
          });
        })
      ]));
      var chips = el("div", { class: "chips" });
      if (!cm.follows) spk.forEach(function (sp) {
        chips.appendChild(chip(sp.name, cm.shows.indexOf(sp.id) >= 0, function (on) {
          cm.shows = cm.shows.filter(function (id) { return id !== sp.id; });
          if (on) cm.shows.push(sp.id);
          renderCameras(); renderModeNote(); changed();
        }));
      });
      chips.appendChild(chip("Static", !!cm.static, function (on) { cm.static = on; if (on) cm.follows = false; renderCameras(); renderStyle(); changed(); },
        "A camera that stays on its shot (no operator re-framing). Tick it for each person's close-up camera: Rapid cutting checks everyone has one. Check for movement can stay on if the shot itself moves (a slider or slow push-in)."));
      chips.appendChild(chip("Follows speaker", !!cm.follows, function (on) { cm.follows = on; if (on) cm.static = false; renderCameras(); renderStyle(); changed(); },
        "An operator re-frames this camera on whoever is talking: it can show any speaker (never a group or a listener)."));
      chips.appendChild(chip("Check for movement", !!cm.moving, function (on) { cm.moving = on; renderCameras(); renderStyle(); changed(); },
        "On for a dolly, slider, handheld or operated camera: PodCutter reads its picture and only cuts to it when it's steady. Leave off for locked-off cameras like a static wide (faster analysis, never held back)."));
      chips.appendChild(chip("Enabled", cm.enabled !== false, function (on) { cm.enabled = on; renderModeNote(); changed(); }));
      var stab = state.result && state.result.stability && state.result.stability[cm.id];
      if (cm.moving && stab && stab.noFootage) {
        row.appendChild(el("div", { class: "warn small", text: "\u26A0 No footage on this camera's track to check for movement, so the cut can't avoid its moves. " +
          (nestAngleTracks().length ? "Its camera is inside the multicam nest: use the nest's angles (above)." : "Check the camera's track.") }));
      } else if (cm.moving && stab) {
        row.appendChild(el("div", { class: "muted small", text: "Steady " + stab.steadyPct + "% \u00B7 slow moves " + stab.slowPct + "% \u00B7 big moves " + stab.fastPct + "%" +
          (stab.lowDetail ? " \u2014 plain background: movement is hard to judge, treated as steady" : "") }));
      } else if (cm.moving && state.result) {
        row.appendChild(el("div", { class: "muted small", text: "Click Analyze to check this camera for movement." }));
      }
      row.appendChild(chips);
      renderFramingFor(cm, row);
      box.appendChild(row);
    });
    renderV1Warning();
  }

  /** Safety check: V1 should hold a static wide that shows everyone, since it stays whole under the other cameras. */
  function renderV1Warning() {
    var box = $("v1Warn"), q = state.seq;
    var problems = [];
    // A multicam nest: the angles are the cameras, so the stacked-track V1 checks don't apply.
    var angles = nestAngleTracks();
    if (q && angles.length && !usesNest()) {
      box.innerHTML = ""; box.classList.remove("hidden");
      box.appendChild(el("b", { text: "⚠ V" + (angles[0].nestTrack + 1) + " holds a multicam nest with " + angles.length + " angles. " }));
      box.appendChild(document.createTextNode("Your cameras still point at stacked tracks, so the dolly can't be checked for movement. "));
      box.appendChild(el("button", { class: "btn small primary", text: "Use the nest's angles as cameras", onclick: useNestAngles }));
      return;
    }
    if (q && usesNest()) { box.innerHTML = ""; box.classList.add("hidden"); return; }
    if (q && state.config.cameras.length) {
      var spk = state.config.speakers.filter(function (s) { return s.enabled !== false; });
      var v1 = state.config.cameras.filter(function (c) { return c.enabled !== false && c.videoTrack === 0; })[0];
      var t0 = q.videoTracks.filter(function (v) { return v.index === 0; })[0];
      var lw = lensWide();
      // A 24-70 on V1 was set up as the static wide at Scan; elsewhere it can't be kept whole under the others.
      if (lw) { if (lw.videoTrack !== 0) problems.push("The 24-70 wide (“" + lw.name + "”) is on V" + (lw.videoTrack + 1) + ", so builds cut every camera track instead of keeping the wide whole."); }
      else if (!v1) problems.push(t0 && t0.clipCount ? "No camera is set to V1." : "V1 is empty: there's no footage on the bottom video track.");
      else {
        if (v1.follows) problems.push("“" + v1.name + "” on V1 is set to follow the speaker.");
        else if (v1.shows.length < spk.length) problems.push("“" + v1.name + "” on V1 isn't set as the wide (tick everyone on it).");
        if (v1.moving) problems.push("“" + v1.name + "” on V1 has Check for movement on; the wide is normally a locked-off camera.");
      }
    }
    box.innerHTML = "";
    box.classList.toggle("hidden", !problems.length);
    if (!problems.length) return;
    box.appendChild(el("b", { text: "⚠ V1 should be the static wide. " }));
    box.appendChild(document.createTextNode(problems.join(" ") + " Check the sequence: put a static wide camera on V1, since the bottom camera stays whole under the others" +
      (load("layered", true) !== false ? " and shows wherever they're switched off." : ".")));
  }
  // Close-ups take their speaker's colour; wides/group shots get neutral tones.
  function camColor(i) {
    var cm = state.config.cameras[i];
    if (cm && cm.shows.length === 1) {
      var si = -1;
      state.config.speakers.forEach(function (s, k) { if (s.id === cm.shows[0]) si = k; });
      if (si >= 0) return colorOf(si);
    }
    if (cm && cm.follows) return "#c79bf2"; // operated / follow cam: its own colour, not a speaker's
    var neutrals = ["#b8bec7", "#8d939c", "#d9d2c3", "#a7b8a8"];
    var n = 0;
    for (var k = 0; k < i; k++) { var c = state.config.cameras[k]; if (!c || c.shows.length !== 1) n++; }
    return neutrals[n % neutrals.length];
  }

  // ----------------------------------------------------- style controls
  function effectiveStyle() { return D.styleFromPreset(state.config.preset, state.config.style); }

  function slider(def, value, onchange, opts) {
    opts = opts || {};
    var wrap = el("div", { class: "ctl", title: def.help || "" });
    var lab = el("label", { text: def.label });
    var out = el("output");
    var input = el("input", { type: "range", min: def.min, max: def.max, step: def.step });
    input.value = value;
    function show(v) {
      v = +v;
      if (opts.autoToggle) { out.textContent = "auto " + Math.round(v); return; }
      if (def.fmt) out.textContent = def.fmt(Math.round(v * 100) / 100);
      else if (def.zero && v === 0) out.textContent = def.zero;
      else if (def.pct) out.textContent = Math.round(v * 100) + "%";
      else out.textContent = (Math.abs(v) < 10 && def.step < 1 ? v.toFixed(def.step < 0.1 ? 2 : 1) : String(Math.round(v * 10) / 10)) + (def.unit && def.unit !== "%" ? " " + def.unit : "");
    }
    show(value);
    input.addEventListener("input", function () {
      if (opts.autoToggle && opts.onAuto) { opts.autoToggle = false; opts.onAuto(false); return; }
      show(input.value); onchange(+input.value);
    });
    // opts.reset: double-click puts the slider back to its default (a value, or a function that does the reset).
    if (opts.reset !== undefined) {
      wrap.title = (def.help ? def.help + " " : "") + "Double-click the slider to reset it.";
      input.addEventListener("dblclick", function () {
        if (typeof opts.reset === "function") { opts.reset(); return; }
        input.value = opts.reset; show(opts.reset); onchange(+opts.reset);
      });
    }
    wrap.appendChild(lab); wrap.appendChild(input); wrap.appendChild(out);
    if (opts.onAuto) {
      out.style.cursor = "pointer"; out.title = "Click to toggle Auto";
      out.addEventListener("click", function () { opts.onAuto(!opts.autoToggle); });
    }
    return wrap;
  }
  /** Captions for a slider's two ends, on their own line above it so the sliders below stay evenly spaced. */
  function endsRow(title, ends, help) {
    return el("div", { class: "ctl ends", title: help || "" }, [el("label", { text: title || "" }),
      el("div", {}, [el("span", { text: ends[0] }), el("span", { text: ends[1] })])]);
  }

  function renderStyle() {
    var st = effectiveStyle();
    var base = D.styleFromPreset(state.config.preset, {});
    var isChanged = function (key) { return state.config.style[key] !== undefined && state.config.style[key] !== base[key]; };
    function control(def) {
      var node;
      var set = function (v) {
        if (v === "true") v = true; else if (v === "false") v = false;
        state.config.style[def.key] = v; node.classList.toggle("changed", v !== base[def.key]); changed(true); countAdvanced();
      };
      if (def.type === "select") {
        node = el("div", { class: "ctl", title: def.help || "" }, [el("label", { text: def.label }),
          select(def.options, st[def.key], function (v) { set(v); })]);
      } else node = slider(def, st[def.key], set, { reset: base[def.key] });
      if (isChanged(def.key)) node.classList.add("changed");
      return node;
    }

    renderModeNote();
    var basic = $("basicControls"); basic.innerHTML = "";
    var fastMode = !!(D.PRESETS[state.config.preset] || {}).fast;
    UI.basicControls.forEach(function (def) {
      if (def.fast && fastMode) def = Object.assign({}, def, def.fast);
      var setting = el("div", { class: "setting" });
      if (def.ends) setting.appendChild(endsRow("", def.ends));
      setting.appendChild(control(def));
      if (def.key === "minWideSec") setting.appendChild(el("div", { id: "shortWideWarn", class: "warn small hidden" }));
      basic.appendChild(setting);
    });
    renderFeature();

    var box = $("styleControls"); box.innerHTML = "";
    var anyMoving = state.config.cameras.some(function (c) { return c.moving && c.enabled !== false; });
    UI.styleGroups.forEach(function (g) {
      if (g.onlyIfMoving && !anyMoving) return;
      var det = el("details", { class: "group" });
      if (g.open || g.controls.some(function (d) { return isChanged(d.key); })) det.open = true;
      det.appendChild(el("summary", { text: g.title }));
      g.controls.forEach(function (def) { det.appendChild(control(def)); });
      box.appendChild(det);
    });
    var adv = $("advancedStyle");
    adv.open = !!load("advancedOpen", false);
    adv.ontoggle = function () { store("advancedOpen", adv.open); };
    countAdvanced();
    renderShortWides();
  }

  /**
   * Content cuts in the footage (sections already removed from the timeline) can leave a stretch shorter than
   * Minimum wide: nothing the cut can do keeps a shot up that long there. Flag them under Minimum wide and list
   * them on the Cleanup tab.
   */
  /** The wide cameras' video tracks (the ones that show content cuts). */
  function wideTracks() {
    var q = state.seq;
    if (!q) return [];
    var spk = state.config.speakers.filter(function (s) { return s.enabled !== false; });
    var cams = state.config.cameras.filter(function (c) { return c.enabled !== false && !c.follows; });
    var wides = cams.filter(function (c) { return c.shows.length > 1 && c.shows.length >= spk.length; });
    if (!wides.length && cams.length) wides = [cams.slice().sort(function (a, b) { return a.videoTrack - b.videoTrack; })[0]];
    return wides.map(function (c) { return q.videoTracks.filter(function (v) { return v.index === c.videoTrack; })[0]; })
      .filter(function (t) { return t && t.clips; });
  }
  /** Content cuts already in the timeline, as zero-length "removals" so the engine changes camera across them. */
  function timelineJoins() {
    var seen = {}, out = [];
    wideTracks().forEach(function (t) {
      D.contentCuts(t.clips, { fps: state.seq.fps }).forEach(function (s) {
        if (!seen[s]) { seen[s] = true; out.push({ startSec: s, endSec: s, join: true }); }
      });
    });
    return out;
  }
  function shortWides() {
    var q = state.seq;
    if (!q) return [];
    var st = effectiveStyle(), min = Math.max(st.minWideSec || 0, st.minShotSec || 0);
    var r = currentRange(), seen = {}, out = [];
    wideTracks().forEach(function (t) {
      D.shortSections(t.clips, min, { fps: q.fps, rangeStart: r ? r.a : 0, rangeEnd: r ? r.b : q.durationSec }).forEach(function (s) {
        if (seen[s.startSec]) return;
        seen[s.startSec] = true; s.track = t.name; s.minSec = min; out.push(s);
      });
    });
    return out.sort(function (a, b) { return a.startSec - b.startSec; });
  }

  function renderShortWides() {
    var warn = $("shortWideWarn"), card = $("shortCard");
    if (!card) return;
    var list = shortWides(), min = list.length ? list[0].minSec : 0;
    if (warn) {
      warn.innerHTML = "";
      warn.classList.toggle("hidden", !list.length);
      if (list.length) {
        warn.appendChild(document.createTextNode("⚠ Content cut detected: " + list.length + (list.length === 1 ? " section" : " sections") +
          " between cuts in the footage " + (list.length === 1 ? "runs" : "run") + " under " + min + " s, so the wide will be shorter there. "));
        warn.appendChild(el("a", { href: "#", text: "Review on the Cleanup tab", onclick: function (e) {
          e.preventDefault(); document.querySelector('.tab[data-tab="cleanup"]').click(); card.scrollIntoView();
        } }));
      }
    }
    card.classList.toggle("hidden", !list.length);
    if (!list.length) return;
    $("shortCount").textContent = list.length + (list.length === 1 ? " section" : " sections");
    $("shortNote").textContent = "Footage was removed from the timeline at these points, and the piece left between cuts is shorter than the " +
      min + " s minimum (Minimum wide, or Minimum close-up if longer). The wide can't stay up that long here without crossing a cut. " +
      "Click one to jump there; lengthen the section, or lower Minimum wide.";
    var box = $("shortList"); box.innerHTML = "";
    list.forEach(function (s) {
      var where = s.cutBefore && s.cutAfter ? "cut at both ends" : s.cutBefore ? "cut at the start" : "cut at the end";
      box.appendChild(el("div", { class: "sug short", onclick: function () { seek(s.startSec); } }, [
        el("div", { class: "sug-top" }, [
          el("span", { class: "time", text: fmt(s.startSec) + " – " + fmt(s.endSec) }),
          el("span", { class: "badge mid", text: s.lengthSec + " s" })
        ]),
        el("div", { class: "small", text: s.track + ": " + where + ", " + s.lengthSec + " s of " + min + " s minimum" })
      ]));
    });
  }

  /** The bottom camera stays whole by default; turning that off shows as a change under Advanced. */
  function renderLayered() {
    var off = load("layered", true) === false;
    $("layeredNote").classList.toggle("hidden", !off);
    if (off) $("timelineGroup").open = true;
    countAdvanced();
  }

  /** "Advanced (3 changed)": so tweaks hidden under the fold aren't forgotten. */
  function countAdvanced() {
    if (!state.config) return;
    var base = D.styleFromPreset(state.config.preset, {}), n = 0;
    UI.styleGroups.forEach(function (g) {
      g.controls.forEach(function (d) { var v = state.config.style[d.key]; if (v !== undefined && v !== base[d.key]) n++; });
    });
    if (load("layered", true) === false) n++;
    $("advancedCount").textContent = n ? n + " changed" : "";
  }

  function renderModeNote() {
    var box = $("modeNote"); box.innerHTML = "";
    var mode = D.PRESETS[state.config.preset] || D.PRESETS.balanced;
    box.appendChild(document.createTextNode(mode.description || ""));
    // Only once static cameras are in use (ticked Static under Cameras): check each person has one of their own.
    var statics = state.config.cameras.filter(function (c) { return c.enabled !== false && c.static; });
    if (mode.needs === "closeups" && statics.length) {
      var missing = state.config.speakers.filter(function (sp) {
        return sp.enabled !== false && !statics.some(function (c) { return c.shows.length === 1 && c.shows[0] === sp.id; });
      });
      if (missing.length) {
        box.appendChild(el("div", { class: "warn", text: "No static close-up for " + missing.map(function (s) { return s.name; }).join(", ") +
          ": they'll be shown on the wide or the follow cam. Under Cameras, tick Static and only that person on their camera." }));
      }
    }
  }

  /** One Feature slider per person: who gets more (or less) screen time. */
  function renderFeature() {
    var box = $("featureControls"); box.innerHTML = "";
    var spk = state.config.speakers.filter(function (sp) { return sp.enabled !== false; });
    if (spk.length < 2) return;
    box.appendChild(endsRow("Feature", UI.featureControl.ends, UI.featureControl.help));
    state.config.speakers.forEach(function (sp, i) {
      if (sp.enabled === false) return;
      var def = Object.assign({}, UI.featureControl, { label: sp.name });
      var node = slider(def, sp.biasDb || 0, function (v) { sp.biasDb = v; node.classList.toggle("changed", v !== 0); changed(true); }, { reset: 0 });
      node.style.setProperty("--sw", colorOf(i));
      if (sp.biasDb) node.classList.add("changed");
      box.appendChild(node);
    });
  }

  function userPresets() {
    var list = load("userPresets", {});
    if (hasNode && state.docsDir) {
      try {
        fs.readdirSync(path.join(state.docsDir, "presets")).forEach(function (f) {
          if (!/\.json$/.test(f)) return;
          try { var p = JSON.parse(fs.readFileSync(path.join(state.docsDir, "presets", f), "utf8")); list[p.name || f.replace(/\.json$/, "")] = p; } catch (e) { /* skip bad */ }
        });
      } catch (e) { /* no folder */ }
    }
    return list;
  }

  function renderPresetSelect() {
    var s = $("presetSelect"); s.innerHTML = "";
    Object.keys(D.PRESETS).forEach(function (k) { s.appendChild(el("option", { value: "b:" + k, text: D.PRESETS[k].label })); });
    var ups = userPresets();
    Object.keys(ups).forEach(function (k) { s.appendChild(el("option", { value: "u:" + k, text: "★ " + k })); });
    s.value = state.config.userPreset ? "u:" + state.config.userPreset : "b:" + state.config.preset;
    s.onchange = function () {
      var v = s.value;
      if (v.indexOf("b:") === 0) { state.config.preset = v.slice(2); state.config.style = {}; state.config.userPreset = null; }
      else {
        var p = userPresets()[v.slice(2)];
        state.config.preset = p.basePreset || "balanced"; state.config.style = copy(p.style || {}); state.config.userPreset = v.slice(2);
      }
      renderStyle(); changed(true);
    };
  }

  function savePreset() {
    var row = $("presetSelect").parentNode;
    if (row.querySelector(".preset-name")) return;
    var input = el("input", { class: "preset-name", placeholder: "Preset name" });
    var okBtn = el("button", { class: "btn primary small", text: "OK", onclick: function () {
      var name = input.value.trim(); if (!name) return;
      var p = { name: name, basePreset: state.config.preset, style: copy(state.config.style), savedAt: new Date().toISOString() };
      var all = load("userPresets", {}); all[name] = p; store("userPresets", all);
      if (hasNode && state.docsDir) fs.writeFileSync(path.join(state.docsDir, "presets", name.replace(/[^\w -]/g, "_") + ".json"), JSON.stringify(p, null, 2));
      state.config.userPreset = name; saveConfig();
      input.remove(); okBtn.remove(); renderPresetSelect();
      status("Saved preset “" + name + "”.", "ok");
    } });
    row.insertBefore(okBtn, row.firstChild); row.insertBefore(input, row.firstChild); input.focus();
  }

  // ------------------------------------------------------------ analyze
  // Waveforms and camera movement are analyzed for the whole sequence once; the In/Out range is applied when
  // planning (planRange slices them), so moving the marks re-plans instantly without analyzing again.
  function rangeKey() { var r = currentRange(); return r ? "@" + r.a.toFixed(2) + "-" + r.b.toFixed(2) : ""; }
  function curveKey(sp) { return sp.audioTrack + ":" + (sp.channel === null || sp.channel === undefined ? "mix" : sp.channel) + (sp.channelManual ? "m" : "a"); }
  function motionKey(cam) { return "v:" + cam.videoTrack; }

  var analyze = guard(function () {
    if (!state.seq) throw new Error("Scan a sequence first.");
    var spk = state.config.speakers.filter(function (s) { return s.enabled !== false; });
    if (!spk.length) throw new Error("Add at least one speaker mic.");
    if (!inPremiere) { // demo
      var demoCurves = window.PD_DEMO.curves(state.seq, state.config, HOP);
      state.config.speakers.forEach(function (sp) {
        var dk = sp.audioTrack + ":" + (sp.channel === null || sp.channel === undefined ? "mix" : sp.channel) + (sp.channelManual ? "m" : "a");
        state.curves[curveKey(sp)] = demoCurves[dk];
      });
      state.config.cameras.forEach(function (c) { if (c.moving) state.motion[motionKey(c)] = window.PD_DEMO.motion(state.seq, c.videoTrack); });
      replan(); renderCameras();
      if (blindCameras().length) status(blindMessage(blindCameras()), "err"); else status("Demo analysis ready.", "ok", 1);
      return;
    }
    if (!state.tools.ffmpeg) throw new Error("ffmpeg is not available. See Settings.");
    var keys = {}, jobs = [];
    spk.forEach(function (sp) { keys[curveKey(sp)] = sp; });
    var dur = state.seq.durationSec, done = 0, total = Object.keys(keys).length;
    var t0 = Date.now();
    status("Reading waveforms (0/" + total + ")…", "", 0.02);
    Object.keys(keys).forEach(function (k) {
      var sp = keys[k], track = speakerTrack(sp, true);
      jobs.push(function () {
        return A.analyzeTrack(track, dur, { hopSec: HOP, channel: sp.channel, onWarning: function (m) { log("Note: " + m); }, onProgress: function (i, n) {
          status("Reading " + track.name + " clip " + i + "/" + n + " (" + done + "/" + total + " tracks done)…", "", (done + i / n) / total);
        } }).then(function (curve) { state.curves[k] = curve; done++; });
      });
    });
    return A.pool(jobs, 3).then(function () {
      log("Analyzed " + total + " mic track(s) in " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
      return analyzeMotion();
    }).then(function () {
      replan();
      warnIdenticalMics();
      renderSpeakers(); renderCameras();
      var blind = blindCameras();
      if (blind.length) status(blindMessage(blind), "err");
      else if ($("statusText").className !== "err") status("Analysis ready \u2014 tweak the style and watch the preview update.", "ok", 1);
    });
  });

  /** Camera-movement check for cameras marked as moving (decodes their video at low resolution). */
  function analyzeMotion() {
    var cams = state.config.cameras.filter(function (c) { return c.moving && c.enabled !== false && !state.motion[motionKey(c)]; });
    return cams.reduce(function (p, c, i) {
      return p.then(function () {
        var track = vtrack(c.videoTrack), t0 = Date.now();
        if (!track || !track.clips) return;
        return window.PodMotion.analyzeTrack(track, state.seq.durationSec, { ffmpegPath: state.tools.ffmpeg, onProgress: function (f) {
          status("Checking " + c.name + " for camera movement\u2026 " + Math.round(f * 100) + "%" + (cams.length > 1 ? " (" + (i + 1) + "/" + cams.length + ")" : ""), "", f);
        } }).then(function (m) {
          state.motion[motionKey(c)] = m;
          log("Camera movement for " + c.name + " analyzed in " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
        });
      });
    }, Promise.resolve());
  }

  function cameraMotionInput() {
    var out = {};
    state.config.cameras.forEach(function (c) { var m = state.motion[motionKey(c)]; if (c.moving && m) out[c.id] = m; });
    return out;
  }

  /** Two "different" mics with near-identical loudness curves means they're reading the same audio. */
  function warnIdenticalMics() {
    var spk = state.config.speakers.filter(function (s) { return s.enabled !== false && state.curves[curveKey(s)]; });
    var pairs = [];
    for (var i = 0; i < spk.length; i++) for (var j = i + 1; j < spk.length; j++) {
      var a = state.curves[curveKey(spk[i])], b = state.curves[curveKey(spk[j])];
      if (a === b || corr(a, b) > 0.97) pairs.push(spk[i].name + " & " + spk[j].name);
    }
    if (pairs.length) {
      var msg = "These speakers are reading the same audio: " + pairs.join(", ") + ". If your mics are channels of one file, set each speaker's channel (Ch 1, Ch 2\u2026).";
      setNote(msg); log(msg);
      status("Some speakers have identical audio \u2014 check their channels.", "err");
    }
    return pairs.length;
  }
  function corr(a, b) {
    var n = Math.min(a.length, b.length), step = Math.max(1, Math.floor(n / 20000)), sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, k = 0;
    for (var i = 0; i < n; i += step) { var x = a[i], y = b[i]; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; k++; }
    var cov = sab / k - (sa / k) * (sb / k), va = saa / k - (sa / k) * (sa / k), vb = sbb / k - (sb / k) * (sb / k);
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 1;
  }

  function curvesReady() {
    return state.config.speakers.filter(function (s) { return s.enabled !== false; }).every(function (s) { return state.curves[curveKey(s)]; });
  }

  // ------------------------------------------------- who's in the shot
  state.framing = {}; // key -> PodFraming.analyze result
  function framingKey(cam) { return "v:" + cam.videoTrack + rangeKey() + "|" + state.config.speakers.map(curveKey).join(","); }
  function framingInput(result) {
    var out = {};
    if (!window.PodFraming || !result) return out;
    state.config.cameras.forEach(function (c) {
      if (!c.follows || !c.moving || c.enabled === false) return;
      var m = state.motion[motionKey(c)];
      if (!m || !m.thumbs) return;
      var key = framingKey(c);
      if (!state.framing[key]) {
        var rng = currentRange();
        state.framing[key] = window.PodFraming.analyze({ thumbs: m.thumbs, motion: m, speech: result.speech,
          speakers: state.config.speakers.filter(function (x) { return x.enabled !== false; }),
          steadyMaxPct: Math.max(1.5, (result.style && result.style.steadyMaxPct) || 1.2), range: rng });
        log("Who's in the shot on " + c.name + ": " + state.framing[key].groups.length + " people found in " + state.framing[key].stretches.length + " steady stretches");
        debounce("cams", renderCameras, 50);
      }
      out[c.id] = window.PodFraming.timeline(state.framing[key], framingNames(c, state.framing[key]));
    });
    return out;
  }
  /** Group -> speaker names: the editor's choices, falling back to the automatic guess. */
  function framingNames(cam, fr) {
    var saved = (state.config.framingNames || {})[cam.id] || {}, names = {};
    fr.groups.forEach(function (g) { names[g.id] = Object.prototype.hasOwnProperty.call(saved, g.id) ? saved[g.id] : g.guess; });
    return names;
  }
  function thumbCanvas(m, sec) {
    var t = m.thumbs, cv = el("canvas", { width: t.w, height: t.h, class: "thumb" });
    if (sec === null || sec === undefined || !t.valid[sec]) return cv;
    var ctx2 = cv.getContext("2d"), img = ctx2.createImageData(t.w, t.h), size = t.w * t.h * 3;
    for (var i = 0, j = 0; i < t.w * t.h; i++, j += 3) {
      img.data[i * 4] = t.data[sec * size + j]; img.data[i * 4 + 1] = t.data[sec * size + j + 1]; img.data[i * 4 + 2] = t.data[sec * size + j + 2]; img.data[i * 4 + 3] = 255;
    }
    ctx2.putImageData(img, 0, 0);
    return cv;
  }
  function renderFramingFor(cm, row) {
    var m = state.motion[motionKey(cm)], fr = state.framing[framingKey(cm)];
    if (!cm.follows || !m || !fr) return;
    var box = el("div", { class: "framing" }, [el("div", { class: "small", html: "<b>Who's in the shot</b> <span class=\"muted\">\u2014 guessed from who was talking; fix any that are wrong</span>" })]);
    var names = framingNames(cm, fr);
    var opts = [["", "Nobody / don't use"]].concat(state.config.speakers.map(function (sp) { return [sp.id, sp.name]; }));
    fr.groups.slice().sort(function (a, b) { return b.seconds - a.seconds; }).forEach(function (g) {
      var sel = select(opts, names[g.id] || "", function (v) {
        state.config.framingNames = state.config.framingNames || {};
        state.config.framingNames[cm.id] = state.config.framingNames[cm.id] || {};
        state.config.framingNames[cm.id][g.id] = v || null;
        changed(true);
      });
      box.appendChild(el("div", { class: "framing-row" }, [thumbCanvas(m, g.sampleSec), sel,
        el("span", { class: "muted small", text: Math.round(g.seconds / 60) + " min" + (g.guess && names[g.id] === g.guess ? " \u00B7 guess" : "") })]));
    });
    if (!fr.groups.length) box.appendChild(el("div", { class: "muted small", text: "No steady stretches found to identify." }));
    row.appendChild(box);
  }

  function replan() {
    if (!state.seq || !curvesReady()) { viz.setData(null); state.result = null; setButtons(); $("vizHint").textContent = state.seq ? "analyze to see the cut" : ""; return; }
    var curves = {};
    state.config.speakers.forEach(function (s) { if (state.curves[curveKey(s)]) curves[s.id] = state.curves[curveKey(s)]; });
    try {
      var planInput = { durationSec: state.seq.durationSec, hopSec: HOP, fps: state.seq.fps, curves: curves, cameraMotion: cameraMotionInput() };
      var rng = currentRange();
      // Accepted cleanup cuts, and content cuts already in the timeline, are passed in so the camera changes across each.
      var planCfg = Object.assign({}, state.config, { removals: acceptedCuts().concat(timelineJoins()), intro: introPlan() });
      var run = function () { return rng ? D.planRange(planInput, planCfg, rng.a, rng.b) : D.plan(planInput, planCfg); };
      state.result = run();
      // Operated cams: work out who they're pointed at (needs the speech found above), then plan again with it.
      var framing = framingInput(state.result);
      if (Object.keys(framing).length) { planInput.framing = framing; state.result = run(); }
    } catch (e) { status(e.message, "err"); state.result = null; setButtons(); return; }
    var spk = state.config.speakers.filter(function (s) { return s.enabled !== false; });
    var cams = state.config.cameras.map(function (c, i) { return { id: c.id, name: c.name, color: camColor(i) }; });
    viz.setData({
      durationSec: state.seq.durationSec, hopSec: HOP, curves: curves,
      speakers: spk.map(function (s) { return { id: s.id, name: s.name, color: colorOf(state.config.speakers.indexOf(s)) }; }),
      calibration: state.result.calibration, speech: state.result.speech, shots: state.result.shots,
      cameras: cams, cleanup: acceptedCuts(), range: currentRange(),
      motion: Object.keys(state.result.stability || {}).map(function (id) {
        var c = cams.filter(function (x) { return x.id === id; })[0];
        return { id: id, name: c ? c.name : id, hopSec: state.result.stability[id].hopSec, states: state.result.stability[id].states, offsetSec: state.result.stability[id].offsetSec || 0,
          framing: (planInput.framing && planInput.framing[id] || []).map(function (f) {
            var si = state.config.speakers.map(function (x) { return x.id; }).indexOf(f.speakerId);
            return { startSec: f.startSec, endSec: f.endSec, color: si >= 0 ? colorOf(si) : "#555" };
          }) };
      })
    });
    $("vizHint").textContent = "click = jump playhead · drag = lock a camera · wheel = zoom";
    renderStats(); setButtons();
    refreshSpeakerLevels();
  }
  // Calibration bars live in the speaker rows; redraw them when the user isn't typing/dragging there.
  function refreshSpeakerLevels() {
    debounce("spk", function () {
      var a = document.activeElement;
      if (a && $("speakerList").contains(a) && (a.tagName === "INPUT" || a.tagName === "SELECT")) return refreshSpeakerLevels();
      renderSpeakers();
    }, 400);
  }

  /** Mic confidence: one meter per speaker, with what's wrong and where. Collapsible; remembers open/closed. */
  function renderConfidence() {
    var det = $("confBox"), list = $("confList"), conf = state.result && state.result.confidence;
    det.classList.toggle("hidden", !(conf && conf.length));
    if (!conf || !conf.length) return;
    det.open = !!load("confOpen", false);
    det.ontoggle = function () { store("confOpen", det.open); };
    var byId = {}, idx = {};
    state.config.speakers.forEach(function (sp, i) { byId[sp.id] = sp; idx[sp.id] = i; });
    var worst = conf.slice().sort(function (a, b) { return a.score - b.score; })[0];
    $("confSummary").textContent = worst.label === "good" ? "all good" :
      (byId[worst.speakerId] ? byId[worst.speakerId].name : "?") + " " + worst.label + " (" + worst.score + ")";
    $("confSummary").className = "conf-" + worst.label;
    list.innerHTML = "";
    conf.forEach(function (c) {
      var sp = byId[c.speakerId]; if (!sp) return;
      var fill = el("i", { class: "conf-" + c.label }); fill.style.width = Math.max(3, c.score) + "%";
      var row = el("div", { class: "conf-row" }, [
        el("div", { class: "conf-top" }, [
          el("span", { class: "conf-name", text: sp.name }),
          el("span", { class: "conf-meter" }, [fill]),
          el("span", { class: "conf-score conf-" + c.label, text: c.score + " " + c.label })
        ]),
        el("div", { class: "muted small", text: "Level " + (c.levelGapDb ? c.levelGapDb + " dB vs loudest" : "loudest") +
          " · separation " + c.separationDb + " dB · borderline " + c.borderlinePct + "%" + (c.missedSec >= 1 ? " · maybe missed " + Math.round(c.missedSec) + " s" : "") })
      ]);
      row.style.setProperty("--sw", colorOf(idx[c.speakerId]));
      c.hints.forEach(function (h) { row.appendChild(el("div", { class: "small conf-hint", text: h })); });
      if (c.weak.length) {
        var spots = el("div", { class: "conf-weak small" }, [el("span", { class: "muted", text: "Weak: " })]);
        c.weak.forEach(function (w) {
          spots.appendChild(el("span", { class: "lock", text: fmt(w[0]) + "–" + fmt(w[1]), style: "cursor:pointer", title: "Jump there",
            onclick: function () { seek(w[0]); } }));
        });
        row.appendChild(spots);
      }
      list.appendChild(row);
    });
  }

  function renderStats() {
    var box = $("stats"); box.innerHTML = "";
    renderConfidence();
    if (!state.result) return;
    var s = state.result.stats;
    [[s.cuts, "cuts"], [s.cutsPerMinute, "cuts / min"], [s.avgShotSec + "s", "avg shot"], [s.longestShotSec + "s", "longest"]].forEach(function (p) {
      box.appendChild(el("div", { class: "stat" }, [el("b", { text: String(p[0]) }), el("span", { text: p[1] })]));
    });
    // Why the cuts happen: helps decide which setting to change.
    var WHY = { speaker: "speaker changes", "wide-turn": "turns on the wide", intro: "host's welcome", "intro-wide": "introductions (wide)", reaction: "reactions", "interjection-wide": "reaction wides", pause: "pauses \u2192 wide",
      hold: "holds", crosstalk: "talking over", cutaway: "monologue cutaways", "camera-move": "dolly moving", framing: "dolly on someone else",
      opening: "opening", "jump-cover": "cut cover", handoff: "handoff wides", removed: "removed sections", locked: "your locks" };
    var reasons = Object.keys(s.reasons || {}).sort(function (a, b) { return s.reasons[b] - s.reasons[a]; });
    if (reasons.length) {
      box.appendChild(el("div", { class: "why small" }, [el("span", { class: "muted", text: "Shots by reason: " }),
        el("span", { text: reasons.map(function (r) { return (WHY[r] || r) + " " + s.reasons[r]; }).join(" \u00B7 ") })]));
    }
    var bars = el("div", { class: "bars" });
    state.config.cameras.forEach(function (c, i) {
      var pct = s.screenTimePct[c.id] || 0;
      var fill = el("i"); fill.style.width = pct + "%"; fill.style.background = camColor(i);
      bars.appendChild(el("div", { class: "bar" }, [el("span", { text: c.name }), el("div", {}, [fill]), el("span", { text: pct + "%" })]));
    });
    state.config.speakers.forEach(function (sp, i) {
      if (s.talkTimePct[sp.id] === undefined) return;
      var fill = el("i"); fill.style.width = s.talkTimePct[sp.id] + "%"; fill.style.background = colorOf(i); fill.style.opacity = ".5";
      bars.appendChild(el("div", { class: "bar" }, [el("span", { class: "muted", text: sp.name + " talks" }), el("div", {}, [fill]), el("span", { class: "muted", text: s.talkTimePct[sp.id] + "%" })]));
    });
    box.appendChild(bars);
  }

  // -------------------------------------------------------------- locks
  function onSelect(a, b) {
    state.selection = [a, b];
    $("lockLabel").textContent = fmt(a) + " – " + fmt(b) + "  lock to:";
    var btns = $("lockButtons"); btns.innerHTML = "";
    state.config.cameras.forEach(function (c, i) {
      var bt = el("button", { class: "btn small", text: c.name, onclick: function () { addLock(c.id); } });
      bt.style.borderColor = camColor(i);
      btns.appendChild(bt);
    });
    btns.appendChild(el("button", { class: "btn ghost small", text: "Auto (unlock)", onclick: function () { addLock(null); } }));
    $("lockBar").classList.remove("hidden");
  }
  function addLock(camId) {
    var a = state.selection[0], b = state.selection[1];
    var keep = [];
    state.config.overrides.forEach(function (o) {
      if (o.endSec <= a || o.startSec >= b) { keep.push(o); return; }
      if (o.startSec < a) keep.push({ startSec: o.startSec, endSec: a, cameraId: o.cameraId });
      if (o.endSec > b) keep.push({ startSec: b, endSec: o.endSec, cameraId: o.cameraId });
    });
    if (camId) keep.push({ startSec: a, endSec: b, cameraId: camId });
    keep.sort(function (x, y) { return x.startSec - y.startSec; });
    state.config.overrides = keep;
    clearSelection(); renderLocks(); changed(true);
  }
  function clearSelection() { state.selection = null; viz.sel = null; $("lockBar").classList.add("hidden"); viz.render(); }
  function renderLocks() {
    var box = $("lockList"); box.innerHTML = "";
    var byId = {}; state.config.cameras.forEach(function (c) { byId[c.id] = c.name; });
    state.config.overrides.forEach(function (o, i) {
      box.appendChild(el("span", { class: "lock" }, [
        el("span", { text: "🔒 " + fmt(o.startSec) + "–" + fmt(o.endSec) + " " + (byId[o.cameraId] || "?"), style: "cursor:pointer",
          onclick: function () { seek(o.startSec); } }),
        el("button", { class: "icon", text: "✕", onclick: function () { state.config.overrides.splice(i, 1); renderLocks(); changed(true); } })
      ]));
    });
  }

  // ----------------------------------------------------- write to Premiere
  function seek(t) {
    viz.setPlayhead(t);
    if (inPremiere && !state.busy) callHost("setPlayhead", [t]).catch(function (e) { log(e.message); });
  }

  var previewMarkers = guard(function () {
    if (!state.result) return;
    var byId = {}; state.config.cameras.forEach(function (c, i) { byId[c.id] = { name: c.name, color: UI.markerColors[i % UI.markerColors.length] }; });
    var spkName = {}; state.config.speakers.forEach(function (s) { spkName[s.id] = s.name; });
    var markers = state.result.shots.map(function (s) {
      var c = byId[s.cameraId] || { name: s.cameraId, color: 5 };
      return { startSec: s.startSec, name: c.name, color: c.color,
        comment: s.reason + (s.speakers.length ? " — " + s.speakers.map(function (id) { return spkName[id]; }).join(", ") : "") };
    });
    status("Adding " + markers.length + " markers…", "", 0.3);
    return callHost("clearMarkers", [MARK_CAM]).then(function () {
      return callHost("addMarkers", [JSON.stringify({ prefix: MARK_CAM, markers: markers })]);
    }).then(function (r) { status("Added " + r.added + " camera markers. Scrub through to review, then Build cut.", "ok", 1); });
  });

  var clearCamMarkers = guard(function () {
    var n = 0;
    return callHost("clearMarkers", [MARK_CAM]).then(function (r) { n += r.removed; return callHost("clearMarkers", [MARK_MOVE]); })
      .then(function (r) { n += r.removed; return callHost("clearMarkers", [MARK_INTRO]); })
      .then(function (r) { n += r.removed; status("Removed " + n + " PodCutter markers.", "ok"); });
  });

  /**
   * Your movement check, made visible: a marker over every stretch where a moving camera is moving (red = big
   * move, orange = slow drift), on the analyzed sequence. The cut avoids exactly these.
   */
  var markMoves = guard(function () {
    if (!state.result) throw new Error("Analyze first.");
    if (blindCameras().length) throw new Error(blindMessage(blindCameras()));
    var cams = state.config.cameras.filter(function (c) { return c.enabled !== false && c.moving; });
    if (!cams.length) throw new Error("No camera has Check for movement ticked.");
    var markers = [];
    cams.forEach(function (c) {
      D.cameraMoves(state.result, c.id).forEach(function (m) {
        markers.push({ startSec: m.startSec, endSec: m.endSec, color: m.kind === "big" ? 1 : 3, name: c.name + (m.kind === "big" ? " moving" : " drifting"),
          comment: (m.kind === "big" ? "Big move" : "Slow move") + " on " + c.name + ", " + fmt(m.startSec) + "–" + fmt(m.endSec) + ". PodCutter keeps this camera off air here." });
      });
    });
    if (!inPremiere) { status(markers.length + " camera moves found (markers need Premiere).", "ok"); return; }
    return callHost("getPlayhead").then(function (p) {
      if (p.sequenceID !== state.seq.sequenceID) throw new Error("Open the analyzed sequence (“" + state.seq.name + "”) first: the markers go on it.");
      return callHost("clearMarkers", [MARK_MOVE]);
    }).then(function () {
      return callHost("addMarkers", [JSON.stringify({ prefix: MARK_MOVE, markers: markers })]);
    }).then(function (r) {
      var big = markers.filter(function (m) { return m.color === 1; }).length;
      status("Marked " + r.added + " camera moves (" + big + " big in red, " + (r.added - big) + " slow in orange).", "ok", 1);
    });
  });

  // Cut history per original sequence: the copy we built and the last few cuts applied to it.
  function copies() { return load("copies", {}); }
  function copyFor(seq) { return seq ? copies()[seq.sequenceID] || null : null; }
  /** A copy of this sequence that has since been deleted from the project isn't offered for Recut. */
  function forgetDeletedCopy(seqId) {
    var all = copies(), rec = all[seqId];
    if (!rec || !inPremiere) return;
    callHost("sequenceExists", [rec.id]).then(function (r) {
      if (r.exists) return;
      delete all[seqId]; store("copies", all);
      log("“" + rec.name + "” isn't in this project any more, so Recut is off until you build a new copy.");
      renderRecut();
    }, function () { /* keep it if we can't tell */ });
  }
  function rememberCut(orig, copySeq, payload, stats, replaceHistory) {
    var all = copies(), rec = all[orig.sequenceID];
    if (!rec || rec.id !== copySeq.sequenceID) rec = { id: copySeq.sequenceID, name: copySeq.name, history: [] };
    if (replaceHistory) rec.history = [];
    rec.history.push({ at: new Date().toISOString(), cuts: stats.cuts, payload: payload });
    if (rec.history.length > 5) rec.history = rec.history.slice(-5);
    all[orig.sequenceID] = rec; store("copies", all);
  }

  /** Razor the camera tracks of a sequence at the cut points and enable one camera per shot. */
  function writeCut(seqId, payload, label) {
    var tracks = [];
    payload.cameraTracks.forEach(function (t) { if (tracks.indexOf(t) < 0) tracks.push(t); });
    var CHUNK = 250, steps = [];
    // Layered payloads razor each track only where it changes (never the bottom camera); older ones razor every track.
    var perTrack = payload.tracks ? payload.tracks.map(function (x) { return { track: x.track, frames: x.cuts }; })
      : tracks.map(function (t) { return { track: t, frames: payload.cutFrames }; });
    perTrack.forEach(function (x) {
      for (var i = 0; i < x.frames.length; i += CHUNK) steps.push({ track: x.track, frames: x.frames.slice(i, i + CHUNK) });
    });
    var n = 0, razored = 0;
    return steps.reduce(function (p, st) {
      return p.then(function () {
        return callHost("razorTrack", [JSON.stringify({ sequenceID: seqId, track: st.track, frames: st.frames })]).then(function (r) {
          razored += r.razored; n++;
          status(label + " V" + (st.track + 1) + "\u2026 (" + Math.round(100 * n / steps.length) + "%)", "", 0.05 + 0.85 * n / steps.length);
        });
      });
    }, Promise.resolve()).then(function () {
      log("Razored " + razored + " edit points");
      status("Switching cameras\u2026", "", 0.93);
      return callHost("applyEnables", [JSON.stringify(payload.tracks ? { sequenceID: seqId, tracks: payload.tracks }
        : { sequenceID: seqId, cameraTracks: tracks, shots: payload.shots })]);
    }).then(function (r) {
      // A camera track with its eye off shows nothing however its clips are switched: turn them all on.
      return callHost("showTracks", [JSON.stringify({ sequenceID: seqId, tracks: tracks })]).then(function (s) {
        r.shown = s.shown;
        if (s.shown.length) log("Turned on track output (the eye) for " + s.shown.map(function (t) { return "V" + (t + 1); }).join(", "));
        return r;
      }, function (e) { log("Couldn't check track output: " + e.message); return r; });
    });
  }

  function shownNote(r) {
    return r && r.shown && r.shown.length ? "; turned on " + r.shown.map(function (t) { return "V" + (t + 1); }).join(", ") + ", which had its eye off" : "";
  }

  /** Cameras set to Check for movement that had no footage to measure: their moves can't be avoided. */
  function blindCameras() {
    var stab = state.result && state.result.stability;
    if (!stab) return [];
    return state.config.cameras.filter(function (c) { return c.enabled !== false && c.moving && stab[c.id] && stab[c.id].noFootage; });
  }
  function blindMessage(blind) {
    return blind.map(function (c) { return "“" + c.name + "”"; }).join(", ") + " is set to Check for movement, but there's no footage on its track to check, " +
      "so the cut would land on it mid-move. " + (nestAngleTracks().length ? "Use the nest's angles (Cameras card) and Analyze again."
        : "Point it at the track with its footage, or untick Check for movement.");
  }

  // ------------------------------------------------- camera 2 in Rose
  var ROSE = 6; // Premiere's label colours: Violet 0, Iris 1, Caribbean 2, Lavender 3, Cerulean 4, Forest 5, Rose 6, …
  function angleOfCam(c) { return c.angle || (c.videoTrack < NEST_BASE ? c.videoTrack + 1 : (c.videoTrack - NEST_BASE) % 16); }

  /** Label the camera 2 shots Rose on a built sequence (when the option is on). ranges: [[a, b]] in sequence time. */
  function labelColor() { var n = +load("labelColor", ROSE); return n >= 0 && n < 16 ? n : ROSE; }
  function labelName(n) { return K && K.LABELS ? K.LABELS[n] : "Rose"; }
  /** The user's Edit > Label > <colour> shortcut, or null. */
  function labelKeyFor(n) {
    var k = cutKeys();
    if (!k || !k.file) return null;
    try { var key = K.labelKey(K.parseShortcuts(fs.readFileSync(k.file.path, "utf8")), n); return key.usable ? key : null; }
    catch (e) { return null; }
  }
  /**
   * Label the camera 2 pieces. reset { within: [a, b], color }: on a recut/undo, pieces that are no longer camera 2
   * get their original label back. With a keystroke sender (a multicam build, Timeline focused) and an Edit > Label
   * shortcut, PodCutter selects the pieces and presses it, which works where scripts can't set the label.
   */
  /** Under the colour picker: the shortcut a multicam build will press, or how to give it one. */
  function renderLabelKey() {
    var note = $("labelKeyNote"), name = labelName(labelColor());
    $("labelColor").disabled = !$("rose2").checked;
    if (!$("rose2").checked || !hasNode) { note.textContent = ""; return; }
    var key = labelKeyFor(labelColor());
    note.textContent = key ? "A multicam build presses " + key.label + " (Edit > Label > " + name + ") on the camera 2 shots."
      : "Give Edit > Label > " + name + " a shortcut (Edit > Keyboard Shortcuts) so a multicam build can press it; scripts often can't set the colour.";
  }
  function labelCamera2(seqId, track, ranges, reset, sender, step) {
    if (!$("rose2").checked || (!ranges.length && !reset)) return Promise.resolve(null);
    var color = labelColor(), name = labelName(color), key = sender ? labelKeyFor(color) : null;
    var hasBase = reset && reset.color !== null && reset.color !== undefined && reset.color !== color;
    if (key) return labelByKeys(seqId, track, ranges, hasBase ? reset : null, sender, key, step || log);
    var arg = { sequenceID: seqId, track: track, ranges: ranges, color: color };
    if (hasBase) { arg.within = reset.within; arg.otherColor = reset.color; }
    var tip = " Give Edit > Label > " + name + " a shortcut (Edit > Keyboard Shortcuts) and a multicam build will press it instead.";
    return callHostWithin(20000, "colorClips", [JSON.stringify(arg)]).then(function (r) {
      if (r.unsupported) log("This Premiere doesn't let scripts set clip label colours" + (r.error ? " (" + r.error + ")" : "") + ", so camera 2 shots weren't labelled." + tip);
      else log("Labelled " + r.colored + " camera 2 shots " + name + " by script. If they didn't change colour on the timeline:" + tip);
      r.name = name;
      return r;
    }, function (e) { log("Couldn't label camera 2 shots: " + e.message); return null; });
  }
  function labelByKeys(seqId, track, ranges, reset, sender, key, step) {
    var name = labelName(labelColor()), colored = 0;
    function press(sel, k, what) {
      return callHostWithin(20000, "selectClips", [JSON.stringify(sel)]).then(function (r) {
        if (r.unsupported) throw new Error("Premiere wouldn't let PodCutter select clips" + (r.error ? " (" + r.error + ")" : ""));
        if (!r.selected) return 0;
        return wait(kbdPause()).then(function () { return sender.send(k.usable); }).then(function (reply) {
          step("label " + what + ": " + r.selected + " pieces, " + k.label + " → " + reply);
          if (reply !== "OK") throw new Error(reply.indexOf("NOFOCUS") === 0 ? "Premiere stopped being the window in front" : "couldn't type " + k.label);
          return wait(kbdPause()).then(function () { return r.selected; });
        });
      });
    }
    var base = { sequenceID: seqId, track: track, ranges: ranges };
    var work = Promise.resolve();
    if (reset) {
      var baseKey = labelKeyFor(reset.color);
      if (baseKey) work = press(Object.assign({}, base, { within: reset.within, invert: true }), baseKey, labelName(reset.color));
      else step("no Edit > Label > " + labelName(reset.color) + " shortcut, so pieces that left camera 2 keep their colour");
    }
    return work.then(function () { return ranges.length ? press(base, key, name) : 0; }).then(function (n) {
      colored = n;
      log("Labelled " + n + " camera 2 shots " + name + " (Edit > Label shortcut " + key.label + ").");
    }).catch(function (e) {
      log("Couldn't label camera 2 shots: " + e.message + ".");
    }).then(function () {
      return callHostWithin(10000, "selectClips", [JSON.stringify({ sequenceID: seqId, track: track, ranges: [] })]).catch(function () {});
    }).then(function () { return { colored: colored, unsupported: false, name: name }; });
  }
  /** Camera 2 stretches of the planned cut, and the stacked track that camera is on. */
  function camera2Shots() {
    var cams = {}; state.config.cameras.forEach(function (c) { cams[c.id] = c; });
    var cam2 = state.config.cameras.filter(function (c) { return c.enabled !== false && angleOfCam(c) === 2 && c.videoTrack < NEST_BASE; })[0];
    if (!cam2 || !state.result) return null;
    return { track: cam2.videoTrack, ranges: state.result.shots.filter(function (s) { return cams[s.cameraId] && angleOfCam(cams[s.cameraId]) === 2; })
      .map(function (s) { return [s.startSec, s.endSec]; }) };
  }
  function roseNote(r) { return r && !r.unsupported && r.colored ? "; " + r.colored + " camera 2 shots labelled " + (r.name || "Rose") : ""; }

  function currentPayload() {
    if (blindCameras().length) throw new Error(blindMessage(blindCameras()));
    if (usesNest()) throw new Error("Your cameras are angles inside a multicam nest: use Build as multicam. (Build cut on a copy and Recut switch stacked camera tracks.)");
    var cams = state.config.cameras.filter(function (c) { return c.enabled !== false; });
    // The layered cut keeps the bottom camera whole; if the 24-70 wide is higher up it would cover the rest, so cut every track.
    var wide = lensWide(), layered = load("layered", true) !== false;
    if (layered && wide && cams.some(function (c) { return c.videoTrack < wide.videoTrack; })) {
      layered = false;
      log("The wide (“" + wide.name + "”, 24-70) isn't the bottom camera, so every camera track is cut (not layered).");
    }
    return D.toEditPayload(state.result, cams, state.seq.fps, { layered: layered });
  }

  var applyCut = guard(function () {
    if (!state.result) return;
    var payload = currentPayload(), orig = state.seq, newSeq;
    status("Duplicating the sequence\u2026", "", 0.02);
    return callHost("duplicateActive", [orig.sequenceID, " - PodCutter"]).then(function (r) {
      newSeq = r; log("Created " + r.name);
      return writeCut(newSeq.sequenceID, payload, "Cutting");
    }).then(function (r) {
      var c2 = camera2Shots();
      return (c2 ? labelCamera2(newSeq.sequenceID, c2.track, c2.ranges) : Promise.resolve(null)).then(function (rose) { return markWelcome().then(function () { return rose; }); }).then(function (rose) {
        rememberCut(orig, newSeq, payload, state.result.stats, true);
        renderRecut();
        status("Done: \u201C" + newSeq.name + "\u201D has " + state.result.stats.cuts + " cuts (" + r.toggled + " clips switched" + shownNote(r) + roseNote(rose) + "). Your original is untouched.", "ok", 1);
      });
    });
  });

  /**
   * Recut: apply the current preview to the copy built earlier, in place. Old edit points stay as invisible
   * through-edits (same camera on both sides); every clip's on/off state is set fresh from the new plan.
   */
  var recut = guard(function () {
    var rec = copyFor(state.seq);
    if (!rec || !state.result) return;
    var payload = currentPayload(), orig = state.seq;
    status("Opening \u201C" + rec.name + "\u201D\u2026", "", 0.02);
    return callHost("openSequenceById", [rec.id]).then(function (r) {
      return writeCut(rec.id, payload, "Recutting").then(function (res) {
        var c2 = camera2Shots();
        return (c2 ? labelCamera2(rec.id, c2.track, c2.ranges) : Promise.resolve(null)).then(function (rose) { return markWelcome().then(function () { return rose; }); }).then(function (rose) {
          rememberCut(orig, { sequenceID: rec.id, name: r.name }, payload, state.result.stats, false);
          renderRecut();
          status("Recut \u201C" + r.name + "\u201D: " + state.result.stats.cuts + " cuts (" + res.toggled + " clips switched" + shownNote(res) + roseNote(rose) + "). Undo recut puts the previous version back.", "ok", 1);
        });
      });
    });
  });

  var undoRecut = guard(function () {
    var all = copies(), rec = state.seq && all[state.seq.sequenceID];
    if (!rec || rec.history.length < 2) return;
    var prev = rec.history[rec.history.length - 2];
    status("Opening \u201C" + rec.name + "\u201D\u2026", "", 0.02);
    return callHost("openSequenceById", [rec.id]).then(function () {
      return writeCut(rec.id, prev.payload, "Restoring");
    }).then(function () {
      rec.history.pop(); all[state.seq.sequenceID] = rec; store("copies", all);
      renderRecut();
      status("Restored the previous cut (" + prev.cuts + " cuts) on \u201C" + rec.name + "\u201D.", "ok", 1);
    });
  });

  function renderRecut() {
    var rec = copyFor(state.seq);
    $("recutRow").classList.toggle("hidden", !rec || !inPremiere || usesNest());
    $("btnRecut").textContent = rec ? "Recut \u201C" + rec.name + "\u201D" : "Recut last copy";
    $("btnRecut").disabled = state.busy || !rec || !state.result;
    $("btnUndoRecut").disabled = state.busy || !rec || rec.history.length < 2;
    $("recutNote").textContent = rec ? "Recut keeps the same copy (and any nest of it) and just changes which camera is on. " +
      (rec.history.length > 1 ? (rec.history.length - 1) + " earlier version" + (rec.history.length > 2 ? "s" : "") + " can be restored." : "") : "";
  }

  function exportForClaude() {
    try { exportForClaudeInner(); }
    catch (e) { status("Export failed: " + e.message, "err"); }
  }
  function exportForClaudeInner() {
    if (!state.result || !hasNode) return;
    fs.mkdirSync(state.docsDir, { recursive: true });
    var down = 4; // 25 ms -> 100 ms
    var curves = {};
    state.config.speakers.forEach(function (s) {
      var c = state.curves[curveKey(s)]; if (!c) return;
      var out = [];
      for (var i = 0; i < c.length; i += down) { var m = -120; for (var k = i; k < Math.min(c.length, i + down); k++) m = Math.max(m, c[k]); out.push(Math.round(m)); }
      curves[s.id] = out;
    });
    var doc = {
      about: "PodCutter analysis export. Re-plan with: node cli/podcutter.js plan <this file> [--preset lively] [--set key=value]. " +
        "Edit `config` (speakers, cameras, preset, style, overrides) and import it back via Settings > Import settings.",
      exportedAt: new Date().toISOString(), engineVersion: D.VERSION,
      sequence: { name: state.seq.name, fps: state.seq.fps, durationSec: state.seq.durationSec },
      range: currentRange() ? { startSec: currentRange().a, endSec: currentRange().b } : undefined,
      // Content cuts found in the timeline (each becomes a zero-length removal the plan covers).
      contentCuts: timelineJoins().map(function (j) { return j.startSec; }),
      input: { durationSec: state.seq.durationSec, hopSec: HOP * down, fps: state.seq.fps, curves: curves,
        framing: framingInput(state.result),
        cameraMotion: (function () {
          var m = cameraMotionInput(), o = {};
          Object.keys(m).forEach(function (id) { o[id] = { hopSec: m[id].hopSec, values: Array.prototype.map.call(m[id].values, function (v) { return isNaN(v) ? null : Math.round(v * 10) / 10; }) }; });
          return o;
        })() },
      config: cleanConfig(state.config),
      result: { calibration: state.result.calibration, stats: state.result.stats, shots: state.result.shots },
      cleanup: state.tx.suggestions.length ? state.tx.suggestions : undefined
    };
    var file = path.join(state.docsDir, safe(state.seq.name) + ".podcutter.json");
    fs.writeFileSync(file, JSON.stringify(doc));
    status("Exported to " + file, "ok");
  }
  function cleanConfig(c) {
    var o = copy(c);
    o.speakers.forEach(function (s) { delete s._open; });
    return o;
  }
  function safe(n) { return String(n).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80); }

  function importSettings(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var o = JSON.parse(r.result);
        var cfg = o.config || o;
        if (!cfg.speakers || !cfg.cameras) throw new Error("No speakers/cameras in that file.");
        state.config = cfg; saveConfig(); renderAll(); replan();
        status("Imported settings from " + file.name, "ok");
      } catch (e) { status("Import failed: " + e.message, "err"); }
    };
    r.readAsText(file);
  }

  // ------------------------------------------------------------ cleanup
  function renderCleanupControls() {
    var box = $("cleanupControls"); box.innerHTML = "";
    UI.cleanupControls.forEach(function (def) {
      box.appendChild(slider(def, state.cleanupOpts[def.key], function (v) {
        state.cleanupOpts[def.key] = v; store("cleanupOpts", state.cleanupOpts); debounce("clean", runCleanup, 150);
      }, { reset: T.DEFAULTS[def.key] }));
    });
  }

  function txCachePath() { return state.seq && hasNode ? path.join(state.docsDir, safe(state.seq.name) + ".transcript.json") : null; }
  function loadCachedTranscript() {
    var p = txCachePath();
    if (!p) return;
    try {
      var o = JSON.parse(fs.readFileSync(p, "utf8"));
      setSegments(o.segments, "Loaded saved transcript (" + o.segments.length + " lines, " + (o.source || "file") + ").");
    } catch (e) { $("txStatus").textContent = ""; }
  }
  function saveTranscript(segs, source) {
    var p = txCachePath();
    if (p) try { fs.writeFileSync(p, JSON.stringify({ source: source, savedAt: new Date().toISOString(), segments: segs })); } catch (e) { log(e.message); }
  }

  function setSegments(segs, msg) {
    state.tx.segments = segs; state.tx.off = {}; state.tx.nudges = {};
    $("txStatus").textContent = msg || "";
    runCleanup();
  }

  function speakerRunsByName() {
    if (!state.result) return null;
    var names = {}; state.config.speakers.forEach(function (s) { names[s.id] = s.name; });
    return state.result.speech.map(function (r) { return { speakerId: names[r.speakerId] || r.speakerId, runs: r.runs }; });
  }

  function runCleanup() {
    if (!state.tx.segments) return;
    var segs = T.assignSpeakers(state.tx.segments, speakerRunsByName());
    var res = T.analyze(segs, state.cleanupOpts);
    state.tx.suggestions = res.suggestions;
    state.tx.intro = T.introduction(segs, { showName: state.cleanupOpts.showName,
      names: state.config ? state.config.speakers.filter(function (s) { return s.enabled !== false; }).map(function (s) { return s.name; }) : [] });
    renderSuggestions(); renderIntro(); refreshVizCleanup(); setButtons();
  }

  // ------------------------------------------------------- introduction
  /** Name-tag text per person, editable and remembered ("Martin" -> "Martin Cothran"). */
  function tagFor(n) { var saved = load("nameTags", {}); return saved[n.name] || n.fullName || n.name; }

  function renderIntro() {
    var it = state.tx.intro, card = $("introCard");
    card.classList.toggle("hidden", !it);
    $("btnIntroMarkers").disabled = !it || !it.names.length || !inPremiere || state.busy;
    if (!it) return;
    $("introWhen").textContent = "welcome at " + fmt(it.welcomeSec) + (it.host ? " · " + it.host.name + " hosting" : "");
    $("introCut").checked = state.config.introCut !== false;
    $("introNote").textContent = "“" + it.welcomeText.slice(0, 90) + "” — solo cam until " + fmt(it.wideSec) +
      ", then the wide until " + fmt(Math.max(it.endSec, it.wideSec + introHold())) + ". Times come from the transcript; check them before dropping name tags.";
    $("introHold").value = introHold();
    var box = $("introNames"); box.innerHTML = "";
    if (!it.names.length) { box.appendChild(el("div", { class: "muted small", text: "Nobody named yet: speaker names on the Multicam tab are matched against the introduction." })); return; }
    it.names.forEach(function (n) {
      var input = el("input", { value: tagFor(n), title: "Text for this person's lower third",
        onchange: function () { var all = load("nameTags", {}); all[n.name] = input.value.trim(); store("nameTags", all); } });
      box.appendChild(el("div", { class: "intro-name" }, [
        el("span", { class: "time", text: fmt(n.sec), title: "Jump there", onclick: function () { seek(n.sec); } }),
        input,
        el("span", { class: "tag", text: n.host ? "host" : n.guest ? "guest" : "" })
      ]));
    });
  }

  /** The intro as the cut engine wants it, or null when it's off or there's no transcript. */
  function introPlan() {
    var it = state.tx.intro;
    if (!it || state.config.introCut === false) return null;
    var hostId = null;
    if (it.host) state.config.speakers.forEach(function (s) {
      if (s.name.split(/\s+/)[0].toLowerCase() === it.host.name.split(/\s+/)[0].toLowerCase()) hostId = s.id;
    });
    return { startSec: it.welcomeSec, wideSec: it.wideSec, endSec: it.endSec, hostId: hostId, holdSec: introHold() };
  }
  function introHold() { var v = state.config && state.config.introHoldSec; return v === undefined || v === null ? 15 : +v; }

  /** Put a marker where the host says the welcome on a built sequence (the active one), so the intro is easy to find. */
  function markWelcome() {
    var it = state.tx.intro;
    if (!it || !inPremiere) return Promise.resolve(null);
    var host = it.host ? it.host.name : "the host";
    return callHost("clearMarkers", [MARK_INTRO]).then(function () {
      return callHost("addMarkers", [JSON.stringify({ prefix: MARK_INTRO, markers: [{ startSec: it.welcomeSec, endSec: it.welcomeEndSec, color: 0,
        name: "Welcome (" + host + ")", comment: "“" + it.welcomeText + "” — solo on " + host + ", then the wide from " + fmt(it.wideSec) +
          " for at least " + introHold() + " s while the members are introduced." }] })]);
    }).then(function (r) { log("Marked the welcome at " + fmt(it.welcomeSec) + "."); return r; }, function (e) { log("Couldn't mark the welcome: " + e.message); return null; });
  }

  var markNames = guard(function () {
    var it = state.tx.intro;
    var markers = it.names.map(function (n) {
      return { startSec: n.sec, endSec: n.sec + 5, name: tagFor(n), color: 4,
        comment: "Lower third" + (n.host ? " (host)" : n.guest ? " (guest)" : "") + ": " + tagFor(n) };
    });
    return callHost("clearMarkers", [MARK_NAME]).then(function () {
      return callHost("addMarkers", [JSON.stringify({ prefix: MARK_NAME, markers: markers })]);
    }).then(function (r) { status("Added " + r.added + " name markers in yellow for the lower thirds.", "ok", 1); });
  });
  var clearNames = guard(function () {
    return callHost("clearMarkers", [MARK_NAME]).then(function (r) { status("Removed " + r.removed + " name markers.", "ok"); });
  });

  function sugRange(s) {
    var n = state.tx.nudges[s.id] || [0, 0];
    return [Math.max(0, s.startSec + n[0]), Math.max(s.startSec + n[0] + 0.1, s.endSec + n[1])];
  }
  function acceptedCuts() {
    return state.tx.suggestions.filter(function (s) { return !state.tx.off[s.id]; }).map(function (s) {
      var r = sugRange(s); return { startSec: r[0], endSec: r[1] };
    });
  }
  function refreshVizCleanup() {
    if (viz.data) { viz.data.cleanup = acceptedCuts(); viz.render(); }
    if (state.result) debounce("plan", replan, 150); // camera must change across each accepted cut
  }

  function renderSuggestions() {
    var box = $("sugList"); box.innerHTML = "";
    var list = state.tx.suggestions;
    var on = list.filter(function (s) { return !state.tx.off[s.id]; });
    var secs = on.reduce(function (a, s) { var r = sugRange(s); return a + r[1] - r[0]; }, 0);
    $("sugCount").textContent = list.length ? on.length + " of " + list.length + " selected · " + secs.toFixed(0) + " s" : "";
    if (!list.length) { box.appendChild(el("div", { class: "muted", text: state.tx.segments ? "Nothing flagged. Lower Min confidence to see weaker matches." : "No transcript loaded." })); return; }
    list.forEach(function (s) {
      var r = sugRange(s);
      var conf = s.confidence >= 0.75 ? "" : s.confidence >= 0.55 ? " mid" : " low";
      var item = el("div", { class: "sug" + (state.tx.off[s.id] ? " off" : ""), onclick: function (e) {
        if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
        seek(r[0]);
      } });
      var box2 = el("input", { type: "checkbox" }); box2.checked = !state.tx.off[s.id];
      box2.addEventListener("change", function () { state.tx.off[s.id] = !box2.checked; renderSuggestions(); refreshVizCleanup(); setButtons(); });
      function nudge(which, d) {
        return el("button", { class: "btn ghost", text: (which === 0 ? "←" : "") + (d < 0 ? "−" : "+") + (which === 1 ? "→" : ""),
          title: (which === 0 ? "Start " : "End ") + (d < 0 ? "earlier" : "later") + " by 0.5 s",
          onclick: function () { var n = state.tx.nudges[s.id] || [0, 0]; n[which] += d; state.tx.nudges[s.id] = n; renderSuggestions(); refreshVizCleanup(); } });
      }
      item.appendChild(el("div", { class: "sug-top" }, [
        box2,
        el("span", { class: "time", text: fmt(r[0]) + " – " + fmt(r[1]) }),
        el("span", { class: "badge" + conf, text: s.type + " " + Math.round(s.confidence * 100) + "%" }),
        el("span", { class: "sug-nudge" }, [nudge(0, -0.5), nudge(0, 0.5), nudge(1, -0.5), nudge(1, 0.5)])
      ]));
      item.appendChild(el("div", { class: "small", text: s.reason }));
      // The show's real start/end: set the sequence In/Out there so the multicam pass skips the chatter too.
      if (s.showStartSec !== undefined || s.showEndSec !== undefined) {
        var isStart = s.showStartSec !== undefined, at = isStart ? s.showStartSec : s.showEndSec;
        item.appendChild(el("div", { class: "sug-actions" }, [el("button", { class: "btn ghost small",
          text: (isStart ? "Set In point at the welcome (" : "Set Out point at the sign-off (") + fmt(at) + ")",
          title: "Sets the sequence " + (isStart ? "In" : "Out") + " point so Analyze and the cut skip the " + (isStart ? "pre-show" : "post-show") + " chat",
          onclick: function () { setShowEdge(isStart, at); } })]));
      }
      item.appendChild(el("div", { class: "sug-text", text: s.text }));
      box.appendChild(item);
    });
  }

  var setShowEdge = guard(function (isStart, sec) {
    if (!state.seq) throw new Error("Scan a sequence first.");
    var q = state.seq;
    if (isStart && q.outSec != null && sec >= q.outSec) throw new Error("The welcome (" + fmt(sec) + ") is after the Out point. Move the Out point first.");
    if (!isStart && q.inSec != null && sec <= q.inSec) throw new Error("The sign-off (" + fmt(sec) + ") is before the In point.");
    var arg = isStart ? { inSec: sec } : { outSec: sec };
    function done() {
      if (isStart) state.seq.inSec = sec; else state.seq.outSec = sec;
      state.config.range = "inout"; saveConfig(); renderRangeSelect();
      state.result = null; replan();
      status((isStart ? "In" : "Out") + " point set at " + fmt(sec) + (curvesReady() ? ": re-planned the show." : ". Click Analyze waveforms to cut only the show."), curvesReady() ? "ok" : "", 0);
    }
    if (!inPremiere) { done(); return; }
    return callHost("setInOut", [JSON.stringify(arg)]).then(done);
  });

  var transcribe = guard(function () {
    if (!state.seq) throw new Error("Scan a sequence first.");
    if (!inPremiere) { setSegments(window.PD_DEMO.transcript(), "Demo transcript loaded."); return; }
    if (!state.tools.ffmpeg) throw new Error("ffmpeg is not available. See Settings.");
    if (!state.tools.whisper) throw new Error("The bundled transcriber was not found. See Settings.");
    var spk = state.config.speakers.filter(function (s) { return s.enabled !== false; });
    var tracks = spk.length ? spk.map(function (s) { return { t: s.audioTrack, ch: s.channel }; })
      : state.seq.audioTracks.filter(function (a) { return !a.muted; }).map(function (a) { return { t: a.index, ch: null }; });
    var clips = [];
    if (spk.length) spk.forEach(function (sp) { speakerTrack(sp).clips.forEach(function (c) { clips.push(c); }); });
    else tracks.forEach(function (x) { trimToRange(state.seq.audioTracks[x.t]).clips.forEach(function (c) { var cc = copy(c); cc.channel = null; clips.push(cc); }); });
    var t0 = Date.now();
    log("Transcribing " + clips.length + " clips with " + path.basename(state.tools.whisper.model));
    return W.transcribeTimeline({
      ffmpegPath: state.tools.ffmpeg, clips: clips, durationSec: state.seq.durationSec, prompt: $("txPrompt").value.trim(),
      onProgress: function (stage, f) {
        if (stage === "mix") status("Preparing audio for transcription… " + Math.round(f * 100) + "%", "", 0.15 * f);
        else status("Transcribing offline… " + Math.round(f * 100) + "% (" + Math.round((Date.now() - t0) / 1000) + " s)", "", 0.15 + 0.85 * f);
      }
    }).then(function (segs) {
      saveTranscript(segs, "whisper");
      setSegments(segs, "Transcribed " + segs.length + " lines in " + Math.round((Date.now() - t0) / 1000) + " s.");
      status("Transcript ready — " + state.tx.suggestions.length + " suggested cuts.", "ok", 1);
    });
  });

  function loadTranscriptFile(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var segs = T.parse(r.result, { fps: state.seq ? state.seq.fps : 30 });
        if (!segs.length) throw new Error("No timecoded lines found.");
        saveTranscript(segs, file.name);
        setSegments(segs, "Loaded " + file.name + " (" + segs.length + " lines).");
        status(state.tx.suggestions.length + " suggested cuts.", "ok");
      } catch (e) { status("Could not read transcript: " + e.message, "err"); }
    };
    r.readAsText(file);
  }

  var markCuts = guard(function () {
    var list = state.tx.suggestions.filter(function (s) { return !state.tx.off[s.id]; });
    var markers = list.map(function (s) {
      var r = sugRange(s);
      return { startSec: r[0], endSec: r[1], name: s.type, color: 1, comment: s.reason + "\n" + s.text };
    });
    return callHost("clearMarkers", [MARK_CUT]).then(function () {
      return callHost("addMarkers", [JSON.stringify({ prefix: MARK_CUT, markers: markers })]);
    }).then(function (r) { status("Marked " + r.added + " sections in red. Review them, then lift/ripple-delete the ones you agree with.", "ok", 1); });
  });
  var clearCuts = guard(function () {
    return callHost("clearMarkers", [MARK_CUT]).then(function (r) { status("Removed " + r.removed + " cleanup markers.", "ok"); });
  });

  function exportCsv() {
    var list = state.tx.suggestions.filter(function (s) { return !state.tx.off[s.id]; }).map(function (s) {
      var r = sugRange(s); var c = copy(s); c.startSec = r[0]; c.endSec = r[1]; return c;
    });
    var file = path.join(state.docsDir, safe(state.seq ? state.seq.name : "transcript") + ".cuts.csv");
    fs.writeFileSync(file, T.toCsv(list));
    status("Saved " + file, "ok");
  }

  function copyForClaude() {
    var lines = ["I'm editing a podcast in Premiere. Below are sections an automatic analyzer flagged for removal",
      "(spoken edit cues, restarts, off-the-record talk). For each, tell me: keep or cut, and adjust the start/end",
      "if the cut should begin or end elsewhere so the edit sounds natural. Then list any other spots in the transcript",
      "that sound like they were meant to be cut.", "", "FLAGGED:"];
    state.tx.suggestions.forEach(function (s) {
      var r = sugRange(s);
      lines.push("- " + s.id + " [" + fmt(r[0]) + " – " + fmt(r[1]) + "] " + s.type + " (" + Math.round(s.confidence * 100) + "%): " + s.reason);
    });
    lines.push("", "TRANSCRIPT:");
    T.assignSpeakers(state.tx.segments, speakerRunsByName()).forEach(function (sg) {
      lines.push("[" + fmt(sg.startSec) + "] " + (sg.speaker ? sg.speaker + ": " : "") + sg.text);
    });
    var text = lines.join("\n");
    var ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    if (hasNode) {
      var file = path.join(state.docsDir, safe(state.seq ? state.seq.name : "transcript") + ".claude-review.txt");
      fs.writeFileSync(file, text);
      status((ok ? "Copied to clipboard and saved " : "Saved ") + file, "ok");
    } else status(ok ? "Copied to clipboard." : "Copy failed.", ok ? "ok" : "err");
  }

  // ------------------------------------------------------------ updates
  var U = window.PodUpdater, pending = null;
  function updateOpts() {
    return { current: D.VERSION, folder: $("updateFolder").value.trim(), github: $("updateGithub").checked };
  }
  function checkUpdates(quiet) {
    if (!hasNode || !U) { if (!quiet) $("updateStatus").textContent = "Updates need the panel running inside Premiere."; return Promise.resolve(); }
    $("updateStatus").textContent = "Checking\u2026";
    store("updateCheckedAt", Date.now());
    return U.check(updateOpts()).then(function (r) {
      pending = r.newer ? r.latest : null;
      $("verLatest").textContent = r.latest ? r.latest.version + " (" + r.latest.source + ")" : "none found";
      $("btnInstallUpdate").disabled = !pending;
      $("updateStatus").textContent = pending ? "Version " + pending.version + " is available." :
        (r.latest ? "You're up to date." : "No release found.") + (r.errors.length ? " " + r.errors.join(" ") : "");
      if (pending && load("skipVersion", null) !== pending.version) {
        $("updateText").textContent = "PodCutter " + pending.version + " is available (you have " + D.VERSION + ").";
        $("updateBanner").classList.remove("hidden");
      }
      if (r.errors.length) log("Update check: " + r.errors.join(" | "));
    });
  }
  var installUpdate = guard(function () {
    if (!pending) return;
    $("updateBanner").classList.add("hidden");
    var labels = { copy: "Copying update", download: "Downloading update", unpack: "Unpacking", install: "Installing", done: "Installed" };
    return U.install(pending, function (stage, f) {
      status(labels[stage] + (f && f < 1 ? " " + Math.round(f * 100) + "%" : "") + "\u2026", "", stage === "download" ? f * 0.7 : stage === "install" ? 0.85 : stage === "done" ? 1 : 0.75);
    }, { extensionRoot: state.extRoot }).then(function (r) {
      log(r.log);
      $("btnUpdateNow").classList.add("hidden");
      $("updateBanner").classList.remove("hidden");
      if (r.needsRestart) {
        // The manifest changed (more than its version): Premiere only reads it at startup.
        $("updateStatus").textContent = "Installed " + r.version + ". This update changes how Premiere loads the panel: restart Premiere Pro to finish.";
        $("updateText").textContent = "PodCutter " + r.version + " is installed. Save your project and restart Premiere Pro to use it.";
        $("btnUpdateLater").textContent = "OK";
        status("Update installed \u2014 restart Premiere Pro to finish.", "ok", 1);
      } else {
        $("updateStatus").textContent = "Installed " + r.version + ". Click Reload PodCutter to start using it; no need to restart Premiere.";
        $("updateText").textContent = "PodCutter " + r.version + " is installed.";
        $("btnReloadBanner").classList.remove("hidden");
        $("btnUpdateLater").textContent = "Later";
        status("Update installed \u2014 reload PodCutter to use it.", "ok", 1);
      }
      pending = null; $("btnInstallUpdate").disabled = true;
    });
  });

  // ------------------------------------------------ multicam by keystrokes (trial)
  var K = window.PodKeys, kbdStop = false;
  function cutKeys() {
    if (!hasNode || !K || !state.docsDir) return null;
    var files = K.findShortcutFiles([path.dirname(state.docsDir)]);
    if (!files.length) return { file: null, cams: [] };
    try { return { file: files[0], cams: K.cutToCameraKeys(K.parseShortcuts(fs.readFileSync(files[0].path, "utf8")), 4) }; }
    catch (e) { return { file: files[0], cams: [], error: e.message }; }
  }
  function renderKbdKeys() {
    var box = $("kbdKeys"); box.innerHTML = "";
    var k = cutKeys();
    if (!k) { box.textContent = "Needs the panel running inside Premiere on Windows."; return; }
    if (!k.file) {
      box.textContent = "Couldn't find your Premiere keyboard shortcuts file. Looked in " +
        K.documentsFolders([path.dirname(state.docsDir)]).map(function (d) { return path.join(d, "Adobe", "Premiere Pro"); }).join(" and ") + ".";
      return;
    }
    box.appendChild(el("div", { class: "muted", text: "From " + path.basename(k.file.path) + " (Premiere " + k.file.version + "):" }));
    k.cams.slice(0, 2).forEach(function (c) {
      box.appendChild(el("div", { text: "Cut to Camera " + c.camera + ": " + (c.label || "no shortcut") +
        (c.label && !c.usable ? " — use a letter, digit or symbol key (with any modifiers) so PodCutter can type it" : "") }));
    });
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  /** A host call that gives up after ms instead of hanging (Premiere can stop answering while a dialog is open). */
  function callHostWithin(ms, fn, args) {
    return Promise.race([callHost(fn, args), wait(ms).then(function () {
      throw new Error("Premiere didn't answer " + fn + " within " + Math.round(ms / 1000) + " s. Is a dialog open in Premiere?");
    })]);
  }

  // The pinned bar at the top: mode "click" (countdown), "running" (typing), or null to hide it.
  function kbdBanner(mode, big, small) {
    var b = $("kbdBanner");
    b.classList.toggle("hidden", !mode);
    b.classList.toggle("click", mode === "click");
    b.classList.toggle("running", mode === "running");
    $("kbdBannerBig").innerHTML = big || "";
    $("kbdBannerSmall").textContent = small || "";
  }
  function kbdPause() { return Math.max(50, Math.min(2000, +$("kbdPause").value || 250)); }

  /** Cut to Camera keys for these angles, or an error naming the ones that can't be typed. */
  function keysFor(angles) {
    var k = cutKeys();
    if (!k || !k.file) throw new Error("Couldn't find your Premiere keyboard shortcuts file, so PodCutter doesn't know your Cut to Camera keys.");
    var map = {}, bad = [];
    angles.forEach(function (a) {
      var c = k.cams[a - 1];
      if (c && c.usable) map[a] = c; else bad.push("camera " + a + " = " + (c && c.label ? c.label : "none"));
    });
    if (bad.length) throw new Error("Cut to Camera needs a letter, digit or symbol shortcut (Edit > Keyboard Shortcuts) for: " + bad.join(", ") + ".");
    return { file: k.file, map: map };
  }

  /**
   * Type a list of angle changes into Premiere: countdown (click in the Timeline), then for each { sec, camera }
   * park the playhead and press Cut to Camera. Stops on Stop, or as soon as Premiere isn't the window in front.
   * opts: { cuts, keys, from (index to start at), label, say, step, onCut(index) } -> { done, ms }
   */
  function typeCuts(opts) {
    var sender = null, done = opts.from || 0, pause = kbdPause(), total = opts.cuts.length;
    kbdStop = false;
    opts.step("starting the keystroke helper");
    return K.startSender().then(function (s) {
      sender = s;
      opts.step("helper ready; counting down");
      var n = 5;
      function tick() {
        if (kbdStop) throw new Error("Stopped before anything was sent.");
        if (n === 0) return null;
        kbdBanner("click", "Click once in the Timeline now <b>" + n + "</b>", "PodCutter types into whatever has focus. Then hands off until it's done.");
        opts.say("Click once in the Timeline now… starting in " + n--);
        return wait(1000).then(tick);
      }
      return tick();
    }).then(function () {
      return sender.front();
    }).then(function (title) {
      opts.step("window in front: “" + title.slice(0, 60) + "”");
      if (title.indexOf("Adobe Premiere Pro") < 0) throw new Error("Premiere wasn't the window in front (“" + title.slice(0, 40) + "”), so nothing was sent.");
      var t0 = Date.now();
      function next() {
        if (kbdStop) throw new Error("Stopped after " + done + " of " + total + ".");
        if (done >= total) return null;
        var c = opts.cuts[done], key = opts.keys.map[c.camera], left = (total - done) * (2 * pause + 120) / 1000;
        if (!key || !key.usable) throw new Error("No typeable Cut to Camera " + c.camera + " shortcut; stopped after " + done + " of " + total + ".");
        kbdBanner("running", opts.label + " — hands off", (done + 1) + " of " + total + ": camera " + c.camera + " at " + fmt(c.sec) +
          " · about " + (left > 90 ? Math.ceil(left / 60) + " min" : Math.ceil(left) + " s") + " left. Switching windows stops it.");
        opts.say(opts.label + ": " + (done + 1) + " of " + total);
        // Snapped to the exact frame, so Cut to Camera lands on an existing edit point rather than a frame before it.
        return callHostWithin(10000, "setPlayhead", [c.sec, true]).then(function () { return wait(pause); }).then(function () {
          return sender.send(key.usable); // the typeable shortcut ({ key, ctrl, alt, shift }), not the whole entry
        }).then(function (reply) {
          opts.step((done + 1) + ": " + key.label + " at " + fmt(c.sec) + " → " + reply);
          if (reply !== "OK") {
            throw new Error(reply.indexOf("NOFOCUS") === 0 ? "Premiere stopped being the window in front; stopped after " + done + " of " + total + "."
              : "Couldn't type " + key.label + " (" + reply + ").");
          }
          done++;
          if (opts.onCut) opts.onCut(done);
          return wait(pause);
        }).then(next);
      }
      return next().then(function () {
        // opts.after(sender): more keystrokes while the Timeline still has focus (the label colour).
        var ms = Date.now() - t0;
        return (opts.after ? opts.after(sender) : Promise.resolve(null)).then(function (after) { return { done: done, ms: ms, after: after }; });
      });
    }).then(function (r) { kbdBanner(null); sender.close(); return r; },
      function (e) { kbdBanner(null); if (sender) sender.close(); e.done = done; throw e; });
  }

  /**
   * Trial: from the playhead, every few seconds, cut to camera 2, 1, 2, … on the multicam clip under the
   * playhead by pressing the user's Cut to Camera shortcuts.
   */
  var runKbdTrial = guard(function () {
    if (!inPremiere || !hasNode || !K) throw new Error("The keystroke trial needs the panel running inside Premiere on Windows.");
    renderKbdKeys();
    var keys = keysFor([1, 2]);
    var count = Math.max(2, Math.min(40, +$("kbdCount").value || 6)), every = Math.max(0.5, +$("kbdEvery").value || 2);
    function say(t) { $("kbdStatus").textContent = t; status(t, ""); }
    function step(t) { log("Keystroke trial: " + t); }
    var info = null, cuts = [];
    step("keys " + keys.map[1].label + " / " + keys.map[2].label + " from " + keys.file.path);
    step("looking for a multicam clip under the playhead");
    return callHostWithin(10000, "multicamAtPlayhead").then(function (r) {
      info = r;
      if (!r.multicam) throw new Error("There's no multicam or nested clip under the playhead in “" + r.name + "”. Park the playhead on one and try again.");
      step("found “" + r.multicam.name + "” on V" + (r.multicam.track + 1) + " (" + (r.multicam.multicam ? "multicam" : "nested sequence; make sure Multi-Camera is enabled on it") + ")");
      for (var i = 0; i < count; i++) {
        var at = r.playheadSec + (i + 1) * every;
        if (at >= r.multicam.endSec - 0.1) break; // past the end of the multicam clip
        cuts.push({ sec: at, camera: i % 2 === 0 ? 2 : 1 });
      }
      return typeCuts({ cuts: cuts, keys: keys, label: "Trial", say: say, step: step });
    }).then(function (res) {
      log("Keystroke trial on " + info.name + " (" + info.multicam.name + "): " + cuts.map(function (s) { return fmt(s.sec) + " cam " + s.camera; }).join(", "));
      return callHostWithin(10000, "setPlayhead", [info.playheadSec]).then(function () {
        say("Sent " + res.done + " cuts in " + (res.ms / 1000).toFixed(1) + " s, from " + fmt(info.playheadSec) +
          ". Check the timeline: there should be a cut every " + every + " s, alternating camera 2 and 1. The times are in the Log.");
      });
    }, function (e) { $("kbdStatus").textContent = e.message; throw e; });
  });

  // ----------------------------------------------------- build as multicam
  /**
   * Per sequence: the builds applied to it (newest last, up to 5) for Recut / Undo, the run in progress (for
   * Resume), and the multicam pieces' original label colour (to undo the Rose labels).
   * { history: [{ desired, startSec, endSec, partial, at }], run: { mode, typed, done, ... } | null, baseLabel }
   */
  function mcRuns() { return load("mcRuns", {}); }
  function mcRecord(id) {
    var rec = mcRuns()[id] || {};
    if (rec.cuts && !rec.history) { // older single-run format
      rec = { history: rec.done >= rec.cuts.length ? [{ desired: rec.cuts, startSec: rec.startSec, endSec: rec.endSec, partial: false }] : [],
        run: rec.done < rec.cuts.length ? { mode: "build", typed: rec.cuts, done: rec.done, track: rec.track, startSec: rec.startSec, endSec: rec.endSec, desired: rec.cuts } : null };
    }
    rec.history = rec.history || [];
    return rec;
  }
  function saveRecord(id, rec) { var all = mcRuns(); all[id] = rec; store("mcRuns", all); }
  /**
   * At Scan: forget a multicam build whose cuts aren't on the timeline any more (undone in Premiere, a fresh
   * assembly into the same sequence, or another sequence that happens to share its ID), so "Recut multicam"
   * and Resume only show when there really is a build here.
   */
  function forgetUndoneMulticam(seqId) {
    if (!inPremiere || !mcRuns()[seqId]) return;
    var rec = mcRecord(seqId), last = rec.history[rec.history.length - 1], run = rec.run, check = null;
    if (last) check = { desired: last.desired, startSec: last.startSec, endSec: last.endSec };
    else if (run && run.done > 0) check = { desired: run.typed.slice(0, run.done), startSec: run.startSec, endSec: run.endSec };
    var gone = function () {
      var all = mcRuns(); delete all[seqId]; store("mcRuns", all);
      if (state.mcSeqId === seqId) state.mcSeqId = null;
      log("No earlier multicam build is on this timeline any more, so this is a first build (not a recut).");
      renderMcRow();
    };
    if (!check) { if (!run) gone(); return; }
    callHost("multicamCovering", [JSON.stringify({ startSec: check.startSec, endSec: check.endSec })]).then(function (r) {
      if (r.sequenceID !== seqId) return;
      if (r.track === undefined) { gone(); return; }
      return callHost("countClips", [JSON.stringify({ track: r.track, startSec: check.startSec, endSec: check.endSec })]).then(function (c) {
        if (!D.multicamBuildPresent(check.desired, c.starts, check.startSec, check.endSec)) gone();
      });
    }).catch(function () { /* keep it if we can't tell */ });
  }
  /** The sequence whose multicam builds apply here: the open one, if it has been built (never another one). */
  function mcSeqId() {
    var cur = state.seq ? state.seq.sequenceID : null;
    return cur && (state.mcSeqId === cur || mcRuns()[cur]) ? cur : null;
  }

  function renderMcRow() {
    var btn = $("btnBuildMc"), resume = $("btnResumeMc"), undo = $("btnUndoMc");
    if (!btn) return;
    var id = mcSeqId(), rec = id ? mcRecord(id) : null, run = rec && rec.run;
    var left = run && run.done < run.typed.length ? run.typed.length - run.done : 0;
    resume.classList.toggle("hidden", !left);
    resume.textContent = left ? "Resume (" + left + " left)" : "Resume";
    btn.textContent = rec && rec.history.length ? "Recut multicam" : "Build as multicam (experimental)";
    undo.classList.toggle("hidden", !(rec && rec.history.length));
    undo.textContent = rec && rec.history.length > 1 ? "Undo multicam cut" : "Undo multicam cut (back to the wide)";
  }

  /**
   * Apply angles to a multicam (or Multi-Camera enabled nested) clip in the active sequence by pressing Cut to
   * Camera. Every existing piece in the range is retyped too, so it works for a first build, a recut after
   * settings changed, and an undo alike (earlier edit points just become through-edits on the same angle).
   * mode: "build" (the current plan), "resume" (the run that stopped), "undo" (the build before the last one,
   * or the wide everywhere after a first build).
   */
  var buildMulticam = guard(function (mode) {
    if (!inPremiere || !hasNode || !K) throw new Error("Build as multicam needs the panel running inside Premiere on Windows.");
    if (mode === "build") {
      if (!state.result) throw new Error("Analyze first: the build follows the planned cut.");
      if (blindCameras().length) throw new Error(blindMessage(blindCameras()));
    }
    var cams = state.config.cameras.filter(function (c) { return c.enabled !== false; });
    var verb = mode === "undo" ? "Undoing" : "Building multicam";
    function say(t) { $("mcNote").textContent = t; status(t, ""); }
    function step(t) { log("Build as multicam: " + t); }
    var seqId = null, rec = null, info = null, keys = null, desired = null, startSec = 0, endSec = 0, partial = false, typed = null, from = 0;

    return callHostWithin(10000, "getPlayhead").then(function (p) {
      seqId = p.sequenceID; rec = mcRecord(seqId);
      if (mode === "resume") {
        var run = rec.run;
        if (!run || run.done >= run.typed.length) throw new Error("Nothing to resume on this sequence.");
        typed = run.typed; from = run.done; desired = run.desired; startSec = run.startSec; endSec = run.endSec; partial = run.partial; mode = run.mode;
      } else if (mode === "undo") {
        if (!rec.history.length) throw new Error("No multicam build of this sequence to undo.");
        var last = rec.history[rec.history.length - 1], prev = rec.history[rec.history.length - 2];
        startSec = last.startSec; endSec = last.endSec; partial = last.partial;
        var wc = wideCam();
        desired = prev ? prev.desired : [{ sec: startSec, camera: wc ? angleOfCam(wc) : 1 }];
        step("undo on “" + seqId + "”: " + rec.history.length + " build(s) kept; restoring " +
          (prev ? "the build from " + (prev.at || "earlier") : "the wide everywhere") + " between " + fmt(startSec) + " and " + fmt(endSec));
      } else {
        desired = D.toMulticamCuts(state.result, cams);
        if (!desired.length) throw new Error("The planned cut is empty.");
        var shots = state.result.shots; startSec = desired[0].sec; endSec = shots[shots.length - 1].endSec;
      }
      return callHostWithin(10000, "multicamCovering", [JSON.stringify({ startSec: startSec, endSec: endSec })]);
    }).then(function (r) {
      info = r;
      if (r.track === undefined) {
        throw new Error("“" + r.name + "” has no multicam clip. In a duplicate of this sequence, select the camera clips (V1, V2), Nest them, " +
          "right-click the nest > Multi-Camera > Enable, open that sequence and try again.");
      }
      if (mode === "build") {
        // Only part of it: the multicam sequence's own In/Out marks, inside the planned cut.
        if ($("mcInOut").checked) {
          if (r.inSec === null && r.outSec === null) throw new Error("Set In and Out marks on “" + r.name + "” around the part to build, or untick “Only between the In and Out marks”.");
          var lo = Math.max(startSec, r.inSec === null ? startSec : r.inSec), hi = Math.min(endSec, r.outSec === null ? endSec : r.outSec);
          if (hi - lo < 0.5) throw new Error("The In/Out marks (" + fmt(r.inSec || 0) + "–" + fmt(r.outSec || endSec) + ") don't overlap the planned cut (" + fmt(startSec) + "–" + fmt(endSec) + ").");
          startSec = lo; endSec = hi; partial = true;
          desired = D.toMulticamCuts(state.result, cams, { startSec: lo, endSec: hi });
        }
        // Stretches with no multicam footage (the audio or the Out mark often runs a little past the cameras):
        // trim them off the ends; inside, skip their cuts and set the angle again where the footage resumes.
        var gaps = r.gaps.filter(function (g) { return g[1] > startSec + 0.05 && g[0] < endSec - 0.05; });
        if (gaps.length) {
          var skipped = gaps.map(function (g) { return fmt(g[0]) + "–" + fmt(g[1]); }).join(", ");
          gaps.forEach(function (g) {
            if (g[0] <= startSec + 0.05) startSec = g[1];
            else if (g[1] >= endSec - 0.05) endSec = g[0];
          });
          if (endSec - startSec < 0.5) throw new Error("There's no multicam footage on V" + (r.track + 1) + " in the stretch to build.");
          var inGap = function (t) { return gaps.some(function (g) { return t >= g[0] - 0.01 && t < g[1] - 0.01; }); };
          var kept = D.toMulticamCuts(state.result, cams, { startSec: startSec, endSec: endSec }).filter(function (c) { return !inGap(c.sec); });
          gaps.forEach(function (g) {
            if (g[0] <= startSec || g[1] >= endSec) return;
            var again = D.toMulticamCuts(state.result, cams, { startSec: g[1], endSec: g[1] + 0.05 })[0];
            if (again) kept.push(again);
          });
          kept.sort(function (a, b) { return a.sec - b.sec; });
          desired = kept;
          step("no multicam footage at " + skipped + ": skipped; building " + fmt(startSec) + "–" + fmt(endSec));
          say("No multicam footage at " + skipped + ", so that part is skipped.");
        }
      }
      state.mcSeqId = r.sequenceID;
      if (typed) return null; // resuming: the list was saved
      // A partial build gets edit points at In and Out, so nothing past Out changes (Cut to Camera switches up to
      // the next edit point). Then every piece in the range is retyped, so earlier builds can't leave stale angles.
      var edges = partial && mode === "build" ? callHostWithin(15000, "razorTrack", [JSON.stringify({ sequenceID: r.sequenceID, track: r.track,
        frames: [Math.round(startSec * r.fps), Math.round(endSec * r.fps)] })]).then(function (z) {
          step("edit points at In/Out: " + z.razored + " added" + (z.razored < 2 ? " (" + (2 - z.razored) + " already on a clip edge)" : ""));
        }) : Promise.resolve();
      return edges.then(function () {
        return callHostWithin(10000, "countClips", [JSON.stringify({ track: r.track, startSec: startSec, endSec: endSec })]);
      }).then(function (c) {
        if (rec.baseLabel === undefined || rec.baseLabel === null) rec.baseLabel = c.firstLabel; // before anything was labelled Rose
        typed = D.multicamRetype(desired, c.starts, startSec, endSec);
        step((mode === "undo" ? "undo" : rec.history.length ? "recut" : "build") + ": " + typed.length + " points to type (" +
          c.starts.length + " existing pieces) between " + fmt(startSec) + " and " + fmt(endSec));
      });
    }).then(function () {
      var angles = []; typed.forEach(function (c) { if (angles.indexOf(c.camera) < 0) angles.push(c.camera); });
      keys = keysFor(angles.sort());
      step("angles: " + cams.map(function (c) { return c.name + " = camera " + angleOfCam(c); }).join(", ") + "; keys from " + keys.file.path);
      rec.run = { mode: mode, typed: typed, done: from, track: info.track, startSec: startSec, endSec: endSec, desired: desired, partial: partial };
      saveRecord(seqId, rec);
      // Camera 2 stretches get the label colour; pieces that aren't camera 2 any more get their original label back.
      var ranges = [];
      typed.forEach(function (cut, i) { if (cut.camera === 2) ranges.push([cut.sec, i + 1 < typed.length ? typed[i + 1].sec : endSec]); });
      return typeCuts({ cuts: typed, keys: keys, from: from, label: verb, say: say, step: step,
        onCut: function (n) { var x = mcRecord(seqId); if (x.run) { x.run.done = n; saveRecord(seqId, x); } },
        after: function (sender) {
          return labelCamera2(info.sequenceID, info.track, ranges, { within: [startSec, endSec], color: rec.baseLabel }, sender, step);
        } });
    }).then(function (res) {
      // Done: record it (a build joins the history; an undo removes the build it undid).
      rec = mcRecord(seqId); rec.run = null;
      if (mode === "undo") rec.history.pop();
      else { rec.history.push({ desired: desired, startSec: startSec, endSec: endSec, partial: partial, at: new Date().toISOString() }); if (rec.history.length > 5) rec.history.shift(); }
      saveRecord(seqId, rec);
      renderMcRow();
      return callHostWithin(10000, "countClips", [JSON.stringify({ track: info.track, startSec: startSec, endSec: endSec })]).then(function (c) {
        var want = typed.length, okAll = c.clips >= want;
        return Promise.resolve(res.after)
          .then(function (rose) { return mode === "build" ? markWelcome().then(function () { return rose; }) : rose; })
          .then(function (rose) {
            say((mode === "undo" ? "Undid the last multicam cut on “" + info.name + "”" + (rec.history.length ? " (back to the build before it)" : " (back to the wide)")
              : "Built “" + info.name + "” as multicam") + ": " + res.done + " points in " + Math.round(res.ms / 1000) + " s" + roseNote(rose) + ". " +
              (okAll ? "The multicam track has " + c.clips + " pieces in the range, as expected."
                : "Only " + c.clips + " of " + want + " show on the track: raise Pause (Settings) and run it again."));
            status(okAll ? (mode === "undo" ? "Undo finished." : "Multicam build finished.") : "Finished, but some cuts didn't land.", okAll ? "ok" : "err", 1);
          });
      });
    }, function (e) {
      renderMcRow();
      if (e.done !== undefined && typed) $("mcNote").textContent = e.message + (e.done < typed.length ? " Click Resume to carry on from there." : "");
      throw e;
    });
  });

  /**
   * Load the installed files again without restarting Premiere: re-run the host script (it redefines PD) and
   * reload the panel page. Settings live in localStorage and the Documents folder, so they survive.
   */
  function reloadPanel() {
    if (state.busy) { status("Wait for the current job to finish, then reload.", "err"); return; }
    status("Reloading PodCutter\u2026", "", 0.5);
    if (!inPremiere || !state.extRoot) { location.reload(); return; }
    var jsx = path.join(state.extRoot, "host", "host.jsx").replace(/\\/g, "/");
    cs.evalScript("$.evalFile(new File(" + JSON.stringify(jsx) + "))", function () { location.reload(); });
  }

  // ------------------------------------------------------------ wiring
  function setButtons() {
    var has = !!state.result, b = state.busy;
    $("btnScan").disabled = b;
    $("btnAnalyze").disabled = b || !state.seq;
    $("btnMarkers").disabled = b || !has || !inPremiere;
    $("btnApply").disabled = b || !has || !inPremiere;
    // Cameras on multicam angles: Build as multicam is the build (Build cut on a copy only switches stacked tracks).
    var nest = usesNest();
    $("btnApply").classList.toggle("hidden", nest);
    $("btnBuildMc").classList.toggle("primary", nest);
    $("btnClearMarkers").disabled = b || !inPremiere;
    $("btnExportPlan").disabled = b || !has || !hasNode;
    $("btnBuildMc").disabled = b || !has || !inPremiere;
    $("btnMarkMoves").disabled = b || !has;
    $("btnResumeMc").disabled = b || !inPremiere;
    $("btnUndoMc").disabled = b || !inPremiere;
    if (typeof renderRecut === "function") renderRecut();
    var sel = state.tx.suggestions.some(function (s) { return !state.tx.off[s.id]; });
    $("btnTranscribe").disabled = b || !state.seq;
    $("btnSugMarkers").disabled = b || !sel || !inPremiere;
    $("btnSugClear").disabled = b || !inPremiere;
    $("btnSugCsv").disabled = !sel || !hasNode;
    $("btnSugClaude").disabled = !state.tx.segments;
  }

  var viz = new window.PDViz($("viz"), $("vizScroll"));
  viz.onSeek = seek;
  viz.onSelect = onSelect;
  $("zoomIn").onclick = function () { viz.zoom(0.5); };
  $("zoomOut").onclick = function () { viz.zoom(2); };
  $("zoomFit").onclick = function () { viz.fit(); };
  $("lockClear").onclick = clearSelection;
  $("btnScan").onclick = scan;
  $("btnAnalyze").onclick = analyze;
  $("btnMarkers").onclick = previewMarkers;
  $("btnClearMarkers").onclick = clearCamMarkers;
  $("btnMarkMoves").onclick = markMoves;
  // Two-step confirm inside the panel (native dialogs are unreliable in CEP).
  var armed = null;
  $("btnApply").onclick = function () {
    var b = $("btnApply");
    if (!armed) {
      b.textContent = "Click again to build on a copy";
      status("This duplicates “" + state.seq.name + "” and cuts the copy. Your original stays untouched.", "");
      armed = setTimeout(function () { armed = null; b.textContent = "Build cut on a copy"; }, 4000);
      return;
    }
    clearTimeout(armed); armed = null; b.textContent = "Build cut on a copy";
    applyCut();
  };
  $("btnExportPlan").onclick = exportForClaude;
  $("btnRecut").onclick = recut;
  $("btnUndoRecut").onclick = undoRecut;
  $("btnSavePreset").onclick = savePreset;
  $("setupSelect").onchange = function () { chooseSetup(this.value); };
  $("rangeSelect").onchange = function () {
    state.config.range = this.value; saveConfig(); state.result = null; replan();
    status(curvesReady() ? "Range changed: re-planned." : "Range changed \u2014 click Analyze waveforms.", "", 0);
  };
  $("btnSaveSetup").onclick = saveSetup;
  $("btnDeleteSetup").onclick = deleteSetup;
  $("btnDeleteSetup").innerHTML = TRASH_SVG;
  $("btnAddSpeaker").onclick = function () {
    if (!state.seq) return;
    var n = state.config.speakers.length + 1, id = "S" + Date.now().toString(36);
    var used = state.config.speakers.map(function (x) { return x.audioTrack; });
    var free = voiceTracks(state.seq).filter(function (a) { return used.indexOf(a.index) < 0; })[0];
    state.config.speakers.push({ id: id, name: "Speaker " + n, audioTrack: free ? free.index : 0, channel: null, thresholdDb: null, biasDb: 0, minShotSec: null, interjections: true, reactionShots: true, enabled: true, _open: true });
    renderAll(); changed();
  };
  $("btnAddCamera").onclick = function () {
    if (!state.seq) return;
    state.config.cameras.push({ id: "C" + Date.now().toString(36), name: "Camera " + (state.config.cameras.length + 1), videoTrack: 0, shows: [], enabled: true });
    renderCameras(); changed();
  };
  $("btnTranscribe").onclick = transcribe;
  $("txFile").onchange = function () { if (this.files[0]) loadTranscriptFile(this.files[0]); this.value = ""; };
  $("sugAll").onclick = function () { state.tx.off = {}; renderSuggestions(); refreshVizCleanup(); setButtons(); };
  $("sugNone").onclick = function () { state.tx.suggestions.forEach(function (s) { state.tx.off[s.id] = true; }); renderSuggestions(); refreshVizCleanup(); setButtons(); };
  $("btnSugMarkers").onclick = markCuts;
  $("btnSugClear").onclick = clearCuts;
  $("btnSugCsv").onclick = exportCsv;
  $("btnSugClaude").onclick = copyForClaude;
  $("btnRecheck").onclick = function () {
    store("ffmpegCustom", $("ffmpegCustom").value.trim()); store("modelCustom", $("modelCustom").value.trim());
    checkTools().then(function () { status("Tools re-checked.", "ok"); });
  };
  $("layered").checked = load("layered", true) !== false;
  $("layered").onchange = function () { store("layered", this.checked); renderLayered(); renderCameras(); };
  renderLayered();
  $("txPrompt").onchange = function () { store("txPrompt", $("txPrompt").value.trim()); };
  $("showName").onchange = function () {
    state.cleanupOpts.showName = $("showName").value.trim(); store("showName", state.cleanupOpts.showName); runCleanup();
  };
  $("btnClearCache").onclick = function () { var n = A.clearCache(); state.curves = {}; replan(); status("Cleared " + n + " cached waveforms.", "ok"); };
  $("btnOpenDocs").onclick = function () {
    if (!hasNode) return;
    var cmd = process.platform === "win32" ? "explorer" : "open";
    require("child_process").spawn(cmd, [state.docsDir], { detached: true });
  };
  $("importFile").onchange = function () { if (this.files[0]) importSettings(this.files[0]); this.value = ""; };

  // Follow Premiere's playhead and the sequence's In/Out marks while the panel is idle.
  setInterval(function () {
    if (!inPremiere || state.busy || !state.seq || document.hidden) return;
    callHost("getPlayhead").then(function (r) {
      if (r.sequenceID !== state.seq.sequenceID) return;
      if (state.result && Math.abs((viz.playhead || -1) - r.sec) > 0.05) viz.setPlayhead(r.sec);
      followMarks(r.inSec, r.outSec);
    }).catch(function () { /* sequence closed */ });
  }, 500);

  /**
   * The In/Out marks moved in Premiere: take the new range and re-plan straight away. The waveforms cover the
   * whole sequence, so nothing needs analyzing again.
   */
  function followMarks(inSec, outSec) {
    var q = state.seq, same = function (a, b) { return a === b || (a != null && b != null && Math.abs(a - b) < 0.02); };
    if (same(q.inSec, inSec) && same(q.outSec, outSec)) return;
    q.inSec = inSec; q.outSec = outSec;
    renderRangeSelect();
    var r = currentRange();
    log("In/Out marks moved: " + (r ? fmt(r.a) + "–" + fmt(r.b) : "none (whole sequence)"));
    renderShortWides();
    if (state.result || curvesReady()) {
      debounce("plan", replan, 150);
      status("In/Out moved — re-planned " + (r ? fmt(r.a) + "–" + fmt(r.b) : "the whole sequence") + ".", "ok");
    }
  }

  $("verInstalled").textContent = D.VERSION;
  $("updateFolder").value = load("updateFolder", "");
  $("updateGithub").checked = load("updateGithub", true) !== false;
  $("updateFolder").onchange = function () { store("updateFolder", this.value.trim()); };
  $("updateGithub").onchange = function () { store("updateGithub", this.checked); };
  $("btnCheckUpdates").onclick = function () { checkUpdates(false); };
  $("btnInstallUpdate").onclick = installUpdate;
  $("btnReload").onclick = reloadPanel;
  $("btnKbdTrial").onclick = runKbdTrial;
  $("btnKbdStop").onclick = function () { kbdStop = true; };
  $("btnKbdBannerStop").onclick = function () { kbdStop = true; $("kbdBannerSmall").textContent = "Stopping after this cut…"; };
  $("btnBuildMc").onclick = function () { buildMulticam("build"); };
  $("btnResumeMc").onclick = function () { buildMulticam("resume"); };
  $("btnUndoMc").onclick = function () { buildMulticam("undo"); };
  $("mcInOut").checked = !!load("mcInOut", false);
  $("mcInOut").onchange = function () { store("mcInOut", this.checked); };
  $("rose2").checked = load("rose2", true) !== false;
  $("rose2").onchange = function () { store("rose2", this.checked); renderLabelKey(); };
  (K && K.LABELS ? K.LABELS : ["Rose"]).forEach(function (n, i) { $("labelColor").appendChild(el("option", { value: String(i), text: n })); });
  $("labelColor").value = String(labelColor());
  $("labelColor").onchange = function () { store("labelColor", +this.value); renderLabelKey(); };
  renderKbdKeys();
  renderLabelKey();
  $("btnIntroMarkers").onclick = markNames;
  $("btnIntroClear").onclick = clearNames;
  $("introCut").onchange = function () { state.config.introCut = this.checked; changed(true); };
  $("introHold").onchange = function () { state.config.introHoldSec = Math.max(0, Math.min(60, +this.value || 0)); changed(true); renderIntro(); };
  $("btnReloadBanner").onclick = reloadPanel;
  $("btnUpdateNow").onclick = installUpdate;
  $("btnUpdateLater").onclick = function () {
    if (pending) store("skipVersion", pending.version);
    $("updateBanner").classList.add("hidden");
  };

  // Keep the page content clear of the pinned header (its height changes with the update banner / panel width).
  function fitHeader() {
    var h = document.querySelector(".sticky-head");
    if (h) $("headSpacer").style.height = (h.offsetHeight + 10) + "px";
  }
  window.addEventListener("resize", fitHeader);
  if (window.ResizeObserver) new ResizeObserver(fitHeader).observe(document.querySelector(".sticky-head"));
  setInterval(fitHeader, 1000);

  init();
  fitHeader();
  // Quietly look for updates a few seconds after the panel opens, then every 2 hours while it stays open.
  if (hasNode) {
    setTimeout(function () { checkUpdates(true).catch(function () {}); }, 4000);
    setInterval(function () { if (!pending) checkUpdates(true).catch(function () {}); }, 2 * 3600 * 1000);
  }
})();
