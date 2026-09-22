const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const {
  normalizeOptionalTextInput,
  normalizeOptionalIntegerInput,
  normalizeOptionalNumericInput,
} = require("../utils/normalize");
const { createHttpError } = require("../utils/httpError");
const {
  loadKpiRowsForUi,
  prepareKpiWritePayload,
  resolveSubjectIdForKpiPayload,
  upsertPrimarySubjectKpiLink,
  annotateOwnedKpisForResponsible,
  deleteKpiDependentRecords,
} = require("../models/kpi.model");
const {
  resolveResponsiblePeopleId,
  resolveResponsibleOwnerContext,
  loadFormResponsibleContext,
} = require("../models/responsible.model");
const { formatIsoDateValue } = require("../utils/weekPeriod");
const {
  buildKpiFormUrl,
  sanitizeKpiFormReturnUrl,
  deriveKpiResultDate,
  deriveKpiResultPeriodType,
  resolveRecordedByPeopleId,
  getDashboardSubmissionStatus,
  normalizeText,
  normalizeCorrectiveActionEstimatedDurationDays,
  normalizeCorrectiveActionImportance,
  normalizeCorrectiveActionUrgency,
  isPercentageUnit,
  normalizeMetricNumberByUnit,
} = require("../services/kpiShared.service");
const { getCurrentFormWeek } = require("../services/ceoReportGeneration.service");
const {
  canUseActionPlanCorrectiveActions,
  syncActionPlanCorrectiveActionsForPeriod,
} = require("../services/actionPlan.service");
const {
  evaluateAndCreateKpiTargetAdjustmentProposal,
  sendKpiTargetAdjustmentApprovalEmail,
} = require("../services/kpiTargetAdjustment.service");
const {
  ensureKpiRatioSchema,
  ensureKpiAssistantConversationSchema,
  refreshKpiKnowledgeBaseForKpiId,
  refreshKpiKnowledgeBases,
} = require("../services/kpiKnowledgeBase.service");
const {
  writeUploadedKpiFile,
  copyExistingKpiFile,
  deleteStoredKpiFile,
} = require("../services/kpiFile.service");
const {
  enrichIndividualAllocationScope,
  ensureKpiObjectSchema,
  loadKpiTargetAllocationRowsForUi,
  buildPreparedKpiObjectRows,
  getKpiObjectInsertValues,
  getKpiTargetAllocationScopeKey,
  getKpiTargetAllocationScopeIdentifier,
  getKpiTargetAllocationGroupIds,
  loadKpiTargetAllocationGroupRowsForUi,
  loadKpiTargetAllocationFamilyRowsForUi,
  loadKpiTargetAllocationRowsByIdsForUi,
} = require("../services/kpiTargetAllocation.service");
const { deleteKpiTargetAllocationDependentRecords } = require("../models/kpi.model");
const {
  ensureResponsibleParameterKpiSchema,
  prepareResponsibleParameterKpiPayload,
} = require("../services/responsibleParameterKpi.service");

