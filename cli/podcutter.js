#!/usr/bin/env node
/*
 * PodCutter CLI — tune cuts offline from an exported analysis, or scan a transcript.
 *
 *   node cli/podcutter.js presets
 *   node cli/podcutter.js plan  <episode.podcutter.json> [--preset lively] [--set minShotSec=3 --set biasDb.S1=3]
 *                                 [--config cfg.json] [--compare calm,balanced,lively] [--out plan.json] [--shots]
 *   node cli/podcutter.js cleanup <transcript.srt|.vtt|.txt|.json> [--set minConfidence=0.5] [--csv cuts.csv] [--json]
 *
 * The analysis file comes from the panel: Multicam > "Export analysis for Claude".
 * Edited configs can be imported back into the panel from Settings > Import settings JSON.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const D = require("../engine/director.js");
const T = require("../engine/transcript.js");

function parseArgs(argv) {
  const out = { _: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") out.set.push(argv[++i]);
    else if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}
function value(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "auto") return null;
  return isFinite(+v) && v !== "" ? +v : v;
}

function applySets(config, sets) {
  sets.forEach((s) => {
    const eq = s.indexOf("=");
    if (eq < 0) throw new Error("--set expects key=value, got " + s);
    const key = s.slice(0, eq), v = value(s.slice(eq + 1));
    // Per-speaker: thresholdDb.S1=-40, biasDb.Host=3 (speaker id or name)
    const dot = key.indexOf(".");
    if (dot > 0) {
      const field = key.slice(0, dot), who = key.slice(dot + 1);
      const sp = config.speakers.find((x) => x.id === who || (x.name || "").toLowerCase() === who.toLowerCase());
      if (!sp) throw new Error("No speaker " + who);
      sp[field] = v;
    } else if (key === "preset") config.preset = v;
    else config.style[key] = v;
  });
}

function table(rows) {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  return rows.map((r) => r.map((v, c) => String(v).padEnd(w[c])).join("  ")).join("\n");
}

function cmdPlan(args) {
  const file = args._[1];
  if (!file) throw new Error("Usage: plan <analysis.json>");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.values(doc.input.cameraMotion || {}).forEach((m) => { m.values = m.values.map((v) => (v === null ? NaN : v)); });
  const base = JSON.parse(JSON.stringify(args.config ? JSON.parse(fs.readFileSync(args.config, "utf8")).config || JSON.parse(fs.readFileSync(args.config, "utf8")) : doc.config));
  base.style = base.style || {};
  if (args.preset) { base.preset = args.preset; base.style = {}; }
  applySets(base, args.set);
  const presets = args.compare ? String(args.compare).split(",") : [null];
  const rows = [["preset", "cuts", "cuts/min", "avg s", "median s", "longest s", "screen time"]];
  let last;
  presets.forEach((p) => {
    const cfg = JSON.parse(JSON.stringify(base));
    if (p) { cfg.preset = p; cfg.style = {}; applySets(cfg, args.set.filter((s) => !/^preset=/.test(s))); }
    const r = doc.range ? D.planRange(doc.input, cfg, doc.range.startSec, doc.range.endSec) : D.plan(doc.input, cfg);
    last = { config: cfg, result: r };
    const names = Object.fromEntries(cfg.cameras.map((c) => [c.id, c.name]));
    rows.push([cfg.preset + (Object.keys(cfg.style).length ? "*" : ""), r.stats.cuts, r.stats.cutsPerMinute, r.stats.avgShotSec,
      r.stats.medianShotSec, r.stats.longestShotSec,
      Object.entries(r.stats.screenTimePct).map(([k, v]) => names[k] + " " + v + "%").join(", ")]);
  });
  console.log(table(rows));
  console.log("\nCalibration:");
  last.result.calibration.forEach((c) => {
    const sp = last.config.speakers.find((s) => s.id === c.id);
    console.log(`  ${sp.name}: floor ${c.floorDb} dB, speech ${c.speechDb} dB, threshold ${c.thresholdDb} dB${sp.thresholdDb == null ? " (auto)" : ""}, talks ${last.result.stats.talkTimePct[c.id]}%`);
  });
  console.log("Reasons:", JSON.stringify(last.result.stats.reasons));
  if (args.shots) {
    const names = Object.fromEntries(last.config.cameras.map((c) => [c.id, c.name]));
    last.result.shots.forEach((s) => console.log(`  ${T.formatTime(s.startSec).padStart(9)} ${T.formatTime(s.endSec).padStart(9)}  ${names[s.cameraId]}  (${s.reason})`));
  }
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify({ config: last.config, result: last.result }, null, 2));
    console.log("\nWrote " + args.out + " (import its config in the panel: Settings > Import settings JSON)");
  }
}

function cmdCleanup(args) {
  const file = args._[1];
  if (!file) throw new Error("Usage: cleanup <transcript>");
  const segs = T.parse(fs.readFileSync(file, "utf8"), { fps: +args.fps || 30 });
  const opts = {};
  args.set.forEach((s) => { const [k, v] = s.split("="); opts[k] = value(v); });
  // People on mic, for "Okay, so Kyle, …" restarts and "Any thoughts, Paul?" handoffs: --names Martin,Tanya,Paul
  if (args.names) opts.names = String(args.names).split(",").map((n) => n.trim()).filter(Boolean);
  const r = T.analyze(segs, opts);
  if (args.json) { console.log(JSON.stringify(r, (k, v) => (k === "segments" ? undefined : v), 2)); return; }
  const F = T.formatTime;
  console.log(`${segs.length} transcript lines, ${r.suggestions.length} suggested cuts\n`);
  r.suggestions.forEach((s) => {
    console.log(`${s.id}  ${(s.tier || "").padEnd(5)}  ${F(s.startSec)} - ${F(s.endSec)}  [${s.type} ${Math.round(s.confidence * 100)}%]  ${s.reason}`);
    if (s.type === "breakdown") {
      s.timeline.forEach((t) => console.log(`      ${F(t.sec)}  ${t.kind.padEnd(9)} ${t.text}`));
      console.log("      restart: " + (s.restart ? F(s.restart.sec) + "  " + s.restart.text : "none found"));
      s.keeps.forEach((k) => console.log(`      keep${k.on ? "*" : " "} ${F(k.startSec)} - ${F(k.endSec)}  ${k.text.slice(0, 80)}`));
      (s.leaks || []).forEach((l) => console.log(`      always cut ${F(l.startSec)}  ${l.reason}`));
      s.elsewhere.forEach((e) => console.log(`      topic again: "${e.phrase}" at ${e.at.map(F).join(", ")}`));
    } else console.log("      " + s.text.slice(0, 200));
    console.log(`      join: "${s.joinBefore || "(start)"}" -> "${s.joinAfter || "(end)"}"`);
  });
  r.notes.forEach((n) => console.log(`\nnote: cold open ${F(n.startSec)} - ${F(n.endSec)} repeats ${F(n.matchStartSec)} - ${F(n.matchEndSec)}`));
  if (args.csv) { fs.writeFileSync(args.csv, T.toCsv(r.suggestions)); console.log("\nWrote " + args.csv); }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === "presets") {
    Object.entries(D.PRESETS).forEach(([k, p]) => console.log(k.padEnd(10), p.label, JSON.stringify(p.style)));
    console.log("\nDefaults:", JSON.stringify(D.DEFAULT_STYLE, null, 1));
  } else if (cmd === "plan") cmdPlan(args);
  else if (cmd === "cleanup") cmdCleanup(args);
  else {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 12).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
    process.exitCode = cmd ? 1 : 0;
  }
}

try { main(); } catch (e) { console.error("Error: " + e.message); process.exit(1); }
