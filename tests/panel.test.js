/*
 * The panel scripts loaded the way Premiere loads them (Node available), against a stub DOM: startup has to
 * finish and Scan has to work before any sequence has been scanned. v0.21.0–0.21.3 threw at startup (the label
 * note read the cameras before there was a config) and then left every button stuck on busy at Scan.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");

const CLIENT = path.join(__dirname, "..", "client");

/** An element (or anything) that accepts every property and call; set properties read back. */
function stub(name) {
  const props = {};
  const classes = new Set();
  let self;
  const target = function () {};
  self = new Proxy(target, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => (p in props ? props[p] : "");
      if (p === Symbol.iterator) return function* () {};
      if (p in props) return props[p];
      if (p === "classList") return { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
        toggle: (c, on) => { on = on === undefined ? !classes.has(c) : on; on ? classes.add(c) : classes.delete(c); return on; } };
      if (p === "textContent" || p === "innerHTML" || p === "value" || p === "className") return "";
      if (p === "length") return 0;
      if (p === "checked" || p === "disabled") return false;
      if (p === "dataset" || p === "style") return (props[p] = stub(name + "." + String(p)));
      if (p === "then") return undefined; // not a promise
      return stub(name + "." + String(p));
    },
    set(t, p, v) { props[p] = v; return true; },
    apply() { return stub(name + "()"); }
  });
  return self;
}

function loadPanel(docsHome) {
  const els = {};
  const store = {};
  const errors = [];
  const document = stub("document");
  const doc = new Proxy(document, {
    get(t, p) {
      if (p === "getElementById") return (id) => els[id] || (els[id] = stub("#" + id));
      if (p === "createElement" || p === "createElementNS") return (tag) => stub("<" + tag + ">");
      if (p === "createTextNode") return (s) => stub("text");
      return t[p];
    }
  });
  const timers = [];
  const window = {
    document: doc,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    addEventListener() {}, removeEventListener() {},
    devicePixelRatio: 1, console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")) },
    requestAnimationFrame: () => 0, ResizeObserver: undefined
  };
  window.window = window;
  window.self = window;
  const ctx = {
    window, self: window, document: doc, localStorage: window.localStorage, console: window.console,
    navigator: { userAgent: "node" }, location: { reload() {} },
    // Only short timers run (debounced redraws); the update check and intervals don't.
    setTimeout: (fn, ms) => { if ((ms || 0) <= 500) timers.push(fn); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    CSInterface: function () { this.evalScript = () => {}; this.getSystemPath = () => ""; this.addEventListener = () => {}; },
    require: (m) => (m === "os" ? Object.assign({}, os, { homedir: () => docsHome }) : require(m)),
    process, Buffer, __dirname: CLIENT, module: undefined,
    Promise, JSON, Math, Date, Array, Object, String, Number, RegExp, Error, TypeError, Float32Array, Uint8Array, Int16Array, Map, Set, Symbol
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const files = ["../engine/director.js", "../engine/transcript.js", "../engine/analyzer.js", "../engine/transcriber.js", "../engine/motion.js",
    "../engine/framing.js", "../engine/updater.js", "../engine/keys.js", "ui-config.js", "demo.js", "viz.js", "panel.js"];
  for (const f of files) {
    const file = path.join(CLIENT, f);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  }
  const flush = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setImmediate(r)); while (timers.length) { try { timers.shift()(); } catch (e) { errors.push(String(e)); } } } };
  return { els, errors, flush };
}

test("panel starts and scans with Node available, before any sequence is scanned", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-panel-"));
  let p;
  assert.doesNotThrow(() => { p = loadPanel(home); }, "startup threw");
  assert.ok(typeof p.els.btnScan.onclick === "function", "startup didn't get as far as wiring Scan");
  p.els.btnScan.onclick();
  await p.flush();
  // (The status line can be taken over by the startup ffmpeg lookup, so check what Scan itself fills in.)
  assert.match(String(p.els.seqLabel.textContent), /fps/, "Scan didn't read the sequence: " + p.els.statusText.textContent);
  assert.strictEqual(p.els.btnScan.disabled, false, "Scan left the panel busy");
  assert.deepStrictEqual(p.errors, []);
});