router.get("/api/responsibles/:responsibleId/kpi-graphs", async (req, res) => {
  const { responsibleId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
          k.kpi_id,
          k.indicator_title,
          k.indicator_sub_title,
          kv.week,
          kv.value
      FROM public.kpi_values kv
      JOIN public."Kpi" k
        ON k.kpi_id = kv.kpi_id
      WHERE kv.responsible_id = $1
      ORDER BY k.kpi_id ASC, kv.week ASC
      `,
      [responsibleId]
    );

    const result1 = await pool.query(
      `SELECT name FROM public."Responsible" WHERE responsible_id = $1`,
      [responsibleId]
    );

    const responsibleName = result1.rows[0]?.name || "Unknown";


    const grouped = {};

    for (const row of result.rows) {
      if (!grouped[row.kpi_id]) {
        grouped[row.kpi_id] = {
          kpi_id: row.kpi_id,
          indicator_title: row.indicator_title,
          indicator_sub_title: row.indicator_sub_title,
          labels: [],
          values: [],
          targetValue: row.target !== null ? Number(row.target) : null,
          highLimitValue: row.high_limit !== null ? Number(row.high_limit) : null,
          lowLimitValue: row.low_limit !== null ? Number(row.low_limit) : null
        };
      }

      grouped[row.kpi_id].labels.push(row.month_label);
      grouped[row.kpi_id].values.push(Number(row.new_value_num) || 0);
    }

    res.json(Object.values(grouped));
  } catch (error) {
    console.error("GET KPI graphs error:", error);
    res.status(500).json({ error: "Failed to load KPI graph data" });
  }
});

router.post("/api/responsibles/:responsibleId/kpis", async (req, res) => {
  const { responsibleId } = req.params;
  let client;
  let uploadedFileStoredPath = null;

  try {
    await ensureKpiRatioSchema();
    const responsiblePeopleId = await resolveResponsiblePeopleId(responsibleId);
    const createdByPeopleId =
      normalizeOptionalIntegerInput(req.body.created_by_people_id) ||
      responsiblePeopleId;

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
      nombre_periode,
      calculation_mode,
      display_trend,
      regression,
      min_type,
      max_type,
      calculation_on,
      target_auto_adjustment,
      reactivity_status,
      importance,
      pricing_type,
      reactivity_need,
      reference_kpi_id,
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

if (!resolvedSubjectId && !req.body.is_duplicate) {
  throw createHttpError(400, "Subject selection is required.");
}

    client = await pool.connect();
    await client.query("BEGIN");

    const insertKpi = await client.query(
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
  nombre_periode,
  calculation_mode,
  display_trend,
  regression,
  min_type,
  max_type,
  calculation_on,
  target_auto_adjustment,
  reactivity_status,
  importance,
  pricing_type,
  reactivity_need,
  reference_kpi_id,
  owner_role_id,
  status,
  comments,
  high_limit,
  low_limit,
  created_by_people_id,
  kfs
)
VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8,
  $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34
)
      RETURNING *
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
        nombre_periode,
        calculation_mode,
        display_trend,
        regression,
        min_type,
        max_type,
        calculation_on,
        target_auto_adjustment,
        reactivity_status,
        importance,
        pricing_type,
        reactivity_need,
        reference_kpi_id,
        owner_role_id,
        status,
        comments,
        high_limit,
        low_limit,
        createdByPeopleId,
        kfs
      ]
    );

    const newKpi = insertKpi.rows[0];
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
      reason: "responsible_kpi_created"
    });


    await client.query("COMMIT");
    const rows = await loadKpiRowsForUi({
      kpiId: newKpi.kpi_id,
      responsibleId: createdByPeopleId
    });
    res.status(201).json(rows[0] || newKpi);
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    if (uploadedFileStoredPath) {
      await deleteStoredKpiFile(uploadedFileStoredPath);
    }
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Failed to create KPI" });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.get("/api/responsibles/:responsibleId/kpis", async (req, res) => {
  const { responsibleId } = req.params;
  try {
    await ensureKpiRatioSchema();
    const includeAll = String(req.query.include_all || "").trim() === "1";
    const responsiblePeopleId = await resolveResponsiblePeopleId(responsibleId);
    if (!includeAll && !responsiblePeopleId) {
      throw createHttpError(400, "Responsible owner is invalid.");
    }
    const rows = await loadKpiRowsForUi({
      search: req.query.search || "",
      responsibleId: includeAll ? null : responsiblePeopleId
    });
    res.json(annotateOwnedKpisForResponsible(rows, responsiblePeopleId));
  } catch (error) {
    console.error("GET /api/responsibles/:responsibleId/kpis error:", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to load KPIs"
    });
  }
});

router.get("/api/responsibles/:responsibleId/kpis/:kpiId", async (req, res) => {
  const { responsibleId, kpiId } = req.params;

  try {
    await ensureKpiRatioSchema();
    const includeAll = String(req.query.include_all || "").trim() === "1";
    const responsiblePeopleId = await resolveResponsiblePeopleId(responsibleId);
    if (!includeAll && !responsiblePeopleId) {
      throw createHttpError(400, "Responsible owner is invalid.");
    }
    const rows = await loadKpiRowsForUi({
      kpiId: Number(kpiId),
      responsibleId: includeAll ? null : responsiblePeopleId
    });

    if (!rows.length) {
      return res.status(404).json({ error: "KPI not found" });
    }

    res.json(annotateOwnedKpisForResponsible(rows, responsiblePeopleId)[0]);
  } catch (error) {
    console.error("GET one KPI error:", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to load KPI"
    });
  }
});

router.put("/api/responsibles/:responsibleId/kpis/:kpiId", async (req, res) => {
  const { responsibleId, kpiId } = req.params;
  let client;
  let uploadedFileStoredPath = null;
  let replacedFilePath = null;

  try {
    await ensureKpiRatioSchema();
    const responsiblePeopleId = await resolveResponsiblePeopleId(responsibleId);

    if (!responsiblePeopleId) {
      throw createHttpError(400, "Responsible owner is invalid.");
    }

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
      nombre_periode,
      calculation_mode,
      display_trend,
      regression,
      min_type,
      max_type,
      calculation_on,
      target_auto_adjustment,
      reactivity_status,
      importance,
      pricing_type,
      reactivity_need,
      kfs,
      reference_kpi_id,
      owner_role_id,
      status,
      comments,
      high_limit,
      low_limit,
      file_upload
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
        AND created_by_people_id = $2
      FOR UPDATE
      `,
      [kpiId, responsiblePeopleId]
    );

    if (!existingKpiResult.rows.length) {
      await client.query("ROLLBACK").catch(() => { });
      return res.status(404).json({ error: "KPI not found" });
    }

    const existingFilePath = normalizeOptionalTextInput(existingKpiResult.rows[0].file);
    let nextFilePath = existingFilePath;

    if (file_upload) {
      const savedFile = await writeUploadedKpiFile(kpiId, file_upload);
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
          nombre_periode = $15,
          calculation_mode = $16,
          display_trend = $17,
          regression = $18,
          min_type = $19,
          max_type = $20,
          calculation_on = $21,
          target_auto_adjustment = $22,
          reference_kpi_id = $23,
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
        AND created_by_people_id = $36
      RETURNING *
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
        nombre_periode,
        calculation_mode,
        display_trend,
        regression,
        min_type,
        max_type,
        calculation_on,
        target_auto_adjustment,
        reference_kpi_id,
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
        kpiId,
        responsiblePeopleId
      ]
    );

    await upsertPrimarySubjectKpiLink(client, Number(kpiId), resolvedSubjectId);
    await refreshKpiKnowledgeBaseForKpiId(client, Number(kpiId), {
      reason: "responsible_kpi_updated"
    });
    await client.query("COMMIT");

    if (replacedFilePath && replacedFilePath !== nextFilePath) {
      await deleteStoredKpiFile(replacedFilePath);
    }

    const rows = await loadKpiRowsForUi({
      kpiId: Number(kpiId),
      responsibleId: responsiblePeopleId
    });
    res.json(rows[0] || result.rows[0]);
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    if (uploadedFileStoredPath) {
      await deleteStoredKpiFile(uploadedFileStoredPath);
    }
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Failed to update KPI" });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.delete("/api/responsibles/:responsibleId/kpis/:kpiId", async (req, res) => {
  const { responsibleId, kpiId } = req.params;
  let client;
  let deletedFilePath = null;

  try {
    await ensureKpiRatioSchema();
    await ensureKpiAssistantConversationSchema();
    const responsiblePeopleId = await resolveResponsiblePeopleId(responsibleId);

    if (!responsiblePeopleId) {
      throw createHttpError(400, "Responsible owner is invalid.");
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const ownedKpiResult = await client.query(
      `
      SELECT kpi_id
      FROM public.kpi
      WHERE kpi_id = $1
        AND created_by_people_id = $2
      LIMIT 1
      `,
      [kpiId, responsiblePeopleId]
    );

    if (!ownedKpiResult.rows.length) {
      await client.query("ROLLBACK").catch(() => { });
      return res.status(404).json({ error: "KPI not found" });
    }

    await deleteKpiDependentRecords(client, kpiId);

    const result = await client.query(
      `
      DELETE FROM public.kpi
      WHERE kpi_id = $1
        AND created_by_people_id = $2
      RETURNING *
      `,
      [kpiId, responsiblePeopleId]
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
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    console.error(error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to delete KPI"
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.get("/api/responsibles/:responsibleId/parameter-kpis", async (req, res) => {
  const { responsibleId } = req.params;

  try {
    await ensureResponsibleParameterKpiSchema();

    const result = await pool.query(
      `
      SELECT
        pk.parameter_kpi_id,
        pk.kpi_id,
        pk.location,
        pk.local_currency,
        pk.value,
        pk.value_date,
        pk.target,
        pk.best_new_target,
        pk.kpi_type,
        pk.created_at,
        pk.updated_at,
        r.name AS responsible_name,
        k.subject AS kpi_subject,
        k.indicator_title AS kpi_group,
        k.indicator_sub_title AS kpi_name
      FROM public.responsible_parameter_kpis pk
      JOIN public."Responsible" r
        ON r.responsible_id = pk.responsible_id
      LEFT JOIN public."Kpi" k
        ON k.kpi_id = pk.kpi_id
      WHERE pk.responsible_id = $1
      ORDER BY pk.created_at DESC, pk.parameter_kpi_id DESC
      `,
      [responsibleId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("GET parameter KPIs error:", error);
    res.status(500).json({ error: "Failed to load parameter KPIs" });
  }
});

router.get("/api/responsibles/:responsibleId/parameter-kpis/:parameterKpiId", async (req, res) => {
  const { responsibleId, parameterKpiId } = req.params;

  try {
    await ensureResponsibleParameterKpiSchema();

    const result = await pool.query(
      `
      SELECT
        pk.parameter_kpi_id,
        pk.kpi_id,
        pk.location,
        pk.local_currency,
        pk.value,
        pk.value_date,
        pk.target,
        pk.best_new_target,
        pk.kpi_type,
        pk.created_at,
        pk.updated_at,
        r.name AS responsible_name,
        k.subject AS kpi_subject,
        k.indicator_title AS kpi_group,
        k.indicator_sub_title AS kpi_name
      FROM public.responsible_parameter_kpis pk
      JOIN public."Responsible" r
        ON r.responsible_id = pk.responsible_id
      LEFT JOIN public."Kpi" k
        ON k.kpi_id = pk.kpi_id
      WHERE pk.responsible_id = $1
        AND pk.parameter_kpi_id = $2
      LIMIT 1
      `,
      [responsibleId, parameterKpiId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Parameter KPI not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("GET one parameter KPI error:", error);
    res.status(500).json({ error: "Failed to load parameter KPI" });
  }
});

router.post("/api/responsibles/:responsibleId/parameter-kpis", async (req, res) => {
  const { responsibleId } = req.params;

  try {
    await ensureResponsibleParameterKpiSchema();

    const {
      kpi_id,
      location,
      local_currency,
      value,
      value_date,
      target,
      best_new_target,
      kpi_type
    } = prepareResponsibleParameterKpiPayload(req.body);

    const result = await pool.query(
      `
      INSERT INTO public.responsible_parameter_kpis (
        responsible_id,
        kpi_id,
        location,
        local_currency,
        value,
        value_date,
        target,
        best_new_target,
        kpi_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        responsibleId,
        kpi_id,
        location,
        local_currency,
        value,
        value_date,
        target,
        best_new_target,
        kpi_type
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("POST parameter KPI error:", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to create parameter KPI"
    });
  }
});

router.post("/api/responsibles/:responsibleId/kpi-objects", async (req, res) => {
  const { responsibleId } = req.params;
  let client;
  try {
    await ensureKpiRatioSchema();
    await ensureKpiObjectSchema();
    const responsiblePeopleContext = await resolveResponsibleOwnerContext(responsibleId);
    const normalizedResponsiblePeopleId =
      normalizeOptionalIntegerInput(responsiblePeopleContext?.people_id);

    const createdByPeopleId =
      normalizeOptionalIntegerInput(req.body.created_by_people_id) ||
      normalizedResponsiblePeopleId;
    const preparedRows = buildPreparedKpiObjectRows({
      ...req.body,
      set_by_people_id: req.body.set_by_people_id || normalizedResponsiblePeopleId,
      created_by_people_id: req.body.created_by_people_id || createdByPeopleId
    }, normalizedResponsiblePeopleId, createdByPeopleId);

    if (!preparedRows.length) {
      throw createHttpError(400, "Enter at least one unit target value.");
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const insertedIds = [];
    const touchedKpiIds = new Set();

   for (const rawPreparedRow of preparedRows) {
      const preparedRow = await enrichIndividualAllocationScope(client, rawPreparedRow);
      const preparedKpiId = normalizeOptionalIntegerInput(preparedRow.kpi_id);
      if (preparedKpiId) {
        touchedKpiIds.add(preparedKpiId);
      }

      const result = await client.query(
        `
        INSERT INTO public.kpi_target_allocation (
          kpi_id,
          plant_id,
          zone_id,
          unit_id,
          "function",
          product_id,
          product_line_id,
          market_id,
          customer_id,
          target_value,
          target_unit,
          local_currency,
          kpi_type,
          unit_type_id,
          role_id,
          target_setup_date,
          target_start_date,
          target_end_date,
          last_best_target,
          previous_target_value,
          target_status,
          set_by_people_id,
          created_by_people_id,
          approved_by_people_id,
          comments
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        RETURNING kpi_target_allocation_id
        `,
        getKpiObjectInsertValues(preparedRow)
      );

      if (result.rows[0]?.kpi_target_allocation_id) {
        insertedIds.push(result.rows[0].kpi_target_allocation_id);
      }
    }

    await refreshKpiKnowledgeBases(client, Array.from(touchedKpiIds), {
      reason: "target_allocation_created"
    });
    await client.query("COMMIT");

    // await sendKpiTargetAllocationAssignmentNotifications({
    //   req,
    //   actorResponsibleId: normalizedResponsiblePeopleId || responsibleId,
    //   allocationIds: insertedIds
    // }).catch((notificationError) => {
    //   console.error("KPI target allocation notification error:", notificationError);
    // });

    const rows = await Promise.all(
      insertedIds.map((allocationId) =>
        loadKpiTargetAllocationRowsForUi({
          allocationId,
          responsibleId: createdByPeopleId || normalizedResponsiblePeopleId || null
        })
      )
    );

    const createdRows = rows.flat().filter(Boolean);
    res.status(201).json(createdRows.length === 1 ? createdRows[0] : createdRows);
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    console.error("POST KPI object error:", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to create KPI target allocation"
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.get("/api/responsibles/:responsibleId/kpi-objects", async (req, res) => {
  const { responsibleId } = req.params;
  try {
    await ensureKpiObjectSchema();
    const loadAllScope = String(req.query?.scope || "").trim().toLowerCase() === "all";
    const responsiblePeopleId = await resolveResponsiblePeopleId(responsibleId);
    if (!loadAllScope && !responsiblePeopleId) {
      throw createHttpError(400, "Responsible owner is invalid.");
    }
    const rows = await loadKpiTargetAllocationRowsForUi({
      responsibleId: loadAllScope ? null : responsiblePeopleId
    });
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json(rows);
  } catch (error) {
    console.error("GET KPI objects error:", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to load KPI target allocations"
    });
  }
});

router.get("/api/responsibles/:responsibleId/kpi-objects/:kpiObjectId", async (req, res) => {
  const { responsibleId, kpiObjectId } = req.params;

  try {
    await ensureKpiObjectSchema();
    const loadAllScope = String(req.query?.scope || "").trim().toLowerCase() === "all";
    const responsiblePeopleId = await resolveResponsiblePeopleId(responsibleId);
    if (!loadAllScope && !responsiblePeopleId) {
      throw createHttpError(400, "Responsible owner is invalid.");
    }
    const anchorRows = await loadKpiTargetAllocationRowsForUi({
      allocationId: Number(kpiObjectId),
      responsibleId: loadAllScope ? null : responsiblePeopleId
    });

    if (!anchorRows.length) {
      return res.status(404).json({ error: "KPI target allocation not found" });
    }

    const relatedAllocations = await loadKpiTargetAllocationGroupRowsForUi(Number(kpiObjectId));
    const primaryRow =
      relatedAllocations.find(
        (row) => Number(row.kpi_target_allocation_id) === Number(kpiObjectId)
      ) || relatedAllocations[0] || anchorRows[0];

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json({
      ...(primaryRow || anchorRows[0]),
      related_allocations: relatedAllocations.length ? relatedAllocations : anchorRows
    });
  } catch (error) {
    console.error("GET one KPI object error:", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to load KPI target allocation"
    });
  }
});

router.put("/api/responsibles/:responsibleId/kpi-objects/:kpiObjectId", async (req, res) => {
  const { responsibleId, kpiObjectId } = req.params;
  let client;
  let transactionCompleted = false;

  try {
    await ensureKpiRatioSchema();
    await ensureKpiObjectSchema();
    const responsiblePeopleContext = await resolveResponsibleOwnerContext(responsibleId);
    const normalizedResponsiblePeopleId =
      normalizeOptionalIntegerInput(responsiblePeopleContext?.people_id);

    const anchorAllocationId = normalizeOptionalIntegerInput(kpiObjectId);
    const existingGroupRows = await loadKpiTargetAllocationGroupRowsForUi(Number(kpiObjectId));
    const existingFamilyRows = await loadKpiTargetAllocationFamilyRowsForUi(Number(kpiObjectId));
    const requestedExistingAllocationIds = Array.from(
      new Set(
        [
          anchorAllocationId,
          ...(Array.isArray(req.body?.existing_allocation_ids) ? req.body.existing_allocation_ids : []),
          ...(Array.isArray(req.body?.unit_allocations)
            ? req.body.unit_allocations.map((row) => row?.kpi_target_allocation_id ?? row?.allocation_id)
            : [])
        ]
          .map((allocationId) => normalizeOptionalIntegerInput(allocationId))
          .filter((allocationId) => Number.isInteger(allocationId) && allocationId > 0)
      )
    );
    const explicitExistingRows = requestedExistingAllocationIds.length
      ? await loadKpiTargetAllocationRowsByIdsForUi(requestedExistingAllocationIds)
      : [];

    if (!existingGroupRows.length) {
      return res.status(404).json({ error: "KPI target allocation not found" });
    }

    const preservedCreatedByPeopleId =
      normalizeOptionalIntegerInput(req.body.created_by_people_id) ||
      normalizeOptionalIntegerInput(existingGroupRows[0]?.created_by_people_id) ||
      normalizedResponsiblePeopleId;
    const preservedSetByPeopleId =
      normalizeOptionalIntegerInput(req.body.set_by_people_id) ||
      normalizeOptionalIntegerInput(existingGroupRows[0]?.set_by_people_id) ||
      normalizedResponsiblePeopleId;
    const preservedGroupCreatedAt =
      existingGroupRows[0]?.created_at || new Date().toISOString();
    const preparedRows = buildPreparedKpiObjectRows({
      ...req.body,
      kpi_target_allocation_id: req.body.kpi_target_allocation_id || kpiObjectId,
      set_by_people_id: req.body.set_by_people_id || preservedSetByPeopleId,
      created_by_people_id: req.body.created_by_people_id || preservedCreatedByPeopleId
    }, normalizedResponsiblePeopleId, preservedCreatedByPeopleId);

    client = await pool.connect();
    await client.query("BEGIN");

    const availableExistingRows = Array.from(
      new Map(
        [
          ...(existingFamilyRows.length ? existingFamilyRows : existingGroupRows),
          ...explicitExistingRows,
          ...existingGroupRows
        ]
          .map((row) => [normalizeOptionalIntegerInput(row?.kpi_target_allocation_id), row])
          .filter(([allocationId]) => Number.isInteger(allocationId) && allocationId > 0)
      ).values()
    );
    const existingRowsByAllocationId = new Map(
      availableExistingRows
        .map((row) => [
          normalizeOptionalIntegerInput(row.kpi_target_allocation_id),
          row
        ])
        .filter(([allocationId]) => Number.isInteger(allocationId) && allocationId > 0)
    );
    const existingRowsByScopeKey = new Map(
      availableExistingRows
        .map((row) => [getKpiTargetAllocationScopeKey(row), row])
        .filter(([scopeKey]) => Boolean(scopeKey))
    );
    const existingRowsByScopeIdentifier = new Map(
      availableExistingRows
        .map((row) => [getKpiTargetAllocationScopeIdentifier(row), row])
        .filter(([scopeIdentifier]) => Boolean(scopeIdentifier))
    );
    const anchorExistingRow = anchorAllocationId
      ? existingRowsByAllocationId.get(anchorAllocationId) || null
      : null;
    const normalizedRequestedKpiType = String(
      normalizeOptionalTextInput(req.body.kpi_type) ||
      normalizeOptionalTextInput(anchorExistingRow?.kpi_type) ||
      ""
    ).trim().toLowerCase();
    const normalizedAnchorKpiType = String(
      normalizeOptionalTextInput(anchorExistingRow?.kpi_type) || ""
    ).trim().toLowerCase();
    const resultingAllocationIds = [];
    const notificationAllocationIds = [];
    const matchedExistingAllocationIds = new Set();
    const touchedKpiIds = new Set();

    const pickAvailableExistingRow = (candidateRow) => {
      const candidateAllocationId = normalizeOptionalIntegerInput(candidateRow?.kpi_target_allocation_id);
      if (!candidateAllocationId) {
        return null;
      }

      return matchedExistingAllocationIds.has(candidateAllocationId)
        ? null
        : candidateRow;
    };

    existingFamilyRows.forEach((row) => {
      const existingKpiId = normalizeOptionalIntegerInput(row?.kpi_id);
      if (existingKpiId) {
        touchedKpiIds.add(existingKpiId);
      }
    });

    for (const preparedRow of preparedRows) {
      const preparedKpiId = normalizeOptionalIntegerInput(preparedRow.kpi_id);
      if (preparedKpiId) {
        touchedKpiIds.add(preparedKpiId);
      }

      const preparedAllocationId = normalizeOptionalIntegerInput(preparedRow.kpi_target_allocation_id);
      const scopeKey = getKpiTargetAllocationScopeKey(preparedRow);
      const scopeIdentifier = getKpiTargetAllocationScopeIdentifier(preparedRow);
      const existingRow =
        (preparedAllocationId
          ? existingRowsByAllocationId.get(preparedAllocationId)
          : null) ||
        (!preparedAllocationId && preparedRows.length === 1 && anchorExistingRow
          ? anchorExistingRow
          : null) ||
        (scopeKey ? pickAvailableExistingRow(existingRowsByScopeKey.get(scopeKey)) : null) ||
        (scopeIdentifier
          ? pickAvailableExistingRow(existingRowsByScopeIdentifier.get(scopeIdentifier))
          : null);
      const existingAssignedPeopleId = normalizeOptionalIntegerInput(existingRow?.set_by_people_id);
      const preparedAssignedPeopleId = normalizeOptionalIntegerInput(preparedRow?.set_by_people_id);
      const existingKpiId = normalizeOptionalIntegerInput(existingRow?.kpi_id);
      if (existingKpiId) {
        touchedKpiIds.add(existingKpiId);
      }

      if (existingRow?.kpi_target_allocation_id) {
        matchedExistingAllocationIds.add(Number(existingRow.kpi_target_allocation_id));
        const updateResult = await client.query(
          `
          UPDATE public.kpi_target_allocation
          SET
            kpi_id = $1,
            plant_id = $2,
            zone_id = $3,
            unit_id = $4,
            "function" = $5,
            product_id = $6,
            product_line_id = $7,
            market_id = $8,
            customer_id = $9,
            target_value = $10,
            target_unit = $11,
            local_currency = $12,
            kpi_type = $13,
            unit_type_id = $14,
            role_id = $15,
            target_setup_date = $16,
            target_start_date = $17,
            target_end_date = $18,
            last_best_target = $19,
            previous_target_value = $20,
            target_status = $21,
            set_by_people_id = $22,
            created_by_people_id = $23,
            approved_by_people_id = $24,
            comments = $25,
            updated_at = NOW()
          WHERE kpi_target_allocation_id = $26
          RETURNING kpi_target_allocation_id
          `,
          [
            ...getKpiObjectInsertValues(preparedRow),
            existingRow.kpi_target_allocation_id,
          ]
        );

        if (updateResult.rows[0]?.kpi_target_allocation_id) {
          resultingAllocationIds.push(updateResult.rows[0].kpi_target_allocation_id);
          if (existingAssignedPeopleId !== preparedAssignedPeopleId) {
            notificationAllocationIds.push(updateResult.rows[0].kpi_target_allocation_id);
          }
        }
        continue;
      }

      const insertResult = await client.query(
        `
        INSERT INTO public.kpi_target_allocation (
          kpi_id,
          plant_id,
          zone_id,
          unit_id,
          "function",
          product_id,
          product_line_id,
          market_id,
          customer_id,
          target_value,
          target_unit,
          local_currency,
          kpi_type,
          unit_type_id,
          role_id,
          target_setup_date,
          target_start_date,
          target_end_date,
          last_best_target,
          previous_target_value,
          target_status,
          set_by_people_id,
          created_by_people_id,
          approved_by_people_id,
          comments,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        RETURNING kpi_target_allocation_id
        `,
        [
          ...getKpiObjectInsertValues(preparedRow),
          preservedGroupCreatedAt
        ]
      );

      if (insertResult.rows[0]?.kpi_target_allocation_id) {
        resultingAllocationIds.push(insertResult.rows[0].kpi_target_allocation_id);
        notificationAllocationIds.push(insertResult.rows[0].kpi_target_allocation_id);
      }
    }

    const rowsToPrune =
      preparedRows.length === 1 &&
        existingFamilyRows.length > existingGroupRows.length &&
        (
          normalizedRequestedKpiType === "individual" ||
          (
            Boolean(normalizedAnchorKpiType) &&
            Boolean(normalizedRequestedKpiType) &&
            normalizedAnchorKpiType !== normalizedRequestedKpiType
          )
        )
        ? existingFamilyRows
        : existingGroupRows;

    for (const existingRow of rowsToPrune) {
      const existingAllocationId = normalizeOptionalIntegerInput(existingRow?.kpi_target_allocation_id);
      if (!existingAllocationId || matchedExistingAllocationIds.has(existingAllocationId)) {
        continue;
      }

      await deleteKpiTargetAllocationDependentRecords(client, existingAllocationId);

      await client.query(
        `
        DELETE FROM public.kpi_target_allocation
        WHERE kpi_target_allocation_id = $1
        `,
        [existingAllocationId]
      );
    }

    await refreshKpiKnowledgeBases(client, Array.from(touchedKpiIds), {
      reason: "target_allocation_updated"
    });
    await client.query("COMMIT");
    transactionCompleted = true;

    // await sendKpiTargetAllocationAssignmentNotifications({
    //   req,
    //   actorResponsibleId: normalizedResponsiblePeopleId || responsibleId,
    //   allocationIds: notificationAllocationIds
    // }).catch((notificationError) => {
    //   console.error("KPI target allocation notification error:", notificationError);
    // });

    const refreshedRowIds = Array.from(
      new Set(
        resultingAllocationIds
          .map((allocationId) => Number(allocationId))
          .filter((allocationId) => Number.isInteger(allocationId) && allocationId > 0)
      )
    );

    const refreshedRows = await Promise.all(
      refreshedRowIds.map((allocationId) =>
        loadKpiTargetAllocationRowsForUi({
          allocationId: Number(allocationId),
          responsibleId: null
        })
      )
    );
    const relatedAllocations = refreshedRows
      .flat()
      .filter(Boolean)
      .sort((left, right) => Number(left.kpi_target_allocation_id) - Number(right.kpi_target_allocation_id));
    const primaryRow =
      relatedAllocations.find(
        (row) => Number(row.kpi_target_allocation_id) === Number(kpiObjectId)
      ) || relatedAllocations[0] || null;

    res.json({
      ...(primaryRow || {}),
      related_allocations: relatedAllocations
    });
  } catch (error) {
    console.error("PUT KPI object error:", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to update KPI target allocation"
    });
  } finally {
    if (client) {
      if (!transactionCompleted) {
        await client.query("ROLLBACK").catch(() => { });
      }
      client.release();
    }
  }
});

router.delete("/api/responsibles/:responsibleId/kpi-objects/:kpiObjectId", async (req, res) => {
  const { kpiObjectId } = req.params;
  let client;

  try {
    await ensureKpiRatioSchema();
    await ensureKpiObjectSchema();
    const requestedAllocationIds = Array.from(
      new Set(
        (Array.isArray(req.body?.allocation_ids) ? req.body.allocation_ids : [])
          .map((allocationId) => normalizeOptionalIntegerInput(allocationId))
          .filter((allocationId) => Number.isInteger(allocationId) && allocationId > 0)
      )
    );
    const anchorAllocationId = normalizeOptionalIntegerInput(kpiObjectId);
    const groupIds = requestedAllocationIds.length
      ? Array.from(
        new Set(
          [anchorAllocationId, ...requestedAllocationIds]
            .filter((allocationId) => Number.isInteger(allocationId) && allocationId > 0)
        )
      )
      : await getKpiTargetAllocationGroupIds(kpiObjectId);
    if (!groupIds.length) {
      return res.status(404).json({ error: "KPI target allocation not found" });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    await deleteKpiTargetAllocationDependentRecords(client, groupIds);

    const result = await client.query(
      `
      DELETE FROM public.kpi_target_allocation
      WHERE kpi_target_allocation_id = ANY($1::int[])
      RETURNING kpi_target_allocation_id, kpi_id
      `,
      [groupIds]
    );

    if (!result.rows.length) {
      await client.query("ROLLBACK").catch(() => { });
      return res.status(404).json({ error: "KPI target allocation not found" });
    }

    await refreshKpiKnowledgeBases(
      client,
      result.rows.map((row) => row.kpi_id),
      { reason: "target_allocation_deleted" }
    );
    await client.query("COMMIT");

    res.json({
      success: true,
      deleted_ids: result.rows
        .map((row) => Number(row.kpi_target_allocation_id))
        .filter((value) => Number.isInteger(value) && value > 0)
    });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    console.error("DELETE KPI object error:", error);
    res.status(500).json({ error: "Failed to delete KPI target allocation" });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.put("/api/responsibles/:responsibleId/parameter-kpis/:parameterKpiId", async (req, res) => {
  const { responsibleId, parameterKpiId } = req.params;

  try {
    await ensureResponsibleParameterKpiSchema();

    const {
      kpi_id,
      location,
      local_currency,
      value,
      value_date,
      target,
      best_new_target,
      kpi_type
    } = prepareResponsibleParameterKpiPayload(req.body);

    const result = await pool.query(
      `
      UPDATE public.responsible_parameter_kpis
      SET
        kpi_id = $1,
        location = $2,
        local_currency = $3,
        value = $4,
        value_date = $5,
        target = $6,
        best_new_target = $7,
        kpi_type = $8,
        updated_at = NOW()
      WHERE parameter_kpi_id = $9
        AND responsible_id = $10
      RETURNING *
      `,
      [
        kpi_id,
        location,
        local_currency,
        value,
        value_date,
        target,
        best_new_target,
        kpi_type,
        parameterKpiId,
        responsibleId
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Parameter KPI not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("PUT parameter KPI error:", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to update parameter KPI"
    });
  }
});

router.delete("/api/responsibles/:responsibleId/parameter-kpis/:parameterKpiId", async (req, res) => {
  const { responsibleId, parameterKpiId } = req.params;

  try {
    await ensureResponsibleParameterKpiSchema();

    const result = await pool.query(
      `
      DELETE FROM public.responsible_parameter_kpis
      WHERE parameter_kpi_id = $1
        AND responsible_id = $2
      RETURNING parameter_kpi_id
      `,
      [parameterKpiId, responsibleId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Parameter KPI not found" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("DELETE parameter KPI error:", error);
    res.status(500).json({ error: "Failed to delete parameter KPI" });
  }
});

router.get("/api/responsibles/:responsibleId/kpi-history-monthly", async (req, res) => {
  const { responsibleId } = req.params;

  try {
    const result = await pool.query(
      `
      WITH ranked AS (
        SELECT
          h.kpi_id,
          k.indicator_title,
          k.indicator_sub_title,
          k.high_limit,
          k.low_limit,
          k.target,
          k.target_direction,
          date_trunc('month', h.updated_at)::date AS month_start,
          to_char(date_trunc('month', h.updated_at), 'Mon YYYY') AS month_label,
          COALESCE(NULLIF(h.new_value, ''), '0')::numeric AS new_value_num,
          h.updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY h.kpi_id, date_trunc('month', h.updated_at)
            ORDER BY h.updated_at DESC
          ) AS rn
        FROM public.kpi_values_hist26 h
        JOIN public."Kpi" k
          ON k.kpi_id = h.kpi_id
        WHERE h.responsible_id = $1
      )
      SELECT
        kpi_id,
        indicator_title,
        indicator_sub_title,
        high_limit,
        low_limit,
        target,
        target_direction,
        month_start,
        month_label,
        new_value_num
      FROM ranked
      WHERE rn = 1
      ORDER BY kpi_id, month_start
      `,
      [responsibleId]
    );

    const grouped = {};

    for (const row of result.rows) {
      if (!grouped[row.kpi_id]) {
        grouped[row.kpi_id] = {
          kpi_id: row.kpi_id,
          indicator_title: row.indicator_title,
          indicator_sub_title: row.indicator_sub_title,
          labels: [],
          values: [],
          targetValue: row.target !== null && row.target !== "" ? Number(row.target) : null,
          highLimitValue: row.high_limit !== null ? Number(row.high_limit) : null,
          lowLimitValue: row.low_limit !== null ? Number(row.low_limit) : null,
          targetDirection: row.target_direction || "Up"
        };
      }

      grouped[row.kpi_id].labels.push(row.month_label);
      grouped[row.kpi_id].values.push(Number(row.new_value_num) || 0);
    }

    const finalRows = Object.values(grouped).map(item => ({
      kpi_id: item.kpi_id,
      indicator_title: item.indicator_title,
      indicator_sub_title: item.indicator_sub_title,
      labels: item.labels,
      values: item.values,
      targetValue: item.targetValue,
      highLimitValue: item.highLimitValue,
      lowLimitValue: item.lowLimitValue,
      targetDirection: item.targetDirection
    }));

    res.json(finalRows);
  } catch (error) {
    console.error("GET monthly KPI history error:", error);
    res.status(500).json({ error: "Failed to load monthly KPI history" });
  }
});
// Ported from the monolith's app.post("/redirect", ...) (index.js), which
// saved submitted weekly KPI values + comments + corrective actions,
// evaluated target-adjustment proposals and sent approval emails via a
// raw HTML form post. This JSON equivalent receives an already-structured
// `items[]` array instead of re-parsing `value_<id>` / `comment_<id>`
// form fields, but preserves the per-item allocation lookup, the
// kpi_result insert/update, evaluateAndCreateKpiTargetAdjustmentProposal,
// syncActionPlanCorrectiveActionsForPeriod and email sending exactly.
router.post("/api/responsibles/:responsibleId/kpi-results", async (req, res) => {
  const { responsibleId: responsible_id } = req.params;

  try {
    const {
      week,
      calculation_mode: submittedCalculationMode,
      frequency: submittedFrequency,
      unit_id: submittedUnitId,
      return_url: submittedReturnUrl,
      items
    } = req.body || {};

    const requestedUnitId = normalizeOptionalIntegerInput(submittedUnitId);
    const normalizedWeek = normalizeOptionalTextInput(week) || formatIsoDateValue(new Date());
    const normalizedCalculationMode = normalizeOptionalTextInput(submittedCalculationMode);
    const normalizedFrequency = normalizeOptionalTextInput(submittedFrequency);
    const fallbackFormUrl = buildKpiFormUrl({
      responsibleId: responsible_id,
      week: normalizedWeek,
      calculationMode: normalizedCalculationMode,
      frequency: normalizedFrequency,
      unitId: requestedUnitId
    });
    const kpiFormReturnUrl = sanitizeKpiFormReturnUrl(submittedReturnUrl, fallbackFormUrl);
    const dashboardReturnUrlParam = kpiFormReturnUrl
      ? `&return_url=${encodeURIComponent(kpiFormReturnUrl)}`
      : "";
    const resultDate = deriveKpiResultDate(normalizedWeek);
    const periodType = deriveKpiResultPeriodType(normalizedWeek);
    const recordedByPeopleId = await resolveRecordedByPeopleId(responsible_id);
    const responsibleContext = await loadFormResponsibleContext(responsible_id, requestedUnitId);
    const correctiveActionsEnabled = await canUseActionPlanCorrectiveActions();

    const submittedItems = Array.isArray(items) ? items : [];
    const defaultResponsibleName = responsibleContext.name || null;
    const targetUpdates = [];
    let correctiveActionsCount = 0;

    for (const item of submittedItems) {
      const allocationId = normalizeOptionalIntegerInput(item?.allocation_id);
      const rawValueText = normalizeOptionalTextInput(item?.value);
      if (!allocationId || rawValueText === null) continue;

      const normalizedValue = normalizeOptionalNumericInput(rawValueText);
      if (normalizedValue === null) {
        throw createHttpError(400, "All KPI values must be numeric.");
      }

      const numericValue = Number(normalizedValue);
      const allocationRes = await pool.query(
        `
        SELECT
          kta.kpi_target_allocation_id,
          kta.kpi_id,
          kta.kpi_type,
          kta.plant_id,
          kta.unit_id,
          kta.last_best_target,
          kta.set_by_people_id,
          kta.approved_by_people_id,
          COALESCE(current_period_result.target_value, kta.target_value, k.target_value) AS effective_target_value,
          COALESCE(kta.target_unit, k.unit) AS effective_unit,
          COALESCE(current_period_result.lower_limit, kta.low_limit, k.low_limit) AS low_limit,
          COALESCE(current_period_result.upper_limit, kta.high_limit, k.high_limit) AS high_limit,
          k.tolerance_type,
          k.low_tolerance,
          k.up_tolerance,
          k.target_direction,
          k.target_auto_adjustment,
          COALESCE(k.kpi_name, k.kpi_sub_title, 'KPI') AS kpi_name,
          COALESCE(subject_link.subject_name, k.kpi_sub_title, k.kpi_name, 'KPI') AS subject_name
        FROM public.kpi_target_allocation kta
        JOIN public.kpi k ON k.kpi_id = kta.kpi_id
        LEFT JOIN LATERAL (
          SELECT
            kr.target_value,
            kr.lower_limit,
            kr.upper_limit
          FROM public.kpi_result kr
          WHERE kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
            AND $2::text IS NOT NULL
            AND (kr.week = $2 OR kr.period_label = $2)
          ORDER BY
            COALESCE(kr.result_date::timestamp, kr.recorded_at) DESC,
            kr.recorded_at DESC,
            kr.kpi_result_id DESC
          LIMIT 1
        ) current_period_result ON TRUE
        LEFT JOIN LATERAL (
          SELECT s.subject_name
          FROM public.subject_kpi sk
          JOIN public.subject s
            ON s.subject_id = sk.subject_id
          WHERE sk.kpi_id = k.kpi_id
          ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
          LIMIT 1
        ) subject_link ON TRUE
        WHERE kta.kpi_target_allocation_id = $1
        LIMIT 1
        `,
        [allocationId, normalizedWeek]
      );
      if (!allocationRes.rows.length) continue;

      const allocation = allocationRes.rows[0];
      const kpiId = allocation.kpi_id;
      const submissionStatusInfo = getDashboardSubmissionStatus({
        value: numericValue,
        target: allocation.effective_target_value,
        unit: allocation.effective_unit,
        low_limit: allocation.low_limit,
        high_limit: allocation.high_limit,
        tolerance_type: allocation.tolerance_type,
        low_tolerance: allocation.low_tolerance,
        up_tolerance: allocation.up_tolerance,
        target_direction: allocation.target_direction,
        subject: allocation.subject_name,
        indicator_sub_title: allocation.kpi_name,
        kpi_id: allocation.kpi_id
      });
      const computedResultStatus = submissionStatusInfo.isGood === false
        ? "Needs attention"
        : "On track";
      const submittedActions = correctiveActionsEnabled
        ? (Array.isArray(item?.corrective_actions) ? item.corrective_actions : []).map((ca) => ({
          correctiveActionId: normalizeText(ca?.corrective_action_id),
          rootCause: normalizeText(ca?.root_cause),
          implementedSolution: normalizeText(ca?.implemented_solution),
          dueDate: normalizeText(ca?.due_date),
          estimatedDurationDays: normalizeCorrectiveActionEstimatedDurationDays(ca?.estimated_duration_days),
          responsibleName:
            normalizeText(ca?.responsible_name) ||
            normalizeText(defaultResponsibleName),
          importance: normalizeCorrectiveActionImportance(ca?.importance),
          urgency: normalizeCorrectiveActionUrgency(ca?.urgency),
          status: normalizeText(ca?.status) || "Open"
        }))
        : [];
      const commentText = normalizeOptionalTextInput(item?.comment);
      const existingResultRes = await pool.query(
        `
        SELECT kpi_result_id
        FROM public.kpi_result
        WHERE kpi_target_allocation_id = $1
          AND kpi_id = $2
          AND COALESCE(period_label, '') = $3
        ORDER BY recorded_at DESC, kpi_result_id DESC
        LIMIT 1
        `,
        [allocationId, kpiId, normalizedWeek]
      );
      const existingResultId = existingResultRes.rows[0]?.kpi_result_id || null;

      if (existingResultId) {
        await pool.query(
          `
          UPDATE public.kpi_result
          SET
            result_date = $2,
            week = $3,
            period_type = $4,
            period_label = $5,
            raw_value = $6,
            lower_limit = $7,
            upper_limit = $8,
            target_value = $9,
            best_new_target = $10,
            unit = $11,
            kpi_type = $12,
            result_status = $13,
            data_source = $14,
            recorded_by_people_id = $15,
            recorded_at = CURRENT_TIMESTAMP,
            comments = $16
          WHERE kpi_result_id = $1
          `,
          [
            existingResultId,
            resultDate,
            normalizedWeek,
            periodType,
            normalizedWeek,
            numericValue,
            allocation.low_limit,
            allocation.high_limit,
            allocation.effective_target_value,
            allocation.last_best_target,
            allocation.effective_unit,
            allocation.kpi_type,
            computedResultStatus,
            "Manual form",
            recordedByPeopleId,
            commentText
          ]
        );
      } else {
        await pool.query(
          `
          INSERT INTO public.kpi_result (
            kpi_target_allocation_id,
            kpi_id,
            result_date,
            week,
            period_type,
            period_label,
            raw_value,
            lower_limit,
            upper_limit,
            target_value,
            best_new_target,
            unit,
            kpi_type,
            result_status,
            data_source,
            recorded_by_people_id,
            comments
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          `,
          [
            allocationId,
            kpiId,
            resultDate,
            normalizedWeek,
            periodType,
            normalizedWeek,
            numericValue,
            allocation.low_limit,
            allocation.high_limit,
            allocation.effective_target_value,
            allocation.last_best_target,
            allocation.effective_unit,
            allocation.kpi_type,
            computedResultStatus,
            "Manual form",
            recordedByPeopleId,
            commentText
          ]
        );
      }

      const targetProposal = await evaluateAndCreateKpiTargetAdjustmentProposal({
        allocation,
        allocationId,
        kpiId,
        actualValue: numericValue,
        periodLabel: normalizedWeek,
        triggeredByPeopleId:
          normalizeOptionalIntegerInput(recordedByPeopleId) ||
          normalizeOptionalIntegerInput(responsible_id)
      });

      if (targetProposal) {
        targetUpdates.push(targetProposal);
        sendKpiTargetAdjustmentApprovalEmail(targetProposal).catch((emailError) => {
          console.error("KPI target adjustment approval email error:", emailError.message);
        });
      }

      // -------------------------------------------------------
      // Save the corrective actions for this KPI period in the Action Plan DB.
      // -------------------------------------------------------
      if (correctiveActionsEnabled) {
        const syncResult = await syncActionPlanCorrectiveActionsForPeriod({
          kpiTargetAllocationId: allocationId,
          kpiId,
          unitId: allocation.unit_id ?? allocation.plant_id,
          periodLabel: normalizedWeek,
          subject: allocation.subject_name,
          kpiName: allocation.kpi_name,
          actions: submittedActions,
          responsibleContext
        });

        correctiveActionsCount += syncResult.savedCount || 0;
      }
    }

    const notifications = ["KPI results saved successfully"];
    if (targetUpdates.length > 0) {
      notifications.push(
        `${targetUpdates.length} target proposal${targetUpdates.length > 1 ? "s" : ""} created for manager approval`
      );
    }
    if (correctiveActionsCount > 0) {
      notifications.push(
        `${correctiveActionsCount} corrective action${correctiveActionsCount > 1 ? "s" : ""} recorded`
      );
    }

    res.json({
      week: normalizedWeek,
      notifications,
      target_proposals_created: targetUpdates.length,
      corrective_actions_recorded: correctiveActionsCount,
      form_url: kpiFormReturnUrl,
      dashboard_url: `/dashboard?responsible_id=${encodeURIComponent(responsible_id)}${dashboardReturnUrlParam}`
    });
  } catch (err) {
    console.error("Error saving KPI results:", err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// JSON equivalent of the original GET /dashboard HTML page (Etape 2). Mirrors
// its exact SQL (ranked_results over kpi_result/kpi_target_allocation/kpi,
// latest row per allocation per calendar month) and its month-grouping logic,
// but returns JSON instead of a rendered page.
router.get("/api/responsibles/:responsibleId/dashboard", async (req, res) => {
  try {
    const responsibleId = normalizeOptionalIntegerInput(req.params.responsibleId);
    const requestedFormReturnUrl = sanitizeKpiFormReturnUrl(req.query?.return_url);
    if (!responsibleId) {
      return res.status(400).json({ error: "Missing responsible_id" });
    }

    const responsibleContext = await loadFormResponsibleContext(responsibleId);
    const responsiblePeopleId = normalizeOptionalIntegerInput(
      responsibleContext?.people_id ?? responsibleId
    );

    if (!responsiblePeopleId) {
      throw createHttpError(404, "Responsible not found");
    }

    const responsible = {
      name: responsibleContext?.name || `Person #${responsiblePeopleId}`,
      plant_name: responsibleContext?.plant_name || "Allocated scope",
      department_name: responsibleContext?.department_name || ""
    };

    const kpiRes = await pool.query(
      `
 WITH ranked_results AS (
  SELECT
    kr.kpi_result_id,
    kr.kpi_target_allocation_id AS kpi_values_id,
    kr.kpi_target_allocation_id,
    kr.kpi_id,
    kr.result_date,
    kr.week,
    kr.period_label,
    kr.raw_value AS value,
    kr.lower_limit AS result_low_limit,
    kr.upper_limit AS result_high_limit,
    kr.target_value AS result_target_value,
    kr.unit AS result_unit,
    kr.recorded_at AS updated_at,
    DATE_TRUNC('month', COALESCE(kr.result_date::timestamp, kr.recorded_at)) AS month_bucket,
    ROW_NUMBER() OVER (
      PARTITION BY DATE_TRUNC('month', COALESCE(kr.result_date::timestamp, kr.recorded_at)), kr.kpi_target_allocation_id
      ORDER BY COALESCE(kr.recorded_at, kr.result_date::timestamp) DESC, kr.kpi_result_id DESC
    ) AS rn
  FROM public.kpi_result kr
  JOIN public.kpi_target_allocation kta
    ON kta.kpi_target_allocation_id = kr.kpi_target_allocation_id
  WHERE kta.set_by_people_id = $1
)
      SELECT
        rr.kpi_result_id AS hist_id,
        rr.kpi_values_id,
        rr.kpi_target_allocation_id,
        rr.week,
        rr.period_label,
        rr.result_date,
        rr.kpi_id,
        rr.value,
        rr.updated_at,
        COALESCE(k.kpi_name, k.kpi_sub_title, 'KPI') AS subject,
        COALESCE(subject_link.subject_name, k.kpi_sub_title, '') AS indicator_sub_title,
        COALESCE(rr.result_unit, kta.target_unit, k.unit) AS unit,
        COALESCE(rr.result_target_value, kta.target_value, k.target_value) AS target,
        k.min_value AS min,
        k.max_value AS max,
        k.tolerance_type,
        k.up_tolerance,
        k.low_tolerance,
        k.frequency,
        k.calculation_mode,
        k.kpi_explanation AS definition,
        k.calculation_on,
        k.target_auto_adjustment,
        COALESCE(rr.result_high_limit, k.high_limit) AS high_limit,
        COALESCE(rr.result_low_limit, k.low_limit) AS low_limit,
        k.target_direction
      FROM ranked_results rr
      JOIN public.kpi k
        ON k.kpi_id = rr.kpi_id
      LEFT JOIN public.kpi_target_allocation kta
        ON kta.kpi_target_allocation_id = rr.kpi_target_allocation_id
      LEFT JOIN LATERAL (
        SELECT s.subject_name
        FROM public.subject_kpi sk
        JOIN public.subject s
          ON s.subject_id = sk.subject_id
        WHERE sk.kpi_id = rr.kpi_id
        ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
        LIMIT 1
      ) subject_link ON TRUE
      WHERE rr.rn = 1
      ORDER BY
        rr.month_bucket DESC,
        COALESCE(k.kpi_name, k.kpi_sub_title, 'KPI') ASC,
        rr.kpi_result_id DESC
      `,
      [responsiblePeopleId]
    );

    const monthMap = new Map();
    kpiRes.rows.forEach((kpi) => {
      const sourceDate = kpi.result_date || kpi.updated_at;
      if (!sourceDate) return;
      const date = new Date(sourceDate);
      if (Number.isNaN(date.getTime())) return;
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
      if (!monthMap.has(monthKey)) monthMap.set(monthKey, []);
      monthMap.get(monthKey).push(kpi);
    });

    const sortedMonthEntries = Array.from(monthMap.entries()).sort((a, b) => {
      const [yearA, monthA] = a[0].split("-").map(Number);
      const [yearB, monthB] = b[0].split("-").map(Number);
      return new Date(yearB, monthB) - new Date(yearA, monthA);
    });

    const formatDashboardTimestamp = (value) => {
      if (!value) return "No updates recorded";
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return "No updates recorded";
      return parsed.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    };

    const monthSummaries = sortedMonthEntries.map(([monthKey, items], index) => {
      const [year, month] = monthKey.split("-").map(Number);
      const monthDate = new Date(year, month);
      let alertCount = 0;
      let onTrackCount = 0;
      let missingCount = 0;
      let latestUpdatedAt = null;

      items.forEach((kpi) => {
        const currentValue = normalizeMetricNumberByUnit(kpi.value, kpi.unit);
        const statusInfo = getDashboardSubmissionStatus(kpi);

        if (currentValue === null) missingCount += 1;
        else if (statusInfo.isGood === false) alertCount += 1;
        else onTrackCount += 1;

        if (kpi.updated_at) {
          const updatedAt = new Date(kpi.updated_at);
          if (!Number.isNaN(updatedAt.getTime()) && (!latestUpdatedAt || updatedAt > latestUpdatedAt)) {
            latestUpdatedAt = updatedAt;
          }
        }
      });

      return {
        monthKey,
        monthLabel: monthDate.toLocaleString("en-US", { month: "long", year: "numeric" }),
        monthShort: monthDate.toLocaleString("en-US", { month: "short" }).toUpperCase(),
        isLatest: index === 0,
        kpiCount: items.length,
        alertCount,
        onTrackCount,
        missingCount,
        lastUpdated: formatDashboardTimestamp(latestUpdatedAt),
        kpis: items
      };
    });

    const latestSubmittedRow = kpiRes.rows
      .slice()
      .sort((left, right) => {
        const leftTime = new Date(left?.updated_at || left?.result_date || 0).getTime();
        const rightTime = new Date(right?.updated_at || right?.result_date || 0).getTime();
        return rightTime - leftTime;
      })
      .find((row) => normalizeOptionalTextInput(row?.week || row?.period_label));
    const dashboardFormWeek =
      normalizeOptionalTextInput(latestSubmittedRow?.week || latestSubmittedRow?.period_label) ||
      getCurrentFormWeek();
    const kpiFormUrl = requestedFormReturnUrl || buildKpiFormUrl({
      responsibleId,
      week: dashboardFormWeek,
      calculationMode: latestSubmittedRow?.calculation_mode,
      frequency: latestSubmittedRow?.frequency
    });

    res.json({
      responsible,
      months: monthSummaries,
      kpi_form_url: kpiFormUrl
    });
  } catch (err) {
    console.error("GET /api/responsibles/:responsibleId/dashboard error:", err.message);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : "Failed to load dashboard data." });
  }
});

// JSON equivalent of the original GET /dashboard-history HTML page (Etape 2).
// The original queried public.kpi_values_hist26 JOIN public."Kpi" -- confirmed
// via information_schema that neither table exists in the current database, so
// that page has been permanently broken (throws on every request) since before
// this migration; there is no old_value/new_value pairing left to recover. This
// returns the closest modern equivalent instead: every kpi_result row ever
// recorded for this responsible (same kta.set_by_people_id scope used
// elsewhere), ordered newest first, so the frontend can show a real
// value-over-time history even though the exact old/new-value shape can't be
// reproduced from data that no longer exists.
router.get("/api/responsibles/:responsibleId/kpi-value-history", async (req, res) => {
  try {
    const responsibleId = normalizeOptionalIntegerInput(req.params.responsibleId);
    if (!responsibleId) {
      return res.status(400).json({ error: "Missing responsible_id" });
    }

    const result = await pool.query(
      `
      SELECT
        kr.kpi_result_id AS hist_id,
        kr.kpi_id,
        kr.kpi_target_allocation_id,
        COALESCE(kr.week, kr.period_label) AS week,
        kr.raw_value AS value,
        COALESCE(kr.unit, kta.target_unit, k.unit) AS unit,
        COALESCE(k.kpi_name, k.kpi_sub_title, 'KPI') AS subject,
        COALESCE(subject_link.subject_name, k.kpi_sub_title, '') AS indicator_sub_title,
        kr.recorded_at AS updated_at
      FROM public.kpi_result kr
      JOIN public.kpi_target_allocation kta
        ON kta.kpi_target_allocation_id = kr.kpi_target_allocation_id
      JOIN public.kpi k
        ON k.kpi_id = kr.kpi_id
      LEFT JOIN LATERAL (
        SELECT s.subject_name
        FROM public.subject_kpi sk
        JOIN public.subject s
          ON s.subject_id = sk.subject_id
        WHERE sk.kpi_id = kr.kpi_id
        ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
        LIMIT 1
      ) subject_link ON TRUE
      WHERE kta.set_by_people_id = $1
      ORDER BY kr.recorded_at DESC NULLS LAST, kr.kpi_result_id DESC
      `,
      [responsibleId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/responsibles/:responsibleId/kpi-value-history error:", err.message);
    res.status(500).json({ error: "Failed to load KPI value history." });
  }
});

module.exports = router;
