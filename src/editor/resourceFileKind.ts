export type ResourceFileKind = "image" | "video" | "audio";

export function resourceFileKind(file: Pick<File, "name" | "type">): ResourceFileKind | null {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext && ["png", "jpg", "jpeg", "svg", "webp", "gif", "bmp", "avif", "ico", "tif", "tiff"].includes(ext)) return "image";
  if (ext && ["mp4", "webm", "mov", "m4v", "avi", "mkv", "ogv", "mpg", "mpeg", "3gp"].includes(ext)) return "video";
  if (ext && ["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "aiff", "aif", "wma"].includes(ext)) return "audio";
  const kind = file.type.toLowerCase().split("/")[0];
  return kind === "image" || kind === "video" || kind === "audio" ? kind : null;
}
