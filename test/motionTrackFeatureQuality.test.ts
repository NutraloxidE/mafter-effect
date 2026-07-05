import { describe, expect, it } from "vitest";
import {
  filterPointsInRoiInterior,
  filterTrackedPoints,
  selectGridDispersedPoints,
  shouldRediscover,
  filterPointsInFrame,
  MIN_TRACK_COUNT,
  MIN_TRACK_COUNT_SFM,
  REDISCOVER_INTERVAL,
  REDISCOVER_INTERVAL_SFM,
} from "../src/editor/motionTrack/featureQuality";
import { TRACK_ROI_PRESETS, isInsideRoiInterior, roiToPixelRect } from "../src/editor/motionTrack/trackRoi";

describe("filterTrackedPoints (FB-LK + err)", () => {
  it("keeps points with small FB error and low LK err", () => {
    const prev = [{ x: 10, y: 10 }];
    const forward = [{ x: 12, y: 10 }];
    const backward = [{ x: 10.2, y: 10 }];
    const { keptPrev, keptCur } = filterTrackedPoints(
      prev,
      forward,
      backward,
      [1],
      [1],
      [2],
    );
    expect(keptPrev).toHaveLength(1);
    expect(keptCur[0]!.x).toBe(12);
  });

  it("rejects large forward-backward error", () => {
    const { keptPrev } = filterTrackedPoints(
      [{ x: 10, y: 10 }],
      [{ x: 20, y: 10 }],
      [{ x: 0, y: 10 }],
      [1],
      [1],
      [1],
    );
    expect(keptPrev).toHaveLength(0);
  });

  it("rejects high LK err", () => {
    const { keptPrev } = filterTrackedPoints(
      [{ x: 10, y: 10 }],
      [{ x: 11, y: 10 }],
      [{ x: 10, y: 10 }],
      [1],
      [1],
      [50],
    );
    expect(keptPrev).toHaveLength(0);
  });

  it("rejects failed status", () => {
    const { keptPrev } = filterTrackedPoints(
      [{ x: 10, y: 10 }],
      [{ x: 11, y: 10 }],
      [{ x: 10, y: 10 }],
      [0],
      [1],
      [1],
    );
    expect(keptPrev).toHaveLength(0);
  });
});

describe("ROI edge rejection", () => {
  it("rejects points on ROI mask edge (center 50%)", () => {
    const w = 100;
    const h = 100;
    const rect = roiToPixelRect(TRACK_ROI_PRESETS.center, w, h);
    // center ROI is [25,75) — edge at x=25 should be rejected with margin 3
    expect(isInsideRoiInterior(25, 50, rect, 3, w, h)).toBe(false);
    expect(isInsideRoiInterior(28, 50, rect, 3, w, h)).toBe(true);
    expect(isInsideRoiInterior(50, 50, rect, 3, w, h)).toBe(true);
    expect(isInsideRoiInterior(74, 50, rect, 3, w, h)).toBe(false);
  });

  it("filterPointsInRoiInterior drops edge points", () => {
    const pts = [
      { x: 25, y: 50 }, // edge
      { x: 50, y: 50 }, // interior
      { x: 90, y: 50 }, // outside ROI
    ];
    const kept = filterPointsInRoiInterior(pts, 100, 100, TRACK_ROI_PRESETS.center, 3);
    expect(kept).toEqual([{ x: 50, y: 50 }]);
  });
});

describe("selectGridDispersedPoints", () => {
  it("spreads points across grid cells", () => {
    const candidates: { x: number; y: number }[] = [];
    for (let y = 5; y < 100; y += 10) {
      for (let x = 5; x < 100; x += 10) {
        candidates.push({ x, y });
      }
    }
    const selected = selectGridDispersedPoints(candidates, [], 100, 100, {
      cols: 4,
      rows: 4,
      perCell: 1,
      minDist: 5,
    });
    expect(selected.length).toBeGreaterThanOrEqual(8);
    expect(selected.length).toBeLessThanOrEqual(16);
  });

  it("excludes points near existing tracks", () => {
    const candidates = [
      { x: 10, y: 10 },
      { x: 50, y: 50 },
    ];
    const existing = [{ x: 11, y: 11 }];
    const selected = selectGridDispersedPoints(candidates, existing, 100, 100, {
      minDist: 8,
      perCell: 5,
    });
    expect(selected.some((p) => p.x === 10 && p.y === 10)).toBe(false);
    expect(selected.some((p) => p.x === 50 && p.y === 50)).toBe(true);
  });
});

describe("shouldRediscover", () => {
  it("triggers when track count is low", () => {
    expect(shouldRediscover(1, MIN_TRACK_COUNT - 1)).toBe(true);
  });

  it("triggers every REDISCOVER_INTERVAL frames", () => {
    expect(shouldRediscover(REDISCOVER_INTERVAL, MIN_TRACK_COUNT + 10)).toBe(true);
    expect(shouldRediscover(REDISCOVER_INTERVAL + 1, MIN_TRACK_COUNT + 10)).toBe(false);
  });

  it("sfm options use shorter interval and higher min count", () => {
    const sfm = { interval: REDISCOVER_INTERVAL_SFM, minCount: MIN_TRACK_COUNT_SFM };
    expect(shouldRediscover(REDISCOVER_INTERVAL_SFM, MIN_TRACK_COUNT_SFM + 10, sfm)).toBe(true);
    expect(shouldRediscover(REDISCOVER_INTERVAL_SFM + 1, MIN_TRACK_COUNT_SFM + 10, sfm)).toBe(
      false,
    );
    expect(shouldRediscover(1, MIN_TRACK_COUNT_SFM - 1, sfm)).toBe(true);
    // default interval would not fire at frame 3
    expect(shouldRediscover(REDISCOVER_INTERVAL_SFM, MIN_TRACK_COUNT + 10)).toBe(false);
  });
});

describe("filterPointsInFrame", () => {
  it("drops points on or outside the border", () => {
    const kept = filterPointsInFrame(
      [
        { x: 0, y: 50 },
        { x: 50, y: 50 },
        { x: 99, y: 50 },
        { x: 50, y: 1 },
      ],
      100,
      100,
      2,
    );
    expect(kept).toEqual([{ x: 50, y: 50 }]);
  });
});
