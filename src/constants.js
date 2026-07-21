// ゲーム全体で使う固定値

export const CAM_MIN_DIST = 300;
export const CAM_MAX_DIST = 1400;

export const ATTACK_COOLDOWN = 380;
export const CHARGE_THRESHOLD = 1800;

export const BOMB_COOLDOWN = 12000;
export const BOMB_DAMAGE_RADIUS = 1800;
export const BOMB_PUSH_RADIUS = 3500;
export const BOMB_DAMAGE_AMOUNT = 8000;

export const MAP_RADIUS_LIMIT = 12300;

// ===== セーブデータ管理用（save.js実装時に使用予定） =====
// セーブフォーマットを変更した場合はこの数値をインクリメントし、
// save.js側で旧バージョンからのマイグレーション処理を書けるようにする。
export const SAVE_VERSION = 1;

// ===== プレイヤー基本パラメータ =====
export const PLAYER_MAX_HP = 100;
export const PLAYER_SPEED = 22.0;
export const DEBUFF_SPEED_MULT = 0.75;

// ===== 戦車（tank）パラメータ =====
export const TANK_HP = 450;
export const TANK_RADIUS = 70;
export const TANK_SCORE_VALUE = 1500;

export const TANK_DESPAWN_DIST = 6500;      // プレイヤーから離れすぎたらデスポーンする距離
export const TANK_ENGAGE_RANGE = 5000;      // この距離内でのみ移動・攻撃AIが作動する
export const TANK_APPROACH_DIST = 1200;     // これより遠いとプレイヤーへ接近する

export const TANK_MOVE_SPEED = 12;          // 1フレームあたりの前進量
export const TANK_BODY_TURN_SPEED = 0.04;   // 車体の旋回速度
export const TANK_TURRET_TURN_SPEED = 0.06; // 砲塔の旋回速度
export const TANK_GUN_PITCH_SPEED = 0.05;   // 砲身の上下角速度

export const TANK_STUCK_CHECK_INTERVAL = 0.5;     // スタック判定を行う間隔（秒）
export const TANK_STUCK_DIST_THRESHOLD_SQ = 10;   // この距離未満しか動いていなければスタックとみなす
export const TANK_STUCK_AVOID_TIMER = 1.5;        // スタック回避行動を続ける時間（秒）

export const TANK_FIRE_INTERVAL_MIN = 1500;             // 発射間隔の下限（ミリ秒）
export const TANK_FIRE_INTERVAL_BASE = 2500;            // 発射間隔の基準値（ミリ秒）
export const TANK_FIRE_INTERVAL_SCORE_DIVISOR = 0.025;  // スコアに応じて発射間隔を短縮する係数

export const TANK_BULLET_SPEED = 60;
export const TANK_BULLET_LIFE = 240;
export const TANK_BULLET_HIT_RADIUS = 120;
export const TANK_BULLET_DAMAGE = 10;

// ===== ボス「ギガ・ミミズ」基本ステータス =====
export const BOSS_SEGMENT_COUNT = 14;   // 胴体の節（セグメント）数
export const BOSS_HP = 60000; //
export const BOSS_RADIUS = 320;         // 頭部の当たり判定半径
export const BOSS_SCORE_VALUE = 50000;

// --- 酸弾（遠距離攻撃）---
export const BOSS_ACID_SPEED = 50;
export const BOSS_ACID_LIFE = 180;
export const BOSS_ACID_HIT_RADIUS = 140;
export const BOSS_ACID_DAMAGE = 6;

// ===== ボス フェーズ・怒りモード =====
export const BOSS_RAGE_HP_RATIO = 0.50;       // このHP割合以下でrageMode（凶暴化）発動
export const BOSS_HYPERRAGE_HP_RATIO = 0.25;  // このHP割合以下でhyperRage（発狂）発動
export const BOSS_STAGE1_HP_RATIO = 0.75;     // 最初の部位破壊が起きるHP割合
export const BOSS_SEGMENTS_PER_STAGE = 3;     // 1段階ごとに吹き飛ぶ胴体セグメント数

