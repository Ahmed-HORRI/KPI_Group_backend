const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const {
  normalizeOptionalTextInput,
  normalizeOptionalIntegerInput,
  normalizeOptionalNumericInput,
} = require("../utils/normalize");
const {
  parseMetricNumber,
  parseToleranceDeltaValue,
  applyToleranceToTargetValue,
} = require("../services/kpiShared.service");
const {
  ensureKpiTargetAdjustmentSchema,
  hashKpiTargetAdjustmentToken,
  loadKpiTargetAdjustmentProposalByToken,
  sendKpiTargetAdjustmentDecisionEmail,
} = require("../services/kpiTargetAdjustment.service");
const { actorFromRequest, createKpiChangeLog } = require("../services/kpiChangeLog.service");

// An approved adjustment changes the target allocation: traced, by its approver.
const kpiChangeLog = createKpiChangeLog({ db: pool });

// Ported from the monolith's app.get("/kpi-target-adjustments/review", ...)
// (index.js). Returns the proposal as JSON instead of a server-rendered
// page — the React frontend renders its own UI from this payload.
router.get("/api/kpi-target-adjustments/proposal", async (req, res) => {
  try {
    const token = normalizeOptionalTextInput(req.query.token);
    const proposal = await loadKpiTargetAdjustmentProposalByToken(token);
    if (!proposal) {
      return res.status(404).json({
        error: "Cette proposition n’existe pas ou le lien n’est plus valide."
      });
    }
    res.set("Cache-Control", "no-store");
    res.json({ proposal });
  } catch (error) {
    console.error("KPI target adjustment review error:", error);
    res.status(500).json({ error: "Impossible de charger la proposition." });
  }
});

