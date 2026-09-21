const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { loadKpiRowsForUi, loadSubjectHierarchyData, getPeopleDisplayName } = require("../models/kpi.model");
const { ensureKpiRatioSchema } = require("../services/kpiKnowledgeBase.service");

router.get("/api/kpis", async (req, res) => {
  try {
    await ensureKpiRatioSchema();

    const searchText = normalizeOptionalTextInput(req.query.search) || "";

    const result = await pool.query(
      `
      SELECT
        k.kpi_id,
        k.kpi_name,
        k.kpi_sub_title,
        k.kpi_code,
        k.unit,
        k.target_value,
        k.status,
        primary_subject.subject_id
      FROM public.kpi k
      LEFT JOIN LATERAL (
        SELECT sk.subject_id
        FROM public.subject_kpi sk
        WHERE sk.kpi_id = k.kpi_id
        ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
        LIMIT 1
      ) primary_subject ON TRUE
      WHERE
        $1 = ''
        OR COALESCE(k.kpi_name, '') ILIKE $2
        OR COALESCE(k.kpi_sub_title, '') ILIKE $2
        OR COALESCE(k.kpi_code, '') ILIKE $2
      ORDER BY k.kpi_name ASC
      `,
      [searchText, `%${searchText}%`]
    );

    const subjectHierarchy = await loadSubjectHierarchyData();

    res.json(result.rows.map((row) => ({
      kpi_id: row.kpi_id,
      kpi_name: row.kpi_name || "",
      indicator_sub_title: row.kpi_name || "",
      indicator_title: row.kpi_sub_title || "",
      kpi_code: row.kpi_code || "",
      unit: row.unit || "",
      target: row.target_value,
      status: row.status || "Active",
      subject: row.subject_id
        ? subjectHierarchy.pathById.get(String(row.subject_id)) || "Other KPIs"
        : "Other KPIs"
    })));
  } catch (err) {
    console.error("GET /api/kpis error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/kpis/:id", async (req, res) => {
  try {
    await ensureKpiRatioSchema();
    const rows = await loadKpiRowsForUi({ kpiId: Number(req.params.id) });

    if (!rows.length) {
      return res.status(404).json({ error: "KPI not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/kpis/:id error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/manufacturing-strategy/zone", async (req, res) => {
  const { unit_id, product_id } = req.query;

  if (!unit_id || !product_id) {
    return res.json({ zones: [] });
  }

  try {
    const result = await pool.query(
      `
      SELECT DISTINCT
        ms.zone_id,
        z.zone_name,
        zone_responsible.people_id AS responsible_people_id,
        zone_responsible.name AS responsible_name,
        zone_responsible.first_name AS responsible_first_name
      FROM public.manufacturing_strategy ms
      LEFT JOIN public.zone z
        ON z.zone_id = ms.zone_id
      LEFT JOIN LATERAL (
        SELECT
          pra.people_id,
          p.name,
          p.first_name
        FROM public.people_role_assignment pra
        LEFT JOIN public.people p
          ON p.people_id = pra.people_id
        WHERE pra.zone_id = ms.zone_id
          AND pra.assignment_status = 'ACTIVE'
        ORDER BY COALESCE(pra.is_primary, false) DESC, pra.assignment_id DESC
        LIMIT 1
      ) zone_responsible ON TRUE
      WHERE ms.plant_id = $1
        AND ms.product_id = $2
        AND ms.strategy_status = 'active'
        AND ms.zone_id IS NOT NULL
      ORDER BY z.zone_name, ms.zone_id
      `,
      [unit_id, product_id]
    );

    res.json({
      zones: result.rows.map((row) => ({
        zone_id: row.zone_id,
        zone_name: row.zone_name || `Zone ${row.zone_id}`,
        responsible_people_id: normalizeOptionalIntegerInput(row.responsible_people_id),
        responsable_zone: getPeopleDisplayName({
          name: row.responsible_name,
          first_name: row.responsible_first_name
        }) || ""
      }))
    });
  } catch (err) {
    console.error("manufacturing-strategy/zone error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
