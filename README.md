# Backrooms map prototype (v2)

An infinite, deterministic 2D map of a Backrooms-style world. Open
`index.html` in a browser; there is no build step and nothing to install.

- **Infinite.** The world is generated lazily around the view, and nothing
  depends on what was generated before.
- **Deterministic.** The same seed always gives the same map, whatever order
  you visit it in and whatever the caches hold. Text seeds work too.
- **Gap-free.** Every square metre belongs to exactly one territory, so every
  territory always borders other territories.
- **Rule-driven.** How two areas meet (open floor, ordinary wall, strong
  transition wall, doorway) comes from a deterministic pair-rule table.
  Maintenance is never inserted merely to trace an area boundary.

## Controls

| | |
|---|---|
| Pan | drag, or WASD / arrow keys (Shift = faster) |
| Zoom | mouse wheel, pinch, `+` / `-` |
| Area map | `M` or the toggle |
| Overlays | Territories, Super-cells (the lattice), Room graph |
| Generation stage | manifestation → structural program → DNA → selected structure → obligations → realized routes → local space plan → boundaries |
| Debug overlays | manifestation lobes/cuts, program roles, DNA/structure, circulation, parcels/access/violations, continuations |
| Inspect | hover: semantic area, manifestation form/scale, program role, DNA, circulation, local-space geometry/access, zone, room |

The URL hash keeps the seed, position, zoom and toggles
(`#seed=31337&x=0&y=0&z=2&rooms=1`), so any view can be shared or bookmarked.

## How a map is made

```
Semantic area       architectural identity / vocabulary                    areas.js
  Manifestation       spatial extent: compact/branched/interwoven/etc.      manifestation.js
    Structural program generic internal roles: core/branch/open/service/... manifestation.js
      Architecture DNA persistent module, axis and circulation language     areas.js
        Structure       selected major/secondary/service circulation         structure.js
          Territories     exact ownership blocks tiling the plane            layout.js
            Obligations   clipped structure inside each territory            structure.js
              Local plan  access catchments, local halls, usable parcels     spaceplan.js
                Archetypes + detailed rooms                                  zones.js, interior.js
Boundaries           reconcile structures, walls and doors                  boundary.js
```

The central distinction is now **identity versus extent**. An area name says
what architectural vocabulary is available; it no longer means that one huge
continuous region of that architecture must fill the world.

### 1. Territories: exact ownership tiling (layout.js)

The plane is still split into 150 m offset super-cells. Their shifted edges and
owned gap boxes form an exact rectilinear tiling with no gaps or overlaps.
Super-cells are recursively split into territories using the semantic area at
each piece's centre.

Territories remain implementation/ownership units. They do not determine the
shape of a manifestation, the existence of major circulation, or the internal
program of a complex.

### 2. Semantic areas and spatial manifestations (areas.js, manifestation.js)

The currently configured semantic roles are:

- **Backrooms** — dominant substrate when no manifestation claims a point.
- **Offices, Hotel, Poolrooms, Parking** — manifestation-bearing areas.
- **Home, Maintenance** — contained pocket territories.

For manifestation-bearing areas, a coarse deterministic seed first chooses an
area identity from the configured weights. A completely separate generic
manifestation planner then chooses:

- **scale** — small, medium, large or regional;
- **footprint grammar** — compact, elongated, branched, fragmented,
  interwoven or regional;
- a set of overlapping architectural lobes;
- optional substrate cuts/holes that let the surrounding fabric intrude.

Those choices come from the area's data weights. The manifestation generator
does not contain Hotel/Office/Poolrooms/Parking branches.

This allows the same semantic identity to appear as a small embedded complex
in one place and a larger or more fragmented structure elsewhere. Conversely,
different semantic identities can use the same spatial grammar.

The currently configured Backrooms substrate is intentionally dominant, so
manifestations read as structures/enclaves woven through it rather than every
coarse field seed becoming a giant biome.

Home and Maintenance keep their pocket behavior. Maintenance remains an actual
plant/utility territory only; automatic Maintenance boundary strips were
removed in the previous milestone and remain removed here.

### 3. Generic structural program, DNA and circulation

Each manifestation receives a deterministic **structural program** before
territory interiors are built. The program uses semantic-neutral region roles:

