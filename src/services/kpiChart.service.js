const {
  DEFAULT_KPI_SUBMISSION_TIMEZONE,
  getKpiSubmissionTargetPeriodLabel,
  buildTimeZoneDateContext,
  getCurrentWeekFromPseudoDate,
  formatIsoDateValue,
  parseWeekLabelDate,
  normalizeOptionalDateInput,
} = require("../utils/weekPeriod");
const { normalizeOptionalTextInput } = require("../utils/normalize");

function normalizeKpiFrequency(frequency) {
  const f = String(frequency || "").toLowerCase();

  if (f.includes("day") || f.includes("daily")) return "daily";
  if (f.includes("week") || f.includes("weekly")) return "weekly";
  if (f.includes("month") || f.includes("monthly")) return "monthly";

  return "weekly";
}

const KPI_CHART_HISTORY_WINDOW = 12;
const KPI_CHART_FUTURE_WINDOW = 3;
const KPI_CHART_DAY_MS = 24 * 60 * 60 * 1000;

function parseKpiChartMonthDate(value) {
  const text = normalizeOptionalTextInput(value);
  if (!text) return null;

  const isoMonthMatch = text.match(/^(\d{4})-(\d{2})$/);
  if (isoMonthMatch) {
    const year = Number(isoMonthMatch[1]);
    const month = Number(isoMonthMatch[2]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return null;
    }

    return new Date(Date.UTC(year, month - 1, 1));
  }

  const parsedDate = new Date(`01 ${text} UTC`);
  if (Number.isNaN(parsedDate.getTime())) return null;

  return new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), 1));
}

function formatKpiChartMonthKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0")
  ].join("-");
}

function parseKpiChartPeriodKey(value, frequencyMode) {
  const text = normalizeOptionalTextInput(value);
  if (!text) return null;

  if (frequencyMode === "daily") {
    return normalizeOptionalDateInput(text);
  }

  if (frequencyMode === "weekly") {
    if (/^\d{4}-Week\d{1,2}$/i.test(text)) return text;

    const normalizedDate = normalizeOptionalDateInput(text);
    if (!normalizedDate) return null;

    return getCurrentWeekFromPseudoDate(new Date(`${normalizedDate}T00:00:00Z`));
  }

  const normalizedDate = normalizeOptionalDateInput(text);
  if (normalizedDate) return normalizedDate.slice(0, 7);

  const parsedWeekDate = parseWeekLabelDate(text);
  if (parsedWeekDate) {
    return formatKpiChartMonthKey(parsedWeekDate);
  }

  const parsedMonthDate = parseKpiChartMonthDate(text);
  return parsedMonthDate ? formatKpiChartMonthKey(parsedMonthDate) : null;
}

function getKpiChartPeriodDate(periodKey, frequencyMode) {
  const text = normalizeOptionalTextInput(periodKey);
  if (!text) return null;

  if (frequencyMode === "daily") {
    const normalizedDate = normalizeOptionalDateInput(text);
    return normalizedDate ? new Date(`${normalizedDate}T00:00:00Z`) : null;
  }

  if (frequencyMode === "weekly") {
    return parseWeekLabelDate(text);
  }

  return parseKpiChartMonthDate(text);
}

function formatKpiChartPeriodLabel(periodKey, frequencyMode) {
  const text = normalizeOptionalTextInput(periodKey) || "";
  if (frequencyMode !== "monthly") return text;

  const monthDate = parseKpiChartMonthDate(text);
  if (!monthDate) return text;

  return monthDate.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
}

function shiftKpiChartPeriodKey(periodKey, frequencyMode, offset) {
  const baseDate = getKpiChartPeriodDate(periodKey, frequencyMode);
  if (!baseDate) return null;

  if (frequencyMode === "daily") {
    return formatIsoDateValue(new Date(baseDate.getTime() + (offset * KPI_CHART_DAY_MS)));
  }

  if (frequencyMode === "weekly") {
    return getCurrentWeekFromPseudoDate(
      new Date(baseDate.getTime() + (offset * 7 * KPI_CHART_DAY_MS))
    );
  }

  return formatKpiChartMonthKey(
    new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + offset, 1))
  );
}

function getKpiChartHistoryItemPeriodKey(item, frequencyMode) {
  if (!item || typeof item !== "object") return null;

  if (frequencyMode === "daily") {
    return parseKpiChartPeriodKey(
      item.result_date || item.period_label || item.week,
      frequencyMode
    );
  }

  if (frequencyMode === "weekly") {
    return parseKpiChartPeriodKey(
      item.week || item.period_label || item.result_date,
      frequencyMode
    );
  }

  return parseKpiChartPeriodKey(
    item.period_label || item.result_date || item.week,
    frequencyMode
  );
}

