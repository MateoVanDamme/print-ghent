// Port of make_printable.py: crop tile STLs to a Lambert-72 bbox, fuse seams,
// build a watertight slab, drop edge-touching buildings, return a single STL.

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const TILE_SIZE = 1000;

// Sort 3 ints ascending. Used to build a canonical edge key.
function edgeKey(a, b) { return a < b ? `${a}_${b}` : `${b}_${a}`; }

/**
 * Walk boundary edges into closed loops, undirected (the source meshes have
 * inconsistent face winding so we ignore edge orientation entirely). At each
 * step we pick any non-prev neighbor; if the only neighbor is the previous
 * vertex (dead end), we fall through and end the chain. Returns closed loops
 * and a count of any unconsumed open chains.
 */
function walkAllBoundaryLoops(boundaryEdges) {
    const adj = new Map();
    const add = (a, b) => {
        if (!adj.has(a)) adj.set(a, []);
        adj.get(a).push(b);
    };
    for (const [a, b] of boundaryEdges) { add(a, b); add(b, a); }
    const consume = (a, b) => {
        const arr = adj.get(a); arr.splice(arr.indexOf(b), 1);
        const arr2 = adj.get(b); arr2.splice(arr2.indexOf(a), 1);
    };

    const loops = [];
    const chains = [];
    while (true) {
        let start = -1;
        for (const [v, arr] of adj) {
            if (arr.length > 0) { start = v; break; }
        }
        if (start === -1) break;

        const loop = [start];
        let prev = -1;
        let curr = start;
        let safety = boundaryEdges.length + 2;
        let closed = false;
        while (safety-- > 0) {
            const arr = adj.get(curr);
            if (!arr || arr.length === 0) break;
            let nxt = -1;
            for (const v of arr) { if (v !== prev) { nxt = v; break; } }
            if (nxt === -1) nxt = arr[0]; // only prev remains; take it anyway
            consume(curr, nxt);
            if (nxt === start) { closed = true; break; }
            loop.push(nxt);
            prev = curr;
            curr = nxt;
        }
        if (closed && loop.length >= 3) loops.push(loop);
        else if (loop.length >= 2) chains.push(loop);
    }
    return { loops, chains };
}

/** Drop triangles whose three indices aren't all distinct. mergeVertices can
 * collapse two corners of a near-degenerate triangle to the same index,
 * leaving a stray edge that masquerades as a boundary half-edge. */
function dropDegenerate(geometry) {
    const indices = geometry.index.array;
    const kept = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    if (kept.length !== indices.length) {
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(kept), 1));
    }
}

/** Signed area of a polygon in the XY plane (positive = CCW from +Z). */
function signedAreaXY(positions, loop) {
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        area += positions[3 * a] * positions[3 * b + 1]
              - positions[3 * b] * positions[3 * a + 1];
    }
    return area / 2;
}

/**
 * Now that boundary detection is undirected, return canonical-pair edges
 * (sorted endpoints) instead of oriented half-edges.
 */
function boundaryEdges(indices) {
    const counts = new Map();
    const pair = new Map();
    for (let i = 0; i < indices.length; i += 3) {
        const v = [indices[i], indices[i + 1], indices[i + 2]];
        for (let j = 0; j < 3; j++) {
            const a = v[j], b = v[(j + 1) % 3];
            const key = edgeKey(a, b);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if (!pair.has(key)) pair.set(key, a < b ? [a, b] : [b, a]);
        }
    }
    const result = [];
    for (const [key, count] of counts) {
        if (count === 1) result.push(pair.get(key));
    }
    return result;
}

/**
 * Snap the outermost row of boundary vertices onto the tile edges.
 * Mirrors _snap_tile_boundary in make_printable.py.
 */
