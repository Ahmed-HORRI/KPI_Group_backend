const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { normalizeOptionalIntegerInput, normalizeOptionalTextInput } = require("../utils/normalize");
const {
  sendDepartmentKPIReportEmail,
  getCurrentFormWeek,
  getDepartmentKPIReport,
  CEO_REPORT_RECIPIENT_EMAIL,
} = require("../services/ceoReportGeneration.service");
const { triggerHierarchyReportNow } = require("../services/hierarchyReport.service");

const toIntOrNull = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// -----------------------------------------------------
// 1. Units dropdown
// GET /api/ceo-kpi/units
// -----------------------------------------------------
router.get("/api/ceo-kpi/units", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.unit_id,
        u.unit_name
      FROM public.unit u
      INNER JOIN public.unit_type ut
        ON ut.unit_type_id = u.unit_type_id
      WHERE u.status_id = 1
        AND LOWER(TRIM(ut.unit_type_name)) = 'factory'
      ORDER BY u.unit_name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET /api/ceo-kpi/units error:", error);
    res.status(500).json({ error: "Failed to load units" });
  }
});

// -----------------------------------------------------
// 2. KPI dropdown
// GET /api/ceo-kpi/kpis
// -----------------------------------------------------
router.get("/api/ceo-kpi/kpis", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT
        k.kpi_id,
        k.kpi_name,
        k.kpi_sub_title,
        k.unit,
        k.frequency
      FROM public.kpi k
      ORDER BY k.kpi_name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("GET /api/ceo-kpi/kpis error:", error);
    res.status(500).json({ error: "Failed to load KPIs" });
  }
});

