// ============================================================
// KPI Target Adjustment domain — ported from the monolith
// (index.js) helpers backing:
//   - app.post("/redirect", ...)                         (proposal creation)
//   - app.get("/kpi-target-adjustments/review", ...)      (JSON: GET /api/kpi-target-adjustments/proposal)
//   - app.post("/kpi-target-adjustments/decision", ...)   (JSON: POST /api/kpi-target-adjustments/decision)
//
// Only the HTML page renderer (renderKpiTargetAdjustmentPage) is
// intentionally NOT ported — the React frontend renders its own
// UI from the JSON these functions produce.
// ============================================================

const crypto = require("crypto");
const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { createTransporter } = require("../config/mailer");
const { getPeopleDisplayName } = require("../models/kpi.model");
const { getPeopleHierarchy } = require("./hierarchyReport.service");
const {
  escapeHtml,
  parseMetricNumber,
  inferKpiDirection,
  calculateKpiTargetAdjustmentProposal,
} = require("./kpiShared.service");

let kpiTargetAdjustmentSchemaPromise = null;

const ensureKpiTargetAdjustmentSchema = async () => {
  if (!kpiTargetAdjustmentSchemaPromise) {
    kpiTargetAdjustmentSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.kpi_target_adjustment_proposal (
          proposal_id BIGSERIAL PRIMARY KEY,
          kpi_target_allocation_id INTEGER NOT NULL
            REFERENCES public.kpi_target_allocation (kpi_target_allocation_id)
            ON DELETE CASCADE,
          kpi_id INTEGER NOT NULL
            REFERENCES public.kpi (kpi_id)
            ON DELETE CASCADE,
          triggered_by_people_id INTEGER,
          approver_people_id INTEGER,
          decision_by_people_id INTEGER,
          previous_target_value NUMERIC NOT NULL,
          proposed_target_value NUMERIC NOT NULL,
          trigger_actual_value NUMERIC NOT NULL,
          improvement_percentage NUMERIC,
          consecutive_periods INTEGER NOT NULL DEFAULT 1,
          trigger_reason VARCHAR(80) NOT NULL,
          target_direction VARCHAR(16) NOT NULL,
          trigger_period_label VARCHAR(120),
          evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
          approval_token_hash VARCHAR(64) NOT NULL UNIQUE,
          status VARCHAR(40) NOT NULL DEFAULT 'Pending approval',
          decision_comment TEXT,
          proposed_low_limit NUMERIC,
          proposed_high_limit NUMERIC,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          decided_at TIMESTAMPTZ
        )
      `);

      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_target_adjustment_pending
        ON public.kpi_target_adjustment_proposal (kpi_target_allocation_id)
        WHERE status = 'Pending approval'
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kpi_target_adjustment_approver_status
        ON public.kpi_target_adjustment_proposal (approver_people_id, status, created_at DESC)
      `);
    })().catch((error) => {
      kpiTargetAdjustmentSchemaPromise = null;
      throw error;
    });
  }

  return kpiTargetAdjustmentSchemaPromise;
};

const hashKpiTargetAdjustmentToken = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

const getDirectManagerRecipient = async (peopleId) => {
  const hierarchy = await getPeopleHierarchy(peopleId);
  const directManager = Array.isArray(hierarchy) ? hierarchy[1] : null;
  const managerEmail = normalizeOptionalTextInput(directManager?.email);

  if (!directManager || !managerEmail) {
    return null;
  }

  return {
    people_id: normalizeOptionalIntegerInput(directManager.people_id),
    name:
      getPeopleDisplayName(directManager) ||
      managerEmail,
    email: managerEmail,
    role_name: normalizeOptionalTextInput(directManager.role_name) || "Manager"
  };
};