function snapTileBoundary(geometry, tx, ty, tol = 5.0, rowTol = 0.5) {
    const positions = geometry.attributes.position.array;
    const indices = geometry.index.array;
    const boundary = boundaryEdges(indices);
    const boundaryVerts = new Set();
    for (const [a, b] of boundary) { boundaryVerts.add(a); boundaryVerts.add(b); }
    const bv = [...boundaryVerts];

    const edges = [
        { axis: 0, target: tx,             extreme: 'min' },
        { axis: 0, target: tx + TILE_SIZE, extreme: 'max' },
        { axis: 1, target: ty,             extreme: 'min' },
        { axis: 1, target: ty + TILE_SIZE, extreme: 'max' },
    ];
    for (const { axis, target, extreme } of edges) {
        const candidates = bv.filter(i => Math.abs(positions[3 * i + axis] - target) < tol);
        if (candidates.length === 0) continue;
        let edgeVal = positions[3 * candidates[0] + axis];
        for (const i of candidates) {
            const v = positions[3 * i + axis];
            edgeVal = extreme === 'min' ? Math.min(edgeVal, v) : Math.max(edgeVal, v);
        }
        for (const i of candidates) {
            if (Math.abs(positions[3 * i + axis] - edgeVal) < rowTol) {
                positions[3 * i + axis] = target;
            }
        }
    }
    geometry.attributes.position.needsUpdate = true;
}

/**
 * For vertices whose XY coincide (after 1 cm quantization), set Z to the
 * group mean. Lets a subsequent mergeVertices fuse seam pairs.
 */
function averageZAtSharedXY(positions, count) {
    const buckets = new Map(); // "qx_qy" -> [zSum, n, [vertIdx,...]]
    for (let i = 0; i < count; i++) {
        const qx = Math.round(positions[3 * i] * 100);
        const qy = Math.round(positions[3 * i + 1] * 100);
        const key = `${qx}_${qy}`;
        const z = positions[3 * i + 2];
        const entry = buckets.get(key);
        if (entry) { entry.sum += z; entry.n += 1; entry.idx.push(i); }
        else buckets.set(key, { sum: z, n: 1, idx: [i] });
    }
    for (const { sum, n, idx } of buckets.values()) {
        if (n < 2) continue;
        const avg = sum / n;
        for (const i of idx) positions[3 * i + 2] = avg;
    }
}

/**
 * Concatenate a list of indexed BufferGeometries into one (positions only).
 */
function concatGeometries(geometries) {
    let totalVerts = 0, totalIdx = 0;
    for (const g of geometries) {
        totalVerts += g.attributes.position.count;
        totalIdx += g.index.array.length;
    }
    const positions = new Float32Array(totalVerts * 3);
    const indices = new Uint32Array(totalIdx);
    let vOff = 0, iOff = 0;
    for (const g of geometries) {
        const p = g.attributes.position.array;
        positions.set(p, vOff * 3);
        const src = g.index.array;
        for (let i = 0; i < src.length; i++) indices[iOff + i] = src[i] + vOff;
        vOff += g.attributes.position.count;
        iOff += src.length;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    out.setIndex(new THREE.BufferAttribute(indices, 1));
    return out;
}

/**
 * Drop indexed faces whose centroid lies outside the bbox.
 */
function filterByCentroid(geometry, x1, y1, x2, y2) {
    const positions = geometry.attributes.position.array;
    const indices = geometry.index.array;
    const kept = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        const cx = (positions[3 * a] + positions[3 * b] + positions[3 * c]) / 3;
        const cy = (positions[3 * a + 1] + positions[3 * b + 1] + positions[3 * c + 1]) / 3;
        if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) kept.push(a, b, c);
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(kept), 1));
}

/**
 * Clip an indexed mesh by an axis-aligned plane. Triangles fully on the
 * kept side are preserved; fully on the other side are dropped; straddling
 * triangles are split, with new vertices interpolated exactly onto the
 * plane. Used to give the terrain crop a clean rectangular boundary
 * instead of the zig-zag you'd get from a triangle-level inside/outside
 * test. CCW winding is preserved through the split.
 */
