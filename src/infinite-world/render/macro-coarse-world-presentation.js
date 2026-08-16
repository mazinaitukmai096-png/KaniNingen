const DEFAULT_TERRAIN_COLOR = Object.freeze([0.28, 0.42, 0.2]);
const TERRAIN_SAMPLES_PER_AXIS = 5;
const TERRAIN_VERTEX_COUNT_PER_CELL = TERRAIN_SAMPLES_PER_AXIS ** 2;
const TERRAIN_INDEX_COUNT_PER_CELL = 4 * 4 * 6;
const TERRAIN_TRIANGLE_COUNT_PER_CELL = TERRAIN_INDEX_COUNT_PER_CELL / 3;

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') {
    throw new TypeError(`THREE.${name} is required for Macro coarse presentation`);
  }
  return THREE[name];
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function terrainSamples(cell) {
  const samples = cell?.terrainSamples ?? cell?.terrain?.samples ?? [];
  if (!Array.isArray(samples) || samples.length !== TERRAIN_VERTEX_COUNT_PER_CELL) {
    throw new RangeError('Macro Terrain cell must contain one world-fixed 5x5 sample lattice');
  }
  return samples;
}

function sampleWorldX(sample) {
  return finite(sample?.worldX, finite(sample?.x, Number.NaN));
}

function sampleWorldZ(sample) {
  return finite(sample?.worldZ, finite(sample?.z, Number.NaN));
}

function sampleHeight(sample) {
  return finite(sample?.heightMeters, finite(sample?.height, Number.NaN));
}

function sampleColor(sample) {
  const value = sample?.color ?? sample?.colorRgb ?? sample?.surfaceColor;
  return Array.isArray(value) && value.length === 3
    && value.every(Number.isFinite) ? value : DEFAULT_TERRAIN_COLOR;
}

function markAttributeRanges(attribute, slots, itemSize, itemsPerSlot = 1) {
  if (!attribute || slots.size === 0) return Object.freeze({ ranges: 0, bytes: 0 });
  const sorted = [...slots].sort((left, right) => left - right);
  attribute.clearUpdateRanges?.();
  let rangeStart = sorted[0];
  let previous = sorted[0];
  let ranges = 0;
  let components = 0;
  const publish = (first, last) => {
    const start = first * itemsPerSlot * itemSize;
    const count = (last - first + 1) * itemsPerSlot * itemSize;
    attribute.addUpdateRange?.(start, count);
    ranges += 1;
    components += count;
  };
  for (let index = 1; index < sorted.length; index += 1) {
    const slot = sorted[index];
    if (slot !== previous + 1) {
      publish(rangeStart, previous);
      rangeStart = slot;
    }
    previous = slot;
  }
  publish(rangeStart, previous);
  attribute.needsUpdate = true;
  return Object.freeze({ ranges, bytes: components * Float32Array.BYTES_PER_ELEMENT });
}

function configureMacroTerrainMaterial(material) {
  const uniforms = {
    w8MacroTerrainPlayerXZ: { value: { x: 0, y: 0 } },
    w8MacroTerrainDetailCenterXZ: { value: { x: 0, y: 0 } },
    w8MacroTerrainUnitsPerMeter: { value: 1 },
    w8MacroTerrainVisibleRadius: { value: 352 },
    w8MacroTerrainDetailExtent: { value: 0 },
    w8MacroTerrainDetailReady: { value: 0 },
  };
  material.userData = {
    ...(material.userData ?? {}),
    macroCoarseTerrain: true,
    macroCoarseTerrainUniforms: uniforms,
    overlapPolicy: 'fragment-exclusive-mask-against-published-logical-terrain',
  };
  const previousOnBeforeCompile = material.onBeforeCompile;
  const previousProgramCacheKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = shader => {
    previousOnBeforeCompile?.call(material, shader);
    Object.assign(shader.uniforms, uniforms);
    const vertexAnchor = '#include <begin_vertex>';
    const fragmentColor = '#include <color_fragment>';
    if (!shader.vertexShader.includes(vertexAnchor)
      || !shader.fragmentShader.includes(fragmentColor)) {
      throw new Error('Macro Terrain shader chunks are unavailable');
    }
    shader.vertexShader = [
      'uniform float w8MacroTerrainUnitsPerMeter;',
      'varying vec2 vW8MacroTerrainXZ;',
      shader.vertexShader,
    ].join('\n').replace(vertexAnchor, [
      vertexAnchor,
      'vW8MacroTerrainXZ = position.xz / w8MacroTerrainUnitsPerMeter;',
    ].join('\n'));
    shader.fragmentShader = [
      'uniform vec2 w8MacroTerrainPlayerXZ;',
      'uniform vec2 w8MacroTerrainDetailCenterXZ;',
      'uniform float w8MacroTerrainVisibleRadius;',
      'uniform float w8MacroTerrainDetailExtent;',
      'uniform float w8MacroTerrainDetailReady;',
      'varying vec2 vW8MacroTerrainXZ;',
      shader.fragmentShader,
    ].join('\n').replace(fragmentColor, [
      fragmentColor,
      'if (length(vW8MacroTerrainXZ - w8MacroTerrainPlayerXZ) > w8MacroTerrainVisibleRadius) discard;',
      'vec2 w8MacroDetailDelta = abs(vW8MacroTerrainXZ - w8MacroTerrainDetailCenterXZ);',
      'if (w8MacroTerrainDetailReady > 0.5 && max(w8MacroDetailDelta.x, w8MacroDetailDelta.y) < w8MacroTerrainDetailExtent) discard;',
    ].join('\n'));
  };
  material.customProgramCacheKey = () => [
    previousProgramCacheKey?.() ?? '',
    'w8-macro-coarse-terrain-exclusive-mask-v1',
  ].join(':');
  return material;
}

