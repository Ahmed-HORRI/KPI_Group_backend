const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const {
  KPI_TRAINING_DEFAULT_TEST_DUE_DAYS,
  buildNormalizedQuestionnaire,
  mergeTrainingQuestions,
  normalizeSubmittedTrainingAnswers,
  scoreTrainingQuestionnaire,
  buildTrainingPortalAssignment,
  loadKpiTrainingPortalRows,
  runKpiTrainingReminderEscalationJob,
  sendKpiTrainingLinksToResponsibles,
} = require("../services/kpiTraining.service");

router.get("/api/kpi-training/portal", async (req, res) => {
  try {
    const peopleId = normalizeOptionalIntegerInput(req.query.people_id);
    const focusedResultId = normalizeOptionalIntegerInput(req.query.result_id);

    if (!peopleId) {
      return res.status(400).json({ error: "Missing people_id" });
    }

    const rows = await loadKpiTrainingPortalRows({
      peopleId
    });
    const assignments = rows.map((row) => buildTrainingPortalAssignment(row));
    const activeResultId = assignments.some((assignment) => assignment.result_id === focusedResultId)
      ? focusedResultId
      : assignments[0]?.result_id || null;

    res.json({
      people: assignments[0]?.responsible || {
        people_id: peopleId,
        name: "Responsible",
        email: null,
        role_name: ""
      },
      active_result_id: activeResultId,
      assignments
    });
  } catch (error) {
    console.error("[KPI Training Portal] Error:", error.message);
    res.status(500).json({ error: "Failed to load training portal." });
  }
});

router.post("/api/kpi-training/results/:resultId/training-complete", async (req, res) => {
  try {
    const resultId = normalizeOptionalIntegerInput(req.params.resultId);
    if (!resultId) {
      return res.status(400).json({ error: "Missing result id." });
    }

    const lookupResult = await pool.query(
      `
      SELECT result_id, test_id, status
      FROM public.kpi_training_result
      WHERE result_id = $1
      LIMIT 1
      `,
      [resultId]
    );

    const existingRow = lookupResult.rows[0];
    if (!existingRow) {
      return res.status(404).json({ error: "Training assignment not found." });
    }

    const nextStatus = normalizeOptionalIntegerInput(existingRow.test_id)
      ? "test_sent"
      : "training_done";

    await pool.query(
      `
      UPDATE public.kpi_training_result
      SET
        training_completed_at = COALESCE(training_completed_at, NOW()),
        test_sent_at = CASE
          WHEN test_id IS NOT NULL THEN COALESCE(test_sent_at, NOW())
          ELSE test_sent_at
        END,
        test_due_date = CASE
          WHEN test_id IS NOT NULL THEN COALESCE(test_due_date, CURRENT_DATE + $2::int)
          ELSE test_due_date
        END,
        status = CASE
          WHEN status IN ('completed_pass', 'completed_fail') THEN status
          ELSE $3
        END,
        updated_at = NOW()
      WHERE result_id = $1
      `,
      [resultId, KPI_TRAINING_DEFAULT_TEST_DUE_DAYS, nextStatus]
    );

    const refreshedRows = await loadKpiTrainingPortalRows({ resultId });
    const assignment = refreshedRows[0] ? buildTrainingPortalAssignment(refreshedRows[0]) : null;

    res.json({
      ok: true,
      assignment
    });
  } catch (error) {
    console.error("[KPI Training Complete] Error:", error.message);
    res.status(500).json({ error: "Failed to update training progress." });
  }
});

