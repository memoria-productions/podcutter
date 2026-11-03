"use strict";
// Runs host/host.jsx against a small fake of Premiere's scripting DOM (incl. QE razor)
// and checks that a planned cut ends up with exactly one enabled camera at every moment.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const D = require("../engine/director.js");
const { makeCurves } = require("./synth.js");

const TPS = 254016000000;
const FPS = 30, TPF = TPS / FPS;

function fakePremiere(durationSec, nCams) {
  const tick = (sec) => ({ ticks: String(Math.round(sec * TPS)) });
  function clipsOf(list) { const o = list.slice(); o.numItems = list.length; return o; }
  function makeTrack(name, media) {
    const t = { name, _clips: [{ name: media, start: tick(0), end: tick(durationSec), inPoint: tick(0), disabled: false,
      projectItem: { getMediaPath: () => "C:/media/" + media } }] };
    Object.defineProperty(t, "clips", { get: () => clipsOf(t._clips) });
    return t;
  }
  const video = []; for (let i = 0; i < nCams; i++) video.push(makeTrack("V" + (i + 1), "cam" + i + ".mp4"));
  // A video track's "mute" is its eye (track output).
  video.forEach((v) => { v._muted = false; v.isMuted = () => v._muted; v.setMute = (m) => { v._muted = !!m; }; });
  const audio = [makeTrack("Host", "host.wav"), makeTrack("Guest", "guest.wav")];
  audio.forEach((a) => { a.isMuted = () => false; });
  const markers = [];
  const seq = {
    name: "Ep 1", sequenceID: "seq-1", timebase: String(TPF), end: String(durationSec * TPS),
    videoTracks: Object.assign(video, { numTracks: video.length }),
    audioTracks: Object.assign(audio, { numTracks: audio.length }),
    markers: {
      createMarker(s) { const m = { start: s, name: "", comments: "", setColorByIndex(i) { this.color = i; } }; markers.push(m); return m; },
      getFirstMarker: () => markers[0] || null,
      getNextMarker: (m) => markers[markers.indexOf(m) + 1] || null,
      deleteMarker: (m) => markers.splice(markers.indexOf(m), 1)
    },
    getSettings: () => { throw new Error("use fallback timecode"); },
    getPlayerPosition: () => tick(0), setPlayerPosition() {},
    clone() { const c = Object.assign({}, seq, { sequenceID: "seq-2", name: "Ep 1 Copy" }); sequences.push(c); }
  };
  const sequences = [seq];
  const project = { name: "P", sequences: new Proxy(sequences, { get: (t, k) => k === "numSequences" ? t.length : t[k] }),
    get activeSequence() { return active; }, openSequence(id) { active = sequences.find((s) => s.sequenceID === id); } };
  let active = seq;
  const qeTrack = (i) => ({
    razor(tc) {
      const [h, m, s, f] = tc.split(":").map(Number);
      const frame = ((h * 60 + m) * 60 + s) * FPS + f;
      const ticks = frame * TPF;
      const tr = video[i];
      const idx = tr._clips.findIndex((c) => +c.start.ticks < ticks && +c.end.ticks > ticks);
      if (idx < 0) throw new Error("no clip");
      const c = tr._clips[idx];
      const right = Object.assign({}, c, { start: { ticks: String(ticks) } });
      c.end = { ticks: String(ticks) };
      tr._clips.splice(idx + 1, 0, right);
    }
  });
  const ctx = {
    app: { version: "26.0", project, enableQE() {} },
    qe: { project: { getActiveSequence: () => ({ getVideoTrackAt: qeTrack }) } },
    Time: function () { this.ticks = "0"; }, JSON, Math, String, parseFloat, isFinite
  };
  return { ctx, seq, video, markers };
}

