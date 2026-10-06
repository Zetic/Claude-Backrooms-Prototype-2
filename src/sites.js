/*
 * sites.js - the macro layer.
 *
 * The infinite plane is divided into square cells. Every cell owns exactly one
 * jittered "site", derived purely from hash(seed, i, j). A coarse "complex"
 * noise field marks regions where neighbouring clusters fuse into one big
 * continuous building (rooms meet at shared walls and connect by doors); outside
 * complexes, clusters stand apart and are linked by corridors. A site is either
 *   - a CLUSTER  : a group of rooms (from a 2-room pod to a 200-room complex)
 *   - a JUNCTION : a bare point where corridors meet, bend or dead-end
 *   - VOID       : nothing at all (common in sparse regions -> long corridors)
 *   - ABSORBED   : swallowed by a much larger neighbouring cluster (ignored)
 *
 * Sites are linked by a corridor graph: the Relative Neighbourhood Graph (always
 * connected, planar, no long skinny edges) plus a random subset of extra Gabriel
 * edges for loops, minus some pruned edges for dead ends. Every decision is a
 * function of a bounded neighbourhood of cells, so any chunk of the world can be
 * generated in any order and always comes out identical.
 *
 * Each cluster owns a "territory": the intersection of half-planes from a
 * clamped power diagram (bigger clusters push the boundary outwards). Rooms are
 * only placed inside it, so neighbouring clusters never overlap even though they
 * are generated independently.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { hash4, hashf, mix32, Rng, fbm, contrast, clamp, rotation, ROTS, distSegSq } = BR;

  const CFG = {
    cell: 44,            // world units per site cell (1 unit ~ 1 m)
    winTerr: 4,          // neighbour window (cells) for territories / absorption
    winEdge: 3,          // candidate corridor partners within +-winEdge cells
    winWit: 4,           // witness window (cells) around an edge midpoint
    maxReach: 78,        // hard cap on cluster radius (must be < ~1.8 * cell)
    extraEdgeP: 0.18,    // chance a Gabriel-but-not-RNG cluster pair gets a loop corridor
    complexEdgeP: 0.5,   // same, inside complexes (doors are cheap, webs have loops)
    complexScale: 6.5,   // complex-field noise scale, in cells
    complexAt: 0.6,     // complex threshold at density 0 (lower = more complexes)
    complexDensity: 0.4, // how much density lowers that threshold
    fuseP: 0.88,         // chance a graph edge inside a complex becomes a door, not a corridor
    voidScale: 7,        // hole-field noise scale, in cells
    voidAt: 0.5,         // hole threshold at density 0 (lower = more / bigger holes)
    districtCells: 7,    // theme districts span ~7x7 cells
    landmarkCells: 9,    // at most one landmark per 9x9 cells (~400 m)
    landmarkP: 0.75      // chance a landmark cell actually has one
  };

  // Salts keep independent decisions independent.
  const S = {
    POS: 11, KIND: 12, REACH: 13, ROT: 14, THEME: 15, ID: 16, DIST: 17,
    EXTRA: 21, PRUNE: 22, GAP: 23, WIDTH: 24, CORR: 25, FUSE: 26, DOOR: 27, CLUSTER: 31, HUB: 32,
    F_DENS: 0xd3a5, F_ROT: 0x70a1, F_WARM: 0xc01a, F_BEIGE: 0xbe16, F_CPLX: 0xc0f1, F_VOID: 0x7e1d, F_SOLID: 0x5011, ORIENT: 33, LMK: 34, ENTR: 35
  };

  // ------------------------------------------------------------------ themes
  // `cores` = weights of the core motif; ranges are [min,max] picked per cluster.
  // `zones` = weights of the zone types that fill this theme's building blocks.
  const THEMES = {
    base:     { cores: { none: 3.4, bsp: 2.2, hall: 0.9, maze: 0.6, comb: 0.5 },
                zones: { open: 4, split: 2, office: 2, warren: 1.1, ring: 1.2, gallery: 1, stalls: 0.7, corridorRooms: 0.7, store: 0.6, courtyard: 0.6, stairs: 0.25, round: 0.3, pool: 0.06 } },
    red:      { color: '#d8908e', cores: { bsp: 2, none: 1, maze: 1 }, zones: { warren: 2.5, stalls: 2, split: 1.5, ring: 1.2, open: 0.8 }, roomScale: [0.75, 1.05] },
    office:   { color: '#d9c3c3', cores: { hall: 2, bsp: 2.5 }, zones: { office: 5, open: 2, split: 2, stalls: 1, warren: 0.6 }, roomScale: [1.0, 1.35], pillars: 0.8 },
    hotel:    { color: '#adb4c3', cores: { comb: 5, none: 0.6 }, zones: { corridorRooms: 5, gallery: 2, ring: 1, split: 1 } },
    concrete: { color: '#bdbdbd', cores: { none: 3, maze: 1 }, zones: { ring: 2.5, open: 2, store: 1.2, warren: 1, courtyard: 1, split: 1, stairs: 1 }, pHall: [0.35, 0.6], roomScale: [0.6, 0.95], hallW: 2 },
    windows:  { color: '#cbcbcb', cores: { hall: 3, bsp: 1 }, zones: { open: 4, gallery: 2, courtyard: 1, split: 1 }, pillars: 0.95 },
    shop:     { color: '#cdc1a2', cores: { hall: 2, none: 1, bsp: 1 }, zones: { store: 4, open: 2, stalls: 1.5, split: 1 } },
    sage:     { color: '#cfd1a9', cores: { none: 2, bsp: 1 }, zones: { open: 2, office: 1.5, split: 1.5, warren: 1 } },
    green:    { color: '#a8cb9d', cores: { none: 2, maze: 1 }, zones: { open: 2, warren: 1.5, split: 1, courtyard: 1 } },
    wood:     { color: '#8f7364', cores: { none: 1, bsp: 1, maze: 1 }, zones: { warren: 2.5, office: 1, gallery: 1 }, maxReach: 30 },
    bluetile: { color: '#86b9f7', cores: { maze: 1, none: 2 }, zones: { stalls: 3, pool: 2, open: 1, warren: 1 }, roomScale: [0.55, 0.85], maxReach: 16 },
    white:    { color: '#f3f3f3', cores: { maze: 1, none: 1 }, zones: { warren: 2, stalls: 1.5, open: 1 }, roomScale: [0.6, 0.9], maxReach: 22 },
    salmon:   { color: '#dd9f86', cores: { bsp: 1 }, zones: { office: 1.5, warren: 1, open: 1 }, roomScale: [0.65, 0.9], maxReach: 18 }
  };
  const DISTRICT_THEMES = { concrete: 3, hotel: 1.6, office: 2, red: 1.3, sage: 1, shop: 1, green: 0.8, windows: 0.9 };
  const LANDMARKS = { grandHall: 3, atrium: 2, longGallery: 1.5, poolHall: 1.5, theatre: 1 };
  const SOLO_THEMES = { red: 1, bluetile: 1.4, white: 0.9, wood: 1, salmon: 0.8, green: 1, office: 0.8, concrete: 0.8, sage: 0.6 };

  // Base "yellow" palette, sampled from the reference map.
  const P_CREAM = BR.hexToRgb('#ecdcb2'), P_YEL = BR.hexToRgb('#e5cc9b'), P_MUST = BR.hexToRgb('#dfc47f');
  const P_BEIGE = BR.hexToRgb('#e5cbae'), P_PEACH = BR.hexToRgb('#dfbd98');

  function baseColor(seed, x, y, jit) {
    const C = CFG.cell;
    const warm = contrast(fbm(seed ^ S.F_WARM, x / (C * 4.5), y / (C * 4.5), 2), 2.4);
    const beige = contrast(fbm(seed ^ S.F_BEIGE, x / (C * 6), y / (C * 6), 2), 2.2);
    let col = warm < 0.5 ? BR.mixRgb(P_CREAM, P_YEL, warm * 2) : BR.mixRgb(P_YEL, P_MUST, (warm - 0.5) * 2);
    const tgt = beige > 0.82 ? P_PEACH : P_BEIGE;
    col = BR.mixRgb(col, tgt, clamp((beige - 0.5) * 1.8, 0, 0.85));
    return BR.scaleRgb(col, 0.965 + 0.07 * jit);
  }

  // ------------------------------------------------------------------- sites
  function siteKey(i, j) { return i + ',' + j; }
  /** canonical order for undirected pairs */
  function siteLess(a, b) { return a.i < b.i || (a.i === b.i && a.j < b.j); }

  function makeSite(W, i, j) {
    const seed = W.seed, C = CFG.cell;
    const id = hash4(seed, i, j, S.ID);
    const r = new Rng(hash4(seed, i, j, S.POS));
    const x = (i + 0.05 + 0.9 * r.f()) * C;
    const y = (j + 0.05 + 0.9 * r.f()) * C;

    // Low-frequency density field: dense regions get more & bigger clusters,
    // and more of them belong to complexes. Sparse regions still get decent
    // buildings (density only scales size by 0.9-1.5x) so they don't thin out
    // into strings of corridors.
    const D = contrast(fbm(seed ^ S.F_DENS, x / (C * 11), y / (C * 11), 3), 2.3);
    const K = contrast(fbm(seed ^ S.F_CPLX, x / (C * CFG.complexScale), y / (C * CFG.complexScale), 3), 2.0);
    const cx = K > CFG.complexAt - CFG.complexDensity * D;
    // Complex character: solid (packed blocks, A24-like) vs webby (branching
    // room bands with courtyards, like the hand-drawn survey).
    const solid = contrast(fbm(seed ^ S.F_SOLID, x / (C * 9), y / (C * 9), 2), 2.2);
    // Voids come in contiguous holes (a separate coarse field), so empty space
    // forms a few big dark areas the graph routes around, rather than scattered
    // gaps that stretch corridors into strings.
    const V = contrast(fbm(seed ^ S.F_VOID, x / (C * CFG.voidScale), y / (C * CFG.voidScale), 2), 2.2);
    // Sparse regions turn into holes rather than a thin mesh of corridors.
    // Landmarks: one special site per coarse cell (huge pillar hall, atrium...)
    const LC = CFG.landmarkCells, li = Math.floor(i / LC), lj = Math.floor(j / LC);
    const lr = new Rng(hash4(seed, li, lj, S.LMK));
    const lmHas = lr.f() < CFG.landmarkP, lmI = li * LC + lr.int(1, LC - 2), lmJ = lj * LC + lr.int(1, LC - 2), lmType = lr.weighted(LANDMARKS);
    const landmark = lmHas && i === lmI && j === lmJ ? lmType : null;
    const isVoid = !cx && !landmark && (V > CFG.voidAt + 0.5 * D || r.f() < 0.03);
    const isCluster = !isVoid && (cx || !!landmark || r.f() < 0.6 + 0.4 * D);

    let reach = 0;
    if (isCluster) {
      const u = r.f();
      reach = (15 + 36 * u * u) * (0.95 + 0.5 * D);
      if (r.f() < 0.035 + 0.07 * D) reach = 50 + 28 * r.f();   // occasional mega complex
      if (landmark) reach = Math.max(reach, 46 + 10 * lr.f());
      reach = Math.min(reach, CFG.maxReach);
    }

    // Orientation. Complex members mostly share their region's grid (one
    // building, flush shared walls); a few are rotated buildings inside it.
    // Elsewhere: aligned to world, to a slowly varying regional angle, or free.
    const orient = fbm(seed ^ S.F_ROT, x / (C * 8), y / (C * 8), 2);
    const m = r.f();
    let rotIdx, grid = false;
    if (cx && m < 0.85) { rotIdx = orientCell(seed, x, y); grid = true; }
    else if (m < 0.28) rotIdx = 0;
    else if (m < 0.62) rotIdx = Math.floor(contrast(orient, 2.5) * (ROTS.length - 0.001));
    else rotIdx = Math.floor(r.f() * ROTS.length);
    const rot = rotation(rotIdx, r.int(0, 3));
    // Offset (cluster frame) that puts the building's integer grid on the shared
    // lattice R*Z^2, so neighbours with the same rotation line up exactly.
    const gu = rot.c * x + rot.s * y, gv = -rot.s * x + rot.c * y;
    const goff = grid ? [Math.round(gu) - gu, Math.round(gv) - gv] : [0, 0];

    // Theme: districts (multi-site areas) first, then rare one-off special clusters.
    const dist = districtTheme(W, x, y);
    let theme = dist.theme;
    if (theme === 'base' && isCluster && r.f() < 0.09) theme = new Rng(hash4(seed, i, j, S.THEME)).weighted(SOLO_THEMES);
    const jit = r.f();
    if (THEMES[theme].maxReach) reach = Math.min(reach, THEMES[theme].maxReach);
    const rgb = theme === 'base' ? baseColor(seed, x, y, jit) : BR.scaleRgb(BR.hexToRgb(THEMES[theme].color), 0.975 + 0.05 * jit);

    return {
      key: siteKey(i, j), i, j, x, y, id,
      kind: isVoid ? 'void' : isCluster ? 'cluster' : 'junction',
      r: reach, D, cx, solid, grid, rotIdx, goff, rot, theme, rgb, landmark, district: dist.key,
      dom: (theme === 'base' ? 0 : 1) + (isCluster ? 0.25 : 0) + hashf(seed, i, j, 99) * 0.2,
      // filled lazily:
      _absorbed: undefined, _raw: null, _adj: null
    };
  }

  /** Orientation (ROTS index) of the coarse region containing (x,y). */
  function orientCell(seed, x, y) {
    const OC = CFG.cell * 5, oi = Math.floor(x / OC), oj = Math.floor(y / OC);
    let best = Infinity, idx = 0;
    for (let a = oi - 1; a <= oi + 1; a++) for (let b = oj - 1; b <= oj + 1; b++) {
      const rr = new Rng(hash4(seed, a, b, S.ORIENT));
      const dx = x - (a + rr.f()) * OC, dy = y - (b + rr.f()) * OC, d = dx * dx + dy * dy;
      if (d < best) { best = d; idx = rr.f() < 0.35 ? 0 : Math.floor(rr.f() * ROTS.length); }
    }
    return idx;
  }

  /** District candidate of coarse cell (a,b): centre, radius, whether it exists, theme. */
  function districtInfo(seed, a, b) {
    const DC = CFG.cell * CFG.districtCells;
    const rr = new Rng(hash4(seed, a, b, S.DIST));
    const cx = (a + rr.f()) * DC, cy = (b + rr.f()) * DC;
    const rad = (1.6 + 2.6 * rr.f()) * CFG.cell;
    const special = rr.f() < 0.42;
    const theme = rr.weighted(DISTRICT_THEMES);
    return { cx, cy, rad, special, theme };
  }

  /** Theme district containing (x,y): { theme, key } (key null outside districts). */
  function districtTheme(W, x, y) {
    const DC = CFG.cell * CFG.districtCells;
    const di = Math.floor(x / DC), dj = Math.floor(y / DC);
    let best = 1, theme = 'base', key = null;
    for (let a = di - 1; a <= di + 1; a++) for (let b = dj - 1; b <= dj + 1; b++) {
      const d = districtInfo(W.seed, a, b);
      const dx = x - d.cx, dy = y - d.cy;
      const q = (dx * dx + dy * dy) / (d.rad * d.rad);
      if (d.special && q < best) { best = q; theme = d.theme; key = a + ',' + b; }
    }
    return { theme, key };
  }

  // ------------------------------------------------------------ absorption
  /** Inactive sites: voids, and sites deep inside a stronger cluster's reach. */
  function isAbsorbed(W, s) {
    if (s._absorbed !== undefined) return s._absorbed;
    if (s.kind === 'void') return (s._absorbed = true);
    if (s.landmark) return (s._absorbed = false);      // landmarks always get built
    let res = false;
    const w = CFG.winTerr;
    for (let a = s.i - w; a <= s.i + w && !res; a++) for (let b = s.j - w; b <= s.j + w; b++) {
      if (a === s.i && b === s.j) continue;
      const o = W.site(a, b);
      if (o.r <= 0) continue;
      if (o.r < s.r || (o.r === s.r && o.id <= s.id)) continue;
      const dx = o.x - s.x, dy = o.y - s.y;
      const lim = 0.62 * o.r;
      if (dx * dx + dy * dy < lim * lim) { res = true; break; }
    }
    s._absorbed = res;
    return res;
  }

  // ----------------------------------------------------------------- graph
  function pairHash(A, B, salt) { return mix32((A.id ^ B.id) + Math.imul(salt, 0x9e3779b1)); }
  function pairF(A, B, salt) { return pairHash(A, B, salt) / BR.U32; }

  /** Raw edge test (RNG, plus some Gabriel edges). Symmetric in A,B by construction. */
  function rawEdge(W, A, B) {
    const dx = B.x - A.x, dy = B.y - A.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > (3.3 * CFG.cell) * (3.3 * CFG.cell)) return false;
    const mi = Math.floor((A.i + B.i) / 2), mj = Math.floor((A.j + B.j) / 2), w = CFG.winWit;
    let rng = true, gab = true;
    for (let a = mi - w; a <= mi + w; a++) for (let b = mj - w; b <= mj + w; b++) {
      const C = W.site(a, b);
      if (C.key === A.key || C.key === B.key || isAbsorbed(W, C)) continue;
      const ax = C.x - A.x, ay = C.y - A.y, bx = C.x - B.x, by = C.y - B.y;
      const da = ax * ax + ay * ay, db = bx * bx + by * by;
      if (da < d2 && db < d2) rng = false;
      if (da + db < d2) { gab = false; return false; }
    }
    if (rng) return true;
    // Extra loop edges only between two clusters: the RNG has no triangles, and
    // loops made purely of bare corridors read as an exposed graph.
    const pe = A.cx && B.cx ? CFG.complexEdgeP : CFG.extraEdgeP;
    return gab && A.kind === 'cluster' && B.kind === 'cluster' && pairF(A, B, S.EXTRA) < pe;
  }

  function rawNeighbours(W, s) {
    if (s._raw) return s._raw;
    const out = [];
    if (!isAbsorbed(W, s)) {
      const w = CFG.winEdge;
      for (let a = s.i - w; a <= s.i + w; a++) for (let b = s.j - w; b <= s.j + w; b++) {
        if (a === s.i && b === s.j) continue;
        const o = W.site(a, b);
        if (isAbsorbed(W, o)) continue;
        if (rawEdge(W, s, o)) out.push(o);
      }
    }
    s._raw = out;
    return out;
  }

  function edgeKey(A, B) { return siteLess(A, B) ? A.key + '|' + B.key : B.key + '|' + A.key; }

  /**
   * Entrances of a theme district: of all graph edges crossing its boundary,
   * keep the lowest-hash one per connected piece of the district (so nothing
   * is cut off) plus one or two more. Everything else across the boundary is
   * dropped, so a themed area is entered through a few doors ("different
   * carpet here!") instead of wherever buildings happen to touch.
   */
  function entrances(W, key) {
    const cache = W._ent || (W._ent = new Map());
    let set = cache.get(key);
    if (set) return set;
    const [a, b] = key.split(',').map(Number), D = districtInfo(W.seed, a, b), C = CFG.cell;
    const members = [];
    for (let i = Math.floor((D.cx - D.rad) / C) - 1; i <= Math.floor((D.cx + D.rad) / C) + 1; i++)
      for (let j = Math.floor((D.cy - D.rad) / C) - 1; j <= Math.floor((D.cy + D.rad) / C) + 1; j++) {
        const s = W.site(i, j);
        if (s.district === key && !isAbsorbed(W, s)) members.push(s);
      }
    const idx = new Map(members.map((s, k) => [s.key, k]));
    const par = members.map((_, k) => k);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const boundary = [];
    for (const s of members) for (const o of rawNeighbours(W, s)) {
      if (idx.has(o.key)) { const p = find(idx.get(s.key)), q = find(idx.get(o.key)); if (p !== q) par[Math.max(p, q)] = Math.min(p, q); }
      else boundary.push({ s, h: pairHash(s, o, S.ENTR), k: edgeKey(s, o) });
    }
    boundary.sort((p, q) => p.h - q.h || (p.k < q.k ? -1 : 1));
    set = new Set();
    const done = new Set();
    for (const e of boundary) { const c = find(idx.get(e.s.key)); if (!done.has(c)) { done.add(c); set.add(e.k); } }
    let extra = 1 + (new Rng(hash4(W.seed, a, b, S.ENTR)).f() < 0.5 ? 1 : 0);
    for (const e of boundary) { if (extra <= 0) break; if (!set.has(e.k)) { set.add(e.k); extra--; } }
    cache.set(key, set);
    return set;
  }

  /**
   * Optional edges may be dropped from the corridor graph: edges across a
   * theme district boundary that aren't one of its entrances, and random
   * prunes that thin out the web. Everything else is a BASE edge.
   */
  function optionalEdge(W, s, o) {
    if (s.district !== o.district) {
      const k = edgeKey(s, o);
      return !((s.district && entrances(W, s.district).has(k)) || (o.district && entrances(W, o.district).has(k)));
    }
    const dA = rawNeighbours(W, s).length, dB = rawNeighbours(W, o).length;
    if (dA < 3 || dB < 3) return false;
    const jj = (s.kind === 'junction') + (o.kind === 'junction');
    const sparse = 1 - (s.D + o.D) / 2;                 // thinner webs where it's sparse
    const p = jj === 2 ? 0.6 : jj === 1 ? 0.35 : 0.1 + 0.22 * sparse;
    return pairF(s, o, S.PRUNE) < p;
  }

  /**
   * Can s reach o in <= maxHops using base edges only? Base edges never get
   * dropped, and whether an edge is base doesn't depend on any other drop
   * decision, so dropping an optional edge that has such a bypass can never
   * disconnect the graph: the map stays one connected world, by construction.
   */
  function bypass(W, s, o, maxHops) {
    let frontier = [s];
    const seen = new Set([s.key]);
    for (let h = 0; h < maxHops && frontier.length; h++) {
      const next = [];
      for (const u of frontier) for (const v of rawNeighbours(W, u)) {
        if (seen.has(v.key) || optionalEdge(W, u, v)) continue;
        if (v.key === o.key) return true;
        seen.add(v.key); next.push(v);
      }
      frontier = next;
    }
    return false;
  }

  /** Final corridor adjacency (sorted canonically). */
  function neighbours(W, s) {
    if (s._adj) return s._adj;
    const out = [];
    for (const o of rawNeighbours(W, s)) {
      if (optionalEdge(W, s, o) && bypass(W, s, o, 5)) continue;
      out.push(o);
    }
    out.sort((a, b) => (siteLess(a, b) ? -1 : 1));
    s._adj = out;
    return out;
  }

  // ------------------------------------------------------------- territory
  function minCore(s) { return s.kind === 'cluster' ? clamp(s.r * 0.45, 5, 16) : 8; }

  /** Same complex and the same grid: their seam is a flush, grid-aligned wall. */
  function sameGrid(A, B) { return inComplex(A, B) && A.grid && B.grid && A.rotIdx === B.rotIdx; }

  /** Integer gap across a grid-aligned seam: mostly one wall's thickness. */
  function gridGap(A, B) {
    const u = pairF(A, B, S.GAP);
    if (u < 0.74) return 1;
    if (u < 0.84) return 2;
    if (u < 0.9) return A.theme === B.theme ? 0 : 1;         // open plan across the seam (same theme only)
    return 4 + Math.floor(5 * (u - 0.9) / 0.1);              // courtyard / light well
  }

  /** Both sites belong to the same complex region (as clusters). */
  function inComplex(A, B) { return A.cx && B.cx && A.kind === 'cluster' && B.kind === 'cluster'; }

  /**
   * A fused edge is connected by doors through a shared seam instead of a
   * corridor (the corridor builder falls back to a corridor if no door fits).
   */
  function isFused(A, B) { return inComplex(A, B) && pairF(A, B, S.FUSE) < CFG.fuseP; }

  /** Gap between two territories: often tight (zones touching), sometimes wide. */
  function pairGap(A, B) {
    const u = pairF(A, B, S.GAP);
    if (inComplex(A, B)) {
      // Inside a complex: mostly a shared wall (the two outlines merge into one
      // thick wall), sometimes a dark slit or a courtyard, rarely an open seam.
      if (u < 0.7) return 0.5;
      if (u < 0.85) return 1.2 + 1.8 * (u - 0.7) / 0.15;
      if (u < 0.92) return A.theme === B.theme ? -0.8 - 1.4 * (u - 0.85) / 0.07 : 0.5;   // open seam only within a theme
      return 4 + 5 * (u - 0.92) / 0.08;
    }
    // Negative = territories overlap a little: the two clusters fuse into one
    // mass along the seam (different grids meeting, as in the reference).
    const fuse = 0.05 + 0.15 * (A.D + B.D) / 2;
    if (u < fuse && A.kind === 'cluster' && B.kind === 'cluster' && A.theme === B.theme) return -1 - 2 * (u / fuse);
    return u < fuse + 0.25 ? 0.9 : 2.5 + 10 * (u - fuse - 0.25) / (0.75 - fuse);
  }

  /**
   * Half-planes bounding cluster A's territory, in world-axis coords relative
   * to A's site: a point p is inside iff p.ux*x + p.uy*y <= p.t for all planes.
   */
  function territoryPlanes(W, A) {
    const planes = [], w = CFG.winTerr;
    for (let a = A.i - w; a <= A.i + w; a++) for (let b = A.j - w; b <= A.j + w; b++) {
      if (a === A.i && b === A.j) continue;
      const B = W.site(a, b);
      if (isAbsorbed(W, B)) continue;
      if (B.kind === 'junction' && neighbours(W, B).length === 0) continue;
      const dx = B.x - A.x, dy = B.y - A.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d - (B.r || 0) > CFG.maxReach + 20) continue;
      if (sameGrid(A, B)) { planes.push(gridPlane(A, B)); continue; }
      // Clamped power-diagram split: symmetric in (A,B), and never eats either
      // site's minimum core, so both sides always have room for something.
      const mA = minCore(A), mB = minCore(B);
      let t, g = pairGap(A, B);
      if (mA + mB + 0.9 >= d) { t = d * mA / (mA + mB); g = Math.min(0.9, d * 0.2); }
      else {
        g = Math.min(g, d - mA - mB);
        t = clamp((d * d + A.r * A.r - B.r * B.r) / (2 * d), mA + g / 2, d - mB - g / 2);
      }
      t -= g / 2;
      if (t > CFG.maxReach + 2) continue;   // arms can reach past r, up to maxReach
      planes.push({ ux: dx / d, uy: dy / d, t });
    }
    return planes;
  }

  /**
   * Grid-aligned split between two same-grid neighbours: along whichever grid
   * axis separates them most, at an integer line. Computed from the canonical
   * (lower, upper) pair so both sides get complementary half-planes.
   */
  function gridPlane(A, B) {
    const R0 = ROTS[A.rotIdx];
    const fa = [R0.c * A.x + R0.s * A.y, -R0.s * A.x + R0.c * A.y];
    const fb = [R0.c * B.x + R0.s * B.y, -R0.s * B.x + R0.c * B.y];
    const k = Math.abs(fb[0] - fa[0]) >= Math.abs(fb[1] - fa[1]) ? 0 : 1;
    const aLo = fa[k] < fb[k] || (fa[k] === fb[k] && siteLess(A, B));
    const lo = aLo ? A : B, hi = aLo ? B : A, flo = aLo ? fa[k] : fb[k], fhi = aLo ? fb[k] : fa[k];
    const dax = fhi - flo, g = gridGap(A, B), mLo = minCore(lo), mHi = minCore(hi);
    let s;
    if (mLo + mHi + g >= dax) s = flo + dax * mLo / (mLo + mHi) - g / 2;
    else s = clamp(flo + (dax * dax + lo.r * lo.r - hi.r * hi.r) / (2 * dax) - g / 2, flo + mLo, fhi - mHi - g);
    const L = Math.floor(s);                       // lower side: coord <= L, upper side: coord >= L + g
    const ex = k === 0 ? R0.c : -R0.s, ey = k === 0 ? R0.s : R0.c;
    return aLo ? { ux: ex, uy: ey, t: L - fa[k] + 1e-7 } : { ux: -ex, uy: -ey, t: fa[k] - (L + g) + 1e-7 };
  }

  /** Corridor lanes (edges not touching A) that pass close to A: rooms must avoid them. */
  function lanes(W, A) {
    const out = [], w = CFG.winEdge + 1, lim = CFG.maxReach + 6;
    for (let a = A.i - w; a <= A.i + w; a++) for (let b = A.j - w; b <= A.j + w; b++) {
      const B = W.site(a, b);
      if (B.key === A.key || isAbsorbed(W, B)) continue;
      for (const C of neighbours(W, B)) {
        if (C.key === A.key || !siteLess(B, C) || isFused(B, C)) continue;   // doors, not corridors
        if (distSegSq(A.x, A.y, B.x, B.y, C.x, C.y) > lim * lim) continue;
        out.push({ x0: B.x - A.x, y0: B.y - A.y, x1: C.x - A.x, y1: C.y - A.y });
      }
    }
    return out;
  }

  /** Corridor width for an edge (world units). */
  function corridorWidth(A, B) {
    const u = pairF(A, B, S.WIDTH);
    if (u < 0.07) return 2.8 + 0.8 * (u / 0.07);
    return 1.45 + 0.95 * ((u - 0.07) / 0.93);
  }

  Object.assign(BR, {
    CFG, SALT: S, THEMES, siteKey, siteLess, makeSite, isAbsorbed,
    rawNeighbours, neighbours, territoryPlanes, lanes,
    pairHash, pairF, corridorWidth, pairGap, minCore, inComplex, isFused, sameGrid, edgeKey, entrances, LANDMARKS
  });
})(typeof window !== 'undefined' ? window : globalThis);
