import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { buildPrintable, tilesForBbox } from './cropper.js';

const L = window.L;
const proj4 = window.proj4;

// Belgian Lambert 72 (EPSG:31370). Standard 7-parameter Helmert to WGS84.
proj4.defs(
    'EPSG:31370',
    '+proj=lcc +lat_1=49.8333339 +lat_2=51.1666672333 +lat_0=90 ' +
    '+lon_0=4.36748666666667 +x_0=150000.013 +y_0=5400088.438 +ellps=intl ' +
    '+towgs84=-106.869,52.2978,-103.724,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs'
);
const wgsToL72 = proj4('EPSG:4326', 'EPSG:31370');
const l72ToWgs = proj4('EPSG:31370', 'EPSG:4326');

const GCS_BASE = 'https://storage.googleapis.com/fly-over-ghent/';
const TILE_SIZE = 1000;
const MAX_TILES = 25;

const stlLoader = new STLLoader();

const $ = (id) => document.getElementById(id);
const els = {
    tlX: $('tl-x'), tlY: $('tl-y'), sizeW: $('size-w'), sizeH: $('size-h'),
    tileCount: $('tile-count'),
    baseHeight: $('base-height'), dropEdge: $('drop-edge'),
    generate: $('generate'), download: $('download'), status: $('status'),
};

// Map setup, centered on Ghent.
const map = L.map('map', { boxZoom: false }).setView([51.0543, 3.7174], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
}).addTo(map);

// Outline of dataset coverage so users know where they can crop.
const coverageTiles = new Set();
fetch('data/gent-in-3d.json').then(r => r.ok ? r.json() : null).then((cov) => {
    if (!cov) return;
    for (const entry of cov) {
        const [xs, ys] = entry.vaknummer.split('_');
        const tx = parseInt(xs, 10) * 1000;
        const ty = parseInt(ys, 10) * 1000;
        coverageTiles.add(`${tx}_${ty}`);
    }
    // Faint per-tile fill for coverage indication.
    // Grid lines as a single deduplicated multi-polyline so adjacent tiles
    // don't double-stroke their shared edges. Each tile contributes its
    // bottom + left edges; top/right are only added at the coverage
    // boundary where the neighbor is missing.
    const segments = [];
    const project = (x, y) => {
        const p = l72ToWgs.forward([x, y]);
        return [p[1], p[0]];  // [lat, lng]
    };
    for (const key of coverageTiles) {
        const [tx, ty] = key.split('_').map(Number);
        // Project each corner independently — Lambert-72 axes don't align
        // with WGS84 lat/lng, so SW.lat != SE.lat (and SW.lng != NW.lng).
        // Reusing one corner's coords for adjacent corners would offset
        // each tile's lines by a few meters, breaking the grid alignment.
        const swLL = project(tx, ty);
        const seLL = project(tx + TILE_SIZE, ty);
        const nwLL = project(tx, ty + TILE_SIZE);
        const neLL = project(tx + TILE_SIZE, ty + TILE_SIZE);
        segments.push([swLL, seLL]); // bottom
        segments.push([swLL, nwLL]); // left
        if (!coverageTiles.has(`${tx}_${ty + TILE_SIZE}`)) {
            segments.push([nwLL, neLL]); // top edge only if no north neighbor
        }
        if (!coverageTiles.has(`${tx + TILE_SIZE}_${ty}`)) {
            segments.push([seLL, neLL]); // right edge only if no east neighbor
        }
    }
    L.polyline(segments, {
        color: '#DC143C', weight: 1, opacity: 0.6,
        lineCap: 'butt', interactive: false,
    }).addTo(map);
}).catch(() => {});

// Shift-drag selection.
let drawing = null;
let selection = null; // L.Rectangle in WGS84
let bboxL72 = null;

map.on('mousedown', (e) => {
    if (!e.originalEvent.shiftKey) return;
    e.originalEvent.preventDefault();
    drawing = e.latlng;
    if (selection) { map.removeLayer(selection); selection = null; }
    map.dragging.disable();
});
// Snap the dragged corner so the bbox is a perfect square in Lambert-72 meters.
// Hold Alt to disable and draw a freeform rectangle.
function snapToSquare(startLatLng, currLatLng) {
    const start = wgsToL72.forward([startLatLng.lng, startLatLng.lat]);
    const curr = wgsToL72.forward([currLatLng.lng, currLatLng.lat]);
    const dx = curr[0] - start[0];
    const dy = curr[1] - start[1];
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = start[0] + Math.sign(dx || 1) * size;
    const sy = start[1] + Math.sign(dy || 1) * size;
    const wgs = l72ToWgs.forward([sx, sy]);
    return L.latLng(wgs[1], wgs[0]);
}

map.on('mousemove', (e) => {
    if (!drawing) return;
    const corner = e.originalEvent.altKey ? e.latlng : snapToSquare(drawing, e.latlng);
    const sw = wgsToL72.forward([drawing.lng, drawing.lat]);
    const ne = wgsToL72.forward([corner.lng, corner.lat]);
    applyBbox(sw[0], sw[1], ne[0], ne[1]);
});
function endDrawing() {
    if (!drawing) return;
    drawing = null;
    map.dragging.enable();
}
map.on('mouseup', endDrawing);
document.addEventListener('mouseup', endDrawing);

