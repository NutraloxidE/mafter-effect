import { SWARM_PROTOCOL_VERSION, SWARM_RUNTIME_VERSION, type WorkerCapabilities } from "./types";

export function collectWorkerCapabilities(): WorkerCapabilities {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const browser = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
  let webgl = false;
  let webgl2 = false;
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    webgl2 = canvas.getContext("webgl2") !== null;
    webgl = webgl2 || canvas.getContext("webgl") !== null;
  }
  const deviceMemory = nav && "deviceMemory" in nav
    ? Number((nav as Navigator & { deviceMemory?: number }).deviceMemory)
    : undefined;
  const maxCanvasDimension = typeof document !== "undefined"
    ? (() => {
      const canvas = document.createElement("canvas");
      return canvas.width;
    })()
    : undefined;
  return {
    browser,
    userAgent: nav?.userAgent,
    logicalCores: nav?.hardwareConcurrency,
    memoryGiB: Number.isFinite(deviceMemory) ? deviceMemory : undefined,
    webgl,
    webgl2,
    webCodecs: typeof VideoDecoder !== "undefined" && typeof VideoEncoder !== "undefined",
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    maxCanvasDimension,
    runtimeVersion: SWARM_RUNTIME_VERSION,
    protocolVersion: SWARM_PROTOCOL_VERSION,
  };
}

export function isWorkerCompatible(capabilities: WorkerCapabilities, runtimeVersion = SWARM_RUNTIME_VERSION): boolean {
  return capabilities.protocolVersion === SWARM_PROTOCOL_VERSION && capabilities.runtimeVersion === runtimeVersion;
}
