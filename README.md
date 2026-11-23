# Circumnavigate

Slice the Earth with a flat plane through its center and see everything the
resulting **great circle** crosses: continents, oceans and seas, countries,
cities, mountains, deserts, lakes, rivers, famous landmarks and lines of
latitude and longitude.

Built for classrooms: clean, friendly, and works on phones, tablets,
Chromebooks and projectors.

## What you can do

- **Place the line**: tap anywhere on the globe to set the starting point, then
  turn the compass dial to point it in any direction.
- **Search**: type a city, country, landmark, mountain or `lat, lon` to start
  there, and pick a second place to *aim through*.
- **Explore the journey**: an ordered list of everything along the way, with
  distances. Tap an entry to fly to it. Turn categories on or off.
- **Interesting paths**: record-breaking circles found by testing 60,000 of
  them: most land, most water, fewest/most land–water crossings, most/fewest
  countries, longest sea voyage, longest walk, most continents, plus the
  Equator, pole-to-pole and a New York → Tokyo flight.
- **Share**: the URL always describes the current path
  (`?lat=…&lon=…&dir=…`), so any path can be shared as a link.
- km / miles toggle, “use my location”, dark mode.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

### Data

Map data comes from [Natural Earth](https://www.naturalearthdata.com/) (public
domain). The processed file `public/data/world.json` is committed, so you only
need these if you want to change the data:

```bash
npm run data      # download + simplify Natural Earth → public/data/world.json
npm run presets   # search all great circles → src/data/presets.json
```

Landmarks are hand-picked in `scripts/landmarks.mjs`.

### How it works

- `src/lib/geo.js`: sphere math. A path is a start point plus a compass
  bearing, which defines the plane through Earth's center.
- `src/lib/analyze.js`: walks the circle in 3,600 steps (~11 km each), tests
  each step against country, ocean, lake and landform polygons, finds river
  crossings where a river segment changes side of the plane, and lists
  cities/peaks/landmarks within a short distance of the line. Runs in a Web
  Worker.
- `src/globe.js`: three.js globe; the map texture is drawn from the same data.
- `scripts/find-presets.mjs`: rasterises the world, scores 60,000 evenly
  spaced circles, then hill-climbs the best ones for each record.

## Deploy

**GitHub Pages**: `.github/workflows/deploy.yml` builds and publishes on every
push to `main`. In the repo go to *Settings → Pages* and set *Source* to
**GitHub Actions** (one time).

**Vercel**: import the repo; Vercel detects Vite automatically (build
`npm run build`, output `dist`). The build uses relative paths, so it works at
a sub-path (Pages) or a domain root (Vercel) without changes.
