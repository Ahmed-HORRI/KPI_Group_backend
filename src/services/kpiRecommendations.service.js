/**
 * kpi-recommendations.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this file next to server.js, then add at the top of server.js:
 *
 *   const {
 *     registerRecommendationRoutes,
 *     generateAndSendKPIRecommendations,
 *     generateAndSendManagerReport,
 *     generateKPIRecommendationsPDFBuffer,   // ← attach PDF to weekly report
 *   } = require('./kpi-recommendations');
 *
 * And after `app` is created (before app.listen):
 *
 *   registerRecommendationRoutes(app, pool, createTransporter);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

const OpenAI = require("openai");
const { generateKPIPdf } = require('./kpiPdfBuilder.service');
const {
    BRAND,
    STATUS,
    FONT,
    BRAND_PAGE_CSS,
    renderEmailHeader,
    renderEmailFooter,
    renderPageHeader,
    withLogoAttachment,
} = require("../config/brand");

// ── Colour / status helper (mirrors server.js getDotColor) ───────────────────
const getStatus = (value, lowLimit) => {
    const val = parseFloat(value);
    if (isNaN(val)) return "No Data";
    const ll = parseFloat(lowLimit);
    if (isNaN(ll)) return "On Track";
    if (val < ll) return "Below Limit";
    if (val < ll * 1.10) return "Near Limit";
    return "On Track";
};

// ── Fetch all KPI data for a responsible + week ───────────────────────────────
const fetchKPIData = async (pool, responsibleId, week) => {
    const resResp = await pool.query(
        `SELECT p.people_id AS responsible_id,
                NULLIF(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, ''))), '') AS name,
                p.email,
                p.work_at_unit_id AS plant_id,
                u.unit_name AS plant_name,
                ''::text AS department_name,
                NULLIF(TRIM(CONCAT_WS(' ', COALESCE(m.first_name, ''), COALESCE(m.name, ''))), '') AS manager,
                m.email AS manager_email
         FROM public.people p
         LEFT JOIN public.unit   u ON p.work_at_unit_id = u.unit_id
         LEFT JOIN public.people m ON u.manager_id      = m.people_id
         WHERE p.people_id = $1`,
        [responsibleId]
    );
    const responsible = resResp.rows[0];
    if (!responsible) throw new Error("Responsible not found");

    const kpiRes = await pool.query(
        `
         SELECT
                kta.kpi_target_allocation_id AS kpi_values_id,
                latest_result.raw_value AS value,
                COALESCE(
                    latest_result.week,
                    latest_result.period_label,
                    TO_CHAR(latest_result.result_date, 'YYYY-MM-DD'),
                    $2::text
                ) AS week,
                k.kpi_id,
                COALESCE(subject_link.subject_name, k.kpi_sub_title, k.kpi_name, 'KPI') AS subject,
                COALESCE(k.kpi_name, k.kpi_sub_title, 'Untitled KPI') AS indicator_sub_title,
                COALESCE(latest_result.unit, kta.target_unit, k.unit) AS unit,
                COALESCE(latest_result.target_value, kta.target_value, k.target_value) AS target,
                COALESCE(latest_result.lower_limit, k.low_limit) AS low_limit,
                COALESCE(latest_result.upper_limit, k.high_limit) AS high_limit,
                k.kpi_explanation AS definition,
                k.frequency,
                latest_result.recorded_at AS last_updated,
                latest_result.comments AS latest_comment,
                NULL::text AS root_cause,
                NULL::text AS implemented_solution,
                NULL::text AS evidence,
                NULL::text AS ca_status
         FROM public.kpi_target_allocation kta
         JOIN public.kpi k
           ON k.kpi_id = kta.kpi_id
         LEFT JOIN LATERAL (
                SELECT s.subject_name
                FROM public.subject_kpi sk
                JOIN public.subject s
                  ON s.subject_id = sk.subject_id
                WHERE sk.kpi_id = k.kpi_id
                ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
                LIMIT 1
         ) subject_link ON TRUE
         LEFT JOIN LATERAL (
                SELECT
                    kr.result_date,
                    kr.week,
                    kr.period_label,
                    kr.raw_value,
                    kr.target_value,
                    kr.lower_limit,
                    kr.upper_limit,
                    kr.unit,
                    kr.recorded_at,
                    kr.comments
                FROM public.kpi_result kr
                WHERE kr.kpi_target_allocation_id = kta.kpi_target_allocation_id
                  AND (($2::text IS NOT NULL AND (kr.period_label = $2 OR kr.week = $2)) OR $2::text IS NULL)
                ORDER BY
                    CASE WHEN $2::text IS NOT NULL AND (kr.period_label = $2 OR kr.week = $2) THEN 0 ELSE 1 END,
                    kr.recorded_at DESC,
                    kr.kpi_result_id DESC
                LIMIT 1
         ) latest_result ON TRUE
         WHERE kta.set_by_people_id = $1
         ORDER BY kta.kpi_target_allocation_id ASC
         `,
        [responsibleId, week]
    );

    // Historical values for trend analysis (last 8 weeks per KPI)
    const histRes = await pool.query(
        `
         SELECT DISTINCT ON (
                kr.kpi_target_allocation_id,
                COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD'))
         )
                kr.kpi_id,
                kr.kpi_target_allocation_id AS kpi_values_id,
                COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')) AS week,
                kr.raw_value AS new_value
         FROM public.kpi_result kr
         JOIN public.kpi_target_allocation kta
           ON kta.kpi_target_allocation_id = kr.kpi_target_allocation_id
         WHERE COALESCE(kta.created_by_people_id, kta.set_by_people_id) = $1
           AND NULLIF(TRIM(kr.raw_value::text), '') IS NOT NULL
         ORDER BY
                kr.kpi_target_allocation_id,
                COALESCE(kr.week, kr.period_label, TO_CHAR(kr.result_date, 'YYYY-MM-DD')),
                kr.recorded_at DESC,
                kr.kpi_result_id DESC
         LIMIT 400
         `,
        [responsibleId]
    );

    // Group history by allocation id so separate KPI assignments do not collapse.
    const histMap = {};
    histRes.rows.forEach(r => {
        const historyKey = String(r.kpi_values_id || r.kpi_id);
        if (!histMap[historyKey]) histMap[historyKey] = [];
        histMap[historyKey].push({
            week: r.week,
            value: Number.parseFloat(String(r.new_value || "0").trim()) || 0
        });
    });

    const kpis = kpiRes.rows.map(k => ({
        ...k,
        status: getStatus(k.value, k.low_limit),
        history: (histMap[String(k.kpi_values_id || k.kpi_id)] || []).slice(0, 8).reverse(),
    }));

    return { responsible, kpis };
};

// ── Build the OpenAI prompt for a single KPI ─────────────────────────────────
const buildKPIPrompt = (kpi, responsible) => {
    const histLine = kpi.history.length
        ? kpi.history.map(h => `${h.week}: ${h.value}`).join(", ")
        : "No historical data";

    const gap = (() => {
        const val = parseFloat(kpi.value);
        const ll  = parseFloat(kpi.low_limit);
        if (!isNaN(val) && !isNaN(ll) && val < ll) {
            return `${(ll - val).toFixed(2)} ${kpi.unit || ""} (${(((ll - val) / ll) * 100).toFixed(1)}% below limit)`;
        }
        return "Within acceptable range";
    })();

    return `You are an industrial performance expert and continuous-improvement coach.

Analyse this KPI for ${responsible.plant_name} — ${responsible.department_name}:

KPI: ${kpi.subject}${kpi.indicator_sub_title ? ` — ${kpi.indicator_sub_title}` : ""}
Unit: ${kpi.unit || "N/A"}
Current value: ${kpi.value} ${kpi.unit || ""}
Low limit: ${kpi.low_limit ?? "N/A"}
High limit: ${kpi.high_limit ?? "N/A"}
Target: ${kpi.target ?? "N/A"}
Status: ${kpi.status}
Gap from low limit: ${gap}
Historical trend (oldest → newest): ${histLine}
${kpi.definition     ? `Definition: ${kpi.definition}`                          : ""}
${kpi.latest_comment ? `Manager comment: ${kpi.latest_comment}`                 : ""}
${kpi.ca_status      ? `Existing corrective action status: ${kpi.ca_status}`    : ""}

Provide a detailed, actionable recommendation with these EXACT fields.
Return ONLY valid JSON, no markdown, no extra text.

{
  "root_cause":        "Detailed analysis of likely root causes based on the data pattern (2-3 sentences)",
  "immediate_actions": "Specific actions to take THIS WEEK to stabilise the KPI (2-3 sentences)",
  "medium_term_plan":  "3-4 week improvement roadmap with milestones (2-3 sentences)",
  "evidence_metrics":  "Exact metrics and checkpoints to measure improvement (2-3 sentences)",
  "risk_mitigation":   "Risks if no action is taken and mitigation strategies (2-3 sentences)"
}`;
};

// ── Call OpenAI for each KPI ──────────────────────────────────────────────────
const generateAIRecommendations = async (kpis, responsible) => {
    const openai = new OpenAI({ apiKey: process.env.SECRET_KEY });

    // Prioritise: Below Limit > Near Limit > On Track > No Data
    const sorted = [...kpis].sort((a, b) => {
        const order = { "Below Limit": 0, "Near Limit": 1, "On Track": 2, "No Data": 3 };
        return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    });

    const recs = [];
    for (const kpi of sorted) {
        try {
            const completion = await openai.chat.completions.create({
                model:       "gpt-4o-mini",
                messages:    [{ role: "user", content: buildKPIPrompt(kpi, responsible) }],
                temperature: 0.65,
                max_tokens:  700,
            });

            const raw    = completion.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
            const parsed = JSON.parse(raw);

            recs.push({
                kpi_name:      kpi.subject,
                kpi_subtitle:  kpi.indicator_sub_title || "",
                kpi_id:        kpi.kpi_id,
                unit:          kpi.unit || "",
                current_value: kpi.value,
                low_limit:     kpi.low_limit,
                high_limit:    kpi.high_limit,
                target:        kpi.target,
                status:        kpi.status,
                ...parsed,
            });
        } catch (err) {
            console.error(`AI recommendation failed for ${kpi.subject}:`, err.message);
            recs.push({
                kpi_name:           kpi.subject,
                kpi_subtitle:       kpi.indicator_sub_title || "",
                kpi_id:             kpi.kpi_id,
                unit:               kpi.unit || "",
                current_value:      kpi.value,
                low_limit:          kpi.low_limit,
                high_limit:         kpi.high_limit,
                target:             kpi.target,
                status:             kpi.status,
                root_cause:         "Analysis unavailable — please review manually.",
                immediate_actions:  "Review the KPI value and compare with historical data.",
                medium_term_plan:   "Establish a baseline and set weekly improvement targets.",
                evidence_metrics:   "Track weekly values and compare against low limit.",
                risk_mitigation:    "Escalate if value remains below limit after one week.",
            });
        }
    }
    return recs;
};

// ── Generate strategic overview (single call covering all KPIs) ───────────────
const generateStrategicOverview = async (kpis, responsible, week) => {
    const openai = new OpenAI({ apiKey: process.env.SECRET_KEY });

    const critical = kpis.filter(k => k.status === "Below Limit");
    const watch    = kpis.filter(k => k.status === "Near Limit");

    const prompt = `You are a plant performance director reviewing weekly KPI results.

Plant: ${responsible.plant_name}
Department: ${responsible.department_name}
Responsible: ${responsible.name}
Week: ${week}

KPI Summary:
- Total KPIs: ${kpis.length}
- Critical (below limit): ${critical.length} — ${critical.map(k => k.subject).join(", ") || "none"}
- Watch (near limit):     ${watch.length}    — ${watch.map(k => k.subject).join(", ")    || "none"}
- On track:               ${kpis.length - critical.length - watch.length}

Write a concise executive strategic overview (3-4 sentences) and provide 5-7 prioritised next steps.
Return ONLY valid JSON:
{
  "overview":    "...",
  "next_steps":  ["step 1", "step 2", "step 3", "step 4", "step 5"]
}`;

    try {
        const completion = await openai.chat.completions.create({
            model:       "gpt-4o-mini",
            messages:    [{ role: "user", content: prompt }],
            temperature: 0.6,
            max_tokens:  500,
        });
        const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
        return JSON.parse(raw);
    } catch (err) {
        console.error("Strategic overview generation failed:", err.message);
        return {
            overview:   "Performance review complete. Please address critical KPIs immediately and monitor those near their limits.",
            next_steps: [
                "Review all KPIs currently below their low limit and assign immediate owners.",
                "Schedule a daily stand-up for critical KPI owners this week.",
                "Document root causes for each below-limit KPI within 48 hours.",
                "Submit corrective action plans for manager approval by end of week.",
                "Re-evaluate all KPIs at the next weekly review.",
            ],
        };
    }
};

// ── Render PDF via kpi-pdf-builder ────────────────────────────────────────────
const renderPDF = (payload) => {
    try {
        const pdfBuffer = generateKPIPdf(payload);
        return Promise.resolve(pdfBuffer);
    } catch (err) {
        return Promise.reject(err);
    }
};

// ── Build the shared PDF payload object ──────────────────────────────────────
const buildPDFPayload = (responsible, kpis, recommendations, strategic, week) => ({
    responsible: {
        name:            responsible.name,
        email:           responsible.email,
        plant_name:      responsible.plant_name,
        department_name: responsible.department_name,
    },
    week,
    kpis: kpis.map(k => ({
        kpi_id:             k.kpi_id,
        subject:            k.subject,
        indicator_sub_title: k.indicator_sub_title,
        unit:               k.unit,
        value:              k.value,
        low_limit:          k.low_limit,
        high_limit:         k.high_limit,
        target:             k.target,
        status:             k.status,
    })),
    recommendations,
    strategic_overview: strategic.overview,
    next_steps:         strategic.next_steps,
});

// ── Send the PDF email ────────────────────────────────────────────────────────
const sendRecommendationEmail = async (
    createTransporter, responsible, week, pdfBuffer, recipients
) => {
    const transporter = createTransporter();
    const weekLabel   = week.replace("2026-Week", "Week ");
    const filename    = `KPI_Recommendations_${responsible.name.replace(/ /g, "_")}_${weekLabel.replace(/ /g, "_")}.pdf`;

    // What the attached PDF contains, one line each (orange dot = list bullet).
    const reportContents = [
        "KPI performance summary with status indicators",
        "Root cause analysis for underperforming KPIs",
        "Immediate action plans for this week",
        "Medium-term improvement roadmaps",
        "Evidence metrics &amp; measurement checkpoints",
        "Risk mitigation strategies",
        "Strategic overview &amp; prioritised next steps",
    ];

    // Outlook-first layout (tables, inline styles, bgcolor), AVOCarbon charter:
    // brand header (logo attached inline, cid:), flat colors, brand footer.
    const htmlBody = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>KPI Recommendations Report</title>
  <!--[if mso]><style>table,td,div,p,a{font-family:Arial,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${BRAND.page};">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${BRAND.page}" style="background:${BRAND.page};">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${BRAND.white}"
               style="max-width:600px;background:${BRAND.white};border:1px solid ${BRAND.line};border-radius:12px;">
          <tr>
            <td style="padding:0;">${renderEmailHeader({ radius: 12 })}</td>
          </tr>
          <tr>
            <td style="padding:30px 36px 0;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td bgcolor="${BRAND.blueTint}"
                      style="padding:5px 12px;border-radius:999px;background:${BRAND.blueTint};font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.8px;color:${BRAND.blueDark};text-transform:uppercase;">
                    ${weekLabel}
                  </td>
                </tr>
              </table>
              <h1 style="margin:14px 0 0;font-family:${FONT};font-size:26px;line-height:32px;font-weight:800;color:${BRAND.ink};">
                KPI Recommendations Report
              </h1>
              <p style="margin:6px 0 0;font-family:${FONT};font-size:14px;line-height:21px;color:${BRAND.muted};">
                ${responsible.plant_name}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 36px 0;font-family:${FONT};">
              <p style="margin:0;font-size:15px;line-height:24px;color:${BRAND.ink};">Dear ${responsible.name},</p>
              <p style="margin:12px 0 0;font-size:14px;line-height:23px;color:${BRAND.text};">
                Please find attached your AI-generated KPI Recommendations Report for
                <strong>${weekLabel}</strong>. This report provides a detailed analysis of your KPI
                performance and tailored action plans to help you reach your targets.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 36px 0;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${BRAND.panel}"
                     style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-left:4px solid ${BRAND.blue};border-radius:10px;">
                <tr>
                  <td style="padding:16px 20px 6px;font-family:${FONT};font-size:12px;line-height:18px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${BRAND.ink};">
                    Report includes
                  </td>
                </tr>
                ${reportContents.map((item, index) => `
                <tr>
                  <td style="padding:0 20px ${index === reportContents.length - 1 ? "16px" : "6px"};">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="18" valign="top" style="padding-top:1px;font-family:${FONT};font-size:10px;line-height:20px;color:${BRAND.orange};">&#9679;</td>
                        <td valign="top" style="font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.text};">${item}</td>
                      </tr>
                    </table>
                  </td>
                </tr>`).join("")}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 36px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.muted};">
              This report was automatically generated by the AVOCarbon KPI System.
            </td>
          </tr>
          <tr>
            <td style="padding:6px 4px 0;">${renderEmailFooter({ note: `AVOCarbon KPI System &middot; ${new Date().toLocaleDateString("en-GB")}` })}</td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

    await transporter.sendMail({
        from:        '"AVOCarbon KPI System" <administration.STS@avocarbon.com>',
        to:          recipients.join(", "),
        subject:     `📊 KPI Recommendations — ${weekLabel} | ${responsible.name}`,
        html:        htmlBody,
        // PDF report + the logo shown by the brand header (cid:avocarbon-logo).
        attachments: withLogoAttachment([{
            filename,
            content:     pdfBuffer,
            contentType: "application/pdf",
        }]),
    });

    console.log(`✅ Recommendations PDF sent to: ${recipients.join(", ")}`);
};

// ── Main orchestrator — generates PDF AND sends its own email ─────────────────
const generateAndSendKPIRecommendations = async (
    pool, createTransporter, responsibleId, week
) => {
    console.log(`🔄 Generating recommendations for responsible=${responsibleId} week=${week}`);

    // 1. Fetch KPI data
    const { responsible, kpis } = await fetchKPIData(pool, responsibleId, week);
    if (!kpis.length) throw new Error("No KPIs found for this responsible/week");

    // 2. Generate AI content
    console.log(`🤖 Generating AI recommendations for ${kpis.length} KPIs…`);
    const [recommendations, strategic] = await Promise.all([
        generateAIRecommendations(kpis, responsible),
        generateStrategicOverview(kpis, responsible, week),
    ]);

    // 3. Build PDF payload & render
    const payload   = buildPDFPayload(responsible, kpis, recommendations, strategic, week);
    console.log("📄 Rendering PDF…");
    const pdfBuffer = await renderPDF(payload);
    console.log(`📄 PDF ready — ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    // 4. Determine recipients
    const recipients = [responsible.email].filter(Boolean);
    if (responsible.manager_email && responsible.manager_email !== responsible.email) {
        recipients.push(responsible.manager_email);
    }
    if (!recipients.length) throw new Error("No email addresses found");

    // 5. Send email
    await sendRecommendationEmail(createTransporter, responsible, week, pdfBuffer, recipients);

    return {
        success:       true,
        recipients,
        kpiCount:      kpis.length,
        criticalCount: kpis.filter(k => k.status === "Below Limit").length,
        pdfSize:       pdfBuffer.length,
    };
};

// ── PDF-only helper — used to ATTACH the PDF to the weekly KPI report email ──
// Returns a Buffer (or null on error).  Never sends an email itself.
const generateKPIRecommendationsPDFBuffer = async (pool, responsibleId, week) => {
    console.log(`📄 [PDF only] Generating recommendations PDF for responsible=${responsibleId} week=${week}`);

    const { responsible, kpis } = await fetchKPIData(pool, responsibleId, week);
    if (!kpis.length) {
        console.warn(`⚠️  No KPIs found for responsible=${responsibleId} week=${week} — skipping PDF`);
        return null;
    }

    const [recommendations, strategic] = await Promise.all([
        generateAIRecommendations(kpis, responsible),
        generateStrategicOverview(kpis, responsible, week),
    ]);

    const payload = buildPDFPayload(responsible, kpis, recommendations, strategic, week);
    const pdfBuffer = await renderPDF(payload);
    console.log(`📄 [PDF only] Done — ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
    return pdfBuffer;
};



// ── Plant-wide PDF — aggregates ALL responsibles under a plant into one PDF ──
const generatePlantKPIRecommendationsPDFBuffer = async (pool, plantId, week) => {
    console.log(`📄 [Plant PDF] Generating plant-wide recommendations for plant=${plantId} week=${week}`);

    // Get all responsibles for this plant
    const responsiblesRes = await pool.query(
        `SELECT DISTINCT
                p.people_id AS responsible_id,
                NULLIF(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, ''))), '') AS name,
                p.email,
                u.unit_name AS plant_name,
                ''::text AS department_name,
                NULLIF(TRIM(CONCAT_WS(' ', COALESCE(m.first_name, ''), COALESCE(m.name, ''))), '') AS manager,
                m.email AS manager_email
         FROM public.kpi_target_allocation kta
         JOIN public.people p
           ON p.people_id = kta.set_by_people_id
         JOIN public.unit u
           ON u.unit_id = COALESCE(kta.plant_id, p.work_at_unit_id)
         LEFT JOIN public.people m
           ON u.manager_id = m.people_id
         WHERE COALESCE(kta.plant_id, p.work_at_unit_id) = $1
         ORDER BY name ASC, p.people_id ASC`,
        [plantId]
    );

    if (!responsiblesRes.rows.length) {
        console.warn(`⚠️  No responsibles found for plant=${plantId}`);
        return null;
    }

    const plantInfo = responsiblesRes.rows[0]; // plant_name, manager etc.

    // Collect KPIs from every responsible
    const allKPIs        = [];
    const allRecs        = [];

    for (const resp of responsiblesRes.rows) {
        try {
            const { kpis } = await fetchKPIData(pool, resp.responsible_id, week);
            if (!kpis.length) continue;

            // Tag each KPI with its responsible name for context
            const taggedKPIs = kpis.map(k => ({ ...k, _responsible: resp.name }));
            allKPIs.push(...taggedKPIs);

            // Build a lightweight responsible object for the prompt
            const respObj = {
                name:            resp.name,
                plant_name:      plantInfo.plant_name,
                department_name: resp.department_name,
            };

            const recs = await generateAIRecommendations(taggedKPIs, respObj);
            // Prefix each rec's kpi_name with the responsible so the PDF is clear
            recs.forEach(r => {
                r.responsible_name = resp.name;
            });
            allRecs.push(...recs);
        } catch (err) {
            console.error(`  ⚠️  Skipping ${resp.name}:`, err.message);
        }
    }

    if (!allKPIs.length) {
        console.warn(`⚠️  No KPI data found for plant=${plantId} week=${week}`);
        return null;
    }

    // Strategic overview covering the whole plant
    const plantResponsible = {
        name:            plantInfo.manager || plantInfo.plant_name,
        plant_name:      plantInfo.plant_name,
        department_name: 'All Departments',
    };
    const strategic = await generateStrategicOverview(allKPIs, plantResponsible, week);

    // Build the PDF payload — reuse the same buildPDFPayload shape
    const payload = {
        responsible: {
            name:            `${plantInfo.plant_name} — Full Plant Report`,
            email:           plantInfo.manager_email || '',
            plant_name:      plantInfo.plant_name,
            department_name: 'All Departments',
        },
        week,
        kpis: allKPIs.map(k => ({
            kpi_id:              k.kpi_id,
            subject:             k.subject,
            indicator_sub_title: k._responsible
                                    ? `${k.indicator_sub_title || ''} [${k._responsible}]`.trim()
                                    : k.indicator_sub_title,
            unit:                k.unit,
            value:               k.value,
            low_limit:           k.low_limit,
            high_limit:          k.high_limit,
            target:              k.target,
            status:              k.status,
        })),
        recommendations:    allRecs,
        strategic_overview: strategic.overview,
        next_steps:         strategic.next_steps,
    };

    const pdfBuffer = await renderPDF(payload);
    console.log(`📄 [Plant PDF] Done — ${(pdfBuffer.length / 1024).toFixed(1)} KB  (${allKPIs.length} KPIs, ${allRecs.length} recommendations)`);
    return pdfBuffer;
};


// ── Manager report: iterate every responsible under a plant ──────────────────
const generateAndSendManagerReport = async (pool, createTransporter, plantId, week) => {
    console.log(`🔄 Generating manager report for plant=${plantId} week=${week}`);

    const responsiblesRes = await pool.query(
        `
        SELECT DISTINCT
            p.people_id AS responsible_id,
            NULLIF(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, ''))), '') AS name,
            p.email
        FROM public.kpi_target_allocation kta
        LEFT JOIN public.people p
            ON p.people_id = kta.set_by_people_id
        WHERE COALESCE(kta.plant_id, p.work_at_unit_id) = $1
          AND p.people_id IS NOT NULL
        ORDER BY name ASC NULLS LAST, p.people_id ASC
        `,
        [plantId]
    );

    if (responsiblesRes.rows.length === 0) {
        throw new Error("No KPI owners found for this plant");
    }

    const results = [];
    for (const resp of responsiblesRes.rows) {
        try {
            const result = await generateAndSendKPIRecommendations(
                pool, createTransporter, resp.responsible_id, week
            );
            results.push({ responsible: resp.name, success: true, ...result });
        } catch (err) {
            console.error(`Failed for ${resp.name}:`, err.message);
            results.push({ responsible: resp.name, success: false, error: err.message });
        }
    }

    // Optional summary log to plant manager
    const plantRes = await pool.query(
        `
        SELECT
            NULLIF(TRIM(CONCAT_WS(' ', COALESCE(m.first_name, ''), COALESCE(m.name, ''))), '') AS manager,
            m.email AS manager_email
        FROM public.unit u
        LEFT JOIN public.people m
            ON u.manager_id = m.people_id
        WHERE u.unit_id = $1
        `,
        [plantId]
    );
    const plant = plantRes.rows[0];
    if (plant && plant.manager_email) {
        console.log(`📧 Manager summary would be sent to: ${plant.manager_email}`);
    }

    return {
        success:          true,
        plantId,
        week,
        totalResponsibles: results.length,
        successful:        results.filter(r => r.success).length,
        failed:            results.filter(r => !r.success).length,
        details:           results,
    };
};

// ── Result pages of /generate-kpi-recommendations (AVOCarbon charter) ─────────
// Brand header on top, one centered card; `tone` picks the status of the icon.
const RESULT_PAGE_TONES = {
    success: { icon: "&#10003;", color: STATUS.goodText,     background: STATUS.goodTint },
    error:   { icon: "!",        color: STATUS.criticalText, background: STATUS.criticalTint },
};

const renderRecommendationResultPage = ({ title, tone, heading, bodyHtml }) => {
    const { icon, color, background } = RESULT_PAGE_TONES[tone] || RESULT_PAGE_TONES.success;
    return `
        <!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${title}</title>
        <style>
          ${BRAND_PAGE_CSS}
          body { margin:0; font-family:${FONT}; background:var(--avo-page); color:var(--avo-text); }
          .rec-main { display:flex; justify-content:center; align-items:center;
                      min-height:calc(100vh - 70px); padding:20px; box-sizing:border-box; }
          .rec-card { background:#fff; border:1px solid var(--avo-line); border-radius:12px;
                      padding:44px 40px; text-align:center; max-width:560px; width:100%; box-sizing:border-box; }
          .rec-icon { width:56px; height:56px; margin:0 auto 18px; border-radius:50%;
                      display:flex; align-items:center; justify-content:center;
                      font:700 26px/1 ${FONT}; color:${color}; background:${background}; }
          .rec-card h1 { margin:0 0 16px; font-size:24px; color:var(--avo-ink); }
          .rec-details { background:var(--avo-panel); border:1px solid var(--avo-line); border-radius:10px;
                         padding:16px 20px; text-align:left; margin-bottom:28px; }
          .rec-details p { margin:6px 0; font-size:14px; color:var(--avo-text); }
          .rec-details strong { color:var(--avo-ink); }
          .rec-message { color:var(--avo-text); margin:16px 0 28px; }
          .rec-actions { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
          .rec-btn { padding:12px 24px; border-radius:8px; font-weight:600; text-decoration:none;
                     background:var(--avo-blue); color:#fff; border:1px solid var(--avo-blue); }
          .rec-btn:hover { background:var(--avo-blue-dark); border-color:var(--avo-blue-dark); }
          .rec-btn-secondary { background:#fff; color:var(--avo-blue-dark); border-color:var(--avo-rule); }
          .rec-btn-secondary:hover { background:var(--avo-blue-tint); border-color:var(--avo-blue); }
        </style></head>
        <body>
          ${renderPageHeader()}
          <main class="rec-main">
            <div class="rec-card">
              <div class="rec-icon">${icon}</div>
              <h1>${heading}</h1>
              ${bodyHtml}
            </div>
          </main>
        </body></html>`;
};

// ── Express routes ─────────────────────────────────────────────────────────────
const registerRecommendationRoutes = (app, pool, createTransporter) => {

    // GET /generate-kpi-recommendations?responsible_id=&week=
    // Full flow: generate AI + render PDF + send email → returns success page
    app.get("/generate-kpi-recommendations", async (req, res) => {
        const { responsible_id, week } = req.query;
        if (!responsible_id || !week) {
            return res.status(400).send(`<p style='color:${STATUS.criticalText};'>Missing responsible_id or week.</p>`);
        }

        try {
            const result = await generateAndSendKPIRecommendations(
                pool, createTransporter, responsible_id, week
            );

            res.send(renderRecommendationResultPage({
                title:   "Recommendations Sent",
                tone:    "success",
                heading: "Recommendations Sent!",
                bodyHtml: `
              <div class="rec-details">
                <p><strong>KPIs analysed:</strong> ${result.kpiCount}</p>
                <p><strong>Critical KPIs:</strong> ${result.criticalCount}</p>
                <p><strong>Sent to:</strong> ${result.recipients.join(", ")}</p>
                <p><strong>PDF size:</strong> ${(result.pdfSize / 1024).toFixed(1)} KB</p>
              </div>
              <div class="rec-actions">
                <a class="rec-btn" href="/dashboard?responsible_id=${responsible_id}">Dashboard</a>
                <a class="rec-btn rec-btn-secondary" href="/kpi-trends?responsible_id=${responsible_id}">KPI Trends</a>
              </div>`,
            }));

        } catch (err) {
            console.error("❌ Recommendation generation failed:", err.message);
            res.status(500).send(renderRecommendationResultPage({
                title:   "Generation Failed",
                tone:    "error",
                heading: "Generation Failed",
                bodyHtml: `
              <p class="rec-message">${err.message}</p>
              <div class="rec-actions">
                <a class="rec-btn" href="/dashboard?responsible_id=${responsible_id}">Back to Dashboard</a>
              </div>`,
            }));
        }
    });

    // POST /send-kpi-recommendations   body: { responsible_id, week }
    // Programmatic JSON API endpoint
    app.post("/send-kpi-recommendations", async (req, res) => {
        const { responsible_id, week } = req.body;
        if (!responsible_id || !week) {
            return res.status(400).json({ error: "Missing responsible_id or week" });
        }
        try {
            const result = await generateAndSendKPIRecommendations(
                pool, createTransporter, responsible_id, week
            );
            res.json(result);
        } catch (err) {
            console.error("❌ Recommendations API error:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /recommendations-preview?responsible_id=&week=
    // In-browser PDF preview — no email sent (useful for testing)
    app.get("/recommendations-preview", async (req, res) => {
        const { responsible_id, week } = req.query;
        if (!responsible_id || !week) {
            return res.status(400).send("<p>Missing params.</p>");
        }
        try {
            const pdfBuffer = await generateKPIRecommendationsPDFBuffer(pool, responsible_id, week);
            if (!pdfBuffer) return res.status(404).send("<p>No KPIs found.</p>");

            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", 'inline; filename="preview.pdf"');
            res.setHeader("Content-Length", pdfBuffer.length);
            res.end(pdfBuffer);
        } catch (err) {
            res.status(500).send(`<p style="color:${STATUS.criticalText};">${err.message}</p>`);
        }
    });

    console.log(
        "✅ Recommendation routes registered: " +
        "/generate-kpi-recommendations, /send-kpi-recommendations, /recommendations-preview"
    );
};

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
    registerRecommendationRoutes,
    generateAndSendKPIRecommendations,
    generateAndSendManagerReport,
    generateKPIRecommendationsPDFBuffer,   // ← attach PDF to weekly KPI report email
     generatePlantKPIRecommendationsPDFBuffer
};
