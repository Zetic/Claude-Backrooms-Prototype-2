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
| Generation stage | DNA → candidate lattice → selected structure → obligations → realized routes → local space plan → boundary reconciliation |
| Debug overlays | DNA/structure, obligations, realized routes, local circulation, space parcels/access/violations, continuations |
| Inspect | hover: area, DNA, structure, route realization, local-space geometry/access, zone, room |

The URL hash keeps the seed, position, zoom and toggles
(`#seed=31337&x=0&y=0&z=2&rooms=1`), so any view can be shared or bookmarked.

## How a map is made

```
Areas          what kind of place: Backrooms, Offices, Hotel, ...       areas.js
  DNA            persistent architectural identity for a district/region areas.js
    Structure      major/secondary/service circulation + anchors          structure.js
      Territories    20-60 m ownership blocks that tile the plane         layout.js
        Obligations   clipped pieces of the district structure             structure.js
          Local plan  access catchments, local halls, usable parcels       spaceplan.js
            Archetypes + detailed rooms                                    zones.js, interior.js
Boundaries      reconcile shared structures and ordinary doors             boundary.js
```

Territories are ownership/build units. They no longer decide whether a major
Hotel/Office route exists. The district structure plan decides that first in
world coordinates; each territory only realizes the piece crossing its owned
rectangles.

### 1. Territories: a pinwheel tiling (layout.js)

The plane is split into 150 m super-cells. Each lattice edge is pushed 5-34 m
off the grid line, and the direction alternates in a checkerboard. That way the
four edges meeting at a lattice vertex always leave a small gap box (never an
overlap). Each gap box is handed to one of its four cells as an "ear". The
result is an exact tiling with no T-junction grid showing.

Each cell's core and ears are then split recursively into territories, using
the split parameters of the area at each piece's centre. Ears that are too
small (under 12 m or 240 m²) merge into the core territory they share the
longest edge with.

Because territories are cut from these offset super-cells, their outlines are
chunky and rectilinear rather than grid-like.

### 2. Areas: a field and pockets (areas.js)

- **Districts** (Offices, Hotel, Poolrooms, Parking): seeds sit on a jittered
  380 m lattice. Each one is a warped blend of an ellipse and a box. A
  territory takes the district at its centre.
- **Backrooms** is what remains: the base area that everything else sits in.
- **Pockets** (Home, Maintenance) replace a whole territory. They are only
  placed where every neighbour has the same host area, so a pocket always sits
  fully inside one host. Each pocket gets exactly one front door, onto a
  non-pocket neighbour.

Area roles: Backrooms is *base*; Offices, Hotel, Poolrooms and Parking are
*districts*; Home and Maintenance are *pockets*. Maintenance exists as real
territories/plant spaces only. It is not generated as a strip around mixed
areas or along super-cell edges.


### Architecture DNA: continuity across territories

Territories are generation ownership units, but they are no longer treated as
independent architectural identities. Each district gets one deterministic
architecture-DNA record (Backrooms/base space uses larger coarse DNA regions).
Territories in that region inherit the same preferred axis, corridor width,
module size, spine/cross-corridor lattice, density biases and zone-weight
profile, with only small local variation.

For Offices and Hotel this is also spatial: corridor spines first try to land
on the district's shared world-coordinate lattice. Adjacent territories can
therefore continue the same corridor line instead of independently choosing a
new vertical/horizontal offset at every territory seam. If a territory is too
small or the shared line cannot fit safely, it falls back to the old local
placement rule. The DNA does **not** force every territory to be identical or
turn a whole district into one corridor; it provides a common architectural
language and a set of recurring circulation lines.

Hover inspection shows the DNA key, preferred axis, corridor width and module
size for the territory under the pointer.

For Offices and Hotel, DNA now supplies the **candidate lattice**, not the
final corridor pattern. The district structure planner selects a connected
subset from that lattice and gives those selected routes stable identities.

### 3. District structure: what actually exists (structure.js)

Each Hotel/Office district deterministically creates one structure plan before
individual interiors are generated.

The plan contains:

- a **major trunk** and, where the district supports it, one parallel wing;
- **secondary branches/bridges** selected at the district level;
- an attached **service circulation** network;
- explicit **junction** and **terminus** nodes;
- topology-attached special-space anchors such as Hotel lobbies/ballrooms/
  courtyards and Office atriums/open workspaces;
- the full DNA candidate lattice for diagnostics, even though only a sparse
  subset is selected.

The selected graph is deliberately not a complete rectangular grid. Branches
can terminate intentionally; a dead end is a planned property of the district
rather than the result of one territory independently deciding not to continue
a corridor.

Selected routes are clipped against territory rectangles to form
**obligations**. Local generation records each obligation as:

