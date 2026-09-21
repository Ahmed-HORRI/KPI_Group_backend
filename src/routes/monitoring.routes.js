const express = require("express");
const router = express.Router();
const { pool, actionPlanPool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { formatDateOnlyValue, parseDateOnlyValue } = require("../utils/weekPeriod");
const {
  normalizeCorrectiveActionImportance,
  normalizeCorrectiveActionUrgency,
  normalizeCorrectiveActionEstimatedDurationDays,
  normalizeCorrectiveActionStatus,
  OPEN_CORRECTIVE_ACTION_STATUS,
} = require("../services/kpiShared.service");
const {
  canUseActionPlanCorrectiveActions,
  ensureActionPlanCorrectiveActionSchema,
  resolveActionPlanActionScope,
} = require("../services/actionPlan.service");

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

const ROWS_SQL = `
  SELECT
    v.kpi_target_allocation_id               AS a,
    kta.kpi_id                              AS kid,
    COALESCE(kta.unit_id, kta.plant_id)     AS uid,
    s.owner_role_id                         AS owner_role_id,
    v.kpi_name                               AS k,
    COALESCE(v.plant_name, '—')              AS p,
    COALESCE(v.role_name,  '—')              AS r,
    v.current_status                         AS s,
    v.priority_score                         AS pr,
    s.analysis_details->>'priority_level'    AS pl,
    v.escalation_level                       AS e,
    v.latest_value                           AS v,
    v.latest_target                          AS t,
    v.performance_gap                        AS g,
    s.analysis_details->>'performance_trend' AS tr,
    s.analysis_details->>'action_status'     AS ac,
    s.analysis_details->>'comment'           AS c,
    s.analysis_details->>'importance'        AS im,
    s.analysis_details->>'urgency'           AS u,
    v.calculation_date                       AS calc
  FROM v_kpi_monitoring v
  JOIN public.kpi_target_allocation kta
    ON kta.kpi_target_allocation_id = v.kpi_target_allocation_id
  JOIN kpi_monitoring_status s
    ON s.monitoring_status_id = v.monitoring_status_id
  {WHERE}
  ORDER BY v.priority_score DESC NULLS LAST, v.kpi_name
`;

const num = (x) => {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

const buildMonitoringActionScopeKey = (kpiId, unitId = null) => {
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  const normalizedUnitId = normalizeOptionalIntegerInput(unitId);
  if (!normalizedKpiId) return "";

  return `${normalizedKpiId}::${normalizedUnitId || ""}`;
};

const mapMonitoringActionRow = (row = {}) => {
  const { periodLabel, kpiTargetAllocationId, subjectInfo } = resolveActionPlanActionScope(row);
  const persistedKpiId =
    normalizeOptionalIntegerInput(row.kpi_id) ||
    normalizeOptionalIntegerInput(subjectInfo?.kpiId);
  if (!persistedKpiId) return null;
  const persistedUnitId = normalizeOptionalIntegerInput(row.unit_id);
  const status =
    normalizeCorrectiveActionStatus(row.status, OPEN_CORRECTIVE_ACTION_STATUS) ||
    OPEN_CORRECTIVE_ACTION_STATUS;
  const dueDate = formatDateOnlyValue(row.due_date);
  const isClosed = String(status || "").trim().toLowerCase() === "closed";
  const overdueDays = isClosed ? 0 : getCorrectiveActionOverdueDays(dueDate);

  return {
    id: normalizeOptionalIntegerInput(row.id),
    corrective_action_id: normalizeOptionalIntegerInput(row.id),
    kpi_id: persistedKpiId,
    unit_id: persistedUnitId,
    unitId: persistedUnitId,
    kpi_target_allocation_id: kpiTargetAllocationId,
    week: periodLabel,
    period_label: periodLabel,
    root_cause: normalizeOptionalTextInput(row.description) || "",
    implemented_solution: normalizeOptionalTextInput(row.titre) || "",
    status,
    due_date: dueDate,
    estimated_duration_days: normalizeCorrectiveActionEstimatedDurationDays(row.estimated_duration_days),
    importance: normalizeCorrectiveActionImportance(row.importance),
    urgency: normalizeCorrectiveActionUrgency(row.urgency),
    responsible: normalizeOptionalTextInput(row.responsable) || "",
    email_responsable: normalizeOptionalTextInput(row.email_responsable),
    created_date: row.created_at,
    updated_date: row.updated_at,
    closed_date: row.closed_date,
    sujet_id: normalizeOptionalIntegerInput(row.sujet_id),
    sujet_code: normalizeOptionalTextInput(row.sujet_code),
    sujet_title: normalizeOptionalTextInput(row.sujet_title),
    overdue_days: overdueDays,
    is_overdue: overdueDays > 0
  };
};

const loadMonitoringActionsByScope = async (rows = []) => {
  const normalizedScopes = Array.from(new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        kpiId: normalizeOptionalIntegerInput(row?.kid ?? row?.kpiId ?? row?.kpi_id),
        unitId: normalizeOptionalIntegerInput(row?.uid ?? row?.unitId ?? row?.unit_id)
      }))
      .filter((row) => Number.isInteger(row.kpiId))
      .map((row) => JSON.stringify(row))
  )).map((value) => JSON.parse(value));

  const normalizedKpiIds = Array.from(new Set(
    normalizedScopes
      .map((row) => row.kpiId)
      .filter((value) => Number.isInteger(value))
      .map((value) => String(value))
  ));

  if (!normalizedScopes.length || !normalizedKpiIds.length || !(await canUseActionPlanCorrectiveActions())) {
    return {};
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
      LEFT JOIN public.sujet s
        ON s.id = a.sujet_id
      WHERE COALESCE(BTRIM(COALESCE(a.kpi_id, '')), '') <> ''
        AND a.kpi_id = ANY($1::text[])
        AND LOWER(COALESCE(a.type, 'action')) = 'action'
      ORDER BY COALESCE(a.updated_at, a.created_at) DESC, a.id DESC
      `,
      [normalizedKpiIds]
    );

    const actionsByScopeKey = {};

    actionsRes.rows.forEach((row) => {
      const mappedAction = mapMonitoringActionRow(row);
      if (!mappedAction) return;

      const key = buildMonitoringActionScopeKey(mappedAction.kpi_id, mappedAction.unit_id);
      if (!key) return;

      if (!actionsByScopeKey[key]) {
        actionsByScopeKey[key] = [];
      }

      actionsByScopeKey[key].push(mappedAction);
    });

    Object.keys(actionsByScopeKey).forEach((key) => {
      actionsByScopeKey[key] = sortCorrectiveActions(actionsByScopeKey[key]);
    });

    return actionsByScopeKey;
  } catch (error) {
    console.error("Failed to load monitoring actions:", error.message);
    return {};
  }
};

const summarizeMonitoringActions = (actions = []) => {
  const normalizedActions = sortCorrectiveActions(Array.isArray(actions) ? actions : []);
  const openActions = normalizedActions.filter(
    (action) =>
      normalizeCorrectiveActionStatus(action.status, OPEN_CORRECTIVE_ACTION_STATUS) !== "Closed"
  );
  const closedActions = normalizedActions.filter(
    (action) =>
      normalizeCorrectiveActionStatus(action.status, OPEN_CORRECTIVE_ACTION_STATUS) === "Closed"
  );
  const overdueActions = openActions.filter((action) => action.is_overdue);
  const latestAction = normalizedActions[0] || null;

  return {
    total: normalizedActions.length,
    open: openActions.length,
    closed: closedActions.length,
    overdue: overdueActions.length,
    latestStatus: latestAction?.status || null,
    latestDueDate: latestAction?.due_date || null,
    latestUpdatedAt: latestAction?.updated_date ?? latestAction?.created_date ?? null
  };
};

const shape = (row, actionsByScope = {}) => {
  const kpiId = normalizeOptionalIntegerInput(row.kid);
  const unitId = normalizeOptionalIntegerInput(row.uid);
  const ownerRoleId = normalizeOptionalIntegerInput(row.owner_role_id);
  const scopeKey = buildMonitoringActionScopeKey(kpiId, unitId);
  const fallbackScopeKey = buildMonitoringActionScopeKey(kpiId, null);
  const actions = scopeKey
    ? (actionsByScope[scopeKey] || actionsByScope[fallbackScopeKey] || [])
    : [];

  return ({
  a: row.a,
  kpiId,
  uid: unitId,
  unitId,
  owner_role_id: ownerRoleId,
  ownerRoleId,
  k: row.k,
  p: row.p,
  r: row.r,
  s: row.s,
  pr: num(row.pr),
  pl: row.pl,
  e: row.e === null || row.e === undefined ? 0 : Number(row.e),
  v: num(row.v),
  t: num(row.t),
  g: num(row.g),
  tr: row.tr,
  ac: row.ac,
  c: row.c,
  im: row.im,
  u: row.u,
  actions,
  actionSummary: summarizeMonitoringActions(actions)
});
};
router.get("/api/kpi/monitoring", async (req, res) => {
  try {
    const { plant } = req.query;

    let sql = ROWS_SQL;
    const params = [];

    if (plant && plant !== "All") {
      sql = sql.replace("{WHERE}", "WHERE v.plant_name = $1");
      params.push(plant);
    } else {
      sql = sql.replace("{WHERE}", "");
    }

    const { rows } = await pool.query(sql, params);
    const actionsByScope = await loadMonitoringActionsByScope(rows);

    res.json({
      ok: true,
      updatedAt: rows.length ? rows[0].calc : null,
      count: rows.length,
      data: rows.map((row) => shape(row, actionsByScope)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: "Failed to load KPI monitoring.",
    });
  }
});
router.get("/api/kpi/monitoring/meta", async (req, res) => {
  try {
    const plantsQ = pool.query(`
      SELECT DISTINCT plant_name
      FROM v_kpi_monitoring
      WHERE plant_name IS NOT NULL
      ORDER BY plant_name
    `);

    const countsQ = pool.query(`
      SELECT current_status AS s,
             COUNT(*)::int AS n
      FROM v_kpi_monitoring
      GROUP BY current_status
    `);

    const updatedQ = pool.query(`
      SELECT MAX(calculation_date) AS updatedAt
      FROM kpi_monitoring_status
    `);

    const [plants, counts, updated] = await Promise.all([
      plantsQ,
      countsQ,
      updatedQ,
    ]);

    res.json({
      ok: true,
      plants: ["All", ...plants.rows.map((r) => r.plant_name)],
      counts: counts.rows.reduce((obj, row) => {
        obj[row.s] = row.n;
        return obj;
      }, {}),
      updatedAt: updated.rows[0].updatedat || updated.rows[0].updatedAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: "Failed to load metadata.",
    });
  }
});

router.get("/api/kpi/monitoring/:allocationId", async (req, res) => {
  try {
    const { allocationId } = req.params;

    const sql = `
      SELECT
        v.kpi_target_allocation_id AS a,
        kta.kpi_id AS kid,
        COALESCE(kta.unit_id, kta.plant_id) AS uid,
        s.owner_role_id AS owner_role_id,
        v.kpi_name AS k,
        COALESCE(v.plant_name,'—') AS p,
        COALESCE(v.role_name,'—') AS r,
        v.current_status AS s,
        v.priority_score AS pr,
        s.analysis_details->>'priority_level' AS pl,
        v.escalation_level AS e,
        v.latest_value AS v,
        v.latest_target AS t,
        v.performance_gap AS g,
        s.analysis_details->>'performance_trend' AS tr,
        s.analysis_details->>'action_status' AS ac,
        s.analysis_details->>'comment' AS c,
        s.analysis_details->>'importance' AS im,
        s.analysis_details->>'urgency' AS u,
        v.calculation_date AS calc
      FROM v_kpi_monitoring v
      JOIN public.kpi_target_allocation kta
        ON kta.kpi_target_allocation_id = v.kpi_target_allocation_id
      JOIN kpi_monitoring_status s
        ON s.monitoring_status_id = v.monitoring_status_id
      WHERE v.kpi_target_allocation_id = $1
    `;

    const { rows } = await pool.query(sql, [allocationId]);

    if (!rows.length) {
      return res.status(404).json({
        ok: false,
        error: "KPI allocation not found.",
      });
    }

    const actionsByScope = await loadMonitoringActionsByScope(rows);

    res.json({
      ok: true,
      data: shape(rows[0], actionsByScope),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: "Failed to load KPI allocation.",
    });
  }
});

router.post("/api/kpi/monitoring/comment", async (req, res) => {
  try {
    const { actionId, comment } = req.body;

    if (!actionId) {
      return res.status(400).json({ ok: false, error: "actionId is required" });
    }

    await actionPlanPool.query(
      `
      UPDATE public.action
      SET
        comment = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [comment, actionId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