test("host applies a planned cut: razors and enables exactly one camera per shot", () => {
  const dur = 40;
  const fake = fakePremiere(dur, 3);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));

  const info = call("PD.getSequenceInfo()");
  assert.ok(info.ok);
  assert.equal(info.durationSec, dur);
  assert.equal(info.videoTracks[0].mediaPaths[0], "C:/media/cam0.mp4");

  const cameras = [{ id: "a", videoTrack: 0, shows: ["H"] }, { id: "b", videoTrack: 1, shows: ["G"] }, { id: "w", videoTrack: 2, shows: ["H", "G"] }];
  const input = makeCurves([["H", 1, 12], ["G", 12.4, 25], ["H", 25.5, 38]], { durationSec: dur, speakers: ["H", "G"] });
  const plan = D.plan(input, { speakers: [{ id: "H", name: "Host" }, { id: "G", name: "Guest" }], cameras });
  const payload = D.toEditPayload(plan, cameras, FPS, { layered: false });

  const dup = call('PD.duplicateActive("seq-1", " - PD")');
  assert.ok(dup.ok, dup.error);
  for (const t of payload.cameraTracks) {
    const r = call("PD.razorTrack(" + JSON.stringify(JSON.stringify({ sequenceID: dup.sequenceID, track: t, frames: payload.cutFrames })) + ")");
    assert.ok(r.ok, r.error);
    assert.equal(r.razored, payload.cutFrames.length);
  }
  const en = call("PD.applyEnables(" + JSON.stringify(JSON.stringify({ sequenceID: dup.sequenceID, cameraTracks: payload.cameraTracks, shots: payload.shots })) + ")");
  assert.ok(en.ok, en.error);

  // At sample times, exactly one camera clip is enabled and it matches the plan.
  for (let t = 0.5; t < dur; t += 0.5) {
    const ticks = t * TPS;
    const enabled = fake.video.map((tr, i) => {
      const c = tr._clips.find((x) => +x.start.ticks <= ticks && +x.end.ticks > ticks);
      return c && !c.disabled ? i : -1;
    }).filter((i) => i >= 0);
    const want = cameras.find((c) => c.id === plan.shots.find((s) => s.startSec <= t && s.endSec > t).cameraId).videoTrack;
    assert.deepEqual(enabled, [want], "at " + t + "s");
  }

  const mk = call("PD.addMarkers(" + JSON.stringify(JSON.stringify({ prefix: "[PD] ", markers: [{ startSec: 1, name: "Wide", color: 6 }, { startSec: 3, endSec: 5, name: "cut", color: 1 }] })) + ")");
  assert.equal(mk.added, 2);
  assert.equal(fake.markers[1].end, 5);
  assert.equal(call('PD.clearMarkers("[PD] ")').removed, 2);
});

test("host refuses to edit when the wrong sequence is active", () => {
  const fake = fakePremiere(10, 2);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const r = JSON.parse(vm.runInContext('PD.razorTrack(' + JSON.stringify(JSON.stringify({ sequenceID: "other", track: 0, frames: [30] })) + ")", fake.ctx));
  assert.equal(r.ok, false);
  assert.match(r.error, /Refusing/);
});

