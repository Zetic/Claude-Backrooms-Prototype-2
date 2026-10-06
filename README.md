# Backrooms map prototype (v2)

An infinite, deterministic 2-D map of a Backrooms-style world. Open
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
| Generation stage | manifestation → structural program → DNA → selected structure → world network → physical route space → territory intersection → buildable floor → interiors |
| Debug overlays | manifestation lobes/cuts, program roles, DNA/structure, circulation, parcels/access/violations, continuations |
| Inspect | hover: semantic area, manifestation form/scale, program role, DNA, circulation, local-space geometry/access, zone, room |

The URL hash keeps the seed, position, zoom and toggles
(`#seed=31337&x=0&y=0&z=2&rooms=1`), so any view can be shared or bookmarked.

## How a map is made

```
Semantic area → manifestation → structural program → Architecture DNA
  World circulation → primary / secondary / local / service paths
    Physical route space → canonical world footprints
      Territory intersection → exact clipping, never adaptation
        Buildable floor → footprint minus route reservations
          Parcels → compatible semantic rooms → route interfaces
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

The currently configured semantic roles are shown below. These names are
configuration, not generator branches: manifestation and structure
participation are derived from each area's `role`.

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
corridor width, module, axis preference and circulation density biases. These
parameters are now also data-driven from area definitions rather than
hard-coded Hotel/Office branches.

The generic circulation planner runs once per manifestation before any
territory or room generation. Its inputs are the structural program, lobe
geometry, DNA, and access-depth policy. It never queries territories or
interiors and contains no biome-name branches.

A primary path organizes the core and a distant destination. Other program
regions attach to that connected network using secondary or service paths.
Occasional alternate approaches form loops. Void regions do not request
access. Dead ends and asymmetric branches remain valid.

Jittered sites inside architectural lobes measure access depth against the
selected network. A bounded number of excessive-depth demands create **local
paths in that same world network**. Their identity and extent belong to the
manifestation, not a territory. Open regions tolerate more depth; density and
DNA influence how much access is needed. Sites do not instantiate a regularly
spaced corridor lattice. Unresolved demands remain explicit support-space
outcomes when the route budget is exhausted.

Every path has a stable ID across its turns and a separate ID for each
rectilinear segment. Its width and footprint are fixed in world coordinates.
Territories query every intersecting network, including networks from other
semantic areas. A connector between fragmented lobes therefore continues
through the intervening substrate and any pocket it crosses.

Intersections are always `exact`: a thin slice of a route at an ownership edge
is retained, rather than bending the route to fit that owner. Routes are
reserved before ordinary interior geometry exists.


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

### 5. Buildable space and interiors (spaceplan.js, interior.js, zones.js)

For every manifestation territory and every territory intersecting a route:

1. Clip canonical route footprints to the owned rectangles.
2. Compute their union and subtract it from floor ownership.
3. Merge residual bookkeeping cells into buildable rectangles.
4. Derive parcels from actual route frontage and depth constraints.
5. Keep deep, unsuitable, or unserved residuals as support floor.
6. Select compatible semantic archetypes only inside that buildable space.
7. Attach adjacent interiors to routes, then construct their walls/openings.

The parcel planner cannot create hallways. Dense archetypes require usable
frontage on a real route and a valid geometry envelope. Support space can
remain open or use compatible non-cellular architecture. Anchors attach to
parcels after subtraction and cannot erase a route reservation.

Route space has plain corridor floor with a stable hierarchy-based treatment,
so its colour does not change at a technical territory seam. Parking modules
also require their complete module and edge margins to fit before placement;
columns and bay markings cannot extend into adjacent route space.

Planning limits are explicit:

- 96 route segments, 24 local paths, and 80 access-demand sites per network;
- 64 semantic parcels per owned rectangle;
- cap overflow remains covered as explicit support rectangles;
- bounded rectangle/segment operations, with no runtime flood fill or global
  traversal of the infinite world.

Areas without a manifestation or an intersecting world route retain their
existing irregular, house, or utility grammar. Automatic Maintenance bands
remain removed.

### 6. Route interfaces and boundaries (boundary.js)

Route fragments meeting inside an owner connect as a continuous network.
At a shared territory edge, matching world route IDs remove the seam wall
across the actual occupied interval and create direct room-graph links.
This applies across semantic areas, different DNA records, thin/thick/open
boundary policies, and seams that cut **along** a route as well as across it.

There is no route bend, doorway, or other architectural event at a technical
seam. The surrounding non-route boundary still follows its pair rule.
A route continuation satisfies the pair's connectivity need and suppresses
redundant ordinary seam doors.

Other boundaries retain canonical pair rules, localized door placement and
bounded bypass decisions. Open boundaries link facing rooms.

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

Planner diagnostics are live overlays above cached map tiles. The stage
selector exposes manifestation, program, DNA, world access demand, world route
network, physical route space, territory intersection, reserved intersections,
remaining buildable space, interior parcels, and route interfaces.

The network and physical-space overlays work before any interior has been
built. Later stages use cached reservation, parcel, and boundary records.
Choosing an interior stage enables detail zoom so its data can be generated.

The route colours are pink (primary), cyan (secondary), green (local), and
orange (service). Hover inspection includes the world route ID, intersecting
networks, actual parcel frontage, support reasons, and exact reservation count.

See [the milestone review](docs/WORLD_SPACE_CIRCULATION.md) for reproducible
views and validation evidence.

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
W.structuresIn(x0, y0, x1, y1)                 // intersecting world route networks
W.routesIn(x0, y0, x1, y1)                     // canonical physical segments, no interiors
W.interior(T)                                  // -> { routeNetworks, routeSpace, buildableSpace,
                                               //      obligations, realizations, spacePlan, anchors,
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
| `structure.js` | world path selection, role-derived destinations, depth demand and network caps |
| `spaceplan.js` | route subtraction, frontage/depth policies and parcel caps |
| `zones.js` | semantic generators plus archetype compatibility filters |
| `render.js` | colours, LOD thresholds, tile cache size and planner-debug overlays |

## Tests

Run all canonical seeds with `node tests/run-all.js`, or a single suite:

```
node tests/determinism.test.js [seed]
node tests/circulation.test.js [seed]
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
  eviction and form connected world route graphs at all hierarchy levels.
