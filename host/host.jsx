/*
 * PodCutter — ExtendScript host (runs inside Premiere Pro).
 *
 * Everything returns a JSON string: { ok: true, ... } or { ok: false, error }.
 * Sequence reading / duplication approach adapted from Podclip (MIT).
 *
 *   PD.ping()
 *   PD.getSequenceInfo()                 tracks, clips, media paths, fps, duration
 *   PD.getPlayhead() / PD.setPlayhead(sec)
 *   PD.addMarkers(json) / PD.clearMarkers(prefix)
 *   PD.duplicateActive(expectedID)       clone + open the copy
 *   PD.razorTrack(json)                  QE-razor one video track at frame numbers
 *   PD.applyEnables(json)                enable exactly one camera track per shot
 */

#target premierepro

if (typeof JSON === "undefined") {
  JSON = {
    parse: function (s) { return eval("(" + s + ")"); },
    stringify: function (v) {
      var t = typeof v;
      if (v === null || t === "undefined") return "null";
      if (t === "number" || t === "boolean") return isFinite(v) || t === "boolean" ? String(v) : "null";
      if (t === "string") return '"' + v.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
      var out = [], k;
      if (v instanceof Array) { for (k = 0; k < v.length; k++) out.push(JSON.stringify(v[k])); return "[" + out.join(",") + "]"; }
      for (k in v) if (v.hasOwnProperty(k) && typeof v[k] !== "function") out.push(JSON.stringify(k) + ":" + JSON.stringify(v[k]));
      return "{" + out.join(",") + "}";
    }
  };
}

