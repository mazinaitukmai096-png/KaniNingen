import {
  FINITE_VISUAL_SOURCE_COMMIT,
  PRODUCTION_FEATURE_PARTS,
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createProductionVisualAssetLibrary,
} from './production-visual-assets.js';
import { SETTLEMENT_BUILDING_PALETTES } from '../../settlement-building-visuals.js';

const descriptor = (
  geometry, material, position, scale, rotation = [0, 0, 0], materialRole = null,
) => Object.freeze({
  geometry, material, position, scale, rotation, materialRole,
});

const house = (...parts) => Object.freeze(parts);
export const W8_FINITE_HOUSE_VARIANTS = Object.freeze([
  house(
    descriptor('box', 'houseWall', [0, 0.278, 0], [0.615, 0.556, 0.762], [0, 0, 0], 'wall'),
    descriptor('pyramid', 'houseRoof', [0, 0.722, 0], [0.692, 0.333, 0.857], [0, 0, 0], 'roof'),
    descriptor('box', 'charred', [0, 0.18, 0.386], [0.115, 0.28, 0.03]),
    descriptor('box', 'window', [-0.23, 0.34, 0.386], [0.12, 0.16, 0.025]),
    descriptor('box', 'window', [0.23, 0.34, 0.386], [0.12, 0.16, 0.025]),
    descriptor('box', 'factoryTrim', [-0.22, 0.81, -0.18], [0.07, 0.30, 0.08]),
  ),
  house(
    descriptor('box', 'houseWall', [0, 0.25, 0], [0.923, 0.5, 0.619], [0, 0, 0], 'wall'),
    descriptor('box', 'houseRoof', [0, 0.542, 0], [1, 0.083, 0.714], [0, 0, 0], 'roof'),
    descriptor('box', 'charred', [-0.23, 0.139, 0.324], [0.115, 0.278, 0.03]),
    descriptor('box', 'charred', [0.23, 0.139, 0.324], [0.115, 0.278, 0.03]),
    descriptor('box', 'window', [-0.12, 0.34, 0.324], [0.12, 0.15, 0.025]),
    descriptor('box', 'window', [0.12, 0.34, 0.324], [0.12, 0.15, 0.025]),
  ),
  house(
    descriptor('box', 'houseWall', [0, 0.528, 0], [0.5, 1.056, 0.619], [0, 0, 0], 'wall'),
    descriptor('box', 'houseRoof', [0, 1.097, 0], [0.538, 0.083, 0.667], [0, 0, 0], 'roof'),
    ...[0.194, 0.5, 0.806].flatMap(y => [
      descriptor('box', 'window', [-0.12, y, 0.324], [0.115, 0.194, 0.025]),
      descriptor('box', 'window', [0.12, y, 0.324], [0.115, 0.194, 0.025]),
    ]),
  ),
  house(
    descriptor('box', 'houseWall', [0, 0.222, 0], [0.577, 0.444, 0.571], [0, 0, 0], 'wall'),
    descriptor('box', 'houseRoof', [0, 0.5, 0], [0.654, 0.111, 0.667], [0, 0, 0], 'roof'),
    descriptor('box', 'houseRoof', [0, 0.333, 0.371], [0.346, 0.056, 0.19], [-0.15, 0, 0], 'roof'),
    descriptor('box', 'charred', [-0.135, 0.15, 0.438], [0.031, 0.306, 0.038]),
    descriptor('box', 'charred', [0.135, 0.15, 0.438], [0.031, 0.306, 0.038]),
    descriptor('box', 'window', [-0.2, 0.28, 0.291], [0.11, 0.16, 0.025]),
    descriptor('box', 'window', [0.2, 0.28, 0.291], [0.11, 0.16, 0.025]),
  ),
  house(
    descriptor('box', 'houseWall', [0, 0.236, 0], [0.462, 0.472, 0.571], [0, 0, 0], 'wall'),
    descriptor('pyramid', 'houseRoof', [0, 0.625, 0], [0.538, 0.306, 0.667], [0, 0, 0], 'roof'),
    descriptor('box', 'charred', [0, 0.16, 0.291], [0.12, 0.31, 0.025]),
    descriptor('box', 'charred', [0.327, 0.125, 0], [0.212, 0.25, 0.286]),
    descriptor('box', 'houseRoof', [0.327, 0.272, 0], [0.25, 0.044, 0.333], [0, 0, 0.2], 'roof'),
  ),
]);

