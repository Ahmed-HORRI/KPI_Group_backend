const cron = require("node-cron");
const { pool, actionPlanPool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { normalizeOptionalDateInput, formatIsoDateValue, buildTimeZoneDateContext } = require("../utils/weekPeriod");
const { createTransporter } = require("../config/mailer");
const { getPeopleDisplayName } = require("../models/kpi.model");
const { loadFormResponsibleContext } = require("../models/responsible.model");
const {
  escapeHtml,
  getKpiStatus,
  getDotColor,
  inferKpiDirection,
  needsCorrectiveAction,
  getReadableThresholdLineValues,
  getAutoChartAxisRange,
  acquireJobLock,
  releaseJobLock,
  sortCorrectiveActions,
  formatInputDate,
} = require("./kpiShared.service");
const {
  canUseActionPlanCorrectiveActions,
  loadActionPlanCorrectiveActionMaps,
  getResponsibleWithKPIs,
  generateEmailHtml,
} = require("./actionPlan.service");
const {
  generateKPIRecommendationsPDFBuffer,
  generatePlantKPIRecommendationsPDFBuffer,
} = require("./kpiRecommendations.service");
const {
  ensureKpiSubmissionEmailDispatchLogSchema,
  sendKPIEmail,
  loadKpiSubmissionEmailRecipients,
  getCanonicalKpiCalculationMode,
  getCanonicalKpiSubmissionFrequency,
  formatKpiSubmissionPeriodLabel,
  getKpiSubmissionTargetPeriodLabel,
  isKpiSubmissionFrequencyDue,
  resolveKpiSubmissionRecipientTimeZone,
  hasReachedKpiSubmissionLocalSendWindow,
  hasKpiSubmissionEmailBeenSentForLocalDate,
  recordKpiSubmissionEmailDispatch,
  loadWeeklyReportRecipientsForWeek,
  buildWeeklyReportChartModel,
  fetchWeeklyReportInlineChartAttachment,
  generateVerticalBarChart,
  generateWeeklyReportData,
  DEFAULT_KPI_SUBMISSION_TIMEZONE,
  WEEKLY_REPORT_MAX_CHARTS,
  truncateWeeklyReportText,
  escapeWeeklyReportText,
  formatWeeklyReportWeekLabel,
} = require("./kpiSubmissionEmail.service");

function getCurrentWeek(date = new Date()) {
  const now = new Date(date);
  const year = now.getFullYear();
  const startDate = new Date(year, 0, 1);
  const days = Math.floor((now - startDate) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.ceil((days + startDate.getDay() + 1) / 7);
  return `${year}-Week${weekNumber}`;
}

function getCurrentFormWeek(date = new Date()) {
  const dayOfWeek = date.getDay();
  const currentWeek = getCurrentWeek(date);
  const fridayCutoverReached = dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;

  return fridayCutoverReached
    ? currentWeek
    : getPreviousWeek(currentWeek);
}

function getCurrentWeekFromPseudoDate(date = new Date()) {
  const now = new Date(date);
  const year = now.getUTCFullYear();
  const startDate = new Date(Date.UTC(year, 0, 1));
  const days = Math.floor((now.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const weekNumber = Math.ceil((days + startDate.getUTCDay() + 1) / 7);
  return `${year}-Week${weekNumber}`;
}

function getCurrentFormWeekFromPseudoDate(date = new Date()) {
  const pseudoDate = new Date(date);
  const dayOfWeek = pseudoDate.getUTCDay();
  const currentWeek = getCurrentWeekFromPseudoDate(pseudoDate);
  const fridayCutoverReached = dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;

  return fridayCutoverReached
    ? currentWeek
    : getPreviousWeek(currentWeek);
}

const generateWeeklyReportEmail = async (responsibleId, reportWeek, deliveryOverride = null) => {
  try {
    const responsibleContext = await loadFormResponsibleContext(responsibleId);
    const responsiblePeopleId = normalizeOptionalIntegerInput(
      responsibleContext?.people_id ?? responsibleId
    );

    if (!responsiblePeopleId) {
      throw new Error(`Responsible ${responsibleId} not found`);
    }

    const responsible = {
      people_id: responsiblePeopleId,
      responsible_id: responsiblePeopleId,
      name: normalizeOptionalTextInput(responsibleContext?.name) || `People #${responsiblePeopleId}`,
      email: normalizeOptionalTextInput(responsibleContext?.email),
      plant_name: normalizeOptionalTextInput(responsibleContext?.plant_name) || "Allocated scope",
      department_name: normalizeOptionalTextInput(responsibleContext?.department_name) || "",
      role_name: normalizeOptionalTextInput(responsibleContext?.role_name) || ""
    };

    const reportWeekLabel = formatWeeklyReportWeekLabel(reportWeek);
    const deliveryRecipient = normalizeOptionalTextInput(deliveryOverride?.recipientEmail) || responsible.email;
    const deliveryRecipientName = normalizeOptionalTextInput(deliveryOverride?.recipientName) || responsible.name;
    const deliveryRoleName = normalizeOptionalTextInput(deliveryOverride?.recipientRoleName) || "";
    const isManagerCopy = Boolean(deliveryOverride?.recipientEmail) && deliveryRecipient !== responsible.email;
    if (!deliveryRecipient) {
      throw new Error(`No email defined for weekly report delivery for ${responsible.name}`);
    }
    const appBaseUrl = (normalizeOptionalTextInput(process.env.APP_BASE_URL) || "https://kpi-form.azurewebsites.net")
      .replace(/\/+$/, "");
    const dashboardUrl = `${appBaseUrl}/dashboard?responsible_id=${encodeURIComponent(responsible.people_id)}`;
    const chartsData = await generateWeeklyReportData(responsible.people_id, reportWeek);
    const chartsForEmail = Array.isArray(chartsData)
      ? chartsData.slice(0, WEEKLY_REPORT_MAX_CHARTS)
      : [];
    const omittedChartsCount = Array.isArray(chartsData) && chartsData.length > chartsForEmail.length
      ? chartsData.length - chartsForEmail.length
      : 0;
    let chartsHtml = "";
    let inlineChartAttachments = [];
    const reportWarnings = [];

    if (chartsForEmail.length > 0) {
      const chartModels = chartsForEmail.map((chart) => buildWeeklyReportChartModel(chart));
      const inlineChartResults = await Promise.all(
        chartModels.map((chartModel, index) => fetchWeeklyReportInlineChartAttachment(chartModel, index))
      );

      chartsHtml = chartModels.map((chartModel, index) =>
        generateVerticalBarChart(chartModel, {
          imageSrc: inlineChartResults[index]?.cid ? `cid:${inlineChartResults[index].cid}` : ""
        })
      ).join("");

      inlineChartAttachments = inlineChartResults
        .map((entry) => entry?.attachment)
        .filter(Boolean)
        .map((attachment) => ({
          ...attachment,
          contentDisposition: "inline"
        }));

      const missingInlineChartsCount = Math.max(0, chartModels.length - inlineChartAttachments.length);
      if (missingInlineChartsCount > 0) {
        reportWarnings.push(`${missingInlineChartsCount} chart image(s) were replaced with placeholders.`);
      }

      if (omittedChartsCount > 0) {
        chartsHtml += `
          <div style="margin:16px 0 0;padding:16px 18px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;color:#1e3a8a;font-size:13px;line-height:1.5;">
            ${escapeWeeklyReportText(`${omittedChartsCount} additional KPI chart(s) are available in the dashboard to keep this email lightweight and reliable.`, 180)}
          </div>`;
      }
    } else {
      reportWarnings.push("No KPI chart data was available for this report period.");
      chartsHtml = `
        <div style="text-align:center;padding:60px;background:#ffffff;border:1px solid #dbe4ef;border-radius:16px;">
          <p style="color:#334155;margin:0;font-size:18px;font-weight:700;">No KPI Data Available</p>
          <p style="color:#64748b;margin:10px 0 0;font-size:13px;">Use the dashboard link below to review the current allocation scope.</p>
        </div>`;
    }

    let pdfAttachment = null;

    try {
      console.log(`Generating recommendations PDF for ${responsible.name}...`);

      const pdfBuffer = await generateKPIRecommendationsPDFBuffer(
        pool,
        responsible.people_id,
        reportWeek
      );

      if (pdfBuffer) {
        const weekLabel = String(reportWeek).replace(/[^a-zA-Z0-9_-]/g, "_");

        const safeName = String(responsible.name || "responsible")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-zA-Z0-9_-]/g, "_");

        pdfAttachment = {
          filename: `KPI_Recommendations_${safeName}_${weekLabel}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        };

        console.log(`PDF ready - ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
        console.log(`PDF filename: ${pdfAttachment.filename}`);
      } else {
        reportWarnings.push("The AI recommendations PDF was not generated for this run.");
      }
    } catch (pdfErr) {
      reportWarnings.push(`The AI recommendations PDF could not be attached: ${pdfErr.message}`);
      console.error(`PDF generation failed for ${responsible.name}:`, pdfErr.message);
    }

    const pdfBannerHtml = pdfAttachment
      ? `<strong>AI Recommendations PDF is attached</strong> - open it for root-cause analysis, action plans and improvement roadmaps for each KPI.`
      : `<strong>AI Recommendations PDF is unavailable for this run</strong> - use the dashboard for the latest analysis while the report remains available in this email.`;
    const managerCopyHtml = isManagerCopy
      ? `
        <tr>
          <td style="padding:14px 32px 0;">
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;color:#1d4ed8;font-size:12px;line-height:1.5;">
              This manager copy was sent to <strong>${escapeWeeklyReportText(deliveryRecipientName, 80)}</strong>${deliveryRoleName ? ` (${escapeWeeklyReportText(deliveryRoleName, 80)})` : ""} for KPI follow-up on <strong>${escapeWeeklyReportText(responsible.name, 80)}</strong>.
            </div>
          </td>
        </tr>`
      : "";

    const reportWarningsHtml = reportWarnings.length
      ? `
        <tr>
          <td style="padding:14px 32px 0;">
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px 14px;color:#9a3412;font-size:12px;line-height:1.5;">
              ${reportWarnings.map((warning) => escapeWeeklyReportText(warning, 200)).join("<br />")}
            </div>
          </td>
        </tr>`
      : "";

    const emailText = [
      `KPI Performance Report - ${reportWeekLabel}`,
      ``,
      `Responsible: ${responsible.name}`,
      `Scope: ${responsible.plant_name}`,
      `Dashboard: ${dashboardUrl}`,
      isManagerCopy
        ? `Manager copy recipient: ${deliveryRecipientName}${deliveryRoleName ? ` (${deliveryRoleName})` : ""}`
        : null,
      ``,
      chartsForEmail.length
        ? `Included KPI charts: ${chartsForEmail.map((chart) => truncateWeeklyReportText(chart.title || chart.subtitle || "KPI", 50)).join(", ")}`
        : `No KPI chart data was available for this period.`,
      pdfAttachment
        ? `AI recommendations PDF: attached`
        : `AI recommendations PDF: unavailable for this run`,
      omittedChartsCount > 0
        ? `${omittedChartsCount} additional KPI chart(s) are available in the dashboard.`
        : null,
      reportWarnings.length
        ? `Warnings: ${reportWarnings.join(" | ")}`
        : null
    ].filter(Boolean).join("\n");

    const emailHtml = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#edf3fb;color:#0f172a;">
    <div style="display:none;font-size:1px;color:#edf3fb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      KPI Performance Report ${escapeWeeklyReportText(reportWeekLabel, 40)} for ${escapeWeeklyReportText(responsible.name, 80)}.
    </div>
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background:#edf3fb;">
      <tr>
        <td align="center" style="padding:28px 18px;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:1040px;background:#f8fbff;border-radius:18px;">
            <tr>
              <td style="padding:30px 30px 22px;">
                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background:#127bd8;border-radius:10px;">
                  <tr>
                    <td align="center" style="padding:26px 20px;">
                      <div style="font-size:20px;font-weight:700;color:#ffffff;line-height:1.25;margin:0 0 8px;">
                        KPI Performance Report
                      </div>
                      <div style="font-size:14px;color:#e0f2fe;line-height:1.5;margin:0 0 14px;">
                        ${escapeWeeklyReportText(reportWeekLabel, 40)} | ${escapeWeeklyReportText(responsible.name, 80)} | ${escapeWeeklyReportText(responsible.plant_name, 80)}
                      </div>
                      <a href="${escapeHtml(dashboardUrl)}"
                         style="display:inline-block;padding:11px 24px;background:#38bdf8;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
                        View Dashboard
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 30px;">
                <div style="background:#fff8e1;border:1px solid #f6d365;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.5;color:#7c4a03;">
                  ${pdfBannerHtml}
                </div>
              </td>
            </tr>

            ${managerCopyHtml}
            ${reportWarningsHtml}

            <tr>
              <td style="padding:16px 30px 30px;">
                ${chartsHtml}
              </td>
            </tr>

            <tr>
              <td style="padding:18px 24px 26px;text-align:center;font-size:12px;color:#64748b;border-top:1px solid #dbe4ef;">
                AVOCarbon KPI System | Generated ${new Date().toLocaleDateString("en-GB")}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    const fallbackHtml = `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="margin:0;padding:24px;font-family:Arial,sans-serif;background:#f4f6f9;color:#0f172a;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #dbe4ef;border-radius:14px;">
      <tr>
        <td style="padding:26px 28px 18px;background:#127bd8;border-radius:14px 14px 0 0;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#ffffff;">KPI Performance Report</div>
          <div style="margin-top:8px;font-size:14px;color:#e0f2fe;">
            ${escapeWeeklyReportText(reportWeekLabel, 40)} | ${escapeWeeklyReportText(responsible.name, 80)} | ${escapeWeeklyReportText(responsible.plant_name, 80)}
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:22px 28px;">
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
            Your weekly KPI report is available. Open the dashboard for the full chart experience.
          </p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">
            Included KPI summary: ${escapeWeeklyReportText(chartsForEmail.map((chart) => chart.title || chart.subtitle || "KPI").join(", ") || "No KPI data available", 260)}
          </p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;">
            ${escapeWeeklyReportText(pdfAttachment ? "The AI recommendations PDF is attached to this message." : "The AI recommendations PDF was not available in this run.", 160)}
          </p>
          <a href="${escapeHtml(dashboardUrl)}"
             style="display:inline-block;padding:12px 22px;background:#127bd8;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
            View Dashboard
          </a>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 28px 22px;font-size:12px;color:#64748b;border-top:1px solid #dbe4ef;text-align:center;">
          AVOCarbon KPI System | Generated ${new Date().toLocaleDateString("en-GB")}
        </td>
      </tr>
    </table>
  </body>
</html>`;

    const transporter = createTransporter();
    const weeklyReportMessageToken = [
      "weekly-report",
      responsible.people_id,
      String(reportWeek || "week").replace(/[^a-zA-Z0-9_-]/g, "_"),
      Date.now()
    ].join("-");

    const baseMailOptions = {
      from: '"AVOCarbon KPI System" <administration.STS@avocarbon.com>',
      sender: "administration.STS@avocarbon.com",
      replyTo: "administration.STS@avocarbon.com",
      to: responsible.email,
      envelope: {
        from: "administration.STS@avocarbon.com",
        to: [deliveryRecipient]
      },
      subject: `KPI Performance Report - ${reportWeekLabel} | ${responsible.name}`,
      text: emailText,
      headers: {
        "X-Auto-Response-Suppress": "OOF, AutoReply",
        "X-Weekly-Report-Id": weeklyReportMessageToken,
        ...(isManagerCopy ? { "X-Weekly-Report-Delivery": "manager-hierarchy-copy" } : {})
      },
      date: new Date(),
      messageId: `<${weeklyReportMessageToken}@avocarbon.com>`
    };

    const attachments = [
      ...inlineChartAttachments,
      ...(pdfAttachment ? [{
        ...pdfAttachment,
        contentDisposition: "attachment"
      }] : [])
    ];

    let info;
    let fallbackUsed = false;

    try {
      info = await transporter.sendMail({
        ...baseMailOptions,
        to: deliveryRecipient,
        html: emailHtml,
        attachments
      });
    } catch (primarySendError) {
      fallbackUsed = true;
      reportWarnings.push(`Rich email fallback used because the primary send failed: ${primarySendError.message}`);
      console.error(`[Weekly Report] Rich email send failed for ${responsible.email}:`, primarySendError.message);

      info = await transporter.sendMail({
        ...baseMailOptions,
        to: deliveryRecipient,
        subject: `${baseMailOptions.subject} [Fallback]`,
        html: fallbackHtml,
        attachments: pdfAttachment ? [{
          ...pdfAttachment,
          contentDisposition: "attachment"
        }] : [],
        headers: {
          ...baseMailOptions.headers,
          "X-Weekly-Report-Fallback": "1"
        },
        messageId: `<${weeklyReportMessageToken}-fallback@avocarbon.com>`
      });
    }

    console.log("[Weekly Report] Mail result:", {
      responsible: responsible.email,
      to: deliveryRecipient,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      messageId: info.messageId,
      hasPdf: Boolean(pdfAttachment),
      inlineCharts: inlineChartAttachments.length,
      renderedCharts: chartsForEmail.length,
      omittedCharts: omittedChartsCount,
      fallbackUsed,
      warnings: reportWarnings
    });


  } catch (error) {
    console.error(`âŒ generateWeeklyReportEmail failed for responsible ${responsibleId}:`, error.message);
    throw error;
  }
};
// ---------- Cron: KPI submission email ----------
const weeklyKpiSubmissionCronState = {
  direct: false,
  ratio: false
};

const runWeeklyKpiSubmissionCron = async ({
  calculationMode,
  lockId,
  stateKey,
  logLabel
}) => {
  const lock = await acquireJobLock(lockId);
  if (!lock.acquired) {
    console.log(`[KPI Reminder:${logLabel}] lock not acquired`);
    return;
  }

  try {
    if (weeklyKpiSubmissionCronState[stateKey]) {
      console.log(`[KPI Reminder:${logLabel}] already running`);
      return;
    }

    weeklyKpiSubmissionCronState[stateKey] = true;
    await ensureKpiSubmissionEmailDispatchLogSchema();
    const recipients = await loadKpiSubmissionEmailRecipients(calculationMode);
    const dispatchDate = new Date();
    const canonicalMode = getCanonicalKpiCalculationMode(calculationMode);
    let eligibleCount = 0;
    let sentCount = 0;
    let alreadySentCount = 0;
    let notDueCount = 0;
    let skippedCount = 0;

    for (const recipient of recipients) {
      const recipientTimeZone = resolveKpiSubmissionRecipientTimeZone(recipient);
      const timeContext = buildTimeZoneDateContext(recipientTimeZone, dispatchDate);
      const frequencyLabel = getCanonicalKpiSubmissionFrequency(
        recipient.frequency_label || recipient.frequency
      );
      const targetPeriodLabel = getKpiSubmissionTargetPeriodLabel({
        timeContext,
        frequencyLabel
      });

      if (!hasReachedKpiSubmissionLocalSendWindow(timeContext, calculationMode)) {
        notDueCount += 1;
        continue;
      }

      if (!isKpiSubmissionFrequencyDue(timeContext, frequencyLabel)) {
        notDueCount += 1;
        continue;
      }

      eligibleCount += 1;

      const alreadySent = await hasKpiSubmissionEmailBeenSentForLocalDate({
        peopleId: recipient.people_id,
        calculationMode: canonicalMode,
        frequencyLabel,
        localDispatchDate: timeContext.localDate,
        unitId: recipient.unit_id
      });

      if (alreadySent) {
        alreadySentCount += 1;
        continue;
      }

      try {
        const emailSent = await sendKPIEmail(recipient.people_id, targetPeriodLabel, {
          calculationMode,
          frequency: frequencyLabel,
          unitId: recipient.unit_id
        });

        if (!emailSent) {
          skippedCount += 1;
          continue;
        }

        await recordKpiSubmissionEmailDispatch({
          peopleId: recipient.people_id,
          calculationMode: canonicalMode,
          frequencyLabel,
          targetWeek: targetPeriodLabel,
          localDispatchDate: timeContext.localDate,
          unitId: recipient.unit_id,
          unitName: recipient.unit_name,
          unitShortName: recipient.unit_short_name,
          unitTimeZone: recipientTimeZone
        });

        sentCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 750));
      } catch (error) {
        skippedCount += 1;
        console.error(
          `[KPI Reminder:${logLabel}] Failed for ${recipient.name || recipient.people_id}:`,
          error.message
        );
      }
    }

    console.log(
      `[KPI Reminder:${logLabel}] Dispatch scan complete. recipients=${recipients.length}, eligible=${eligibleCount}, sent=${sentCount}, already_sent=${alreadySentCount}, not_due=${notDueCount}, skipped=${skippedCount}`
    );
  } catch (error) {
    console.error(`[KPI Reminder:${logLabel}] Scheduled email error:`, error.message);
  } finally {
    weeklyKpiSubmissionCronState[stateKey] = false;
    await releaseJobLock(lockId, lock.instanceId, lock.lockHash);
  }
};


// DISABLE_CRON_JOBS=true (local runs against the shared production database):
// these jobs send real e-mails and record the dispatch in the shared log.
const cronJobsDisabled = String(process.env.DISABLE_CRON_JOBS || "").trim().toLowerCase() === "true";
if (cronJobsDisabled) {
  console.log("[KPI Reminder] Weekly KPI submission cron disabled (DISABLE_CRON_JOBS=true).");
}

cron.schedule("*/5 * * * *", async () => {
  if (cronJobsDisabled) return;
  await runWeeklyKpiSubmissionCron({
    calculationMode: "Ratio",
    lockId: "send_kpi_weekly_email_ratio_job",
    stateKey: "ratio",
    logLabel: "Ratio"
  });

  await runWeeklyKpiSubmissionCron({
    calculationMode: "Direct",
    lockId: "send_kpi_weekly_email_direct_job",
    stateKey: "direct",
    logLabel: "Direct"
  });
}, {
  scheduled: true,
  timezone: "UTC"
});

// ---------- Cron: weekly reports ----------
// let reportCronRunning = false;

// cron.schedule("40 14 * * *", async () => {
//   const lockId = "weekly_kpi_report_job";
//   const lock = await acquireJobLock(lockId);

//   if (!lock.acquired) {
//     console.log("[Weekly Report] lock not acquired");
//     return;
//   }

//   try {
//     if (reportCronRunning) {
//       console.log("[Weekly Report] already running");
//       return;
//     }

//     reportCronRunning = true;

//     const reportWeek = getPreviousWeek(getCurrentWeek());
//     console.log("[Weekly Report] week:", reportWeek);

//     const recipients = await loadWeeklyReportRecipientsForWeek(reportWeek);
//     console.log("[Weekly Report] recipients:", recipients.length);

//     for (const recipient of recipients) {
//       try {
//         console.log("[Weekly Report] sending to:", recipient.email || recipient.people_id);

//         await generateWeeklyReportEmail(recipient.people_id, reportWeek);

//         console.log("[Weekly Report] sent to:", recipient.email || recipient.people_id);

//         await new Promise((resolve) => setTimeout(resolve, 1500));
//       } catch (error) {
//         console.error(
//           `[Weekly Report] Failed for ${recipient.name || recipient.people_id}:`,
//           error.message
//         );
//       }
//     }

//     console.log(`[Weekly Report] Emails processed for ${recipients.length} people for ${reportWeek}`);
//   } catch (err) {
//     console.error("[Weekly Report] Scheduled error:", err.message);
//   } finally {
//     reportCronRunning = false;
//     await releaseJobLock(lockId, lock.instanceId, lock.lockHash);
//     console.log("[Weekly Report] lock released");
//   }
// }, { scheduled: true, timezone: "Africa/Tunis" });

// ============================================================
// createIndividualKPIChart
// ============================================================
const createIndividualKPIChart = (kpi) => {
  const target = kpi.target && kpi.target !== 'None' ? Number(kpi.target) : null;
  const high_limit = kpi.high_limit && kpi.high_limit !== 'None' ? Number(kpi.high_limit) : null;
  const low_limit = kpi.low_limit && kpi.low_limit !== 'None' ? Number(kpi.low_limit) : null;
  const direction = inferKpiDirection(kpi);
  const thresholdLineValues = getReadableThresholdLineValues(low_limit, target, high_limit);
  const displayHigh = thresholdLineValues.displayHigh;
  const displayLow = thresholdLineValues.displayLow;
  const displayTarget = thresholdLineValues.displayTarget;

  const weeklyData = kpi.weeklyData || { weeks: [], values: [] };
  const weeks = weeklyData.weeks.slice(0, 12);
  const values = weeklyData.values.slice(0, 12);

  if (!values || values.length === 0) {
    return `<table border="0" cellpadding="15" cellspacing="0" width="100%"
              style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:15px;">
      <tr><td style="text-align:center;color:#999;font-size:14px;padding:20px;">
        <div>No data for ${kpi.subtitle || kpi.title}</div>
      </td></tr></table>`;
  }

  const fmt = (num) => {
    if (num === null || num === undefined || isNaN(num)) return '0';
    const w = Math.abs(num - Math.round(num)) < 0.0001;
    if (num >= 1e6) return (num / 1e6).toFixed(w ? 0 : 1) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(w ? 0 : 1) + 'k';
    if (w) return Math.round(num).toString();
    if (num < 1) return num.toFixed(2);
    return num.toFixed(1);
  };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const currentValue = values[values.length - 1];

  const currentStatus = getKpiStatus(currentValue, low_limit, high_limit, direction);
  const trendColor = currentStatus.isGood === false ? '#dc2626' : '#22c55e';

  const statusArrow = currentStatus.isGood === false
    ? (direction === 'down' ? '\u2197' : '\u2198')
    : (direction === 'down' ? '\u2198' : '\u2197');



  const pointColors = values.map((v) =>
    getKpiStatus(v, low_limit, high_limit, direction).isGood === false
      ? '#dc2626'
      : '#22c55e'
  );

  const weekLabels = weeks.map(w =>
    typeof w === 'string' && w.includes('-Week')
      ? `W${w.split('-Week')[1]}`
      : w   // already a month label like "Feb 2026"
  );


  const datasets = [
    {
      label: (kpi.subtitle || kpi.title || '').substring(0, 40),
      data: values,
      borderColor: '#94a3b8',
      borderWidth: 2,
      lineTension: 0,
      pointBackgroundColor: pointColors,
      pointBorderColor: '#ffffff',
      pointBorderWidth: 2,
      pointRadius: 7,
      fill: false
    }
  ];
  const axisRange = getAutoChartAxisRange(values, displayLow, displayTarget, displayHigh);

  if (high_limit !== null) {
    datasets.push({
      label: `High Limit (${fmt(high_limit)})`,
      data: new Array(values.length).fill(displayHigh),
      borderColor: '#f97316', borderWidth: 2, borderDash: [6, 4],
      lineTension: 0, pointRadius: 0, fill: false
    });
  }

  if (target !== null) {
    datasets.push({
      label: `Target (${fmt(target)})`,
      data: new Array(values.length).fill(displayTarget),
      borderColor: '#16a34a', borderWidth: 2.25,
      lineTension: 0, pointRadius: 0, fill: false
    });
  }

  if (low_limit !== null) {
    datasets.push({
      label: `Low Limit (${fmt(low_limit)})`,
      data: new Array(values.length).fill(displayLow),
      borderColor: '#dc2626', borderWidth: 2, borderDash: [6, 4],
      lineTension: 0, pointRadius: 0, fill: false
    });
  }

  const chartConfig = {
    type: 'line',
    data: { labels: weekLabels, datasets },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { fontSize: 10 }, gridLines: { color: 'rgba(0,0,0,0.05)' } }],
        yAxes: [{
          ticks: {
            fontSize: 10,
            beginAtZero: false,
            min: axisRange.min,
            max: axisRange.max
          },
          gridLines: { color: 'rgba(0,0,0,0.05)' }
        }]
      }
    }
  };

  const chartUrl =
    `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}` +
    `&w=320&h=170&bkg=white`;

  const badges = `
    <table border="0" cellpadding="5" cellspacing="0" width="100%" style="margin-top:10px;">
      <tr>
        <td align="center" width="33%">${target !== null
      ? `<div style="background:#e8f5e9;color:#2e7d32;padding:5px 10px;border-radius:6px;font-size:10px;font-weight:700;border:1px solid #a5d6a7;display:inline-block;">Target: ${target}</div>`
      : `<div style="background:#f5f5f5;color:#9e9e9e;padding:5px 10px;border-radius:6px;font-size:10px;font-weight:700;border:1px solid #e0e0e0;display:inline-block;">Target: N/A</div>`}</td>
        <td align="center" width="33%">${high_limit !== null
      ? `<div style="background:#fff3e0;color:#e65100;padding:5px 10px;border-radius:6px;font-size:10px;font-weight:700;border:1px solid #ffb74d;display:inline-block;">High Limit: ${high_limit}</div>`
      : `<div style="background:#f5f5f5;color:#9e9e9e;padding:5px 10px;border-radius:6px;font-size:10px;font-weight:700;border:1px solid #e0e0e0;display:inline-block;">High Limit: N/A</div>`}</td>
        <td align="center" width="33%">${low_limit !== null
      ? `<div style="background:#ffebee;color:#c62828;padding:5px 10px;border-radius:6px;font-size:10px;font-weight:700;border:1px solid #ef5350;display:inline-block;">Low Limit: ${low_limit}</div>`
      : `<div style="background:#f5f5f5;color:#9e9e9e;padding:5px 10px;border-radius:6px;font-size:10px;font-weight:700;border:1px solid #e0e0e0;display:inline-block;">Low Limit: N/A</div>`}</td>
      </tr>
    </table>`;
  const thresholdReadabilityNote = thresholdLineValues.hasTightCluster ? `
    <div style="margin-top:8px;text-align:center;font-size:10px;color:#64748b;line-height:1.4;">
      Threshold lines are slightly spaced in the chart for readability. Exact values are shown above.
    </div>
  ` : '';

  const hasComments = kpi.comments && kpi.comments.length > 0;
  const correctiveActionDueDate = kpi.correctiveAction?.dueDate
    ? formatInputDate(kpi.correctiveAction.dueDate)
    : '';
  const correctiveActionWeekLabel = kpi.correctiveAction?.week
    ? weekToMonthLabel(kpi.correctiveAction.week) || String(kpi.correctiveAction.week).replace('2026-Week', 'Week ')
    : '';
  const hasCA = kpi.correctiveAction && (
    kpi.correctiveAction.rootCause ||
    kpi.correctiveAction.implementedSolution ||
    correctiveActionDueDate
  );
  const hasSide = hasComments || hasCA;
  const leftWidth = hasSide ? '52%' : '100%';
  const rightWidth = hasSide ? '48%' : '0%';

  const caStatusBadge = hasCA && kpi.correctiveAction.status ? `
    <span style="display:inline-block;font-size:9px;font-weight:700;padding:2px 8px;
                 border-radius:10px;margin-left:6px;
                 background:${kpi.correctiveAction.status === 'Waiting for validation' ? '#fff3e0' : '#ffebee'};
                 color:${kpi.correctiveAction.status === 'Waiting for validation' ? '#e65100' : '#c62828'};
                 border:1px solid ${kpi.correctiveAction.status === 'Waiting for validation' ? '#ffcc80' : '#ef9a9a'};">
      ${kpi.correctiveAction.status}
    </span>` : '';

  const rightColumn = hasSide ? `
    <td width="${rightWidth}" valign="top"
        style="padding:18px 16px 18px 20px;
               border-left:3px solid #e2e8f0;
               background:#f8fafc;
               border-radius:0 8px 8px 0;">

      ${hasComments ? `
      <div style="margin-bottom:${hasCA ? '14px' : '0'};">
        <div style="font-size:11px;font-weight:700;color:#0078D7;
                    margin-bottom:10px;padding-bottom:6px;
                    border-bottom:1px solid #bfdbfe;letter-spacing:0.4px;">
          COMMENTS
        </div>
        ${kpi.comments.map(c => `
          <table border="0" cellpadding="10" cellspacing="0" width="100%"
                 style="background:#eff6ff;border-radius:8px;
                        border-left:4px solid #3b82f6;margin-bottom:8px;">
            <tr><td style="font-size:10px;font-weight:800;color:#1d4ed8;
                           text-transform:uppercase;letter-spacing:0.5px;
                           padding-bottom:4px;">
              ${weekToMonthLabel(c.week || '') || (c.week || '').replace('2026-Week', 'Week ')}
            </td></tr>
            <tr><td style="font-size:12px;color:#1e3a5f;line-height:1.5;">${c.text}</td></tr>
          </table>`).join('')}
      </div>` : ''}

      ${hasCA ? `
      <div>
        <div style="font-size:11px;font-weight:700;color:#c62828;
                    margin-bottom:10px;padding-bottom:6px;
                    border-bottom:1px solid #fecaca;letter-spacing:0.4px;
                    display:flex;align-items:center;">
          CORRECTIVE ACTION ${caStatusBadge}
        </div>

        ${correctiveActionWeekLabel ? `
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;
                    letter-spacing:0.08em;margin:0 0 8px;">
          Action Week: ${correctiveActionWeekLabel}
        </div>` : ''}

        ${kpi.correctiveAction.rootCause ? `
        <table border="0" cellpadding="0" cellspacing="0" width="100%"
               style="margin-bottom:8px;">
          <tr><td style="padding:8px 10px;background:#fff5f5;border-radius:6px;
                         border-left:3px solid #ef4444;">
            <div style="font-size:9px;font-weight:800;color:#dc2626;
                        text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">
              Root Cause
            </div>
            <div style="font-size:11px;color:#374151;line-height:1.5;">
              ${kpi.correctiveAction.rootCause}
            </div>
          </td></tr>
        </table>` : ''}

        ${kpi.correctiveAction.implementedSolution ? `
        <table border="0" cellpadding="0" cellspacing="0" width="100%"
               style="margin-bottom:8px;">
          <tr><td style="padding:8px 10px;background:#fffbeb;border-radius:6px;
                         border-left:3px solid #f59e0b;">
            <div style="font-size:9px;font-weight:800;color:#d97706;
                        text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">
              Implemented Solution
            </div>
            <div style="font-size:11px;color:#374151;line-height:1.5;">
              ${kpi.correctiveAction.implementedSolution}
            </div>
          </td></tr>
        </table>` : ''}

        ${correctiveActionDueDate ? `
        <table border="0" cellpadding="0" cellspacing="0" width="100%"
               style="margin-bottom:8px;">
          <tr><td style="padding:8px 10px;background:#f5f3ff;border-radius:6px;
                         border-left:3px solid #7c3aed;">
            <div style="font-size:9px;font-weight:800;color:#6d28d9;
                        text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">
              Due Date
            </div>
            <div style="font-size:11px;color:#374151;line-height:1.5;">
              ${correctiveActionDueDate}
            </div>
          </td></tr>
        </table>` : ''}

      </div>` : ''}

    </td>` : '';

  return `
<table border="0" cellpadding="0" cellspacing="0" width="100%"
       style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;
              margin-bottom:15px;box-sizing:border-box;">
  <tr><td style="padding:18px 20px;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:8px;">
      <tr>
        <td style="font-weight:700;font-size:13px;color:#333;padding-right:10px;">
          ${kpi.subtitle || kpi.title}
        </td>
        <td align="center" valign="middle" style="padding:0 8px;">
          <div style="background:#f1f5f9;border:1px solid #e2e8f0;padding:4px 10px;
                      border-radius:8px;display:inline-block;">
            <span style="font-size:11px;color:#475569;font-weight:600;">${kpi.responsible || 'N/A'}</span>
          </div>
        </td>
        <td align="right" width="36">
          <div style="background:${trendColor};color:#fff;padding:4px 8px;border-radius:6px;
                      font-weight:700;font-size:12px;display:inline-block;">${statusArrow}</div>
        </td>
      </tr>
    </table>
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:14px;">
      <tr><td align="center">
        <span style="background:#8b5cf6;color:white;padding:5px 12px;border-radius:20px;
                     font-size:12px;font-weight:700;display:inline-block;">
          Current: ${currentValue.toFixed(kpi.unit === '%' ? 1 : 2)} ${kpi.unit || ''}
          &nbsp;|&nbsp;
          Avg: ${avg.toFixed(kpi.unit === '%' ? 1 : 2)} ${kpi.unit || ''}
        </span>
      </td></tr>
    </table>
    <table border="0" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td width="${leftWidth}" valign="top"
            style="padding-right:${hasSide ? '20px' : '0'};">
          ${badges}
          ${thresholdReadabilityNote}
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top:10px;">
            <tr><td align="center">
              <img src="${chartUrl}" width="320" height="170" alt="KPI trend chart"
                   style="display:block;width:100%;max-width:320px;
                          border:1px solid #f0f0f0;border-radius:6px;" />
            </td></tr>
          </table>
          <table border="0" cellpadding="3" cellspacing="0" width="100%"
                 style="margin-top:8px;border-top:1px solid #f0f0f0;">
            <tr><td align="center">
              <table border="0" cellpadding="0" cellspacing="6"><tr>
                <td><table border="0" cellpadding="0" cellspacing="3"><tr>
                  <td width="10" height="10" style="background:#22c55e;border-radius:50%;font-size:0;">&nbsp;</td>
                  <td style="font-size:10px;color:#666;">Good direction</td>
                </tr></table></td>
                <td><table border="0" cellpadding="0" cellspacing="3"><tr>
                  <td width="10" height="10" style="background:#dc2626;border-radius:50%;font-size:0;">&nbsp;</td>
                  <td style="font-size:10px;color:#666;">Outside good direction</td>
                </tr></table></td>
              </tr></table>
            </td></tr>
          </table>
        </td>
        ${rightColumn}
      </tr>
    </table>
  </td></tr>
</table>`;
};

