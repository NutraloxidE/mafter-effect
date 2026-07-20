export function avcCodecString(w: number, h: number, fps: number): string {
  const mbW = Math.ceil(w / 16);
  const mbH = Math.ceil(h / 16);
  const frameMbs = mbW * mbH;
  const mbps = frameMbs * Math.max(1, fps);
  const levels: Array<[number, number, number]> = [
    [0x1f, 36864, 108000],
    [0x20, 36864, 216000],
    [0x28, 139264, 245760],
    [0x29, 139264, 245760],
    [0x2a, 139264, 522240],
    [0x32, 696320, 589824],
    [0x33, 696320, 983040],
    [0x34, 696320, 2073600],
  ];
  let chosen = levels[levels.length - 1]![0];
  for (const [idc, maxFs, maxMbps] of levels) {
    if (frameMbs <= maxFs && mbps <= maxMbps) { chosen = idc; break; }
  }
  return `avc1.42e0${chosen.toString(16).padStart(2, "0")}`;
}

export async function configureVideoEncoder(
  encoder: VideoEncoder,
  base: VideoEncoderConfig,
): Promise<void> {
  const prefs: (HardwareAcceleration | undefined)[] = [
    "prefer-hardware",
    undefined,
    "prefer-software",
  ];
  for (const accel of prefs) {
    const cfg: VideoEncoderConfig = accel ? { ...base, hardwareAcceleration: accel } : { ...base };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) {
        const finalConfig = support.config ?? cfg;
        encoder.configure(base.colorSpace ? { ...finalConfig, colorSpace: base.colorSpace } : finalConfig);
        return;
      }
    } catch {
      // Try the next acceleration preference.
    }
  }
  throw new Error(`No supported VideoEncoder config for codec ${base.codec} at ${base.width}x${base.height}`);
}