- Every physical route intersection is exact, with zero local adaptation.
- World routing succeeds when territory and interior queries are forbidden.
- Routes retain identity across three or more territories and semantic areas.
- Rooms, walls, masses, pools, props and columns do not overlap route space.
- Network and parcel planning obey their caps without losing floor coverage.
- Territory parcel generation creates zero local hallway rectangles.
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

- The current configuration deliberately assigns Backrooms the `base` role.
  The manifestation engine itself is role-driven: the configured `base` area
  becomes substrate, `district` areas automatically participate in
  manifestations/structure planning, and `pocket` areas remain contained
  replacements. No manifestation/structure code enumerates semantic names.
- Manifestation footprints are composed from axis-aligned lobe primitives and
  are sampled at territory centres; final area boundaries therefore remain
  rectilinear at plan/detail zoom.
- Structural-program roles are generic, but each semantic area still needs
  useful archetype weights for those roles to produce convincing content.
- Rooms are axis-aligned. Rotated wings from v1 remain intentionally excluded
  because integer-metre geometry keeps tiling and door probing exact.
- World access demands are sampled rather than a complete continuous depth
  solver. Cap-limited or deep residuals remain support floor.
- Different manifestations connect through the established territory/room
  graph; their route networks do not require a single global trunk.
- Vertical connectivity is not planned yet; stairs remain decorative.
- Version 1 is tagged `v1-final`; its old `sites.js`, `cluster.js` and
  `corridors.js` modules are unused.
