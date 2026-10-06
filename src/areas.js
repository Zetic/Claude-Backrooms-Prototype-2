/*
 * areas.js - level 1: what kind of space is where, and how kinds meet.
 *
 * Every territory belongs to exactly one AREA. Areas have a ROLE:
 *   base     - Backrooms: fills everything nothing else claims
 *   district - Offices, Hotel, Poolrooms, Parking: large compact regions
 *   pocket   - Home, Maintenance rooms: one territory, fully inside one host
 *   network  - Maintenance: thin service bands carved along boundaries
 *
 * Districts come from a deterministic field: seeds on a coarse jittered
 * lattice, each a warped box/ellipse blend. A point's area is the district
 * whose shape it is deepest inside, else Backrooms. The field is sampled at
 * territory centres, so area edges always follow territory edges (walls).
 *
 * RULES says how every pair of areas meets: wall type, door spacing, how
 * often a pair may have no door at all, and which pairs may not touch (a
 * maintenance band is carved between them). All rules are applied per
 * boundary from the two sides only, so they never cascade.
 */
(function (root) {
  'use strict';
  const BR = root.BR;
  const { hash4, Rng, fbm, contrast, clamp } = BR;

  const S = { DIST: 0xd157, WARPX: 0x3a91, WARPY: 0x3a92, WARM: 0xc01a, BEIGE: 0xbe16, DNA: 0xd6a1 };

  // ----------------------------------------------------------------- areas
  // split   - territory grain: tmin/tmax side, split probability, max aspect,
  //           shortMax (cut long thin strips: hotel wings)
  // style   - how a territory is cut into blocks (interior.js)
  // zones   - zone-type weights for blocks (zones.js catalogue)
  // main / service - zone weights for 'hall' style main halls / service strips
  const AREAS = {
    backrooms: {
      name: 'Backrooms', role: 'base', color: null,
      split: { tmin: 14, tmax: 54, pSplit: 0.55, maxAspect: 3 },
      style: 'irregular',
      zones: { open: 5, split: 1.2, office: 1.1, warren: 0.8, ring: 1.2, gallery: 0.8, stalls: 0.5, store: 0.4, courtyard: 0.4, stairs: 0.3, round: 0.15, corridorRooms: 0.3 },
      landmarks: { grandHall: 3, atrium: 2, theatre: 1, longGallery: 1.5 }, landmarkP: 0.03,
      roomScale: [0.95, 1.45], pillars: 0.5, pOpen: [0.15, 0.45], pLoop: [0.15, 0.45], pWide: [0.08, 0.3]
    },
    offices: {
      name: 'Offices', role: 'district', color: '#d9c6c4',
      split: { tmin: 18, tmax: 48, pSplit: 0.6, maxAspect: 2.4 },
      style: 'spine', chunk: [8, 22], depthMin: 6,
      zones: { office: 4, open: 1.6, stalls: 1.4, warren: 1, store: 0.6, corridorRooms: 0.4, split: 0.5 },
      landmarks: { atrium: 1 }, landmarkP: 0.02,
      roomScale: [0.9, 1.2], pillars: 0.6, pOpen: [0.05, 0.2], pLoop: [0.1, 0.3], pWide: [0.03, 0.12]
    },
    hotel: {
      name: 'Hotel', role: 'district', color: '#adb6c7',
      split: { tmin: 16, tmax: 64, pSplit: 0.4, maxAspect: 4.5, shortMax: 28 },
      style: 'hotel', chunk: [4, 8], depthMin: 4,
      zones: { open: 2, gallery: 1, courtyard: 0.6 },
      landmarks: { atrium: 1 }, landmarkP: 0.03,
      roomScale: [0.9, 1.1], pillars: 0.7, pOpen: [0, 0.05], pLoop: [0, 0.1], pWide: [0, 0.05]
    },
    poolrooms: {
      name: 'Poolrooms', role: 'district', color: '#e3ebeb',
      split: { tmin: 22, tmax: 70, pSplit: 0.35, maxAspect: 2.5 },
      style: 'hall',
      main: { pools: 4, pool: 1, courtyard: 0.4, open: 0.6 },
      service: { stalls: 2, room: 1.2, stairs: 0.3 },
      landmarks: { poolHall: 1 }, landmarkP: 0.05,
      roomScale: [1, 1.3], pillars: 0.7, pOpen: [0.2, 0.5], pLoop: [0.2, 0.4], pWide: [0.2, 0.45]
    },
    parking: {
      name: 'Parking', role: 'district', color: '#bebdb7',
      split: { tmin: 26, tmax: 84, pSplit: 0.3, maxAspect: 2.5 },
      style: 'hall',
      main: { parking: 4, store: 1, open: 0.7 },
      service: { room: 1.5, stairs: 0.8 },
      roomScale: [1.1, 1.4], pillars: 0.9, pOpen: [0.3, 0.6], pLoop: [0.2, 0.4], pWide: [0.3, 0.6]
    },
    home: {
      name: 'Home', role: 'pocket', color: '#cfa985',
      pocket: { hosts: ['backrooms', 'offices', 'hotel'], p: 0.045, minDim: 14, maxDim: 42, salt: 61 },
      style: 'house',
      roomScale: [0.9, 1.1], pillars: 0, pOpen: [0, 0.1], pLoop: [0, 0.1], pWide: [0, 0.1]
    },
    maintenance: {
      name: 'Maintenance', role: 'network', color: '#b5b2a8',
      pocket: { hosts: ['backrooms', 'parking', 'poolrooms'], p: 0.025, minDim: 12, maxDim: 40, salt: 62 },
      style: 'utility', band: [3, 4],
      roomScale: [0.7, 0.9], pillars: 0, pOpen: [0, 0.1], pLoop: [0, 0.1], pWide: [0, 0.05]
    }
  };
  const ORDER = Object.keys(AREAS);
  const POCKETS = ['home', 'maintenance'];
  const DISTRICT_TYPES = { offices: 3, parking: 1.4, poolrooms: 1.4, hotel: 1.1 };

  // ----------------------------------------------------------------- rules
  /**
   * open/thick: chance the shared wall is absent / 2 m thick (else thin)
   * every, min, max: one door per `every` metres of shared wall, clamped
   * pNone: chance the pair has no door at all (only if the map stays connected)
   * wide:  chance a door is a wide opening (archway, loading door)
   */
  const R = (open, thick, every, min, max, pNone, wide) => ({ open, thick, every, min, max, pNone, wide });
  const RULES = {
    'backrooms|backrooms': R(0.3, 0, 18, 1, 3, 0.15, 0.25),
    'offices|offices': R(0, 0, 26, 1, 2, 0.1, 0.05),
    'hotel|hotel': R(0, 0, 30, 1, 1, 0.2, 0),
    'poolrooms|poolrooms': R(0.35, 0, 20, 1, 3, 0.1, 0.4),
    'parking|parking': R(0.5, 0, 20, 1, 3, 0.1, 0.6),
    'backrooms|offices': R(0, 0, 30, 1, 2, 0.35, 0.05),
    'backrooms|hotel': R(0, 0, 40, 1, 1, 0.5, 0),
    'backrooms|poolrooms': R(0, 0.6, 40, 1, 1, 0.6, 0.1),
    'backrooms|parking': R(0, 0.4, 30, 1, 2, 0.4, 0.4),
    'hotel|offices': R(0, 0, 40, 1, 1, 0.4, 0),
    'offices|parking': R(0, 1, 40, 1, 1, 0.6, 0),
    'hotel|poolrooms': R(0, 1, 40, 1, 1, 0.6, 0),
    // may not touch: a maintenance band is carved between them
    'offices|poolrooms': 'band', 'parking|poolrooms': 'band', 'hotel|parking': 'band'
  };
  const DEFAULT_RULE = R(0, 0, 30, 1, 1, 0.4, 0.1);
  function rule(a, b) {
    const k = a < b ? a + '|' + b : b + '|' + a;
    return RULES[k] || DEFAULT_RULE;
  }
  function isPocket(area) { return area === 'home' || area === 'maintenance'; }

  // ----------------------------------------------------------- the field
  const CFG = { districtCell: 380, districtP: 0.78, warp: 60, warpScale: 260 };

  function districtSeed(seed, a, b) {
    const r = new Rng(hash4(seed, a, b, S.DIST));
    const C = CFG.districtCell;
    const exists = r.f() < CFG.districtP;
    const cx = (a + 0.15 + 0.7 * r.f()) * C, cy = (b + 0.15 + 0.7 * r.f()) * C;
    const type = r.weighted(DISTRICT_TYPES);
    const rx = 100 + 140 * r.f(), ry = rx * (0.65 + 0.7 * r.f());
    const k = 0.3 + 0.7 * r.f();               // 0 = ellipse, 1 = box
    return { exists, cx, cy, rx, ry, k, type, id: a + ',' + b };
  }

  /** Base area at a point: { area, district } (district id, or null for Backrooms). */
  function areaAt(W, x, y) {
    const seed = W.seed, ws = CFG.warpScale;
    const wx = x + CFG.warp * 2 * (contrast(fbm(seed ^ S.WARPX, x / ws, y / ws, 2), 2) - 0.5);
    const wy = y + CFG.warp * 2 * (contrast(fbm(seed ^ S.WARPY, x / ws, y / ws, 2), 2) - 0.5);
    const C = CFG.districtCell, da = Math.floor(wx / C), db = Math.floor(wy / C);
    let best = 1, area = 'backrooms', district = null;
    for (let a = da - 1; a <= da + 1; a++) for (let b = db - 1; b <= db + 1; b++) {
      const d = districtSeed(seed, a, b);
      if (!d.exists) continue;
      const nx = Math.abs(wx - d.cx) / d.rx, ny = Math.abs(wy - d.cy) / d.ry;
      const dist = (1 - d.k) * Math.sqrt(nx * nx + ny * ny) + d.k * Math.max(nx, ny);
      if (dist < best) { best = dist; area = d.type; district = d.id; }
    }
    return { area, district };
  }


  // ------------------------------------------------------ architecture DNA
  // Territories are generation ownership units, not architectural identity
  // units. A district (or a coarse base-area region) therefore owns a stable
  // DNA record that nearby territories inherit. Local territory RNG still
  // varies individual rooms, while the DNA preserves corridor rhythm,
  // preferred axis, module size, density and zone tendencies across seams.
  const DNA_REGION = 760;

  function architectureRegion(T, area) {
    const A = AREAS[area] || AREAS.backrooms;
    if (T.district && (A.role === 'district' || A.role === 'pocket' || A.role === 'network')) {
      const p = T.district.split(',');
      return { key: 'district:' + area + ':' + T.district, a: +p[0], b: +p[1], district: true };
    }
    const a = Math.floor(T.cx / DNA_REGION), b = Math.floor(T.cy / DNA_REGION);
    return { key: 'field:' + area + ':' + a + ',' + b, a, b, district: false };
  }

  function architectureDNA(W, T, area) {
    area = area || T.base || 'backrooms';
    const reg = architectureRegion(T, area);
    if (W.dna && W.dna.has(reg.key)) {
      const hit = W.dna.get(reg.key);
      W.dna.delete(reg.key); W.dna.set(reg.key, hit);
      return hit;
    }

    const areaId = Math.max(1, ORDER.indexOf(area) + 1);
    const rng = new Rng(hash4(W.seed, reg.a, reg.b, S.DNA ^ Math.imul(areaId, 0x9e37)));
    let majorAxis;
    if (reg.district && T.district) {
      const d = districtSeed(W.seed, reg.a, reg.b);
      const ratio = d.rx / Math.max(1, d.ry);
      majorAxis = ratio > 1.12 ? 'x' : ratio < 0.89 ? 'y' : (rng.f() < 0.5 ? 'x' : 'y');
    } else majorAxis = rng.f() < 0.5 ? 'x' : 'y';

    const corridorWidth = rng.f() < (area === 'hotel' ? 0.78 : 0.68) ? 2 : 3;
    const module = area === 'hotel' ? rng.int(4, 6) : area === 'offices' ? rng.int(4, 7) : rng.int(4, 8);
    const spineSpacing = area === 'hotel' ? rng.int(26, 38) : area === 'offices' ? rng.int(30, 48) : rng.int(28, 52);
    const crossSpacing = area === 'hotel' ? rng.int(42, 64) : area === 'offices' ? rng.int(36, 58) : rng.int(40, 68);
    const A = AREAS[area] || AREAS.backrooms;
    const zoneWeights = {};
    for (const k in (A.zones || {})) zoneWeights[k] = A.zones[k] * rng.range(0.78, 1.22);

    const dna = {
      key: reg.key, area, majorAxis, corridorWidth, module,
      spineSpacing, spinePhase: rng.int(0, spineSpacing - 1),
      crossSpacing, crossPhase: rng.int(0, crossSpacing - 1),
      crossChance: area === 'hotel' ? rng.range(0.28, 0.52) : area === 'offices' ? rng.range(0.38, 0.68) : rng.range(0.25, 0.55),
      roomScale: rng.range(0.91, 1.09),
      openness: rng.range(0.82, 1.18),
      loopiness: rng.range(0.82, 1.18),
      wideness: rng.range(0.82, 1.18),
      pillarDensity: rng.range(0.88, 1.12),
      landmarkBias: rng.range(0.75, 1.25),
      specialBias: rng.range(0.82, 1.18),
      zoneWeights
    };

    if (W.dna) {
      W.dna.set(reg.key, dna);
      if (W.dna.size > W.limits.dna) W.evict(W.dna, Math.max(1, W.limits.dna >> 2));
    }
    return dna;
  }

  // ---------------------------------------------------------------- colour
  // Backrooms palette, sampled from the reference map; slow fields drift it
  // between cream, yellow, mustard, beige and peach.
  const P_CREAM = BR.hexToRgb('#ecdcb2'), P_YEL = BR.hexToRgb('#e5cc9b'), P_MUST = BR.hexToRgb('#dfc47f');
  const P_BEIGE = BR.hexToRgb('#e5cbae'), P_PEACH = BR.hexToRgb('#dfbd98');
  function backroomsColor(seed, x, y, jit) {
    const warm = contrast(fbm(seed ^ S.WARM, x / 200, y / 200, 2), 2.4);
    const beige = contrast(fbm(seed ^ S.BEIGE, x / 260, y / 260, 2), 2.2);
    let col = warm < 0.5 ? BR.mixRgb(P_CREAM, P_YEL, warm * 2) : BR.mixRgb(P_YEL, P_MUST, (warm - 0.5) * 2);
    const tgt = beige > 0.82 ? P_PEACH : P_BEIGE;
    col = BR.mixRgb(col, tgt, clamp((beige - 0.5) * 1.8, 0, 0.85));
    return BR.scaleRgb(col, 0.97 + 0.06 * jit);
  }
  function areaColor(seed, area, x, y, jit) {
    if (area === 'backrooms') return backroomsColor(seed, x, y, jit);
    return BR.scaleRgb(BR.hexToRgb(AREAS[area].color), 0.98 + 0.04 * jit);
  }

  Object.assign(BR, { AREAS, AREA_ORDER: ORDER, POCKETS, RULES, rule, isPocket, areaAt, areaColor, districtSeed, architectureDNA, ARCHITECTURE_DNA_REGION: DNA_REGION, AREA_CFG: CFG });
})(typeof window !== 'undefined' ? window : globalThis);
