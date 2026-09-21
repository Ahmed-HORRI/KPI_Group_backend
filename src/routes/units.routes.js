const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");

const countryCodes = {
  Tunisia: "TN",
  France: "FR",
  Germany: "DE",
  India: "IN",
  China: "CN",
  Mexico: "MX",
  Luxembourg: "LU",
  "South Korea": "KR"
};

router.get("/api/units/countries", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT country, COUNT(*)::int AS unit_count
      FROM public.unit
      WHERE country IS NOT NULL
        AND TRIM(country) <> ''
        AND status_id = 1
      GROUP BY country
      ORDER BY country
    `);

    res.json(result.rows.map(row => ({
      country: row.country,
      country_code: countryCodes[row.country] || null,
      unit_count: row.unit_count
    })));
  } catch (err) {
    console.error("GET /api/units/countries error:", err);
    res.status(500).json({ error: "Failed to load countries" });
  }
});

router.get("/api/units/tree", async (req, res) => {
  try {
    const { country, parent_unit_id } = req.query;

    const params = [];
    let where = "u.status_id = 1";

    if (country && !parent_unit_id) {
      params.push(country);
      where += `
        AND u.country = $${params.length}
        AND NOT EXISTS (
          SELECT 1
          FROM public.unit parent
          WHERE parent.unit_id = u.parent_unit_id
            AND parent.country = u.country
        )
      `;
    }

    if (parent_unit_id) {
      params.push(Number(parent_unit_id));
      where += ` AND u.parent_unit_id = $${params.length}`;
    }

    const result = await pool.query(`
      SELECT
        u.unit_id,
        u.parent_unit_id,
        u.unit_name,
        u.unit_short_name,
        u.country,
        u.city,
        u.unit_type_id,
        ut.unit_type_name,
        EXISTS (
          SELECT 1
          FROM public.unit child
          WHERE child.parent_unit_id = u.unit_id
            AND child.status_id = 1
        ) AS has_children
      FROM public.unit u
      LEFT JOIN public.unit_type ut
        ON ut.unit_type_id = u.unit_type_id
      WHERE ${where}
      ORDER BY u.unit_name
    `, params);

    res.json(result.rows.map(row => ({
      ...row,
      country_code: countryCodes[row.country] || null
    })));
  } catch (err) {
    console.error("GET /api/units/tree error:", err);
    res.status(500).json({ error: "Failed to load unit tree" });
  }
});


router.get("/api/units/:unitId/people-kpis", async (req, res) => {
  try {
    const { unitId } = req.params;
    const { week } = req.query;

    const result = await pool.query(`
      SELECT
        v.people_id,
        v.employee_name AS people_name,
        v.role_id,
        v.role_name,
        v.department_id,
        v.department_name,

        kta.kpi_target_allocation_id,
        k.kpi_id,
        k.kpi_name,
        k.kpi_sub_title AS indicator_title,
        k.frequency,

        kta.target_value AS target,
        kr.kpi_result_id AS result_id,
        kr.raw_value AS value,
        kr.result_status AS status

      FROM public.v_people_department v

      LEFT JOIN public.kpi_target_allocation kta
        ON kta.set_by_people_id = v.people_id

      LEFT JOIN public.kpi k
        ON k.kpi_id = kta.kpi_id

      LEFT JOIN public.kpi_result kr
        ON kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
       AND ($2::text IS NULL OR kr.week = $2)

      WHERE v.department_id = $1::int

      ORDER BY v.employee_name, k.kpi_name
    `, [unitId, week || null]);

    const peopleMap = new Map();

    result.rows.forEach(row => {
      if (!peopleMap.has(row.people_id)) {
        peopleMap.set(row.people_id, {
          people_id: row.people_id,
          people_name: row.people_name,
          role_id: row.role_id,
          role_name: row.role_name,
          department_id: row.department_id,
          department_name: row.department_name,
          kpis: []
        });
      }

      if (row.kpi_id) {
        peopleMap.get(row.people_id).kpis.push({
          kpi_target_allocation_id: row.kpi_target_allocation_id,
          kpi_id: row.kpi_id,
          kpi_name: row.kpi_name,
          indicator_title: row.indicator_title,
          frequency: row.frequency,
          target: row.target,
          value: row.value,
          status: row.status,
          result_id: row.result_id
        });
      }
    });

    res.json([...peopleMap.values()]);
  } catch (err) {
    console.error("GET /api/units/:unitId/people-kpis error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