// ============================================================
// generateManagerReportHtml
// ============================================================
const generateManagerReportHtml = (reportData) => {
  const { plant, week, kpisByDepartment, stats, deliveryRecipient } = reportData;
  let kpiSections = '';
  const departments = Object.keys(kpisByDepartment).sort();
  departments.forEach(department => {
    const kpis = kpisByDepartment[department];
    if (kpis.length === 0) return;
    const color = getDepartmentColor(department);
    function createKPIRows(kpis) {
      let rows = '';
      for (let i = 0; i < kpis.length; i += 2) {
        const rowKPIs = kpis.slice(i, i + 2);
        rows += '<tr>';
        rowKPIs.forEach(kpi => { rows += `<td width="50%" valign="top" style="padding:12px;">${createIndividualKPIChart(kpi)}</td>`; });
        const empty = 2 - rowKPIs.length;
        for (let j = 0; j < empty; j++) rows += '<td width="50%" style="padding:12px;"></td>';
        rows += '</tr>';
      }
      return rows;
    }
    kpiSections += `
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:40px;">
        <tr><td>
          <table border="0" cellpadding="0" cellspacing="0" width="100%"
                 style="margin-bottom:20px;padding-bottom:10px;border-bottom:3px solid ${color};">
            <tr><td style="padding:5px 0;">
              <span style="font-size:20px;font-weight:700;color:#2c3e50;
                           text-transform:uppercase;">${department}</span>
              <span style="font-size:12px;color:#6c757d;background:#f8f9fa;
                           padding:5px 14px;border-radius:12px;margin-left:10px;">${kpis.length} KPIs</span>
            </td></tr>
          </table>
          <table border="0" cellpadding="10" cellspacing="0" width="100%">
            ${createKPIRows(kpis)}
          </table>
        </td></tr>
      </table>`;
  });
  return `<!DOCTYPE html><html>
<head><meta charset="utf-8"><title>Plant Weekly KPI Dashboard</title>
<style>body{margin:0;padding:0;font-family:Arial,sans-serif;background:#f8f9fa;}</style></head>
<body>
  <div style="padding:30px 20px;max-width:1400px;margin:0 auto;">
    <div style="background:white;border-radius:12px;padding:30px;box-shadow:0 4px 12px rgba(0,0,0,0.05);margin-bottom:30px;">
      <h1 style="margin:0 0 8px;font-size:28px;font-weight:800;color:#2c3e50;">CEO KPI Group DASHBOARD</h1>
      <div style="font-size:14px;color:#6c757d;">
        <strong>${plant.plant_name}</strong>  Week: <strong>${week.replace('2026-Week', 'W')}</strong>
        Manager: <strong>${plant.manager || 'N/A'}</strong>
        ${deliveryRecipient ? `&nbsp;&nbsp;|&nbsp;&nbsp;Recipient: <strong>${deliveryRecipient}</strong>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:15px;
                  background:#f8f9fa;padding:20px;border-radius:8px;margin-top:20px;">
        <div style="text-align:center;">
          <div style="font-size:28px;font-weight:800;color:#0078D7;">${stats.totalDepartments}</div>
          <div style="font-size:12px;color:#6c757d;">Departments</div></div>
        <div style="text-align:center;">
          <div style="font-size:28px;font-weight:800;color:#28a745;">${stats.totalKPIs}</div>
          <div style="font-size:12px;color:#6c757d;">Total KPIs</div></div>
        <div style="text-align:center;">
          <div style="font-size:28px;font-weight:800;color:#6f42c1;">${week.replace('2026-Week', 'W')}</div>
          <div style="font-size:12px;color:#6c757d;">Current Week</div></div>
      </div>
    </div>
    <div style="background:white;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
      ${kpiSections || '<div style="text-align:center;padding:60px;color:#6c757d;">No KPI data available</div>'}
    </div>
    <div style="background:#2c3e50;color:white;padding:25px;border-radius:12px;text-align:center;margin-top:30px;">
      <div style="font-size:16px;font-weight:600;margin-bottom:10px;">AVOCarbon Plant Analytics</div>
      <div style="font-size:13px;opacity:0.8;">Weekly KPI Performance Monitoring</div>
    </div>
  </div>
</body></html>`;
};

const getDepartmentColor = (departmentName) => {
  if (!departmentName) return '#6c757d';
  if (departmentName.includes('Sales')) return '#667eea';
  if (departmentName.includes('Production')) return '#4facfe';
  if (departmentName.includes('Quality')) return '#43e97b';
  if (departmentName.includes('VOH')) return '#909d6f';
  if (departmentName.includes('Engineering')) return '#36a07b';
  if (departmentName.includes('Human resources')) return '#78d69a';
  if (departmentName.includes('Stocks')) return '#6a772a';
  if (departmentName.includes('AR/AP')) return '#96ce25';
  if (departmentName.includes('Cash')) return '#54591b';
  const colorMap = {
    'Production': '#667eea', 'Quality': '#f093fb', 'Maintenance': '#4facfe',
    'Safety': '#43e97b', 'Operations': '#fa709a', 'Engineering': '#30cfd0',
    'Supply-chain': '#f6d365', 'Administration': '#a8edea', 'Finance': '#f093fb',
    'HR': '#4facfe', 'IT': '#667eea', 'Sales': '#43e97b', 'Other': '#6c757d'
  };
  return colorMap[departmentName] || '#6c757d';
};

function processKPIChartData(rows) {
  const kpis = new Map();
  const weeksSet = new Set();

  rows.forEach(row => {
    const kpiId = row.kpi_id;
    if (!kpis.has(kpiId)) {
      kpis.set(kpiId, {
        id: kpiId, subject: row.subject, subtitle: row.indicator_sub_title,
        unit: row.unit || '',
        target: row.target && row.target !== 'None' ? parseFloat(row.target) : null,
        direction: inferKpiDirection(row),
        min: row.min && row.min !== 'None' ? parseFloat(row.min) : null,
        max: row.max && row.max !== 'None' ? parseFloat(row.max) : null,
        high_limit: row.high_limit && row.high_limit !== 'None' ? parseFloat(row.high_limit) : null,
        low_limit: row.low_limit && row.low_limit !== 'None' ? parseFloat(row.low_limit) : null,
        definition: row.definition, tolerance_type: row.tolerance_type,
        up_tolerance: row.up_tolerance, low_tolerance: row.low_tolerance,
        values: [], weeks: [], colors: [], comments: []
      });
    }
    const value = parseFloat(row.new_value);
    const kpi = kpis.get(kpiId);
    kpi.values.push(value);
    kpi.weeks.push(row.week);
    if (row.comment && row.comment.trim()) kpi.comments.push({ week: row.week, text: row.comment, date: row.updated_at });
    kpi.colors.push(getDotColor(value, kpi.low_limit, kpi.high_limit, kpi.direction));
    weeksSet.add(row.week);
  });

  const allWeeks = Array.from(weeksSet).sort((a, b) => {
    const [ya, wa] = a.includes('Week') ? [parseInt(a.split('-Week')[0]), parseInt(a.split('-Week')[1])] : [0, parseInt(a.replace('Week', ''))];
    const [yb, wb] = b.includes('Week') ? [parseInt(b.split('-Week')[0]), parseInt(b.split('-Week')[1])] : [0, parseInt(b.replace('Week', ''))];
    return ya !== yb ? ya - yb : wa - wb;
  });

  for (const [, kpi] of kpis) {
    const vals = kpi.values.filter(v => !isNaN(v) && v > 0);
    if (vals.length === 0) continue;
    kpi.average = vals.reduce((a, b) => a + b, 0) / vals.length;
    kpi.maxValue = Math.max(...vals);
    kpi.minValue = Math.min(...vals);
    if (vals.length >= 2) {
      const cur = vals[vals.length - 1], prev = vals[vals.length - 2];
      kpi.trend = ((cur - prev) / prev) * 100;
      kpi.trendIcon = cur > prev ? '\u2197' : cur < prev ? '\u2198' : '\u2192';
      kpi.trendColor = cur > prev ? '#10b981' : cur < prev ? '#ef4444' : '#6b7280';
    } else { kpi.trend = 0; kpi.trendIcon = '\u2192'; kpi.trendColor = '#6b7280'; }
    if (kpi.low_limit !== null || kpi.high_limit !== null) {
      const latest = vals[vals.length - 1];
      kpi.achievementVsLimit = !needsCorrectiveAction(latest, kpi.low_limit, kpi.high_limit, kpi.direction);
      kpi.achievementColor = getDotColor(latest, kpi.low_limit, kpi.high_limit, kpi.direction);
    }
  }

  return { kpis: Array.from(kpis.values()), allWeeks, totalKPIs: kpis.size, totalWeeks: allWeeks.length };
}

function generateTrendsDashboardHTML(responsible, kpiData) {
  const { kpis, allWeeks, totalKPIs, totalWeeks } = kpiData;
  return `<!DOCTYPE html><html>
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>KPI Trends - ${responsible.name}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Segoe UI',sans-serif;background:linear-gradient(rgba(0,0,0,0.7),rgba(0,0,0,0.7)),
      url('https://images.unsplash.com/photo-1542744095-fcf48d80b0fd?w=1920') center/cover fixed;
      color:#fff;min-height:100vh;}
    .container{max-width:1400px;margin:0 auto;padding:20px;}
    .dashboard-header{background:rgba(31,41,55,0.95);border:1px solid rgba(255,255,255,0.1);
      backdrop-filter:blur(10px);border-radius:24px;padding:40px;margin-bottom:30px;}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-top:30px;}
    .stat-card{background:rgba(255,255,255,0.1);border-radius:16px;padding:20px;border:1px solid rgba(255,255,255,0.2);}
    .stat-value{font-size:32px;font-weight:700;margin-bottom:5px;}
    .stat-label{font-size:14px;opacity:0.8;text-transform:uppercase;letter-spacing:0.5px;}
    .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(600px,1fr));gap:30px;margin-bottom:40px;}
    @media(max-width:1300px){.kpi-grid{grid-template-columns:1fr;}}
    .kpi-card{background:rgba(255,255,255,0.95);color:#1f2937;border-radius:20px;padding:30px;
      border:1px solid rgba(255,255,255,0.2);transition:all 0.3s ease;}
    .kpi-card:hover{transform:translateY(-5px);box-shadow:0 20px 40px rgba(0,0,0,0.3);}
    .kpi-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:25px;}
    .chart-container{height:300px;margin:25px 0;position:relative;}
    .stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin-top:25px;}
    .stat-box{background:#f9fafb;border-radius:12px;padding:15px;text-align:center;border:1px solid #e5e7eb;}
    .stat-box .label{font-size:12px;color:#6b7280;margin-bottom:5px;text-transform:uppercase;}
    .stat-box .value{font-size:20px;font-weight:700;color:#111827;}
    .footer{text-align:center;margin-top:50px;padding:30px;border-top:1px solid rgba(255,255,255,0.1);}
    @media(max-width:768px){.kpi-grid{grid-template-columns:1fr;}.stats-row{grid-template-columns:repeat(2,1fr);}}
  </style>
</head>
<body>
  <div class="container">
    <header class="dashboard-header">
      <h1 style="font-size:36px;font-weight:800;color:#fff;margin-bottom:10px;">KPI Trends & Analytics</h1>
      <p style="font-size:18px;opacity:0.9;margin-bottom:25px;">Performance metrics across all production weeks</p>
      <div style="display:flex;gap:30px;flex-wrap:wrap;">
        <div><div style="font-size:12px;opacity:0.6;margin-bottom:5px;">OPERATOR</div>
          <div style="font-size:18px;font-weight:600;">${responsible.name}</div></div>
        <div><div style="font-size:12px;opacity:0.6;margin-bottom:5px;">FACTORY</div>
          <div style="font-size:18px;font-weight:600;">${responsible.plant_name}</div></div>
        <div><div style="font-size:12px;opacity:0.6;margin-bottom:5px;">DEPARTMENT</div>
          <div style="font-size:18px;font-weight:600;">${responsible.department_name}</div></div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value" style="color:#60a5fa;">${totalKPIs}</div>
          <div class="stat-label">Active KPIs</div></div>
        <div class="stat-card"><div class="stat-value" style="color:#34d399;">${totalWeeks}</div>
          <div class="stat-label">Production Weeks</div></div>
        <div class="stat-card">
          <div class="stat-value" style="color:#fbbf24;">${kpis.reduce((acc, k) => acc + k.values.length, 0)}</div>
          <div class="stat-label">Data Points</div></div>
        <div class="stat-card">
          <div class="stat-value" style="color:#f87171;">${kpis.filter(k => k.low_limit !== null).length}</div>
          <div class="stat-label">KPIs with Limits</div></div>
      </div>
    </header>
    <main>
      <div class="kpi-grid">
        ${kpis.map((kpi, index) => generateKPIChartHTML(kpi, index)).join('')}
      </div>
    </main>
    <footer class="footer">
      <p style="color:rgba(255,255,255,0.8);">AVOCarbon Industrial Analytics | ${new Date().getFullYear()}</p>
    </footer>
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      ${kpis.map((kpi, index) => initializeChartJS(kpi, index)).join('\n')}
    });
  </script>
</body></html>`;
}

function generateKPIChartHTML(kpi, index) {
  const chartId = `chart-${index}`;
  return `
    <div class="kpi-card">
      <div class="kpi-header">
        <div>
          <h3 style="font-size:20px;font-weight:700;color:#111827;margin-bottom:5px;">${kpi.subject}</h3>
          ${kpi.subtitle ? `<p style="font-size:14px;color:#6b7280;">${kpi.subtitle}</p>` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${kpi.unit ? `<span style="padding:6px 12px;border-radius:20px;font-size:12px;
            font-weight:600;background:#f3f4f6;color:#374151;">Unit: ${kpi.unit}</span>` : ''}
          <span style="padding:6px 12px;border-radius:20px;font-size:12px;font-weight:600;
            background:${kpi.trendColor}20;color:${kpi.trendColor};">
            ${kpi.trendIcon} ${Math.abs(kpi.trend).toFixed(1)}%</span>
        </div>
      </div>
      <div class="chart-container"><canvas id="${chartId}"></canvas></div>
      
      <!-- Three key metrics side by side - Target, High Limit, Low Limit -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin:25px 0;">
        <!-- Target Box -->
        <div style="background:#f9fafb;border-radius:12px;padding:15px;text-align:center;border:1px solid #e5e7eb;">
          <div style="font-size:12px;color:#6b7280;margin-bottom:5px;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:4px;">
            <span>Target</span>
          </div>
          <div style="font-size:24px;font-weight:700;color:#f97316;">
            ${kpi.target !== null ? kpi.target.toFixed(2) : 'N/A'}
          </div>
        </div>
        
        <!-- High Limit Box -->
        <div style="background:#f9fafb;border-radius:12px;padding:15px;text-align:center;border:1px solid #e5e7eb;">
          <div style="font-size:12px;color:#6b7280;margin-bottom:5px;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:4px;">
            <span>High Limit</span>
          </div>
          <div style="font-size:24px;font-weight:700;color:#f97316;">
            ${kpi.high_limit !== null ? kpi.high_limit.toFixed(2) : 'N/A'}
          </div>
        </div>
        
        <!-- Low Limit Box -->
        <div style="background:#f9fafb;border-radius:12px;padding:15px;text-align:center;border:1px solid #e5e7eb;">
          <div style="font-size:12px;color:#6b7280;margin-bottom:5px;text-transform:uppercase;display:flex;align-items:center;justify-content:center;gap:4px;">
            <span>Low Limit</span>
          </div>
          <div style="font-size:24px;font-weight:700;color:#ef4444;">
            ${kpi.low_limit !== null ? kpi.low_limit.toFixed(2) : 'N/A'}
          </div>
        </div>
      </div>
      
      <!-- Secondary stats row (Average and Trend) -->
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:15px;margin-bottom:25px;">
        <div class="stat-box">
          <div class="label">Average</div>
          <div class="value" style="color:#3b82f6;">${kpi.average ? kpi.average.toFixed(2) : 'N/A'}</div>
        </div>
        <div class="stat-box">
          <div class="label">Trend</div>
          <div class="value" style="color:${kpi.trendColor};">${kpi.trendIcon} ${Math.abs(kpi.trend).toFixed(1)}%</div>
        </div>
      </div>
      
      <div style="display:flex;gap:15px;margin-top:15px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:12px;height:12px;border-radius:50%;background:#22c55e;"></div>
          <span style="font-size:12px;color:#6b7280;">Within good direction</span></div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:12px;height:12px;border-radius:50%;background:#ef4444;"></div>
          <span style="font-size:12px;color:#6b7280;">Outside good direction</span></div>
      </div>
      ${kpi.definition ? `
        <div style="margin-top:20px;padding:15px;background:#f8fafc;border-radius:12px;border-left:4px solid #667eea;">
          <div style="font-size:12px;color:#64748b;margin-bottom:5px;">Definitsqcion</div>
          <div style="font-size:14px;color:#475569;">${kpi.definition}</div>
        </div>` : ''}
    </div>`;
}

function initializeChartJS(kpi, index) {
  const chartId = `chart-${index}`;
  const weekLabels = kpi.weeks.map(w =>
    w.includes('Week') ? `W${w.split('-Week')[1] || w.replace('Week', '')}` : w
  );
  const lowLimit = kpi.low_limit != null ? parseFloat(kpi.low_limit) : null;
  const highLimit = kpi.high_limit != null ? parseFloat(kpi.high_limit) : null;
  const direction = kpi.direction === 'down' ? 'down' : 'up';
  const axisRange = getAutoChartAxisRange(kpi.values, lowLimit, null, highLimit);

  const pointColors = JSON.stringify(kpi.values.map((v) => {
    const status = getKpiStatus(v, lowLimit, highLimit, direction);
    if (status.isGood === null) return '#6b7280';
    return status.isGood ? '#22c55e' : '#ef4444';
  }));

  const extraDatasets = [];
  if (highLimit !== null) {
    extraDatasets.push(`{
      label: 'High Limit',
      data: Array(${kpi.values.length}).fill(${highLimit}),
      type: 'line', borderColor: '#f97316',
      borderDash: [6,4], borderWidth: 2,
      pointRadius: 0, fill: false, tension: 0, order: 1
    }`);
  }
  if (lowLimit !== null) {
    extraDatasets.push(`{
      label: 'Low Limit',
      data: Array(${kpi.values.length}).fill(${lowLimit}),
      type: 'line', borderColor: '#ef4444',
      borderDash: [6,4], borderWidth: 2,
      pointRadius: 0, fill: false, tension: 0, order: 1
    }`);
  }

  return `(function(){
    const ctx${index} = document.getElementById('${chartId}').getContext('2d');
    const pc${index}  = ${pointColors};
    new Chart(ctx${index}, {
      type: 'line',
      data: {
        labels: ${JSON.stringify(weekLabels)},
        datasets: [
          {
            label: '${kpi.subject}',
            data: ${JSON.stringify(kpi.values)},
            borderColor: '#94a3b8',
            borderWidth: 2,
            backgroundColor: pc${index},
            pointBackgroundColor: pc${index},
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
            pointRadius: 9,
            pointHoverRadius: 12,
            showLine: true,
            tension: 0,
            fill: false,
            order: 2
          }
          ${extraDatasets.length ? ',' + extraDatasets.join(',') : ''}
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { font: { size: 12 }, padding: 20, usePointStyle: true } },
          tooltip: {
            backgroundColor: 'rgba(31,41,55,0.9)',
            padding: 12, cornerRadius: 8,
            callbacks: {
              label: function(ctx) {
                if (ctx.dataset.label === 'High Limit') return 'High Limit: ' + ctx.parsed.y;
                if (ctx.dataset.label === 'Low Limit')  return 'Low Limit: '  + ctx.parsed.y;
                return '${kpi.unit ? kpi.unit + ': ' : ''}' + ctx.parsed.y.toFixed(2);
              }
            }
          }
        },
        scales: {
          x: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 11 } } },
          y: { beginAtZero: false, min: ${axisRange.min}, max: ${axisRange.max}, grid: { color: 'rgba(0,0,0,0.05)' },
               ticks: { font: { size: 11 },
                  callback: function(v){ return v + '${kpi.unit ? ' ' + kpi.unit : ''}'; } } }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });
  })();`;
}

function createErrorHTML(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#ef4444,#dc2626);
      min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px;margin:0;">
      <div style="background:rgba(255,255,255,0.95);border-radius:24px;padding:50px 40px;text-align:center;max-width:500px;">
        <div style="font-size:72px;color:#ef4444;margin-bottom:30px;">âŒ</div>
        <h1 style="color:#1f2937;font-size:28px;">Error Loading KPI Trends</h1>
        <div style="color:#6b7280;padding:15px;background:#fef2f2;border-radius:12px;margin:20px 0;">${message}</div>
        <a href="/" style="display:inline-block;padding:15px 30px;background:linear-gradient(135deg,#ef4444,#dc2626);
          color:white;text-decoration:none;border-radius:12px;font-weight:600;">Return to Home</a>
      </div>
    </body></html>`;
}

