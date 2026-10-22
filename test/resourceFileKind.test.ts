import { describe, expect, it } from "vitest";
import { resourceFileKind } from "../src/editor/resourceFileKind";

describe("resource file kind", () => {
  it.each([
    ["art.SVG", "application/octet-stream", "image"],
    ["image.png", "", "image"],
    ["animation.gif", "image/gif", "image"],
    ["clip.MOV", "", "video"],
    ["clip.webm", "application/octet-stream", "video"],
    ["song.m4a", "video/mp4", "audio"],
    ["sound.WAV", "", "audio"],
    ["unknown", "video/mp4", "video"],
    ["unknown", "audio/wav", "audio"],
    ["unknown", "image/png", "image"],
    ["project.zip", "application/zip", null],
    ["index.html", "text/html", null],
    ["note.txt", "", null],
  ])("classifies %s with MIME %s", (name, type, expected) => {
    expect(resourceFileKind({ name, type })).toBe(expected);
  });
});