router.post("/api/kpi-training/results/:resultId/test-submit", async (req, res) => {
  try {
    const resultId = normalizeOptionalIntegerInput(req.params.resultId);
    if (!resultId) {
      return res.status(400).json({ error: "Missing result id." });
    }

    const rows = await loadKpiTrainingPortalRows({ resultId });
    const row = rows[0];

    if (!row) {
      return res.status(404).json({ error: "Training assignment not found." });
    }

    if (!normalizeOptionalIntegerInput(row.test_id)) {
      return res.status(400).json({ error: "No test is linked to this training assignment." });
    }

    if (row.test_completed_at) {
      return res.status(409).json({ error: "This test was already submitted." });
    }

    const questionnaireQuestions = buildNormalizedQuestionnaire(row.questionnaire_json);
    const trainingQuestions = buildNormalizedQuestionnaire(row.training_content);
    const fullQuestions = mergeTrainingQuestions(questionnaireQuestions, trainingQuestions);
    const scorableQuestions = fullQuestions.filter((question) => question.scorable);

    if (!scorableQuestions.length) {
      return res.status(400).json({ error: "This questionnaire is not fully configured for scoring yet." });
    }

    const submittedAnswers = normalizeSubmittedTrainingAnswers(req.body?.answers);
    const grading = scoreTrainingQuestionnaire(fullQuestions, submittedAnswers);
    if (grading.score === null) {
      return res.status(400).json({ error: "No valid answers were submitted." });
    }

    const passScore = Number.isFinite(Number(row.pass_score)) ? Number(row.pass_score) : 80;
    const passed = grading.score >= passScore;
    const answersPayload = {
      submitted_at: new Date().toISOString(),
      pass_score: passScore,
      score: grading.score,
      correct_count: grading.correctCount,
      scorable_count: grading.scorableCount,
      answers: submittedAnswers,
      questions: grading.responses
    };

    await pool.query(
      `
      UPDATE public.kpi_training_result
      SET
        training_completed_at = COALESCE(training_completed_at, NOW()),
        test_sent_at = COALESCE(test_sent_at, NOW()),
        test_due_date = COALESCE(test_due_date, CURRENT_DATE + $2::int),
        answers_json = $3::jsonb,
        score = $4,

        test_completed_at = NOW(),
        next_reminder_due_at = CASE
          WHEN $5::boolean = TRUE THEN NULL
          ELSE COALESCE(next_reminder_due_at, NOW() + ($2::int * INTERVAL '1 day'))
        END,
        status = $6,
        updated_at = NOW()
      WHERE result_id = $1
      `,
      [
        resultId,
        KPI_TRAINING_DEFAULT_TEST_DUE_DAYS,
        JSON.stringify(answersPayload),
        grading.score,
        passed,
        passed ? "completed_pass" : "completed_fail"
      ]
    );

    const refreshedRows = await loadKpiTrainingPortalRows({ resultId });
    const assignment = refreshedRows[0] ? buildTrainingPortalAssignment(refreshedRows[0]) : null;

    res.json({
      ok: true,
      score: grading.score,
      passed,
      assignment
    });
  } catch (error) {
    console.error("[KPI Training Submit Test] Error:", error.message);
    res.status(500).json({ error: "Failed to submit the questionnaire." });
  }
});

