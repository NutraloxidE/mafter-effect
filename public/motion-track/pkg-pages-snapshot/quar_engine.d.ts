/* tslint:disable */
/* eslint-disable */

export class AdaptiveConfig {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create configuration for 30 FPS target.
   */
  static target_30fps(): AdaptiveConfig;
  /**
   * Create default configuration targeting 60 FPS.
   */
  constructor();
  /**
   * Target FPS (default: 60)
   */
  target_fps: number;
  /**
   * Minimum acceptable FPS (default: 30)
   */
  min_fps: number;
  /**
   * Enable adaptive quality adjustment
   */
  enabled: boolean;
  /**
   * Smoothing factor for frame time averaging (0-1)
   */
  smoothing: number;
  /**
   * Number of frames to wait before adjusting
   */
  adjustment_delay: number;
}

export class AdaptiveHandle {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get frame skip setting.
   */
  frame_skip(): number;
  /**
   * Check if degraded.
   */
  is_degraded(): boolean;
  /**
   * Reset statistics.
   */
  reset_stats(): void;
  /**
   * Get current window size setting.
   */
  window_size(): number;
  /**
   * Get current max features setting.
   */
  max_features(): number;
  /**
   * Record a frame time and check if quality changed.
   */
  record_frame(frame_time_ms: number): boolean;
  /**
   * Get estimated FPS.
   */
  estimated_fps(): number;
  /**
   * Get current quality level (0=High, 1=Medium, 2=Low, 3=Minimal).
   */
  quality_level(): number;
  /**
   * Get current FAST threshold.
   */
  fast_threshold(): number;
  /**
   * Get current pyramid levels setting.
   */
  pyramid_levels(): number;
  /**
   * Get average frame time in ms.
   */
  avg_frame_time_ms(): number;
  /**
   * Force a quality level.
   */
  set_quality_level(level: number): void;
  /**
   * Create a new adaptive controller.
   */
  constructor();
}

export class BreakdownReport {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  grayscale_pct: number;
  detection_pct: number;
  tracking_pct: number;
  pose_pct: number;
  other_pct: number;
}

export class EngineConfig {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create a new engine configuration with default values.
   */
  constructor();
  /**
   * Get the target FPS.
   */
  target_fps: number;
  /**
   * Check if adaptive quality is enabled.
   */
  adaptive_quality: boolean;
  /**
   * Check if debug mode is enabled.
   */
  debug: boolean;
}

export class FrameTiming {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create a new frame timing.
   */
  constructor();
  /**
   * Total frame processing time
   */
  total_ms: number;
  /**
   * Grayscale conversion time
   */
  grayscale_ms: number;
  /**
   * Feature detection time
   */
  detection_ms: number;
  /**
   * Optical flow tracking time
   */
  tracking_ms: number;
  /**
   * Pose estimation time
   */
  pose_ms: number;
  /**
   * Number of features detected
   */
  feature_count: number;
  /**
   * Number of points tracked
   */
  tracked_count: number;
}

export class ImageTargetDetectorHandle {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create a detector with custom configuration.
   *
   * # Arguments
   * * `min_matches` - Minimum matches required (default: 10)
   * * `ransac_threshold` - RANSAC inlier threshold in pixels (default: 3.0)
   * * `min_inliers` - Minimum inliers required (default: 8)
   */
  static with_config(min_matches: number, ransac_threshold: number, min_inliers: number): ImageTargetDetectorHandle;
  /**
   * Add a reference image template.
   *
   * # Arguments
   * * `id` - Unique identifier for this template
   * * `rgba` - RGBA pixel data of the template image
   * * `width` - Template width in pixels
   * * `height` - Template height in pixels
   * * `physical_width_meters` - Physical width of the target in meters
   *
   * # Returns
   * True if template was added successfully (has enough features)
   */
  add_template(id: string, rgba: Uint8Array, width: number, height: number, physical_width_meters: number): boolean;
  /**
   * Set camera intrinsics for pose estimation.
   *
   * # Arguments
   * * `fx` - Focal length X (pixels)
   * * `fy` - Focal length Y (pixels)
   * * `cx` - Principal point X
   * * `cy` - Principal point Y
   */
  set_intrinsics(fx: number, fy: number, cx: number, cy: number): void;
  /**
   * Get the number of registered templates.
   */
  template_count(): number;
  /**
   * Remove a template by ID.
   *
   * # Returns
   * True if template was found and removed
   */
  remove_template(id: string): boolean;
  /**
   * Get feature count for a template.
   *
   * # Returns
   * Number of features, or 0 if template not found
   */
  get_template_feature_count(id: string): number;
  /**
   * Create a new image target detector.
   */
  constructor();
  /**
   * Detect all registered templates in a camera frame.
   *
   * # Arguments
   * * `rgba` - RGBA pixel data of the camera frame
   * * `width` - Frame width
   * * `height` - Frame height
   *
   * # Returns
   * Array of detected targets as JSON
   */
  detect(rgba: Uint8Array, width: number, height: number): any;
}

export class JsHitResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get normal as [x, y, z] array.
   */
  normal(): Float64Array;
  /**
   * Get position as [x, y, z] array.
   */
  position(): Float64Array;
  /**
   * X position of hit
   */
  x: number;
  /**
   * Y position of hit
   */
  y: number;
  /**
   * Z position of hit
   */
  z: number;
  /**
   * Normal X component
   */
  normal_x: number;
  /**
   * Normal Y component
   */
  normal_y: number;
  /**
   * Normal Z component
   */
  normal_z: number;
  /**
   * Distance from ray origin
   */
  distance: number;
  /**
   * ID of the plane hit
   */
  plane_id: bigint;
}