| Role | Structural meaning |
|---|---|
| core | primary organizing region |
| branch | extension/wing from the core |
| open | low-partition large space |
| service | support/back-of-house region |
| landmark | focal/distinctive region |
| connector | joins lobes or major regions |
| terminal | destination/end region |
| void | courtyard/substrate intrusion/open gap |
| repeating | dense modular region |

The area grammar maps those roles into its own semantic archetypes through
weights. For example, a repeating region can prefer one area's cellular rooms,
another area's pools, or another area's parking modules without the structural
planner knowing those area names.

Architecture DNA remains the persistent design-language layer: preferred axis,
corridor width, module, candidate spine/cross lattice and density biases. These
parameters are now also data-driven from area definitions rather than
hard-coded Hotel/Office branches.

The generic structure planner runs for every manifestation-bearing area. It
creates a connected major trunk, optional major wing, secondary
branches/bridges, service circulation when the structural program calls for
it, junction/terminus nodes, and role-derived anchors. The structural program
guides which candidate routes are selected and how much circulation a
manifestation receives.

Selected routes are clipped against territories as **obligations**. Each local
realization remains explicit:

- `exact` — planned world-space route fits directly;
- `adapted` — deterministic local dogleg preserves the obligation;
- `failed` — cannot safely fit; failure remains inspectable.

After the district-scale structure is realized, the generic local-space planner
handles access depth, bounded local circulation, parcels and archetype
compatibility. Poolrooms and Parking now use the same structure/local-space
pipeline as the other manifestation-bearing areas rather than remaining on a
separate special-case hall path.


### 4. Pair rules: how areas meet (areas.js, layout.js)

Every pair of touching territories looks up `rule(areaA, areaB)`:

| Pair | Open | Thick | Doors (1 per N m, min-max) | Doorless if safe | Wide doors |
|---|---|---|---|---|---|
| backrooms - backrooms | 30% | - | 18 m, 1-3 | 15% | 25% |
| offices - offices | - | - | 26 m, 1-2 | 10% | 5% |
| hotel - hotel | - | - | 30 m, 1 | 20% | - |
| poolrooms - poolrooms | 35% | - | 20 m, 1-3 | 10% | 40% |
| parking - parking | 50% | - | 20 m, 1-3 | 10% | 60% |
| backrooms - offices | - | - | 30 m, 1-2 | 35% | 5% |
| backrooms - hotel | - | - | 40 m, 1 | 50% | - |
| backrooms - poolrooms | - | 60% | 40 m, 1 | 60% | 10% |
| backrooms - parking | - | 40% | 30 m, 1-2 | 40% | 40% |
| hotel - offices | - | - | 40 m, 1 | 40% | - |
| offices - parking | - | 100% | 40 m, 1 | 60% | - |
| hotel - poolrooms | - | 100% | 40 m, 1 | 60% | - |
| offices - poolrooms | - | 100% | 52 m, 1 | 55% | 5% |
| parking - poolrooms | - | 100% | 46 m, 1 | 45% | 20% |
| hotel - parking | - | 100% | 55 m, 1 | 60% | 5% |

The last three pairs previously carved continuous 3-4 m Maintenance bands
along their area boundary. That feature has been removed. They now meet
directly at a strong transition wall with sparse localized access. Random
super-cell-edge Maintenance/service bands were removed as well.

**"Doorless if safe"** means a pair is optional. It drops its doors only if a
detour of at most five territories exists over pairs that retain connectivity,
so optional edges cannot recursively justify one another. Contacts shorter
than 8 m are optional; contacts without at least 3.2 m of usable edge become
wall-only corner contacts.

All pair decisions are canonical and cached by the territory-pair key.

### 5. Local space planning and interiors (spaceplan.js, interior.js, zones.js)

For every territory covered by a manifestation structure plan, generation
separates **space planning** from **semantic room generation**:

1. Realize district route obligations as exact/adapted/failed geometry.
2. Analyze the residual floor as rectangles adjacent to circulation.
3. If a region is too deep to be served directly, add a bounded local branch
   that physically starts on its serving corridor. Derived local halls form a
   tree rather than disconnected parallel strips.
4. Subdivide the served mass into architectural parcels based on frontage,
   depth, aspect ratio and the area's DNA module.
5. Classify unsuitable or unserved residuals as support space instead of
   forcing a dense room archetype into them.