test("recut in place: a second plan applied over the first ends up exactly as the second plan", () => {
  const dur = 40;
  const fake = fakePremiere(dur, 3);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));
  const cameras = [{ id: "a", videoTrack: 0, shows: ["H"] }, { id: "b", videoTrack: 1, shows: ["G"] }, { id: "w", videoTrack: 2, shows: ["H", "G"] }];
  const input = makeCurves([["H", 1, 12], ["G", 12.4, 25], ["H", 25.5, 38]], { durationSec: dur, speakers: ["H", "G"] });
  const speakersHG = [{ id: "H", name: "Host" }, { id: "G", name: "Guest" }];
  const write = (seqId, payload) => {
    for (const x of payload.tracks) call("PD.razorTrack(" + JSON.stringify(JSON.stringify({ sequenceID: seqId, track: x.track, frames: x.cuts })) + ")");
    return call("PD.applyEnables(" + JSON.stringify(JSON.stringify({ sequenceID: seqId, tracks: payload.tracks })) + ")");
  };
  const writeOld = (seqId, payload) => {
    for (const t of payload.cameraTracks) call("PD.razorTrack(" + JSON.stringify(JSON.stringify({ sequenceID: seqId, track: t, frames: payload.cutFrames })) + ")");
    return call("PD.applyEnables(" + JSON.stringify(JSON.stringify({ sequenceID: seqId, cameraTracks: payload.cameraTracks, shots: payload.shots })) + ")");
  };
  const dup = call('PD.duplicateActive("seq-1", " - PD")');
  // First cut in the old every-track style, then recut layered over it: the bottom track must come back whole-enabled.
  const p1 = D.toEditPayload(D.plan(input, { speakers: speakersHG, cameras, preset: "calm" }), cameras, FPS, { layered: false });
  writeOld(dup.sequenceID, p1);
  assert.ok(call('PD.openSequenceById("' + dup.sequenceID + '")').ok);
  const plan2 = D.plan(input, { speakers: speakersHG, cameras, preset: "social" });
  write(dup.sequenceID, D.toEditPayload(plan2, cameras, FPS));
  for (let t = 0.5; t < dur; t += 0.5) {
    const want = cameras.find((c) => c.id === plan2.shots.find((s) => s.startSec <= t && s.endSec > t).cameraId).videoTrack;
    assert.equal(visible(fake, t), want, "at " + t + "s");
  }
  assert.ok(fake.video[0]._clips.every((c) => !c.disabled), "bottom camera all enabled");
  assert.equal(call('PD.openSequenceById("nope")').ok, false);
  // A remembered copy that was deleted from the project is reported gone (the panel then stops offering Recut).
  assert.equal(call('PD.sequenceExists("' + dup.sequenceID + '")').exists, true);
  assert.equal(call('PD.sequenceExists("nope")').exists, false);
});

/** The camera Premiere shows: the top-most enabled clip. */
function visible(fake, t) {
  const ticks = t * TPS;
  for (let i = fake.video.length - 1; i >= 0; i--) {
    const c = fake.video[i]._clips.find((x) => +x.start.ticks <= ticks && +x.end.ticks > ticks);
    if (c && !c.disabled) return i;
  }
  return -1;
}

test("layered cut: the bottom camera is never razored, the cameras above only where they change", () => {
  const dur = 60;
  const fake = fakePremiere(dur, 2);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));
  // V1 static wide underneath, V2 solo camera on top (the Classical et cetera setup).
  const cameras = [{ id: "w", videoTrack: 0, shows: ["H", "G"] }, { id: "solo", videoTrack: 1, shows: [], follows: true }];
  const input = makeCurves([["H", 1, 12], ["G", 12.4, 25], ["H", 25.5, 38], ["G", 38.5, 58]], { durationSec: dur, speakers: ["H", "G"] });
  const plan = D.plan(input, { speakers: [{ id: "H", name: "Host" }, { id: "G", name: "Guest" }], cameras, style: { maxShotSec: 6, cutawayMode: "wide" } });
  const payload = D.toEditPayload(plan, cameras, FPS);
  const dup = call('PD.duplicateActive("seq-1", " - PD")');
  for (const x of payload.tracks) assert.ok(call("PD.razorTrack(" + JSON.stringify(JSON.stringify({ sequenceID: dup.sequenceID, track: x.track, frames: x.cuts })) + ")").ok);
  assert.ok(call("PD.applyEnables(" + JSON.stringify(JSON.stringify({ sequenceID: dup.sequenceID, tracks: payload.tracks })) + ")").ok);
  assert.equal(fake.video[0]._clips.length, 1, "wide untouched");
  assert.ok(!fake.video[0]._clips[0].disabled);
  assert.ok(fake.video[1]._clips.length > 1, "solo cam was cut");
  for (let t = 0.5; t < dur; t += 0.5) {
    const want = cameras.find((c) => c.id === plan.shots.find((s) => s.startSec <= t && s.endSec > t).cameraId).videoTrack;
    assert.equal(visible(fake, t), want, "at " + t + "s");
  }
});

