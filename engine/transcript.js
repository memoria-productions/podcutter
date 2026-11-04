/*
 * PodCutter — transcript analyzer.
 *
 * An edit review of the conversation. Major cuts: production breakdowns (the
 * hosts talking about the show instead of the topic, from the first signal to
 * the clean restart, with passages worth keeping), producer and internal talk,
 * spoken edit cues ("cut that", "we'll fix it in post"), off-the-record
 * stretches, pre- and post-show chat. Smaller trims: restarts, false starts,
 * dead handoffs, self-corrections, interruptions. Each suggestion carries a
 * confidence, the reason and the join (the lines either side of the cut), for
 * review in the panel or by Claude.
 *
 * Inputs: SRT, WebVTT, Premiere transcript .txt (timecoded blocks), or Whisper
 * JSON (segments, optional word timestamps). Pure JS, no dependencies.
 */
(function (root, factory) {
  // CEP panels with Node enabled define both window and module: export to both.
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodTranscript = api;
  else if (root) root.PodTranscript = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------- parsing

  var TC = /(\d{1,2}):(\d{2}):(\d{2})(?:([.,])(\d{1,3})|[:;](\d{2}))?/;
  var TC_G = new RegExp(TC.source, "g");

  function tcToSec(m, fps) {
    var h = +m[1], mi = +m[2], s = +m[3];
    var frac = 0;
    if (m[5] !== undefined) frac = parseFloat("0." + m[5]);
    else if (m[6] !== undefined) frac = (+m[6]) / (fps || 30);
    return h * 3600 + mi * 60 + s + frac;
  }

  /** Parse transcript text in any supported format. Returns [{startSec,endSec,speaker,text,words?}] */
  function parse(text, opts) {
    opts = opts || {};
    var fps = opts.fps || 30;
    text = String(text || "").replace(/^﻿/, "");
    var trimmed = text.trim();
    if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") return parseJson(JSON.parse(trimmed));

    var lines = text.split(/\r?\n/);
    var segs = [];
    var cur = null;
    function flush() {
      if (cur && cur.text.trim()) {
        cur.text = cur.text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        var sp = /^\s*(?:\[([^\]]{1,40})\]|([A-Z][\w .'-]{0,30}?)\s*:)\s+/.exec(cur.text);
        if (!cur.speaker && sp) { cur.speaker = (sp[1] || sp[2]).trim(); cur.text = cur.text.slice(sp[0].length); }
        if (/^>>\s*/.test(cur.text)) cur.text = cur.text.replace(/^>>\s*/, "");
        segs.push(cur);
      }
      cur = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^WEBVTT/.test(line) || /^NOTE\b/.test(line)) continue;
      var tcs = [];
      var m;
      TC_G.lastIndex = 0;
      while ((m = TC_G.exec(line)) !== null) tcs.push(m);
      var isTimeLine = tcs.length >= 1 && line.replace(TC_G, "").replace(/-->|-|–|\s|\[|\]|\(|\)/g, "").length === 0;
      if (isTimeLine) {
        flush();
        var start = tcToSec(tcs[0], fps);
        cur = { startSec: start, endSec: tcs[1] ? tcToSec(tcs[1], fps) : null, speaker: null, text: "" };
        continue;
      }
      if (!cur) continue;
      if (/^\d+$/.test(line.trim()) && !cur.text) continue; // SRT index
      if (!line.trim()) { if (cur.text) flush(); continue; }
      // Premiere .txt puts the speaker name alone on the line after the timecode.
      if (!cur.text && !cur.speaker && /^(Speaker \d+|[A-Z][\w .'-]{0,30})$/.test(line.trim()) && lines[i + 1] && lines[i + 1].trim()) {
        cur.speaker = line.trim();
        continue;
      }
      cur.text += (cur.text ? " " : "") + line.trim();
    }
    flush();
    // Fill missing end times from the next segment.
    for (var k = 0; k < segs.length; k++) {
      if (segs[k].endSec === null || segs[k].endSec <= segs[k].startSec) {
        segs[k].endSec = segs[k + 1] ? segs[k + 1].startSec : segs[k].startSec + estimateDuration(segs[k].text);
      }
    }
    segs.forEach(function (sg) { if (isSound(sg.text)) sg.sound = true; });
    return segs.sort(function (a, b) { return a.startSec - b.startSec; });
  }

  /** Whisper and caption files mark non-speech sounds as [phone ringing], (laughs), *buzzing*. */
  function isSound(text) { return /^\s*[\[(*][^\])*]{1,60}[\])*]\s*$/.test(text || ""); }

  function estimateDuration(text) { return Math.max(1, text.split(/\s+/).length / 2.7); }

  function parseJson(obj) {
    var segs = obj.segments || obj.transcription || obj.results || obj;
    if (!Array.isArray(segs)) throw new Error("Unrecognized transcript JSON.");
    return segs.map(function (s) {
      var start = num(s.start, s.startSec, s.offsets && s.offsets.from / 1000, s.timestamps && parseTs(s.timestamps.from));
      var end = num(s.end, s.endSec, s.offsets && s.offsets.to / 1000, s.timestamps && parseTs(s.timestamps.to));
      var words = (s.words || []).map(function (w) {
        return { startSec: num(w.start, w.startSec), endSec: num(w.end, w.endSec), text: String(w.word || w.text || "").trim() };
      });
      var text = String(s.text || "").trim();
      return { startSec: start, endSec: end, speaker: s.speaker || null, text: text, words: words.length ? words : undefined, sound: isSound(text) || undefined };
    }).filter(function (s) { return isFinite(s.startSec) && s.text; });
  }
  function parseTs(t) { var m = TC.exec(t || ""); return m ? tcToSec(m) : NaN; }
  function num() {
    for (var i = 0; i < arguments.length; i++) { var v = Number(arguments[i]); if (arguments[i] !== undefined && arguments[i] !== null && isFinite(v)) return v; }
    return NaN;
  }

  // --------------------------------------------------------------- cues

  // weight: how sure we are this phrase means "remove something".
  // scope: "before" = the mistake precedes the cue, "after" = what follows is off-limits.
  var CUES = [
    // Explicit edit instructions
    { re: /\b(cut|edit|strike|delete|remove|chop|trim)\s+(that|this|all that|all of that|that part|this part|that bit|this bit|that section|that one)\b/, type: "edit-cue", weight: 0.95, scope: "before" },
    { re: /\b(cut|edit|take|leave|keep|chop|trim|bleep)\s+(it|that|this|all that|that part|this part|that bit|this bit)\s+out\b/, type: "edit-cue", weight: 0.95, scope: "before" },
    { re: /\b(we('ll| will| can| should| gotta|'re gonna| are going to)|you can|can (we|you)|please|gonna|going to)\s+(cut|edit|trim|chop)\b/, type: "edit-cue", weight: 0.85, scope: "before" },
    { re: /\b(fix|clean|sort|deal with) (it|that|this) (up )?in post\b|\bin post\b/, type: "edit-cue", weight: 0.75, scope: "before" },
    { re: /\b(scratch|strike|disregard|ignore) (that|this|all that)\b/, type: "edit-cue", weight: 0.9, scope: "before" },
    { re: /\b(don't|do not|can't|cannot) (use|include|air|publish) (that|this|it)\b/, type: "edit-cue", weight: 0.9, scope: "before" },
    { re: /\b(don't|do not|can't|cannot) put (that|this|it) (on (the )?air|in (the )?(show|episode|podcast|edit))\b/, type: "edit-cue", weight: 0.9, scope: "before" },
    // A bare "cut." addressed to the editor ("So David, cut."), checked on the raw text so punctuation counts.
    { raw: /(?:^|[.!?]\s+)(?:(?:so|and|okay|ok|alright|all right)\s*,?\s*)?(?:[A-Z][a-z]+,\s*)?cut(?:\s+(?:it|there|here))?\s*[.!]?\s*$/i, type: "edit-cue", weight: 0.8, scope: "before" },
    { raw: /(?:^|[.!?]\s+)(?:(?:so|and|okay|ok|alright|all right)\s*,?\s*)?(?:[A-Z][a-z]+,\s*)?cut(?:\s+(?:it|there|here))?\s*[.!]/i, type: "edit-cue", weight: 0.75, scope: "before" },
    { re: /\b(bleep|beep) (that|this|it)( out)?\b/, type: "bleep", weight: 0.8, scope: "before" },
    { re: /\bthat('s| is| was) (not|n't) going in\b|\bnot for (the )?(episode|show|podcast|air|broadcast)\b/, type: "edit-cue", weight: 0.85, scope: "before" },
    // Restarts / retakes
    { re: /\b(let me|lemme|i('ll| will| need to| wanna| want to)|can i|should i|let's|lets) (start|begin|try|do|say|go|take) (that|this|it)? ?(over|again|one more time|from the top|from the beginning)\b/, type: "restart", weight: 0.9, scope: "before" },
    { re: /\b(start|begin)(ing)? (over|again)\b|\bfrom the top\b|\btake (two|2|three|3)\b|\bone more time\b/, type: "restart", weight: 0.8, scope: "before" },
    { re: /\b(let me|lemme|can i|i('ll| will| need to| wanna)) (redo|re-do|rephrase|reword|rerecord|re-record|restart|re-start) (that|this|it)?\b/, type: "restart", weight: 0.9, scope: "before" },
    { re: /\b(let me|lemme) (back up|go back)\b|\bthat came out wrong\b|\bi (messed|screwed|botched|flubbed) (that|it) up\b|\bi flubbed\b/, type: "restart", weight: 0.7, scope: "before" },
    { re: /\b(pick ?up|pickup) (from|at) \b/, type: "restart", weight: 0.6, scope: "before" },
    // Off the record
    { re: /\boff the record\b|\bbetween (us|you and me)\b|\bdon't (record|air) this\b|\bthis is(n't| not) (for|going on) (the )?(record|air|show|episode)\b/, type: "off-record", weight: 0.85, scope: "after" },
    // Interruptions: phones, alarms, someone at the door (whole interruption gets cut, not just the words)
    { re: /\b(silence|silencing|mute|muting|turn(ing)? off|switch(ing)? off|shut(ting)? off|turn(ing)? down|put(ting)?|stop(ping)?|decline|declining|ignore|ignoring|get(ting)? rid of)\b[^.?!]{0,24}\b(phone|cell ?phone|cell|ringer|alarm|timer|watch|notifications?|ringtone)\b/, type: "interruption", weight: 0.85, scope: "interruption" },
    { re: /\b(phone|cell ?phone|cell|alarm|timer|watch|ringtone)\b[^.?!]{0,20}\b(ring|rings|ringing|rang|going off|goes off|went off|buzz|buzzes|buzzing|beep|beeps|beeping|vibrat\w*|blowing up|on silent|on mute|on do not disturb|on airplane mode)\b/, type: "interruption", weight: 0.8, scope: "interruption" },
    { re: /\b(that'?s|that is|it'?s|sorry,? (that'?s|my|about (my|the)))\s*(my|his|her|your|the|someone'?s)?\s*(phone|alarm|timer|cell)\b/, type: "interruption", weight: 0.75, scope: "interruption" },
    { re: /\b(phone|ringing|ringtone|buzzing|beeping|alarm|knock(ing)?|doorbell|notification)\b/, type: "interruption", weight: 0.7, scope: "interruption", soundOnly: true },
    { re: /\b(put(ting)? (it|this|that|my phone|the phone|mine) (in|on) |turn(ing)? on )?(airplane mode|do not disturb)\b/, type: "interruption", weight: 0.7, scope: "interruption" },
    { re: /\b(someone'?s|somebody'?s) at the door\b|\bi (have|need) to (take|get) this\b|\b(let me|i'?ll|lemme) (just )?(get|grab|take) (that|this)\b/, type: "interruption", weight: 0.65, scope: "interruption" },
    // Weak signals: technical interruptions
    { re: /\b(hold on|hang on|wait wait|one sec(ond)?|give me a (sec|second|minute))\b/, type: "interruption", weight: 0.45, scope: "around" },
    { re: /\b(where was i|lost my (train of thought|place)|what was i saying)\b/, type: "interruption", weight: 0.55, scope: "before" },
    { re: /\b(is (it|this|the mic|the camera|everything) (still )?(recording|rolling|on)|are we (still )?(recording|rolling)|we('re| are) (back|rolling|recording)( again)?|(mic|camera|audio) (check|died|dropped|cut out))\b/, type: "technical", weight: 0.6, scope: "around" }
  ];
  var BACK_ON = /\b(back on the record|on the record (again|now)|ok(ay)? we('re| are) back|we('re| are) back)\b/;

  function normalize(text) {
    return String(text).toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function words(text) { return normalize(text).split(" ").filter(Boolean); }
  var FILLER = { um: 1, uh: 1, uhm: 1, er: 1, ah: 1, like: 1, so: 1, well: 1, okay: 1, ok: 1, and: 1, but: 1, yeah: 1, i: 0 };
  function contentWords(text) { return words(text).filter(function (w) { return !FILLER[w]; }); }

  // ------------------------------------------------------------ analysis

  var DEFAULTS = {
    pauseSec: 1.2,          // a gap this long marks where a botched passage most likely began
    maxLookbackSec: 40,     // never reach further back than this from a cue
    minLookbackSec: 2.0,    // always take at least this much before a cue
    padSec: 0.15,           // breathing room around suggested ranges
    falseStartWords: 3,     // matching opening words needed to call a restart
    falseStartWindowSec: 25,
    minConfidence: 0.4,
    offRecordMaxSec: 600,
    backChainSec: 45,       // after a cut cue, "okay, we're back" must come within this of the last cut/back phrase
    backMaxSec: 240,        // and within this of the first cue
    showName: "",           // the welcome address names the show ("welcome to Classical et cetera"): the show starts there
    breakdownGapSec: 180,   // talk about the show this close together is one breakdown
    restartWindowSec: 150,  // look this far past a breakdown's last meta line for the clean restart
    keepMinSec: 20,         // an on-topic stretch inside a breakdown at least this long is worth keeping (surgical option)
    names: []               // people on mic (first names are enough): a question addressed to one of them is a restart or a handoff
  };

  /**
   * analyze(segments, opts) -> { suggestions: [...], segments }
   * Each suggestion: { id, startSec, endSec, type, confidence, reason, trigger, text, speaker }
   */
  function analyze(segments, opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (opts || {})) if (opts[k] !== undefined) o[k] = opts[k];
    var segs = (segments || []).slice().sort(function (a, b) { return a.startSec - b.startSec; });
    var out = [];

    segs.forEach(function (sg, i) {
      var norm = normalize(sg.text);
      for (var c = 0; c < CUES.length; c++) {
        var cue = CUES[c];
        if (cue.soundOnly && !sg.sound) continue;
        var m = cue.raw ? cue.raw.exec(sg.text) : cue.re.exec(norm);
        if (!m) continue;
        var cueTime = cue.raw ? cueTimeInSegment(sg, Math.round(m.index / Math.max(1, sg.text.length) * norm.length), norm.length)
          : cueTimeInSegment(sg, m.index, norm.length);
        var sug;
        if (cue.scope === "after") sug = offRecordRange(segs, i, cueTime, o);
        else if (cue.scope === "around") sug = aroundRange(segs, i, cueTime);
        else if (cue.scope === "interruption") sug = interruptionRange(segs, i, o);
        else sug = beforeRange(segs, i, cueTime, o);
        sug.type = cue.type;
        sug.trigger = m[0];
        sug.confidence = cue.weight;
        // Phrases at the very end of a segment (a pause follows) are more likely real instructions.
        if (m.index + m[0].length >= norm.length - 3) sug.confidence = Math.min(1, sug.confidence + 0.05);
        // "cut" said mid-story ("they cut the budget") is filtered by the regexes; questions lower confidence.
        if (/\?\s*$/.test(sg.text) && cue.type === "edit-cue") sug.confidence -= 0.1;
        sug.speaker = sg.speaker || null;
        sug.reason = describe(cue.type, m[0].replace(/^[.!?\s]+/, "").trim());
        // "Let's cut this part" often starts a tangent they abandon: run on to where they say they're back.
        if (cue.type === "edit-cue") {
          var back = returnPoint(segs, i, cueTime.start, o);
          if (back && back.endSec > sug.endSec) {
            sug.endSec = back.endSec; sug.review = "both"; sug.confidence += 0.03;
            sug.reason += " \u2026 back at: \u201c" + back.trigger + "\u201d";
          }
        }
        out.push(sug);
        break; // one cue per segment is enough
      }
    });

    falseStarts(segs, o).forEach(function (s) { out.push(s); });
    showEdges(segs, o).forEach(function (s) { out.push(s); });
    deadHandoffs(segs, o).forEach(function (s) { out.push(s); });
    selfCorrections(segs, o).forEach(function (s) { out.push(s); });

    var small = mergeSuggestions(out.filter(function (s) { return s.confidence >= o.minConfidence; }));
    // Breakdowns stand apart: what they swallow is listed inside them; leaks inside them stay cut even when
    // the editor keeps the good passages.
    var big = breakdowns(segs, o).filter(function (b) { return b.confidence >= o.minConfidence; });
    var leaks = leakLines(segs, o);
    big.forEach(function (b) {
      b.leaks = leaks.filter(function (l) { return l.startSec >= b.startSec - 1 && l.endSec <= b.endSec + 1; });
      b.keeps = b.keeps.map(function (k) {
        // A leak splits a keep: never keep a leak line.
        var pieces = [[k.startSec, k.endSec]];
        b.leaks.forEach(function (l) {
          pieces = pieces.reduce(function (acc, pc) {
            if (l.endSec <= pc[0] || l.startSec >= pc[1]) acc.push(pc);
            else {
              if (l.startSec - pc[0] >= o.keepMinSec) acc.push([pc[0], l.startSec]);
              if (pc[1] - l.endSec >= o.keepMinSec) acc.push([l.endSec, pc[1]]);
            }
            return acc;
          }, []);
        });
        return pieces.map(function (pc) { return { startSec: round2(pc[0]), endSec: round2(pc[1]), text: clip(sentenceText(segs, pc[0], pc[1]), 120) }; });
      }).reduce(function (a, x) { return a.concat(x); }, []);
      var longest = b.keeps.slice().sort(function (x, y) { return (y.endSec - y.startSec) - (x.endSec - x.startSec); }).slice(0, 2);
      b.keeps.forEach(function (k, i) { k.id = b.type + "-keep" + i; k.on = longest.indexOf(k) >= 0; });
    });
    var inBig = function (s) { return big.some(function (b) { return s.startSec >= b.startSec - 1 && s.endSec <= b.endSec + 1; }); };
    var merged = small.filter(function (s) { return !inBig(s); })
      .concat(leaks.filter(function (l) { return !inBig(l) && l.confidence >= o.minConfidence; }))
      .concat(big)
      .sort(function (a, b) { return a.startSec - b.startSec; });
    var all = sentenceStream(segs, 0, 0);
    merged.forEach(function (s, idx) {
      s.id = "cut" + (idx + 1);
      s.startSec = Math.max(0, round2(s.startSec - o.padSec));
      s.endSec = round2(s.endSec + o.padSec);
      s.confidence = round2(Math.max(0, Math.min(1, s.confidence)));
      s.text = textBetween(segs, s.startSec, s.endSec);
      s.tier = tierOf(s);
      // Test the join: the last line before the cut and the first line after it should read as one conversation.
      var before = null, after = null;
      all.forEach(function (st) {
        if (st.endSec <= s.startSec + 0.3) before = st;
        else if (!after && st.startSec >= s.endSec - 0.3) after = st;
      });
      s.joinBefore = before ? clip(before.text, 110, true) : null;
      s.joinAfter = after ? clip(after.text, 110) : null;
    });
    return { suggestions: merged, segments: segs, notes: coldOpen(segs, o) };
  }

  /** major: never air it (breakdowns, leaks, pre/post-show, long asked-for cuts); trim: tidy-ups. */
  function tierOf(s) {
    if (/^(breakdown|leak|pre-show|post-show|off-record)$/.test(s.type)) return "major";
    if (s.type === "edit-cue" && s.endSec - s.startSec > 20) return "major";
    return "trim";
  }
  function clip(t, n, tail) {
    t = String(t || "").trim();
    if (t.length <= n) return t;
    return tail ? "\u2026" + t.slice(t.length - n).replace(/^\S*\s/, "") : t.slice(0, n).replace(/\s\S*$/, "") + "\u2026";
  }

  function cueTimeInSegment(sg, charIndex, len) {
    if (sg.words && sg.words.length) {
      // Find the word whose cumulative character position covers charIndex.
      var pos = 0;
      for (var w = 0; w < sg.words.length; w++) {
        pos += normalize(sg.words[w].text).length + 1;
        if (pos > charIndex) return { start: sg.words[w].startSec, end: sg.words[Math.min(sg.words.length - 1, w + 3)].endSec };
      }
    }
    var frac = len ? charIndex / len : 0;
    var t = sg.startSec + (sg.endSec - sg.startSec) * frac;
    return { start: t, end: sg.endSec };
  }

  /**
   * The mistake comes before the cue: reach back sentence by sentence to the last real pause, a change of
   * speaker, or the show's opening/sign-off line. Usually that's a sentence or two (about 8 s); when the cue
   * calls out a whole stretch ("cut this part, it's going everywhere") it may reach back maxLookbackSec.
   */
  var TANGENT = /\b(this|that|the) (whole )?(part|section|stretch|conversation|discussion|tangent|segment)\b|\bgoing (everywhere|all over)\b|\btangent\b|\brabbit (trail|hole)\b|\boff (topic|track)\b/;
  function beforeRange(segs, i, cueTime, o) {
    var list = [];
    for (var k = 0; k <= i; k++) sentences(segs[k]).forEach(function (st) { list.push({ st: st, seg: segs[k] }); });
    var c = list.length - 1;
    while (c > 0 && list[c].st.startSec > cueTime.start + 0.01) c--;
    var cueSt = list[c].st, sg = segs[i];
    var near = cueSt.norm + " " + ((list[c + 1] && list[c + 1].st.norm) || "") + " " + (sentenceStream(segs, i, cueSt.endSec)[0] || { norm: "" }).norm;
    var limit = TANGENT.test(near) ? o.maxLookbackSec : o.minLookbackSec * 4;
    var cueAtStart = cueTime.start - cueSt.startSec < 0.6;
    var start = cueSt.startSec, taken = 0;
    for (var j = c - 1; j >= 0; j--) {
      var prev = list[j], next = list[j + 1];
      if (next.st.startSec - prev.st.endSec >= o.pauseSec) break;
      if (prev.seg.speaker && sg.speaker && prev.seg.speaker !== sg.speaker && prev.seg.speaker !== "Unknown") break;
      if (INTRO.test(prev.st.norm) || OUTRO.test(prev.st.norm)) break;
      if (cueTime.start - prev.st.startSec > limit && !(cueAtStart && taken === 0)) break;
      start = prev.st.startSec; taken++;
    }
    if (cueTime.start - start < o.minLookbackSec && taken === 0 && c > 0 &&
        !INTRO.test(list[c - 1].st.norm) && !OUTRO.test(list[c - 1].st.norm)) start = Math.max(list[c - 1].st.startSec, cueTime.start - o.minLookbackSec);
    var end = Math.max(cueTime.end, cueSt.endSec);
    if (sg.words || sg.endSec - sg.startSec <= 8) end = Math.max(end, sg.endSec);
    return { startSec: start, endSec: end, review: "start" };
  }

  function offRecordRange(segs, i, cueTime, o) {
    var start = segs[i].startSec;
    var end = segs[i].endSec;
    for (var j = i + 1; j < segs.length; j++) {
      if (segs[j].startSec - start > o.offRecordMaxSec) break;
      end = segs[j].endSec;
      if (BACK_ON.test(normalize(segs[j].text))) break;
      if (j + 1 < segs.length && segs[j + 1].startSec - segs[j].endSec > 3) break;
    }
    return { startSec: start, endSec: end, review: "end" };
  }

  /**
   * An interruption (phone, alarm, door): from where the conversation broke off (the last real pause, at most
   * ~10 s back) to where it resumes, swallowing the short "sorry / okay / where were we" lines that follow.
   */
  var RESUME = /^(sorry|okay|ok|alright|all right|anyway|so|where (were|was) (we|i)|go ahead|carry on|continue|we'?re (good|back)|done|got it|there we go|that'?s better|yeah|um|uh)\b/;
  function interruptionRange(segs, i, o) {
    var sg = segs[i], start = sg.startSec, j = i;
    while (j > 0 && sg.startSec - segs[j - 1].startSec <= 10 && segs[j].startSec - segs[j - 1].endSec < o.pauseSec &&
           (segs[j - 1].sound || words(segs[j - 1].text).length <= 6)) { j--; start = segs[j].startSec; }
    var end = sg.endSec;
    for (var k = i + 1; k < segs.length && segs[k].startSec - sg.endSec <= 25; k++) {
      var t = normalize(segs[k].text);
      var n = words(segs[k].text).length;
      // Short "okay, sorry" lines belong to the interruption; a resumption with real content ("Anyway, the Aeneid...") doesn't.
      if (segs[k].sound || (n <= 4 && RESUME.test(t)) || (n <= 10 && /phone|alarm|silent|ringer|sorry about that/.test(t))) end = segs[k].endSec;
      else break;
    }
    return { startSec: start, endSec: end, review: "both" };
  }

  /** Just the sentence the cue is in (long transcript blocks hold many sentences and often several speakers). */
  function aroundRange(segs, i, cueTime) {
    var sg = segs[i];
    if (sg.endSec - sg.startSec <= 8 || !cueTime) return { startSec: sg.startSec, endSec: sg.endSec, review: "both" };
    var hit = null;
    sentences(sg).forEach(function (st) { if (!hit && st.endSec > cueTime.start + 0.01) hit = st; });
    hit = hit || { startSec: sg.startSec, endSec: sg.endSec };
    return { startSec: hit.startSec, endSec: hit.endSec, review: "both" };
  }

  // -------------------------------------------------- sentence timing

  /**
   * Sentences of a segment with estimated times. Uses word timestamps when present, otherwise spreads the
   * segment's time over its words (Premiere's transcript export gives one timecode per ~20 s block).
   */
  function sentences(sg) {
    if (sg._sentences) return sg._sentences;
    var parts = String(sg.text).match(/[^.!?]+[.!?]*/g) || [sg.text];
    var total = 0;
    parts.forEach(function (p) { total += words(p).length; });
    total = total || 1;
    var dur = sg.endSec - sg.startSec, acc = 0, out = [];
    var W = sg.words && sg.words.length ? sg.words : null;
    parts.forEach(function (p) {
      var n = words(p).length;
      if (!n) return;
      var a, b;
      if (W) {
        a = W[Math.min(W.length - 1, Math.round(acc * W.length / total))].startSec;
        b = W[Math.min(W.length - 1, Math.round((acc + n) * W.length / total) - 1)].endSec;
      } else { a = sg.startSec + dur * acc / total; b = sg.startSec + dur * (acc + n) / total; }
      acc += n;
      out.push({ text: p.trim(), norm: normalize(p), n: n, startSec: a, endSec: Math.max(a, b) });
    });
    Object.defineProperty ? Object.defineProperty(sg, "_sentences", { value: out, enumerable: false, configurable: true }) : (sg._sentences = out);
    return out;
  }
  function sentenceStream(segs, from, fromSec) {
    var list = [];
    for (var i = from; i < segs.length; i++) sentences(segs[i]).forEach(function (st) { if (st.startSec >= fromSec - 0.01) list.push(st); });
    return list;
  }

  // "Okay, bring it back", "get us back on track", "okay, we're back": the tangent is over.
  var BACK = /\b(bring(ing)? (it|us|this) back|back on track|get(ting)? (us|it|this) back|let'?s go back( now)?$|let'?s get back|ok(ay)? we'?re back|we'?re back( now)?$|where were we|back to (the|our) (topic|question|list|show|episode|conversation)|let'?s (move|keep) (on|going) (from|past) (that|this))\b/;
  var OFF_RECORD = /\boff the record\b|\bdon't (record|air) this\b/;
  var CUT_AGAIN = /\b(cut|edit|strike|delete|remove|chop|trim)\s+(it|that|this)\b|\bnot (going )?in the (show|episode)\b/;

  /**
   * After a cut cue, look ahead for where they come back. Each cut/back phrase must come within backChainSec of
   * the last one; the cut ends after the last "we're back" sentence and any one- to three-word lines right after it.
   */
  function returnPoint(segs, i, fromSec, o) {
    var list = sentenceStream(segs, i, fromSec), last = fromSec, found = null;
    for (var k = 0; k < list.length; k++) {
      var st = list[k];
      if (st.startSec - last > o.backChainSec || st.startSec - fromSec > o.backMaxSec) break;
      if (OFF_RECORD.test(st.norm)) break; // a separate off-the-record stretch has its own "we're back"

      if (BACK.test(st.norm)) { found = { endSec: st.endSec, trigger: st.text.replace(/[.!?]+$/, ""), k: k }; last = st.startSec; }
      else if (CUT_AGAIN.test(st.norm)) last = st.startSec;
    }
    if (!found) return null;
    for (var j = found.k + 1; j < list.length && list[j].n <= 3 && list[j].startSec - found.endSec < 2; j++) found.endSec = list[j].endSec;
    return found;
  }

  // ----------------------------------------------- pre- and post-show

  var INTRO = /\b((hello|hi|hey|good (morning|afternoon|evening))( everyone| everybody| all| folks)?( and)? welcome\b|welcome (back )?to (another|the|this|our|today'?s|episode|part|season)\b)/;
  var NOT_INTRO = /\b(you'?re|you are|are|be|is|always|more than) welcome\b/;
  /** "et cetera", "etcetera", "etc." all read the same, so a show name matches however the transcriber spelled it. */
  function showKey(t) { return normalize(t).replace(/\bet ?cetera\b|\betc\b/g, "etc").replace(/\s+/g, " ").trim(); }
  function isIntro(st, o) {
    var t = showKey(st.norm);
    if (o.showName && t.indexOf("welcome") >= 0 && t.indexOf(showKey(o.showName)) >= 0) return "show";
    return INTRO.test(st.norm) && !NOT_INTRO.test(st.norm) ? "generic" : null;
  }
  var OUTRO = /\b(thank(s| you)( all| everyone| everybody| so much)? for (joining|listening|watching)|(we'?ll|we will) (see|be back|talk to)( with)?( you| y'?all)? (next time|next week|soon)|see you next (time|week)|until next time)\b/;

  /** Chatter before the opening line and after the sign-off. */
  function showEdges(segs, o) {
    var res = [];
    if (!segs.length) return res;
    var endT = segs[segs.length - 1].endSec, all = sentenceStream(segs, 0, 0);
    // The welcome address with the show's name wins; otherwise the first generic "hello and welcome to the…".
    var intro = null;
    for (var k = 0; k < all.length && all[k].startSec < endT * 0.35; k++) {
      var kind = all[k].startSec > 30 ? isIntro(all[k], o) : null;
      if (kind === "show") { intro = all[k]; intro.kind = kind; break; }
      if (kind === "generic" && !intro) { intro = all[k]; intro.kind = kind; }
    }
    if (intro) {
      // Start the show at the greeting that leads into the welcome ("Hello and welcome…" may be its own sentence).
      var idx = all.indexOf(intro), from = intro;
      if (idx > 0 && all[idx - 1].n <= 3 && /^(hello|hi|hey|good (morning|afternoon|evening)|welcome)\b/.test(all[idx - 1].norm)) from = all[idx - 1];
      res.push({ startSec: segs[0].startSec, endSec: Math.max(segs[0].startSec, from.startSec - o.padSec * 2), type: "pre-show",
        confidence: intro.kind === "show" ? 0.85 : 0.7, review: "end", showStartSec: from.startSec,
        trigger: intro.text, reason: "Before the welcome: \u201c" + intro.text.slice(0, 60) + "\u201d" });
    }
    for (k = all.length - 1; k >= 0 && all[k].startSec > endT * 0.7; k--) {
      if (!OUTRO.test(all[k].norm)) continue;
      // The run of talk after the sign-off, up to the next real gap in the recording.
      var tail = [], prevEnd = all[k].endSec;
      for (var j = k + 1; j < all.length; j++) {
        if (all[j].startSec - prevEnd > 3) break;
        tail.push(all[j]); prevEnd = all[j].endSec;
      }
      var n = 0; tail.forEach(function (t) { n += t.n; });
      if (!tail.length || tail.some(function (t) { return OUTRO.test(t.norm); }) || n > 60 || prevEnd - all[k].endSec > 40) continue;
      res.push({ startSec: all[k].endSec, endSec: prevEnd, type: "post-show", showEndSec: all[k].endSec, confidence: 0.65, review: "start",
        trigger: all[k].text, reason: "After the sign-off: \u201c" + all[k].text.slice(0, 40) + "\u201d" });
      break;
    }
    return res;
  }

  // ------------------------------------------- production breakdowns

  // Talk about the show instead of the topic. A breakdown is one stretch with a clear start (the first of these)
  // and a clean restart (the host asking a question again with its full context).
  var META = [
    { kind: "regroup", w: 0.85, re: /\b(take|have|call) a time ?out\b|\blost the plot\b|\bland (this|the|that) plane\b|\b(gotta|got to|got a|have to|need to) land (somewhere|on something|this|that)\b|\bdon'?t (even )?know where we'?re (at|going)\b|\b(get|getting|bring|bringing) (us |it |this |things )?back on track\b|\blet'?s (regroup|reset|refocus)\b|\bwe'?re (all over the place|going (around )?in circles|rambling)\b|\bwhat are we even (talking about|doing)\b|\bthis (isn'?t|is not) (working|going anywhere)\b/ },
    { kind: "regroup", w: 0.6, re: /\b(synthesize|pull together|tie together) (all )?(the things|what|everything) we'?ve (talked about|said)\b|\bsuch a tangle\b/ },
    { kind: "audience", w: 0.7, re: /\b(average|normal|regular|typical) (person|listener|viewer|parent|homeschooler|mom|reader)s?\b[^.?!]{0,40}\b(no idea|no clue|confused|lost|won'?t (know|understand|follow)|doesn'?t (know|understand|follow)|don'?t (know|understand|follow))\b|\b(people|listeners|viewers|our audience|the audience)\b[^.?!]{0,25}\b(going to|gonna|will|would) be (so |really |very )?(confused|lost)\b|\bno (idea|clue) what we'?re (talking about|saying)\b/ },
    { kind: "audience", w: 0.5, re: /\b(the )?average (person|listener|viewer|bear|joe|reader|homeschooler)\b|\bpeople are (going to|gonna) (come away|walk away)\b/ },
    { kind: "recording", w: 0.75, re: /\bare we (still )?(recording|rolling)( again)?\b|\bis (this|it|everything) (still )?(recording|rolling)\b|\bstill rolling\b|\b(we|you|they|he|she|[a-z]+) can (just )?(cut|edit) (that|this|it)( out)?\b|\buse (whatever|what) ?(is|'?s) (useful|usable|good|helpful)\b|\b(take|pull|use|grab) (pieces|bits|parts|clips|snippets) (from|of|out of)\b/ },
    { kind: "restart", w: 0.6, re: /\b(let me|lemme|let'?s) (start|try|do) (that|this|it)? ?(over|again)\b|\bstart over\b|\bfrom the top\b|\blet me (re ?ask|rephrase|reframe) (that|the question|this)\b/ },
    { kind: "restart", w: 0.5, re: /\b(we'?ll|let'?s|we can|we'?re going to) (just )*(continue|keep going|carry on|pick (it )?(back )?up)\b/ }
  ];
  // Business that shouldn't air even inside a passage worth keeping: producer asks and internal projects.
  var LEAK = [
    { kind: "agenda", w: 0.8, raw: /\b[A-Z][a-z]+ (really |very much |definitely |specifically )?wants (me|us) to (talk|mention|plug|bring up|say|cover)\b/ },
    { kind: "agenda", w: 0.75, re: /\b(i'?ve got to|i have to|i need to|i'?m supposed to|we'?re supposed to|i gotta|i got to)\b[^.?!]{0,60}\bbefore (we|the (episode|show)) (end|ends|wrap|close|finish)/ },
    { kind: "internal", w: 0.75, re: /\b(that'?s|it'?s) not (something|anything) (that )?we need to (discuss|talk about|get into)\b|\b(i haven'?t|i have not|i'?ve not) been following (what'?s (been )?going on|what is going on|what has been going on|the progress)\b|\b(we'?ll|let'?s|we can) (talk|discuss|deal with) (about )?(that|this|it) (later|offline|afterwards|after the (show|episode)|off (air|mic))\b/ }
  ];
  var APOLOGY = /^(sorry|i'?m sorry|my bad|go ahead|no,? you go|you go( ahead)?|no no|wait)\b/;
  var RESTART_OPEN = /^(okay|ok|alright|all right|so|well|now)\b/;

  /**
   * Sentences with the segment each came from. Whisper breaks segments mid-sentence ("That's not something we
   * need to" | "discuss."), so a fragment without closing punctuation runs on into the next segment.
   */
  function sentenceList(segs) {
    var list = [];
    segs.forEach(function (sg) {
      sentences(sg).forEach(function (st) {
        var p = list[list.length - 1];
        if (p && p.seg !== sg && !/[.!?]["”']?\s*$/.test(p.st.text) && st.startSec - p.st.endSec < 1.5 && p.st.n + st.n <= 80) {
          var text = p.st.text + " " + st.text;
          p.st = { text: text, norm: normalize(text), n: p.st.n + st.n, startSec: p.st.startSec, endSec: st.endSec };
        } else list.push({ st: st, seg: sg });
      });
    });
    return list;
  }
  function metaOf(item, cues) {
    for (var c = 0; c < cues.length; c++) {
      var cue = cues[c], m = cue.raw ? cue.raw.exec(item.st.text) : cue.re.exec(item.st.norm);
      if (m) return { kind: cue.kind, w: cue.w, phrase: m[0] };
    }
    return null;
  }
  function isCrosstalk(item) { return item.st.n <= 3 || APOLOGY.test(item.st.norm); }
  function namesRe(o) {
    var n = (o.names || []).map(function (x) { return String(x).split(/\s+/)[0].replace(/[^A-Za-z'\-]/g, ""); }).filter(function (x) { return x.length > 1; });
    return n.length ? new RegExp("\\b(" + n.join("|") + ")\\b", "i") : null;
  }

  function breakdowns(segs, o) {
    var list = sentenceList(segs), hits = [];
    list.forEach(function (it, i) {
      var m = metaOf(it, META) || metaOf(it, LEAK);
      if (m) hits.push({ i: i, m: m });
    });
    // Hits close together form one stretch.
    var clusters = [], cur = null;
    hits.forEach(function (h) {
      if (cur && list[h.i].st.startSec - list[cur[cur.length - 1].i].st.endSec <= o.breakdownGapSec) cur.push(h);
      else { cur = [h]; clusters.push(cur); }
    });
    var res = [], nameRe = namesRe(o);
    clusters.forEach(function (cl) {
      var first = cl[0].i, last = cl[cl.length - 1].i;
      var kinds = {}; cl.forEach(function (h) { kinds[h.m.kind] = 1; });
      var cross = 0;
      for (var k = first; k <= Math.min(list.length - 1, last + 6); k++) if (isCrosstalk(list[k])) cross++;
      var score = cl.reduce(function (a, h) { return a + h.m.w; }, 0) + 0.15 * (Object.keys(kinds).length - 1) + Math.min(0.6, 0.05 * cross);
      // One strong "we've lost the plot" with a burst of crosstalk counts; otherwise it takes two signals.
      var ok = (cl.length >= 2 && score >= 1.4) || (kinds.regroup && cross >= 4);
      if (!ok) return;
      // Start: the first meta line, pulled back over the crosstalk just before it.
      var s = first;
      while (s > 0 && isCrosstalk(list[s - 1]) && list[first].st.startSec - list[s - 1].st.startSec <= 10) s--;
      // End: the first clean, self-contained restart after the last meta line.
      var lastEnd = list[last].st.endSec, restart = null;
      for (var r = last + 1; r < list.length && list[r].st.startSec - lastEnd <= o.restartWindowSec; r++) {
        var it = list[r];
        if (metaOf(it, META) || metaOf(it, LEAK) || isCrosstalk(it)) continue;
        var q = /\?\s*$/.test(it.st.text), addressed = nameRe && nameRe.test(it.st.text);
        var nextQ = list[r + 1] && /\?\s*$/.test(list[r + 1].st.text) && list[r + 1].st.startSec - it.st.endSec < 2;
        if ((q && it.st.n >= 8) || (RESTART_OPEN.test(it.st.norm) && it.st.n >= 10 && (q || nextQ || addressed))) { restart = it; break; }
      }
      var endSec = restart ? restart.st.startSec : lastEnd, e = last;
      if (!restart) while (e + 1 < list.length && isCrosstalk(list[e + 1]) && list[e + 1].st.startSec - list[e].st.endSec < 3) { e++; endSec = list[e].st.endSec; }
      var startSec = list[s].st.startSec;
      // Passages inside worth keeping: long on-topic runs with no meta talk or crosstalk.
      var keeps = [], run = null, endIdx = restart ? list.indexOf(restart) - 1 : e;
      for (var j = s; j <= endIdx; j++) {
        var bad = metaOf(list[j], META) || metaOf(list[j], LEAK) || APOLOGY.test(list[j].st.norm);
        if (!bad && run && list[j].st.n <= 3) continue; // "Right." "Yeah." inside a passage: keep going
        bad = bad || isCrosstalk(list[j]);
        if (!bad && run && list[j].st.startSec - run.endSec < 2.5) run.endSec = list[j].st.endSec;
        else if (!bad) run = { startSec: list[j].st.startSec, endSec: list[j].st.endSec };
        else run = null;
        if (run && run.endSec - run.startSec >= o.keepMinSec && keeps.indexOf(run) < 0) keeps.push(run);
      }
      res.push({
        startSec: startSec, endSec: endSec, type: "breakdown", review: "both",
        confidence: Math.min(0.95, 0.5 + 0.08 * cl.length + 0.12 * (Object.keys(kinds).length - 1) + Math.min(0.15, 0.02 * cross) + (restart ? 0.05 : 0)),
        trigger: cl[0].m.phrase, speaker: list[first].seg.speaker || null,
        reason: "Production breakdown: “" + clip(list[first].st.text, 70) + "”",
        timeline: cl.map(function (h) { return { sec: round2(list[h.i].st.startSec), kind: h.m.kind, text: clip(list[h.i].st.text, 90) }; }),
        crosstalk: cross,
        restart: restart ? { sec: round2(restart.st.startSec), text: clip(restart.st.text, 120) } : null,
        keeps: keeps,
        elsewhere: topicElsewhere(list, startSec, endSec)
      });
    });
    // Two breakdowns that touch are one.
    return res.reduce(function (acc, b) {
      var p = acc[acc.length - 1];
      if (p && b.startSec <= p.endSec + 5) {
        p.endSec = Math.max(p.endSec, b.endSec); p.timeline = p.timeline.concat(b.timeline); p.keeps = p.keeps.concat(b.keeps);
        p.restart = b.restart || p.restart; p.confidence = Math.max(p.confidence, b.confidence); p.crosstalk += b.crosstalk;
      } else acc.push(b);
      return acc;
    }, []);
  }

  /** Producer asks and internal business, one line each. */
  function leakLines(segs, o) {
    return sentenceList(segs).map(function (it) {
      var m = metaOf(it, LEAK);
      return m ? { startSec: it.st.startSec, endSec: it.st.endSec, type: "leak", confidence: m.w, review: "both", trigger: m.phrase,
        speaker: it.seg.speaker || null, reason: (m.kind === "agenda" ? "Producer / agenda talk" : "Internal business") + ": “" + clip(it.st.text, 80) + "”" } : null;
    }).filter(Boolean);
  }

  // Words that say nothing about the topic, for finding where a dropped subject comes up again.
  var STOP = {};
  ("the a an and or but so of to in on at for with from by about as is are was were be been being it its it's this that these those there " +
   "here what which who whom whose when where why how i you he she we they me him her us them my your his our their mine yours " +
   "do does did doing have has had having not no yes yeah okay ok um uh like just really very much more most some any all " +
   "can could would should will shall may might must going gonna want wanna know think thing things kind sort lot get got " +
   "one two also then than too well right mean say said see go because if out up down over into even still i'm it's that's " +
   "talk talking talked saying people actually maybe something everything anything little point question questions " +
   "don't you're we're they're there's what's").split(" ").forEach(function (w) { STOP[w] = 1; });

  /** Where the subject of a cut comes up again outside it: the cut's repeated two-word phrases, found elsewhere. */
  function topicElsewhere(list, a, b) {
    var counts = {};
    list.forEach(function (it) {
      if (it.st.startSec < a || it.st.endSec > b) return;
      var w = words(it.st.text).filter(function (x) { return x.length > 2 && !STOP[x] && x.indexOf("'") < 0; }), seen = {};
      for (var k = 0; k < w.length; k++) {
        var keys = [w[k].length >= 5 ? w[k] : null, k + 1 < w.length ? w[k] + " " + w[k + 1] : null];
        keys.forEach(function (key) { if (key && !seen[key]) { seen[key] = 1; counts[key] = (counts[key] || 0) + 1; } });
      }
    });
    var outside = list.filter(function (it) { return it.st.endSec <= a - 20 || it.st.startSec >= b + 20; }).map(function (it) {
      return { sec: it.st.startSec, t: " " + words(it.st.text).filter(function (x) { return x.length > 2 && !STOP[x] && x.indexOf("'") < 0; }).join(" ") + " " };
    });
    var found = [];
    Object.keys(counts).forEach(function (key) {
      if (counts[key] < 2) return;
      var at = [];
      outside.forEach(function (x) { if (x.t.indexOf(" " + key + " ") >= 0 && (!at.length || x.sec - at[at.length - 1] > 60)) at.push(round2(x.sec)); });
      // A subject, not a stock phrase: it comes up again, but not all through the show.
      if (!at.length || at.length > 8) return;
      var later = at.filter(function (t) { return t > b; });
      found.push({ phrase: key, at: later.concat(at.filter(function (t) { return t <= b; })).slice(0, 3), n: counts[key], later: later.length });
    });
    // Covered again after the cut beats mentioned before it; then how much the cut dwelt on it.
    found.sort(function (x, y) { return y.n * Math.min(3, y.later) - x.n * Math.min(3, x.later) || y.n - x.n || x.at.length - y.at.length; });
    var out = [];
    found.forEach(function (f) { if (out.length < 2 && !out.some(function (o2) { return o2.phrase.indexOf(f.phrase) >= 0 || f.phrase.indexOf(o2.phrase) >= 0; })) out.push({ phrase: f.phrase, at: f.at }); });
    return out;
  }

  // ------------------------------------------------------ small trims

  var HANDOFF = /\b((any|no|final|last|other) (final |last |other |closing )?(thoughts|ponderings|comments|questions|reactions|response|takeaways?)|anything (to add|else|from you)|what do you think|want to (add|jump in|respond)|do you have (anything|any)|your (thoughts|take))\b/;
  var DECLINE = /^(nope|no|nah|not really|i'?m good|i'?m fine|i think i'?m good|nothing|pass|no,? i'?m (good|fine)|i don'?t think so|not from me|nothing (from me|to add|else)|no,? not really|i'?m all set)\b/;
  /** The host invites someone in and they decline: "Any ponderings, Paul?" "Nope." */
  function deadHandoffs(segs, o) {
    var list = sentenceList(segs), res = [], nameRe = namesRe(o);
    // All in one short line, often unpunctuated: "no final ponderings Paul no". Read on the transcriber's own
    // lines, before fragments are joined into sentences.
    segs.forEach(function (sg) {
      sentences(sg).forEach(function (st) {
        var hm = HANDOFF.exec(st.norm);
        if (!hm || st.n > 10) return;
        var rest = st.norm.slice(hm.index + hm[0].length).split(" ").filter(function (x) { return x && !(nameRe && nameRe.test(x)); });
        if (rest.length && rest.length <= 4 && rest.some(function (x) { return /^(no|nope|nah|nothing)$/.test(x); }))
          res.push({ startSec: st.startSec, endSec: st.endSec, type: "dead-handoff", confidence: 0.55, review: "both", trigger: st.text,
            speaker: sg.speaker || null, reason: "Dead handoff: “" + clip(st.text, 60) + "”" });
      });
    });
    for (var i = 0; i + 1 < list.length; i++) {
      var q = list[i], a = list[i + 1];
      if (!/\?\s*$/.test(q.st.text) || !(HANDOFF.test(q.st.norm) || (nameRe && nameRe.test(q.st.text) && q.st.n <= 8))) continue;
      if (a.st.n > 5 || !DECLINE.test(a.st.norm) || a.st.startSec - q.st.endSec > 3) continue;
      if (q.seg.speaker && a.seg.speaker && q.seg.speaker === a.seg.speaker && q.seg !== a.seg) continue;
      res.push({ startSec: q.st.startSec, endSec: a.st.endSec, type: "dead-handoff", confidence: 0.6, review: "both", trigger: q.st.text,
        speaker: q.seg.speaker || null, reason: "Dead handoff: “" + clip(q.st.text, 50) + "” → “" + a.st.text + "”" });
    }
    return res;
  }

  /** "I haven't made any… I mean I haven't finished": trim the false opening up to the restart. */
  function selfCorrections(segs, o) {
    var res = [], list = sentenceList(segs);
    list.forEach(function (it, idx) {
      // Across a sentence break: "I haven't made any prior. I mean, I haven't finished…"
      var prev = list[idx - 1];
      if (prev && prev.st.n <= 8 && it.st.startSec - prev.st.endSec < 1 && /^(i mean|or rather|sorry)\b/.test(it.st.norm)) {
        var pw = words(prev.st.text), cw = it.st.norm.replace(/^(i mean|or rather|sorry)\s*/, "").split(" ");
        if (pw.length >= 2 && cw[0] === pw[0] && cw[1] === pw[1]) {
          var tw0 = timedWords(it.st), skip = it.st.norm.split(" ").length - cw.length;
          res.push({ startSec: prev.st.startSec, endSec: tw0[Math.min(tw0.length - 1, skip)].sec - 0.15, type: "self-correction", confidence: 0.55, review: "end",
            trigger: prev.st.text, speaker: prev.seg.speaker || null,
            reason: "Self-correction: “" + clip(prev.st.text + " " + it.st.text, 70) + "”" });
          return;
        }
      }
      var tw = timedWords(it.st), w = tw.map(function (x) { return x.norm; });
      for (var k = 2; k <= Math.min(8, w.length - 3); k++) {
        if (!((w[k] === "i" && w[k + 1] === "mean") || (w[k] === "or" && w[k + 1] === "rather"))) continue;
        if (w[k + 2] !== w[0] || w[k + 3] !== w[1]) continue; // the opening two words again
        var per = (it.st.endSec - it.st.startSec) / Math.max(1, tw.length);
        res.push({ startSec: it.st.startSec, endSec: tw[k + 2].sec - per / 2,
          type: "self-correction", confidence: 0.5, review: "end", trigger: tw.slice(0, k + 2).map(function (x) { return x.raw; }).join(" "),
          speaker: it.seg.speaker || null, reason: "Self-correction: “" + tw.slice(0, k + 3).map(function (x) { return x.raw; }).join(" ") + "…”" });
        break;
      }
    });
    return res;
  }

  /**
   * Intentional structure: a cold open that repeats a later exchange word for word. Not a cut: a note, so the
   * teaser still works after the edit. -> [{ type: "cold-open", startSec, endSec, matchStartSec, matchEndSec, text }]
   */
  function coldOpen(segs, o) {
    var list = sentenceList(segs);
    if (!list.length) return [];
    var t0 = list[0].st.startSec, opening = [], rest = [];
    list.forEach(function (it) {
      timedWords(it.st).forEach(function (w) {
        if (!w.norm || FILLER[w.norm]) return;
        (w.sec - t0 <= 45 ? opening : rest).push(w);
      });
    });
    var N = 6, grams = {};
    for (var i = 0; i + N <= opening.length; i++) {
      var g = opening.slice(i, i + N).map(function (w) { return w.norm; }).join(" ");
      if (grams[g] === undefined) grams[g] = i;
    }
    // The longest stretch of the opening said again later.
    var best = null;
    for (var j = 0; j + N <= rest.length; j++) {
      if (rest[j].sec - t0 < 90) continue;
      var key = rest.slice(j, j + N).map(function (w) { return w.norm; }).join(" ");
      if (grams[key] === undefined) continue;
      var a = grams[key], b = j, len = N;
      while (a + len < opening.length && b + len < rest.length && opening[a + len].norm === rest[b + len].norm) len++;
      var a0 = a, b0 = b;
      while (a0 > 0 && b0 > 0 && opening[a0 - 1].norm === rest[b0 - 1].norm) { a0--; b0--; }
      var total = a + len - a0;
      if (!best || total > best.total) best = { total: total, a0: a0, a1: a + len - 1, b0: b0, b1: b + len - 1 };
      j = b + len - 1;
    }
    if (!best) return [];
    return [{ type: "cold-open", startSec: round2(opening[best.a0].sec), endSec: round2(opening[best.a1].sec),
      matchStartSec: round2(rest[best.b0].sec), matchEndSec: round2(rest[best.b1].sec),
      text: clip(opening.slice(best.a0, best.a1 + 1).map(function (w) { return w.raw; }).join(" "), 140) }];
  }

  // ---------------------------------------------------- introductions

  // Words that can follow a first name without being a surname ("Paul, Tanya and Martin", "Jessica Abood and…").
  var NOT_SURNAME = { And: 1, The: 1, Is: 1, With: 1, Here: 1, Today: 1, I: 1, We: 1, Our: 1, My: 1, Your: 1, This: 1, That: 1,
    So: 1, But: 1, Or: 1, Of: 1, From: 1, To: 1, In: 1, On: 1, At: 1, As: 1, It: 1, He: 1, She: 1, They: 1, Who: 1, Happy: 1, Hello: 1, Hi: 1 };
  var GUEST_CUE = /\b(joined by|joining us( today)?( is)?|our (special )?guest( today)?( is)?|special guest|with us (today|this week)( is)?|welcome(s)?( back)?)\s*$/i;

  /** Words of a sentence with estimated times (spread evenly over the sentence) and their original spelling. */
  function timedWords(st) {
    var raw = st.text.split(/\s+/).filter(function (w) { return normalize(w); });
    var dur = st.endSec - st.startSec;
    return raw.map(function (w, i) {
      return { raw: w.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, ""), norm: normalize(w), sec: st.startSec + dur * (i + 0.5) / raw.length };
    });
  }
  function isCap(w) { return /^[A-Z][a-zA-Z'\-]+$/.test(w || "") && !NOT_SURNAME[w]; }

  /**
   * The show's introduction: the welcome ("Hello and welcome to … Classical et cetera"), the host ("I'm Jessica
   * Abood"), and everyone named while they go round the table. Used to open on the host's solo cam, go to the
   * wide for the introductions, and drop lower-third name markers.
   *   opts: { showName, names: ["Martin", "Tanya", …] (people on mic; first names are enough), windowSec: 75 }
   *   -> { welcomeSec, welcomeEndSec, welcomeText, host: {name, sec}|null, names: [{ name, fullName, sec, host, guest }],
   *        wideSec, endSec } or null
   */
  function introduction(segs, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    if (!segs || !segs.length) return null;
    var all = sentenceStream(segs, 0, 0), endT = segs[segs.length - 1].endSec;
    var welcome = null;
    for (var k = 0; k < all.length && all[k].startSec < endT * 0.35; k++) {
      var kind = isIntro(all[k], o);
      if (kind === "show") { welcome = all[k]; break; }
      if (kind === "generic" && !welcome) welcome = all[k];
    }
    if (!welcome) return null;
    var idx = all.indexOf(welcome), from = welcome;
    if (idx > 0 && all[idx - 1].n <= 3 && /^(hello|hi|hey|good (morning|afternoon|evening)|welcome)\b/.test(all[idx - 1].norm)) from = all[idx - 1];

    var windowSec = o.windowSec || 75;
    var wanted = (o.names || []).map(function (n) { return { first: normalize(String(n).split(/\s+/)[0]), label: String(n).trim() }; })
      .filter(function (n) { return n.first.length > 1; });
    var found = {}, list = [], host = null;
    var words = [];
    for (var j = idx; j < all.length && all[j].startSec < welcome.startSec + windowSec; j++) words = words.concat(timedWords(all[j]));
    for (var w = 0; w < words.length; w++) {
      var cur = words[w], prev2 = w > 1 ? words[w - 2].norm + " " + words[w - 1].norm : "", prev = w > 0 ? words[w - 1].norm : "";
      var full = function (i) { // "Jessica" + "Abood" when a capitalised surname follows
        var s = words[i].raw;
        if (words[i + 1] && isCap(words[i + 1].raw) && !wanted.some(function (n) { return n.first === words[i + 1].norm; })) s += " " + words[i + 1].raw;
        return s;
      };
      // The host introduces themselves: "I'm Jessica Abood", "my name is …", "this is …".
      if (!host && (prev === "im" || prev === "i'm" || prev2 === "i am" || prev2 === "name is" || prev2 === "this is") && isCap(cur.raw)) {
        host = { name: full(w), first: cur.norm, sec: cur.sec };
      }
      var match = wanted.filter(function (n) { return n.first === cur.norm; })[0];
      if (match && !found[match.first]) {
        found[match.first] = true;
        // A full name set on the speaker ("Martin Cothran") beats what the transcript spelled out.
        list.push({ name: match.label, fullName: match.label.indexOf(" ") > 0 ? match.label : full(w), sec: Math.round(cur.sec * 100) / 100 });
        continue;
      }
      // A guest introduced by a cue phrase ("joined by Dr. Malcolm Guite", "our guest today is …").
      if (isCap(cur.raw) && !found[cur.norm] && GUEST_CUE.test(words.slice(Math.max(0, w - 5), w).map(function (x) { return x.raw; }).join(" "))) {
        var gi = w, name = cur.raw;
        if (/^(dr|mr|mrs|ms|father|fr|professor|prof)$/i.test(cur.raw) && words[w + 1] && isCap(words[w + 1].raw)) {
          gi = w + 1; name = cur.raw + (/^(dr|mr|mrs|ms|fr|prof)$/i.test(cur.raw) ? ". " : " ") + words[gi].raw;
        }
        if (words[gi + 1] && isCap(words[gi + 1].raw)) name += " " + words[gi + 1].raw;
        found[words[gi].norm] = true;
        list.push({ name: name, fullName: name, sec: Math.round(cur.sec * 100) / 100, guest: true });
      }
    }
    // Keep the names said together, starting at the welcome: stop at a gap of more than 30 s between names.
    list.sort(function (a, b) { return a.sec - b.sec; });
    var keep = [];
    list.forEach(function (n) { if (!keep.length || n.sec - keep[keep.length - 1].sec <= 30) keep.push(n); });
    if (host) {
      var hostEntry = keep.filter(function (n) { return normalize(n.fullName.split(" ")[0]) === host.first; })[0];
      if (hostEntry) { hostEntry.host = true; hostEntry.fullName = host.name.length > hostEntry.fullName.length ? host.name : hostEntry.fullName; }
      else keep.unshift({ name: host.name, fullName: host.name, sec: Math.round(host.sec * 100) / 100, host: true });
    }
    var others = keep.filter(function (n) { return !n.host; });
    var wideSec = others.length ? Math.max(welcome.endSec, others[0].sec - 0.3) : welcome.endSec;
    // On their own the names come quickly; the wide holds a beat after the last one.
    var lastName = keep.length ? keep[keep.length - 1].sec : welcome.endSec;
    return {
      welcomeSec: round2(from.startSec), welcomeEndSec: round2(welcome.endSec), welcomeText: welcome.text,
      host: host ? { name: host.name, sec: round2(host.sec) } : null,
      names: keep, wideSec: round2(Math.min(wideSec, lastName)), endSec: round2(Math.max(lastName + 2.5, wideSec + 4))
    };
  }

  /** "So the thing about — so the thing about budgets is..." -> cut the first attempt. */
  function falseStarts(segs, o) {
    var res = [];
    var N = o.falseStartWords;
    for (var i = 0; i < segs.length; i++) {
      var a = contentWords(segs[i].text);
      if (a.length < N) continue;
      var head = a.slice(0, N).join(" ");
      for (var j = i + 1; j < segs.length && segs[j].startSec - segs[i].startSec <= o.falseStartWindowSec; j++) {
        if (segs[i].speaker && segs[j].speaker && segs[i].speaker !== segs[j].speaker) continue;
        var b = contentWords(segs[j].text);
        if (b.length < N || b.slice(0, N).join(" ") !== head) continue;
        // Attempt i should be shorter / abandoned; if both are long, it's probably a repeated phrase.
        var abandoned = a.length <= b.length + 2 || /(—|--|\.\.\.|-)\s*$/.test(segs[i].text);
        var conf = 0.5 + Math.min(0.3, 0.06 * (commonPrefix(a, b) - N)) + (abandoned ? 0.1 : -0.2);
        if (segs[j].startSec - segs[i].endSec < 4) conf += 0.05;
        res.push({ startSec: segs[i].startSec, endSec: segs[j].startSec, type: "false-start",
          confidence: conf, trigger: head, speaker: segs[i].speaker || null, review: "end",
          reason: "Restarted with the same words (\"" + head + "…\")" });
        break;
      }
    }
    return res;
  }
  function commonPrefix(a, b) { var n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

  var LABELS = {
    "edit-cue": "Asked to cut", restart: "Restart / retake", "off-record": "Off the record",
    bleep: "Bleep requested", interruption: "Interruption (phone, alarm\u2026)", technical: "Technical chatter", "false-start": "False start",
    "pre-show": "Pre-show chatter", "post-show": "Post-show chatter", breakdown: "Production breakdown", leak: "Producer / internal talk",
    "dead-handoff": "Dead handoff", "self-correction": "Self-correction"
  };
  function describe(type, phrase) { return (LABELS[type] || type) + ": “" + phrase + "”"; }

  function mergeSuggestions(list) {
    list.sort(function (a, b) { return a.startSec - b.startSec; });
    var out = [];
    list.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s.startSec <= last.endSec + 0.5) {
        last.endSec = Math.max(last.endSec, s.endSec);
        if (s.confidence > last.confidence) { last.type = s.type; last.trigger = s.trigger; last.reason = s.reason; }
        last.confidence = Math.max(last.confidence, s.confidence) + 0.05; // corroborated
        last.reasons = (last.reasons || [last.reason]).concat([s.reason]);
        if (s.showStartSec !== undefined) last.showStartSec = s.showStartSec;
        if (s.showEndSec !== undefined) last.showEndSec = s.showEndSec;
      } else out.push(s);
    });
    return out;
  }

  function sentenceText(segs, a, b) {
    return sentenceList(segs).filter(function (it) { return it.st.startSec >= a - 0.05 && it.st.endSec <= b + 0.05; }).map(function (it) { return it.st.text; }).join(" ");
  }
  function textBetween(segs, a, b) {
    return segs.filter(function (s) { return s.endSec > a && s.startSec < b; })
      .map(function (s) { return (s.speaker && !/^unknown$/i.test(s.speaker) ? s.speaker + ": " : "") + s.text; }).join(" ").slice(0, 600);
  }
  function round2(v) { return Math.round(v * 100) / 100; }

  /** Attribute speakers using mic activity runs from the multicam engine (for transcripts without labels). */
  function assignSpeakers(segs, speechRuns) {
    return segs.map(function (s) {
      if (s.speaker) return s;
      var best = null, bestOv = 0;
      (speechRuns || []).forEach(function (sr) {
        var ov = 0;
        sr.runs.forEach(function (r) { ov += Math.max(0, Math.min(r[1], s.endSec) - Math.max(r[0], s.startSec)); });
        if (ov > bestOv) { bestOv = ov; best = sr.speakerId; }
      });
      var c = {}; for (var k in s) c[k] = s[k];
      c.speaker = best;
      return c;
    });
  }

  function toCsv(suggestions) {
    var rows = [["id", "start", "end", "duration", "type", "confidence", "reason", "text"]];
    suggestions.forEach(function (s) {
      rows.push([s.id, fmt(s.startSec), fmt(s.endSec), (s.endSec - s.startSec).toFixed(2), s.type, s.confidence, s.reason, s.text]);
    });
    return rows.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
  }
  function fmt(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ":" : "") + (m < 10 && h ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
  }

  return { isSound: isSound, parse: parse, analyze: analyze, introduction: introduction, assignSpeakers: assignSpeakers, toCsv: toCsv,
           formatTime: fmt, DEFAULTS: DEFAULTS, CUES: CUES };
});
