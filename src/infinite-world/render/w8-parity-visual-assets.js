import {
  FINITE_VISUAL_SOURCE_COMMIT,
  PRODUCTION_FEATURE_PARTS,
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createProductionVisualAssetLibrary,
} from './production-visual-assets.js';

const descriptor = (geometry, material, position, scale, rotation = [0, 0, 0]) => Object.freeze({
  geometry, material, position, scale, rotation,
});

export const W8_PARITY_FEATURE_PARTS = Object.freeze({
  ...PRODUCTION_FEATURE_PARTS,
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
  grass: Object.freeze([
    descriptor('box', 'grass', [-0.13, 0.3, 0], [0.08, 0.6, 0.08], [0, 0, -0.16]),
    descriptor('box', 'grassLight', [0.12, 0.25, 0.05], [0.07, 0.5, 0.07], [0, 0, 0.2]),
  ]),
  flower: Object.freeze([
    descriptor('box', 'grass', [0, 0.22, 0], [0.05, 0.44, 0.05]),
    descriptor('sphere', 'flower', [0, 0.5, 0], [0.2, 0.16, 0.2]),
  ]),
  factory: Object.freeze([
    descriptor('box', 'factoryWall', [0, 0.34, 0], [1, 0.68, 1]),
    descriptor('box', 'factoryRoof', [0, 0.72, 0], [1.04, 0.08, 1.04]),
    descriptor('box', 'factoryTrim', [0.3, 0.95, -0.24], [0.16, 0.62, 0.16]),
    descriptor('box', 'window', [-0.28, 0.42, 0.51], [0.22, 0.18, 0.03]),
  ]),
  militaryBase: Object.freeze([
    descriptor('box', 'military', [0, 0.2, 0], [1, 0.4, 1]),
    descriptor('pyramid', 'militaryRoof', [0, 0.48, 0], [1.08, 0.24, 1.08]),
    descriptor('box', 'charred', [0, 0.42, 0.51], [0.34, 0.32, 0.03]),
    descriptor('box', 'gold', [0, 0.82, 0], [0.04, 0.52, 0.04]),
  ]),
  barn: Object.freeze([
    descriptor('box', 'barn', [0, 0.35, 0], [1, 0.7, 1]),
    descriptor('pyramid', 'barnRoof', [0, 0.8, 0], [1.1, 0.34, 1.1]),
    descriptor('box', 'barnDoor', [0, 0.33, 0.51], [0.34, 0.58, 0.03]),
  ]),
  haystack: Object.freeze([
    descriptor('dodeca', 'hay', [0, 0.35, 0], [0.72, 0.7, 0.72]),
    descriptor('cone', 'hay', [0, 0.88, 0], [0.72, 0.48, 0.72]),
  ]),
  cow: Object.freeze([
    descriptor('box', 'cow', [0, 0.42, 0], [0.9, 0.48, 0.42]),
    descriptor('box', 'cowDark', [0, 0.5, 0.38], [0.34, 0.34, 0.28]),
    descriptor('box', 'cowDark', [-0.3, 0.16, -0.22], [0.1, 0.46, 0.1]),
    descriptor('box', 'cowDark', [0.3, 0.16, 0.22], [0.1, 0.46, 0.1]),
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
  const Material = requireType(THREE, 'MeshLambertMaterial');
  const PhongMaterial = requireType(THREE, 'MeshPhongMaterial', 'MeshLambertMaterial');
  const material = (color, extra = {}) => new Material({ color, flatShading: true, ...extra });
  const phong = (color, extra = {}) => new PhongMaterial({ color, ...extra });
  const supplementalMaterials = {
    playerCrab: phong(0xff4500),
    playerWhiteEye: phong(0xffffff, { shininess: 60 }),
    playerBlackEye: phong(0x111111, { shininess: 100 }),
    treeTrunk: phong(0x5d4037, { shininess: 2 }),
    treeLeaves: phong(0x2e7d32, { shininess: 3 }),
    treeLeavesForest: phong(0x1b5e20, { shininess: 3 }),
    treeLeavesMeadow: phong(0x7cb342, { shininess: 3 }),
    road: phong(0xc2a878, { shininess: 3 }),
    houseWall: phong(0xeeeeee), houseRoof: phong(0xaa2222),
    towerWall: phong(0x78909c), towerRoof: phong(0x37474f),
    churchWall: phong(0xe0e0e0), churchRoof: phong(0x37474f),
    schoolWall: phong(0xdfbca0), schoolRoof: phong(0x37474f),
    window: phong(0x29b6f6, { transparent: true, opacity: 0.75, shininess: 100 }),
    gold: phong(0xffd700, { shininess: 80 }),
    grass: material(0x376b22), grassLight: material(0x75a83a), flower: material(0xffd54f),
    factoryWall: phong(0x707878), factoryRoof: phong(0x4a4a4a), factoryTrim: phong(0xb5651d),
    brick: phong(0xb5651d), military: phong(0x4a6523, { shininess: 40 }),
    militaryRoof: phong(0x333333), barn: phong(0x8b3a2f), barnRoof: phong(0x3a3a3a),
    barnDoor: phong(0x333333), hay: phong(0xd4a017), cow: phong(0xf5f5f0),
    cowDark: phong(0x2b2b2b), streetLight: material(0xffe28a), roadSign: material(0x244b59),
    water: phong(0x2f6fa8, { transparent: true, opacity: 0.82, shininess: 70, depthWrite: false }),
    scorch: material(0x241b18, { transparent: true, opacity: 0.72 }),
    blood: material(0x7e1019), acid: material(0x7cff31),
    cloud: material(0xffffff, { transparent: true, opacity: 0.68, depthWrite: false }),
    horizonTerrain: material(0x668c54),
  };
  const materials = Object.freeze({ ...base.materials, ...supplementalMaterials });
  let disposed = false;

  function appendPart(group, geometry, materialName, position, scale, role) {
    const mesh = new Mesh(base.geometries[geometry], materials[materialName]);
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
    const leftArm = appendPart(group, 'box', 'humanBody', [-24, 42, 0], [12, 62, 12], 'left-arm');
    const rightArm = appendPart(group, 'box', 'humanBody', [24, 42, 0], [12, 62, 12], 'right-arm');
    const leftLeg = appendPart(group, 'box', 'charred', [-13, -4, 0], [15, 62, 16], 'left-leg');
    const rightLeg = appendPart(group, 'box', 'charred', [13, -4, 0], [15, 62, 16], 'right-leg');
    group.userData.presentationParts = { leftArm, rightArm, leftLeg, rightLeg };
    return group;
  }

  function createTankModel() {
    const group = base.createEntityModel('tank');
    group.userData.presentationParts = {
      turret: group.children[3] ?? null,
      gun: group.children[5] ?? null,
    };
    return group;
  }

  function createBossModel() {
    const group = base.createEntityModel('boss');
    const segments = [];
    for (let index = 0; index < 14; index += 1) {
      const taper = 1 - index * 0.035;
      segments.push(appendPart(
        group, 'dodeca', index > 10 ? 'charred' : 'boss',
        [0, 205 - index * 5, -270 - index * 210],
        [255 * taper, 205 * taper, 245 * taper], `boss-segment-${index}`,
      ));
    }
    group.userData.segmentMeshes = segments;
    return group;
  }

  return Object.freeze({
    schemaVersion: 'w8-finite-parity-visual-assets-1',
    sourceCommit: FINITE_VISUAL_SOURCE_COMMIT,
    geometries: base.geometries,
    materials,
    featureParts: W8_PARITY_FEATURE_PARTS,
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
        sharedMaterialCount: source.sharedMaterialCount + Object.keys(supplementalMaterials).length,
        disposed,
      });
    },
    dispose() {
      if (disposed) return;
      for (const value of Object.values(supplementalMaterials)) value.dispose();
      base.dispose();
      disposed = true;
    },
  });
}

export { PRODUCTION_VISUAL_UNITS_PER_METER };