6. Only then select a semantic archetype compatible with the parcel.

The planner is generic. Current policies exist for all configured semantic
areas, and every manifestation-bearing area now consumes the same structural
and local-space pipeline. The important contract is independent of a
particular room name: dense cellular archetypes require intentional access and
a compatible geometry envelope.

This prevents arbitrary residual rectangles from stretching their assigned
semantic type. For example, `guest` is no longer accepted for any rectangle;
it is one archetype constrained by the same generic parcel metadata used by
the selector. Oversized/deep residual mass creates local circulation or becomes
support/open architecture instead of being interpreted as one stretched room.

Planning is intentionally bounded:

- at most 64 parcels per local-plan part;
- at most 4 derived local routes;
- at most 4 local service-depth levels;
- direct rectangle/segment/graph operations only;
- no raster flood-fill, open-ended search or regenerate-until-valid loop.

Areas without a manifestation structure retain their established local
grammar: Backrooms uses irregular subdivision, Home uses houses/gardens and
Maintenance uses plant-room pockets.

After planning, `zones.js` supplies semantic detail (office, guest, open,
gallery, courtyard, machinery, pools, parking, etc.), and `interior.js`
connects the resulting block graph with circulation-first spanning connections
and loops.

### 6. Boundaries (boundary.js)

Each shared wall is built once from the pair's rule and both interiors. Before
ordinary door placement, matching **selected route identities** are reconciled.
If the same district route reaches the same shared edge from both sides, that
exact corridor-width interval is removed from the territory wall and linked
directly as a `continuation`. The rest of the shared edge remains a
normal wall, so only the architectural feature crosses the technical seam.
Accidental corridor overlaps do not qualify: the stable circulation contract
must match on both sides. A continuation also satisfies the pair's connectivity
need, so a redundant normal seam door is not added.

For boundaries without a continuation, doors are probed on both sides; spots on
corridors, halls and aisles are preferred, so circulation lines up across
territories. Open boundaries have no wall, and every pair of rooms facing
across them is linked.

### The room graph

`BR.roomGraph(world, items)` returns `{ nodes, edges }`:

- nodes are `'territoryKey:roomIndex'`;
- edges are `[a, b, kind, external]`, where `external` marks links through a
  territory boundary.

This is the walkable structure a game would use. The tests check that every
room in a 1.8 km square is reachable.

## Rendering (render.js)

- **Tiles.** The map is drawn into cached 256 px tiles at zoom levels
  2^(k/2). Each frame blits the tiles and spends a ~14 ms budget building the
  missing ones, nearest first. While a tile is pending, a coarser or finer
  cached level stands in. Panning is a blit, about 60 fps even in headless
  software rendering.
- **Level of detail by zoom:**
  - under 0.4 px/m: a raster of the area field;
  - plan view: territories, outlines and area names;
  - 1.1 px/m and up: interiors;
  - then, as you zoom in further: pillars, furniture, partitions, and hatching
    (stair treads, parking bays, pipes).
- **Wall weights.** Walls between territories of the same area are drawn like
  interior walls, so the tiling does not show. Walls between different areas
  are heavier, and thick walls are solid strips.

### Generation debugger

Planner diagnostics are drawn as live overlays rather than cached map tiles.
The **Generation stage** selector now exposes the full calculation:

1. area manifestations;
2. structural-program regions;
3. Architecture DNA;
4. candidate circulation lattice;
5. selected structure;
6. territory obligations;
7. exact/adapted/failed circulation realization;
8. local space planning;
9. boundary reconciliation.

The manifestation view shows the lobes that define each spatial occurrence and
its substrate cuts. The structural-program view shows generic roles such as
core, branch, open, service, connector, terminal and void before they become
semantic room types.

Local-space overlays continue to expose parcel boundaries, access ownership,
derived local circulation and geometry/access violations. Debug rendering
reads cached generation records; turning on an overlay does not rerun planning.


## Data API (for a game)