export class JsPlaneInfo {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get normal as [x, y, z] array.
   */
  get_normal(): Float64Array;
  /**
   * Check if this is a vertical plane (wall).
   */
  is_vertical(): boolean;
  /**
   * Check if this is a horizontal plane.
   */
  is_horizontal(): boolean;
  /**
   * Get center as [x, y, z] array.
   */
  center(): Float64Array;
  /**
   * Check if this is a floor plane.
   */
  is_floor(): boolean;
  /**
   * Plane ID
   */
  id: bigint;
  /**
   * Center X
   */
  center_x: number;
  /**
   * Center Y
   */
  center_y: number;
  /**
   * Center Z
   */
  center_z: number;
  /**
   * Normal X
   */
  normal_x: number;
  /**
   * Normal Y
   */
  normal_y: number;
  /**
   * Normal Z
   */
  normal_z: number;
  /**
   * Width extent
   */
  width: number;
  /**
   * Height extent
   */
  height: number;
  /**
   * Number of inlier points
   */
  inlier_count: number;
  /**
   * Confidence (0.0 to 1.0)
   */
  confidence: number;
  /**
   * Plane type: 0=HorizontalUp, 1=HorizontalDown, 2=Vertical, 3=Arbitrary
   */
  plane_type: number;
}

export class LightingEstimatorHandle {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the overall confidence (0.0-1.0).
   */
  confidence(): number;
  /**
   * Get the current estimate without processing a new frame.
   */
  get_estimate(): any;
  /**
   * Get the ambient color as [r, g, b] array.
   */
  ambient_color(): Float32Array;
  /**
   * Analyze a frame and return the lighting estimate as a JavaScript object.
   *
   * # Arguments
   * * `rgba` - RGBA pixel data as Uint8ClampedArray
   * * `width` - Image width in pixels
   * * `height` - Image height in pixels
   *
   * # Returns
   * JsValue containing the LightingEstimate object
   */
  analyze_frame(rgba: Uint8Array, width: number, height: number): any;
  /**
   * Create an estimator with custom smoothing factor (0.0-0.99).
   */
  static with_smoothing(smoothing: number): LightingEstimatorHandle;
  /**
   * Get the ambient intensity (0.0-1.0).
   */
  ambient_intensity(): number;
  /**
   * Get the color temperature in Kelvin.
   */
  color_temperature(): number;
  /**
   * Get the directional light direction as [x, y, z] unit vector.
   */
  directional_direction(): Float32Array;
  /**
   * Get the directional light intensity (0.0-1.0).
   */
  directional_intensity(): number;
  /**
   * Set the analysis interval (frames between full analysis).
   * Lower values = more responsive but higher CPU usage.
   */
  set_analysis_interval(interval: number): void;
  /**
   * Create a new lighting estimator handle.
   */
  constructor();
  /**
   * Reset the estimator state.
   */
  reset(): void;
}

export class PlaneDetectorHandle {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the number of detected planes.
   */
  num_planes(): number;
  /**
   * Detect planes from a flat array of 3D points [x1,y1,z1, x2,y2,z2, ...].
   */
  detect_planes(points: Float64Array): number;
  /**
   * Get the floor plane (largest horizontal-up plane), if any.
   */
  get_floor_plane(): JsPlaneInfo | undefined;
  /**
   * Set the minimum number of inliers required to accept a plane.
   */
  set_min_inliers(min_inliers: number): void;
  /**
   * Perform a hit test on vertical planes only (walls).
   */
  hit_test_vertical(origin_x: number, origin_y: number, origin_z: number, direction_x: number, direction_y: number, direction_z: number, max_distance: number): JsHitResult | undefined;
  /**
   * Create a plane detector optimized for floor detection.
   */
  static for_floor_detection(): PlaneDetectorHandle;
  /**
   * Perform a hit test on horizontal planes only (floors/tables).
   */
  hit_test_horizontal(origin_x: number, origin_y: number, origin_z: number, direction_x: number, direction_y: number, direction_z: number, max_distance: number): JsHitResult | undefined;
  /**
   * Set the inlier threshold (distance from plane to be considered an inlier).
   */
  set_inlier_threshold(threshold: number): void;
  /**
   * Create a new plane detector with default settings.
   */
  constructor();
  /**
   * Clear all detected planes.
   */
  clear(): void;
  /**
   * Reset the detector (clears planes and resets plane ID counter).
   */
  reset(): void;
  /**
   * Perform a hit test with a ray.
   *
   * # Arguments
   * * `origin_x, origin_y, origin_z` - Ray origin
   * * `direction_x, direction_y, direction_z` - Ray direction (should be normalized)
   * * `max_distance` - Maximum distance to check
   *
   * # Returns
   * The closest hit result, or None if no hit.
   */
  hit_test(origin_x: number, origin_y: number, origin_z: number, direction_x: number, direction_y: number, direction_z: number, max_distance: number): JsHitResult | undefined;
  /**
   * Get info about a detected plane by index.
   */
  get_plane(index: number): JsPlaneInfo | undefined;
}

export class Pose3D {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the rotation as a JavaScript array [qx, qy, qz, qw].
   */
  quaternion(): Float32Array;
  /**
   * Convert to a 4x4 transformation matrix in column-major order.
   */
  to_matrix4(): Float32Array;
  /**
   * Create a pose from position and quaternion components.
   */
  static from_components(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): Pose3D;
  /**
   * Create a new identity pose (no rotation, at origin).
   */
  constructor();
  /**
   * Get the position as a JavaScript array [x, y, z].
   */
  position(): Float32Array;
  /**
   * X position in meters
   */
  x: number;
  /**
   * Y position in meters
   */
  y: number;
  /**
   * Z position in meters
   */
  z: number;
  /**
   * Quaternion X component
   */
  qx: number;
  /**
   * Quaternion Y component
   */
  qy: number;
  /**
   * Quaternion Z component
   */
  qz: number;
  /**
   * Quaternion W component
   */
  qw: number;
}

