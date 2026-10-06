/*
 * areas.js - level 1: what kind of space is where, and how kinds meet.
 *
 * Every territory belongs to exactly one semantic AREA. Spatial extent is a
 * separate concern:
 *   base     - dominant substrate when no manifestation claims the point
 *   district - semantic identity realized through a generic manifestation
 *   pocket   - one contained territory replacing a compatible host
 *
 * District-role areas no longer imply one huge compact biome. The generic
 * manifestation layer chooses scale/footprint independently, and may produce
 * compact, elongated, branched, fragmented, interwoven or regional forms.
 * The field is sampled at territory centres, so final semantic edges still
 * follow territory edges exactly.
 *
 * RULES says how every pair of areas meets: wall type, door spacing and how
 * often a pair may have no door at all. Mixed-area transitions remain direct
 * architectural boundaries; Maintenance is generated only as its own pocket/
 * territory, never as a gasket automatically inserted between biomes.
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
      architecture: { corridor3:0.32, module:[4,8], spine:[28,52], cross:[40,68], crossChance:[0.25,0.55] },
      roomScale: [0.95, 1.45], pillars: 0.5, pOpen: [0.15, 0.45], pLoop: [0.15, 0.45], pWide: [0.08, 0.3]
    },
    offices: {
      name: 'Offices', role: 'district', color: '#d9c6c4',
      split: { tmin: 18, tmax: 48, pSplit: 0.6, maxAspect: 2.4 },
      style: 'spine', chunk: [8, 22], depthMin: 6,
      zones: { office: 4, open: 1.6, stalls: 1.4, warren: 1, store: 0.6, corridorRooms: 0.4, split: 0.5 },
      landmarks: { atrium: 1 }, landmarkP: 0.02,
      architecture: { corridor3:0.32, module:[4,7], spine:[30,48], cross:[36,58], crossChance:[0.38,0.68] },
      manifestation: {
        forms:{compact:1.1,elongated:1.2,branched:2.4,fragmented:1.25,interwoven:1.45,regional:0.22},
        scales:{small:1.4,medium:3.2,large:0.8,regional:0.08}, scale:0.95, intrusion:0.22
      },
      program:{roles:{core:1,branch:1.8,open:1.15,service:0.7,landmark:0.45,connector:0.9,terminal:0.6,void:0.25,repeating:2.2},routeDensity:0.95},
      roomScale: [0.9, 1.2], pillars: 0.6, pOpen: [0.05, 0.2], pLoop: [0.1, 0.3], pWide: [0.03, 0.12]
    },
    hotel: {
      name: 'Hotel', role: 'district', color: '#adb6c7',
      split: { tmin: 16, tmax: 64, pSplit: 0.4, maxAspect: 4.5, shortMax: 28 },
      style: 'hotel', chunk: [4, 8], depthMin: 4,
      zones: { guest: 5.5, open: 1.5, gallery: 0.8, courtyard: 0.45 },
      landmarks: { atrium: 1 }, landmarkP: 0.03,
      architecture: { corridor3:0.22, module:[4,6], spine:[26,38], cross:[42,64], crossChance:[0.28,0.52] },
      manifestation: {
        forms:{compact:1.15,elongated:1.8,branched:2.1,fragmented:1.05,interwoven:1.35,regional:0.16},
        scales:{small:1.5,medium:3.4,large:0.7,regional:0.06}, scale:0.92, intrusion:0.2
      },
      program:{roles:{core:1.2,branch:1.9,open:1.2,service:0.8,landmark:0.5,connector:0.9,terminal:0.8,void:0.35,repeating:2.1},routeDensity:0.9},
      roomScale: [0.9, 1.1], pillars: 0.7, pOpen: [0, 0.05], pLoop: [0, 0.1], pWide: [0, 0.05]
    },
    poolrooms: {
      name: 'Poolrooms', role: 'district', color: '#e3ebeb',
      split: { tmin: 22, tmax: 70, pSplit: 0.35, maxAspect: 2.5 },
      style: 'hall',
      zones: { pools:4, pool:1.2, courtyard:0.7, open:0.9, stalls:0.45, room:0.3, stairs:0.2 },
      main: { pools: 4, pool: 1, courtyard: 0.4, open: 0.6 },
      service: { stalls: 2, room: 1.2, stairs: 0.3 },
      landmarks: { poolHall: 1 }, landmarkP: 0.05,
      architecture: { corridor3:0.58, module:[5,9], spine:[34,58], cross:[46,74], crossChance:[0.25,0.5] },
      manifestation: {
        forms:{compact:0.7,elongated:0.8,branched:1.35,fragmented:1.15,interwoven:1.65,regional:0.75},
        scales:{small:0.7,medium:2.1,large:1.6,regional:0.55}, scale:1.05, intrusion:0.28
      },
      program:{roles:{core:1.2,branch:1.1,open:2.1,service:0.55,landmark:0.65,connector:0.8,terminal:0.65,void:0.9,repeating:1.1},routeDensity:0.72},
      roomScale: [1, 1.3], pillars: 0.7, pOpen: [0.2, 0.5], pLoop: [0.2, 0.4], pWide: [0.2, 0.45]
    },
    parking: {
      name: 'Parking', role: 'district', color: '#bebdb7',
      split: { tmin: 26, tmax: 84, pSplit: 0.3, maxAspect: 2.5 },
      style: 'hall',
      zones: { parking:4, store:1, open:0.8, room:0.45, stairs:0.28 },
      main: { parking: 4, store: 1, open: 0.7 },
      service: { room: 1.5, stairs: 0.8 },
      architecture: { corridor3:0.72, module:[6,10], spine:[38,64], cross:[48,78], crossChance:[0.22,0.48] },
      manifestation: {
        forms:{compact:0.75,elongated:1.5,branched:1.1,fragmented:0.75,interwoven:0.7,regional:1.0},
        scales:{small:0.45,medium:1.65,large:2.0,regional:0.8}, scale:1.08, intrusion:0.1
      },
      program:{roles:{core:1,branch:1.1,open:1.5,service:0.85,landmark:0.22,connector:0.8,terminal:0.45,void:0.15,repeating:1.8},routeDensity:0.68},
      roomScale: [1.1, 1.4], pillars: 0.9, pOpen: [0.3, 0.6], pLoop: [0.2, 0.4], pWide: [0.3, 0.6]
    },
    home: {
      name: 'Home', role: 'pocket', color: '#cfa985',
      pocket: { hosts: ['backrooms', 'offices', 'hotel'], p: 0.045, minDim: 14, maxDim: 42, salt: 61 },
      style: 'house',
      architecture: { corridor3:0.05, module:[4,7], spine:[30,48], cross:[42,68], crossChance:[0.2,0.45] },
      roomScale: [0.9, 1.1], pillars: 0, pOpen: [0, 0.1], pLoop: [0, 0.1], pWide: [0, 0.1]
    },
    maintenance: {
      name: 'Maintenance', role: 'pocket', color: '#b5b2a8',
      pocket: { hosts: ['backrooms', 'parking', 'poolrooms'], p: 0.025, minDim: 12, maxDim: 40, salt: 62 },
      style: 'utility',
      architecture: { corridor3:0.15, module:[4,7], spine:[28,46], cross:[40,64], crossChance:[0.2,0.4] },
      roomScale: [0.7, 0.9], pillars: 0, pOpen: [0, 0.1], pLoop: [0, 0.1], pWide: [0, 0.05]
    }
  };
  const ORDER = Object.keys(AREAS);
  const POCKETS = ['home', 'maintenance'];
  const MANIFEST_TYPES = { offices: 3, parking: 1.4, poolrooms: 1.4, hotel: 1.1 };

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
    // Former maintenance-band pairs now meet directly through a strong
    // transition wall with sparse localized access.
    'offices|poolrooms': R(0, 1, 52, 1, 1, 0.55, 0.05),
    'parking|poolrooms': R(0, 1, 46, 1, 1, 0.45, 0.2),
    'hotel|parking': R(0, 1, 55, 1, 1, 0.6, 0.05)
  };
  const DEFAULT_RULE = R(0, 0, 30, 1, 1, 0.4, 0.1);
  function rule(a, b) {
    const k = a < b ? a + '|' + b : b + '|' + a;
    return RULES[k] || DEFAULT_RULE;
  }
  function isPocket(area) { return area === 'home' || area === 'maintenance'; }

  // ------------------------------------------------ manifestation field
  // Compatibility names are retained because structure/layout APIs already
  // use `district` as the stable manifestation identifier.
  const CFG = { districtCell:380, districtP:0.74, warp:42, warpScale:280 };
  function districtSeed(seed,a,b) { return BR.manifestationSeed(seed,a,b); }
  function areaAt(W,x,y) { return BR.manifestationAt(W,x,y); }

  // ------------------------------------------------------ architecture DNA
  // Territories are generation ownership units, not architectural identity
  // units. A district (or a coarse base-area region) therefore owns a stable
  // DNA record that nearby territories inherit. Local territory RNG still
  // varies individual rooms, while the DNA preserves corridor rhythm,
  // preferred axis, module size, density and zone tendencies across seams.
  const DNA_REGION = 760;

  function architectureRegion(T, area) {
    const A = AREAS[area] || AREAS.backrooms;
    if (T.district && A.role === 'district') {
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
      majorAxis = d.axis || (rng.f() < 0.5 ? 'x' : 'y');
    } else majorAxis = rng.f() < 0.5 ? 'x' : 'y';

    const A = AREAS[area] || AREAS.backrooms, AC=A.architecture||AREAS.backrooms.architecture;
    const corridorWidth = rng.f() < (1-(AC.corridor3||0.32)) ? 2 : 3;
    const module = rng.int(AC.module[0], AC.module[1]);
    const spineSpacing = rng.int(AC.spine[0], AC.spine[1]);
    const crossSpacing = rng.int(AC.cross[0], AC.cross[1]);
    const zoneWeights = {};
    for (const k in (A.zones || {})) zoneWeights[k] = A.zones[k] * rng.range(0.78, 1.22);

    const dna = {
      key: reg.key, area, majorAxis, corridorWidth, module,
      spineSpacing, spinePhase: rng.int(0, spineSpacing - 1),
      crossSpacing, crossPhase: rng.int(0, crossSpacing - 1),
      crossChance: rng.range(AC.crossChance[0], AC.crossChance[1]),
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

  Object.assign(BR, { AREAS, AREA_ORDER: ORDER, POCKETS, MANIFEST_TYPES, RULES, rule, isPocket,
    areaAt, areaColor, districtSeed, architectureDNA, ARCHITECTURE_DNA_REGION: DNA_REGION, AREA_CFG: CFG });
})(typeof window !== 'undefined' ? window : globalThis);
