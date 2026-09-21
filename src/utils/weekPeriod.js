const { normalizeOptionalTextInput } = require("./normalize");

const DEFAULT_KPI_SUBMISSION_TIMEZONE = "Africa/Tunis";

const getCanonicalKpiSubmissionFrequency = (value) => {
  const normalizedValue = normalizeOptionalTextInput(value);
  if (!normalizedValue) return "Weekly";

  const key = normalizedValue.toLowerCase().replace(/\s+/g, " ").trim();

  if (["daily", "day"].includes(key) || key.includes("day")) return "Daily";
  if (["by weekly", "biweekly", "bi-weekly", "every 2 weeks", "every two weeks"].includes(key)) {
    return "By Weekly";
  }
  if (key.includes("week")) return "Weekly";
  if (["quarterly", "quarter"].includes(key) || key.includes("quarter")) return "Quarterly";
  if (["by monthly", "bimonthly", "bi-monthly", "every 2 months", "every two months"].includes(key)) {
    return "By Monthly";
  }
  if (key.includes("month")) return "Monthly";
  if (["by yearly", "bi-yearly", "every 2 years", "every two years", "biennial"].includes(key)) {
    return "By Yearly";
  }
  if (["yearly", "annual", "year"].includes(key) || key.includes("year")) return "Yearly";

  return normalizedValue;
};

const getKpiSubmissionTargetPeriodLabel = ({
  timeContext = {},
  frequencyLabel = "Weekly"
} = {}) => {
  const canonicalFrequency = getCanonicalKpiSubmissionFrequency(frequencyLabel);
  const year = Number(timeContext.year || 0);
  const month = Number(timeContext.month || 1);
  const localDate = normalizeOptionalTextInput(timeContext.localDate);

  if (canonicalFrequency === "Daily" && localDate) {
    return localDate;
  }

  if (canonicalFrequency === "Monthly" || canonicalFrequency === "By Monthly") {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
  }

  if (canonicalFrequency === "Quarterly") {
    return `${String(year).padStart(4, "0")}-Q${Math.floor((month - 1) / 3) + 1}`;
  }

  if (canonicalFrequency === "Yearly" || canonicalFrequency === "By Yearly") {
    return String(year).padStart(4, "0");
  }

  return getCurrentFormWeekFromPseudoDate(timeContext.pseudoDate || new Date());
};

const buildTimeZoneDateContext = (timeZone, date = new Date()) => {
  const resolvedTimeZone =
    normalizeOptionalTextInput(timeZone) || DEFAULT_KPI_SUBMISSION_TIMEZONE;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: resolvedTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23"
    });

    const partsMap = formatter.formatToParts(date).reduce((accumulator, part) => {
      if (part.type !== "literal") {
        accumulator[part.type] = part.value;
      }
      return accumulator;
    }, {});

    const year = Number(partsMap.year || 0);
    const month = Number(partsMap.month || 1);
    const day = Number(partsMap.day || 1);
    const hour = Number(partsMap.hour || 0);
    const minute = Number(partsMap.minute || 0);
    const second = Number(partsMap.second || 0);
    const pseudoDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

    return {
      timeZone: resolvedTimeZone,
      year,
      month,
      day,
      dayOfWeek: pseudoDate.getUTCDay(),
      hour,
      minute,
      second,
      localDate: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      pseudoDate
    };
  } catch (error) {
    if (resolvedTimeZone !== DEFAULT_KPI_SUBMISSION_TIMEZONE) {
      return buildTimeZoneDateContext(DEFAULT_KPI_SUBMISSION_TIMEZONE, date);
    }

    throw error;
  }
};

function getCurrentWeekFromPseudoDate(date = new Date()) {
  const now = new Date(date);
  const year = now.getUTCFullYear();
  const startDate = new Date(Date.UTC(year, 0, 1));
  const days = Math.floor((now.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.ceil((days + startDate.getUTCDay() + 1) / 7);
  return `${year}-Week${weekNumber}`;
}

function getCurrentFormWeekFromPseudoDate(date = new Date()) {
  const pseudoDate = new Date(date);
  const dayOfWeek = pseudoDate.getUTCDay();
  const currentWeek = getCurrentWeekFromPseudoDate(pseudoDate);
  const fridayCutoverReached = dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;

  return fridayCutoverReached
    ? currentWeek
    : getPreviousWeek(currentWeek);
}

const getPreviousWeek = (currentWeek) => {
  const [yearStr, weekStr] = currentWeek.split('-Week');
  let year = parseInt(yearStr), weekNumber = parseInt(weekStr) - 1;
  if (weekNumber < 1) { year--; weekNumber = 52; }
  return `${year}-Week${weekNumber}`;
};

const formatIsoDateValue = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const parseWeekLabelDate = (weekLabel) => {
  const text = normalizeOptionalTextInput(weekLabel);
  const match = text ? text.match(/^(\d{4})-Week(\d{1,2})$/i) : null;
  if (!match) return null;

  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 53) {
    return null;
  }

  return new Date(Date.UTC(year, 0, 1 + (weekNumber - 1) * 7));
};

const normalizeOptionalDateInput = (value) => {
  const text = normalizeOptionalTextInput(value);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;

  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : text;
};

const formatDateOnlyValue = (value = new Date()) => {
  if (!value) return null;

  if (typeof value === "string") {
    const normalizedText = value.trim();
    const dateOnlyMatch = normalizedText.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateOnlyMatch) {
      return `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}`;
    }
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseDateOnlyValue = (value) => {
  const normalizedDate = formatDateOnlyValue(value);
  if (!normalizedDate) return null;

  const match = normalizedDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

module.exports = {
  DEFAULT_KPI_SUBMISSION_TIMEZONE,
  getCanonicalKpiSubmissionFrequency,
  getKpiSubmissionTargetPeriodLabel,
  buildTimeZoneDateContext,
  getCurrentWeekFromPseudoDate,
  getCurrentFormWeekFromPseudoDate,
  getPreviousWeek,
  formatIsoDateValue,
  parseWeekLabelDate,
  normalizeOptionalDateInput,
  formatDateOnlyValue,
  parseDateOnlyValue,
};