function stableVariantIndex(value, count) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

function settlementMaterialKey(color) {
  return `settlement-${Number(color).toString(16).padStart(6, '0')}`;
}

export function resolveW8BuildingParts(building) {
  const source = building?.buildingType === 'house'
    ? W8_FINITE_HOUSE_VARIANTS[stableVariantIndex(building.stableId, W8_FINITE_HOUSE_VARIANTS.length)]
    : W8_PARITY_FEATURE_PARTS[building?.buildingType] ?? [];
  const visual = building?.visual;
  if (!visual) return source;
  return source.map(part => {
    const color = part.materialRole === 'wall' ? visual.wallColor
      : part.materialRole === 'roof' ? visual.roofColor : null;
    const roofScale = part.materialRole === 'roof' ? visual.roofScale ?? 1 : 1;
    if (!Number.isFinite(color) && roofScale === 1) return part;
    return Object.freeze({
      ...part,
      material: Number.isFinite(color) ? settlementMaterialKey(color) : part.material,
      scale: roofScale === 1
        ? part.scale : Object.freeze([part.scale[0], part.scale[1] * roofScale, part.scale[2]]),
    });
  });
}

export const W8_PARITY_FEATURE_PARTS = Object.freeze({
  ...PRODUCTION_FEATURE_PARTS,
  house: W8_FINITE_HOUSE_VARIANTS[0],
  tower: Object.freeze([
    descriptor('box', 'towerWall', [0, 0.286, 0], [0.727, 0.571, 0.727], [0, 0, 0], 'wall'),
    descriptor('box', 'towerWall', [0, 0.571, 0], [0.909, 0.036, 0.909], [0, 0, 0], 'wall'),
    descriptor('pyramid', 'towerRoof', [0, 0.673, 0], [1, 0.167, 1], [0, 0, 0], 'roof'),
    descriptor('box', 'charred', [0, 0.19, 0], [0.109, 0.083, 0.745]),
    descriptor('box', 'charred', [0, 0.31, 0], [0.109, 0.083, 0.745]),
    descriptor('box', 'charred', [0, 0.429, 0], [0.109, 0.083, 0.745]),
  ]),
  church: Object.freeze([
    descriptor('box', 'churchWall', [0, 0.164, 0], [0.909, 0.328, 0.632], [0, 0, 0], 'wall'),
    descriptor('pyramid', 'churchRoof', [0, 0.5, 0], [1, 0.299, 0.684], [0, 0, Math.PI / 4], 'roof'),
    descriptor('box', 'churchWall', [0, 0.373, 0.408], [0.424, 0.746, 0.184], [0, 0, 0], 'wall'),
    descriptor('pyramid', 'churchRoof', [0, 0.836, 0.408], [0.485, 0.179, 0.211], [0, 0, 0], 'roof'),
    descriptor('box', 'gold', [0, 1, 0.408], [0.048, 0.149, 0.021]),
    descriptor('box', 'gold', [0, 1.015, 0.408], [0.182, 0.024, 0.021]),
    ...[-0.289, -0.171, -0.053].flatMap((z, index) => [
      descriptor('box', index % 2 ? 'stainedGlassYellow' : 'stainedGlassBlue', [0.461, 0.164, z], [0.024, 0.134, 0.047]),
      descriptor('box', index % 2 ? 'stainedGlassBlue' : 'stainedGlassYellow', [-0.461, 0.164, z], [0.024, 0.134, 0.047]),
    ]),
  ]),
  school: Object.freeze([
    descriptor('box', 'schoolWall', [0, 0.316, 0], [0.947, 0.632, 0.737], [0, 0, 0], 'wall'),
    descriptor('box', 'schoolRoof', [0, 0.671, 0], [1, 0.079, 0.842], [0, 0, 0], 'roof'),
    descriptor('box', 'schoolWall', [0, 0.895, 0], [0.158, 0.526, 0.316], [0, 0, 0], 'wall'),
    descriptor('pyramid', 'schoolRoof', [0, 1.263, 0], [0.184, 0.211, 0.368], [0, 0, 0], 'roof'),
    descriptor('box', 'gold', [0, 0.947, 0.166], [0.079, 0.158, 0.026]),
    descriptor('box', 'charred', [0, 0.184, 0.382], [0.105, 0.368, 0.026]),
    ...[-0.316, -0.105, 0.105, 0.316].map(x => (
      descriptor('box', 'window', [x, 0.368, 0.382], [0.105, 0.184, 0.026])
    )),
  ]),
  tree: Object.freeze([
    descriptor('box', 'treeTrunk', [0, 0.207, 0], [0.15, 0.414, 0.15]),
    descriptor('cone', 'treeLeaves', [0, 0.621, 0], [0.5, 0.759, 0.5]),
  ]),
  broadleafTree: Object.freeze([
    descriptor('box', 'treeTrunk', [0, 0.207, 0], [0.15, 0.414, 0.15]),
    descriptor('sphere', 'treeLeavesMeadow', [0, 0.552, 0], [0.6875, 0.448, 0.6875]),
    descriptor('sphere', 'treeLeavesMeadow', [0.265, 0.655, -0.265], [0.4375, 0.241, 0.4375]),
  ]),
  wetlandTree: Object.freeze([
    descriptor('box', 'treeTrunk', [0, 0.207, 0], [0.15, 0.414, 0.15]),
    descriptor('sphere', 'treeLeavesForest', [0, 0.552, 0], [0.6875, 0.448, 0.6875]),
    descriptor('sphere', 'treeLeavesForest', [-0.265, 0.655, 0.265], [0.4375, 0.241, 0.4375]),
  ]),
  // finite rock/pebble used a unit dodecahedron with its centre at half its
  // scale.  The projection supplies that finite scale in metres.
  rock: Object.freeze([
    descriptor('dodeca', 'rock', [0, 0.5, 0], [1, 1, 1]),
  ]),
  grass: Object.freeze([
    descriptor('box', 'grass', [-0.13, 0.3, 0], [0.08, 0.6, 0.08], [0, 0, -0.16]),
    descriptor('box', 'grassLight', [0.12, 0.25, 0.05], [0.07, 0.5, 0.07], [0, 0, 0.2]),
  ]),
  flower: Object.freeze([
    descriptor('box', 'grass', [0, 0.22, 0], [0.05, 0.44, 0.05]),
    descriptor('sphere', 'flower', [0, 0.5, 0], [0.2, 0.16, 0.2]),
  ]),
  factory: Object.freeze([
    descriptor('box', 'factoryWall', [0, 0.219, 0], [0.722, 0.438, 0.625]),
    descriptor('box', 'factoryRoof', [0, 0.459, 0], [0.778, 0.044, 0.688]),
    descriptor('cylinder', 'factoryTrim', [-0.25, 0.688, -0.188], [0.122, 0.688, 0.138]),
    descriptor('box', 'charred', [-0.25, 1.038, -0.188], [0.139, 0.031, 0.156]),
    descriptor('box', 'window', [-0.222, 0.281, 0.316], [0.097, 0.109, 0.025]),
    descriptor('box', 'window', [0, 0.281, 0.316], [0.097, 0.109, 0.025]),
    descriptor('box', 'window', [0.222, 0.281, 0.316], [0.097, 0.109, 0.025]),
  ]),
  militaryBase: Object.freeze([
    descriptor('box', 'towerWall', [0, 0.042, 0], [0.591, 0.083, 0.591]),
    descriptor('halfCylinder', 'military', [0, 0.083, -0.023], [0.455, 0.833, 0.455], [Math.PI / 2, 0, 0]),
    ...[-0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2].map(z => (
      descriptor('halfCylinder', 'charred', [0, 0.083, z], [0.468, 0.033, 0.468], [Math.PI / 2, 0, 0])
    )),
    descriptor('box', 'towerWall', [0, 0.167, 0.205], [0.318, 0.25, 0.045]),
    descriptor('box', 'charred', [0, 0.146, 0.205], [0.227, 0.208, 0.05]),
    descriptor('box', 'towerWall', [-0.227, 0.25, 0.227], [0.045, 0.417, 0.045]),
    descriptor('box', 'towerWall', [0.227, 0.25, 0.227], [0.045, 0.417, 0.045]),
    descriptor('box', 'charred', [-0.227, 0.5, 0.227], [0.068, 0.083, 0.068]),
    descriptor('box', 'charred', [0.227, 0.5, 0.227], [0.068, 0.083, 0.068]),
    descriptor('cylinder', 'playerWhiteEye', [-0.227, 0.604, 0.227], [0.01, 0.125, 0.01]),
    descriptor('cylinder', 'playerWhiteEye', [0.227, 0.604, 0.227], [0.01, 0.125, 0.01]),
  ]),
  barn: Object.freeze([
    descriptor('box', 'barn', [0, 0.325, 0], [0.786, 0.65, 0.536]),
    descriptor('box', 'barnRoof', [0, 0.65, 0], [0.857, 0.6, 0.429], [Math.PI / 4, 0, 0]),
    descriptor('box', 'barnTrim', [0, 0.54, 0.271], [0.5, 0.05, 0.025]),
    descriptor('box', 'barnDoor', [-0.107, 0.225, 0.271], [0.179, 0.45, 0.025]),
    descriptor('box', 'barnDoor', [0.107, 0.225, 0.271], [0.179, 0.45, 0.025]),
    descriptor('cylinder', 'towerWall', [0.554, 0.4, 0], [0.25, 0.8, 0.25]),
    descriptor('cone', 'barnRoof', [0.554, 0.913, 0], [0.286, 0.225, 0.286]),
  ]),
  haystack: Object.freeze([
    descriptor('dodeca', 'hay', [0, 0.35, 0], [0.72, 0.7, 0.72]),
    descriptor('cone', 'hay', [0, 0.88, 0], [0.72, 0.48, 0.72]),
  ]),
  cow: Object.freeze([
    descriptor('box', 'cow', [0, 0.3, 0], [0.972, 0.3, 1.111]),
    descriptor('box', 'cowDark', [-0.208, 0.3, 0], [0.306, 0.307, 1.139]),
    descriptor('box', 'cow', [0.583, 0.32, 0], [0.389, 0.187, 0.889]),
    ...[-1, 1].flatMap(x => [-1, 1].map(z => descriptor(
      'box', 'cowDark', [x * 0.306, 0.087, z * 0.389], [0.139, 0.173, 0.278],
    ))),
  ]),
  streetLamp: Object.freeze([
    descriptor('box', 'charred', [0, 0.5, 0], [0.08, 1, 0.08]),
    descriptor('sphere', 'streetLight', [0, 1.03, 0], [0.18, 0.18, 0.18]),
  ]),
  roadSign: Object.freeze([
    descriptor('box', 'charred', [0, 0.42, 0], [0.08, 0.84, 0.08]),
    descriptor('box', 'roadSign', [0, 0.85, 0], [0.64, 0.34, 0.08]),
  ]),
});

