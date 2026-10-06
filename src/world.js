/*
 * world.js - lazy, cached, order-independent access to the generated world.
 *
 *   plan(i, j)        super-cell territories (cheap)          layout.js
 *   pattern(T)        architectural groups and shared ports  spaceplan.js
 *   interior(T)       rooms of territory T (built on demand)  interior.js
 *   boundary(A, B)    shared wall + doors between A and B     boundary.js
 *
 * Every cache entry is a pure function of (seed, coordinates). Caches are
 * bounded and can be dropped at any time; rebuilding gives the same result.
 */
(function (root) {
  'use strict';
  const BR = root.BR;

  const DEFAULT_LIMITS = { plans: 6000, patterns:4000, interiors: 5000, boundaries: 14000, pairs: 60000, manifests: 2400, dna: 4000, programs: 2000, structures: 2000 };
  const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

  class World {
    constructor(seed, opts) {
      this.seed = seed >>> 0;
      this.limits = Object.assign({}, DEFAULT_LIMITS, opts && opts.limits);
      this.plans = new Map();
      this.interiors = new Map();
      this.patterns = new Map();
      this.boundaries = new Map();
      this.pairs = new Map();
      this.manifests = new Map();
      this.dna = new Map();
      this.programs = new Map();
      this.structures = new Map();
      this.stats = { interiorMs: 0, interiorsBuilt: 0, boundariesBuilt: 0, programsBuilt: 0, structuresBuilt: 0, patternsBuilt:0, infillFallbacks:0, doorFailures: 0 };
    }
    evict(map, n) {
      const it = map.keys();
      for (let i = 0; i < n; i++) { const r = it.next(); if (r.done) break; map.delete(r.value); }
    }

    // ------------------------------------------------------------ plan layer
    plan(i, j) {
      const k = i + ',' + j;
      let p = this.plans.get(k);
      if (!p) {
        p = BR.buildPlan(this, i, j);
        this.plans.set(k, p);
        if (this.plans.size > this.limits.plans) this.evict(this.plans, Math.max(1,this.limits.plans >> 2));
      }
      return p;
    }
    terr(key) {
      const c = key.indexOf(':'), ij = key.slice(0, c).split(',');
      return this.plan(+ij[0], +ij[1]).territories[+key.slice(c + 1)];
    }
    adj(T) { return BR.adjacency(this, T); }
    final(T) { return BR.finalArea(this, T); }
    manifestSeed(a,b) {
      const k=a+','+b;
      let M=this.manifests.get(k);
      if(M){this.manifests.delete(k);this.manifests.set(k,M);return M;}
      M=BR.manifestationSeed(this.seed,a,b);
      this.manifests.set(k,M);
      if(this.manifests.size>this.limits.manifests)this.evict(this.manifests,Math.max(1,this.limits.manifests>>2));
      return M;
    }
    architecture(T) { return BR.architectureDNA(this, T, this.final(T)); }
    pattern(T) {
      let p=this.patterns.get(T.key);
      if(p){this.patterns.delete(T.key);this.patterns.set(T.key,p);return p;}
      p=BR.buildPatternPlan(this,T);this.patterns.set(T.key,p);this.stats.patternsBuilt++;
      if(this.patterns.size>this.limits.patterns)this.evict(this.patterns,Math.max(1,this.limits.patterns>>2));
      return p;
    }
    manifestation(T) {
      if (!T || !T.district) return null;
      const ij=T.district.split(',');
      return this.manifestSeed(+ij[0],+ij[1]);
    }
    programBy(area, district) {
      if (!area || !district || !BR.STRUCTURE_AREAS.has(area)) return null;
      const k=area+':'+district;
      let P=this.programs.get(k);
      if(P){this.programs.delete(k);this.programs.set(k,P);return P;}
      P=BR.buildManifestationProgram(this,area,district);
      if(P){
        this.stats.programsBuilt++;
        this.programs.set(k,P);
        if(this.programs.size>this.limits.programs)this.evict(this.programs,Math.max(1,this.limits.programs>>2));
      }
      return P;
    }
    program(T) { return this.programBy(this.final(T),T.district); }
    structureBy(area, district) {
      if (!area || !district || !BR.STRUCTURE_AREAS.has(area)) return null;
      const k = area + ':' + district;
      let P = this.structures.get(k);
      if (P) { this.structures.delete(k); this.structures.set(k, P); return P; }
      P = BR.buildDistrictStructure(this, area, district);
      if (P) {
        this.stats.structuresBuilt++;
        this.structures.set(k, P);
        if (this.structures.size > this.limits.structures) this.evict(this.structures, Math.max(1, this.limits.structures >> 2));
      }
      return P;
    }
    structure(T) { return this.structureBy(this.final(T), T.district); }
    structuresIn(x0, y0, x1, y1) {
      const out=[];
      // Same bounded manifestation-address halo as the semantic field. The
      // one-cell structure query omitted regional/branched extents near edges.
      for(const M of this.manifestationsIn(x0-3,y0-3,x1+3,y1+3)) {
        const P=this.structureBy(M.type,M.id);
        if(P && P.bounds[2]>=x0 && P.bounds[0]<=x1 && P.bounds[3]>=y0 && P.bounds[1]<=y1)out.push(P);
      }
      return out;
    }
    manifestationsIn(x0,y0,x1,y1) {
      const C=BR.AREA_CFG.districtCell,out=[],R=BR.MANIFEST_SEARCH_CELLS||1;
      for(let a=Math.floor(x0/C)-R;a<=Math.floor(x1/C)+R;a++)for(let b=Math.floor(y0/C)-R;b<=Math.floor(y1/C)+R;b++){
        const M=this.manifestSeed(a,b);if(!M.exists)continue;
        const B=M.bounds;if(B[2]<x0||B[0]>x1||B[3]<y0||B[1]>y1)continue;
        out.push(M);
      }
      return out;
    }
    programsIn(x0,y0,x1,y1) {
      const out=[];
      for(const M of this.manifestationsIn(x0,y0,x1,y1)){
        const P=this.programBy(M.type,M.id);if(P)out.push(P);
      }
      return out;
    }
    connectionsIn(x0,y0,x1,y1) {
      const out=[],seen=new Set();
      for(const T of this.territoriesIn(x0,y0,x1,y1))for(const p of this.pattern(T).ports){
        if(seen.has(p.id))continue;seen.add(p.id);out.push(p);
      }
      return out;
    }
    color(T) {
      if (!T._rgb) T._rgb = BR.areaColor(this.seed, this.final(T), T.cx, T.cy, (T.h >>> 8) / 16777216);
      return T._rgb;
    }

    // -------------------------------------------------------- rooms & walls
    interior(T) {
      let I = this.interiors.get(T.key);
      if (I) { this.interiors.delete(T.key); this.interiors.set(T.key, I); return I; }
      const t0 = now();
      I = BR.buildInterior(this, T);
      this.stats.interiorMs += now() - t0;
      this.stats.interiorsBuilt++;
      this.interiors.set(T.key, I);
      if (this.interiors.size > this.limits.interiors) this.evict(this.interiors, Math.max(1,this.limits.interiors >> 2));
      return I;
    }
    hasInterior(T) { return this.interiors.has(T.key); }
    boundary(A, B) {
      if (B.key < A.key) { const t = A; A = B; B = t; }
      const k = A.key + '|' + B.key;
      let b = this.boundaries.get(k);
      if (b) return b;
      b = BR.buildBoundary(this, A, B);
      this.stats.boundariesBuilt++;
      this.boundaries.set(k, b);
      if (this.boundaries.size > this.limits.boundaries) this.evict(this.boundaries, Math.max(1,this.limits.boundaries >> 2));
      return b;
    }

    /** Territories whose bbox intersects the rect, nearest to its centre first. */
    territoriesIn(x0, y0, x1, y1) {
      const SC = BR.LAYOUT.SC, out = [];
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      for (let i = Math.floor(x0 / SC) - 1; i <= Math.floor(x1 / SC) + 1; i++)
        for (let j = Math.floor(y0 / SC) - 1; j <= Math.floor(y1 / SC) + 1; j++)
          for (const T of this.plan(i, j).territories) {
            const B = T.bbox;
            if (B[2] <= x0 || B[0] >= x1 || B[3] <= y0 || B[1] >= y1) continue;
            out.push(T);
          }
      const d = (T) => { const dx = T.cx - cx, dy = T.cy - cy; return dx * dx + dy * dy; };
      out.sort((a, b) => d(a) - d(b) || (a.key < b.key ? -1 : 1));
      return out;
    }

    /**
     * Everything needed to draw a world rect. With opts.interiors, rooms are
     * built (time-boxed: `done` is false if the budget ran out - just ask
     * again next frame). Boundaries need both sides' interiors, so the ring of
     * neighbours around the view is built too.
     */
    collect(x0, y0, x1, y1, budgetMs, opts) {
      opts = opts || {};
      const t0 = now(), over = () => now() - t0 > budgetMs;
      const territories = this.territoriesIn(x0, y0, x1, y1);
      const out = { territories, interiors: [], boundaries: [], done: true };
      if (!opts.interiors) return out;
      const ring = [], seenRing = new Set(territories.map((T) => T.key));
      for (const T of territories) {
        if (!this.hasInterior(T)) {
          if (over()) { out.done = false; if (opts.genOnly) return out; continue; }
        }
        out.interiors.push(this.interior(T));
        for (const n of this.adj(T)) if (!seenRing.has(n.U.key)) { seenRing.add(n.U.key); ring.push(n.U); }
      }
      for (const U of ring) {
        if (this.hasInterior(U)) continue;
        if (over()) { out.done = false; if (opts.genOnly) return out; break; }
        this.interior(U);
      }
      const seen = new Set();
      for (const T of territories) {
        if (!this.hasInterior(T)) continue;
        for (const n of this.adj(T)) {
          const U = n.U, k = BR.pairKey(T, U);
          if (seen.has(k) || !this.hasInterior(U)) continue;
          seen.add(k);
          if (!this.boundaries.has(k) && over()) { out.done = false; if (opts.genOnly) return out; continue; }
          out.boundaries.push(this.boundary(T, U));
        }
      }
      return out;
    }

    /** What is at (x,y): area, territory, zone, room. */
    inspect(x, y) {
      const T = BR.territoryAt(this, x, y);
      if (!T) return null;
      const r = { territory: T, area: this.final(T), base: T.base, district: T.district,
        manifestationId: T.manifestation || T.district };
      r.manifestation = this.manifestation(T);
      r.program = this.program(T);
      r.programRole = r.program ? BR.programRoleAt(r.program,x,y) : null;
      r.dna = this.architecture(T);
      r.structure = this.structure(T);
      r.pattern = this.pattern(T);
      const I = this.interiors.get(T.key);
      if (I) {
        const k = BR.interiorRoomAt(I, x, y);
        if (k >= 0) { r.room = I.rooms[k]; r.roomIndex = k; }
        r.block = BR.interiorBlockAt(I, x, y);
        r.traversals = I.traversals;
        r.ports = I.ports;
        r.diagnostics = I.diagnostics;
      }
      return r;
    }
  }

  /**
   * Room graph of a collect() result. Nodes: 'territory:room' at a world
   * point. Edges: [a, b, kind, external] - links inside a territory, and
   * doors / openings through territory boundaries (external).
   */
  function roomGraph(W, items) {
    const nodes = new Map(), edges = [];
    for (const I of items.interiors) {
      I.rooms.forEach((r, ri) => {
        const q = r.rects[0];
        nodes.set(I.key + ':' + ri, { x: (q[0] + q[2]) / 2, y: (q[1] + q[3]) / 2 });
      });
      for (const L of I.links) edges.push([I.key + ':' + L.a, I.key + ':' + L.b, L.kind, false]);
    }
    for (const B of items.boundaries) for (const L of B.links) edges.push([L.a.key + ':' + L.a.room, L.b.key + ':' + L.b.room, L.kind, true]);
    return { nodes, edges };
  }

  BR.World = World;
  BR.roomGraph = roomGraph;
})(typeof window !== 'undefined' ? window : globalThis);
