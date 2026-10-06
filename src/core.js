/*
 * core.js - deterministic primitives shared by every generation stage.
 *
 * Rules that keep the generator reproducible on any machine / engine:
 *   - All randomness comes from integer hashing (hash4) or a seeded PRNG (Rng).
 *     Never Math.random().
 *   - Territory ownership uses integer metres. Architectural patterns and
 *     doorway clearances may use fractional metres; geometry stays axis-aligned.
 *   - Noise uses polynomial smoothing; only + - * / take part in decisions,
 *     which IEEE-754 defines exactly. A C# / GDScript port that keeps the same
 *     operation order produces the same map (Math.imul, >>>, |0 are 32-bit ops).
 */
(function (root) {
  'use strict';
  const BR = root.BR || (root.BR = {});

  // ---------------------------------------------------------------- hashing
  function mix32(h) {
    h = h | 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /** Hash of four 32-bit ints -> uint32. Typical use: hash4(seed, i, j, SALT). */
  function hash4(a, b, c, d) {
    let h = mix32((a | 0) ^ 0x9e3779b9);
    h = mix32(h ^ Math.imul(b | 0, 0x85ebca6b));
    h = mix32(h ^ Math.imul(c | 0, 0xc2b2ae35));
    h = mix32(h ^ Math.imul(d | 0, 0x27d4eb2f));
    return h;
  }
  const U32 = 4294967296;
  function hashf(a, b, c, d) { return hash4(a, b, c, d) / U32; }

  // ------------------------------------------------------------------- PRNG
  /** mulberry32 - tiny, fast, good enough for layout decisions. */
  class Rng {
    constructor(seed) { this.s = (seed >>> 0) || 0x2545f491; }
    u32() {
      let t = (this.s = (this.s + 0x6d2b79f5) | 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    }
    f() { return this.u32() / U32; }
    range(a, b) { return a + (b - a) * this.f(); }
    /** inclusive integer range */
    int(a, b) { return a + Math.floor(this.f() * (b - a + 1)); }
    chance(p) { return this.f() < p; }
    pick(arr) { return arr[Math.floor(this.f() * arr.length)]; }
    /** weights: plain object {key: weight}. Key order is insertion order (deterministic). */
    weighted(w) {
      let tot = 0, last = null;
      for (const k in w) { tot += w[k]; last = k; }
      let r = this.f() * tot;
      for (const k in w) { r -= w[k]; if (r < 0) return k; }
      return last;
    }
  }

  // ------------------------------------------------------------------ noise
  function smooth(t) { return t * t * (3 - 2 * t); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

  /** 2D value noise in [0,1). Lattice spacing = 1. */
  function valueNoise(seed, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const u = smooth(x - xi), v = smooth(y - yi);
    const a = hashf(seed, xi, yi, 0x51), b = hashf(seed, xi + 1, yi, 0x51);
    const c = hashf(seed, xi, yi + 1, 0x51), d = hashf(seed, xi + 1, yi + 1, 0x51);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  /** Fractal value noise, normalised to roughly [0,1]. */
  function fbm(seed, x, y, octaves) {
    let sum = 0, amp = 0.5, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * valueNoise(seed + o * 1013, x * f, y * f);
      norm += amp; amp *= 0.5; f *= 2;
    }
    return sum / norm;
  }
  /** Stretch noise that clusters around 0.5 back out toward [0,1]. */
  function contrast(v, k) { return clamp(0.5 + (v - 0.5) * k, 0, 1); }

  // --------------------------------------------------------------- geometry
  /** Union-find over 0..n-1 (smaller index wins, so results are order independent). */
  function makeUF(n) {
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a === b) return false; if (a < b) p[b] = a; else p[a] = b; return true; };
    return { find, union };
  }

  // ------------------------------------------------------------------ color
  // (colour maths is presentation-only, floats are fine here)
  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToCss(c) {
    return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
  }
  function mixRgb(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function scaleRgb(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }

  Object.assign(BR, {
    mix32, hash4, hashf, Rng, U32,
    smooth, lerp, clamp, valueNoise, fbm, contrast, makeUF,
    hexToRgb, rgbToCss, mixRgb, scaleRgb
  });
})(typeof window !== 'undefined' ? window : globalThis);