const getKpiTargetAdjustmentApprover = async (allocation = {}, triggeredByPeopleId = null) => {
  const configuredApproverId = normalizeOptionalIntegerInput(allocation.approved_by_people_id);

  if (configuredApproverId) {
    const configuredApproverRes = await pool.query(
      `
      SELECT people_id, first_name, name, email
      FROM public.people
      WHERE people_id = $1
        AND COALESCE(TRIM(email), '') <> ''
      LIMIT 1
      `,
      [configuredApproverId]
    );
    const configuredApprover = configuredApproverRes.rows[0];
    if (configuredApprover) {
      return {
        people_id: configuredApprover.people_id,
        name: getPeopleDisplayName(configuredApprover) || configuredApprover.email,
        email: configuredApprover.email,
        source: "allocation_approver"
      };
    }
  }

  const responsiblePeopleId =
    normalizeOptionalIntegerInput(triggeredByPeopleId) ||
    normalizeOptionalIntegerInput(allocation.set_by_people_id);
  const directManager = responsiblePeopleId
    ? await getDirectManagerRecipient(responsiblePeopleId)
    : null;

  return directManager
    ? { ...directManager, source: "direct_manager" }
    : null;
};

const evaluateAndCreateKpiTargetAdjustmentProposal = async ({
  allocation = {},
  allocationId,
  kpiId,
  actualValue,
  periodLabel,
  triggeredByPeopleId
} = {}) => {
  if (String(allocation.target_auto_adjustment || "").trim().toLowerCase() !== "yes") {
    return null;
  }

  const normalizedAllocationId = normalizeOptionalIntegerInput(allocationId);
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  const targetValue = parseMetricNumber(allocation.effective_target_value);
  if (!normalizedAllocationId || !normalizedKpiId || targetValue === null) {
    return null;
  }

  await ensureKpiTargetAdjustmentSchema();

  const pendingRes = await pool.query(
    `
    SELECT proposal_id
    FROM public.kpi_target_adjustment_proposal
    WHERE kpi_target_allocation_id = $1
      AND status = 'Pending approval'
    LIMIT 1
    `,
    [normalizedAllocationId]
  );
  if (pendingRes.rows.length) return null;

  const historyRes = await pool.query(
    `
    SELECT
      kr.raw_value,
      kr.target_value,
      COALESCE(kr.period_label, kr.week, TO_CHAR(kr.result_date, 'YYYY-MM-DD')) AS period_label,
      kr.result_date,
      kr.recorded_at
    FROM public.kpi_result kr
    WHERE kr.kpi_target_allocation_id = $1
      AND kr.raw_value IS NOT NULL
    ORDER BY
      COALESCE(kr.result_date::timestamp, kr.recorded_at) DESC,
      kr.recorded_at DESC,
      kr.kpi_result_id DESC
    LIMIT 3
    `,
    [normalizedAllocationId]
  );

  const direction = inferKpiDirection({
    ...allocation,
    target: targetValue,
    high_limit: allocation.high_limit,
    low_limit: allocation.low_limit
  });
  const calculation = calculateKpiTargetAdjustmentProposal({
    targetAutoAdjustment: allocation.target_auto_adjustment,
    targetValue,
    actualValue,
    direction,
    recentActualValues: historyRes.rows.map((row) => {
      const historicalTarget = parseMetricNumber(row.target_value);
      return historicalTarget !== null && Math.abs(historicalTarget - targetValue) <= 0.000001
        ? row.raw_value
        : targetValue;
    })
  });
  if (!calculation.eligible) return null;

  const approver = await getKpiTargetAdjustmentApprover(
    allocation,
    triggeredByPeopleId
  );
  const responsibleRes = normalizeOptionalIntegerInput(triggeredByPeopleId)
    ? await pool.query(
      `SELECT people_id, first_name, name, email FROM public.people WHERE people_id = $1 LIMIT 1`,
      [normalizeOptionalIntegerInput(triggeredByPeopleId)]
    )
    : { rows: [] };
  const responsible = responsibleRes.rows[0] || null;
  const approvalToken = crypto.randomBytes(32).toString("hex");
  const evidence = historyRes.rows.slice(0, calculation.consecutivePeriods).map((row) => ({
    period_label: row.period_label,
    actual_value: Number(row.raw_value)
  }));

  try {
    const insertRes = await pool.query(
      `
      INSERT INTO public.kpi_target_adjustment_proposal (
        kpi_target_allocation_id,
        kpi_id,
        triggered_by_people_id,
        approver_people_id,
        previous_target_value,
        proposed_target_value,
        trigger_actual_value,
        improvement_percentage,
        consecutive_periods,
        trigger_reason,
        target_direction,
        trigger_period_label,
        evidence,
        approval_token_hash
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
      RETURNING proposal_id, created_at
      `,
      [
        normalizedAllocationId,
        normalizedKpiId,
        normalizeOptionalIntegerInput(triggeredByPeopleId),
        normalizeOptionalIntegerInput(approver?.people_id),
        targetValue,
        calculation.proposedTargetValue,
        Number(actualValue),
        calculation.improvementPercentage,
        calculation.consecutivePeriods,
        calculation.triggerReason,
        calculation.direction,
        normalizeOptionalTextInput(periodLabel),
        JSON.stringify(evidence),
        hashKpiTargetAdjustmentToken(approvalToken)
      ]
    );

    return {
      proposal_id: insertRes.rows[0].proposal_id,
      allocation_id: normalizedAllocationId,
      kpi_id: normalizedKpiId,
      kpi_name: allocation.kpi_name || `KPI #${normalizedKpiId}`,
      subject_name: allocation.subject_name || "",
      unit: allocation.effective_unit || "",
      previous_target_value: targetValue,
      proposed_target_value: calculation.proposedTargetValue,
      trigger_actual_value: Number(actualValue),
      improvement_percentage: calculation.improvementPercentage,
      consecutive_periods: calculation.consecutivePeriods,
      trigger_reason: calculation.triggerReason,
      target_direction: calculation.direction,
      period_label: periodLabel,
      evidence,
      approval_token: approvalToken,
      approver,
      responsible: responsible
        ? {
          people_id: responsible.people_id,
          name: getPeopleDisplayName(responsible) || responsible.email || "KPI responsible",
          email: normalizeOptionalTextInput(responsible.email)
        }
        : null
    };
  } catch (error) {
    if (error?.code === "23505") return null;
    throw error;
  }
};

