const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { normalizeOptionalIntegerInput } = require("../utils/normalize");
const {
  normalizeText,
  inferKpiDirection,
  normalizeCorrectiveActionStatus,
  normalizeCorrectiveActionEstimatedDurationDays,
  normalizeCorrectiveActionImportance,
  normalizeCorrectiveActionUrgency,
} = require("../services/kpiShared.service");
const { getOpenAIClient } = require("../config/openai");
const {
  loadKpiAssistantConversationRow,
  generateKpiAssistantReply,
  generateCASuggestions,
} = require("../services/kpiAssistant.service");
const { ensureKpiAssistantConversationSchema } = require("../services/kpiKnowledgeBase.service");
const {
  hasPublicTable,
  canUseActionPlanCorrectiveActions,
  updateActionPlanCorrectiveActionStatus,
  ensureLegacyCorrectiveActionsSchema,
  upsertCorrectiveAction,
} = require("../services/actionPlan.service");

router.get("/generate-ca-suggestion", async (req, res) => {
  try {
    const { kpi_id, responsible_id, week } = req.query;

    const kpiRes = await pool.query(
      `SELECT k.kpi_id, k.subject, k.indicator_sub_title,
              k.unit, k.target, k.definition, k.calculation_on,
              k.frequency, k.low_limit, k.high_limit, kv.value
       FROM public."Kpi" k
       LEFT JOIN public.kpi_values kv
         ON kv.kpi_id = k.kpi_id
        AND kv.responsible_id = $2
        AND kv.week = $3
       WHERE k.kpi_id = $1
       LIMIT 1`,
      [kpi_id, responsible_id, week]
    );

    if (!kpiRes.rows.length)
      return res.status(404).json({ error: "KPI not found" });

    const suggestions = await generateCASuggestions(kpiRes.rows[0]);

    if (!suggestions || suggestions.length === 0)
      return res.status(500).json({ error: "Could not generate suggestion" });

    // Randomly pick one suggestion to give variety on re-generate
    const suggestion = suggestions[Math.floor(Math.random() * suggestions.length)];
    res.json({ suggestion });
  } catch (err) {
    console.error("Error generating CA suggestion:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/kpi-ai-assistant", async (req, res) => {
  const client = await pool.connect();

  try {
    await ensureKpiAssistantConversationSchema();

    const {
      responsible_id,
      week,
      selected_kpi_id,
      message,
      kpis
    } = req.body || {};

    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) {
      return res.status(400).json({ error: "Message is required" });
    }

    await client.query("BEGIN");

    const responsibleRes = await client.query(
      `SELECT
         p.people_id AS responsible_id,
         p.name,
         p.first_name,
         p.email,
         p.work_at_unit_id,
         u.unit_name AS plant_name
       FROM public.people p
       LEFT JOIN public.unit u ON u.unit_id = p.work_at_unit_id
       WHERE p.people_id = $1`,
      [responsible_id]
    );

    const responsible = responsibleRes.rows[0] || null;
    if (!responsible) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Responsible person not found" });
    }

    // Try to find a role assignment, but don't block if none exists
    const assignmentRes = await client.query(
      `SELECT assignment_id
   FROM public.people_role_assignment
   WHERE people_id = $1
     AND assignment_status = 'ACTIVE'
   ORDER BY is_primary DESC, assignment_id DESC
   LIMIT 1`,
      [responsible_id]
    );

    // Fall back to using people_id directly as the conversation key
    const assignment = assignmentRes.rows[0];
    const assignmentId = normalizeOptionalIntegerInput(assignment?.assignment_id);
    const peopleId =
      normalizeOptionalIntegerInput(responsible?.responsible_id) ||
      normalizeOptionalIntegerInput(responsible_id);

    if (!assignmentId && !peopleId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Responsible conversation identity is invalid"
      });
    }

    const selectedId = selected_kpi_id ? Number(selected_kpi_id) : null;

    let kpiId = null;
    let selectedKpiKnowledgeBase = null;

    if (selectedId) {
      const kpiLookupRes = await client.query(
        `SELECT kpi_id FROM public.kpi_target_allocation
     WHERE kpi_target_allocation_id = $1 LIMIT 1`,
        [selectedId]
      );
      kpiId = kpiLookupRes.rows[0]?.kpi_id ?? selectedId;

      const kpiKnowledgeBaseRes = await client.query(
        `SELECT kpi_knowledge_base
       FROM public.kpi
      WHERE kpi_id = $1
      LIMIT 1`,
        [kpiId]
      );
      selectedKpiKnowledgeBase = kpiKnowledgeBaseRes.rows[0]?.kpi_knowledge_base ?? null;

    }

    const existingConversationRow = await loadKpiAssistantConversationRow(
      client,
      {
        assignmentId,
        peopleId,
        kpiId,
        forUpdate: true
      }
    );

    const conversationHistory = Array.isArray(existingConversationRow?.conversation)
      ? existingConversationRow.conversation
      : [];

    const reply = await generateKpiAssistantReply({
      responsible,
      week,
      selectedKpiId: kpiId,
      kpis: Array.isArray(kpis) ? kpis : [],
      message: cleanMessage,
      conversationHistory,
      selectedKpiKnowledgeBase
    });

    const updatedConversation = [
      ...conversationHistory,
      {
        role: "user",
        content: cleanMessage,
        text: cleanMessage,
        ts: Date.now()
      },
      {
        role: "assistant",
        content: reply,
        text: reply,
        ts: Date.now()
      }
    ].slice(-50);

    if (existingConversationRow) {
      await client.query(
        `UPDATE public.kpi_assistant_conversation
         SET conversation = $1::jsonb,
             people_role_assignment_id = COALESCE($2, people_role_assignment_id),
             people_id = COALESCE($3, people_id),
             updated_at = CURRENT_TIMESTAMP
         WHERE conversation_id = $4`,
        [
          JSON.stringify(updatedConversation),
          assignmentId,
          peopleId,
          existingConversationRow.conversation_id
        ]
      );
    } else {
      await client.query(
        `INSERT INTO public.kpi_assistant_conversation
          (people_role_assignment_id, people_id, kpi_id, conversation)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          assignmentId,
          peopleId,
          kpiId,
          JSON.stringify(updatedConversation)
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      reply,
      conversation: updatedConversation
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("KPI AI assistant error:", err.message);
    res.status(500).json({ error: err.message || "Could not generate AI response" });
  } finally {
    client.release();
  }
});

router.get("/kpi-ai-assistant/conversation", async (req, res) => {
  const { responsible_id, kpi_id } = req.query;

  try {
    await ensureKpiAssistantConversationSchema();

    const assignmentRes = await pool.query(
      `
  SELECT 
    pra.assignment_id,
    pra.role_id,
    r.role_name,
    p.name
  FROM public.people_role_assignment pra
  JOIN public.role r
    ON r.role_id = pra.role_id
  JOIN public.people p
    ON p.people_id = pra.people_id
  WHERE pra.people_id = $1
    AND pra.assignment_status = 'ACTIVE'
  ORDER BY pra.is_primary DESC, pra.assignment_id DESC
  LIMIT 1
  `,
      [Number(responsible_id)]
    );

    const assignment = assignmentRes.rows[0];
    const assignmentId = normalizeOptionalIntegerInput(assignment?.assignment_id);
    const peopleId = normalizeOptionalIntegerInput(responsible_id);

    if (!assignmentId && !peopleId) {
      return res.json({ conversation: [] });
    }

    const selectedId = kpi_id ? Number(kpi_id) : null;
    let realKpiId = null;

    if (selectedId) {
      const kpiLookupRes = await pool.query(
        `
        SELECT kpi_id
        FROM public.kpi_target_allocation
        WHERE kpi_target_allocation_id = $1
        LIMIT 1
        `,
        [selectedId]
      );

      realKpiId = kpiLookupRes.rows[0]?.kpi_id ?? selectedId;
    }

    const existingConversationRow = await loadKpiAssistantConversationRow(
      pool,
      {
        assignmentId,
        peopleId,
        kpiId: realKpiId,
        forUpdate: false
      }
    );

    return res.json({
      conversation: existingConversationRow?.conversation ?? []
    });
  } catch (err) {
    console.error("Fetch conversation error:", err.message);
    return res.status(500).json({ conversation: [] });
  }
});

router.post("/api/corrective-actions/:correctiveActionId/status", async (req, res) => {
  try {
    const correctiveActionId = normalizeText(req.params.correctiveActionId);
    const nextStatus = normalizeCorrectiveActionStatus(req.body?.status);

    if (!correctiveActionId) {
      return res.status(400).json({ error: "Missing corrective action id" });
    }

    if (!nextStatus) {
      return res.status(400).json({ error: "Invalid corrective action status" });
    }

    if (await canUseActionPlanCorrectiveActions()) {
      const actionPlanResult = await updateActionPlanCorrectiveActionStatus(
        correctiveActionId,
        nextStatus
      );

      if (actionPlanResult) {
        return res.json(actionPlanResult);
      }
    }

    if (!(await hasPublicTable("corrective_actions"))) {
      return res.status(404).json({ error: "Corrective action not found" });
    }

    const result = await pool.query(
      `UPDATE public.corrective_actions
       SET status = $2::text,
           updated_date = NOW()
       WHERE corrective_action_id = $1
       RETURNING corrective_action_id, status`,
      [correctiveActionId, nextStatus]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Corrective action not found" });
    }

    res.json({
      corrective_action_id: result.rows[0].corrective_action_id,
      status: result.rows[0].status
    });
  } catch (err) {
    console.error("Error updating corrective action status:", err);
    res.status(500).json({ error: "Failed to update corrective action status" });
  }
});
// Ported from the monolith's app.post("/submit-corrective-action", ...)
// (index.js). The original read its fields off a raw HTML form post;
// this JSON version receives them directly in the request body.
router.post("/api/corrective-actions/submit", async (req, res) => {
  try {
    const {
      responsible_id,
      kpi_id,
      week,
      corrective_action_id,
      root_cause,
      implemented_solution,
      due_date,
      estimated_duration_days,
      responsible,
      importance,
      urgency
    } = req.body || {};

    if (!responsible_id || !kpi_id || !week) {
      return res.status(400).json({ error: "Missing responsible_id, kpi_id, or week" });
    }

    const saved = await upsertCorrectiveAction(responsible_id, kpi_id, week, {
      correctiveActionId: normalizeText(corrective_action_id),
      rootCause: normalizeText(root_cause),
      implementedSolution: normalizeText(implemented_solution),
      dueDate: due_date || null,
      estimatedDurationDays: estimated_duration_days,
      responsibleName: normalizeText(responsible),
      importance,
      urgency,
      status: normalizeCorrectiveActionStatus(req.body?.status),
      demandeur: normalizeText(req.body?.demandeur)
    });

    if (!saved) {
      return res.status(500).json({ error: "Could not save corrective action" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error submitting corrective action:", err);
    res.status(500).json({ error: "Could not save corrective action" });
  }
});

// Ported from the monolith's app.post("/submit-bulk-corrective-actions", ...)
// (index.js), preserving the exact UPDATE ... status = CASE SQL and the
// "completed" counting condition. The original parsed HTML form fields
// named `root_cause_<id>`, `solution_<id>`, etc.; this JSON version
// receives them directly in the `actions[]` array instead.
router.post("/api/corrective-actions/submit-bulk", async (req, res) => {
  try {
    await ensureLegacyCorrectiveActionsSchema();

    const { week, actions } = req.body || {};
    const submittedActions = Array.isArray(actions) ? actions : [];
    let completedCount = 0;

    for (const action of submittedActions) {
      const caId = action?.corrective_action_id;
      const rootCause = normalizeText(action?.root_cause);
      const solution = normalizeText(action?.implemented_solution);
      const dueDate = action?.due_date || null;
      const estimatedDurationDays = normalizeCorrectiveActionEstimatedDurationDays(
        action?.estimated_duration_days
      );
      const responsibleName = normalizeText(action?.responsible);
      const importance = normalizeCorrectiveActionImportance(action?.importance);
      const urgency = normalizeCorrectiveActionUrgency(action?.urgency);
      if (
        rootCause ||
        solution ||
        dueDate ||
        responsibleName ||
        estimatedDurationDays !== null ||
        importance ||
        urgency
      ) {
        await pool.query(
          `UPDATE public.corrective_actions
           SET root_cause=$1,
               implemented_solution=$2,
               due_date=$3::date,
               estimated_duration_days=$4::integer,
               responsible=$5::text,
               importance=$6::text,
               urgency=$7::text,
               status = CASE
                 WHEN $1::text IS NOT NULL
                  AND $2::text IS NOT NULL
                  AND $3::date IS NOT NULL
                  AND NULLIF(BTRIM($5::text), '') IS NOT NULL
                 THEN 'Waiting for validation'
                 ELSE status
               END,
               updated_date=NOW()
           WHERE corrective_action_id=$8`,
          [
            rootCause,
            solution,
            dueDate,
            estimatedDurationDays,
            responsibleName,
            importance,
            urgency,
            caId
          ]
        );
        if (rootCause && solution && dueDate && responsibleName) {
          completedCount++;
        }
      }
    }

    res.json({ completed_count: completedCount, week: week || null });
  } catch (err) {
    console.error("Error submitting bulk corrective actions:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