```js
const W = new BR.World(seed);                  // caches are bounded; limits can be set
W.collect(x0, y0, x1, y1, budgetMs, { interiors: true })
                                               // -> { territories, interiors, boundaries, done }
W.territoriesIn(x0, y0, x1, y1)                // plan only (cheap)
W.final(T)                                     // semantic area name
W.manifestation(T)                             // spatial manifestation containing T
W.manifestationsIn(x0, y0, x1, y1)             // visible manifestation records
W.program(T)                                   // generic structural program
W.programsIn(x0, y0, x1, y1)                   // visible structural programs
W.architecture(T)                              // persistent architecture DNA
W.structure(T)                                 // selected circulation/anchor structure
W.structuresIn(x0, y0, x1, y1)                 // visible manifestation structures
W.interior(T)                                  // -> { obligations, realizations, spacePlan, anchors,
                                               //      blocks, zones, rooms, links, walls, ... }
W.boundary(A, B)                               // -> { wall, semantic, walls, doors, continuations, links }
W.inspect(x, y)                                // area / manifestation / program role / structure / room
BR.pairInfo(W, A, B)                           // the rule decision for a pair
BR.roomGraph(W, items)                         // walkable graph
```

Geometry is in integer metres, with no rotations. Wall lists are flat
`[x0, y0, x1, y1, ...]`; solid lists are flat rects.

## Tuning knobs

| Where | What |
|---|---|
| `areas.js` `AREAS` | semantic grammar plus manifestation/scale/program/architecture weights |
| `areas.js` `RULES` | the pair-rule table above |
| `areas.js` `CFG` | manifestation seed spacing, density and field warp |
| `manifestation.js` | generic footprint grammars, scales, structural roles and role→archetype biases |
| `layout.js` `CFG` | super-cell size, edge offsets, ear merge thresholds, bypass depth |
| `structure.js` | generic manifestation route selection, hierarchy and role-derived anchors |
| `spaceplan.js` | access/depth/frontage policies and hard parcel/local-route caps |
| `zones.js` | semantic generators plus archetype compatibility filters |
| `render.js` | colours, LOD thresholds, tile cache size and planner-debug overlays |

## Tests

```
node tests/determinism.test.js [seed]
```

**Determinism:** the output does not depend on any of the following.

- Visit order.
- Cache eviction, with caches of a dozen entries.
- Request order.
- Tiled or one-shot builds.
- Distance from the origin, checked at 1,000,000 m.

The suite also checks that different seeds give different maps.

**Structure:**

- Manifestations are deterministic and use multiple scales and all generic
  footprint grammars across the canonical seeds.
- The same semantic identity can appear through multiple manifestation forms.
- Structural programs span the manifestation-bearing semantic areas and all
  required generic roles have a core.
- The territorial tiling remains exact: no gaps or overlaps at about 900k
  sampled points, and area sums match exactly.
- Former Maintenance-band area pairs use direct strong transitions.
- Zero automatic Maintenance strips are generated.
- Maintenance/Home pockets remain contained in one host and retain access.
- Manifestation structure plans remain deterministic through aggressive cache
  eviction and form connected major/secondary/service route graphs.
- Territory route obligations remain explicit as exact/adapted/failed.
- Local space planning obeys its hard parcel/route caps.
- Occupiable parcels satisfy their access/geometry constraints.
- Unserved floor never receives a dense cellular archetype.
- Semantic archetypes are rejected when incompatible with parcel geometry;
  the guest-room case is retained as a regression check rather than a special
  planning path.
- Selected routes cross technical territory seams without wall overlap or
  redundant seam doors.
- No door placement fails.
- Every room is reachable.

All checks pass for seeds 31337, 7, 12345, 99 and 4242.

## Limitations / next steps

- The current configuration deliberately makes Backrooms the dominant
  substrate. The manifestation mechanism itself is generic, but changing which
  identity is substrate would still require an area-field configuration change.
- Manifestation footprints are composed from axis-aligned lobe primitives and
  are sampled at territory centres; final area boundaries therefore remain
  rectilinear at plan/detail zoom.
- Structural-program roles are generic, but each semantic area still needs
  useful archetype weights for those roles to produce convincing content.
- Rooms are axis-aligned. Rotated wings from v1 remain intentionally excluded
  because integer-metre geometry keeps tiling and door probing exact.
- Failed route obligations remain explicit. A future higher-level rerouter can
  repair clusters of failures across a manifestation instead of relying only
  on local dogleg adaptation.
- Vertical connectivity is not planned yet; stairs remain decorative.
- Version 1 is tagged `v1-final`; its old `sites.js`, `cluster.js` and
  `corridors.js` modules are unused.
