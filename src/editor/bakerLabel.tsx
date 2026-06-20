/** §27.2 / §28 — Inspector 用 Baker バッジ（previewBakeRequired === true）。 */
export function BakerBadge() {
  return (
    <span
      style={{ marginLeft: 6, fontSize: 10, color: "#8cf", fontWeight: 600 }}
      title="RAM Preview のフレームベイクが必要なエフェクトです"
    >
      Baker
    </span>
  );
}