export class QrDetectorHandle {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the current QR size setting in meters.
   */
  get_qr_size(): number;
  /**
   * Set the physical size of QR codes in meters.
   *
   * This is used for pose estimation. Default is 0.05 (5cm).
   */
  set_qr_size(size_meters: number): void;
  /**
   * Set camera intrinsics for pose estimation.
   *
   * # Arguments
   * * `fx` - Focal length X (pixels)
   * * `fy` - Focal length Y (pixels)
   * * `cx` - Principal point X
   * * `cy` - Principal point Y
   */
  set_intrinsics(fx: number, fy: number, cx: number, cy: number): void;
  /**
   * Debug: Get detailed pattern info as JSON.
   */
  debug_get_patterns(rgba: Uint8Array, width: number, height: number): any;
  /**
   * Debug: Get the computed threshold value.
   */
  debug_get_threshold(rgba: Uint8Array, width: number, height: number): number;
  /**
   * Debug: Get number of finder patterns detected (before QR validation).
   * Returns the count of individual finder patterns found in the frame.
   */
  debug_detect_patterns(rgba: Uint8Array, width: number, height: number): number;
  /**
   * Debug: Get image stats (min, max, mean) to verify grayscale conversion.
   */
  debug_get_image_stats(rgba: Uint8Array, _width: number, _height: number): any;
  /**
   * Create a new QR code detector.
   */
  constructor();
  /**
   * Detect QR codes in a camera frame.
   *
   * # Arguments
   * * `rgba` - RGBA pixel data
   * * `width` - Frame width
   * * `height` - Frame height
   *
   * # Returns
   * Array of detected QR codes as JSON
   */
  detect(rgba: Uint8Array, width: number, height: number): any;
}

/**
 * Quality level for tracking.
 */
export enum QualityLevel {
  /**
   * Highest quality - all features enabled
   */
  High = 0,
  /**
   * Medium quality - reduced features
   */
  Medium = 1,
  /**
   * Low quality - minimal processing for weak devices
   */
  Low = 2,
  /**
   * Minimal quality - emergency mode
   */
  Minimal = 3,
}

export class QualitySettings {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get settings for a quality level.
   */
  static for_level(level: QualityLevel): QualitySettings;
  /**
   * Maximum features to track
   */
  max_features: number;
  /**
   * Number of pyramid levels
   */
  pyramid_levels: number;
  /**
   * Lucas-Kanade window size
   */
  window_size: number;
  /**
   * FAST detection threshold
   */
  fast_threshold: number;
  /**
   * Frame skip interval (1 = no skip, 2 = every other frame)
   */
  frame_skip: number;
  /**
   * Enable pose smoothing
   */
  pose_smoothing: boolean;
}

export class TimingReport {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get breakdown as percentages.
   */
  breakdown_percentages(): BreakdownReport;
  /**
   * Convert to JSON string.
   */
  to_json(): string;
  /**
   * Check if meeting 30 FPS target (< 33.33ms).
   */
  readonly meets_30fps: boolean;
  /**
   * Check if meeting 60 FPS target (< 16.67ms).
   */
  readonly meets_60fps: boolean;
  /**
   * Get estimated FPS based on average frame time.
   */
  readonly estimated_fps: number;
  /**
   * Number of frames measured
   */
  frame_count: number;
  /**
   * Average total frame time in ms
   */
  avg_total_ms: number;
  /**
   * Average grayscale conversion time
   */
  avg_grayscale_ms: number;
  /**
   * Average feature detection time
   */
  avg_detection_ms: number;
  /**
   * Average tracking time
   */
  avg_tracking_ms: number;
  /**
   * Average pose estimation time
   */
  avg_pose_ms: number;
  /**
   * Maximum frame time
   */
  max_total_ms: number;
  /**
   * Minimum frame time
   */
  min_total_ms: number;
}