router.get("/api/kpi-training/results", async (req, res) => {
  try {
    const { status, kpi_id, people_id, passed } = req.query;
    const conditions = [];
    const params = [];
    const passedExpression = `
      COALESCE(
        ktr.passed,
        CASE
          WHEN ktr.score IS NULL THEN NULL
          WHEN ktr.score >= GREATEST(COALESCE(ktest.pass_score, 80), 80) THEN TRUE
          ELSE FALSE
        END
      )
    `;

    if (normalizeOptionalTextInput(status)) {
      params.push(status); conditions.push(`ktr.status = $${params.length}`);
    }
    if (normalizeOptionalIntegerInput(kpi_id)) {
      params.push(parseInt(kpi_id)); conditions.push(`ktr.kpi_id = $${params.length}`);
    }
    if (normalizeOptionalIntegerInput(people_id)) {
      params.push(parseInt(people_id)); conditions.push(`ktr.people_id = $${params.length}`);
    }
    if (passed === "true") conditions.push(`${passedExpression} = TRUE`);
    if (passed === "false") conditions.push(`${passedExpression} = FALSE`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT
        ktr.result_id,
        ktr.training_id,
        ktr.test_id,
        ktr.people_id,
        ktr.kpi_id,
        ktr.kpi_target_allocation_id,
        NULLIF(TRIM(CONCAT_WS(' ', COALESCE(p.first_name,''), COALESCE(p.name,''))), '') AS people_name,
        p.email AS people_email,
        pra_role.role_name,
        COALESCE(k.kpi_sub_title, k.kpi_name, 'KPI #' || ktr.kpi_id) AS kpi_name,
        k.frequency AS kpi_frequency,
        COALESCE(kt.training_name, 'Training #' || ktr.training_id) AS training_name,
        kt.version AS training_version,
        ktest.test_name,
        ktest.pass_score,
        ktr.status,
        ktr.score,
        COALESCE(
          ktr.passed,
          CASE
            WHEN ktr.score IS NULL THEN NULL
            WHEN ktr.score >= GREATEST(COALESCE(ktest.pass_score, 80), 80) THEN TRUE
            ELSE FALSE
          END
        ) AS passed,
        ktr.escalation_level,
        ktr.test_due_date,
        ktr.training_sent_at,
        ktr.training_completed_at,
        ktr.test_sent_at,
        ktr.test_completed_at,
        ktr.last_reminder_sent_at,
        ktr.next_reminder_due_at,
        ktr.comments,
        ktr.created_at,
        ktr.updated_at
      FROM public.kpi_training_result ktr
      LEFT JOIN public.people p ON p.people_id = ktr.people_id
      LEFT JOIN LATERAL (
        SELECT r.role_name
        FROM public.people_role_assignment pra
        JOIN public.role r ON r.role_id = pra.role_id
        WHERE pra.people_id = ktr.people_id
          AND COALESCE(pra.assignment_status,'ACTIVE') = 'ACTIVE'
          AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
        ORDER BY COALESCE(pra.is_primary,false) DESC,
                 pra.allocation_percentage DESC NULLS LAST,
                 pra.assignment_id DESC
        LIMIT 1
      ) pra_role ON TRUE
      LEFT JOIN public.kpi k           ON k.kpi_id          = ktr.kpi_id
      LEFT JOIN public.kpi_training kt ON kt.training_id    = ktr.training_id
      LEFT JOIN public.kpi_test ktest  ON ktest.test_id     = ktr.test_id
      ${where}
      ORDER BY
        CASE ktr.status
          WHEN 'escalated'      THEN 1
          WHEN 'test_overdue'   THEN 2
          WHEN 'completed_fail' THEN 3
          WHEN 'test_sent'      THEN 4
          WHEN 'training_done'  THEN 5
          WHEN 'training_sent'  THEN 6
          WHEN 'completed_pass' THEN 7
          ELSE 8
        END,
        ktr.escalation_level DESC,
        ktr.test_due_date ASC NULLS LAST,
        ktr.result_id DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error("[KPI Training Dashboard] Error:", error.message);
    res.status(500).json({ error: "Failed to load training results." });
  }
});

router.get("/api/kpi-training/stats", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                               AS total,
        COUNT(*) FILTER (
          WHERE (
            CASE
              WHEN ktr.score IS NULL THEN COALESCE(ktr.passed, false)
              WHEN ktr.score >= GREATEST(COALESCE(ktest.pass_score, 80), 80) THEN TRUE
              ELSE FALSE
            END
          ) = TRUE
        )                                                                     AS passed_count,
        COUNT(*) FILTER (WHERE score IS NOT NULL)                             AS tested_count,
        ROUND(AVG(score) FILTER (WHERE score IS NOT NULL), 1)                 AS avg_score,
        COUNT(*) FILTER (WHERE status IN ('test_overdue','escalated'))         AS overdue_escalated,
        COUNT(*) FILTER (
          WHERE status IN ('training_assigned','training_sent','training_done','test_sent','completed_fail')
            AND NOT (
              status = 'training_done'
              AND ktr.test_id IS NULL
              AND ktr.training_completed_at IS NOT NULL
            )
        )                                                                     AS pending
      FROM public.kpi_training_result ktr
      LEFT JOIN public.kpi_test ktest
        ON ktest.test_id = ktr.test_id
    `);
    const r = rows[0] || {};
    res.json({
      total: parseInt(r.total) || 0,
      passed_count: parseInt(r.passed_count) || 0,
      tested_count: parseInt(r.tested_count) || 0,
      avg_score: r.avg_score ? parseFloat(r.avg_score) : null,
      pass_rate: r.tested_count > 0
        ? Math.round(r.passed_count / r.tested_count * 100) : null,
      overdue_escalated: parseInt(r.overdue_escalated) || 0,
      pending: parseInt(r.pending) || 0,
    });
  } catch (error) {
    console.error("[KPI Training Stats] Error:", error.message);
    res.status(500).json({ error: "Failed to load training stats." });
  }
});

router.post("/api/kpi-training/send-responsible-links", async (req, res) => {
  try {
    const result = await sendKpiTrainingLinksToResponsibles();
    res.json(result);
  } catch (error) {
    console.error("[KPI Training Email] Error:", error.message);
    res.status(500).json({ error: "Failed to send KPI training links." });
  }
});

router.post("/api/kpi-training/process-reminders", async (req, res) => {
  try {
    const result = await runKpiTrainingReminderEscalationJob();
    res.json(result);
  } catch (error) {
    console.error("[KPI Training Reminder] Error:", error.message);
    res.status(500).json({ error: "Failed to process KPI training reminders." });
  }
});

module.exports = router;
