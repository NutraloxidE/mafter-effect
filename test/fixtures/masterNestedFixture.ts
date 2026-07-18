import type {
  AnimatedProp,
  Easing,
  Keyframe,
  Project,
  SceneObject,
  TimelineComposition,
  Transform,
  Vec3,
} from "../../src/core/schema";
import { staticProp, vec3 } from "../../src/core/props";

/**
 * master-nested-composite-performance-plan Phase 0 — **repo synthetic fixture**（§5.2）。
 *
 * ユーザーの最大実プロジェクト（`Master=30fps → main 1=15fps → lyric1/2/3`、23,146 dense keyframes、
 * hot interval で 3D-extrude text 45 枚同時可視）の**構造だけ**を小型に再現する。巨大 media や
 * ユーザー固有音源は含めない（決定論・リポジトリ安全）。元 ZIP は 590MB で egress policy 上この
 * 環境からは取得不可のため、性能・op-count ゲートはこの synthetic fixture を基準とする。
 *
 * 再現する構造:
 * - `main 1`: 15fps / 1245 frames / 45 個の 3D-text 風レイヤー（position/rotation/scale を dense KF）
 * - `Master`: 30fps / 2430 frames。`main 1` を precomp レイヤーとして `[0, 531)` に配置
 * - `Master` の [0,531) は `main 1` の child frame 0..265（266 unique）を参照＝ 265/531 が重複
 */

const LINEAR: Easing = { type: "linear" };

/** 45 枚の 3D text を模す（実プロジェクト: lyric1=17 + lyric2=26 + lyric3=19 ≈ 62 objs / 45 同時可視）。 */
export const MAIN1_OBJECT_COUNT = 45;
export const MAIN1_FPS = 15;
export const MAIN1_DURATION = 1245;
export const MASTER_FPS = 30;
export const MASTER_DURATION = 2430;
/** Master 内で main 1 が使われる parent 区間 [0, MAIN1_USE_SPAN)。 */
export const MAIN1_USE_SPAN = 531;

/**
 * 決定論 dense keyframe track を作る。visible window の各 frame 付近に 1 KF を置き、
 * 1 track あたり ~170 KF（実プロジェクトの 178〜218 に相当）。値は seed で決まる純関数。
 */
function denseVec3Track(seed: number, frames: number, base: Vec3, amp: Vec3): AnimatedProp<Vec3> {
  const keyframes: Keyframe<Vec3>[] = [];
  // 実データ同様「ほぼ毎 frame」だが完全同一 frame の重複や飛びも混ぜる。
  let f = 0;
  let k = seed;
  while (f < frames) {
    const wobble = (Math.sin(k * 0.1) + 1) / 2;
    keyframes.push({
      frame: f,
      value: {
        x: base.x + amp.x * Math.sin((f + seed) * 0.07),
        y: base.y + amp.y * Math.cos((f + seed) * 0.05),
        z: base.z + amp.z * Math.sin((f + seed) * 0.03),
      },
      easing: LINEAR,
    });
    // step: 1 か 2（たまに 0=重複 frame を混ぜて二分探索の重複処理も踏ませる）。
    const step = wobble < 0.1 ? 0 : wobble < 0.7 ? 1 : 2;
    f += step === 0 ? 1 : step; // 0 のときは重複 KF を 1 個入れて次へ
    if (step === 0) {
      keyframes.push({ frame: f, value: keyframes[keyframes.length - 1]!.value, easing: LINEAR });
      f += 1;
    }
    k += 1;
  }
  return { value: base, keyframes };
}

function denseTransform(seed: number, frames: number): Transform {
  return {
    anchor: staticProp(vec3(0, 0, 0)),
    position: denseVec3Track(seed, frames, vec3(960, 540, 0), vec3(400, 200, 50)),
    rotation: denseVec3Track(seed + 101, frames, vec3(0, 0, 0), vec3(15, 15, 45)),
    scale: denseVec3Track(seed + 211, frames, vec3(1, 1, 1), vec3(0.3, 0.3, 0)),
  };
}

/** 3D-extrude text 風レイヤー（type "text" + geom3d props）。resolve は transform/opacity を主に見る。 */
function textLayer(i: number, frames: number): SceneObject {
  return {
    id: `main1-text-${String(i).padStart(2, "0")}`,
    name: `lyric ${i}`,
    parent: null,
    zOrder: i + 1,
    enabled: true,
    inPoint: 0,
    outPoint: frames - 1,
    transform: denseTransform(i * 37 + 1, frames),
    opacity: staticProp(1),
    components: [
      {
        type: "text",
        props: {
          text: `char${i}`,
          size: 96,
          geom3d: {
            enabled: true,
            depth: 20,
            bevelSize: 2,
            bevelStyle: "round",
            bevelSegments: 3,
            curveQuality: "medium",
            shading: "lambert",
            lightDir: vec3(0.3, -0.5, 0.8),
            ambient: 0.35,
            shareCanvas: true,
          },
        },
      },
    ],
  };
}

/** 15fps の main 1 相当 comp（45 dense 3D-text レイヤー）。 */
export function makeMain1(): TimelineComposition {
  const objects: SceneObject[] = [];
  for (let i = 0; i < MAIN1_OBJECT_COUNT; i++) objects.push(textLayer(i, MAIN1_DURATION));
  return {
    id: "main1",
    name: "main 1",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: MAIN1_FPS,
    duration: MAIN1_DURATION,
    objects,
  };
}

/** 30fps の Master。main 1 を precomp レイヤーとして [0, MAIN1_USE_SPAN) に置く。 */
export function makeMaster(): TimelineComposition {
  const compLayer: SceneObject = {
    id: "master-main1",
    name: "main 1 (precomp)",
    parent: null,
    zOrder: 1,
    enabled: true,
    inPoint: 0,
    outPoint: MAIN1_USE_SPAN - 1,
    transform: {
      anchor: staticProp(vec3(0, 0, 0)),
      // 親側は毎 frame 動く（duplicate child frame でも parent transform は反映される必要がある）。
      position: denseVec3Track(9001, MAIN1_USE_SPAN, vec3(960, 540, 0), vec3(60, 40, 0)),
      rotation: staticProp(vec3(0, 0, 0)),
      scale: staticProp(vec3(1, 1, 1)),
    },
    opacity: staticProp(1),
    components: [{ type: "comp", props: { compId: "main1", trimStart: 0 } }],
  };
  return {
    id: "master",
    name: "Master",
    kind: "timeline",
    width: 1920,
    height: 1080,
    fps: MASTER_FPS,
    duration: MASTER_DURATION,
    objects: [compLayer],
  };
}

export interface MasterNestedFixture {
  project: Project;
  master: TimelineComposition;
  main1: TimelineComposition;
}

export function makeMasterNestedFixture(): MasterNestedFixture {
  const master = makeMaster();
  const main1 = makeMain1();
  const project: Project = {
    schemaVersion: 1,
    meta: { name: "master-nested-synthetic", createdAt: "2026-07-19T00:00:00Z", updatedAt: "2026-07-19T00:00:00Z" },
    assets: [],
    compositions: [master, main1],
    rootComposition: "master",
    pluginRefs: [],
  };
  return { project, master, main1 };
}

/** main 1 の全 keyframe 数（fixture 規模の確認・実プロジェクト 23,146 に対する比較用）。 */
export function countKeyframes(comp: TimelineComposition): number {
  let n = 0;
  for (const o of comp.objects) {
    for (const key of ["anchor", "position", "rotation", "scale"] as const) {
      n += o.transform[key].keyframes.length;
    }
    n += o.opacity.keyframes.length;
  }
  return n;
}
