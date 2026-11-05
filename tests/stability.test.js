"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../engine/director.js");
const { makeCurves } = require("./synth.js");

const HOP = 1 / 6;
const speakers = [{ id: "A", name: "Host" }, { id: "B", name: "Guest" }];
const at = (r, t) => r.shots.find((s) => s.startSec <= t && s.endSec > t);

/** Motion curve (% frame width/s): [start, end, value] segments over a steady (0) baseline. */
function motion(duration, moves) {
  const v = new Float32Array(Math.ceil(duration / HOP)).fill(0);
  moves.forEach(([a, b, x]) => { for (let i = Math.round(a / HOP); i < Math.round(b / HOP); i++) v[i] = x; });
  return { hopSec: HOP, values: v };
}

const talk = () => makeCurves([["A", 1, 12], ["B", 12.4, 25], ["A", 25.5, 40]], { durationSec: 42 });
const base = { openOnWideSec: 0, interjectionMode: "ignore", maxShotSec: 0, wideAfterSilenceSec: 0, minWideSec: 0 };

test("follow cam: cuts to wide while the operator re-frames, back once settled", () => {
  const input = talk();
  input.cameraMotion = { F: motion(42, [[12.2, 13.6, 15], [25.6, 27, 12]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: base });
  assert.equal(at(r, 6).cameraId, "F");
  assert.equal(at(r, 12.8).cameraId, "W", "operator is moving");
  assert.equal(at(r, 13.9).cameraId, "W", "still settling");
  assert.equal(at(r, 16).cameraId, "F", "settled on the guest");
  assert.equal(at(r, 26).cameraId, "W");
  assert.equal(at(r, 30).cameraId, "F");
  assert.equal(at(r, 12.8).reason, "camera-move");
  assert.ok(r.stability.F.fastPct > 0);
});

test("a moving camera with no footage to measure is flagged noFootage, not plain-background lowDetail", () => {
  const input = talk();
  input.cameraMotion = { F: { hopSec: HOP, values: new Float32Array(Math.ceil(42 / HOP)).fill(NaN) } }; // empty track
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: base });
  assert.equal(r.stability.F.noFootage, true);
  assert.equal(r.stability.F.lowDetail, false);
  const real = D.plan(Object.assign(talk(), { cameraMotion: { F: motion(42, [[12.2, 13.6, 15]]) } }), { speakers, cameras, style: base });
  assert.equal(real.stability.F.noFootage, false);
});

