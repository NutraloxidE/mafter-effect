import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

export function WorkerQr({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    void QRCode.toCanvas(canvas, value, { width: 220, margin: 1, errorCorrectionLevel: "M" })
      .then(() => setError(null))
      .catch(() => setError("QR code unavailable — copy the worker link instead."));
  }, [value]);
  return (
    <div style={{ textAlign: "center" }}>
      {error ? <div style={{ color: "#e9a3a3", fontSize: 11 }}>{error}</div> : <canvas ref={canvasRef} aria-label="Worker join QR code" />}
      <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>Scan this on another device to use it as a render worker.</div>
    </div>
  );
}
