/** Pulse Scale プリセットの周期波形（§9）。脚本・プレビュー・テストの単一正本。 */

export const PULSE_BEND_GAIN = 4;

export type PulseWaveform = "sine" | "triangle" | "square" | "sawtooth";

/** Serum 風 BEND +/- — 周期位相 t∈[0,1] を凹/直線/凸にワープ。 */
export function bendPhase(t: number, bend: number): number {
  if (!bend) return t;
  const x = Math.max(0, Math.min(1, t));
  const b = Math.max(-1, Math.min(1, bend));
  if (b > 0) return Math.pow(x, 1 / (1 + b * PULSE_BEND_GAIN));
  return Math.pow(x, 1 - b * PULSE_BEND_GAIN);
}

export function pulseWaveValue(waveform: PulseWaveform, t: number): number {
  switch (waveform) {
    case "triangle":
      return 1 - 4 * Math.abs(t - 0.5);
    case "square":
      return Math.sin(t * Math.PI * 2) >= 0 ? 1 : -1;
    case "sawtooth":
      return 2 * t - 1;
    case "sine":
    default:
      return Math.sin(t * Math.PI * 2);
  }
}

/** 周期位相 t∈[0,1)。phaseDeg は 360° 単位（360+ 可）。 */
export function pulseCycleT(time: number, frequency: number, phaseDeg: number): number {
  const raw = time * frequency + phaseDeg / 360;
  return raw - Math.floor(raw);
}

export function polaritySign(polarity: unknown): number {
  return polarity === "-" || polarity === -1 ? -1 : 1;
}

/** 1 周期内の変調値 w ∈ 約 [-1, 1]。 */
export function pulseModulation(
  waveform: string,
  bend: number,
  cycleT: number,
  polarity: unknown = "+",
): number {
  const wf: PulseWaveform = waveform === "triangle" || waveform === "square" || waveform === "sawtooth"
    ? waveform
    : "sine";
  return pulseWaveValue(wf, bendPhase(cycleT, bend)) * polaritySign(polarity);
}

export function pulseScaleMultiplier(
  amount: number,
  waveform: string,
  bend: number,
  cycleT: number,
  polarity: unknown = "+",
): number {
  return 1 + amount * pulseModulation(waveform, bend, cycleT, polarity);
}

/** FS 共有脚本に埋め込む helper（正本と同一式）。 */
export function pulseScaleScriptHelpersJs(): string {
  return `function bendPhase(t, bend) {
  if (!bend) return t;
  const x = Math.max(0, Math.min(1, t));
  const b = Math.max(-1, Math.min(1, bend));
  if (b > 0) return Math.pow(x, 1 / (1 + b * ${PULSE_BEND_GAIN}));
  return Math.pow(x, 1 - b * ${PULSE_BEND_GAIN});
}`;
}
