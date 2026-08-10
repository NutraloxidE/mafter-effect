#!/usr/bin/env python3
"""Mafter Effect deploy 用の統合サーバ（stdlib のみ・Node/Docker 不要）。

doc/feedback-loop.md Phase 1 の v1 確定版:
  - GET /*            -> --static 配下を配信（SPA フォールバック: 該当ファイルが
                         無ければ index.html を返す）
  - POST /api/feedback -> Bearer トークン検証 -> --feedback-dir/YYYY-MM-DD.jsonl に1行 append
  - その他             -> 404

非破壊 3 条件（.cursor/plans/feedback_undefined_audit_091af114.plan.md G28）:
  1. static 配信は feedback 機能の有無に関わらず既存 `python3 -m http.server` と同等に動く
     （--token 未指定でも static 配信は継続。/api/feedback だけ 404 を返す）。
  2. POST ハンドラの例外は static 配信を巻き込まない（try/except で隔離、500 を返すのみ）。
  3. 起動の冪等化は呼び出し側（deploy-ssh.mjs）が `pkill -f mafter_http_server.py` で担当する
     （本スクリプトは単発プロセスとして起動される前提）。
"""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import secrets
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_PAYLOAD_BYTES = 8 * 1024  # 8KB（doc/feedback-loop.md G11）
MAX_MESSAGE_CHARS = 4000
MAX_SIGNALS = 20
MAX_SIGNAL_LABEL_CHARS = 64
RATE_LIMIT_WINDOW_SEC = 60
RATE_LIMIT_MAX_REQUESTS = 10  # 10 req/min/IP
SWARM_MAX_PAYLOAD_BYTES = 256 * 1024
SWARM_MAX_WAIT_SECONDS = 25
SWARM_DEFAULT_TTL_SECONDS = 30 * 60
SWARM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

_rate_lock = threading.Lock()
_rate_buckets: dict[str, list[float]] = {}

_jsonl_lock = threading.Lock()
_swarm_lock = threading.RLock()
_swarm_sessions: dict[str, "_SwarmSession"] = {}


class _SwarmRequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class _SwarmSession:
    def __init__(self, session_id: str, join_code: str, host_peer_id: str, expires_at: float) -> None:
        self.session_id = session_id
        self.join_code = join_code
        self.host_peer_id = host_peer_id
        self.expires_at = expires_at
        self.peers: dict[str, dict] = {}
        self.events: dict[str, list[dict]] = {host_peer_id: []}
        self.closed = False
        self.condition = threading.Condition(_swarm_lock)


def _swarm_token(length: int) -> str:
    return "".join(secrets.choice(SWARM_CODE_ALPHABET) for _ in range(length))


def _swarm_string(body: dict, key: str, max_length: int = 256) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value or len(value) > max_length:
        raise _SwarmRequestError(400, f"invalid {key}")
    return value


def _swarm_session(session_id: str) -> _SwarmSession:
    session = _swarm_sessions.get(session_id)
    if session is None or session.closed:
        raise _SwarmRequestError(400, "Unknown swarm session")
    if session.expires_at <= time.time():
        session.closed = True
        _swarm_emit(session, session.host_peer_id, {"type": "session-expired"})
        _swarm_sessions.pop(session.session_id, None)
        raise _SwarmRequestError(400, "Swarm session expired")
    return session


def _swarm_emit(session: _SwarmSession, peer_id: str, event: dict) -> None:
    session.events.setdefault(peer_id, []).append(event)
    session.condition.notify_all()


def _swarm_create(body: dict) -> dict:
    host_peer_id = _swarm_string(body, "hostPeerId")
    _swarm_string(body, "hostDeviceId")
    _swarm_string(body, "hostLabel")
    expires_in_ms = body.get("expiresInMs", SWARM_DEFAULT_TTL_SECONDS * 1000)
    if isinstance(expires_in_ms, bool) or not isinstance(expires_in_ms, (int, float)) or not math.isfinite(float(expires_in_ms)):
        raise _SwarmRequestError(400, "invalid expiresInMs")
    ttl_seconds = max(60, min(SWARM_DEFAULT_TTL_SECONDS, float(expires_in_ms) / 1000))
    now = time.time()
    with _swarm_lock:
        session_id = f"session-{_swarm_token(12)}"
        join_code = _swarm_token(6)
        session = _SwarmSession(session_id, join_code, host_peer_id, now + ttl_seconds)
        _swarm_sessions[session_id] = session
    return {"sessionId": session_id, "joinCode": join_code, "expiresAt": int(session.expires_at * 1000)}


