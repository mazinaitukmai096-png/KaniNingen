import {
  RENDER_CHUNK_SIZE,
  assertLogicalChunkCoordinate,
  chunkRenderPosition,
} from './chunk-coordinates.js';

export class FloatingOrigin {
  constructor() {
    this.initialized = false;
    this.renderOriginChunkX = 0;
    this.renderOriginChunkZ = 0;
    this.rebaseCount = 0;
  }

  setCenterChunk(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'renderOriginChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'renderOriginChunkZ');
    if (!this.initialized) {
      this.initialized = true;
      this.renderOriginChunkX = chunkX;
      this.renderOriginChunkZ = chunkZ;
      return Object.freeze({ changed: false, initial: true, deltaRenderX: 0, deltaRenderZ: 0 });
    }
    const previousX = this.renderOriginChunkX;
    const previousZ = this.renderOriginChunkZ;
    const changed = previousX !== chunkX || previousZ !== chunkZ;
    if (changed) {
      this.renderOriginChunkX = chunkX;
      this.renderOriginChunkZ = chunkZ;
      this.rebaseCount += 1;
    }
    return Object.freeze({
      changed,
      initial: false,
      deltaRenderX: (previousX - chunkX) * RENDER_CHUNK_SIZE,
      deltaRenderZ: (previousZ - chunkZ) * RENDER_CHUNK_SIZE,
    });
  }

  projectChunk(chunkX, chunkZ) {
    if (!this.initialized) throw new Error('floating origin is not initialized');
    return chunkRenderPosition(
      chunkX,
      chunkZ,
      this.renderOriginChunkX,
      this.renderOriginChunkZ,
    );
  }

  snapshot() {
    return Object.freeze({
      initialized: this.initialized,
      renderOriginChunkX: this.renderOriginChunkX,
      renderOriginChunkZ: this.renderOriginChunkZ,
      rebaseCount: this.rebaseCount,
    });
  }
}