test("cameraMoves lists the moving stretches in sequence time, big or slow", () => {
  const input = talk();
  input.cameraMotion = { F: motion(42, [[12.2, 13.6, 15], [20, 22, 3], [30, 30.1, 20]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: base });
  const moves = D.cameraMoves(r, "F");
  assert.equal(moves.length, 2, JSON.stringify(moves)); // the 0.1 s glitch at 30 s is too short to keep
  assert.equal(moves[0].kind, "big");
  assert.ok(Math.abs(moves[0].startSec - 12.2) < 0.4 && Math.abs(moves[0].endSec - 13.6) < 0.4, JSON.stringify(moves[0]));
  assert.equal(moves[1].kind, "slow");
  // Range plans: stability carries its offset, so moves come back in sequence time.
  const ranged = D.planRange(input, { speakers, cameras, style: base }, 10, 40);
  const rm = D.cameraMoves(ranged, "F");
  assert.ok(Math.abs(rm[0].startSec - 12.2) < 0.4, JSON.stringify(rm[0]));
  assert.deepEqual(D.cameraMoves(r, "W"), [], "not a moving camera");
});

test("banter: between two quick moves the cut stays on the wide instead of flicking back to the dolly", () => {
  const input = talk();
  // Two re-frames 3.5 s apart (operator swinging between people): about 2.5 s usable in between.
  input.cameraMotion = { F: motion(42, [[12.2, 13.4, 15], [16.9, 18, 15]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: base });
  assert.equal(at(r, 15.5).cameraId, "W", "a short steady gap between moves stays wide");
  assert.equal(at(r, 21).cameraId, "F", "back on the dolly once it has settled for good");
  const flicker = D.plan(input, { speakers, cameras, style: Object.assign({}, base, { comeBackSec: 0 }) });
  assert.equal(at(flicker, 15.5).cameraId, "F", "with Come back after = 0 it flicks back in the gap, as before");
});

test("a reaction on the dolly that isn't steady throughout goes to the wide", () => {
  const input = makeCurves([["A", 1, 30], ["B", 15, 15.8]], { durationSec: 32 }); // B laughs during A's turn
  input.cameraMotion = { F: motion(32, [[15.2, 15.6, 12]]) }; // the operator swings onto B mid-laugh
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "A", videoTrack: 2, shows: ["A"] },
    { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const framing = { F: [{ startSec: 0, endSec: 32, speakerId: "B" }] }; // dolly framed on the listener
  const r = D.plan(Object.assign(input, { framing }), { speakers, cameras,
    style: Object.assign({}, base, { interjectionMode: "reaction", interjectionChance: 1 }) });
  const during = r.shots.filter((s) => s.endSec > 15 && s.startSec < 16).map((s) => s.cameraId);
  assert.ok(!during.includes("F"), "no shaky reaction on the dolly: " + JSON.stringify(during));
});

test("a late cut timing never delays a cut to the wide (it's the safety shot)", () => {
  const input = makeCurves([["A", 1, 12], ["B", 8, 12.4], ["B", 12.4, 25]], { durationSec: 27 }); // overlap 8-12 goes wide
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "cA", videoTrack: 1, shows: ["A"] }, { id: "cB", videoTrack: 2, shows: ["B"] }];
  const st = { openOnWideSec: 0, interjectionMode: "ignore", maxShotSec: 0, minWideSec: 0 };
  const early = D.plan(input, { speakers, cameras, style: Object.assign({ cutTimingSec: 0 }, st) });
  const late = D.plan(input, { speakers, cameras, style: Object.assign({ cutTimingSec: 0.5 }, st) });
  const wideStart = (r) => r.shots.find((s) => s.cameraId === "W").startSec;
  assert.equal(wideStart(late), wideStart(early), "late timing leaves the cut to the wide where it was");
});

test("without motion analysis the same follow cam is used straight through", () => {
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(talk(), { speakers, cameras, style: base });
  assert.equal(at(r, 12.8).cameraId, "F");
});