test("a camera track with its eye off is reported on scan and turned back on after the cut", () => {
  const fake = fakePremiere(30, 2);
  fake.video[1]._muted = true; // V2's track output switched off in the original
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));
  const info = call("PD.getSequenceInfo()");
  assert.deepEqual(info.videoTracks.map((v) => v.hidden), [false, true]);
  const dup = call('PD.duplicateActive("seq-1", " - PD")');
  const r = call("PD.showTracks(" + JSON.stringify(JSON.stringify({ sequenceID: dup.sequenceID, tracks: [0, 1] })) + ")");
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.shown, [1]);
  assert.equal(fake.video[1].isMuted(), false);
  assert.deepEqual(call("PD.showTracks(" + JSON.stringify(JSON.stringify({ sequenceID: dup.sequenceID, tracks: [0, 1] })) + ")").shown, [], "nothing to do the second time");
});

test("multicamAtPlayhead finds a multicam clip under the playhead (and says when there isn't one)", () => {
  const fake = fakePremiere(30, 2);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));
  let r = call("PD.multicamAtPlayhead()");
  assert.ok(r.ok && r.multicam === null && r.fps === 30);
  fake.video[0]._clips[0].projectItem.isSequence = () => true; // a plain nest on V1
  r = call("PD.multicamAtPlayhead()");
  assert.deepEqual(r.multicam, { track: 0, name: "cam0.mp4", startSec: 0, endSec: 30, multicam: false });
  fake.video[1]._clips[0].projectItem.isMulticamClip = () => true; // a real multicam clip wins
  r = call("PD.multicamAtPlayhead()");
  assert.deepEqual(r.multicam, { track: 1, name: "cam1.mp4", startSec: 0, endSec: 30, multicam: true });
});

test("multicamCovering finds the multicam track for a range; countClips counts the pieces", () => {
  const fake = fakePremiere(30, 2);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));
  const q = (o) => JSON.stringify(JSON.stringify(o));
  assert.equal(call("PD.multicamCovering(" + q({ startSec: 5, endSec: 25 }) + ")").track, undefined, "nothing nested yet");
  fake.video[0]._clips[0].projectItem.isSequence = () => true;
  fake.video[0]._clips[0].projectItem.isMulticamClip = () => true;
  const r = call("PD.multicamCovering(" + q({ startSec: 5, endSec: 25 }) + ")");
  assert.equal(r.track, 0);
  assert.equal(r.multicam, true);
  assert.deepEqual(r.gaps, []);
  assert.equal(Math.round(r.coveredSec), 20);
  assert.equal(r.inSec, null, "no marks set");
  fake.seq.getInPoint = () => "8"; fake.seq.getOutPoint = () => "18";
  const m = call("PD.multicamCovering(" + q({ startSec: 5, endSec: 25 }) + ")");
  assert.deepEqual([m.inSec, m.outSec], [8, 18]);
  // Two cuts with the razor, then count: three pieces inside the range.
  const qt = fake.ctx.qe.project.getActiveSequence().getVideoTrackAt(0);
  qt.razor("00:00:10:00"); qt.razor("00:00:20:00");
  const cc = call("PD.countClips(" + q({ track: 0, startSec: 5, endSec: 25 }) + ")");
  assert.equal(cc.clips, 3);
  assert.deepEqual(cc.starts, [0, 10, 20], "the existing edit points, for a recut");
});

