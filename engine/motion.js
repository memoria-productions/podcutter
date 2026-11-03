/*
 * PodCutter — camera motion analyzer.
 *
 * Measures how much the *camera* moves (pan, tilt, dolly/push, zoom, shake),
 * not how much the people in frame move. Video is decoded by ffmpeg to tiny
 * grayscale frames (160x90 at 6 fps, from 320x180); each frame pair is block-matched
 * (coarse-to-fine), and a robust similarity model (translation + scale +
 * rotation) is fitted to the block vectors. Blocks that disagree with the
 * dominant motion — a gesturing guest, a nodding head — are rejected as
 * outliers, so subject motion doesn't count as camera motion.
 *
 * Output: a curve of camera motion in "% of frame width per second" (the
 * fastest-moving frame corner), one value per 1/6 s, in sequence time.
 * Unknown frames (black, featureless) are NaN. Results are cached on disk.
 *
 * Two finer readings fill in where neighbouring frames show nothing: frames a
 * second apart (a slow creep), and the whole picture's shift at 320x180 to a
 * few hundredths of a pixel (a knock on the dolly rail, 2-3 px at full size).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodMotion = api;
  else if (root) root.PodMotion = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var req = typeof require === "function" ? require : null;
  var cp = req && req("child_process");
  var fs = req && req("fs");
  var os = req && req("os");
  var path = req && req("path");
  var crypto = req && req("crypto");

  var W = 160, H = 90, FPS = 6, HOP = 1 / FPS;
  var HW = W >> 1, HH = H >> 1;
  var B = 16, HB = B >> 1;           // block size full / half res
  var R_HALF = 4;                    // coarse search radius (= ±8 px at full res)
  var MARGIN = 2 * R_HALF + 2;
  var CACHE_VERSION = 9;
  // Slow drift: frames 1/6 s apart can't see a creep under ~1.3 %/s (it rounds to zero), so frames a second
  // apart are compared too and the drift spread back per second (down to ~0.2 %/s).
  var LAG = FPS;
  // Jolts: a knock on the dolly rail shifts the picture 2-3 px at full size in one step, about 0.2 px here,
  // under the noise floor of the block matching above. Frames are decoded at twice the size and the whole
  // picture's shift is measured there too (consensus of many blocks: noise ~0.01-0.04 px, a jolt 0.15+).
  var FW = W * 2, FH = H * 2, JOLT_PX = 0.09, JOLT_PCT = 1.3; // a jolt reads as a slow move, at least
  // Ep 245 (dolly, 5 min): 3 jolts the coarse reading missed, no false ones; a static wide reads 0.01 px at most.
  // Small colour thumbnails (1 per second) for "who's in the shot" on operated cameras.
  var TW = 32, TH = 18, TSIZE = TW * TH * 3;

  // Block grid (top-left corners at full resolution).
  var BLOCKS = (function () {
    var cols = 8, rows = 5, out = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = Math.round(MARGIN + c * (W - 2 * MARGIN - B) / (cols - 1));
        var y = Math.round(MARGIN + r * (H - 2 * MARGIN - B) / (rows - 1));
        out.push({ x: x & ~1, y: y & ~1 });
      }
    }
    return out;
  })();

  function downsample(full) {
    var half = new Uint8Array(HW * HH);
    for (var y = 0; y < HH; y++) {
      for (var x = 0; x < HW; x++) {
        var i = (2 * y) * W + 2 * x;
        half[y * HW + x] = (full[i] + full[i + 1] + full[i + W] + full[i + W + 1] + 2) >> 2;
      }
    }
    return half;
  }

  function sad(a, b, stride, ax, ay, bx, by, size, limit) {
    var s = 0;
    for (var y = 0; y < size; y++) {
      var ia = (ay + y) * stride + ax, ib = (by + y) * stride + bx;
      for (var x = 0; x < size; x++) {
        var d = a[ia + x] - b[ib + x];
        s += d < 0 ? -d : d;
      }
      if (s >= limit) return s;
    }
    return s;
  }

  function blockStd(img, x0, y0) {
    var sum = 0, sq = 0, n = B * B;
    for (var y = 0; y < B; y++) for (var x = 0; x < B; x++) { var v = img[(y0 + y) * W + x0 + x]; sum += v; sq += v * v; }
    var m = sum / n;
    return Math.sqrt(Math.max(0, sq / n - m * m));
  }

  /** Motion vectors of each textured block from prev -> cur. */
  function blockVectors(prev, cur, prevHalf, curHalf) {
    var vecs = [];
    var lost = 0, textured = 0, ambiguous = 0;
    for (var k = 0; k < BLOCKS.length; k++) {
      var bx = BLOCKS[k].x, by = BLOCKS[k].y;
      if (blockStd(prev, bx, by) < 5) continue; // flat area: can't tell if it moved
      textured++;
      // Coarse search at half resolution.
      var hx = bx >> 1, hy = by >> 1, best = Infinity, cdx = 0, cdy = 0;
      for (var dy = -R_HALF; dy <= R_HALF; dy++) {
        for (var dx = -R_HALF; dx <= R_HALF; dx++) {
          var s = sad(prevHalf, curHalf, HW, hx, hy, hx + dx, hy + dy, HB, best);
          if (s < best || (s === best && dx * dx + dy * dy < cdx * cdx + cdy * cdy)) { best = s; cdx = dx; cdy = dy; }
        }
      }
      // Refine ±1 px at full resolution, keep the 3x3 cost surface for sub-pixel fit.
      var fx = 2 * cdx, fy = 2 * cdy, costs = [], bestF = Infinity, bfx = fx, bfy = fy;
      for (var ry = -1; ry <= 1; ry++) {
        for (var rx = -1; rx <= 1; rx++) {
          var tx = bx + fx + rx, ty = by + fy + ry;
          var c = (tx < 0 || ty < 0 || tx + B > W || ty + B > H) ? Infinity : sad(prev, cur, W, bx, by, tx, ty, B, Infinity);
          costs.push(c);
          if (c < bestF || (c === bestF && Math.abs(rx) + Math.abs(ry) < Math.abs(bfx - fx) + Math.abs(bfy - fy))) { bestF = c; bfx = fx + rx; bfy = fy + ry; }
        }
      }
      // Aperture problem: stripes or a single straight edge give no information along one axis
      // (the cost surface is flat that way). Skip such blocks.
      if (bfx === fx && bfy === fy) {
        var curvX = costs[3] + costs[5] - 2 * costs[4], curvY = costs[1] + costs[7] - 2 * costs[4];
        if (isFinite(curvX) && isFinite(curvY) && Math.min(curvX, curvY) < 0.08 * Math.max(curvX, curvY) + B) { ambiguous++; continue; }
      }
      var meanErr = bestF / (B * B);
      if (meanErr > 22) { lost++; continue; } // no good match: blur, occlusion, cut
      var sub = { x: 0, y: 0 };
      // Parabolic sub-pixel refinement when the best is the centre of the 3x3.
      if (bfx === fx && bfy === fy) {
        var l = costs[3], r = costs[5], u = costs[1], d = costs[7], m = costs[4];
        if (isFinite(l) && isFinite(r) && l + r - 2 * m > 0) sub.x = 0.5 * (l - r) / (l + r - 2 * m);
        if (isFinite(u) && isFinite(d) && u + d - 2 * m > 0) sub.y = 0.5 * (u - d) / (u + d - 2 * m);
      }
      vecs.push({ x: bx + B / 2 - W / 2, y: by + B / 2 - H / 2, dx: bfx + sub.x, dy: bfy + sub.y });
    }
    return { vecs: vecs, lost: lost, textured: textured };
  }

  /** Robust least-squares similarity fit: dx = tx + s*x - r*y, dy = ty + s*y + r*x. */
  function fitSimilarity(vecs) {
    var use = vecs.map(function () { return true; });
    var p = null;
    for (var iter = 0; iter < 4; iter++) {
      // Normal equations for [tx, ty, s, r].
      var A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], b = [0, 0, 0, 0], n = 0;
      for (var i = 0; i < vecs.length; i++) {
        if (!use[i]) continue;
        var v = vecs[i];
        var rows = [[1, 0, v.x, -v.y, v.dx], [0, 1, v.y, v.x, v.dy]];
        for (var q = 0; q < 2; q++) {
          var row = rows[q];
          for (var a = 0; a < 4; a++) { b[a] += row[a] * row[4]; for (var c = 0; c < 4; c++) A[a][c] += row[a] * row[c]; }
        }
        n++;
      }
      if (n < 5) return null;
      for (var d = 0; d < 4; d++) A[d][d] += 1e-6;
      p = solve4(A, b);
      if (!p) return null;
      // Reject outliers (local subject motion) and refit.
      var res = vecs.map(function (v) {
        var ex = p[0] + p[2] * v.x - p[3] * v.y - v.dx, ey = p[1] + p[2] * v.y + p[3] * v.x - v.dy;
        return Math.sqrt(ex * ex + ey * ey);
      });
      var sorted = res.filter(function (_, k) { return use[k]; }).sort(function (x, y) { return x - y; });
      var cut = Math.max(0.75, 2.5 * sorted[Math.floor(sorted.length / 2)]);
      var changed = false;
      for (i = 0; i < vecs.length; i++) { var keep = res[i] <= cut; if (keep !== use[i]) { use[i] = keep; changed = true; } }
      if (!changed) break;
    }
    var used = vecs.filter(function (_, k) { return use[k]; });
    return { tx: p[0], ty: p[1], s: p[2], r: p[3], inliers: used.length, used: used, total: vecs.length };
  }

  function solve4(A, b) {
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var c = 0; c < 4; c++) {
      var piv = c;
      for (var r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      for (r = 0; r < 4; r++) {
        if (r === c) continue;
        var f = M[r][c] / M[c][c];
        for (var k = c; k < 5; k++) M[r][k] -= f * M[c][k];
      }
    }
    return [M[0][4] / M[0][0], M[1][4] / M[1][1], M[2][4] / M[2][2], M[3][4] / M[3][3]];
  }

  var EDGE_X = W / 2 - MARGIN - B / 2 - 1, EDGE_Y = H / 2 - MARGIN - B / 2 - 1;
  /** Blocks on the outer ring of the grid count double: that's usually background. */
  function edgeScore(list) {
    var sc = 0;
    list.forEach(function (v) { sc += (Math.abs(v.x) >= EDGE_X || Math.abs(v.y) >= EDGE_Y) ? 2 : 1; });
    return sc;
  }
  function spans(list, fx, fy) {
    if (!list.length) return false;
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    list.forEach(function (v) { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); });
    return x1 - x0 >= fx * W && y1 - y0 >= fy * H;
  }

  /** Camera motion between two frames, in % of frame width per second. NaN = can't tell. */
  function frameMotion(prev, cur, prevHalf, curHalf) {
    var bv = blockVectors(prev, cur, prevHalf, curHalf);
    if (bv.textured < 6) return NaN;
    if (bv.lost > bv.textured * 0.6) return 100; // most of the picture changed: whip pan, blur or a cut
    var vecs = bv.vecs;
    // Two hypotheses: the still blocks are the background (camera steady, subject moving), or the
    // coherently moving blocks are the background (camera moving, maybe tracking a subject that stays
    // put in frame). The background is the group that owns more of the frame's edges.
    var still = vecs.filter(function (v) { return Math.abs(v.dx) <= 0.35 && Math.abs(v.dy) <= 0.35; });
    var moving = vecs.filter(function (v) { return !(Math.abs(v.dx) <= 0.35 && Math.abs(v.dy) <= 0.35); });
    var fit = moving.length >= 5 ? fitSimilarity(moving) : null;
    if (fit && fit.inliers < 5) fit = null;
    var stillScore = edgeScore(still), moveScore = fit ? edgeScore(fit.used) : 0;
    if (!fit || stillScore >= moveScore) {
      return still.length >= 4 && spans(still, 0.45, 0.3) ? 0 : NaN;
    }
    // Camera motion moves the whole frame: the agreeing blocks must span most of it.
    // Agreement only inside one region (a person on a plain wall) is ambiguous.
    if (!spans(fit.used, 0.55, 0.4)) return NaN;
    var worst = 0;
    [[W / 2, H / 2], [-W / 2, H / 2], [W / 2, -H / 2], [-W / 2, -H / 2]].forEach(function (c) {
      var vx = fit.tx + fit.s * c[0] - fit.r * c[1], vy = fit.ty + fit.s * c[1] + fit.r * c[0];
      worst = Math.max(worst, Math.sqrt(vx * vx + vy * vy));
    });
    // Ignore sub-pixel jitter from compression noise.
    worst = Math.max(0, worst - 0.15);
    return 100 * worst / W * FPS;
  }

  // ------------------------------------------------------------ decoding

  function cacheDir() {
    var d = path.join(os.tmpdir(), "poddirector-cache");
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
    return d;
  }
  function cacheKey(mediaPath, inSec, durSec) {
    var st = { mtimeMs: 0, size: 0 };
    try { st = fs.statSync(mediaPath); } catch (e) { /* ignore */ }
    return "motion-" + crypto.createHash("sha1").update([CACHE_VERSION, mediaPath, st.mtimeMs, st.size, inSec.toFixed(3), durSec.toFixed(3)].join("|")).digest("hex");
  }

  /**
   * Camera motion for a source range. Resolves Float32Array (one value per HOP).
   * opts: { ffmpegPath, onProgress(fraction) }
   */
  /** RGB frame -> luma (for motion) and, once a second, a 32x18 colour thumbnail. */
  function toGray(rgb) { return grayOf(rgb, W * H); }
  function grayOf(rgb, n) {
    var g = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 3) g[i] = (rgb[j] * 77 + rgb[j + 1] * 150 + rgb[j + 2] * 29) >> 8;
    return g;
  }
  /** FWxFH RGB -> WxH RGB (2x2 average, as ffmpeg's area scaling would give). */
  function halveRgb(big) {
    var out = new Uint8Array(W * H * 3);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) for (var c = 0; c < 3; c++) {
      var a = ((2 * y) * FW + 2 * x) * 3 + c, b = a + FW * 3;
      out[(y * W + x) * 3 + c] = (big[a] + big[a + 3] + big[b] + big[b + 3] + 2) >> 2;
    }
    return out;
  }

  /**
   * Shift of the whole picture between two FWxFH gray frames, to a few hundredths of a pixel: block matching
   * (±2 px, sub-pixel by parabola) on a grid of textured blocks, then the largest group of blocks agreeing
   * within 0.12 px (the background; people moving disagree). -> { d, dx, dy, support } or null.
   */
  var FB = 16, FR = 2, FSTEP = 16;
  function fineShift(a, b) {
    var vs = [];
    for (var by = FR + 2; by + FB + FR + 2 < FH; by += FSTEP) for (var bx = FR + 2; bx + FB + FR + 2 < FW; bx += FSTEP) {
      var v = fineBlock(a, b, bx, by);
      if (v) vs.push(v);
    }
    if (vs.length < 20) return null;
    var best = null;
    for (var i = 0; i < vs.length; i++) {
      var near = [];
      for (var k = 0; k < vs.length; k++) if (Math.abs(vs[k][0] - vs[i][0]) < 0.12 && Math.abs(vs[k][1] - vs[i][1]) < 0.12) near.push(vs[k]);
      if (!best || near.length > best.length) best = near;
    }
    if (best.length < vs.length * 0.3) return null; // no clear background
    var mx = 0, my = 0;
    best.forEach(function (u) { mx += u[0]; my += u[1]; });
    mx /= best.length; my /= best.length;
    return { d: Math.sqrt(mx * mx + my * my), dx: mx, dy: my, support: best.length / vs.length };
  }
  function fineBlock(a, b, bx, by) {
    var mean = 0, x, y;
    for (y = 0; y < FB; y++) for (x = 0; x < FB; x++) mean += a[(by + y) * FW + bx + x];
    mean /= FB * FB;
    var v = 0;
    for (y = 0; y < FB; y++) for (x = 0; x < FB; x++) { var d = a[(by + y) * FW + bx + x] - mean; v += d * d; }
    if (v / (FB * FB) < 60) return null; // flat: nothing to match
    var n = 2 * FR + 1, cost = new Float64Array(n * n), bdx = 0, bdy = 0, be = Infinity;
    for (var dy = -FR; dy <= FR; dy++) for (var dx = -FR; dx <= FR; dx++) {
      var e = 0;
      for (y = 0; y < FB; y++) {
        var ra = (by + y) * FW + bx, rb = (by + y + dy) * FW + bx + dx;
        for (x = 0; x < FB; x++) e += Math.abs(a[ra + x] - b[rb + x]);
      }
      cost[(dy + FR) * n + dx + FR] = e;
      if (e < be) { be = e; bdx = dx; bdy = dy; }
    }
    if (Math.abs(bdx) === FR || Math.abs(bdy) === FR) return null; // moved further than a jolt
    function c(dx, dy) { return cost[(dy + FR) * n + dx + FR]; }
    function para(m, z, p) { var den = m - 2 * z + p; return den > 0 ? 0.5 * (m - p) / den : 0; }
    return [bdx + para(c(bdx - 1, bdy), be, c(bdx + 1, bdy)), bdy + para(c(bdx, bdy - 1), be, c(bdx, bdy + 1))];
  }
  function thumbnail(rgb, out, offset) {
    var bx = W / TW, by = H / TH; // 5 x 5 source pixels per thumbnail pixel
    for (var ty = 0; ty < TH; ty++) for (var tx = 0; tx < TW; tx++) {
      var r = 0, g = 0, b = 0, n = 0;
      for (var y = ty * by; y < (ty + 1) * by; y++) for (var x = tx * bx; x < (tx + 1) * bx; x++) {
        var k = (y * W + x) * 3; r += rgb[k]; g += rgb[k + 1]; b += rgb[k + 2]; n++;
      }
      var o = offset + (ty * TW + tx) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }

  /** Resolves { values: Float32Array (motion per HOP), thumbs: Uint8Array (one TWxTH RGB thumbnail per second) } */
  function analyzeRange(mediaPath, inSec, durSec, opts) {
    opts = opts || {};
    var key = cacheKey(mediaPath, inSec, durSec);
    var file = path.join(cacheDir(), key + ".f32"), tfile = path.join(cacheDir(), key + ".thumbs");
    try {
      var buf = fs.readFileSync(file), tb = fs.readFileSync(tfile);
      return Promise.resolve({ values: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
        thumbs: new Uint8Array(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.byteLength)) });
    } catch (e) { /* not cached */ }

    var total = Math.ceil(durSec * FPS), seconds = Math.ceil(durSec);
    var out = new Float32Array(total).fill(NaN);
    var thumbs = new Uint8Array(seconds * TSIZE);
    var args = ["-hide_banner", "-nostats", "-loglevel", "error", "-hwaccel", "auto",
      "-ss", String(Math.max(0, inSec)), "-t", String(durSec), "-i", mediaPath,
      "-an", "-sn", "-dn", "-vf", "fps=" + FPS + ",scale=" + FW + ":" + FH + ":flags=area,format=rgb24",
      "-f", "rawvideo", "pipe:1"];
    return new Promise(function (resolve, reject) {
      var p = cp.spawn(opts.ffmpegPath || "ffmpeg", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      var frameSize = FW * FH * 3, pending = Buffer.alloc(0), idx = 0, prev = null, prevHalf = null, prevFine = null, err = "", hist = new Array(LAG);
      var jolts = [];
      p.stdout.on("data", function (chunk) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= frameSize) {
          var big = new Uint8Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + frameSize));
          pending = pending.slice(frameSize);
          var rgb = halveRgb(big), fine = grayOf(big, FW * FH);
          if (idx % FPS === 0 && idx / FPS < seconds) thumbnail(rgb, thumbs, (idx / FPS) * TSIZE);
          var cur = toGray(rgb);
          var curHalf = downsample(cur);
          if (prev && idx - 1 < total) out[idx - 1] = frameMotion(prev, cur, prevHalf, curHalf);
          // Where the coarse reading saw nothing, a small jolt of the whole picture.
          if (prevFine && idx - 1 < total && out[idx - 1] === 0) {
            var js = fineShift(prevFine, fine);
            if (js && js.d >= JOLT_PX) jolts.push([idx - 1, Math.max(JOLT_PCT, 100 * js.d / FW * FPS)]);
          }
          prevFine = fine;
          // The second-apart reading belongs to the middle of its window. It only counts where the short readings in
          // the window saw no move (zero at both ends, never two in a row: a creep can tick over a pixel now and
          // then), so a real move's own readings never spill half a second either side of it.
          var old = hist[idx % LAG], mid = idx - 1 - (LAG >> 1);
          var quiet = !!old && idx - 1 < total && out[idx - LAG] === 0 && out[idx - 1] === 0;
          for (var q = idx - LAG + 1; quiet && q < idx; q++) quiet = out[q] === 0 || out[q - 1] === 0;
          if (quiet && mid >= 0 && out[mid] === 0) {
            var slow = frameMotion(old.g, cur, old.h, curHalf);
            if (isFinite(slow) && slow < 100) out[mid] = slow / LAG;
          }
          hist[idx % LAG] = { g: cur, h: curHalf };
          prev = cur; prevHalf = curHalf; idx++;
          if (opts.onProgress && idx % 60 === 0) opts.onProgress(Math.min(1, idx / total));
        }
      });
      p.stderr.on("data", function (d) { if (err.length < 2000) err += d; });
      p.on("error", reject);
      p.on("close", function (code) {
        if (code !== 0 && idx === 0) return reject(new Error("ffmpeg could not read video " + mediaPath + ": " + err.trim()));
        if (idx > 1 && idx - 1 < total) out[idx - 1] = out[idx - 2]; // last frame has no successor
        // A jolt is one step; it covers its neighbours too, so the planner's smoothing (a median over ~0.8 s,
        // against one-frame glitches) keeps it and the cut leaves before it.
        jolts.forEach(function (j) {
          for (var k = Math.max(0, j[0] - 1); k <= Math.min(total - 1, j[0] + 1); k++) if (!(out[k] >= j[1])) out[k] = j[1];
        });
        try { fs.writeFileSync(file, Buffer.from(out.buffer)); fs.writeFileSync(tfile, Buffer.from(thumbs.buffer)); } catch (e) { /* ignore */ }
        resolve({ values: out, thumbs: thumbs });
      });
    });
  }

  /**
   * Stitch the clips of a camera's video track into one motion curve in sequence time.
   * track.clips: [{ startSec, endSec, inPointSec, mediaPath, speed? }]
   * Returns { hopSec, values: Float32Array }  (NaN where there's no clip or no reading)
   */
  function analyzeTrack(track, durationSec, opts) {
    opts = opts || {};
    var total = Math.ceil(durationSec * FPS), seconds = Math.ceil(durationSec);
    var curve = new Float32Array(total).fill(NaN);
    var thumbs = new Uint8Array(seconds * TSIZE), hasThumb = new Uint8Array(seconds);
    var clips = (track.clips || []).filter(function (c) { return c.mediaPath && c.endSec > c.startSec; })
      .sort(function (a, b) { return a.startSec - b.startSec; });
    var dur = clips.reduce(function (s, c) { return s + c.endSec - c.startSec; }, 0) || 1, doneDur = 0;
    return clips.reduce(function (chain, clip) {
      return chain.then(function () {
        var speed = clip.speed > 0 ? clip.speed : 1, len = clip.endSec - clip.startSec;
        return analyzeRange(clip.mediaPath, clip.inPointSec || 0, len * speed, {
          ffmpegPath: opts.ffmpegPath,
          onProgress: function (f) { if (opts.onProgress) opts.onProgress((doneDur + f * len) / dur); }
        }).then(function (res) {
          var vals = res.values;
          var start = Math.round(clip.startSec * FPS), n = Math.round(len * FPS);
          for (var k = 0; k < n; k++) {
            var src = Math.floor(k * speed);
            if (start + k >= 0 && start + k < total && src < vals.length) curve[start + k] = vals[src] * speed;
          }
          // Thumbnails at whole sequence seconds.
          for (var sec = Math.ceil(clip.startSec); sec < clip.endSec && sec < seconds; sec++) {
            var ss = Math.floor((sec - clip.startSec) * speed);
            if (ss >= 0 && (ss + 1) * TSIZE <= res.thumbs.length) { thumbs.set(res.thumbs.subarray(ss * TSIZE, (ss + 1) * TSIZE), sec * TSIZE); hasThumb[sec] = 1; }
          }
          doneDur += len;
          if (opts.onProgress) opts.onProgress(doneDur / dur);
        });
      });
    }, Promise.resolve()).then(function () {
      return { hopSec: HOP, values: curve, thumbs: { w: TW, h: TH, hopSec: 1, data: thumbs, valid: hasThumb } };
    });
  }

  return { HOP: HOP, FPS: FPS, W: W, H: H, TW: TW, TH: TH, analyzeRange: analyzeRange, analyzeTrack: analyzeTrack,
           _internal: { frameMotion: frameMotion, downsample: downsample, fitSimilarity: fitSimilarity } };
});
