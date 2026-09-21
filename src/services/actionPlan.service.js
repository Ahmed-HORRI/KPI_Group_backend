const { pool, actionPlanPool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { normalizeCorrectiveActionStatus } = require("./kpiShared.service");

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

module.exports = {
  hasPublicTable,
  hasActionPlanTable,
  canUseActionPlanCorrectiveActions,
  updateActionPlanCorrectiveActionStatus,
};
