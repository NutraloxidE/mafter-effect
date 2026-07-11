// Mafter Effect expression — pulse scale (§9)
// @mafter:preset pulse-scale
function bendPhase(t, bend) {
  if (!bend) return t;
  const x = Math.max(0, Math.min(1, t));
  const b = Math.max(-1, Math.min(1, bend));
  if (b > 0) return Math.pow(x, 1 / (1 + b * 4));
  return Math.pow(x, 1 - b * 4);
}
export default (ctx) => {
  const amount = ctx.presetParams.amount ?? 0.1;
  const freq = ctx.presetParams.frequency ?? 2;
  const waveform = ctx.presetParams.waveform ?? "sine";
  const bend = ctx.presetParams.bend ?? 0;
  const phaseDeg = ctx.presetParams.phase ?? 0;
  const pol = ctx.presetParams.polarity === "-" ? -1 : 1;
  const raw = ctx.time * freq + phaseDeg / 360;
  const t = bendPhase(raw - Math.floor(raw), bend);
  let w;
  switch (waveform) {
    case "triangle":
      w = 1 - 4 * Math.abs(t - 0.5);
      break;
    case "square":
      w = Math.sin(t * Math.PI * 2) >= 0 ? 1 : -1;
      break;
    case "sawtooth":
      w = 2 * t - 1;
      break;
    case "sine":
    default:
      w = Math.sin(t * Math.PI * 2);
      break;
  }
  w *= pol;
  const m = 1 + amount * w;
  return { x: ctx.value.x * m, y: ctx.value.y * m, z: ctx.value.z };
};