var PD = (function () {
  var TPS = 254016000000; // Premiere ticks per second

  function ok(o) { o = o || {}; o.ok = true; return JSON.stringify(o); }
  function fail(msg) { return JSON.stringify({ ok: false, error: String(msg) }); }
  function sec(t) {
    // Track items expose Time objects; sequence.end is a plain tick string.
    return parseFloat(typeof t === "object" && t !== null ? t.ticks : t) / TPS;
  }

  function ping() { return ok({ version: app.version, project: app.project ? app.project.name : null }); }

  function seqOrFail() {
    var seq = app.project && app.project.activeSequence;
    return seq || null;
  }

  function getSequenceInfo() {
    var seq = seqOrFail();
    if (!seq) return fail("Open a sequence first (no active sequence).");
    var tpf = parseFloat(seq.timebase);
    var info = {
      name: seq.name, sequenceID: seq.sequenceID, fps: TPS / tpf, ticksPerFrame: seq.timebase,
      durationSec: sec(seq.end), inSec: null, outSec: null, audioTracks: [], videoTracks: []
    };
    // Sequence In/Out marks (unset marks come back as 0 / the end, or as large negative numbers).
    try {
      var inS = parseFloat(seq.getInPoint()), outS = parseFloat(seq.getOutPoint());
      if (isFinite(inS) && inS > 0.01 && inS < info.durationSec) info.inSec = inS;
      if (isFinite(outS) && outS > 0 && outS < info.durationSec - 0.01 && outS > (info.inSec || 0)) info.outSec = outS;
    } catch (eIO) { /* older Premiere: whole sequence */ }
    var i, j, track, clip, clips, mp, speed;
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      track = seq.audioTracks[i];
      clips = [];
      for (j = 0; j < track.clips.numItems; j++) {
        clip = track.clips[j];
        mp = null; speed = 1;
        try { mp = clip.projectItem ? clip.projectItem.getMediaPath() : null; } catch (e1) { mp = null; }
        try { if (typeof clip.getSpeed === "function") speed = clip.getSpeed(); } catch (e2) { speed = 1; }
        clips.push({ name: clip.name, startSec: sec(clip.start), endSec: sec(clip.end),
          inPointSec: sec(clip.inPoint), mediaPath: mp, speed: speed });
      }
      var muted = false;
      try { muted = track.isMuted(); } catch (e3) { muted = false; }
      info.audioTracks.push({ index: i, name: track.name || ("A" + (i + 1)), muted: muted, clips: clips });
    }
    for (i = 0; i < seq.videoTracks.numTracks; i++) {
      track = seq.videoTracks[i];
      var first = null, n = track.clips.numItems, endMax = 0, media = [], seen = {}, vclips = [];
      for (j = 0; j < n; j++) {
        clip = track.clips[j];
        if (!first) first = clip.name;
        endMax = Math.max(endMax, sec(clip.end));
        mp = null; speed = 1;
        try {
          mp = clip.projectItem ? clip.projectItem.getMediaPath() : null;
          if (mp && !seen[mp] && media.length < 50) { seen[mp] = true; media.push(mp); }
        } catch (e4) { /* graphics, nested sequences */ }
        try { if (typeof clip.getSpeed === "function") speed = clip.getSpeed(); } catch (e5) { speed = 1; }
        // Clip list for camera-motion analysis (capped: camera tracks rarely have more).
        if (vclips.length < 400) vclips.push({ startSec: sec(clip.start), endSec: sec(clip.end), inPointSec: sec(clip.inPoint), mediaPath: mp, speed: speed });
      }
      var hidden = false;
      try { hidden = track.isMuted(); } catch (e6) { hidden = false; } // a video track's "mute" is its eye (track output)
      info.videoTracks.push({ index: i, name: track.name || ("V" + (i + 1)), clipCount: n, firstClip: first, endSec: endMax, mediaPaths: media, clips: vclips, hidden: hidden,
        nest: readNest(track) });
    }
    return ok(info);
  }

  /** The sequence a nested (or multicam) clip plays, or null. */
  function nestedSequenceOf(clip) {
    var pi = clip.projectItem, isSeq = false;
    try { isSeq = !!(pi && pi.isSequence && pi.isSequence()); } catch (e) { isSeq = false; }
    if (!isSeq) return null;
    for (var s = 0; s < app.project.sequences.numSequences; s++) {
      var q = app.project.sequences[s];
      try { if (q.projectItem && q.projectItem.nodeId === pi.nodeId) return q; } catch (e2) { /* keep looking */ }
    }
    return null;
  }

  /**
   * A video track holding a nested (multicam) sequence: the cameras inside it, mapped onto this sequence's
   * timeline, so they can be analyzed as if they were stacked here. Each video track of the nest is an angle
   * (V1 = angle 1). Uses the nest that covers most of the track; null when there isn't one.
   * -> { sequenceID, name, multicam, angles: [{ angle, name, clips: [{ startSec, endSec, inPointSec, mediaPath, speed }] }] }
   */
  function readNest(track) {
    var groups = {}, best = null;
    for (var j = 0; j < track.clips.numItems; j++) {
      var clip = track.clips[j], inner = nestedSequenceOf(clip);
      if (!inner) continue;
      var g = groups[inner.sequenceID];
      if (!g) {
        var mc = false;
        try { mc = !!(clip.projectItem.isMulticamClip && clip.projectItem.isMulticamClip()); } catch (e) { mc = false; }
        g = groups[inner.sequenceID] = { seq: inner, multicam: mc, windows: [], covered: 0 };
      }
      // Outer [start, end) plays the nest from inPoint on.
      g.windows.push({ s: sec(clip.start), e: sec(clip.end), inner: sec(clip.inPoint) });
      g.covered += sec(clip.end) - sec(clip.start);
    }
    for (var id in groups) if (groups.hasOwnProperty(id) && (!best || groups[id].covered > best.covered)) best = groups[id];
    if (!best) return null;
    var angles = [];
    for (var v = 0; v < best.seq.videoTracks.numTracks; v++) {
      var vt = best.seq.videoTracks[v], mapped = [], angleName = vt.name || ("V" + (v + 1)), nestName = null;
      for (var w = 0; w < best.windows.length; w++) {
        var win = best.windows[w];
        // Outer time = win.s + (inner time − win.inner), over the window's span of the nest.
        nestName = mediaPieces([vt], win.inner, win.inner + (win.e - win.s), win.s - win.inner, mapped, 0) || nestName;
      }
      if (!mapped.length) continue;
      // An angle that is itself a nest (David's 244_a_cam / 244_b_cam, as PodGrip builds them) is named after it.
      if (nestName) angleName = nestName;
      mapped.sort(function (x, y) { return x.startSec - y.startSec; });
      // Pieces split by cuts on the outer track are one continuous clip again for analysis.
      var merged = [mapped[0]];
      for (var k = 1; k < mapped.length; k++) {
        var p = merged[merged.length - 1], m = mapped[k];
        if (m.mediaPath === p.mediaPath && Math.abs(m.startSec - p.endSec) < 0.02 &&
            Math.abs(m.inPointSec - (p.inPointSec + (p.endSec - p.startSec) * p.speed)) < 0.05) p.endSec = m.endSec;
        else merged.push(m);
      }
      angles.push({ angle: v + 1, name: angleName, clips: merged.slice(0, 2000) });
    }
    return angles.length ? { sequenceID: best.seq.sequenceID, name: best.seq.name, multicam: best.multicam, angles: angles } : null;
  }

  /**
   * The media clips the given tracks play between inner times [from, to), following nested sequences down (an
   * angle that is a per-camera nest holding the camera clips), pushed onto out in outer time (inner + shift).
   * Returns the name of the first nest it went into, or null.
   */
  function mediaPieces(tracks, from, to, shift, out, depth) {
    var nestName = null;
    for (var t = 0; t < tracks.length; t++) {
      var tr = tracks[t];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var ic = tr.clips[c], icS = sec(ic.start), icE = sec(ic.end), a = Math.max(icS, from), b = Math.min(icE, to);
        if (b <= a) continue;
        var mp = null, speed = 1;
        try { mp = ic.projectItem ? ic.projectItem.getMediaPath() : null; } catch (e3) { mp = null; }
        try { if (typeof ic.getSpeed === "function") speed = ic.getSpeed(); } catch (e4) { speed = 1; }
        if (mp) {
          out.push({ startSec: a + shift, endSec: b + shift, inPointSec: sec(ic.inPoint) + (a - icS) * speed, mediaPath: mp, speed: speed });
          continue;
        }
        var inner = depth < 3 ? nestedSequenceOf(ic) : null;
        if (!inner) continue;
        if (!nestName) nestName = inner.name;
        // This clip plays the nest from its inPoint: inner-nest time = ic.inPoint + (t − icS).
        var nin = sec(ic.inPoint), sub = [];
        for (var k = 0; k < inner.videoTracks.numTracks; k++) sub.push(inner.videoTracks[k]);
        mediaPieces(sub, nin + (a - icS), nin + (b - icS), shift + icS - nin, out, depth + 1);
      }
    }
    return nestName;
  }

  /** The sequence's In/Out marks in seconds; null when a mark isn't set (Premiere reads unset marks as 0 / the end). */
  function marksOf(seq) {
    var m = { inSec: null, outSec: null };
    try {
      var inS = parseFloat(seq.getInPoint()), outS = parseFloat(seq.getOutPoint()), endS = sec(seq.end);
      if (isFinite(inS) && inS > 0.01 && inS < endS) m.inSec = inS;
      if (isFinite(outS) && outS > 0 && outS < endS - 0.01 && outS > (m.inSec || 0)) m.outSec = outS;
    } catch (e) { /* older Premiere: no marks */ }
    return m;
  }

  /** Playhead and In/Out marks of the active sequence (polled by the panel to follow both live). */
  function getPlayhead() {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var m = marksOf(seq);
    return ok({ sec: sec(seq.getPlayerPosition()), sequenceID: seq.sequenceID, inSec: m.inSec, outSec: m.outSec });
  }

  /**
   * Move the playhead. snap: land exactly on the start of the nearest frame (in the sequence's own ticks), which
   * Cut to Camera needs to hit an existing edit point: a time rounded to the millisecond can fall a hair before
   * the edit at 23.976 fps, and then Premiere cuts a one-frame sliver off the piece before instead.
   */
  function setPlayhead(s, snap) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var ticks = Math.round(Number(s) * TPS), tpf = parseFloat(seq.timebase);
    if (snap && tpf > 0) ticks = Math.round(Math.round(ticks / tpf) * tpf);
    seq.setPlayerPosition(String(ticks));
    return ok({ ticks: String(ticks) });
  }

  /** json: { inSec?, outSec? } -> sets the active sequence's In and/or Out point. */
  function setInOut(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var o = JSON.parse(json);
    function put(fn, v) {
      try { seq[fn](Number(v)); return; } catch (e) { /* older versions want a string or a Time */ }
      try { seq[fn](String(v)); return; } catch (e2) { /* fall through */ }
      var t = new Time(); t.seconds = Number(v); seq[fn](t);
    }
    try {
      if (o.inSec !== undefined && o.inSec !== null) put("setInPoint", o.inSec);
      if (o.outSec !== undefined && o.outSec !== null) put("setOutPoint", o.outSec);
    } catch (e3) { return fail("Couldn't set In/Out: " + e3); }
    return ok({ inSec: parseFloat(seq.getInPoint()), outSec: parseFloat(seq.getOutPoint()) });
  }

  /** json: { prefix, markers: [{ startSec, endSec?, name, comment, color }] }  color = 0..7 */
  function addMarkers(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json), n = 0;
    for (var i = 0; i < p.markers.length; i++) {
      var m = p.markers[i];
      var mk = seq.markers.createMarker(m.startSec);
      mk.name = (p.prefix || "") + (m.name || "");
      if (m.comment) mk.comments = m.comment;
      if (m.endSec && m.endSec > m.startSec) mk.end = m.endSec;
      try { if (typeof mk.setColorByIndex === "function") mk.setColorByIndex(m.color || 0); } catch (e) { /* older versions */ }
      n++;
    }
    return ok({ added: n });
  }

  function clearMarkers(prefix) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var removed = 0, doomed = [];
    var mk = seq.markers.getFirstMarker();
    while (mk) {
      if (mk.name && mk.name.indexOf(prefix) === 0) doomed.push(mk);
      mk = seq.markers.getNextMarker(mk);
    }
    for (var i = 0; i < doomed.length; i++) { seq.markers.deleteMarker(doomed[i]); removed++; }
    return ok({ removed: removed });
  }

  function seqIDs() {
    var ids = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) ids[app.project.sequences[i].sequenceID] = true;
    return ids;
  }

  function duplicateActive(expectedID, suffix) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    if (expectedID && seq.sequenceID !== expectedID) return fail("The analyzed sequence is no longer active. Re-scan the sequence you want to cut.");
    try {
      app.enableQE();
      var q = qe.project.getActiveSequence();
      var qt = q && q.getVideoTrackAt(0);
      if (!qt || typeof qt.razor !== "function") return fail("This Premiere version does not expose the razor tool to scripts. Nothing was changed.");
    } catch (eq) { return fail("Premiere's QE scripting layer is unavailable: " + eq); }
    var before = seqIDs();
    try { seq.clone(); } catch (e) { return fail("Could not duplicate the sequence: " + e); }
    var copy = null;
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (!before[s.sequenceID]) { copy = s; break; }
    }
    if (!copy) return fail("Premiere did not create the duplicate.");
    try { copy.name = seq.name + (suffix || " - PodCutter"); } catch (en) { /* name is cosmetic */ }
    app.project.openSequence(copy.sequenceID);
    return ok({ sequenceID: copy.sequenceID, name: copy.name, originalName: seq.name });
  }

  function timecodeFor(seq, frame) {
    var t = new Time();
    t.ticks = String(Math.round(frame * parseFloat(seq.timebase)));
    try {
      var st = seq.getSettings();
      return t.getFormatted(st.videoFrameRate, st.videoDisplayFormat);
    } catch (e) {
      // Fallback: non-drop timecode from frame count.
      var fps = Math.round(TPS / parseFloat(seq.timebase));
      var ff = frame % fps, ts = Math.floor(frame / fps);
      function p2(n) { return n < 10 ? "0" + n : "" + n; }
      return p2(Math.floor(ts / 3600)) + ":" + p2(Math.floor(ts / 60) % 60) + ":" + p2(ts % 60) + ":" + p2(ff);
    }
  }

  /** json: { sequenceID, track, frames: [..] } — razor one video track at each frame. */
  function razorTrack(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Refusing to edit: the PodCutter copy is not the active sequence.");
    app.enableQE();
    var q = qe.project.getActiveSequence();
    var qt = q.getVideoTrackAt(p.track);
    if (!qt) return fail("Video track V" + (p.track + 1) + " not found.");
    var vt = seq.videoTracks[p.track];
    // Only razor where a clip actually spans the cut (avoids QE errors in gaps).
    var spans = [];
    for (var c = 0; c < vt.clips.numItems; c++) {
      spans.push([parseFloat(vt.clips[c].start.ticks), parseFloat(vt.clips[c].end.ticks)]);
    }
    var tpf = parseFloat(seq.timebase), n = 0, skipped = 0;
    for (var i = 0; i < p.frames.length; i++) {
      var tk = p.frames[i] * tpf, inside = false;
      for (var s = 0; s < spans.length; s++) if (tk > spans[s][0] + tpf / 2 && tk < spans[s][1] - tpf / 2) { inside = true; break; }
      if (!inside) { skipped++; continue; }
      try { qt.razor(timecodeFor(seq, p.frames[i])); n++; } catch (e) { skipped++; }
    }
    return ok({ razored: n, skipped: skipped });
  }

  /** json: { sequenceID, tracks: [{track, segments:[{startFrame,endFrame,enabled}]}] }
   *  or (older payloads) { sequenceID, cameraTracks: [..], shots: [{startFrame,endFrame,videoTrack}] } */
  function applyEnables(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Refusing to edit: the PodCutter copy is not the active sequence.");
    var tpf = parseFloat(seq.timebase), shots = p.shots, toggled = 0;
    function shotAt(frame) {
      var lo = 0, hi = shots.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (shots[mid].endFrame <= frame) lo = mid + 1;
        else if (shots[mid].startFrame > frame) hi = mid - 1;
        else return shots[mid];
      }
      return null;
    }
    // Per-track stretches (layered edits: the bottom camera stays enabled, cameras above switch on and off).
    if (p.tracks) {
      for (var k = 0; k < p.tracks.length; k++) {
        var tr = p.tracks[k], vt2 = seq.videoTracks[tr.track], sg = tr.segments;
        if (!vt2) continue;
        for (var c2 = 0; c2 < vt2.clips.numItems; c2++) {
          var clip2 = vt2.clips[c2];
          var f = Math.floor((parseFloat(clip2.start.ticks) + parseFloat(clip2.end.ticks)) / 2 / tpf), seg = null;
          for (var lo = 0, hi = sg.length - 1; lo <= hi;) {
            var m = (lo + hi) >> 1;
            if (sg[m].endFrame <= f) lo = m + 1; else if (sg[m].startFrame > f) hi = m - 1; else { seg = sg[m]; break; }
          }
          if (!seg) continue;
          try { if (clip2.disabled !== !seg.enabled) { clip2.disabled = !seg.enabled; toggled++; } } catch (e6) { /* not toggleable */ }
        }
      }
      return ok({ toggled: toggled });
    }
    for (var t = 0; t < p.cameraTracks.length; t++) {
      var idx = p.cameraTracks[t], vt = seq.videoTracks[idx];
      if (!vt) continue;
      for (var c = 0; c < vt.clips.numItems; c++) {
        var clip = vt.clips[c];
        var mid = (parseFloat(clip.start.ticks) + parseFloat(clip.end.ticks)) / 2 / tpf;
        var shot = shotAt(Math.floor(mid));
        if (!shot) continue;
        var want = shot.videoTrack === idx;
        try { if (clip.disabled !== !want) { clip.disabled = !want; toggled++; } } catch (e) { /* not toggleable */ }
      }
    }
    return ok({ toggled: toggled });
  }

  /**
   * For the keystroke trial: is there a multicam clip under the playhead in the active sequence? A multicam
   * source sequence counts; so does a nested sequence (Multi-Camera > Enable can't be read from scripts, so
   * the panel asks the user to check it). Multicam clips win over nests.
   * -> { sequenceID, name, playheadSec, fps, multicam: { track, name, startSec, endSec, multicam: bool } | null }
   */
  function multicamAtPlayhead() {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var at = sec(seq.getPlayerPosition()), found = null, nest = null;
    for (var i = 0; i < seq.videoTracks.numTracks && !found; i++) {
      var vt = seq.videoTracks[i];
      for (var c = 0; c < vt.clips.numItems; c++) {
        var clip = vt.clips[c];
        if (sec(clip.start) > at || sec(clip.end) <= at) continue;
        var mc = false, isSeq = false;
        try { mc = !!(clip.projectItem && clip.projectItem.isMulticamClip && clip.projectItem.isMulticamClip()); } catch (e) { mc = false; }
        try { isSeq = !!(clip.projectItem && clip.projectItem.isSequence && clip.projectItem.isSequence()); } catch (e3) { isSeq = false; }
        var hit = { track: i, name: clip.name, startSec: sec(clip.start), endSec: sec(clip.end), multicam: mc };
        if (mc) { found = hit; break; }
        if (isSeq && !nest) nest = hit;
      }
    }
    if (!found) found = nest;
    var fps = 30;
    try { fps = Math.round(TPS / parseFloat(seq.timebase) * 1000) / 1000; } catch (e2) { fps = 30; }
    return ok({ sequenceID: seq.sequenceID, name: seq.name, playheadSec: at, fps: fps, multicam: found });
  }

  /**
   * For Build as multicam: the multicam (or nested) clips on one track that together cover [startSec, endSec].
   * Picks the track with the most multicam/nest coverage of the range; a real multicam source wins over a nest.
   * json: { startSec, endSec } -> { sequenceID, name, fps, track, multicam, coveredSec, gaps: [[a,b]], clips }
   */
  function multicamCovering(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json), best = null;
    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      var vt = seq.videoTracks[i], covered = 0, mcAll = true, spans = [], n = 0;
      for (var c = 0; c < vt.clips.numItems; c++) {
        var clip = vt.clips[c], a = sec(clip.start), b = sec(clip.end);
        if (b <= p.startSec || a >= p.endSec) continue;
        var mc = false, isSeq = false;
        try { mc = !!(clip.projectItem && clip.projectItem.isMulticamClip && clip.projectItem.isMulticamClip()); } catch (e) { mc = false; }
        try { isSeq = !!(clip.projectItem && clip.projectItem.isSequence && clip.projectItem.isSequence()); } catch (e2) { isSeq = false; }
        if (!mc && !isSeq) continue;
        if (!mc) mcAll = false;
        n++;
        spans.push([Math.max(a, p.startSec), Math.min(b, p.endSec)]);
        covered += Math.min(b, p.endSec) - Math.max(a, p.startSec);
      }
      if (!n) continue;
      if (!best || covered > best.coveredSec + 0.01 || (Math.abs(covered - best.coveredSec) <= 0.01 && mcAll && !best.multicam)) {
        var gaps = [], at = p.startSec;
        spans.sort(function (x, y) { return x[0] - y[0]; });
        for (var s = 0; s < spans.length; s++) { if (spans[s][0] > at + 0.05) gaps.push([at, spans[s][0]]); at = Math.max(at, spans[s][1]); }
        if (at < p.endSec - 0.05) gaps.push([at, p.endSec]);
        best = { track: i, multicam: mcAll, coveredSec: covered, gaps: gaps, clips: n };
      }
    }
    var fps = 30;
    try { fps = Math.round(TPS / parseFloat(seq.timebase) * 1000) / 1000; } catch (e3) { fps = 30; }
    // The sequence's own In/Out marks, for building only part of it.
    var mk = marksOf(seq);
    var r = { sequenceID: seq.sequenceID, name: seq.name, fps: fps, inSec: mk.inSec, outSec: mk.outSec };
    if (best) for (var k in best) if (best.hasOwnProperty(k)) r[k] = best[k];
    return ok(r);
  }

  /**
   * json: { sequenceID, track, ranges: [[startSec, endSec]], color } — set the label colour (Premiere's label index,
   * e.g. 6 = Rose) of the clips on a video track whose middle falls in one of the ranges. Only the timeline clips
   * change, never the source in the project (every piece of a multicam nest shares one).
   * -> { colored, unsupported }
   */
  function colorClips(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Refusing to edit: the built sequence is not the active sequence.");
    var vt = seq.videoTracks[p.track], n = 0;
    if (!vt) return fail("Video track V" + (p.track + 1) + " not found.");
    var r = p.ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
    // otherColor (optional): pieces inside [within[0], within[1]) but not in a range go back to this label.
    var hasOther = p.otherColor !== undefined && p.otherColor !== null && p.within;
    for (var c = 0; c < vt.clips.numItems; c++) {
      var clip = vt.clips[c], mid = (sec(clip.start) + sec(clip.end)) / 2, hit = false;
      for (var k = 0; k < r.length && r[k][0] <= mid; k++) if (mid < r[k][1]) { hit = true; break; }
      var want = hit ? p.color : (hasOther && mid >= p.within[0] && mid < p.within[1] ? p.otherColor : null);
      if (want === null) continue;
      if (typeof clip.setColorLabel !== "function") return ok({ colored: n, unsupported: true });
      try { clip.setColorLabel(want); if (hit) n++; } catch (e) { return ok({ colored: n, unsupported: true, error: String(e) }); }
    }
    return ok({ colored: n, unsupported: false });
  }

  /**
   * json: { sequenceID, track, ranges, within?, invert? } -> { selected, unsupported }: select just the pieces on a
   * track whose middle is in a range (invert: the pieces inside within that aren't), so the panel can press a
   * Label shortcut on them. Everything else in the sequence is deselected; empty ranges just clear the selection.
   */
  function selectClips(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Refusing to edit: the built sequence is not the active sequence.");
    var vt = seq.videoTracks[p.track], n = 0, kinds = [seq.videoTracks, seq.audioTracks];
    if (!vt) return fail("Video track V" + (p.track + 1) + " not found.");
    try {
      for (var g = 0; g < kinds.length; g++) for (var t = 0; t < kinds[g].numTracks; t++) {
        var cl = kinds[g][t].clips;
        for (var c = 0; c < cl.numItems; c++) if (cl[c].isSelected && cl[c].isSelected()) cl[c].setSelected(false, true);
      }
      var r = p.ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
      for (var i = 0; i < vt.clips.numItems; i++) {
        var clip = vt.clips[i], mid = (sec(clip.start) + sec(clip.end)) / 2, hit = false;
        for (var k = 0; k < r.length && r[k][0] <= mid; k++) if (mid < r[k][1]) { hit = true; break; }
        if (p.invert) hit = !hit && mid >= p.within[0] && mid < p.within[1];
        if (hit) { clip.setSelected(true, true); n++; }
      }
    } catch (e) { return ok({ selected: n, unsupported: true, error: String(e) }); }
    return ok({ selected: n, unsupported: false });
  }

  /** json: { track, startSec, endSec } -> { clips }: how many pieces a track has inside a range (after cutting). */
  function countClips(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json), vt = seq.videoTracks[p.track], n = 0, starts = [], label = null;
    if (!vt) return fail("Video track V" + (p.track + 1) + " not found.");
    for (var c = 0; c < vt.clips.numItems; c++) {
      var a = sec(vt.clips[c].start), b = sec(vt.clips[c].end);
      if (b > p.startSec + 0.02 && a < p.endSec - 0.02) {
        n++; starts.push(a); // starts: the existing edit points (for a recut)
        if (label === null) { try { if (typeof vt.clips[c].getColorLabel === "function") label = vt.clips[c].getColorLabel(); } catch (e) { label = null; } }
      }
    }
    return ok({ clips: n, starts: starts, firstLabel: label });
  }

  /** json: { sequenceID, tracks: [index] } — turn track output (the eye) on for these video tracks. */
  function showTracks(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Refusing to edit: the PodCutter copy is not the active sequence.");
    var shown = [];
    for (var i = 0; i < p.tracks.length; i++) {
      var vt = seq.videoTracks[p.tracks[i]];
      if (!vt) continue;
      try { if (vt.isMuted()) { vt.setMute(0); shown.push(p.tracks[i]); } } catch (e) { /* older Premiere: leave it */ }
    }
    return ok({ shown: shown });
  }

  /**
   * json: { sequenceID, track, startSec, endSec } — put a multicam clip back the way it was before Cut to Camera:
   * runs of through-edits in the range (pieces that touch, share the multicam source and carry on in it without a
   * jump) become one clip again: the later pieces are removed and the first is lengthened over them. Real cuts
   * (content removed, a gap, another clip) stay. Audio tracks carrying the same multicam get the same.
   * -> { joined: pieces removed, pieces: what's left in the range on the video track, starts: [sec] of those }
   */
  function restoreMulticam(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Open the multicam sequence that was built first.");
    var vt = seq.videoTracks[p.track];
    if (!vt) return fail("Video track V" + (p.track + 1) + " not found.");
    var tol = parseFloat(seq.timebase) / TPS / 2;
    function idOf(it) { try { return it.projectItem ? it.projectItem.nodeId : null; } catch (e) { return null; } }
    function piecesOf(tr, id) {
      var out = [];
      for (var c = 0; c < tr.clips.numItems; c++) {
        var it = tr.clips[c], a = sec(it.start), b = sec(it.end);
        if (a < p.startSec - tol || b > p.endSec + tol) continue;
        if (id !== undefined && idOf(it) !== id) continue;
        out.push({ item: it, a: a, b: b, inS: sec(it.inPoint), id: idOf(it) });
      }
      out.sort(function (x, y) { return x.a - y.a; });
      return out;
    }
    function join(tr, id) {
      var ps = piecesOf(tr, id), removed = 0;
      var groups = [], g = null;
      for (var i = 0; i < ps.length; i++) {
        var pr = g ? g[g.length - 1] : null, cur = ps[i];
        var through = pr && cur.id !== null && cur.id === pr.id && Math.abs(cur.a - pr.b) < tol &&
          Math.abs((cur.inS - pr.inS) - (pr.b - pr.a)) < tol;
        if (through) g.push(cur); else { g = [cur]; groups.push(g); }
      }
      // Last run first, and within a run last piece first, so nothing shifts under the pieces still to do.
      for (var k = groups.length - 1; k >= 0; k--) {
        var run = groups[k];
        if (run.length < 2) continue;
        var endT = new Time(); endT.ticks = run[run.length - 1].item.end.ticks;
        for (var j = run.length - 1; j >= 1; j--) { run[j].item.remove(false, false); removed++; }
        run[0].item.end = endT;
        if (Math.abs(sec(run[0].item.end) - sec(endT)) > tol) {
          return { error: "Premiere wouldn't lengthen the clip at " + run[0].a.toFixed(2) + " s back over the pieces removed after it: check the timeline there (Edit > Undo may put them back)." };
        }
      }
      return { removed: removed };
    }
    var v = join(vt);
    if (v.error) return fail(v.error);
    // The same multicam on audio tracks (its sound, cut along with the picture): under each joined clip, the
    // pieces of the same source at the same offset become one again, whether removing the picture took its
    // linked sound with it or not.
    var vp = piecesOf(vt), audioJoined = 0;
    for (var i = 0; i < vp.length; i++) {
      if (vp[i].id === null) continue;
      for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        var ap = piecesOf(seq.audioTracks[t], vp[i].id), mine = [];
        for (var k2 = 0; k2 < ap.length; k2++) {
          if (ap[k2].a >= vp[i].a - tol && ap[k2].b <= vp[i].b + tol && Math.abs((ap[k2].inS - ap[k2].a) - (vp[i].inS - vp[i].a)) < tol) mine.push(ap[k2]);
        }
        if (!mine.length || Math.abs(mine[0].a - vp[i].a) > tol) continue;
        for (var r = mine.length - 1; r >= 1; r--) { mine[r].item.remove(false, false); audioJoined++; }
        if (Math.abs(mine[0].b - vp[i].b) > tol) { var ae = new Time(); ae.ticks = vp[i].item.end.ticks; mine[0].item.end = ae; }
      }
    }
    var left = piecesOf(vt), starts = [];
    for (var s = 0; s < left.length; s++) starts.push(left[s].a);
    return ok({ joined: v.removed, audioJoined: audioJoined, pieces: left.length, starts: starts });
  }

  /** Open a sequence by ID (used to recut an earlier PodCutter copy). */
  function openSequenceById(id) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (s.sequenceID === id) {
        app.project.openSequence(id);
        return ok({ sequenceID: id, name: s.name });
      }
    }
    return fail("That PodCutter copy no longer exists in this project.");
  }

  /** Is there a sequence with this ID in the open project? (A remembered copy may have been deleted.) */
  function sequenceExists(id) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) if (app.project.sequences[i].sequenceID === id) return ok({ exists: true });
    return ok({ exists: false });
  }

  return { ping: ping, getSequenceInfo: getSequenceInfo, getPlayhead: getPlayhead, setPlayhead: setPlayhead,
           addMarkers: addMarkers, clearMarkers: clearMarkers, duplicateActive: duplicateActive,
           razorTrack: razorTrack, applyEnables: applyEnables, showTracks: showTracks, multicamAtPlayhead: multicamAtPlayhead,
           multicamCovering: multicamCovering, countClips: countClips, colorClips: colorClips, selectClips: selectClips, openSequenceById: openSequenceById, sequenceExists: sequenceExists, restoreMulticam: restoreMulticam, setInOut: setInOut };
})();
