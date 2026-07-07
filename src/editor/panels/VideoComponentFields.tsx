import type { ComponentType } from "react";
import type { ParamDescriptor, SceneObject } from "../../core/schema";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import { isPackedAlphaVideoMeta } from "../../runtime/imageAssetCache";
import { webcodecsUnavailableReason } from "../../runtime/webcodecsVideoEncode";
import { useEditorStore } from "../store";
import { MotionTrackFields } from "./MotionTrackFields";
import { PackedAlphaConvertFields } from "./PackedAlphaConvertFields";
import { PackedExportQualitySelect } from "./PackedExportQualitySelect";
import { PackedPreviewQualitySelect } from "./PackedPreviewQualitySelect";
import { SubjectExtractFields } from "./SubjectExtractFields";

// InspectorPanel の ComponentFields を再利用するための props 型。
type ComponentFieldsProps = {
  obj: SceneObject;
  compIdx: number;
  params: ParamDescriptor[];
  frame: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
  onEditFocus?: () => void;
  onEditBlur?: () => void;
};

/**
 * Video レイヤーの Inspector フィールド。
 * 本体 props は ComponentFields、Motion Track は折りたたみセクションとして分離。
 */
export function VideoComponentFields({
  obj,
  compIdx,
  frame,
  updateObject,
  previewPatch,
  onEditFocus,
  onEditBlur,
  componentFields: ComponentFieldsImpl,
}: {
  obj: SceneObject;
  compIdx: number;
  frame: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
  onEditFocus?: () => void;
  onEditBlur?: () => void;
  componentFields: ComponentType<ComponentFieldsProps>;
}) {
  const def = globalPluginRegistry.getComponentDef("video");
  const project = useEditorStore((s) => s.project);

  const assetId = typeof obj.components[compIdx]?.props["asset"] === "string"
    ? (obj.components[compIdx]!.props["asset"] as string)
    : "";
  const asset = project?.assets.find((a) => a.id === assetId);
  const isPacked = asset?.kind === "video" && isPackedAlphaVideoMeta(asset.meta);

  // §16.2b: packed レイヤーは通常の footageQuality（Quality）ドロップダウンを出さず、
  // 決定論 export には影響しない専用の PackedPreviewQualitySelect に差し替える
  // （同じ prop を2つの UI で編集できてしまう混乱を避ける）。
  const params = isPacked
    ? (def?.params ?? []).filter((p) => p.key !== "footageQuality")
    : (def?.params ?? []);
  const webcodecsWarning = isPacked ? webcodecsUnavailableReason() : null;

  return (
    <>
      <ComponentFieldsImpl
        obj={obj}
        compIdx={compIdx}
        params={params}
        frame={frame}
        updateObject={updateObject}
        previewPatch={previewPatch}
        onEditFocus={onEditFocus}
        onEditBlur={onEditBlur}
      />
      {webcodecsWarning && (
        <div
          style={{
            fontSize: 10,
            color: "#fc8",
            background: "#2a2415",
            padding: "4px 6px",
            borderRadius: 3,
            marginBottom: 6,
            lineHeight: 1.4,
          }}
        >
          ⚠ {webcodecsWarning} プレビュー/書き出し用の縮小プロキシを生成できないため、常に原本画質で再生・書き出しされます。
        </div>
      )}
      {isPacked && (
        <>
          <PackedPreviewQualitySelect videoLayer={obj} compIdx={compIdx} updateObject={updateObject} />
          <PackedExportQualitySelect videoLayer={obj} compIdx={compIdx} updateObject={updateObject} />
        </>
      )}
      <div style={{ marginTop: 8 }}>
        <PackedAlphaConvertFields videoLayer={obj} />
        <SubjectExtractFields videoLayer={obj} />
        <MotionTrackFields videoLayer={obj} />
      </div>
    </>
  );
}
