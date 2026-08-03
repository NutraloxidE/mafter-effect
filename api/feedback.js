// Vercel Serverless Function（Node.js runtime）— POST /api/feedback の中継。
//
// SSH デプロイ（scripts/deploy-ssh.mjs）ではリモートの python サーバ
// （scripts/mafter_http_server.py）が静的配信と ingest を兼ねるが、Vercel は
// 静的ホスティングなので同じ受け口が無い。ここでは既存の ingest オリジンへ
// 転送するだけの薄い proxy を置き、Vercel からもフィードバック送信を成立させる。
//
// 既定は無効: MAFTER_FEEDBACK_ORIGIN 未設定なら何もせず 501 を返す。
// クライアント（src/editor/feedbackCollector.ts）は res.ok でない応答を
// localStorage キューに退避して次回リトライするだけなので、無効でも UI は壊れない。
//
// 環境変数（Vercel プロジェクト設定）:
//   MAFTER_FEEDBACK_ORIGIN  転送先オリジン（例: https://maftereffect.gycp.party）
//   FEEDBACK_INGEST_TOKEN   任意。設定するとクライアントの Authorization を
//                           サーバ側の値で上書きする（トークンをビルドに焼かない運用）。

const FORWARD_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const origin = (process.env.MAFTER_FEEDBACK_ORIGIN ?? "").replace(/\/+$/, "");
  if (!origin) {
    res.status(501).json({ error: "feedback_forwarding_disabled" });
    return;
  }

  const serverToken = process.env.FEEDBACK_INGEST_TOKEN;
  const authorization = serverToken ? `Bearer ${serverToken}` : req.headers.authorization;
  if (!authorization) {
    res.status(401).json({ error: "missing_authorization" });
    return;
  }

  let body;
  try {
    // Vercel が JSON をパース済みなら req.body（object）、未パースなら生ストリーム。
    body = req.body === undefined ? await readRawBody(req) : JSON.stringify(req.body);
  } catch {
    res.status(413).json({ error: "payload_too_large" });
    return;
  }

  try {
    const upstream = await fetch(`${origin}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    res.send(text);
  } catch {
    res.status(502).json({ error: "upstream_unreachable" });
  }
}
