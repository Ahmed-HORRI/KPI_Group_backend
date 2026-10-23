const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const {
  normalizeOptionalTextInput,
  normalizeOptionalIntegerInput,
  normalizeOptionalNumericInput,
} = require("../utils/normalize");
const { createHttpError } = require("../utils/httpError");
const { filterActiveSubjectTree } = require("../utils/subjectHierarchy");
const { createKpiAnalyticsScope } = require("../services/kpiAnalyticsScope.service");
const { actorFromRequest, createKpiChangeLog } = require("../services/kpiChangeLog.service");

// Trace of every KPI / target allocation created, updated or deleted here
// (administration, tab "KPI audit trail"), written in the same transaction.
const kpiChangeLog = createKpiChangeLog({ db: pool });
const {
  loadKpiRowsForUi,
  loadSubjectHierarchyData,
  getPeopleDisplayName,
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
const {
  buildKpiFormUrl,
  sanitizeKpiFormReturnUrl,
  deriveKpiResultDate,
  deriveKpiResultPeriodType,
  resolveRecordedByPeopleId,
  getDashboardSubmissionStatus,
  resolveAllocationLimits,
  normalizeText,
  normalizeCorrectiveActionEstimatedDurationDays,
  normalizeCorrectiveActionImportance,
  normalizeCorrectiveActionUrgency,
  isPercentageUnit,
  normalizeMetricNumberByUnit,
  inferKpiDirection,
  needsCorrectiveAction,
  sortCorrectiveActions,
} = require("../services/kpiShared.service");
const { getCurrentFormWeek } = require("../services/ceoReportGeneration.service");
const {
  canUseActionPlanCorrectiveActions,
  syncActionPlanCorrectiveActionsForPeriod,
  getResponsibleWithKPIs,
} = require("../services/actionPlan.service");
const {
  DEFAULT_KPI_SUBMISSION_TIMEZONE,
  formatIsoDateValue,
  getCanonicalKpiSubmissionFrequency,
  getKpiSubmissionTargetPeriodLabel,
  buildTimeZoneDateContext,
  parseWeekLabelDate,
} = require("../utils/weekPeriod");
const {
  normalizeKpiFrequency,
  buildKpiChartHistorySeries,
  KPI_CHART_HISTORY_WINDOW,
  parseKpiChartPeriodKey,
  formatKpiChartPeriodLabel,
  getKpiChartPeriodDate,
} = require("../services/kpiChart.service");
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
  isEndedInactiveKpiTargetAllocation,
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

    await kpiChangeLog.record(client, {
      entityType: "kpi",
      before: new Map(),
      after: await kpiChangeLog.snapshotKpis(client, [newKpi.kpi_id]),
      actor: actorFromRequest(req, "dashboard")
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

    const kpiBefore = await kpiChangeLog.snapshotKpis(client, [kpiId]);
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
    await kpiChangeLog.record(client, {
      entityType: "kpi",
      before: kpiBefore,
      after: await kpiChangeLog.snapshotKpis(client, [kpiId]),
      actor: actorFromRequest(req, "dashboard")
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

    const kpiBefore = await kpiChangeLog.snapshotKpis(client, [kpiId]);
    const allocationCount = (await kpiChangeLog.allocationIdsOfKpi(client, kpiId)).length;
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
    await kpiChangeLog.record(client, {
      entityType: "kpi",
      before: kpiBefore,
      after: new Map(),
      actor: actorFromRequest(req, "dashboard"),
      note: allocationCount ? `Its ${allocationCount} target allocation(s) were deleted with it.` : null
    });
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
    await kpiChangeLog.record(client, {
      entityType: "target_allocation",
      before: new Map(),
      after: await kpiChangeLog.snapshotAllocations(client, insertedIds),
      actor: actorFromRequest(req, "dashboard")
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
    // Consult Target Allocation list: hide allocations that were deactivated with an end date.
    const rows = await loadKpiTargetAllocationRowsForUi({
      responsibleId: loadAllScope ? null : responsiblePeopleId,
      excludeEndedInactive: true
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

    const groupAllocations = await loadKpiTargetAllocationGroupRowsForUi(Number(kpiObjectId));
    const isHiddenGroupAllocation = (row) =>
      Number(row.kpi_target_allocation_id) !== Number(kpiObjectId) &&
      isEndedInactiveKpiTargetAllocation(row);
    const relatedAllocations = groupAllocations.filter((row) => !isHiddenGroupAllocation(row));
    // Plants where this KPI (same type, unit type and role, any product line) still has a live target:
    // the edit form lists another plant only when it has one.
    const liveUnitsResult = await pool.query(
      `
      SELECT DISTINCT COALESCE(a.plant_id, a.unit_id) AS unit_id
      FROM public.kpi_target_allocation a
      JOIN public.kpi_target_allocation anchor
        ON anchor.kpi_target_allocation_id = $1
      WHERE a.kpi_id = anchor.kpi_id
        AND COALESCE(a.kpi_type, '') = COALESCE(anchor.kpi_type, '')
        AND COALESCE(a.unit_type_id, 0) = COALESCE(anchor.unit_type_id, 0)
        AND COALESCE(a.role_id, 0) = COALESCE(anchor.role_id, 0)
        AND COALESCE(a.plant_id, a.unit_id) IS NOT NULL
        AND NOT (
          LOWER(TRIM(COALESCE(a.target_status, ''))) = 'inactive'
          AND a.target_end_date IS NOT NULL
        )
      `,
      [Number(kpiObjectId)]
    );
    const primaryRow =
      relatedAllocations.find(
        (row) => Number(row.kpi_target_allocation_id) === Number(kpiObjectId)
      ) || relatedAllocations[0] || anchorRows[0];

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json({
      ...(primaryRow || anchorRows[0]),
      related_allocations: relatedAllocations.length ? relatedAllocations : anchorRows,
      live_unit_ids: liveUnitsResult.rows.map((row) => String(row.unit_id))
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

    // A repeated allocation id would overwrite its owner and leave its siblings unmatched for the prune below.
    const requestedAllocationIds = new Set();
    for (const preparedRow of preparedRows) {
      const requestedAllocationId = normalizeOptionalIntegerInput(preparedRow.kpi_target_allocation_id);
      if (!requestedAllocationId) continue;
      if (requestedAllocationIds.has(requestedAllocationId)) {
        throw createHttpError(
          400,
          "The same KPI target allocation was sent twice. Reload the page and try again."
        );
      }
      requestedAllocationIds.add(requestedAllocationId);
    }

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
    const allocationsBefore = await kpiChangeLog.snapshotAllocations(
      client,
      availableExistingRows.map((row) => row.kpi_target_allocation_id)
    );
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

      // Hidden from the edit form, so its absence from the payload is not a removal.
      if (isEndedInactiveKpiTargetAllocation(existingRow)) {
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
    await kpiChangeLog.record(client, {
      entityType: "target_allocation",
      before: allocationsBefore,
      after: await kpiChangeLog.snapshotAllocations(client, [...allocationsBefore.keys(), ...resultingAllocationIds]),
      actor: actorFromRequest(req, "dashboard")
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

    const allocationsBefore = await kpiChangeLog.snapshotAllocations(client, groupIds);
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
    await kpiChangeLog.record(client, {
      entityType: "target_allocation",
      before: allocationsBefore,
      after: await kpiChangeLog.snapshotAllocations(client, groupIds),
      actor: actorFromRequest(req, "dashboard")
    });
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
      const resolvedLimits = resolveAllocationLimits({
        lowLimit: allocation.low_limit,
        highLimit: allocation.high_limit,
        target: allocation.effective_target_value,
        toleranceType: allocation.tolerance_type,
        lowTolerance: allocation.low_tolerance,
        upTolerance: allocation.up_tolerance
      });
      allocation.low_limit = resolvedLimits.lowLimit;
      allocation.high_limit = resolvedLimits.highLimit;
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

// ---------------------------------------------------------------------------
// GET /api/responsibles/:responsibleId/kpi-form
//
// JSON equivalent of the original GET /form HTML page (index.js:31820-38601,
// 6782 lines -- the KPI value entry form). Nothing in Etape 1 returned this
// combined payload: the original page smuggled all of it into the markup via
// `data-*` attributes on each `.kpi-card`, so the React page needs it as data.
//
// It mirrors the original's 6 SQL statements and its server-side derivation:
//   1. active people list           -> corrective-action "Responsible" options
//   2. getResponsibleWithKPIs(...)  -> responsible context + the main
//      kpi_target_allocation/kpi query scoped by kta.set_by_people_id +
//      the Action Plan corrective-action maps (2nd database), all already
//      extracted into actionPlan.service.js during Etape 1
//   3. value history  (kpi_result, raw_value IS NOT NULL)
//   4. comment history (kpi_result, DISTINCT ON period, comments non-empty)
// plus per-KPI status/direction/chart-series derivation
// (inferKpiDirection / needsCorrectiveAction / buildKpiChartHistorySeries)
// and the week/month period-selector list.
//
// Deliberate omissions (all confirmed dead in the original, see the structural
// analysis of that route):
//   - the second, redundant loadFormResponsibleContext() call (identical data
//     to the one getResponsibleWithKPIs already performs; its results were
//     only used as fallbacks that can never be reached because the first call
//     already substitutes "Allocated scope"/"" defaults);
//   - the per-KPI console.log debug blocks (8 lines x every KPI, every request);
//   - the computed-but-never-rendered caStatus/safeCaStatusClass/
//     latestCorrectiveAction locals and findPreviousMonthLabel.
// Two corrections vs. the original, noted so the difference is explicit:
//   - corrective-action history is keyed by allocation id only. The original
//     looked up `correctiveActionsByKpiMonth[kpi.kpi_id]` FIRST and only then
//     `[kpi.kpi_values_id]`, although that map is keyed by allocation id --
//     so a KPI whose kpi_id happened to equal another KPI's allocation id got
//     the wrong history.
//   - the currently selected period is always present in period.options (the
//     original could emit a <select> with no matching <option>, which makes a
//     browser silently display the first option instead of the real period).
// ---------------------------------------------------------------------------
// Temporary: corrective actions are optional on /form until the target allocation limits are fixed.
// Set KPI_FORM_REQUIRE_CORRECTIVE_ACTION=true in the environment to make them mandatory again.
const KPI_FORM_REQUIRE_CORRECTIVE_ACTION =
  String(process.env.KPI_FORM_REQUIRE_CORRECTIVE_ACTION || "").trim().toLowerCase() === "true";

const getKpiFormDisplayUnit = (kpi = {}) => {
  const unit = String(kpi.unit || "").trim();
  if (unit.toLowerCase() !== "kcur") return unit;

  const currency = String(kpi.selling_currency || kpi.local_currency || "")
    .trim()
    .toUpperCase();

  return currency ? `k${currency}` : "kCur";
};

const parseKpiFormNumber = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text === "None" || text === "null") return null;
  const parsed = parseFloat(text);
  return Number.isNaN(parsed) ? null : parsed;
};

const weekToKpiFormMonthLabel = (periodLabel) => {
  const monthKey = parseKpiChartPeriodKey(periodLabel, "monthly");
  if (!monthKey) return periodLabel || "";
  return formatKpiChartPeriodLabel(monthKey, "monthly");
};

const sortKpiFormHistoryEntries = (entries, getUpdatedAt, frequencyMode = "monthly") =>
  (Array.isArray(entries) ? entries.slice() : []).sort((a, b) => {
    const leftPeriodKey = parseKpiChartPeriodKey(
      a?.week || a?.period_label || a?.month_label || a?.result_date,
      frequencyMode
    );
    const rightPeriodKey = parseKpiChartPeriodKey(
      b?.week || b?.period_label || b?.month_label || b?.result_date,
      frequencyMode
    );
    const periodDiff =
      (getKpiChartPeriodDate(rightPeriodKey, frequencyMode)?.getTime() ?? 0) -
      (getKpiChartPeriodDate(leftPeriodKey, frequencyMode)?.getTime() ?? 0);
    if (periodDiff !== 0) return periodDiff;

    return new Date(getUpdatedAt(b) || 0) - new Date(getUpdatedAt(a) || 0);
  });

// Same ISO-week label helper the original declared inline at index.js:31971.
const getKpiFormIsoWeekLabel = (inputDate) => {
  const date = new Date(Date.UTC(
    inputDate.getFullYear(),
    inputDate.getMonth(),
    inputDate.getDate()
  ));

  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);

  return `${date.getUTCFullYear()}-Week${String(weekNumber).padStart(2, "0")}`;
};

// Port of buildAvailableFormPeriods (index.js:32435): monthly -> current month
// + the previous 6; anything else -> the current FORM week + the previous 4
// (the original's comment says 6 but its loop stops at -4).
const buildAvailableKpiFormPeriods = ({ frequency }) => {
  const normalizedFrequency = String(frequency || "").trim().toLowerCase();
  const periods = [];

  if (normalizedFrequency === "monthly") {
    const currentDate = new Date();
    for (let offset = 0; offset >= -6; offset -= 1) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      periods.push(formatKpiChartPeriodLabel(monthKey, "monthly"));
    }
    return periods;
  }

  const currentWeekDate = parseWeekLabelDate(getCurrentFormWeek());
  const referenceDate =
    currentWeekDate && !Number.isNaN(currentWeekDate.getTime())
      ? currentWeekDate
      : new Date();

  for (let offset = 0; offset >= -4; offset -= 1) {
    const date = new Date(referenceDate);
    date.setDate(referenceDate.getDate() + offset * 7);
    periods.push(getKpiFormIsoWeekLabel(date));
  }

  return periods;
};

const mapKpiFormCorrectiveAction = (action = {}, allocationId = null) => {
  const periodLabel = action.week || action.period_label || "";

  return {
    corrective_action_id: action.corrective_action_id ?? action.id ?? null,
    allocation_id: allocationId,
    week: periodLabel,
    month_label: weekToKpiFormMonthLabel(periodLabel),
    status: action.status || "",
    root_cause: action.root_cause || "",
    implemented_solution: action.implemented_solution || "",
    evidence: action.evidence || "",
    due_date: action.due_date || "",
    estimated_duration_days: normalizeCorrectiveActionEstimatedDurationDays(
      action.estimated_duration_days
    ),
    importance: normalizeCorrectiveActionImportance(action.importance) || "",
    urgency: normalizeCorrectiveActionUrgency(action.urgency) || "",
    responsible: action.responsible || "",
    updated_at: action.updated_date || action.created_date || null
  };
};

router.get("/api/responsibles/:responsibleId/kpi-form", async (req, res) => {
  try {
    const responsibleId = normalizeOptionalIntegerInput(req.params.responsibleId);
    if (!responsibleId) {
      return res.status(400).json({ error: "Missing responsible_id" });
    }

    const requestedCalculationMode = normalizeOptionalTextInput(req.query?.calculation_mode);
    const requestedUnitId = normalizeOptionalIntegerInput(req.query?.unit_id);
    const normalizedFrequencyFilter = normalizeOptionalTextInput(req.query?.frequency)
      ? getCanonicalKpiSubmissionFrequency(req.query.frequency)
      : null;
    const week =
      normalizeOptionalTextInput(req.query?.week) ||
      (normalizedFrequencyFilter
        ? getKpiSubmissionTargetPeriodLabel({
          timeContext: buildTimeZoneDateContext(DEFAULT_KPI_SUBMISSION_TIMEZONE),
          frequencyLabel: normalizedFrequencyFilter
        })
        : getCurrentFormWeek());

    // Query 1 -- active people, the corrective-action owner options.
    const peopleRes = await pool.query(
      `SELECT people_id,
          TRIM(first_name || ' ' || name) AS display_name
   FROM public.people
   WHERE status = 'Active'
   ORDER BY first_name ASC, name ASC`
    );
    const responsibleOptions = peopleRes.rows
      .map((row) => normalizeOptionalTextInput(row.display_name))
      .filter(Boolean);

    // Queries 2/3/4 -- responsible context, the main KPI+allocation query and
    // the Action Plan corrective-action maps.
    const {
      responsible,
      kpis,
      correctiveActionsEnabled,
      correctiveActionHistoryByAllocation
    } = await getResponsibleWithKPIs(responsibleId, week, {
      frequency: normalizedFrequencyFilter,
      calculationMode: requestedCalculationMode,
      unitId: requestedUnitId
    });

    const responsibleName = normalizeOptionalTextInput(responsible?.name) || "";
    const responsibleGroupLabel =
      normalizeOptionalTextInput(responsible?.group_name) ||
      normalizeOptionalTextInput(responsible?.plant_name) ||
      "Allocated scope";
    const responsibleRoleLabel =
      normalizeOptionalTextInput(kpis?.[0]?.allocation_role_name) ||
      normalizeOptionalTextInput(responsible?.role_name) ||
      normalizeOptionalTextInput(responsible?.role) ||
      "Not assigned";
    const formFrequencyLabel =
      normalizedFrequencyFilter ||
      normalizeOptionalTextInput(kpis?.[0]?.frequency) ||
      "Weekly";
    const formReturnUrl = sanitizeKpiFormReturnUrl(
      req.query?.return_url,
      buildKpiFormUrl({
        responsibleId,
        week,
        calculationMode: requestedCalculationMode,
        frequency: formFrequencyLabel,
        unitId: requestedUnitId
      })
    );

    const isMonthlyForm = String(formFrequencyLabel).trim().toLowerCase() === "monthly";
    const formPeriodLabel = isMonthlyForm ? weekToKpiFormMonthLabel(week) : week;
    const periodOptions = buildAvailableKpiFormPeriods({ frequency: formFrequencyLabel });
    if (formPeriodLabel && !periodOptions.includes(formPeriodLabel)) {
      periodOptions.unshift(formPeriodLabel);
    }
    const defaultResponsible =
      responsibleOptions.find(
        (option) => option.toLowerCase() === responsibleName.toLowerCase()
      ) ||
      responsibleOptions[0] ||
      "";

    const basePayload = {
      responsible: {
        people_id: responsible?.people_id ?? responsibleId,
        name: responsibleName,
        group: responsibleGroupLabel,
        role: responsibleRoleLabel,
        email: responsible?.email || "",
        department: responsible?.department_name || ""
      },
      period: {
        week,
        label: formPeriodLabel,
        title: isMonthlyForm ? "Month" : "Week",
        options: periodOptions
      },
      frequency: formFrequencyLabel,
      frequency_mode: normalizeKpiFrequency(formFrequencyLabel),
      calculation_mode: requestedCalculationMode,
      unit_id: requestedUnitId,
      return_url: formReturnUrl,
      corrective_actions_enabled: Boolean(correctiveActionsEnabled),
      corrective_actions_required: KPI_FORM_REQUIRE_CORRECTIVE_ACTION,
      responsible_options: responsibleOptions,
      default_responsible: defaultResponsible,
      has_initial_invalid_kpi: false,
      kpis: []
    };

    // The original rendered a standalone "No KPI values to enter yet" page here.
    if (!kpis.length) {
      return res.json(basePayload);
    }

    const allocationIds = kpis
      .map((kpi) => normalizeOptionalIntegerInput(kpi.kpi_values_id))
      .filter((value) => Number.isInteger(value));

    // Query 5 -- value history per allocation.
    const histRes = await pool.query(
      `
      SELECT
        kr.kpi_target_allocation_id AS kpi_values_id,
        kr.kpi_id,
        TO_CHAR(kr.result_date, 'YYYY-MM-DD') AS result_date,
        kr.week,
        kr.period_label,
        kr.raw_value AS new_value,
        kr.recorded_at AS updated_at
      FROM public.kpi_result kr
      WHERE kr.kpi_target_allocation_id = ANY($1::int[])
        AND kr.raw_value IS NOT NULL
      ORDER BY
        kr.kpi_target_allocation_id,
        kr.result_date ASC NULLS LAST,
        kr.week ASC,
        kr.period_label ASC,
        kr.recorded_at ASC
      `,
      [allocationIds]
    );

    const historyByKpi = {};
    histRes.rows.forEach((row) => {
      const historyKey = String(row.kpi_values_id || row.kpi_id);
      if (!historyByKpi[historyKey]) historyByKpi[historyKey] = [];
      historyByKpi[historyKey].push({
        week: row.week,
        period_label: row.period_label,
        result_date: row.result_date,
        value: parseFloat(row.new_value)
      });
    });

    // Query 6 -- latest comment per allocation per period.
    const commentsHistoryRes = await pool.query(
      `
      SELECT DISTINCT ON (kr.kpi_target_allocation_id, COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')))
        kr.kpi_target_allocation_id AS kpi_values_id,
        kr.kpi_id,
        COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')) AS week,
        kr.comments AS comment,
        kr.recorded_at AS updated_at
      FROM public.kpi_result kr
      WHERE kr.kpi_target_allocation_id = ANY($1::int[])
        AND kr.comments IS NOT NULL
        AND BTRIM(kr.comments) <> ''
      ORDER BY
        kr.kpi_target_allocation_id,
        COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')),
        kr.recorded_at DESC,
        kr.kpi_result_id DESC
      `,
      [allocationIds]
    );

    const commentsByAllocation = {};
    commentsHistoryRes.rows.forEach((row) => {
      const commentKey = String(row.kpi_values_id || row.kpi_id);
      if (!commentsByAllocation[commentKey]) commentsByAllocation[commentKey] = [];
      commentsByAllocation[commentKey].push({
        week: row.week,
        month_label: weekToKpiFormMonthLabel(row.week),
        text: row.comment,
        updated_at: row.updated_at
      });
    });

    let hasInitialInvalidKpi = false;

    const formKpis = kpis.map((kpi) => {
      const allocationId = normalizeOptionalIntegerInput(kpi.kpi_values_id);
      const allocationKey = String(kpi.kpi_values_id ?? "");
      const displayUnit = getKpiFormDisplayUnit({ ...kpi, unit: kpi.display_unit });
      const lowLimit = parseKpiFormNumber(kpi.low_limit);
      const highLimit = parseKpiFormNumber(kpi.high_limit);
      const targetValue = parseKpiFormNumber(kpi.target);
      const currentValue = parseKpiFormNumber(kpi.value);
      const goodDirection = inferKpiDirection(kpi);
      const initialNeedsCA =
        currentValue !== null &&
        needsCorrectiveAction(currentValue, lowLimit, highLimit, goodDirection);
      const currentPeriodActions = Array.isArray(kpi.current_week_corrective_actions)
        ? kpi.current_week_corrective_actions
        : [];
      const hasValidCA = currentPeriodActions.some(
        (action) =>
          String(action.root_cause || "").trim() &&
          String(action.implemented_solution || "").trim() &&
          String(action.due_date || "").trim() &&
          String(action.responsible || "").trim()
      );

      if (KPI_FORM_REQUIRE_CORRECTIVE_ACTION && correctiveActionsEnabled && initialNeedsCA && !hasValidCA) {
        hasInitialInvalidKpi = true;
      }

      const frequencyMode = normalizeKpiFrequency(
        formFrequencyLabel || kpi.frequency
      );
      const chartSeries = buildKpiChartHistorySeries({
        historyItems: historyByKpi[allocationKey] || [],
        frequencyMode,
        currentPeriodLabel: week,
        currentValue,
        windowSize: KPI_CHART_HISTORY_WINDOW
      });

      const historyActions = correctiveActionsEnabled
        ? sortKpiFormHistoryEntries(
          (correctiveActionHistoryByAllocation?.[allocationKey] || []).map((action) =>
            mapKpiFormCorrectiveAction(action, allocationId)
          ),
          (entry) => entry?.updated_at,
          frequencyMode
        )
        : [];
      const historyComments = sortKpiFormHistoryEntries(
        commentsByAllocation[allocationKey] || [],
        (entry) => entry?.updated_at,
        frequencyMode
      );

      return {
        allocation_id: allocationId,
        kpi_id: kpi.kpi_id,
        title: normalizeOptionalTextInput(kpi.indicator_sub_title) || "KPI",
        subject: normalizeOptionalTextInput(kpi.subject) || "",
        definition: normalizeOptionalTextInput(kpi.definition) || "",
        unit: displayUnit,
        frequency: normalizeOptionalTextInput(kpi.frequency) || formFrequencyLabel,
        value: currentValue,
        comment: kpi.latest_comment || "",
        target: targetValue,
        low_limit: lowLimit,
        high_limit: highLimit,
        good_direction: goodDirection,
        needs_corrective_action: initialNeedsCA,
        has_valid_corrective_action: hasValidCA,
        corrective_action_count: kpi.corrective_action_count || 0,
        last_updated: kpi.last_updated || null,
        chart: {
          labels: chartSeries.labels,
          values: chartSeries.values,
          current_period_label: chartSeries.currentPeriodLabel || week
        },
        current_actions: correctiveActionsEnabled
          ? sortCorrectiveActions(currentPeriodActions).map((action) =>
            mapKpiFormCorrectiveAction(action, allocationId)
          )
          : [],
        history_actions: historyActions,
        history_comments: historyComments
      };
    });

    res.json({
      ...basePayload,
      has_initial_invalid_kpi: hasInitialInvalidKpi,
      kpis: formKpis
    });
  } catch (err) {
    console.error("GET /api/responsibles/:responsibleId/kpi-form error:", err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to load the KPI entry form."
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/responsibles/:responsibleId/dashboard-context
//
// Bootstrap payload for the original GET /responsible/:responsibleId/dashboard
// HTML page (index.js:8548-24318, 15771 lines -- the responsible's KPI /
// target-allocation admin console). That page ran four loaders server-side and
// inlined their results into the markup as JS consts:
//   loadFormResponsibleContext(responsibleId)  -> `responsibleName`/`responsibleId`
//   loadRoleOptions()                          -> `roleOptions`
//   loadKpiTargetAllocationLookups()           -> `allocationLookups`
//   loadSubjectHierarchyData()                 -> `kpiSubjectHierarchy`
// Nothing in Etape 1 exposed roleOptions or allocationLookups as JSON, and the
// whole target-allocation matrix (unit / role / zone / product-line scopes,
// responsible resolution from people_role_assignment) is driven by them, so the
// React page cannot work without this endpoint.
//
// This is a faithful port of loadRoleOptions (index.js:3388) and
// loadKpiTargetAllocationLookups (index.js:3403): same SQL, same shaping. All
// tables it touches (role, unit, unit_type, zone, product_line, product, market,
// customer, people, people_role_assignment) were verified present in the current
// database via information_schema -- unlike the legacy public."Responsible" /
// public."Kpi" tables other parts of this page's domain still reference.
//
// Return the same active subject hierarchy as the original Excel-style picker.
// The selected node ID is submitted alongside its full path when saving a KPI.
// ---------------------------------------------------------------------------
router.get("/api/responsibles/:responsibleId/dashboard-context", async (req, res) => {
  try {
    const responsibleId = normalizeOptionalIntegerInput(req.params.responsibleId);
    if (!responsibleId) {
      return res.status(400).json({ error: "Missing responsible_id" });
    }

    const responsibleContext = await loadFormResponsibleContext(responsibleId);

    const [
      rolesResult,
      unitsResult,
      unitTypesResult,
      zonesResult,
      productLinesResult,
      productsResult,
      marketsResult,
      customersResult,
      peopleResult,
      multisiteAssignmentsResult,
      peopleRoleAssignmentsResult,
      roleScopeAssignmentsResult,
      productLineAssignmentsResult,
      subjectHierarchy,
      endedInactiveAllocationsResult
    ] = await Promise.all([
      pool.query(`
        SELECT role_id, role_name
        FROM public.role
        ORDER BY role_name, role_id
      `),

      pool.query(`
        SELECT
          u.unit_id,
          u.unit_name,
          u.unit_type_id,
          ut.unit_type_name,
          u.selling_currency,
          u.operating_currency
        FROM public.unit u
        INNER JOIN public.unit_type ut
          ON ut.unit_type_id = u.unit_type_id
        WHERE u.status_id = 1
          AND LOWER(TRIM(ut.unit_type_name)) = 'factory'
        ORDER BY u.unit_name, u.unit_id
      `),

      pool.query(`
        SELECT unit_type_id, unit_type_name
        FROM public.unit_type
        ORDER BY unit_type_name, unit_type_id
      `),

      pool.query(`
        SELECT
          z.zone_id,
          z.zone_name,
          pra.people_id AS responsible_people_id,
          pra.role_id AS responsible_role_id,
          COALESCE(r.role_name, '') AS responsible_role_name,
          COALESCE(pra.is_primary, false) AS responsible_is_primary,
          p.name AS responsible_name,
          p.first_name AS responsible_first_name
        FROM public.zone z
        LEFT JOIN public.people_role_assignment pra
          ON pra.zone_id = z.zone_id
         AND pra.assignment_status = 'ACTIVE'
        LEFT JOIN public.people p
          ON p.people_id = pra.people_id
        LEFT JOIN public.role r
          ON r.role_id = pra.role_id
        ORDER BY
          z.zone_name,
          z.zone_id,
          COALESCE(pra.is_primary, false) DESC,
          pra.assignment_id DESC,
          p.name,
          p.first_name,
          p.people_id
      `),

      pool.query(`
        SELECT product_line_id, product_line_name
        FROM public.product_line
        ORDER BY product_line_name, product_line_id
      `),

      pool.query(`
        SELECT product_id, product_name
        FROM public.product
        ORDER BY product_name, product_id
      `),

      pool.query(`
        SELECT market_id, market_name
        FROM public.market
        ORDER BY market_name, market_id
      `),

      pool.query(`
        SELECT customer_id, customer_name
        FROM public.customer
        ORDER BY customer_name, customer_id
      `),

      pool.query(`
        SELECT people_id, name, first_name
        FROM public.people
        ORDER BY name, first_name, people_id
      `),

      pool.query(`
        SELECT
          u.unit_id,
          u.unit_name,
          u.unit_type_id,
          ut.unit_type_name,
          u.selling_currency,
          u.operating_currency,
          pra.people_id,
          p.name,
          p.first_name,
          pra.role_id,
          COALESCE(r.role_name, '') AS role_name,
          COALESCE(pra.is_primary, false) AS is_primary
        FROM public.unit u
        INNER JOIN public.unit_type ut
          ON ut.unit_type_id = u.unit_type_id
        LEFT JOIN public.people_role_assignment pra
          ON pra.unit_id = u.unit_id
         AND COALESCE(pra.assignment_status, 'ACTIVE') = 'ACTIVE'
         AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
        LEFT JOIN public.people p
          ON p.people_id = pra.people_id
        LEFT JOIN public.role r
          ON r.role_id = pra.role_id
        WHERE u.status_id = 1
        ORDER BY
          ut.unit_type_name,
          u.unit_name,
          r.role_name,
          pra.is_primary DESC,
          p.name,
          p.first_name,
          p.people_id
      `),

      pool.query(`
        SELECT
          pra.assignment_id,
          pra.people_id,
          pra.role_id,
          pra.unit_id,
          pra.zone_id,
          pra.market_id,
          pra.product_line_id,
          pra.is_primary,
          pra.assignment_status,
          p.name,
          p.first_name,
          COALESCE(r.role_name, '') AS role_name,
          u.unit_name,
          u.unit_type_id,
          COALESCE(ut.unit_type_name, '') AS unit_type_name,
          u.selling_currency,
          u.operating_currency
        FROM public.people_role_assignment pra
        JOIN public.people p
          ON p.people_id = pra.people_id
        LEFT JOIN public.role r
          ON r.role_id = pra.role_id
        LEFT JOIN public.unit u
          ON u.unit_id = pra.unit_id
        LEFT JOIN public.unit_type ut
          ON ut.unit_type_id = u.unit_type_id
        WHERE COALESCE(pra.assignment_status, 'ACTIVE') = 'ACTIVE'
          AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
        ORDER BY
          pra.role_id,
          pra.is_primary DESC,
          u.unit_name,
          p.name,
          p.first_name,
          pra.people_id
      `),

      pool.query(`
        SELECT
          pra.assignment_id,
          pra.people_id,
          pra.role_id,
          pra.unit_id,
          pra.zone_id,
          pra.market_id,
          pra.product_line_id,
          pra.is_primary,
          pra.assignment_status,
          pra.start_date,
          pra.end_date,
          p.name,
          p.first_name,
          COALESCE(r.role_name, '') AS role_name,
          u.unit_name,
          u.unit_type_id,
          COALESCE(ut.unit_type_name, '') AS unit_type_name,
          u.selling_currency,
          u.operating_currency
        FROM public.people_role_assignment pra
        LEFT JOIN public.people p
          ON p.people_id = pra.people_id
        LEFT JOIN public.role r
          ON r.role_id = pra.role_id
        LEFT JOIN public.unit u
          ON u.unit_id = pra.unit_id
        LEFT JOIN public.unit_type ut
          ON ut.unit_type_id = u.unit_type_id
        ORDER BY
          pra.role_id,
          pra.assignment_id
      `),

      pool.query(`
        SELECT
          pl.product_line_id,
          pl.product_line_name,
          pra.people_id,
          pra.role_id,
          COALESCE(r.role_name, '') AS role_name,
          COALESCE(pra.is_primary, false) AS is_primary,
          p.name,
          p.first_name
        FROM public.product_line pl
        LEFT JOIN public.people_role_assignment pra
          ON pra.product_line_id = pl.product_line_id
         AND pra.assignment_status = 'ACTIVE'
         AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
        LEFT JOIN public.role r
          ON r.role_id = pra.role_id
        LEFT JOIN public.people p
          ON p.people_id = pra.people_id
        WHERE LOWER(TRIM(COALESCE(r.role_name, ''))) = 'product line manager'
        ORDER BY
          pl.product_line_name,
          COALESCE(pra.is_primary, false) DESC,
          p.name,
          p.first_name,
          pra.people_id
      `),
      loadSubjectHierarchyData(),

      // Targets deactivated with an end date: the unit + person is not listed again for that KPI.
      pool.query(`
        SELECT DISTINCT
          kpi_id,
          COALESCE(plant_id, unit_id) AS unit_id,
          set_by_people_id
        FROM public.kpi_target_allocation
        WHERE LOWER(TRIM(COALESCE(target_status, ''))) = 'inactive'
          AND target_end_date IS NOT NULL
          AND COALESCE(plant_id, unit_id) IS NOT NULL
          AND set_by_people_id IS NOT NULL
      `)
    ]);

    const roleOptions = rolesResult.rows.map((row) => ({
      value: String(row.role_id),
      label: normalizeOptionalTextInput(row.role_name) || `Role ${row.role_id}`
    }));

    const unitOptions = unitsResult.rows.map((row) => ({
      value: String(row.unit_id),
      label: normalizeOptionalTextInput(row.unit_name) || `Unit ${row.unit_id}`,
      unit_type_id: normalizeOptionalIntegerInput(row.unit_type_id),
      unit_type_name: normalizeOptionalTextInput(row.unit_type_name) || "",
      selling_currency: normalizeOptionalTextInput(row.selling_currency) || "",
      operating_currency: normalizeOptionalTextInput(row.operating_currency) || ""
    }));

    const multisiteAssignmentsMap = new Map(
      unitOptions.map((unit) => [
        String(unit.value),
        {
          value: String(unit.value),
          label: unit.label,
          unit_type_id: unit.unit_type_id,
          unit_type_name: unit.unit_type_name,
          selling_currency: unit.selling_currency,
          operating_currency: unit.operating_currency,
          responsibles: []
        }
      ])
    );

    multisiteAssignmentsResult.rows.forEach((row) => {
      const unitId = normalizeOptionalIntegerInput(row.unit_id);
      if (!unitId) return;

      const unitKey = String(unitId);

      if (!multisiteAssignmentsMap.has(unitKey)) {
        multisiteAssignmentsMap.set(unitKey, {
          value: unitKey,
          label: normalizeOptionalTextInput(row.unit_name) || `Unit ${unitKey}`,
          unit_type_id: normalizeOptionalIntegerInput(row.unit_type_id),
          unit_type_name: normalizeOptionalTextInput(row.unit_type_name) || "",
          selling_currency: normalizeOptionalTextInput(row.selling_currency) || "",
          operating_currency: normalizeOptionalTextInput(row.operating_currency) || "",
          responsibles: []
        });
      }

      if (!normalizeOptionalIntegerInput(row.people_id)) return;

      multisiteAssignmentsMap.get(unitKey).responsibles.push({
        people_id: String(row.people_id),
        label: getPeopleDisplayName(row) || `Person ${row.people_id}`,
        role_id: normalizeOptionalIntegerInput(row.role_id),
        role_name: normalizeOptionalTextInput(row.role_name) || "",
        is_primary: Boolean(row.is_primary)
      });
    });

    const zoneAssignmentsMap = new Map();

    zonesResult.rows.forEach((row) => {
      const zoneId = normalizeOptionalIntegerInput(row.zone_id);
      if (!zoneId) return;

      const zoneKey = String(zoneId);

      if (!zoneAssignmentsMap.has(zoneKey)) {
        zoneAssignmentsMap.set(zoneKey, {
          value: zoneKey,
          zone_id: zoneKey,
          label: normalizeOptionalTextInput(row.zone_name) || `Zone ${zoneKey}`,
          zone_name: normalizeOptionalTextInput(row.zone_name) || "",
          responsable_zone: "",
          responsible_people_id: "",
          responsibles: []
        });
      }

      const zoneEntry = zoneAssignmentsMap.get(zoneKey);
      const peopleId = normalizeOptionalIntegerInput(row.responsible_people_id);
      if (!peopleId) return;

      const normalizedPeopleId = String(peopleId);
      const responsibleLabel =
        getPeopleDisplayName({
          name: row.responsible_name,
          first_name: row.responsible_first_name
        }) || `Person ${normalizedPeopleId}`;

      const normalizedRoleId = String(
        normalizeOptionalIntegerInput(row.responsible_role_id) || ""
      ).trim();

      if (
        !zoneEntry.responsibles.some(
          (entry) =>
            String(entry.people_id || "") === normalizedPeopleId &&
            String(entry.role_id || "") === normalizedRoleId
        )
      ) {
        zoneEntry.responsibles.push({
          people_id: normalizedPeopleId,
          label: responsibleLabel,
          role_id: normalizeOptionalIntegerInput(row.responsible_role_id),
          role_name: normalizeOptionalTextInput(row.responsible_role_name) || "",
          is_primary: Boolean(row.responsible_is_primary)
        });
      }

      if (!zoneEntry.responsible_people_id) {
        zoneEntry.responsible_people_id = normalizedPeopleId;
        zoneEntry.responsable_zone = responsibleLabel;
      }
    });

    const productLineAssignmentsMap = new Map();

    productLineAssignmentsResult.rows.forEach((row) => {
      const productLineId = normalizeOptionalIntegerInput(row.product_line_id);
      if (!productLineId) return;

      const productLineKey = String(productLineId);

      if (!productLineAssignmentsMap.has(productLineKey)) {
        productLineAssignmentsMap.set(productLineKey, {
          value: productLineKey,
          product_line_id: productLineKey,
          label:
            normalizeOptionalTextInput(row.product_line_name) ||
            `Product line ${productLineKey}`,
          product_line_name: normalizeOptionalTextInput(row.product_line_name) || "",
          responsible_people_id: "",
          responsable_product_line: "",
          responsibles: []
        });
      }

      const productLineEntry = productLineAssignmentsMap.get(productLineKey);
      const peopleId = normalizeOptionalIntegerInput(row.people_id);
      if (!peopleId) return;

      const responsibleLabel = getPeopleDisplayName(row) || `Person ${peopleId}`;

      productLineEntry.responsibles.push({
        people_id: String(peopleId),
        label: responsibleLabel,
        role_id: normalizeOptionalIntegerInput(row.role_id),
        role_name: normalizeOptionalTextInput(row.role_name) || "",
        is_primary: Boolean(row.is_primary)
      });

      if (!productLineEntry.responsible_people_id) {
        productLineEntry.responsible_people_id = String(peopleId);
        productLineEntry.responsable_product_line = responsibleLabel;
      }
    });

    const allocationLookups = {
      plants: unitOptions,
      units: unitOptions,

      unitTypes: unitTypesResult.rows.map((row) => ({
        value: String(row.unit_type_id),
        label:
          normalizeOptionalTextInput(row.unit_type_name) ||
          `Unit type ${row.unit_type_id}`
      })),

      multisiteAssignments: Array.from(multisiteAssignmentsMap.values()),
      zones: Array.from(zoneAssignmentsMap.values()),

      productLines: productLinesResult.rows.map((row) => {
        const productLineId = String(row.product_line_id);
        const assignmentEntry = productLineAssignmentsMap.get(productLineId);

        return {
          value: productLineId,
          label:
            normalizeOptionalTextInput(row.product_line_name) ||
            `Product line ${productLineId}`,
          product_line_id: productLineId,
          product_line_name: normalizeOptionalTextInput(row.product_line_name) || "",
          responsible_people_id: assignmentEntry?.responsible_people_id || "",
          responsable_product_line: assignmentEntry?.responsable_product_line || "",
          responsibles: assignmentEntry?.responsibles || []
        };
      }),

      products: productsResult.rows.map((row) => ({
        value: String(row.product_id),
        label:
          normalizeOptionalTextInput(row.product_name) || `Product ${row.product_id}`
      })),

      markets: marketsResult.rows.map((row) => ({
        value: String(row.market_id),
        label:
          normalizeOptionalTextInput(row.market_name) || `Market ${row.market_id}`
      })),

      customers: customersResult.rows.map((row) => ({
        value: String(row.customer_id),
        label:
          normalizeOptionalTextInput(row.customer_name) || `Customer ${row.customer_id}`
      })),

      people: peopleResult.rows.map((row) => ({
        value: String(row.people_id),
        label: getPeopleDisplayName(row) || `Person ${row.people_id}`
      })),

      peopleRoleAssignments: peopleRoleAssignmentsResult.rows.map((row) => ({
        assignment_id: row.assignment_id,
        people_id: String(row.people_id),
        value: String(row.people_id),
        role_id: normalizeOptionalIntegerInput(row.role_id),
        unit_id: normalizeOptionalIntegerInput(row.unit_id),
        zone_id: normalizeOptionalIntegerInput(row.zone_id),
        market_id: normalizeOptionalIntegerInput(row.market_id),
        product_line_id: normalizeOptionalIntegerInput(row.product_line_id),
        is_primary: Boolean(row.is_primary),
        assignment_status: normalizeOptionalTextInput(row.assignment_status) || "",
        role_name: normalizeOptionalTextInput(row.role_name) || "",
        unit_name: normalizeOptionalTextInput(row.unit_name) || "",
        unit_type_id: normalizeOptionalIntegerInput(row.unit_type_id),
        unit_type_name: normalizeOptionalTextInput(row.unit_type_name) || "",
        selling_currency: normalizeOptionalTextInput(row.selling_currency) || "",
        operating_currency: normalizeOptionalTextInput(row.operating_currency) || "",
        label: getPeopleDisplayName(row) || `Person ${row.people_id}`
      })),

      roleScopeAssignments: roleScopeAssignmentsResult.rows.map((row) => ({
        assignment_id: row.assignment_id,
        people_id: String(row.people_id || ""),
        value: String(row.people_id || ""),
        role_id: normalizeOptionalIntegerInput(row.role_id),
        unit_id: normalizeOptionalIntegerInput(row.unit_id),
        zone_id: normalizeOptionalIntegerInput(row.zone_id),
        market_id: normalizeOptionalIntegerInput(row.market_id),
        product_line_id: normalizeOptionalIntegerInput(row.product_line_id),
        is_primary: Boolean(row.is_primary),
        assignment_status: normalizeOptionalTextInput(row.assignment_status) || "",
        start_date: normalizeOptionalTextInput(row.start_date) || "",
        end_date: normalizeOptionalTextInput(row.end_date) || "",
        role_name: normalizeOptionalTextInput(row.role_name) || "",
        unit_name: normalizeOptionalTextInput(row.unit_name) || "",
        unit_type_id: normalizeOptionalIntegerInput(row.unit_type_id),
        unit_type_name: normalizeOptionalTextInput(row.unit_type_name) || "",
        selling_currency: normalizeOptionalTextInput(row.selling_currency) || "",
        operating_currency: normalizeOptionalTextInput(row.operating_currency) || "",
        label: getPeopleDisplayName(row) || (row.people_id ? `Person ${row.people_id}` : "")
      })),

      endedInactiveAllocations: endedInactiveAllocationsResult.rows.map((row) => ({
        kpi_id: String(row.kpi_id),
        unit_id: String(row.unit_id),
        people_id: String(row.set_by_people_id)
      }))
    };

    res.json({
      responsible: {
        people_id: String(responsibleContext?.people_id || responsibleId),
        name: responsibleContext?.name || "KPI Workspace",
        plant_name: responsibleContext?.plant_name || "",
        department_name: responsibleContext?.department_name || "",
        role_name: responsibleContext?.role_name || ""
      },
      role_options: roleOptions,
      subject_hierarchy: filterActiveSubjectTree(subjectHierarchy.tree),
      allocation_lookups: allocationLookups
    });
  } catch (err) {
    console.error(
      "GET /api/responsibles/:responsibleId/dashboard-context error:",
      err.message
    );
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to load the dashboard context."
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/responsibles/:responsibleId/kpi-monthly-series
//
// Live replacement for GET /api/responsibles/:responsibleId/kpi-history-monthly
// (migrated as-is in Etape 1) which feeds the "My KPI Analytics" chart section of
// the responsible dashboard page. The original query reads
// public.kpi_values_hist26 JOIN public."Kpi" -- both confirmed absent from the
// current database via information_schema -- so that endpoint has been throwing
// on every request since long before this migration and the charts section has
// always rendered "No KPI history found for this responsible."
//
// This endpoint keeps the original's response shape exactly (one entry per KPI
// with labels[]/values[]/targetValue/highLimitValue/lowLimitValue/targetDirection,
// one point per calendar month, latest row of each month) but reads the live
// source used everywhere else in this codebase: kpi_result joined to
// kpi_target_allocation (scoped by kta.set_by_people_id, the same scope as
// GET /api/responsibles/:id/dashboard) and public.kpi.
//
// Without parameters it returns the dashboard owner's KPIs, as before. CEO, VP,
// plant / zone managers and administrators can also ask for other responsibles
// of their scope (services/kpiAnalyticsScope.service.js):
// ?responsible=<people_id>|all&unit_id=<unit_id>. Each series then carries its
// responsible and their unit. Each series also carries the KPI's frequency, which
// the page filters on client-side (the points stay one per calendar month).
// ---------------------------------------------------------------------------
const kpiAnalyticsScope = createKpiAnalyticsScope({ db: pool });

// Units and responsibles the signed-in user can pick in "My KPI Analytics".
router.get("/api/responsibles/:responsibleId/kpi-analytics-filters", async (req, res) => {
  try {
    res.json(await kpiAnalyticsScope.getFilters(req.auth?.user));
  } catch (err) {
    console.error("GET /api/responsibles/:responsibleId/kpi-analytics-filters error:", err.message);
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to load the KPI analytics filters."
    });
  }
});

router.get("/api/responsibles/:responsibleId/kpi-monthly-series", async (req, res) => {
  try {
    const responsibleId = normalizeOptionalIntegerInput(req.params.responsibleId);
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

    const peopleIds = await kpiAnalyticsScope.resolveSelection(req.auth?.user, {
      ownerId: responsiblePeopleId,
      responsible: req.query.responsible,
      unitId: req.query.unit_id
    });
    if (!peopleIds.length) return res.json([]);

    const result = await pool.query(
      `
      WITH ranked AS (
        SELECT
          kta.set_by_people_id AS responsible_id,
          kr.kpi_id,
          DATE_TRUNC('month', COALESCE(kr.result_date::timestamp, kr.recorded_at)) AS month_start,
          TO_CHAR(
            DATE_TRUNC('month', COALESCE(kr.result_date::timestamp, kr.recorded_at)),
            'Mon YYYY'
          ) AS month_label,
          kr.raw_value AS value_num,
          COALESCE(kr.target_value, kta.target_value, k.target_value) AS target,
          COALESCE(kr.upper_limit, k.high_limit) AS high_limit,
          COALESCE(kr.lower_limit, k.low_limit) AS low_limit,
          k.target_direction,
          NULLIF(TRIM(k.frequency), '') AS frequency,
          COALESCE(k.kpi_name, k.kpi_sub_title, 'KPI') AS indicator_title,
          COALESCE(k.kpi_sub_title, k.kpi_name, '') AS indicator_sub_title,
          ROW_NUMBER() OVER (
            PARTITION BY
              kta.set_by_people_id,
              kr.kpi_id,
              DATE_TRUNC('month', COALESCE(kr.result_date::timestamp, kr.recorded_at))
            ORDER BY COALESCE(kr.recorded_at, kr.result_date::timestamp) DESC,
                     kr.kpi_result_id DESC
          ) AS rn
        FROM public.kpi_result kr
        JOIN public.kpi_target_allocation kta
          ON kta.kpi_target_allocation_id = kr.kpi_target_allocation_id
        JOIN public.kpi k
          ON k.kpi_id = kr.kpi_id
        WHERE kta.set_by_people_id = ANY($1::int[])
          AND kr.raw_value IS NOT NULL
      )
      SELECT
        ranked.responsible_id,
        TRIM(CONCAT_WS(' ', p.first_name, p.name)) AS responsible_name,
        wu.unit_name,
        kpi_id,
        indicator_title,
        indicator_sub_title,
        high_limit,
        low_limit,
        target,
        target_direction,
        frequency,
        month_start,
        month_label,
        value_num
      FROM ranked
      LEFT JOIN public.people p ON p.people_id = ranked.responsible_id
      LEFT JOIN public.unit wu ON wu.unit_id = p.work_at_unit_id
      WHERE rn = 1
      ORDER BY wu.unit_name, p.name, p.first_name, ranked.responsible_id, kpi_id, month_start
      `,
      [peopleIds]
    );

    // One series per responsible and KPI (a KPI can be allocated to several).
    const grouped = new Map();

    for (const row of result.rows) {
      const key = `${row.responsible_id}:${row.kpi_id}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          responsible_id: row.responsible_id,
          responsible_name: row.responsible_name || "",
          unit_name: row.unit_name || "",
          kpi_id: row.kpi_id,
          indicator_title: row.indicator_title,
          indicator_sub_title: row.indicator_sub_title,
          labels: [],
          values: [],
          targetValue:
            row.target !== null && row.target !== "" ? Number(row.target) : null,
          highLimitValue: row.high_limit !== null ? Number(row.high_limit) : null,
          lowLimitValue: row.low_limit !== null ? Number(row.low_limit) : null,
          targetDirection: row.target_direction || "Up",
          // Weekly / Monthly / ... -- the analytics page filters on it.
          frequency: row.frequency || ""
        });
      }

      grouped.get(key).labels.push(row.month_label);
      grouped.get(key).values.push(Number(row.value_num) || 0);
    }

    res.json([...grouped.values()]);
  } catch (err) {
    console.error(
      "GET /api/responsibles/:responsibleId/kpi-monthly-series error:",
      err.message
    );
    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to load KPI monthly series."
    });
  }
});

module.exports = router;