function resolveKpiChartCurrentPeriodKey(periodLabel, frequencyMode) {
  const requestedKey = parseKpiChartPeriodKey(periodLabel, frequencyMode);
  if (requestedKey) return requestedKey;

  const fallbackPeriodLabel = getKpiSubmissionTargetPeriodLabel({
    timeContext: buildTimeZoneDateContext(DEFAULT_KPI_SUBMISSION_TIMEZONE),
    frequencyLabel:
      frequencyMode === "daily"
        ? "Daily"
        : frequencyMode === "monthly"
          ? "Monthly"
          : "Weekly"
  });

  return parseKpiChartPeriodKey(fallbackPeriodLabel, frequencyMode);
}

function buildKpiChartHistorySeries({
  historyItems = [],
  frequencyMode = "weekly",
  currentPeriodLabel = null,
  currentValue = null,
  windowSize = KPI_CHART_HISTORY_WINDOW,
  futureWindowSize = KPI_CHART_FUTURE_WINDOW
} = {}) {
  const normalizedWindowSize =
    Number.isInteger(windowSize) && windowSize > 0
      ? windowSize
      : KPI_CHART_HISTORY_WINDOW;
  const normalizedFutureWindowSize =
    Number.isInteger(futureWindowSize) && futureWindowSize >= 0
      ? futureWindowSize
      : KPI_CHART_FUTURE_WINDOW;
  const periodMap = new Map();

  (Array.isArray(historyItems) ? historyItems : []).forEach((item) => {
    const numericValue = Number(item?.value ?? item?.new_value);
    if (!Number.isFinite(numericValue)) return;

    const periodKey = getKpiChartHistoryItemPeriodKey(item, frequencyMode);
    if (!periodKey) return;

    const bucket = periodMap.get(periodKey) || { sum: 0, count: 0 };
    bucket.sum += numericValue;
    bucket.count += 1;
    periodMap.set(periodKey, bucket);
  });

  const resolvedCurrentPeriodKey = resolveKpiChartCurrentPeriodKey(
    currentPeriodLabel,
    frequencyMode
  );

  if (resolvedCurrentPeriodKey && Number.isFinite(Number(currentValue))) {
    periodMap.set(resolvedCurrentPeriodKey, {
      sum: Number(currentValue),
      count: 1
    });
  }

  let orderedPeriodKeys = [];

  if (resolvedCurrentPeriodKey) {
    for (let offset = normalizedWindowSize - 1; offset >= 0; offset -= 1) {
      const shiftedPeriodKey = shiftKpiChartPeriodKey(
        resolvedCurrentPeriodKey,
        frequencyMode,
        -offset
      );

      if (shiftedPeriodKey) {
        orderedPeriodKeys.push(shiftedPeriodKey);
      }
    }

    for (let offset = 1; offset <= normalizedFutureWindowSize; offset += 1) {
      const shiftedPeriodKey = shiftKpiChartPeriodKey(
        resolvedCurrentPeriodKey,
        frequencyMode,
        offset
      );

      if (shiftedPeriodKey) {
        orderedPeriodKeys.push(shiftedPeriodKey);
      }
    }
  }

  if (!orderedPeriodKeys.length) {
    orderedPeriodKeys = Array.from(periodMap.keys())
      .sort((left, right) => {
        const leftTime = getKpiChartPeriodDate(left, frequencyMode)?.getTime() ?? 0;
        const rightTime = getKpiChartPeriodDate(right, frequencyMode)?.getTime() ?? 0;
        return leftTime - rightTime;
      })
      .slice(-(normalizedWindowSize + normalizedFutureWindowSize));
  }

  return {
    labels: orderedPeriodKeys.map((periodKey) =>
      formatKpiChartPeriodLabel(periodKey, frequencyMode)
    ),
    values: orderedPeriodKeys.map((periodKey) => {
      const bucket = periodMap.get(periodKey);
      return bucket ? Number((bucket.sum / bucket.count).toFixed(2)) : null;
    }),
    currentPeriodLabel: resolvedCurrentPeriodKey
      ? formatKpiChartPeriodLabel(resolvedCurrentPeriodKey, frequencyMode)
      : null
  };
}

module.exports = {
  normalizeKpiFrequency,
  buildKpiChartHistorySeries,
  KPI_CHART_HISTORY_WINDOW,
  // Also exported (additive, nothing else changed) for
  // GET /api/responsibles/:id/kpi-form, which needs the monolith's local
  // `weekToMonthLabel` / `sortHistoryEntries` period helpers -- the original
  // /form handler called exactly these three functions directly.
  parseKpiChartPeriodKey,
  formatKpiChartPeriodLabel,
  getKpiChartPeriodDate,
};
