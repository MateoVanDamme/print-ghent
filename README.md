# print-ghent

Static web app to crop a watertight, slicer-ready 3D-printable STL of any region of Ghent. Source data is the City of Gent's open "Gent in 3D" dataset (https://data.stad.gent/explore/dataset/gent-in-3d). Sister project to [fly-over-gent](https://fly.mateovandamme.com/), which is the free-flight viewer over the same data.

**Live demo:** https://print-gent.mateovandamme.com/

## How it works

1. Pick a region on the map (Shift-drag for a square, hold Alt for freeform, or type the corner + width/height).
2. Fetches the relevant 1km × 1km terrain + buildings tiles as STL from the GCS bucket the viewer also uses (`gs://fly-over-ghent/stl/`).
3. Runs a watertight-slab pipeline entirely in the browser:
   - Plane-clips the terrain to the bbox so the slab has flat sides.
   - Builds the 4 walls + flat bottom.
   - Adds buildings (whole, or only fully-inside if "drop edge buildings" is on).
4. Exports a single STL via `STLExporter`.

No backend, no build step. Open `index.html` over a static server.

## Run locally

```
python -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

Any static host. The site is hard-coded to fetch tile STLs from `https://storage.googleapis.com/fly-over-ghent/`, so the GCS bucket needs to allow CORS from this origin (the bucket is already public-read; usually `Access-Control-Allow-Origin: *` is set, no change needed).

Service worker invalidation: bump `CACHE_NAME` in `sw.js` (e.g. `print-ghent-tiles-v2`) when the upstream STL contents change so existing visitors evict their cached tiles.

### License
This work is licensed under a
Creative Commons (4.0 International License)
Attribution—Noncommercial—Share Alike