const getKpiTargetAdjustmentReasonLabelEnglish = (reason) => {
  if (reason === "three_consecutive_periods_and_five_percent") {
    return "3 consecutive improved periods and at least 5% improvement";
  }
  if (reason === "three_consecutive_periods") {
    return "3 consecutive improved periods";
  }
  return "At least 5% improvement in the current period";
};

const sendKpiTargetAdjustmentApprovalEmail = async (proposal = {}) => {
  const recipientEmail = normalizeOptionalTextInput(proposal.approver?.email);
  if (!recipientEmail || !proposal.approval_token) {
    console.warn(
      `[KPI Target Adjustment] Proposal ${proposal.proposal_id || ""} created without an approver email.`
    );
    return false;
  }

  const baseUrl = (
    normalizeOptionalTextInput(process.env.APP_BASE_URL) ||
    "https://kpi-form.azurewebsites.net"
  ).replace(/\/+$/, "");
  const reviewUrl = `${baseUrl}/kpi-target-adjustments/review?token=${encodeURIComponent(proposal.approval_token)}`;
  const directionLabel = proposal.target_direction === "down"
    ? "Lower is better"
    : "Higher is better";
  const directionArrow = proposal.target_direction === "down" ? "&#8595;" : "&#8593;";
  const improvementLabel = proposal.improvement_percentage === null || proposal.improvement_percentage === undefined
    ? "Not calculated"
    : `${escapeHtml(proposal.improvement_percentage)}%`;
  const evidenceRowsHtml = (proposal.evidence || [])
    .map((entry, index) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e9eef4;color:#667085;font-size:13px;">${escapeHtml(entry.period_label || `Period ${index + 1}`)}</td>
        <td align="right" style="padding:10px 12px;border-bottom:1px solid #e9eef4;color:#172033;font-size:14px;font-weight:700;">${escapeHtml(entry.actual_value)} ${escapeHtml(proposal.unit || "")}</td>
      </tr>
    `)
    .join("");
  const transporter = createTransporter();

  await transporter.sendMail({
    from: '"KPI Manager" <kpi-manager@avocarbon.com>',
    replyTo: "kpi-manager@avocarbon.com",
    to: recipientEmail,
    subject: `KPI target approval required - ${proposal.kpi_name}`,
    html: `
      <!doctype html>
      <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>KPI target approval</title>
      </head>
      <body style="margin:0;padding:0;background-color:#eef2f6;font-family:Segoe UI,Arial,sans-serif;color:#172033;">
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;">A new KPI target is waiting for your approval.</div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#eef2f6;">
          <tr>
            <td align="center" style="padding:28px 12px;">
              <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid #dce4ec;border-radius:18px;overflow:hidden;box-shadow:0 12px 30px rgba(15,23,42,.08);">
                <tr>
                  <td style="height:7px;font-size:0;line-height:0;background-color:#13aaa3;">&nbsp;</td>
                </tr>
                <tr>
                  <td style="padding:24px 30px;background-color:#102a43;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:-.3px;">KPI Group</td>
                        <td align="right"><span style="display:inline-block;padding:6px 10px;border-radius:20px;background-color:#fff3cd;color:#805b00;font-size:11px;font-weight:800;letter-spacing:.5px;">APPROVAL REQUIRED</span></td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:30px 30px 12px;">
                    <p style="margin:0 0 8px;color:#13a39c;font-size:12px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;">New target proposal</p>
                    <h1 style="margin:0;color:#172033;font-size:27px;line-height:1.2;letter-spacing:-.5px;">${escapeHtml(proposal.kpi_name)}</h1>
                    ${proposal.subject_name ? `<p style="margin:7px 0 0;color:#667085;font-size:14px;">${escapeHtml(proposal.subject_name)}</p>` : ""}
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 30px 0;">
                    <p style="margin:0;color:#475467;font-size:15px;line-height:1.65;">Hello <strong style="color:#172033;">${escapeHtml(proposal.approver?.name || "Manager")}</strong>,<br>a performance improvement has triggered a new target proposal. Your approval is required before it can take effect.</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:24px 30px 8px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td width="44%" valign="middle" style="padding:18px;border:1px solid #dfe6ee;border-radius:12px;background:#f8fafc;">
                          <div style="color:#667085;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Current target</div>
                          <div style="margin-top:7px;color:#344054;font-size:25px;font-weight:800;">${escapeHtml(proposal.previous_target_value)} <span style="font-size:13px;font-weight:600;color:#667085;">${escapeHtml(proposal.unit || "")}</span></div>
                        </td>
                        <td width="12%" align="center" style="color:#13a39c;font-size:25px;font-weight:900;">&#8594;</td>
                        <td width="44%" valign="middle" style="padding:18px;border:1px solid #9ddfd8;border-radius:12px;background:#eaf9f6;">
                          <div style="color:#087f78;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;">Proposed target</div>
                          <div style="margin-top:7px;color:#087f78;font-size:25px;font-weight:900;">${escapeHtml(proposal.proposed_target_value)} <span style="font-size:13px;font-weight:700;">${escapeHtml(proposal.unit || "")}</span></div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 30px 4px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #dfe6ee;border-radius:12px;overflow:hidden;">
                      <tr>
                        <td width="50%" style="padding:13px 16px;border-right:1px solid #e5eaf0;background:#ffffff;">
                          <div style="color:#667085;font-size:11px;font-weight:700;text-transform:uppercase;">Performance direction</div>
                          <div style="margin-top:5px;color:#172033;font-size:14px;font-weight:800;"><span style="color:#13a39c;font-size:18px;">${directionArrow}</span>&nbsp; ${directionLabel}</div>
                        </td>
                        <td width="50%" style="padding:13px 16px;background:#ffffff;">
                          <div style="color:#667085;font-size:11px;font-weight:700;text-transform:uppercase;">Current improvement</div>
                          <div style="margin-top:5px;color:#172033;font-size:14px;font-weight:800;">${improvementLabel}</div>
                        </td>
                      </tr>
                      <tr>
                        <td colspan="2" style="padding:13px 16px;border-top:1px solid #e5eaf0;background:#f8fafc;">
                          <div style="color:#667085;font-size:11px;font-weight:700;text-transform:uppercase;">KPI owner</div>
                          <div style="margin-top:5px;color:#172033;font-size:14px;font-weight:700;">${escapeHtml(proposal.responsible?.name || "Not specified")}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 30px 4px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fff8e6;border:1px solid #f0d69a;border-radius:12px;">
                      <tr>
                        <td width="42" valign="top" style="padding:15px 0 15px 16px;color:#a36b00;font-size:21px;">&#9679;</td>
                        <td style="padding:14px 16px 14px 8px;">
                          <div style="color:#805b00;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;">Why was this proposed?</div>
                          <div style="margin-top:5px;color:#5f470f;font-size:14px;line-height:1.5;">${escapeHtml(getKpiTargetAdjustmentReasonLabelEnglish(proposal.trigger_reason))}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ${evidenceRowsHtml ? `
                <tr>
                  <td style="padding:20px 30px 4px;">
                    <p style="margin:0 0 9px;color:#344054;font-size:13px;font-weight:800;">Analyzed values</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #dfe6ee;border-radius:10px;overflow:hidden;">
                      <tr><th align="left" style="padding:9px 12px;background:#f5f7fa;color:#667085;font-size:11px;text-transform:uppercase;">Period</th><th align="right" style="padding:9px 12px;background:#f5f7fa;color:#667085;font-size:11px;text-transform:uppercase;">Actual value</th></tr>
                      ${evidenceRowsHtml}
                    </table>
                  </td>
                </tr>` : ""}
                <tr>
                  <td align="center" style="padding:27px 30px 12px;">
                    <a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:14px 28px;border-radius:10px;background-color:#1677c8;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;box-shadow:0 6px 14px rgba(22,119,200,.22);">Review and decide</a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:0 30px 28px;">
                    <p style="margin:0;color:#667085;font-size:12px;line-height:1.5;">The active target will remain unchanged until you approve this proposal.</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:18px 30px;background:#f8fafc;border-top:1px solid #e5eaf0;">
                    <p style="margin:0;color:#98a2b3;font-size:11px;line-height:1.5;text-align:center;">KPI Group &bull; Automated target governance message<br>If the button does not work, open this link: <a href="${escapeHtml(reviewUrl)}" style="color:#1677c8;word-break:break-all;">${escapeHtml(reviewUrl)}</a></p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `
  });

  return true;
};

const loadKpiTargetAdjustmentProposalByToken = async (token, client = pool) => {
  const normalizedToken = normalizeOptionalTextInput(token);
  if (!normalizedToken) return null;
  await ensureKpiTargetAdjustmentSchema();

  const result = await client.query(
    `
    SELECT
      proposal.*,
      k.kpi_name,
      k.kpi_sub_title,
      k.tolerance_type,
      k.up_tolerance,
      k.low_tolerance,
      kta.target_value AS current_target_value,
      kta.target_unit,
      kta.high_limit AS current_high_limit,
      kta.low_limit AS current_low_limit,
      responsible.first_name AS responsible_first_name,
      responsible.name AS responsible_name,
      responsible.email AS responsible_email,
      approver.first_name AS approver_first_name,
      approver.name AS approver_name,
      approver.email AS approver_email
    FROM public.kpi_target_adjustment_proposal proposal
    JOIN public.kpi_target_allocation kta
      ON kta.kpi_target_allocation_id = proposal.kpi_target_allocation_id
    JOIN public.kpi k
      ON k.kpi_id = proposal.kpi_id
    LEFT JOIN public.people responsible
      ON responsible.people_id = proposal.triggered_by_people_id
    LEFT JOIN public.people approver
      ON approver.people_id = proposal.approver_people_id
    WHERE proposal.approval_token_hash = $1
    LIMIT 1
    `,
    [hashKpiTargetAdjustmentToken(normalizedToken)]
  );
  return result.rows[0] || null;
};

const sendKpiTargetAdjustmentDecisionEmail = async (proposal, action) => {
  const recipientEmail = normalizeOptionalTextInput(proposal?.responsible_email);
  if (!recipientEmail) return false;
  const approved = action === "approve";
  const statusColor = approved ? "#087f5b" : "#b42318";
  const statusBackground = approved ? "#e8f8f1" : "#fff0f0";
  const statusLabel = approved ? "TARGET APPROVED" : "PROPOSAL REJECTED";
  const transporter = createTransporter();
  await transporter.sendMail({
    from: '"KPI Manager" <kpi-manager@avocarbon.com>',
    replyTo: "kpi-manager@avocarbon.com",
    to: recipientEmail,
    subject: `${approved ? "KPI target approved" : "KPI target rejected"} - ${proposal.kpi_name}`,
    html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:0;background:#eef2f6;font-family:Segoe UI,Arial,sans-serif;color:#172033;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="padding:28px 12px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #dce4ec;border-radius:16px;overflow:hidden;">
            <tr><td style="height:7px;background:${statusColor};font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr><td style="padding:22px 28px;background:#102a43;color:#fff;font-size:19px;font-weight:800;">KPI Group</td></tr>
            <tr><td style="padding:28px;">
              <span style="display:inline-block;padding:6px 10px;border-radius:20px;background:${statusBackground};color:${statusColor};font-size:11px;font-weight:900;">${statusLabel}</span>
              <h2 style="margin:16px 0 7px;font-size:24px;">${escapeHtml(proposal.kpi_name)}</h2>
              <p style="margin:0 0 22px;color:#667085;line-height:1.6;">${approved ? "The target proposal has been approved by the manager." : "The target proposal was not approved by the manager."}</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #dfe6ee;border-radius:11px;overflow:hidden;">
                <tr><td style="padding:13px 15px;background:#f8fafc;color:#667085;font-size:12px;">Proposed target</td><td align="right" style="padding:13px 15px;background:#f8fafc;color:#172033;font-size:17px;font-weight:800;">${escapeHtml(proposal.proposed_target_value)} ${escapeHtml(proposal.target_unit || "")}</td></tr>
              </table>
              <p style="margin:20px 0 0;padding:14px 16px;border-radius:10px;background:${statusBackground};color:${statusColor};font-size:14px;font-weight:700;line-height:1.5;">${approved ? "The new target will apply only to future periods." : "The current target remains unchanged."}</p>
            </td></tr>
            <tr><td align="center" style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e5eaf0;color:#98a2b3;font-size:11px;">KPI Group &bull; Automated notification</td></tr>
          </table>
        </td></tr></table>
      </body></html>`
  });
  return true;
};

module.exports = {
  ensureKpiTargetAdjustmentSchema,
  hashKpiTargetAdjustmentToken,
  getDirectManagerRecipient,
  getKpiTargetAdjustmentApprover,
  evaluateAndCreateKpiTargetAdjustmentProposal,
  sendKpiTargetAdjustmentApprovalEmail,
  loadKpiTargetAdjustmentProposalByToken,
  sendKpiTargetAdjustmentDecisionEmail,
};
