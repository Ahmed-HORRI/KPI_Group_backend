const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");

router.get("/api/statistics/summary", async (req, res) => {
  try {
    const { week } = req.query;

    const result = await pool.query(`
      WITH fulfilled_kpis AS (
        SELECT
          v.people_id,
          v.department_id,
          kr.kpi_result_id
        FROM public.v_people_department v
        JOIN public.kpi_target_allocation kta
          ON kta.set_by_people_id = v.people_id
        JOIN public.kpi_result kr
          ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
         AND ($1::text IS NULL OR kr.week = $1)
        WHERE kr.raw_value IS NOT NULL
      )
      SELECT
        (SELECT COUNT(*)::int FROM public.unit WHERE status_id = 1) AS total_units,
        (SELECT COUNT(*)::int FROM public.unit WHERE status_id = 1 AND unit_type_id = 5) AS total_departments,
        COUNT(DISTINCT people_id)::int AS responsible_people,
        COUNT(kpi_result_id)::int AS fulfilled_kpis
      FROM fulfilled_kpis
    `, [week || null]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /api/statistics/summary error:", err);
    res.status(500).json({ error: err.message });
  }
});


// 2) Chart 1: KPIs by Unit
router.get("/api/statistics/kpis-by-unit", async (req, res) => {
  try {
    const { week } = req.query;

    const result = await pool.query(`
      SELECT
        factory.unit_id,
        factory.unit_name,
        factory.country,
        COUNT(kr.kpi_result_id)::int AS kpi_count
      FROM public.v_people_department v
      JOIN public.unit factory
        ON factory.unit_id = v.factory_id
      JOIN public.kpi_target_allocation kta
        ON kta.set_by_people_id = v.people_id
      JOIN public.kpi_result kr
        ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
       AND ($1::text IS NULL OR kr.week = $1)
      WHERE kr.raw_value IS NOT NULL
      GROUP BY factory.unit_id, factory.unit_name, factory.country
      ORDER BY kpi_count DESC, factory.unit_name
    `, [week || null]);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/statistics/kpis-by-unit error:", err);
    res.status(500).json({ error: err.message });
  }
});


// 3) Chart 2: KPI Values by Department
router.get("/api/statistics/kpi-values-by-department", async (req, res) => {
  try {
    const { week } = req.query;

    const result = await pool.query(`
      SELECT
        v.department_id,
        v.department_name,
        COUNT(kr.kpi_result_id)::int AS kpi_count,
        SUM(NULLIF(kr.raw_value::text, '')::numeric) AS total_value,
        AVG(NULLIF(kr.raw_value::text, '')::numeric) AS avg_value
      FROM public.v_people_department v
      JOIN public.kpi_target_allocation kta
        ON kta.set_by_people_id = v.people_id
      JOIN public.kpi_result kr
        ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
       AND ($1::text IS NULL OR kr.week = $1)
      WHERE kr.raw_value IS NOT NULL
        AND v.department_id IS NOT NULL
      GROUP BY v.department_id, v.department_name
      ORDER BY total_value DESC NULLS LAST
    `, [week || null]);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/statistics/kpi-values-by-department error:", err);
    res.status(500).json({ error: err.message });
  }
});


// 4) Chart 3: KPI Count by Responsible
router.get("/api/statistics/kpi-count-by-responsible", async (req, res) => {
  try {
    const { week } = req.query;

    const result = await pool.query(`
      SELECT
        v.people_id,
        v.employee_name AS people_name,
        v.role_name,
        v.department_name,
        COUNT(kr.kpi_result_id)::int AS kpi_count
      FROM public.v_people_department v
      JOIN public.kpi_target_allocation kta
        ON kta.set_by_people_id = v.people_id
      JOIN public.kpi_result kr
        ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
       AND ($1::text IS NULL OR kr.week = $1)
      WHERE kr.raw_value IS NOT NULL
      GROUP BY v.people_id, v.employee_name, v.role_name, v.department_name
      ORDER BY kpi_count DESC, v.employee_name
      LIMIT 25
    `, [week || null]);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/statistics/kpi-count-by-responsible error:", err);
    res.status(500).json({ error: err.message });
  }
});


// 5) Chart 4: KPI Target vs Value
router.get("/api/statistics/kpi-target-vs-value", async (req, res) => {
  try {
    const { week, unit_id, department_id, kpi_id } = req.query;

    const toNullableInt = (value) => {
      const text = String(value ?? "").trim();
      if (!text || text.toLowerCase() === "nan") return null;

      const number = Number(text);
      return Number.isInteger(number) && number > 0 ? number : null;
    };

    const unitId = toNullableInt(unit_id);
    const departmentId = toNullableInt(department_id);
    const kpiId = toNullableInt(kpi_id);

    const result = await pool.query(
      `
      SELECT
        factory.unit_id,
        factory.unit_name,
        v.department_id,
        v.department_name,
        k.kpi_id,
        k.kpi_name,
        v.people_id,
        v.employee_name AS people_name,
        kr.week,
        kr.week AS period_value,
        NULLIF(kta.target_value::text, '')::numeric AS target,
        NULLIF(kr.raw_value::text, '')::numeric AS value
      FROM public.v_people_department v
      JOIN public.unit factory
        ON factory.unit_id = v.factory_id
      JOIN public.kpi_target_allocation kta
        ON kta.set_by_people_id = v.people_id
      JOIN public.kpi k
        ON k.kpi_id = kta.kpi_id
      JOIN public.kpi_result kr
        ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
      WHERE kr.raw_value IS NOT NULL
        AND ($1::text IS NULL OR kr.week = $1)
        AND ($2::int IS NULL OR v.factory_id = $2)
        AND ($3::int IS NULL OR v.department_id = $3)
        AND ($4::int IS NULL OR k.kpi_id = $4)
      ORDER BY v.employee_name, k.kpi_name
      `,
      [
        week || null,
        unitId,
        departmentId,
        kpiId
      ]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/statistics/kpi-target-vs-value error:", err);
    res.status(500).json({ error: err.message });
  }
});


// 6) Chart 5: Department Distribution Pie Chart
router.get("/api/statistics/department-distribution", async (req, res) => {
  try {
    const { week } = req.query;

    const result = await pool.query(`
      SELECT
        v.department_id,
        v.department_name,
        COUNT(kr.kpi_result_id)::int AS value
      FROM public.v_people_department v
      JOIN public.kpi_target_allocation kta
        ON kta.set_by_people_id = v.people_id
      JOIN public.kpi_result kr
        ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
       AND ($1::text IS NULL OR kr.week = $1)
      WHERE kr.raw_value IS NOT NULL
        AND v.department_id IS NOT NULL
      GROUP BY v.department_id, v.department_name
      ORDER BY value DESC
    `, [week || null]);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/statistics/department-distribution error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
