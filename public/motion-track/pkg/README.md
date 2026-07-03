# QUAR Engine

**Rust/WASM WebAR SLAM Engine for 60FPS Markerless 6DoF Tracking**

[![Rust](https://img.shields.io/badge/Rust-1.70+-orange.svg)](https://www.rust-lang.org/)
[![WASM](https://img.shields.io/badge/WebAssembly-Ready-blueviolet.svg)](https://webassembly.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-534%20Rust%20%7C%20494%20SDK-brightgreen.svg)](#testing)

QUAR Engine is a high-performance WebAR engine that brings native-quality SLAM tracking to the browser. Built entirely in Rust and compiled to WebAssembly, it delivers real-time 6 degrees of freedom (6DoF) tracking at 60 FPS with a ~140KB gzipped footprint.

## Features

- **6DoF Tracking** - Full rotation and translation via Essential matrix decomposition
- **Visual-Inertial Odometry** - IMU sensor fusion with automatic scale estimation
- **Plane Detection** - RANSAC-based plane fitting with horizontal/vertical classification
- **Hit Testing** - Screen-to-world ray casting for AR object placement
- **Lighting Estimation** - Real-time ambient and directional light analysis
- **ORB Descriptors** - 256-bit binary feature descriptors with Hamming distance matching
- **Loop Closure** - Place recognition using bag-of-words for drift correction
- **Bundle Adjustment** - Levenberg-Marquardt optimization for map refinement

## Live Demos

Try the demos on your phone (requires camera access):

| Demo | Description |
|------|-------------|
| [6DoF Tracking](https://funwayhq.github.io/quar_engine/6dof-demo.html) | Full 6DoF with translation |
| [AR Cube](https://funwayhq.github.io/quar_engine/ar-demo.html) | Basic 3DoF rotation tracking |
| [Advanced AR](https://funwayhq.github.io/quar_engine/advanced-demo.html) | IMU fusion + performance dashboard |
| [Feature Detection](https://funwayhq.github.io/quar_engine/feature-demo.html) | FAST corner visualization |
| [Image Target](https://funwayhq.github.io/quar_engine/image-target-demo.html) | ORB-based image tracking |
| [QR Detection](https://funwayhq.github.io/quar_engine/qr-target-demo.html) | QR finder pattern detection |
| [Web Workers](https://funwayhq.github.io/quar_engine/worker-demo.html) | Off-thread processing |

## Quick Start

### Installation

```bash
# Install Rust (if needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add WASM target
rustup target add wasm32-unknown-unknown

# Install wasm-pack
cargo install wasm-pack

# Build WASM module
wasm-pack build --target web --release
```

### JavaScript Usage

```javascript
import init, { Tracker6DoFHandle, version } from './pkg/quar_engine.js';

// Initialize WASM
await init();
console.log('QUAR Engine:', version());

// Create 6DoF tracker
const tracker = new Tracker6DoFHandle(640, 480);

// In your render loop
function animate() {
  const imageData = ctx.getImageData(0, 0, 640, 480);
  const pose = tracker.process_frame(imageData.data, 640, 480);

  if (pose) {
    // Apply to Three.js camera
    camera.quaternion.set(pose.rotation[0], pose.rotation[1],
                          pose.rotation[2], pose.rotation[3]);
    camera.position.set(pose.translation[0], pose.translation[1],
                        pose.translation[2]);
  }

  requestAnimationFrame(animate);
}
```

### TypeScript SDK

See [sdk/README.md](sdk/README.md) for the full TypeScript SDK with Three.js integration.

```typescript
import { ARSession, createThreeLightingCallbacks, LightingManager } from '@quar/sdk';

// Create AR session with automatic camera and tracking
const session = new ARSession(renderer, scene, camera);
await session.start();

// Add lighting estimation
const lighting = new LightingManager(createThreeLightingCallbacks(THREE));
scene.add(lighting.ambientLight);
scene.add(lighting.directionalLight);
```

## Architecture

Based on [ORB-SLAM3](https://github.com/UZ-SLAMLab/ORB_SLAM3) (Campos et al., IEEE T-RO 2021):

```
+-------------------------------------------------------------+
|                      Browser (JavaScript)                    |
+-------------+-------------+-------------+-------------------+
|   Camera    |     IMU     |   Worker    |     Three.js      |
|   Manager   |   Manager   |   Bridge    |     Adapter       |
+-------------+-------------+-------------+-------------------+
|                    TypeScript SDK                            |
+-------------------------------------------------------------+
|                    WASM Bindings                             |
+-------------------------------------------------------------+
|                       Rust Core                              |
+-----------+-----------+-----------+-----------+-------------+
|  Feature  |  Optical  | Essential |  Bundle   |    Loop     |
| Detection |   Flow    |  Matrix   | Adjustment|   Closure   |
+-----------+-----------+-----------+-----------+-------------+
|   FAST-9  |Lucas-Kanade|  5-point  |    L-M    |   BoW/DBoW  |
|    NMS    |  Pyramid  |  8-point  |  Huber    |   TF-IDF    |
|    ORB    |   Gyro    |  RANSAC   |           |  Pose Graph |
+-----------+-----------+-----------+-----------+-------------+
```

### Core Pipeline

1. **Frame Capture** - Camera frames via getUserMedia
2. **Feature Detection** - FAST-9 corners with NMS, ORB descriptors
3. **Optical Flow** - Lucas-Kanade tracking with gyro compensation
4. **Pose Estimation** - Essential matrix via 8-point + RANSAC
5. **Triangulation** - DLT for 3D point recovery
6. **Bundle Adjustment** - Joint optimization of poses and structure
7. **Loop Closure** - BoW-based place recognition for drift correction

## Project Structure

```
quar_engine/
+-- src/                    # Rust source
|   +-- lib.rs              # WASM entry point
|   +-- features/           # FAST, NMS, ORB, grayscale
|   +-- tracker/            # Optical flow, Essential, BA, Loop Closure
|   +-- lighting/           # Luminance analysis, color temperature
|   +-- memory/             # Arena allocator, frame pool
|   +-- adaptive/           # Quality controller
+-- sdk/                    # TypeScript SDK
|   +-- src/
|       +-- camera/         # CameraManager, FrameCapture
|       +-- ar/             # Tracker6DoF, HitTesting, Anchor
|       +-- three/          # ARSession, ARHelpers
|       +-- lighting/       # LightingManager
|       +-- imu/            # IMUManager, filters
|       +-- debug/          # DebugOverlay
+-- docs/                   # GitHub Pages demos
+-- examples/               # Standalone examples
+-- benches/                # Performance benchmarks
```

## Performance

| Metric | Target | Current |
|--------|--------|---------|
| Tracking Loop | <16ms (60 FPS) | Achieved on modern devices |
| WASM Binary | <300KB gzipped | 319 KB / 140 KB gzipped / 116 KB brotli |
| JS Bindings | - | 101 KB (15 KB gzipped) |
| SDK (ESM) | - | 191 KB (41 KB gzipped) |
| Motion-to-Photon | <30ms | <25ms with IMU |
| Feature Detection | <5ms (640x480) | ~3ms |

## Build Commands

```bash
# Development build
wasm-pack build --target web --dev

# Release build (optimized)
wasm-pack build --target web --release

# Run Rust tests
cargo test

# Run SDK tests
cd sdk && npm test

# Check formatting
cargo fmt --check

# Run lints
cargo clippy -- -D warnings
```

## Testing

The project has comprehensive test coverage:

- **Rust**: 534 unit tests covering all core algorithms
- **SDK**: 494 TypeScript tests with Jest (20 suites)

```bash
# Run all Rust tests
cargo test

# Run with output
cargo test -- --nocapture

# Run SDK tests
cd sdk && npm test
```

## Requirements

- **Rust**: 1.70+ (stable)
- **wasm-pack**: For WASM compilation
- **Node.js**: 18+ (for SDK development)
- **Browser**: Chrome 90+, Safari 14+, Firefox 90+
- **HTTPS**: Required for camera/sensor access

## License

MIT License - see [LICENSE](LICENSE) for details.

## References

- [ORB-SLAM3](https://github.com/UZ-SLAMLab/ORB_SLAM3) - Campos et al., IEEE T-RO 2021
- [FAST Corner Detection](https://www.edwardrosten.com/work/fast.html) - Rosten & Drummond 2006
- [IMU Preintegration](https://arxiv.org/abs/1512.02363) - Forster et al., 2015