def _swarm_join(body: dict) -> dict:
    join_code = _swarm_string(body, "joinCode", 64)
    peer = body.get("peer")
    if not isinstance(peer, dict):
        raise _SwarmRequestError(400, "invalid peer")
    peer_id = _swarm_string(peer, "peerId")
    _swarm_string(peer, "deviceId")
    _swarm_string(peer, "label")
    if not isinstance(peer.get("publicKeyJwk"), dict):
        raise _SwarmRequestError(400, "invalid publicKeyJwk")
    requested_at = peer.get("requestedAt", int(time.time() * 1000))
    if isinstance(requested_at, bool) or not isinstance(requested_at, (int, float)) or not math.isfinite(float(requested_at)):
        raise _SwarmRequestError(400, "invalid requestedAt")
    normalized_peer = dict(peer)
    normalized_peer["requestedAt"] = int(requested_at)
    with _swarm_lock:
        session = next((item for item in _swarm_sessions.values() if item.join_code == join_code), None)
        if session is None:
            raise _SwarmRequestError(400, "Unknown swarm join code")
        _swarm_session(session.session_id)
        session.peers[peer_id] = normalized_peer
        _swarm_emit(session, session.host_peer_id, {"type": "peer-join-request", "peer": normalized_peer})
        descriptor = {
            "sessionId": session.session_id,
            "joinCode": session.join_code,
            "expiresAt": int(session.expires_at * 1000),
        }
    return {"session": descriptor, "peer": normalized_peer}


def _swarm_approve(body: dict) -> None:
    session_id = _swarm_string(body, "sessionId")
    host_peer_id = _swarm_string(body, "hostPeerId")
    peer_id = _swarm_string(body, "peerId")
    approved = body.get("approved") is True
    with _swarm_lock:
        session = _swarm_session(session_id)
        if session.host_peer_id != host_peer_id:
            raise _SwarmRequestError(403, "Only the host may approve a worker")
        peer = session.peers.get(peer_id)
        if peer is None:
            raise _SwarmRequestError(400, "Unknown worker")
        if approved:
            _swarm_emit(session, peer_id, {"type": "peer-approved", "peer": peer, "hostPeerId": host_peer_id})
        else:
            _swarm_emit(session, peer_id, {"type": "peer-rejected", "peerId": peer_id, "reason": "Host rejected the worker"})
            session.peers.pop(peer_id, None)


def _swarm_signal(body: dict) -> None:
    session_id = _swarm_string(body, "sessionId")
    from_peer_id = _swarm_string(body, "fromPeerId")
    to_peer_id = _swarm_string(body, "toPeerId")
    signal = body.get("signal")
    if not isinstance(signal, dict) or signal.get("kind") not in ("description", "candidate"):
        raise _SwarmRequestError(400, "invalid signal")
    with _swarm_lock:
        session = _swarm_session(session_id)
        valid_peers = set(session.peers) | {session.host_peer_id}
        if from_peer_id not in valid_peers:
            raise _SwarmRequestError(400, "Unknown sender")
        if to_peer_id not in valid_peers:
            raise _SwarmRequestError(400, "Unknown recipient")
        _swarm_emit(session, to_peer_id, {"type": "signal", "fromPeerId": from_peer_id, "payload": signal})


