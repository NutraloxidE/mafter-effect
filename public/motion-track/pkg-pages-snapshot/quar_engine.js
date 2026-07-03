let wasm;

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    }
}

let WASM_VECTOR_LEN = 0;

const AdaptiveConfigFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_adaptiveconfig_free(ptr >>> 0, 1));

const AdaptiveHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_adaptivehandle_free(ptr >>> 0, 1));

const BreakdownReportFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_breakdownreport_free(ptr >>> 0, 1));

const EngineConfigFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engineconfig_free(ptr >>> 0, 1));

const FrameTimingFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_frametiming_free(ptr >>> 0, 1));

const ImageTargetDetectorHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_imagetargetdetectorhandle_free(ptr >>> 0, 1));

const JsHitResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jshitresult_free(ptr >>> 0, 1));

const JsPlaneInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jsplaneinfo_free(ptr >>> 0, 1));

const LightingEstimatorHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lightingestimatorhandle_free(ptr >>> 0, 1));

const PlaneDetectorHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_planedetectorhandle_free(ptr >>> 0, 1));

const Pose3DFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pose3d_free(ptr >>> 0, 1));

const QrDetectorHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_qrdetectorhandle_free(ptr >>> 0, 1));

const QualitySettingsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_qualitysettings_free(ptr >>> 0, 1));

const TimingReportFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_timingreport_free(ptr >>> 0, 1));

const Tracker6DoFHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_tracker6dofhandle_free(ptr >>> 0, 1));

const TrackerHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_trackerhandle_free(ptr >>> 0, 1));

/**
 * Configuration for adaptive quality control.
 */
