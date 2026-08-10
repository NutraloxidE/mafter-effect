# Render Swarm v1

Render Swarm is a runtime-only optional accelerator. It does not modify
`project.json`, the §5 TypeScript schema, or existing invariants.

```text
Editor / PreviewCacheService
          |
    SwarmCoordinator ---- SwarmScheduler / leases / result validation
          |
    SignalingBackend (Vercel adapter or in-memory test adapter)
          |
       WebRTC DataChannel
          |
     lightweight /w/<join-code> worker page
```

The host is always the coordinator. The local renderer remains authoritative:
remote preview work is accepted only after host-side validation, and any
disconnect, timeout, stale revision, invalid result, unsupported asset, or
signaling failure falls back to the existing local preview cache path.

## Local development

The editor shows `Workers +` beside `Macro`. Opening it creates a short-lived
session and displays a copyable URL, join code, and QR code. Open `/w/<code>` on
another Chromium browser and press `Join as Worker`; the host must approve an
unknown device.

Set `VITE_SWARM_SIGNALING_URL` to the deployed `/api/swarm` base URL when using
the Vercel adapter. `VITE_SWARM_USE_IN_MEMORY=1` is intended only for same-page
unit/dev experiments; it is not cross-tab signaling.

The Vercel route is `api/swarm/[action].ts`. It keeps only temporary rendezvous
state and uses long-poll event delivery only until WebRTC is established. Jobs,
results, heartbeats, and performance telemetry never go through the server.
The included server store is instance-local; a multi-instance deployment must
replace `getVercelServerBackend()` with a short-lived shared signaling store.

The existing static SSH deployment can expose the same six actions through
`scripts/mafter_http_server.py`; it keeps only temporary rendezvous state in
the server process and does not receive jobs or rendered frames. Re-run the
static deployment after changing this server so the deployed API and editor
client are updated together.

## Identity and recovery

Workers create an anonymous ECDSA P-256 identity and persist it locally. The
host sends a nonce after the data channel opens; the worker signs it before the
host restores a trusted logical worker slot. A transport peer ID is therefore
separate from the long-lived device ID and the host-side worker slot.

Jobs are small dynamic leases. The queue prioritizes the playhead, then nearby
frames. Expired or disconnected leases are requeued. A result must match the
job ID, revision, composition, frame, dimensions, PNG format, and runtime
version before it can enter the existing preview cache.

## v1 boundary

Remote preview-cache rendering is enabled for timeline compositions without
asset-backed video or expression scripts. Asset manifest/hash primitives are
present for the next transfer step; asset-backed jobs conservatively remain
local until their content-addressed transfer is wired end to end. Final video
export distribution is intentionally not enabled in v1 so frame ordering, audio
muxing, alpha, nested comps, and existing exporter parity remain unchanged.

TURN is not configured by default. If direct WebRTC connectivity fails, Mafter
continues locally and reports the worker as unavailable.
