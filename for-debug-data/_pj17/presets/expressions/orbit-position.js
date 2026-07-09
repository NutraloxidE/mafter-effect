// Mafter Effect expression — orbit position (§9)
// @mafter:preset orbit-position
export default (ctx) => {
  const radius = ctx.presetParams.radius ?? 80;
  const freq = ctx.presetParams.frequency ?? 0.5;
  const phaseDeg = ctx.presetParams.phase ?? 0;
  const angle = ctx.time * Math.PI * 2 * freq + (phaseDeg * Math.PI) / 180;
  return {
    ...ctx.value,
    x: ctx.value.x + Math.cos(angle) * radius,
    y: ctx.value.y + Math.sin(angle) * radius,
  };
};
