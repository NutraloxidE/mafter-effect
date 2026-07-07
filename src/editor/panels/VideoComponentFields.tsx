import type { ComponentType } from "react";
import type { ParamDescriptor, SceneObject } from "../../core/schema";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import { MotionTrackFields } from "./MotionTrackFields";
import { PackedAlphaConvertFields } from "./PackedAlphaConvertFields";
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
  const params = def?.params ?? [];

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
      <div style={{ marginTop: 8 }}>
        <PackedAlphaConvertFields videoLayer={obj} />
        <SubjectExtractFields videoLayer={obj} />
        <MotionTrackFields videoLayer={obj} />
      </div>
    </>
  );
}