export class Tracker6DoFHandle {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get estimated gravity vector as [gx, gy, gz].
   */
  get_gravity(): Float64Array;
  /**
   * Get current VIO scale estimate.
   */
  get_vio_scale(): number;
  /**
   * Check if device is stationary (from ZUPT detection).
   */
  is_stationary(): boolean;
  /**
   * Process a frame and return the 6DoF pose as JSON.
   */
  process_frame(rgba: Uint8Array, width: number, height: number): any;
  /**
   * Get map points as a flat array [x1, y1, z1, x2, y2, z2, ...].
   * Points are in camera frame coordinates (scaled by current scale factor).
   */
  get_map_points(): Float64Array;
  /**
   * Get IMU buffer length (number of IMU samples stored).
   */
  imu_buffer_len(): number;
  /**
   * Check if VIO mode is enabled.
   */
  is_vio_enabled(): boolean;
  /**
   * Test Essential matrix computation (for WASM debugging).
   */
  static test_essential(): boolean;
  /**
   * Get the number of tracked points.
   */
  tracked_points(): number;
  /**
   * Get accelerometer-derived speed (magnitude) in m/s.
   */
  get_accel_speed(): number;
  /**
   * Get the number of triangulated 3D map points.
   */
  map_point_count(): number;
  /**
   * Enable or disable VIO (Visual-Inertial Odometry) mode.
   */
  set_vio_enabled(enabled: boolean): void;
  /**
   * Clear the IMU buffer.
   */
  clear_imu_buffer(): void;
  /**
   * Clear all map points.
   */
  clear_map_points(): void;
  /**
   * Reset the stabilizer.
   */
  reset_stabilizer(): void;
  /**
   * Get the last computed max parallax (for debugging translation issues).
   */
  get_last_parallax(): number;
  /**
   * Process a frame with VIO fusion.
   * Returns the pose as JSON.
   */
  process_frame_vio(rgba: Uint8Array, width: number, height: number, timestamp: number): any;
  /**
   * Update stabilizer with optical flow magnitude.
   * Call this each frame after processing.
   */
  update_stabilizer(flow_magnitude: number, time: number): void;
  /**
   * Get accelerometer-derived position as [x, y, z] in meters.
   */
  get_accel_position(): Float64Array;
  /**
   * Get accelerometer-derived velocity as [vx, vy, vz] in m/s.
   */
  get_accel_velocity(): Float64Array;
  /**
   * Check if VIO is initialized (gravity estimated).
   */
  is_vio_initialized(): boolean;
  /**
   * Apply position stabilization.
   * Call after computing translation each frame.
   */
  apply_stabilization(): void;
  /**
   * Get the gravity rotation matrix as a flat array (row-major, 9 elements).
   * This transforms from camera frame to gravity-aligned world frame.
   */
  get_gravity_rotation(): Float64Array;
  /**
   * Get map points transformed to gravity-aligned world frame.
   * Returns a flat array [x1, y1, z1, x2, y2, z2, ...].
   * World frame has Y pointing up (opposite to gravity).
   */
  get_map_points_world(): Float64Array;
  /**
   * Get scale estimation confidence (0.0-1.0).
   */
  get_scale_confidence(): number;
  /**
   * Reset accelerometer position to zero.
   */
  reset_accel_position(): void;
  /**
   * Check if stabilization is enabled.
   */
  is_stabilization_enabled(): boolean;
  /**
   * Get stabilized stationary state.
   */
  is_stabilized_stationary(): boolean;
  /**
   * Enable or disable position stabilization.
   */
  set_stabilization_enabled(enabled: boolean): void;
  /**
   * Get stationary duration from stabilizer (seconds).
   */
  stabilizer_stationary_duration(): number;
  /**
   * Check if keyframe-based translation is enabled.
   */
  is_keyframe_translation_enabled(): boolean;
  /**
   * Enable or disable keyframe-based translation.
   * When enabled, translation uses larger temporal baseline for more reliable estimation.
   */
  set_keyframe_translation_enabled(enabled: boolean): void;
  /**
   * Create a new 6DoF tracker.
   */
  constructor(width: number, height: number);
  /**
   * Reset the tracker.
   */
  reset(): void;
  /**
   * Get the current pose as JSON.
   */
  get_pose(): any;
  /**
   * Push an IMU measurement (accelerometer + gyroscope).
   *
   * # Arguments
   * * `ax, ay, az` - Acceleration in m/s²
   * * `gx, gy, gz` - Angular velocity in rad/s
   * * `timestamp` - Timestamp in seconds
   */
  push_imu(ax: number, ay: number, az: number, gx: number, gy: number, gz: number, timestamp: number): void;
  /**
   * Get the current scale estimate.
   */
  get_scale(): number;
  /**
   * Set the scale manually.
   */
  set_scale(scale: number): void;
}

export class TrackerHandle {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Create a tracker with custom configuration.
   */
  static with_config(window_size: number, pyramid_levels: number, fast_threshold: number, max_features: number): TrackerHandle;
  /**
   * Get the current velocity estimate from Kalman filter as [vx, vy, vz].
   */
  get_velocity(): Float32Array;
  /**
   * Get the number of inlier points after RANSAC filtering.
   */
  inlier_points(): number;
  /**
   * Process a frame and return the pose as JSON.
   */
  process_frame(rgba: Uint8Array, width: number, height: number): any;
  /**
   * Get the number of tracked points.
   */
  tracked_points(): number;
  /**
   * Get the current tracking confidence level (0=Lost, 1=Low, 2=Medium, 3=High).
   */
  confidence_level(): number;
  /**
   * Get the current motion model (0=Stationary, 1=Walking, 2=Running).
   */
  get_motion_model(): number;
  /**
   * Check if Kalman filtering is enabled.
   */
  is_kalman_enabled(): boolean;
  /**
   * Enable or disable Kalman filtering for translation smoothing.
   */
  set_kalman_enabled(enabled: boolean): void;
  /**
   * Get current rotation rate from gyro (rad/s).
   */
  current_rotation_rate(): number;
  /**
   * Enable or disable gyro-based flow compensation.
   */
  set_gyro_compensation(enabled: boolean): void;
  /**
   * Process a frame with timestamp for gyro compensation.
   * timestamp_ms should be from performance.now() for best results.
   */
  process_frame_with_time(rgba: Uint8Array, width: number, height: number, timestamp_ms: number): any;
  /**
   * Check if gyro compensation is currently active.
   */
  is_gyro_compensation_enabled(): boolean;
  /**
   * Create a new tracker.
   */
  constructor();
  /**
   * Reset the tracker.
   */
  reset(): void;
  /**
   * Get the current pose as JSON.
   */
  get_pose(): any;
  /**
   * Push a gyroscope reading for flow compensation.
   * omega_x, omega_y, omega_z are rotation rates in rad/s.
   * timestamp_ms is the reading timestamp in milliseconds.
   */
  push_gyro(omega_x: number, omega_y: number, omega_z: number, timestamp_ms: number): void;
}

/**
 * Count the number of features detected (without returning full keypoint data).
 * Useful for quick feature density checks.
 */
