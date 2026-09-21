const express = require("express");
const router = express.Router();
const fs = require("fs");
const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { createHttpError } = require("../utils/httpError");
const {
  loadKpiRowsForUi,
  loadSubjectHierarchyData,
  getPeopleDisplayName,
  getKpiDisplayFileName,
  getKpiStoredFileName,
  prepareKpiWritePayload,
  resolveSubjectIdForKpiPayload,
  upsertPrimarySubjectKpiLink,
  deleteKpiDependentRecords,
} = require("../models/kpi.model");
const {
  ensureKpiRatioSchema,
  refreshKpiKnowledgeBaseForKpiId,
  ensureKpiAssistantConversationSchema,
} = require("../services/kpiKnowledgeBase.service");
const {
  resolveStoredKpiFileAbsolutePath,
  writeUploadedKpiFile,
  copyExistingKpiFile,
  deleteStoredKpiFile,
} = require("../services/kpiFile.service");

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

router.get("/api/kpis/:id/file/:fileName?", async (req, res) => {
  try {
    await ensureKpiRatioSchema();

    const kpiId = normalizeOptionalIntegerInput(req.params.id);
    if (!kpiId) {
      return res.status(400).json({ error: "KPI ID is invalid." });
    }

    const result = await pool.query(
      `
      SELECT file
      FROM public.kpi
      WHERE kpi_id = $1
      LIMIT 1
      `,
      [kpiId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "KPI not found" });
    }

    const storedFilePath = normalizeOptionalTextInput(result.rows[0].file);
    if (!storedFilePath) {
      return res.status(404).json({ error: "No file is attached to this KPI." });
    }

    if (/^(https?:)?\/\//i.test(storedFilePath)) {
      return res.redirect(storedFilePath);
    }

    const absolutePath = resolveStoredKpiFileAbsolutePath(storedFilePath);
    if (!absolutePath) {
      return res.status(404).json({ error: "Stored KPI file path is invalid." });
    }

    await fs.promises.access(absolutePath, fs.constants.F_OK);
    return res.download(
      absolutePath,
      getKpiDisplayFileName(storedFilePath) || getKpiStoredFileName(storedFilePath) || "kpi-file"
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return res.status(404).json({ error: "KPI file not found on server." });
    }

    console.error("GET /api/kpis/:id/file error:", error.message);
    return res.status(500).json({ error: "Failed to download KPI file" });
  }
});

router.post("/api/kpis/:id/knowledge-base/refresh", async (req, res) => {
  try {
    await ensureKpiRatioSchema();

    const kb = await refreshKpiKnowledgeBaseForKpiId(pool, req.params.id, {
      reason: "manual_refresh"
    });

    if (!kb) {
      return res.status(404).json({ error: "KPI not found" });
    }

    res.json(kb);
  } catch (error) {
    console.error("Refresh KPI knowledge base error:", error);
    res.status(500).json({ error: "Failed to refresh KPI knowledge base" });
  }
});