const getPreviousWeek = (currentWeek) => {
  const [yearStr, weekStr] = currentWeek.split('-Week');
  let year = parseInt(yearStr), weekNumber = parseInt(weekStr) - 1;
  if (weekNumber < 1) { year--; weekNumber = 52; }
  return `${year}-Week${weekNumber}`;
};

const weekToMonthLabel = (weekStr) => {
  const match = weekStr.match(/(\d{4})-Week(\d+)/);
  if (!match) return weekStr;
  const date = new Date(parseInt(match[1]), 0, 1 + (parseInt(match[2]) - 1) * 7);
  return date.toLocaleString('en-US', { month: 'short', year: 'numeric' }); // "Feb 2026"
};

const CEO_REPORT_RECIPIENT_EMAIL = "ahmed.horri@avocarbon.com";

const hasMeaningfulManagerReportCorrectiveAction = (action = {}) =>
  Boolean(
    normalizeOptionalTextInput(action.root_cause) ||
    normalizeOptionalTextInput(action.implemented_solution) ||
    normalizeOptionalDateInput(action.due_date)
  );

const selectManagerReportCorrectiveAction = ({
  currentActions = [],
  historyActions = []
} = {}) => {
  const currentMeaningfulActions = sortCorrectiveActions(
    (Array.isArray(currentActions) ? currentActions : []).filter(hasMeaningfulManagerReportCorrectiveAction)
  );
  if (currentMeaningfulActions.length) {
    return currentMeaningfulActions[0];
  }

  const historyMeaningfulActions = sortCorrectiveActions(
    (Array.isArray(historyActions) ? historyActions : []).filter(hasMeaningfulManagerReportCorrectiveAction)
  );
  return historyMeaningfulActions.length ? historyMeaningfulActions[0] : null;
};

