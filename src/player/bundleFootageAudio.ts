// fix-plan-v2plus: bundle 専用の footage 音声（standalone audio + video 内蔵音声）検出・時刻マッピング。
//
// hasAudioLayers（BundleAudioClock.ts）は editor preview（PreviewPanel.tsx）でも使われる標準関数で、
// standalone `audio` レイヤーのみを対象にしたセマンティクスを変えてはならない。bundle は video 内蔵
// 音声も別 <audio> 要素として鳴らしたいため、ここに **bundle 専用の別関数** を定義する
// （既存 hasAudioLayers の戻り値・呼び出し元は一切変更しない）。
//
// 純関数のみ（DOM 非依存）。BundleAudioClock.ts から呼ばれる。

import type { AnimatedProp, Frame, Project, TimelineComposition } from "../core/schema";
import { collectFootageAudioSources } from "../runtime/footageAudio";
import { collectFadeClips, computeFadeSuppression, isAutoFadeEnabled, type FadeSuppression } from "../runtime/footageAutoFade";

/** bundle 専用: 1 レイヤー分の音声ソース仕様（standalone audio または video 内蔵音声）。 */
export interface BundleFootageAudioSpec {
  objectId: string;
  assetPath: string;
  inPoint: Frame;
  outPoint: Frame;
  /** 現状どおり plain number 読み取り（animated trimStart は既存未対応・本タスク非変更）。 */
  trimStart: Frame;
  gainProp: AnimatedProp<number>;
  /** §11.5.2 カット端 declick（既定 ON・best-effort: volume 粒度）。 */
  autoFade: boolean;
  suppression: FadeSuppression;
  /** video 内蔵音声は抽出後 <video> を常時ミュートする対象（BundlePlayer が使う）。 */
  componentType: "audio" | "video";
}

/**
 * bundle 専用: timeline から footage 音声レイヤー（standalone audio + video 内蔵音声の両方）を
 * 列挙する純関数。asset が project に存在しないレイヤーは除外する。
 *
 * video の音声トラック有無は asset.meta に判定手段が無いため確認しない（判定手段が無い場合の
 * フォールバックとして「video は常に音声ソース候補」とする — fix-plan-v2plus Phase1）。
 * 音声トラックが実際には無い video の場合、生成される <audio> 要素は単に無音のまま鳴らない
 * だけで、BundleAudioClock は wall-clock 駆動のため無音要素が混ざってもタイミングは壊れない
 * （他レイヤーの再生に影響しない・実害なし）。
 */
export function collectBundleFootageAudioSources(
  project: Project,
  comp: TimelineComposition,
): BundleFootageAudioSpec[] {
  const suppression = computeFadeSuppression(collectFadeClips(comp));
  const out: BundleFootageAudioSpec[] = [];
  for (const source of collectFootageAudioSources(comp)) {
    const asset = project.assets.find((a) => a.id === source.assetId);
    if (!asset) continue;
    const cmp = source.obj.components.find((c) => c.type === source.componentType);
    out.push({
      objectId: source.objectId,
      assetPath: asset.path,
      inPoint: source.inPoint,
      outPoint: source.outPoint,
      trimStart: source.trimStart,
      gainProp: source.gainProp,
      autoFade: cmp ? isAutoFadeEnabled(cmp.props) : true,
      suppression: suppression.get(source.objectId) ?? { in: false, out: false },
      componentType: source.componentType,
    });
  }
  return out;
}

/**
 * bundle 専用: この comp に footage 音声（standalone audio または video 内蔵音声）が
 * 1 つでもあるか。**hasAudioLayers とはセマンティクスが異なる別関数**（あちらは standalone
 * audio のみ判定・editor preview 共有のため変更不可）。
 */
export function hasBundleFootageAudio(project: Project, comp: TimelineComposition): boolean {
  return collectBundleFootageAudioSources(project, comp).length > 0;
}

/**
 * 純関数: comp のフレーム位置（transportFrame。小数可 — 例えば wall-clock 経過秒から逆算した
 * 位置）から、footage レイヤーの **media（ソースファイル内）時刻（秒）** を求める。
 * `inPoint` と `trimStart` を反映する（report.md「副次的な発見」— 既存 BundleAudioClock は
 * これを無視して `(frame - rangeStart)/fps` だけで seek していたため trimStart 付き素材や
 * inPoint がレンジ先頭とズレる素材で誤った位置から再生していた）。
 *
 * 0 未満にはクランプする（transportFrame が inPoint 以前でも負値の currentTime にしない）。
 * frame >= outPoint（レイヤー範囲外）かどうかの判定はここでは行わない（呼び出し側の責務）。
 */
export function footageAudioMediaTimeSec(
  transportFrame: number,
  inPoint: Frame,
  trimStart: Frame,
  fps: number,
): number {
  return Math.max(0, (transportFrame - inPoint) / fps + trimStart / fps);
}