def _swarm_events(body: dict) -> dict:
    session_id = _swarm_string(body, "sessionId")
    peer_id = _swarm_string(body, "peerId")
    wait_ms = body.get("waitMs", 0)
    if isinstance(wait_ms, bool) or not isinstance(wait_ms, (int, float)) or not math.isfinite(float(wait_ms)):
        raise _SwarmRequestError(400, "invalid waitMs")
    wait_seconds = max(0, min(SWARM_MAX_WAIT_SECONDS, float(wait_ms) / 1000))
    with _swarm_lock:
        session = _swarm_session(session_id)
        if peer_id != session.host_peer_id and peer_id not in session.peers:
            raise _SwarmRequestError(400, "Unknown swarm peer")
        deadline = time.monotonic() + wait_seconds
        queue = session.events.setdefault(peer_id, [])
        while not queue and not session.closed:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            session.condition.wait(remaining)
        events = list(queue)
        queue.clear()
    return {"events": events}


def _swarm_close(body: dict) -> None:
    session_id = _swarm_string(body, "sessionId")
    with _swarm_lock:
        session = _swarm_sessions.pop(session_id, None)
        if session is None:
            return
        session.closed = True
        for peer_id in session.peers:
            _swarm_emit(session, peer_id, {"type": "peer-left", "peerId": session.host_peer_id})
        session.condition.notify_all()


def _check_rate_limit(ip: str) -> bool:
    """True を返せば許可。超過なら False。"""
    now = time.time()
    with _rate_lock:
        bucket = _rate_buckets.setdefault(ip, [])
        cutoff = now - RATE_LIMIT_WINDOW_SEC
        bucket[:] = [t for t in bucket if t > cutoff]
        if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
            return False
        bucket.append(now)
        return True


def _validate_payload(raw: dict) -> tuple[bool, str]:
    if raw.get("schemaVersion") != 1:
        return False, "unsupported schemaVersion"
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        return False, "missing id"
    if not isinstance(raw.get("sessionId"), str):
        return False, "missing sessionId"
    signals = raw.get("signals")
    if not isinstance(signals, list) or len(signals) > MAX_SIGNALS:
        return False, "invalid signals"
    for s in signals:
        if not isinstance(s, str) or len(s) > MAX_SIGNAL_LABEL_CHARS:
            return False, "invalid signal label"
    message = raw.get("message")
    if message is not None and not isinstance(message, str):
        return False, "invalid message"
    return True, ""


