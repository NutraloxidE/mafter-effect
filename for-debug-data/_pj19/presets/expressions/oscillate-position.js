// Mafter Effect expression — oscillate position (§9)
// @mafter:preset oscillate-position
export default (ctx) => {
  const amp = ctx.presetParams.amplitude ?? 30;
  const freq = ctx.presetParams.frequency ?? 1;
  return {
    ...ctx.value,
    y: ctx.value.y + Math.sin(ctx.time * Math.PI * 2 * freq) * amp,
  };
};
