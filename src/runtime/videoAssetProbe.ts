/** import 時: File から video の natural size と尺を取得（store meta 用）。 */
export interface VideoProbeResult {
  width: number;
  height: number;
  duration: number;
  mime: string;
}

const VIDEO_EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
};

export function videoMimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXT_MIME[ext] ?? "video/mp4";
}

export function probeVideoFile(file: File): Promise<VideoProbeResult> {
  const mime = file.type || videoMimeFromPath(file.name);
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    video.addEventListener("loadedmetadata", () => {
      const width = video.videoWidth > 0 ? video.videoWidth : 100;
      const height = video.videoHeight > 0 ? video.videoHeight : 100;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      cleanup();
      resolve({ width, height, duration, mime });
    });
    video.addEventListener("error", () => {
      cleanup();
      reject(new Error("video metadata probe failed"));
    });
    video.src = url;
  });
}
