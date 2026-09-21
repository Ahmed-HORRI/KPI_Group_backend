const { pool, actionPlanPool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { normalizeCorrectiveActionStatus } = require("./kpiShared.service");
const { formatIsoDateValue } = require("../utils/weekPeriod");

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

module.exports = {
  hasPublicTable,
  hasActionPlanTable,
  canUseActionPlanCorrectiveActions,
  updateActionPlanCorrectiveActionStatus,
  ensureActionPlanCorrectiveActionSchema,
  resolveActionPlanActionScope,
  ACTION_PLAN_SUBJECT_CODE_PREFIX,
};
