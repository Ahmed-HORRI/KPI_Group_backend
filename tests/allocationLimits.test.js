const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveAllocationLimits,
  needsCorrectiveAction,
  getDashboardSubmissionStatus,
} = require("../src/services/kpiShared.service");

const relativeDown = { toleranceType: "Relative", lowTolerance: "-0.05", upTolerance: "0.05" };

test("missing high limit is derived from the relative tolerance (Kamel MASSOUDI, allocation 4569)", () => {
  const { lowLimit, highLimit } = resolveAllocationLimits({ lowLimit: "0.0", highLimit: null, target: "6.375", ...relativeDown });
  assert.equal(lowLimit, "0.0", "an existing limit is never replaced");
  assert.ok(Math.abs(highLimit - 6.69375) < 1e-9);

  // value better than target, within +5 %, above +5 %
  assert.equal(needsCorrectiveAction(5, lowLimit, highLimit, "down"), false);
  assert.equal(needsCorrectiveAction(6.6, lowLimit, highLimit, "down"), false);
  assert.equal(needsCorrectiveAction(7, lowLimit, highLimit, "down"), true);
});

test("both limits missing: a full band is derived around the target", () => {
  const { lowLimit, highLimit } = resolveAllocationLimits({ lowLimit: null, highLimit: null, target: 100, ...relativeDown });
  assert.ok(Math.abs(lowLimit - 95) < 1e-9);
  assert.ok(Math.abs(highLimit - 105) < 1e-9);
});

test("absolute tolerance, percent strings and no tolerance", () => {
  assert.deepEqual(
    resolveAllocationLimits({ lowLimit: null, highLimit: null, target: 1000, toleranceType: "Absolute", lowTolerance: "90", upTolerance: "100" }),
    { lowLimit: 910, highLimit: 1100 }
  );
  const percent = resolveAllocationLimits({ lowLimit: null, highLimit: null, target: 200, toleranceType: "Relative", lowTolerance: "-10%", upTolerance: "5%" });
  assert.ok(Math.abs(percent.lowLimit - 180) < 1e-9);
  assert.ok(Math.abs(percent.highLimit - 210) < 1e-9);
  assert.deepEqual(
    resolveAllocationLimits({ lowLimit: null, highLimit: null, target: 50, toleranceType: null, lowTolerance: null, upTolerance: null }),
    { lowLimit: 50, highLimit: 50 }
  );
});

test("explicit limits and allocations without target are left as they are", () => {
  assert.deepEqual(
    resolveAllocationLimits({ lowLimit: "80", highLimit: "130", target: 100, ...relativeDown }),
    { lowLimit: "80", highLimit: "130" }
  );
  assert.deepEqual(
    resolveAllocationLimits({ lowLimit: "0", highLimit: null, target: null, ...relativeDown }),
    { lowLimit: "0", highLimit: null }
  );
});

test("saved status: an on-target value is On track for both directions once limits are resolved", () => {
  const down = { target: 6.375, tolerance_type: "Relative", low_tolerance: "-0.05", up_tolerance: "0.05", target_direction: "down", unit: "kCur" };
  const downLimits = resolveAllocationLimits({ lowLimit: 0, highLimit: null, target: down.target, ...relativeDown });
  assert.equal(getDashboardSubmissionStatus({ ...down, low_limit: 0, high_limit: null, value: 5 }).isGood, false, "the bug: 5 < target was 'Needs attention'");
  assert.equal(getDashboardSubmissionStatus({ ...down, low_limit: downLimits.lowLimit, high_limit: downLimits.highLimit, value: 5 }).isGood, true);
  assert.equal(getDashboardSubmissionStatus({ ...down, low_limit: downLimits.lowLimit, high_limit: downLimits.highLimit, value: 7 }).isGood, false);

  const up = { target: 1, tolerance_type: "Relative", low_tolerance: "-0.05", up_tolerance: "0.05", target_direction: "up", unit: "kCur" };
  const upLimits = resolveAllocationLimits({ lowLimit: null, highLimit: "30", target: up.target, ...relativeDown });
  assert.equal(getDashboardSubmissionStatus({ ...up, low_limit: null, high_limit: "30", value: 1 }).isGood, false, "the bug: on-target was 'Needs attention'");
  assert.equal(getDashboardSubmissionStatus({ ...up, low_limit: upLimits.lowLimit, high_limit: upLimits.highLimit, value: 1 }).isGood, true);
  assert.equal(getDashboardSubmissionStatus({ ...up, low_limit: upLimits.lowLimit, high_limit: upLimits.highLimit, value: 0.7 }).isGood, false);
});
