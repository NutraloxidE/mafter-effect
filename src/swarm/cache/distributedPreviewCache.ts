import type { Project, TimelineComposition } from "../../core/schema";
import { SWARM_RUNTIME_VERSION, type RenderProfile, type SwarmRenderJob } from "../core/types";

export interface RemotePreviewRequest {
  project: Project;
  comp: TimelineComposition;
  projectRevision: number;
  frame: number;
  quality: "draft" | "precise";
  proxy: string;
  width: number;
  height: number;
  /** 0 = no local measurement yet; the coordinator then uses its own floor. */
  timeoutMs?: number;
}

export function buildPreviewSwarmJob(request: RemotePreviewRequest): SwarmRenderJob {
  const profile: RenderProfile = {
    quality: request.quality,
    proxy: request.proxy,
    width: request.width,
    height: request.height,
  };
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}-${request.frame}`,
    kind: "preview-frame",
    renderRevision: `project-revision-${request.projectRevision}`,
    compositionId: request.comp.id,
    frameStart: request.frame,
    frameEnd: request.frame + 1,
    priority: "playhead",
    profile,
    runtimeVersion: SWARM_RUNTIME_VERSION,
    project: request.project,
    createdAt: Date.now(),
  };
}
