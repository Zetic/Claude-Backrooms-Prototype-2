# Backrooms map prototype (v2)

An infinite, deterministic 2D map of a Backrooms-style world. Open
`index.html` in a browser; there is no build step and nothing to install.

- **Infinite.** The world is generated lazily around the view, and nothing
  depends on what was generated before.
- **Deterministic.** The same seed always gives the same map, whatever order
  you visit it in and whatever the caches hold. Text seeds work too.
- **Gap-free.** Every square metre belongs to exactly one territory, so every
  territory always borders other territories.
- **Rule-driven.** How two areas meet (an open floor, a wall with doors, a
  thick wall, or a maintenance band between them) comes from a pair-rule
  table, not from chance.

## Controls

| | |
|---|---|
| Pan | drag, or WASD / arrow keys (Shift = faster) |
| Zoom | mouse wheel, pinch, `+` / `-` |
| Area map | `M` or the toggle |
| Overlays | Territories, Super-cells (the lattice), Room graph |
| Inspect | hover: area, host area, territory, zone, room kind |

The URL hash keeps the seed, position, zoom and toggles
(`#seed=31337&x=0&y=0&z=2&rooms=1`), so any view can be shared or bookmarked.

## How a map is made: three nested levels

```
Areas        what kind of place: Backrooms, Offices, Hotel, ...      areas.js
  Territories   20-60 m blocks that tile the plane with no gaps        layout.js
    Rooms          the floor plan inside each territory                 interior.js, zones.js
Boundaries   the shared wall between two territories, with its doors  boundary.js
```

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
*districts*; Home is a *pocket*; Maintenance is a *network* (pockets plus
bands).

### 3. Pair rules: how areas meet (areas.js, layout.js)

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
| offices - poolrooms, parking - poolrooms, hotel - parking | **forbidden** | | | | |

- **Forbidden pairs never get a door.** One side gives up a 3-4 m maintenance
  band along the shared edge. If neither side is deep enough for a band, the
  pair gets a thick wall instead. About a third of these bands have one service
  door.
- **"Doorless if safe"** means the pair is *optional*. It drops its doors only
  if a detour of at most 5 territories exists over pairs that do keep theirs,
  so connectivity is never lost. Contacts shorter than 8 m are always optional.
  Contacts with no stretch of at least 3.2 m (corner touches) never get a door.
- **Service lines:** runs of three super-cell edges sometimes (22%) become long
  maintenance corridors. They are bands carved along one side, and they link
  to the maintenance network.

All of these decisions are made per pair from local information only, and they
are cached by the pair's key.

### 4. Interiors (interior.js, zones.js)

For each territory:

1. **Carve bands.** Remove the maintenance strips the plan assigns to this
   territory.
2. **Block out** the rest in the area's style:
   - *irregular* (Backrooms): one great hall, a few big rooms, or many
     smaller ones.
   - *spine* (Offices): a corridor with suites on both sides, sometimes a
     cross corridor.
   - *hotel*: guest-room wings with en-suites and suites, ballrooms, garden
     courts, lobbies.
   - *hall* (Poolrooms, Parking): a main hall plus a service strip.
   - *house* (Home): one to three houses with gardens; hallway, front and
     back rows of rooms.
   - *utility* (Maintenance): plant rooms.
3. **Fill each block with a zone type.** Types come from the area's catalogue
   weights, avoiding the types of neighbouring blocks. Examples: open hall,
   split, ring, office, warren, stalls, store, gallery, courtyard, pools,
   parking, machinery. Large single-rect territories occasionally become
   *landmarks*, such as a grand hall, atrium, theatre, long gallery or pool hall.
4. **Connect.** A random spanning tree over the blocks, plus loops. Corridor
   walls are tried first and service strips last. A door is only placed where
   both sides are walkable, and never into an en-suite bathroom. If a block
   would otherwise be cut off, a doorway is carved through solid mass as a
   last resort.

### 5. Boundaries (boundary.js)

Each shared wall is built once from the pair's rule and both interiors. Doors
are probed on both sides; spots on corridors, halls and aisles are preferred,
so circulation lines up across territories. Open boundaries have no wall, and
every pair of rooms facing across them is linked.

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

## Data API (for a game)

```js
const W = new BR.World(seed);                  // caches are bounded; limits can be set
W.collect(x0, y0, x1, y1, budgetMs, { interiors: true })
                                               // -> { territories, interiors, boundaries, done }
W.territoriesIn(x0, y0, x1, y1)                // plan only (cheap)
W.final(T)                                     // area name of territory T
W.interior(T)                                  // -> { blocks, zones, rooms: [{rects, kind, zone}], links,
                                               //      walls, minor, masses, voids, pools, props, pillars, ... }
W.boundary(A, B)                               // -> { wall, walls, doors: [{x, y, w, o, kind}], links }
W.inspect(x, y)                                // area / territory / zone / room at a point
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
| `layout.js` `CFG` | super-cell size, edge offsets, ear merge thresholds, service-line odds, bypass depth |
| `zones.js` | zone generators and their size fits |
| `render.js` | colours, LOD thresholds, tile cache size |

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

- The tiling is exact: no gaps or overlaps at about 900k sample points, and
  the areas sum correctly.
- Forbidden pairs always have a band or a thick wall, and no normal doors.
- Bands are maintenance floor along their whole length.
- Pockets sit inside one host and have a door.
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
- No vertical connections yet. Stairs are decorative.
- Version 1 is tagged `v1-final` in git. Its old modules `sites.js`,
  `cluster.js` and `corridors.js` are no longer used.