export function createMacroCoarseWorldPresentation({
  THREE,
  parent,
  terrainSourceMaterial,
  maximumCells,
  unitsPerMeter,
  logicalChunkSizeMeters,
  anchorWorldX,
  anchorWorldZ,
} = {}) {
  if (!parent?.add || !parent?.remove) throw new TypeError('Macro presentation parent is required');
  if (!Number.isSafeInteger(maximumCells) || maximumCells <= 0) {
    throw new RangeError('Macro Terrain presentation capacity must be a positive integer');
  }
  if (![unitsPerMeter, logicalChunkSizeMeters, anchorWorldX, anchorWorldZ]
    .every(Number.isFinite) || unitsPerMeter <= 0 || logicalChunkSizeMeters <= 0) {
    throw new TypeError('Macro presentation scale and anchor must be finite');
  }
  const Group = requireConstructor(THREE, 'Group');
  const Mesh = requireConstructor(THREE, 'Mesh');
  const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
  const Float32BufferAttribute = requireConstructor(THREE, 'Float32BufferAttribute');
  const Uint32BufferAttribute = requireConstructor(THREE, 'Uint32BufferAttribute');

  const root = new Group();
  root.name = 'w8-macro-coarse-world';
  root.userData = {
    ...(root.userData ?? {}),
    presentationOnly: true,
    macroCoarseWorld: true,
    logicalIdentity: 'world-fixed-64m-cell',
    presentationContent: 'terrain-only',
  };
  parent.add(root);

  const terrainPositions = new Float32Array(maximumCells * TERRAIN_VERTEX_COUNT_PER_CELL * 3);
  const terrainColors = new Float32Array(maximumCells * TERRAIN_VERTEX_COUNT_PER_CELL * 3);
  const terrainIndices = new Uint32Array(maximumCells * TERRAIN_INDEX_COUNT_PER_CELL);
  for (let slot = 0; slot < maximumCells; slot += 1) {
    const vertexBase = slot * TERRAIN_VERTEX_COUNT_PER_CELL;
    const indexBase = slot * TERRAIN_INDEX_COUNT_PER_CELL;
    let cursor = indexBase;
    for (let z = 0; z < 4; z += 1) {
      for (let x = 0; x < 4; x += 1) {
        const northwest = vertexBase + z * TERRAIN_SAMPLES_PER_AXIS + x;
        const northeast = northwest + 1;
        const southwest = northwest + TERRAIN_SAMPLES_PER_AXIS;
        const southeast = southwest + 1;
        terrainIndices.set([
          northwest, southwest, northeast,
          northeast, southwest, southeast,
        ], cursor);
        cursor += 6;
      }
    }
  }
  const terrainGeometry = new BufferGeometry();
  const terrainPositionAttribute = new Float32BufferAttribute(terrainPositions, 3);
  const terrainColorAttribute = new Float32BufferAttribute(terrainColors, 3);
  const terrainPositionValues = terrainPositionAttribute.array
    ?? terrainPositionAttribute.values
    ?? terrainPositions;
  const terrainColorValues = terrainColorAttribute.array
    ?? terrainColorAttribute.values
    ?? terrainColors;
  terrainGeometry.setAttribute('position', terrainPositionAttribute);
  terrainGeometry.setAttribute('color', terrainColorAttribute);
  terrainGeometry.setIndex(new Uint32BufferAttribute(terrainIndices, 1));
  terrainGeometry.drawRange = { start: 0, count: 0 };
  terrainGeometry.userData = {
    ...(terrainGeometry.userData ?? {}),
    macroCoarseTerrain: true,
    cellCapacity: maximumCells,
    verticesPerCell: TERRAIN_VERTEX_COUNT_PER_CELL,
    trianglesPerCell: TERRAIN_TRIANGLE_COUNT_PER_CELL,
  };
  const terrainMaterial = terrainSourceMaterial?.clone?.();
  if (!terrainMaterial || terrainMaterial === terrainSourceMaterial) {
    throw new Error('Macro Terrain requires a cloned canonical Terrain material');
  }
  configureMacroTerrainMaterial(terrainMaterial);
  const terrainMesh = new Mesh(terrainGeometry, terrainMaterial);
  terrainMesh.name = 'w8-macro-coarse-terrain';
  terrainMesh.visible = false;
  terrainMesh.frustumCulled = false;
  terrainMesh.castShadow = false;
  terrainMesh.receiveShadow = false;
  terrainMesh.userData = {
    ...(terrainMesh.userData ?? {}),
    presentationOnly: true,
    logicalTerrainSurface: true,
    terrainLodBand: 'macro-coarse',
    overlapPolicy: 'exclusive-detail-mask',
  };
  root.add(terrainMesh);

  const cells = [];
  const cellSlotByKey = new Map();
  const dirtyTerrainSlots = new Set();
  let disposed = false;
  let terrainCellPublicationCount = 0;
  let compactionMoveCount = 0;
  let maximumTerrainCells = 0;
  let bufferUploadBytes = 0;
  let bufferUpdateRangeCount = 0;
  let reanchorCount = 0;
  let anchorX = anchorWorldX;
  let anchorZ = anchorWorldZ;

  const setDrawCount = () => {
    const count = cells.length * TERRAIN_INDEX_COUNT_PER_CELL;
    terrainGeometry.setDrawRange?.(0, count);
    terrainGeometry.drawRange = { start: 0, count };
    terrainMesh.visible = cells.length > 0;
  };

  const writeTerrainCell = (slot, cell) => {
    const samples = terrainSamples(cell);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const worldX = sampleWorldX(sample);
      const worldZ = sampleWorldZ(sample);
      const heightMeters = sampleHeight(sample);
      if (![worldX, worldZ, heightMeters].every(Number.isFinite)) {
        throw new TypeError(`Macro Terrain sample is invalid: ${cell.key ?? 'unknown'}`);
      }
      const offset = (slot * TERRAIN_VERTEX_COUNT_PER_CELL + index) * 3;
      terrainPositionValues[offset] = (worldX - anchorX) * unitsPerMeter;
      terrainPositionValues[offset + 1] = heightMeters * unitsPerMeter;
      terrainPositionValues[offset + 2] = (worldZ - anchorZ) * unitsPerMeter;
      const color = sampleColor(sample);
      terrainColorValues[offset] = color[0];
      terrainColorValues[offset + 1] = color[1];
      terrainColorValues[offset + 2] = color[2];
    }
    dirtyTerrainSlots.add(slot);
  };

  const retireCell = key => {
    if (disposed) return false;
    const slot = cellSlotByKey.get(key);
    if (!Number.isSafeInteger(slot)) return false;
    const lastSlot = cells.length - 1;
    const last = cells[lastSlot];
    cells.pop();
    cellSlotByKey.delete(key);
    if (slot !== lastSlot && last) {
      cells[slot] = last;
      cellSlotByKey.set(last.key, slot);
      writeTerrainCell(slot, last.cell);
      compactionMoveCount += 1;
    }
    setDrawCount();
    return true;
  };

  const publishCell = cell => {
    if (disposed) return false;
    const key = cell?.key ?? `${cell?.macroX},${cell?.macroZ}`;
    if (typeof key !== 'string' || key.includes('undefined')) {
      throw new TypeError('Macro cell requires a logical key');
    }
    if (cellSlotByKey.has(key)) retireCell(key);
    if (cells.length >= maximumCells) {
      throw new RangeError('Macro Terrain presentation capacity exceeded');
    }
    const slot = cells.length;
    const entry = { key, cell };
    cells.push(entry);
    cellSlotByKey.set(key, slot);
    writeTerrainCell(slot, cell);
    terrainCellPublicationCount += 1;
    maximumTerrainCells = Math.max(maximumTerrainCells, cells.length);
    setDrawCount();
    return true;
  };

  const flushUpdates = () => {
    const terrainChanged = dirtyTerrainSlots.size > 0;
    const positionUpload = markAttributeRanges(
      terrainPositionAttribute,
      dirtyTerrainSlots,
      3,
      TERRAIN_VERTEX_COUNT_PER_CELL,
    );
    const colorUpload = markAttributeRanges(
      terrainColorAttribute,
      dirtyTerrainSlots,
      3,
      TERRAIN_VERTEX_COUNT_PER_CELL,
    );
    const ranges = positionUpload.ranges + colorUpload.ranges;
    const bytes = positionUpload.bytes + colorUpload.bytes;
    bufferUpdateRangeCount += ranges;
    bufferUploadBytes += bytes;
    if (terrainChanged) {
      terrainGeometry.boundingBox = null;
      terrainGeometry.boundingSphere = null;
    }
    dirtyTerrainSlots.clear();
    return Object.freeze({ ranges, bytes });
  };

  const rewriteForAnchor = (nextAnchorX, nextAnchorZ) => {
    if (nextAnchorX === anchorX && nextAnchorZ === anchorZ) return false;
    anchorX = nextAnchorX;
    anchorZ = nextAnchorZ;
    for (let slot = 0; slot < cells.length; slot += 1) {
      writeTerrainCell(slot, cells[slot].cell);
    }
    reanchorCount += 1;
    return true;
  };

  const rebase = renderOrigin => {
    if (disposed) return false;
    const originWorldX = finite(renderOrigin?.renderOriginChunkX) * logicalChunkSizeMeters;
    const originWorldZ = finite(renderOrigin?.renderOriginChunkZ) * logicalChunkSizeMeters;
    root.position.set(
      (anchorX - originWorldX) * unitsPerMeter,
      0,
      (anchorZ - originWorldZ) * unitsPerMeter,
    );
    return true;
  };

  const update = ({
    playerWorldX,
    playerWorldZ,
    renderOrigin,
    detailTerrainReady = false,
    detailTerrainCenterWorldX = 0,
    detailTerrainCenterWorldZ = 0,
    detailTerrainExtentMeters = 0,
  } = {}) => {
    if (disposed || ![playerWorldX, playerWorldZ].every(Number.isFinite)) return false;
    if (Math.hypot(playerWorldX - anchorX, playerWorldZ - anchorZ) > 4_096) {
      rewriteForAnchor(
        (Math.floor(playerWorldX / 64) + 0.5) * 64,
        (Math.floor(playerWorldZ / 64) + 0.5) * 64,
      );
    }
    rebase(renderOrigin);
    const terrainUniforms = terrainMaterial.userData.macroCoarseTerrainUniforms;
    terrainUniforms.w8MacroTerrainPlayerXZ.value.x = playerWorldX - anchorX;
    terrainUniforms.w8MacroTerrainPlayerXZ.value.y = playerWorldZ - anchorZ;
    terrainUniforms.w8MacroTerrainDetailCenterXZ.value.x = detailTerrainCenterWorldX - anchorX;
    terrainUniforms.w8MacroTerrainDetailCenterXZ.value.y = detailTerrainCenterWorldZ - anchorZ;
    terrainUniforms.w8MacroTerrainUnitsPerMeter.value = unitsPerMeter;
    terrainUniforms.w8MacroTerrainDetailExtent.value = Math.max(
      0,
      finite(detailTerrainExtentMeters),
    );
    terrainUniforms.w8MacroTerrainDetailReady.value = detailTerrainReady ? 1 : 0;
    flushUpdates();
    return true;
  };

  const snapshot = () => Object.freeze({
    enabled: !disposed,
    presentationContent: 'terrain-only',
    terrainIntegration: 'independent-macro-mesh-with-exclusive-detail-mask',
    terrainOverlapCount: 0,
    terrainCellCount: cells.length,
    terrainCellCapacity: maximumCells,
    terrainTriangleCount: cells.length * TERRAIN_TRIANGLE_COUNT_PER_CELL,
    terrainDrawCallEquivalent: Number(terrainMesh.visible && cells.length > 0),
    terrainCellPublicationCount,
    compactionMoveCount,
    maximumTerrainCells,
    bufferUpdateRangeCount,
    bufferUploadBytes,
    reanchorCount,
    anchorWorldX: anchorX,
    anchorWorldZ: anchorZ,
  });

  return Object.freeze({
    root,
    terrainMesh,
    publishCell,
    retireCell,
    flushUpdates,
    update,
    rebase,
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      parent.remove(root);
      terrainMesh.dispose?.();
      terrainGeometry.dispose?.();
      terrainMaterial.dispose?.();
      cells.length = 0;
      cellSlotByKey.clear();
      dirtyTerrainSlots.clear();
      root.clear?.();
    },
  });
}

export const MACRO_COARSE_PRESENTATION_CONSTANTS = Object.freeze({
  terrainSamplesPerAxis: TERRAIN_SAMPLES_PER_AXIS,
  terrainVerticesPerCell: TERRAIN_VERTEX_COUNT_PER_CELL,
  terrainTrianglesPerCell: TERRAIN_TRIANGLE_COUNT_PER_CELL,
});