test("multicam angles that are per-camera nests (244_mc of 244_a_cam / 244_b_cam) are followed down to the camera files", () => {
  const fake = fakePremiere(40, 1);
  const tick = (s) => ({ ticks: String(Math.round(s * TPS)) });
  const clipsOf = (list) => Object.assign(list.slice(), { numItems: list.length });
  const track = (name, c) => ({ name, get clips() { return clipsOf(c); } });
  const seqOf = (id, name, tracks) => ({ sequenceID: id, name, projectItem: { nodeId: id }, videoTracks: Object.assign(tracks, { numTracks: tracks.length }) });
  const item = (id, mc) => ({ nodeId: id, isSequence: () => true, isMulticamClip: () => !!mc, getMediaPath: () => "" });
  // Per-camera nests, as David and PodGrip build them: the camera file starts 3 s in (b_cam) or 1.5 s in (a_cam, on V2,
  // with a Black Video filler on V3 that has no media).
  const bCam = seqOf("b", "244_b_cam", [track("V1", [{ name: "wide.mp4", start: tick(3), end: tick(63), inPoint: tick(0), projectItem: { getMediaPath: () => "C:/media/wide.mp4" } }])]);
  const aCam = seqOf("a", "244_a_cam", [track("V1", []),
    track("V2", [{ name: "dolly.mp4", start: tick(1.5), end: tick(61.5), inPoint: tick(10), projectItem: { getMediaPath: () => "C:/media/dolly.mp4" } }]),
    track("V3", [{ name: "Black Video", start: tick(61.5), end: tick(70), inPoint: tick(0), projectItem: { getMediaPath: () => "" } }])]);
  // The multicam: V1 = b_cam (the wide), V2 = a_cam, each nest from its own 0.
  const mc = seqOf("mc", "244_mc", [track("V1", [{ name: "244_b_cam", start: tick(0), end: tick(70), inPoint: tick(0), projectItem: item("b") }]),
    track("V2", [{ name: "244_a_cam", start: tick(0), end: tick(70), inPoint: tick(0), projectItem: item("a") }])]);
  fake.ctx.app.project.sequences.push(bCam, aCam, mc);
  // The main edit plays the multicam from 4 s of its time at 0 s.
  fake.video[0]._clips = [{ name: "244_mc", start: tick(0), end: tick(40), inPoint: tick(4), projectItem: item("mc", true) }];
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const v1 = JSON.parse(vm.runInContext("PD.getSequenceInfo()", fake.ctx)).videoTracks[0];
  assert.ok(v1.nest, "multicam found");
  assert.deepEqual(v1.nest.angles.map((a) => [a.angle, a.name]), [[1, "244_b_cam"], [2, "244_a_cam"]]);
  // Outer 0 s = multicam 4 s = b_cam 4 s = wide.mp4 1 s in.
  assert.deepEqual(v1.nest.angles[0].clips, [{ startSec: 0, endSec: 40, inPointSec: 1, mediaPath: "C:/media/wide.mp4", speed: 1 }]);
  // Outer 0 s = a_cam 4 s = dolly.mp4 10 + 2.5 s in; no Black Video piece.
  assert.deepEqual(v1.nest.angles[1].clips, [{ startSec: 0, endSec: 40, inPointSec: 12.5, mediaPath: "C:/media/dolly.mp4", speed: 1 }]);
});