function clipByPlane(geometry, axis, threshold, keepGTE) {
    const oldPos = geometry.attributes.position.array;
    const oldIdx = geometry.index.array;
    const positions = Array.from(oldPos);
    const newIndices = [];

    const inside = (i) => {
        const v = positions[3 * i + axis];
        return keepGTE ? v >= threshold : v <= threshold;
    };
    const interp = (i, j) => {
        const vi = positions[3 * i + axis];
        const vj = positions[3 * j + axis];
        const t = (threshold - vi) / (vj - vi);
        const newIdx = positions.length / 3;
        positions.push(
            positions[3 * i]     + t * (positions[3 * j]     - positions[3 * i]),
            positions[3 * i + 1] + t * (positions[3 * j + 1] - positions[3 * i + 1]),
            positions[3 * i + 2] + t * (positions[3 * j + 2] - positions[3 * i + 2]),
        );
        return newIdx;
    };

    for (let f = 0; f < oldIdx.length; f += 3) {
        const a = oldIdx[f], b = oldIdx[f + 1], c = oldIdx[f + 2];
        const ia = inside(a), ib = inside(b), ic = inside(c);
        const cnt = (ia ? 1 : 0) + (ib ? 1 : 0) + (ic ? 1 : 0);
        if (cnt === 0) continue;
        if (cnt === 3) { newIndices.push(a, b, c); continue; }
        let p, q, r;
        if (cnt === 1) {
            // Rotate so p is the inside vertex; q, r are outside (CCW order).
            if (ia) { p = a; q = b; r = c; }
            else if (ib) { p = b; q = c; r = a; }
            else { p = c; q = a; r = b; }
            const pq = interp(p, q);
            const rp = interp(r, p);
            newIndices.push(p, pq, rp);
        } else {
            // Rotate so r is the outside vertex; p, q are inside (CCW order).
            if (!ia) { p = b; q = c; r = a; }
            else if (!ib) { p = c; q = a; r = b; }
            else { p = a; q = b; r = c; }
            const qr = interp(q, r);
            const rp = interp(r, p);
            newIndices.push(p, q, qr);
            newIndices.push(p, qr, rp);
        }
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    out.setIndex(new THREE.BufferAttribute(new Uint32Array(newIndices), 1));
    return out;
}

/**
 * Edge-based union-find: faces sharing a topological edge are unioned.
 * Returns an array of arrays of face indices, one per connected component.
 */
function connectedComponentsByEdge(indices) {
    const numFaces = indices.length / 3;
    const parent = new Int32Array(numFaces);
    for (let i = 0; i < numFaces; i++) parent[i] = i;
    const find = (x) => {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    };
    const union = (x, y) => {
        const rx = find(x), ry = find(y);
        if (rx !== ry) parent[rx] = ry;
    };

    const edgeMap = new Map();
    for (let f = 0; f < numFaces; f++) {
        const a = indices[3 * f], b = indices[3 * f + 1], c = indices[3 * f + 2];
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const key = edgeKey(u, v);
            const prev = edgeMap.get(key);
            if (prev !== undefined) union(f, prev);
            else edgeMap.set(key, f);
        }
    }
    const groups = new Map();
    for (let f = 0; f < numFaces; f++) {
        const r = find(f);
        let arr = groups.get(r);
        if (!arr) { arr = []; groups.set(r, arr); }
        arr.push(f);
    }
    return [...groups.values()];
}

/**
 * Filter connected components by their relationship to the bbox.
 *
 * mode = 'fully-inside': keep only components whose every face centroid is
 *   inside the bbox. Components that cross the edge are dropped entirely
 *   (clean rectangular outline at the building level).
 *
 * mode = 'any-inside': keep components that have at least one face centroid
 *   inside the bbox, intact. Buildings that touch the bbox edge stay whole
 *   and overhang the slab; buildings fully outside are dropped. Avoids
 *   slicing 3D shells along an arbitrary plane.
 */
function filterComponents(geometry, x1, y1, x2, y2, mode) {
    const positions = geometry.attributes.position.array;
    const indices = geometry.index.array;
    const numFaces = indices.length / 3;

    const inBox = new Uint8Array(numFaces);
    for (let f = 0; f < numFaces; f++) {
        const a = indices[3 * f], b = indices[3 * f + 1], c = indices[3 * f + 2];
        const cx = (positions[3 * a] + positions[3 * b] + positions[3 * c]) / 3;
        const cy = (positions[3 * a + 1] + positions[3 * b + 1] + positions[3 * c + 1]) / 3;
        inBox[f] = (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) ? 1 : 0;
    }

    const components = connectedComponentsByEdge(indices);
    const kept = [];
    for (const comp of components) {
        const keep = mode === 'fully-inside'
            ? comp.every(f => inBox[f])
            : comp.some(f => inBox[f]);
        if (keep) {
            for (const f of comp) {
                kept.push(indices[3 * f], indices[3 * f + 1], indices[3 * f + 2]);
            }
        }
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(kept), 1));
}

/**
 * Build a watertight slab from a (cropped) terrain mesh: top surface +
 * vertical walls + flat bottom. Boundary edges from the terrain's face
 * winding are traversed in topological order; consistent winding flows
 * through to walls and bottom so all normals point outward.
 */