- `exact` — the planned line fits directly;
- `adapted` — a deterministic local dogleg preserves the planned
  entry/exit while moving the interior segment to a safe line;
- `failed` — the territory cannot safely realize it; the reason is retained
  for debugging instead of silently replacing it with unrelated architecture.

Special-space anchors are applied to suitable non-circulation blocks near
their planned topology node, so a lobby/atrium/ballroom is attached to the
district network rather than randomly replacing a corridor-bearing territory.

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

For Hotel/Office territories covered by a district structure plan, generation
now separates **space planning** from **semantic room generation**:

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

The planner is generic. Current policies exist for Hotel, Offices, Backrooms,
Poolrooms, Parking, Home and Maintenance; structured Hotel/Office interiors
are the first consumers. The important contract is independent of a particular
room name: dense cellular archetypes require intentional access and a
compatible geometry envelope.

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

Areas without district structure retain their established local grammar:
Backrooms irregular subdivision, Poolrooms/Parking halls, Home houses/gardens
and Maintenance plant-room pockets. The generic planner/policy API is available
for those area-specific structure systems when they gain district-scale plans.

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
The **Generation stage** selector exposes the calculation in order:

1. DNA regions;
2. DNA candidate circulation lattice;
3. selected district routes plus junctions/anchors;
4. clipped territory obligations;
5. exact/adapted/failed district-route realization;
6. local space planning;
7. boundary reconciliation.

Local-space overlays expose the next decision layer independently: parcel
boundaries, access ownership, derived local circulation and geometry/access
violations. Selected district-route hierarchy remains separately visible for
major, secondary and service circulation. Debug drawing consumes cached
generation records; enabling an overlay does not rerun planning.

## Data API (for a game)

```js
const W = new BR.World(seed);                  // caches are bounded; limits can be set
W.collect(x0, y0, x1, y1, budgetMs, { interiors: true })
                                               // -> { territories, interiors, boundaries, done }
W.territoriesIn(x0, y0, x1, y1)                // plan only (cheap)
W.final(T)                                     // area name of territory T
W.architecture(T)                              // persistent architecture DNA
W.structure(T)                                 // district structure plan for this territory
W.structuresIn(x0, y0, x1, y1)                 // visible Hotel/Office structure plans
W.interior(T)                                  // -> { obligations, realizations, spacePlan, anchors,
                                               //      blocks, zones, rooms, links, walls, ... }
W.boundary(A, B)                               // -> { wall, semantic, walls, doors, continuations, links }
W.inspect(x, y)                                // area / DNA / structure / route / territory / room at a point
BR.pairInfo(W, A, B)                           // the rule decision for a pair
BR.roomGraph(W, items)                         // walkable graph
```

Geometry is in integer metres, with no rotations. Wall lists are flat
`[x0, y0, x1, y1, ...]`; solid lists are flat rects.

## Tuning knobs

| Where | What |
|---|---|
| `areas.js` `AREAS` | per area: colour, split sizes, style, zone weights, landmarks, door/loop/open probabilities, pocket frequency and size |
| `areas.js` `RULES` | the pair-rule table above |
| `areas.js` `CFG` | district lattice spacing, density, warp |
| `layout.js` `CFG` | super-cell size, edge offsets, ear merge thresholds, bypass depth |
| `structure.js` | district route selection, hierarchy, branch/service structure and special-space anchoring |
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

- The territorial tiling remains exact: no gaps or overlaps at about 900k
  sampled points, and area sums match exactly.
- Former Maintenance-band area pairs use direct strong transitions.
- Zero automatic Maintenance strips are generated.
- Maintenance/Home pockets remain contained in one host and retain access.
- District structure plans remain deterministic through aggressive cache
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

- The far raster draws the district field itself, so its edges are smooth
  blobs. From plan zoom up, the same districts snap to territory edges.
- Area colours are a stand-in theme. The architecture (areas, rules, tiling)
  is the part this prototype is about.
- Rooms are axis-aligned. Rotated wings from v1 were dropped, because
  integer-metre geometry keeps the tiling and door probing exact.
- District structure planning and the new local-space realization path
  currently apply to **Hotel and Offices**. The local planner itself is
  area-generic. Poolrooms and Parking still use their existing hall grammars;
  future district planners should expose pool/walkway and parking/aisle
  obligations to the same local-space layer rather than copying Hotel logic.
- Failed route obligations are retained and visible in the debugger. A future
  planner can reroute around a cluster of failures at district scope instead
  of relying only on local dogleg adaptation.
- No vertical connections yet. Stairs are decorative.
- Version 1 is tagged `v1-final` in git. Its old modules `sites.js`,
  `cluster.js` and `corridors.js` are no longer used.