// Single source of truth for the bbox. Updates the map rectangle, the input
// fields (unless `syncInputs` is false — used when the change came FROM the
// inputs to avoid overwriting what the user is typing), the derived size /
// tile readouts, and the validation status.
function applyBbox(x1, y1, x2, y2, { syncInputs = true } = {}) {
    bboxL72 = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    [x1, y1, x2, y2] = bboxL72;

    const sw = l72ToWgs.forward([x1, y1]);
    const ne = l72ToWgs.forward([x2, y2]);
    const bounds = L.latLngBounds([sw[1], sw[0]], [ne[1], ne[0]]);
    if (selection) selection.setBounds(bounds);
    else selection = L.rectangle(bounds, { color: '#DC143C', weight: 2, fillOpacity: 0.1 }).addTo(map);

    if (syncInputs) {
        // Top-left = NW corner = (x1, y2). Width grows east, height grows south.
        els.tlX.value  = x1.toFixed(0);
        els.tlY.value  = y2.toFixed(0);
        els.sizeW.value = (x2 - x1).toFixed(0);
        els.sizeH.value = (y2 - y1).toFixed(0);
    }
    for (const k of ['tlX', 'tlY', 'sizeW', 'sizeH']) els[k].disabled = false;

    const tiles = tilesForBbox(x1, y1, x2, y2);
    els.tileCount.textContent = `${tiles.length}`;

    const missingFromCoverage = coverageTiles.size > 0
        ? tiles.filter(([tx, ty]) => !coverageTiles.has(`${tx}_${ty}`))
        : [];
    const tooBig = tiles.length > MAX_TILES;
    const tooSmall = (x2 - x1) < 50 || (y2 - y1) < 50;
    const allMissing = missingFromCoverage.length === tiles.length && coverageTiles.size > 0;
    els.generate.disabled = tooBig || tooSmall || allMissing;
    if (tooBig) {
        setStatus(`Selection covers ${tiles.length} tiles (max ${MAX_TILES}); pick a smaller area.`, 'error');
    } else if (tooSmall) {
        setStatus('Selection too small (< 50 m).', 'error');
    } else if (allMissing) {
        setStatus('Selection is outside the dataset (no tiles available).', 'error');
    } else if (missingFromCoverage.length > 0) {
        setStatus(`Warning: ${missingFromCoverage.length} of ${tiles.length} tiles are outside the dataset; the slab may have holes.`);
    } else {
        setStatus('');
    }
}

for (const k of ['tlX', 'tlY', 'sizeW', 'sizeH']) {
    els[k].addEventListener('input', () => {
        const tlX = parseFloat(els.tlX.value);
        const tlY = parseFloat(els.tlY.value);
        const w   = parseFloat(els.sizeW.value);
        const h   = parseFloat(els.sizeH.value);
        if (![tlX, tlY, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return;
        applyBbox(tlX, tlY - h, tlX + w, tlY, { syncInputs: false });
    });
}

function setStatus(msg, kind = '') {
    els.status.textContent = msg;
    els.status.className = kind;
}

async function fetchTile(tx, ty, kind) {
    const suffix = kind === 'Trn' ? '_10_0_N_2013.stl' : '_10_2_N_2013.stl';
    const url = `${GCS_BASE}stl/${kind}_${tx}_${ty}${suffix}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const raw = stlLoader.parse(buf);
    // Drop normals/colors so mergeVertices only considers positions.
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', raw.attributes.position);
    return g;
}

els.generate.addEventListener('click', async () => {
    if (!bboxL72) return;
    els.generate.disabled = true;
    els.download.style.display = 'none';
    const baseHeight = Math.max(0, parseFloat(els.baseHeight.value) || 10);
    const dropEdgeBuildings = els.dropEdge.checked;
    const tiles = tilesForBbox(...bboxL72);

    try {
        const t0 = performance.now();
        const { geometry, stats } = await buildPrintable({
            bbox: bboxL72, tiles, baseHeight, dropEdgeBuildings,
            fetchTile, onProgress: (msg) => setStatus(msg),
        });
        const ms = performance.now() - t0;

        const exporter = new STLExporter();
        const mesh = new THREE.Mesh(geometry);
        const data = exporter.parse(mesh, { binary: true });
        const blob = new Blob([data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);

        const [x1, y1, x2, y2] = bboxL72.map(v => Math.round(v));
        const filename = `Print_${x1}-${y1}-${x2}-${y2}.stl`;
        els.download.href = url;
        els.download.download = filename;
        els.download.textContent = `Download ${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`;
        els.download.style.display = 'block';

        const missing = stats.missing.length ? `\nMissing: ${stats.missing.join(', ')}` : '';
        setStatus(
            `Done in ${(ms / 1000).toFixed(1)} s.\n` +
            `${stats.totalFaces.toLocaleString()} faces total ` +
            `(slab ${stats.terrainFaces.toLocaleString()}, buildings ${stats.buildingFaces.toLocaleString()}).` +
            missing
        );
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, 'error');
    } finally {
        els.generate.disabled = false;
    }
});