// -----------------------------------------------------
// 3. Departments under selected unit
// Department = role/function inside KPI allocation
// GET /api/ceo-kpi/units/:unitId/departments
// -----------------------------------------------------
router.get("/api/ceo-kpi/units/:unitId/departments", async (req, res) => {
  try {
    const unitId = toIntOrNull(req.params.unitId);

    if (!unitId) {
      return res.status(400).json({ error: "Valid unitId is required" });
    }

    const result = await pool.query(
      `
      SELECT DISTINCT
        COALESCE(
          NULLIF(TRIM(r.role_name), ''),
          NULLIF(TRIM(kta."function"), ''),
          'General'
        ) AS department_name,

        COALESCE(
          'role:' || r.role_id::text,
          'function:' || NULLIF(TRIM(kta."function"), ''),
          'general'
        ) AS department_id

      FROM public.kpi_target_allocation kta
      LEFT JOIN public.role r
        ON r.role_id = kta.role_id

      WHERE COALESCE(kta.plant_id, kta.unit_id) = $1

      ORDER BY department_name ASC
      `,
      [unitId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("GET /api/ceo-kpi/units/:unitId/departments error:", error);
    res.status(500).json({ error: "Failed to load departments" });
  }
});

// -----------------------------------------------------
// 4. Main CEO Dashboard endpoint
// GET /api/ceo-kpi/dashboard?unit_id=&department_id=&kpi_id=
// -----------------------------------------------------
router.get("/api/ceo-kpi/dashboard", async (req, res) => {
  try {
    const unitId = toIntOrNull(req.query.unit_id);
    const kpiId = toIntOrNull(req.query.kpi_id);
    const departmentId = String(req.query.department_id || "").trim();

    const params = [];
    const filters = [];

    if (unitId) {
      params.push(unitId);
      filters.push(`COALESCE(kta.plant_id, kta.unit_id) = $${params.length}`);
    }

    if (kpiId) {
      params.push(kpiId);
      filters.push(`k.kpi_id = $${params.length}`);
    }

    if (departmentId) {
      if (departmentId.startsWith("role:")) {
        const roleId = Number(departmentId.replace("role:", ""));
        if (Number.isInteger(roleId)) {
          params.push(roleId);
          filters.push(`kta.role_id = $${params.length}`);
        }
      } else if (departmentId.startsWith("function:")) {
        const functionName = departmentId.replace("function:", "");
        params.push(functionName);
        filters.push(`LOWER(TRIM(kta."function")) = LOWER(TRIM($${params.length}))`);
      } else if (departmentId === "general") {
        filters.push(`kta.role_id IS NULL AND NULLIF(TRIM(kta."function"), '') IS NULL`);
      }
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    // -------------------------------------------------
    // SUMMARY
    // -------------------------------------------------
    const summaryResult = await pool.query(
      `
      WITH base AS (
        SELECT
          u.unit_id,
          k.kpi_id,
          kta.kpi_target_allocation_id,
          COALESCE(kr.raw_value, 0)::numeric AS actual_value,
          COALESCE(kr.target_value, kta.target_value, k.target_value, 0)::numeric AS target_value
        FROM public.kpi_target_allocation kta
        JOIN public.kpi k
          ON k.kpi_id = kta.kpi_id
        LEFT JOIN public.unit u
          ON u.unit_id = COALESCE(kta.plant_id, kta.unit_id)
        LEFT JOIN LATERAL (
          SELECT
            kr.raw_value,
            kr.target_value
          FROM public.kpi_result kr
          WHERE kr.kpi_id = k.kpi_id
            AND kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
          ORDER BY COALESCE(kr.recorded_at, kr.result_date::timestamp) DESC,
                   kr.kpi_result_id DESC
          LIMIT 1
        ) kr ON TRUE
        ${whereClause}
      )
      SELECT
        COUNT(DISTINCT unit_id)::int AS total_units,
        COUNT(DISTINCT kpi_id)::int AS total_kpis,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN target_value <> 0
                THEN (actual_value / target_value) * 100
              END
            ), 2
          ), 0
        ) AS achievement_rate,
        COALESCE(
          SUM(
            CASE
              WHEN target_value <> 0
               AND actual_value < target_value * 0.8
              THEN 1
              ELSE 0
            END
          ), 0
        )::int AS critical_kpis
      FROM base
      `,
      params
    );

    // -------------------------------------------------
    // PERFORMANCE BY DEPARTMENT
    // -------------------------------------------------
    const performanceResult = await pool.query(
      `
      WITH base AS (
        SELECT
          COALESCE(
            NULLIF(TRIM(r.role_name), ''),
            NULLIF(TRIM(kta."function"), ''),
            'General'
          ) AS department_name,
          COALESCE(kr.raw_value, 0)::numeric AS actual_value,
          COALESCE(kr.target_value, kta.target_value, k.target_value, 0)::numeric AS target_value
        FROM public.kpi_target_allocation kta
        JOIN public.kpi k
          ON k.kpi_id = kta.kpi_id
        LEFT JOIN public.role r
          ON r.role_id = kta.role_id
        LEFT JOIN LATERAL (
          SELECT
            kr.raw_value,
            kr.target_value
          FROM public.kpi_result kr
          WHERE kr.kpi_id = k.kpi_id
            AND kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
          ORDER BY COALESCE(kr.recorded_at, kr.result_date::timestamp) DESC,
                   kr.kpi_result_id DESC
          LIMIT 1
        ) kr ON TRUE
        ${whereClause}
      )
      SELECT
        department_name,
        COALESCE(
          ROUND(
            AVG(
              CASE
                WHEN target_value <> 0
                THEN (actual_value / target_value) * 100
              END
            ), 2
          ), 0
        ) AS achievement_rate
      FROM base
      GROUP BY department_name
      ORDER BY achievement_rate DESC
      `,
      params
    );

    // -------------------------------------------------
    // TARGET VS ACTUAL
    // -------------------------------------------------
    const targetVsActualResult = await pool.query(
      `
      SELECT
        k.kpi_name,
        COALESCE(SUM(COALESCE(kr.target_value, kta.target_value, k.target_value, 0)), 0) AS target,
        COALESCE(SUM(COALESCE(kr.raw_value, 0)), 0) AS actual
      FROM public.kpi_target_allocation kta
      JOIN public.kpi k
        ON k.kpi_id = kta.kpi_id
      LEFT JOIN LATERAL (
        SELECT
          kr.raw_value,
          kr.target_value
        FROM public.kpi_result kr
        WHERE kr.kpi_id = k.kpi_id
          AND kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
        ORDER BY COALESCE(kr.recorded_at, kr.result_date::timestamp) DESC,
                 kr.kpi_result_id DESC
        LIMIT 1
      ) kr ON TRUE
      ${whereClause}
      GROUP BY k.kpi_name
      ORDER BY k.kpi_name ASC
      LIMIT 20
      `,
      params
    );

    // -------------------------------------------------
    // TREND
    // -------------------------------------------------
    const trendResult = await pool.query(
      `
      SELECT
        COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')) AS week,
        COALESCE(SUM(kr.target_value), 0) AS target,
        COALESCE(SUM(kr.raw_value), 0) AS actual
      FROM public.kpi_result kr
      JOIN public.kpi k
        ON k.kpi_id = kr.kpi_id
      LEFT JOIN public.kpi_target_allocation kta
        ON kta.kpi_target_allocation_id = kr.kpi_target_allocation_id
      LEFT JOIN public.role r
        ON r.role_id = kta.role_id
      ${whereClause}
      GROUP BY COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD'))
      ORDER BY week ASC
      LIMIT 20
      `,
      params
    );

    // -------------------------------------------------
    // STATUS DISTRIBUTION
    // -------------------------------------------------
    const statusResult = await pool.query(
      `
      WITH base AS (
        SELECT
          COALESCE(kr.raw_value, 0)::numeric AS actual_value,
          COALESCE(kr.target_value, kta.target_value, k.target_value, 0)::numeric AS target_value
        FROM public.kpi_target_allocation kta
        JOIN public.kpi k
          ON k.kpi_id = kta.kpi_id
        LEFT JOIN LATERAL (
          SELECT
            kr.raw_value,
            kr.target_value
          FROM public.kpi_result kr
          WHERE kr.kpi_id = k.kpi_id
            AND kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
          ORDER BY COALESCE(kr.recorded_at, kr.result_date::timestamp) DESC,
                   kr.kpi_result_id DESC
          LIMIT 1
        ) kr ON TRUE
        ${whereClause}
      )
      SELECT
        CASE
          WHEN target_value = 0 THEN 'No Target'
          WHEN actual_value >= target_value THEN 'Healthy'
          WHEN actual_value >= target_value * 0.8 THEN 'Warning'
          ELSE 'Critical'
        END AS status,
        COUNT(*)::int AS value
      FROM base
      GROUP BY status
      ORDER BY value DESC
      `,
      params
    );

    // -------------------------------------------------
    // TOP RISKS
    // -------------------------------------------------
    const topRisksResult = await pool.query(
      `
      SELECT
        k.kpi_name,
        ROUND(
          COALESCE(kr.target_value, kta.target_value, k.target_value, 0)::numeric
          - COALESCE(kr.raw_value, 0)::numeric,
          2
        ) AS gap
      FROM public.kpi_target_allocation kta
      JOIN public.kpi k
        ON k.kpi_id = kta.kpi_id
      LEFT JOIN LATERAL (
        SELECT
          kr.raw_value,
          kr.target_value
        FROM public.kpi_result kr
        WHERE kr.kpi_id = k.kpi_id
          AND kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
        ORDER BY COALESCE(kr.recorded_at, kr.result_date::timestamp) DESC,
                 kr.kpi_result_id DESC
        LIMIT 1
      ) kr ON TRUE
      ${whereClause}
      ORDER BY gap DESC
      LIMIT 10
      `,
      params
    );

    res.json({
      summary: summaryResult.rows[0] || {
        total_units: 0,
        total_kpis: 0,
        achievement_rate: 0,
        critical_kpis: 0,
      },
      performanceByDepartment: performanceResult.rows,
      targetVsActual: targetVsActualResult.rows,
      trend: trendResult.rows,
      statusDistribution: statusResult.rows,
      topRisks: topRisksResult.rows,
    });
  } catch (error) {
    console.error("GET /api/ceo-kpi/dashboard error:", error);
    res.status(500).json({ error: "Failed to load CEO KPI dashboard" });
  }
});
// JSON equivalent of the original GET /ceo-report/plants/:plantId HTML preview
// page, for the React frontend (Etape 2) -- returns the report data instead of
// rendering generateManagerReportHtml() server-side.
//
// Deliberate deviation from the original: the default week (when none is
// given) now uses getCurrentFormWeek() -- the same Friday-cutover-aware
// "most recently submittable week" the KPI entry form defaults to -- instead
// of the original's raw getCurrentWeek(). The original's plain calendar week
// has no submitted data until the Friday cutover, so browsing this route
// without an explicit ?week= 404s for every plant on Sun-Thu; the original
// was never hit this way (only via generated report links that always
// carried an explicit week), so this bug never showed up until this route
// got a real UI entry point (the Responsible dashboard's Report Dashboard
// link).
// Latest weekly period ("YYYY-WeekNN") that has a numeric KPI result for the
// plant, using the same plant scoping as getDepartmentKPIReport(). Monthly
// periods ("2026-10", "Oct 2026") are skipped: they would show only the
// monthly KPIs under a "Current Week" label.
const getLatestReportWeekForPlant = async (plantId) => {
  const result = await pool.query(
    `
    SELECT kr.week
    FROM public.kpi_target_allocation kta
    LEFT JOIN public.people owner
      ON owner.people_id = COALESCE(kta.created_by_people_id, kta.set_by_people_id)
    JOIN public.kpi_result kr
      ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
    WHERE COALESCE(kta.plant_id, owner.work_at_unit_id) = $1
      AND kr.week ~ '^[0-9]{4}-Week[0-9]{1,2}$'
      AND kr.raw_value IS NOT NULL
      AND CAST(kr.raw_value AS TEXT) ~ '^[0-9.]+$'
    ORDER BY
      SPLIT_PART(kr.week, '-Week', 1)::integer DESC,
      SPLIT_PART(kr.week, '-Week', 2)::integer DESC
    LIMIT 1
    `,
    [plantId]
  );
  return result.rows[0]?.week || null;
};

router.get("/api/ceo-report/plants/:plantId", async (req, res) => {
  try {
    const plantId = normalizeOptionalIntegerInput(req.params.plantId);

    if (!plantId) {
      return res.status(400).json({ error: "Invalid plantId" });
    }

    // Without an explicit ?week=, show the latest week that has data for this
    // plant: the current form week has no results until people submit it.
    const reportWeek =
      normalizeOptionalTextInput(req.query?.week) ||
      (await getLatestReportWeekForPlant(plantId)) ||
      getCurrentFormWeek();

    const reportData = await getDepartmentKPIReport(plantId, reportWeek);
    if (!reportData || reportData.stats.totalKPIs === 0) {
      return res.status(404).json({
        error: "No KPI report data available for this plant and week."
      });
    }

    res.json({
      ...reportData,
      deliveryRecipient: CEO_REPORT_RECIPIENT_EMAIL
    });
  } catch (error) {
    console.error("CEO report preview error:", error.message);
    res.status(500).json({ error: "Failed to generate CEO report preview." });
  }
});

router.post("/api/ceo-report/plants/:plantId/send", async (req, res) => {
  try {
    const plantId = normalizeOptionalIntegerInput(req.params.plantId);
    const reportWeek =
      normalizeOptionalTextInput(req.body?.week ?? req.query?.week) ||
      getCurrentFormWeek();

    if (!plantId) {
      return res.status(400).json({ error: "Invalid plantId" });
    }

    const result = await sendDepartmentKPIReportEmail(plantId, reportWeek);
    if (!result) {
      return res.status(404).json({
        error: "No KPI report data available for this plant and week."
      });
    }

    res.json({
      success: true,
      plant_id: plantId,
      week: result.week,
      recipient_email: result.recipientEmail
    });
  } catch (error) {
    console.error("CEO report send error:", error.message);
    res.status(500).json({ error: "Failed to send CEO report email." });
  }
});

router.get("/api/hierarchy-report/send", triggerHierarchyReportNow);
router.post("/api/hierarchy-report/send", triggerHierarchyReportNow);

module.exports = router;