// ===== ボスAI：slither（通常移動）状態 =====
export const BOSS_SLITHER_TURN_SPEED = 0.02;
export const BOSS_SLITHER_APPROACH_DIST = 450;      // これより遠いと前進する
export const BOSS_SLITHER_SPEED = 9;
export const BOSS_SLITHER_SPEED_RAGE = 14;
export const BOSS_SLITHER_ACID_SPIT_CHANCE = 0.02;  // hyperRage中、1フレームあたり酸を吐く確率係数
export const BOSS_SLITHER_DURATION = 6.0;              // slither状態を選んだ時のタイマー（秒）
export const BOSS_CHARGE_DURATION_FROM_SLITHER = 4.0;  // slither→charge 移行時のタイマー（秒）
export const BOSS_DIG_DURATION_FROM_SLITHER = 5.0;     // slither→dig 移行時のタイマー（秒）
export const BOSS_SWEEP_DURATION_FROM_SLITHER = 5.0;   // slither→sweep 移行時のタイマー（秒）

// ===== ボスAI：sweep（旋回）状態 =====
export const BOSS_SWEEP_RADIUS_START = 1500;   // 開始時のプレイヤーとの距離
export const BOSS_SWEEP_CLOSE_RATE = 200;      // 時間経過で距離を詰める速さ
export const BOSS_SWEEP_TURN_SPEED = 0.04;
export const BOSS_SWEEP_SPEED = 16;
export const BOSS_SWEEP_SPEED_RAGE = 22;
export const BOSS_CHARGE_DURATION_FROM_SWEEP = 3.0;   // sweep→charge 移行時のタイマー（秒）

// ===== ボスAI：charge（突進）状態 =====
export const BOSS_CHARGE_TURN_SPEED = 0.008;
export const BOSS_CHARGE_SPEED = 18;
export const BOSS_CHARGE_SPEED_RAGE = 26;
export const BOSS_CHARGE_HIT_RADIUS = 340;          // プレイヤーへの接触ダメージ判定距離
export const BOSS_CHARGE_DAMAGE = 0.11;
export const BOSS_CHARGE_DAMAGE_RAGE = 0.22;
export const BOSS_CHARGE_PUSH_FORCE = 12.0;         // 接触時にプレイヤーを吹き飛ばす力
export const BOSS_DIG_DURATION_FROM_CHARGE = 5.0;   // charge→dig 移行時のタイマー（秒）

// ===== ボスAI：dig（潜行）状態 =====
export const BOSS_DIG_TURN_SPEED = 0.05;
export const BOSS_DIG_SPEED = 14;
export const BOSS_DIG_SPEED_RAGE = 19;
export const BOSS_DIG_CATCHUP_DIST = 700;    // これより遠いと潜行速度を上げて追いつく
export const BOSS_DIG_CATCHUP_BOOST = 9;     // 追いつくときの加速量
export const BOSS_DIG_SINK_RATE = 12;        // 地中に潜る速さ
export const BOSS_DIG_MAX_DEPTH = -150;      // 潜れる深さの下限
export const BOSS_BREACH_DURATION = 3.5;             // dig→breach 移行時のタイマー（秒／※他と違い難易度補正なし）
export const BOSS_BREACH_JUMP_VELOCITY = 75;         // breach突入時のジャンプ初速
export const BOSS_BREACH_PREDICT_SECONDS = 1.7;      // 着地地点予測の先読み秒数

