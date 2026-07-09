// Mafter Effect expression — wiggle position (§9)
// @mafter:preset wiggle-position
export default (ctx) => {
  const f = ctx.presetParams.frequency ?? 2;
  const a = ctx.presetParams.amplitude ?? 60;
  const s = ctx.presetParams.seed ?? 0;
  return ctx.wiggle(f, a, s);
};
