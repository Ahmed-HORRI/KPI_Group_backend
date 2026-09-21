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

    const htmlBody = `
  <!DOCTYPE html><html><head><meta charset="utf-8"></head>
  <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f4f6f9;padding:20px;margin:0;">
    <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:10px;
                box-shadow:0 4px 15px rgba(0,0,0,0.1);overflow:hidden;">
      <div style="background:#0078D7;padding:28px;text-align:center;">
        <h1 style="margin:0;color:#fff;font-size:22px;">📊 KPI Recommendations Report</h1>
        <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">
          ${weekLabel} &nbsp;•&nbsp; ${responsible.plant_name}
        </p>
      </div>
      <div style="padding:28px;">
        <p style="font-size:15px;color:#333;">Dear ${responsible.name},</p>
        <p style="font-size:14px;color:#555;line-height:1.6;">
          Please find attached your AI-generated KPI Recommendations Report for
          <strong>${weekLabel}</strong>. This report provides a detailed analysis of your KPI
          performance and tailored action plans to help you reach your targets.
        </p>
        <div style="background:#f8f9fa;border-left:4px solid #0078D7;padding:16px;
                    border-radius:0 8px 8px 0;margin:20px 0;">
          <p style="margin:0;font-size:13px;color:#555;">
            <strong>Report includes:</strong><br>
            ✅ KPI performance summary with status indicators<br>
            🔍 Root cause analysis for underperforming KPIs<br>
            ⚡ Immediate action plans for this week<br>
            📅 Medium-term improvement roadmaps<br>
            📊 Evidence metrics &amp; measurement checkpoints<br>
            🛡️ Risk mitigation strategies<br>
            🎯 Strategic overview &amp; prioritised next steps
          </p>
        </div>
        <p style="font-size:13px;color:#888;margin-top:24px;">
          This report was automatically generated by the AVOCarbon KPI System.
        </p>
      </div>
      <div style="background:#f8f9fa;padding:16px;text-align:center;
                  font-size:12px;color:#888;border-top:1px solid #eee;">
        AVOCarbon KPI System • ${new Date().toLocaleDateString("en-GB")}
      </div>
    </div>
  </body></html>`;

    await transporter.sendMail({
        from:        '"AVOCarbon KPI System" <administration.STS@avocarbon.com>',
        to:          recipients.join(", "),
        subject:     `📊 KPI Recommendations — ${weekLabel} | ${responsible.name}`,
        html:        htmlBody,
        attachments: [{
            filename,
            content:     pdfBuffer,
            contentType: "application/pdf",
        }],
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

// ── Express routes ─────────────────────────────────────────────────────────────
const registerRecommendationRoutes = (app, pool, createTransporter) => {

    // GET /generate-kpi-recommendations?responsible_id=&week=
    // Full flow: generate AI + render PDF + send email → returns success page
    app.get("/generate-kpi-recommendations", async (req, res) => {
        const { responsible_id, week } = req.query;
        if (!responsible_id || !week) {
            return res.status(400).send("<p style='color:red;'>Missing responsible_id or week.</p>");
        }

        try {
            const result = await generateAndSendKPIRecommendations(
                pool, createTransporter, responsible_id, week
            );

            res.send(`
        <!DOCTYPE html><html><head><meta charset="utf-8">
        <title>Recommendations Sent</title></head>
        <body style="font-family:'Segoe UI',sans-serif;background:#f4f6f9;
                     display:flex;justify-content:center;align-items:center;
                     min-height:100vh;margin:0;padding:20px;">
          <div style="background:#fff;border-radius:12px;padding:50px 40px;
                      text-align:center;max-width:560px;
                      box-shadow:0 8px 24px rgba(0,0,0,0.1);">
            <div style="font-size:64px;margin-bottom:20px;">✅</div>
            <h1 style="color:#28a745;font-size:26px;margin-bottom:16px;">
              Recommendations Sent!
            </h1>
            <div style="background:#f8f9fa;border-radius:8px;padding:20px;
                        text-align:left;margin-bottom:28px;">
              <p style="margin:6px 0;font-size:14px;color:#555;">
                <strong>📊 KPIs analysed:</strong> ${result.kpiCount}
              </p>
              <p style="margin:6px 0;font-size:14px;color:#555;">
                <strong>🔴 Critical KPIs:</strong> ${result.criticalCount}
              </p>
              <p style="margin:6px 0;font-size:14px;color:#555;">
                <strong>📧 Sent to:</strong> ${result.recipients.join(", ")}
              </p>
              <p style="margin:6px 0;font-size:14px;color:#555;">
                <strong>📄 PDF size:</strong> ${(result.pdfSize / 1024).toFixed(1)} KB
              </p>
            </div>
            <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
              <a href="/dashboard?responsible_id=${responsible_id}"
                 style="padding:12px 24px;background:#0078D7;color:#fff;
                        text-decoration:none;border-radius:8px;font-weight:600;">
                📊 Dashboard
              </a>
              <a href="/kpi-trends?responsible_id=${responsible_id}"
                 style="padding:12px 24px;background:#6c757d;color:#fff;
                        text-decoration:none;border-radius:8px;font-weight:600;">
                📈 KPI Trends
              </a>
            </div>
          </div>
        </body></html>`);

        } catch (err) {
            console.error("❌ Recommendation generation failed:", err.message);
            res.status(500).send(`
        <!DOCTYPE html><html><head><meta charset="utf-8"></head>
        <body style="font-family:'Segoe UI',sans-serif;background:#fff5f5;
                     display:flex;justify-content:center;align-items:center;
                     min-height:100vh;margin:0;padding:20px;">
          <div style="background:#fff;border-radius:12px;padding:50px 40px;
                      text-align:center;max-width:500px;
                      box-shadow:0 4px 15px rgba(0,0,0,0.1);">
            <div style="font-size:64px;margin-bottom:20px;">❌</div>
            <h1 style="color:#dc3545;font-size:24px;">Generation Failed</h1>
            <p style="color:#555;margin:16px 0;">${err.message}</p>
            <a href="/dashboard?responsible_id=${responsible_id}"
               style="padding:12px 24px;background:#0078D7;color:#fff;
                      text-decoration:none;border-radius:8px;font-weight:600;">
              Back to Dashboard
            </a>
          </div>
        </body></html>`);
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
            res.status(500).send(`<p style="color:red;">${err.message}</p>`);
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