// ===== ボスAI：breach（着地・地上突破）状態 =====
export const BOSS_BREACH_ARRIVE_DIST = 100;          // 着地目標地点にこれより近づいたら水平移動をやめる
export const BOSS_BREACH_MOVE_SPEED = 35;            // 空中にいる間の水平移動速度
export const BOSS_BREACH_GRAVITY = 2.2;              // 落下の重力加速度
export const BOSS_BREACH_LANDING_SCAR_RADIUS = 280;  // 着地予測地点に先に残す焦げ跡の大きさ
export const BOSS_RECOVER_DURATION = 5.0;            // breach→recover 移行時のタイマー（秒）
export const BOSS_LANDING_DAMAGE_RADIUS = 4000;      // 着地の爆風ダメージが届く範囲
export const BOSS_LANDING_DAMAGE_AMOUNT = 4000;      // 着地の爆風ダメージ量
export const BOSS_LANDING_PUSH_RADIUS = 2500;        // 着地の爆風で吹き飛ばされる範囲
export const BOSS_LANDING_SCAR_RADIUS_MULT = 1.5;    // 実際の着地地点に残す焦げ跡の大きさ（ボス半径への倍率）
export const BOSS_LANDING_ACID_SPRAY_COUNT = 15;      // hyperRage時、着地と同時に周囲へ酸をばらまく数

// ===== ボスAI：recover（もがき／怯み）状態 =====
export const BOSS_RECOVER_SPIT_RATE = 0.9;              // 怯み中に酸を吐くリズムの速さ
export const BOSS_SLITHER_DURATION_FROM_RECOVER = 7.0;  // recover→slither 移行時のタイマー（秒）

// ===== ボス共通処理：セグメント追従・接触ダメージ =====
export const BOSS_SEGMENT_GAP_THRESHOLD = 90;    // 前セグメントとの距離がこれを超えたら追従移動する
export const BOSS_SEGMENT_LERP_BASE = 0.72;      // 追従の滑らかさ（0〜1、小さいほど速く追いつく）
export const BOSS_SEGMENT_WAVE_FREQ = 3.5;       // 胴体がうねる速さ（sin波の周波数）
export const BOSS_SEGMENT_WAVE_TURN_MULT = 0.15; // うねり量が旋回に影響する強さ

export const BOSS_BODY_CONTACT_RANGE = 350;      // 胴体に触れているとみなす距離
export const BOSS_BODY_CONTACT_DAMAGE = 0.4;     // 胴体接触时の1フレームあたりダメージ
// ===== ボスAI：尻尾攻撃（sweep中のみ発生） =====
export const BOSS_TAIL_HIT_RADIUS = 160;      // 尻尾の当たり判定半径
export const BOSS_TAIL_DAMAGE = 8;            // 尻尾ヒット時のダメージ
export const BOSS_TAIL_KNOCKBACK = 14000;       // 尻尾ヒット時に吹き飛ぶ力
export const BOSS_TAIL_HIT_COOLDOWN = 1.2;    // 連続ヒット防止のクールタイム（秒）
export const BOSS_LANDING_PLAYER_KNOCKBACK = 14000; // 着地時にプレイヤーを軽く吹き飛ばす力
export const BOSS_PLAYER_KNOCKBACK_DECAY = 0.93;  // プレイヤーのノックバック減衰速度（大きいほどゆっくり止まる。他の敵は0.85で使用中）
// ===== ノックバック演出とめり込み解消の競合防止 =====
export const PLAYER_KNOCKBACK_COLLISION_GRACE = 0.3; // ボスの意図的なノックバック発生後、この秒数だけボス本体との「めり込み解消」を止める
// ===== 人間NPC：水域回避（川でスタックするのを防ぐ） =====
export const HUMAN_WATER_AVOID_DURATION = 1.2; // 川に押し戻された後、この秒数だけ岸沿い方向へ逃走方向をそらす
export const HUMAN_WATER_AVOID_BLEND = 0.8;    // 岸沿い方向への引き寄せ強度（0〜1、大きいほど川と平行に走る）

// ===== デバッグモード（F1で切り替え） =====
export const DEBUG_NOCLIP_SPEED_MULT = 3.0;  // ノークリップ中の移動速度倍率
export const DEBUG_SCORE_STEP = 5000;        // +/-キーでのスコア（被害総額）増減量
export const DEBUG_BOSS_SPAWN_DIST = 3000;   // 即時召喚時、プレイヤーからボスを離す距離