const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const {
  formatDateOnlyValue,
  parseDateOnlyValue,
  formatIsoDateValue,
  parseWeekLabelDate,
  normalizeOptionalDateInput,
} = require("../utils/weekPeriod");
const { KPI_IMPORTANCE_OPTIONS } = require("../models/kpi.model");

// Mirrors index.js:22's module-level `port` (used by buildAbsoluteAppUrl's
// fallback host below).
const port = process.env.PORT || 5000;

const KPI_DIRECTION_OVERRIDES = Object.freeze({
  // Add explicit overrides here if a KPI direction should not be inferred.
  // Example: 11: "down"
});

const DOWN_DIRECTION_PATTERNS = [
  /\bclaims?\b/i,
  /\bbacklog\b/i,
  /\bstock\b/i,
  /\binventory\b/i,
  /\bcosts?\b/i,
  /\bfees?\b/i,
  /\bmore than\b/i,
  /\bdelay\b/i,
  /\blate\b/i,
];

const isPercentageUnit = (unit) => {
  const normalizedUnit = String(unit ?? '').trim().toLowerCase();
  return normalizedUnit === '%' || normalizedUnit === 'percent' || normalizedUnit === 'percentage' || normalizedUnit === 'pct';
};

const parseMetricNumber = (value) => {
  if (value === null || value === undefined || value === '' || value === 'None') {
    return null;
  }
  const parsed = parseFloat(typeof value === 'string' ? value.trim().replace(',', '.') : value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeMetricNumberByUnit = (value, unit) => {
  const parsed = parseMetricNumber(value);
  if (parsed === null) return null;
  if (!isPercentageUnit(unit)) return parsed;
  return Math.abs(parsed) < 1 ? Number((parsed * 100).toFixed(4)) : parsed;
};

const isRelativeToleranceTypeValue = (value) =>
  String(value ?? "").trim().toLowerCase() === "relative";

const parseToleranceDeltaValue = (value, toleranceType, direction = "up") => {
  if (value === null || value === undefined || value === "" || value === "None") {
    return null;
  }

  const text = String(value).trim();
  if (!text) return null;

  const hasPercent = text.includes("%");
  const numeric = parseMetricNumber(text.replace(/%/g, ""));
  if (!Number.isFinite(numeric)) return null;

  let delta = numeric;
  if (isRelativeToleranceTypeValue(toleranceType)) {
    delta = hasPercent || Math.abs(delta) > 1 ? delta / 100 : delta;
  }

  if (direction === "up") {
    return Math.abs(delta);
  }

  return delta > 0 ? -delta : delta;
};

const applyToleranceToTargetValue = (targetValue, toleranceDelta, toleranceType) => {
  if (!Number.isFinite(targetValue)) return null;
  if (!Number.isFinite(toleranceDelta)) return targetValue;
  if (isRelativeToleranceTypeValue(toleranceType)) {
    return targetValue * (1 + toleranceDelta);
  }
  return targetValue + toleranceDelta;
};

const normalizeKpiDirection = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;

  if (
    text === 'up' ||
    text === 'higher' ||
    text === 'higher is better' ||
    text === 'increase' ||
    text === 'increasing' ||
    text === 'maximize' ||
    text === 'max'
  ) {
    return 'up';
  }

  if (
    text === 'down' ||
    text === 'lower' ||
    text === 'lower is better' ||
    text === 'decrease' ||
    text === 'decreasing' ||
    text === 'minimize' ||
    text === 'min'
  ) {
    return 'down';
  }

  return null;
};

const getKpiBounds = (lowLimit, highLimit) => {
  const low = parseMetricNumber(lowLimit);
  const high = parseMetricNumber(highLimit);
  const bounds = [low, high].filter((value) => value !== null);

  if (!bounds.length) {
    return { lowerBound: null, upperBound: null };
  }

  return {
    lowerBound: Math.min(...bounds),
    upperBound: Math.max(...bounds)
  };
};

const getReadableThresholdLineValues = (lowLimit, target, highLimit) => {
  const low = parseMetricNumber(lowLimit);
  const targetValue = parseMetricNumber(target);
  const high = parseMetricNumber(highLimit);

  const entries = [
    low !== null ? { key: "low", value: low, priority: 0 } : null,
    targetValue !== null ? { key: "target", value: targetValue, priority: 1 } : null,
    high !== null ? { key: "high", value: high, priority: 2 } : null
  ].filter(Boolean);

  if (entries.length < 2) {
    return {
      low,
      target: targetValue,
      high,
      displayLow: low,
      displayTarget: targetValue,
      displayHigh: high,
      hasTightCluster: false,
      actualBand: 0,
      desiredGap: 0
    };
  }

  const sortedEntries = [...entries].sort((a, b) =>
    a.value === b.value ? a.priority - b.priority : a.value - b.value
  );

  const actualBand =
    sortedEntries[sortedEntries.length - 1].value - sortedEntries[0].value;
  const magnitude = Math.max(...sortedEntries.map((entry) => Math.abs(entry.value)), 1);
  const desiredGap = Number(
    Math.min(Math.max(0.25, magnitude * 0.04), 6).toFixed(4)
  );
  const minGap = sortedEntries.slice(1).reduce((currentMin, entry, index) => {
    const previous = sortedEntries[index];
    return Math.min(currentMin, entry.value - previous.value);
  }, Number.POSITIVE_INFINITY);

  const hasTightCluster =
    minGap < desiredGap ||
    actualBand < desiredGap * (sortedEntries.length - 1);

  if (!hasTightCluster) {
    return {
      low,
      target: targetValue,
      high,
      displayLow: low,
      displayTarget: targetValue,
      displayHigh: high,
      hasTightCluster: false,
      actualBand,
      desiredGap
    };
  }

  let displaySorted;
  const targetIndex = sortedEntries.findIndex((entry) => entry.key === "target");

  if (targetIndex >= 0) {
    const anchor = sortedEntries[targetIndex].value;
    displaySorted = sortedEntries.map((entry, index) =>
      Number((anchor + ((index - targetIndex) * desiredGap)).toFixed(4))
    );
  } else {
    const center =
      (sortedEntries[0].value + sortedEntries[sortedEntries.length - 1].value) / 2;
    const start = center - (((sortedEntries.length - 1) * desiredGap) / 2);
    displaySorted = sortedEntries.map((entry, index) =>
      Number((start + (index * desiredGap)).toFixed(4))
    );
  }

  const displayMap = {};
  sortedEntries.forEach((entry, index) => {
    displayMap[entry.key] = displaySorted[index];
  });

  return {
    low,
    target: targetValue,
    high,
    displayLow: displayMap.low ?? low,
    displayTarget: displayMap.target ?? targetValue,
    displayHigh: displayMap.high ?? high,
    hasTightCluster: true,
    actualBand,
    desiredGap
  };
};

const getAutoChartAxisRange = (
  values = [],
  lowLimit = null,
  target = null,
  highLimit = null,
  marginRatio = 0.2
) => {
  const numericValues = [];
  const pushIfNumeric = (value) => {
    const parsed = parseMetricNumber(value);
    if (parsed !== null) {
      numericValues.push(parsed);
    }
  };

  (Array.isArray(values) ? values : [values]).forEach(pushIfNumeric);
  pushIfNumeric(lowLimit);
  pushIfNumeric(target);
  pushIfNumeric(highLimit);

  if (!numericValues.length) {
    return { min: 0, max: 100, sourceMin: 0, sourceMax: 100 };
  }

  const safeMargin = Number.isFinite(marginRatio) && marginRatio >= 0
    ? marginRatio
    : 0.2;
  const sourceMin = Math.min(...numericValues);
  const sourceMax = Math.max(...numericValues);

  let min = sourceMin > 0
    ? sourceMin * (1 - safeMargin)
    : sourceMin < 0
      ? sourceMin * (1 + safeMargin)
      : 0;

  let max = sourceMax > 0
    ? sourceMax * (1 + safeMargin)
    : sourceMax < 0
      ? sourceMax * (1 - safeMargin)
      : 0;

  if (min === max) {
    const pad = Math.max(Math.abs(sourceMax || sourceMin || 1) * safeMargin, 1);
    min = sourceMin - pad;
    max = sourceMax + pad;
  }

  return {
    min: Number(min.toFixed(6)),
    max: Number(max.toFixed(6)),
    sourceMin,
    sourceMax
  };
};

const inferKpiDirection = (kpi = {}) => {
  const explicitDirection = normalizeKpiDirection(
    kpi.target_direction ||
    kpi.good_direction ||
    kpi.goodDirection ||
    kpi.direction ||
    kpi.performance_direction
  );
  if (explicitDirection) return explicitDirection;

  const overrideKey = String(kpi.kpi_id ?? kpi.kpiId ?? kpi.id ?? '');
  const overrideDirection = normalizeKpiDirection(KPI_DIRECTION_OVERRIDES[overrideKey]);
  if (overrideDirection) return overrideDirection;

  const { lowerBound, upperBound } = getKpiBounds(
    kpi.low_limit ?? kpi.lowLimit,
    kpi.high_limit ?? kpi.highLimit
  );
  const target = parseMetricNumber(kpi.target);

  if (target !== null && lowerBound !== null && upperBound !== null) {
    if (target <= lowerBound) return 'down';
    if (target >= upperBound) return 'up';
  }

  const searchableText = [
    kpi.subject,
    kpi.title,
    kpi.indicator_sub_title,
    kpi.subtitle
  ]
    .filter(Boolean)
    .join(' ');

  if (DOWN_DIRECTION_PATTERNS.some((pattern) => pattern.test(searchableText))) {
    return 'down';
  }

  return 'up';
};

const getKpiGoodDirectionMeta = (direction) => {
  const resolvedDirection = normalizeKpiDirection(direction) || 'up';

  if (resolvedDirection === 'down') {
    return {
      value: 'down',
      label: 'Down',
      summary: 'Lower is better',
      examples: 'Scrap, accidents, customer claims',
      accent: '#dc2626',
      background: '#fff5f5',
      border: '#fecaca',
      icon: '&darr;'
    };
  }

  return {
    value: 'up',
    label: 'Up',
    summary: 'Higher is better',
    examples: 'Sales, OTD',
    accent: '#16a34a',
    background: '#f0fdf4',
    border: '#bbf7d0',
    icon: '&uarr;'
  };
};

const getKpiStatus = (value, lowLimit, highLimit, direction = 'up') => {
  const val = parseMetricNumber(value);
  const resolvedDirection = normalizeKpiDirection(direction) || 'up';
  const { lowerBound, upperBound } = getKpiBounds(lowLimit, highLimit);

  if (val === null) {
    return {
      color: '#6c757d',
      isGood: null,
      direction: resolvedDirection,
      lowerBound,
      upperBound
    };
  }

  const isBelowLower = lowerBound !== null && val < lowerBound;
  const isAboveUpper = upperBound !== null && val > upperBound;
  const isBad =
    resolvedDirection === 'down'
      ? isAboveUpper
      : isBelowLower;

  return {
    color: isBad ? '#dc3545' : '#28a745',
    isGood: !isBad,
    direction: resolvedDirection,
    lowerBound,
    upperBound
  };
};

const needsCorrectiveAction = (value, lowLimit, highLimit, direction = 'up') =>
  getKpiStatus(value, lowLimit, highLimit, direction).isGood === false;

const getDotColor = (value, lowLimit, highLimit, direction = 'up') =>
  getKpiStatus(value, lowLimit, highLimit, direction).color;

const getDashboardSubmissionStatus = (kpi) => {
  const currentValue = normalizeMetricNumberByUnit(kpi?.value, kpi?.unit);
  const targetValue = normalizeMetricNumberByUnit(kpi?.target, kpi?.unit);
  const lowLimit = normalizeMetricNumberByUnit(kpi?.low_limit, kpi?.unit);
  const highLimit = normalizeMetricNumberByUnit(kpi?.high_limit, kpi?.unit);
  const resolvedDirection = inferKpiDirection(kpi);
  const { lowerBound, upperBound } = getKpiBounds(lowLimit, highLimit);

  if (currentValue === null) {
    return {
      color: "#6c757d",
      isGood: null,
      minimumTargetValue: null,
      targetValue,
      lowerBound,
      upperBound,
      direction: resolvedDirection,
      mode: "pending"
    };
  }

  const hasLimitBand = lowerBound !== null || upperBound !== null;

  if (hasLimitBand) {
    const limitStatus = getKpiStatus(currentValue, lowLimit, highLimit, resolvedDirection);

    return {
      color: limitStatus.color,
      isGood: limitStatus.isGood,
      minimumTargetValue: null,
      targetValue,
      lowerBound: limitStatus.lowerBound,
      upperBound: limitStatus.upperBound,
      direction: limitStatus.direction,
      mode: "limit"
    };
  }

  if (targetValue !== null) {
    const minimumTargetValue = applyToleranceToTargetValue(
      targetValue,
      parseToleranceDeltaValue(kpi?.low_tolerance, kpi?.tolerance_type, "low"),
      kpi?.tolerance_type
    );

    return {
      color: currentValue < minimumTargetValue ? "#dc3545" : "#28a745",
      isGood: currentValue >= minimumTargetValue,
      minimumTargetValue,
      targetValue,
      lowerBound,
      upperBound,
      direction: resolvedDirection,
      mode: "target"
    };
  }

  const fallbackStatus = getKpiStatus(currentValue, lowLimit, highLimit, resolvedDirection);

  return {
    ...fallbackStatus,
    minimumTargetValue: null,
    targetValue: null,
    mode: "limit"
  };
};

const calculateKpiTargetAdjustmentProposal = ({
  targetAutoAdjustment,
  targetValue,
  actualValue,
  direction = "up",
  recentActualValues = [],
  consecutivePeriodsRequired = 3,
  improvementThresholdPercent = 5
} = {}) => {
  const autoAdjustmentEnabled =
    String(targetAutoAdjustment || "").trim().toLowerCase() === "yes";
  const target = parseMetricNumber(targetValue);
  const actual = parseMetricNumber(actualValue);
  const resolvedDirection = normalizeKpiDirection(direction) || "up";

  if (!autoAdjustmentEnabled || target === null || actual === null) {
    return { eligible: false, reason: "disabled_or_missing_value" };
  }

  const isBetter = (value) =>
    resolvedDirection === "down" ? value < target : value > target;

  if (!isBetter(actual)) {
    return { eligible: false, reason: "actual_not_better" };
  }

  const normalizedRecentValues = (Array.isArray(recentActualValues)
    ? recentActualValues
    : [])
    .map(parseMetricNumber)
    .filter((value) => value !== null)
    .slice(0, consecutivePeriodsRequired);
  const hasConsecutiveImprovement =
    normalizedRecentValues.length === consecutivePeriodsRequired &&
    normalizedRecentValues.every(isBetter);

  const improvementPercentage = target === 0
    ? null
    : Number((
      (resolvedDirection === "down" ? target - actual : actual - target) /
      Math.abs(target) *
      100
    ).toFixed(4));
  const hasSignificantImprovement =
    improvementPercentage !== null &&
    improvementPercentage >= improvementThresholdPercent;

  if (!hasConsecutiveImprovement && !hasSignificantImprovement) {
    return {
      eligible: false,
      reason: "threshold_not_reached",
      improvementPercentage,
      consecutivePeriods: normalizedRecentValues.filter(isBetter).length
    };
  }

  const proposedTargetValue = hasConsecutiveImprovement
    ? resolvedDirection === "down"
      ? Math.max(...normalizedRecentValues)
      : Math.min(...normalizedRecentValues)
    : actual;
  const triggerReason = hasConsecutiveImprovement && hasSignificantImprovement
    ? "three_consecutive_periods_and_five_percent"
    : hasConsecutiveImprovement
      ? "three_consecutive_periods"
      : "five_percent_improvement";

  return {
    eligible: true,
    direction: resolvedDirection,
    proposedTargetValue: Number(proposedTargetValue.toFixed(6)),
    improvementPercentage,
    consecutivePeriods: hasConsecutiveImprovement
      ? consecutivePeriodsRequired
      : 1,
    triggerReason,
    evidenceValues: hasConsecutiveImprovement
      ? normalizedRecentValues
      : [actual]
  };
};

// ---------- IMPROVED Job Lock Helper with PostgreSQL Advisory Locks ----------
const acquireJobLock = async (lockId, ttlMinutes = 9) => {
  const instanceId = process.env.WEBSITE_INSTANCE_ID || `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  try {
    const lockHash = Math.abs(lockId.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0));
    const result = await pool.query('SELECT pg_try_advisory_lock($1) as acquired', [lockHash]);
    if (result.rows[0].acquired) {
      console.log(`ðŸ”’ Instance ${instanceId} acquired lock ${lockId}`);
      return { acquired: true, instanceId, lockHash };
    } else {
      return { acquired: false, instanceId, lockHash };
    }
  } catch (error) {
    return { acquired: false, instanceId, error: error.message };
  }
};

const releaseJobLock = async (lockId, lockHashOrInstanceId, maybeLockHash) => {
  const resolvedLockHash = maybeLockHash ?? lockHashOrInstanceId;
  try {
    if (resolvedLockHash) {
      await pool.query('SELECT pg_advisory_unlock($1)', [resolvedLockHash]);
    }
  } catch (error) {
    console.error(`âš ï¸ Could not release lock ${lockId}:`, error.message);
  }
};

async function runWithJobLock(lockId, jobFn) {
  const lockHash = Math.abs(
    lockId.split("").reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)
  );

  const client = await pool.connect();

  try {
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [lockHash]
    );

    if (!result.rows[0].acquired) {
      console.log(`[${lockId}] lock not acquired, skipping`);
      return;
    }

    console.log(`[${lockId}] lock acquired`);

    await jobFn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [lockHash]).catch(() => { });
    client.release();
    console.log(`[${lockId}] lock released`);
  }
}


// ---------- Nodemailer ----------
const parseBooleanEnv = (value, fallback = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const createTransporter = () => {
  const host = normalizeOptionalTextInput(process.env.SMTP_HOST) || "avocarbon-com.mail.protection.outlook.com";
  const parsedPort = Number.parseInt(String(process.env.SMTP_PORT || "25"), 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 25;
  const secure = parseBooleanEnv(process.env.SMTP_SECURE, port === 465);
  const authMode = String(
    process.env.SMTP_AUTH_MODE || "basic"
  ).trim().toLowerCase();
  const smtpUser = normalizeOptionalTextInput(process.env.SMTP_USER) || "administration.STS@avocarbon.com";
  const smtpPass = normalizeOptionalTextInput(process.env.SMTP_PASS) || "shnlgdyfbcztbhxn";

  const transporterOptions = {
    host,
    port,
    secure,
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    tls: {
      servername: host
    }
  };

  if (parseBooleanEnv(process.env.SMTP_REQUIRE_TLS, false)) {
    transporterOptions.requireTLS = true;
  }

  if (authMode !== "none" && smtpUser && smtpPass) {
    transporterOptions.auth = {
      user: smtpUser,
      pass: smtpPass
    };
  }

  return nodemailer.createTransport(transporterOptions);
};

const getOpenAIClient = () => {
  if (!process.env.SECRET_KEY) {
    throw new Error("OpenAI API key is not configured");
  }

  const OpenAI = require("openai");
  return new OpenAI({
    apiKey: process.env.SECRET_KEY,
  });
};

const formatInputDate = (dateValue) => {
  return formatDateOnlyValue(dateValue) || "";
};

const formatDisplayDate = (
  dateValue,
  locale = "en-GB",
  options = { day: "2-digit", month: "short", year: "numeric" }
) => {
  if (!dateValue) return "N/A";
  const d = parseDateOnlyValue(dateValue);
  if (!d || isNaN(d.getTime())) return "N/A";
  return d.toLocaleDateString(locale, options);
};

const normalizeText = (value) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const CORRECTIVE_ACTION_STATUS_OPTIONS = [
  "Open",
  "Waiting for validation",
  "Completed",
  "Closed"
];
const CORRECTIVE_ACTION_IMPORTANCE_OPTIONS = KPI_IMPORTANCE_OPTIONS;
const CORRECTIVE_ACTION_URGENCY_OPTIONS = Object.freeze([
  "Flexible",
  "Urgent",
  "Secondary"
]);

const OPEN_CORRECTIVE_ACTION_STATUS = "Open";
const CLOSED_CORRECTIVE_ACTION_STATUS = "Closed";

const CORRECTIVE_ACTION_ESCALATION_STAGES = [
  {
    key: "due_day_3_responsible_reminder",
    minOverdueDays: 3,
    audience: "responsible",
    label: "First reminder",
    intro:
      "This corrective action is now 3 days overdue. Please review it and update the status as soon as possible."
  },
  {
    key: "due_day_4_responsible_reminder",
    minOverdueDays: 4,
    audience: "responsible",
    label: "Second reminder",
    intro:
      "This is a second reminder because the corrective action is still open 4 days after the due date."
  },
  {
    key: "due_day_5_responsible_reminder",
    minOverdueDays: 5,
    audience: "responsible",
    label: "Third reminder",
    intro:
      "This is a third reminder because the corrective action is still open 5 days after the due date."
  },
  {
    key: "due_day_6_plant_manager_escalation",
    minOverdueDays: 6,
    audience: "manager",
    label: "Plant manager escalation",
    intro:
      "This corrective action is still open 6 days after the due date and has now been escalated to the plant manager."
  }
];

const normalizeCorrectiveActionStatus = (value, fallback = null) => {
  const text = normalizeText(value);
  if (!text) return fallback;

  const matchedStatus = CORRECTIVE_ACTION_STATUS_OPTIONS.find(
    (option) => option.toLowerCase() === text.toLowerCase()
  );

  return matchedStatus || fallback;
};

const normalizeCorrectiveActionChoice = (value, options, fallback = null) => {
  const text = normalizeText(value);
  if (!text) return fallback;

  const matchedOption = (Array.isArray(options) ? options : []).find(
    (option) => String(option).toLowerCase() === text.toLowerCase()
  );

  return matchedOption || fallback;
};

const normalizeCorrectiveActionImportance = (value, fallback = null) =>
  normalizeCorrectiveActionChoice(value, CORRECTIVE_ACTION_IMPORTANCE_OPTIONS, fallback);

const normalizeCorrectiveActionUrgency = (value, fallback = null) =>
  normalizeCorrectiveActionChoice(value, CORRECTIVE_ACTION_URGENCY_OPTIONS, fallback);

const normalizeCorrectiveActionEstimatedDurationDays = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const normalizedValue = normalizeOptionalIntegerInput(value);
  if (!Number.isInteger(normalizedValue) || normalizedValue < 0) {
    return null;
  }

  return normalizedValue;
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildAbsoluteAppUrl = (req, relativePath = "/") => {
  const normalizedPath = String(relativePath || "/").startsWith("/")
    ? String(relativePath || "/")
    : `/${String(relativePath || "")}`;
  const forwardedProto = normalizeOptionalTextInput(req?.headers?.["x-forwarded-proto"]);
  const protocol = forwardedProto || req?.protocol || "http";
  const host = normalizeOptionalTextInput(req?.get?.("host")) || `kpi-form.azurewebsites.net${port}`;
  return `${protocol}://${host}${normalizedPath}`;
};

const getCorrectiveActionSortTime = (action = {}) => {
  const rawValue =
    action.updated_date ??
    action.updatedDate ??
    action.created_date ??
    action.createdDate ??
    null;

  const timestamp = rawValue ? new Date(rawValue).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const sortCorrectiveActions = (actions = []) =>
  [...actions].sort((a, b) => {
    const timeDiff = getCorrectiveActionSortTime(b) - getCorrectiveActionSortTime(a);
    if (timeDiff !== 0) return timeDiff;

    const parsedIdA = parseInt(a.corrective_action_id ?? a.correctiveActionId ?? a.id ?? 0, 10);
    const parsedIdB = parseInt(b.corrective_action_id ?? b.correctiveActionId ?? b.id ?? 0, 10);
    const idA = Number.isFinite(parsedIdA) ? parsedIdA : 0;
    const idB = Number.isFinite(parsedIdB) ? parsedIdB : 0;
    return idB - idA;
  });

const getLatestCorrectiveAction = (actions = []) => {
  const sorted = sortCorrectiveActions(actions);
  return sorted.length ? sorted[0] : null;
};

const getCorrectiveActionOverdueDays = (dateValue, now = new Date()) => {
  if (!dateValue) return 0;

  const dueDate = parseDateOnlyValue(dateValue);
  if (!dueDate || isNaN(dueDate.getTime())) return 0;

  const currentDay = new Date(now);
  currentDay.setHours(0, 0, 0, 0);

  const dueDay = new Date(dueDate);
  dueDay.setHours(0, 0, 0, 0);

  const diffMs = currentDay.getTime() - dueDay.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;

  return Math.floor(diffMs / 86400000);
};

// ============================================================
// Ported from the monolith's app.post("/redirect", ...) handler
// (index.js) and its supporting helpers. Used by the JSON
// equivalent POST /api/responsibles/:responsibleId/kpi-results.
// ============================================================

const buildKpiFormUrl = ({
  responsibleId,
  week,
  calculationMode = null,
  frequency = null,
  unitId = null
} = {}) => {
  const normalizedResponsibleId = normalizeOptionalIntegerInput(responsibleId);
  const normalizedWeek = normalizeOptionalTextInput(week);

  const params = new URLSearchParams();
  if (normalizedResponsibleId) {
    params.set("responsible_id", String(normalizedResponsibleId));
  }
  if (normalizedWeek) {
    params.set("week", normalizedWeek);
  }

  const normalizedCalculationMode = normalizeOptionalTextInput(calculationMode);
  if (normalizedCalculationMode) {
    params.set("calculation_mode", normalizedCalculationMode);
  }

  const normalizedFrequency = normalizeOptionalTextInput(frequency);
  if (normalizedFrequency) {
    params.set("frequency", normalizedFrequency);
  }

  const normalizedUnitId = normalizeOptionalIntegerInput(unitId);
  if (normalizedUnitId) {
    params.set("unit_id", String(normalizedUnitId));
  }

  const query = params.toString();
  return query ? `/form?${query}` : "/form";
};

const sanitizeKpiFormReturnUrl = (value, fallback = null) => {
  const text = normalizeOptionalTextInput(value);
  if (!text || !text.startsWith("/form")) return fallback;
  if (text.startsWith("//")) return fallback;
  return text;
};

const deriveKpiResultDate = (periodLabel) => {
  const normalizedDate = normalizeOptionalDateInput(periodLabel);
  if (normalizedDate) return normalizedDate;

  const text = String(periodLabel || "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;

  const quarterMatch = text.match(/^(\d{4})-Q([1-4])$/i);
  if (quarterMatch) {
    const quarterStartMonth = String((Number(quarterMatch[2]) - 1) * 3 + 1).padStart(2, "0");
    return `${quarterMatch[1]}-${quarterStartMonth}-01`;
  }

  if (/^\d{4}$/.test(text)) return `${text}-01-01`;

  return formatIsoDateValue(parseWeekLabelDate(periodLabel)) || formatIsoDateValue(new Date());
};

const deriveKpiResultPeriodType = (periodLabel) => {
  const text = normalizeOptionalTextInput(periodLabel);
  if (!text) return "Date";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "Date";
  if (/^\d{4}-Week\d{1,2}$/i.test(text)) return "Week";
  if (/^\d{4}-\d{2}$/.test(text)) return "Month";
  if (/^\d{4}-Q[1-4]$/i.test(text)) return "Quarter";
  if (/^\d{4}$/.test(text)) return "Year";
  return "Period";
};

const resolveRecordedByPeopleId = async (candidateId) => {
  const peopleId = normalizeOptionalIntegerInput(candidateId);
  if (!peopleId) return null;

  const result = await pool.query(
    `SELECT people_id FROM public.people WHERE people_id = $1 LIMIT 1`,
    [peopleId]
  );

  return result.rows[0]?.people_id ?? null;
};

module.exports = {
  getCorrectiveActionSortTime,
  sortCorrectiveActions,
  getLatestCorrectiveAction,
  getCorrectiveActionOverdueDays,
  normalizeText,
  isPercentageUnit,
  parseMetricNumber,
  normalizeMetricNumberByUnit,
  isRelativeToleranceTypeValue,
  parseToleranceDeltaValue,
  applyToleranceToTargetValue,
  normalizeKpiDirection,
  getKpiBounds,
  getReadableThresholdLineValues,
  getAutoChartAxisRange,
  inferKpiDirection,
  getKpiGoodDirectionMeta,
  getKpiStatus,
  needsCorrectiveAction,
  getDotColor,
  getDashboardSubmissionStatus,
  calculateKpiTargetAdjustmentProposal,
  acquireJobLock,
  releaseJobLock,
  runWithJobLock,
  formatInputDate,
  formatDisplayDate,
  CORRECTIVE_ACTION_STATUS_OPTIONS,
  CORRECTIVE_ACTION_IMPORTANCE_OPTIONS,
  CORRECTIVE_ACTION_URGENCY_OPTIONS,
  OPEN_CORRECTIVE_ACTION_STATUS,
  CLOSED_CORRECTIVE_ACTION_STATUS,
  CORRECTIVE_ACTION_ESCALATION_STAGES,
  normalizeCorrectiveActionStatus,
  normalizeCorrectiveActionChoice,
  normalizeCorrectiveActionImportance,
  normalizeCorrectiveActionUrgency,
  normalizeCorrectiveActionEstimatedDurationDays,
  escapeHtml,
  buildAbsoluteAppUrl,
  buildKpiFormUrl,
  sanitizeKpiFormReturnUrl,
  deriveKpiResultDate,
  deriveKpiResultPeriodType,
  resolveRecordedByPeopleId,
};