export class AdaptiveConfig {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(AdaptiveConfig.prototype);
        obj.__wbg_ptr = ptr;
        AdaptiveConfigFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AdaptiveConfigFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_adaptiveconfig_free(ptr, 0);
    }
    /**
     * Create configuration for 30 FPS target.
     * @returns {AdaptiveConfig}
     */
    static target_30fps() {
        const ret = wasm.adaptiveconfig_target_30fps();
        return AdaptiveConfig.__wrap(ret);
    }
    /**
     * Create default configuration targeting 60 FPS.
     */
    constructor() {
        const ret = wasm.adaptiveconfig_new();
        this.__wbg_ptr = ret >>> 0;
        AdaptiveConfigFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Target FPS (default: 60)
     * @returns {number}
     */
    get target_fps() {
        const ret = wasm.__wbg_get_adaptiveconfig_target_fps(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Target FPS (default: 60)
     * @param {number} arg0
     */
    set target_fps(arg0) {
        wasm.__wbg_set_adaptiveconfig_target_fps(this.__wbg_ptr, arg0);
    }
    /**
     * Minimum acceptable FPS (default: 30)
     * @returns {number}
     */
    get min_fps() {
        const ret = wasm.__wbg_get_adaptiveconfig_min_fps(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Minimum acceptable FPS (default: 30)
     * @param {number} arg0
     */
    set min_fps(arg0) {
        wasm.__wbg_set_adaptiveconfig_min_fps(this.__wbg_ptr, arg0);
    }
    /**
     * Enable adaptive quality adjustment
     * @returns {boolean}
     */
    get enabled() {
        const ret = wasm.__wbg_get_adaptiveconfig_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Enable adaptive quality adjustment
     * @param {boolean} arg0
     */
    set enabled(arg0) {
        wasm.__wbg_set_adaptiveconfig_enabled(this.__wbg_ptr, arg0);
    }
    /**
     * Smoothing factor for frame time averaging (0-1)
     * @returns {number}
     */
    get smoothing() {
        const ret = wasm.__wbg_get_adaptiveconfig_smoothing(this.__wbg_ptr);
        return ret;
    }
    /**
     * Smoothing factor for frame time averaging (0-1)
     * @param {number} arg0
     */
    set smoothing(arg0) {
        wasm.__wbg_set_adaptiveconfig_smoothing(this.__wbg_ptr, arg0);
    }
    /**
     * Number of frames to wait before adjusting
     * @returns {number}
     */
    get adjustment_delay() {
        const ret = wasm.__wbg_get_adaptiveconfig_adjustment_delay(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of frames to wait before adjusting
     * @param {number} arg0
     */
    set adjustment_delay(arg0) {
        wasm.__wbg_set_adaptiveconfig_adjustment_delay(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) AdaptiveConfig.prototype[Symbol.dispose] = AdaptiveConfig.prototype.free;

/**
 * WASM-exported adaptive controller.
 */
export class AdaptiveHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AdaptiveHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_adaptivehandle_free(ptr, 0);
    }
    /**
     * Get frame skip setting.
     * @returns {number}
     */
    frame_skip() {
        const ret = wasm.adaptivehandle_frame_skip(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Check if degraded.
     * @returns {boolean}
     */
    is_degraded() {
        const ret = wasm.adaptivehandle_is_degraded(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Reset statistics.
     */
    reset_stats() {
        wasm.adaptivehandle_reset_stats(this.__wbg_ptr);
    }
    /**
     * Get current window size setting.
     * @returns {number}
     */
    window_size() {
        const ret = wasm.adaptivehandle_window_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get current max features setting.
     * @returns {number}
     */
    max_features() {
        const ret = wasm.adaptivehandle_max_features(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Record a frame time and check if quality changed.
     * @param {number} frame_time_ms
     * @returns {boolean}
     */
    record_frame(frame_time_ms) {
        const ret = wasm.adaptivehandle_record_frame(this.__wbg_ptr, frame_time_ms);
        return ret !== 0;
    }
    /**
     * Get estimated FPS.
     * @returns {number}
     */
    estimated_fps() {
        const ret = wasm.adaptivehandle_estimated_fps(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get current quality level (0=High, 1=Medium, 2=Low, 3=Minimal).
     * @returns {number}
     */
    quality_level() {
        const ret = wasm.adaptivehandle_quality_level(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get current FAST threshold.
     * @returns {number}
     */
    fast_threshold() {
        const ret = wasm.adaptivehandle_fast_threshold(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get current pyramid levels setting.
     * @returns {number}
     */
    pyramid_levels() {
        const ret = wasm.adaptivehandle_pyramid_levels(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get average frame time in ms.
     * @returns {number}
     */
    avg_frame_time_ms() {
        const ret = wasm.adaptivehandle_avg_frame_time_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * Force a quality level.
     * @param {number} level
     */
    set_quality_level(level) {
        wasm.adaptivehandle_set_quality_level(this.__wbg_ptr, level);
    }
    /**
     * Create a new adaptive controller.
     */
    constructor() {
        const ret = wasm.adaptivehandle_new();
        this.__wbg_ptr = ret >>> 0;
        AdaptiveHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) AdaptiveHandle.prototype[Symbol.dispose] = AdaptiveHandle.prototype.free;

/**
 * Breakdown of time spent in each stage as percentages.
 */
export class BreakdownReport {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(BreakdownReport.prototype);
        obj.__wbg_ptr = ptr;
        BreakdownReportFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BreakdownReportFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_breakdownreport_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get grayscale_pct() {
        const ret = wasm.__wbg_get_breakdownreport_grayscale_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set grayscale_pct(arg0) {
        wasm.__wbg_set_breakdownreport_grayscale_pct(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get detection_pct() {
        const ret = wasm.__wbg_get_breakdownreport_detection_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set detection_pct(arg0) {
        wasm.__wbg_set_breakdownreport_detection_pct(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get tracking_pct() {
        const ret = wasm.__wbg_get_breakdownreport_tracking_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set tracking_pct(arg0) {
        wasm.__wbg_set_breakdownreport_tracking_pct(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get pose_pct() {
        const ret = wasm.__wbg_get_breakdownreport_pose_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set pose_pct(arg0) {
        wasm.__wbg_set_breakdownreport_pose_pct(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get other_pct() {
        const ret = wasm.__wbg_get_breakdownreport_other_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set other_pct(arg0) {
        wasm.__wbg_set_breakdownreport_other_pct(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) BreakdownReport.prototype[Symbol.dispose] = BreakdownReport.prototype.free;

/**
 * Engine configuration options passed from JavaScript.
 */
export class EngineConfig {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineConfigFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engineconfig_free(ptr, 0);
    }
    /**
     * Get the target FPS.
     * @returns {number}
     */
    get target_fps() {
        const ret = wasm.engineconfig_target_fps(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Set the target FPS (30 or 60).
     * @param {number} fps
     */
    set target_fps(fps) {
        wasm.engineconfig_set_target_fps(this.__wbg_ptr, fps);
    }
    /**
     * Check if adaptive quality is enabled.
     * @returns {boolean}
     */
    get adaptive_quality() {
        const ret = wasm.engineconfig_adaptive_quality(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Enable or disable adaptive quality.
     * @param {boolean} enabled
     */
    set adaptive_quality(enabled) {
        wasm.engineconfig_set_adaptive_quality(this.__wbg_ptr, enabled);
    }
    /**
     * Create a new engine configuration with default values.
     */
    constructor() {
        const ret = wasm.engineconfig_new();
        this.__wbg_ptr = ret >>> 0;
        EngineConfigFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Check if debug mode is enabled.
     * @returns {boolean}
     */
    get debug() {
        const ret = wasm.engineconfig_debug(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Enable or disable debug mode.
     * @param {boolean} enabled
     */
    set debug(enabled) {
        wasm.engineconfig_set_debug(this.__wbg_ptr, enabled);
    }
}
if (Symbol.dispose) EngineConfig.prototype[Symbol.dispose] = EngineConfig.prototype.free;

/**
 * Timing report for a single frame.
 */
export class FrameTiming {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FrameTimingFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_frametiming_free(ptr, 0);
    }
    /**
     * Create a new frame timing.
     */
    constructor() {
        const ret = wasm.frametiming_new();
        this.__wbg_ptr = ret >>> 0;
        FrameTimingFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Total frame processing time
     * @returns {number}
     */
    get total_ms() {
        const ret = wasm.__wbg_get_breakdownreport_grayscale_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Total frame processing time
     * @param {number} arg0
     */
    set total_ms(arg0) {
        wasm.__wbg_set_breakdownreport_grayscale_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Grayscale conversion time
     * @returns {number}
     */
    get grayscale_ms() {
        const ret = wasm.__wbg_get_breakdownreport_detection_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Grayscale conversion time
     * @param {number} arg0
     */
    set grayscale_ms(arg0) {
        wasm.__wbg_set_breakdownreport_detection_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Feature detection time
     * @returns {number}
     */
    get detection_ms() {
        const ret = wasm.__wbg_get_breakdownreport_tracking_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Feature detection time
     * @param {number} arg0
     */
    set detection_ms(arg0) {
        wasm.__wbg_set_breakdownreport_tracking_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Optical flow tracking time
     * @returns {number}
     */
    get tracking_ms() {
        const ret = wasm.__wbg_get_breakdownreport_pose_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Optical flow tracking time
     * @param {number} arg0
     */
    set tracking_ms(arg0) {
        wasm.__wbg_set_breakdownreport_pose_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Pose estimation time
     * @returns {number}
     */
    get pose_ms() {
        const ret = wasm.__wbg_get_breakdownreport_other_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Pose estimation time
     * @param {number} arg0
     */
    set pose_ms(arg0) {
        wasm.__wbg_set_breakdownreport_other_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Number of features detected
     * @returns {number}
     */
    get feature_count() {
        const ret = wasm.__wbg_get_frametiming_feature_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of features detected
     * @param {number} arg0
     */
    set feature_count(arg0) {
        wasm.__wbg_set_frametiming_feature_count(this.__wbg_ptr, arg0);
    }
    /**
     * Number of points tracked
     * @returns {number}
     */
    get tracked_count() {
        const ret = wasm.__wbg_get_frametiming_tracked_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of points tracked
     * @param {number} arg0
     */
    set tracked_count(arg0) {
        wasm.__wbg_set_frametiming_tracked_count(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) FrameTiming.prototype[Symbol.dispose] = FrameTiming.prototype.free;

/**
 * WASM handle for image target detector.
 */
export class ImageTargetDetectorHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ImageTargetDetectorHandle.prototype);
        obj.__wbg_ptr = ptr;
        ImageTargetDetectorHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ImageTargetDetectorHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_imagetargetdetectorhandle_free(ptr, 0);
    }
    /**
     * Create a detector with custom configuration.
     *
     * # Arguments
     * * `min_matches` - Minimum matches required (default: 10)
     * * `ransac_threshold` - RANSAC inlier threshold in pixels (default: 3.0)
     * * `min_inliers` - Minimum inliers required (default: 8)
     * @param {number} min_matches
     * @param {number} ransac_threshold
     * @param {number} min_inliers
     * @returns {ImageTargetDetectorHandle}
     */
    static with_config(min_matches, ransac_threshold, min_inliers) {
        const ret = wasm.imagetargetdetectorhandle_with_config(min_matches, ransac_threshold, min_inliers);
        return ImageTargetDetectorHandle.__wrap(ret);
    }
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
     * @param {string} id
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @param {number} physical_width_meters
     * @returns {boolean}
     */
    add_template(id, rgba, width, height, physical_width_meters) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.imagetargetdetectorhandle_add_template(this.__wbg_ptr, ptr0, len0, ptr1, len1, width, height, physical_width_meters);
        return ret !== 0;
    }
    /**
     * Set camera intrinsics for pose estimation.
     *
     * # Arguments
     * * `fx` - Focal length X (pixels)
     * * `fy` - Focal length Y (pixels)
     * * `cx` - Principal point X
     * * `cy` - Principal point Y
     * @param {number} fx
     * @param {number} fy
     * @param {number} cx
     * @param {number} cy
     */
    set_intrinsics(fx, fy, cx, cy) {
        wasm.imagetargetdetectorhandle_set_intrinsics(this.__wbg_ptr, fx, fy, cx, cy);
    }
    /**
     * Get the number of registered templates.
     * @returns {number}
     */
    template_count() {
        const ret = wasm.imagetargetdetectorhandle_template_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Remove a template by ID.
     *
     * # Returns
     * True if template was found and removed
     * @param {string} id
     * @returns {boolean}
     */
    remove_template(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.imagetargetdetectorhandle_remove_template(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Get feature count for a template.
     *
     * # Returns
     * Number of features, or 0 if template not found
     * @param {string} id
     * @returns {number}
     */
    get_template_feature_count(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.imagetargetdetectorhandle_get_template_feature_count(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Create a new image target detector.
     */
    constructor() {
        const ret = wasm.imagetargetdetectorhandle_new();
        this.__wbg_ptr = ret >>> 0;
        ImageTargetDetectorHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
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
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @returns {any}
     */
    detect(rgba, width, height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.imagetargetdetectorhandle_detect(this.__wbg_ptr, ptr0, len0, width, height);
        return ret;
    }
}
if (Symbol.dispose) ImageTargetDetectorHandle.prototype[Symbol.dispose] = ImageTargetDetectorHandle.prototype.free;

/**
 * JavaScript-friendly hit test result.
 */
export class JsHitResult {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(JsHitResult.prototype);
        obj.__wbg_ptr = ptr;
        JsHitResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsHitResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jshitresult_free(ptr, 0);
    }
    /**
     * Get normal as [x, y, z] array.
     * @returns {Float64Array}
     */
    normal() {
        const ret = wasm.jshitresult_normal(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get position as [x, y, z] array.
     * @returns {Float64Array}
     */
    position() {
        const ret = wasm.jshitresult_position(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * X position of hit
     * @returns {number}
     */
    get x() {
        const ret = wasm.__wbg_get_breakdownreport_grayscale_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * X position of hit
     * @param {number} arg0
     */
    set x(arg0) {
        wasm.__wbg_set_breakdownreport_grayscale_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Y position of hit
     * @returns {number}
     */
    get y() {
        const ret = wasm.__wbg_get_breakdownreport_detection_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Y position of hit
     * @param {number} arg0
     */
    set y(arg0) {
        wasm.__wbg_set_breakdownreport_detection_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Z position of hit
     * @returns {number}
     */
    get z() {
        const ret = wasm.__wbg_get_breakdownreport_tracking_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Z position of hit
     * @param {number} arg0
     */
    set z(arg0) {
        wasm.__wbg_set_breakdownreport_tracking_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Normal X component
     * @returns {number}
     */
    get normal_x() {
        const ret = wasm.__wbg_get_breakdownreport_pose_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Normal X component
     * @param {number} arg0
     */
    set normal_x(arg0) {
        wasm.__wbg_set_breakdownreport_pose_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Normal Y component
     * @returns {number}
     */
    get normal_y() {
        const ret = wasm.__wbg_get_breakdownreport_other_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Normal Y component
     * @param {number} arg0
     */
    set normal_y(arg0) {
        wasm.__wbg_set_breakdownreport_other_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Normal Z component
     * @returns {number}
     */
    get normal_z() {
        const ret = wasm.__wbg_get_jshitresult_normal_z(this.__wbg_ptr);
        return ret;
    }
    /**
     * Normal Z component
     * @param {number} arg0
     */
    set normal_z(arg0) {
        wasm.__wbg_set_jshitresult_normal_z(this.__wbg_ptr, arg0);
    }
    /**
     * Distance from ray origin
     * @returns {number}
     */
    get distance() {
        const ret = wasm.__wbg_get_jshitresult_distance(this.__wbg_ptr);
        return ret;
    }
    /**
     * Distance from ray origin
     * @param {number} arg0
     */
    set distance(arg0) {
        wasm.__wbg_set_jshitresult_distance(this.__wbg_ptr, arg0);
    }
    /**
     * ID of the plane hit
     * @returns {bigint}
     */
    get plane_id() {
        const ret = wasm.__wbg_get_jshitresult_plane_id(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * ID of the plane hit
     * @param {bigint} arg0
     */
    set plane_id(arg0) {
        wasm.__wbg_set_jshitresult_plane_id(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) JsHitResult.prototype[Symbol.dispose] = JsHitResult.prototype.free;

/**
 * JavaScript-friendly plane info.
 */
export class JsPlaneInfo {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(JsPlaneInfo.prototype);
        obj.__wbg_ptr = ptr;
        JsPlaneInfoFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JsPlaneInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jsplaneinfo_free(ptr, 0);
    }
    /**
     * Get normal as [x, y, z] array.
     * @returns {Float64Array}
     */
    get_normal() {
        const ret = wasm.jsplaneinfo_get_normal(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Check if this is a vertical plane (wall).
     * @returns {boolean}
     */
    is_vertical() {
        const ret = wasm.jsplaneinfo_is_vertical(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if this is a horizontal plane.
     * @returns {boolean}
     */
    is_horizontal() {
        const ret = wasm.jsplaneinfo_is_horizontal(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get center as [x, y, z] array.
     * @returns {Float64Array}
     */
    center() {
        const ret = wasm.jsplaneinfo_center(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Check if this is a floor plane.
     * @returns {boolean}
     */
    is_floor() {
        const ret = wasm.jsplaneinfo_is_floor(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Plane ID
     * @returns {bigint}
     */
    get id() {
        const ret = wasm.__wbg_get_jsplaneinfo_id(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Plane ID
     * @param {bigint} arg0
     */
    set id(arg0) {
        wasm.__wbg_set_jsplaneinfo_id(this.__wbg_ptr, arg0);
    }
    /**
     * Center X
     * @returns {number}
     */
    get center_x() {
        const ret = wasm.__wbg_get_breakdownreport_detection_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Center X
     * @param {number} arg0
     */
    set center_x(arg0) {
        wasm.__wbg_set_breakdownreport_detection_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Center Y
     * @returns {number}
     */
    get center_y() {
        const ret = wasm.__wbg_get_breakdownreport_tracking_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Center Y
     * @param {number} arg0
     */
    set center_y(arg0) {
        wasm.__wbg_set_breakdownreport_tracking_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Center Z
     * @returns {number}
     */
    get center_z() {
        const ret = wasm.__wbg_get_breakdownreport_pose_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Center Z
     * @param {number} arg0
     */
    set center_z(arg0) {
        wasm.__wbg_set_breakdownreport_pose_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Normal X
     * @returns {number}
     */
    get normal_x() {
        const ret = wasm.__wbg_get_breakdownreport_other_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Normal X
     * @param {number} arg0
     */
    set normal_x(arg0) {
        wasm.__wbg_set_breakdownreport_other_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Normal Y
     * @returns {number}
     */
    get normal_y() {
        const ret = wasm.__wbg_get_jshitresult_normal_z(this.__wbg_ptr);
        return ret;
    }
    /**
     * Normal Y
     * @param {number} arg0
     */
    set normal_y(arg0) {
        wasm.__wbg_set_jshitresult_normal_z(this.__wbg_ptr, arg0);
    }
    /**
     * Normal Z
     * @returns {number}
     */
    get normal_z() {
        const ret = wasm.__wbg_get_jshitresult_distance(this.__wbg_ptr);
        return ret;
    }
    /**
     * Normal Z
     * @param {number} arg0
     */
    set normal_z(arg0) {
        wasm.__wbg_set_jshitresult_distance(this.__wbg_ptr, arg0);
    }
    /**
     * Width extent
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_jsplaneinfo_width(this.__wbg_ptr);
        return ret;
    }
    /**
     * Width extent
     * @param {number} arg0
     */
    set width(arg0) {
        wasm.__wbg_set_jsplaneinfo_width(this.__wbg_ptr, arg0);
    }
    /**
     * Height extent
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_jsplaneinfo_height(this.__wbg_ptr);
        return ret;
    }
    /**
     * Height extent
     * @param {number} arg0
     */
    set height(arg0) {
        wasm.__wbg_set_jsplaneinfo_height(this.__wbg_ptr, arg0);
    }
    /**
     * Number of inlier points
     * @returns {number}
     */
    get inlier_count() {
        const ret = wasm.__wbg_get_jsplaneinfo_inlier_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of inlier points
     * @param {number} arg0
     */
    set inlier_count(arg0) {
        wasm.__wbg_set_jsplaneinfo_inlier_count(this.__wbg_ptr, arg0);
    }
    /**
     * Confidence (0.0 to 1.0)
     * @returns {number}
     */
    get confidence() {
        const ret = wasm.__wbg_get_jsplaneinfo_confidence(this.__wbg_ptr);
        return ret;
    }
    /**
     * Confidence (0.0 to 1.0)
     * @param {number} arg0
     */
    set confidence(arg0) {
        wasm.__wbg_set_jsplaneinfo_confidence(this.__wbg_ptr, arg0);
    }
    /**
     * Plane type: 0=HorizontalUp, 1=HorizontalDown, 2=Vertical, 3=Arbitrary
     * @returns {number}
     */
    get plane_type() {
        const ret = wasm.__wbg_get_jsplaneinfo_plane_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * Plane type: 0=HorizontalUp, 1=HorizontalDown, 2=Vertical, 3=Arbitrary
     * @param {number} arg0
     */
    set plane_type(arg0) {
        wasm.__wbg_set_jsplaneinfo_plane_type(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) JsPlaneInfo.prototype[Symbol.dispose] = JsPlaneInfo.prototype.free;

/**
 * WASM-bindgen handle for the lighting estimator.
 *
 * Provides JavaScript-accessible interface to the lighting estimation system.
 */
export class LightingEstimatorHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(LightingEstimatorHandle.prototype);
        obj.__wbg_ptr = ptr;
        LightingEstimatorHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LightingEstimatorHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lightingestimatorhandle_free(ptr, 0);
    }
    /**
     * Get the overall confidence (0.0-1.0).
     * @returns {number}
     */
    confidence() {
        const ret = wasm.lightingestimatorhandle_confidence(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the current estimate without processing a new frame.
     * @returns {any}
     */
    get_estimate() {
        const ret = wasm.lightingestimatorhandle_get_estimate(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the ambient color as [r, g, b] array.
     * @returns {Float32Array}
     */
    ambient_color() {
        const ret = wasm.lightingestimatorhandle_ambient_color(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
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
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @returns {any}
     */
    analyze_frame(rgba, width, height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.lightingestimatorhandle_analyze_frame(this.__wbg_ptr, ptr0, len0, width, height);
        return ret;
    }
    /**
     * Create an estimator with custom smoothing factor (0.0-0.99).
     * @param {number} smoothing
     * @returns {LightingEstimatorHandle}
     */
    static with_smoothing(smoothing) {
        const ret = wasm.lightingestimatorhandle_with_smoothing(smoothing);
        return LightingEstimatorHandle.__wrap(ret);
    }
    /**
     * Get the ambient intensity (0.0-1.0).
     * @returns {number}
     */
    ambient_intensity() {
        const ret = wasm.lightingestimatorhandle_ambient_intensity(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the color temperature in Kelvin.
     * @returns {number}
     */
    color_temperature() {
        const ret = wasm.lightingestimatorhandle_color_temperature(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the directional light direction as [x, y, z] unit vector.
     * @returns {Float32Array}
     */
    directional_direction() {
        const ret = wasm.lightingestimatorhandle_directional_direction(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get the directional light intensity (0.0-1.0).
     * @returns {number}
     */
    directional_intensity() {
        const ret = wasm.lightingestimatorhandle_directional_intensity(this.__wbg_ptr);
        return ret;
    }
    /**
     * Set the analysis interval (frames between full analysis).
     * Lower values = more responsive but higher CPU usage.
     * @param {number} interval
     */
    set_analysis_interval(interval) {
        wasm.lightingestimatorhandle_set_analysis_interval(this.__wbg_ptr, interval);
    }
    /**
     * Create a new lighting estimator handle.
     */
    constructor() {
        const ret = wasm.lightingestimatorhandle_new();
        this.__wbg_ptr = ret >>> 0;
        LightingEstimatorHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Reset the estimator state.
     */
    reset() {
        wasm.lightingestimatorhandle_reset(this.__wbg_ptr);
    }
}
if (Symbol.dispose) LightingEstimatorHandle.prototype[Symbol.dispose] = LightingEstimatorHandle.prototype.free;

/**
 * WASM-exposed plane detector handle.
 */
export class PlaneDetectorHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(PlaneDetectorHandle.prototype);
        obj.__wbg_ptr = ptr;
        PlaneDetectorHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PlaneDetectorHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_planedetectorhandle_free(ptr, 0);
    }
    /**
     * Get the number of detected planes.
     * @returns {number}
     */
    num_planes() {
        const ret = wasm.planedetectorhandle_num_planes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Detect planes from a flat array of 3D points [x1,y1,z1, x2,y2,z2, ...].
     * @param {Float64Array} points
     * @returns {number}
     */
    detect_planes(points) {
        const ptr0 = passArrayF64ToWasm0(points, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.planedetectorhandle_detect_planes(this.__wbg_ptr, ptr0, len0);
        return ret >>> 0;
    }
    /**
     * Get the floor plane (largest horizontal-up plane), if any.
     * @returns {JsPlaneInfo | undefined}
     */
    get_floor_plane() {
        const ret = wasm.planedetectorhandle_get_floor_plane(this.__wbg_ptr);
        return ret === 0 ? undefined : JsPlaneInfo.__wrap(ret);
    }
    /**
     * Set the minimum number of inliers required to accept a plane.
     * @param {number} min_inliers
     */
    set_min_inliers(min_inliers) {
        wasm.planedetectorhandle_set_min_inliers(this.__wbg_ptr, min_inliers);
    }
    /**
     * Perform a hit test on vertical planes only (walls).
     * @param {number} origin_x
     * @param {number} origin_y
     * @param {number} origin_z
     * @param {number} direction_x
     * @param {number} direction_y
     * @param {number} direction_z
     * @param {number} max_distance
     * @returns {JsHitResult | undefined}
     */
    hit_test_vertical(origin_x, origin_y, origin_z, direction_x, direction_y, direction_z, max_distance) {
        const ret = wasm.planedetectorhandle_hit_test_vertical(this.__wbg_ptr, origin_x, origin_y, origin_z, direction_x, direction_y, direction_z, max_distance);
        return ret === 0 ? undefined : JsHitResult.__wrap(ret);
    }
    /**
     * Create a plane detector optimized for floor detection.
     * @returns {PlaneDetectorHandle}
     */
    static for_floor_detection() {
        const ret = wasm.planedetectorhandle_for_floor_detection();
        return PlaneDetectorHandle.__wrap(ret);
    }
    /**
     * Perform a hit test on horizontal planes only (floors/tables).
     * @param {number} origin_x
     * @param {number} origin_y
     * @param {number} origin_z
     * @param {number} direction_x
     * @param {number} direction_y
     * @param {number} direction_z
     * @param {number} max_distance
     * @returns {JsHitResult | undefined}
     */
    hit_test_horizontal(origin_x, origin_y, origin_z, direction_x, direction_y, direction_z, max_distance) {
        const ret = wasm.planedetectorhandle_hit_test_horizontal(this.__wbg_ptr, origin_x, origin_y, origin_z, direction_x, direction_y, direction_z, max_distance);
        return ret === 0 ? undefined : JsHitResult.__wrap(ret);
    }
    /**
     * Set the inlier threshold (distance from plane to be considered an inlier).
     * @param {number} threshold
     */
    set_inlier_threshold(threshold) {
        wasm.planedetectorhandle_set_inlier_threshold(this.__wbg_ptr, threshold);
    }
    /**
     * Create a new plane detector with default settings.
     */
    constructor() {
        const ret = wasm.planedetectorhandle_new();
        this.__wbg_ptr = ret >>> 0;
        PlaneDetectorHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Clear all detected planes.
     */
    clear() {
        wasm.planedetectorhandle_clear(this.__wbg_ptr);
    }
    /**
     * Reset the detector (clears planes and resets plane ID counter).
     */
    reset() {
        wasm.planedetectorhandle_reset(this.__wbg_ptr);
    }
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
     * @param {number} origin_x
     * @param {number} origin_y
     * @param {number} origin_z
     * @param {number} direction_x
     * @param {number} direction_y
     * @param {number} direction_z
     * @param {number} max_distance
     * @returns {JsHitResult | undefined}
     */
    hit_test(origin_x, origin_y, origin_z, direction_x, direction_y, direction_z, max_distance) {
        const ret = wasm.planedetectorhandle_hit_test(this.__wbg_ptr, origin_x, origin_y, origin_z, direction_x, direction_y, direction_z, max_distance);
        return ret === 0 ? undefined : JsHitResult.__wrap(ret);
    }
    /**
     * Get info about a detected plane by index.
     * @param {number} index
     * @returns {JsPlaneInfo | undefined}
     */
    get_plane(index) {
        const ret = wasm.planedetectorhandle_get_plane(this.__wbg_ptr, index);
        return ret === 0 ? undefined : JsPlaneInfo.__wrap(ret);
    }
}
if (Symbol.dispose) PlaneDetectorHandle.prototype[Symbol.dispose] = PlaneDetectorHandle.prototype.free;

/**
 * Pose3D represents a 6DoF pose (position + rotation).
 * Used to communicate tracking results back to JavaScript.
 */
export class Pose3D {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Pose3D.prototype);
        obj.__wbg_ptr = ptr;
        Pose3DFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Pose3DFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pose3d_free(ptr, 0);
    }
    /**
     * X position in meters
     * @returns {number}
     */
    get x() {
        const ret = wasm.__wbg_get_pose3d_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * X position in meters
     * @param {number} arg0
     */
    set x(arg0) {
        wasm.__wbg_set_pose3d_x(this.__wbg_ptr, arg0);
    }
    /**
     * Y position in meters
     * @returns {number}
     */
    get y() {
        const ret = wasm.__wbg_get_pose3d_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * Y position in meters
     * @param {number} arg0
     */
    set y(arg0) {
        wasm.__wbg_set_pose3d_y(this.__wbg_ptr, arg0);
    }
    /**
     * Z position in meters
     * @returns {number}
     */
    get z() {
        const ret = wasm.__wbg_get_adaptiveconfig_smoothing(this.__wbg_ptr);
        return ret;
    }
    /**
     * Z position in meters
     * @param {number} arg0
     */
    set z(arg0) {
        wasm.__wbg_set_adaptiveconfig_smoothing(this.__wbg_ptr, arg0);
    }
    /**
     * Quaternion X component
     * @returns {number}
     */
    get qx() {
        const ret = wasm.__wbg_get_pose3d_qx(this.__wbg_ptr);
        return ret;
    }
    /**
     * Quaternion X component
     * @param {number} arg0
     */
    set qx(arg0) {
        wasm.__wbg_set_pose3d_qx(this.__wbg_ptr, arg0);
    }
    /**
     * Quaternion Y component
     * @returns {number}
     */
    get qy() {
        const ret = wasm.__wbg_get_pose3d_qy(this.__wbg_ptr);
        return ret;
    }
    /**
     * Quaternion Y component
     * @param {number} arg0
     */
    set qy(arg0) {
        wasm.__wbg_set_pose3d_qy(this.__wbg_ptr, arg0);
    }
    /**
     * Quaternion Z component
     * @returns {number}
     */
    get qz() {
        const ret = wasm.__wbg_get_pose3d_qz(this.__wbg_ptr);
        return ret;
    }
    /**
     * Quaternion Z component
     * @param {number} arg0
     */
    set qz(arg0) {
        wasm.__wbg_set_pose3d_qz(this.__wbg_ptr, arg0);
    }
    /**
     * Quaternion W component
     * @returns {number}
     */
    get qw() {
        const ret = wasm.__wbg_get_pose3d_qw(this.__wbg_ptr);
        return ret;
    }
    /**
     * Quaternion W component
     * @param {number} arg0
     */
    set qw(arg0) {
        wasm.__wbg_set_pose3d_qw(this.__wbg_ptr, arg0);
    }
    /**
     * Get the rotation as a JavaScript array [qx, qy, qz, qw].
     * @returns {Float32Array}
     */
    quaternion() {
        const ret = wasm.pose3d_quaternion(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Convert to a 4x4 transformation matrix in column-major order.
     * @returns {Float32Array}
     */
    to_matrix4() {
        const ret = wasm.pose3d_to_matrix4(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Create a pose from position and quaternion components.
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} qx
     * @param {number} qy
     * @param {number} qz
     * @param {number} qw
     * @returns {Pose3D}
     */
    static from_components(x, y, z, qx, qy, qz, qw) {
        const ret = wasm.pose3d_from_components(x, y, z, qx, qy, qz, qw);
        return Pose3D.__wrap(ret);
    }
    /**
     * Create a new identity pose (no rotation, at origin).
     */
    constructor() {
        const ret = wasm.pose3d_new();
        this.__wbg_ptr = ret >>> 0;
        Pose3DFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get the position as a JavaScript array [x, y, z].
     * @returns {Float32Array}
     */
    position() {
        const ret = wasm.pose3d_position(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) Pose3D.prototype[Symbol.dispose] = Pose3D.prototype.free;

/**
 * WASM handle for QR code detector.
 */
export class QrDetectorHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        QrDetectorHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_qrdetectorhandle_free(ptr, 0);
    }
    /**
     * Get the current QR size setting in meters.
     * @returns {number}
     */
    get_qr_size() {
        const ret = wasm.qrdetectorhandle_get_qr_size(this.__wbg_ptr);
        return ret;
    }
    /**
     * Set the physical size of QR codes in meters.
     *
     * This is used for pose estimation. Default is 0.05 (5cm).
     * @param {number} size_meters
     */
    set_qr_size(size_meters) {
        wasm.qrdetectorhandle_set_qr_size(this.__wbg_ptr, size_meters);
    }
    /**
     * Set camera intrinsics for pose estimation.
     *
     * # Arguments
     * * `fx` - Focal length X (pixels)
     * * `fy` - Focal length Y (pixels)
     * * `cx` - Principal point X
     * * `cy` - Principal point Y
     * @param {number} fx
     * @param {number} fy
     * @param {number} cx
     * @param {number} cy
     */
    set_intrinsics(fx, fy, cx, cy) {
        wasm.qrdetectorhandle_set_intrinsics(this.__wbg_ptr, fx, fy, cx, cy);
    }
    /**
     * Debug: Get detailed pattern info as JSON.
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @returns {any}
     */
    debug_get_patterns(rgba, width, height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.qrdetectorhandle_debug_get_patterns(this.__wbg_ptr, ptr0, len0, width, height);
        return ret;
    }
    /**
     * Debug: Get the computed threshold value.
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @returns {number}
     */
    debug_get_threshold(rgba, width, height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.qrdetectorhandle_debug_get_threshold(this.__wbg_ptr, ptr0, len0, width, height);
        return ret;
    }
    /**
     * Debug: Get number of finder patterns detected (before QR validation).
     * Returns the count of individual finder patterns found in the frame.
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @returns {number}
     */
    debug_detect_patterns(rgba, width, height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.qrdetectorhandle_debug_detect_patterns(this.__wbg_ptr, ptr0, len0, width, height);
        return ret >>> 0;
    }
    /**
     * Debug: Get image stats (min, max, mean) to verify grayscale conversion.
     * @param {Uint8Array} rgba
     * @param {number} _width
     * @param {number} _height
     * @returns {any}
     */
    debug_get_image_stats(rgba, _width, _height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.qrdetectorhandle_debug_get_image_stats(this.__wbg_ptr, ptr0, len0, _width, _height);
        return ret;
    }
    /**
     * Create a new QR code detector.
     */
    constructor() {
        const ret = wasm.qrdetectorhandle_new();
        this.__wbg_ptr = ret >>> 0;
        QrDetectorHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
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
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @returns {any}
     */
    detect(rgba, width, height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.qrdetectorhandle_detect(this.__wbg_ptr, ptr0, len0, width, height);
        return ret;
    }
}
if (Symbol.dispose) QrDetectorHandle.prototype[Symbol.dispose] = QrDetectorHandle.prototype.free;

/**
 * Quality level for tracking.
 * @enum {0 | 1 | 2 | 3}
 */
export const QualityLevel = Object.freeze({
    /**
     * Highest quality - all features enabled
     */
    High: 0, "0": "High",
    /**
     * Medium quality - reduced features
     */
    Medium: 1, "1": "Medium",
    /**
     * Low quality - minimal processing for weak devices
     */
    Low: 2, "2": "Low",
    /**
     * Minimal quality - emergency mode
     */
    Minimal: 3, "3": "Minimal",
});

/**
 * Current quality settings derived from the quality level.
 */
export class QualitySettings {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(QualitySettings.prototype);
        obj.__wbg_ptr = ptr;
        QualitySettingsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        QualitySettingsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_qualitysettings_free(ptr, 0);
    }
    /**
     * Get settings for a quality level.
     * @param {QualityLevel} level
     * @returns {QualitySettings}
     */
    static for_level(level) {
        const ret = wasm.qualitysettings_for_level(level);
        return QualitySettings.__wrap(ret);
    }
    /**
     * Maximum features to track
     * @returns {number}
     */
    get max_features() {
        const ret = wasm.__wbg_get_adaptiveconfig_target_fps(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Maximum features to track
     * @param {number} arg0
     */
    set max_features(arg0) {
        wasm.__wbg_set_adaptiveconfig_target_fps(this.__wbg_ptr, arg0);
    }
    /**
     * Number of pyramid levels
     * @returns {number}
     */
    get pyramid_levels() {
        const ret = wasm.__wbg_get_adaptiveconfig_min_fps(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of pyramid levels
     * @param {number} arg0
     */
    set pyramid_levels(arg0) {
        wasm.__wbg_set_adaptiveconfig_min_fps(this.__wbg_ptr, arg0);
    }
    /**
     * Lucas-Kanade window size
     * @returns {number}
     */
    get window_size() {
        const ret = wasm.__wbg_get_qualitysettings_window_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Lucas-Kanade window size
     * @param {number} arg0
     */
    set window_size(arg0) {
        wasm.__wbg_set_qualitysettings_window_size(this.__wbg_ptr, arg0);
    }
    /**
     * FAST detection threshold
     * @returns {number}
     */
    get fast_threshold() {
        const ret = wasm.__wbg_get_qualitysettings_fast_threshold(this.__wbg_ptr);
        return ret;
    }
    /**
     * FAST detection threshold
     * @param {number} arg0
     */
    set fast_threshold(arg0) {
        wasm.__wbg_set_qualitysettings_fast_threshold(this.__wbg_ptr, arg0);
    }
    /**
     * Frame skip interval (1 = no skip, 2 = every other frame)
     * @returns {number}
     */
    get frame_skip() {
        const ret = wasm.__wbg_get_adaptiveconfig_adjustment_delay(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Frame skip interval (1 = no skip, 2 = every other frame)
     * @param {number} arg0
     */
    set frame_skip(arg0) {
        wasm.__wbg_set_adaptiveconfig_adjustment_delay(this.__wbg_ptr, arg0);
    }
    /**
     * Enable pose smoothing
     * @returns {boolean}
     */
    get pose_smoothing() {
        const ret = wasm.__wbg_get_qualitysettings_pose_smoothing(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Enable pose smoothing
     * @param {boolean} arg0
     */
    set pose_smoothing(arg0) {
        wasm.__wbg_set_qualitysettings_pose_smoothing(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) QualitySettings.prototype[Symbol.dispose] = QualitySettings.prototype.free;

/**
 * Summary report of timing statistics.
 */
export class TimingReport {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TimingReportFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_timingreport_free(ptr, 0);
    }
    /**
     * Check if meeting 30 FPS target (< 33.33ms).
     * @returns {boolean}
     */
    get meets_30fps() {
        const ret = wasm.timingreport_meets_30fps(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if meeting 60 FPS target (< 16.67ms).
     * @returns {boolean}
     */
    get meets_60fps() {
        const ret = wasm.timingreport_meets_60fps(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get estimated FPS based on average frame time.
     * @returns {number}
     */
    get estimated_fps() {
        const ret = wasm.timingreport_estimated_fps(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get breakdown as percentages.
     * @returns {BreakdownReport}
     */
    breakdown_percentages() {
        const ret = wasm.timingreport_breakdown_percentages(this.__wbg_ptr);
        return BreakdownReport.__wrap(ret);
    }
    /**
     * Convert to JSON string.
     * @returns {string}
     */
    to_json() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.timingreport_to_json(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Number of frames measured
     * @returns {number}
     */
    get frame_count() {
        const ret = wasm.__wbg_get_timingreport_frame_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of frames measured
     * @param {number} arg0
     */
    set frame_count(arg0) {
        wasm.__wbg_set_timingreport_frame_count(this.__wbg_ptr, arg0);
    }
    /**
     * Average total frame time in ms
     * @returns {number}
     */
    get avg_total_ms() {
        const ret = wasm.__wbg_get_breakdownreport_grayscale_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Average total frame time in ms
     * @param {number} arg0
     */
    set avg_total_ms(arg0) {
        wasm.__wbg_set_breakdownreport_grayscale_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Average grayscale conversion time
     * @returns {number}
     */
    get avg_grayscale_ms() {
        const ret = wasm.__wbg_get_breakdownreport_detection_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Average grayscale conversion time
     * @param {number} arg0
     */
    set avg_grayscale_ms(arg0) {
        wasm.__wbg_set_breakdownreport_detection_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Average feature detection time
     * @returns {number}
     */
    get avg_detection_ms() {
        const ret = wasm.__wbg_get_breakdownreport_tracking_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Average feature detection time
     * @param {number} arg0
     */
    set avg_detection_ms(arg0) {
        wasm.__wbg_set_breakdownreport_tracking_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Average tracking time
     * @returns {number}
     */
    get avg_tracking_ms() {
        const ret = wasm.__wbg_get_breakdownreport_pose_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Average tracking time
     * @param {number} arg0
     */
    set avg_tracking_ms(arg0) {
        wasm.__wbg_set_breakdownreport_pose_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Average pose estimation time
     * @returns {number}
     */
    get avg_pose_ms() {
        const ret = wasm.__wbg_get_breakdownreport_other_pct(this.__wbg_ptr);
        return ret;
    }
    /**
     * Average pose estimation time
     * @param {number} arg0
     */
    set avg_pose_ms(arg0) {
        wasm.__wbg_set_breakdownreport_other_pct(this.__wbg_ptr, arg0);
    }
    /**
     * Maximum frame time
     * @returns {number}
     */
    get max_total_ms() {
        const ret = wasm.__wbg_get_jshitresult_normal_z(this.__wbg_ptr);
        return ret;
    }
    /**
     * Maximum frame time
     * @param {number} arg0
     */
    set max_total_ms(arg0) {
        wasm.__wbg_set_jshitresult_normal_z(this.__wbg_ptr, arg0);
    }
    /**
     * Minimum frame time
     * @returns {number}
     */
    get min_total_ms() {
        const ret = wasm.__wbg_get_jshitresult_distance(this.__wbg_ptr);
        return ret;
    }
    /**
     * Minimum frame time
     * @param {number} arg0
     */
    set min_total_ms(arg0) {
        wasm.__wbg_set_jshitresult_distance(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) TimingReport.prototype[Symbol.dispose] = TimingReport.prototype.free;

/**
 * Opaque handle to a 6DoF tracker instance.
 */
export class Tracker6DoFHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Tracker6DoFHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_tracker6dofhandle_free(ptr, 0);
    }
    /**
     * Get estimated gravity vector as [gx, gy, gz].
     * @returns {Float64Array}
     */
    get_gravity() {
        const ret = wasm.tracker6dofhandle_get_gravity(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get current VIO scale estimate.
     * @returns {number}
     */
    get_vio_scale() {
        const ret = wasm.tracker6dofhandle_get_vio_scale(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if device is stationary (from ZUPT detection).
     * @returns {boolean}
     */
    is_stationary() {
        const ret = wasm.tracker6dofhandle_is_stationary(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Process a frame and return the 6DoF pose as JSON.
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @returns {any}
     */
    process_frame(rgba, width, height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tracker6dofhandle_process_frame(this.__wbg_ptr, ptr0, len0, width, height);
        return ret;
    }
    /**
     * Get map points as a flat array [x1, y1, z1, x2, y2, z2, ...].
     * Points are in camera frame coordinates (scaled by current scale factor).
     * @returns {Float64Array}
     */
    get_map_points() {
        const ret = wasm.tracker6dofhandle_get_map_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get IMU buffer length (number of IMU samples stored).
     * @returns {number}
     */
    imu_buffer_len() {
        const ret = wasm.tracker6dofhandle_imu_buffer_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Check if VIO mode is enabled.
     * @returns {boolean}
     */
    is_vio_enabled() {
        const ret = wasm.tracker6dofhandle_is_vio_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Test Essential matrix computation (for WASM debugging).
     * @returns {boolean}
     */
    static test_essential() {
        const ret = wasm.tracker6dofhandle_test_essential();
        return ret !== 0;
    }
    /**
     * Get the number of tracked points.
     * @returns {number}
     */
    tracked_points() {
        const ret = wasm.tracker6dofhandle_tracked_points(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get accelerometer-derived speed (magnitude) in m/s.
     * @returns {number}
     */
    get_accel_speed() {
        const ret = wasm.tracker6dofhandle_get_accel_speed(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the number of triangulated 3D map points.
     * @returns {number}
     */
    map_point_count() {
        const ret = wasm.tracker6dofhandle_map_point_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Enable or disable VIO (Visual-Inertial Odometry) mode.
     * @param {boolean} enabled
     */
    set_vio_enabled(enabled) {
        wasm.tracker6dofhandle_set_vio_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Clear the IMU buffer.
     */
    clear_imu_buffer() {
        wasm.tracker6dofhandle_clear_imu_buffer(this.__wbg_ptr);
    }
    /**
     * Clear all map points.
     */
    clear_map_points() {
        wasm.tracker6dofhandle_clear_map_points(this.__wbg_ptr);
    }
    /**
     * Reset the stabilizer.
     */
    reset_stabilizer() {
        wasm.tracker6dofhandle_reset_stabilizer(this.__wbg_ptr);
    }
    /**
     * Get the last computed max parallax (for debugging translation issues).
     * @returns {number}
     */
    get_last_parallax() {
        const ret = wasm.tracker6dofhandle_get_last_parallax(this.__wbg_ptr);
        return ret;
    }
    /**
     * Process a frame with VIO fusion.
     * Returns the pose as JSON.
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @param {number} timestamp
     * @returns {any}
     */
    process_frame_vio(rgba, width, height, timestamp) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tracker6dofhandle_process_frame_vio(this.__wbg_ptr, ptr0, len0, width, height, timestamp);
        return ret;
    }
    /**
     * Update stabilizer with optical flow magnitude.
     * Call this each frame after processing.
     * @param {number} flow_magnitude
     * @param {number} time
     */
    update_stabilizer(flow_magnitude, time) {
        wasm.tracker6dofhandle_update_stabilizer(this.__wbg_ptr, flow_magnitude, time);
    }
    /**
     * Get accelerometer-derived position as [x, y, z] in meters.
     * @returns {Float64Array}
     */
    get_accel_position() {
        const ret = wasm.tracker6dofhandle_get_accel_position(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get accelerometer-derived velocity as [vx, vy, vz] in m/s.
     * @returns {Float64Array}
     */
    get_accel_velocity() {
        const ret = wasm.tracker6dofhandle_get_accel_velocity(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Check if VIO is initialized (gravity estimated).
     * @returns {boolean}
     */
    is_vio_initialized() {
        const ret = wasm.tracker6dofhandle_is_vio_initialized(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Apply position stabilization.
     * Call after computing translation each frame.
     */
    apply_stabilization() {
        wasm.tracker6dofhandle_apply_stabilization(this.__wbg_ptr);
    }
    /**
     * Get the gravity rotation matrix as a flat array (row-major, 9 elements).
     * This transforms from camera frame to gravity-aligned world frame.
     * @returns {Float64Array}
     */
    get_gravity_rotation() {
        const ret = wasm.tracker6dofhandle_get_gravity_rotation(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get map points transformed to gravity-aligned world frame.
     * Returns a flat array [x1, y1, z1, x2, y2, z2, ...].
     * World frame has Y pointing up (opposite to gravity).
     * @returns {Float64Array}
     */
    get_map_points_world() {
        const ret = wasm.tracker6dofhandle_get_map_points_world(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Get scale estimation confidence (0.0-1.0).
     * @returns {number}
     */
    get_scale_confidence() {
        const ret = wasm.tracker6dofhandle_get_scale_confidence(this.__wbg_ptr);
        return ret;
    }
    /**
     * Reset accelerometer position to zero.
     */
    reset_accel_position() {
        wasm.tracker6dofhandle_reset_accel_position(this.__wbg_ptr);
    }
    /**
     * Check if stabilization is enabled.
     * @returns {boolean}
     */
    is_stabilization_enabled() {
        const ret = wasm.tracker6dofhandle_is_stabilization_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get stabilized stationary state.
     * @returns {boolean}
     */
    is_stabilized_stationary() {
        const ret = wasm.tracker6dofhandle_is_stabilized_stationary(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Enable or disable position stabilization.
     * @param {boolean} enabled
     */
    set_stabilization_enabled(enabled) {
        wasm.tracker6dofhandle_set_stabilization_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Get stationary duration from stabilizer (seconds).
     * @returns {number}
     */
    stabilizer_stationary_duration() {
        const ret = wasm.tracker6dofhandle_stabilizer_stationary_duration(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if keyframe-based translation is enabled.
     * @returns {boolean}
     */
    is_keyframe_translation_enabled() {
        const ret = wasm.tracker6dofhandle_is_keyframe_translation_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Enable or disable keyframe-based translation.
     * When enabled, translation uses larger temporal baseline for more reliable estimation.
     * @param {boolean} enabled
     */
    set_keyframe_translation_enabled(enabled) {
        wasm.tracker6dofhandle_set_keyframe_translation_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Create a new 6DoF tracker.
     * @param {number} width
     * @param {number} height
     */
    constructor(width, height) {
        const ret = wasm.tracker6dofhandle_new(width, height);
        this.__wbg_ptr = ret >>> 0;
        Tracker6DoFHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Reset the tracker.
     */
    reset() {
        wasm.tracker6dofhandle_reset(this.__wbg_ptr);
    }
    /**
     * Get the current pose as JSON.
     * @returns {any}
     */
    get_pose() {
        const ret = wasm.tracker6dofhandle_get_pose(this.__wbg_ptr);
        return ret;
    }
    /**
     * Push an IMU measurement (accelerometer + gyroscope).
     *
     * # Arguments
     * * `ax, ay, az` - Acceleration in m/s²
     * * `gx, gy, gz` - Angular velocity in rad/s
     * * `timestamp` - Timestamp in seconds
     * @param {number} ax
     * @param {number} ay
     * @param {number} az
     * @param {number} gx
     * @param {number} gy
     * @param {number} gz
     * @param {number} timestamp
     */
    push_imu(ax, ay, az, gx, gy, gz, timestamp) {
        wasm.tracker6dofhandle_push_imu(this.__wbg_ptr, ax, ay, az, gx, gy, gz, timestamp);
    }
    /**
     * Get the current scale estimate.
     * @returns {number}
     */
    get_scale() {
        const ret = wasm.tracker6dofhandle_get_scale(this.__wbg_ptr);
        return ret;
    }
    /**
     * Set the scale manually.
     * @param {number} scale
     */
    set_scale(scale) {
        wasm.tracker6dofhandle_set_scale(this.__wbg_ptr, scale);
    }
}
if (Symbol.dispose) Tracker6DoFHandle.prototype[Symbol.dispose] = Tracker6DoFHandle.prototype.free;

/**
 * Opaque handle to a tracker instance.
 */
export class TrackerHandle {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(TrackerHandle.prototype);
        obj.__wbg_ptr = ptr;
        TrackerHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TrackerHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_trackerhandle_free(ptr, 0);
    }
    /**
     * Create a tracker with custom configuration.
     * @param {number} window_size
     * @param {number} pyramid_levels
     * @param {number} fast_threshold
     * @param {number} max_features
     * @returns {TrackerHandle}
     */
    static with_config(window_size, pyramid_levels, fast_threshold, max_features) {
        const ret = wasm.trackerhandle_with_config(window_size, pyramid_levels, fast_threshold, max_features);
        return TrackerHandle.__wrap(ret);
    }
    /**
     * Get the current velocity estimate from Kalman filter as [vx, vy, vz].
     * @returns {Float32Array}
     */
    get_velocity() {
        const ret = wasm.trackerhandle_get_velocity(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get the number of inlier points after RANSAC filtering.
     * @returns {number}
     */
    inlier_points() {
        const ret = wasm.trackerhandle_inlier_points(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Process a frame and return the pose as JSON.
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @returns {any}
     */
    process_frame(rgba, width, height) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.trackerhandle_process_frame(this.__wbg_ptr, ptr0, len0, width, height);
        return ret;
    }
    /**
     * Get the number of tracked points.
     * @returns {number}
     */
    tracked_points() {
        const ret = wasm.trackerhandle_tracked_points(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get the current tracking confidence level (0=Lost, 1=Low, 2=Medium, 3=High).
     * @returns {number}
     */
    confidence_level() {
        const ret = wasm.trackerhandle_confidence_level(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get the current motion model (0=Stationary, 1=Walking, 2=Running).
     * @returns {number}
     */
    get_motion_model() {
        const ret = wasm.trackerhandle_get_motion_model(this.__wbg_ptr);
        return ret;
    }
    /**
     * Check if Kalman filtering is enabled.
     * @returns {boolean}
     */
    is_kalman_enabled() {
        const ret = wasm.trackerhandle_is_kalman_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Enable or disable Kalman filtering for translation smoothing.
     * @param {boolean} enabled
     */
    set_kalman_enabled(enabled) {
        wasm.trackerhandle_set_kalman_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Get current rotation rate from gyro (rad/s).
     * @returns {number}
     */
    current_rotation_rate() {
        const ret = wasm.trackerhandle_current_rotation_rate(this.__wbg_ptr);
        return ret;
    }
    /**
     * Enable or disable gyro-based flow compensation.
     * @param {boolean} enabled
     */
    set_gyro_compensation(enabled) {
        wasm.trackerhandle_set_gyro_compensation(this.__wbg_ptr, enabled);
    }
    /**
     * Process a frame with timestamp for gyro compensation.
     * timestamp_ms should be from performance.now() for best results.
     * @param {Uint8Array} rgba
     * @param {number} width
     * @param {number} height
     * @param {number} timestamp_ms
     * @returns {any}
     */
    process_frame_with_time(rgba, width, height, timestamp_ms) {
        const ptr0 = passArray8ToWasm0(rgba, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.trackerhandle_process_frame_with_time(this.__wbg_ptr, ptr0, len0, width, height, timestamp_ms);
        return ret;
    }
    /**
     * Check if gyro compensation is currently active.
     * @returns {boolean}
     */
    is_gyro_compensation_enabled() {
        const ret = wasm.trackerhandle_is_gyro_compensation_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Create a new tracker.
     */
    constructor() {
        const ret = wasm.trackerhandle_new();
        this.__wbg_ptr = ret >>> 0;
        TrackerHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Reset the tracker.
     */
    reset() {
        wasm.trackerhandle_reset(this.__wbg_ptr);
    }
    /**
     * Get the current pose as JSON.
     * @returns {any}
     */
    get_pose() {
        const ret = wasm.trackerhandle_get_pose(this.__wbg_ptr);
        return ret;
    }
    /**
     * Push a gyroscope reading for flow compensation.
     * omega_x, omega_y, omega_z are rotation rates in rad/s.
     * timestamp_ms is the reading timestamp in milliseconds.
     * @param {number} omega_x
     * @param {number} omega_y
     * @param {number} omega_z
     * @param {number} timestamp_ms
     */
    push_gyro(omega_x, omega_y, omega_z, timestamp_ms) {
        wasm.trackerhandle_push_gyro(this.__wbg_ptr, omega_x, omega_y, omega_z, timestamp_ms);
    }
}
if (Symbol.dispose) TrackerHandle.prototype[Symbol.dispose] = TrackerHandle.prototype.free;

/**
 * Count the number of features detected (without returning full keypoint data).
 * Useful for quick feature density checks.
 * @param {Uint8Array} rgba_data
 * @param {number} width
 * @param {number} height
 * @param {number} threshold
 * @returns {number}
 */
export function count_features(rgba_data, width, height, threshold) {
    const ptr0 = passArray8ToWasm0(rgba_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.count_features(ptr0, len0, width, height, threshold);
    return ret >>> 0;
}

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
 * @param {Uint8Array} rgba_data
 * @param {number} width
 * @param {number} height
 * @param {number} threshold
 * @returns {any}
 */
export function detect_features(rgba_data, width, height, threshold) {
    const ptr0 = passArray8ToWasm0(rgba_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.detect_features(ptr0, len0, width, height, threshold);
    return ret;
}

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
 * @param {Uint8Array} rgba_data
 * @param {number} width
 * @param {number} height
 * @param {number} threshold
 * @param {number} nms_radius
 * @returns {any}
 */
export function detect_features_advanced(rgba_data, width, height, threshold, nms_radius) {
    const ptr0 = passArray8ToWasm0(rgba_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.detect_features_advanced(ptr0, len0, width, height, threshold, nms_radius);
    return ret;
}

/**
 * Log an error message to the browser console.
 * @param {string} message
 */
export function error(message) {
    const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.error(ptr0, len0);
}

/**
 * Extract features with ORB descriptors (WASM binding).
 *
 * Returns a JsValue containing an array of features with keypoints and descriptors.
 * @param {Uint8Array} rgba_data
 * @param {number} width
 * @param {number} height
 * @param {number} threshold
 * @param {number} max_features
 * @returns {any}
 */
export function extract_features_with_descriptors(rgba_data, width, height, threshold, max_features) {
    const ptr0 = passArray8ToWasm0(rgba_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.extract_features_with_descriptors(ptr0, len0, width, height, threshold, max_features);
    return ret;
}

/**
 * Get the grayscale version of an RGBA image.
 * Useful for debugging or visualization.
 * @param {Uint8Array} rgba_data
 * @returns {Uint8Array}
 */
export function get_grayscale(rgba_data) {
    const ptr0 = passArray8ToWasm0(rgba_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.get_grayscale(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Get the current high-resolution timestamp from the browser's Performance API.
 * Returns milliseconds since the page was loaded.
 * Works in both window and worker contexts.
 * @returns {number}
 */
export function get_performance_now() {
    const ret = wasm.get_performance_now();
    return ret;
}

/**
 * A simple greeting function to verify WASM integration is working.
 * This function logs to the browser console and returns a greeting message.
 * @param {string} name
 * @returns {string}
 */
export function greet(name) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.greet(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Initialize the WASM module with panic hook for better error messages.
 * This function is automatically called when the WASM module is loaded.
 */
export function init() {
    wasm.init();
}

/**
 * Log a message to the browser console.
 * @param {string} message
 */
export function log(message) {
    const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.log(ptr0, len0);
}

/**
 * Match features between two frames (WASM binding).
 *
 * Returns matched feature pairs as indices.
 * @param {any} features1_js
 * @param {any} features2_js
 * @param {number} max_distance
 * @returns {any}
 */
export function match_features(features1_js, features2_js, max_distance) {
    const ret = wasm.match_features(features1_js, features2_js, max_distance);
    return ret;
}

/**
 * Returns the version of the Aether engine.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Log a warning message to the browser console.
 * @param {string} message
 */
export function warn(message) {
    const ptr0 = passStringToWasm0(message, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    wasm.warn(ptr0, len0);
}

const EXPECTED_RESPONSE_TYPES = new Set(['basic', 'cors', 'default']);

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_Error_52673b7de5a0ca89 = function(arg0, arg1) {
        const ret = Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_Number_2d1dcfcf4ec51736 = function(arg0) {
        const ret = Number(arg0);
        return ret;
    };
    imports.wbg.__wbg___wbindgen_boolean_get_dea25b33882b895b = function(arg0) {
        const v = arg0;
        const ret = typeof(v) === 'boolean' ? v : undefined;
        return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
    };
    imports.wbg.__wbg___wbindgen_debug_string_adfb662ae34724b6 = function(arg0, arg1) {
        const ret = debugString(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_in_0d3e1e8f0c669317 = function(arg0, arg1) {
        const ret = arg0 in arg1;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_function_8d400b8b1af978cd = function(arg0) {
        const ret = typeof(arg0) === 'function';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_object_ce774f3490692386 = function(arg0) {
        const val = arg0;
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_string_704ef9c8fc131030 = function(arg0) {
        const ret = typeof(arg0) === 'string';
        return ret;
    };
    imports.wbg.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_jsval_loose_eq_766057600fdd1b0d = function(arg0, arg1) {
        const ret = arg0 == arg1;
        return ret;
    };
    imports.wbg.__wbg___wbindgen_number_get_9619185a74197f95 = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'number' ? obj : undefined;
        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    };
    imports.wbg.__wbg___wbindgen_string_get_a2a31e16edf96e42 = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'string' ? obj : undefined;
        var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_call_abb4ff46ce38be40 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_done_62ea16af4ce34b24 = function(arg0) {
        const ret = arg0.done;
        return ret;
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_error_7bc7d576a6aaf855 = function(arg0) {
        console.error(arg0);
    };
    imports.wbg.__wbg_get_6b7bd52aca3f9671 = function(arg0, arg1) {
        const ret = arg0[arg1 >>> 0];
        return ret;
    };
    imports.wbg.__wbg_get_af9dab7e9603ea93 = function() { return handleError(function (arg0, arg1) {
        const ret = Reflect.get(arg0, arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_get_with_ref_key_1dc361bd10053bfe = function(arg0, arg1) {
        const ret = arg0[arg1];
        return ret;
    };
    imports.wbg.__wbg_instanceof_ArrayBuffer_f3320d2419cd0355 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof ArrayBuffer;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Uint8Array_da54ccc9d3e09434 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Uint8Array;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_instanceof_Window_b5cf7783caa68180 = function(arg0) {
        let result;
        try {
            result = arg0 instanceof Window;
        } catch (_) {
            result = false;
        }
        const ret = result;
        return ret;
    };
    imports.wbg.__wbg_isArray_51fd9e6422c0a395 = function(arg0) {
        const ret = Array.isArray(arg0);
        return ret;
    };
    imports.wbg.__wbg_isSafeInteger_ae7d3f054d55fa16 = function(arg0) {
        const ret = Number.isSafeInteger(arg0);
        return ret;
    };
    imports.wbg.__wbg_iterator_27b7c8b35ab3e86b = function() {
        const ret = Symbol.iterator;
        return ret;
    };
    imports.wbg.__wbg_length_22ac23eaec9d8053 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_length_d45040a40c570362 = function(arg0) {
        const ret = arg0.length;
        return ret;
    };
    imports.wbg.__wbg_log_1d990106d99dacb7 = function(arg0) {
        console.log(arg0);
    };
    imports.wbg.__wbg_new_1ba21ce319a06297 = function() {
        const ret = new Object();
        return ret;
    };
    imports.wbg.__wbg_new_25f239778d6112b9 = function() {
        const ret = new Array();
        return ret;
    };
    imports.wbg.__wbg_new_6421f6084cc5bc5a = function(arg0) {
        const ret = new Uint8Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return ret;
    };
    imports.wbg.__wbg_new_b546ae120718850e = function() {
        const ret = new Map();
        return ret;
    };
    imports.wbg.__wbg_new_no_args_cb138f77cf6151ee = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_next_138a17bbf04e926c = function(arg0) {
        const ret = arg0.next;
        return ret;
    };
    imports.wbg.__wbg_next_3cfe5c0fe2a4cc53 = function() { return handleError(function (arg0) {
        const ret = arg0.next();
        return ret;
    }, arguments) };
    imports.wbg.__wbg_now_8cf15d6e317793e1 = function(arg0) {
        const ret = arg0.now();
        return ret;
    };
    imports.wbg.__wbg_performance_c77a440eff2efd9b = function(arg0) {
        const ret = arg0.performance;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_prototypesetcall_dfe9b766cdc1f1fd = function(arg0, arg1, arg2) {
        Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
    };
    imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
        arg0[arg1] = arg2;
    };
    imports.wbg.__wbg_set_7df433eea03a5c14 = function(arg0, arg1, arg2) {
        arg0[arg1 >>> 0] = arg2;
    };
    imports.wbg.__wbg_set_efaaf145b9377369 = function(arg0, arg1, arg2) {
        const ret = arg0.set(arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_769e6b65d6557335 = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_60cf02db4de8e1c1 = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_08f5a74c69739274 = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_a8924b26aa92d024 = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_value_57b7b035e117f7ee = function(arg0) {
        const ret = arg0.value;
        return ret;
    };
    imports.wbg.__wbg_warn_6e567d0d926ff881 = function(arg0) {
        console.warn(arg0);
    };
    imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
        // Cast intrinsic for `Ref(String) -> Externref`.
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
        // Cast intrinsic for `U64 -> Externref`.
        const ret = BigInt.asUintN(64, arg0);
        return ret;
    };
    imports.wbg.__wbindgen_cast_9ae0607507abb057 = function(arg0) {
        // Cast intrinsic for `I64 -> Externref`.
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
        // Cast intrinsic for `F64 -> Externref`.
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_externrefs;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
    };

    return imports;
}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('quar_engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