export function count_features(rgba_data: Uint8Array, width: number, height: number, threshold: number): number;

/**
 * Detect FAST corners in an RGBA image.
 *
 * # Arguments
 * * `rgba_data` - RGBA pixel data as a flat array (4 bytes per pixel)
 * * `width` - Image width in pixels
 * * `height` - Image height in pixels
 * * `threshold` - Intensity difference threshold (typically 20-50)
 *
 * # Returns
 * A JsValue containing a JSON array of keypoints with x, y, and score.
 */
export function detect_features(rgba_data: Uint8Array, width: number, height: number, threshold: number): any;

/**
 * Detect FAST corners with custom NMS radius.
 *
 * # Arguments
 * * `rgba_data` - RGBA pixel data
 * * `width` - Image width
 * * `height` - Image height
 * * `threshold` - Intensity difference threshold
 * * `nms_radius` - Non-maximum suppression radius in pixels
 *
 * # Returns
 * A JsValue containing a JSON array of keypoints.
 */
export function detect_features_advanced(rgba_data: Uint8Array, width: number, height: number, threshold: number, nms_radius: number): any;

/**
 * Log an error message to the browser console.
 */
export function error(message: string): void;

/**
 * Extract features with ORB descriptors (WASM binding).
 *
 * Returns a JsValue containing an array of features with keypoints and descriptors.
 */
export function extract_features_with_descriptors(rgba_data: Uint8Array, width: number, height: number, threshold: number, max_features: number): any;

/**
 * Get the grayscale version of an RGBA image.
 * Useful for debugging or visualization.
 */
export function get_grayscale(rgba_data: Uint8Array): Uint8Array;

/**
 * Get the current high-resolution timestamp from the browser's Performance API.
 * Returns milliseconds since the page was loaded.
 * Works in both window and worker contexts.
 */
export function get_performance_now(): number;

/**
 * A simple greeting function to verify WASM integration is working.
 * This function logs to the browser console and returns a greeting message.
 */
export function greet(name: string): string;

/**
 * Initialize the WASM module with panic hook for better error messages.
 * This function is automatically called when the WASM module is loaded.
 */
export function init(): void;

/**
 * Log a message to the browser console.
 */
export function log(message: string): void;

/**
 * Match features between two frames (WASM binding).
 *
 * Returns matched feature pairs as indices.
 */
export function match_features(features1_js: any, features2_js: any, max_distance: number): any;

/**
 * Returns the version of the Aether engine.
 */
export function version(): string;

/**
 * Log a warning message to the browser console.
 */
