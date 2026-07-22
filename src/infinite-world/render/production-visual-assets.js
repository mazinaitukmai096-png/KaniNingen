import {
  PRODUCTION_HUMAN_VISUAL_SCALE,
  PRODUCTION_TANK_VISUAL_SCALE,
} from '../../world-scale-rebalance.js';

export const FINITE_VISUAL_SOURCE_COMMIT = 'f8bc9f80c2af417bb585bff26c99522c4229ab8e';
export const PRODUCTION_VISUAL_UNITS_PER_METER = 40;

function constructor(THREE, preferred, fallback = 'BufferGeometry') {
  const Type = THREE?.[preferred] ?? THREE?.[fallback];
  if (typeof Type !== 'function') throw new TypeError(`THREE.${preferred} is required`);
  return Type;
}

function add(group, ...children) {
  for (const child of children) group.add(child);
}

function part(geometry, material, position, scale, rotation = [0, 0, 0]) {
  return Object.freeze({ geometry, material, position, scale, rotation });
}

// Normalized descriptors are projected against the dimensions already present in W5/W6 ChunkData.
// They intentionally contain no placement or generation rules.
export const PRODUCTION_FEATURE_PARTS = Object.freeze({
  house: Object.freeze([
    part('box', 'houseWall', [0, 0.31, 0], [1, 0.62, 1]),
    part('pyramid', 'houseRoof', [0, 0.78, 0], [1.12, 0.34, 1.12]),
  ]),
  tower: Object.freeze([
    part('box', 'towerWall', [0, 0.43, 0], [0.78, 0.86, 0.78]),
    part('pyramid', 'towerRoof', [0, 0.92, 0], [0.9, 0.16, 0.9]),
    part('box', 'window', [0, 0.58, 0.405], [0.22, 0.18, 0.03]),
  ]),
  church: Object.freeze([
    part('box', 'churchWall', [0, 0.28, -0.08], [1, 0.56, 0.78]),
    part('pyramid', 'churchRoof', [0, 0.66, -0.08], [1.08, 0.3, 0.88]),
    part('box', 'churchWall', [0, 0.66, 0.31], [0.32, 0.72, 0.28]),
    part('pyramid', 'churchRoof', [0, 1.02, 0.31], [0.38, 0.22, 0.34]),
    part('box', 'gold', [0, 1.13, 0.31], [0.08, 0.22, 0.05]),
    part('box', 'gold', [0, 1.18, 0.31], [0.19, 0.05, 0.05]),
  ]),
  school: Object.freeze([
    part('box', 'schoolWall', [0, 0.3, 0], [1, 0.6, 1]),
    part('box', 'schoolRoof', [0, 0.64, 0], [1.06, 0.08, 1.08]),
    part('box', 'schoolWall', [0, 0.79, 0], [0.2, 0.38, 0.28]),
    part('pyramid', 'schoolRoof', [0, 1.03, 0], [0.24, 0.18, 0.32]),
    part('box', 'gold', [0, 0.83, 0.145], [0.08, 0.1, 0.02]),
  ]),
  tree: Object.freeze([
    part('box', 'treeTrunk', [0, 0.19, 0], [0.22, 0.38, 0.22]),
    part('cone', 'treeLeaves', [0, 0.65, 0], [0.76, 0.78, 0.76]),
  ]),
  broadleafTree: Object.freeze([
    part('box', 'treeTrunk', [0, 0.2, 0], [0.2, 0.4, 0.2]),
    part('sphere', 'treeLeaves', [0, 0.64, 0], [0.82, 0.72, 0.82]),
    part('sphere', 'treeLeaves', [0.22, 0.78, -0.12], [0.48, 0.45, 0.48]),
  ]),
  shrub: Object.freeze([
    part('dodeca', 'bush', [0, 0.38, 0], [0.95, 0.7, 0.95]),
  ]),
  rock: Object.freeze([
    part('dodeca', 'rock', [0, 0.42, 0], [1, 0.72, 1]),
  ]),
});

const ENTITY_PARTS = Object.freeze({
  human: Object.freeze([
    part('box', 'humanBody', [0, 45, 0], [45, 90, 45]),
    part('sphere', 'skin', [0, 110, 0], [30, 30, 30]),
  ]),
  tank: Object.freeze([
    part('box', 'tank', [0, 30, 0], [100, 35, 140]),
    part('box', 'charred', [-61, 20, 0], [22, 40, 160]),
    part('box', 'charred', [61, 20, 0], [22, 40, 160]),
    part('box', 'tank', [0, 60, -10], [65, 26, 75]),
    part('box', 'charred', [16, 74, -20], [24, 5, 24]),
    part('box', 'tank', [0, 62, 78], [18, 18, 150]),
  ]),
  boss: Object.freeze([
    part('dodeca', 'boss', [0, 260, 0], [320, 280, 320]),
    part('sphere', 'bossEye', [-105, 330, 235], [42, 42, 42]),
    part('sphere', 'bossEye', [105, 330, 235], [42, 42, 42]),
  ]),
});