const resolveManagerReportActionPlanContext = async (rows = [], currentPeriodLabel = null) => {
  const reportRows = Array.isArray(rows) ? rows : [];

  if (!reportRows.length || !(await canUseActionPlanCorrectiveActions())) {
    return {
      rows: reportRows,
      currentByAllocationId: {},
      historyByAllocationId: {}
    };
  }

  const allRowsHaveDirectAllocations = reportRows.every((row) => {
    const allocationId = normalizeOptionalIntegerInput(row.kpi_target_allocation_id ?? row.kpi_values_id);
    const kpiId = normalizeOptionalIntegerInput(row.kpi_id);
    return Number.isInteger(allocationId) && allocationId > 0 && Number.isInteger(kpiId) && kpiId > 0;
  });

  if (allRowsHaveDirectAllocations) {
    const {
      currentByAllocationId,
      historyByAllocationId
    } = await loadActionPlanCorrectiveActionMaps(reportRows, currentPeriodLabel);

    return {
      rows: reportRows,
      currentByAllocationId,
      historyByAllocationId
    };
  }

  const uniqueResponsibleIds = Array.from(
    new Set(
      reportRows
        .map((row) => normalizeOptionalIntegerInput(row.responsible_id))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

  const responsibleContexts = await Promise.all(
    uniqueResponsibleIds.map(async (responsibleId) => ([
      String(responsibleId),
      await loadFormResponsibleContext(responsibleId)
    ]))
  );

  const peopleIdByResponsibleId = new Map(
    responsibleContexts.map(([responsibleId, context]) => ([
      responsibleId,
      normalizeOptionalIntegerInput(context?.people_id)
    ]))
  );

  const uniquePeopleIds = Array.from(
    new Set(
      Array.from(peopleIdByResponsibleId.values()).filter(
        (value) => Number.isInteger(value) && value > 0
      )
    )
  );

  if (!uniquePeopleIds.length) {
    return {
      rows: reportRows,
      currentByAllocationId: {},
      historyByAllocationId: {}
    };
  }

  const allocationRes = await pool.query(
    `
    SELECT
      kta.kpi_target_allocation_id,
      COALESCE(kta.created_by_people_id, kta.set_by_people_id) AS responsible_people_id,
      kta.kpi_id,
      COALESCE(k.kpi_name, '') AS kpi_name,
      COALESCE(k.kpi_sub_title, '') AS kpi_group,
      COALESCE(k.unit, '') AS kpi_unit,
      COALESCE(kta.target_unit, '') AS target_unit
    FROM public.kpi_target_allocation kta
    JOIN public.kpi k
      ON k.kpi_id = kta.kpi_id
    WHERE COALESCE(kta.created_by_people_id, kta.set_by_people_id) = ANY($1::int[])
    ORDER BY
      COALESCE(kta.updated_at, kta.created_at) DESC,
      kta.kpi_target_allocation_id DESC
    `,
    [uniquePeopleIds]
  );

  const allocationsByPeopleId = new Map();
  allocationRes.rows.forEach((row) => {
    const peopleId = normalizeOptionalIntegerInput(row.responsible_people_id);
    if (!peopleId) return;

    const peopleKey = String(peopleId);
    if (!allocationsByPeopleId.has(peopleKey)) {
      allocationsByPeopleId.set(peopleKey, []);
    }

    allocationsByPeopleId.get(peopleKey).push(row);
  });

  const normalizeMatchText = (value) => normalizeOptionalTextInput(value)?.toLowerCase() || "";

  const pickBestAllocationMatch = (row, allocations = []) => {
    const legacyKpiId = normalizeOptionalIntegerInput(row.kpi_id);
    const legacyGroup = normalizeMatchText(row.indicator_title);
    const legacyName = normalizeMatchText(row.indicator_sub_title);
    const legacyUnit = normalizeMatchText(row.unit);

    let bestMatch = null;
    let bestScore = Number.POSITIVE_INFINITY;

    allocations.forEach((allocation) => {
      const allocationKpiId = normalizeOptionalIntegerInput(allocation.kpi_id);
      const allocationGroup = normalizeMatchText(allocation.kpi_group);
      const allocationName = normalizeMatchText(allocation.kpi_name);
      const allocationUnit = normalizeMatchText(allocation.target_unit || allocation.kpi_unit);

      const exactIdMatch =
        Number.isInteger(legacyKpiId) &&
        Number.isInteger(allocationKpiId) &&
        legacyKpiId === allocationKpiId;
      const exactNameMatch = Boolean(legacyName && allocationName && legacyName === allocationName);
      const exactGroupMatch = Boolean(legacyGroup && allocationGroup && legacyGroup === allocationGroup);
      const exactUnitMatch = Boolean(legacyUnit && allocationUnit && legacyUnit === allocationUnit);

      let score = Number.POSITIVE_INFINITY;

      if (exactIdMatch && exactNameMatch && exactGroupMatch) score = 0;
      else if (exactNameMatch && exactGroupMatch && exactUnitMatch) score = 1;
      else if (exactIdMatch && exactNameMatch) score = 2;
      else if (exactIdMatch && exactGroupMatch) score = 3;
      else if (exactNameMatch && exactUnitMatch) score = 4;
      else if (exactNameMatch) score = 5;
      else if (exactIdMatch) score = 6;
      else if (exactGroupMatch && exactUnitMatch) score = 7;
      else if (exactGroupMatch) score = 8;

      if (score < bestScore) {
        bestMatch = allocation;
        bestScore = score;
      }
    });

    return Number.isFinite(bestScore) ? bestMatch : null;
  };

  const rowsWithAllocations = reportRows.map((row) => {
    const responsibleId = normalizeOptionalIntegerInput(row.responsible_id);
    const peopleId = responsibleId
      ? peopleIdByResponsibleId.get(String(responsibleId)) || null
      : null;
    const matchedAllocation = peopleId
      ? pickBestAllocationMatch(row, allocationsByPeopleId.get(String(peopleId)) || [])
      : null;

    return {
      ...row,
      kpi_target_allocation_id:
        normalizeOptionalIntegerInput(matchedAllocation?.kpi_target_allocation_id) || null,
      action_plan_kpi_id:
        normalizeOptionalIntegerInput(matchedAllocation?.kpi_id) || null
    };
  });

  const matchedAllocationRows = rowsWithAllocations
    .filter((row) =>
      Number.isInteger(normalizeOptionalIntegerInput(row.kpi_target_allocation_id)) &&
      Number.isInteger(normalizeOptionalIntegerInput(row.action_plan_kpi_id))
    )
    .map((row) => ({
      kpi_target_allocation_id: row.kpi_target_allocation_id,
      kpi_values_id: row.kpi_target_allocation_id,
      kpi_id: row.action_plan_kpi_id
    }));

  if (!matchedAllocationRows.length) {
    return {
      rows: rowsWithAllocations,
      currentByAllocationId: {},
      historyByAllocationId: {}
    };
  }

  const {
    currentByAllocationId,
    historyByAllocationId
  } = await loadActionPlanCorrectiveActionMaps(matchedAllocationRows, currentPeriodLabel);

  return {
    rows: rowsWithAllocations,
    currentByAllocationId,
    historyByAllocationId
  };
};


const getDepartmentKPIReport = async (plantId, week) => {
  try {
    const plantRes = await pool.query(
      `
      SELECT
        u.unit_id AS plant_id,
        u.unit_name AS plant_name,
        NULLIF(TRIM(CONCAT_WS(' ', COALESCE(m.first_name, ''), COALESCE(m.name, ''))), '') AS manager,
        m.email AS manager_email
      FROM public.unit u
      LEFT JOIN public.people m
        ON m.people_id = u.manager_id
      WHERE u.unit_id = $1
      `,
      [plantId]
    );
    const plant = plantRes.rows[0];
    if (!plant) return null;

    const kpiRes = await pool.query(
      `
      WITH plant_allocations AS (
        SELECT
          kta.kpi_target_allocation_id,
          kta.kpi_id,
          owner.people_id AS responsible_id,
          NULLIF(TRIM(CONCAT_WS(' ', COALESCE(owner.first_name, ''), COALESCE(owner.name, ''))), '') AS responsible_name
        FROM public.kpi_target_allocation kta
        LEFT JOIN public.people owner
          ON owner.people_id = COALESCE(kta.created_by_people_id, kta.set_by_people_id)
        WHERE COALESCE(kta.plant_id, owner.work_at_unit_id) = $1
      ),
      latest_kpi_values AS (
        SELECT
          pa.kpi_target_allocation_id,
          pa.kpi_id,
          pa.responsible_id,
          pa.responsible_name,
          COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')) AS week,
          kr.raw_value AS new_value,
          kr.recorded_at AS updated_at,
          kr.comments AS comment,
          kr.unit AS result_unit,
          kr.target_value AS result_target_value,
          kr.upper_limit AS result_high_limit,
          kr.lower_limit AS result_low_limit,
          ROW_NUMBER() OVER (
            PARTITION BY pa.kpi_target_allocation_id
            ORDER BY kr.recorded_at DESC, kr.kpi_result_id DESC
          ) AS rn
        FROM plant_allocations pa
        JOIN public.kpi_result kr
          ON kr.kpi_target_allocation_id = pa.kpi_target_allocation_id
        WHERE ($2::text IS NULL OR kr.period_label = $2 OR kr.week = $2)
          AND kr.raw_value IS NOT NULL
          AND CAST(kr.raw_value AS TEXT) ~ '^[0-9.]+$'
      )
      SELECT
        lkv.kpi_target_allocation_id,
        lkv.kpi_id,
        lkv.responsible_id,
        lkv.responsible_name,
        lkv.week,
        lkv.new_value,
        lkv.updated_at,
        lkv.comment,
        COALESCE(k.kpi_sub_title, subject_link.subject_name, k.kpi_name, 'KPI') AS indicator_title,
        COALESCE(k.kpi_name, k.kpi_sub_title, 'Untitled KPI') AS indicator_sub_title,
        COALESCE(lkv.result_unit, kta.target_unit, k.unit) AS unit,
        COALESCE(lkv.result_target_value, kta.target_value, k.target_value) AS target,
        k.min_value AS min,
        k.max_value AS max,
        COALESCE(lkv.result_high_limit, k.high_limit) AS high_limit,
        COALESCE(lkv.result_low_limit, k.low_limit) AS low_limit,
        ''::text AS department_name,
        k.target_direction
      FROM latest_kpi_values lkv
      JOIN public.kpi_target_allocation kta
        ON kta.kpi_target_allocation_id = lkv.kpi_target_allocation_id
      JOIN public.kpi k
        ON k.kpi_id = lkv.kpi_id
      LEFT JOIN LATERAL (
        SELECT s.subject_name
        FROM public.subject_kpi sk
        JOIN public.subject s
          ON s.subject_id = sk.subject_id
        WHERE sk.kpi_id = lkv.kpi_id
        ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
        LIMIT 1
      ) subject_link ON TRUE
      WHERE lkv.rn = 1
      ORDER BY indicator_title, indicator_sub_title, lkv.kpi_target_allocation_id
      `,
      [plantId, week]
    );

    if (!kpiRes.rows.length) return null;

    const {
      rows: kpiReportRows,
      currentByAllocationId,
      historyByAllocationId
    } = await resolveManagerReportActionPlanContext(kpiRes.rows, week);

    const weeklyTrendRes = await pool.query(
      `
      WITH plant_allocations AS (
        SELECT
          kta.kpi_target_allocation_id,
          kta.kpi_id,
          owner.people_id AS responsible_id,
          NULLIF(TRIM(CONCAT_WS(' ', COALESCE(owner.first_name, ''), COALESCE(owner.name, ''))), '') AS responsible_name
        FROM public.kpi_target_allocation kta
        LEFT JOIN public.people owner
          ON owner.people_id = COALESCE(kta.created_by_people_id, kta.set_by_people_id)
        WHERE COALESCE(kta.plant_id, owner.work_at_unit_id) = $1
      )
      SELECT
        pa.kpi_target_allocation_id,
        pa.kpi_id,
        pa.responsible_id,
        pa.responsible_name,
        COALESCE(k.kpi_sub_title, subject_link.subject_name, k.kpi_name, 'KPI') AS indicator_title,
        COALESCE(k.kpi_name, k.kpi_sub_title, 'Untitled KPI') AS indicator_sub_title,
        COALESCE(kr.unit, kta.target_unit, k.unit) AS unit,
        COALESCE(kr.target_value, kta.target_value, k.target_value) AS target,
        k.min_value AS min,
        k.max_value AS max,
        COALESCE(kr.upper_limit, k.high_limit) AS high_limit,
        COALESCE(kr.lower_limit, k.low_limit) AS low_limit,
        COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')) AS week,
        CAST(kr.raw_value AS NUMERIC) AS avg_value
      FROM plant_allocations pa
      JOIN public.kpi_target_allocation kta
        ON kta.kpi_target_allocation_id = pa.kpi_target_allocation_id
      JOIN public.kpi_result kr
        ON kr.kpi_target_allocation_id = pa.kpi_target_allocation_id
      JOIN public.kpi k
        ON k.kpi_id = pa.kpi_id
      LEFT JOIN LATERAL (
        SELECT s.subject_name
        FROM public.subject_kpi sk
        JOIN public.subject s
          ON s.subject_id = sk.subject_id
        WHERE sk.kpi_id = pa.kpi_id
        ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
        LIMIT 1
      ) subject_link ON TRUE
      WHERE kr.raw_value IS NOT NULL
        AND CAST(kr.raw_value AS TEXT) ~ '^[0-9.]+$'
      ORDER BY pa.kpi_target_allocation_id ASC, week ASC
      `,
      [plantId]
    );

    const extractDept = (t) => {
      if (!t) return 'Other';
      if (t.includes(' / ')) return t.split(' / ')[0].trim() || 'Other';
      if (t.includes('/')) return t.split('/')[0].trim() || 'Other';
      if (t.includes('Actual - ')) {
        const ex = t.split('Actual - ')[1];
        if (ex.includes('/')) return ex.split('/')[0].trim();
        if (ex.includes('(')) return ex.split('(')[0].trim();
        return ex.trim();
      }
      return t;
    };

    const kpisByDepartment = {};
    const weeklyDataByKPI = {};

    // Accumulate weekly values grouped into months
    weeklyTrendRes.rows.forEach(row => {
      const key = String(row.kpi_target_allocation_id || `${row.kpi_id}_${row.responsible_id || ''}`);
      const dept = extractDept(row.indicator_title);
      const month = weekToMonthLabel(row.week); // e.g. "Feb 2026"

      if (!weeklyDataByKPI[key]) {
        weeklyDataByKPI[key] = {
          allocation_id: row.kpi_target_allocation_id,
          kpi_id: row.kpi_id, title: row.indicator_title, subtitle: row.indicator_sub_title || '',
          unit: row.unit || '', target: row.target, min: row.min, max: row.max,
          high_limit: row.high_limit, low_limit: row.low_limit,
          department: dept,
          responsible: row.responsible_name || '',
          _monthlyMap: {},  // { "Feb 2026": { sum, count } }
          weeks: [], values: []
        };
      }

      const mm = weeklyDataByKPI[key]._monthlyMap;
      if (!mm[month]) mm[month] = { sum: 0, count: 0 };
      mm[month].sum += parseFloat(row.avg_value);
      mm[month].count += 1;
    });

    // Convert monthly map â†’ sorted arrays
    Object.values(weeklyDataByKPI).forEach(kpi => {
      const mm = kpi._monthlyMap || {};
      const sortedMonths = Object.keys(mm).sort((a, b) => new Date(a) - new Date(b));
      kpi.weeks = sortedMonths;                                        // ["Jan 2026", "Feb 2026", â€¦]
      kpi.values = sortedMonths.map(m => mm[m].sum / mm[m].count);     // monthly average
      delete kpi._monthlyMap;
    });

    kpiReportRows.forEach(row => {
      const dept = extractDept(row.indicator_title);
      const key = String(row.kpi_target_allocation_id || `${row.kpi_id}_${row.responsible_id || ''}`);
      if (!kpisByDepartment[dept]) kpisByDepartment[dept] = [];
      let existing = kpisByDepartment[dept].find(
        (k) => String(k.allocationId || '') === String(row.kpi_target_allocation_id || '')
      );
      if (!existing) {
        existing = {
          id: row.kpi_id, title: row.indicator_title, subtitle: row.indicator_sub_title || '',
          unit: row.unit || '', target: row.target, min: row.min, max: row.max,
          high_limit: row.high_limit, low_limit: row.low_limit,
          department: dept, originalDepartment: row.department_name,
          currentValue: parseFloat(row.new_value),
          weeklyData: weeklyDataByKPI[key] || { weeks: [], values: [] },
          lastUpdated: row.updated_at, responsible: row.responsible_name || '',
          allocationId: row.kpi_target_allocation_id || null,
          kpiTargetAllocationId: row.kpi_target_allocation_id || null,
          comments: [], correctiveAction: null
        };
        kpisByDepartment[dept].push(existing);
      }
      if (row.comment && row.comment.trim())
        existing.comments.push({ week: row.week, text: row.comment.trim() });

      const allocationKey = String(row.kpi_target_allocation_id || "").trim();
      const selectedCorrectiveAction = allocationKey
        ? selectManagerReportCorrectiveAction({
          currentActions: currentByAllocationId[allocationKey] || [],
          historyActions: historyByAllocationId[allocationKey] || []
        })
        : null;

      if (!existing.correctiveAction && selectedCorrectiveAction) {
        existing.correctiveAction = {
          rootCause: normalizeOptionalTextInput(selectedCorrectiveAction.root_cause) || '',
          implementedSolution: normalizeOptionalTextInput(selectedCorrectiveAction.implemented_solution) || '',
          evidence: '',
          dueDate: selectedCorrectiveAction.due_date || null,
          week: selectedCorrectiveAction.week || selectedCorrectiveAction.period_label || null,
          status: normalizeOptionalTextInput(selectedCorrectiveAction.status) || ''
        };
      }
    });

    const sortedDepts = {};
    Object.keys(kpisByDepartment).sort().forEach(d => { sortedDepts[d] = kpisByDepartment[d]; });

    return {
      plant, week, kpisByDepartment: sortedDepts,
      stats: {
        totalDepartments: Object.keys(sortedDepts).length,
        totalKPIs: Object.values(sortedDepts).reduce((s, k) => s + k.length, 0),
        totalValues: kpiRes.rows.length
      }
    };
  } catch (error) {
    console.error(`Error getting KPI report for plant ${plantId}:`, error.message);
    return null;
  }
};

async function sendDepartmentKPIReportEmail(plantId, currentWeek, recipientOverride = null) {
  try {
    const reportWeek = currentWeek;
    const reportData = await getDepartmentKPIReport(plantId, reportWeek);
    if (!reportData || reportData.stats.totalKPIs === 0) return null;
    const deliveryRecipient =
      normalizeOptionalTextInput(recipientOverride?.recipientEmail) ||
      normalizeOptionalTextInput(CEO_REPORT_RECIPIENT_EMAIL) ||
      normalizeOptionalTextInput(reportData.plant?.manager_email);

    if (!deliveryRecipient) {
      throw new Error(`No delivery recipient found for plant ${plantId}`);
    }

    const emailHtml = generateManagerReportHtml({
      ...reportData,
      deliveryRecipient
    });

    // â”€â”€ Generate plant-wide recommendations PDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let pdfAttachment = null;
    try {
      console.log(`ðŸ“„ Generating plant-wide recommendations PDF for plant=${plantId}â€¦`);
      const pdfBuffer = await generatePlantKPIRecommendationsPDFBuffer(pool, plantId, reportWeek);
      if (pdfBuffer) {
        const weekLabel = reportWeek.replace('2026-Week', 'Week_');
        pdfAttachment = {
          filename: `KPI_Recommendations_${reportData.plant.plant_name.replace(/ /g, '_')}_${weekLabel}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        };
        console.log(`ðŸ“„ Plant PDF ready â€” ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
      }
    } catch (pdfErr) {
      // Never block the main email if PDF generation fails
      console.error(`Could not generate plant recommendations PDF:`, pdfErr.message);
    }

    // â”€â”€ Send email with optional PDF attachment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const transporter = createTransporter();
    const info = await transporter.sendMail({
      from: '"AVOCarbon Plant Analytics" <administration.STS@avocarbon.com>',
      to: deliveryRecipient,
      subject: `Weekly KPI Dashboard - ${reportData.plant.plant_name} - Week ${reportWeek.replace('2026-Week', '')}`,
      html: emailHtml,
      attachments: pdfAttachment ? [{
        ...pdfAttachment,
        contentDisposition: "attachment"
      }] : []
    });

    console.log("[Plant KPI Report] Mail result:", {
      plantId,
      to: deliveryRecipient,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      messageId: info.messageId,
      hasPdf: Boolean(pdfAttachment)
    });
    console.log(`KPI report${pdfAttachment ? ' + recommendations PDF' : ''} sent to ${deliveryRecipient}`);
    return {
      plant: reportData.plant,
      week: reportWeek,
      recipientEmail: deliveryRecipient
    };
  } catch (error) {
    console.error(`Failed to send report for plant ${plantId}:`, error.message);
    throw error;
  }
};

// ---------------------------------------------------------------------------
// sendConsolidatedManagerReport
// Sends ONE combined KPI email to a manager containing the KPI charts for
// EACH of their direct reports (passed as an array of people IDs).
// ---------------------------------------------------------------------------
async function sendConsolidatedManagerReport(manager, directReportPeopleIds, currentWeek) {
  const appBaseUrl = (normalizeOptionalTextInput(process.env.APP_BASE_URL) || "https://kpi-form.azurewebsites.net")
    .replace(/\/+$/, "");
  const reportWeekLabel = formatWeeklyReportWeekLabel(currentWeek);
  const managerName = getPeopleDisplayName(manager) || `${manager.first_name || ""} ${manager.name || ""}`.trim();
  const managerRoleName = normalizeOptionalTextInput(manager.role_name) || "Manager";

  // ── Build per-responsible sections ────────────────────────────────────────
  const responsibleSections = [];
  const allInlineAttachments = [];
  let globalChartIndex = 0;

  for (const responsiblePeopleId of directReportPeopleIds) {
    try {
      const responsibleContext = await loadFormResponsibleContext(responsiblePeopleId);
      const respName = normalizeOptionalTextInput(responsibleContext?.name) || `People #${responsiblePeopleId}`;
      const respPlant = normalizeOptionalTextInput(responsibleContext?.plant_name) || "";
      const respRole = normalizeOptionalTextInput(responsibleContext?.role_name) || "";
      const dashboardUrl = `${appBaseUrl}/dashboard?responsible_id=${encodeURIComponent(responsiblePeopleId)}`;

      const chartsData = await generateWeeklyReportData(responsiblePeopleId, currentWeek);
      const chartsForEmail = Array.isArray(chartsData)
        ? chartsData.slice(0, WEEKLY_REPORT_MAX_CHARTS)
        : [];

      let chartsHtml = "";

      if (chartsForEmail.length > 0) {
        const chartModels = chartsForEmail.map((chart) => buildWeeklyReportChartModel(chart));
        const inlineChartResults = await Promise.all(
          chartModels.map((chartModel, idx) =>
            fetchWeeklyReportInlineChartAttachment(chartModel, globalChartIndex + idx)
          )
        );
        globalChartIndex += chartModels.length;

        chartsHtml = chartModels.map((chartModel, idx) =>
          generateVerticalBarChart(chartModel, {
            imageSrc: inlineChartResults[idx]?.cid ? `cid:${inlineChartResults[idx].cid}` : ""
          })
        ).join("");

        inlineChartResults
          .map((entry) => entry?.attachment)
          .filter(Boolean)
          .forEach((att) => allInlineAttachments.push({ ...att, contentDisposition: "inline" }));
      } else {
        chartsHtml = `<div style="padding:20px;text-align:center;color:#64748b;font-size:13px;">No KPI data available for this period.</div>`;
      }

      responsibleSections.push(`
        <div style="margin:0 0 28px;border:1px solid #dbe4ef;border-radius:14px;overflow:hidden;background:#ffffff;">
          <div style="background:#1e3a5f;padding:14px 20px;">
            <div style="font-size:15px;font-weight:700;color:#ffffff;">${escapeWeeklyReportText(respName, 100)}</div>
            <div style="font-size:12px;color:#94a3b8;margin-top:3px;">
              ${respRole ? escapeWeeklyReportText(respRole, 80) + " &nbsp;|&nbsp; " : ""}${escapeWeeklyReportText(respPlant, 80)}
              &nbsp;&nbsp;
              
            </div>
          </div>
          <div style="padding:16px 16px 10px;">
            ${chartsHtml}
          </div>
        </div>
      `);
    } catch (respErr) {
      console.error(`[Consolidated Manager Report] Error loading data for responsible ${responsiblePeopleId}:`, respErr.message);
    }
  }

  if (!responsibleSections.length) {
    throw new Error(`No KPI data could be loaded for any direct report of manager ${managerName}`);
  }

  // ── Assemble email HTML ────────────────────────────────────────────────────
  const emailHtml = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#edf3fb;color:#0f172a;">
    <div style="display:none;font-size:1px;color:#edf3fb;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      Manager KPI Report ${escapeWeeklyReportText(reportWeekLabel, 40)} — ${directReportPeopleIds.length} direct report(s).
    </div>
    <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background:#edf3fb;">
      <tr>
        <td align="center" style="padding:28px 18px;">
          <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:1040px;background:#f8fbff;border-radius:18px;">
            <!-- Header -->
            <tr>
              <td style="padding:30px 30px 22px;">
                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background:#127bd8;border-radius:10px;">
                  <tr>
                    <td align="center" style="padding:26px 20px;">
                      <div style="font-size:20px;font-weight:700;color:#ffffff;margin:0 0 6px;">&#128202; Manager KPI Report</div>
                      <div style="font-size:14px;color:#e0f2fe;margin:0 0 14px;">
                        ${escapeWeeklyReportText(reportWeekLabel, 40)}
                        &nbsp;|&nbsp; ${escapeWeeklyReportText(managerName, 80)}
                        &nbsp;|&nbsp; ${escapeWeeklyReportText(managerRoleName, 80)}
                      </div>
                      <div style="font-size:12px;color:#bae6fd;">
                        ${directReportPeopleIds.length} direct report(s) included in this report
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <!-- Info banner -->
            <tr>
              <td style="padding:0 30px 20px;">
                <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;color:#1d4ed8;font-size:13px;line-height:1.5;">
                  This report shows the KPI performance of your <strong>direct reports</strong> for ${escapeWeeklyReportText(reportWeekLabel, 40)}.
                  Each section below corresponds to one of your direct reports.
                </div>
              </td>
            </tr>
            <!-- Responsible sections -->
            <tr>
              <td style="padding:0 30px 30px;">
                ${responsibleSections.join("")}
              </td>
            </tr>
            <!-- Footer -->
            <tr>
              <td style="padding:18px 24px 26px;text-align:center;font-size:12px;color:#64748b;border-top:1px solid #dbe4ef;">
                AVOCarbon KPI System | Generated ${new Date().toLocaleDateString("en-GB")}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const transporter = createTransporter();
  const messageToken = [
    "mgr-consolidated",
    manager.people_id,
    String(currentWeek || "week").replace(/[^a-zA-Z0-9_-]/g, "_"),
    Date.now()
  ].join("-");

  const info = await transporter.sendMail({
    from: '"AVOCarbon KPI System" <administration.STS@avocarbon.com>',
    sender: "administration.STS@avocarbon.com",
    replyTo: "administration.STS@avocarbon.com",
    to: manager.email,
    subject: `Manager KPI Report — Direct Reports — ${reportWeekLabel}`,
    html: emailHtml,
    attachments: allInlineAttachments,
    headers: {
      "X-Auto-Response-Suppress": "OOF, AutoReply",
      "X-Manager-Report-Id": messageToken
    },
    date: new Date(),
    messageId: `<${messageToken}@avocarbon.com>`
  });

  console.log(`[Consolidated Manager Report] Sent to ${manager.email} (${managerName}) — ${directReportPeopleIds.length} direct report(s):`, {
    accepted: info.accepted,
    rejected: info.rejected,
    messageId: info.messageId
  });

  return info;
}

// ---------------------------------------------------------------------------
// runHierarchyKpiReports (consolidated mode)
// For each responsible with KPIs, resolve their direct boss via the role
// hierarchy (parent_role_id). Group all responsibles by the same direct boss
// and send ONE combined email per manager.
// ---------------------------------------------------------------------------
async function runHierarchyKpiReports(frequency, options = {}) {
  // Required lazily (not at module top-level) because hierarchyReport.service.js
  // itself requires this file -- a top-level require here would be circular.
  const { getPeopleHierarchy } = require("./hierarchyReport.service");
  const normalizedFrequency = normalizeOptionalTextInput(frequency) || "Weekly";
  const currentWeek =
    normalizeOptionalTextInput(options.reportWeek) || getPreviousWeek(getCurrentWeek());
  const targetResponsiblePeopleId = normalizeOptionalIntegerInput(options.responsiblePeopleId);

  // 1️⃣  Collect all responsibles that have KPIs for the given frequency
  const responsiblesRes = targetResponsiblePeopleId
    ? { rows: [{ responsible_people_id: targetResponsiblePeopleId }] }
    : await pool.query(
      `
        SELECT DISTINCT
          COALESCE(kta.created_by_people_id, kta.set_by_people_id) AS responsible_people_id
        FROM public.kpi_target_allocation kta
        JOIN public.kpi k ON k.kpi_id = kta.kpi_id
        WHERE COALESCE(kta.created_by_people_id, kta.set_by_people_id) IS NOT NULL
          AND LOWER(k.frequency) = LOWER($1)
        `,
      [normalizedFrequency]
    );

  // 2️⃣  For each responsible resolve their DIRECT boss (hierarchy level 1)
  //     and group responsibles by that boss.
  // managerMap: Map<managerPeopleId(string), { manager: hierarchyRow, directReports: Set<peopleId> }>
  const managerMap = new Map();

  for (const row of responsiblesRes.rows) {
    const responsiblePeopleId = normalizeOptionalIntegerInput(row.responsible_people_id);
    if (!responsiblePeopleId) continue;

    let hierarchy;
    try {
      hierarchy = await getPeopleHierarchy(responsiblePeopleId);
    } catch (hierarchyErr) {
      console.warn(`[Hierarchy Report] Could not load hierarchy for responsible ${responsiblePeopleId}:`, hierarchyErr.message);
      continue;
    }

    if (!hierarchy.length) continue;

    // hierarchy[0] = the responsible themselves
    // hierarchy[1] = their direct boss (one level up via parent_role_id)
    const directBoss = hierarchy[1];
    if (!directBoss || !directBoss.email) {
      console.log(`[Hierarchy Report] No direct boss with email found for responsible ${responsiblePeopleId} — skipping.`);
      continue;
    }

    const bossKey = String(directBoss.people_id);
    if (!managerMap.has(bossKey)) {
      managerMap.set(bossKey, { manager: directBoss, directReports: new Set() });
    }
    managerMap.get(bossKey).directReports.add(responsiblePeopleId);
  }

  console.log(`[Hierarchy Report] Found ${managerMap.size} manager(s) with direct reports having KPIs.`);

  // 3️⃣  Send ONE consolidated email per manager
  const managerResults = [];

  for (const [bossKey, { manager, directReports }] of managerMap) {
    const managerName = getPeopleDisplayName(manager) || `${manager.first_name || ""} ${manager.name || ""}`.trim();
    const directReportIds = [...directReports];

    console.log(`[Hierarchy Report] Sending consolidated report to ${manager.email} (${managerName}) for ${directReportIds.length} direct report(s).`);

    try {
      await sendConsolidatedManagerReport(manager, directReportIds, currentWeek);
      managerResults.push({
        managerId: normalizeOptionalIntegerInput(manager.people_id),
        managerName,
        email: manager.email,
        roleName: normalizeOptionalTextInput(manager.role_name) || "",
        directReportCount: directReportIds.length,
        directReportIds,
        status: "sent"
      });
    } catch (sendErr) {
      console.error(`[Hierarchy Report] Failed consolidated email for manager ${manager.email}:`, sendErr.message);
      managerResults.push({
        managerId: normalizeOptionalIntegerInput(manager.people_id),
        managerName,
        email: manager.email,
        roleName: normalizeOptionalTextInput(manager.role_name) || "",
        directReportCount: directReportIds.length,
        directReportIds,
        status: "failed",
        error: sendErr.message
      });
    }

    // Brief pause between manager emails to avoid SMTP throttling
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  return {
    frequency: normalizedFrequency,
    week: currentWeek,
    managersProcessed: managerResults.length,
    deliveriesSent: managerResults.filter((r) => r.status === "sent").length,
    deliveriesFailed: managerResults.filter((r) => r.status === "failed").length,
    managerResults
  };
}


module.exports = {
  getCurrentWeek,
  getCurrentFormWeek,
  generateWeeklyReportEmail,
  runWeeklyKpiSubmissionCron,
  generateManagerReportHtml,
  getDepartmentKPIReport,
  sendDepartmentKPIReportEmail,
  sendConsolidatedManagerReport,
  runHierarchyKpiReports,
  getPreviousWeek,
  CEO_REPORT_RECIPIENT_EMAIL,
  weekToMonthLabel,
  hasMeaningfulManagerReportCorrectiveAction,
};