class FeedbackRequestHandler(BaseHTTPRequestHandler):
    server_version = "MafterHTTP/1.0"

    # サブクラスのクラス変数として deploy 時に注入される（argparse 結果）。
    static_root: Path
    feedback_dir: Path | None
    token: str | None

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib シグネチャ踏襲
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    # ── GET: static 配信（SPA フォールバック） ──────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        try:
            self._serve_static()
        except Exception:  # noqa: BLE001 - static 配信は落とさない
            self.send_error(500, "Internal error")

    def do_HEAD(self) -> None:  # noqa: N802
        try:
            self._serve_static(head_only=True)
        except Exception:  # noqa: BLE001
            self.send_error(500, "Internal error")

    def _serve_static(self, head_only: bool = False) -> None:
        parsed = urllib.parse.urlparse(self.path)
        rel_path = urllib.parse.unquote(parsed.path).lstrip("/")

        candidate = (self.static_root / rel_path).resolve() if rel_path else self.static_root
        try:
            candidate.relative_to(self.static_root.resolve())
        except ValueError:
            self.send_error(403, "Forbidden")
            return

        if candidate.is_dir():
            candidate = candidate / "index.html"

        if not candidate.is_file():
            # SPA フォールバック（API パス以外）
            fallback = self.static_root / "index.html"
            if fallback.is_file():
                candidate = fallback
            else:
                self.send_error(404, "Not found")
                return

        try:
            body = candidate.read_bytes()
        except OSError:
            self.send_error(404, "Not found")
            return

        mime, _ = mimetypes.guess_type(str(candidate))
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    # ── POST: /api/feedback のみ ────────────────────────────────────────
    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/swarm/"):
            try:
                self._handle_swarm(parsed.path.rsplit("/", 1)[-1])
            except _SwarmRequestError as error:
                self._send_json(error.status, {"ok": False, "error": error.message})
            except Exception:
                self._send_json(500, {"ok": False, "error": "internal_error"})
            return
        if parsed.path != "/api/feedback":
            self.send_error(404, "Not found")
            return
        try:
            self._handle_feedback()
        except Exception:  # noqa: BLE001 - API 例外を static 配信に波及させない（非破壊条件2）
            self._send_json(500, {"error": "internal_error"})

    def _read_json_body(self, max_bytes: int) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as error:
            raise _SwarmRequestError(400, "invalid content length") from error
        if length <= 0 or length > max_bytes:
            raise _SwarmRequestError(413, "payload_too_large")
        raw_body = self.rfile.read(length)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise _SwarmRequestError(400, "invalid_json") from error
        if not isinstance(payload, dict):
            raise _SwarmRequestError(400, "invalid_payload")
        return payload

    def _handle_swarm(self, action: str) -> None:
        body = self._read_json_body(SWARM_MAX_PAYLOAD_BYTES)
        if action == "create":
            value = _swarm_create(body)
        elif action == "join":
            value = _swarm_join(body)
        elif action == "approve":
            _swarm_approve(body)
            value = None
        elif action == "signal":
            _swarm_signal(body)
            value = None
        elif action == "events":
            value = _swarm_events(body)
        elif action == "close":
            _swarm_close(body)
            value = None
        else:
            self._send_json(404, {"ok": False, "error": "unknown swarm action"})
            return
        self._send_json(200, {"ok": True, "value": value})

    def _handle_feedback(self) -> None:
        if not self.token:
            # トークン未設定 = feedback 機能オフ。static 専用サーバとして振る舞う。
            self.send_error(404, "Not found")
            return

        auth = self.headers.get("Authorization", "")
        expected = f"Bearer {self.token}"
        if auth != expected:
            self._send_json(401, {"error": "unauthorized"})
            return

        ip = self.client_address[0]
        if not _check_rate_limit(ip):
            self._send_json(429, {"error": "rate_limited"})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_PAYLOAD_BYTES:
            self._send_json(413, {"error": "payload_too_large"})
            return

        raw_body = self.rfile.read(length)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "invalid_json"})
            return

        if not isinstance(payload, dict):
            self._send_json(400, {"error": "invalid_payload"})
            return

        ok, reason = _validate_payload(payload)
        if not ok:
            self._send_json(400, {"error": reason})
            return

        if isinstance(payload.get("message"), str) and len(payload["message"]) > MAX_MESSAGE_CHARS:
            payload["message"] = payload["message"][:MAX_MESSAGE_CHARS]

        if self.feedback_dir is not None:
            self._append_jsonl(payload)

        self._send_json(200, {"ok": True})

    def _append_jsonl(self, payload: dict) -> None:
        assert self.feedback_dir is not None
        self.feedback_dir.mkdir(parents=True, exist_ok=True)
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        target = self.feedback_dir / f"{date_str}.jsonl"
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with _jsonl_lock:
            with target.open("a", encoding="utf-8") as f:
                f.write(line)

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def make_handler(static_root: Path, feedback_dir: Path | None, token: str | None):
    class Handler(FeedbackRequestHandler):
        pass

    Handler.static_root = static_root.resolve()
    Handler.feedback_dir = feedback_dir
    Handler.token = token
    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=80)
    parser.add_argument("--static", type=str, required=True, help="static ファイル配信ルート")
    parser.add_argument("--feedback-dir", type=str, default=None, help="jsonl 保存先ディレクトリ")
    parser.add_argument("--token", type=str, default=os.environ.get("FEEDBACK_INGEST_TOKEN"), help="Bearer トークン（未指定なら feedback API 無効）")
    args = parser.parse_args()

    static_root = Path(args.static)
    if not static_root.is_dir():
        print(f"error: --static directory not found: {static_root}", file=sys.stderr)
        sys.exit(1)

    feedback_dir = Path(args.feedback_dir) if args.feedback_dir else None

    handler_cls = make_handler(static_root, feedback_dir, args.token or None)
    server = ThreadingHTTPServer(("0.0.0.0", args.port), handler_cls)

    mode = "static+feedback" if args.token else "static-only (no FEEDBACK_INGEST_TOKEN)"
    print(f"Mafter HTTP server listening on :{args.port} ({mode}, root={static_root})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