test("cutting to a dolly close-up waits (holding the previous shot) until it settles", () => {
  const input = talk();
  input.cameraMotion = { B: motion(42, [[11.8, 13.0, 10]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "A", videoTrack: 1, shows: ["A"] },
    { id: "B", videoTrack: 2, shows: ["B"], moving: true }];
  const r = D.plan(input, { speakers, cameras, style: base });
  assert.equal(at(r, 12.9).cameraId, "A", "held on the host while the guest cam finished its move");
  assert.equal(at(r, 14).cameraId, "B");
  const cutIn = r.shots.find((s) => s.cameraId === "B").startSec;
  assert.ok(cutIn >= 13.5 && cutIn <= 13.8, "cut in after settleSec, got " + cutIn);
});

test("slow push-ins stay on air unless slowMovesOnAir is off; fast moves never do", () => {
  const input = talk();
  input.cameraMotion = { F: motion(42, [[31, 35, 3], [37, 38, 20]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const on = D.plan(input, { speakers, cameras, style: Object.assign({ slowMovesOnAir: true }, base) });
  assert.equal(at(on, 33).cameraId, "F");
  assert.equal(at(on, 37.5).cameraId, "W");
  const off = D.plan(input, { speakers, cameras, style: Object.assign({ slowMovesOnAir: false }, base) });
  assert.equal(at(off, 33).cameraId, "W");
});

test("minimum-shot cleanup never puts a moving camera back on air", () => {
  const input = talk();
  // A short whip (0.5 s) inside a long shot: the wide cutaway is short, but must survive.
  input.cameraMotion = { F: motion(42, [[18, 18.5, 30]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: Object.assign({}, base, { minShotSec: 3 }) });
  assert.equal(at(r, 18.2).cameraId, "W");
});

test("follow cams are never used as listener reactions", () => {
  const input = makeCurves([["A", 1, 30], ["B", 12, 12.6]], { durationSec: 32 });
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true }];
  const r = D.plan(input, { speakers, cameras, style: { openOnWideSec: 0, interjectionMode: "reaction", interjectionChance: 1, maxShotSec: 10, cutawayMode: "reaction" } });
  assert.ok(!r.shots.some((s) => s.reason === "reaction"), "no reaction shot on a follow cam");
  assert.ok(r.shots.filter((s) => s.reason === "cutaway").every((s) => s.cameraId === "W"));
});

test("unreadable stretches: treated as moving on a readable camera, ignored on a plain-backdrop camera", () => {
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const readable = talk();
  readable.cameraMotion = { F: motion(42, [[18, 21, NaN]]) };
  const r1 = D.plan(readable, { speakers, cameras, style: Object.assign({}, base, { slowMovesOnAir: false }) });
  assert.equal(at(r1, 19.5).cameraId, "W");
  const plain = talk();
  plain.cameraMotion = { F: motion(42, [[0, 5, NaN], [8, 42, NaN]]) }; // only a few seconds readable
  const r2 = D.plan(plain, { speakers, cameras, style: Object.assign({}, base, { slowMovesOnAir: false }) });
  assert.equal(at(r2, 19.5).cameraId, "F");
  assert.equal(r2.stability.F.lowDetail, true);
});

test("a wide forced by a dolly move stays up for the minimum wide length", () => {
  const input = talk();
  input.cameraMotion = { F: motion(42, [[12.2, 13.6, 15]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: Object.assign({}, base, { minWideSec: 5 }) });
  const w = at(r, 12.8);
  assert.equal(w.cameraId, "W");
  assert.ok(w.endSec - w.startSec >= 4.99, "wide lasts " + (w.endSec - w.startSec));
});

test("follow cam without a framing reading: still on the last person until the operator moves", () => {
  // Martin (A) talks to 30 s with the dolly on him; Tanya (B) talks 30-50 s, but the operator only swings to her at
  // 39-40 s. Then Martin again from 50.5 s, the operator swinging back at 52-53 s.
  const input = makeCurves([["A", 1, 30], ["B", 30.3, 50], ["A", 50.5, 75]], { durationSec: 76 });
  input.cameraMotion = { F: motion(76, [[0, 0.5, 15], [39, 40, 15], [52, 53, 15]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: base });
  assert.equal(at(r, 15).cameraId, "F", "on Martin while he talks");
  assert.equal(at(r, 33).cameraId, "W", "Tanya talks but the dolly is still on Martin: the wide");
  assert.equal(at(r, 45).cameraId, "F", "the dolly has moved to her");
  assert.equal(at(r, 51).cameraId, "W", "Martin again, dolly still on Tanya");
  assert.equal(at(r, 60).cameraId, "F");
  const off = D.plan(input, { speakers, cameras, style: Object.assign({ guessFraming: false }, base) });
  assert.equal(at(off, 33).cameraId, "F", "the old behaviour: the dolly counts as a close-up of whoever talks");
});

test("a content cut is covered by the dolly even when the operator moves it a few seconds later", () => {
  // The host talks on the wide (the dolly sits on the guest, listening). Content cut at 20 s; the dolly is steady
  // until 26 s, then moves. The cover is cut short before the move instead of dropped (the jump would show).
  const input = makeCurves([["A", 1, 40]], { durationSec: 42 });
  input.cameraMotion = { F: motion(42, [[0, 0.5, 20], [26, 28, 20], [35, 35.5, 20]]) };
  input.framing = { F: [{ startSec: 0.5, endSec: 26, speakerId: "B" }, { startSec: 28, endSec: 42, speakerId: "B" }] };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const style = Object.assign({}, base, { jumpCoverSec: 8, minShotSec: 4, checkFramingByAudio: false });
  const r = D.plan(input, { speakers, cameras, style, removals: [{ startSec: 20, endSec: 20, join: true }] });
  assert.equal(at(r, 19.9).cameraId, "W");
  const cover = at(r, 20.1);
  assert.equal(cover.cameraId, "F", "the listener's solo covers the cut");
  assert.equal(cover.reason, "jump-cover");
  assert.ok(cover.endSec <= 26 && cover.endSec >= 24, "and leaves the dolly just before it moves (" + cover.endSec + ")");
});

// Safe zones: an operated camera parked (still) on someone needs no settling; the settle rules only apply next to a move.
const followCams = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];

test("back to a speaker the dolly stayed parked on: straight to the solo; just arrived on them: the wide first", () => {
  const mk = (moves, framing) => Object.assign(makeCurves([["A", 1, 30], ["B", 30.5, 55], ["A", 55.5, 80]], { durationSec: 82 }),
    { cameraMotion: { F: motion(82, moves) }, framing: { F: framing } });
  const cfg = { speakers, cameras: followCams, preset: "handoff", style: { openOnWideSec: 0 } };
  const parked = D.plan(mk([], [{ startSec: 0, endSec: 82, speakerId: "A" }]), cfg);
  assert.equal(at(parked, 40).cameraId, "W", "B's turn: the dolly is on A");
  assert.equal(at(parked, 56.5).cameraId, "F", "A again: the dolly never left, cut straight back");
  const arrived = D.plan(mk([[54, 55, 15]], [{ startSec: 0, endSec: 54, speakerId: "B" }, { startSec: 55, endSec: 82, speakerId: "A" }]), cfg);
  assert.equal(at(arrived, 56.5).cameraId, "W", "the operator only just swung to A: still settling");
});

test("a wide over a quick overlap hands back early to a dolly parked on the speaker", () => {
  const mk = () => Object.assign(makeCurves([["A", 0.5, 50], ["B", 20, 22.5]], { durationSec: 52 }),
    { cameraMotion: { F: motion(52, []) }, framing: { F: [{ startSec: 0, endSec: 52, speakerId: "A" }] } });
  const style = Object.assign({}, base, { minWideSec: 9, minShotSec: 2, crosstalkMinSec: 0.5, asideSec: 0 });
  const wideAt = (r) => r.shots.find((s) => s.cameraId === "W" && s.startSec > 15);
  const full = wideAt(D.plan(mk(), { speakers, cameras: followCams, style: Object.assign({}, style, { parkedWideSec: 9 }) }));
  assert.ok(full && full.endSec - full.startSec >= 8.9, "without the safe zone: the full minimum wide " + JSON.stringify(full));
  const r = D.plan(mk(), { speakers, cameras: followCams, style: Object.assign({}, style, { parkedWideSec: 3 }) });
  const w = wideAt(r);
  assert.ok(w && w.endSec - w.startSec < 3.5 && w.endSec > 22.4, "parked on A: back to the dolly once B is done " + JSON.stringify(w));
  assert.equal(at(r, 24).cameraId, "F");
  // No motion readings: nothing is known to be parked, the minimum wide stands.
  const blind = mk(); delete blind.cameraMotion; delete blind.framing;
  const cams = [followCams[0], Object.assign({}, followCams[1], { moving: false })];
  const bw = wideAt(D.plan(blind, { speakers, cameras: cams, style: Object.assign({}, style, { parkedWideSec: 3 }) }));
  assert.ok(!bw || bw.endSec - bw.startSec >= 8.9, JSON.stringify(bw));
});
