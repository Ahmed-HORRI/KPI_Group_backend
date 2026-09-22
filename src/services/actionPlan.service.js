const { pool, actionPlanPool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const {
  normalizeText,
  normalizeCorrectiveActionStatus,
  normalizeCorrectiveActionImportance,
  normalizeCorrectiveActionUrgency,
  normalizeCorrectiveActionEstimatedDurationDays,
  OPEN_CORRECTIVE_ACTION_STATUS,
  CLOSED_CORRECTIVE_ACTION_STATUS,
  escapeHtml,
  sortCorrectiveActions,
  getLatestCorrectiveAction,
} = require("./kpiShared.service");
const {
  formatIsoDateValue,
  formatDateOnlyValue,
  normalizeOptionalDateInput,
} = require("../utils/weekPeriod");
const { loadFormResponsibleContext } = require("../models/responsible.model");
const {
  getCanonicalKpiSubmissionFrequency,
  getCanonicalKpiCalculationMode,
  formatKpiSubmissionPeriodLabel,
} = require("./kpiSubmissionEmail.service");

const optionalTableAvailabilityCache = new Map();

const hasPublicTable = async (tableName) => {
  const normalizedName = normalizeOptionalTextInput(tableName);
  if (!normalizedName) return false;

  if (optionalTableAvailabilityCache.has(normalizedName)) {
    return optionalTableAvailabilityCache.get(normalizedName);
  }

  const result = await pool.query(
    `SELECT to_regclass($1) AS regclass`,
    [`public.${normalizedName}`]
  );

  const exists = Boolean(result.rows[0]?.regclass);
  optionalTableAvailabilityCache.set(normalizedName, exists);
  return exists;
};

const actionPlanTableAvailabilityCache = new Map();
const ACTION_PLAN_SUBJECT_CODE_PREFIX = "kpi-form";
const ACTION_PLAN_SUBJECT_LINK_KEY_PREFIX = "Link key:";

const hasActionPlanTable = async (tableName) => {
  const normalizedName = normalizeOptionalTextInput(tableName);
  if (!normalizedName) return false;

  if (actionPlanTableAvailabilityCache.has(normalizedName)) {
    return actionPlanTableAvailabilityCache.get(normalizedName);
  }

  try {
    const result = await actionPlanPool.query(
      `SELECT to_regclass($1) AS regclass`,
      [`public.${normalizedName}`]
    );

    const exists = Boolean(result.rows[0]?.regclass);
    actionPlanTableAvailabilityCache.set(normalizedName, exists);
    return exists;
  } catch (error) {
    console.error("Action Plan table availability check failed:", error.message);
    actionPlanTableAvailabilityCache.set(normalizedName, false);
    return false;
  }
};

const canUseActionPlanCorrectiveActions = async () => {
  const [hasActionTable, hasSujetTable] = await Promise.all([
    hasActionPlanTable("action"),
    hasActionPlanTable("sujet")
  ]);

  return hasActionTable && hasSujetTable;
};

const updateActionPlanCorrectiveActionStatus = async (correctiveActionId, nextStatus) => {
  const actionId = normalizeOptionalIntegerInput(correctiveActionId);
  if (!actionId) return null;

  const result = await actionPlanPool.query(
    `
    UPDATE public.action
    SET
      status = $2,
      updated_at = NOW(),
      closed_date = CASE
        WHEN LOWER($2::text) = 'closed' THEN COALESCE(closed_date, CURRENT_DATE)
        ELSE NULL
      END
    WHERE id = $1
    RETURNING id, status
    `,
    [actionId, nextStatus]
  );

  if (!result.rows.length) {
    return null;
  }

  return {
    corrective_action_id: result.rows[0].id,
    status:
      normalizeCorrectiveActionStatus(result.rows[0].status, nextStatus) ||
      nextStatus
  };
};


let actionPlanCorrectiveActionSchemaPromise = null;

const ensureActionPlanCorrectiveActionSchema = async () => {
  if (!actionPlanCorrectiveActionSchemaPromise) {
    actionPlanCorrectiveActionSchemaPromise = (async () => {
      if (!(await canUseActionPlanCorrectiveActions())) {
        return false;
      }

      await actionPlanPool.query(`
        ALTER TABLE public.action
        ADD COLUMN IF NOT EXISTS estimated_duration_days INTEGER
      `);

      await actionPlanPool.query(`
        ALTER TABLE public.action
        ADD COLUMN IF NOT EXISTS importance VARCHAR(50)
      `);

      await actionPlanPool.query(`
        ALTER TABLE public.action
        ADD COLUMN IF NOT EXISTS urgency VARCHAR(50)
      `);

      await actionPlanPool.query(`
        ALTER TABLE public.action
        ADD COLUMN IF NOT EXISTS kpi_id VARCHAR
      `);

      await actionPlanPool.query(`
        ALTER TABLE public.action
        ADD COLUMN IF NOT EXISTS kpi_target_allocation_id VARCHAR
      `);

      await actionPlanPool.query(`
        ALTER TABLE public.action
        ADD COLUMN IF NOT EXISTS period_label VARCHAR
      `);

      await actionPlanPool.query(`
       ALTER TABLE public.action
       ADD COLUMN IF NOT EXISTS unit_id VARCHAR
       `);

       await actionPlanPool.query(`
        ALTER TABLE public.action
        ADD COLUMN IF NOT EXISTS unit_id VARCHAR
      `);

      await actionPlanPool.query(`
        UPDATE public.action AS a
        SET kpi_id = parsed.kpi_id
        FROM (
          SELECT
            s.id AS sujet_id,
            NULLIF(
              split_part(
                COALESCE(
                  NULLIF(BTRIM(COALESCE(s.code, '')), ''),
                  substring(COALESCE(s.description, '') from 'Link key:\\s*([^\\s]+)')
                ),
                '|',
                3
              ),
              ''
            ) AS kpi_id
          FROM public.sujet s
        ) AS parsed
        WHERE a.sujet_id = parsed.sujet_id
          AND COALESCE(BTRIM(COALESCE(a.kpi_id, '')), '') = ''
          AND parsed.kpi_id IS NOT NULL
      `);

      await actionPlanPool.query(`
        UPDATE public.action AS a
        SET kpi_target_allocation_id = parsed.kpi_target_allocation_id
        FROM (
          SELECT
            action_row.id AS action_id,
            NULLIF(
              split_part(
                COALESCE(
                  NULLIF(BTRIM(COALESCE(s.code, '')), ''),
                  substring(COALESCE(s.description, '') from 'Link key:\\s*([^\\s]+)')
                ),
                '|',
                2
              ),
              ''
            ) AS kpi_target_allocation_id
          FROM public.action action_row
          JOIN public.sujet s
            ON s.id = action_row.sujet_id
        ) AS parsed
        WHERE a.id = parsed.action_id
          AND COALESCE(BTRIM(COALESCE(a.kpi_target_allocation_id, '')), '') = ''
          AND parsed.kpi_target_allocation_id IS NOT NULL
      `);

      return true;
    })().catch((error) => {
      actionPlanCorrectiveActionSchemaPromise = null;
      throw error;
    });
  }

  return actionPlanCorrectiveActionSchemaPromise;
};

const encodeActionPlanPeriodToken = (value) => {
  const normalizedValue = normalizeOptionalTextInput(value) || "period";
  return Buffer.from(normalizedValue, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const decodeActionPlanPeriodToken = (value) => {
  const token = normalizeOptionalTextInput(value);
  if (!token) return null;

  const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4 === 0
    ? ""
    : "=".repeat(4 - (base64.length % 4));

  try {
    const decoded = Buffer.from(base64 + padding, "base64").toString("utf8");
    return normalizeOptionalTextInput(decoded);
  } catch (error) {
    return null;
  }
};

const buildActionPlanSubjectCode = ({
  kpiTargetAllocationId,
  kpiId,
  periodLabel
}) => {
  const allocationId = normalizeOptionalIntegerInput(kpiTargetAllocationId);
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  const normalizedPeriodLabel =
    normalizeOptionalTextInput(periodLabel) ||
    formatIsoDateValue(new Date()) ||
    "period";

  if (!allocationId || !normalizedKpiId) return null;

  return [
    ACTION_PLAN_SUBJECT_CODE_PREFIX,
    allocationId,
    normalizedKpiId,
    encodeActionPlanPeriodToken(normalizedPeriodLabel)
  ].join("|");
};

const buildActionPlanSubjectPattern = ({
  kpiTargetAllocationId,
  kpiId
}) => {
  const allocationId = normalizeOptionalIntegerInput(kpiTargetAllocationId);
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  if (!allocationId || !normalizedKpiId) return null;
  return `${ACTION_PLAN_SUBJECT_CODE_PREFIX}|${allocationId}|${normalizedKpiId}|%`;
};

const buildActionPlanSubjectDescriptionSearchValue = (subjectCode) => {
  const normalizedSubjectCode = normalizeOptionalTextInput(subjectCode);
  if (!normalizedSubjectCode) return null;
  return `%${ACTION_PLAN_SUBJECT_LINK_KEY_PREFIX} ${normalizedSubjectCode}%`;
};

const buildActionPlanSubjectDescriptionPattern = ({
  kpiTargetAllocationId,
  kpiId
}) => {
  const subjectPattern = buildActionPlanSubjectPattern({
    kpiTargetAllocationId,
    kpiId
  });
  return buildActionPlanSubjectDescriptionSearchValue(subjectPattern);
};

const parseActionPlanSubjectCode = (value) => {
  const code = normalizeOptionalTextInput(value);
  if (!code) return null;

  const [prefix, rawAllocationId, rawKpiId, rawPeriodToken] = code.split("|");
  if (
    prefix !== ACTION_PLAN_SUBJECT_CODE_PREFIX ||
    rawAllocationId === undefined ||
    rawKpiId === undefined ||
    rawPeriodToken === undefined
  ) {
    return null;
  }

  const allocationId = normalizeOptionalIntegerInput(rawAllocationId);
  const kpiId = normalizeOptionalIntegerInput(rawKpiId);
  const periodLabel = decodeActionPlanPeriodToken(rawPeriodToken);

  if (!allocationId || !kpiId || !periodLabel) {
    return null;
  }

  return {
    kpiTargetAllocationId: allocationId,
    kpiId,
    periodLabel
  };
};

const extractActionPlanSubjectCodeFromDescription = (value) => {
  const text = normalizeOptionalTextInput(value);
  if (!text) return null;

  const match = text.match(/Link key:\s*([^\s]+)/i);
  return normalizeOptionalTextInput(match?.[1]);
};

const parseActionPlanSubjectReference = ({
  subjectCode = null,
  description = null
} = {}) => {
  return (
    parseActionPlanSubjectCode(subjectCode) ||
    parseActionPlanSubjectCode(extractActionPlanSubjectCodeFromDescription(description))
  );
};

const resolveActionPlanActionScope = (row = {}) => {
  const subjectInfo = parseActionPlanSubjectReference({
    subjectCode: row.sujet_code,
    description: row.sujet_description
  });

  return {
    subjectInfo,
    kpiTargetAllocationId:
      normalizeOptionalIntegerInput(row.kpi_target_allocation_id) ||
      normalizeOptionalIntegerInput(subjectInfo?.kpiTargetAllocationId) ||
      null,
    periodLabel:
      normalizeOptionalTextInput(row.period_label) ||
      normalizeOptionalTextInput(subjectInfo?.periodLabel) ||
      null
  };
};

const mapActionPlanActionRow = (row = {}) => {
  const { subjectInfo, kpiTargetAllocationId, periodLabel } = resolveActionPlanActionScope(row);
  const persistedKpiId =
    normalizeOptionalIntegerInput(row.kpi_id) ||
    normalizeOptionalIntegerInput(subjectInfo?.kpiId);
  if (!persistedKpiId) return null;
  const persistedUnitId = normalizeOptionalIntegerInput(row.unit_id);

  const status =
    normalizeCorrectiveActionStatus(row.status, OPEN_CORRECTIVE_ACTION_STATUS) ||
    OPEN_CORRECTIVE_ACTION_STATUS;

  return {
    id: row.id,
    corrective_action_id: row.id,
    kpi_values_id: kpiTargetAllocationId,
    kpi_target_allocation_id: kpiTargetAllocationId,
    kpi_id: persistedKpiId,
    unit_id: persistedUnitId,
    unitId: persistedUnitId,
    week: periodLabel,
    period_label: periodLabel,
    // In Action Plan DB, the action title stores the implemented solution
    // and the description stores the root cause narrative.
    root_cause: normalizeOptionalTextInput(row.description) || "",
    implemented_solution: normalizeOptionalTextInput(row.titre) || "",
    status,
    due_date: formatDateOnlyValue(row.due_date),
    estimated_duration_days: normalizeCorrectiveActionEstimatedDurationDays(row.estimated_duration_days),
    importance: normalizeCorrectiveActionImportance(row.importance),
    urgency: normalizeCorrectiveActionUrgency(row.urgency),
    responsible: normalizeOptionalTextInput(row.responsable) || "",
    email_responsable: normalizeOptionalTextInput(row.email_responsable),
    created_date: row.created_at,
    updated_date: row.updated_at,
    closed_date: row.closed_date,
    sujet_id: row.sujet_id,
    sujet_code: normalizeOptionalTextInput(row.sujet_code),
    sujet_title: normalizeOptionalTextInput(row.sujet_title)
  };
};


const loadActionPlanCorrectiveActionMaps = async (kpiRows = [], currentPeriodLabel = null) => {
  if (!(await canUseActionPlanCorrectiveActions())) {
    return {
      currentByAllocationId: {},
      historyByAllocationId: {}
    };
  }

  const allocationIds = Array.from(new Set(
    (Array.isArray(kpiRows) ? kpiRows : [])
      .map((row) => normalizeOptionalIntegerInput(
        row.kpi_target_allocation_id ?? row.kpi_values_id
      ))
      .filter((value) => Number.isInteger(value))
      .map((value) => String(value))
  ));
  const patterns = Array.from(new Set(
    (Array.isArray(kpiRows) ? kpiRows : [])
      .map((row) => buildActionPlanSubjectPattern({
        kpiTargetAllocationId: row.kpi_target_allocation_id ?? row.kpi_values_id,
        kpiId: row.kpi_id
      }))
      .filter(Boolean)
  ));
  const descriptionPatterns = Array.from(new Set(
    (Array.isArray(kpiRows) ? kpiRows : [])
      .map((row) => buildActionPlanSubjectDescriptionPattern({
        kpiTargetAllocationId: row.kpi_target_allocation_id ?? row.kpi_values_id,
        kpiId: row.kpi_id
      }))
      .filter(Boolean)
  ));

  if (!allocationIds.length && !patterns.length && !descriptionPatterns.length) {
    return {
      currentByAllocationId: {},
      historyByAllocationId: {}
    };
  }

  try {
    await ensureActionPlanCorrectiveActionSchema();

    const actionsRes = await actionPlanPool.query(
      `
      SELECT
        a.id,
        a.kpi_id,
        a.unit_id,
        a.kpi_target_allocation_id,
        a.period_label,
        a.sujet_id,
        a.type,
        a.titre,
        a.description,
        a.status,
        a.responsable,
        a.email_responsable,
        a.due_date,
        a.estimated_duration_days,
        a.importance,
        a.urgency,
        a.created_at,
        a.updated_at,
        a.closed_date,
        s.code AS sujet_code,
        s.titre AS sujet_title,
        s.description AS sujet_description
      FROM public.action a
      JOIN public.sujet s
        ON s.id = a.sujet_id
      WHERE (
        ($1::text[] IS NOT NULL AND COALESCE(a.kpi_target_allocation_id, '') = ANY($1::text[]))
        OR ($2::text[] IS NOT NULL AND COALESCE(s.code, '') LIKE ANY($2::text[]))
        OR ($3::text[] IS NOT NULL AND COALESCE(s.description, '') LIKE ANY($3::text[]))
      )
        AND LOWER(COALESCE(a.type, 'action')) = 'action'
      ORDER BY COALESCE(a.updated_at, a.created_at) DESC, a.id DESC
      `,
      [
        allocationIds.length ? allocationIds : null,
        patterns.length ? patterns : null,
        descriptionPatterns.length ? descriptionPatterns : null
      ]
    );

    const normalizedCurrentPeriod = normalizeOptionalTextInput(currentPeriodLabel);
    const currentByAllocationId = {};
    const historyByAllocationId = {};

    actionsRes.rows.forEach((row) => {
      const mappedAction = mapActionPlanActionRow(row);
      if (!mappedAction) return;

      const allocationKey = String(
        mappedAction.kpi_target_allocation_id ?? mappedAction.kpi_values_id ?? ""
      ).trim();
      if (!allocationKey) return;

      if (!historyByAllocationId[allocationKey]) {
        historyByAllocationId[allocationKey] = [];
      }
      historyByAllocationId[allocationKey].push(mappedAction);

      if (normalizedCurrentPeriod && mappedAction.period_label === normalizedCurrentPeriod) {
        if (!currentByAllocationId[allocationKey]) {
          currentByAllocationId[allocationKey] = [];
        }
        currentByAllocationId[allocationKey].push(mappedAction);
      }
    });

    return {
      currentByAllocationId,
      historyByAllocationId
    };
  } catch (error) {
    console.error("Failed to load Action Plan corrective actions:", error.message);
    return {
      currentByAllocationId: {},
      historyByAllocationId: {}
    };
  }
};

const getResponsibleWithKPIs = async (responsibleId, week, filters = {}) => {
  const responsible = await loadFormResponsibleContext(responsibleId, filters.unitId);
  const normalizedWeek = normalizeOptionalTextInput(week);
  const normalizedFrequencyFilter = normalizeOptionalTextInput(filters.frequency)
    ? getCanonicalKpiSubmissionFrequency(filters.frequency)
    : null;
  const normalizedCalculationModeFilter = normalizeOptionalTextInput(filters.calculationMode)
    ? getCanonicalKpiCalculationMode(filters.calculationMode)
    : null;
  const responsibleNumericId = normalizeOptionalIntegerInput(
    responsible?.people_id ?? responsibleId
  );
  const normalizedUnitId = normalizeOptionalIntegerInput(filters.unitId);
  const correctiveActionsEnabled = await canUseActionPlanCorrectiveActions();

  const kpiRes = await pool.query(
    `
    SELECT
      kta.kpi_target_allocation_id AS kpi_values_id,
      kta.kpi_target_allocation_id,
      kta.kpi_id,
      role.role_name AS allocation_role_name,
      kta.role_id AS allocation_role_id,
      COALESCE(subject_link.subject_name, k.kpi_sub_title, k.kpi_name, 'KPI') AS subject,
      COALESCE(k.kpi_name, k.kpi_sub_title, 'Untitled KPI') AS indicator_sub_title,
     COALESCE(kta.target_unit, k.unit) AS unit,
     COALESCE(unit_scope.selling_currency, plant_scope.selling_currency, kta.local_currency) AS selling_currency,
     kta.local_currency,
     CASE
     WHEN LOWER(TRIM(COALESCE(kta.target_unit, k.unit))) = 'kcur'
     AND NULLIF(TRIM(COALESCE(unit_scope.selling_currency, plant_scope.selling_currency, kta.local_currency)), '') IS NOT NULL
     THEN 'k' || UPPER(TRIM(COALESCE(unit_scope.selling_currency, plant_scope.selling_currency, kta.local_currency)))
     ELSE COALESCE(kta.target_unit, k.unit)
     END AS display_unit,
      COALESCE(latest_result.target_value, kta.target_value, k.target_value) AS target,
      k.min_value AS min,
      k.max_value AS max,
      k.tolerance_type,
      k.up_tolerance,
      k.low_tolerance,
      k.frequency,
      k.kpi_explanation AS definition,
      k.calculation_on,
      k.target_auto_adjustment,
      COALESCE(latest_result.upper_limit, kta.high_limit, k.high_limit) AS high_limit,
      COALESCE(latest_result.lower_limit, kta.low_limit, k.low_limit) AS low_limit,
      k.target_direction,
      latest_result.raw_value AS value,
      latest_result.comments AS latest_comment,
      COALESCE(latest_result.recorded_at, CURRENT_TIMESTAMP) AS last_updated
    FROM public.kpi_target_allocation kta
    JOIN public.kpi k ON k.kpi_id = kta.kpi_id
    LEFT JOIN public.unit unit_scope
    ON unit_scope.unit_id = kta.unit_id

    LEFT JOIN public.unit plant_scope
    ON plant_scope.unit_id = kta.plant_id
    LEFT JOIN public.role role
    ON role.role_id = kta.role_id
    LEFT JOIN LATERAL (
      SELECT s.subject_name
      FROM public.subject_kpi sk
      JOIN public.subject s ON s.subject_id = sk.subject_id
      WHERE sk.kpi_id = k.kpi_id
      ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
      LIMIT 1
    ) subject_link ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        kr.raw_value,
        kr.target_value,
        kr.upper_limit,
        kr.lower_limit,
        kr.comments,
        kr.recorded_at
      FROM public.kpi_result kr
      WHERE kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
        AND (
          ($1::text IS NOT NULL AND (kr.period_label = $1 OR kr.week = $1))
          OR $1::text IS NULL
        )
      ORDER BY
        CASE WHEN $1::text IS NOT NULL AND (kr.period_label = $1 OR kr.week = $1) THEN 0 ELSE 1 END,
        kr.recorded_at DESC,
        kr.kpi_result_id DESC
      LIMIT 1
    ) latest_result ON TRUE
     LEFT JOIN LATERAL (
  SELECT
    kr.target_value,
    kr.upper_limit,
    kr.lower_limit
  FROM public.kpi_result kr
  WHERE kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
    AND (
      kr.target_value IS NOT NULL
      OR kr.upper_limit IS NOT NULL
      OR kr.lower_limit IS NOT NULL
    )
  ORDER BY
    CASE
      WHEN $1::text IS NOT NULL AND (kr.week = $1 OR kr.period_label = $1) THEN 0
      ELSE 1
    END,
    COALESCE(kr.result_date::timestamp, kr.recorded_at) DESC,
    kr.recorded_at DESC,
    kr.kpi_result_id DESC
  LIMIT 1
) latest_limits ON TRUE
    WHERE $2::integer IS NOT NULL
      AND kta.set_by_people_id = $2
  AND (
  $5::integer IS NULL
  OR COALESCE(kta.unit_id, kta.plant_id) = $5
)
      AND (
        $3::text IS NULL
        OR LOWER(COALESCE(NULLIF(TRIM(k.frequency), ''), 'weekly')) = LOWER($3)
      )
      AND (
        $4::text IS NULL
        OR LOWER(COALESCE(NULLIF(TRIM(k.calculation_mode), ''), 'direct')) = LOWER($4)
      )
    ORDER BY
      COALESCE(subject_link.subject_name, k.kpi_sub_title, k.kpi_name, 'KPI') ASC,
      COALESCE(k.kpi_name, k.kpi_sub_title, 'Untitled KPI') ASC,
      kta.kpi_target_allocation_id ASC
    `,
    [
      normalizedWeek,
      responsibleNumericId,
      normalizedFrequencyFilter,
      normalizedCalculationModeFilter,
      normalizedUnitId
    ]
  );

  const {
    currentByAllocationId,
    historyByAllocationId
  } = correctiveActionsEnabled
      ? await loadActionPlanCorrectiveActionMaps(kpiRes.rows, normalizedWeek)
      : { currentByAllocationId: {}, historyByAllocationId: {} };

  Object.values(historyByAllocationId).forEach((rows) => {
    (rows || []).forEach((action) => {
      if (!action) return;

      action.corrective_action_id =
        action.corrective_action_id ??
        action.id ??
        null;
    });
  });

  const kpis = kpiRes.rows.map((kpi) => {
    const allocationKey = String(
      kpi.kpi_target_allocation_id ?? kpi.kpi_values_id ?? ""
    ).trim();
    const allPeriodActions = historyByAllocationId[allocationKey] || [];
    const currentWeekActions = currentByAllocationId[allocationKey] || [];

    const openActions = allPeriodActions.filter((action) => {
      return (
        normalizeCorrectiveActionStatus(action.status, OPEN_CORRECTIVE_ACTION_STATUS) !==
        CLOSED_CORRECTIVE_ACTION_STATUS
      );
    });

    const correctiveActions = sortCorrectiveActions(openActions);
    const latestCorrectiveAction = getLatestCorrectiveAction(correctiveActions);

    return {
      ...kpi,
      corrective_actions: correctiveActions,
      current_week_corrective_actions: sortCorrectiveActions(currentWeekActions),
      corrective_action_count: correctiveActions.length,
      corrective_action_id: latestCorrectiveAction?.corrective_action_id ?? null,
      ca_root_cause: latestCorrectiveAction?.root_cause ?? "",
      ca_implemented_solution: latestCorrectiveAction?.implemented_solution ?? "",
      ca_evidence: latestCorrectiveAction?.evidence ?? "",
      ca_status: latestCorrectiveAction?.status ?? "",
      ca_due_date: latestCorrectiveAction?.due_date ?? null,
      ca_responsible_name: latestCorrectiveAction?.responsible ?? ""
    };
  });

  return {
    responsible,
    kpis,
    correctiveActionsEnabled,
    correctiveActionHistoryByAllocation: historyByAllocationId
  };
};

const generateEmailHtml = ({
  responsible,
  week,
  calculationMode = null,
  frequencyLabel = null
}) => {
  const responsibleId = responsible?.people_id ?? responsible?.responsible_id ?? "";
  const normalizedCalculationMode = normalizeOptionalTextInput(calculationMode)
    ? getCanonicalKpiCalculationMode(calculationMode)
    : null;
  const normalizedFrequencyLabel = normalizeOptionalTextInput(frequencyLabel)
    ? getCanonicalKpiSubmissionFrequency(frequencyLabel)
    : null;
  const queryParams = new URLSearchParams({
    responsible_id: String(responsibleId),
    week: String(week || "")
  });
  const appBaseUrl = (normalizeOptionalTextInput(process.env.APP_BASE_URL) || "https://kpi-form.azurewebsites.net")
    .replace(/\/+$/, "");

  if (normalizedCalculationMode) {
    queryParams.set("calculation_mode", normalizedCalculationMode);
  }

  if (normalizedFrequencyLabel) {
    queryParams.set("frequency", normalizedFrequencyLabel);
  }

  const responsibleUnitId =
    normalizeOptionalIntegerInput(responsible?.unit_id) ||
    normalizeOptionalIntegerInput(responsible?.plant_id);

  if (responsibleUnitId) {
    queryParams.set("unit_id", String(responsibleUnitId));
  }

  const formUrl = `${appBaseUrl}/form?${queryParams.toString()}`;
  const periodLabel = formatKpiSubmissionPeriodLabel(week, normalizedFrequencyLabel);
  const responsiblePlant = escapeHtml(
    normalizeOptionalTextInput(responsible?.plant_name) || "Allocated scope"
  );

  return `
  <!DOCTYPE html><html><head><meta charset="utf-8"><title>KPI Form</title></head>
  <body style="font-family:'Segoe UI',sans-serif;background:#f4f4f4;padding:20px;margin:0;">
    <div style="max-width:600px;margin:0 auto;background:#fff;padding:30px 25px 40px;border-radius:10px;box-shadow:0 4px 15px rgba(0,0,0,0.1);text-align:center;">
      
      <!-- Logo -->
      <div style="margin-bottom:10px;">
        <img src="https://media.licdn.com/dms/image/v2/D4E0BAQGYVmAPO2RZqQ/company-logo_200_200/company-logo_200_200/0/1689240189455/avocarbon_group_logo?e=2147483647&v=beta&t=nZNCXd3ypoMFQnQMxfAZrljyNBbp4E5HM11Y1yl9_L0"
             alt="AVOCarbon Logo" style="width:90px;height:90px;object-fit:contain;">
      </div>
      
      <!-- KPI group with cadre/border - directly under logo and centered -->
      <div style="border:2px solid #0078D7;border-radius:8px;padding:6px 25px;display:inline-block;margin:0 auto 15px auto;">
        <span style="color:#0078D7;font-size:16px;font-weight:500;display:inline-block;">KPI Group</span>
      </div>
      
      <h2 style="color:#0078D7;font-size:24px;margin:0 0 10px 0;font-weight:600;">KPI Submission </h2>
      ${normalizedCalculationMode
      ? `<p style="margin:0 0 6px 0;color:#0f4c81;font-size:14px;font-weight:600;">Calculation Mode: ${escapeHtml(normalizedCalculationMode)}</p>`
      : ""}
      ${normalizedFrequencyLabel
      ? `<p style="margin:0 0 14px 0;color:#0f4c81;font-size:14px;font-weight:600;">Frequency: ${escapeHtml(normalizedFrequencyLabel)}</p>`
      : ""}
      
      <h3 style="color:#333;font-size:18px;margin:0 0 25px 0;font-weight:500;">${responsiblePlant}</h3>
      
      <a href="${escapeHtml(formUrl)}"
         style="display:inline-block;padding:14px 35px;background:#0078D7;color:white;
                border-radius:50px;text-decoration:none;font-weight:600;font-size:16px;
                margin-bottom:20px;border:none;cursor:pointer;">
        Fill KPI Form
      </a>
      
      <p style="margin:0;font-size:13px;color:#666;">Click the button above to fill your KPIs for ${escapeHtml(periodLabel)}.</p>
    </div>
  </body></html>`;
};

// ============================================================
// Ported from the monolith's app.post("/redirect", ...) handler
// and its Action Plan corrective-action sync helpers (index.js).
// Used by the JSON equivalent
// POST /api/responsibles/:responsibleId/kpi-results and by the
// corrective-action submission endpoints.
// ============================================================

const hasMeaningfulCorrectiveActionInput = (action = {}) =>
  Boolean(
    normalizeText(action.rootCause ?? action.root_cause) &&
    normalizeText(action.implementedSolution ?? action.implemented_solution) &&
    normalizeText(action.dueDate ?? action.due_date) &&
    normalizeText(action.responsibleName ?? action.responsible)
  );

const buildActionPlanSubjectMetadata = ({
  kpiTargetAllocationId,
  kpiId,
  periodLabel,
  subject,
  kpiName,
  subjectCode
}) => {
  const subjectLabel =
    normalizeOptionalTextInput(subject) ||
    normalizeOptionalTextInput(kpiName) ||
    `KPI ${kpiId}`;
  const kpiLabel =
    normalizeOptionalTextInput(kpiName) ||
    subjectLabel;
  const periodText =
    normalizeOptionalTextInput(periodLabel) ||
    formatIsoDateValue(new Date()) ||
    "current period";
  const normalizedSubjectCode =
    normalizeOptionalTextInput(subjectCode) ||
    buildActionPlanSubjectCode({
      kpiTargetAllocationId,
      kpiId,
      periodLabel
    }) ||
    "";

  return {
    title: subjectLabel,
    description:
      `Corrective actions captured from the KPI form for subject "${subjectLabel}" ` +
      `and KPI "${kpiLabel}". Shared subject row reused for the same responsible across periods.`
  };
};

const actionPlanResponsibleEmailCache = new Map();

const findResponsibleEmailByDisplayName = async (responsibleName) => {
  const normalizedResponsibleName = normalizeOptionalTextInput(responsibleName);
  if (!normalizedResponsibleName) return null;

  const cacheKey = normalizedResponsibleName.toLowerCase();
  if (actionPlanResponsibleEmailCache.has(cacheKey)) {
    return actionPlanResponsibleEmailCache.get(cacheKey);
  }

  const peopleResult = await pool.query(
    `
    SELECT p.email
    FROM public.people p
    WHERE
      LOWER(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, '')))) = LOWER($1)
      OR LOWER(COALESCE(p.name, '')) = LOWER($1)
      OR LOWER(COALESCE(p.first_name, '')) = LOWER($1)
    ORDER BY
      CASE
        WHEN LOWER(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, '')))) = LOWER($1) THEN 0
        WHEN LOWER(COALESCE(p.name, '')) = LOWER($1) THEN 1
        WHEN LOWER(COALESCE(p.first_name, '')) = LOWER($1) THEN 2
        ELSE 3
      END,
      p.people_id ASC
    LIMIT 1
    `,
    [normalizedResponsibleName]
  );

  let resolvedEmail = normalizeOptionalTextInput(peopleResult.rows[0]?.email);

  if (!resolvedEmail) {
    try {
      const legacyResponsibleResult = await pool.query(
        `
        SELECT email
        FROM public."Responsible"
        WHERE LOWER(COALESCE(name, '')) = LOWER($1)
        ORDER BY responsible_id ASC
        LIMIT 1
        `,
        [normalizedResponsibleName]
      );

      resolvedEmail = normalizeOptionalTextInput(legacyResponsibleResult.rows[0]?.email);
    } catch (error) {
      resolvedEmail = null;
    }
  }

  actionPlanResponsibleEmailCache.set(cacheKey, resolvedEmail);
  return resolvedEmail;
};

const resolveActionPlanResponsibleEmail = async ({
  responsibleName,
  responsibleContext
}) => {
  const normalizedResponsibleName = normalizeOptionalTextInput(responsibleName);
  const normalizedContextName = normalizeOptionalTextInput(responsibleContext?.name);
  const normalizedContextEmail = normalizeOptionalTextInput(responsibleContext?.email);

  if (normalizedResponsibleName && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedResponsibleName)) {
    return normalizedResponsibleName;
  }

  if (
    normalizedContextEmail &&
    (!normalizedResponsibleName ||
      !normalizedContextName ||
      normalizedResponsibleName.toLowerCase() === normalizedContextName.toLowerCase())
  ) {
    return normalizedContextEmail;
  }

  return findResponsibleEmailByDisplayName(normalizedResponsibleName);
};

const getActionPlanSubjectOwnerIdentifier = (responsibleContext = null) => (
  normalizeOptionalTextInput(responsibleContext?.email) ||
  normalizeOptionalTextInput(responsibleContext?.name) ||
  null
);

const findActionPlanSubjectId = async ({
  subjectTitle = null,
  insertedBy = null,
  subjectCode = null,
  descriptionSearchValue = null
} = {}) => {
  const normalizedSubjectTitle = normalizeOptionalTextInput(subjectTitle);
  const normalizedInsertedBy = normalizeOptionalTextInput(insertedBy);
  const normalizedSubjectCode = normalizeOptionalTextInput(subjectCode);
  const normalizedDescriptionSearchValue = normalizeOptionalTextInput(descriptionSearchValue);

  if (normalizedSubjectTitle && normalizedInsertedBy) {
    const ownedSubjectResult = await actionPlanPool.query(
      `
      SELECT id
      FROM public.sujet
      WHERE parent_sujet_id IS NULL
        AND LOWER(BTRIM(COALESCE(titre, ''))) = LOWER($1)
        AND LOWER(BTRIM(COALESCE(inserted_by, ''))) = LOWER($2)
      ORDER BY id DESC
      LIMIT 1
      `,
      [normalizedSubjectTitle, normalizedInsertedBy]
    );

    const ownedSubjectId = normalizeOptionalIntegerInput(ownedSubjectResult.rows[0]?.id);
    if (ownedSubjectId) {
      return ownedSubjectId;
    }

    const blankOwnerSubjectResult = await actionPlanPool.query(
      `
      SELECT id
      FROM public.sujet
      WHERE parent_sujet_id IS NULL
        AND LOWER(BTRIM(COALESCE(titre, ''))) = LOWER($1)
        AND COALESCE(BTRIM(COALESCE(inserted_by, '')), '') = ''
      ORDER BY id DESC
      LIMIT 1
      `,
      [normalizedSubjectTitle]
    );

    const blankOwnerSubjectId = normalizeOptionalIntegerInput(blankOwnerSubjectResult.rows[0]?.id);
    if (blankOwnerSubjectId) {
      return blankOwnerSubjectId;
    }
  }

  if (!normalizedSubjectCode && !normalizedDescriptionSearchValue) {
    return null;
  }

  const result = await actionPlanPool.query(
    `
    SELECT id
    FROM public.sujet
    WHERE
      ($1::text IS NOT NULL AND code = $1)
      OR ($2::text IS NOT NULL AND COALESCE(description, '') LIKE $2)
    ORDER BY id DESC
    LIMIT 1
    `,
    [normalizedSubjectCode, normalizedDescriptionSearchValue]
  );

  return normalizeOptionalIntegerInput(result.rows[0]?.id);
};

const backfillActionPlanActionScopeForSubject = async (sujetId) => {
  const normalizedSujetId = normalizeOptionalIntegerInput(sujetId);
  if (!normalizedSujetId) return;

  const actionsRes = await actionPlanPool.query(
    `
    SELECT
      a.id,
      a.kpi_id,
      a.kpi_target_allocation_id,
      a.period_label,
      s.code AS sujet_code,
      s.description AS sujet_description
    FROM public.action a
    JOIN public.sujet s
      ON s.id = a.sujet_id
    WHERE a.sujet_id = $1
      AND LOWER(COALESCE(a.type, 'action')) = 'action'
      AND (
        COALESCE(BTRIM(COALESCE(a.kpi_id, '')), '') = ''
        OR COALESCE(BTRIM(COALESCE(a.kpi_target_allocation_id, '')), '') = ''
        OR COALESCE(BTRIM(COALESCE(a.period_label, '')), '') = ''
      )
    ORDER BY a.id ASC
    `,
    [normalizedSujetId]
  );

  for (const row of actionsRes.rows) {
    const { subjectInfo, kpiTargetAllocationId, periodLabel } = resolveActionPlanActionScope(row);
    const resolvedKpiId =
      normalizeOptionalIntegerInput(row.kpi_id) ||
      normalizeOptionalIntegerInput(subjectInfo?.kpiId);

    if (!resolvedKpiId && !kpiTargetAllocationId && !periodLabel) {
      continue;
    }

    await actionPlanPool.query(
      `
      UPDATE public.action
      SET
        kpi_id = CASE
          WHEN COALESCE(BTRIM(COALESCE(kpi_id, '')), '') = '' AND $2::text IS NOT NULL THEN $2::text
          ELSE kpi_id
        END,
        kpi_target_allocation_id = CASE
          WHEN COALESCE(BTRIM(COALESCE(kpi_target_allocation_id, '')), '') = '' AND $3::text IS NOT NULL THEN $3::text
          ELSE kpi_target_allocation_id
        END,
        period_label = CASE
          WHEN COALESCE(BTRIM(COALESCE(period_label, '')), '') = '' AND $4::text IS NOT NULL THEN $4::text
          ELSE period_label
        END
      WHERE id = $1
      `,
      [
        normalizeOptionalIntegerInput(row.id),
        Number.isInteger(resolvedKpiId) ? String(resolvedKpiId) : null,
        Number.isInteger(kpiTargetAllocationId) ? String(kpiTargetAllocationId) : null,
        normalizeOptionalTextInput(periodLabel)
      ]
    );
  }
};

const loadActionPlanActionIdsForScope = async ({
  sujetId,
  kpiTargetAllocationId,
  periodLabel
}) => {
  const normalizedSujetId = normalizeOptionalIntegerInput(sujetId);
  if (!normalizedSujetId) {
    return [];
  }

  const normalizedAllocationId = normalizeOptionalIntegerInput(kpiTargetAllocationId);
  const normalizedPeriodLabel = normalizeOptionalTextInput(periodLabel) || "";
  if (!normalizedAllocationId || !normalizedPeriodLabel) {
    return [];
  }

  const existingActionsRes = await actionPlanPool.query(
    `
    SELECT id
    FROM public.action
    WHERE sujet_id = $1
      AND LOWER(COALESCE(type, 'action')) = 'action'
      AND COALESCE(BTRIM(COALESCE(kpi_target_allocation_id, '')), '') = $2
      AND COALESCE(BTRIM(COALESCE(period_label, '')), '') = $3
    ORDER BY id ASC
    `,
    [normalizedSujetId, String(normalizedAllocationId), normalizedPeriodLabel]
  );

  return existingActionsRes.rows
    .map((row) => normalizeOptionalIntegerInput(row.id))
    .filter((value) => Number.isInteger(value));
};

const deleteActionPlanSubjectIfUnused = async (sujetId) => {
  const normalizedSujetId = normalizeOptionalIntegerInput(sujetId);
  if (!normalizedSujetId) return;

  const remainingActionsRes = await actionPlanPool.query(
    `
    SELECT COUNT(*)::integer AS action_count
    FROM public.action
    WHERE sujet_id = $1
      AND LOWER(COALESCE(type, 'action')) = 'action'
    `,
    [normalizedSujetId]
  );

  if (Number(remainingActionsRes.rows[0]?.action_count || 0) > 0) {
    return;
  }

  await actionPlanPool.query(
    `DELETE FROM public.sujet WHERE id = $1`,
    [normalizedSujetId]
  );
};

const ensureActionPlanSubject = async ({
  kpiTargetAllocationId,
  kpiId,
  periodLabel,
  subject,
  kpiName,
  insertedBy
}) => {
  const normalizedInsertedBy = normalizeOptionalTextInput(insertedBy);
  const subjectCode = buildActionPlanSubjectCode({
    kpiTargetAllocationId,
    kpiId,
    periodLabel
  });

  const metadata = buildActionPlanSubjectMetadata({
    kpiTargetAllocationId,
    kpiId,
    periodLabel,
    subject,
    kpiName,
    subjectCode
  });

  const existingSubjectId = await findActionPlanSubjectId({
    subjectTitle: metadata.title,
    insertedBy: normalizedInsertedBy,
    subjectCode,
    descriptionSearchValue: buildActionPlanSubjectDescriptionSearchValue(subjectCode)
  });
  if (existingSubjectId) {
    await backfillActionPlanActionScopeForSubject(existingSubjectId);

    await actionPlanPool.query(
      `
      UPDATE public.sujet
      SET
        code = NULL,
        titre = $2,
        description = $3,
        updated_at = NOW(),
        inserted_by = CASE
          WHEN COALESCE(BTRIM(COALESCE(inserted_by, '')), '') = '' AND $4::text IS NOT NULL THEN $4::text
          ELSE inserted_by
        END
      WHERE id = $1
      `,
      [existingSubjectId, metadata.title, metadata.description, normalizedInsertedBy]
    );

    return {
      sujetId: existingSubjectId,
      subjectCode
    };
  }

  const insertedSubjectRes = await actionPlanPool.query(
    `
    INSERT INTO public.sujet (code, titre, description, inserted_by)
    VALUES ($1, $2, $3, $4)
    RETURNING id
    `,
    [null, metadata.title, metadata.description, normalizedInsertedBy]
  );

  return {
    sujetId: normalizeOptionalIntegerInput(insertedSubjectRes.rows[0]?.id),
    subjectCode
  };
};

const syncActionPlanCorrectiveActionsForPeriod = async ({
  kpiTargetAllocationId,
  kpiId,
  unitId,
  periodLabel,
  subject,
  kpiName,
  actions = [],
  responsibleContext = null
}) => {
  const subjectCode = buildActionPlanSubjectCode({
    kpiTargetAllocationId,
    kpiId,
    periodLabel
  });
  const subjectDescriptionSearchValue = buildActionPlanSubjectDescriptionSearchValue(subjectCode);

  if (!subjectCode || !(await canUseActionPlanCorrectiveActions())) {
    return { savedCount: 0, deletedCount: 0 };
  }

  await ensureActionPlanCorrectiveActionSchema();

  const submittedActions = Array.isArray(actions) ? actions : [];
  const meaningfulActions = submittedActions.filter(hasMeaningfulCorrectiveActionInput);
  const subjectOwnerIdentifier = getActionPlanSubjectOwnerIdentifier(responsibleContext);
  const metadata = buildActionPlanSubjectMetadata({
    kpiTargetAllocationId,
    kpiId,
    periodLabel,
    subject,
    kpiName,
    subjectCode
  });

  let sujetId = await findActionPlanSubjectId({
    subjectTitle: metadata.title,
    insertedBy: subjectOwnerIdentifier,
    subjectCode,
    descriptionSearchValue: subjectDescriptionSearchValue
  });

  if (sujetId) {
    await backfillActionPlanActionScopeForSubject(sujetId);
  }

  const existingActionIds = new Set(
    await loadActionPlanActionIdsForScope({
      sujetId,
      kpiTargetAllocationId,
      periodLabel
    })
  );

  if (!meaningfulActions.length) {
    if (!sujetId || !existingActionIds.size) {
      return { savedCount: 0, deletedCount: 0 };
    }

    await actionPlanPool.query(
      `
      DELETE FROM public.action
      WHERE sujet_id = $1
        AND LOWER(COALESCE(type, 'action')) = 'action'
        AND COALESCE(BTRIM(COALESCE(kpi_target_allocation_id, '')), '') = $2
        AND COALESCE(BTRIM(COALESCE(period_label, '')), '') = $3
      `,
      [
        sujetId,
        String(normalizeOptionalIntegerInput(kpiTargetAllocationId)),
        normalizeOptionalTextInput(periodLabel) || ""
      ]
    );
    await deleteActionPlanSubjectIfUnused(sujetId);

    return {
      savedCount: 0,
      deletedCount: existingActionIds.size
    };
  }

  const ensuredSubject = await ensureActionPlanSubject({
    kpiTargetAllocationId,
    kpiId,
    periodLabel,
    subject,
    kpiName,
    insertedBy: subjectOwnerIdentifier
  });
  sujetId = normalizeOptionalIntegerInput(ensuredSubject?.sujetId);
  if (!sujetId) {
    return { savedCount: 0, deletedCount: 0 };
  }

  let savedCount = 0;
  const keptActionIds = new Set();
  const actionPlanKpiId = normalizeOptionalIntegerInput(kpiId);
  const actionPlanKpiIdValue = Number.isInteger(actionPlanKpiId)
    ? String(actionPlanKpiId)
    : null;

  const actionPlanUnitId = normalizeOptionalIntegerInput(unitId);
  const actionPlanUnitIdValue = Number.isInteger(actionPlanUnitId)
    ? String(actionPlanUnitId)
    : null;
  const actionPlanAllocationId = normalizeOptionalIntegerInput(kpiTargetAllocationId);
  const actionPlanAllocationIdValue = Number.isInteger(actionPlanAllocationId)
    ? String(actionPlanAllocationId)
    : null;
  const normalizedActionPlanPeriodLabel = normalizeOptionalTextInput(periodLabel) || null;

  for (let index = 0; index < meaningfulActions.length; index += 1) {
    const action = meaningfulActions[index];
    const actionId = normalizeOptionalIntegerInput(
      action.correctiveActionId ??
      action.corrective_action_id ??
      action.id
    );

    if (actionId && !existingActionIds.has(actionId)) {
      continue;
    }

    const status =
      normalizeCorrectiveActionStatus(action.status, OPEN_CORRECTIVE_ACTION_STATUS) ||
      OPEN_CORRECTIVE_ACTION_STATUS;
    const responsibleName =
      normalizeOptionalTextInput(action.responsibleName ?? action.responsible) ||
      normalizeOptionalTextInput(responsibleContext?.name);
    const responsibleEmail = await resolveActionPlanResponsibleEmail({
      responsibleName,
      responsibleContext
    });
    const demandeur =
      normalizeOptionalTextInput(responsibleContext?.name) ||
      normalizeOptionalTextInput(responsibleContext?.email);
    const emailDemandeur =
      normalizeOptionalTextInput(responsibleContext?.email);

    const implementedSolution =
      normalizeOptionalTextInput(action.implementedSolution ?? action.implemented_solution);
    const rootCause =
      normalizeOptionalTextInput(action.rootCause ?? action.root_cause);
    const estimatedDurationDays = normalizeCorrectiveActionEstimatedDurationDays(
      action.estimatedDurationDays ?? action.estimated_duration_days
    );
    const importance = normalizeCorrectiveActionImportance(action.importance);
    const urgency = normalizeCorrectiveActionUrgency(action.urgency);
    const values = [
      implementedSolution,
      rootCause,
      status,
      responsibleName,
      normalizeOptionalDateInput(action.dueDate ?? action.due_date),
      estimatedDurationDays,
      importance,
      urgency,
      index + 1,
      responsibleEmail,
      demandeur,
      emailDemandeur,
      actionPlanKpiIdValue,
      actionPlanUnitIdValue,
      actionPlanAllocationIdValue,
      normalizedActionPlanPeriodLabel
    ];

    if (actionId && existingActionIds.has(actionId)) {
      const updatedActionRes = await actionPlanPool.query(
        `
        UPDATE public.action
        SET
          titre = $2,
          description = $3,
          status = $4,
          responsable = $5,
          due_date = $6,
          estimated_duration_days = $7,
          importance = $8,
          urgency = $9,
          ordre = $10,
          email_responsable = $11,
          demandeur = $12,
          email_demandeur = $13,
          kpi_id = $14,
          unit_id = $15,
          kpi_target_allocation_id = $16,
          period_label = $17,
          type = 'action',
          updated_at = NOW(),
          closed_date = CASE
            WHEN LOWER($4::text) = 'closed' THEN COALESCE(closed_date, CURRENT_DATE)
            ELSE NULL
          END
        WHERE id = $1
         AND sujet_id = $18
        RETURNING id
        `,
        [actionId, ...values, sujetId]
      );

      const updatedActionId = normalizeOptionalIntegerInput(updatedActionRes.rows[0]?.id);
      if (updatedActionId) {
        keptActionIds.add(updatedActionId);
        savedCount += 1;
        continue;
      }
    }

    const insertedActionRes = await actionPlanPool.query(
      `
    INSERT INTO public.action (
      sujet_id,
      type,
      titre,
      description,
      status,
      responsable,
      due_date,
      estimated_duration_days,
      importance,
      urgency,
      ordre,
      email_responsable,
      demandeur,
      email_demandeur,
      kpi_id,
      unit_id,
      kpi_target_allocation_id,
      period_label,
      closed_date
    )
      VALUES (
        $1,
        'action',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        CASE
          WHEN LOWER($4::text) = 'closed' THEN CURRENT_DATE
          ELSE NULL
        END
      )
      RETURNING id
      `,
      [sujetId, ...values]
    );

    const insertedActionId = normalizeOptionalIntegerInput(insertedActionRes.rows[0]?.id);
    if (insertedActionId) {
      keptActionIds.add(insertedActionId);
      savedCount += 1;
    }
  }

  const staleActionIds = Array.from(existingActionIds).filter(
    (id) => !keptActionIds.has(id)
  );

  if (staleActionIds.length) {
    await actionPlanPool.query(
      `DELETE FROM public.action WHERE sujet_id = $1 AND id = ANY($2::bigint[])`,
      [sujetId, staleActionIds]
    );
  }

  return {
    savedCount,
    deletedCount: staleActionIds.length
  };
};

// ============================================================
// Legacy public.corrective_actions table helpers, ported from
// the monolith's app.post("/submit-corrective-action", ...) and
// app.post("/submit-bulk-corrective-actions", ...) handlers.
// ============================================================

let legacyCorrectiveActionsSchemaPromise = null;

const ensureLegacyCorrectiveActionsSchema = async () => {
  if (!legacyCorrectiveActionsSchemaPromise) {
    legacyCorrectiveActionsSchemaPromise = (async () => {
      if (!(await hasPublicTable("corrective_actions"))) {
        return false;
      }

      await pool.query(`
        ALTER TABLE public.corrective_actions
        ADD COLUMN IF NOT EXISTS estimated_duration_days INTEGER
      `);

      await pool.query(`
        ALTER TABLE public.corrective_actions
        ADD COLUMN IF NOT EXISTS importance VARCHAR(50)
      `);

      await pool.query(`
        ALTER TABLE public.corrective_actions
        ADD COLUMN IF NOT EXISTS urgency VARCHAR(50)
      `);

      return true;
    })().catch((error) => {
      legacyCorrectiveActionsSchemaPromise = null;
      throw error;
    });
  }

  return legacyCorrectiveActionsSchemaPromise;
};

// ============================================================
// upsertCorrectiveAction — saves root_cause, implemented_solution,
// evidence into corrective_actions table for a given kpi/week
// ============================================================
const upsertCorrectiveAction = async (
  responsibleId,
  kpiId,
  week,
  {
    correctiveActionId,
    rootCause,
    implementedSolution,
    dueDate,
    estimatedDurationDays,
    responsibleName,
    importance,
    urgency,
    status,
    demandeur
  }
) => {
  try {
    await ensureLegacyCorrectiveActionsSchema();

    const normalizedPayload = {
      rootCause: normalizeText(rootCause),
      implementedSolution: normalizeText(implementedSolution),
      dueDate: normalizeText(dueDate),
      estimatedDurationDays: normalizeCorrectiveActionEstimatedDurationDays(estimatedDurationDays),
      responsibleName: normalizeText(responsibleName),
      importance: normalizeCorrectiveActionImportance(importance),
      urgency: normalizeCorrectiveActionUrgency(urgency),
      status: normalizeCorrectiveActionStatus(status),
      demandeur: normalizeText(demandeur)
    };
    let resolvedStatus = normalizedPayload.status || "Open";

    if (normalizeText(correctiveActionId) && !normalizedPayload.status) {
      const existingStatusRes = await pool.query(
        `SELECT status
         FROM public.corrective_actions
         WHERE corrective_action_id = $1
         LIMIT 1`,
        [correctiveActionId]
      );
      resolvedStatus = normalizeText(existingStatusRes.rows[0]?.status) || "Open";
    }

    if (normalizeText(correctiveActionId)) {
      const result = await pool.query(
        `UPDATE public.corrective_actions
     SET root_cause = $2::text,
       implemented_solution = $3::text,
       due_date = $4::date,
       estimated_duration_days = $5::integer,
       responsible = $6::text,
       importance = $7::text,
       urgency = $8::text,
       status = $9::text,
       demandeur = $10::text,
       updated_date = NOW()
      WHERE corrective_action_id = $1
       RETURNING corrective_action_id`,
        [
          correctiveActionId,
          normalizedPayload.rootCause,
          normalizedPayload.implementedSolution,
          normalizedPayload.dueDate,
          normalizedPayload.estimatedDurationDays,
          normalizedPayload.responsibleName,
          normalizedPayload.importance,
          normalizedPayload.urgency,
          resolvedStatus,
          normalizedPayload.demandeur
        ]
      );

      if (result.rowCount > 0) {
        return true;
      }
    }

    await pool.query(
      `INSERT INTO public.corrective_actions
   (
     responsible_id, kpi_id, week,
     root_cause, implemented_solution,
     due_date, estimated_duration_days, responsible, importance, urgency, status, demandeur
   )
   VALUES (
     $1,$2,$3,$4::text,$5::text,$6::date,$7::integer,$8::text,$9::text,$10::text,$11::text,$12::text
   )`,
      [
        responsibleId,
        kpiId,
        week,
        normalizedPayload.rootCause,
        normalizedPayload.implementedSolution,
        normalizedPayload.dueDate,
        normalizedPayload.estimatedDurationDays,
        normalizedPayload.responsibleName,
        normalizedPayload.importance,
        normalizedPayload.urgency,
        resolvedStatus,
        normalizedPayload.demandeur
      ]
    );

    return true;
  } catch (err) {
    console.error("upsertCorrectiveAction error:", err.message);
    return false;
  }
};

module.exports = {
  hasPublicTable,
  hasActionPlanTable,
  canUseActionPlanCorrectiveActions,
  updateActionPlanCorrectiveActionStatus,
  ensureActionPlanCorrectiveActionSchema,
  resolveActionPlanActionScope,
  ACTION_PLAN_SUBJECT_CODE_PREFIX,
  mapActionPlanActionRow,
  loadActionPlanCorrectiveActionMaps,
  getResponsibleWithKPIs,
  generateEmailHtml,
  syncActionPlanCorrectiveActionsForPeriod,
  ensureLegacyCorrectiveActionsSchema,
  upsertCorrectiveAction,
};
