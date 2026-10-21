const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { createTransporter } = require("../config/mailer");
const { getPeopleDisplayName } = require("../models/kpi.model");
const {
  formatIsoDateValue,
  getCurrentWeekFromPseudoDate,
  getCurrentFormWeekFromPseudoDate,
} = require("../utils/weekPeriod");
const {
  getKpiStatus,
  getDotColor,
  inferKpiDirection,
  needsCorrectiveAction,
  getReadableThresholdLineValues,
  getAutoChartAxisRange,
  escapeHtml,
  normalizeKpiDirection,
  sortCorrectiveActions,
  getKpiGoodDirectionMeta,
} = require("./kpiShared.service");
const { loadFormResponsibleContext } = require("../models/responsible.model");

// actionPlan.service.js and ceoReportGeneration.service.js both require this
// file at module top-level, so requiring them back the same way would be
// circular and could capture `undefined` depending on load order. Required
// lazily (memoized) instead -- by the time any of these run, both modules
// have finished loading.
let _actionPlanService = null;
function getActionPlanService() {
  if (!_actionPlanService) _actionPlanService = require("./actionPlan.service");
  return _actionPlanService;
}
let _ceoReportGenerationService = null;
function getCeoReportGenerationService() {
  if (!_ceoReportGenerationService) _ceoReportGenerationService = require("./ceoReportGeneration.service");
  return _ceoReportGenerationService;
}

let kpiSubmissionEmailDispatchLogSchemaPromise = null;