function requireType(THREE, name, fallback) {
  const Type = THREE?.[name] ?? THREE?.[fallback];
  if (typeof Type !== 'function') throw new TypeError(`THREE.${name} is required`);
  return Type;
}

export function createW8ParityVisualAssetLibrary({ THREE } = {}) {
  const base = createProductionVisualAssetLibrary({ THREE });
  const Group = requireType(THREE, 'Group');
  const Mesh = requireType(THREE, 'Mesh');
  const CylinderGeometry = requireType(THREE, 'CylinderGeometry');
  const Material = requireType(THREE, 'MeshLambertMaterial');
  const PhongMaterial = requireType(THREE, 'MeshPhongMaterial', 'MeshLambertMaterial');
  const BasicMaterial = requireType(THREE, 'MeshBasicMaterial', 'MeshLambertMaterial');
  const material = (color, extra = {}) => new Material({ color, flatShading: true, ...extra });
  const phong = (color, extra = {}) => new PhongMaterial({ color, ...extra });
  const basic = (color, extra = {}) => new BasicMaterial({ color, ...extra });
  const supplementalGeometries = Object.freeze({
    cylinder: new CylinderGeometry(0.5, 0.5, 1, 8),
    halfCylinder: new CylinderGeometry(0.5, 0.5, 1, 16, 1, false, Math.PI / 2, Math.PI),
    torus: new (requireType(THREE, 'TorusGeometry', 'CylinderGeometry'))(0.5, 0.055, 6, 24),
    windArc: new (requireType(THREE, 'TorusGeometry', 'CylinderGeometry'))(
      0.5, 0.045, 6, 20, Math.PI * 1.35,
    ),
    landingRing: new (requireType(THREE, 'RingGeometry', 'CylinderGeometry'))(0.1, 1, 20),
  });
  const settlementPaletteMaterials = {};
  for (const palette of Object.values(SETTLEMENT_BUILDING_PALETTES)) {
    for (const color of [...palette.wall, ...palette.roof]) {
      settlementPaletteMaterials[settlementMaterialKey(color)] ??= phong(color);
    }
  }
  const supplementalMaterials = {
    humanBody: phong(0x3366ff),
    skin: phong(0xffccaa),
    tank: phong(0x4a6523, { shininess: 40 }),
    charred: phong(0x333333),
    playerCrab: phong(0xff4500),
    playerWhiteEye: phong(0xffffff, { shininess: 60 }),
    playerBlackEye: phong(0x111111, { shininess: 100 }),
    treeTrunk: phong(0x5d4037, { shininess: 2 }),
    treeLeaves: phong(0x2e7d32, { shininess: 3 }),
    treeLeavesForest: phong(0x1b5e20, { shininess: 3 }),
    treeLeavesMeadow: phong(0x7cb342, { shininess: 3 }),
    road: phong(0xc2a878, { shininess: 3 }),
    lotResidential: phong(0xa58c68, { shininess: 2 }),
    lotCivic: phong(0x918d84, { shininess: 4 }),
    houseWall: phong(0xeeeeee), houseRoof: phong(0xaa2222),
    towerWall: phong(0x78909c), towerRoof: phong(0x37474f),
    churchWall: phong(0xe0e0e0), churchRoof: phong(0x37474f),
    schoolWall: phong(0xdfbca0), schoolRoof: phong(0x37474f),
    window: phong(0x29b6f6, { transparent: true, opacity: 0.75, shininess: 100 }),
    stainedGlassBlue: phong(0x1565c0, { shininess: 80 }),
    stainedGlassYellow: phong(0xfbc02d, { shininess: 80 }),
    gold: phong(0xffd700, { shininess: 80 }),
    grass: material(0x376b22), grassLight: material(0x75a83a), flower: material(0xffd54f),
    factoryWall: phong(0x707878), factoryRoof: phong(0x4a4a4a), factoryTrim: phong(0xb5651d),
    brick: phong(0xb5651d), military: phong(0x4a6523, { shininess: 40 }),
    militaryRoof: phong(0x333333), barn: phong(0x8b3a2f), barnRoof: phong(0x3a3a3a),
    barnTrim: phong(0xf5f5f0), barnDoor: phong(0x333333), hay: phong(0xd4a017), cow: phong(0xf5f5f0),
    cowDark: phong(0x2b2b2b), streetLight: material(0xffe28a), roadSign: material(0x244b59),
    water: phong(0x2f6fa8, { transparent: true, opacity: 0.82, shininess: 70, depthWrite: false }),
    scorch: material(0x241b18, { transparent: true, opacity: 0.72 }),
    blood: material(0x7e1019), acid: material(0x7cff31),
    bossSegmentDark: phong(0x4a1c2c, { shininess: 40 }),
    bossSegmentMid: phong(0x63263a, { shininess: 40 }),
    bossSegmentLight: phong(0x7b354b, { shininess: 40 }),
    bossTeeth: phong(0xeeeedd, { shininess: 80 }),
    bossEyeCyan: phong(0x00ffcc, { shininess: 100, emissive: 0x004c3d }),
    atomicFlash: basic(0xffffff, { transparent: true, opacity: 0.65, depthWrite: false }),
    atomicOrange: basic(0xffaa00, { transparent: true, opacity: 0.65, depthWrite: false }),
    shockwave: phong(0xffb020, { transparent: true, opacity: 0.72, depthWrite: false }),
    landingOuter: basic(0xff3300, {
      side: THREE.DoubleSide, transparent: true, opacity: 0.85,
      depthTest: false, depthWrite: false,
    }),
    landingInner: basic(0xffaa00, {
      side: THREE.DoubleSide, transparent: true, opacity: 0.85,
      depthTest: false, depthWrite: false,
    }),
    wind: basic(0xffffff, { transparent: true, opacity: 0.8, depthWrite: false }),
    smoke: phong(0x4a413d, { transparent: true, opacity: 0.68, depthWrite: false }),
    lobbyFire: phong(0xff5500, { emissive: 0x662200, shininess: 0 }),
    lobbySmoke: phong(0x1a1a1a, { shininess: 0 }),
    cloud: phong(0xffffff, {
      transparent: true, opacity: 0.72, depthWrite: false, shininess: 4,
    }),
    ...settlementPaletteMaterials,
  };
  const geometries = Object.freeze({ ...base.geometries, ...supplementalGeometries });
  const materials = Object.freeze({ ...base.materials, ...supplementalMaterials });
  let disposed = false;

  function appendPart(group, geometry, materialName, position, scale, role) {
    const mesh = new Mesh(geometries[geometry], materials[materialName]);
    mesh.position.set(...position); mesh.scale.set(...scale);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { ...(mesh.userData ?? {}), presentationRole: role };
    group.add(mesh);
    return mesh;
  }

  function createPlayerModel() {
    const group = new Group();
    group.name = 'w8-finite-parity-player-crab';
    const visualRoot = new Group();
    visualRoot.name = 'finite-player-visual-root';
    group.add(visualRoot);
    const shell = appendPart(visualRoot, 'box', 'playerCrab', [0, 30, 0], [100, 45, 85], 'shell');
    appendPart(visualRoot, 'box', 'playerCrab', [20, 50, 35], [8, 22, 8], 'left-eye-stalk');
    appendPart(visualRoot, 'sphere', 'playerWhiteEye', [20, 61, 35], [12, 12, 12], 'left-eye');
    appendPart(visualRoot, 'box', 'playerBlackEye', [20, 61, 46], [6, 6, 4], 'left-pupil');
    appendPart(visualRoot, 'box', 'playerCrab', [-20, 50, 35], [8, 22, 8], 'right-eye-stalk');
    appendPart(visualRoot, 'sphere', 'playerWhiteEye', [-20, 61, 35], [12, 12, 12], 'right-eye');
    appendPart(visualRoot, 'box', 'playerBlackEye', [-20, 61, 46], [6, 6, 4], 'right-pupil');

    const createClaw = side => {
      const claw = new Group();
      claw.name = side > 0 ? 'finite-left-claw-root' : 'finite-right-claw-root';
      claw.position.set(side * 85, 30, 5);
      appendPart(claw, 'box', 'playerCrab', [0, 0, 50], [55, 35, 55], 'pincer');
      appendPart(claw, 'box', 'playerCrab', [side * 18, 0, 85], [15, 20, 35], 'outer-cutter');
      appendPart(claw, 'box', 'playerCrab', [-side * 12, 0, 75], [12, 16, 25], 'inner-cutter');
      visualRoot.add(claw);
      return claw;
    };
    const leftClaw = createClaw(1);
    const rightClaw = createClaw(-1);
    const legs = [];
    for (let index = 0; index < 8; index += 1) {
      legs.push(appendPart(
        visualRoot,
        'box',
        'playerCrab',
        [(index < 4 ? 1 : -1) * 85, 0, (index % 4 - 1.5) * 30],
        [15, 45, 15],
        `leg-${index}`,
      ));
    }
    group.userData.presentationParts = {
      shell,
      visualRoot,
      claws: [leftClaw, rightClaw],
      leftClaw,
      rightClaw,
      legs,
    };
    group.userData.finiteMeshCount = 21;
    return group;
  }

  function createHumanModel() {
    const group = base.createEntityModel('human');
    group.userData = {
      ...(group.userData ?? {}),
      presentationParts: { body: group.children[0] ?? null, head: group.children[1] ?? null },
      finiteMeshCount: 2,
    };
    return group;
  }

  function createTankModel() {
    const group = base.createEntityModel('tank');
    group.clear?.();
    const chassis = appendPart(group, 'box', 'tank', [0, 30, 0], [100, 35, 140], 'chassis');
    appendPart(group, 'box', 'charred', [-61, 20, 0], [22, 40, 160], 'left-track');
    appendPart(group, 'box', 'charred', [61, 20, 0], [22, 40, 160], 'right-track');
    const turret = new Group();
    turret.name = 'finite-tank-turret-pivot';
    turret.position.set(0, 60, -10);
    const turretBody = appendPart(turret, 'box', 'tank', [0, 0, 0], [65, 26, 75], 'turret-body');
    appendPart(turret, 'box', 'charred', [16, 14, -10], [24, 5, 24], 'hatch');
    const gun = new Group();
    gun.name = 'finite-tank-gun-pivot';
    gun.position.set(0, 0, 32);
    appendPart(gun, 'box', 'tank', [0, 0, 45], [8, 8, 90], 'barrel');
    const muzzle = appendPart(gun, 'box', 'charred', [0, 0, 90], [14, 14, 16], 'muzzle');
    turret.add(gun);
    group.add(turret);
    const exhaust = appendPart(group, 'box', 'charred', [-35, 35, -70], [8, 22, 8], 'exhaust');
    group.userData = {
      ...(group.userData ?? {}),
      presentationParts: { chassis, turret, turretBody, gun, muzzle, exhaust },
      finiteMeshCount: 8,
    };
    return group;
  }

  function createBossModel() {
    const group = base.createEntityModel('boss');
    group.clear?.();
    const segments = [];
    for (let index = 0; index < 14; index += 1) {
      const radius = 140 - index * 7.5;
      const segment = new Group();
      segment.name = `finite-boss-segment-${index}`;
      segment.position.set(0, 80, -index * 110);
      segment.userData = { radius, segmentIndex: index };
      const segmentMaterial = index < 5 ? 'bossSegmentDark'
        : index < 10 ? 'bossSegmentMid' : 'bossSegmentLight';
      appendPart(segment, 'sphere', segmentMaterial, [0, 0, 0], [radius, radius * 0.9, radius],
        `boss-segment-body-${index}`);
      if (index === 0) {
        for (let toothIndex = 0; toothIndex < 10; toothIndex += 1) {
          const angle = toothIndex / 10 * Math.PI * 2;
          const toothScale = radius * 0.12;
          appendPart(segment, 'cone', 'bossTeeth', [
            Math.cos(angle) * radius * 0.35,
            Math.sin(angle) * radius * 0.35,
            radius * 0.42,
          ], [toothScale, toothScale * 2.8, toothScale],
          `boss-tooth-${toothIndex}`).rotation.set(Math.PI / 2, 0, -angle);
        }
        for (let eyeIndex = 0; eyeIndex < 4; eyeIndex += 1) {
          const angle = eyeIndex / 4 * Math.PI * 2 + 0.3;
          const eyeScale = radius * 0.08;
          appendPart(segment, 'sphere', 'bossEyeCyan', [
            Math.cos(angle) * radius * 0.42,
            Math.sin(angle) * radius * 0.42,
            radius * 0.2,
          ], [eyeScale, eyeScale, eyeScale], `boss-eye-${eyeIndex}`);
        }
      }
      group.add(segment);
      segments.push(segment);
    }
    group.userData = {
      ...(group.userData ?? {}),
      segmentMeshes: segments,
      finiteSegmentCount: 14,
      finiteToothCount: 10,
      finiteEyeCount: 4,
    };
    return group;
  }

  return Object.freeze({
    schemaVersion: 'w8-finite-parity-visual-assets-1',
    sourceCommit: FINITE_VISUAL_SOURCE_COMMIT,
    geometries,
    materials,
    featureParts: W8_PARITY_FEATURE_PARTS,
    resolveBuildingParts: resolveW8BuildingParts,
    createPlayerModel,
    createEntityModel(type) {
      if (type === 'human') return createHumanModel();
      if (type === 'boss') return createBossModel();
      if (type === 'tank') return createTankModel();
      return base.createEntityModel(type);
    },
    snapshot() {
      const source = base.snapshot();
      return Object.freeze({
        ...source,
        schemaVersion: 'w8-finite-parity-visual-resource-snapshot-1',
        sharedGeometryCount: source.sharedGeometryCount + Object.keys(supplementalGeometries).length,
        sharedMaterialCount: source.sharedMaterialCount + Object.keys(supplementalMaterials).length,
        disposed,
      });
    },
    dispose() {
      if (disposed) return;
      for (const geometry of Object.values(supplementalGeometries)) geometry.dispose();
      for (const value of Object.values(supplementalMaterials)) value.dispose();
      base.dispose();
      disposed = true;
    },
  });
}

export { PRODUCTION_VISUAL_UNITS_PER_METER };