test("a multicam nest's angles are read through and mapped onto the outer timeline", () => {
  const fake = fakePremiere(40, 1);
  const tick = (s) => ({ ticks: String(Math.round(s * TPS)) });
  const clipsOf = (list) => Object.assign(list.slice(), { numItems: list.length });
  // Inside the nest: V1 wide, V2 dolly, both 0-60 s of their own files.
  const innerTrack = (name, media) => {
    const c = [{ name: media, start: tick(0), end: tick(60), inPoint: tick(0), projectItem: { getMediaPath: () => "C:/media/" + media } }];
    return { name, get clips() { return clipsOf(c); } };
  };
  const nest = { sequenceID: "nest-1", name: "Cams MC", projectItem: { nodeId: "n1" },
    videoTracks: Object.assign([innerTrack("Wide", "wide.mp4"), innerTrack("Dolly", "dolly.mp4")], { numTracks: 2 }) };
  fake.ctx.app.project.sequences.push(nest);
  // Outside: V1 plays the nest from 2 s of its time at 5 s, cut in two at 15 s (as after a multicam build).
  const nestItem = { nodeId: "n1", isSequence: () => true, isMulticamClip: () => true, getMediaPath: () => "" };
  fake.video[0]._clips = [
    { name: "Cams MC", start: tick(5), end: tick(15), inPoint: tick(2), projectItem: nestItem, setColorLabel(i) { this.label = i; } },
    { name: "Cams MC", start: tick(15), end: tick(35), inPoint: tick(12), projectItem: nestItem, setColorLabel(i) { this.label = i; } }
  ];
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));
  const v1 = call("PD.getSequenceInfo()").videoTracks[0];
  assert.ok(v1.nest, "nest found");
  assert.equal(v1.nest.multicam, true);
  assert.deepEqual(v1.nest.angles.map((a) => [a.angle, a.name]), [[1, "Wide"], [2, "Dolly"]]);
  // The two outer pieces carry on continuously, so each angle is one clip: 5-35 s on the outside, from 2 s of the file.
  assert.deepEqual(v1.nest.angles[1].clips, [{ startSec: 5, endSec: 35, inPointSec: 2, mediaPath: "C:/media/dolly.mp4", speed: 1 }]);

  // Rose on the pieces whose middle is in a camera 2 stretch.
  const q = (o) => JSON.stringify(JSON.stringify(o));
  const r = call("PD.colorClips(" + q({ sequenceID: "seq-1", track: 0, ranges: [[15, 35]], color: 6 }) + ")");
  assert.deepEqual([r.colored, r.unsupported], [1, false]);
  assert.equal(fake.video[0]._clips[1].label, 6);
  assert.equal(fake.video[0]._clips[0].label, undefined);
  // A recut that moves camera 2 to the first piece: it turns Rose, the second gets its original label (5) back.
  call("PD.colorClips(" + q({ sequenceID: "seq-1", track: 0, ranges: [[5, 15]], color: 6, within: [5, 35], otherColor: 5 }) + ")");
  assert.deepEqual(fake.video[0]._clips.map((c) => c.label), [6, 5]);
  // Selecting pieces for a Label shortcut: just the camera 2 piece, then the others, then nothing.
  fake.video[0]._clips.forEach((c) => { c.sel = false; c.isSelected = function () { return this.sel; }; c.setSelected = function (s) { this.sel = s; }; });
  fake.video[0]._clips[0].sel = true;
  assert.equal(call("PD.selectClips(" + q({ sequenceID: "seq-1", track: 0, ranges: [[15, 35]] }) + ")").selected, 1);
  assert.deepEqual(fake.video[0]._clips.map((c) => c.sel), [false, true]);
  call("PD.selectClips(" + q({ track: 0, ranges: [[15, 35]], within: [5, 35], invert: true }) + ")");
  assert.deepEqual(fake.video[0]._clips.map((c) => c.sel), [true, false]);
  call("PD.selectClips(" + q({ track: 0, ranges: [] }) + ")");
  assert.deepEqual(fake.video[0]._clips.map((c) => c.sel), [false, false]);
  delete fake.video[0]._clips[0].setColorLabel;
  assert.equal(call("PD.colorClips(" + q({ track: 0, ranges: [[0, 15]], color: 6 }) + ")").unsupported, true, "says so when Premiere can't");
});

test("layered payload: with three cameras the middle one isn't cut while the top one covers it", () => {
  const cams = [{ id: "w", videoTrack: 0 }, { id: "a", videoTrack: 1 }, { id: "b", videoTrack: 2 }];
  const shot = (a, b, c) => ({ startSec: a, endSec: b, cameraId: c });
  const p = D.toEditPayload({ shots: [shot(0, 5, "a"), shot(5, 9, "b"), shot(9, 14, "a"), shot(14, 20, "w")] }, cams, 10);
  const byTrack = {}; p.tracks.forEach((x) => { byTrack[x.track] = x; });
  assert.deepEqual(byTrack[0].cuts, [], "base never cut");
  assert.deepEqual(byTrack[1].cuts, [140], "middle cam stays on under the top cam, off only for the wide");
  assert.deepEqual(byTrack[2].cuts, [50, 90]);
});