const ensureKpiSubmissionEmailDispatchLogSchema = async () => {
  if (!kpiSubmissionEmailDispatchLogSchemaPromise) {
    kpiSubmissionEmailDispatchLogSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.kpi_submission_email_dispatch_log (
          dispatch_id BIGSERIAL PRIMARY KEY,
          people_id INTEGER NOT NULL
            REFERENCES public.people (people_id)
            ON UPDATE NO ACTION
            ON DELETE CASCADE,
          calculation_mode VARCHAR(40) NOT NULL,
          frequency_label VARCHAR(50),
          target_week VARCHAR(40) NOT NULL,
          local_dispatch_date DATE NOT NULL,
          unit_id INTEGER NULL
            REFERENCES public.unit (unit_id)
            ON UPDATE NO ACTION
            ON DELETE SET NULL,
          unit_name VARCHAR(255),
          unit_short_name VARCHAR(100),
          unit_timezone VARCHAR(120) NOT NULL,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        ALTER TABLE public.kpi_submission_email_dispatch_log
        ADD COLUMN IF NOT EXISTS frequency_label VARCHAR(50)
      `);

      await pool.query(`
        UPDATE public.kpi_submission_email_dispatch_log
        SET frequency_label = 'Weekly'
        WHERE COALESCE(TRIM(frequency_label), '') = ''
      `);

      await pool.query(`
        ALTER TABLE public.kpi_submission_email_dispatch_log
        ALTER COLUMN frequency_label SET NOT NULL
      `);

      await pool.query(`
        DROP INDEX IF EXISTS public.uq_kpi_submission_email_dispatch_log_people_mode_date
      `);

      await pool.query(`
       DROP INDEX IF EXISTS public.uq_kpi_submission_email_dispatch_log_people_mode_frequency_date;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_submission_email_dispatch_log_people_mode_frequency_unit_date
      ON public.kpi_submission_email_dispatch_log (
      people_id,
      calculation_mode,
      frequency_label,
     COALESCE(unit_id, 0),
     local_dispatch_date
      )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kpi_submission_email_dispatch_log_mode_frequency_date
        ON public.kpi_submission_email_dispatch_log (
          calculation_mode,
          frequency_label,
          local_dispatch_date DESC
        )
      `);
    })().catch((error) => {
      kpiSubmissionEmailDispatchLogSchemaPromise = null;
      throw error;
    });
  }

  return kpiSubmissionEmailDispatchLogSchemaPromise;
};

const sendKPIEmail = async (responsibleId, week, options = {}) => {
  try {
    const calculationMode = normalizeOptionalTextInput(options.calculationMode)
      ? getCanonicalKpiCalculationMode(options.calculationMode)
      : null;

    const frequencyLabel = normalizeOptionalTextInput(options.frequency)
      ? getCanonicalKpiSubmissionFrequency(options.frequency)
      : null;

    const unitId = normalizeOptionalIntegerInput(options.unitId);

    console.log("[KPI Email] Start sendKPIEmail:", {
      responsibleId,
      week,
      calculationMode,
      frequencyLabel,
      unitId,
    });

    const { responsible, kpis } = await getActionPlanService().getResponsibleWithKPIs(responsibleId, week, {
      calculationMode,
      frequency: frequencyLabel,
      unitId,
    });

    console.log("[KPI Email] Loaded responsible:", {
      responsibleId,
      responsibleName: responsible?.name,
      responsibleEmail: responsible?.email,
      kpiCount: Array.isArray(kpis) ? kpis.length : 0,
    });

    if (!responsible) {
      throw new Error(`Responsible ${responsibleId} not found`);
    }

    if (!normalizeOptionalTextInput(responsible.email)) {
      console.warn(`[KPI Email] Skipped: no email for ${responsible.name || responsibleId}`);
      return false;
    }

    if (!Array.isArray(kpis) || !kpis.length) {
      console.warn(`[KPI Email] Skipped: no KPI allocations for ${responsible.name || responsibleId}`);
      return false;
    }

    const html = getActionPlanService().generateEmailHtml({
      responsible: {
        ...responsible,
        unit_id: unitId,
      },
      week,
      calculationMode,
      frequencyLabel,
    });

    const transporter = createTransporter();

    console.log("[KPI Email] Verifying SMTP transporter...");

    await transporter.verify();

    console.log("[KPI Email] SMTP transporter verified OK");

    const subjectContext = [calculationMode, frequencyLabel].filter(Boolean).join(" | ");
    const subjectSuffix = subjectContext ? ` (${subjectContext})` : "";
    const formattedPeriodLabel = formatKpiSubmissionPeriodLabel(week, frequencyLabel);

    const subject = `KPI Submission${subjectSuffix} for ${responsible.name} - ${formattedPeriodLabel}`;

    console.log("[KPI Email] Sending email:", {
      from: "KPI Manager <kpi-manager@avocarbon.com>",
      to: responsible.email,
      subject,
    });

    const info = await transporter.sendMail({
      from: '"KPI Manager" <kpi-manager@avocarbon.com>',
      replyTo: "kpi-manager@avocarbon.com",
      to: responsible.email,
      subject,
      html,
    });

    console.log("[KPI Email] SMTP RESULT:", {
      accepted: info.accepted,
      rejected: info.rejected,
      pending: info.pending,
      response: info.response,
      messageId: info.messageId,
      envelope: info.envelope,
    });

    if (Array.isArray(info.rejected) && info.rejected.length > 0) {
      console.error("[KPI Email] SMTP rejected recipients:", info.rejected);
      return false;
    }

    if (!Array.isArray(info.accepted) || !info.accepted.length) {
      console.error("[KPI Email] SMTP did not accept any recipient");
      return false;
    }

    console.log(`[KPI Email] Email accepted by SMTP for ${responsible.email}`);
    return true;
  } catch (err) {
    console.error(`[KPI Email] Failed to send email to responsible ID ${responsibleId}:`, {
      message: err.message,
      code: err.code,
      command: err.command,
      response: err.response,
      responseCode: err.responseCode,
      stack: err.stack,
    });

    return false;
  }
};

const loadKpiSubmissionEmailRecipients = async (calculationMode = null) => {
  const normalizedCalculationMode = normalizeOptionalTextInput(calculationMode);
  const modeFilter = normalizedCalculationMode
    ? getCanonicalKpiCalculationMode(normalizedCalculationMode).toLowerCase()
    : null;
  const result = await pool.query(
    `
    SELECT
      owner.people_id,
      NULLIF(TRIM(CONCAT_WS(' ', COALESCE(owner.first_name, ''), COALESCE(owner.name, ''))), '') AS name,
      owner.email,
      COALESCE(unit_scope.unit_id, plant_scope.unit_id) AS unit_id,
      COALESCE(
        NULLIF(TRIM(unit_scope.unit_name), ''),
        NULLIF(TRIM(plant_scope.unit_name), ''),
        NULLIF(TRIM(primary_unit.unit_name), ''),
        NULLIF(TRIM(home_unit.unit_name), '')
      ) AS unit_name,
      COALESCE(
        NULLIF(TRIM(unit_scope.unit_short_name), ''),
        NULLIF(TRIM(plant_scope.unit_short_name), ''),
        NULLIF(TRIM(primary_unit.unit_short_name), ''),
        NULLIF(TRIM(home_unit.unit_short_name), '')
      ) AS unit_short_name,
      COALESCE(
        NULLIF(TRIM(unit_scope.country), ''),
        NULLIF(TRIM(plant_scope.country), ''),
        NULLIF(TRIM(primary_unit.country), ''),
        NULLIF(TRIM(home_unit.country), '')
      ) AS country,
      k.frequency,
      COALESCE(kta.updated_at, kta.created_at, CURRENT_TIMESTAMP) AS allocation_updated_at,
      kta.kpi_target_allocation_id
    FROM public.kpi_target_allocation kta
    JOIN public.kpi k
      ON k.kpi_id = kta.kpi_id
    JOIN public.people owner
      ON owner.people_id = kta.set_by_people_id
    LEFT JOIN LATERAL (
      SELECT pra.unit_id
      FROM public.people_role_assignment pra
      WHERE pra.people_id = owner.people_id
        AND COALESCE(pra.assignment_status, 'ACTIVE') = 'ACTIVE'
        AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
      ORDER BY
        COALESCE(pra.is_primary, false) DESC,
        pra.assignment_id DESC
      LIMIT 1
    ) primary_assignment ON TRUE
    LEFT JOIN public.unit primary_unit
      ON primary_unit.unit_id = primary_assignment.unit_id
    LEFT JOIN public.unit home_unit
      ON home_unit.unit_id = owner.work_at_unit_id
    LEFT JOIN public.unit unit_scope
      ON unit_scope.unit_id = kta.unit_id
    LEFT JOIN public.unit plant_scope
      ON plant_scope.unit_id = kta.plant_id
    WHERE owner.people_id IS NOT NULL
      AND kta.set_by_people_id IS NOT NULL
      AND COALESCE(TRIM(owner.email), '') <> ''
      AND COALESCE(kta.is_active, true) = true
      AND COALESCE(k.is_active, true) = true
      AND COALESCE(LOWER(TRIM(kta.target_status)), '') <> 'inactive'
      AND (
        $1::text IS NULL
        OR LOWER(COALESCE(NULLIF(TRIM(k.calculation_mode), ''), 'direct')) = $1
      )
    ORDER BY
      owner.people_id ASC,
      COALESCE(kta.updated_at, kta.created_at, CURRENT_TIMESTAMP) DESC,
      kta.kpi_target_allocation_id DESC
    `,
    [modeFilter]
  );

  const recipientByKey = new Map();

  result.rows.forEach((row) => {
    const peopleId = normalizeOptionalIntegerInput(row.people_id);
    if (!peopleId) return;

    const frequencyLabel = getCanonicalKpiSubmissionFrequency(row.frequency);
    const unitId = normalizeOptionalIntegerInput(row.unit_id);
    const key = `${peopleId}:${frequencyLabel}:${unitId || "no-unit"}`;

    if (!recipientByKey.has(key)) {
      recipientByKey.set(key, {
        ...row,
        people_id: peopleId,
        unit_id: unitId,
        frequency_label: frequencyLabel
      });
    }
  });

  return Array.from(recipientByKey.values()).sort((left, right) => {
    const peopleIdDiff = Number(left.people_id || 0) - Number(right.people_id || 0);
    if (peopleIdDiff !== 0) return peopleIdDiff;
    return String(left.frequency_label || "").localeCompare(String(right.frequency_label || ""));
  });
};

const DEFAULT_KPI_SUBMISSION_TIMEZONE = "Africa/Tunis";
const KPI_SUBMISSION_DISPATCH_WINDOW_MINUTES = 15;
const COUNTRY_TIMEZONE_BY_NAME = {
  luxembourg: "Europe/Paris",
  france: "Europe/Paris",
  tunisia: "Africa/Tunis",
  germany: "Europe/Berlin",
  india: "Asia/Kolkata",
  korea: "Asia/Seoul",
  "south korea": "Asia/Seoul",
  china: "Asia/Shanghai",
  mexico: "America/Mexico_City"
};

const normalizeCountryTimezoneKey = (value) =>
  String(value ?? "").trim().toLowerCase();

const getCanonicalKpiCalculationMode = (value) => {
  const normalizedValue = normalizeOptionalTextInput(value);
  if (!normalizedValue) return "Direct";
  return normalizedValue.trim().toLowerCase() === "ratio" ? "Ratio" : "Direct";
};

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

const formatKpiSubmissionPeriodLabel = (periodLabel, frequencyLabel = null) => {
  const normalizedPeriodLabel = normalizeOptionalTextInput(periodLabel) || "";
  const canonicalFrequency = frequencyLabel
    ? getCanonicalKpiSubmissionFrequency(frequencyLabel)
    : null;

  if (!normalizedPeriodLabel) return "Current period";

  if (canonicalFrequency === "Daily" && /^\d{4}-\d{2}-\d{2}$/.test(normalizedPeriodLabel)) {
    return new Date(`${normalizedPeriodLabel}T00:00:00Z`).toLocaleDateString("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    });
  }

  const weekMatch = normalizedPeriodLabel.match(/^(\d{4})-Week(\d{1,2})$/i);
  if (weekMatch) {
    return `Week ${Number(weekMatch[2])}, ${weekMatch[1]}`;
  }

  const monthMatch = normalizedPeriodLabel.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    return new Date(`${normalizedPeriodLabel}-01T00:00:00Z`).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    });
  }

  const quarterMatch = normalizedPeriodLabel.match(/^(\d{4})-Q([1-4])$/i);
  if (quarterMatch) {
    return `Q${quarterMatch[2]} ${quarterMatch[1]}`;
  }

  if (/^\d{4}$/.test(normalizedPeriodLabel)) {
    return normalizedPeriodLabel;
  }

  return normalizedPeriodLabel;
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

const isKpiSubmissionFrequencyDue = (timeContext = {}, frequencyLabel = "Weekly") => {
  const canonicalFrequency = getCanonicalKpiSubmissionFrequency(frequencyLabel);
  const dayOfWeek = Number(timeContext.dayOfWeek);
  const dayOfMonth = Number(timeContext.day);
  const month = Number(timeContext.month);
  const year = Number(timeContext.year);
  const currentWeekLabel = getCurrentWeekFromPseudoDate(timeContext.pseudoDate || new Date());
  const weekNumber = Number(currentWeekLabel.match(/Week(\d+)/i)?.[1] || 0);

  if (canonicalFrequency === "Daily") return true;
  if (canonicalFrequency === "Weekly") return dayOfWeek === 1;
  if (canonicalFrequency === "By Weekly") return dayOfWeek === 1 && weekNumber % 2 === 1;
  if (canonicalFrequency === "Monthly") return dayOfMonth === 1;
  if (canonicalFrequency === "By Monthly") return dayOfMonth === 1 && month % 2 === 1;
  if (canonicalFrequency === "Quarterly") {
    return dayOfMonth === 1 && [1, 4, 7, 10].includes(month);
  }
  if (canonicalFrequency === "Yearly") return dayOfMonth === 1 && month === 1;
  if (canonicalFrequency === "By Yearly") {
    return dayOfMonth === 1 && month === 1 && year % 2 === 1;
  }

  return dayOfWeek === 1;
};

const resolveKpiSubmissionRecipientTimeZone = (recipient = {}) => {
  const countryKey = normalizeCountryTimezoneKey(recipient.country);

  if (COUNTRY_TIMEZONE_BY_NAME[countryKey]) {
    return COUNTRY_TIMEZONE_BY_NAME[countryKey];
  }

  return DEFAULT_KPI_SUBMISSION_TIMEZONE;
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

const getKpiSubmissionTargetLocalHour = (calculationMode) => {
  const canonicalMode = getCanonicalKpiCalculationMode(calculationMode);
  return canonicalMode === "Ratio" ? 8 : 10;
};

const hasReachedKpiSubmissionLocalSendWindow = (
  timeContext = {},
  calculationMode = "Direct"
) => {
  const targetHour = getKpiSubmissionTargetLocalHour(calculationMode);

  const currentMinutes =
    Number(timeContext.hour) * 60 + Number(timeContext.minute);

  const targetMinutes = targetHour * 60;

  return currentMinutes >= targetMinutes;
};

const hasKpiSubmissionEmailBeenSentForLocalDate = async ({
  peopleId,
  calculationMode,
  frequencyLabel,
  localDispatchDate,
  unitId = null
}) => {
  const normalizedPeopleId = normalizeOptionalIntegerInput(peopleId);
  const canonicalMode = getCanonicalKpiCalculationMode(calculationMode);
  const canonicalFrequency = getCanonicalKpiSubmissionFrequency(frequencyLabel);
  const normalizedLocalDate = normalizeOptionalTextInput(localDispatchDate);
  const normalizedUnitId = normalizeOptionalIntegerInput(unitId);

  if (!normalizedPeopleId || !normalizedLocalDate) {
    return false;
  }

  const result = await pool.query(
    `
  SELECT 1
   FROM public.kpi_submission_email_dispatch_log
  WHERE people_id = $1
   AND calculation_mode = $2
   AND frequency_label = $3
   AND local_dispatch_date = $4::date
   AND COALESCE(unit_id, 0) = COALESCE($5::integer, 0)
   LIMIT 1
    `,
    [normalizedPeopleId, canonicalMode, canonicalFrequency, normalizedLocalDate, normalizedUnitId]
  );

  return Boolean(result.rows.length);
};

const recordKpiSubmissionEmailDispatch = async ({
  peopleId,
  calculationMode,
  frequencyLabel,
  targetWeek,
  localDispatchDate,
  unitId = null,
  unitName = null,
  unitShortName = null,
  unitTimeZone
}) => {
  const normalizedPeopleId = normalizeOptionalIntegerInput(peopleId);
  const canonicalMode = getCanonicalKpiCalculationMode(calculationMode);
  const canonicalFrequency = getCanonicalKpiSubmissionFrequency(frequencyLabel);
  const normalizedTargetWeek = normalizeOptionalTextInput(targetWeek);
  const normalizedLocalDate = normalizeOptionalTextInput(localDispatchDate);

  if (!normalizedPeopleId || !normalizedTargetWeek || !normalizedLocalDate) {
    return false;
  }

  await pool.query(
    `
    INSERT INTO public.kpi_submission_email_dispatch_log (
      people_id,
      calculation_mode,
      frequency_label,
      target_week,
      local_dispatch_date,
      unit_id,
      unit_name,
      unit_short_name,
      unit_timezone
    )
    VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
   ON CONFLICT (
      people_id,
      calculation_mode,
      frequency_label,
      COALESCE(unit_id, 0),
      local_dispatch_date
    ) DO NOTHING
    `,
    [
      normalizedPeopleId,
      canonicalMode,
      canonicalFrequency,
      normalizedTargetWeek,
      normalizedLocalDate,
      normalizeOptionalIntegerInput(unitId),
      normalizeOptionalTextInput(unitName),
      normalizeOptionalTextInput(unitShortName),
      normalizeOptionalTextInput(unitTimeZone) || DEFAULT_KPI_SUBMISSION_TIMEZONE
    ]
  );

  return true;
};

const loadWeeklyReportRecipientsForWeek = async (reportWeek) => {
  const result = await pool.query(
    `
    SELECT DISTINCT
      owner.people_id,
      NULLIF(TRIM(CONCAT_WS(' ', COALESCE(owner.first_name, ''), COALESCE(owner.name, ''))), '') AS name,
      owner.email
    FROM public.kpi_target_allocation kta
    JOIN public.people owner
      ON owner.people_id = kta.set_by_people_id
    JOIN public.kpi_result kr
      ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
    WHERE kta.set_by_people_id IS NOT NULL
      AND COALESCE(TRIM(owner.email), '') <> ''
      AND ($1::text IS NULL OR kr.period_label = $1 OR kr.week = $1)
      AND kr.raw_value IS NOT NULL
      AND TRIM(CAST(kr.raw_value AS TEXT)) <> ''
    ORDER BY owner.people_id ASC
    `,
    [normalizeOptionalTextInput(reportWeek)]
  );

  return result.rows;
};

const formatNumber = (num) => {
  const n = parseFloat(num);
  if (Number.isInteger(n)) return n.toString();
  if (Math.abs(n - Math.round(n)) < 0.0001) return Math.round(n).toString();
  return n.toFixed(1);
};

const WEEKLY_REPORT_MAX_CHARTS = Math.max(
  1,
  Number.parseInt(String(process.env.WEEKLY_REPORT_MAX_CHARTS || "3"), 10) || 3
);
const WEEKLY_REPORT_MAX_COMMENTS = 1;
const WEEKLY_REPORT_MAX_CORRECTIVE_ACTIONS = 2;

const truncateWeeklyReportText = (value, maxLength = 240) => {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 0 || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trim()}…`;
};

const escapeWeeklyReportText = (value, maxLength) =>
  escapeHtml(truncateWeeklyReportText(value, maxLength));

const escapeWeeklyReportMultilineText = (value, maxLength) =>
  escapeWeeklyReportText(String(value ?? "").replace(/\r\n/g, "\n"), maxLength).replace(/\n/g, "<br />");

const formatWeeklyReportWeekLabel = (week) => {
  const normalized = String(week || "").trim();
  if (!normalized) return "";
  return normalized.includes("-Week")
    ? normalized.replace(/^\d{4}-Week/, "Week ")
    : normalized;
};

const buildWeeklyReportChartModel = (chartData = {}) => {
  const title = truncateWeeklyReportText(chartData.title || "Untitled KPI", 120);
  const subtitle = truncateWeeklyReportText(chartData.subtitle || "", 160);
  const unit = truncateWeeklyReportText(chartData.unit || "", 30);
  const frequency = truncateWeeklyReportText(chartData.frequency || "Monthly", 40);
  const currentWeekLabel = formatWeeklyReportWeekLabel(
    chartData.currentWeek || chartData.week || ""
  );

  const cleanHigh = Number.isFinite(parseFloat(chartData.high_limit))
    ? parseFloat(chartData.high_limit)
    : null;
  const cleanLow = Number.isFinite(parseFloat(chartData.low_limit))
    ? parseFloat(chartData.low_limit)
    : null;
  const cleanTarget = Number.isFinite(parseFloat(chartData.target))
    ? parseFloat(chartData.target)
    : null;
  const thresholdLineValues = getReadableThresholdLineValues(cleanLow, cleanTarget, cleanHigh);
  const displayHigh = thresholdLineValues.displayHigh;
  const displayLow = thresholdLineValues.displayLow;
  const displayTarget = thresholdLineValues.displayTarget;

  const values = (Array.isArray(chartData.data) ? chartData.data : [])
    .slice(0, 12)
    .map((value) => {
      const numericValue = Number(value);
      return Number.isFinite(numericValue) ? numericValue : 0;
    });

  const safeValues = values.length ? values : [0];
  const labels = (Array.isArray(chartData.weekLabels) ? chartData.weekLabels : safeValues.map((_, index) => `P${index + 1}`))
    .slice(0, 12)
    .map((label, index) => truncateWeeklyReportText(label || `P${index + 1}`, 24));
  const axisRange = getAutoChartAxisRange(safeValues, displayLow, displayTarget, displayHigh);
  const resolvedDirection = normalizeKpiDirection(chartData.direction) || "up";
  const currentValue = safeValues[safeValues.length - 1] || 0;
  const currentStatus = getKpiStatus(currentValue, cleanLow, cleanHigh, resolvedDirection);
  const pointColors = safeValues.map((value) => getDotColor(value, cleanLow, cleanHigh, resolvedDirection));

  const datasets = [
    {
      label: subtitle || title,
      data: safeValues,
      borderColor: "#94a3b8",
      borderWidth: 2,
      lineTension: 0,
      fill: false,
      pointBackgroundColor: pointColors,
      pointBorderColor: "#ffffff",
      pointBorderWidth: 2,
      pointRadius: 5
    }
  ];

  if (cleanHigh !== null) {
    datasets.push({
      label: `High Limit (${formatNumber(cleanHigh)})`,
      data: new Array(safeValues.length).fill(displayHigh),
      borderColor: "#f97316",
      borderWidth: 2.25,
      borderDash: [10, 4],
      pointRadius: 0,
      fill: false
    });
  }

  if (cleanLow !== null) {
    datasets.push({
      label: `Low Limit (${formatNumber(cleanLow)})`,
      data: new Array(safeValues.length).fill(displayLow),
      borderColor: "#dc2626",
      borderWidth: 2.25,
      borderDash: [4, 6],
      pointRadius: 0,
      fill: false
    });
  }

  if (cleanTarget !== null) {
    datasets.push({
      label: `Target (${formatNumber(cleanTarget)})`,
      data: new Array(safeValues.length).fill(displayTarget),
      borderColor: "#16a34a",
      borderWidth: 2.5,
      pointRadius: 0,
      fill: false
    });
  }

  const chartHeightPx = thresholdLineValues.hasTightCluster ? 300 : 250;
  const chartConfig = {
    type: "line",
    data: { labels, datasets },
    options: {
      legend: { display: false },
      layout: { padding: { top: 8, right: 10, bottom: 4, left: 4 } },
      scales: {
        xAxes: [{
          ticks: { fontSize: 10 },
          gridLines: { color: "rgba(0,0,0,0.05)" }
        }],
        yAxes: [{
          ticks: {
            fontSize: 10,
            beginAtZero: false,
            min: axisRange.min,
            max: axisRange.max
          },
          gridLines: { color: "rgba(0,0,0,0.05)" }
        }]
      }
    }
  };

  const chartUrl =
    `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}` +
    `&w=480&h=${chartHeightPx}&bkg=white&format=png&devicePixelRatio=2`;

  return {
    title,
    subtitle,
    unit,
    frequency,
    currentWeekLabel,
    chartUrl,
    chartHeightPx,
    chartAlt: truncateWeeklyReportText(`${title} trend chart`, 120),
    currentColor: getDotColor(currentValue, cleanLow, cleanHigh, resolvedDirection),
    currentValue: truncateWeeklyReportText(chartData?.stats?.current ?? formatNumber(currentValue), 40),
    averageValue: truncateWeeklyReportText(chartData?.stats?.average ?? "N/A", 40),
    periodsLabel: truncateWeeklyReportText(`${chartData?.stats?.dataPoints || safeValues.length} periods`, 40),
    directionArrow: currentStatus.isGood === false
      ? (resolvedDirection === "down" ? "↑" : "↓")
      : (resolvedDirection === "down" ? "↓" : "↑"),
    directionColor: currentStatus.isGood === false ? "#dc2626" : "#16a34a",
    thresholdBadges: [
      cleanTarget !== null ? { label: "Target", value: formatNumber(cleanTarget), color: "#16a34a" } : null,
      cleanHigh !== null ? { label: "High Limit", value: formatNumber(cleanHigh), color: "#ea580c" } : null,
      cleanLow !== null ? { label: "Low Limit", value: formatNumber(cleanLow), color: "#dc2626" } : null
    ].filter(Boolean),
    comments: (Array.isArray(chartData.comments) ? chartData.comments : [])
      .slice(0, WEEKLY_REPORT_MAX_COMMENTS)
      .map((entry) => ({
        weekLabel:
          getCeoReportGenerationService().weekToMonthLabel(entry?.week || "") ||
          formatWeeklyReportWeekLabel(entry?.week || "") ||
          "Period",
        text: truncateWeeklyReportText(entry?.text || "", 280)
      }))
      .filter((entry) => entry.text),
    correctiveActions: (Array.isArray(chartData.correctiveActions) ? chartData.correctiveActions : [])
      .slice(0, WEEKLY_REPORT_MAX_CORRECTIVE_ACTIONS)
      .map((entry) => ({
        weekLabel:
          getCeoReportGenerationService().weekToMonthLabel(entry?.week || "") ||
          formatWeeklyReportWeekLabel(entry?.week || "") ||
          "Period",
        status: truncateWeeklyReportText(entry?.status || "Open", 60),
        rootCause: truncateWeeklyReportText(entry?.root_cause || "", 220),
        implementedSolution: truncateWeeklyReportText(entry?.implemented_solution || "", 220),
        responsible: truncateWeeklyReportText(entry?.responsible || "", 120),
        evidence: truncateWeeklyReportText(entry?.evidence || "", 180),
        dueDate: entry?.due_date
          ? (() => {
            const parsed = new Date(entry.due_date);
            return Number.isNaN(parsed.getTime())
              ? truncateWeeklyReportText(entry.due_date, 40)
              : parsed.toLocaleDateString("en-GB");
          })()
          : ""
      }))
      .filter((entry) => entry.rootCause || entry.implementedSolution || entry.responsible || entry.evidence || entry.dueDate)
  };
};

const fetchWeeklyReportInlineChartAttachment = async (chartModel, chartIndex) => {
  const chartLabel = truncateWeeklyReportText(chartModel?.title || `chart_${chartIndex + 1}`, 50)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || `chart_${chartIndex + 1}`;
  const cid = `weekly-report-chart-${Date.now()}-${chartIndex}@avocarbon.local`;

  try {
    if (typeof fetch !== "function") {
      throw new Error("Global fetch is not available");
    }

    const response = await fetch(chartModel.chartUrl, {
      headers: { Accept: "image/png" }
    });

    if (!response.ok) {
      throw new Error(`QuickChart responded with ${response.status}`);
    }

    return {
      cid,
      attachment: {
        filename: `${chartLabel}.png`,
        content: Buffer.from(await response.arrayBuffer()),
        contentType: "image/png",
        contentDisposition: "inline",
        cid
      }
    };
  } catch (error) {
    console.error(`[Weekly Report] Inline chart ${chartIndex + 1} failed:`, error.message);
    return { cid: "", attachment: null };
  }
};

const renderWeeklyReportChartCard = (chartModel, { imageSrc = "" } = {}) => {
  const thresholdOrder = ["High Limit", "Target", "Low Limit"];
  const orderedThresholds = thresholdOrder
    .map((label) => chartModel.thresholdBadges.find((badge) => badge.label === label))
    .filter(Boolean);

  const thresholdCardsHtml = orderedThresholds.length
    ? `
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:18px 0 0;">
        <tr>
          ${orderedThresholds.map((badge, index) => `
            <td valign="top" width="${Math.round(100 / orderedThresholds.length)}%"
                ${index < orderedThresholds.length - 1 ? 'style="padding-right:10px;"' : ""}>
              <table border="0" cellpadding="0" cellspacing="0" width="100%"
                     style="background:#ffffff;border:1px solid #dbe4ef;border-radius:12px;">
                <tr>
                  <td align="center" style="padding:14px 10px 12px;">
                    <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">
                      ${escapeWeeklyReportText(badge.label, 40)}
                    </div>
                    <div style="font-size:20px;font-weight:700;color:${badge.color};line-height:1.2;">
                      ${escapeWeeklyReportText(badge.value, 40)}
                    </div>
                    <div style="font-size:10px;color:#94a3b8;margin-top:4px;">
                      ${escapeWeeklyReportText(chartModel.unit || "-", 20)}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          `).join("")}
        </tr>
      </table>`
    : "";

  const correctiveActionsPanelHtml = chartModel.correctiveActions.length
    ? chartModel.correctiveActions.map((entry) => `
        <div style="margin-bottom:10px;padding:12px 12px;background:#fff4f4;border:1px solid #ffd6d6;border-left:4px solid #ef4444;border-radius:10px;">
          <div style="font-size:11px;font-weight:700;color:#7f1d1d;margin-bottom:6px;">
            ${escapeWeeklyReportText(entry.weekLabel, 40)}
            ${entry.status ? `<span style="margin-left:8px;color:#dc2626;">${escapeWeeklyReportText(entry.status, 50)}</span>` : ""}
          </div>
          ${entry.rootCause ? `<div style="font-size:12px;color:#374151;line-height:1.45;margin-bottom:5px;"><strong>Root Cause</strong><br />${escapeWeeklyReportMultilineText(entry.rootCause, 220)}</div>` : ""}
          ${entry.implementedSolution ? `<div style="font-size:12px;color:#374151;line-height:1.45;margin-bottom:5px;"><strong>Implemented Solution</strong><br />${escapeWeeklyReportMultilineText(entry.implementedSolution, 220)}</div>` : ""}
          ${entry.dueDate ? `<div style="font-size:11px;color:#475569;margin-bottom:4px;"><strong>Due Date</strong><br />${escapeWeeklyReportText(entry.dueDate, 40)}</div>` : ""}
          ${entry.responsible ? `<div style="font-size:11px;color:#475569;"><strong>Responsible</strong><br />${escapeWeeklyReportText(entry.responsible, 120)}</div>` : ""}
        </div>
      `).join("")
    : `<div style="padding:24px 16px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;text-align:center;color:#64748b;font-size:12px;line-height:1.5;">
         No corrective actions were recorded for this KPI in the selected period.
       </div>`;

  const commentsHtml = chartModel.comments.length
    ? `
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">
        <tr>
          <td style="padding:0;">
            <div style="font-size:11px;font-weight:700;color:#0f6cbd;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Latest Comment</div>
            ${chartModel.comments.map((entry) => `
              <div style="padding:12px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;">
                <div style="font-size:11px;font-weight:700;color:#1d4ed8;margin-bottom:5px;">${escapeWeeklyReportText(entry.weekLabel, 40)}</div>
                <div style="font-size:13px;color:#334155;line-height:1.5;">${escapeWeeklyReportMultilineText(entry.text, 280)}</div>
              </div>
            `).join("")}
          </td>
        </tr>
      </table>`
    : "";

  const chartImageHtml = imageSrc
    ? `<img src="${escapeHtml(imageSrc)}"
            width="520"
            height="${chartModel.chartHeightPx}"
            alt="${escapeWeeklyReportText(chartModel.chartAlt, 120)}"
            style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #e5e7eb;border-radius:12px;background:#ffffff;" />`
    : `<div style="padding:34px 20px;text-align:center;color:#64748b;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:12px;font-size:13px;line-height:1.5;">
         Chart preview is unavailable in this email.<br />Use the dashboard link for the full KPI trend view.
       </div>`;

  return `
    <table border="0" cellpadding="0" cellspacing="0" width="100%"
           style="margin:22px 0 0;background:#ffffff;border:1px solid #d9e5f1;border-radius:16px;font-family:Arial,sans-serif;">
      <tr>
        <td style="padding:26px 26px 24px;">
          <div style="font-size:18px;font-weight:700;color:#111827;line-height:1.3;margin:0 0 4px;">
            ${escapeWeeklyReportText(chartModel.title, 120)}
          </div>
          ${chartModel.subtitle ? `<div style="font-size:14px;color:#475569;line-height:1.4;margin:0 0 4px;">${escapeWeeklyReportText(chartModel.subtitle, 160)}</div>` : ""}
          <div style="font-size:12px;color:#64748b;line-height:1.4;">
            Unit: ${escapeWeeklyReportText(chartModel.unit || "-", 20)} | Frequency: ${escapeWeeklyReportText(chartModel.frequency || "Monthly", 40)}
          </div>

          <table border="0" cellpadding="0" cellspacing="0" width="100%"
                 style="margin:18px 0 0;background:#ffffff;border:1px solid #dbe4ef;border-radius:12px;">
            <tr>
              <td align="center" width="33.33%" style="padding:16px 8px;">
                <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Current</div>
                <div style="font-size:22px;font-weight:700;color:${chartModel.currentColor};line-height:1.2;">${escapeWeeklyReportText(chartModel.currentValue, 40)}</div>
                ${chartModel.currentWeekLabel ? `<div style="font-size:10px;color:#94a3b8;margin-top:4px;">${escapeWeeklyReportText(chartModel.currentWeekLabel, 40)}</div>` : ""}
              </td>
              <td align="center" width="33.33%" style="padding:16px 8px;border-left:1px solid #eef2f7;border-right:1px solid #eef2f7;">
                <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Direction</div>
                <div style="font-size:34px;font-weight:700;color:${chartModel.directionColor};line-height:1;">${escapeWeeklyReportText(chartModel.directionArrow, 4)}</div>
              </td>
              <td align="center" width="33.33%" style="padding:16px 8px;">
                <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Average</div>
                <div style="font-size:22px;font-weight:700;color:#0f6cbd;line-height:1.2;">${escapeWeeklyReportText(chartModel.averageValue || "N/A", 40)}</div>
                <div style="font-size:10px;color:#94a3b8;margin-top:4px;">${escapeWeeklyReportText(chartModel.periodsLabel, 40)}</div>
              </td>
            </tr>
          </table>

          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">
            <tr>
              <td valign="top" width="58%" style="padding-right:16px;">
                ${chartImageHtml}
              </td>
              <td valign="top" width="42%">
                <div style="font-size:12px;font-weight:700;color:#111827;line-height:1.3;margin-bottom:10px;">
                  Corrective Actions
                </div>
                ${correctiveActionsPanelHtml}
              </td>
            </tr>
          </table>

          ${thresholdCardsHtml}
          ${commentsHtml}
        </td>
      </tr>
    </table>`;
};

// ============================================================
// generateVerticalBarChart â€” DOTS + HIGH/LOW LIMIT LINES
// ============================================================
const generateVerticalBarChart = (chartData, options = {}) => {
  return renderWeeklyReportChartCard(
    chartData?.chartUrl ? chartData : buildWeeklyReportChartModel(chartData),
    options
  );

  const {
    title, subtitle, unit, data, weekLabels, currentWeek,
    stats, target, low_limit, high_limit,
    direction,
    tolerance_type, up_tolerance, low_tolerance,
    frequency, definition, comments = [],
    correctiveActions = []
  } = chartData;

  const cleanHigh = (high_limit && high_limit !== 'None' && high_limit !== '' && !isNaN(parseFloat(high_limit)))
    ? parseFloat(high_limit) : null;
  const cleanLow = (low_limit && low_limit !== 'None' && low_limit !== '' && !isNaN(parseFloat(low_limit)))
    ? parseFloat(low_limit) : null;
  const cleanTarget = (target && target !== 'None' && target !== '' && !isNaN(parseFloat(target)))
    ? parseFloat(target) : null;
  const thresholdLineValues = getReadableThresholdLineValues(cleanLow, cleanTarget, cleanHigh);
  const displayHigh = thresholdLineValues.displayHigh;
  const displayLow = thresholdLineValues.displayLow;
  const displayTarget = thresholdLineValues.displayTarget;

  if (!data || data.length === 0 || data.every(v => v <= 0)) {
    return `<table border="0" cellpadding="20" cellspacing="0" width="100%"
              style="margin:20px 0;background:white;border-radius:8px;border:1px solid #e0e0e0;">
      <tr><td>
        <h3 style="margin:0;color:#333;font-size:16px;">${title}</h3>
        ${subtitle ? `<p style="margin:5px 0 0;color:#666;font-size:14px;">${subtitle}</p>` : ''}
        <p style="margin:15px 0;color:#999;font-size:14px;">No data available</p>
      </td></tr></table>`;
  }

  const validData = data.filter(v => v > 0 && !isNaN(v));
  const values = data.slice(0, 12);
  const axisRange = getAutoChartAxisRange(values, displayLow, displayTarget, displayHigh);

  const labels =
    (weekLabels || data.map((_, i) => `W${i + 1}`))
      .slice(0, 12);

  const fmt = (num) => {
    if (num === null || num === undefined || isNaN(num)) return '0';
    const w = Math.abs(num - Math.round(num)) < 0.0001;
    if (num >= 1e6) return (num / 1e6).toFixed(w ? 0 : 1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(w ? 0 : 1) + 'k';
    if (w) return Math.round(num).toString();
    if (num < 1) return num.toFixed(2);
    return num.toFixed(1);
  };

  const resolvedDirection = normalizeKpiDirection(direction) || 'up';
  const directionMeta = getKpiGoodDirectionMeta(resolvedDirection);
  const pointColors = values.map(v => getDotColor(v, cleanLow, cleanHigh, resolvedDirection));

  const allVals = [...validData];
  if (displayHigh !== null) allVals.push(displayHigh);
  if (displayLow !== null) allVals.push(displayLow);
  if (displayTarget !== null) allVals.push(displayTarget);

  const thresholdValues = [cleanLow, cleanTarget, cleanHigh]
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const tightThresholdCluster = thresholdLineValues.hasTightCluster;
  const chartHeightPx = tightThresholdCluster ? 320 : 260;

  const dataMax = Math.max(...allVals, 1);
  const rawInt = dataMax / 10;
  const mag = Math.pow(10, Math.floor(Math.log10(rawInt || 1)));
  const norm = rawInt / mag;
  let interval;
  if (norm <= 1) interval = 1 * mag;
  else if (norm <= 2) interval = 2 * mag;
  else if (norm <= 2.5) interval = 2.5 * mag;
  else if (norm <= 5) interval = 5 * mag;
  else interval = 10 * mag;

  const maxValue = Math.ceil(dataMax / interval) * interval + interval;
  const numSteps = Math.round(maxValue / interval);
  const chartHeight = 180;
  const segmentHeight = chartHeight / numSteps;

  const yAxis = () => {
    let h = '';
    for (let i = numSteps; i >= 0; i--) {
      const val = i * interval;
      let ind = '';
      if (cleanHigh !== null && Math.abs(val - cleanHigh) < interval / 2) ind += ' H';
      if (cleanLow !== null && Math.abs(val - cleanLow) < interval / 2) ind += ' L';
      h += `<tr><td height="${segmentHeight}" valign="top" align="right"
              style="font-size:10px;color:#666;padding-right:8px;white-space:nowrap;">
              ${fmt(val)}${ind}</td></tr>`;
    }
    return h;
  };

  const currentValue = data[data.length - 1] || 0;
  const directionGuideHtml = `
    <table border="0" cellpadding="0" cellspacing="0" width="100%"
           style="margin:0 0 18px;background:${directionMeta.background};
                  border:1px solid ${directionMeta.border};border-radius:12px;">
      <tr>
        <td style="padding:14px 16px;">
          <div style="font-size:11px;font-weight:700;color:${directionMeta.accent};
                      text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;">
            Good Direction
          </div>
          <div style="font-size:15px;font-weight:700;color:#1f2937;margin-bottom:4px;">
            <span style="color:${directionMeta.accent};margin-right:6px;">${directionMeta.icon}</span>
            ${directionMeta.label} = ${directionMeta.summary}
          </div>
     
        </td>
      </tr>
    </table>
  `;

  // STATS BOX - 3 columns (CURRENT, AVERAGE, TREND)
  // Replace the statsBox const with this:
  const currentStatus = getKpiStatus(currentValue, cleanLow, cleanHigh, resolvedDirection);
  const trendIcon = currentStatus.isGood === false
    ? {
      icon: resolvedDirection === 'down' ? '&uarr;' : '&darr;',
      color: '#dc2626'
    }
    : {
      icon: resolvedDirection === 'down' ? '&darr;' : '&uarr;',
      color: '#28a745'
    };

  const statsBox = `
  <table border="0" cellpadding="0" cellspacing="0" width="100%"
         style="background:white;border-radius:12px;border:1px solid #e0e0e0;margin-bottom:20px;">
    <tr>
      <td style="padding:20px;">
        <table border="0" cellpadding="0" cellspacing="0" align="center"
               style="margin:0 auto;text-align:center;">
          <tr>

            <!-- CURRENT -->
            <td valign="middle" style="padding-right:30px;text-align:center;">
              <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:5px;">CURRENT</div>
              <div style="font-size:32px;font-weight:700;color:${getDotColor(currentValue, cleanLow, cleanHigh, resolvedDirection)};line-height:36px;">
                ${stats.current}
              </div>
              ${currentWeek ? `
                <div style="font-size:11px;color:#999;margin-top:2px;">
                  ${String(currentWeek).replace('2026-Week', 'Week ')}
                </div>` : ''}
            </td>

            <!-- TREND ICON â€” same row, between CURRENT and AVERAGE -->
            <td valign="middle" style="padding:0 30px;text-align:center;">
             <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:5px;">Direction</div>
              <div style="font-size:40px;font-weight:900;color:${trendIcon.color};line-height:1;">
                ${trendIcon.icon}
              </div>
           
            </td>

            <!-- AVERAGE -->
            <td valign="middle" style="padding-left:30px;text-align:center;">
              <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:5px;">AVERAGE</div>
              <div style="font-size:32px;font-weight:700;color:#0078D7;line-height:36px;">
                ${stats.average}
              </div>
              <div style="font-size:11px;color:#999;margin-top:2px;">
                ${stats.dataPoints || data.length} periods
              </div>
            </td>

          </tr>
        </table>
      </td>
    </tr>
  </table>
`;
  // QuickChart datasets
  const datasets = [
    {
      label: subtitle || title,
      data: values,
      borderColor: '#94a3b8',
      borderWidth: 2,
      lineTension: 0,
      fill: false,
      pointBackgroundColor: pointColors,
      pointBorderColor: '#ffffff',
      pointBorderWidth: 2,
      pointRadius: 6
    }
  ];

  if (cleanHigh !== null) {
    datasets.push({
      label: `High Limit (${fmt(cleanHigh)})`,
      data: new Array(values.length).fill(displayHigh),
      borderColor: '#ff9800',
      borderWidth: 3,
      borderDash: [12, 5],
      pointRadius: 0,
      fill: false
    });
  }

  if (cleanLow !== null) {
    datasets.push({
      label: `Low Limit (${fmt(cleanLow)})`,
      data: new Array(values.length).fill(displayLow),
      borderColor: '#dc3545',
      borderWidth: 3,
      borderDash: [2, 6],
      pointRadius: 0,
      fill: false
    });
  }

  if (cleanTarget !== null) {
    datasets.push({
      label: `Target (${fmt(cleanTarget)})`,
      data: new Array(values.length).fill(displayTarget),
      borderColor: '#16a34a',
      borderWidth: 3.5,
      borderDash: [],
      pointRadius: 0,
      fill: false
    });
  }

  const chartConfig = {
    type: 'line',
    data: { labels, datasets },
    options: {
      legend: { display: false },
      layout: {
        padding: {
          top: tightThresholdCluster ? 12 : 6,
          right: 12,
          bottom: 4,
          left: 4
        }
      },
      scales: {
        xAxes: [{
          ticks: { fontSize: 10 },
          gridLines: { color: 'rgba(0,0,0,0.05)' }
        }],
        yAxes: [{
          ticks: {
            fontSize: 10,
            beginAtZero: false,
            min: axisRange.min,
            max: axisRange.max
          },
          gridLines: { color: 'rgba(0,0,0,0.05)' }
        }]
      }
    }
  };

  const chartUrl =
    `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}` +
    `&w=500&h=${chartHeightPx}&bkg=white`;

  const commentsHtml = comments.length > 0 ? `
    <div style="margin-bottom:20px;">
      <h4 style="margin:0 0 15px;color:#333;font-size:16px;">Comments</h4>
      ${comments.map(c => `
        <div style="margin-bottom:12px;padding:12px;background:#e3f2fd;border-radius:8px;border-left:4px solid #0078D7;">
          <div style="font-size:11px;font-weight:600;color:#0078D7;margin-bottom:6px;">
           ${getCeoReportGenerationService().weekToMonthLabel(c.week || '') || (c.week || '').replace('2026-Week', 'Week ')}
          </div>
          <div style="font-size:13px;color:#2c3e50;">${c.text}</div>
        </div>
      `).join('')}
    </div>` : '';

  const formatCorrectiveActionDate = (value) => {
    if (!value) return '';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? String(value)
      : parsed.toLocaleDateString('en-GB');
  };

  const correctiveActionsHtml = correctiveActions.length > 0 ? `
    <div style="margin-bottom:20px;">
      <h4 style="margin:0 0 15px;color:#333;font-size:16px;">Corrective Actions</h4>
      ${correctiveActions.map(ca => `
       <div style="margin-bottom:18px;padding:18px 20px;background:#fff3f3;border-radius:8px;border-left:4px solid #dc3545;line-height:1.55;">
       <div style="font-size:12px;font-weight:600;color:#495057;margin-bottom:8px;">
         ${ca.week ? getCeoReportGenerationService().weekToMonthLabel(ca.week) : 'N/A'}
         ${ca.status ? `<span style="margin-left:10px;font-size:11px;color:#dc3545;">${ca.status}</span>` : ''}
          </div>
          ${ca.root_cause ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:11px;font-weight:700;color:#dc3545;">Root Cause</div>
              <div style="font-size:13px;color:#374151;margin-top:4px;line-height:1.5;">${ca.root_cause}</div>
            </div>
          ` : ''}
          ${ca.implemented_solution ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:11px;font-weight:700;color:#d97706;">Implemented Solution</div>
              <div style="font-size:12px;color:#374151;">${ca.implemented_solution}</div>
            </div>
          ` : ''}
          ${ca.due_date ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:11px;font-weight:700;color:#2563eb;">Due Date</div>
              <div style="font-size:12px;color:#374151;">${formatCorrectiveActionDate(ca.due_date)}</div>
            </div>
          ` : ''}
          ${ca.responsible ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:11px;font-weight:700;color:#475569;">Responsible</div>
              <div style="font-size:12px;color:#374151;">${ca.responsible}</div>
            </div>
          ` : ''}
          ${ca.evidence ? `
            <div style="margin-bottom:14px;">
              <div style="font-size:11px;font-weight:700;color:#059669;">Evidence</div>
              <div style="font-size:12px;color:#374151;">${ca.evidence}</div>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  ` : '';

  // EMAIL-SAFE LIMITS (High + Low side-by-side using table)
  const limitsRowHtml = (() => {
    const highBox = cleanHigh !== null ? `
    <table border="0" cellpadding="0" cellspacing="0" width="100%"
           style="background:white;border-radius:12px;border:1px solid #e0e0e0;text-align:center;">
      <tr><td style="padding:15px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:5px;">HIGH LIMIT</div>
        <div style="font-size:28px;font-weight:700;color:#ff9800;">${fmt(cleanHigh)}</div>
        <div style="font-size:11px;color:#999;">${unit || ''}</div>
      </td></tr>
    </table>
  ` : '';

    const targetBox = cleanTarget !== null ? `
    <table border="0" cellpadding="0" cellspacing="0" width="100%"
           style="background:white;border-radius:12px;border:1px solid #e0e0e0;text-align:center;">
      <tr><td style="padding:15px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:5px;">TARGET</div>
        <div style="font-size:28px;font-weight:700;color:#16a34a;">${fmt(cleanTarget)}</div>
        <div style="font-size:11px;color:#999;">${unit || ''}</div>
      </td></tr>
    </table>
  ` : '';

    const lowBox = cleanLow !== null ? `
    <table border="0" cellpadding="0" cellspacing="0" width="100%"
           style="background:white;border-radius:12px;border:1px solid #e0e0e0;text-align:center;">
      <tr><td style="padding:15px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:5px;">LOW LIMIT</div>
        <div style="font-size:28px;font-weight:700;color:#dc3545;">${fmt(cleanLow)}</div>
        <div style="font-size:11px;color:#999;">${unit || ''}</div>
      </td></tr>
    </table>
  ` : '';

    const boxes = [];
    if (highBox) boxes.push(highBox);
    if (targetBox) boxes.push(targetBox);
    if (lowBox) boxes.push(lowBox);

    if (boxes.length === 0) {
      return `
      <div style="margin-top:20px;background:#f8f9fa;border-radius:12px;padding:30px;
                  text-align:center;border:1px dashed #e0e0e0;">
        <p style="margin:0;color:#999;font-size:13px;">No limits defined</p>
      </div>
    `;
    }

    const colWidth = Math.floor(100 / boxes.length);

    return `
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:20px;">
      <tr>
        ${boxes.map((box, i) => `
          <td width="${colWidth}%" valign="top"
              style="${i !== boxes.length - 1 ? 'padding-right:8px;' : ''}">
            ${box}
          </td>
        `).join('')}
      </tr>
    </table>
  `;
  })();

  const thresholdFocusHtml = tightThresholdCluster ? `
    <div style="margin:0 0 16px;padding:12px 14px;background:#f8fbff;border:1px solid #dbeafe;
                border-radius:12px;">
      <div style="font-size:11px;font-weight:700;color:#0f6cbd;text-transform:uppercase;
                  letter-spacing:0.08em;margin-bottom:6px;">Threshold Focus</div>
      <div style="font-size:13px;color:#475569;line-height:1.5;">
        High limit, target, and low limit are tightly grouped between
        <strong>${fmt(thresholdValues[0])}</strong> and
        <strong>${fmt(thresholdValues[thresholdValues.length - 1])}</strong>${unit ? ` ${unit}` : ''}.
        The chart lines are slightly spaced for readability, and the exact values are shown below.
      </div>
    </div>
  ` : '';

  const preChartLimitsHtml = tightThresholdCluster ? limitsRowHtml : '';
  const postChartLimitsHtml = tightThresholdCluster ? '' : limitsRowHtml;

  return `
    <table border="0" cellpadding="0" cellspacing="0" width="100%"
           style="margin:20px 0;background:white;border-radius:12px;
                  border:1px solid #e0e0e0;font-family:Arial,sans-serif;">
      <tr><td style="padding:20px;">
        <div style="margin-bottom:20px;">
          <h3 style="margin:0;color:#333;font-size:18px;font-weight:600;">${title}</h3>
          ${subtitle ? `<p style="margin:5px 0 0;color:#666;font-size:14px;">${subtitle}</p>` : ''}
          ${unit ? `<p style="margin:5px 0 0;color:#888;font-size:12px;">Unit: ${unit} | Frequency: ${frequency || 'Monthly'}</p>` : ''}
        </div>

      
        ${statsBox}
        ${thresholdFocusHtml}

        <table border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td width="60%" valign="top" style="padding-right:20px;">
              ${preChartLimitsHtml}
              <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td valign="top" style="padding-left:5px;">
                    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="text-align:center;">
                      <tr>
                        <td align="center">
                          <img src="${chartUrl}"
                               width="500"
                               height="${chartHeightPx}"
                               alt="KPI Trend Chart"
                             style="max-width:100%;
                             border-radius:8px;
                             border:1px solid #f0f0f0;
                             display:block;
                             margin:auto;" />
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!--High/Low limits beside each other -->
              ${postChartLimitsHtml}
            </td>

            <td width="40%" valign="top" style="padding-left:20px;border-left:2px solid #f0f0f0;">
              ${correctiveActionsHtml}
              ${commentsHtml}

              ${comments.length === 0 && correctiveActions.length === 0 ? `
                <div style="background:#f8f9fa;border-radius:12px;padding:30px;
                            text-align:center;border:1px dashed #e0e0e0;">
                  <p style="margin:0;color:#999;font-size:13px;">No additional data</p>
                </div>` : ''}
            </td>
          </tr>
        </table>
      </td></tr>
    </table>`;
};
// ============================================================
// generateWeeklyReportData
// ============================================================
// ============================================================
// generateWeeklyReportData (updated to include corrective actions)
// ============================================================
const generateWeeklyReportData = async (responsibleId, reportWeek) => {
  try {
    const responsibleContext = await loadFormResponsibleContext(responsibleId);
    const responsiblePeopleId = normalizeOptionalIntegerInput(
      responsibleContext?.people_id ?? responsibleId
    );

    if (!responsiblePeopleId) {
      return null;
    }

    const currentPeriodRes = await pool.query(
      `
      WITH responsible_allocations AS (
        SELECT
          kta.kpi_target_allocation_id,
          kta.kpi_id
        FROM public.kpi_target_allocation kta
        WHERE kta.set_by_people_id = $1
      ),
      latest_period_values AS (
        SELECT
          ra.kpi_target_allocation_id,
          ra.kpi_id,
          COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')) AS week,
          kr.raw_value AS new_value,
          kr.recorded_at AS updated_at,
          kr.comments AS comment,
          kr.unit AS result_unit,
          kr.target_value AS result_target_value,
          kr.upper_limit AS result_high_limit,
          kr.lower_limit AS result_low_limit,
          ROW_NUMBER() OVER (
            PARTITION BY ra.kpi_target_allocation_id
            ORDER BY kr.recorded_at DESC, kr.kpi_result_id DESC
          ) AS rn
        FROM responsible_allocations ra
        JOIN public.kpi_result kr
          ON kr.kpi_target_allocation_id = ra.kpi_target_allocation_id
        WHERE ($2::text IS NULL OR kr.period_label = $2 OR kr.week = $2)
          AND kr.raw_value IS NOT NULL
          AND TRIM(CAST(kr.raw_value AS TEXT)) <> ''
      )
      SELECT
        lpv.kpi_target_allocation_id,
        lpv.kpi_id,
        lpv.week,
        lpv.new_value,
        lpv.updated_at,
        lpv.comment,
        COALESCE(subject_link.subject_name, k.kpi_sub_title, k.kpi_name, 'KPI') AS subject,
        COALESCE(k.kpi_sub_title, subject_link.subject_name, k.kpi_name, 'KPI') AS indicator_title,
        COALESCE(k.kpi_name, k.kpi_sub_title, 'Untitled KPI') AS indicator_sub_title,
        COALESCE(lpv.result_unit, kta.target_unit, k.unit) AS unit,
        COALESCE(lpv.result_target_value, kta.target_value, k.target_value) AS target,
        k.min_value AS min,
        k.max_value AS max,
        COALESCE(lpv.result_high_limit, k.high_limit) AS high_limit,
        COALESCE(lpv.result_low_limit, k.low_limit) AS low_limit,
        k.tolerance_type,
        k.up_tolerance,
        k.low_tolerance,
        k.frequency,
        k.kpi_explanation AS definition,
        k.target_direction
      FROM latest_period_values lpv
      JOIN public.kpi_target_allocation kta
        ON kta.kpi_target_allocation_id = lpv.kpi_target_allocation_id
      JOIN public.kpi k
        ON k.kpi_id = lpv.kpi_id
      LEFT JOIN LATERAL (
        SELECT s.subject_name
        FROM public.subject_kpi sk
        JOIN public.subject s
          ON s.subject_id = sk.subject_id
        WHERE sk.kpi_id = lpv.kpi_id
        ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
        LIMIT 1
      ) subject_link ON TRUE
      WHERE lpv.rn = 1
      ORDER BY indicator_title ASC, indicator_sub_title ASC, lpv.kpi_target_allocation_id ASC
      `,
      [responsiblePeopleId, normalizeOptionalTextInput(reportWeek)]
    );

    if (!currentPeriodRes.rows.length) {
      return null;
    }

    const {
      currentByAllocationId,
      historyByAllocationId
    } = await getActionPlanService().loadActionPlanCorrectiveActionMaps(currentPeriodRes.rows, reportWeek);

    const historyRes = await pool.query(
      `
      WITH responsible_allocations AS (
        SELECT
          kta.kpi_target_allocation_id,
          kta.kpi_id
        FROM public.kpi_target_allocation kta
        WHERE kta.set_by_people_id = $1
      )
      SELECT DISTINCT ON (
        ra.kpi_target_allocation_id,
        COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD'))
      )
        ra.kpi_target_allocation_id,
        ra.kpi_id,
        COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')) AS week,
        kr.raw_value AS new_value,
        kr.recorded_at AS updated_at,
        kr.comments AS comment
      FROM responsible_allocations ra
      JOIN public.kpi_result kr
        ON kr.kpi_target_allocation_id = ra.kpi_target_allocation_id
      WHERE kr.raw_value IS NOT NULL
        AND TRIM(CAST(kr.raw_value AS TEXT)) <> ''
      ORDER BY
        ra.kpi_target_allocation_id,
        COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')),
        kr.recorded_at DESC,
        kr.kpi_result_id DESC
      `,
      [responsiblePeopleId]
    );

    const historyByAllocation = {};
    historyRes.rows.forEach((row) => {
      const allocationKey = String(row.kpi_target_allocation_id || row.kpi_id || "").trim();
      if (!allocationKey) return;
      if (!historyByAllocation[allocationKey]) {
        historyByAllocation[allocationKey] = [];
      }
      historyByAllocation[allocationKey].push(row);
    });

    const charts = [];

    currentPeriodRes.rows.forEach((row) => {
      const allocationKey = String(row.kpi_target_allocation_id || row.kpi_id || "").trim();
      const historyRows = historyByAllocation[allocationKey] || [];
      const monthMap = {};
      const comments = [];

      historyRows.forEach((historyRow) => {
        const numericValue = Number(historyRow.new_value);
        if (Number.isFinite(numericValue) && numericValue > 0) {
          const monthLabel = getCeoReportGenerationService().weekToMonthLabel(historyRow.week);
          if (!monthMap[monthLabel]) {
            monthMap[monthLabel] = { sum: 0, count: 0 };
          }
          monthMap[monthLabel].sum += numericValue;
          monthMap[monthLabel].count += 1;
        }

        const commentText = normalizeOptionalTextInput(historyRow.comment);
        if (commentText) {
          comments.push({
            week: historyRow.week,
            text: commentText,
            date: historyRow.updated_at
          });
        }
      });

      const weekLabels = Object.keys(monthMap).sort((left, right) => new Date(left) - new Date(right));
      const dataPoints = weekLabels.map((label) => monthMap[label].sum / monthMap[label].count);
      if (!dataPoints.some((value) => value > 0)) {
        return;
      }

      let currentWeek = null;
      let currentValue = 0;
      let previousValue = 0;
      for (let index = weekLabels.length - 1; index >= 0; index -= 1) {
        if (dataPoints[index] > 0) {
          currentWeek = weekLabels[index];
          currentValue = dataPoints[index];
          for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
            if (dataPoints[previousIndex] > 0) {
              previousValue = dataPoints[previousIndex];
              break;
            }
          }
          break;
        }
      }

      if (!currentWeek) {
        return;
      }

      const nonZeroDataPoints = dataPoints.filter((value) => value > 0);
      const averageValue = nonZeroDataPoints.reduce((sum, value) => sum + value, 0) / nonZeroDataPoints.length;
      let trend = "0.0%";
      if (previousValue > 0 && currentValue > 0) {
        const trendValue = ((currentValue - previousValue) / previousValue) * 100;
        trend = `${trendValue >= 0 ? "+" : ""}${trendValue.toFixed(1)}%`;
      }

      const currentActions = currentByAllocationId[allocationKey] || [];
      const historyActions = historyByAllocationId[allocationKey] || [];
      const meaningfulCorrectiveActions = [];
      const seenCorrectiveActions = new Set();

      const isMeaningfulManagerReportCorrectiveAction = getCeoReportGenerationService().hasMeaningfulManagerReportCorrectiveAction;
      [
        ...sortCorrectiveActions(
          (Array.isArray(currentActions) ? currentActions : []).filter(isMeaningfulManagerReportCorrectiveAction)
        ),
        ...sortCorrectiveActions(
          (Array.isArray(historyActions) ? historyActions : []).filter(isMeaningfulManagerReportCorrectiveAction)
        )
      ].forEach((action) => {
        const actionKey = [
          normalizeOptionalIntegerInput(action.corrective_action_id ?? action.id) || "na",
          normalizeOptionalTextInput(action.period_label || action.week) || "na"
        ].join("|");

        if (seenCorrectiveActions.has(actionKey)) {
          return;
        }

        seenCorrectiveActions.add(actionKey);
        meaningfulCorrectiveActions.push({
          week: action.week || action.period_label || null,
          root_cause: normalizeOptionalTextInput(action.root_cause) || "",
          implemented_solution: normalizeOptionalTextInput(action.implemented_solution) || "",
          evidence: normalizeOptionalTextInput(action.evidence) || "",
          status: normalizeOptionalTextInput(action.status) || "Open",
          due_date: action.due_date || null,
          responsible: normalizeOptionalTextInput(action.responsible) || "",
          created_date: action.created_date,
          updated_date: action.updated_date
        });
      });

      charts.push({
        kpiId: row.kpi_id,
        title: row.subject,
        subtitle: row.indicator_sub_title,
        unit: row.unit || "",
        target: row.target,
        direction: inferKpiDirection(row),
        min: row.min,
        max: row.max,
        low_limit: row.low_limit,
        high_limit: row.high_limit,
        tolerance_type: row.tolerance_type,
        up_tolerance: row.up_tolerance,
        low_tolerance: row.low_tolerance,
        frequency: row.frequency,
        definition: row.definition,
        data: dataPoints,
        weekLabels,
        fullWeeks: weekLabels,
        currentWeek,
        comments: comments.sort((left, right) => new Date(right.date) - new Date(left.date)),
        correctiveActions: meaningfulCorrectiveActions,
        stats: {
          current: currentValue.toFixed(row.unit === "%" ? 1 : 2),
          previous: previousValue > 0 ? previousValue.toFixed(row.unit === "%" ? 1 : 2) : "N/A",
          average: averageValue.toFixed(row.unit === "%" ? 1 : 2),
          trend,
          dataPoints: nonZeroDataPoints.length,
          totalWeeks: weekLabels.length
        }
      });
    });

    console.log(`Generated ${charts.length} KPI charts for responsible ${responsiblePeopleId}`);
    return charts;
  } catch (error) {
    console.error("Error generating weekly report data:", error);
    return null;
  }
};


module.exports = {
  ensureKpiSubmissionEmailDispatchLogSchema,
  sendKPIEmail,
  loadKpiSubmissionEmailRecipients,
  getCanonicalKpiCalculationMode,
  getCanonicalKpiSubmissionFrequency,
  formatKpiSubmissionPeriodLabel,
  getKpiSubmissionTargetPeriodLabel,
  isKpiSubmissionFrequencyDue,
  resolveKpiSubmissionRecipientTimeZone,
  hasReachedKpiSubmissionLocalSendWindow,
  hasKpiSubmissionEmailBeenSentForLocalDate,
  recordKpiSubmissionEmailDispatch,
  loadWeeklyReportRecipientsForWeek,
  buildWeeklyReportChartModel,
  fetchWeeklyReportInlineChartAttachment,
  generateVerticalBarChart,
  generateWeeklyReportData,
  DEFAULT_KPI_SUBMISSION_TIMEZONE,
  WEEKLY_REPORT_MAX_CHARTS,
  truncateWeeklyReportText,
  escapeWeeklyReportText,
  formatWeeklyReportWeekLabel,
};