// Ported from the monolith's app.post("/kpi-target-adjustments/decision", ...)
// (index.js). Same transaction / FOR UPDATE / approve-reject logic, but
// responds with JSON instead of rendering the decision page.
router.post("/api/kpi-target-adjustments/decision", async (req, res) => {
  const token = normalizeOptionalTextInput(req.body.token);
  const action = String(req.body.action || "").trim().toLowerCase();
  const decisionComment = normalizeOptionalTextInput(req.body.decision_comment);
  if (!token || !["approve", "reject"].includes(action)) {
    return res.status(400).json({
      proposal: null,
      message: "Décision ou jeton invalide.",
      error: true
    });
  }

  let client;
  let proposal;
  try {
    await ensureKpiTargetAdjustmentSchema();
    client = await pool.connect();
    await client.query("BEGIN");
    const proposalRes = await client.query(
      `
      SELECT
        proposal.*,
        k.kpi_name,
        k.tolerance_type,
        k.up_tolerance,
        k.low_tolerance,
        kta.target_value AS current_target_value,
        kta.target_unit,
        kta.high_limit AS current_high_limit,
        kta.low_limit AS current_low_limit,
        responsible.email AS responsible_email
      FROM public.kpi_target_adjustment_proposal proposal
      JOIN public.kpi_target_allocation kta
        ON kta.kpi_target_allocation_id = proposal.kpi_target_allocation_id
      JOIN public.kpi k ON k.kpi_id = proposal.kpi_id
      LEFT JOIN public.people responsible
        ON responsible.people_id = proposal.triggered_by_people_id
      WHERE proposal.approval_token_hash = $1
      FOR UPDATE OF proposal, kta
      `,
      [hashKpiTargetAdjustmentToken(token)]
    );
    proposal = proposalRes.rows[0];
    if (!proposal) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        proposal: null,
        message: "Cette proposition n’existe pas ou le lien n’est plus valide.",
        error: true
      });
    }
    if (proposal.status !== "Pending approval") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        proposal,
        message: `Cette proposition est déjà ${proposal.status}.`,
        error: true
      });
    }

    if (action === "approve") {
      const currentTarget = parseMetricNumber(proposal.current_target_value);
      const expectedTarget = parseMetricNumber(proposal.previous_target_value);
      if (currentTarget === null || expectedTarget === null || Math.abs(currentTarget - expectedTarget) > 0.000001) {
        await client.query(
          `UPDATE public.kpi_target_adjustment_proposal SET status = 'Superseded', updated_at = NOW(), decided_at = NOW(), decision_comment = $2 WHERE proposal_id = $1`,
          [proposal.proposal_id, "The active target changed before approval."]
        );
        await client.query("COMMIT");
        proposal.status = "Superseded";
        return res.status(409).json({
          proposal,
          message: "La cible active a changé. Cette proposition a été remplacée et ne peut plus être approuvée.",
          error: true
        });
      }

      const proposedTarget = Number(proposal.proposed_target_value);
      const isRelative = String(proposal.tolerance_type || "").trim().toLowerCase() === "relative";
      let nextLowLimit;
      let nextHighLimit;
      if (isRelative) {
        nextLowLimit = applyToleranceToTargetValue(
          proposedTarget,
          parseToleranceDeltaValue(proposal.low_tolerance, proposal.tolerance_type, "low"),
          proposal.tolerance_type
        );
        nextHighLimit = applyToleranceToTargetValue(
          proposedTarget,
          parseToleranceDeltaValue(proposal.up_tolerance, proposal.tolerance_type, "up"),
          proposal.tolerance_type
        );
      } else {
        nextLowLimit = normalizeOptionalNumericInput(req.body.low_limit);
        nextHighLimit = normalizeOptionalNumericInput(req.body.high_limit);
        if (nextLowLimit === null || nextHighLimit === null) {
          await client.query("ROLLBACK");
          const fullProposal = await loadKpiTargetAdjustmentProposalByToken(token);
          return res.status(400).json({
            proposal: fullProposal,
            message: "Low Limit et High Limit sont obligatoires pour une tolérance absolue.",
            error: true
          });
        }
      }

      const allocationBefore = await kpiChangeLog.snapshotAllocations(client, [proposal.kpi_target_allocation_id]);
      await client.query(
        `
        UPDATE public.kpi_target_allocation
        SET
          previous_target_value = target_value,
          target_value = $2,
          last_best_target = $2,
          low_limit = $3,
          high_limit = $4,
          target_setup_date = CURRENT_DATE,
          target_status = 'Approved',
          approved_by_people_id = COALESCE($5, approved_by_people_id),
          updated_at = NOW()
        WHERE kpi_target_allocation_id = $1
        `,
        [
          proposal.kpi_target_allocation_id,
          proposedTarget,
          nextLowLimit,
          nextHighLimit,
          normalizeOptionalIntegerInput(proposal.approver_people_id)
        ]
      );
      // The decision belongs to the approver of the e-mail link, whoever is signed in.
      await kpiChangeLog.record(client, {
        entityType: "target_allocation",
        before: allocationBefore,
        after: await kpiChangeLog.snapshotAllocations(client, [proposal.kpi_target_allocation_id]),
        actor: {
          ...actorFromRequest(null, "target_review"),
          peopleId: normalizeOptionalIntegerInput(proposal.approver_people_id),
          ip: req.ip || null
        }
      });
      await client.query(
        `
        UPDATE public.kpi_target_adjustment_proposal
        SET status = 'Approved', decision_by_people_id = approver_people_id,
            decision_comment = $2, proposed_low_limit = $3, proposed_high_limit = $4,
            decided_at = NOW(), updated_at = NOW()
        WHERE proposal_id = $1
        `,
        [proposal.proposal_id, decisionComment, nextLowLimit, nextHighLimit]
      );
      proposal.status = "Approved";
    } else {
      await client.query(
        `
        UPDATE public.kpi_target_adjustment_proposal
        SET status = 'Rejected', decision_by_people_id = approver_people_id,
            decision_comment = $2, decided_at = NOW(), updated_at = NOW()
        WHERE proposal_id = $1
        `,
        [proposal.proposal_id, decisionComment]
      );
      proposal.status = "Rejected";
    }

    await client.query("COMMIT");
    sendKpiTargetAdjustmentDecisionEmail(proposal, action).catch((emailError) => {
      console.error("KPI target adjustment decision email error:", emailError.message);
    });
    const refreshedProposal = await loadKpiTargetAdjustmentProposalByToken(token);
    res.json({
      proposal: refreshedProposal,
      message: action === "approve"
        ? "La nouvelle cible a été approuvée et s’appliquera aux prochaines périodes."
        : "La proposition a été rejetée. La cible actuelle reste inchangée."
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("KPI target adjustment decision error:", error);
    res.status(500).json({
      proposal: proposal || null,
      message: "La décision n’a pas pu être enregistrée.",
      error: true
    });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
