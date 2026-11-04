/*
 * PodCutter — multicam by keystrokes (experimental, Windows).
 *
 * Premiere has no scripting call to switch a multicam angle, but its "Cut to Camera N" command does it from the
 * keyboard: with the playhead parked on a multicam clip it cuts there and switches to camera N. This module reads
 * the user's keyboard shortcuts (.kys) to find those keys, and sends them to Premiere through a small PowerShell
 * helper that only types while Premiere is the window in front.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodKeys = api;
  else if (root) root.PodKeys = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var req = typeof require === "function" ? require : null;
  var fs = req && req("fs"), path = req && req("path"), cp = req && req("child_process");

  // .kys virtual keys: printable keys are their character with the top bit set (0x80000031 = "1");
  // other values are Premiere's own codes for arrows, function keys and so on.
  var CHAR_FLAG = 0x80000000;

  /** Parse a .kys file: { commandName: [{ key: "1" | null, code, ctrl, alt, shift, context }] } */
  function parseShortcuts(xml) {
    var out = {}, context = "";
    var re = /<context\.([^\s>]+)[^>]*>|<item\.\d+[^>]*>([\s\S]*?)<\/item\.\d+>/g, m;
    while ((m = re.exec(String(xml)))) {
      if (m[1]) { context = m[1]; continue; }
      var body = m[2];
      var cmd = /<commandname>([^<]+)<\/commandname>/.exec(body), vk = /<virtualkey>(\d+)<\/virtualkey>/.exec(body);
      if (!cmd || !vk) continue;
      var v = Number(vk[1]), isChar = v >= CHAR_FLAG;
      var flag = function (name) { return new RegExp("<modifier\\." + name + ">true<").test(body); };
      (out[cmd[1]] = out[cmd[1]] || []).push({
        key: isChar ? String.fromCharCode(v - CHAR_FLAG) : null, code: isChar ? v - CHAR_FLAG : v,
        ctrl: flag("ctrl"), alt: flag("alt"), shift: flag("shift"), context: context
      });
    }
    return out;
  }

  /** "Ctrl+Alt+1" */
  function describe(k) {
    return (k.ctrl ? "Ctrl+" : "") + (k.alt ? "Alt+" : "") + (k.shift ? "Shift+" : "") + (k.key !== null ? k.key.toUpperCase() : "key #" + k.code);
  }

  /** A command's Timeline (or global) keys: { keys: [..], usable, label }; usable = a printable key we can type. */
  function commandKey(shortcuts, cmd) {
    var keys = (shortcuts[cmd] || []).filter(function (k) { return k.context === "global" || k.context === "timeline"; });
    var usable = keys.filter(function (k) { return k.key !== null; })[0] || null;
    return { keys: keys, usable: usable, label: usable ? describe(usable) : keys.length ? describe(keys[0]) : null };
  }

  /** The keys for "Cut to Camera 1..n": [{ camera, keys: [..], usable, label }]. */
  function cutToCameraKeys(shortcuts, n) {
    var res = [];
    for (var i = 1; i <= (n || 4); i++) {
      var k = commandKey(shortcuts, "cmd.multicam.choose.camera." + i);
      k.camera = i; res.push(k);
    }
    return res;
  }

  /** Premiere's label colours in Edit > Label order; index n is the command cmd.edit.label.n. */
  var LABELS = ["Violet", "Iris", "Caribbean", "Lavender", "Cerulean", "Forest", "Rose", "Mango",
                "Purple", "Blue", "Teal", "Magenta", "Tan", "Green", "Brown", "Yellow"];
  function labelKey(shortcuts, index) { return commandKey(shortcuts, "cmd.edit.label." + index); }

  /**
   * Where Windows really keeps Documents. Folder redirection (e.g. to a network share) moves it away from
   * %USERPROFILE%\Documents, and Premiere follows the redirect.
   */
  // Asked once per session: reg.exe is a process launch, and the panel looks up shortcuts on every redraw.
  var redirectedDocs;
  function documentsFolders(extra) {
    var list = [].concat(extra || []);
    if (process.platform === "win32") {
      if (redirectedDocs === undefined) {
        redirectedDocs = null;
        try {
          var out = cp.execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders" /v Personal',
            { encoding: "utf8", windowsHide: true, timeout: 5000 });
          var m = /Personal\s+REG_\w+\s+(.+)/.exec(out);
          if (m) redirectedDocs = m[1].trim();
        } catch (e) { /* fall back to the usual places */ }
      }
      if (redirectedDocs) list.unshift(redirectedDocs);
    }
    if (process.env.USERPROFILE) list.push(path.join(process.env.USERPROFILE, "Documents"));
    return list.filter(function (d, i) { return d && list.indexOf(d) === i; });
  }

  /**
   * Premiere's keyboard shortcut files, newest first, from Adobe\Premiere Pro\<version>\Profile-*\Win in each of
   * the given Documents folders (or, by default, wherever Windows keeps Documents).
   */
  function findShortcutFiles(documentsDirs) {
    var files = [];
    documentsFolders(documentsDirs).forEach(function (d) { files = files.concat(shortcutFilesIn(d)); });
    return files.sort(function (a, b) { return b.mtime - a.mtime; });
  }
  function shortcutFilesIn(documentsDir) {
    var base = path.join(documentsDir, "Adobe", "Premiere Pro"), files = [];
    try {
      fs.readdirSync(base).forEach(function (ver) {
        var vdir = path.join(base, ver);
        try {
          fs.readdirSync(vdir).filter(function (p) { return /^Profile-/.test(p); }).forEach(function (prof) {
            var win = path.join(vdir, prof, "Win");
            try {
              fs.readdirSync(win).filter(function (f) { return /\.kys$/i.test(f); }).forEach(function (f) {
                var full = path.join(win, f);
                files.push({ path: full, version: ver, mtime: fs.statSync(full).mtimeMs });
              });
            } catch (e) { /* no Win folder */ }
          });
        } catch (e) { /* not a folder */ }
      });
    } catch (e) { /* no Premiere settings here */ }
    return files;
  }

  // The helper: reads commands on stdin, one per line.
  //   FG                        -> the title of the window in front
  //   KEY <charCode> <c> <a> <s> -> types that key with modifiers (1/0), only if Premiere is in front;
  //                                answers OK, NOFOCUS <title>, or BADKEY
  var HELPER = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type @'",
    "using System; using System.Runtime.InteropServices; using System.Text;",
    "public static class PdKeys {",
    "  [DllImport(\"user32.dll\")] static extern IntPtr GetForegroundWindow();",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char c);",
    "  [DllImport(\"user32.dll\")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);",
    "  public static string Front() { var s = new StringBuilder(512); GetWindowText(GetForegroundWindow(), s, 512); return s.ToString(); }",
    "  static void Tap(byte vk, bool down) { keybd_event(vk, 0, down ? 0u : 2u, UIntPtr.Zero); }",
    "  public static bool Send(char c, bool ctrl, bool alt, bool shift) {",
    "    short r = VkKeyScan(c); if (r == -1) return false;",
    "    byte vk = (byte)(r & 0xff);",
    "    if (ctrl) Tap(0x11, true); if (alt) Tap(0x12, true); if (shift) Tap(0x10, true);",
    "    Tap(vk, true); System.Threading.Thread.Sleep(15); Tap(vk, false);",
    "    if (shift) Tap(0x10, false); if (alt) Tap(0x12, false); if (ctrl) Tap(0x11, false);",
    "    return true;",
    "  }",
    "}",
    "'@",
    "[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()",
    "while ($true) {",
    "  $line = [Console]::In.ReadLine(); if ($line -eq $null -or $line -eq 'QUIT') { break }",
    "  $p = $line.Split(' ')",
    "  if ($p[0] -eq 'FG') { [Console]::Out.WriteLine('FG ' + [PdKeys]::Front()) }",
    "  elseif ($p[0] -eq 'KEY') {",
    "    $t = [PdKeys]::Front()",
    "    if ($t -notlike '*Adobe Premiere Pro*') { [Console]::Out.WriteLine('NOFOCUS ' + $t) }",
    "    elseif ([PdKeys]::Send([char][int]$p[1], $p[2] -eq '1', $p[3] -eq '1', $p[4] -eq '1')) { [Console]::Out.WriteLine('OK') }",
    "    else { [Console]::Out.WriteLine('BADKEY') }",
    "  }",
    "  [Console]::Out.Flush()",
    "}"
  ].join("\r\n");

  /** Start the helper. Resolves { send(key) -> Promise<reply>, front() -> Promise<title>, close() }. */
  function startSender() {
    if (process.platform !== "win32") return Promise.reject(new Error("Sending keystrokes is only available on Windows."));
    var encoded = Buffer.from(HELPER, "utf16le").toString("base64");
    var p = cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    var buf = "", waiting = [], err = "";
    p.stdout.on("data", function (d) {
      buf += d;
      var i;
      while ((i = buf.indexOf("\n")) >= 0) {
        var line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        var w = waiting.shift(); if (w) w(line);
      }
    });
    p.stderr.on("data", function (d) { err += d; });
    function ask(cmd) {
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { reject(new Error("The keystroke helper stopped answering. " + err.slice(0, 200))); }, 5000);
        waiting.push(function (line) { clearTimeout(t); resolve(line); });
        p.stdin.write(cmd + "\n");
      });
    }
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error("The keystroke helper didn't start. " + err.slice(0, 300))); }, 15000);
      waiting.push(function (line) {
        clearTimeout(t);
        if (line !== "READY") return reject(new Error("Unexpected reply from the keystroke helper: " + line));
        resolve({
          front: function () { return ask("FG").then(function (l) { return l.replace(/^FG /, ""); }); },
          send: function (k) { return ask(["KEY", k.key.charCodeAt(0), k.ctrl ? 1 : 0, k.alt ? 1 : 0, k.shift ? 1 : 0].join(" ")); },
          close: function () { try { p.stdin.write("QUIT\n"); p.stdin.end(); } catch (e) { /* already gone */ } }
        });
      });
      p.on("error", function (e) { clearTimeout(t); reject(e); });
    });
  }

  return { parseShortcuts: parseShortcuts, cutToCameraKeys: cutToCameraKeys, commandKey: commandKey, labelKey: labelKey, LABELS: LABELS, describe: describe,
           findShortcutFiles: findShortcutFiles, documentsFolders: documentsFolders, startSender: startSender };
});