router.post("/api/kpis", async (req, res) => {
  let client;
  let uploadedFileStoredPath = null;

  try {
    await ensureKpiRatioSchema();
    const {
      subject_id,
      kpi_name,
      kpi_sub_title,
      kpi_code,
      kpi_formula,
      unit,
      kpi_explanation,
      frequency,
      target_value,
      target_direction,
      tolerance_type,
      up_tolerance,
      low_tolerance,
      max_value,
      min_value,
      min_type,
      max_type,
      nombre_periode,
      calculation_on,
      calculation_mode,
      display_trend,
      regression,
      reference_kpi_id,
      target_auto_adjustment,
      reactivity_status,
      importance,
      pricing_type,
      reactivity_need,
      owner_role_id,
      status,
      comments,
      high_limit,
      low_limit,
      kfs,
      file_upload,
      file_source_path,
      file_source_name
    } = prepareKpiWritePayload(req.body);
    const createdByPeopleId = normalizeOptionalIntegerInput(req.body.created_by_people_id);
    const resolvedSubjectId = await resolveSubjectIdForKpiPayload({
      subject_id,
      subject: req.body.subject
    });

 if (!resolvedSubjectId && !req.body.is_duplicate) {
  throw createHttpError(400, "Subject selection is required.");
  }

    client = await pool.connect();
    await client.query("BEGIN");

    const result = await client.query(
      `
      INSERT INTO public.kpi (
        kpi_name,
        kpi_sub_title,
        kpi_code,
        kpi_formula,
        unit,
        kpi_explanation,
        frequency,
        target_value,
        target_direction,
        tolerance_type,
        up_tolerance,
        low_tolerance,
        max_value,
        min_value,
        min_type,
        max_type,
        nombre_periode,
        calculation_on,
        calculation_mode,
        reference_kpi_id,
        target_auto_adjustment,
        reactivity_status,
        importance,
        pricing_type,
        reactivity_need,
        display_trend,
        regression,
        owner_role_id,
        status,
        comments,
        high_limit,
        low_limit,
        created_by_people_id,
        kfs
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
      )
      RETURNING *;
      `,
      [
        kpi_name,
        kpi_sub_title,
        kpi_code,
        kpi_formula,
        unit,
        kpi_explanation,
        frequency,
        target_value,
        target_direction,
        tolerance_type,
        up_tolerance,
        low_tolerance,
        max_value,
        min_value,
        min_type,
        max_type,
        nombre_periode,
        calculation_on,
        calculation_mode,
        reference_kpi_id,
        target_auto_adjustment,
        reactivity_status,
        importance,
        pricing_type,
        reactivity_need,
        display_trend,
        regression,
        owner_role_id,
        status,
        comments,
        high_limit,
        low_limit,
        createdByPeopleId,
        kfs
      ]
    );

    const newKpi = result.rows[0];
    const fileAttachment =
      file_upload
        ? await writeUploadedKpiFile(newKpi.kpi_id, file_upload)
        : await copyExistingKpiFile(newKpi.kpi_id, file_source_path, {
          preferredFileName: file_source_name
        });

    if (fileAttachment) {
      uploadedFileStoredPath = fileAttachment.stored_path;
      await client.query(
        `
        UPDATE public.kpi
        SET file = $1
        WHERE kpi_id = $2
        `,
        [fileAttachment.stored_path, newKpi.kpi_id]
      );
    }
    if (resolvedSubjectId) {
    await upsertPrimarySubjectKpiLink(
      client,
      newKpi.kpi_id,
      resolvedSubjectId
     );
   }
    await refreshKpiKnowledgeBaseForKpiId(client, newKpi.kpi_id, {
      reason: "kpi_created"
    });

    await client.query("COMMIT");
    const rows = await loadKpiRowsForUi({ kpiId: newKpi.kpi_id });
    res.status(201).json(rows[0] || newKpi);
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    if (uploadedFileStoredPath) {
      await deleteStoredKpiFile(uploadedFileStoredPath);
    }
    console.error("POST /api/kpis error:", err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "Failed to create KPI" });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.put("/api/kpis/:id", async (req, res) => {
  let client;
  let uploadedFileStoredPath = null;
  let replacedFilePath = null;

  try {
    await ensureKpiRatioSchema();
    const {
      subject_id,
      kpi_name,
      kpi_sub_title,
      kpi_code,
      kpi_formula,
      unit,
      kpi_explanation,
      frequency,
      target_value,
      target_direction,
      tolerance_type,
      up_tolerance,
      low_tolerance,
      max_value,
      min_value,
      min_type,
      max_type,
      nombre_periode,
      calculation_on,
      calculation_mode,
      display_trend,
      regression,
      reference_kpi_id,
      target_auto_adjustment,
      reactivity_status,
      importance,
      pricing_type,
      reactivity_need,
      owner_role_id,
      status,
      comments,
      high_limit,
      low_limit,
      kfs,
      file_upload,
      file_source_path,
      file_source_name
    } = prepareKpiWritePayload(req.body);
    const resolvedSubjectId = await resolveSubjectIdForKpiPayload({
      subject_id,
      subject: req.body.subject
    });

    if (!resolvedSubjectId) {
      throw createHttpError(400, "Subject selection is required.");
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const existingKpiResult = await client.query(
      `
      SELECT file
      FROM public.kpi
      WHERE kpi_id = $1
      FOR UPDATE
      `,
      [req.params.id]
    );

    if (!existingKpiResult.rows.length) {
      await client.query("ROLLBACK").catch(() => { });
      return res.status(404).json({ error: "KPI not found" });
    }

    const existingFilePath = normalizeOptionalTextInput(existingKpiResult.rows[0].file);
    let nextFilePath = existingFilePath;

    if (file_upload) {
      const savedFile = await writeUploadedKpiFile(req.params.id, file_upload);
      if (savedFile) {
        uploadedFileStoredPath = savedFile.stored_path;
        nextFilePath = savedFile.stored_path;
        replacedFilePath = existingFilePath;
      }
    }

    const result = await client.query(
      `
      UPDATE public.kpi
      SET
        kpi_name = $1,
        kpi_sub_title = $2,
        kpi_code = $3,
        kpi_formula = $4,
        unit = $5,
        kpi_explanation = $6,
        frequency = $7,
        target_value = $8,
        target_direction = $9,
        tolerance_type = $10,
        up_tolerance = $11,
        low_tolerance = $12,
        max_value = $13,
        min_value = $14,
        min_type = $15,
        max_type = $16,
        nombre_periode = $17,
        calculation_on = $18,
        calculation_mode = $19,
        display_trend = $20,
        regression = $21,
        reference_kpi_id = $22,
        target_auto_adjustment = $23,
        owner_role_id = $24,
        status = $25,
        comments = $26,
        high_limit = $27,
        low_limit = $28,
        reactivity_status = $29,
        importance = $30,
        pricing_type = $31,
        reactivity_need = $32,
        kfs = $33,
        file = $34,
        updated_at = NOW()
      WHERE kpi_id = $35
      RETURNING *;
      `,
      [
        kpi_name,
        kpi_sub_title,
        kpi_code,
        kpi_formula,
        unit,
        kpi_explanation,
        frequency,
        target_value,
        target_direction,
        tolerance_type,
        up_tolerance,
        low_tolerance,
        max_value,
        min_value,
        min_type,
        max_type,
        nombre_periode,
        calculation_on,
        calculation_mode,
        display_trend,
        regression,
        reference_kpi_id,
        target_auto_adjustment,
        owner_role_id,
        status,
        comments,
        high_limit,
        low_limit,
        reactivity_status,
        importance,
        pricing_type,
        reactivity_need,
        kfs,
        nextFilePath,
        req.params.id
      ]
    );

    await upsertPrimarySubjectKpiLink(client, Number(req.params.id), resolvedSubjectId);
    await refreshKpiKnowledgeBaseForKpiId(client, Number(req.params.id), {
      reason: "kpi_updated"
    });
    await client.query("COMMIT");

    if (replacedFilePath && replacedFilePath !== nextFilePath) {
      await deleteStoredKpiFile(replacedFilePath);
    }

    const rows = await loadKpiRowsForUi({ kpiId: Number(req.params.id) });
    res.json(rows[0] || result.rows[0]);
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    if (uploadedFileStoredPath) {
      await deleteStoredKpiFile(uploadedFileStoredPath);
    }
    console.error("PUT /api/kpis/:id error:", err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "Failed to update KPI" });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.delete("/api/kpis/:id", async (req, res) => {
  let client;
  let deletedFilePath = null;

  try {
    await ensureKpiAssistantConversationSchema();
    client = await pool.connect();
    await client.query("BEGIN");

    await deleteKpiDependentRecords(client, req.params.id);

    const result = await client.query(
      `DELETE FROM public.kpi WHERE kpi_id = $1 RETURNING kpi_id, file`,
      [req.params.id]
    );

    if (!result.rows.length) {
      await client.query("ROLLBACK").catch(() => { });
      return res.status(404).json({ error: "KPI not found" });
    }

    deletedFilePath = normalizeOptionalTextInput(result.rows[0].file);
    await client.query("COMMIT");
    if (deletedFilePath) {
      await deleteStoredKpiFile(deletedFilePath);
    }
    res.json({ success: true });
  } catch (err) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    console.error("DELETE /api/kpis/:id error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;
