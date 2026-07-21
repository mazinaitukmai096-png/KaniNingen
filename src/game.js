import {
  CAM_INITIAL_DIST,CAM_INITIAL_PITCH,CAM_MOUSE_ROTATION_SPEED,CAM_WHEEL_ZOOM_SCALE,
  ATTACK_COOLDOWN,CHARGE_THRESHOLD,ATTACK_INPUT_DELAY_MS,INTRO_DURATION_MS,BOMB_COOLDOWN,BOMB_DAMAGE_RADIUS,BOMB_PUSH_RADIUS,BOMB_DAMAGE_AMOUNT,MAP_RADIUS_LIMIT,MAP_SIZE,
  PLAYER_MAX_HP,PLAYER_SPEED,PLAYER_RADIUS,PLAYER_GRAVITY,DEBUFF_SPEED_MULT,
  TANK_HP,TANK_RADIUS,TANK_SCORE_VALUE,TANK_DESPAWN_DIST,TANK_ENGAGE_RANGE,TANK_APPROACH_DIST,
  TANK_MOVE_SPEED,TANK_BODY_TURN_SPEED,TANK_TURRET_TURN_SPEED,TANK_GUN_PITCH_SPEED,
  TANK_STUCK_CHECK_INTERVAL,TANK_STUCK_DIST_THRESHOLD_SQ,TANK_STUCK_AVOID_TIMER,
  TANK_FIRE_INTERVAL_MIN,TANK_FIRE_INTERVAL_BASE,TANK_FIRE_INTERVAL_SCORE_DIVISOR,
  TANK_BULLET_SPEED,TANK_BULLET_LIFE,TANK_BULLET_HIT_RADIUS,TANK_BULLET_DAMAGE,
  BOSS_SEGMENT_COUNT,BOSS_HP,BOSS_RADIUS,BOSS_SCORE_VALUE,
  BOSS_ACID_SPEED,BOSS_ACID_LIFE,BOSS_ACID_HIT_RADIUS,BOSS_ACID_DAMAGE,
  BOSS_RAGE_HP_RATIO,BOSS_HYPERRAGE_HP_RATIO,BOSS_STAGE1_HP_RATIO,BOSS_SEGMENTS_PER_STAGE,
  BOSS_SLITHER_TURN_SPEED,BOSS_SLITHER_APPROACH_DIST,BOSS_SLITHER_SPEED,BOSS_SLITHER_SPEED_RAGE,
  BOSS_SLITHER_ACID_SPIT_CHANCE,BOSS_SLITHER_DURATION,BOSS_CHARGE_DURATION_FROM_SLITHER,
  BOSS_DIG_DURATION_FROM_SLITHER,BOSS_SWEEP_DURATION_FROM_SLITHER,
  BOSS_SWEEP_RADIUS_START,BOSS_SWEEP_CLOSE_RATE,BOSS_SWEEP_TURN_SPEED,BOSS_SWEEP_SPEED,
  BOSS_SWEEP_SPEED_RAGE,BOSS_CHARGE_DURATION_FROM_SWEEP,
  BOSS_CHARGE_TURN_SPEED,BOSS_CHARGE_SPEED,BOSS_CHARGE_SPEED_RAGE,BOSS_CHARGE_HIT_RADIUS,
  BOSS_CHARGE_DAMAGE,BOSS_CHARGE_DAMAGE_RAGE,BOSS_CHARGE_PUSH_FORCE,BOSS_DIG_DURATION_FROM_CHARGE,
  BOSS_DIG_TURN_SPEED,BOSS_DIG_SPEED,BOSS_DIG_SPEED_RAGE,BOSS_DIG_CATCHUP_DIST,BOSS_DIG_CATCHUP_BOOST,
  BOSS_DIG_SINK_RATE,BOSS_DIG_MAX_DEPTH,BOSS_BREACH_DURATION,BOSS_BREACH_JUMP_VELOCITY,BOSS_BREACH_PREDICT_SECONDS,
  BOSS_BREACH_ARRIVE_DIST,BOSS_BREACH_MOVE_SPEED,BOSS_BREACH_GRAVITY,BOSS_BREACH_LANDING_SCAR_RADIUS,
  BOSS_RECOVER_DURATION,BOSS_LANDING_DAMAGE_RADIUS,BOSS_LANDING_DAMAGE_AMOUNT,BOSS_LANDING_PUSH_RADIUS,
  BOSS_LANDING_SCAR_RADIUS_MULT,BOSS_LANDING_ACID_SPRAY_COUNT,
  BOSS_RECOVER_SPIT_RATE,BOSS_SLITHER_DURATION_FROM_RECOVER,
  BOSS_SEGMENT_GAP_THRESHOLD,BOSS_SEGMENT_LERP_BASE,BOSS_SEGMENT_WAVE_FREQ,BOSS_SEGMENT_WAVE_TURN_MULT,
  BOSS_BODY_CONTACT_RANGE,BOSS_BODY_CONTACT_DAMAGE,
  BOSS_TAIL_HIT_RADIUS,BOSS_TAIL_DAMAGE,BOSS_TAIL_KNOCKBACK,BOSS_TAIL_HIT_COOLDOWN,
  BOSS_LANDING_PLAYER_KNOCKBACK,BOSS_PLAYER_KNOCKBACK_DECAY,
  PLAYER_KNOCKBACK_COLLISION_GRACE,
  HUMAN_WATER_AVOID_DURATION,HUMAN_WATER_AVOID_BLEND,
  DEBUG_NOCLIP_SPEED_MULT,DEBUG_SCORE_STEP,DEBUG_BOSS_SPAWN_DIST
} from './constants.js';
import { createInputController } from './core/input.js';
import { createRendererController } from './core/renderer.js';
import {
  HUMAN_VISUAL_SCALES,
  INITIAL_SCALE_STAGE_ID,
  canScaleStageDamageTarget,
  getScaleStage,
  isScaleSandboxAtomicEnabled,
} from './scale-sandbox.js';

let bossHPDelay = 100;

function renderBossHP(en) {
    const hpRatio = Math.max(0, en.hp / en.maxHp) * 100;
    document.getElementById("boss-hp-fill").style.width = hpRatio + "%";
    document.getElementById("boss-hp-damage").style.width = bossHPDelay + "%";
    setTimeout(() => {
        bossHPDelay = hpRatio;
        document.getElementById("boss-hp-damage").style.width = bossHPDelay + "%";
    }, 500);
}