test("host sets the sequence In point at the welcome", () => {
  const fake = fakePremiere(60, 2);
  let inSec = null;
  fake.seq.setInPoint = (v) => { inSec = Number(v); };
  fake.seq.getInPoint = () => String(inSec);
  fake.seq.getOutPoint = () => "60";
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const r = JSON.parse(vm.runInContext("PD.setInOut(" + JSON.stringify(JSON.stringify({ inSec: 12.5 })) + ")", fake.ctx));
  assert.ok(r.ok, r.error);
  assert.equal(inSec, 12.5);
  assert.equal(r.inSec, 12.5);
});

test("restoring a multicam joins PodCutter's through-edits back into one clip, keeping content cuts", () => {
  const fake = fakePremiere(60, 1);
  const tick = (s) => ({ ticks: String(Math.round(s * TPS)) });
  const mcItem = { nodeId: "mc", isSequence: () => true, isMulticamClip: () => true, getMediaPath: () => "" };
  // Built 0-40 s: Cut to Camera left edit points at 10, 20 and 30 s; at 30 s there's also a content cut (the
  // source jumps from 30 to 40 s), and a title sits after 40 s. The multicam's sound on A1 was cut the same way.
  const pieces = (track) => [[0, 10, 4], [10, 20, 14], [20, 30, 24], [30, 40, 44], [40, 50, null]].map(([a, b, i]) => {
    const c = { name: i === null ? "Title" : "245_mc", start: tick(a), end: tick(b), inPoint: tick(i || 0),
      projectItem: i === null ? { nodeId: "title", getMediaPath: () => "" } : mcItem };
    c.remove = () => track._clips.splice(track._clips.indexOf(c), 1);
    return c;
  });
  const v1 = fake.video[0], a1 = fake.seq.audioTracks[0];
  v1._clips = pieces(v1); a1._clips = pieces(a1);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));
  const q = (o) => JSON.stringify(JSON.stringify(o));
  const span = (tr) => tr._clips.map((c) => [+c.start.ticks / TPS, +c.end.ticks / TPS, +c.inPoint.ticks / TPS]);

  const r = call("PD.restoreMulticam(" + q({ sequenceID: "seq-1", track: 0, startSec: 0, endSec: 40 }) + ")");
  assert.ok(r.ok, r.error);
  assert.deepEqual([r.joined, r.audioJoined, r.pieces, r.starts], [2, 2, 2, [0, 30]]);
  assert.deepEqual(span(v1), [[0, 30, 4], [30, 40, 44], [40, 50, 0]], "through-edits joined; the content cut and the title stay");
  assert.deepEqual(span(a1), [[0, 30, 4], [30, 40, 44], [40, 50, 0]], "the sound under it too");
  // Nothing left to join the second time.
  assert.equal(call("PD.restoreMulticam(" + q({ sequenceID: "seq-1", track: 0, startSec: 0, endSec: 40 }) + ")").joined, 0);
  // Removing the picture can take its linked sound with it: the sound is still put back under the clip.
  v1._clips = pieces(v1); a1._clips = pieces(a1).filter((c, i) => i === 0 || i > 2);
  assert.ok(call("PD.restoreMulticam(" + q({ track: 0, startSec: 0, endSec: 40 }) + ")").ok);
  assert.deepEqual(span(a1), [[0, 30, 4], [30, 40, 44], [40, 50, 0]]);
  assert.match(call("PD.restoreMulticam(" + q({ sequenceID: "other", track: 0, startSec: 0, endSec: 40 }) + ")").error, /Open the multicam sequence/);
});