function buildSlab(terrain, baseHeight) {
    const tPositions = terrain.attributes.position.array;
    const tIndices = terrain.index.array;
    const n = terrain.attributes.position.count;

    let minZ = Infinity;
    for (let i = 0; i < n; i++) {
        const z = tPositions[3 * i + 2];
        if (z < minZ) minZ = z;
    }
    const baseZ = minZ - baseHeight;

    const boundary = boundaryEdges(tIndices);
    let { loops, chains } = walkAllBoundaryLoops(boundary);
    if (loops.length === 0 && chains.length === 0) {
        throw new Error('terrain crop has no boundary edges');
    }
    // Force CCW (looking from +Z) so wall winding (a, b+n, b) points outward
    // and the bottom fan winding (pivot, loop[i+1]+n, loop[i]+n) points -Z.
    loops = loops.map(loop => signedAreaXY(tPositions, loop) < 0 ? loop.slice().reverse() : loop);

    const verts = new Float32Array(n * 2 * 3);
    verts.set(tPositions, 0);
    for (let i = 0; i < n; i++) {
        verts[3 * (i + n)]     = tPositions[3 * i];
        verts[3 * (i + n) + 1] = tPositions[3 * i + 1];
        verts[3 * (i + n) + 2] = baseZ;
    }

    // Walls per loop and chain. Closed loops also get a fan-triangulated
    // bottom; open chains contribute walls only and the slicer fills the
    // gap. Wall winding (a, b+n, b) → outward normal for CCW loops.
    const wallFaces = [];
    const bottomFaces = [];
    for (const loop of loops) {
        for (let i = 0; i < loop.length; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % loop.length];
            wallFaces.push(a, b + n, b, a, a + n, b + n);
        }
        const pivot = loop[0] + n;
        for (let i = 1; i < loop.length - 1; i++) {
            bottomFaces.push(pivot, loop[i + 1] + n, loop[i] + n);
        }
    }
    for (const chain of chains) {
        for (let i = 0; i < chain.length - 1; i++) {
            const a = chain[i];
            const b = chain[i + 1];
            wallFaces.push(a, b + n, b, a, a + n, b + n);
        }
    }

    const allFaces = new Uint32Array(tIndices.length + wallFaces.length + bottomFaces.length);
    allFaces.set(tIndices, 0);
    allFaces.set(wallFaces, tIndices.length);
    allFaces.set(bottomFaces, tIndices.length + wallFaces.length);

    const slab = new THREE.BufferGeometry();
    slab.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    slab.setIndex(new THREE.BufferAttribute(allFaces, 1));
    return slab;
}

/**
 * Convert any geometry to non-indexed (3 vertices per triangle, no sharing).
 * STL is a non-indexed format, and this also drops unreferenced vertices.
 */