let scene, camera, renderer, clock, animationId;
let inputController, rendererController;

        // --- 追加: カメラ透視（障害物の半透明化）用の変数 ---
        const cameraRaycaster = new THREE.Raycaster();
        let transparentObjects = [];
        const transparentMaterialCache = {};

        function getTransparentMaterial(originalMat) {
            if (!originalMat) return null;
            // 一度作った半透明マテリアルはキャッシュして使い回す（メモリ対策）
            if (transparentMaterialCache[originalMat.uuid]) {
                return transparentMaterialCache[originalMat.uuid];
            }
            const transMat = originalMat.clone();
            transMat.transparent = true;
            transMat.opacity = 0.25; // 0.0(透明) 〜 1.0(不透明)。0.25でうっすら見える程度
            transMat.depthWrite = false; // 透けた奥の景色が正しく描画されるようにする
            transparentMaterialCache[originalMat.uuid] = transMat;
            return transMat;
        }

        // FPSカウンター表示・FPS上限（フレームスキップ）用の計測変数
        let fpsFrameCount = 0;
        let fpsLastSampleTime = performance.now();
        let lastFps = 0; // デバッグモーダル表示用に直近のFPS値を保持
        let lastRenderedFrameTime = 0;
        let yaw = 0, pitch = CAM_INITIAL_PITCH, score = 0, shake = 0, gameRunning = false, isGameOver = false;
        // 地面の高さを返す関数（現在は平坦な地形のため常に0を返します）
        function getTerrainHeight(x, z) {
        return 0;
        }
        // 待機画面・ドロップシーケンス用のステート変数
        let isMenu = true;
        let isDropping = false;
        let dropVelY = 0;
        let isPaused = false; // 設定画面開閉時のポーズ用
        let lobbyExplosionTimer = 0; // タイトル画面で遠くに原爆を落とす演出用タイマー
        // ゲーム設定値の保持
        const settings = {
            mouseSensitivity: 1.0,
            volume: 0.5,
            shadows: true,
            cameraShake: 1.0,
            quality: 'medium', // 'high' | 'medium' | 'low'（低スペックPC向け画質プリセット。初期値は標準）
            showFpsCounter: false, // 画面左上にFPSを表示するか
            fpsCap: 0,              // FPS上限（0=無制限、発熱・電池消費を抑えたい場合に30/60/120等を指定）
            // アンチエイリアスはWebGL描画コンテキスト生成時にしか切り替えられない（再生成するとPointerLockが壊れる既知の不具合があるため
            // このゲームでは意図的にレンダラーを使い回している）。そのため次回ページ読み込み時に反映される設定として保存する。
            antialias: (() => {
                try {
                    const saved = localStorage.getItem('gameAntialias');
                    return saved === null ? true : saved === 'true';
                } catch (e) { return true; }
            })()
        };

        // ===== デバッグモード（F1でパネルを開閉。開発中の動作確認専用） =====
        const debugState = {
            godMode: false,   // 無敵モード：HPが減らない
            noclip: false,    // ノークリップ：建物・ボスに当たらず、移動速度も上がる
        };

        let activeScaleStageId = INITIAL_SCALE_STAGE_ID;
        let activeScaleStage = getScaleStage(activeScaleStageId);
        let humanVisualScale = HUMAN_VISUAL_SCALES.CURRENT;
        let camDist = CAM_INITIAL_DIST;
        // --- 追加: ゲーム開始時の映画的カメラ演出（確立ショット→通常視点） ---
        let isIntroPlaying = false;
        let introStartTime = 0;
        let introStartCamPos = null;
        let introStartLookAt = null;
        const entities = [], particles = [], bullets = [], scars = [], shockwaves = [];
        const DESTRUCTIBLE_BUILDING_TYPES = new Set(['house', 'tower', 'church', 'school', 'barn', 'factory']);
        const MOBILE_COLLISION_OBSTACLE_TYPES = new Set(['house', 'rock', 'pebble', 'tower', 'church', 'school', 'militaryBase', 'barn', 'factory']);
        const BOSS_COLLISION_OBSTACLE_TYPES = new Set(['house', 'rock', 'pebble', 'tower', 'church', 'school']);
        let buildingHitStopUntil = 0;
        // 水域（川・池）データ専用の独立配列。{ x, z, radius } のみを保持する純粋な地形データで、
        // entities配列（攻撃判定・スコア・耐久力を持つオブジェクト群）とは完全に分離して管理する。
        const waterZones = [];
        // 橋データ専用の独立配列。{ x, z, angle, halfLength, halfWidth } のみを保持し、
        // 「この矩形範囲内にいる人間NPCは水域回避を無視して良い」という判定にのみ使う。
        const bridges = [];
        let tankCount = 0;
        let militaryBases = []; // 各町の外れに配置される軍事施設のエンティティ参照（戦車のスポーン元として使用）
        // 人間NPCの配置候補地点プール（画質プリセットの人口密度調整用）。
        // initMap() で全候補地点を記録し、そのうち何割を実際に生成するかを humanDensity で決める。
        let humanSpawnPool = [];
        let humanPoolActivatedCount = 0; // プール内、これまでに実体化(spawnEntity)した件数
        let MAX_TANKS = 4;
        let nextBossScore = 35000; 
        let bossActive = false;
        let hudHidden = false; // HUD表示ON/OFF状態
        let lastAttackTime = -9999;

        // 可視制御＆シャドウ処理範囲（画質プリセットにより実行時に上書きされる）
        let ACTIVE_DISTANCE_SQ = 7500 * 7500; 
        let SHADOW_DISTANCE_SQ = 2800 * 2800; 

        // パーティクル同時数上限（画質プリセットにより実行時に上書きされる）
        let PARTICLE_CAP_NORMAL = 500;
        let PARTICLE_CAP_HEAVY = 800;
        // 爆発・被弾などで生成するパーティクル「数」自体に掛ける倍率（画質プリセットにより上書き）
        // 例: 0.5なら createParticles(..., count, ...) の count を半分に間引く
        let PARTICLE_COUNT_SCALE = 1.0;
        // 地面に残る傷跡・血痕デカールの同時保持数上限（画質プリセットにより上書き）
        let SCAR_CAP = 50;
        // 建物・戦車破壊時に「バラバラの破片」として物理演算させるパーツ数上限（画質プリセットにより上書き）
        // 0にすると、破片が飛び散る演出自体を行わず、瓦礫（spawnRuins）だけを残して軽量化する
        let DEBRIS_PIECE_CAP = 10;
        // 岩・小石破壊時に飛び散らせる破片（シャード）の数上限（画質プリセットにより上書き）
        let ROCK_SHARD_CAP = 8;

        const geometries = {
            box: new THREE.BoxGeometry(1, 1, 1),
            cone: new THREE.ConeGeometry(1, 1, 8),
            // 追加：辺が壁と平行になり、スケール値がそのまま幅・奥行きになる完璧な四角錐（ピラミッド）
            pyramid: new THREE.CylinderGeometry(0, 0.7071, 1, 4, 1, false, Math.PI / 4),
            sphere: new THREE.SphereGeometry(1, 12, 12),
            dodeca: new THREE.DodecahedronGeometry(1),
            ringUnit: new THREE.RingGeometry(0.1, 1, 20),
            circleUnit: new THREE.CircleGeometry(1, 10)
        };

        const materials = {
            houseBase: new THREE.MeshPhongMaterial({color: 0xeeeeee}),
            houseRoof: new THREE.MeshPhongMaterial({color: 0xaa2222}),
            treeTrunk: new THREE.MeshPhongMaterial({color: 0x5d4037}),
            treeLeaves: new THREE.MeshPhongMaterial({color: 0x2e7d32}),
            rock: new THREE.MeshPhongMaterial({color: 0xa0785a}),
            treeLeavesForest: new THREE.MeshPhongMaterial({color: 0x1b5e20}),  // 森林バイオーム用：濃い緑
            treeLeavesMeadow: new THREE.MeshPhongMaterial({color: 0x7cb342}),  // 花咲く草原バイオーム用：明るい黄緑
            treeLeavesPlateau: new THREE.MeshPhongMaterial({color: 0xaed581}), // 高原バイオーム用：さらに明るい黄緑
            rockHighland: new THREE.MeshPhongMaterial({color: 0x9e9e9e}),      // 岩石高地バイオーム用：グレー岩
            tank: new THREE.MeshPhongMaterial({color: 0x4a6523, shininess: 40}), // 生存時：より鮮やかでツヤ感のあるオリーブ色
            bossLeg: new THREE.MeshPhongMaterial({color: 0x111111}),
            charred: new THREE.MeshPhongMaterial({color: 0x333333}),
            ruinsCharred: new THREE.MeshPhongMaterial({color: 0x2a2522, shininess: 5}), 
            blood: new THREE.MeshBasicMaterial({color: 0xaa0000}),
            atomic: new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.65}),
            sandDust: new THREE.MeshBasicMaterial({color: 0xa08060, transparent: true, opacity: 0.45}),
            orangeSpark: new THREE.MeshBasicMaterial({color: 0xff5500, transparent: true, opacity: 0.8}),
            goldSpark: new THREE.MeshBasicMaterial({color: 0xffdd44, transparent: true, opacity: 0.9}),
            
            towerBase: new THREE.MeshPhongMaterial({color: 0x78909c}), 
            churchBase: new THREE.MeshPhongMaterial({color: 0xe0e0e0}), 
            churchRoof: new THREE.MeshPhongMaterial({color: 0x37474f}), 
            schoolBase: new THREE.MeshPhongMaterial({color: 0xdfbca0}), 
            gold: new THREE.MeshPhongMaterial({color: 0xffd700, shininess: 80}),

            windowGlass: new THREE.MeshPhongMaterial({color: 0x29b6f6, transparent: true, opacity: 0.75, shininess: 100}), 
            stainedGlassBlue: new THREE.MeshPhongMaterial({color: 0x1565c0, shininess: 80}), 
            stainedGlassYellow: new THREE.MeshPhongMaterial({color: 0xfbc02d, shininess: 80}), 
            whiteEye: new THREE.MeshPhongMaterial({color: 0xffffff, shininess: 60}),
            blackEye: new THREE.MeshPhongMaterial({color: 0x111111, shininess: 100}),
            
            acid: new THREE.MeshBasicMaterial({color: 0x39ff14}), 
            dizzyStar: new THREE.MeshBasicMaterial({color: 0xffeb3b}), 

            road: new THREE.MeshPhongMaterial({color: 0xc2a878, shininess: 3}),

            barnWall: new THREE.MeshPhongMaterial({color: 0x8b3a2f}),
            barnTrim: new THREE.MeshPhongMaterial({color: 0xf5f5f0}),
            barnRoof: new THREE.MeshPhongMaterial({color: 0x3a3a3a}),
            hay: new THREE.MeshPhongMaterial({color: 0xd4a017}),
            cowBody: new THREE.MeshPhongMaterial({color: 0xf5f5f0}),
            cowSpot: new THREE.MeshPhongMaterial({color: 0x2b2b2b}),
            factoryWall: new THREE.MeshPhongMaterial({color: 0x707878}),
            factoryRoof: new THREE.MeshPhongMaterial({color: 0x4a4a4a}),
            factoryTrim: new THREE.MeshPhongMaterial({color: 0xb5651d}),
            farmField: new THREE.MeshPhongMaterial({color: 0x6b7a2e}),
            water: new THREE.MeshPhongMaterial({color: 0x2f6fa8, transparent: true, opacity: 0.82, shininess: 70}),
            bridgeDeck: new THREE.MeshPhongMaterial({color: 0x8b6337, shininess: 8})
        };

        const roofColorPalette = [
            0xaa2222, 0x2c4c38, 0x29507a, 0xe67e22, 0x4a4a4a, 0x7d6608, 0x6c3483, 0x78281f
        ];

        const wallColorPalette = [
            0xeeeeee, 0xf5f5dc, 0xd5dbdb, 0xfadbd8, 0xfdebd0, 0xa9dfbf, 0xdfbca0
        ];

        // --- 追加: マテリアルプール（キャッシュ） ---
        const roofMaterialPool = {};
        const wallMaterialPool = {};
        function getRoofMaterial(color) {
            if (!roofMaterialPool[color]) {
                roofMaterialPool[color] = new THREE.MeshPhongMaterial({color: color, shininess: 20});
            }
            return roofMaterialPool[color];
        }
        function getWallMaterial(color) {
            if (!wallMaterialPool[color]) {
                wallMaterialPool[color] = new THREE.MeshPhongMaterial({color: color});
            }
            return wallMaterialPool[color];
        }

        // --- 追加: パーティクル用マテリアルプールと共通マテリアル ---
        materials.windArc = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
        materials.scar = new THREE.MeshBasicMaterial({ color: 0x332211, transparent: true, opacity: 0.5 });
        materials.bloodScar = new THREE.MeshBasicMaterial({ color: 0x7a0000, transparent: true, opacity: 0.75 });
        materials.ruinSmoke = new THREE.MeshBasicMaterial({ color: 0x3d3936, transparent: true, opacity: 0.5 });
        
        const ashMaterials = [0x5a4a3a, 0x3a2f26, 0x8a7355, 0x2a221a].map(c => new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.7}));

        const particleMaterialPool = {};
        function getParticleMaterial(color) {
            if (!particleMaterialPool[color]) {
                const mat = new THREE.MeshBasicMaterial({color: color});
                mat._isShared = true; // 共有フラグ
                particleMaterialPool[color] = mat;
            }
            return particleMaterialPool[color];
        }

        // 初期化時にすべての共通マテリアルに共有フラグを立てる
        Object.values(materials).forEach(m => { if(m) m._isShared = true; });
        ashMaterials.forEach(m => m._isShared = true);

        // --- 追加: 安全なメモリ解放関数 ---
        const cachedGeometries = Object.values(geometries);
        function safeDispose(obj) {
            if (!obj) return;
            if (obj.isMesh) {
                if (obj.geometry && !cachedGeometries.includes(obj.geometry)) {
                    obj.geometry.dispose();
                }
                if (obj.material) {
                    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                    mats.forEach(m => {
                        // 共有マテリアルとしてマークされていない場合のみ破棄（毎フレームの重い検索を排除）
                        if (!m._isShared) {
                            m.dispose();
                        }
                    });
                }
            }
        }

        // 既存の「60fps時の1frame確率」を、経過した基準frame数へ変換する。
        // 状態遷移・spawnのように1更新内で最大1回だけ起きる処理に使用する。
        function timeAdjustedProbability(frameProbability, frameScale) {
            if (frameProbability <= 0 || frameScale <= 0) return 0;
            if (frameProbability >= 1) return 1;
            return 1 - Math.pow(1 - frameProbability, frameScale);
        }

        function frameRateIndependentChance(frameProbability, frameScale) {
            return Math.random() < timeAdjustedProbability(frameProbability, frameScale);
        }

        // 継続Particleは単位時間当たりの生成期待数を維持する。
        // dtScaleの既存上限（最大4）に従うため、極端な停止後も一度に4回を超えない。
        function referenceFrameEventCount(frameProbability, frameScale, random = Math.random) {
            if (frameProbability <= 0 || frameScale <= 0) return 0;
            const probability = Math.min(1, frameProbability);
            const boundedScale = Math.min(4, frameScale);
            const wholeFrames = Math.floor(boundedScale);
            const fractionalFrame = boundedScale - wholeFrames;
            let eventCount = 0;
            for (let i = 0; i < wholeFrames; i++) {
                if (random() < probability) eventCount++;
            }
            if (fractionalFrame > 0 && random() < probability * fractionalFrame) eventCount++;
            return eventCount;
        }

        function makeParticleRoom(limit) {
            while (particles.length >= limit) {
                const old = particles.shift();
                scene.remove(old.mesh);
                safeDispose(old.mesh);
            }
        }

        // --- 追加: 画質プリセット（ノートPC等の低スペック機向け軽量化） ---
        // レンダラーの再生成（アンティエイリアス切替等）はPointerLockバグ再発のため行わず、
        // 実行中に安全に変更できるパラメータのみを調整する。
        const QUALITY_PRESETS = {
            high: {
                pixelRatioCap: 1.5,
                shadows: true,
                activeDistance: 7500,
                shadowDistance: 2800,
                particleCapNormal: 500,
                particleCapHeavy: 800,
                maxTanks: 4,
                fogFar: 12000,
                humanDensity: 1.0,   // 人間NPCの配置候補に対する出現率
                effectsScale: 1.0,   // 爆発・破壊パーティクルの生成数倍率
                scarCap: 50,         // 地面の傷跡・血痕の同時保持数
                debrisPieces: 10,    // 建物・戦車破壊時に飛び散らせる破片パーツ数
                rockShards: 8        // 岩・小石破壊時に飛び散らせるシャード数
            },
            medium: {
                pixelRatioCap: 1.2,
                shadows: true,
                activeDistance: 6000,
                shadowDistance: 2000,
                particleCapNormal: 320,
                particleCapHeavy: 500,
                maxTanks: 3,
                fogFar: 9000,
                humanDensity: 0.6,
                effectsScale: 0.65,
                scarCap: 30,
                debrisPieces: 5,     // 破片は出すが数を絞って軽量化
                rockShards: 4
            },
            low: {
                pixelRatioCap: 1.0,
                shadows: false,
                activeDistance: 4500,
                shadowDistance: 0, // 0＝影の計算対象なし（shadows:falseと合わせて完全無効化）
                particleCapNormal: 150,
                particleCapHeavy: 250,
                maxTanks: 2,
                fogFar: 6500,
                humanDensity: 0.35,
                effectsScale: 0.35,
                scarCap: 15,
                debrisPieces: 0,     // 破片が飛び散る演出をカットし、瓦礫のみ即残す（ノートPC向け軽量化）
                rockShards: 0        // 岩の破片も飛ばさず、割れ跡（傷デカール）のみ残す
            }
        };

        function applyQualityPreset(name) {
            const preset = QUALITY_PRESETS[name] || QUALITY_PRESETS.high;
            settings.quality = name;

            // 描画解像度（体感負荷への影響が最も大きい）
            if (renderer) renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatioCap));

            // シャドウ
            settings.shadows = preset.shadows;
            if (renderer) renderer.shadowMap.enabled = preset.shadows;

            // 描画・影の有効距離
            ACTIVE_DISTANCE_SQ = preset.activeDistance * preset.activeDistance;
            SHADOW_DISTANCE_SQ = preset.shadowDistance * preset.shadowDistance;

            // パーティクル同時数上限・生成数倍率
            PARTICLE_CAP_NORMAL = preset.particleCapNormal;
            PARTICLE_CAP_HEAVY = preset.particleCapHeavy;
            PARTICLE_COUNT_SCALE = preset.effectsScale;

            // 地面の傷跡・血痕の同時保持数上限
            SCAR_CAP = preset.scarCap;

            // 建物・戦車破壊時に飛び散らせる破片パーツ数上限
            DEBRIS_PIECE_CAP = preset.debrisPieces;

            // 岩・小石破壊時に飛び散らせるシャード数上限
            ROCK_SHARD_CAP = preset.rockShards;
            while (scars.length > SCAR_CAP) {
                const old = scars.shift();
                scene.remove(old);
                safeDispose(old);
            }

            // 同時出現する戦車の上限数
            MAX_TANKS = preset.maxTanks;

            // 遠景フォグ距離（近いほど遠くの描画物を早めに霧で隠せて負荷軽減）
            if (scene && scene.fog) scene.fog.far = preset.fogFar;

            // 人間NPCの数を、マップ再生成なしにその場で目標密度へ増減させる
            applyHumanDensity(name);

            // 設定UIのセレクトをプリセット名に同期
            const qSelect = document.getElementById('set-quality');
            if (qSelect) qSelect.value = name;
        }

        // --- 人間NPCの密度を画質プリセットに合わせてその場で増減させる ---
        // humanSpawnPool: initMap() で記録した「人間が置かれ得る全候補地点」
        // humanPoolActivatedCount: これまでに実体化(spawnEntity)させたプールの件数
        function applyHumanDensity(qualityName) {
            if (humanSpawnPool.length === 0) return; // マップ未生成時は何もしない

            const preset = QUALITY_PRESETS[qualityName] || QUALITY_PRESETS.high;
            const targetCount = Math.round(humanSpawnPool.length * preset.humanDensity);
            const aliveHumans = entities.filter(en => en.type === 'human' && !en.isDead);

            if (aliveHumans.length < targetCount) {
                // 不足分を、まだ実体化していないプール地点から補充する
                let need = targetCount - aliveHumans.length;
                while (need > 0 && humanPoolActivatedCount < humanSpawnPool.length) {
                    const spot = humanSpawnPool[humanPoolActivatedCount];
                    spawnEntity('human', spot.x, spot.z);
                    humanPoolActivatedCount++;
                    need--;
                }
            } else if (aliveHumans.length > targetCount) {
                // 超過分を、生存中の人間からランダムに間引く
                let excess = aliveHumans.length - targetCount;
                for (let i = aliveHumans.length - 1; i >= 0 && excess > 0; i--) {
                    const en = aliveHumans[i];
                    scene.remove(en.mesh);
                    en.mesh.traverse(child => safeDispose(child));
                    const idx = entities.indexOf(en);
                    if (idx !== -1) entities.splice(idx, 1);
                    excess--;
                }
            }
        }

        let audioCtx = null;
        let masterGain = null;
        function ensureAudio() { 
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)(); 
                masterGain = audioCtx.createGain();
                masterGain.gain.value = settings.volume;
                masterGain.connect(audioCtx.destination);
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
        }
        function beep(freq, duration, type, vol, sweepTo) {
            if (!audioCtx || audioCtx.state === 'suspended') return;
            try {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = type || 'sine';
                osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
                if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, audioCtx.currentTime + duration);
                gain.gain.setValueAtTime(vol || 0.3, audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
                osc.connect(gain); gain.connect(masterGain);
                osc.onended = () => { osc.disconnect(); gain.disconnect(); };
                osc.start(); osc.stop(audioCtx.currentTime + duration);
            } catch(e) {}
        }

        const playAttackSound = () => beep(180, 0.1, 'square', 0.15, 50);
        const playSplatSound  = () => beep(40, 0.15, 'sawtooth', 0.4, 10);
        const playHitSound    = (big) => beep(big ? 30 : 60, big ? 0.4 : 0.2, 'sawtooth', big ? 0.3 : 0.1, 20);
        const playBoomSound   = () => { beep(20, 1.2, 'sawtooth', 0.5, 5); beep(40, 0.6, 'sine', 0.4, 10); };
        const playRoarSound   = () => { if (!audioCtx) return; beep(70, 0.8, 'sawtooth', 0.5, 25); beep(110, 0.5, 'square', 0.3, 40); };
        const playRumbleSound = () => { beep(35, 0.3, 'sawtooth', 0.15, 10); };

        function playSwishSound() {
            if (!audioCtx || audioCtx.state === 'suspended') return;
            try {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(600, audioCtx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(40, audioCtx.currentTime + 0.15);
                gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
                osc.connect(gain); gain.connect(masterGain);
                osc.onended = () => { osc.disconnect(); gain.disconnect(); };
                osc.start(); osc.stop(audioCtx.currentTime + 0.15);
            } catch(e){}
        }

        function playTankFireSound() {
            if (!audioCtx || audioCtx.state === 'suspended') return;
            try {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(120, audioCtx.currentTime);
                osc.frequency.linearRampToValueAtTime(10, audioCtx.currentTime + 0.45);
                gain.gain.setValueAtTime(0.35, audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45); 
                osc.connect(gain); gain.connect(masterGain);
                osc.onended = () => { osc.disconnect(); gain.disconnect(); };
                osc.start(); osc.stop(audioCtx.currentTime + 0.45);

                const osc2 = audioCtx.createOscillator();
                const gain2 = audioCtx.createGain();
                osc2.type = 'triangle';
                osc2.frequency.setValueAtTime(50, audioCtx.currentTime);
                osc2.frequency.exponentialRampToValueAtTime(5, audioCtx.currentTime + 0.25);
                gain2.gain.setValueAtTime(0.4, audioCtx.currentTime);
                gain2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25); 
                osc2.connect(gain2); gain2.connect(masterGain);
                osc2.onended = () => { osc2.disconnect(); gain2.disconnect(); };
                osc2.start(); osc2.stop(audioCtx.currentTime + 0.25);
            } catch(e){}
        }

        function playAtomicExplosionSound() {
            if (!audioCtx || audioCtx.state === 'suspended') return;
            try {
                const oscLow = audioCtx.createOscillator();
                const gainLow = audioCtx.createGain();
                oscLow.type = 'sawtooth';
                oscLow.frequency.setValueAtTime(28, audioCtx.currentTime);
                oscLow.frequency.exponentialRampToValueAtTime(3, audioCtx.currentTime + 2.5);
                gainLow.gain.setValueAtTime(0.65, audioCtx.currentTime);
                gainLow.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 2.5);
                oscLow.connect(gainLow); gainLow.connect(masterGain);
                oscLow.onended = () => { oscLow.disconnect(); gainLow.disconnect(); };
                oscLow.start(); oscLow.stop(audioCtx.currentTime + 2.5);

                const gainHigh = THREE.AudioContext ? THREE.AudioContext.getContext() : audioCtx; 
                const oscHighNode = audioCtx.createOscillator();
                const gainHighNode = audioCtx.createGain();
                oscHighNode.type = 'square';
                oscHighNode.frequency.setValueAtTime(95, audioCtx.currentTime);
                oscHighNode.frequency.linearRampToValueAtTime(8, audioCtx.currentTime + 1.2);
                gainHighNode.gain.setValueAtTime(0.4, audioCtx.currentTime);
                gainHighNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.2);
                oscHighNode.connect(gainHighNode); gainHighNode.connect(masterGain);
                oscHighNode.onended = () => { oscHighNode.disconnect(); gainHighNode.disconnect(); };
                oscHighNode.start(); oscHighNode.stop(audioCtx.currentTime + 1.2);
            } catch(e){}
        }

        function playAcidSplashSound() {
            if (!audioCtx || audioCtx.state === 'suspended') return;
            try {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'square';
                osc.frequency.setValueAtTime(800, audioCtx.currentTime);
                osc.frequency.linearRampToValueAtTime(150, audioCtx.currentTime + 0.25);
                gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
                osc.connect(gain); gain.connect(masterGain);
                osc.onended = () => { osc.disconnect(); gain.disconnect(); };
                osc.start(); osc.stop(audioCtx.currentTime + 0.25);
            } catch(e){}
        }

        // --- 追加: 岩・小石のインスタンス描画管理 ---
        let rockInstancedMesh = null;
        let pebbleInstancedMesh = null;
        let nextRockInstanceIndex = 0;
        let nextPebbleInstanceIndex = 0;

        // --- 追加: 木のインスタンス描画管理（幹・葉(円錐)・葉(球1)・葉(球2)の4種） ---
        let treeTrunkInstancedMesh = null;
        let treeConeInstancedMesh = null;
        let treeSphere1InstancedMesh = null;
        let treeSphere2InstancedMesh = null;
        let nextTreeTrunkInstanceIndex = 0;
        let nextTreeConeInstanceIndex = 0;
        let nextTreeSphere1InstanceIndex = 0;
        let nextTreeSphere2InstanceIndex = 0;

        // --- 追加: 草のインスタンス描画管理（当たり判定なしの純粋な装飾） ---
        let grassInstancedMesh = null;
        let nextGrassInstanceIndex = 0;
        // --- 追加: 茂み・花のインスタンス描画管理（当たり判定なしの純粋な装飾、殺風景さ対策の彩り追加） ---
        let bushInstancedMesh = null;
        let nextBushInstanceIndex = 0;
        let flowerInstancedMesh = null;
        let nextFlowerInstanceIndex = 0;
        const clouds = []; // 追加: 雲オブジェクト配列

        const player = {
            hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, mesh: new THREE.Group(), radius: PLAYER_RADIUS, yVel: 0, isGrounded: true,
            isCharging: false, chargeTime: 0, isLeftDown: false, isRightDown: false, legs: [],
            pushVel: new THREE.Vector3(), // ノックバック用（着地の衝撃・尻尾攻撃などで加算し、徐々に減衰する）
            knockbackGraceTimer: 0, // この値が0より大きい間、ボス本体との「めり込み解消」を一時的に止める（意図的なノックバック演出を邪魔しないため）
            defaultColor: new THREE.Color(0xff4500),
            debuffTimer: 0,
            isDying: false,   // 追加：死亡演出中フラグ
            deathTimer: 0,    // 追加：死亡カウントダウンタイマー
            moveDir: new THREE.Vector3(), // ミミズの着地予測AI用：プレイヤーの現在の移動方向を保持
            lastBombTime: -99999, // クールタイム管理用
            chargeBlock: false, // 同時タップによるダブルパンチ時のチャージ阻止フラグ
            
            // 攻撃時のモーションイージング補間用ステート
            attackLTimer: 0,
            attackRTimer: 0,
            attackType: '', // 'single' または 'double'

            // 入力暴発防止用バッファ
            pendingAttack: null,
            attackDelayTimer: null,
            doubleAttackPending: false,

            chargeZoom: 0, // カメラズーム補間用のステート
            material: null, // 動的な色変え用の個別マテリアル参照
            doubleDownTime: 0 // 同時押しが開始された時刻を保持するタイマー（チャージ画面暴発防止用）
        };

        function resetAtomicChargeForScaleSandbox() {
            player.isCharging = false;
            player.chargeTime = 0;
            player.chargeZoom = 0;
            player.chargeBlock = false;
            const chargeUi = document.getElementById('charge-ui');
            if (chargeUi) {
                chargeUi.style.display = 'none';
                chargeUi.classList.remove('ready');
            }
        }

        function applyScaleStage(stageId, { resetCamera = true } = {}) {
            const nextStage = getScaleStage(stageId);
            activeScaleStageId = stageId;
            activeScaleStage = nextStage;

            // 同一Player instanceのrootだけを拡縮し、HP・位置・Score・World stateには触れない。
            player.mesh.scale.setScalar(nextStage.visualScale);
            player.radius = nextStage.collisionRadius;

            if (camera) {
                camera.near = nextStage.cameraNear;
                camera.updateProjectionMatrix();
            }
            if (resetCamera) {
                camDist = nextStage.cameraDistance;
                pitch = nextStage.cameraPitch;
            } else {
                camDist = Math.max(nextStage.cameraMinDistance, Math.min(nextStage.cameraMaxDistance, camDist));
                pitch = Math.max(nextStage.cameraMinPitch, Math.min(nextStage.cameraMaxPitch, pitch));
            }

            resetAtomicChargeForScaleSandbox();
        }

        function applyHumanVisualScale(scale) {
            if (!Object.values(HUMAN_VISUAL_SCALES).includes(scale)) return;
            humanVisualScale = scale;
            for (const en of entities) {
                if (en.type === 'human') en.mesh.scale.setScalar(humanVisualScale);
            }
        }

        function init() {
            if (!rendererController) {
                rendererController = createRendererController({
                    THREE,
                    antialias: settings.antialias,
                    container: document.body,
                    viewport: window,
                });
            }
            const renderState = rendererController.createScene({ isMenu });
            scene = renderState.scene;
            camera = renderState.camera;
            renderer = renderState.renderer;

            // --- 地面に色のムラ（まだら模様）を作る ---
            // ジオメトリを細かく分割（150x150）して頂点カラーを適用できるようにする
            const floorGeo = new THREE.PlaneGeometry(100000, 100000, 150, 150);
            const colors = [];
            const colorBase = new THREE.Color(0x7d8f4f);  // 基本の草地色（緑豊かに変更）
            const colorDark = new THREE.Color(0x5c6b38);  // 暗い草地の陰
            const colorGreen = new THREE.Color(0x8fae4f); // 鮮やかな緑（生い茂った草地）
            const colorDirt = new THREE.Color(0x9a8264);  // 踏み固められた土色（アクセントとして一部に残す）
            const tempColor = new THREE.Color();

            const posAttr = floorGeo.attributes.position;
            for (let i = 0; i < posAttr.count; i++) {
                const vx = posAttr.getX(i);
                const vy = posAttr.getY(i); // PlaneGeometryはXY平面に作られるためYが奥行き(Z)相当
                
                // サイン波を組み合わせて滑らかな雲状のノイズ（模様）を作る
                const noise1 = Math.sin(vx * 0.0004) * Math.cos(vy * 0.0004);
                const noise2 = Math.sin(vx * 0.0015 + vy * 0.001);
                const noise = (noise1 + noise2 * 0.5) / 1.5; // -1.0 〜 1.0の範囲に収める

                // ノイズの値に応じて色をブレンドする（大部分は緑豊かな草地、強い負のノイズのみ土色のパッチに）
                if (noise > 0.1) {
                    tempColor.copy(colorBase).lerp(colorGreen, Math.min(1, (noise - 0.1) * 1.3));
                } else if (noise < -0.35) {
                    tempColor.copy(colorBase).lerp(colorDirt, Math.min(1, (-noise - 0.35) * 1.8));
                } else if (noise < -0.1) {
                    tempColor.copy(colorBase).lerp(colorDark, Math.min(1, (-noise - 0.1) * 1.5));
                } else {
                    tempColor.copy(colorBase);
                }
                
                // さらに微細なランダムノイズを足して、土のザラザラ感を出す
                const microNoise = (Math.random() - 0.5) * 0.04;
                tempColor.offsetHSL(0, 0, microNoise);

                colors.push(tempColor.r, tempColor.g, tempColor.b);
            }
            floorGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

            const floorMat = new THREE.MeshPhongMaterial({ 
                color: 0xffffff, // 頂点カラーをそのまま表示するため白を指定
                vertexColors: true, 
                shininess: 0 
            });
            const floor = new THREE.Mesh(floorGeo, floorMat);
            floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
            floor.matrixAutoUpdate = false; floor.updateMatrix();
            scene.add(floor);

            clock = new THREE.Clock();
            initPlayer();
            initMap();
            
            if (isMenu) {
                // カニの足元をその座標の地面の高さにスナップ（めり込み・浮遊の防止）
                const lobbyTerrainY = getTerrainHeight(0, 5200);
                player.mesh.position.set(0, lobbyTerrainY, 5200);
                
                // 【修正】カニの角度をカメラ（手前右側）に正対する向きに調整
                player.mesh.rotation.y = Math.atan2(220, 380); 
                
                // カメラをカニのすぐ近く（斜め手前・見上げるアングル）に配置
                camera.position.set(220, lobbyTerrainY + 80, 5580);
                camera.lookAt(-40, lobbyTerrainY + 50, 5200);

                // 【修正】戦車を少しカニに近づけ、対峙する構図にします
                spawnEntity('tank', -800, 4700, Math.PI * 0.45);
            }
            
            // animationIdを確実にキャンセルしたうえで、一本のスレッドスケジュールを保証する
            if (animationId) cancelAnimationFrame(animationId);
            animationId = requestAnimationFrame(animate);
        }

        function initPlayer() {
            player.mesh = new THREE.Group();
            player.legs = [];
            // 個別の体色変更用にマテリアルを確保
            player.material = new THREE.MeshPhongMaterial({ color: player.defaultColor.clone() });
            const mat = player.material;
            
            const shell = new THREE.Mesh(geometries.box, mat);
            shell.scale.set(100, 45, 85); shell.position.y = 30; shell.castShadow = true; player.mesh.add(shell);
            
            const eyeStalkL = new THREE.Mesh(geometries.box, mat);
            eyeStalkL.scale.set(8, 22, 8); eyeStalkL.position.set(20, 50, 35); player.mesh.add(eyeStalkL);
            const eyeBallL = new THREE.Mesh(geometries.sphere, materials.whiteEye);
            eyeBallL.scale.setScalar(12); eyeBallL.position.set(20, 61, 35); player.mesh.add(eyeBallL);
            const pupilL = new THREE.Mesh(geometries.box, materials.blackEye);
            pupilL.scale.set(6, 6, 4); pupilL.position.set(20, 61, 46); player.mesh.add(pupilL);

            const eyeStalkR = new THREE.Mesh(geometries.box, mat);
            eyeStalkR.scale.set(8, 22, 8); eyeStalkR.position.set(-20, 50, 35); player.mesh.add(eyeStalkR);
            const eyeBallR = new THREE.Mesh(geometries.sphere, materials.whiteEye);
            eyeBallR.scale.setScalar(12); eyeBallR.position.set(-20, 61, 35); player.mesh.add(eyeBallR);
            const pupilR = new THREE.Mesh(geometries.box, materials.blackEye);
            pupilR.scale.set(6, 6, 4); pupilR.position.set(-20, 61, 46); player.mesh.add(pupilR);

            const createClaw = (side) => {
                const cg = new THREE.Group();
                const pincer = new THREE.Mesh(geometries.box, mat);
                pincer.scale.set(55, 35, 55); pincer.position.z = 50; pincer.castShadow = true; cg.add(pincer);
                
                const cutterOuter = new THREE.Mesh(geometries.box, mat);
                cutterOuter.scale.set(15, 20, 35); cutterOuter.position.set(side * 18, 0, 85); cg.add(cutterOuter);
                const cutterInner = new THREE.Mesh(geometries.box, mat);
                cutterInner.scale.set(12, 16, 25); cutterInner.position.set(-side * 12, 0, 75); cg.add(cutterInner);

                cg.position.set(side * 85, 30, 5); return cg;
            };
            player.clawL = createClaw(1); player.clawR = createClaw(-1);
            player.mesh.add(player.clawL, player.clawR);
            
            for (let i = 0; i < 8; i++) {
                const leg = new THREE.Mesh(geometries.box, mat);
                leg.scale.set(15, 45, 15); leg.position.set((i < 4 ? 1 : -1) * 85, 0, (i % 4 - 1.5) * 30);
                player.mesh.add(leg); player.legs.push(leg);
            }
            scene.add(player.mesh);
            applyScaleStage(activeScaleStageId, { resetCamera: false });
        }

        function spawnRuins(pos, sizeScale = 1.0) {
            // 残骸の上限管理（30個を超えたら古いものを削除）
            let ruinsCount = 0;
            let oldestRuinIndex = -1;
            for (let i = 0; i < entities.length; i++) {
                if (entities[i].type === 'ruins') {
                    ruinsCount++;
                    if (oldestRuinIndex === -1) oldestRuinIndex = i;
                }
            }
            if (ruinsCount >= 30 && oldestRuinIndex !== -1) {
                const oldRuin = entities[oldestRuinIndex];
                scene.remove(oldRuin.mesh);
                oldRuin.mesh.traverse(child => safeDispose(child));
                entities.splice(oldestRuinIndex, 1);
            }

            const ruinsGroup = new THREE.Group();
            
            const blockCount = 1 + Math.floor(Math.random() * 3);
            for (let i = 0; i < blockCount; i++) {
                const ruinBlock = new THREE.Mesh(geometries.box, materials.ruinsCharred);
                const w = (60 + Math.random() * 80) * sizeScale;
                const h = (15 + Math.random() * 40) * sizeScale;
                const d = (40 + Math.random() * 70) * sizeScale;
                
                ruinBlock.scale.set(w, h, d);
                ruinBlock.position.set(
                    (Math.random() - 0.5) * 80 * sizeScale,
                    h / 2.5,
                    (Math.random() - 0.5) * 80 * sizeScale
                );
                ruinBlock.rotation.set(
                    (Math.random() - 0.5) * 0.8,
                    Math.random() * Math.PI,
                    (Math.random() - 0.5) * 0.8
                );
                ruinBlock.castShadow = true;
                ruinBlock.receiveShadow = true;
                ruinsGroup.add(ruinBlock);
            }
            
            ruinsGroup.position.copy(pos);
            scene.add(ruinsGroup);
            
            const data = {
                type: 'ruins', hp: 0, isDead: true, mesh: ruinsGroup, radius: 100 * sizeScale,
                velocity: new THREE.Vector3(), rotVel: new THREE.Vector3(), pushVel: new THREE.Vector3(),
                life: 15.0 // 残骸が消え始めるまでの寿命（秒）
            };
            entities.push(data);
        }

        function spawnEntity(type, x, z, forceAngle = null, biome = null) {
            if (type === 'boss') {
                const segments = [];
                const segmentCount = BOSS_SEGMENT_COUNT;
                const pPos = player.mesh.position;
                let dirAway = new THREE.Vector3(x - pPos.x, 0, z - pPos.z).normalize();
                if (dirAway.lengthSq() < 0.1) dirAway.set(0, 0, 1);

                for (let i = 0; i < segmentCount; i++) {
                    const segGroup = new THREE.Group(); 
                    const s = 140 - (i * 7.5); 

                    const segMat = new THREE.MeshPhongMaterial({
                        color: new THREE.Color().setHSL(0.96, 0.45, 0.2 + (i / segmentCount) * 0.2),
                        shininess: 40
                    });
                    const sphereMesh = new THREE.Mesh(geometries.sphere, segMat);
                    sphereMesh.scale.set(s, s * 0.9, s);
                    sphereMesh.castShadow = true;
                    segGroup.add(sphereMesh);

                    segGroup.userData = { radius: s };

                    if (i === 0) {
                        const teethMat = new THREE.MeshPhongMaterial({color: 0xeeeedd, shininess: 80});
                        for (let t = 0; t < 10; t++) {
                            const tooth = new THREE.Mesh(geometries.cone, teethMat);
                            const tScale = s * 0.12;
                            tooth.scale.set(tScale, tScale * 2.8, tScale);
                            const angle = (t / 10) * Math.PI * 2;
                            tooth.position.set(Math.cos(angle) * (s * 0.35), Math.sin(angle) * (s * 0.35), s * 0.42);
                            tooth.rotation.x = Math.PI / 2;
                            tooth.rotation.z = -angle;
                            segGroup.add(tooth);
                        }
                        const eyeMat = new THREE.MeshBasicMaterial({color: 0x00ffcc});
                        for (let e = 0; e < 4; e++) {
                            const eye = new THREE.Mesh(geometries.sphere, eyeMat);
                            const eyeScale = s * 0.08;
                            eye.scale.setScalar(eyeScale);
                            const angle = (e / 4) * Math.PI * 2 + 0.3;
                            eye.position.set(Math.cos(angle) * (s * 0.42), Math.sin(angle) * (s * 0.42), s * 0.2);
                            segGroup.add(eye);
                        }
                    }
                    const startPos = new THREE.Vector3(x, 80, z).addScaledVector(dirAway, i * 110);
                    segGroup.position.copy(startPos);
                    scene.add(segGroup); 
                    segments.push(segGroup);
                }

                bossActive = true;
                document.getElementById('boss-title').innerText = "ギガ・ミミズ";
                document.getElementById('boss-ui').style.display = 'block';
                document.getElementById('boss-hp-fill').style.width = '100%';
                document.getElementById('boss-hp-damage').style.width = '100%';
                bossHPDelay = 100;
                
                // 緊急ニューステロップの表示
                document.getElementById('news-ticker').style.display = 'block';
                
                const warn = document.getElementById('warning-overlay');
                warn.style.display = 'block';
                setTimeout(() => { warn.style.display = 'none'; }, 2500);

                const bossData = {
                    type, hp: BOSS_HP, maxHp: BOSS_HP, mesh: segments[0], segments,
                    velocity: new THREE.Vector3(), rotVel: new THREE.Vector3(), pushVel: new THREE.Vector3(),
                    radius: BOSS_RADIUS, scoreVal: BOSS_SCORE_VALUE, isDead: false,
                    aiState: 'slither',
                    lastPick: null, // 直前にslitherから選んだ技（連続回避用）
                    tailAttackCooldown: 0, // 尻尾攻撃の連続ヒット防止用
                    aiTimer: 6.0,
                    jumpYVel: 0,
                    targetPos: new THREE.Vector3(),
                    breakStage: 0, 
                    rageMode: false,
                    hyperRage: false, // 追加: HP25%以下での発狂モード
                    hasSpitThisTick: false,
                    hasShownShadow: false // 追加: 影表示フラグ
                };
                entities.push(bossData);
                playRoarSound();
                return bossData;
            }

            const group = new THREE.Group();
            let hp = 100, radius = 50, scoreVal = 200; 
            let baseCastShadow = false;
            let debrisMaterial = null; // 追加: 破壊時の破片色を種類ごとに保持（未設定ならデフォルト色を使用）
            
            let customChassis = null;
            let customTurret = null;
            let customGunGroup = null;

            // 人間用の行動パラメータ初期化
            let humanState = 'idle';
            let humanTimer = Math.random() * 3.0;
            let wiggleTime = Math.random() * 100;
            let tripTimer = 0;
            let targetBuilding = null; // 追加: 避難先建物
            let idleWaitTimer = 0; // 追加: 立ち止まり時間

            if (type === 'house') {
                const roofColor = roofColorPalette[Math.floor(Math.random() * roofColorPalette.length)];
                const wallColor = wallColorPalette[Math.floor(Math.random() * wallColorPalette.length)];
                const customRoofMat = getRoofMaterial(roofColor);
                const customWallMat = getWallMaterial(wallColor);

                const houseType = Math.random();
                if (houseType < 0.27) {
                    const b = new THREE.Mesh(geometries.box, customWallMat); b.scale.set(160, 100, 160); b.position.y = 50; group.add(b);
                    const r = new THREE.Mesh(geometries.pyramid, customRoofMat); r.scale.set(180, 60, 180); r.position.y = 130; group.add(r);
                    hp = 300; radius = 75; 
                } else if (houseType < 0.42) {
                    const b = new THREE.Mesh(geometries.box, customWallMat); b.scale.set(240, 90, 130); b.position.y = 45; group.add(b);
                    const r = new THREE.Mesh(geometries.box, customRoofMat); r.scale.set(260, 15, 150); r.position.set(0, 97.5, 0); group.add(r);
                    const door = new THREE.Mesh(geometries.box, materials.charred); door.scale.set(30, 50, 4); door.position.set(-60, 25, 66); group.add(door);
                    const door2 = new THREE.Mesh(geometries.box, materials.charred); door2.scale.set(30, 50, 4); door2.position.set(60, 25, 66); group.add(door2);
                    hp = 400; radius = 90; 
                } else if (houseType < 0.57) {
                    const b = new THREE.Mesh(geometries.box, customWallMat); b.scale.set(130, 190, 130); b.position.y = 95; group.add(b);
                    const roofDeco = new THREE.Mesh(geometries.box, customRoofMat); roofDeco.scale.set(140, 15, 140); roofDeco.position.set(0, 197.5, 0); group.add(roofDeco);
                    for (let floorY = 0; floorY < 3; floorY++) {
                        const win = new THREE.Mesh(geometries.box, materials.windowGlass);
                        win.scale.set(50, 35, 4); win.position.set(0, 35 + floorY * 55, 66); group.add(win);
                    }
                    hp = 600; radius = 70; scoreVal = 400;
                } else if (houseType < 0.68) {
                    const cylGeom = new THREE.CylinderGeometry(80, 80, 100, 8); 
                    const b = new THREE.Mesh(cylGeom, customWallMat); b.position.y = 50; group.add(b);
                    const r = new THREE.Mesh(geometries.sphere, customRoofMat); r.scale.set(85, 85, 85); r.position.y = 100; group.add(r);
                    hp = 350; radius = 75; 
                } else if (houseType < 0.76) {
                    const b = new THREE.Mesh(geometries.box, customWallMat); b.scale.set(110, 60, 110); b.position.y = 30; group.add(b);
                    const r = new THREE.Mesh(geometries.pyramid, customRoofMat); r.scale.set(130, 45, 130); r.position.y = 82.5; group.add(r);
                    hp = 200; radius = 55; 
                } else if (houseType < 0.82) {
                    const b = new THREE.Mesh(geometries.box, customWallMat); b.scale.set(150, 80, 120); b.position.y = 40; group.add(b);
                    const r = new THREE.Mesh(geometries.box, customRoofMat); r.scale.set(170, 20, 140); r.position.set(0, 90, 0); group.add(r);
                    const porchRoof = new THREE.Mesh(geometries.box, customRoofMat); porchRoof.scale.set(90, 10, 40); porchRoof.position.set(0, 60, 78); porchRoof.rotation.x = -0.15; group.add(porchRoof);
                    const pillarL = new THREE.Mesh(geometries.box, materials.charred); pillarL.scale.set(8, 55, 8); pillarL.position.set(-35, 27, 92); group.add(pillarL);
                    const pillarR = new THREE.Mesh(geometries.box, materials.charred); pillarR.scale.set(8, 55, 8); pillarR.position.set(35, 27, 92); group.add(pillarR);
                    hp = 320; radius = 80; 
                } else if (houseType < 0.88) {
                    const b = new THREE.Mesh(geometries.box, customWallMat); b.scale.set(90, 210, 100); b.position.y = 105; group.add(b);
                    const r = new THREE.Mesh(geometries.box, customRoofMat); r.scale.set(100, 20, 110); r.position.set(0, 220, 0); group.add(r);
                    for (let floorY = 0; floorY < 3; floorY++) {
                        const win = new THREE.Mesh(geometries.box, materials.windowGlass);
                        win.scale.set(30, 28, 4); win.position.set(0, 40 + floorY * 55, 51); group.add(win);
                    }
                    hp = 500; radius = 65; scoreVal = 350;
                } else if (houseType < 0.94) {
                    const b = new THREE.Mesh(geometries.box, customWallMat); b.scale.set(170, 90, 130); b.position.y = 45; group.add(b);
                    const roofFlat = new THREE.Mesh(geometries.box, customRoofMat); roofFlat.scale.set(180, 12, 140); roofFlat.position.set(0, 96, 0); group.add(roofFlat);
                    const awningMat = new THREE.MeshPhongMaterial({color: Math.random() < 0.5 ? 0xd35400 : 0x1565c0});
                    const awning = new THREE.Mesh(geometries.box, awningMat); awning.scale.set(160, 10, 45); awning.position.set(0, 60, 82); awning.rotation.x = -0.25; group.add(awning);
                    const sign = new THREE.Mesh(geometries.box, materials.gold); sign.scale.set(80, 18, 6); sign.position.set(0, 78, 68); group.add(sign);
                    hp = 380; radius = 85; scoreVal = 300;
                } else {
                    const b = new THREE.Mesh(geometries.box, customWallMat); b.scale.set(120, 85, 120); b.position.y = 42.5; group.add(b);
                    const r = new THREE.Mesh(geometries.pyramid, customRoofMat); r.scale.set(140, 55, 140); r.position.y = 112.5; group.add(r);
                    const shed = new THREE.Mesh(geometries.box, materials.charred); shed.scale.set(55, 45, 60); shed.position.set(85, 22.5, 0); group.add(shed);
                    const shedRoof = new THREE.Mesh(geometries.box, customRoofMat); shedRoof.scale.set(65, 8, 70); shedRoof.position.set(85, 49, 0); shedRoof.rotation.z = 0.2; group.add(shedRoof);
                    hp = 340; radius = 90; 
                }
                baseCastShadow = true;
            } else if (type === 'tower') {
                const b = new THREE.Mesh(geometries.box, materials.towerBase); b.scale.set(80, 240, 80); b.position.y = 120; group.add(b);
                const balcony = new THREE.Mesh(geometries.box, materials.towerBase); balcony.scale.set(100, 15, 100); balcony.position.y = 240; group.add(balcony);
                const roof = new THREE.Mesh(geometries.pyramid, materials.churchRoof); roof.scale.set(110, 70, 110); roof.position.y = 282.5; group.add(roof);
                
                for (let h = 0; h < 3; h++) {
                    const slit = new THREE.Mesh(geometries.box, materials.charred);
                    slit.scale.set(12, 35, 82); slit.position.set(0, 80 + h * 50, 0); group.add(slit);
                }
                hp = 1200; radius = 65; scoreVal = 800; baseCastShadow = true; 
            } else if (type === 'church') {
                const nave = new THREE.Mesh(geometries.box, materials.churchBase); nave.scale.set(150, 110, 240); nave.position.y = 55; group.add(nave);
                
                // 1. まず元の四角い箱（BoxGeometry）で屋根を作ります
                const naveRoofGeometry = new THREE.BoxGeometry(1, 1, 1); 

                // 2. 箱の「上側の頂点」のX座標だけを中心に集めて、切妻屋根（三角屋根）の稜線を作ります
                const positionAttribute = naveRoofGeometry.attributes.position;
                for (let i = 0; i < positionAttribute.count; i++) {
                    // Y座標が 0.5（上の面）の頂点を探し、Xだけを0（中心）に移動します（Zは保持して稜線にする）
                    if (positionAttribute.getY(i) > 0) {
                        positionAttribute.setX(i, 0);
                    }
                }
                // 変形を確定させるための処理
                naveRoofGeometry.computeVertexNormals();

                const naveRoof = new THREE.Mesh(naveRoofGeometry, materials.churchRoof);

                // 3. 回転は一切不要なので削除、または 0 にします
                naveRoof.rotation.y = 0;
                naveRoof.rotation.z = 0;

                // 4. サイズは元の長方形（115 × 250）にぴったり合わせます
                // （※もし高さ 115 が高すぎる場合は、真ん中の数値を 60 などに減らしてください）
                naveRoof.scale.set(165, 100, 260); // 幅を本体150より広く→軒の出っ張り、高さは少し抑えめに

                // 5. 位置の調整（身廊の上に載せます）
                // もし屋根が浮いたり沈んだりしたら、真ん中の 110 の数値を上下させてください
                naveRoof.position.set(0, 167.5, 0);

                naveRoof.castShadow = true;
                group.add(naveRoof);


                
                const tower = new THREE.Mesh(geometries.box, materials.churchBase); tower.scale.set(70, 250, 70); tower.position.set(0, 125, 155); group.add(tower);
                const towerRoof = new THREE.Mesh(geometries.pyramid, materials.churchRoof); 
                towerRoof.scale.set(80, 60, 80); 
                towerRoof.position.set(0, 280, 155); 
                group.add(towerRoof);
                
                const crossV = new THREE.Mesh(geometries.box, materials.gold); crossV.scale.set(8, 50, 8); crossV.position.set(0, 335, 155); group.add(crossV);
                const crossH = new THREE.Mesh(geometries.box, materials.gold); crossH.scale.set(30, 8, 8); crossH.position.set(0, 340, 155); group.add(crossH);

                for (let s = -2; s <= 0; s++) {
                    const winL = new THREE.Mesh(geometries.box, Math.random() < 0.5 ? materials.stainedGlassBlue : materials.stainedGlassYellow);
                    winL.scale.set(4, 45, 18); winL.position.set(76, 55, s * 45 - 20); group.add(winL);
                    const winR = new THREE.Mesh(geometries.box, Math.random() < 0.5 ? materials.stainedGlassBlue : materials.stainedGlassYellow);
                    winR.scale.set(4, 45, 18); winR.position.set(-76, 55, s * 45 - 20); group.add(winR);
                }
                hp = 2200; radius = 115; scoreVal = 1500; baseCastShadow = true;
            } else if (type === 'school') {
                const mainBuilding = new THREE.Mesh(geometries.box, materials.schoolBase); mainBuilding.scale.set(360, 120, 140); mainBuilding.position.y = 60; group.add(mainBuilding);
                const mainRoof = new THREE.Mesh(geometries.box, materials.churchRoof); mainRoof.scale.set(380, 15, 160); mainRoof.position.y = 127.5; group.add(mainRoof);

                const clockTower = new THREE.Mesh(geometries.box, materials.schoolBase); clockTower.scale.set(60, 100, 60); clockTower.position.set(0, 170, 0); clockTower.castShadow = true; group.add(clockTower);
                const towerRoof = new THREE.Mesh(geometries.pyramid, materials.churchRoof); 
                towerRoof.scale.set(70, 40, 70); 
                towerRoof.position.set(0, 240, 0); 
                group.add(towerRoof);
                
                const clockFace = new THREE.Mesh(geometries.box, materials.gold); clockFace.scale.set(25, 25, 4); clockFace.position.set(0, 180, 31); group.add(clockFace);
                const porch = new THREE.Mesh(geometries.box, materials.schoolBase); porch.scale.set(100, 50, 30); porch.position.set(0, 25, 80); group.add(porch);

                for (let floorY = 0; floorY < 2; floorY++) {
                    for (let wX = -4; wX <= 4; wX++) {
                        if (Math.abs(wX) === 0 || Math.abs(wX) === 1) continue; 
                        const win = new THREE.Mesh(geometries.box, materials.windowGlass);
                        win.scale.set(22, 28, 4); win.position.set(wX * 36, 30 + floorY * 55, 71);
                        group.add(win);
                    }
                }
                hp = 3500; radius = 145; scoreVal = 2500; baseCastShadow = true; 
            } else if (type === 'tree') {
                // InstancedMesh化: groupには何もaddせず、ワールド座標で直接インスタンスの行列を書き込む
                const leafMat = biome === 'forest' ? materials.treeLeavesForest
                    : biome === 'meadow' ? materials.treeLeavesMeadow
                    : biome === 'plateau' ? materials.treeLeavesPlateau
                    : materials.treeLeaves;
                debrisMaterial = leafMat; // 追加: 破壊時の葉パーティクル色として使う

                hp = 80; radius = 25; scoreVal = 50; baseCastShadow = false;

                const treeInstances = [];
                const dummy = new THREE.Object3D();
                // 元の演出（球葉のときに小さい球がランダム方向にずれる）を再現するための角度
                const leafOffsetAngle = Math.random() * Math.PI * 2;

                // 幹
                dummy.position.set(x, 30, z);
                dummy.rotation.set(0, 0, 0);
                dummy.scale.set(12, 60, 12);
                dummy.updateMatrix();
                if (treeTrunkInstancedMesh && nextTreeTrunkInstanceIndex < 5000) {
                    treeTrunkInstancedMesh.setMatrixAt(nextTreeTrunkInstanceIndex, dummy.matrix);
                    treeInstances.push({ mesh: treeTrunkInstancedMesh, index: nextTreeTrunkInstanceIndex });
                    nextTreeTrunkInstanceIndex++;
                    treeTrunkInstancedMesh.instanceMatrix.needsUpdate = true;
                }

                // 葉：円錐 or 2つの球（50%抽選、元のロジックのまま）
                if (Math.random() < 0.5) {
                    dummy.position.set(x, 90, z);
                    dummy.scale.set(40, 110, 40);
                    dummy.updateMatrix();
                    if (treeConeInstancedMesh && nextTreeConeInstanceIndex < 5000) {
                        treeConeInstancedMesh.setMatrixAt(nextTreeConeInstanceIndex, dummy.matrix);
                        treeConeInstancedMesh.setColorAt(nextTreeConeInstanceIndex, leafMat.color);
                        treeInstances.push({ mesh: treeConeInstancedMesh, index: nextTreeConeInstanceIndex });
                        nextTreeConeInstanceIndex++;
                        treeConeInstancedMesh.instanceMatrix.needsUpdate = true;
                        if (treeConeInstancedMesh.instanceColor) treeConeInstancedMesh.instanceColor.needsUpdate = true;
                    }
                } else {
                    dummy.position.set(x, 80, z);
                    dummy.scale.set(55, 65, 55);
                    dummy.updateMatrix();
                    if (treeSphere1InstancedMesh && nextTreeSphere1InstanceIndex < 5000) {
                        treeSphere1InstancedMesh.setMatrixAt(nextTreeSphere1InstanceIndex, dummy.matrix);
                        treeSphere1InstancedMesh.setColorAt(nextTreeSphere1InstanceIndex, leafMat.color);
                        treeInstances.push({ mesh: treeSphere1InstancedMesh, index: nextTreeSphere1InstanceIndex });
                        nextTreeSphere1InstanceIndex++;
                        treeSphere1InstancedMesh.instanceMatrix.needsUpdate = true;
                        if (treeSphere1InstancedMesh.instanceColor) treeSphere1InstancedMesh.instanceColor.needsUpdate = true;
                    }

                    const offX = Math.cos(leafOffsetAngle) * 21.2; // 元の(15,-15)のオフセット距離を角度化
                    const offZ = Math.sin(leafOffsetAngle) * 21.2;
                    dummy.position.set(x + offX, 95, z + offZ);
                    dummy.scale.set(35, 35, 35);
                    dummy.updateMatrix();
                    if (treeSphere2InstancedMesh && nextTreeSphere2InstanceIndex < 5000) {
                        treeSphere2InstancedMesh.setMatrixAt(nextTreeSphere2InstanceIndex, dummy.matrix);
                        treeSphere2InstancedMesh.setColorAt(nextTreeSphere2InstanceIndex, leafMat.color);
                        treeInstances.push({ mesh: treeSphere2InstancedMesh, index: nextTreeSphere2InstanceIndex });
                        nextTreeSphere2InstanceIndex++;
                        treeSphere2InstancedMesh.instanceMatrix.needsUpdate = true;
                        if (treeSphere2InstancedMesh.instanceColor) treeSphere2InstancedMesh.instanceColor.needsUpdate = true;
                    }
                }

                group.userData = { isInstanced: true, instances: treeInstances };
            } else if (type === 'rock') {
                const h = 200 + Math.random() * 250;
                const rockMat = biome === 'highland' ? materials.rockHighland : materials.rock;
                debrisMaterial = rockMat; // 追加: 破壊時に正しい色の破片を出すため記録
                hp = 600; radius = h / 3.8; scoreVal = 100; baseCastShadow = true;

                const dummy = new THREE.Object3D();
                dummy.position.set(x, h / 5.6, z);
                dummy.scale.setScalar(h / 2.8);
                dummy.updateMatrix();

                if (rockInstancedMesh && nextRockInstanceIndex < 3000) {
                    rockInstancedMesh.setMatrixAt(nextRockInstanceIndex, dummy.matrix);
                    // 岩肌に苔をまとわせるバリエーション（高地バイオーム以外で3割の確率）：単調な岩色を崩す
                    if (biome !== 'highland' && Math.random() < 0.3) {
                        const mossyRockColor = rockMat.color.clone().lerp(new THREE.Color(0x5c7a3a), 0.35 + Math.random() * 0.25);
                        rockInstancedMesh.setColorAt(nextRockInstanceIndex, mossyRockColor);
                    } else {
                        rockInstancedMesh.setColorAt(nextRockInstanceIndex, rockMat.color);
                    }
                    group.userData = { isInstanced: true, instances: [{ mesh: rockInstancedMesh, index: nextRockInstanceIndex }] };
                    nextRockInstanceIndex++;
                    rockInstancedMesh.instanceMatrix.needsUpdate = true;
                }
            } else if (type === 'pebble') {
                const size = 30 + Math.random() * 40;
                const rockMat = biome === 'highland' ? materials.rockHighland : materials.rock;
                debrisMaterial = rockMat; // 追加: 破壊時に正しい色の破片を出すため記録
                hp = 150; radius = size * 0.35; scoreVal = 20; baseCastShadow = false;

                const dummy = new THREE.Object3D();
                dummy.position.set(x, size * 0.35, z);
                dummy.scale.setScalar(size * 0.7);
                dummy.updateMatrix();

                if (pebbleInstancedMesh && nextPebbleInstanceIndex < 5000) {
                    pebbleInstancedMesh.setMatrixAt(nextPebbleInstanceIndex, dummy.matrix);
                    // 小石にも苔バリエーションを混ぜて統一感のあるアクセントにする
                    if (biome !== 'highland' && Math.random() < 0.3) {
                        const mossyPebbleColor = rockMat.color.clone().lerp(new THREE.Color(0x5c7a3a), 0.35 + Math.random() * 0.25);
                        pebbleInstancedMesh.setColorAt(nextPebbleInstanceIndex, mossyPebbleColor);
                    } else {
                        pebbleInstancedMesh.setColorAt(nextPebbleInstanceIndex, rockMat.color);
                    }
                    group.userData = { isInstanced: true, instances: [{ mesh: pebbleInstancedMesh, index: nextPebbleInstanceIndex }] };
                    nextPebbleInstanceIndex++;
                    pebbleInstancedMesh.instanceMatrix.needsUpdate = true;
                }
            } else if (type === 'human') {
                const body = new THREE.Mesh(geometries.box, new THREE.MeshPhongMaterial({color: Math.random() < 0.25 ? 0x225522 : 0x3366ff}));
                body.scale.set(45, 90, 45); body.position.y = 45; group.add(body);
                const head = new THREE.Mesh(geometries.sphere, new THREE.MeshPhongMaterial({color: 0xffccaa}));
                head.scale.setScalar(30); head.position.y = 110; group.add(head);
                hp = 40; radius = 25; scoreVal = 100; baseCastShadow = false;
            } else if (type === 'militaryBase') {
                // 洗練された重装甲かまぼこ型（クォンセット・ハット）要塞
                const concreteMat = materials.towerBase;
                const armorMat = materials.charred;
                const armyMat = materials.tank;

                const basePad = new THREE.Mesh(geometries.box, concreteMat);
                basePad.scale.set(260, 20, 260);
                basePad.position.set(0, 10, 0);
                basePad.castShadow = true;
                basePad.receiveShadow = true;
                group.add(basePad);

                const hangarGeom = new THREE.CylinderGeometry(100, 100, 200, 16, 1, false, Math.PI / 2, Math.PI);
                const hangar = new THREE.Mesh(hangarGeom, armyMat);
                hangar.rotation.x = Math.PI / 2;
                hangar.position.set(0, 20, -10);
                hangar.castShadow = true;
                group.add(hangar);

                for (let i = -4; i <= 4; i++) {
                    const ribGeom = new THREE.CylinderGeometry(103, 103, 8, 16, 1, false, Math.PI / 2, Math.PI);
                    const rib = new THREE.Mesh(ribGeom, armorMat);
                    rib.rotation.x = Math.PI / 2;
                    rib.position.set(0, 20, -10 + i * 22);
                    group.add(rib);
                }

                const doorFrame = new THREE.Mesh(geometries.box, concreteMat);
                doorFrame.scale.set(140, 60, 20);
                doorFrame.position.set(0, 40, 90);
                group.add(doorFrame);

                const door = new THREE.Mesh(geometries.box, armorMat);
                door.scale.set(100, 50, 22);
                door.position.set(0, 35, 90);
                group.add(door);

                for (let i = -1; i <= 1; i += 2) {
                    const towerPillar = new THREE.Mesh(geometries.box, concreteMat);
                    towerPillar.scale.set(20, 100, 20);
                    towerPillar.position.set(i * 100, 60, 100);
                    towerPillar.castShadow = true;
                    group.add(towerPillar);

                    const towerCabin = new THREE.Mesh(geometries.box, armorMat);
                    towerCabin.scale.set(30, 20, 30);
                    towerCabin.position.set(i * 100, 120, 100);
                    group.add(towerCabin);
                    
                    const antGeom = new THREE.CylinderGeometry(1, 1, 30, 4);
                    const ant = new THREE.Mesh(antGeom, materials.whiteEye);
                    ant.position.set(i * 100, 145, 100);
                    group.add(ant);
                }

                hp = 3200; radius = 160; scoreVal = 2200; baseCastShadow = true;
            } else if (type === 'barn') {
                const body = new THREE.Mesh(geometries.box, materials.barnWall);
                body.scale.set(220, 130, 150); body.position.y = 65; group.add(body);
                // 長方形の納屋には、Boxを45度傾けた「切妻屋根（三角屋根）」を乗せる
                const roof = new THREE.Mesh(geometries.box, materials.barnRoof);
                roof.scale.set(240, 120, 120); // 奥行き170相当
                roof.position.y = 130; 
                roof.rotation.x = Math.PI / 4; 
                group.add(roof);

                const trimX = new THREE.Mesh(geometries.box, materials.barnTrim);
                trimX.scale.set(140, 10, 4); trimX.position.set(0, 108, 76); group.add(trimX);
                const doorL = new THREE.Mesh(geometries.box, materials.charred);
                doorL.scale.set(50, 90, 4); doorL.position.set(-30, 45, 76); group.add(doorL);
                const doorR = new THREE.Mesh(geometries.box, materials.charred);
                doorR.scale.set(50, 90, 4); doorR.position.set(30, 45, 76); group.add(doorR);

                const siloGeom = new THREE.CylinderGeometry(35, 35, 160, 10);
                const silo = new THREE.Mesh(siloGeom, materials.towerBase);
                silo.position.set(155, 80, 0); silo.castShadow = true; group.add(silo);
                const siloRoof = new THREE.Mesh(geometries.cone, materials.barnRoof);
                siloRoof.scale.set(40, 45, 40); siloRoof.position.set(155, 182.5, 0); group.add(siloRoof);

                hp = 900; radius = 140; scoreVal = 700; baseCastShadow = true;
            }
            else if (type === 'factory') {
                const body = new THREE.Mesh(geometries.box, materials.factoryWall);
                body.scale.set(260, 140, 200); body.position.y = 70; group.add(body);
                const roof = new THREE.Mesh(geometries.box, materials.factoryRoof);
                roof.scale.set(280, 14, 220); roof.position.y = 147; group.add(roof);

                const stackGeom = new THREE.CylinderGeometry(22, 26, 220, 8);
                const stack = new THREE.Mesh(stackGeom, materials.factoryTrim);
                stack.position.set(-90, 220, -60); stack.castShadow = true; group.add(stack);
                const stackTop = new THREE.Mesh(geometries.box, materials.charred);
                stackTop.scale.set(50, 10, 50); stackTop.position.set(-90, 332, -60); group.add(stackTop);

                for (let w = 0; w < 3; w++) {
                    const win = new THREE.Mesh(geometries.box, materials.windowGlass);
                    win.scale.set(35, 35, 4); win.position.set(-80 + w * 80, 90, 101); group.add(win);
                }

                hp = 1600; radius = 160; scoreVal = 1200; baseCastShadow = true;
            } else if (type === 'haystack') {
                const size = 45 + Math.random() * 25;
                const b = new THREE.Mesh(geometries.dodeca, materials.hay); b.scale.setScalar(size); b.position.y = size * 0.6; group.add(b);
                hp = 120; radius = size * 0.6; scoreVal = 40; baseCastShadow = false;
            } else if (type === 'cow') {
                const body = new THREE.Mesh(geometries.box, materials.cowBody);
                body.scale.set(70, 45, 40); body.position.y = 45; group.add(body);
                const spot = new THREE.Mesh(geometries.box, materials.cowSpot);
                spot.scale.set(22, 46, 41); spot.position.set(-15, 45, 0); group.add(spot);
                const head = new THREE.Mesh(geometries.box, materials.cowBody);
                head.scale.set(28, 28, 32); head.position.set(42, 48, 0); group.add(head);
                for (let l = 0; l < 4; l++) {
                    const leg = new THREE.Mesh(geometries.box, materials.cowSpot);
                    leg.scale.set(10, 26, 10);
                    leg.position.set((l < 2 ? -22 : 22), 13, (l % 2 === 0 ? -14 : 14));
                    group.add(leg);
                }
                hp = 60; radius = 35; scoreVal = 80; baseCastShadow = false;
            } else if (type === 'tank') {
                // シャシー本体
                customChassis = new THREE.Mesh(geometries.box, materials.tank);
                customChassis.scale.set(100, 35, 140); customChassis.position.set(0, 30, 0);
                group.add(customChassis);

                // キャタピラ (左右にリアルに配置。group直下に配置しバグを防止)
                const trackL = new THREE.Mesh(geometries.box, materials.charred);
                trackL.scale.set(22, 40, 160); trackL.position.set(-61, 20, 0);
                trackL.castShadow = true; trackL.receiveShadow = true;
                group.add(trackL);

                const trackR = new THREE.Mesh(geometries.box, materials.charred);
                trackR.scale.set(22, 40, 160); trackR.position.set(61, 20, 0);
                trackR.castShadow = true; trackR.receiveShadow = true;
                group.add(trackR);

                // 砲塔本体
                customTurret = new THREE.Mesh(geometries.box, materials.tank);
                customTurret.scale.set(65, 26, 75); customTurret.position.set(0, 60, -10);
                group.add(customTurret);

                // 砲塔上部ハッチ (巨大化バグを防ぐため、スケールされたMeshではなく、全体group直下に配置)
                const hatch = new THREE.Mesh(geometries.box, materials.charred);
                hatch.scale.set(24, 5, 24); hatch.position.set(16, 74, -20);
                hatch.castShadow = true; hatch.receiveShadow = true;
                group.add(hatch);

                // 砲身基部＆砲身
                customGunGroup = new THREE.Group();
                customGunGroup.position.set(0, 60, 22);
                
                const gunMesh = new THREE.Mesh(geometries.box, materials.tank);
                gunMesh.scale.set(8, 8, 90); gunMesh.position.set(0, 0, 45);
                customGunGroup.add(gunMesh);

                // マズルブレーキ (砲口先端の膨らみ)
                const muzzle = new THREE.Mesh(geometries.box, materials.charred);
                muzzle.scale.set(14, 14, 16); muzzle.position.set(0, 0, 90);
                customGunGroup.add(muzzle);

                group.add(customGunGroup);

                // 後部排気管 (マフラー)
                const exhaust = new THREE.Mesh(geometries.box, materials.charred);
                exhaust.scale.set(8, 22, 8); exhaust.position.set(-35, 35, -70);
                group.add(exhaust);

                radius = TANK_RADIUS; 
                hp = TANK_HP; scoreVal = TANK_SCORE_VALUE; tankCount++; baseCastShadow = true;
            }
            
            group.position.set(x, 0, z);
            if (type === 'human') group.scale.setScalar(humanVisualScale);
            if (forceAngle !== null) {
                group.rotation.y = forceAngle;
            } else {
                group.rotation.y = Math.random() * Math.PI * 2;
            }
            
            const distSq = x * x + z * z;
            if (distSq > ACTIVE_DISTANCE_SQ) {
                group.visible = false;
            }

            // 動かない静的オブジェクト（家、木、岩、軍事基地など）は、行列計算を生成時に一度だけ強制更新し、
            // 毎フレームのCPU再計算（matrixAutoUpdate）を停止させてCPUの無駄な計算オーバーヘッドを削減します。
            const isStatic = ['house', 'tower', 'church', 'school', 'tree', 'rock', 'pebble', 'militaryBase', 'barn', 'factory', 'haystack', 'cow'].includes(type);
            if (isStatic) {
                group.updateMatrix();
                group.matrixAutoUpdate = false;
                group.traverse(child => {
                    if (child.isMesh) {
                        child.updateMatrix();
                        child.matrixAutoUpdate = false;
                    }
                });
            }

            const data = {
                type, hp, maxHp: hp, mesh: group,
                debrisMaterial, // 追加: 破壊時の破片色（岩・小石のみ設定される）
                velocity: new THREE.Vector3(), rotVel: new THREE.Vector3(), pushVel: new THREE.Vector3(),
                radius, scoreVal, isDead: false, wanderAngle: Math.random() * Math.PI * 2, lastShot: 0,
                baseCastShadow: baseCastShadow,
                currentCastShadow: null, // シャドウ更新最適化用
                chassis: customChassis,
                turret: customTurret,
                gunGroup: customGunGroup,
                // 人間用追加ステート
                humanState,
                humanTimer,
                wiggleTime,
                tripTimer,
                targetBuilding, // 追加: 避難先建物
                idleWaitTimer, // 追加: 立ち止まり時間
                fleeAngleOffset: 0, // 追加: 逃走方向のランダムオフセット
                waterAvoidTimer: 0, // 追加: 川に押し戻された直後、岸沿い方向へ逃走方向をそらす残り時間
                waterAvoidDir: new THREE.Vector3(), // 追加: 押し戻された時の水域中心からの外向き方向
                // 戦車用追加ステート
                tankStuckTimer: 0,
                tankAvoidAngle: 0,
                lastPos: new THREE.Vector3(x, 0, z),
                stuckCheckTimer: 0
            };
            entities.push(data); scene.add(group);
            return data;
        }

        // --- 都市・村計画配置システム (Town Planning System) ---
        function initMap() {
            militaryBases.length = 0; // 再生成時に古いオブジェクトデータ参照が残り続けるバグを防止
            humanSpawnPool.length = 0; // 人間の配置候補プールも再生成時にリセット
            humanPoolActivatedCount = 0;
            waterZones.length = 0; // 池・川の位置データも再生成時にリセット（追加：蓄積バグ防止）
            // 1500個ずつの最大容量でインスタンスを事前生成（ドローコールを1回に集約）
            // ベースマテリアルの色を白色 (0xffffff) にしたクローンを使うことで、
            // setColorAt で色が掛け算（乗算）されて暗く退化する現象を完全に防止します。
            const instancedRockMat = materials.rock.clone();
            instancedRockMat.color.setHex(0xffffff);

            rockInstancedMesh = new THREE.InstancedMesh(geometries.dodeca, instancedRockMat, 3000);
            pebbleInstancedMesh = new THREE.InstancedMesh(geometries.dodeca, instancedRockMat, 5000);
            rockInstancedMesh.castShadow = true;
            rockInstancedMesh.receiveShadow = true;
            pebbleInstancedMesh.castShadow = true;
            pebbleInstancedMesh.receiveShadow = true;
            
            // カリング制御を有効化
            rockInstancedMesh.frustumCulled = true;
            pebbleInstancedMesh.frustumCulled = true;

            scene.add(rockInstancedMesh);
            scene.add(pebbleInstancedMesh);

            // 追加: 木のInstancedMesh生成（葉は白クローン材質でsetColorAtによりバイオームごとに色分け）
            const instancedLeafMat = materials.treeLeaves.clone();
            instancedLeafMat.color.setHex(0xffffff);

            const TREE_CAPACITY = 5000;
            treeTrunkInstancedMesh = new THREE.InstancedMesh(geometries.box, materials.treeTrunk, TREE_CAPACITY);
            treeConeInstancedMesh = new THREE.InstancedMesh(geometries.cone, instancedLeafMat, TREE_CAPACITY);
            treeSphere1InstancedMesh = new THREE.InstancedMesh(geometries.sphere, instancedLeafMat, TREE_CAPACITY);
            treeSphere2InstancedMesh = new THREE.InstancedMesh(geometries.sphere, instancedLeafMat, TREE_CAPACITY);

            treeTrunkInstancedMesh.castShadow = false;
            treeConeInstancedMesh.castShadow = false;
            treeSphere1InstancedMesh.castShadow = false;
            treeSphere2InstancedMesh.castShadow = false;

            treeTrunkInstancedMesh.frustumCulled = true;
            treeConeInstancedMesh.frustumCulled = true;
            treeSphere1InstancedMesh.frustumCulled = true;
            treeSphere2InstancedMesh.frustumCulled = true;

            scene.add(treeTrunkInstancedMesh);
            scene.add(treeConeInstancedMesh);
            scene.add(treeSphere1InstancedMesh);
            scene.add(treeSphere2InstancedMesh);

            // 草専用のInstancedMesh（四角錐を細長くして草の刃に見立てる。束にするため容量を増やす）
            const instancedGrassMat = materials.treeLeaves.clone();
            instancedGrassMat.color.setHex(0xffffff);
            grassInstancedMesh = new THREE.InstancedMesh(geometries.pyramid, instancedGrassMat, 60000);
            grassInstancedMesh.castShadow = false; // 影は落とさず軽くする
            grassInstancedMesh.receiveShadow = true;
            grassInstancedMesh.frustumCulled = true;
            scene.add(grassInstancedMesh);

            // 茂み専用のInstancedMesh（球体を低く潰して丸い低木に見立てる。純粋な装飾で当たり判定なし）
            const instancedBushMat = materials.treeLeaves.clone();
            instancedBushMat.color.setHex(0xffffff);
            bushInstancedMesh = new THREE.InstancedMesh(geometries.sphere, instancedBushMat, 4000);
            bushInstancedMesh.castShadow = true;
            bushInstancedMesh.receiveShadow = true;
            bushInstancedMesh.frustumCulled = true;
            scene.add(bushInstancedMesh);

            // 花専用のInstancedMesh（小さな円錐を花びらの塊に見立て、鮮やかな色を散りばめて彩りを足す）
            const instancedFlowerMat = materials.treeLeaves.clone();
            instancedFlowerMat.color.setHex(0xffffff);
            flowerInstancedMesh = new THREE.InstancedMesh(geometries.cone, instancedFlowerMat, 9000);
            flowerInstancedMesh.castShadow = false;
            flowerInstancedMesh.receiveShadow = false;
            flowerInstancedMesh.frustumCulled = true;
            scene.add(flowerInstancedMesh);

            // --- 雲の生成 ---
            clouds.forEach(c => { scene.remove(c.mesh); safeDispose(c.mesh); });
            clouds.length = 0;
            for(let i=0; i<70; i++) {
                // 雲ごとに不透明度と色味を少し変えて奥行き・柔らかさを出す
                const cloudOpacity = 0.55 + Math.random() * 0.35;
                const warmTint = Math.random() < 0.4;
                const cloudColor = warmTint ? 0xfff3e0 : 0xffffff;
                const cloudMat = new THREE.MeshPhongMaterial({ color: cloudColor, transparent: true, opacity: cloudOpacity });

                const cloud = new THREE.Mesh(geometries.box, cloudMat);
                const w = 600 + Math.random() * 1400;
                const h = 100 + Math.random() * 220;
                const d = 400 + Math.random() * 900;
                cloud.scale.set(w, h, d);
                cloud.position.set(
                    (Math.random() - 0.5) * 28000,
                    1600 + Math.random() * 1900,
                    (Math.random() - 0.5) * 28000
                );
                scene.add(cloud);
                clouds.push({ mesh: cloud, speed: 1.5 + Math.random() * 2.5 });

                // 3割の確率で、脇にもう一塊足して房状のふわっとした雲にする
                if (Math.random() < 0.3) {
                    const puff = new THREE.Mesh(geometries.box, cloudMat);
                    const pw = w * (0.4 + Math.random() * 0.4);
                    const ph = h * (0.6 + Math.random() * 0.4);
                    const pd = d * (0.4 + Math.random() * 0.4);
                    puff.scale.set(pw, ph, pd);
                    puff.position.set(
                        cloud.position.x + (Math.random() - 0.5) * w * 0.8,
                        cloud.position.y + (Math.random() - 0.5) * h * 0.4,
                        cloud.position.z + (Math.random() - 0.5) * d * 0.8
                    );
                    scene.add(puff);
                    clouds.push({ mesh: puff, speed: clouds[clouds.length - 1].speed });
                }
            }

            nextTreeTrunkInstanceIndex = 0;
            nextTreeConeInstanceIndex = 0;
            nextTreeSphere1InstanceIndex = 0;
            nextTreeSphere2InstanceIndex = 0;
            
            nextRockInstanceIndex = 0;
            nextPebbleInstanceIndex = 0;
            nextGrassInstanceIndex = 0;
            nextBushInstanceIndex = 0;
            nextFlowerInstanceIndex = 0;
            const TOTAL_OBJECTS = 3500; // スカスカすぎず過密すぎないベストな密集感 (2400 -> 3500)

            const townCenters = [
                { x: 0,     z: 0,     radius: 4860, coreRadius: 2700, type: 'capital' },   
                { x: 7500,  z: 7500,  radius: 3780, coreRadius: 2100, type: 'church_town' }, 
                { x: -8250, z: 6750,  radius: 3780, coreRadius: 2100, type: 'school_town' }, 
                { x: 7500,  z: -7500, radius: 3510, coreRadius: 1950, type: 'residential' }, 
                { x: -7500, z: -8250, radius: 3510, coreRadius: 1950, type: 'military' },    
                { x: 0,     z: 11250, radius: 3240, coreRadius: 1800, type: 'suburb' }       
            ];

            townCenters.forEach(tc => {
                // 町の少し外れ（町の半径の外側）に軍事施設を配置
                const baseAngle = Math.random() * Math.PI * 2;
                const baseDist = tc.radius + 350 + Math.random() * 250;
                tc.baseX = tc.x + Math.sin(baseAngle) * baseDist;
                tc.baseZ = tc.z + Math.cos(baseAngle) * baseDist;
                
                // 【不具合修正】スポーン処理が生きている基地を正確に認識できるように、実エンティティを参照登録
                const mBase = spawnEntity('militaryBase', tc.baseX, tc.baseZ, baseAngle);
                militaryBases.push(mBase);

                if (tc.type === 'capital') {
                    spawnEntity('school', tc.x - 400, tc.z, 0);
                    spawnEntity('church', tc.x + 500, tc.z, Math.PI / 2);
                    spawnEntity('tower', tc.x, tc.z - 550, 0);
                } else if (tc.type === 'church_town') {
                    spawnEntity('church', tc.x, tc.z, 0);
                    spawnEntity('tower', tc.x - 400, tc.z + 300, Math.PI / 4);
                } else if (tc.type === 'school_town') {
                    spawnEntity('school', tc.x, tc.z, 0);
                } else if (tc.type === 'military') {
                    spawnEntity('tower', tc.x, tc.z, 0);
                    spawnEntity('tank', tc.baseX - 150, tc.baseZ + 120);
                    spawnEntity('tank', tc.baseX + 150, tc.baseZ - 120);
                } else if (tc.type === 'suburb') {
                    spawnEntity('church', tc.x, tc.z, Math.PI);
                }
            });

            // --- 水域（川・池）の生成 ---
            // waterZones は entities とは無関係の純粋な地形データ（{x, z, radius}）のみを保持する。
            const WATER_TOWN_MARGIN = 700; 

            // 池の生成
            const pondCount = 2;
            let pondsPlaced = 0, pondAttempts = 0;
            while (pondsPlaced < pondCount && pondAttempts < 300) {
                pondAttempts++;
                const ang = Math.random() * Math.PI * 2;
                const dist = 6300 + Math.random() * 4200;
                const px = Math.sin(ang) * dist;
                const pz = Math.cos(ang) * dist;

                let tooCloseToTown = false;
                for (const tc of townCenters) {
                    const dx = px - tc.x, dz = pz - tc.z;
                    const minGap = tc.radius + WATER_TOWN_MARGIN;
                    if (dx * dx + dz * dz < minGap * minGap) { tooCloseToTown = true; break; }
                }
                if (tooCloseToTown) continue;

                const pondRadius = 280 + Math.random() * 160;
                let tooCloseToWater = false;
                for (const wz of waterZones) {
                    const dx = px - wz.x, dz = pz - wz.z;
                    const minGap = pondRadius + wz.radius + 300;
                    if (dx * dx + dz * dz < minGap * minGap) { tooCloseToWater = true; break; }
                }
                if (tooCloseToWater) continue;

                waterZones.push({ x: px, z: pz, radius: pondRadius, isPond: true });
                const pondMesh = new THREE.Mesh(new THREE.CircleGeometry(pondRadius, 28), materials.water);
                pondMesh.rotation.x = -Math.PI / 2;
                pondMesh.position.set(px, 0.5, pz);
                pondMesh.receiveShadow = true;
                pondMesh.matrixAutoUpdate = false;
                pondMesh.updateMatrix();
                scene.add(pondMesh);
                pondsPlaced++;
            }

            // 川を1本、マップを縦断させる（重力・引力ロジック）
            {
                const RIVER_TILE = 110;
                let angle = 0; 
                const baseAngle = 0; 
                
                let rx = (Math.random() - 0.5) * 4000; 
                let rz = -MAP_SIZE / 2 - 400;
                let dist = 0;
                const maxDist = MAP_SIZE * 1.4;

                while (dist < maxDist) {
                    angle += (Math.random() - 0.5) * 0.35; 
                    let angleDiff = baseAngle - angle;
                    angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
                    angle += angleDiff * 0.08; 

                    for (const tc of townCenters) {
                        const dxTc = rx - tc.x, dzTc = rz - tc.z;
                        const dangerRadius = tc.radius + 300; 
                        if (dxTc * dxTc + dzTc * dzTc < dangerRadius * dangerRadius) {
                            const awayAngle = Math.atan2(dxTc, dzTc);
                            let avoidDiff = awayAngle - angle;
                            avoidDiff = Math.atan2(Math.sin(avoidDiff), Math.cos(avoidDiff));
                            angle += Math.sign(avoidDiff) * 0.15;
                            break;
                        }
                    }

                    for (const wz of waterZones) {
                        if (!wz.isPond) continue;
                        const dxWz = rx - wz.x, dzWz = rz - wz.z;
                        const dangerRadiusPond = wz.radius + 300;
                        if (dxWz * dxWz + dzWz * dzWz < dangerRadiusPond * dangerRadiusPond) {
                            const awayAnglePond = Math.atan2(dxWz, dzWz);
                            let avoidDiffPond = awayAnglePond - angle;
                            avoidDiffPond = Math.atan2(Math.sin(avoidDiffPond), Math.cos(avoidDiffPond));
                            angle += Math.sign(avoidDiffPond) * 0.15;
                            break;
                        }
                    }

                    const stepLen = RIVER_TILE * 0.35; 
                    rx += Math.sin(angle) * stepLen;
                    rz += Math.cos(angle) * stepLen;
                    dist += stepLen;

                    const tileRadius = RIVER_TILE * 0.5 * (0.85 + Math.random() * 0.3);
                    waterZones.push({ x: rx, z: rz, radius: tileRadius });

                    const riverTile = new THREE.Mesh(new THREE.CircleGeometry(tileRadius, 16), materials.water);
                    riverTile.rotation.x = -Math.PI / 2;
                    riverTile.position.set(rx, 0.5, rz);
                    riverTile.receiveShadow = true;
                    riverTile.matrixAutoUpdate = false;
                    riverTile.updateMatrix();
                    scene.add(riverTile);
                }
            }

            // --- 街道（道と橋）の生成（人間の営みロジック） ---
            const pathTiles = []; 
            const PATH_TILE = 70;
            const PATH_Y = 3.0;

            // 1. 町の中にローカルな小道を作る（建物を密集させるため）
            townCenters.forEach(tc => {
                const branchCount = 3 + Math.floor(tc.radius / 500);
                for (let b = 0; b < branchCount; b++) {
                    let angle = Math.random() * Math.PI * 2;
                    let px = tc.x, pz = tc.z;
                    let dist = 0;
                    const maxDist = tc.radius * 0.7;
                    while (dist < maxDist) {
                        angle += (Math.random() - 0.5) * 0.5; // 蛇行を弱め、迷路っぽさを緩和（0.8→0.5）
                        const stepLen = PATH_TILE * 0.8;
                        px += Math.sin(angle) * stepLen;
                        pz += Math.cos(angle) * stepLen;
                        dist += stepLen;
                        
                        let inWater = false;
                        for (const wz of waterZones) {
                            if ((px - wz.x)**2 + (pz - wz.z)**2 < (wz.radius + 20)**2) { inWater = true; break; }
                        }
                        if (inWater) continue;

                        const size = PATH_TILE * (0.85 + Math.random() * 0.35);
                        const tile = new THREE.Mesh(new THREE.PlaneGeometry(size, size), materials.road);
                        tile.rotation.x = -Math.PI / 2;
                        tile.rotation.z = (Math.random() - 0.5) * 0.12; // タイルのギザギザ回転を抑制
                        tile.position.set(px, PATH_Y, pz);
                        tile.receiveShadow = true;
                        tile.matrixAutoUpdate = false;
                        tile.updateMatrix();
                        scene.add(tile);
                        pathTiles.push({ x: px, z: pz, tc });
                    }
                }
            });

            // 2. 町と町を結ぶ「街道」を敷き、川にぶつかったら「橋」を架ける
            for (let i = 0; i < townCenters.length; i++) {
                for (let j = i + 1; j < townCenters.length; j++) {
                    const tcA = townCenters[i], tcB = townCenters[j];
                    const distSq = (tcA.x - tcB.x)**2 + (tcA.z - tcB.z)**2;
                    
                    // 近隣の町同士（距離11000以内）だけを街道で結ぶ
                    if (distSq > 11000 * 11000) continue;

                    let px = tcA.x, pz = tcA.z;
                    let isBridging = false;
                    let bridgeStartX = 0, bridgeStartZ = 0;
                    let steps = 0;

                    while (steps < 1000) {
                        steps++;
                        const dx = tcB.x - px, dz = tcB.z - pz;
                        if (dx*dx + dz*dz < 400 * 400) break; // 目的地（町B）に到着

                        const targetAngle = Math.atan2(dx, dz);
                        // 橋の上は一直線、陸地は少し蛇行しながら進む
                        const moveAngle = isBridging ? targetAngle : targetAngle + (Math.random() - 0.5) * 0.6;
                        
                        const stepLen = PATH_TILE * 0.8;
                        px += Math.sin(moveAngle) * stepLen;
                        pz += Math.cos(moveAngle) * stepLen;

                        // 現在地が水域か判定
                        let inWater = false;
                        for (const wz of waterZones) {
                            if ((px - wz.x)**2 + (pz - wz.z)**2 < (wz.radius + 30)**2) { 
                                inWater = true; break; 
                            }
                        }

                        if (inWater && !isBridging) {
                            // 水際に到達 -> 橋の建設開始
                            isBridging = true;
                            bridgeStartX = px; bridgeStartZ = pz;
                        } else if (!inWater && isBridging) {
                            // 対岸に到達 -> 橋を架ける
                            isBridging = false;
                            const bdx = px - bridgeStartX, bdz = pz - bridgeStartZ;
                            const bridgeLen = Math.sqrt(bdx*bdx + bdz*bdz);
                            
                            if (bridgeLen > 50) {
                                const bridgeAngle = Math.atan2(bdx, bdz);
                                const midX = (bridgeStartX + px) / 2;
                                const midZ = (bridgeStartZ + pz) / 2;
                                const halfLength = (bridgeLen / 2) + 40; // 両岸に食い込ませる
                                const halfWidth = 55;
                                
                                bridges.push({ x: midX, z: midZ, angle: bridgeAngle, halfLength, halfWidth });

                                const bridgeMesh = new THREE.Mesh(
                                    new THREE.BoxGeometry(halfWidth * 2, 14, halfLength * 2),
                                    materials.bridgeDeck
                                );
                                bridgeMesh.position.set(midX, 8, midZ);
                                bridgeMesh.rotation.y = bridgeAngle;
                                bridgeMesh.castShadow = true;
                                bridgeMesh.receiveShadow = true;
                                bridgeMesh.matrixAutoUpdate = false;
                                bridgeMesh.updateMatrix();
                                scene.add(bridgeMesh);
                            }
                        }

                        // 陸地なら道タイルを敷く
                        if (!isBridging) {
                            const size = PATH_TILE * (0.85 + Math.random() * 0.35);
                            const tile = new THREE.Mesh(new THREE.PlaneGeometry(size, size), materials.road);
                            tile.rotation.x = -Math.PI / 2;
                            tile.rotation.z = (Math.random() - 0.5) * 0.12; // タイルのギザギザ回転を抑制
                            tile.position.set(px, PATH_Y, pz);
                            tile.receiveShadow = true;
                            tile.matrixAutoUpdate = false;
                            tile.updateMatrix();
                            scene.add(tile);
                            
                            // 街道沿いにも建物を建てるため、近い方の町に所属させる
                            const tc = (dx*dx + dz*dz) < distSq / 4 ? tcB : tcA;
                            pathTiles.push({ x: px, z: pz, tc });
                        }
                    }
                }
            }
            // --- 建物クラスターの生成 (マイクラ村風の密集配置) ---
            // 道からあまり離れない範囲にランダムに建物を寄せて建て、隙間の少ない密集した村にする。
            // ただし建物同士の隙間は、人間NPCが逃げ回れる幅を確保する。
            const placedTownSpots = []; // 重なり回避用 { x, z, radius }
            const HUMAN_PASSAGE_GAP = 75; // 建物と建物の間に必ず残す隙間（人間の逃走路）
            // 実際のスポーン前に必要な最低間隔を見積もるための概算半径（各タイプの最大サイズ想定）
            const APPROX_RADIUS = { house: 90, tower: 65, church: 115, school: 145, tree: 25, human: 25, tank: 70 };

            // --- 町中の公園エリア：各町に1箇所、建物を建てず木・芝生で緑化するゾーンを確保する ---
            const parkZones = [];

            townCenters.forEach(tc => {
                const townPaths = pathTiles.filter(t => t.tc === tc);
                if (townPaths.length === 0) return;

                // 中心のランドマーク広場（半径220）を避けつつ、コア範囲内にランダムで公園を1箇所確保
                const parkAngle = Math.random() * Math.PI * 2;
                const parkRadius = Math.max(240, tc.coreRadius * 0.24);
                const parkDist = 260 + parkRadius + Math.random() * Math.max(100, tc.coreRadius * 0.35);
                const park = {
                    x: tc.x + Math.sin(parkAngle) * parkDist,
                    z: tc.z + Math.cos(parkAngle) * parkDist,
                    radius: parkRadius,
                    tc
                };
                parkZones.push(park);
                tc.park = park;

                const targetCount = Math.round((tc.coreRadius * tc.coreRadius) / 36000); // 密集度アップ：空き地を減らし賑やかな町並みにする
                let placed = 0, attempts = 0;

                while (placed < targetCount && attempts < targetCount * 18) {
                    attempts++;
                    const tile = townPaths[Math.floor(Math.random() * townPaths.length)];
                    const ang = Math.random() * Math.PI * 2;
                    const dist = 90 + Math.random() * 150; // 道から少し離れた位置に建物を寄せる
                    const px = tile.x + Math.sin(ang) * dist;
                    const pz = tile.z + Math.cos(ang) * dist;

                    const fromCenterSq = (px - tc.x) * (px - tc.x) + (pz - tc.z) * (pz - tc.z);
                    if (fromCenterSq < 220 * 220) continue; // 中心の広場（ランドマーク建築エリア）は避ける
                    if (fromCenterSq > (tc.radius * 0.98) * (tc.radius * 0.98)) continue; // 町の外周を超えない

                    // 公園エリアには建物を建てない（緑地として確保）
                    const dxParkChk = px - park.x, dzParkChk = pz - park.z;
                    if (dxParkChk * dxParkChk + dzParkChk * dzParkChk < park.radius * park.radius) continue;

                    // 水域に近すぎる場所には建物を配置しない
                    let nearWaterTown = false;
                    for (const wz of waterZones) {
                        const dx = px - wz.x, dz = pz - wz.z;
                        const wThresh = wz.radius + 150;
                        if (dx * dx + dz * dz < wThresh * wThresh) { nearWaterTown = true; break; }
                    }
                    if (nearWaterTown) continue;

                    // 先に建てる種類を決めてから、その概算サイズ込みで間隔をチェックする
                    const r = Math.random();
                    let spawnType;
                    if (tc.type === 'military') {
                        if (r < 0.45) spawnType = 'house';
                        else if (r < 0.60) spawnType = 'tower';
                        else if (r < 0.72) spawnType = 'tank';
                        else spawnType = 'human';
                    } else if (tc.type === 'suburb') {
                        if (r < 0.50) spawnType = 'house';
                        else if (r < 0.75) spawnType = 'tree';
                        else spawnType = 'human';
                    } else {
                        if (r < 0.62) spawnType = 'house';
                        else if (r < 0.70) spawnType = 'tower';
                        else if (r < 0.74) spawnType = 'church';
                        else if (r < 0.78) spawnType = 'school';
                        else if (r < 0.85) spawnType = 'tree';
                        else spawnType = 'human';
                    }

                    const newApproxRadius = APPROX_RADIUS[spawnType];
                    let tooClose = false;
                    for (const spot of placedTownSpots) {
                        const dx = px - spot.x, dz = pz - spot.z;
                        const requiredDist = newApproxRadius + spot.radius + HUMAN_PASSAGE_GAP;
                        if (dx * dx + dz * dz < requiredDist * requiredDist) { tooClose = true; break; }
                    }
                    if (tooClose) continue;

                    // 追加: 建物が「道」の上に被らないように厳密にチェックして避ける
                    let onPath = false;
                    for (const pt of pathTiles) {
                        const dx = px - pt.x, dz = pz - pt.z;
                        const safeDist = newApproxRadius + 35; // 建物半径 + 道の幅の余裕
                        if (Math.abs(dx) > safeDist || Math.abs(dz) > safeDist) continue; // 計算の軽量化
                        if (dx * dx + dz * dz < safeDist * safeDist) { onPath = true; break; }
                    }
                    if (onPath) continue;

                    // 最寄りの小道の方を向かせる（建物の正面が道に面するように東西南北へスナップ）
                    const dxp = tile.x - px, dzp = tile.z - pz;
                    const angleToPath = Math.atan2(dxp, dzp);
                    const forceAngle = Math.round(angleToPath / (Math.PI / 2)) * (Math.PI / 2);

                    if (spawnType === 'human') {
                        // 人間は画質プリセットで数を調整できるよう、その場では作らずプールに座標だけ記録する。
                        // 実際の生成は町生成完了後に applyHumanDensity() でまとめて行う。
                        humanSpawnPool.push({ x: px, z: pz });
                        placedTownSpots.push({ x: px, z: pz, radius: APPROX_RADIUS.human });
                        placed++;
                        continue;
                    }

                    const spawned = (spawnType === 'tank')
                        ? spawnEntity(spawnType, px, pz)
                        : spawnEntity(spawnType, px, pz, forceAngle);

                    placedTownSpots.push({ x: px, z: pz, radius: spawned.radius });
                    placed++;
                }

                // --- 公園エリアの緑化：建物を避けたゾーンに木と芝生を密に配置し、公園らしい緑地にする ---
                {
                    const parkTreeCount = 6 + Math.floor(park.radius / 90);
                    let parkTreesPlaced = 0, parkAttempts = 0;
                    while (parkTreesPlaced < parkTreeCount && parkAttempts < parkTreeCount * 12) {
                        parkAttempts++;
                        const pAng = Math.random() * Math.PI * 2;
                        // 中心45%は開けた芝生として残し、外周寄り(45%〜95%)にだけ木を配置する
                        const pDist = park.radius * (0.45 + Math.random() * 0.5);
                        const tx = park.x + Math.sin(pAng) * pDist;
                        const tz = park.z + Math.cos(pAng) * pDist;

                        let blocked = false;
                        for (const wz of waterZones) {
                            const dx = tx - wz.x, dz = tz - wz.z;
                            const wThresh = wz.radius + 60;
                            if (dx * dx + dz * dz < wThresh * wThresh) { blocked = true; break; }
                        }
                        if (!blocked) {
                            for (const pt of pathTiles) {
                                if (Math.abs(tx - pt.x) < 90 && Math.abs(tz - pt.z) < 90) { blocked = true; break; }
                            }
                        }
                        if (!blocked) {
                            for (const spot of placedTownSpots) {
                                const dx = tx - spot.x, dz = tz - spot.z;
                                const req = 70 + spot.radius; // 木同士の間隔を広げ、密集した塊に見えないようにする
                                if (dx * dx + dz * dz < req * req) { blocked = true; break; }
                            }
                        }
                        if (blocked) continue;

                        const parkTree = spawnEntity('tree', tx, tz, null, 'meadow');
                        placedTownSpots.push({ x: tx, z: tz, radius: parkTree.radius });
                        parkTreesPlaced++;
                    }

                    // 公園内の芝生：花咲く草原と同じ明るい緑で密に敷き詰める
                    const parkGrassSpots = Math.floor((park.radius * park.radius) / 900);
                    const parkDummy = new THREE.Object3D();
                    for (let g = 0; g < parkGrassSpots; g++) {
                        const gAng = Math.random() * Math.PI * 2;
                        const gDist = Math.random() * park.radius;
                        const gx = park.x + Math.sin(gAng) * gDist;
                        const gz = park.z + Math.cos(gAng) * gDist;

                        let invalidSpot = false;
                        for (const wz of waterZones) {
                            if ((gx - wz.x) ** 2 + (gz - wz.z) ** 2 < (wz.radius + 10) ** 2) { invalidSpot = true; break; }
                        }
                        if (!invalidSpot) {
                            for (const pt of pathTiles) {
                                if (Math.abs(gx - pt.x) < 45 && Math.abs(gz - pt.z) < 45) { invalidSpot = true; break; }
                            }
                        }
                        if (invalidSpot) continue;

                        const parkGrassColor = new THREE.Color(0x7cb342);
                        parkGrassColor.offsetHSL(0, 0, (Math.random() - 0.5) * 0.12);

                        const bladeCount = 2 + Math.floor(Math.random() * 2);
                        for (let b = 0; b < bladeCount; b++) {
                            if (grassInstancedMesh && nextGrassInstanceIndex < 60000) {
                                const height = 12 + Math.random() * 16;
                                const width = 2.5 + Math.random() * 2;
                                const offsetX = (Math.random() - 0.5) * 8;
                                const offsetZ = (Math.random() - 0.5) * 8;

                                parkDummy.position.set(gx + offsetX, height / 2, gz + offsetZ);
                                parkDummy.scale.set(width, height, width);

                                const tiltX = (Math.random() - 0.5) * 0.6;
                                const tiltZ = (Math.random() - 0.5) * 0.6;
                                const rotY = Math.random() * Math.PI;
                                parkDummy.rotation.set(tiltX, rotY, tiltZ);
                                parkDummy.updateMatrix();

                                grassInstancedMesh.setMatrixAt(nextGrassInstanceIndex, parkDummy.matrix);
                                grassInstancedMesh.setColorAt(nextGrassInstanceIndex, parkGrassColor);
                                nextGrassInstanceIndex++;
                            }
                        }
                    }
                }
            });

            // --- 町と田舎の境目の緩和 ＆ 田舎の集落・農場・工業地帯の生成 ---
            // 木・岩の密度は下のメイン装飾配置ループで距離に応じたグラデーションをかけて
            // なじませるため、ここでは町の外周のさらに外側に小さな集落・農場・工業地帯のみ配置する。
            townCenters.forEach(tc => {
                // 田舎の小さな集落・農場・工業地帯を1〜2箇所、町の外周のさらに外側にランダム配置
                const satelliteCount = 1 + Math.floor(Math.random() * 2);
                for (let s = 0; s < satelliteCount; s++) {
                    const ang = Math.random() * Math.PI * 2;
                    const dist = tc.radius + 900 + Math.random() * 1400;
                    const sx = tc.x + Math.sin(ang) * dist;
                    const sz = tc.z + Math.cos(ang) * dist;

                    // 水域に近すぎる場所には集落・農場・工業地帯を配置しない
                    let satelliteNearWater = false;
                    for (const wz of waterZones) {
                        const dx = sx - wz.x, dz = sz - wz.z;
                        const wThresh = wz.radius + 450;
                        if (dx * dx + dz * dz < wThresh * wThresh) { satelliteNearWater = true; break; }
                    }
                    if (satelliteNearWater) continue;

                    const zoneRoll = Math.random();
                    if (zoneRoll < 0.45) {
                        // 田舎の小さな集落（家が2〜4軒、まばらに点在）
                        const houseCount = 2 + Math.floor(Math.random() * 3);
                        for (let h = 0; h < houseCount; h++) {
                            const hAng = Math.random() * Math.PI * 2;
                            const hDist = Math.random() * 260;
                            spawnEntity('house', sx + Math.sin(hAng) * hDist, sz + Math.cos(hAng) * hDist, Math.round(Math.random() * 4) * (Math.PI / 2));
                        }
                        if (Math.random() < 0.6) spawnEntity('tree', sx + 150, sz - 100);
                    } else if (zoneRoll < 0.8) {
                        // 農場・酪農地帯
                        const fieldTile = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), materials.farmField);
                        fieldTile.rotation.x = -Math.PI / 2;
                        fieldTile.position.set(sx, 0.3, sz);
                        fieldTile.receiveShadow = true;
                        fieldTile.matrixAutoUpdate = false;
                        fieldTile.updateMatrix();
                        scene.add(fieldTile);

                        spawnEntity('barn', sx - 150, sz, Math.random() * Math.PI * 2);
                        const hayCount = 2 + Math.floor(Math.random() * 3);
                        for (let h = 0; h < hayCount; h++) {
                            spawnEntity('haystack', sx + 120 + (Math.random() - 0.5) * 200, sz + (Math.random() - 0.5) * 200);
                        }
                        const cowCount = 2 + Math.floor(Math.random() * 3);
                        for (let c = 0; c < cowCount; c++) {
                            spawnEntity('cow', sx + (Math.random() - 0.5) * 400, sz + (Math.random() - 0.5) * 400);
                        }
                    } else {
                        // 工業地帯
                        spawnEntity('factory', sx, sz, Math.random() * Math.PI * 2);
                        if (Math.random() < 0.7) {
                            spawnEntity('factory', sx + 320, sz + 180, Math.random() * Math.PI * 2);
                        }
                    }
                }
            });

            const RURAL_OBJECTS = 4000; // 2500 -> 4000個に増量し、田舎の殺風景さを解消
            const EDGE_BLEND_DIST = 400; // 変更: フェード距離を短くし、不自然な空白地帯を減らす

            // --- バイオーム設定：町タイプごとに木/岩/小石の比率と色味を変える ---
            const BIOME_BY_TOWN_TYPE = {
                capital:      { name: '草原',       treeRatio: 0.60, rockRatio: 0.16, matBiome: null },
                church_town:  { name: '森林',       treeRatio: 0.74, rockRatio: 0.12, matBiome: 'forest' },
                school_town:  { name: '岩石高地',   treeRatio: 0.40, rockRatio: 0.42, matBiome: 'highland' },
                residential:  { name: '花咲く草原', treeRatio: 0.62, rockRatio: 0.11, matBiome: 'meadow' },
                military:     { name: '荒野',       treeRatio: 0.48, rockRatio: 0.24, matBiome: null },
                suburb:       { name: '高原',       treeRatio: 0.52, rockRatio: 0.14, matBiome: 'plateau' }
            };

            // 茂み用の色（バイオームに合わせて緑のトーンを変える）
            const bushColorByBiome = {
                forest: 0x1b5e20, meadow: 0x7cb342, plateau: 0xaed581, highland: 0x8d9e7a, default: 0x2e7d32
            };
            const dummyBush = new THREE.Object3D();

            for (let i = 0; i < TOTAL_OBJECTS + RURAL_OBJECTS; i++) {
                const x = (Math.random() - 0.5) * MAP_SIZE;
                const z = (Math.random() - 0.5) * MAP_SIZE;

                // 【修正】タイトル画面のカメラ視野から木・岩・小石を排除し、視界をクリアにします
                if (x > -900 && x < 900 && z > 3800 && z < 6000) {
                    continue;
                }

                const dFromCenter = Math.sqrt(x*x + z*z);
                if (dFromCenter > 12150) continue;

                let nearestTown = null;
                let minDist = Infinity;
                townCenters.forEach(tc => {
                    const dx = x - tc.x;
                    const dz = z - tc.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    if (dist < minDist) {
                        minDist = dist;
                        nearestTown = tc;
                    }
                });

                const biomeCfg = (nearestTown && BIOME_BY_TOWN_TYPE[nearestTown.type]) || BIOME_BY_TOWN_TYPE.capital;

                // 修正: 境界のフェード処理を自然にし、町の中にも少し自然物を混ぜる
                if (nearestTown && minDist < nearestTown.radius * 0.8) {
                    // 町の中心部：完全にスキップせず、22%の確率で木や小石を残し、人工的すぎるのを防ぐ
                    if (Math.random() > 0.22) continue;
                } else if (nearestTown && minDist < nearestTown.radius) {
                    // 町の外周付近：内側から外周に向かって密度を上げる（最低40%は配置）
                    const edgeT = (minDist - nearestTown.radius * 0.8) / (nearestTown.radius * 0.2);
                    if (Math.random() > 0.4 + (edgeT * 0.4)) continue;
                } else if (nearestTown && minDist < nearestTown.radius + EDGE_BLEND_DIST) {
                    // 町のすぐ外側：田舎の全密度に向けて素早く立ち上げる（最低60%は配置）
                    const edgeT = (minDist - nearestTown.radius) / EDGE_BLEND_DIST;
                    if (Math.random() > 0.6 + (edgeT * 0.4)) continue;
                }

                // 水面から木・岩・小石が生えないよう、waterZonesに近すぎる座標は配置をスキップする
                // （町の中心に近すぎたら配置しないスキップ処理と同じパターン）
                let nearWater = false;
                for (const wz of waterZones) {
                    const dx = x - wz.x, dz = z - wz.z;
                    const wThresh = wz.radius + 60;
                    if (dx * dx + dz * dz < wThresh * wThresh) { nearWater = true; break; }
                }
                if (nearWater) continue;

                // 追加: 木や岩が「道」の上に生えないようにチェックして避ける
                let onPath = false;
                for (const pt of pathTiles) {
                    const dx = x - pt.x, dz = z - pt.z;
                    // 変更: 巨大な岩がはみ出さないよう、道を避ける距離(クリアランス)を 65 から 200 に大幅拡大
                    if (Math.abs(dx) > 200 || Math.abs(dz) > 200) continue; 
                    if (dx * dx + dz * dz < 200 * 200) { onPath = true; break; }
                }
                if (onPath) continue;

                // 田舎（町の外）に人間は配置しない。人間は町・村クラスター内にのみ生息させ、
                // 「田舎に人間ばかりで人間っぽくない」問題を解消。空いた分は木・岩・小石・茂みの装飾に配分。
                const r = Math.random();
                if (r < biomeCfg.treeRatio) {
                    spawnEntity('tree', x, z, null, biomeCfg.matBiome);
                } else if (r < biomeCfg.treeRatio + biomeCfg.rockRatio) {
                    spawnEntity('rock', x, z, null, biomeCfg.matBiome);
                } else if (r < biomeCfg.treeRatio + biomeCfg.rockRatio + 0.08) {
                    // 茂み（低木）：当たり判定のない純粋な装飾で、木と岩だけの単調さを崩す
                    if (bushInstancedMesh && nextBushInstanceIndex < 4000) {
                        const bushScale = 22 + Math.random() * 18;
                        dummyBush.position.set(x, bushScale * 0.55, z);
                        dummyBush.scale.set(bushScale, bushScale * 0.8, bushScale);
                        dummyBush.rotation.set(0, Math.random() * Math.PI, 0);
                        dummyBush.updateMatrix();
                        const bushColor = new THREE.Color(bushColorByBiome[biomeCfg.matBiome] || bushColorByBiome.default);
                        bushColor.offsetHSL(0, 0, (Math.random() - 0.5) * 0.12);
                        bushInstancedMesh.setMatrixAt(nextBushInstanceIndex, dummyBush.matrix);
                        bushInstancedMesh.setColorAt(nextBushInstanceIndex, bushColor);
                        nextBushInstanceIndex++;
                    }
                } else {
                    spawnEntity('pebble', x, z, null, biomeCfg.matBiome);
                }
            }
            if (bushInstancedMesh) {
                bushInstancedMesh.instanceMatrix.needsUpdate = true;
                if (bushInstancedMesh.instanceColor) bushInstancedMesh.instanceColor.needsUpdate = true;
            }

            // --- 草の大量配置（当たり判定を持たない純粋な装飾） ---
            const GRASS_CLUSTER_COUNT = 17000;
            const dummyGrass = new THREE.Object3D();
            for (let i = 0; i < GRASS_CLUSTER_COUNT; i++) {
                const x = (Math.random() - 0.5) * MAP_SIZE;
                const z = (Math.random() - 0.5) * MAP_SIZE;

                // タイトル画面のカメラ視野から排除
                if (x > -900 && x < 900 && z > 3800 && z < 6000) continue;
                if (Math.sqrt(x*x + z*z) > 12150) continue;

                // 水域と道の上には生やさない
                let invalidSpot = false;
                for (const wz of waterZones) {
                    if ((x - wz.x)**2 + (z - wz.z)**2 < (wz.radius + 10)**2) { invalidSpot = true; break; }
                }
                if (invalidSpot) continue;
                for (const pt of pathTiles) {
                    if (Math.abs(x - pt.x) < 50 && Math.abs(z - pt.z) < 50) { invalidSpot = true; break; }
                }
                if (invalidSpot) continue;

                // バイオーム判定
                let nearestTown = null;
                let minDist = Infinity;
                townCenters.forEach(tc => {
                    const dist = Math.sqrt((x - tc.x)**2 + (z - tc.z)**2);
                    if (dist < minDist) { minDist = dist; nearestTown = tc; }
                });
                const biomeCfg = (nearestTown && BIOME_BY_TOWN_TYPE[nearestTown.type]) || BIOME_BY_TOWN_TYPE.capital;

                // 街の中心部は草を減らす
                if (nearestTown && minDist < nearestTown.radius * 0.8 && Math.random() > 0.25) continue;

                let grassColor;
                if (biomeCfg.matBiome === 'forest') grassColor = new THREE.Color(0x1b5e20);
                else if (biomeCfg.matBiome === 'meadow') grassColor = new THREE.Color(0x7cb342);
                else if (biomeCfg.matBiome === 'plateau') grassColor = new THREE.Color(0xaed581);
                else if (biomeCfg.matBiome === 'highland') grassColor = new THREE.Color(0x8d9e7a);
                else grassColor = new THREE.Color(0x558b2f);
                
                grassColor.offsetHSL(0, 0, (Math.random() - 0.5) * 0.15);

                // 1つの座標に2〜3本の細長い刃を束ねて配置
                const bladeCount = 2 + Math.floor(Math.random() * 2);
                for (let b = 0; b < bladeCount; b++) {
                    if (grassInstancedMesh && nextGrassInstanceIndex < 60000) {
                        const height = 12 + Math.random() * 16; // 高く細く
                        const width = 2.5 + Math.random() * 2;
                        
                        const offsetX = (Math.random() - 0.5) * 8;
                        const offsetZ = (Math.random() - 0.5) * 8;

                        dummyGrass.position.set(x + offsetX, height / 2, z + offsetZ);
                        dummyGrass.scale.set(width, height, width);
                        
                        // 外側に向かって少し傾ける
                        const tiltX = (Math.random() - 0.5) * 0.6;
                        const tiltZ = (Math.random() - 0.5) * 0.6;
                        const rotY = Math.random() * Math.PI;
                        dummyGrass.rotation.set(tiltX, rotY, tiltZ);
                        dummyGrass.updateMatrix();

                        grassInstancedMesh.setMatrixAt(nextGrassInstanceIndex, dummyGrass.matrix);
                        grassInstancedMesh.setColorAt(nextGrassInstanceIndex, grassColor);
                        nextGrassInstanceIndex++;
                    }
                }
            }
            if (grassInstancedMesh) {
                grassInstancedMesh.instanceMatrix.needsUpdate = true;
                if (grassInstancedMesh.instanceColor) grassInstancedMesh.instanceColor.needsUpdate = true;
            }

            // --- 花畑の配置（純粋な装飾、彩りを足して単調な緑を崩す） ---
            // 花咲く草原・高原・首都バイオームで多め、森林・岩石高地では控えめに出現させる
            const FLOWER_PATCH_COUNT = 900;
            const flowerPetalColors = [0xff6f91, 0xffd93d, 0xb388ff, 0xffffff, 0xff8a65, 0xfff176];
            const flowerDensityByBiome = { meadow: 1.4, plateau: 1.1, forest: 0.35, highland: 0.25, default: 0.8 };
            const dummyFlower = new THREE.Object3D();

            for (let i = 0; i < FLOWER_PATCH_COUNT; i++) {
                const x = (Math.random() - 0.5) * MAP_SIZE;
                const z = (Math.random() - 0.5) * MAP_SIZE;

                if (x > -900 && x < 900 && z > 3800 && z < 6000) continue;
                if (Math.sqrt(x*x + z*z) > 12150) continue;

                let invalidSpot = false;
                for (const wz of waterZones) {
                    if ((x - wz.x)**2 + (z - wz.z)**2 < (wz.radius + 30)**2) { invalidSpot = true; break; }
                }
                if (invalidSpot) continue;
                for (const pt of pathTiles) {
                    if (Math.abs(x - pt.x) < 60 && Math.abs(z - pt.z) < 60) { invalidSpot = true; break; }
                }
                if (invalidSpot) continue;

                let nearestTown = null;
                let minDist = Infinity;
                townCenters.forEach(tc => {
                    const dist = Math.sqrt((x - tc.x)**2 + (z - tc.z)**2);
                    if (dist < minDist) { minDist = dist; nearestTown = tc; }
                });
                const biomeCfg = (nearestTown && BIOME_BY_TOWN_TYPE[nearestTown.type]) || BIOME_BY_TOWN_TYPE.capital;

                // 町の建物密集地には花畑を作らない（公園ゾーンや田舎側で自然に映える）
                if (nearestTown && minDist < nearestTown.radius * 0.85 && Math.random() > 0.2) continue;

                const density = flowerDensityByBiome[biomeCfg.matBiome] ?? flowerDensityByBiome.default;
                if (Math.random() > density * 0.6) continue;

                // 1箇所に小さな花の塊を6〜12本まとめて咲かせる
                const petalCount = 6 + Math.floor(Math.random() * 7);
                const patchColor = flowerPetalColors[Math.floor(Math.random() * flowerPetalColors.length)];
                for (let p = 0; p < petalCount; p++) {
                    if (flowerInstancedMesh && nextFlowerInstanceIndex < 9000) {
                        const offsetX = (Math.random() - 0.5) * 90;
                        const offsetZ = (Math.random() - 0.5) * 90;
                        const petalHeight = 10 + Math.random() * 8;
                        const petalWidth = 5 + Math.random() * 4;

                        dummyFlower.position.set(x + offsetX, petalHeight / 2, z + offsetZ);
                        dummyFlower.scale.set(petalWidth, petalHeight, petalWidth);
                        dummyFlower.rotation.set(0, Math.random() * Math.PI, 0);
                        dummyFlower.updateMatrix();

                        const petalColor = new THREE.Color(patchColor);
                        petalColor.offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);

                        flowerInstancedMesh.setMatrixAt(nextFlowerInstanceIndex, dummyFlower.matrix);
                        flowerInstancedMesh.setColorAt(nextFlowerInstanceIndex, petalColor);
                        nextFlowerInstanceIndex++;
                    }
                }
            }
            if (flowerInstancedMesh) {
                flowerInstancedMesh.instanceMatrix.needsUpdate = true;
                if (flowerInstancedMesh.instanceColor) flowerInstancedMesh.instanceColor.needsUpdate = true;
            }

            // プールに記録した人間の配置候補地点から、現在の画質プリセットに応じた人数だけ実体化する
            applyHumanDensity(settings.quality);
        }

        let particlesCreatedThisFrame = 0;
        function createParticles(pos, color, count, size, isAtomic = false, customMat = null) {
            // 画質プリセットによる間引き（元のcountが1以上ある限り、最低1個は残す）
            const scaledCount = count > 0 ? Math.max(1, Math.round(count * PARTICLE_COUNT_SCALE)) : count;
            let pCount = scaledCount;
            let finalSize = size;
            
            if (isAtomic) {
                pCount = Math.round(scaledCount * 0.45);
                finalSize = size * 1.4;
                if (particlesCreatedThisFrame > 65) return; 
            } else {
                pCount = Math.min(scaledCount, 35); 
                if (particlesCreatedThisFrame > 90) return;
            }

            const matToUse = customMat ? customMat : (isAtomic ? materials.atomic : getParticleMaterial(color));
            const isBlood = (color === 0xaa0000 || color === 0x990000);

            for (let i = 0; i < pCount; i++) {
                makeParticleRoom(PARTICLE_CAP_NORMAL);
                const p = new THREE.Mesh(geometries.box, matToUse);
                
                if (isBlood) {
                    // 血の飛び散り表現をリアルにするため、しずく状に引き伸ばした不均等なスケールにする
                    p.scale.set(
                        (finalSize * 0.4) * (0.6 + Math.random()),
                        (finalSize * 1.4) * (0.6 + Math.random()),
                        (finalSize * 0.4) * (0.6 + Math.random())
                    );
                } else {
                    p.scale.setScalar(finalSize * (0.6 + Math.random())); 
                }
                p.position.copy(pos);
                
                const isSettleBlocked = isAtomic || customMat === materials.sandDust;
                const settleYValue = isSettleBlocked ? -9999 : 5;

                const v = isAtomic
                    ? new THREE.Vector3((Math.random() - 0.5) * 1200, Math.random() * 2200, (Math.random() - 0.5) * 1200)
                    : new THREE.Vector3((Math.random() - 0.5) * 800,  Math.random() * 900,  (Math.random() - 0.5) * 800);
                
                particles.push({ 
                    mesh: p, 
                    vel: v, 
                    life: isAtomic ? 3.5 : 2.0, 
                    rotVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.2),
                    settleY: settleYValue
                });
                scene.add(p); particlesCreatedThisFrame++;
            }
        }

        // 鋭くはっきりとした軌跡(弧)を描く専用パーティクル生成関数
        function createWindArcParticles(isLeft) {
            const pPos = player.mesh.position;
            const pRot = player.mesh.rotation.y;
            const particleCount = 28; // さらに密度を向上
            
            // スイングの軌道を弧状にマッピング
            const startAngle = isLeft ? 1.1 : -1.1;
            const endAngle = isLeft ? -0.3 : 0.3;
            const radius = activeScaleStage.windArcRadius;
            const particleScale = activeScaleStage.windArcParticleScale;
            
            for (let i = 0; i < particleCount; i++) {
                const t = i / (particleCount - 1);
                const easeT = Math.sin(t * Math.PI / 2);
                const angleOffset = startAngle + (endAngle - startAngle) * easeT;
                const finalAngle = pRot + angleOffset;
                
                // プレイヤーの爪の高さで円弧上の座標を算出
                const localPos = new THREE.Vector3(
                    Math.sin(angleOffset) * radius, 
                    30 * activeScaleStage.visualScale + (Math.random() - 0.5) * 4 * particleScale, // Stageごとの爪の高さへ合わせる
                    Math.cos(angleOffset) * radius
                );
                localPos.applyAxisAngle(new THREE.Vector3(0, 1, 0), pRot);
                const worldPos = pPos.clone().add(localPos);
                
                makeParticleRoom(PARTICLE_CAP_HEAVY);
                
                const p = new THREE.Mesh(geometries.box, materials.windArc);
                
                // 太さと長さを「はっきりと」スケールアップ
                const scaleLen = (8 + Math.random() * 6) * particleScale;
                p.scale.set(2.6 * particleScale, scaleLen, 2.6 * particleScale); // Maxでは承認済みの太さを維持
                p.userData.baseScale = p.scale.clone(); // フェードアウト用に初期スケールを保存
                p.position.copy(worldPos);
                
                // スイング Jun向きに同期
                p.rotation.y = finalAngle + Math.PI / 2;
                p.rotation.z = Math.PI / 4; 
                
                // 弧に沿う放出推進速度（軌道形状を乱さない程度に微速化）
                const flowDir = new THREE.Vector3(Math.cos(finalAngle), 0, -Math.sin(finalAngle)).normalize();
                if (!isLeft) flowDir.negate();
                const v = flowDir.multiplyScalar((45 + Math.random() * 35) * particleScale);
                
                const pLife = 0.45 + Math.random() * 0.25; // 寿命を少し伸ばして空間保持力を強化
                particles.push({
                    mesh: p,
                    vel: v,
                    life: pLife,
                    maxLife: pLife,  // 減衰比率計算用に最大寿命を保持
                    rotVel: new THREE.Vector3(0, 0, 0),
                    settleY: -9999,
                    noGravity: true,  // 重力落下の影響を完全に排除
                    isWindFade: true  // 特殊フェードアウト適用
                });
                scene.add(p);
            }
        }

        function createShockwave(pos, maxRadius, color) {
            const mat = new THREE.MeshBasicMaterial({
                color: color,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.85,
                depthWrite: false
            });
            const mesh = new THREE.Mesh(geometries.ringUnit, mat);
            mesh.position.copy(pos);
            mesh.position.y = 4.0; 
            mesh.rotation.x = -Math.PI / 2;
            scene.add(mesh);
            shockwaves.push({
                mesh: mesh,
                radius: 10,
                maxRadius: maxRadius,
                opacity: 0.85
            });
        }

        function spawnMushroomCloud(pos) {
            playAtomicExplosionSound();
            createParticles(pos, 0xffffff, 80, 50, true);
            createParticles(pos, 0xffaa00, 80, 70, true);

            createParticles(pos, 0xffdd44, 40, 25, false, materials.goldSpark);

            const ringLife = 2.2;
            const decayPerSecond = 1.212;
            const ringSpeed = BOMB_PUSH_RADIUS * decayPerSecond / (1 - Math.exp(-decayPerSecond * ringLife));
            
            const ringCount = Math.max(6, Math.round(26 * PARTICLE_COUNT_SCALE));
            for (let i = 0; i < ringCount; i++) {
                makeParticleRoom(PARTICLE_CAP_HEAVY);
                const angle = (i / ringCount) * Math.PI * 2;
                const p = new THREE.Mesh(geometries.box, materials.atomic);
                p.scale.set(320, 90, 320); p.position.copy(pos); 
                const v = new THREE.Vector3(Math.cos(angle) * ringSpeed, 100, Math.sin(angle) * ringSpeed);
                particles.push({ mesh: p, vel: v, life: ringLife, rotVel: new THREE.Vector3(), settleY: -9999 });
                scene.add(p);
            }
        }

        function leaveScar(pos, radius) {
            const scar = new THREE.Mesh(
                geometries.circleUnit,
                materials.scar
            );
            scar.scale.setScalar(radius * 1.5);
            scar.position.copy(pos); scar.position.y = 1.5; scar.rotation.x = -Math.PI / 2;
            scene.add(scar); scars.push(scar);
            if (scars.length > SCAR_CAP) {
                const old = scars.shift();
                scene.remove(old);
                safeDispose(old);
            }
        }

        // 地面に赤い血溜まりを残すデカール生成処理
        function leaveBloodScar(pos, radius) {
            const scar = new THREE.Mesh(
                geometries.circleUnit,
                materials.bloodScar
            );
            const baseScale = radius * 1.6;
            scar.position.copy(pos); scar.position.y = 1.6; scar.rotation.x = -Math.PI / 2;
            // 少し楕円にするなどして不均等な広がり感を出す
            scar.scale.set(
                baseScale * (1.0 + (Math.random() - 0.5) * 0.25),
                baseScale * (1.0 + (Math.random() - 0.5) * 0.25),
                1.0
            );
            scene.add(scar); scars.push(scar);
            if (scars.length > SCAR_CAP) {
                const old = scars.shift();
                scene.remove(old);
                safeDispose(old);
            }
        }

        function shatterRock(en, hitDir) {
            // 画質プリセットに応じてシャード数を調整（低画質は0＝破片を飛ばさず割れ跡のみ残す）
            const shardCount = ROCK_SHARD_CAP; const baseSize = en.radius * 0.4;
            for (let i = 0; i < shardCount; i++) {
                makeParticleRoom(PARTICLE_CAP_NORMAL);
                const shard = new THREE.Mesh(geometries.dodeca, en.debrisMaterial || materials.rock);
                shard.scale.setScalar(baseSize * (0.6 + Math.random())); shard.position.copy(en.mesh.position); shard.position.y += 15;
                const v = new THREE.Vector3(hitDir.x + (Math.random() - 0.5) * 1.5, 0.5 + Math.random(), hitDir.z + (Math.random() - 0.5) * 1.5).normalize().multiplyScalar(400 + Math.random() * 600);
                particles.push({ mesh: shard, vel: v, life: 3.5, rotVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.15), settleY: 5 });
                scene.add(shard);
            }
            leaveScar(en.mesh.position, en.radius); 
            
            // インスタンス化されているオブジェクトの場合は、該当のモデル（複数パーツの場合は全て）をスケール0にして消去
            if (en.mesh.userData && en.mesh.userData.isInstanced) {
                const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
                en.mesh.userData.instances.forEach(inst => {
                    inst.mesh.setMatrixAt(inst.index, zeroMatrix);
                    inst.mesh.instanceMatrix.needsUpdate = true;
                });
            }
            scene.remove(en.mesh);
        }

        function damageEntity(en, damage, hitDir) {
            if (en.isDead) return;
            en.hp -= damage;
            
            // ゼロ方向ベクトル（立ち止まり時）のNaNバグ徹底排除ガード (バグ修正要望)
            let hDir = (hitDir && hitDir.isVector3) ? hitDir.clone() : new THREE.Vector3();
            if (hDir.lengthSq() < 0.001) {
                hDir.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
            }

            const isDestructibleBuilding = DESTRUCTIBLE_BUILDING_TYPES.has(en.type);
            if (isDestructibleBuilding) {
                if (en.hp <= 0) {
                    buildingHitStopUntil = Math.max(buildingHitStopUntil, performance.now() + 65);
                    shake = Math.max(shake, Math.min(88, 50 + en.radius * 0.21));
                } else {
                    buildingHitStopUntil = Math.max(buildingHitStopUntil, performance.now() + 32);
                    playHitSound(false);
                }
            }

            if (en.type !== 'human') {
                createParticles(en.mesh.position, 0x999999, 5, 12, false, materials.charred);
                createParticles(en.mesh.position, 0xffdd44, 6, 8, false, materials.goldSpark);
            }

            if (en.type === 'boss') {
                renderBossHP(en);
                
                const hpRatio = en.hp / en.maxHp;
                let segmentsToShatter = 0;
                let currentStage = 0;
                
                if (hpRatio <= BOSS_HYPERRAGE_HP_RATIO && en.breakStage < 3) {
                    segmentsToShatter = BOSS_SEGMENTS_PER_STAGE; en.breakStage = 3; currentStage = 3;
                } else if (hpRatio <= BOSS_RAGE_HP_RATIO && en.breakStage < 2) {
                    segmentsToShatter = BOSS_SEGMENTS_PER_STAGE; en.breakStage = 2; currentStage = 2;
                    en.rageMode = true; 
                    
                    en.segments[0].children.forEach(child => {
                        if (child.material && child.material.color && child.material.color.getHex() === 0x00ffcc) {
                            child.material.color.setHex(0xff0000); 
                        }
                    });
                } else if (hpRatio <= BOSS_STAGE1_HP_RATIO && en.breakStage < 1) {
                    segmentsToShatter = BOSS_SEGMENTS_PER_STAGE; en.breakStage = 1; currentStage = 1;
                }

                if (segmentsToShatter > 0 && en.segments.length > 4) {
                    playBoomSound();
                    shake = 200;
                    
                    const popCount = Math.min(segmentsToShatter, en.segments.length - 3);
                    for (let s = 0; s < popCount; s++) {
                        const targetSeg = en.segments.pop(); 
                        if (targetSeg) {
                            createParticles(targetSeg.position, 0xaa0000, 25, 20); 
                            
                            targetSeg.children.forEach(meshChild => {
                                if (meshChild.isMesh) {
                                    makeParticleRoom(PARTICLE_CAP_HEAVY);
                                    meshChild.material = materials.charred;
                                    scene.attach(meshChild);
                                    const v = new THREE.Vector3(
                                        (Math.random() - 0.5) * 600,
                                        300 + Math.random() * 500,
                                        (Math.random() - 0.5) * 600
                                    );
                                    particles.push({
                                        mesh: meshChild,
                                        vel: v,
                                        life: 3.5,
                                        rotVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.12),
                                        settleY: 10
                                    });
                                }
                            });
                        }
                    }
                    
                    document.getElementById('boss-title').innerText = `【部位破壊!!】ギガ・ミミズ (第${currentStage}段階・千断)`;
                    setTimeout(() => {
                        if (bossActive) {
                            document.getElementById('boss-title').innerText = en.rageMode 
                                ? "【狂暴怒り】ギガ・ミミズ" 
                                : "ギガ・ミミズ";
                        }
                    }, 3000);
                }
            }

            shake = Math.max(shake, damage / 7);
            if (en.hp <= 0) {
                en.hp = 0; en.isDead = true;
                if (en.type !== 'tank' && en.type !== 'boss') score += en.scoreVal;
                
                if (player.hp > 0) {
                    let healAmount = 0;
                    if (en.type === 'human') healAmount = 1.0;
                    else if (en.type === 'house') healAmount = 3.0;
                    else if (en.type === 'tower') healAmount = 5.0;
                    else if (en.type === 'church') healAmount = 10.0;
                    else if (en.type === 'school') healAmount = 12.0;
                    else if (en.type === 'rock') healAmount = 2.0;
                    else if (en.type === 'pebble') healAmount = 0.5;
                    else if (en.type === 'barn') healAmount = 3.0;
                    else if (en.type === 'factory') healAmount = 5.0;

                    player.hp = Math.min(player.maxHp, player.hp + healAmount);
                }

                if (en.type === 'human') {
                    playSplatSound(); 
                    
                    // 血の描写強化：血のパーティクル数を大幅増加、血の波紋（ショックウェーブ）、および血溜まり（デカール）を生成
                    createParticles(en.mesh.position, 0xaa0000, 38, 12);
                    createShockwave(en.mesh.position, 160, 0x990000);
                    leaveBloodScar(en.mesh.position, en.radius * 1.5);

                    en.velocity.copy(hDir).multiplyScalar(280); en.velocity.y = 220;
                    en.rotVel.set(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(0.3);
                } else if (en.type === 'boss') {
                    spawnMushroomCloud(en.mesh.position);
                    en.segments.forEach(seg => {
                        makeParticleRoom(PARTICLE_CAP_HEAVY);
                        const v = new THREE.Vector3((Math.random() - 0.5) * 1800, Math.random() * 2500, (Math.random() - 0.5) * 1800);
                        particles.push({ mesh: seg, vel: v, life: 4.5, rotVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5), settleY: 15 });
                    });
                    bossActive = false; 
                    nextBossScore = score + 45000; 
                    document.getElementById('boss-ui').style.display = 'none';
                    document.getElementById('news-ticker').style.display = 'none'; // テロップ非表示
                } else if (en.type === 'rock' || en.type === 'pebble') {
                    playHitSound(false); shatterRock(en, hDir);
                } else if (en.mesh.userData && en.mesh.userData.isInstanced) {
                    // InstancedMesh化されたオブジェクト（現在は木）の破壊処理。
                    // groupに子要素が無いため、元のような「パーツがバラバラに飛ぶ」演出の代わりに
                    // 簡易的な破片パーティクルを手動生成し、インスタンス本体は非表示化する。
                    const ruinScale = 0.6;
                    spawnRuins(en.mesh.position, ruinScale);
                    playHitSound(true);

                    const debrisCount = Math.min(DEBRIS_PIECE_CAP, 6);
                    for (let i = 0; i < debrisCount; i++) {
                        makeParticleRoom(PARTICLE_CAP_NORMAL);
                        // 木の場合: 1つ目は幹（茶色の箱）、残りは葉（記録した色のかけら）にする
                        const isTrunkPiece = (en.type === 'tree' && i === 0);
                        const debrisGeom = isTrunkPiece ? geometries.box : geometries.dodeca;
                        const debrisMat = isTrunkPiece ? materials.treeTrunk : (en.debrisMaterial || materials.charred);
                        const debris = new THREE.Mesh(debrisGeom, debrisMat);
                        debris.scale.setScalar(en.radius * (0.4 + Math.random() * 0.5));
                        debris.position.copy(en.mesh.position); debris.position.y += 20;

                        const v = new THREE.Vector3(
                            hDir.x * 2.2 + (Math.random() - 0.5),
                            0.5 + Math.random() * 0.5,
                            hDir.z * 2.2 + (Math.random() - 0.5)
                        ).normalize().multiplyScalar(240 + Math.random() * 320);

                        const rVel = new THREE.Vector3(
                            Math.random() - 0.5,
                            Math.random() - 0.5,
                            Math.random() - 0.5
                        ).multiplyScalar(0.15);

                        particles.push({ mesh: debris, vel: v, life: 4.0, rotVel: rVel, settleY: 5 });
                        scene.add(debris);
                    }

                    // インスタンス本体（幹・葉）を非表示化
                    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
                    en.mesh.userData.instances.forEach(inst => {
                        inst.mesh.setMatrixAt(inst.index, zeroMatrix);
                        inst.mesh.instanceMatrix.needsUpdate = true;
                    });

                    leaveScar(en.mesh.position, en.radius);
                    scene.remove(en.mesh);
                } else {
                    const ruinScale = (en.type === 'school') ? 2.2 : (en.type === 'church') ? 1.6 : (en.type === 'tower') ? 1.1 : 0.85;
                    spawnRuins(en.mesh.position, ruinScale);

                    playHitSound(true);

                    const partsToExplode = [...en.mesh.children];
                    // 画質プリセットに応じて「バラバラに飛び散る破片」の数を調整（低画質は0＝演出自体をカット）
                    const limitParts = partsToExplode.slice(0, DEBRIS_PIECE_CAP);
                    
                    // パーティクル化しない残りのパーツをメモリ解放
                    partsToExplode.forEach(c => {
                        if (!limitParts.includes(c)) safeDispose(c);
                    });

                    limitParts.forEach(c => {
                        if (c.isMesh) {
                            makeParticleRoom(PARTICLE_CAP_NORMAL);
                            c.material = materials.charred;
                            const worldPos = new THREE.Vector3(); 
                            c.getWorldPosition(worldPos); 
                            scene.attach(c); 
                            
                            // 飛び散る破片パーツが物理演算（落下・回転）で動くよう、マトリクス自動更新をtrueに戻す
                            c.matrixAutoUpdate = true;
                            
                            // 慣性をのせた安全な爆発ベクトル (NaNバグ完全対策)
                            const outwardDir = worldPos.clone().sub(en.mesh.position).setY(0);
                            if (outwardDir.lengthSq() < 0.001) outwardDir.copy(hDir);
                            outwardDir.normalize();
                            const v = new THREE.Vector3(
                                hDir.x * 1.55 + outwardDir.x * 0.75 + (Math.random() - 0.5) * 0.8,
                                0.75 + Math.random() * 1.1,
                                hDir.z * 1.55 + outwardDir.z * 0.75 + (Math.random() - 0.5) * 0.8
                            ).normalize().multiplyScalar(300 + Math.random() * 420);
                            
                            const rVel = new THREE.Vector3(
                                Math.random() - 0.5, 
                                Math.random() - 0.5, 
                                Math.random() - 0.5
                            ).multiplyScalar(0.14);

                            particles.push({ 
                                mesh: c, 
                                vel: v, 
                                life: 4.0, 
                                rotVel: rVel, 
                                settleY: 5 
                            });
                        }
                    });
                    
                    leaveScar(en.mesh.position, en.radius); 
                    scene.remove(en.mesh);
                    if (en.type === 'tank') tankCount--;
                }
            }
        }

        // 指定座標が橋の矩形範囲内にあるかを判定する（人間NPCの水域回避スキップにのみ使用）
        function isOnBridge(x, z, margin = 0) {
            for (const br of bridges) {
                const dx = x - br.x, dz = z - br.z;
                const alongForward = dx * Math.sin(br.angle) + dz * Math.cos(br.angle);
                const alongRight = dx * Math.cos(br.angle) - dz * Math.sin(br.angle);
                if (Math.abs(alongForward) <= br.halfLength + margin && Math.abs(alongRight) <= br.halfWidth) return true;
            }
            return false;
        }

        function pushOutOf(pPos, pRadius, targetPos, targetRadius) {
            const dx = pPos.x - targetPos.x;
            const dz = pPos.z - targetPos.z;
            const distSq = dx * dx + dz * dz;
            const minDist = pRadius + targetRadius;
            if (distSq < minDist * minDist) {
                const dist = Math.sqrt(distSq) || 0.001;
                const nx = dx / dist, nz = dz / dist;
                const overlap = minDist - dist;
                pPos.x += nx * overlap; pPos.z += nz * overlap;
            }
        }

        function handleCollisions() {
            const pPos = player.mesh.position;
            const pRadius = player.radius;
            const mobileCollisionObstacles = [];
            const bossCollisionObstacles = [];
            for (const candidate of entities) {
                if (candidate.isDead) continue;
                if (MOBILE_COLLISION_OBSTACLE_TYPES.has(candidate.type)) mobileCollisionObstacles.push(candidate);
                if (BOSS_COLLISION_OBSTACLE_TYPES.has(candidate.type)) bossCollisionObstacles.push(candidate);
            }

            const playerDistFromCenter = Math.sqrt(pPos.x * pPos.x + pPos.z * pPos.z);
            if (playerDistFromCenter > MAP_RADIUS_LIMIT) {
                const ratio = MAP_RADIUS_LIMIT / playerDistFromCenter;
                pPos.x *= ratio;
                pPos.z *= ratio;
            }
            
            for (let en of entities) {
                if (en.isDead) continue;
                
                // 事前カリング
                if (Math.abs(en.mesh.position.x - pPos.x) > 1200 || 
                    Math.abs(en.mesh.position.z - pPos.z) > 1200) {
                    continue;
                }

                const dSq = en.mesh.position.distanceToSquared(pPos);
                if (dSq > 1200 * 1200) continue; 

                if (en.type === 'house' || en.type === 'rock' || en.type === 'pebble' || en.type === 'tower' || en.type === 'church' || en.type === 'school' || en.type === 'militaryBase' || en.type === 'barn' || en.type === 'factory') {
                    pushOutOf(pPos, pRadius, en.mesh.position, en.radius);
                } else if (en.type === 'boss') {
                    if (en.mesh.position.y < -10) continue;
                    if (en.aiState === 'breach') continue; // ジャンプ中（空中）は水平方向だけの当たり判定で押し出さない
                    if (player.knockbackGraceTimer > 0) continue; // ノックバック演出中は、めり込み解消で打ち消さない
                    for (const seg of en.segments) {
                        const segRadius = seg.userData.radius || 100;
                        pushOutOf(pPos, pRadius, seg.position, segRadius * 0.85);
                    }
                }
            }

            for (let en of entities) {
                if (en.isDead) continue;
                if (en.type === 'human' || en.type === 'tank') {
                    if (Math.abs(en.mesh.position.x - pPos.x) > 3000 || 
                        Math.abs(en.mesh.position.z - pPos.z) > 3000) continue;

                    const pToEnSq = en.mesh.position.distanceToSquared(pPos);
                    if (pToEnSq > 3000 * 3000) continue; 

                    for (let obstacle of mobileCollisionObstacles) {
                        if (obstacle === en) continue;
                        const maxDist = en.radius + obstacle.radius;
                        if (Math.abs(en.mesh.position.x - obstacle.mesh.position.x) > maxDist ||
                            Math.abs(en.mesh.position.z - obstacle.mesh.position.z) > maxDist) continue;

                        pushOutOf(en.mesh.position, en.radius, obstacle.mesh.position, obstacle.radius);
                    }
                }
            }

            // --- 人間NPCの水域回避処理 ---
            // 建物avoidance処理（上のobstacle.type === 'house' ... の分岐）とは別ブロックとして追記。
            // 戦車・プレイヤーは水域の移動制限を受けないため、ここでは人間NPCのみを対象にする。
            for (let en of entities) {
                if (en.isDead || en.type !== 'human') continue;
                // 橋に入る直前の陸地（マージン 85px）でも川からの押し戻し衝突を無視し、進入スタックを完全に防止
                if (isOnBridge(en.mesh.position.x, en.mesh.position.z, 85)) continue; // 橋の上では水域回避を無視し、渡れるようにする
                for (const wz of waterZones) {
                    const dx = en.mesh.position.x - wz.x, dz = en.mesh.position.z - wz.z;
                    const limitDist = en.radius + wz.radius;
                    if (Math.abs(dx) > limitDist || Math.abs(dz) > limitDist) continue;

                    // 実際に水域へめり込んでいた場合のみ、押し戻し方向（外向き法線）を記憶する
                    // →この後の逃走移動で「岸沿いに走る」動きへブレンドし、同じ場所への再突入を防ぐ
                    const distSqToWater = dx * dx + dz * dz;
                    if (distSqToWater < limitDist * limitDist) {
                        const distToWater = Math.sqrt(distSqToWater) || 0.001;
                        en.waterAvoidDir.set(dx / distToWater, 0, dz / distToWater);
                        en.waterAvoidTimer = HUMAN_WATER_AVOID_DURATION;
                    }

                    pushOutOf(en.mesh.position, en.radius, wz, wz.radius);
                }
            }

            for (let en of entities) {
                if (en.isDead || en.type !== 'boss') continue;
                if (en.mesh.position.y < -35) continue; 
                
                for (const seg of en.segments) {
                    const segRadius = seg.userData.radius || 100;
                    const segPos = seg.position;

                    for (let obstacle of bossCollisionObstacles) {
                        if (obstacle.isDead) continue;
                        const limitDist = segRadius + obstacle.radius;
                        if (Math.abs(obstacle.mesh.position.x - segPos.x) > limitDist ||
                            Math.abs(obstacle.mesh.position.z - segPos.z) > limitDist) continue;
                        
                        const distSq = obstacle.mesh.position.distanceToSquared(segPos);
                        if (distSq < limitDist * limitDist) {
                            const pushDir = obstacle.mesh.position.clone().sub(segPos).setY(0).normalize();
                            damageEntity(obstacle, obstacle.hp, pushDir);
                            playHitSound(true);
                        }
                    }
                }
            }

        }

        function explodeAt(center, damageRadius, damageAmount, pushRadius, excludeType = null, damageFilter = null) {
            const radSq = damageRadius * damageRadius;
            const pushSq = pushRadius * pushRadius;
            for (let en of entities) {
                if (en.isDead) continue;
                if (excludeType && en.type === excludeType) continue; 
                if (damageFilter && !damageFilter(en)) continue;
                
                // 事前カリング
                if (Math.abs(en.mesh.position.x - center.x) > pushRadius || 
                    Math.abs(en.mesh.position.z - center.z) > pushRadius) {
                    continue;
                }

                let finalDmg = damageAmount;
                if (en.type === 'boss') {
                    if (en.mesh.position.y < -30) {
                        finalDmg = damageAmount * 0.05; 
                    } 
                    else if (en.aiState === 'recover') {
                        finalDmg = damageAmount * 1.5;
                        shake = Math.max(shake, 120);
                        createParticles(en.mesh.position, 0xffeb3b, 20, 25); 
                    }
                }

                const isUnderground = (en.type === 'boss' && en.mesh.position.y < -10);
                const dSq = en.mesh.position.distanceToSquared(center);
                if (dSq < radSq) {
                    const dmg = isUnderground ? finalDmg * 0.5 : finalDmg;
                    
                    // centerとオブジェクトが同一点にいる場合のNaN除算ガード
                    let pDir = en.mesh.position.clone().sub(center);
                    if (pDir.lengthSq() < 0.001) {
                        pDir.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                    } else {
                        pDir.normalize();
                    }
                    damageEntity(en, dmg, pDir);
                } else if (dSq < pushSq && !isUnderground) {
                    let pushDir = en.mesh.position.clone().sub(center);
                    if (pushDir.lengthSq() < 0.001) {
                        pushDir.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                    } else {
                        pushDir.normalize();
                    }
                    en.pushVel.add(pushDir.multiplyScalar(400 * (1 - Math.sqrt(dSq) / pushRadius)));
                }
            }
        }

        function attack(isLeft) {
            if (!player.hp || player.hp <= 0) return;
            const now = Date.now();
            if (now - lastAttackTime < ATTACK_COOLDOWN) return;
            lastAttackTime = now; playSwishSound();
            
            // 振りかぶり→薙ぎ払い 補間アニメーションパラメータのセット
            if (isLeft) {
                player.attackLTimer = 0.25;
            } else {
                player.attackRTimer = 0.25;
            }
            player.attackType = 'single';
            
            // 美しい白い弧の軌跡粒子のみを生成（ソリッドな板エフェクトは削除）
            createWindArcParticles(isLeft);

            // 行う手によって当たり判定位置を変更 (左手は左前方、右手は右前方)
            const hitPos = player.mesh.position.clone().add(
                new THREE.Vector3(
                    isLeft ? activeScaleStage.attackOffsetX : -activeScaleStage.attackOffsetX,
                    0,
                    activeScaleStage.attackOffsetZ
                ).applyAxisAngle(new THREE.Vector3(0, 1, 0), player.mesh.rotation.y)
            );
            const hitRad = activeScaleStage.singleAttackRadius;
            const hitRadSq = hitRad * hitRad; // 手が偏っている分、個別判定の半径を既存 of 500 から 350 に調整
            
            for (let en of entities) {
                if (!en.isDead) {
                    if (!canScaleStageDamageTarget(activeScaleStageId, en)) continue;
                    if (en.type === 'boss' && en.mesh.position.y < -20) continue;
                    
                    if (Math.abs(en.mesh.position.x - hitPos.x) > hitRad ||
                        Math.abs(en.mesh.position.z - hitPos.z) > hitRad) continue;

                    if (en.mesh.position.distanceToSquared(hitPos) < hitRadSq) {
                        const scaleDmg = (en.type === 'boss' && en.aiState === 'recover') ? 550 * 1.5 : 550;
                        
                        // ハサミのヒットベクトル安全化
                        let hitVec = en.mesh.position.clone().sub(player.mesh.position);
                        if (hitVec.lengthSq() < 0.001) {
                            hitVec.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                        } else {
                            hitVec.normalize();
                        }
                        damageEntity(en, scaleDmg, hitVec);
                    }
                }
            }
        }

        // ダブルパンチ攻撃関数
        function attackDouble() {
            if (!player.hp || player.hp <= 0) return;
            const now = Date.now();
            if (now - lastAttackTime < ATTACK_COOLDOWN) return;
            lastAttackTime = now;
            playSwishSound();
            playSwishSound(); // 厚みを出すために2回再生

            // 両腕クラッシュ 補間アニメーションパラメータのセット
            player.attackLTimer = 0.28;
            player.attackRTimer = 0.28;
            player.attackType = 'double';

            // 美しい白い弧の軌跡粒子のみを生成（ソリッドな板エフェクトは削除）
            createWindArcParticles(true);
            createWindArcParticles(false);

            // 左右両方の領域に当たり判定座標をセット
            const hitPosL = player.mesh.position.clone().add(
                new THREE.Vector3(activeScaleStage.attackOffsetX, 0, activeScaleStage.attackOffsetZ)
                    .applyAxisAngle(new THREE.Vector3(0, 1, 0), player.mesh.rotation.y)
            );
            const hitPosR = player.mesh.position.clone().add(
                new THREE.Vector3(-activeScaleStage.attackOffsetX, 0, activeScaleStage.attackOffsetZ)
                    .applyAxisAngle(new THREE.Vector3(0, 1, 0), player.mesh.rotation.y)
            );
            const hitRad = activeScaleStage.doubleAttackRadius;
            const hitRadSq = hitRad * hitRad;

            for (let en of entities) {
                if (!en.isDead) {
                    if (!canScaleStageDamageTarget(activeScaleStageId, en)) continue;
                    if (en.type === 'boss' && en.mesh.position.y < -20) continue;
                    
                    const dxL = Math.abs(en.mesh.position.x - hitPosL.x);
                    const dzL = Math.abs(en.mesh.position.z - hitPosL.z);
                    const dxR = Math.abs(en.mesh.position.x - hitPosR.x);
                    const dzR = Math.abs(en.mesh.position.z - hitPosR.z);
                    
                    if ((dxL > hitRad || dzL > hitRad) && (dxR > hitRad || dzR > hitRad)) continue;

                    const dLSq = en.mesh.position.distanceToSquared(hitPosL);
                    const dRSq = en.mesh.position.distanceToSquared(hitPosR);
                    if (dLSq < hitRadSq || dRSq < hitRadSq) {
                        const scaleDmg = (en.type === 'boss' && en.aiState === 'recover') ? 650 * 1.5 : 650;
                        
                        let hitVec = en.mesh.position.clone().sub(player.mesh.position);
                        if (hitVec.lengthSq() < 0.001) {
                            hitVec.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                        } else {
                            hitVec.normalize();
                        }
                        damageEntity(en, scaleDmg, hitVec);
                    }
                }
            }
        }

        function updateLobbyAnimation(delta, dtScale, time) {
            const lobbyTerrainY = getTerrainHeight(0, 5200);
            
            // 咆哮前、街を見据えて静かに構える巨大生物の演出（地面高さ＋呼吸上下動）
            player.mesh.position.y = lobbyTerrainY + Math.sin(time * 0.5) * 5.0; 
            
            // カニの向きの上書きをカメラ（手前右側）に正対する角度へ修正
            player.mesh.rotation.y = Math.atan2(220, 380) + Math.sin(time * 0.15) * 0.04; 
            player.mesh.rotation.z = 0;

            // ハサミを低い位置でゆっくり開閉させる、威嚇するような重い動き
            player.clawL.position.y = 30 + Math.sin(time * 0.7) * 8;
            player.clawL.rotation.z = 0.12 + Math.sin(time * 0.7) * 0.08;
            player.clawR.position.y = 30 - Math.sin(time * 0.7) * 8;
            player.clawR.rotation.z = -0.12 - Math.sin(time * 0.7) * 0.08;

            player.legs.forEach((l, i) => {
                l.rotation.x = Math.sin(time * 0.6 + i) * 0.12;
            });

            // 手前のカニが大きく映り、右奥に世界の中心方向の街と遠景が収まるようにカメラ位置をスライド制御
            camera.position.set(
                220 + Math.sin(time * 0.08) * 15, 
                lobbyTerrainY + 80 + Math.sin(time * 0.2) * 3, 
                5580 + Math.cos(time * 0.08) * 15
            );
            camera.lookAt(-40, lobbyTerrainY + 50, 5200);

            // --- 【デザイン改修】停滞して燃え続ける巨大なキノコ雲 ---
            if (!window.lobbyMushroomCloud) {
                window.lobbyMushroomCloud = new THREE.Group();
                // カニからさらに遠く離れた奥に配置 (Zを1500から-500に変更)
                const basePos = new THREE.Vector3(0, 0, -500); 
                window.lobbyMushroomCloud.position.copy(basePos);
                
                // 遠くした分、全体をさらに1.3倍に巨大化して迫力を維持
                window.lobbyMushroomCloud.scale.setScalar(1.3);
                
                scene.add(window.lobbyMushroomCloud);

                // 共通のマテリアル生成関数（炎と黒煙）
                const createMat = (isFire) => {
                    const col = isFire ? (Math.random() < 0.5 ? 0xff4400 : 0xffaa00) : 0x1a1a1a;
                    return new THREE.MeshPhongMaterial({
                        color: col, emissive: isFire ? col : 0x000000,
                        emissiveIntensity: isFire ? 1.2 : 0, transparent: true, opacity: 0.95, shininess: 0
                    });
                };

                // 1. 根元の土煙（ベースサージ）
                for (let i = 0; i < 50; i++) {
                    const isFire = Math.random() < 0.2; // 根元は煙を多めに
                    const cp = new THREE.Mesh(geometries.box, createMat(isFire));
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 200 + Math.random() * 700; // 横に広く
                    cp.position.set(Math.cos(angle) * dist, Math.random() * 250, Math.sin(angle) * dist);
                    cp.scale.setScalar(150 + Math.random() * 200);
                    cp.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
                    window.lobbyMushroomCloud.add(cp);
                }

                // 2. 茎（柱）の部分
                for (let i = 0; i < 80; i++) {
                    const isFire = Math.random() < 0.4;
                    const cp = new THREE.Mesh(geometries.box, createMat(isFire));
                    const height = 100 + Math.random() * 1000;
                    // 上に行くほど少し太くなるように計算
                    const radius = (40 + Math.random() * 120) * (1.0 + height / 1000); 
                    const angle = Math.random() * Math.PI * 2;
                    cp.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
                    cp.scale.setScalar(150 + Math.random() * 200);
                    cp.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
                    window.lobbyMushroomCloud.add(cp);
                }
                
                // 3. 傘の部分
                for (let i = 0; i < 200; i++) {
                    const isFire = Math.random() < 0.5;
                    const cp = new THREE.Mesh(geometries.box, createMat(isFire));
                    
                    const angle = Math.random() * Math.PI * 2;
                    // 中心に少し密集させつつ、最大半径1000まで広げる
                    const dist = Math.pow(Math.random(), 0.6) * 1000; 
                    
                    // ドーム状の高さ計算（中心が高く、外側が低い）
                    const domeHeight = Math.cos((dist / 1000) * (Math.PI / 2)) * 400; 
                    // 基準の高さ1100にドームの高さとランダムな厚みを足す
                    const height = 1100 + domeHeight + (Math.random() - 0.5) * 350;
                    
                    cp.position.set(Math.cos(angle) * dist, height, Math.sin(angle) * dist);
                    
                    // 外側ほどブロックを少し大きくしてボリュームを出す
                    const sizeBase = 200 + (dist / 1000) * 150;
                    cp.scale.setScalar(sizeBase + Math.random() * 200);
                    cp.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
                    window.lobbyMushroomCloud.add(cp);
                }
            }
            
            // キノコ雲をゆっくり回転させ、マグマのように炎を明滅させる
            if (window.lobbyMushroomCloud) {
                window.lobbyMushroomCloud.rotation.y += 0.03 * delta; // 巨大感を出すため回転を少しゆっくりに
                window.lobbyMushroomCloud.children.forEach((child, index) => {
                    if (child.material.emissiveIntensity > 0) {
                        child.material.emissiveIntensity = 0.8 + Math.sin(time * 3.0 + index) * 0.5;
                    }
                });
            }

            // 崩れ落ちる灰・砂塵を静かに降らせる演出
            const lobbyAshEvents = referenceFrameEventCount(0.35, dtScale);
            for (let ashEvent = 0; ashEvent < lobbyAshEvents; ashEvent++) {
                if (particles.length >= PARTICLE_CAP_NORMAL) break;
                const pMat = ashMaterials[Math.floor(Math.random() * ashMaterials.length)];
                const cp = new THREE.Mesh(geometries.box, pMat);
                cp.scale.set(2 + Math.random() * 3, 2 + Math.random() * 3, 2 + Math.random() * 3);
                cp.position.set(
                    (Math.random() - 0.5) * 700,
                    180 + Math.random() * 120,
                    (Math.random() - 0.5) * 300
                );
                const cv = new THREE.Vector3((Math.random() - 0.5) * 15, -25 - Math.random() * 20, (Math.random() - 0.5) * 15);
                particles.push({
                    mesh: cp,
                    vel: cv,
                    life: 4.5,
                    rotVel: new THREE.Vector3(Math.random() * 1.5, Math.random() * 1.5, Math.random() * 1.5),
                    settleY: -50
                });
                scene.add(cp);
            }

            // 待機画面内での砂塵・きのこ雲パーティクルの更新処理
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.mesh.position.addScaledVector(p.vel, delta);
                
                if (!p.noGravity) {
                    p.vel.y -= 25 * dtScale;
                }
                p.vel.multiplyScalar(Math.pow(0.98, dtScale));
                p.mesh.rotation.x += p.rotVel.x * dtScale;
                p.mesh.rotation.y += p.rotVel.y * dtScale;
                p.life -= delta;
                if ((!p.noGravity && p.mesh.position.y < -100) || p.life <= 0) {
                    scene.remove(p.mesh);
                    safeDispose(p.mesh);
                    particles.splice(i, 1);
                }
            }
        }

        // --- DROP（急降下）演出の更新 ---
        // animate() から isDropping 時のみ呼び出される。ロジックは元のまま。
        function updateDropSequence(dtScale, time) {
            dropVelY -= 1.6 * dtScale;
            player.mesh.position.y += dropVelY * dtScale;

            // 落下中は空中で脚を超高速ジタバタ動かす
            player.legs.forEach((l, i) => {
                l.rotation.x = Math.sin(time * 30.0 + i) * 1.5;
            });
            player.clawL.position.y = 45; player.clawR.position.y = 45;

            // カメラがプレイヤーの後ろから追従しながら降下
            camera.position.set(
                player.mesh.position.x,
                player.mesh.position.y + 350,
                player.mesh.position.z - 380
            );
            camera.lookAt(player.mesh.position.x, player.mesh.position.y, player.mesh.position.z);

            // 着地した瞬間
            if (player.mesh.position.y <= 0) {
                player.mesh.position.y = 0;
                isDropping = false;
                gameRunning = true;

                // ドロップ着地時の巨大な衝撃波＆煙エフェクト
                shake = 180;
                playBoomSound();
                explodeAt(player.mesh.position, 600, 1000, 1200);
                createShockwave(player.mesh.position, 650, 0xff3300);
                createShockwave(player.mesh.position, 420, 0xffaa00);
                createParticles(player.mesh.position, 0xa08060, 30, 60, false, materials.sandDust);

                // UIを表示して本編へ移行
                document.getElementById('ui').style.display = 'block';
            }
        }

        function animate() {
            animationId = requestAnimationFrame(animate);
            const nowMs = performance.now();

            // --- FPS上限（発熱・電池消費対策）：目標間隔に達していないフレームは処理・描画をスキップ ---
            // 注意：ここでclock.getDelta()を呼んで経過時間を捨てると、間引いた分だけ
            // ゲーム内時間の進みが遅れてスローモーションになってしまうため、絶対に呼ばない。
            // 経過時間はそのままclockに貯めておき、次に実際に処理するフレームでまとめて消費する。
            if (settings.fpsCap > 0) {
                const minInterval = 1000 / settings.fpsCap;
                if (nowMs - lastRenderedFrameTime < minInterval) {
                    return;
                }
                lastRenderedFrameTime = nowMs;
            }

            if (isPaused) {
                clock.getDelta(); // ポーズ中も時計を進めて蓄積バグを防ぐ
                return;
            }

            // --- FPSカウンター計測（0.5秒ごとに表示更新） ---
            // FPS上限でスキップされたフレームやポーズ中は数えず、実際に処理・描画されたフレームのみを数える
            // （こうしないとFPS上限を設定してもカウンター表示が上限と一致しない）
            fpsFrameCount++;
            const sampleElapsed = nowMs - fpsLastSampleTime;
            if (sampleElapsed >= 500) {
                lastFps = Math.round((fpsFrameCount * 1000) / sampleElapsed);
                if (settings.showFpsCounter) {
                    const fpsEl = document.getElementById('fps-counter');
                    if (fpsEl) fpsEl.innerText = 'FPS: ' + lastFps;
                }
                fpsFrameCount = 0;
                fpsLastSampleTime = nowMs;
            }

            let rawDelta = clock.getDelta();
            let delta = rawDelta;
            // 【死亡演出】死亡中はすべてのゲーム内の時間の進行を15%に超減速（スローモーション化）
            if (player.isDying) delta *= 0.15;
            if (nowMs < buildingHitStopUntil) delta = 0;
            
            const dtScale = Math.min(delta * 60, 4); // 2から4に引き上げ、処理落ち時のスローモーションを緩和
            const time = Date.now() * 0.005;
            particlesCreatedThisFrame = 0;

            const pPos = player.mesh.position;
            const difficultyScale = Math.min(1.5, 1.0 + score * 0.000005);

            // --- スタート待機画面（フォールガイズ風ロビー）の更新ループ ---
            if (isMenu) {
                updateLobbyAnimation(delta, dtScale, time);
                rendererController.render();
                return;
            }

            // --- DROP（急降下）演出 of 処理 ---
            if (isDropping) {
                updateDropSequence(dtScale, time);
                rendererController.render();
                return;
            }

            // --- 通常のゲーム本編ループ ---
            // 雲をゆっくり流す
            clouds.forEach(c => {
                c.mesh.position.x += c.speed * dtScale;
                if (c.mesh.position.x > 14000) {
                    c.mesh.position.x = -14000;
                    c.mesh.position.z = (Math.random() - 0.5) * 28000;
                }
            });

            for (let i = 0; i < entities.length; i++) {
                const en = entities[i];
                
                if (en.isDead && en.type === 'human') {
                    continue; // 後半のループで処理するためここではスキップのみ
                }

                const dx = en.mesh.position.x - pPos.x;
                const dz = en.mesh.position.z - pPos.z;
                
                // 事前カリングで遠すぎるオブジェクトの計算をスキップ
                if (Math.abs(dx) > 7500 || Math.abs(dz) > 7500) {
                    if (en.mesh.visible) {
                        en.mesh.visible = false;
                        if (en.currentCastShadow !== false) {
                            en.mesh.traverse(child => {
                                if (child.isMesh) {
                                    child.castShadow = false;
                                    child.receiveShadow = false;
                                }
                            });
                            en.currentCastShadow = false;
                        }
                    }
                    continue;
                }

                const distSq = dx * dx + dz * dz;

                if (distSq > ACTIVE_DISTANCE_SQ) {
                    if (en.mesh.visible) {
                        en.mesh.visible = false;
                        if (en.currentCastShadow !== false) {
                            en.mesh.traverse(child => {
                                if (child.isMesh) {
                                    child.castShadow = false;
                                    child.receiveShadow = false;
                                }
                            });
                            en.currentCastShadow = false;
                        }
                    }
                } else {
                    if (!en.mesh.visible) {
                        en.mesh.visible = true;
                    }
                    
                    // シャドウ更新最適化：状態が変わった時だけ traverse を呼ぶ
                    const needShadow = distSq < SHADOW_DISTANCE_SQ && en.baseCastShadow;
                    if (en.currentCastShadow !== needShadow) {
                        en.mesh.traverse(child => {
                            if (child.isMesh) {
                                child.castShadow = needShadow;
                                child.receiveShadow = true;
                            }
                        });
                        en.currentCastShadow = needShadow;
                    }
                }
            }

            // HPが0より大きく、かつ死亡演出中でない場合のみ操作を受け付ける
            if (player.hp > 0 && !player.isDying) {
                const moveVec = new THREE.Vector3();
                const inputSnapshot = inputController.getInputSnapshot();
                
                if (isIntroPlaying) {
                    // オープニング演出中は強制的に前進（陸へ上がる）
                    moveVec.z = -1; 
                } else {
                    if (inputSnapshot.isPressed('KeyW')) moveVec.z -= 1;
                    if (inputSnapshot.isPressed('KeyS')) moveVec.z += 1;
                    if (inputSnapshot.isPressed('KeyA')) moveVec.x -= 1;
                    if (inputSnapshot.isPressed('KeyD')) moveVec.x += 1;
                }

                if (inputSnapshot.isPressed('Space') && player.isGrounded && !isIntroPlaying) { player.yVel = activeScaleStage.jumpVelocity; player.isGrounded = false; }
                if (!player.isGrounded) {
                    player.yVel -= activeScaleStage.gravity * dtScale; player.mesh.position.y += player.yVel * dtScale;
                    if (player.mesh.position.y <= 0) {
                        player.mesh.position.y = 0; player.isGrounded = true;
                        
                        shake = activeScaleStage.landingShake;
                        explodeAt(
                            player.mesh.position,
                            activeScaleStage.landingRadius,
                            800,
                            activeScaleStage.landingPushRadius,
                            null,
                            en => canScaleStageDamageTarget(activeScaleStageId, en)
                        );
                        playHitSound(true);

                        createShockwave(player.mesh.position, activeScaleStage.landingRadius * 1.1, 0xff3300);
                        createShockwave(player.mesh.position, activeScaleStage.landingRadius * 0.76, 0xffaa00);

                        const landingEffectScale = Math.max(0.35, activeScaleStage.visualScale);
                        const landDustCount = Math.max(4, Math.round(14 * activeScaleStage.visualScale));
                        for (let j = 0; j < landDustCount; j++) {
                            makeParticleRoom(PARTICLE_CAP_HEAVY);
                            const angle = (j / landDustCount) * Math.PI * 2;
                            const p = new THREE.Mesh(geometries.box, materials.sandDust);
                            p.scale.setScalar((15 + Math.random() * 20) * landingEffectScale);
                            p.position.copy(player.mesh.position);
                            p.position.y = 5;
                            const speed = (400 + Math.random() * 500) * landingEffectScale;
                            const v = new THREE.Vector3(Math.cos(angle) * speed, 10 + Math.random() * 80, Math.sin(angle) * speed);
                            particles.push({
                                mesh: p,
                                vel: v,
                                life: 1.0 + Math.random(),
                                rotVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5),
                                settleY: -9999 
                            });
                            scene.add(p);
                        }
                    }
                }
                
                if (player.debuffTimer > 0) {
                    player.debuffTimer -= delta;
                    const debuffParticleEvents = referenceFrameEventCount(0.2, dtScale);
                    for (let debuffEvent = 0; debuffEvent < debuffParticleEvents; debuffEvent++) {
                        createParticles(player.mesh.position, 0x39ff14, 2, 8);
                    }
                }

                if (player.knockbackGraceTimer > 0) {
                    player.knockbackGraceTimer -= delta;
                }

                // ノックバックの適用・減衰（他の敵の吹き飛ばし処理と同じ式に揃えています）
                if (player.pushVel.lengthSq() > 0.1) {
                    player.mesh.position.addScaledVector(player.pushVel, delta);
                    player.pushVel.multiplyScalar(Math.pow(0.85, dtScale));
                } else {
                    player.pushVel.set(0, 0, 0);
                }

                const speedMult = player.debuffTimer > 0 ? DEBUFF_SPEED_MULT : 1.0;
                // 演出中は歩行速度を約3.5割（0.35）に落とし、のっそりとした前進にします
                const currentMoveSpeed = activeScaleStage.movementSpeed * speedMult * (isIntroPlaying ? 0.35 : 1.0) * (debugState.noclip ? DEBUG_NOCLIP_SPEED_MULT : 1.0);

                // --- プレイヤー胴体および脚のアニメーションリセット ---
                player.mesh.rotation.x = 0;
                player.mesh.rotation.z = 0;

                if (moveVec.length() > 0) {
                    moveVec.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
                    player.mesh.position.addScaledVector(moveVec, currentMoveSpeed * dtScale);
                    player.mesh.rotation.y = Math.atan2(moveVec.x, moveVec.z);
                    player.moveDir.copy(moveVec);
                    if (player.isGrounded) {
                        // イントロ演出中は脚の動く周期を遅くし、体の跳ね上がりを低くすることで重厚感を出します
                        const motionTime = isIntroPlaying ? time * 0.4 : time;
                        const legSpeed = isIntroPlaying ? 3.0 : 6.0;
                        const legLift = isIntroPlaying ? 4.0 : 10.0;
                        const bodyBounce = isIntroPlaying ? 8.0 : 20.0;

                        player.legs.forEach((l, i) => { 
                            const offset = i * 0.5;
                            l.rotation.x = Math.sin(motionTime * legSpeed + offset) * 0.8;
                            l.position.y = Math.max(0, Math.sin(motionTime * (legSpeed * 2) + offset) * legLift); // 地面を蹴って跳ねる挙動
                        });
                        player.mesh.position.y = Math.abs(Math.sin(motionTime * 5)) * bodyBounce;
                    }
                } else if (player.isGrounded) {
                    player.mesh.position.y = 0;
                    player.moveDir.set(0, 0, 0);
                    player.legs.forEach((l, i) => { 
                        l.rotation.x = 0; 
                        l.position.y = 0; 
                    });
                }

                // --- 左右ハサミの攻撃スイング＆踏み込み補間モーション処理 ---
                const defLPos = new THREE.Vector3(85, 30, 5);
                const defRPos = new THREE.Vector3(-85, 30, 5);

                if (player.attackLTimer > 0) {
                    player.attackLTimer -= delta;
                    const progress = (0.25 - player.attackLTimer) / 0.25; // 0.0 -> 1.0

                    if (player.attackType === 'double') {
                        const doubleProg = (0.28 - player.attackLTimer) / 0.28;
                        // 左右同時に内側に大きく挟み込む（クラッシュ）ダイナミックモーション
                        let tz = 5;
                        let tx = 85;
                        let ry = 0;
                        if (doubleProg < 0.4) {
                            const t = doubleProg / 0.4;
                            tz = 5 + 130 * Math.sin(t * Math.PI / 2);
                            tx = 85 - 35 * Math.sin(t * Math.PI / 2);
                            ry = -0.6 * Math.sin(t * Math.PI / 2); // 内側に傾ける
                        } else {
                            const t = (doubleProg - 0.4) / 0.6;
                            tz = 135 - 130 * Math.sin(t * Math.PI / 2);
                            tx = 50 + 35 * Math.sin(t * Math.PI / 2);
                            ry = -0.6 + 0.6 * Math.sin(t * Math.PI / 2);
                        }
                        player.clawL.position.set(tx, 30, tz);
                        player.clawL.rotation.y = ry;
                        
                        // 踏み込みによる胴体の前傾・沈み込み
                        player.mesh.rotation.x = 0.15 * Math.sin(doubleProg * Math.PI);
                        player.mesh.position.y += 8 * Math.sin(doubleProg * Math.PI);
                    } else {
                        // 左手：外側に振りかぶってから内側へ鋭く斬りつける(薙ぎ払い)モーション
                        let tz = 5;
                        let tx = 85;
                        let ry = 0;
                        if (progress < 0.35) {
                            // 溜め：外側後方へハサミを引く
                            const t = progress / 0.35;
                            tx = 85 + 30 * Math.sin(t * Math.PI / 2);
                            tz = 5 - 15 * Math.sin(t * Math.PI / 2);
                            ry = 0.4 * Math.sin(t * Math.PI / 2);
                        } else {
                            // 斬撃＆引き戻し
                            const t = (progress - 0.35) / 0.65;
                            tx = 115 - 65 * Math.sin(t * Math.PI / 2); // 内側へ弧を描く
                            tz = -10 + 125 * Math.sin(t * Math.PI / 2); // 前方へ一閃
                            ry = 0.4 - 1.2 * Math.sin(t * Math.PI / 2); // 鋭い刃先旋回
                            if (t > 0.5) {
                                const t2 = (t - 0.5) / 0.5;
                                tx = tx + (85 - tx) * t2;
                                tz = tz + (5 - tz) * t2;
                                ry = ry + (0 - ry) * t2;
                            }
                        }
                        player.clawL.position.set(tx, 30, tz);
                        player.clawL.rotation.y = ry;

                        // 薙ぎ払いの方向へ胴体がわずかに傾く（力の連動）
                        player.mesh.rotation.y += 0.08 * Math.sin(progress * Math.PI);
                    }
                } else {
                    player.clawL.position.lerp(defLPos, 0.25 * dtScale);
                    player.clawL.rotation.y += (0 - player.clawL.rotation.y) * 0.25 * dtScale;
                }

                if (player.attackRTimer > 0) {
                    player.attackRTimer -= delta;
                    const progress = (0.25 - player.attackRTimer) / 0.25;

                    if (player.attackType === 'double') {
                        const doubleProg = (0.28 - player.attackRTimer) / 0.28;
                        let tz = 5;
                        let tx = -85;
                        let ry = 0;
                        if (doubleProg < 0.4) {
                            const t = doubleProg / 0.4;
                            tz = 5 + 130 * Math.sin(t * Math.PI / 2);
                            tx = -85 + 35 * Math.sin(t * Math.PI / 2);
                            ry = 0.6 * Math.sin(t * Math.PI / 2);
                        } else {
                            const t = (doubleProg - 0.4) / 0.6;
                            tz = 135 - 130 * Math.sin(t * Math.PI / 2);
                            tx = -50 - 35 * Math.sin(t * Math.PI / 2);
                            ry = 0.6 - 0.6 * Math.sin(t * Math.PI / 2);
                        }
                        player.clawR.position.set(tx, 30, tz);
                        player.clawR.rotation.y = ry;
                    } else {
                        // 右手：外側に振りかぶってから内側へ鋭く斬りつける(薙ぎ払い)モーション
                        let tz = 5;
                        let tx = -85;
                        let ry = 0;
                        if (progress < 0.35) {
                            const t = progress / 0.35;
                            tx = -85 - 30 * Math.sin(t * Math.PI / 2);
                            tz = 5 - 15 * Math.sin(t * Math.PI / 2);
                            ry = -0.4 * Math.sin(t * Math.PI / 2);
                        } else {
                            const t = (progress - 0.35) / 0.65;
                            tx = -115 + 65 * Math.sin(t * Math.PI / 2);
                            tz = -10 + 125 * Math.sin(t * Math.PI / 2);
                            ry = -0.4 + 1.2 * Math.sin(t * Math.PI / 2);
                            if (t > 0.5) {
                                const t2 = (t - 0.5) / 0.5;
                                tx = tx + (-85 - tx) * t2;
                                tz = tz + (5 - tz) * t2;
                                ry = ry + (0 - ry) * t2;
                            }
                        }
                        player.clawR.position.set(tx, 30, tz);
                        player.clawR.rotation.y = ry;

                        // 薙ぎ払いの方向へ胴体が反動旋回
                        player.mesh.rotation.y -= 0.08 * Math.sin(progress * Math.PI);
                    }
                } else {
                    player.clawR.position.lerp(defRPos, 0.25 * dtScale);
                    player.clawR.rotation.y += (0 - player.clawR.rotation.y) * 0.25 * dtScale;
                }

                if (!debugState.noclip) handleCollisions();

                // 同時押しされてから原爆チャージ画面が誤って表示されないようにする長押し猶予時間（ディレイ：250ms）
                const CHARGE_DELAY = 250; 
                const isDoublePressed = player.isLeftDown && player.isRightDown;
                const pressDuration = isDoublePressed && player.doubleDownTime ? (Date.now() - player.doubleDownTime) : 0;

                if (isScaleSandboxAtomicEnabled(activeScaleStageId) && isDoublePressed && !player.chargeBlock && pressDuration >= CHARGE_DELAY) {
                    const now = Date.now();
                    if (now - player.lastBombTime > BOMB_COOLDOWN) {
                        player.isCharging = true; player.chargeTime += delta * 1000;
                        document.getElementById('charge-ui').style.display = 'block';
                        document.getElementById('charge-bar-fill').style.width = Math.min(100, (player.chargeTime / CHARGE_THRESHOLD) * 100) + '%';
                        
                        if (player.chargeTime > CHARGE_THRESHOLD) { 
                            document.getElementById('charge-ui').classList.add('ready'); 
                            shake = 10; 
                            
                            // 【空中起爆ナビゲーション】地上と空中をリアルタイムで判別してHUDを変化
                            const label = document.getElementById('charge-label');
                            if (player.isGrounded) {
                                label.innerText = "⚠️ JUMP TO DETONATE! ⚠️";
                                label.style.color = "#ff3300"; // 警告を示す赤色
                                label.style.opacity = Math.sin(time * 15) > 0 ? "1.0" : "0.2"; // 緩やかな点滅
                            } else {
                                label.innerText = "☢️ READY TO DROP!☢️\n(RELEASE MOUSE) ";
                                label.style.color = "#39ff14"; // 起爆可能を示すネオングリーン
                                label.style.opacity = Math.sin(time * 30) > 0 ? "1.0" : "0.4"; // 激しい高速点滅
                            }
                        } else {
                            const label = document.getElementById('charge-label');
                            label.innerText = "ATOMIC CHARGING...";
                            label.style.color = "#ffdd88";
                            label.style.opacity = "1.0";
                        }
                    } else {
                        player.isCharging = false; player.chargeTime = 0;
                        document.getElementById('charge-ui').style.display = 'block';
                        document.getElementById('charge-bar-fill').style.width = '0%';
                        const remaining = Math.ceil((BOMB_COOLDOWN - (now - player.lastBombTime)) / 1000);
                        const label = document.getElementById('charge-label');
                        label.innerText = "ATOMIC COOLDOWN: " + remaining + "s";
                        label.style.color = "#ffdd88";
                        label.style.opacity = "1.0";
                    }
                } else {
                    // 猶予時間内、または同時押しが解除されている間はチャージUIを絶対に非表示に維持する
                    player.isCharging = false;
                    if (!isDoublePressed) {
                        player.chargeTime = 0;
                    }
                    document.getElementById('charge-ui').style.display = 'none';
                    document.getElementById('charge-ui').classList.remove('ready');
                    
                    const label = document.getElementById('charge-label');
                    label.innerText = "ATOMIC CHARGING...";
                    label.style.color = "#ffdd88";
                    label.style.opacity = "1.0";
                }

                // もっとはっきりとオレンジ（0xffaa00）→ 赤（0xff0000）へカラーシフト
                // かつ、エネルギーのグロー効果として自己発光（emissive）を赤熱化
                if (player.material) {
                    if (player.isCharging) {
                        const ratio = Math.min(1.0, player.chargeTime / CHARGE_THRESHOLD);
                        const startCol = new THREE.Color(0xffaa00); // 鮮やかなオレンジ
                        const endCol = new THREE.Color(0xff0000);   // 深い赤
                        player.material.color.copy(startCol).lerp(endCol, ratio);
                        player.material.emissive.setRGB(ratio * 0.75, 0, 0); // チャージ量に連動して赤く自己発光
                    } else {
                        player.material.color.copy(player.defaultColor);
                        player.material.emissive.setRGB(0, 0, 0);
                    }
                }

                // チャージ中の大げさなカニ本体のブルブル振動（シェイク）
                if (player.isCharging) {
                    const ratio = Math.min(1.0, player.chargeTime / CHARGE_THRESHOLD);
                    const amp = ratio * 5.0; // 最大5pxの揺れ
                    player.mesh.position.x += (Math.random() - 0.5) * amp;
                    player.mesh.position.y += (Math.random() - 0.5) * amp;
                    player.mesh.position.z += (Math.random() - 0.5) * amp;
                }

                // チャージ中のカメラズーム（進行度に応じてスムーズにズーム接近）
                if (player.isCharging) {
                    const ratio = Math.min(1.0, player.chargeTime / CHARGE_THRESHOLD);
                    const targetZoom = ratio * 0.12; 
                    player.chargeZoom += (targetZoom - player.chargeZoom) * 0.15 * dtScale;
                } else {
                    player.chargeZoom += (0 - player.chargeZoom) * 0.12 * dtScale;
                }
                const activeCamDist = camDist * (1.0 - player.chargeZoom);

                // 通常のターゲットカメラ位置
                const targetCamPos = new THREE.Vector3(
                    player.mesh.position.x + activeCamDist * Math.sin(yaw) * Math.cos(pitch),
                    player.mesh.position.y + activeCamDist * Math.sin(pitch) + activeScaleStage.cameraHeight,
                    player.mesh.position.z + activeCamDist * Math.cos(yaw) * Math.cos(pitch)
                );
                const targetLookAt = new THREE.Vector3(
                    player.mesh.position.x,
                    player.mesh.position.y + activeScaleStage.cameraTargetHeight,
                    player.mesh.position.z
                );

                if (isIntroPlaying) {
                    // 演出の進行度 (0.0 〜 1.0)
                    const introT = Math.min(1, (performance.now() - introStartTime) / INTRO_DURATION_MS);
                    
                    // 【タイミングの入れ替え】
                    // 0.0 〜 0.15 : 素早くパンアップして第三者アングルを決める
                    // 0.15 〜 0.3 : 第三者アングルを少しだけキープ（キープ時間を短く）
                    // 0.3 〜 1.0 : ゆっくりと時間をかけて通常視点へ回り込む（戻る時間を長く！）
                    
                    const panT = Math.min(1, introT / 0.15); 
                    
                    // eased は全体の30%を過ぎた時点から、残り70%の時間をたっぷり使って通常視点へ戻る
                    const eased = introT < 0.3 ? 0 : Math.pow((introT - 0.3) / 0.7, 2);

                    // 【第三者視点のアングル演出】
                    const currentTrackX = 150 + (50 * Math.sin(panT * Math.PI / 2)); 
                    const currentTrackY = 10 + (10 * Math.sin(panT * Math.PI / 2)); 
                    const currentTrackZ = 300 + (80 * Math.sin(panT * Math.PI / 2)); 
                    
                    const trackOffset = new THREE.Vector3(currentTrackX, currentTrackY, currentTrackZ);
                    trackOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), player.mesh.rotation.y);
                    const trackCamPos = player.mesh.position.clone().add(trackOffset);
                    
                    // 【手ブレの遊び】
                    trackCamPos.x += Math.sin(time * 2.5) * 3.0 * (1 - eased);
                    trackCamPos.y += Math.cos(time * 3.2) * 2.0 * (1 - eased);

                    // 【注視点のパンアップ】
                    const currentLookAtY = 40 + (30 * Math.sin(panT * Math.PI / 2));
                    const trackLookAt = player.mesh.position.clone().add(new THREE.Vector3(0, currentLookAtY, 0));

                    camera.position.lerpVectors(trackCamPos, targetCamPos, eased);
                    const blendedLookAt = trackLookAt.clone().lerp(targetLookAt, eased);
                    camera.lookAt(blendedLookAt);

                    if (introT >= 1) isIntroPlaying = false;
                } else {
                    camera.position.copy(targetCamPos);
                    camera.lookAt(targetLookAt);
                }

                // ボスめり込み回避（通常時・演出時共通）
                for (const en of entities) {
                    if (en.type !== 'boss' || en.isDead || en.mesh.position.y < -30) continue;
                    for (const seg of en.segments) {
                        const segR = (seg.userData.radius || 100) + 60;
                        const dx = camera.position.x - seg.position.x;
                        const dy = camera.position.y - seg.position.y;
                        const dz = camera.position.z - seg.position.z;
                        const distSq = dx * dx + dy * dy + dz * dz;
                        if (distSq < segR * segR) {
                            const dist = Math.sqrt(distSq) || 0.001;
                            const scale = segR / dist;
                            camera.position.x = seg.position.x + dx * scale;
                            camera.position.y = seg.position.y + dy * scale;
                            camera.position.z = seg.position.z + dz * scale;
                        }
                    }
                }

                // === カメラとプレイヤーの間の建物を半透明にする処理 ===
                // 【変更】オープニング演出（isIntroPlaying中）の見栄え向上だけが目的だったため、
                // 通常プレイ中は実行しないようにし、町など建物が多いエリアでの負荷を無くす
                if (isIntroPlaying) {
                    // 1. 前回半透明にしたオブジェクトを元のマテリアルに戻す
                    transparentObjects.forEach(obj => {
                        if (obj.userData.originalMaterial) {
                            obj.material = obj.userData.originalMaterial;
                            obj.userData.originalMaterial = null;
                        }
                    });
                    transparentObjects = [];

                    // 2. カメラからプレイヤーへのレイ（レーザー）を飛ばす
                    const camPos = camera.position.clone();
                    const playerCenter = player.mesh.position.clone();
                    playerCenter.y += 40; // 足元ではなくカニの胴体中心を狙う

                    const direction = new THREE.Vector3().subVectors(playerCenter, camPos).normalize();
                    const distance = camPos.distanceTo(playerCenter);

                    cameraRaycaster.set(camPos, direction);
                    cameraRaycaster.far = distance;

                    // 3. 判定対象のメッシュを抽出（建物など大きな障害物のみ。木や岩はインスタンス描画のため除外）
                    const obstacles = [];
                    for (let i = 0; i < entities.length; i++) {
                        const en = entities[i];
                        if (en.isDead) continue;
                        if (['house', 'tower', 'church', 'school', 'militaryBase', 'barn', 'factory'].includes(en.type)) {
                            obstacles.push(en.mesh);
                        }
                    }

                    // 4. 交差判定
                    const intersects = cameraRaycaster.intersectObjects(obstacles, true);

                    // 5. 交差したメッシュのマテリアルを半透明用に差し替え
                    for (let i = 0; i < intersects.length; i++) {
                        const hitObj = intersects[i].object;
                        
                        // InstancedMeshは全体が透けてしまうため除外
                        if (hitObj.isInstancedMesh) continue;

                        if (hitObj.material) {
                            // 元のマテリアルを記憶しておく
                            if (!hitObj.userData.originalMaterial) {
                                hitObj.userData.originalMaterial = hitObj.material;
                                
                                // 複数マテリアルが割り当てられている場合と単一の場合で分岐
                                if (Array.isArray(hitObj.material)) {
                                    hitObj.material = hitObj.material.map(m => getTransparentMaterial(m));
                                } else {
                                    hitObj.material = getTransparentMaterial(hitObj.material);
                                }
                            }
                            // 戻すリストに追加
                            if (!transparentObjects.includes(hitObj)) {
                                transparentObjects.push(hitObj);
                            }
                        }
                    }
                } else if (transparentObjects.length > 0) {
                    // 演出終了後、透明化されたままの建物が残っていれば1回だけ元に戻す
                    transparentObjects.forEach(obj => {
                        if (obj.userData.originalMaterial) {
                            obj.material = obj.userData.originalMaterial;
                            obj.userData.originalMaterial = null;
                        }
                    });
                    transparentObjects = [];
                }
            }

            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.mesh.position.addScaledVector(p.vel, delta);
                
                // 軌跡パーティクル以外のみ重力の影響を受ける
                if (!p.noGravity) {
                    p.vel.y -= 25 * dtScale;
                }
                p.vel.multiplyScalar(Math.pow(0.98, dtScale));
                
                p.mesh.rotation.x += p.rotVel.x * dtScale;
                p.mesh.rotation.y += p.rotVel.y * dtScale;
                p.life -= delta;

                // 軌跡用パーティクルのフェードアウト処理（マテリアル共有のためスケール縮小に変更）
                if (p.isWindFade) {
                    const ratio = Math.max(0, p.life / p.maxLife);
                    p.mesh.scale.copy(p.mesh.userData.baseScale).multiplyScalar(ratio);
                }

                const limitY = p.settleY !== undefined ? p.settleY : 5;
                if (p.mesh.position.y < limitY) { 
                    p.mesh.position.y = limitY; 
                    p.vel.set(0, 0, 0); 
                    p.rotVel.set(0, 0, 0); 
                }
                
                if (p.life <= 0 || (p.isWindFade && p.life / p.maxLife <= 0.02)) {
                    scene.remove(p.mesh);
                    safeDispose(p.mesh);
                    particles.splice(i, 1);
                }
            }

            for (let i = shockwaves.length - 1; i >= 0; i--) {
                const sw = shockwaves[i];
                // 既存のショックウェーブ（衝撃波リング）更新のみ実行
                sw.radius += (sw.maxRadius - sw.radius) * 0.12 * dtScale;
                sw.opacity -= 0.04 * dtScale;
                sw.mesh.scale.setScalar(sw.radius);
                sw.mesh.material.opacity = Math.max(0, sw.opacity);

                if (sw.opacity <= 0) {
                    scene.remove(sw.mesh);
                    safeDispose(sw.mesh);
                    shockwaves.splice(i, 1);
                }
            }

            if (score >= nextBossScore && !bossActive) {
                const angle = Math.random() * Math.PI * 2;
                spawnEntity('boss',
                    player.mesh.position.x + Math.cos(angle) * 4500,
                    player.mesh.position.z + Math.sin(angle) * 4500
                );
                nextBossScore = 999999999;
            }
            
            // 【不具合修正】
            // 1. 生きている(破壊されていない)基地のリストを抽出して、幽霊基地からのスポーンを完璧に防止
            // 2. プレイヤーとの距離が5800px未満のアクティブな基地のみを対象とすることで、遠すぎることによる即時デスポーン消滅を防止
            // 【軍の反撃強化】街を破壊（スコア獲得）するほど軍の警戒度が上がり、戦車の同時上限数とスポーン確率が動的に上昇
            const currentAllowedTanks = bossActive ? 2 : Math.min(10, 4 + Math.floor(score / 6000));
            const spawnChance = 0.012 + Math.min(0.028, score * 0.000003); // 破壊規模に応じて最大4.0%まで頻度向上
            
            if (tankCount < currentAllowedTanks && frameRateIndependentChance(spawnChance, dtScale)) {
                const SPAWN_ABLE_BASE_DIST_SQ = 5800 * 5800;
                const activeBases = militaryBases.filter(mb => {
                    if (mb.isDead) return false;
                    const distSqToPlayer = mb.mesh.position.distanceToSquared(pPos);
                    return distSqToPlayer < SPAWN_ABLE_BASE_DIST_SQ;
                });
                
                if (activeBases.length > 0) {
                    // 近くにアクティブな基地がある場合はそこから出撃
                    const targetBase = activeBases[Math.floor(Math.random() * activeBases.length)];
                    spawnEntity('tank',
                        targetBase.mesh.position.x + (Math.random() - 0.5) * 400,
                        targetBase.mesh.position.z + (Math.random() - 0.5) * 400
                    );
                } else if (score > 2500) {
                    // 基地を破壊した場合や離れた田舎にいる場合でも、警戒レベルに応じて軍が「増援部隊」を画面外周辺から直接送り込む
                    const spawnAngle = Math.random() * Math.PI * 2;
                    const spawnDist = 2000 + Math.random() * 800; // 画面の少し外側の位置
                    spawnEntity('tank',
                        pPos.x + Math.sin(spawnAngle) * spawnDist,
                        pPos.z + Math.cos(spawnAngle) * spawnDist
                    );
                }
            }

            let activeShelterBuildings = null;
            let lineOfSightObstacles = null;
            for (let ei = 0; ei < entities.length; ei++) {
                const en = entities[ei];
                if (en.isDead) {
                    if (en.type === 'human') {
                        en.mesh.position.y -= dtScale * 1.8;
                        if (en.mesh.position.y < -45) {
                            scene.remove(en.mesh);
                            en.mesh.traverse(child => safeDispose(child));
                            entities.splice(ei, 1);
                            ei--;
                        }
                    }
                    else if (en.type === 'ruins') {
                        if (en.life === undefined) en.life = 15.0;
                        en.life -= delta;

                        if (en.life <= 0) {
                            en.mesh.position.y -= dtScale * 1.5;
                            if (en.mesh.position.y < -120 * (en.radius / 100)) {
                                scene.remove(en.mesh);
                                en.mesh.traverse(child => safeDispose(child));
                                entities.splice(ei, 1);
                                ei--;
                            }
                        } else if (en.mesh.visible) {
                            // 寿命が残っている間だけ、リアルな黒煙をたなびかせる (非表示時は生成しない)
                            const smokeEvents = referenceFrameEventCount(0.12, dtScale);
                            for (let smokeEvent = 0; smokeEvent < smokeEvents; smokeEvent++) {
                                if (particles.length >= PARTICLE_CAP_NORMAL) break;
                                const smokePos = en.mesh.position.clone();
                                smokePos.x += (Math.random() - 0.5) * en.radius * 0.8;
                                smokePos.z += (Math.random() - 0.5) * en.radius * 0.8;
                                smokePos.y += 12 + Math.random() * 15;

                                const p = new THREE.Mesh(geometries.sphere, materials.ruinSmoke);
                                p.scale.setScalar(12 + Math.random() * 16);
                                p.userData.baseScale = p.scale.clone(); // 追加: フェードアウト時のクラッシュ防止
                                p.position.copy(smokePos);

                                const v = new THREE.Vector3(
                                    (Math.random() - 0.5) * 35,
                                    85 + Math.random() * 65,
                                    (Math.random() - 0.5) * 35
                                );

                                particles.push({
                                    mesh: p,
                                    vel: v,
                                    life: 1.1 + Math.random() * 0.5,
                                    maxLife: 1.6,
                                    rotVel: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.1),
                                    settleY: -9999,
                                    noGravity: true, // 空中に上昇し続ける
                                    isWindFade: true
                                });
                                scene.add(p);
                            }
                        }
                    } else {
                        // その他の死んだエンティティを配列から除去して肥大化を防ぐ
                        entities.splice(ei, 1);
                        ei--;
                    }
                    continue;
                } 

                const dSq = en.mesh.position.distanceToSquared(pPos);

                // 【不具合修正】プレイヤーから一定距離以上遠く離れた戦車を自動消滅（デスポーン）させる
                // これにより、遠くの基地に溜まったまま一歩も動かない戦車を安全にリサイクルし、偏りやスタックを解消
                if (en.type === 'tank') {
                    const DESPAWN_DIST_SQ = TANK_DESPAWN_DIST * TANK_DESPAWN_DIST; // 距離 6500px 以上離れたらデスポーン
                    if (dSq > DESPAWN_DIST_SQ) {
                        en.isDead = true;
                        scene.remove(en.mesh);
                        en.mesh.traverse(child => safeDispose(child));
                        tankCount--;
                        
                        // 配列から安全に即時除外
                        entities.splice(ei, 1);
                        ei--;
                        continue;
                    }
                }
                
                if (!en.mesh.visible && en.type !== 'boss') continue;

                if (en.pushVel.lengthSq() > 0.1) {
                    en.mesh.position.addScaledVector(en.pushVel, delta);
                    en.pushVel.multiplyScalar(Math.pow(0.85, dtScale));
                }

                // --- 改良された人間のリアル＆コミカル行動パターンモーション処理 ---
                if (en.type === 'human') {
                    en.wiggleTime += delta * 15;

                    if (en.waterAvoidTimer > 0) {
                        en.waterAvoidTimer -= delta;
                    }
                    
                    // カニが近づいたら逃走モードへ
                    if (dSq < 2200 * 2200) {
                        if (en.humanState !== 'flee' && en.humanState !== 'tripped' && en.humanState !== 'recovering') {
                            en.humanState = 'flee';
                            en.humanTimer = 0;
                            en.fleeAngleOffset = (Math.random() - 0.5) * Math.PI / 2; // 複数の逃走方向をランダム選択
                            
                            // 建物への避難は選択肢の1つにする (30%の確率)
                            en.targetBuilding = null;
                            if (Math.random() < 0.3) {
                                let nearestBldg = null;
                                let minDistBldg = Infinity;
                                if (!activeShelterBuildings) {
                                    activeShelterBuildings = entities.filter(bldg => !bldg.isDead && DESTRUCTIBLE_BUILDING_TYPES.has(bldg.type));
                                }
                                for (let bldg of activeShelterBuildings) {
                                    let d = bldg.mesh.position.distanceToSquared(en.mesh.position);
                                    if (d < 3000 * 3000 && d < minDistBldg) {
                                        minDistBldg = d;
                                        nearestBldg = bldg;
                                    }
                                }
                                en.targetBuilding = nearestBldg;
                            }
                        }
                    } else {
                        // カニが遠くなったら通常のんびりモードへ戻る
                        if (en.humanState === 'flee') {
                            en.humanState = 'idle';
                            en.humanTimer = Math.random() * 3.0;
                            en.targetBuilding = null;
                        }
                    }

                    // 1. つまずき転倒状態
                    if (en.humanState === 'tripped') {
                        en.tripTimer -= delta;
                        
                        // 地面にバッタリ倒れる（傷つくばる）モーション
                        en.mesh.rotation.x = Math.PI / 2;
                        en.mesh.position.y = 8;
                        
                        // パニックで頭をカタカタ震わせる
                        if (en.mesh.children[1]) {
                            en.mesh.children[1].position.x = Math.sin(en.wiggleTime * 2.5) * 5;
                        }
                        
                        if (en.tripTimer <= 0) {
                            en.humanState = 'recovering';
                            en.tripTimer = 0.5; // 0.5秒立ち止まる
                            en.mesh.rotation.x = 0;
                            if (en.mesh.children[1]) en.mesh.children[1].position.x = 0;
                        }
                    }
                    // 1.5. 転倒からの復帰状態（一瞬立ち止まる）
                    else if (en.humanState === 'recovering') {
                        en.tripTimer -= delta;
                        en.mesh.position.y = 45;
                        if (en.tripTimer <= 0) {
                            en.humanState = 'flee';
                            en.humanTimer = 0;
                        }
                    }
                    // 2. パニック全力逃走状態（ジグザグ走走 ＆ 転倒抽選 ＆ 建物避難）
                    else if (en.humanState === 'flee') {
                        en.humanTimer += delta;
                        
                        // 逃走中、稀に地面につまずいて大げさに転ぶ
                        if (en.humanTimer > 0.8 && frameRateIndependentChance(0.003, dtScale)) {
                            en.humanState = 'tripped';
                            en.tripTimer = 1.0 + Math.random() * 0.8;
                            en.pushVel.set(0, 0, 0);
                        } 
                        // 途中で周囲確認や方向転換を追加（一瞬立ち止まる）
                        else if (en.humanTimer > 1.5 && frameRateIndependentChance(0.005, dtScale)) {
                            en.humanState = 'recovering';
                            en.tripTimer = 0.3 + Math.random() * 0.4;
                            en.fleeAngleOffset = (Math.random() - 0.5) * Math.PI / 2;
                            en.pushVel.set(0, 0, 0);
                        }
                        else {
                            let fleeDir = en.mesh.position.clone().sub(pPos).setY(0).normalize();
                            
                            // --- 橋への吸い込み誘導ナビゲーション ---
                            // 近くに橋（索敵範囲1200px以内）が存在する場合、一時的に逃げる方向を橋の方向へ引き寄せます
                            let nearestBridge = null;
                            let minDistBridgeSq = 1200 * 1200; 
                            for (const br of bridges) {
                                const dSqBr = (en.mesh.position.x - br.x)**2 + (en.mesh.position.z - br.z)**2;
                                if (dSqBr < minDistBridgeSq) {
                                    minDistBridgeSq = dSqBr;
                                    nearestBridge = br;
                                }
                            }
                            if (nearestBridge) {
                                const toBridge = new THREE.Vector3(nearestBridge.x - en.mesh.position.x, 0, nearestBridge.z - en.mesh.position.z).normalize();
                                const crabToNPC = en.mesh.position.clone().sub(pPos).normalize();
                                // カニに向かって逆走（自爆）しない安全な角度（背後ではない）の場合のみ、橋の方向へ逃走ルートを引き寄せる（最大ブレンド率 65%）
                                if (toBridge.dot(crabToNPC) > -0.2) {
                                    fleeDir.lerp(toBridge, 0.65).normalize();
                                }
                            }
                            
                            if (en.targetBuilding && !en.targetBuilding.isDead) {
                                // 建物へ向かうベクトル
                                let toBldg = en.targetBuilding.mesh.position.clone().sub(en.mesh.position).setY(0).normalize();
                                // 逃走中は敵との距離を最優先する（敵から遠ざかるベクトルを強めに合成）
                                fleeDir.lerp(toBldg, 0.4).normalize();
                                
                                // 建物到達後も自然な待機や移動を維持する
                                if (en.mesh.position.distanceToSquared(en.targetBuilding.mesh.position) < Math.pow(en.targetBuilding.radius + 40, 2)) {
                                    en.targetBuilding = null; // ターゲット解除
                                    en.humanState = 'recovering'; // 到達したら少し隠れる（立ち止まる）
                                    en.tripTimer = 1.0 + Math.random() * 2.0;
                                }
                            }
                            
                            // 川に押し戻された直後は、水際と平行な方向へ逃走方向をそらし、
                            // 同じ場所に何度も突っ込んでジタバタするのを防ぐ
                            if (en.waterAvoidTimer > 0) {
                                const tangent = new THREE.Vector3(-en.waterAvoidDir.z, 0, en.waterAvoidDir.x);
                                // 現在の逃走方向に近い側の岸沿い方向を選ぶ（毎フレーム左右反転しないように）
                                if (tangent.dot(fleeDir) < 0) tangent.negate();
                                fleeDir.lerp(tangent, HUMAN_WATER_AVOID_BLEND).normalize();
                            }

                            // 建物へ一直線に移動しないよう、ランダムな方向オフセットと蛇行を加える
                            const zigzagAngle = Math.sin(en.wiggleTime * 0.3) * 0.18;
                            fleeDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (en.fleeAngleOffset || 0) + zigzagAngle);
                            
                            const runSpeed = 11 * dtScale;
                            en.mesh.position.addScaledVector(fleeDir, runSpeed);
                            en.mesh.rotation.y = Math.atan2(fleeDir.x, fleeDir.z);
                            
                            // 前傾姿勢・身体 of ロール・縦揺れの各種振幅を抑制
                            en.mesh.rotation.x = 0.12; 
                            en.mesh.rotation.z = Math.sin(en.wiggleTime) * 0.12; 
                            en.mesh.position.y = 45 + Math.abs(Math.sin(en.wiggleTime)) * 4.5; 
                        }
                    }
                    // 3. 通常のんびり徘徊状態
                    else if (en.humanState === 'idle') {
                        en.mesh.rotation.x = 0;
                        en.mesh.rotation.z = 0;
                        en.mesh.position.y = 45;
                        if (en.mesh.children[1]) {
                            en.mesh.children[1].position.set(0, 110, 0);
                        }
                        
                        if (en.idleWaitTimer > 0) {
                            en.idleWaitTimer -= delta;
                            // 立ち止まっている
                        } else {
                            en.humanTimer -= delta;
                            if (en.humanTimer <= 0) {
                                if (Math.random() < 0.4) {
                                    en.idleWaitTimer = 1.0 + Math.random() * 2.0; // 立ち止まる
                                } else {
                                    en.wanderAngle = Math.random() * Math.PI * 2;
                                    en.humanTimer = 1.5 + Math.random() * 3.0;
                                }
                            } else {
                                // のんびり散歩移動
                                const walkDir = new THREE.Vector3(Math.sin(en.wanderAngle), 0, Math.cos(en.wanderAngle));
                                en.mesh.position.addScaledVector(walkDir, 3 * dtScale);
                                en.mesh.rotation.y = en.wanderAngle;
                                
                                // ゆるやかな散歩揺れ
                                en.mesh.rotation.z = Math.sin(en.wiggleTime * 0.4) * 0.08;
                                en.mesh.position.y = 45 + Math.abs(Math.sin(en.wiggleTime * 0.4)) * 6;
                            }
                        }
                    }
                } 
                else if (en.type === 'tank' && dSq < TANK_ENGAGE_RANGE * TANK_ENGAGE_RANGE) {
                    // スタック判定
                    en.stuckCheckTimer -= delta;
                    if (en.stuckCheckTimer <= 0) {
                        if (en.lastPos.distanceToSquared(en.mesh.position) < TANK_STUCK_DIST_THRESHOLD_SQ) {
                            en.tankStuckTimer = TANK_STUCK_AVOID_TIMER;
                            en.tankAvoidAngle = en.mesh.rotation.y + (Math.random() > 0.5 ? Math.PI/2 : -Math.PI/2);
                        }
                        en.lastPos.copy(en.mesh.position);
                        en.stuckCheckTimer = TANK_STUCK_CHECK_INTERVAL;
                    }

                    let isStuck = en.tankStuckTimer > 0;
                    if (isStuck) en.tankStuckTimer -= delta;

                    // 射線判定（簡易レイキャスト）
                    let hasLOS = true;
                    const toPlayerVec = pPos.clone().sub(en.mesh.position);
                    const distToPlayer = toPlayerVec.length();
                    const rayDir = toPlayerVec.clone().normalize();
                    if (!lineOfSightObstacles) {
                        lineOfSightObstacles = entities.filter(obs => !obs.isDead && obs.type !== 'human' && obs.type !== 'boss' && obs.type !== 'pebble');
                    }
                    for (let obs of lineOfSightObstacles) {
                        if (obs === en) continue;
                        const toObs = obs.mesh.position.clone().sub(en.mesh.position);
                        const proj = toObs.dot(rayDir);
                        if (proj > 0 && proj < distToPlayer) {
                            const perpSq = toObs.lengthSq() - proj * proj;
                            const obsRad = obs.radius + 20;
                            if (perpSq < obsRad * obsRad) {
                                hasLOS = false;
                                break;
                            }
                        }
                    }

                    const toPlayer = pPos.clone().sub(en.mesh.position).setY(0);
                    let targetAngle = Math.atan2(toPlayer.x, toPlayer.z);

                    if (isStuck) {
                        targetAngle = en.tankAvoidAngle;
                    } else if (!hasLOS) {
                        // 射線が通らない場合は回り込む
                        targetAngle += Math.PI / 3;
                    }
                    
                    let angleDiff = targetAngle - en.mesh.rotation.y;
                    angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
                    en.mesh.rotation.y += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), TANK_BODY_TURN_SPEED * dtScale);

                    if (dSq > TANK_APPROACH_DIST * TANK_APPROACH_DIST || !hasLOS || isStuck) {
                        en.mesh.translateZ(TANK_MOVE_SPEED * dtScale);
                    }
                    if (en.turret && en.gunGroup) {
                        const localPlayerPos = pPos.clone().sub(en.mesh.position);
                        localPlayerPos.applyAxisAngle(new THREE.Vector3(0, 1, 0), -en.mesh.rotation.y);

                        const targetTurretYaw = Math.atan2(localPlayerPos.x, localPlayerPos.z);
                        let turretDiff = targetTurretYaw - en.turret.rotation.y;
                        turretDiff = Math.atan2(Math.sin(turretDiff), Math.cos(turretDiff));
                        en.turret.rotation.y += Math.sign(turretDiff) * Math.min(Math.abs(turretDiff), TANK_TURRET_TURN_SPEED * dtScale);

                        const targetHeightDiff = (pPos.y + 35) - (en.mesh.position.y + 65);
                        const horizontalDist = Math.sqrt(localPlayerPos.x * localPlayerPos.x + localPlayerPos.z * localPlayerPos.z);
                        const targetGunPitch = -Math.atan2(targetHeightDiff, Math.max(1, horizontalDist));

                        let gunDiff = targetGunPitch - en.gunGroup.rotation.x;
                        en.gunGroup.rotation.x += Math.sign(gunDiff) * Math.min(Math.abs(gunDiff), TANK_GUN_PITCH_SPEED * dtScale);
                    }

                    const fireInterval = Math.max(TANK_FIRE_INTERVAL_MIN, TANK_FIRE_INTERVAL_BASE - (score * TANK_FIRE_INTERVAL_SCORE_DIVISOR));
                    if (hasLOS && !isStuck && Date.now() - en.lastShot > fireInterval) {
                        let muzzleWorld = en.mesh.position.clone();
                        muzzleWorld.y += 65; 

                        if (en.turret && en.gunGroup) {
                            const muzzleLocal = new THREE.Vector3(0, 0, 95);
                            muzzleLocal.applyAxisAngle(new THREE.Vector3(1, 0, 0), en.gunGroup.rotation.x);
                            muzzleLocal.applyAxisAngle(new THREE.Vector3(0, 1, 0), en.turret.rotation.y);
                            muzzleLocal.applyAxisAngle(new THREE.Vector3(0, 1, 0), en.mesh.rotation.y);
                            muzzleWorld.add(muzzleLocal);
                        } else {
                            muzzleWorld.y += 10;
                        }

                        const shell = new THREE.Mesh(geometries.sphere, materials.blood);
                        shell.scale.setScalar(20); shell.position.copy(muzzleWorld);
                        const dir = pPos.clone().add(new THREE.Vector3(0, 35, 0)).sub(muzzleWorld).normalize();
                        
                        bullets.push({ mesh: shell, dir, life: TANK_BULLET_LIFE, owner: en });
                        scene.add(shell); en.lastShot = Date.now();
                        playTankFireSound();
                    }
                } else if (en.type === 'boss') {
                    en.aiTimer -= delta;

                    // HPフェーズチェック
                    const hpRatio = en.hp / en.maxHp;
                    if (hpRatio <= BOSS_HYPERRAGE_HP_RATIO && !en.hyperRage) {
                        en.hyperRage = true;
                    }

                    const angleToPlayer = Math.atan2(pPos.x - en.mesh.position.x, pPos.z - en.mesh.position.z);
                    let bossRotDiff = angleToPlayer - en.mesh.rotation.y;
                    bossRotDiff = Math.atan2(Math.sin(bossRotDiff), Math.cos(bossRotDiff));

                    if (en.aiState === 'slither') {
                        const maxSlitherTurn = BOSS_SLITHER_TURN_SPEED * dtScale;
                        en.mesh.rotation.y += Math.sign(bossRotDiff) * Math.min(Math.abs(bossRotDiff), maxSlitherTurn);

                        if (dSq > BOSS_SLITHER_APPROACH_DIST * BOSS_SLITHER_APPROACH_DIST) {
                            const speed = en.rageMode ? BOSS_SLITHER_SPEED_RAGE : BOSS_SLITHER_SPEED;
                            en.mesh.translateZ(speed * dtScale);
                        }
                        en.mesh.position.y = 70 + Math.sin(time * 3) * 45;

                        // hyperRage時はslither中にも酸を吐く
                        if (en.hyperRage && frameRateIndependentChance(BOSS_SLITHER_ACID_SPIT_CHANCE, dtScale)) {
                            const spitBomb = new THREE.Mesh(geometries.sphere, materials.acid);
                            spitBomb.scale.setScalar(35);
                            spitBomb.position.copy(en.mesh.position).add(new THREE.Vector3(0, 90, 60).applyAxisAngle(new THREE.Vector3(0,1,0), en.mesh.rotation.y));
                            const spitDir = pPos.clone().add(new THREE.Vector3(0,20,0)).sub(spitBomb.position).normalize();
                            bullets.push({ mesh: spitBomb, dir: spitDir, life: BOSS_ACID_LIFE, owner: en, type: 'acid' });
                            scene.add(spitBomb);
                            beep(450, 0.2, 'triangle', 0.15, 100);
                        }

                        if (en.aiTimer <= 0) {
                            const allStates = en.rageMode ? ['charge', 'dig', 'sweep'] : ['charge', 'dig', 'slither'];
                            // 直前に選んだ技を候補から除外し、同じ技が連続しないようにする
                            const nextStates = allStates.filter(s => s !== en.lastPick);
                            const candidates = nextStates.length > 0 ? nextStates : allStates;
                            const pick = candidates[Math.floor(Math.random() * candidates.length)];
                            en.lastPick = pick;
                            en.aiState = pick;
                            en.mesh.rotation.z = 0; 
                            
                            if (pick === 'charge') en.aiTimer = BOSS_CHARGE_DURATION_FROM_SLITHER / difficultyScale;
                            else if (pick === 'dig') en.aiTimer = BOSS_DIG_DURATION_FROM_SLITHER / difficultyScale;
                            else if (pick === 'slither') en.aiTimer = BOSS_SLITHER_DURATION / difficultyScale;
                            else if (pick === 'sweep') en.aiTimer = BOSS_SWEEP_DURATION_FROM_SLITHER / difficultyScale;
                            
                            playRoarSound();
                        }
                    }
                    else if (en.aiState === 'sweep') {
                        // プレイヤーの周囲を円を描くように移動
                        const sweepRadius = BOSS_SWEEP_RADIUS_START - (BOSS_SWEEP_DURATION_FROM_SLITHER - en.aiTimer) * BOSS_SWEEP_CLOSE_RATE; // 徐々に近づく
                        const targetAngle = angleToPlayer + Math.PI / 2; // プレイヤーの横方向
                        const targetPos = pPos.clone().add(new THREE.Vector3(Math.sin(targetAngle) * sweepRadius, 0, Math.cos(targetAngle) * sweepRadius));
                        
                        const angleToTarget = Math.atan2(targetPos.x - en.mesh.position.x, targetPos.z - en.mesh.position.z);
                        let sweepRotDiff = angleToTarget - en.mesh.rotation.y;
                        sweepRotDiff = Math.atan2(Math.sin(sweepRotDiff), Math.cos(sweepRotDiff));
                        
                        en.mesh.rotation.y += Math.sign(sweepRotDiff) * Math.min(Math.abs(sweepRotDiff), BOSS_SWEEP_TURN_SPEED * dtScale);
                        en.mesh.translateZ((en.rageMode ? BOSS_SWEEP_SPEED_RAGE : BOSS_SWEEP_SPEED) * dtScale);
                        en.mesh.position.y = 60 + Math.sin(time * 5) * 20;
                        en.mesh.rotation.z = 0.3;

                        // 尻尾攻撃：旋回中は尻尾が大きく振られるため、近づきすぎると尻尾が当たる
                        if (en.tailAttackCooldown > 0) en.tailAttackCooldown -= delta;
                        const tailSeg = en.segments[en.segments.length - 1];
                        if (en.tailAttackCooldown <= 0 && tailSeg.position.distanceToSquared(pPos) < BOSS_TAIL_HIT_RADIUS * BOSS_TAIL_HIT_RADIUS) {
                            player.hp -= BOSS_TAIL_DAMAGE;
                            shake = Math.max(shake, 20);
                            let tailPushDir = pPos.clone().sub(tailSeg.position).setY(0);
                            if (tailPushDir.lengthSq() < 0.001) {
                                tailPushDir.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                            } else {
                                tailPushDir.normalize();
                            }
                            player.pushVel.add(tailPushDir.multiplyScalar(BOSS_TAIL_KNOCKBACK));
                            player.knockbackGraceTimer = PLAYER_KNOCKBACK_COLLISION_GRACE;
                            en.tailAttackCooldown = BOSS_TAIL_HIT_COOLDOWN;
                            beep(150, 0.15, 'square', 0.25);
                            createParticles(tailSeg.position, 0xffffff, 8, 20);
                        }

                        if (en.aiTimer <= 0) {
                            en.mesh.rotation.z = 0;
                            en.aiState = 'charge'; en.aiTimer = BOSS_CHARGE_DURATION_FROM_SWEEP / difficultyScale; playRoarSound();
                        }
                    }
                    else if (en.aiState === 'charge') {
                        const maxChargeTurn = BOSS_CHARGE_TURN_SPEED * dtScale;
                        en.mesh.rotation.y += Math.sign(bossRotDiff) * Math.min(Math.abs(bossRotDiff), maxChargeTurn);
                        
                        const chargeSpeed = en.rageMode ? BOSS_CHARGE_SPEED_RAGE : BOSS_CHARGE_SPEED;
                        en.mesh.translateZ(chargeSpeed * dtScale);
                        en.mesh.position.y = 55 + Math.sin(time * 9) * 15;
                        
                        en.mesh.rotation.z += (en.rageMode ? 0.6 : 0.4) * dtScale;
                        
                        shake = Math.max(shake, 14);
                        if (frameRateIndependentChance(0.3, dtScale)) {
                            createParticles(en.mesh.position, 0xa08060, 3, 30, false, materials.sandDust);
                            playRumbleSound();
                        }

                        if (dSq < BOSS_CHARGE_HIT_RADIUS * BOSS_CHARGE_HIT_RADIUS) {
                            player.hp -= (en.rageMode ? BOSS_CHARGE_DAMAGE_RAGE : BOSS_CHARGE_DAMAGE) * dtScale; 
                            shake = Math.max(shake, 25);
                            
                            const pushDir = pPos.clone().sub(en.mesh.position).setY(0).normalize();
                            player.mesh.position.addScaledVector(pushDir, BOSS_CHARGE_PUSH_FORCE * dtScale);
                        }

                        if (en.aiTimer <= 0) {
                            en.mesh.rotation.z = 0; 
                            en.aiState = 'dig'; en.aiTimer = BOSS_DIG_DURATION_FROM_CHARGE / difficultyScale; playRoarSound();
                        }
                    }
                    else if (en.aiState === 'dig') {
                        // 追尾性強化：ジャンプ移動だけではフレキシブルに追従できるよう回頭速度を引き上げる
                        const maxDigTurn = BOSS_DIG_TURN_SPEED * dtScale;
                        en.mesh.rotation.y += Math.sign(bossRotDiff) * Math.min(Math.abs(bossRotDiff), maxDigTurn);
                        
                        // プレイヤーとの距離が開いている場合は潜行速度を上げて追いつけるようにする
                        const baseDigSpeed = en.rageMode ? BOSS_DIG_SPEED_RAGE : BOSS_DIG_SPEED;
                        const digSpeed = dSq > BOSS_DIG_CATCHUP_DIST * BOSS_DIG_CATCHUP_DIST ? baseDigSpeed + BOSS_DIG_CATCHUP_BOOST : baseDigSpeed;
                        en.mesh.translateZ(digSpeed * dtScale); 
                        
                        if (en.mesh.position.y > BOSS_DIG_MAX_DEPTH) {
                            en.mesh.position.y -= BOSS_DIG_SINK_RATE * dtScale;
                        } else {
                            en.mesh.position.y = BOSS_DIG_MAX_DEPTH;
                        }

                        const dustEvents = referenceFrameEventCount(1, dtScale);
                        for (let dustEvent = 0; dustEvent < dustEvents; dustEvent++) {
                            const dustPos = en.mesh.position.clone();
                            dustPos.y = 5;
                            createParticles(dustPos, 0xa08060, 2, 35, false, materials.sandDust);
                            createParticles(dustPos, 0xff5500, 2, 18, false, materials.orangeSpark);
                        }

                        if (frameRateIndependentChance(0.4, dtScale)) {
                            playRumbleSound();
                        }

                        if (en.aiTimer <= 0) {
                            en.aiState = 'breach';
                            en.aiTimer = BOSS_BREACH_DURATION; 
                            en.jumpYVel = BOSS_BREACH_JUMP_VELOCITY; 
                            
                            // 着地位置予測改善
                            const predictSeconds = BOSS_BREACH_PREDICT_SECONDS;
                            const speedMult = player.debuffTimer > 0 ? DEBUFF_SPEED_MULT : 1.0;
                            const currentMoveSpeed = PLAYER_SPEED * speedMult;
                            const velocity = player.moveDir.clone().multiplyScalar(currentMoveSpeed * 60);
                            
                            en.targetPos.copy(pPos).addScaledVector(velocity, predictSeconds);
                            
                            // マップ外に出ないように制限
                            const distFromCenter = Math.sqrt(en.targetPos.x**2 + en.targetPos.z**2);
                            if (distFromCenter > MAP_RADIUS_LIMIT) {
                                en.targetPos.multiplyScalar(MAP_RADIUS_LIMIT / distFromCenter);
                            }

                            en.hasShownShadow = false; // 追加
                        }
                    }
                    else if (en.aiState === 'breach') {
                        const horizontalDistSq = en.mesh.position.distanceToSquared(en.targetPos);
                        
                        if (horizontalDistSq > BOSS_BREACH_ARRIVE_DIST * BOSS_BREACH_ARRIVE_DIST) {
                            const dirToTar = en.targetPos.clone().sub(en.mesh.position);
                            dirToTar.y = 0; dirToTar.normalize();
                            en.mesh.position.addScaledVector(dirToTar, BOSS_BREACH_MOVE_SPEED * dtScale);
                            en.mesh.lookAt(en.targetPos.x, en.mesh.position.y, en.targetPos.z);
                        }

                        en.mesh.position.y += en.jumpYVel * dtScale;
                        en.jumpYVel -= BOSS_BREACH_GRAVITY * dtScale; 

                        // 追加：落下開始時に影を表示
                        if (en.jumpYVel < 0 && !en.hasShownShadow) {
                            // 実際の着地予定座標を計算
                            const y = en.mesh.position.y;
                            const v = en.jumpYVel;
                            const discriminant = v * v + 2 * BOSS_BREACH_GRAVITY * y;
                            let t = 0;
                            if (discriminant >= 0) {
                                t = (v + Math.sqrt(discriminant)) / BOSS_BREACH_GRAVITY;
                            }
                            
                            const maxDist = BOSS_BREACH_MOVE_SPEED * t;
                            const currentPos2D = en.mesh.position.clone().setY(0);
                            const targetPos2D = en.targetPos.clone().setY(0);
                            const distToTarget = currentPos2D.distanceTo(targetPos2D);
                            
                            const actualDist = Math.min(maxDist, distToTarget);
                            const actualLandingPos = currentPos2D.clone();
                            if (distToTarget > 0.1) {
                                const dir = targetPos2D.sub(currentPos2D).normalize();
                                actualLandingPos.addScaledVector(dir, actualDist);
                            }
                            
                            leaveScar(actualLandingPos, BOSS_BREACH_LANDING_SCAR_RADIUS);
                            en.hasShownShadow = true;
                        }

                        if (Math.abs(en.mesh.position.y) < 55 && en.jumpYVel > 10) {
                            shake = 180;
                            playBoomSound();
                            createParticles(en.mesh.position, 0xa08060, 18, 70, false, materials.sandDust); 
                        }

                        if (en.mesh.position.y < 0 && en.jumpYVel < 0) {
                            en.mesh.position.y = 0;
                            en.aiState = 'recover';
                            en.aiTimer = BOSS_RECOVER_DURATION; 
                            en.hasSpitThisTick = false;
                            shake = 220;
                            playBoomSound();
                            explodeAt(en.mesh.position, BOSS_LANDING_DAMAGE_RADIUS, BOSS_LANDING_DAMAGE_AMOUNT, BOSS_LANDING_PUSH_RADIUS, 'boss');
                            
                            // プレイヤーを軽く吹き飛ばすノックバック（ダメージは与えない）
                            let landingPushDir = pPos.clone().sub(en.mesh.position).setY(0);
                            const landingDist = landingPushDir.length();
                            if (landingDist < BOSS_LANDING_PUSH_RADIUS) {
                                if (landingDist < 0.001) {
                                    landingPushDir.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                                } else {
                                    landingPushDir.normalize();
                                }
                                player.pushVel.add(landingPushDir.multiplyScalar(BOSS_LANDING_PLAYER_KNOCKBACK * (1 - landingDist / BOSS_LANDING_PUSH_RADIUS)));
                            }
                            // 着地の瞬間は頭部・胴体とプレイヤーが激しく重なることがあるため、
                            // 通常のめり込み解消（pushOutOf）が乱暴な補正を上乗せしないよう猶予を与える
                            player.knockbackGraceTimer = PLAYER_KNOCKBACK_COLLISION_GRACE;
                            
                            createParticles(en.mesh.position, 0xa08060, 24, 80, false, materials.sandDust);
                            leaveScar(en.mesh.position, en.radius * BOSS_LANDING_SCAR_RADIUS_MULT);

                            // hyperRage時は着地時に酸を8方向にばらまく
                            if (en.hyperRage) {
                                for(let i=0; i<BOSS_LANDING_ACID_SPRAY_COUNT; i++) {
                                    const ang = (i/BOSS_LANDING_ACID_SPRAY_COUNT) * Math.PI * 2;
                                    const spitBomb = new THREE.Mesh(geometries.sphere, materials.acid);
                                    spitBomb.scale.setScalar(30);
                                    spitBomb.position.copy(en.mesh.position).add(new THREE.Vector3(0, 50, 0));
                                    const spitDir = new THREE.Vector3(Math.cos(ang), 0.5, Math.sin(ang)).normalize();
                                    bullets.push({ mesh: spitBomb, dir: spitDir, life: BOSS_ACID_LIFE, owner: en, type: 'acid' });
                                    scene.add(spitBomb);
                                }
                            }
                        }
                    }
                    else if (en.aiState === 'recover') {
                        en.mesh.position.y = 15;
                        en.mesh.rotation.y += 0.08 * dtScale;
                        en.mesh.rotation.x = Math.sin(time * 6) * 0.4;
                        
                        const recoverStarEvents = referenceFrameEventCount(0.45, dtScale);
                        for (let starEvent = 0; starEvent < recoverStarEvents; starEvent++) {
                            makeParticleRoom(PARTICLE_CAP_NORMAL);
                            const starPos = en.mesh.position.clone().add(new THREE.Vector3(0, 140, 0));
                            const star = new THREE.Mesh(geometries.box, materials.dizzyStar);
                            star.scale.setScalar(12 + Math.random() * 12); star.position.copy(starPos);
                            const sv = new THREE.Vector3(
                                Math.cos(time * 15) * 150, 
                                60 + Math.random() * 80, 
                                Math.sin(time * 15) * 150
                            );
                            particles.push({ mesh: star, vel: sv, life: 1.2, rotVel: new THREE.Vector3(1, 1, 1), settleY: -9999 });
                            scene.add(star);
                        }

                        // 地面にめり込んでいる間、遠距離攻撃（酸の吐き出し）を繰り出す
                        const roundedSec = Math.floor(time * BOSS_RECOVER_SPIT_RATE) % 2;
                        if (roundedSec === 0 && !en.hasSpitThisTick) {
                            en.hasSpitThisTick = true;
                            
                            const spitBomb = new THREE.Mesh(geometries.sphere, materials.acid);
                            spitBomb.scale.setScalar(35);
                            spitBomb.position.copy(en.mesh.position).add(new THREE.Vector3(0, 90, 60).applyAxisAngle(new THREE.Vector3(0,1,0), en.mesh.rotation.y));
                            
                            const spitDir = pPos.clone().add(new THREE.Vector3(0,20,0)).sub(spitBomb.position).normalize();
                            bullets.push({ mesh: spitBomb, dir: spitDir, life: BOSS_ACID_LIFE, owner: en, type: 'acid' });
                            
                            scene.add(spitBomb);
                            beep(450, 0.2, 'triangle', 0.15, 100);
                        } else if (roundedSec !== 0) {
                            en.hasSpitThisTick = false;
                        }

                        if (en.aiTimer <= 0) {
                            en.aiState = 'slither';
                            en.aiTimer = BOSS_SLITHER_DURATION_FROM_RECOVER / difficultyScale; 
                            playRoarSound();
                        }
                    }

                    for (let i = 1; i < en.segments.length; i++) {
                        const prev = en.segments[i - 1];
                        const curr = en.segments[i];
                        const distToPrev = curr.position.distanceTo(prev.position);
                        
                        if (distToPrev > BOSS_SEGMENT_GAP_THRESHOLD) {
                            const lerpFactor = 1.0 - Math.pow(BOSS_SEGMENT_LERP_BASE, dtScale);
                            curr.position.lerp(prev.position, lerpFactor);
                        }
                        curr.lookAt(prev.position);
                        
                        const waveOffset = Math.sin(time * BOSS_SEGMENT_WAVE_FREQ - i * 0.8) * 18;
                        curr.position.x += Math.cos(curr.rotation.y) * waveOffset * dtScale * BOSS_SEGMENT_WAVE_TURN_MULT;
                    }
                }
            }

            for (let i = bullets.length - 1; i >= 0; i--) {
                const b = bullets[i];
                const baseBVel = b.type === 'acid' ? BOSS_ACID_SPEED : TANK_BULLET_SPEED;
                b.mesh.position.addScaledVector(b.dir, baseBVel * difficultyScale * dtScale);
                
                let hitSomething = false;

                if (b.type === 'acid') {
                    if (player.hp > 0 && b.mesh.position.distanceToSquared(pPos) < BOSS_ACID_HIT_RADIUS * BOSS_ACID_HIT_RADIUS) {
                        player.hp -= BOSS_ACID_DAMAGE;
                        shake = 40; 
                        hitSomething = true;
                        playAcidSplashSound();
                        
                        createParticles(pPos, 0x39ff14, 12, 12); 
                        player.debuffTimer = 1.1; 
                    }
                } else {
                    if (player.hp > 0 && b.mesh.position.distanceToSquared(pPos) < TANK_BULLET_HIT_RADIUS * TANK_BULLET_HIT_RADIUS) {
                        player.hp -= TANK_BULLET_DAMAGE; shake = 35; hitSomething = true; beep(200, 0.2, 'square', 0.2);
                    }
                }

                if (!hitSomething) {
                    for (let en of entities) {
                        if (en.isDead) continue;
                        if (!en.mesh.visible) continue; 
                        if (en.type === 'boss') continue; 
                        if (en === b.owner) continue;      
                        if (en.type === 'tank') continue;  
                        
                        const colRad = en.radius + 15; 
                        if (Math.abs(b.mesh.position.x - en.mesh.position.x) > colRad ||
                            Math.abs(b.mesh.position.z - en.mesh.position.z) > colRad) continue;

                        const distSq = b.mesh.position.distanceToSquared(en.mesh.position);
                        if (distSq < colRad * colRad) {
                            hitSomething = true;
                            damageEntity(en, 150, b.dir.clone());
                            createParticles(b.mesh.position, b.type === 'acid' ? 0x39ff14 : 0xff8800, 8, 16);
                            createParticles(b.mesh.position, 0xa08060, 6, 22, false, materials.sandDust);
                            playHitSound(false);
                            break;
                        }
                    }
                }

                if (!hitSomething && b.mesh.position.y <= 10) {
                    hitSomething = true;
                    createParticles(b.mesh.position, b.type === 'acid' ? 0xa08060 : 0xa08060, 5, 20, false, materials.sandDust);
                }

                b.life -= dtScale;
                if (b.life <= 0 || hitSomething) {
                    scene.remove(b.mesh);
                    safeDispose(b.mesh);
                    bullets.splice(i, 1);
                }
            }

            if (debugState.godMode && player.hp > 0) player.hp = player.maxHp;

            updateHUD();

            // 【仕様変更】コミカル吹っ飛び ＆ 地面めり込み防止付き・スローモーション死亡演出
            if (player.hp <= 0 && !isGameOver) {
                updateDeathSequence(rawDelta, dtScale);
            }
            updateCompass();

            if (shake > 0) {
                const appliedShake = shake * settings.cameraShake;
                camera.position.x += (Math.random() - 0.5) * appliedShake;
                camera.position.y += (Math.random() - 0.5) * appliedShake;
                shake *= Math.pow(0.85, dtScale);
            }

            rendererController.render();
        }

        // --- HUD（HPバー・スコア・原爆クールタイム）の更新 ---
        // 毎フレーム animate() から呼び出される。ロジックは元のまま。
        function updateHUD() {
            // リアルタイムにHPカウンターの数値を更新
            const hpNum = document.getElementById('hp-number');
            if (hpNum) hpNum.innerText = Math.max(0, Math.ceil(player.hp));

            // APEX/フォートナイト風のピンチ連動：HP25%未満でバーが「ネオングリーン」から「赤色」へ変化
            const hpFill = document.getElementById('hp-bar-fill');
            hpFill.style.width = Math.max(0, player.hp) + '%';
            if (player.hp < 25) {
                hpFill.style.background = 'linear-gradient(90deg, #ff0000, #ff3300)'; // 警告赤
                hpFill.style.boxShadow = '0 0 8px rgba(255,0,0,0.8) inset';
            } else {
                hpFill.style.background = 'linear-gradient(90deg, #39ff14, #00e5ff)'; // 正常（グリーン〜ブルー）
                hpFill.style.boxShadow = '0 0 8px rgba(0,255,100,0.8) inset';
            }

            // スコア1ポイントにつき1万ドルの被害額として計算し、3桁区切りに変換
            document.getElementById('score').innerText = "$" + (score * 10000).toLocaleString();

            // 原爆クールタイムHUDの常時更新処理
            const cdRemaining = Math.max(0, BOMB_COOLDOWN - (Date.now() - player.lastBombTime));
            const cdLabel = document.getElementById('atomic-cd-label');
            if (cdLabel) {
                if (!isScaleSandboxAtomicEnabled(activeScaleStageId)) {
                    cdLabel.innerText = "SCALE SANDBOX: LOCKED";
                    cdLabel.style.color = "#888888";
                } else if (cdRemaining > 0) {
                    cdLabel.innerText = "COOLDOWN (" + Math.ceil(cdRemaining / 1000) + "s)";
                    cdLabel.style.color = "#ff3300";
                } else {
                    cdLabel.innerText = "READY";
                    cdLabel.style.color = "#39ff14";
                }
            }
        }

        // --- コミカル吹っ飛び＆スローモーション死亡演出の更新 ---
        // animate() から player.hp <= 0 の間、毎フレーム呼び出される。ロジックは元のまま。
        function updateDeathSequence(rawDelta, dtScale) {
            const rawFrameScale = Math.min(rawDelta * 60, 4);
            if (!player.isDying) {
                player.isDying = true;
                player.deathTimer = 3; // 3秒間の劇的スローモーション
                shake = 20; // 大揺れによる3D酔いを完全に防止する、一瞬の微小な衝撃揺れ
                playBoomSound(); // 大爆発音

                // 【コミカル吹っ飛び物理】死んだ瞬間に、カニを軽く上空へピョーンと跳ね上げる
                player.isGrounded = false;
                player.yVel = 18; // 上方向への浮上初速

                // カニの体を真っ黒い「炭（焦げ色）」に変更
                if (player.material) {
                    player.material.color.setHex(0x111111);
                    player.material.emissive.setHex(0x330000); // 内部がわずかに赤熱してくすぶる
                }
            }

            // スローの影響を受けない実時間（クロック）でタイマーを減算
            player.deathTimer -= rawDelta;

            // 死亡中のスローモーション空中落下（重力）物理のリアル計算
            if (!player.isGrounded) {
                player.yVel -= PLAYER_GRAVITY * dtScale; // 重力落下
                player.mesh.position.y += player.yVel * dtScale;

                // 地面（Y=0）に着地した瞬間
                if (player.mesh.position.y <= 0) {
                    player.mesh.position.y = 0;
                    player.isGrounded = true;
                    playHitSound(true); // ゴンと鈍い着地音
                    shake = 50;
                }
            }

            // 【めり込み防止処理】カニが横向きに倒れる（rotation.z）につれて、体の厚みで地面に埋まらないように自動で高さを浮かせます
            if (player.isGrounded) {
                const rollAngle = player.mesh.rotation.z;
                // 最大でハサミや甲羅の横幅の半分（約40px）だけY座標を持ち上げてめり込みを100%防ぐ
                player.mesh.position.y = Math.abs(Math.sin(rollAngle)) * 42;
            }

            // 体から黒煙（炭化粒子）とオレンジの火花をボコボコと放出する
            const deathParticleEvents = referenceFrameEventCount(0.35, rawFrameScale);
            for (let deathEvent = 0; deathEvent < deathParticleEvents; deathEvent++) {
                createParticles(player.mesh.position, 0x3d3936, 4, 18, false, materials.charred); // 黒煙
                createParticles(player.mesh.position, 0xff5500, 2, 8, false, materials.orangeSpark); // 火花
            }

            // カメラをカニ人間の周りをゆっくり回転させながら、静かに上空へ引き上げる（速度を穏やかに減速）
            yaw += 0.003 * rawFrameScale; // ゆっくりと周囲を旋回（約1/5の速度に減速）
            pitch = Math.max(0.2, pitch - 0.001 * rawFrameScale); // なだらかな見上げ角度の変化（1/5の速度に減速）
            camDist = Math.min(1000, camDist + 0.8 * rawFrameScale); // 静かにじわじわとズームアウト（約1/6の速度に減速）

            // カニの体をゆっくり地面に転がらせる（コミカルなゴロゴロ横転回転）
            player.mesh.rotation.z += 0.015 * rawFrameScale;
            player.mesh.rotation.x += 0.010 * rawFrameScale;

            // 【死亡中専用シネマティックカメラワークのリアルタイム適用】
            // 生存時のカメラ処理が止まってしまうため、ここでカメラの座標と注視点を上書き更新します。
            const activeCamDist = camDist * (1.0 - player.chargeZoom);
            camera.position.x = player.mesh.position.x + activeCamDist * Math.sin(yaw) * Math.cos(pitch);
            camera.position.z = player.mesh.position.z + activeCamDist * Math.cos(yaw) * Math.cos(pitch);
            // カメラの高さをフワッと持ち上げて、倒れたカニを見下ろすアングルにします
            camera.position.y = player.mesh.position.y + activeCamDist * Math.sin(pitch) + 120;

            // カメラの視線を、倒れゆくカニ人間の体の中心（重心）に常にロックオン（注視）し続けます
            camera.lookAt(player.mesh.position.x, player.mesh.position.y + 40, player.mesh.position.z);

            if (player.deathTimer <= 0) {
                triggerGameOver(); // 演出タイマーが切れたらゲームオーバー画面を表示
            }
        }

        function updateCompass() {
            let nearest = null, nearestDistSq = Infinity;
            for (let en of entities) {
                if ((en.type === 'tank' || en.type === 'boss') && !en.isDead) {
                    const dSq = en.mesh.position.distanceToSquared(player.mesh.position);
                    if (dSq < nearestDistSq) { nearestDistSq = dSq; nearest = en; }
                }
            }
            if (!nearest) { document.getElementById('compass').style.display = 'none'; return; }
            document.getElementById('compass').style.display = 'block';
            const relativeAngle = Math.atan2(
                nearest.mesh.position.x - player.mesh.position.x,
                nearest.mesh.position.z - player.mesh.position.z
            ) - yaw;
            document.getElementById('compass-arrow').style.transform = `translate(-50%, -60%) rotate(${relativeAngle}rad)`;
        }
        function triggerGameOver() {
          isGameOver = true; gameRunning = false; playRoarSound();
            document.getElementById('final-score').innerText = "$" + (score * 10000).toLocaleString();
           document.getElementById('game-over').style.display = 'flex';
           document.getElementById('ui').style.display = 'none';
     // 死亡時、戦闘中に表示されていたHUD要素をすべて隠す（ボス体力バー・チャージゲージ・コンパス・照準）
           document.getElementById('boss-ui').style.display = 'none';
          document.getElementById('charge-ui').style.display = 'none';
           document.getElementById('compass').style.display = 'none';
          document.getElementById('crosshair').style.display = 'none';
          if (document.pointerLockElement) document.exitPointerLock();
        }

        function showLoadingScreen(text) {
            const el = document.getElementById('loading-screen');
            if(el) el.style.display = 'flex';
        }
        function hideLoadingScreen() {
            const el = document.getElementById('loading-screen');
            if(el) el.style.display = 'none';
        }

        // マップ生成後、町はずれの池のほとりをゲーム開始地点として選ぶ。
        // 池が生成されていない場合はマップ中心付近にフォールバックする。
        function findLandingSpot() {
            const ponds = waterZones.filter(wz => wz.isPond);
            if (ponds.length > 0) {
                const pond = ponds[Math.floor(Math.random() * ponds.length)];
                const angle = Math.random() * Math.PI * 2;
                // 池の中心寄りの水中からスタート
                const dist = pond.radius * 0.4;
                const x = pond.x + Math.cos(angle) * dist;
                const z = pond.z + Math.sin(angle) * dist;
                // 岸（外側）へ向かって歩く角度
                const facingAngle = angle;
                return { x, z, facingAngle };
            }
            return { x: 0, z: 500, facingAngle: 0 };
        }

        function startGame() {
            document.getElementById('start-screen').style.display = 'none';

            ensureAudio();
            if (animationId) cancelAnimationFrame(animationId);
            buildingHitStopUntil = 0;
            
            shockwaves.forEach(sw => {
                if(sw.mesh) {
                    scene.remove(sw.mesh);
                    safeDispose(sw.mesh);
                }
            });
            shockwaves.length = 0;

            // 待機画面のキノコ雲を削除
            if (window.lobbyMushroomCloud) {
                scene.remove(window.lobbyMushroomCloud);
                window.lobbyMushroomCloud.children.forEach(child => safeDispose(child));
                window.lobbyMushroomCloud = null;
            }

            // 追加: 半透明状態の解除
            transparentObjects.forEach(obj => {
                if (obj.userData.originalMaterial) {
                    obj.material = obj.userData.originalMaterial;
                    obj.userData.originalMaterial = null;
                }
            });
            transparentObjects = [];

            // 各種状態初期化の前に既存オブジェクトをクリーンアップ
            entities.forEach(en => {
                scene.remove(en.mesh);
                en.mesh.traverse(child => safeDispose(child));
            });
            particles.forEach(p => {
                scene.remove(p.mesh);
                safeDispose(p.mesh);
            });
            bullets.forEach(b => {
                scene.remove(b.mesh);
                safeDispose(b.mesh);
            });
            scars.forEach(s => {
                scene.remove(s);
                safeDispose(s);
            });

            entities.length = 0; particles.length = 0; bullets.length = 0; scars.length = 0;
            isPaused = false; // ポーズ状態を確実にクリア
            tankCount = 0; score = 0; shake = 0; bossActive = false;
            nextBossScore = 35000; 
            yaw = 0; pitch = CAM_INITIAL_PITCH;
            player.hp = PLAYER_MAX_HP; player.yVel = 0; player.isGrounded = true;
            player.isDying = false; // 初期化
            player.deathTimer = 0;  // 初期化
            player.isCharging = false; player.chargeTime = 0;
            player.isLeftDown = false; player.isRightDown = false;
            player.debuffTimer = 0; 
            player.lastBombTime = -99999;
            player.chargeBlock = false;
            player.attackLTimer = 0;
            player.attackRTimer = 0;
            player.attackType = '';
            player.pendingAttack = null;
            if (player.attackDelayTimer) {
                clearTimeout(player.attackDelayTimer);
                player.attackDelayTimer = null;
            }
            player.doubleAttackPending = false;
            player.chargeZoom = 0;
            player.doubleDownTime = 0;
            militaryBases.length = 0; // 開始時のリセットを徹底化
            
            // 待機からゲーム本編へ移行（重い「上空からのドロップ演出」は廃止し、
            // 町はずれの池のほとりに映画的なカメラ演出付きで登場させる）
            isMenu = false;
            isDropping = false;
            gameRunning = true;

            // 青空色に背景・フォグをリセット
            const skyColor = 0x5dade2;
            scene.background = new THREE.Color(skyColor);
            scene.fog.color.setHex(skyColor);

            // WebGLRendererのDOM脱着を廃止（再生成せず使いまわしてPointerLockバグを完全解消）
            init();

            // 新しく生成されたオブジェクトのシェーダーをここで先にコンパイルし、
            // ロード画面を消した直後のカクつきを防ぐ
            renderer.compile(scene, camera);

            // マップ生成後、池のほとりを出現地点として選ぶ
            const landingSpot = findLandingSpot();
            player.mesh.position.set(landingSpot.x, getTerrainHeight(landingSpot.x, landingSpot.z), landingSpot.z);
            player.mesh.rotation.y = landingSpot.facingAngle;
            player.mesh.rotation.x = 0; // コケた傾きを元に戻す
            player.mesh.rotation.z = 0; // コケた傾きを元に戻す
            yaw = landingSpot.facingAngle; // 通常カメラの水平向きをカニの向きに合わせておく
            pitch = 0.45;

            // オープニング演出: 池の中から陸へ上がる歩行＆トラッキングカメラ
            isIntroPlaying = true;
            introStartTime = performance.now();
            // 初期カメラ位置はanimate内で動的に計算するため、ここではフラグと時間のみセット

            document.getElementById('ui').style.display = 'block';

            document.getElementById('game-over').style.display = 'none';
            document.getElementById('news-ticker').style.display = 'none'; // リセット時にニュース速報を消去
            renderer.domElement.requestPointerLock();
        }

        // 初期ロード時は待機画面として初期化
        isMenu = true;
        init();
        applyQualityPreset(settings.quality); // 画質プリセットの初期適用
        renderer.compile(scene, camera);
        document.getElementById('start-screen').style.display = 'flex';

        // 【仕様変更】ゲームオーバーから最初のロビー待機画面に完全リセットして戻す関数
        function returnToMenu() {
            ensureAudio();
            if (animationId) cancelAnimationFrame(animationId);
            buildingHitStopUntil = 0;
            
            // 画面上の古い3Dオブジェクトや敵をすべてきれいに削除（クリーンアップ）
            shockwaves.forEach(sw => {
                if(sw.mesh) {
                    scene.remove(sw.mesh);
                    safeDispose(sw.mesh);
                }
            });
            shockwaves.length = 0;

            // 追加: 半透明状態の解除
            transparentObjects.forEach(obj => {
                if (obj.userData.originalMaterial) {
                    obj.material = obj.userData.originalMaterial;
                    obj.userData.originalMaterial = null;
                }
            });
            transparentObjects = [];

            entities.forEach(en => {
                scene.remove(en.mesh);
                en.mesh.traverse(child => safeDispose(child));
            });
            particles.forEach(p => {
                scene.remove(p.mesh);
                safeDispose(p.mesh);
            });
            bullets.forEach(b => {
                scene.remove(b.mesh);
                safeDispose(b.mesh);
            });
            scars.forEach(s => {
                scene.remove(s);
                safeDispose(s);
            });

            // 内部変数（HP、スコア、時間など）を完全初期化
            entities.length = 0; particles.length = 0; bullets.length = 0; scars.length = 0;
            tankCount = 0; score = 0; shake = 0; bossActive = false; 
            nextBossScore = 35000; 
            yaw = 0; pitch = CAM_INITIAL_PITCH;
            player.hp = PLAYER_MAX_HP; player.yVel = 0; player.isGrounded = true;
            player.isDying = false; // 初期化
            player.deathTimer = 0;  // 初期化
            player.isCharging = false; player.chargeTime = 0;
            player.isLeftDown = false; player.isRightDown = false;
            player.debuffTimer = 0; 
            player.lastBombTime = -99999;
            player.chargeBlock = false;
            player.attackLTimer = 0;
            player.attackRTimer = 0;
            player.attackType = '';
            player.pendingAttack = null;
            if (player.attackDelayTimer) {
                clearTimeout(player.attackDelayTimer);
                player.attackDelayTimer = null;
            }
            player.doubleAttackPending = false;
            player.chargeZoom = 0;
            player.doubleDownTime = 0;
            militaryBases.length = 0;

            // 状態を「最初期の待機ロビー」にセット
            isMenu = true;
            isDropping = false;
            gameRunning = false;
            isGameOver = false;
            isPaused = false; // ポーズ状態を解除してフリーズを防止

            // 背景とフォグを薄暮スモークカラー（ロビー用）に戻す
            scene.background = new THREE.Color(0x3a2c22);
            scene.fog = new THREE.Fog(0x3a2c22, 2000, 9000);

            // カニとマップの再読み込み
            initPlayer();
            initMap();

            // 新しく生成されたオブジェクトのシェーダーをここで先にコンパイルし、
            // ロード画面を消した直後のカクつきを防ぐ
            renderer.compile(scene, camera);

            // 【修正】init()の待機画面と同じ座標・アングルに統一（ここがズレていたためカニが画面に映らなかった）
            const lobbyTerrainY = getTerrainHeight(0, 5200);
            player.mesh.position.set(0, lobbyTerrainY, 5200);
            player.mesh.rotation.y = Math.atan2(220, 380);
            player.mesh.rotation.x = 0; // コケた傾きを元に戻す
            player.mesh.rotation.z = 0; // コケた傾きを元に戻す
            camera.position.set(220, lobbyTerrainY + 80, 5580);
            camera.lookAt(-40, lobbyTerrainY + 50, 5200);
            // 初回ロビーと同様、対峙する戦車を再配置
            spawnEntity('tank', -800, 4700, Math.PI * 0.45);

            // UIを最初の状態（スタート画面）に復元
            document.getElementById('start-screen').style.display = 'flex';
            document.getElementById('game-over').style.display = 'none';
            document.getElementById('ui').style.display = 'none';
            document.getElementById('news-ticker').style.display = 'none';
            // タイトル画面に不要な戦闘中HUDを念のためすべて隠す
            document.getElementById('boss-ui').style.display = 'none';
            document.getElementById('charge-ui').style.display = 'none';
            document.getElementById('compass').style.display = 'none';
            document.getElementById('crosshair').style.display = 'none';

            // マウスロックを一度解除
            if (document.pointerLockElement) document.exitPointerLock();

            // ロビー待機用アニメーションの再開
            animationId = requestAnimationFrame(animate);
        }

        document.getElementById('start-button').addEventListener('click', startGame);
        document.getElementById('restart-button').addEventListener('click', () => {
            // RETRYボタンを押した時に、直接開始するのではなく、一度ロビー画面へ戻す
            returnToMenu();
        });
        
        inputController = createInputController({
          onKeyDown: e => {
            if (e.code === 'Escape' && confirmModal.style.display === 'flex') {
            hideConfirmModal();
            } else if (e.code === 'Escape' && settingsModal.style.display === 'flex') {
            closeSettings(false);
            } else if (e.code === 'Escape' && debugModal.style.display === 'flex') {
            closeDebugModal(false);
            }
            if (e.code === 'KeyH' && gameRunning) {
                hudHidden = !hudHidden;
                document.body.classList.toggle('hud-hidden', hudHidden);
            }

            // ===== デバッグモード（Tabで操作パネルを開閉。開発中の動作確認専用） =====
            if (e.code === 'Tab') {
                e.preventDefault();
                if (debugModal.style.display === 'flex') {
                    closeDebugModal(true);
                } else {
                    openDebugModal();
                }
            }
          },
          onMouseMove: e => {
            // イントロ再生中はカメラの自由な旋回を禁止します
            if (isIntroPlaying) return;

            if (document.pointerLockElement) {
                yaw -= e.movementX * CAM_MOUSE_ROTATION_SPEED * settings.mouseSensitivity;
                pitch = Math.max(
                    activeScaleStage.cameraMinPitch,
                    Math.min(
                        activeScaleStage.cameraMaxPitch,
                        pitch + e.movementY * CAM_MOUSE_ROTATION_SPEED * settings.mouseSensitivity
                    )
                );
            }
          },
          onWheel: e => {
            // イントロ再生中はホイールによるカメラ距離の調整を禁止します
            if (isIntroPlaying) return;

            if (gameRunning) {
                camDist = Math.max(
                    activeScaleStage.cameraMinDistance,
                    Math.min(activeScaleStage.cameraMaxDistance, camDist + e.deltaY * CAM_WHEEL_ZOOM_SCALE)
                );
            }
          },
          onMouseDown: e => {
            // プレイ中にロックが外れている場合、画面クリックで復帰を試みる
            if (gameRunning && !document.pointerLockElement && settingsModal.style.display !== 'flex' && debugModal.style.display !== 'flex') {
                renderer.domElement.requestPointerLock();
                return; // 復帰クリック時のハサミ攻撃などの暴発を防ぐ
            }

            // 演出中は攻撃入力を完全にブロック
            if (isIntroPlaying) return;

            if (gameRunning && document.pointerLockElement) {
                const wasLeft = player.isLeftDown;
                const wasRight = player.isRightDown;

                if (e.button === 0) player.isLeftDown  = true;
                if (e.button === 2) player.isRightDown = true;

                // 左右同時クリックでのダブルパンチ・チャージ判定
                if (player.isLeftDown && player.isRightDown) {
                    // 片方クリックによる単発予約が動作している場合はキャンセルする
                    if (player.attackDelayTimer) {
                        clearTimeout(player.attackDelayTimer);
                        player.attackDelayTimer = null;
                    }
                    player.pendingAttack = null;
                    
                    // 同時押しフラグを設定して、アトミックチャージへの移行待機
                    player.doubleAttackPending = true;
                    player.chargeBlock = false;
                    
                    // 追加：同時押しが開始された時刻を記録（250ms以上の長押しでなければチャージ画面を表示しない）
                    player.doubleDownTime = Date.now();
                } else {
                    // 片方のみの入力時、同時押し猶予(120ms)を設けて暴発を防止
                    if (e.button === 0 && !wasLeft) {
                        player.pendingAttack = 'left';
                        player.attackDelayTimer = setTimeout(() => {
                            if (player.pendingAttack === 'left') {
                                attack(true);
                                player.pendingAttack = null;
                            }
                            player.attackDelayTimer = null;
                        }, ATTACK_INPUT_DELAY_MS);
                    }
                    if (e.button === 2 && !wasRight) {
                        player.pendingAttack = 'right';
                        player.attackDelayTimer = setTimeout(() => {
                            if (player.pendingAttack === 'right') {
                                attack(false);
                                player.pendingAttack = null;
                            }
                            player.attackDelayTimer = null;
                        }, ATTACK_INPUT_DELAY_MS);
                    }
                }
            }
          },
          onMouseUp: e => {
            const wasCharging = player.isCharging;
            const chargeCompleted = player.chargeTime > CHARGE_THRESHOLD;

            if (e.button === 0) { player.isLeftDown  = false; player.chargeBlock = false; player.doubleDownTime = 0; }
            if (e.button === 2) { player.isRightDown = false; player.chargeBlock = false; player.doubleDownTime = 0; }
            
            // 指が素早く離された場合、遅延を待たずに単発攻撃を実行（クリックレスポンスを維持）
            if (player.attackDelayTimer) {
                clearTimeout(player.attackDelayTimer);
                player.attackDelayTimer = null;
                if (player.pendingAttack === 'left') {
                    attack(true);
                } else if (player.pendingAttack === 'right') {
                    attack(false);
                }
                player.pendingAttack = null;
            }

            // 同時押しをしていた状態で、チャージ完了前に指が離された場合はダブルパンチ攻撃を繰り出す
            if (player.doubleAttackPending) {
                player.doubleAttackPending = false;
                if (!wasCharging || !chargeCompleted) {
                    const now = Date.now();
                    if (now - lastAttackTime >= ATTACK_COOLDOWN) {
                        attackDouble();
                    }
                }
            }
            
            if (isScaleSandboxAtomicEnabled(activeScaleStageId) && wasCharging && chargeCompleted && player.hp > 0) {
                // 変更点：プレイヤーがジャンプ中（空中：isGrounded が false）のときのみ起爆するように制限
                if (!player.isGrounded) {
                    const now = Date.now();
                    if (now - player.lastBombTime > BOMB_COOLDOWN) {
                        player.lastBombTime = now;
                        shake = 450;
                        document.getElementById('flash').style.opacity = 1;
                        setTimeout(() => document.getElementById('flash').style.opacity = 0, 300);
                        spawnMushroomCloud(player.mesh.position);
                        explodeAt(player.mesh.position, BOMB_DAMAGE_RADIUS, BOMB_DAMAGE_AMOUNT, BOMB_PUSH_RADIUS);
                    }
                }
            }
            player.isCharging = false; player.chargeTime = 0;
          },
          onPointerLockChange: () => {
            if (gameRunning && !isGameOver) {
                if (!document.pointerLockElement) {
                    // ゲーム中にロックが外れた場合（Escを押した等）
                    if (settingsModal.style.display !== 'flex' && resumeOverlay.style.display !== 'flex' && debugModal.style.display !== 'flex') {
                        openSettings();
                    }
                } else {
                    // ロックが成功（カーソルが消えた）した場合、すべて閉じて再開
                    settingsModal.style.display = 'none';
                    debugModal.style.display = 'none';
                    resumeOverlay.style.display = 'none';
                    isPaused = false;
                }
            }
          },
        });
        // --- 設定モーダル開閉ロジック ---
        const settingsModal = document.getElementById('settings-modal');
        const resumeOverlay = document.getElementById('resume-overlay');
        // --- デバッグモーダル（F1。開発中の動作確認専用） ---
        const debugModal = document.getElementById('debug-modal');
        // 追加：確認モーダル（ホームに戻る／進行状況リセット共用）
        const confirmModal = document.getElementById('confirm-modal');
        const confirmMessageEl = document.getElementById('confirm-message');
        const confirmOkBtn = document.getElementById('confirm-ok-btn');
        const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
        let pendingConfirmAction = null;

        function showConfirmModal(message, onConfirm) {
            confirmMessageEl.innerText = message;
            pendingConfirmAction = onConfirm;
            confirmModal.style.display = 'flex';
        }

        function hideConfirmModal() {
            confirmModal.style.display = 'none';
            pendingConfirmAction = null;
        }

        confirmOkBtn.addEventListener('click', () => {
            const action = pendingConfirmAction;
            hideConfirmModal();
            if (action) action();
        });
        confirmCancelBtn.addEventListener('click', () => {
            hideConfirmModal();
        });
        function openSettings() {
       settingsModal.style.display = 'flex';
        resumeOverlay.style.display = 'none';
     if (gameRunning) {
         isPaused = true;
        if (document.pointerLockElement) document.exitPointerLock();
       }
      // プレイ中に開いた場合のみ「ホームに戻る」「進行状況リセット」を表示する。
      // タイトル画面（isMenu）から開いた場合はまだ進行状況が存在しないため両方非表示にする。
        const showInGameOnlyButtons = gameRunning;
     document.getElementById('set-home-btn').style.display = showInGameOnlyButtons ? 'inline-block' : 'none';
     document.getElementById('set-reset-btn').style.display = showInGameOnlyButtons ? 'inline-block' : 'none';
        }

        // byClick が true ならボタンクリック、false なら Escキー
        function closeSettings(byClick) {
            settingsModal.style.display = 'none';
            if (gameRunning && !isGameOver) {
                if (byClick) {
                    // ボタンで閉じた場合は即座にロック要求
                    renderer.domElement.requestPointerLock();
                } else {
                    // Escで閉じた場合はブラウザ仕様で即ロックできないため、案内画面を出す
                    resumeOverlay.style.display = 'flex';
                }
            }
        }

        document.getElementById('lobby-settings-btn').addEventListener('click', () => openSettings());
        document.getElementById('settings-close-btn').addEventListener('click', () => closeSettings(true));

        // --- デバッグモーダル開閉ロジック（設定モーダルと同じ一時停止・カーソル復帰パターン） ---
        function refreshDebugModal() {
            document.getElementById('debug-fps-val').innerText = lastFps;
            const pPos = player.mesh.position;
            document.getElementById('debug-coords-val').innerText =
                `X:${pPos.x.toFixed(0)} Y:${pPos.y.toFixed(0)} Z:${pPos.z.toFixed(0)}`;
            document.getElementById('debug-entities-val').innerText = entities.length;
            document.getElementById('debug-god-btn').innerText = debugState.godMode ? 'ON' : 'OFF';
            document.getElementById('debug-god-btn').classList.toggle('debug-on', debugState.godMode);
            document.getElementById('debug-noclip-btn').innerText = debugState.noclip ? 'ON' : 'OFF';
            document.getElementById('debug-noclip-btn').classList.toggle('debug-on', debugState.noclip);
            document.getElementById('debug-score-val').innerText = score;
            document.querySelectorAll('[data-scale-stage]').forEach(button => {
                button.classList.toggle('debug-on', button.dataset.scaleStage === activeScaleStageId);
            });
            const stageValues = document.getElementById('debug-scale-values');
            stageValues.innerText =
                `Stage: ${activeScaleStage.id} | Visual: ${activeScaleStage.visualScale.toFixed(2)} | ` +
                `Collision: ${activeScaleStage.collisionRadius.toFixed(2)} | Speed: ${activeScaleStage.movementSpeed.toFixed(1)} | ` +
                `Jump: ${activeScaleStage.jumpVelocity.toFixed(1)} | Attack: ${activeScaleStage.singleAttackRadius}/${activeScaleStage.doubleAttackRadius} | ` +
                `Camera: ${activeScaleStage.cameraDistance}`;
            document.getElementById('debug-human-scale').value = String(humanVisualScale);
            const spawnBtn = document.getElementById('debug-spawn-boss-btn');
            const killBtn = document.getElementById('debug-kill-boss-btn');
            spawnBtn.disabled = !gameRunning || bossActive;
            killBtn.disabled = !bossActive;
        }

        function openDebugModal() {
            debugModal.style.display = 'flex';
            resumeOverlay.style.display = 'none';
            if (gameRunning) {
                isPaused = true;
                if (document.pointerLockElement) document.exitPointerLock();
            }
            refreshDebugModal();
        }

        // byClick が true ならボタンクリック（F1含む）、false ならEscキー
        function closeDebugModal(byClick) {
            debugModal.style.display = 'none';
            if (gameRunning && !isGameOver) {
                if (byClick) {
                    renderer.domElement.requestPointerLock();
                } else {
                    resumeOverlay.style.display = 'flex';
                }
            }
        }

        function toggleGodMode() {
            debugState.godMode = !debugState.godMode;
            refreshDebugModal();
        }
        function toggleNoclip() {
            debugState.noclip = !debugState.noclip;
            refreshDebugModal();
        }

        document.getElementById('debug-close-btn').addEventListener('click', () => closeDebugModal(true));
        document.getElementById('debug-god-btn').addEventListener('click', toggleGodMode);
        document.getElementById('debug-noclip-btn').addEventListener('click', toggleNoclip);
        document.querySelectorAll('[data-scale-stage]').forEach(button => {
            button.addEventListener('click', () => {
                applyScaleStage(button.dataset.scaleStage);
                refreshDebugModal();
            });
        });
        document.getElementById('debug-human-scale').addEventListener('change', event => {
            applyHumanVisualScale(Number(event.target.value));
            refreshDebugModal();
        });
        document.getElementById('debug-spawn-boss-btn').addEventListener('click', () => {
            if (!gameRunning || bossActive) return;
            const angle = Math.random() * Math.PI * 2;
            spawnEntity('boss',
                player.mesh.position.x + Math.cos(angle) * DEBUG_BOSS_SPAWN_DIST,
                player.mesh.position.z + Math.sin(angle) * DEBUG_BOSS_SPAWN_DIST
            );
            nextBossScore = 999999999;
            refreshDebugModal();
        });
        document.getElementById('debug-kill-boss-btn').addEventListener('click', () => {
            const debugBoss = entities.find(en => en.type === 'boss' && !en.isDead);
            if (debugBoss) damageEntity(debugBoss, debugBoss.hp);
            refreshDebugModal();
        });
        document.getElementById('debug-score-plus-btn').addEventListener('click', () => {
            score += DEBUG_SCORE_STEP;
            refreshDebugModal();
        });
        document.getElementById('debug-score-minus-btn').addEventListener('click', () => {
            score = Math.max(0, score - DEBUG_SCORE_STEP);
            refreshDebugModal();
        });
        // --- 設定項目のイベントリスナー ---
        document.getElementById('set-mouse').addEventListener('input', e => {
            settings.mouseSensitivity = parseFloat(e.target.value);
            document.getElementById('val-mouse').innerText = settings.mouseSensitivity.toFixed(1);
        });
        document.getElementById('set-vol').addEventListener('input', e => {
            settings.volume = parseFloat(e.target.value);
            document.getElementById('val-vol').innerText = Math.round(settings.volume * 100);
            if (masterGain) masterGain.gain.value = settings.volume;
        });
        document.getElementById('set-quality').addEventListener('change', e => {
            applyQualityPreset(e.target.value);
            if (scene) {
                scene.traverse(child => {
                    if (child.isMesh && child.material) child.material.needsUpdate = true;
                });
            }
        });
        // アンチエイリアスのチェック状態を現在の設定値で初期化
        const antialiasCheckbox = document.getElementById('set-antialias');
        antialiasCheckbox.checked = settings.antialias;
        antialiasCheckbox.addEventListener('change', e => {
            settings.antialias = e.target.checked;
            try { localStorage.setItem('gameAntialias', String(settings.antialias)); } catch (err) {}
            // レンダラー再生成によるPointerLock不具合を避けるため、次回リロード時に反映する旨を表示
            document.getElementById('antialias-note').style.display = 'block';
        });
        // FPSカウンター表示のON/OFF
        const fpsCounterCheckbox = document.getElementById('set-fps-counter');
        const fpsCounterEl = document.getElementById('fps-counter');
        fpsCounterCheckbox.checked = settings.showFpsCounter;
        fpsCounterEl.style.display = settings.showFpsCounter ? 'block' : 'none';
        fpsCounterCheckbox.addEventListener('change', e => {
            settings.showFpsCounter = e.target.checked;
            fpsCounterEl.style.display = settings.showFpsCounter ? 'block' : 'none';
            if (!settings.showFpsCounter) fpsCounterEl.innerText = 'FPS: --';
        });
        // FPS上限の選択
        document.getElementById('set-fps-cap').addEventListener('change', e => {
            settings.fpsCap = parseInt(e.target.value, 10);
            lastRenderedFrameTime = 0; // 切り替え直後の1フレームは即座に反映
        });
        document.getElementById('set-shake').addEventListener('input', e => {
            settings.cameraShake = parseFloat(e.target.value);
            document.getElementById('val-shake').innerText = settings.cameraShake.toFixed(1);
        });
        // 追加
        document.getElementById('set-home-btn').addEventListener('click', () => {
       showConfirmModal("ゲームを中断してホーム画面に戻りますか？\n（現在の進行状況は失われます）", () => {
        settingsModal.style.display = 'none';
        returnToMenu();
     });
      });

        document.getElementById('set-reset-btn').addEventListener('click', () => {
         showConfirmModal("現在の進行状況（スコアや配置）をすべてリセットして\n最初から再スタートしますか？", () => {
        settingsModal.style.display = 'none';
        startGame();
         });
        });