const PLAYER_PARTS = Object.freeze([
  part('box', 'crab', [0, 30, 0], [100, 45, 85]),
  part('box', 'crab', [20, 50, 35], [8, 22, 8]),
  part('box', 'crab', [-20, 50, 35], [8, 22, 8]),
  part('sphere', 'whiteEye', [20, 61, 35], [12, 12, 12]),
  part('sphere', 'whiteEye', [-20, 61, 35], [12, 12, 12]),
  part('box', 'blackEye', [20, 61, 46], [6, 6, 4]),
  part('box', 'blackEye', [-20, 61, 46], [6, 6, 4]),
  part('box', 'crab', [85, 30, 55], [55, 35, 55]),
  part('box', 'crab', [-85, 30, 55], [55, 35, 55]),
  ...Array.from({ length: 8 }, (_, index) => part(
    'box',
    'crab',
    [(index < 4 ? 1 : -1) * 85, 0, (index % 4 - 1.5) * 30],
    [15, 45, 15],
    [0, 0, (index < 4 ? -1 : 1) * 0.35],
  )),
]);

export function createProductionVisualAssetLibrary({ THREE } = {}) {
  const Group = constructor(THREE, 'Group');
  const Mesh = constructor(THREE, 'Mesh');
  const Material = constructor(THREE, 'MeshLambertMaterial');
  const geometries = Object.freeze({
    box: new (constructor(THREE, 'BoxGeometry'))(1, 1, 1),
    cone: new (constructor(THREE, 'ConeGeometry'))(1, 1, 8),
    pyramid: new (constructor(THREE, 'CylinderGeometry'))(0, 0.7071, 1, 4, 1, false, Math.PI / 4),
    sphere: new (constructor(THREE, 'SphereGeometry'))(1, 12, 12),
    dodeca: new (constructor(THREE, 'DodecahedronGeometry'))(1, 0),
  });
  const material = (color, extra = {}) => new Material({ color, flatShading: true, ...extra });
  const materials = Object.freeze({
    crab: material(0xff4500), whiteEye: material(0xffffff), blackEye: material(0x111111),
    humanBody: material(0x3366ff), skin: material(0xffccaa),
    tank: material(0x4a6523), charred: material(0x333333), boss: material(0x6b1628), bossEye: material(0xffd84a),
    houseWall: material(0xeeeeee), houseRoof: material(0xaa2222),
    towerWall: material(0x78909c), towerRoof: material(0x37474f),
    churchWall: material(0xe0e0e0), churchRoof: material(0x37474f),
    schoolWall: material(0xdfbca0), schoolRoof: material(0x37474f),
    window: material(0x29b6f6, { transparent: true, opacity: 0.75 }), gold: material(0xffd700),
    treeTrunk: material(0x5d4037), treeLeaves: material(0x2e7d32), bush: material(0x4f7d32), rock: material(0xa0785a),
    road: material(0xc2a878),
  });
  let disposed = false;

  function createModel(parts, name) {
    if (disposed) throw new Error('production visual asset library is disposed');
    const group = new Group();
    group.name = name;
    for (const descriptor of parts) {
      const mesh = new Mesh(geometries[descriptor.geometry], materials[descriptor.material]);
      mesh.position.set(...descriptor.position);
      mesh.rotation.set(...descriptor.rotation);
      mesh.scale.set(...descriptor.scale);
      mesh.castShadow = true;
      add(group, mesh);
    }
    return group;
  }

  return Object.freeze({
    schemaVersion: 'w7-production-visual-assets-1',
    geometries,
    materials,
    featureParts: PRODUCTION_FEATURE_PARTS,
    createPlayerModel: () => createModel(PLAYER_PARTS, 'production-player-crab'),
    createEntityModel(type) {
      if (!ENTITY_PARTS[type]) throw new RangeError(`unsupported production entity visual: ${type}`);
      const model = createModel(ENTITY_PARTS[type], `production-${type}`);
      model.userData.productionVisualScale = type === 'human'
        ? PRODUCTION_HUMAN_VISUAL_SCALE
        : type === 'tank' ? PRODUCTION_TANK_VISUAL_SCALE : 1;
      return model;
    },
    snapshot: () => Object.freeze({
      schemaVersion: 'w7-production-visual-resource-snapshot-1',
      sharedGeometryCount: Object.keys(geometries).length,
      sharedMaterialCount: Object.keys(materials).length,
      disposed,
    }),
    dispose() {
      if (disposed) return;
      for (const geometry of Object.values(geometries)) geometry.dispose();
      for (const value of Object.values(materials)) value.dispose();
      disposed = true;
    },
  });
}
