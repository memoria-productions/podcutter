/*
 * Edit review on the transcript: production breakdowns (talk about the show instead of the topic), leaks,
 * small trims and intentional structure. Checked against Classical et cetera #245, where a hand review found the
 * breakdown at 32:20–39:04 (published timing; the raw recording runs within a few seconds of it).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const T = require("../engine/transcript.js");

const NAMES = ["Martin", "Tanya", "Jessica", "Paul", "Kyle"];
const ce245 = () => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ce245.json"), "utf8")).segments;
const mmss = (m, s) => m * 60 + s;
const near = (v, t, tol, what) => assert.ok(Math.abs(v - t) <= tol, what + ": " + T.formatTime(v) + ", expected about " + T.formatTime(t));

test("#245: the breakdown runs from 'Can we take a time out?' to the clean restart 'Okay, so Kyle…'", () => {
  const r = T.analyze(ce245(), { showName: "Classical et cetera", names: NAMES });
  const b = r.suggestions.filter((s) => s.type === "breakdown");
  assert.strictEqual(b.length, 1, "one breakdown, not scattered moments");
  const bd = b[0];
  assert.strictEqual(bd.tier, "major");
  near(bd.startSec, mmss(32, 20), 4, "starts at the time out");
  near(bd.endSec, mmss(39, 4), 4, "ends at the restart");
  assert.match(bd.restart.text, /^Okay, so Kyle/);
  assert.match(bd.timeline[0].text, /time out/);
  assert.ok(bd.timeline.some((t) => /recording/.test(t.text)), "'are we still recording?' is on the timeline");
  // The join reads as one conversation: the last on-topic line, then the restart.
  assert.match(bd.joinBefore, /build beauty somewhere/);
  assert.match(bd.joinAfter, /^Okay, so Kyle/);
  // Surgical option: the passages the hand review kept, ticked; leaks are never inside a keep.
  const on = bd.keeps.filter((k) => k.on);
  assert.strictEqual(on.length, 2);
  assert.ok(on.some((k) => k.startSec <= mmss(34, 56) && k.endSec >= mmss(35, 20)), "keeps 34:54–35:23");
  assert.ok(on.some((k) => k.startSec <= mmss(37, 42) && k.endSec >= mmss(38, 40)), "keeps 37:39–38:41");
  assert.ok(bd.leaks.some((l) => /Tanya very much wants me to talk about/.test(l.reason)), "producer ask is a leak");
  assert.ok(bd.leaks.some((l) => /following what's been going on with the guides/.test(l.reason)), "internal guide talk is a leak");
  bd.leaks.forEach((l) => bd.keeps.forEach((k) => assert.ok(l.endSec <= k.startSec || l.startSec >= k.endSec, "leak inside a keep")));
  // What the cut drops is covered again later.
  const g = bd.elsewhere.find((e) => e.phrase === "guides");
  assert.ok(g && g.at.some((t) => Math.abs(t - mmss(40, 50)) < 10), "the lit guides come up again near 40:50");
});

test("#245: small trims — the self-correction near 1:10 and the dead handoff near 49:35", () => {
  const r = T.analyze(ce245(), { names: NAMES });
  const sc = r.suggestions.find((s) => s.type === "self-correction");
  assert.ok(sc && sc.startSec > mmss(1, 5) && sc.endSec < mmss(1, 25), "self-correction: " + (sc && T.formatTime(sc.startSec)));
  assert.match(sc.reason, /I haven't made any/);
  const dh = r.suggestions.find((s) => s.type === "dead-handoff");
  assert.ok(dh && dh.startSec > mmss(49, 25) && dh.endSec < mmss(49, 50), "dead handoff: " + (dh && T.formatTime(dh.startSec)));
  assert.strictEqual(dh.tier, "trim");
});

test("#244 has no breakdown: the Narnia tangent stays an asked-for cut", () => {
  const segs = T.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ce244.txt"), "utf8"), { fps: 24 });
  const r = T.analyze(segs, { names: NAMES });
  assert.ok(!r.suggestions.some((s) => s.type === "breakdown" || s.type === "leak"), r.suggestions.map((s) => s.type + "@" + T.formatTime(s.startSec)).join(", "));
});

function seg(start, end, text) { return { startSec: start, endSec: end, text: text }; }

test("one stray 'are we recording?' or a single time out is not a breakdown", () => {
  const segs = [
    seg(0, 8, "Today we're talking about the Iliad and how we teach it to seventh graders."),
    seg(8, 12, "Are we recording? Yes."),
    seg(12, 30, "Great. So the first thing about Homer is the way the epithets carry the oral tradition forward."),
    seg(300, 304, "Let's take a time out for a second, I want to think about that."),
    seg(304, 330, "The shield of Achilles is the whole world in miniature, and students see that once you slow down.")
  ];
  assert.ok(!T.analyze(segs).suggestions.some((s) => s.type === "breakdown"));
});

test("a producer ask outside any breakdown is still flagged on its own", () => {
  const segs = [
    seg(0, 10, "So the Odyssey is really about homecoming in every sense."),
    seg(10, 16, "Oh, and Sarah really wants me to mention the new catalog."),
    seg(16, 30, "Anyway, Odysseus spends ten years trying to get back to Ithaca.")
  ];
  const leak = T.analyze(segs).suggestions.find((s) => s.type === "leak");
  assert.ok(leak, "leak flagged");
  assert.strictEqual(leak.tier, "major");
  assert.ok(leak.startSec >= 9 && leak.endSec <= 17);
});

test("a punctuated dead handoff: the question, then 'Nope.'", () => {
  const segs = [
    seg(0, 10, "That's a great point about Virgil and the founding of Rome."),
    seg(10.2, 12, "Any final thoughts, Paul?"),
    seg(12.3, 12.8, "Nope."),
    seg(13.2, 25, "Well, thank you all for a wonderful discussion today.")
  ];
  const dh = T.analyze(segs, { names: ["Paul"] }).suggestions.find((s) => s.type === "dead-handoff");
  assert.ok(dh && dh.startSec < 10.5 && dh.endSec > 12.6 && dh.endSec < 13.2);
});

test("a cold open that repeats a later exchange is a note, not a cut", () => {
  const topics = ["Homer", "Virgil", "Dante", "Milton", "Austen", "Dickens", "Tolkien", "Lewis", "Bunyan", "Spenser", "Chaucer", "Plutarch",
    "Herodotus", "Sophocles", "Aeschylus", "Euripides", "Ovid", "Horace", "Cicero", "Livy", "Tacitus", "Boethius", "Augustine", "Aquinas", "Pascal"];
  let t = 0;
  const filler = (a, n) => Array.from({ length: n }, (_, i) => seg(a + i * 10, a + i * 10 + 9.5, topics[t++ % topics.length] + " wrote for readers in " + (1000 + 37 * t) + "."));
  const segs = [seg(2, 12, "If you don't read it slowly you'll never find the heart of the story.")]
    .concat(filler(20, 20))
    .concat([seg(400, 410, "And I tell my students, if you don't read it slowly you'll never find the heart of the story.")])
    .concat(filler(420, 5));
  const r = T.analyze(segs);
  assert.strictEqual(r.notes.length, 1);
  assert.strictEqual(r.notes[0].type, "cold-open");
  assert.ok(r.notes[0].matchStartSec >= 400 && r.notes[0].matchStartSec < 411);
  assert.ok(!r.suggestions.some((s) => s.startSec < 12), "the teaser isn't suggested as a cut");
});