export function warn(message: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly log: (a: number, b: number) => void;
  readonly __wbg_adaptiveconfig_free: (a: number, b: number) => void;
  readonly __wbg_adaptivehandle_free: (a: number, b: number) => void;
  readonly __wbg_breakdownreport_free: (a: number, b: number) => void;
  readonly __wbg_engineconfig_free: (a: number, b: number) => void;
  readonly __wbg_frametiming_free: (a: number, b: number) => void;
  readonly __wbg_get_adaptiveconfig_adjustment_delay: (a: number) => number;
  readonly __wbg_get_adaptiveconfig_enabled: (a: number) => number;
  readonly __wbg_get_adaptiveconfig_min_fps: (a: number) => number;
  readonly __wbg_get_adaptiveconfig_smoothing: (a: number) => number;
  readonly __wbg_get_adaptiveconfig_target_fps: (a: number) => number;
  readonly __wbg_get_breakdownreport_detection_pct: (a: number) => number;
  readonly __wbg_get_breakdownreport_grayscale_pct: (a: number) => number;
  readonly __wbg_get_breakdownreport_other_pct: (a: number) => number;
  readonly __wbg_get_breakdownreport_pose_pct: (a: number) => number;
  readonly __wbg_get_breakdownreport_tracking_pct: (a: number) => number;
  readonly __wbg_get_frametiming_feature_count: (a: number) => number;
  readonly __wbg_get_frametiming_tracked_count: (a: number) => number;
  readonly __wbg_get_jshitresult_distance: (a: number) => number;
  readonly __wbg_get_jshitresult_normal_z: (a: number) => number;
  readonly __wbg_get_jshitresult_plane_id: (a: number) => bigint;
  readonly __wbg_get_jsplaneinfo_confidence: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_height: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_id: (a: number) => bigint;
  readonly __wbg_get_jsplaneinfo_inlier_count: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_plane_type: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_width: (a: number) => number;
  readonly __wbg_get_pose3d_qw: (a: number) => number;
  readonly __wbg_get_pose3d_qx: (a: number) => number;
  readonly __wbg_get_pose3d_qy: (a: number) => number;
  readonly __wbg_get_pose3d_qz: (a: number) => number;
  readonly __wbg_get_pose3d_x: (a: number) => number;
  readonly __wbg_get_pose3d_y: (a: number) => number;
  readonly __wbg_get_qualitysettings_fast_threshold: (a: number) => number;
  readonly __wbg_get_qualitysettings_pose_smoothing: (a: number) => number;
  readonly __wbg_get_qualitysettings_window_size: (a: number) => number;
  readonly __wbg_get_timingreport_frame_count: (a: number) => number;
  readonly __wbg_imagetargetdetectorhandle_free: (a: number, b: number) => void;
  readonly __wbg_jshitresult_free: (a: number, b: number) => void;
  readonly __wbg_jsplaneinfo_free: (a: number, b: number) => void;
  readonly __wbg_lightingestimatorhandle_free: (a: number, b: number) => void;
  readonly __wbg_planedetectorhandle_free: (a: number, b: number) => void;
  readonly __wbg_pose3d_free: (a: number, b: number) => void;
  readonly __wbg_set_adaptiveconfig_adjustment_delay: (a: number, b: number) => void;
  readonly __wbg_set_adaptiveconfig_enabled: (a: number, b: number) => void;
  readonly __wbg_set_adaptiveconfig_min_fps: (a: number, b: number) => void;
  readonly __wbg_set_adaptiveconfig_smoothing: (a: number, b: number) => void;
  readonly __wbg_set_adaptiveconfig_target_fps: (a: number, b: number) => void;
  readonly __wbg_set_breakdownreport_detection_pct: (a: number, b: number) => void;
  readonly __wbg_set_breakdownreport_grayscale_pct: (a: number, b: number) => void;
  readonly __wbg_set_breakdownreport_other_pct: (a: number, b: number) => void;
  readonly __wbg_set_breakdownreport_pose_pct: (a: number, b: number) => void;
  readonly __wbg_set_breakdownreport_tracking_pct: (a: number, b: number) => void;
  readonly __wbg_set_frametiming_feature_count: (a: number, b: number) => void;
  readonly __wbg_set_frametiming_tracked_count: (a: number, b: number) => void;
  readonly __wbg_set_jshitresult_distance: (a: number, b: number) => void;
  readonly __wbg_set_jshitresult_normal_z: (a: number, b: number) => void;
  readonly __wbg_set_jshitresult_plane_id: (a: number, b: bigint) => void;
  readonly __wbg_set_jsplaneinfo_confidence: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_height: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_id: (a: number, b: bigint) => void;
  readonly __wbg_set_jsplaneinfo_inlier_count: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_plane_type: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_width: (a: number, b: number) => void;
  readonly __wbg_set_pose3d_qw: (a: number, b: number) => void;
  readonly __wbg_set_pose3d_qx: (a: number, b: number) => void;
  readonly __wbg_set_pose3d_qy: (a: number, b: number) => void;
  readonly __wbg_set_pose3d_qz: (a: number, b: number) => void;
  readonly __wbg_set_pose3d_x: (a: number, b: number) => void;
  readonly __wbg_set_pose3d_y: (a: number, b: number) => void;
  readonly __wbg_set_qualitysettings_fast_threshold: (a: number, b: number) => void;
  readonly __wbg_set_qualitysettings_pose_smoothing: (a: number, b: number) => void;
  readonly __wbg_set_qualitysettings_window_size: (a: number, b: number) => void;
  readonly __wbg_set_timingreport_frame_count: (a: number, b: number) => void;
  readonly __wbg_tracker6dofhandle_free: (a: number, b: number) => void;
  readonly __wbg_trackerhandle_free: (a: number, b: number) => void;
  readonly adaptiveconfig_new: () => number;
  readonly adaptiveconfig_target_30fps: () => number;
  readonly adaptivehandle_avg_frame_time_ms: (a: number) => number;
  readonly adaptivehandle_estimated_fps: (a: number) => number;
  readonly adaptivehandle_fast_threshold: (a: number) => number;
  readonly adaptivehandle_frame_skip: (a: number) => number;
  readonly adaptivehandle_is_degraded: (a: number) => number;
  readonly adaptivehandle_max_features: (a: number) => number;
  readonly adaptivehandle_new: () => number;
  readonly adaptivehandle_pyramid_levels: (a: number) => number;
  readonly adaptivehandle_quality_level: (a: number) => number;
  readonly adaptivehandle_record_frame: (a: number, b: number) => number;
  readonly adaptivehandle_reset_stats: (a: number) => void;
  readonly adaptivehandle_set_quality_level: (a: number, b: number) => void;
  readonly adaptivehandle_window_size: (a: number) => number;
  readonly count_features: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly detect_features: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly detect_features_advanced: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly engineconfig_adaptive_quality: (a: number) => number;
  readonly engineconfig_debug: (a: number) => number;
  readonly engineconfig_new: () => number;
  readonly engineconfig_set_adaptive_quality: (a: number, b: number) => void;
  readonly engineconfig_set_debug: (a: number, b: number) => void;
  readonly engineconfig_set_target_fps: (a: number, b: number) => void;
  readonly engineconfig_target_fps: (a: number) => number;
  readonly error: (a: number, b: number) => void;
  readonly extract_features_with_descriptors: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly frametiming_new: () => number;
  readonly get_grayscale: (a: number, b: number) => [number, number];
  readonly get_performance_now: () => number;
  readonly greet: (a: number, b: number) => [number, number];
  readonly imagetargetdetectorhandle_add_template: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
  readonly imagetargetdetectorhandle_detect: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly imagetargetdetectorhandle_get_template_feature_count: (a: number, b: number, c: number) => number;
  readonly imagetargetdetectorhandle_new: () => number;
  readonly imagetargetdetectorhandle_remove_template: (a: number, b: number, c: number) => number;
  readonly imagetargetdetectorhandle_set_intrinsics: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly imagetargetdetectorhandle_template_count: (a: number) => number;
  readonly imagetargetdetectorhandle_with_config: (a: number, b: number, c: number) => number;
  readonly init: () => void;
  readonly jshitresult_normal: (a: number) => [number, number];
  readonly jshitresult_position: (a: number) => [number, number];
  readonly jsplaneinfo_center: (a: number) => [number, number];
  readonly jsplaneinfo_get_normal: (a: number) => [number, number];
  readonly jsplaneinfo_is_floor: (a: number) => number;
  readonly jsplaneinfo_is_horizontal: (a: number) => number;
  readonly jsplaneinfo_is_vertical: (a: number) => number;
  readonly lightingestimatorhandle_ambient_color: (a: number) => [number, number];
  readonly lightingestimatorhandle_ambient_intensity: (a: number) => number;
  readonly lightingestimatorhandle_analyze_frame: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly lightingestimatorhandle_color_temperature: (a: number) => number;
  readonly lightingestimatorhandle_confidence: (a: number) => number;
  readonly lightingestimatorhandle_directional_direction: (a: number) => [number, number];
  readonly lightingestimatorhandle_directional_intensity: (a: number) => number;
  readonly lightingestimatorhandle_get_estimate: (a: number) => any;
  readonly lightingestimatorhandle_new: () => number;
  readonly lightingestimatorhandle_reset: (a: number) => void;
  readonly lightingestimatorhandle_set_analysis_interval: (a: number, b: number) => void;
  readonly lightingestimatorhandle_with_smoothing: (a: number) => number;
  readonly match_features: (a: any, b: any, c: number) => any;
  readonly planedetectorhandle_clear: (a: number) => void;
  readonly planedetectorhandle_detect_planes: (a: number, b: number, c: number) => number;
  readonly planedetectorhandle_for_floor_detection: () => number;
  readonly planedetectorhandle_get_floor_plane: (a: number) => number;
  readonly planedetectorhandle_get_plane: (a: number, b: number) => number;
  readonly planedetectorhandle_hit_test: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
  readonly planedetectorhandle_hit_test_horizontal: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
  readonly planedetectorhandle_hit_test_vertical: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
  readonly planedetectorhandle_new: () => number;
  readonly planedetectorhandle_num_planes: (a: number) => number;
  readonly planedetectorhandle_reset: (a: number) => void;
  readonly planedetectorhandle_set_inlier_threshold: (a: number, b: number) => void;
  readonly planedetectorhandle_set_min_inliers: (a: number, b: number) => void;
  readonly pose3d_from_components: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
  readonly pose3d_new: () => number;
  readonly pose3d_position: (a: number) => [number, number];
  readonly pose3d_quaternion: (a: number) => [number, number];
  readonly pose3d_to_matrix4: (a: number) => [number, number];
  readonly qrdetectorhandle_debug_detect_patterns: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly qrdetectorhandle_debug_get_image_stats: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly qrdetectorhandle_debug_get_patterns: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly qrdetectorhandle_debug_get_threshold: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly qrdetectorhandle_detect: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly qrdetectorhandle_get_qr_size: (a: number) => number;
  readonly qrdetectorhandle_new: () => number;
  readonly qrdetectorhandle_set_intrinsics: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly qrdetectorhandle_set_qr_size: (a: number, b: number) => void;
  readonly qualitysettings_for_level: (a: number) => number;
  readonly timingreport_breakdown_percentages: (a: number) => number;
  readonly timingreport_estimated_fps: (a: number) => number;
  readonly timingreport_meets_30fps: (a: number) => number;
  readonly timingreport_meets_60fps: (a: number) => number;
  readonly timingreport_to_json: (a: number) => [number, number];
  readonly tracker6dofhandle_apply_stabilization: (a: number) => void;
  readonly tracker6dofhandle_clear_imu_buffer: (a: number) => void;
  readonly tracker6dofhandle_clear_map_points: (a: number) => void;
  readonly tracker6dofhandle_get_accel_position: (a: number) => [number, number];
  readonly tracker6dofhandle_get_accel_speed: (a: number) => number;
  readonly tracker6dofhandle_get_accel_velocity: (a: number) => [number, number];
  readonly tracker6dofhandle_get_gravity: (a: number) => [number, number];
  readonly tracker6dofhandle_get_gravity_rotation: (a: number) => [number, number];
  readonly tracker6dofhandle_get_last_parallax: (a: number) => number;
  readonly tracker6dofhandle_get_map_points: (a: number) => [number, number];
  readonly tracker6dofhandle_get_map_points_world: (a: number) => [number, number];
  readonly tracker6dofhandle_get_pose: (a: number) => any;
  readonly tracker6dofhandle_get_scale: (a: number) => number;
  readonly tracker6dofhandle_get_scale_confidence: (a: number) => number;
  readonly tracker6dofhandle_get_vio_scale: (a: number) => number;
  readonly tracker6dofhandle_imu_buffer_len: (a: number) => number;
  readonly tracker6dofhandle_is_keyframe_translation_enabled: (a: number) => number;
  readonly tracker6dofhandle_is_stabilization_enabled: (a: number) => number;
  readonly tracker6dofhandle_is_stabilized_stationary: (a: number) => number;
  readonly tracker6dofhandle_is_stationary: (a: number) => number;
  readonly tracker6dofhandle_is_vio_enabled: (a: number) => number;
  readonly tracker6dofhandle_is_vio_initialized: (a: number) => number;
  readonly tracker6dofhandle_map_point_count: (a: number) => number;
  readonly tracker6dofhandle_new: (a: number, b: number) => number;
  readonly tracker6dofhandle_process_frame: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly tracker6dofhandle_process_frame_vio: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly tracker6dofhandle_push_imu: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
  readonly tracker6dofhandle_reset: (a: number) => void;
  readonly tracker6dofhandle_reset_accel_position: (a: number) => void;
  readonly tracker6dofhandle_reset_stabilizer: (a: number) => void;
  readonly tracker6dofhandle_set_keyframe_translation_enabled: (a: number, b: number) => void;
  readonly tracker6dofhandle_set_scale: (a: number, b: number) => void;
  readonly tracker6dofhandle_set_stabilization_enabled: (a: number, b: number) => void;
  readonly tracker6dofhandle_set_vio_enabled: (a: number, b: number) => void;
  readonly tracker6dofhandle_stabilizer_stationary_duration: (a: number) => number;
  readonly tracker6dofhandle_test_essential: () => number;
  readonly tracker6dofhandle_tracked_points: (a: number) => number;
  readonly tracker6dofhandle_update_stabilizer: (a: number, b: number, c: number) => void;
  readonly trackerhandle_confidence_level: (a: number) => number;
  readonly trackerhandle_current_rotation_rate: (a: number) => number;
  readonly trackerhandle_get_motion_model: (a: number) => number;
  readonly trackerhandle_get_pose: (a: number) => any;
  readonly trackerhandle_get_velocity: (a: number) => [number, number];
  readonly trackerhandle_inlier_points: (a: number) => number;
  readonly trackerhandle_is_gyro_compensation_enabled: (a: number) => number;
  readonly trackerhandle_is_kalman_enabled: (a: number) => number;
  readonly trackerhandle_new: () => number;
  readonly trackerhandle_process_frame: (a: number, b: number, c: number, d: number, e: number) => any;
  readonly trackerhandle_process_frame_with_time: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly trackerhandle_push_gyro: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly trackerhandle_reset: (a: number) => void;
  readonly trackerhandle_set_gyro_compensation: (a: number, b: number) => void;
  readonly trackerhandle_set_kalman_enabled: (a: number, b: number) => void;
  readonly trackerhandle_tracked_points: (a: number) => number;
  readonly trackerhandle_with_config: (a: number, b: number, c: number, d: number) => number;
  readonly version: () => [number, number];
  readonly warn: (a: number, b: number) => void;
  readonly __wbg_set_frametiming_detection_ms: (a: number, b: number) => void;
  readonly __wbg_set_frametiming_grayscale_ms: (a: number, b: number) => void;
  readonly __wbg_set_frametiming_pose_ms: (a: number, b: number) => void;
  readonly __wbg_set_frametiming_total_ms: (a: number, b: number) => void;
  readonly __wbg_set_frametiming_tracking_ms: (a: number, b: number) => void;
  readonly __wbg_set_jshitresult_normal_x: (a: number, b: number) => void;
  readonly __wbg_set_jshitresult_normal_y: (a: number, b: number) => void;
  readonly __wbg_set_jshitresult_x: (a: number, b: number) => void;
  readonly __wbg_set_jshitresult_y: (a: number, b: number) => void;
  readonly __wbg_set_jshitresult_z: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_center_x: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_center_y: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_center_z: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_normal_x: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_normal_y: (a: number, b: number) => void;
  readonly __wbg_set_jsplaneinfo_normal_z: (a: number, b: number) => void;
  readonly __wbg_set_pose3d_z: (a: number, b: number) => void;
  readonly __wbg_set_qualitysettings_frame_skip: (a: number, b: number) => void;
  readonly __wbg_set_qualitysettings_max_features: (a: number, b: number) => void;
  readonly __wbg_set_qualitysettings_pyramid_levels: (a: number, b: number) => void;
  readonly __wbg_set_timingreport_avg_detection_ms: (a: number, b: number) => void;
  readonly __wbg_set_timingreport_avg_grayscale_ms: (a: number, b: number) => void;
  readonly __wbg_set_timingreport_avg_pose_ms: (a: number, b: number) => void;
  readonly __wbg_set_timingreport_avg_total_ms: (a: number, b: number) => void;
  readonly __wbg_set_timingreport_avg_tracking_ms: (a: number, b: number) => void;
  readonly __wbg_set_timingreport_max_total_ms: (a: number, b: number) => void;
  readonly __wbg_set_timingreport_min_total_ms: (a: number, b: number) => void;
  readonly __wbg_get_qualitysettings_frame_skip: (a: number) => number;
  readonly __wbg_get_qualitysettings_max_features: (a: number) => number;
  readonly __wbg_get_qualitysettings_pyramid_levels: (a: number) => number;
  readonly __wbg_get_frametiming_detection_ms: (a: number) => number;
  readonly __wbg_get_frametiming_grayscale_ms: (a: number) => number;
  readonly __wbg_get_frametiming_pose_ms: (a: number) => number;
  readonly __wbg_get_frametiming_total_ms: (a: number) => number;
  readonly __wbg_get_frametiming_tracking_ms: (a: number) => number;
  readonly __wbg_get_jshitresult_normal_x: (a: number) => number;
  readonly __wbg_get_jshitresult_normal_y: (a: number) => number;
  readonly __wbg_get_jshitresult_x: (a: number) => number;
  readonly __wbg_get_jshitresult_y: (a: number) => number;
  readonly __wbg_get_jshitresult_z: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_center_x: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_center_y: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_center_z: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_normal_x: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_normal_y: (a: number) => number;
  readonly __wbg_get_jsplaneinfo_normal_z: (a: number) => number;
  readonly __wbg_get_pose3d_z: (a: number) => number;
  readonly __wbg_get_timingreport_avg_detection_ms: (a: number) => number;
  readonly __wbg_get_timingreport_avg_grayscale_ms: (a: number) => number;
  readonly __wbg_get_timingreport_avg_pose_ms: (a: number) => number;
  readonly __wbg_get_timingreport_avg_total_ms: (a: number) => number;
  readonly __wbg_get_timingreport_avg_tracking_ms: (a: number) => number;
  readonly __wbg_get_timingreport_max_total_ms: (a: number) => number;
  readonly __wbg_get_timingreport_min_total_ms: (a: number) => number;
  readonly __wbg_timingreport_free: (a: number, b: number) => void;
  readonly __wbg_qualitysettings_free: (a: number, b: number) => void;
  readonly __wbg_qrdetectorhandle_free: (a: number, b: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