function toNonIndexed(geometry) {
    if (!geometry.index) return geometry;
    const positions = geometry.attributes.position.array;
    const indices = geometry.index.array;
    const out = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
        const v = indices[i];
        out[3 * i]     = positions[3 * v];
        out[3 * i + 1] = positions[3 * v + 1];
        out[3 * i + 2] = positions[3 * v + 2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    return g;
}

/**
 * Compute the list of (tx, ty) tile coordinates the bbox touches.
 */
export function tilesForBbox(x1, y1, x2, y2) {
    const txLo = Math.floor(x1 / TILE_SIZE) * TILE_SIZE;
    const tyLo = Math.floor(y1 / TILE_SIZE) * TILE_SIZE;
    const txHi = Math.ceil(x2 / TILE_SIZE) * TILE_SIZE;
    const tyHi = Math.ceil(y2 / TILE_SIZE) * TILE_SIZE;
    const tiles = [];
    for (let tx = txLo; tx < txHi; tx += TILE_SIZE) {
        for (let ty = tyLo; ty < tyHi; ty += TILE_SIZE) {
            tiles.push([tx, ty]);
        }
    }
    return tiles;
}

/**
 * Run the full pipeline for a bbox. Returns { geometry, stats }.
 *
 * fetchTile(tx, ty, kind: 'Trn'|'Geb') must return a non-indexed
 * BufferGeometry in raw Lambert-72 coords (no translation), or null if
 * the tile is missing.
 */
export async function buildPrintable({
    bbox, tiles, baseHeight, dropEdgeBuildings, fetchTile, onProgress = () => {},
}) {
    const [x1, y1, x2, y2] = bbox;
    const stats = { missing: [], terrainFaces: 0, buildingFaces: 0, totalFaces: 0 };

    // Translate everything by -ref so coordinates are small (<2km) for
    // mergeVertices. At raw Lambert-72 magnitudes (~100000) one float32 ULP
    // is ~1.5 cm, larger than the merge tolerance, so coincident vertices
    // straddle hash-bin boundaries and never fuse.
    const refX = Math.floor(x1 / 1000) * 1000;
    const refY = Math.floor(y1 / 1000) * 1000;
    const lx1 = x1 - refX, ly1 = y1 - refY, lx2 = x2 - refX, ly2 = y2 - refY;
    const localize = (geom) => {
        const a = geom.attributes.position.array;
        for (let i = 0; i < a.length; i += 3) { a[i] -= refX; a[i + 1] -= refY; }
        return geom;
    };

    onProgress('Loading terrain tiles…');
    const terrainGeoms = [];
    for (const [tx, ty] of tiles) {
        const g = await fetchTile(tx, ty, 'Trn');
        if (!g) { stats.missing.push(`Trn_${tx}_${ty}`); continue; }
        localize(g);
        const merged = mergeVertices(g, 0.01);
        dropDegenerate(merged);
        snapTileBoundary(merged, tx - refX, ty - refY);
        terrainGeoms.push(merged);
    }
    if (terrainGeoms.length === 0) throw new Error('no terrain tiles found for bbox');

    onProgress('Fusing terrain seams…');
    let terrain = concatGeometries(terrainGeoms);
    averageZAtSharedXY(terrain.attributes.position.array, terrain.attributes.position.count);
    terrain = mergeVertices(terrain, 0.01);
    dropDegenerate(terrain);

    // Clip against the 4 bbox planes so the terrain ends exactly on the bbox
    // edge instead of zig-zagging along triangle boundaries (which gave the
    // slab a corrugated-cardboard look). After clipping, fuse coincident
    // clip points so the new boundary is a single closed loop.
    onProgress('Clipping terrain to bbox…');
    terrain = clipByPlane(terrain, 0, lx1, true);
    terrain = clipByPlane(terrain, 0, lx2, false);
    terrain = clipByPlane(terrain, 1, ly1, true);
    terrain = clipByPlane(terrain, 1, ly2, false);
    terrain = mergeVertices(terrain, 0.01);
    dropDegenerate(terrain);
    if (terrain.index.array.length === 0) throw new Error('bbox contains no terrain');

    onProgress('Building watertight slab…');
    const slab = buildSlab(terrain, baseHeight);
    stats.terrainFaces = slab.index.array.length / 3;

    onProgress('Loading building tiles…');
    const buildingGeoms = [];
    for (const [tx, ty] of tiles) {
        const g = await fetchTile(tx, ty, 'Geb');
        if (!g) { stats.missing.push(`Geb_${tx}_${ty}`); continue; }
        localize(g);
        const merged = mergeVertices(g, 0.01);
        dropDegenerate(merged);
        buildingGeoms.push(merged);
    }

    let buildings = null;
    if (buildingGeoms.length > 0) {
        onProgress('Filtering buildings at bbox edge…');
        buildings = concatGeometries(buildingGeoms);
        buildings = mergeVertices(buildings, 0.01);
        dropDegenerate(buildings);
        filterComponents(buildings, lx1, ly1, lx2, ly2,
            dropEdgeBuildings ? 'fully-inside' : 'any-inside');
        stats.buildingFaces = buildings.index.array.length / 3;
    }

    onProgress('Combining…');
    const parts = [toNonIndexed(slab)];
    if (buildings && buildings.index.array.length > 0) {
        parts.push(toNonIndexed(buildings));
    }
    const combined = concatNonIndexed(parts);
    stats.totalFaces = combined.attributes.position.count / 3;
    return { geometry: combined, stats };
}

/** Stack non-indexed geometries (positions only) into one. */
function concatNonIndexed(geometries) {
    let total = 0;
    for (const g of geometries) total += g.attributes.position.array.length;
    const positions = new Float32Array(total);
    let off = 0;
    for (const g of geometries) {
        positions.set(g.attributes.position.array, off);
        off += g.attributes.position.array.length;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return out;
}
