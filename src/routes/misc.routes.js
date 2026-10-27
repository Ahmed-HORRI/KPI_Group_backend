const express = require("express");
const router = express.Router();
const { normalizeOptionalTextInput } = require("../utils/normalize");
const { createTransporter } = require("../config/mailer");
const { escapeHtml } = require("../services/kpiShared.service");
const { BRAND, FONT, renderEmailHeader, renderEmailFooter, withLogoAttachment } = require("../config/brand");

// The Help Support e-mail in the charter: the feedback first, then its context.
const renderHelpSupportEmailHtml = ({ feedback, name, role, group, week, page }) => {
  const contextRows = [
    ["Name", name],
    ["Role", role],
    ["Group", group],
    ["Week", week],
    ["Page", page]
  ]
    .map(([label, value], index) => {
      const rule = index ? `border-top:1px solid ${BRAND.line};` : "";
      return `<tr>
                  <td style="padding:10px 15px;width:80px;color:${BRAND.muted};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;${rule}">${label}</td>
                  <td style="padding:10px 15px;color:${BRAND.ink};font-size:14px;word-break:break-word;${rule}">${escapeHtml(value || "—")}</td>
                </tr>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
      <body style="margin:0;padding:0;background:${BRAND.page};font-family:${FONT};color:${BRAND.text};">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${BRAND.page}" style="background:${BRAND.page};"><tr><td align="center" style="padding:28px 12px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="${BRAND.white}" style="width:100%;max-width:600px;background:${BRAND.white};border:1px solid ${BRAND.line};border-radius:12px;">
            <tr><td style="padding:0;">${renderEmailHeader({ label: "Help support", radius: 12 })}</td></tr>
            <tr><td style="padding:28px 30px 8px;font-family:${FONT};">
              <h2 style="margin:0 0 6px;font-size:22px;line-height:1.25;color:${BRAND.ink};">KPI Help Support Feedback</h2>
              <p style="margin:0 0 20px;color:${BRAND.muted};font-size:14px;line-height:1.6;">Sent with the Help Support button of the KPI form.</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${BRAND.blueTint}" style="background:${BRAND.blueTint};border:1px solid ${BRAND.blueSoft};border-left:4px solid ${BRAND.blue};border-radius:8px;">
                <tr><td style="padding:16px 18px;color:${BRAND.ink};font-size:15px;line-height:1.6;">${escapeHtml(feedback).replace(/\n/g, "<br>")}</td></tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${BRAND.panel}" style="margin-top:20px;background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;">
                ${contextRows}
              </table>
            </td></tr>
            <tr><td style="padding:16px 0 0;">${renderEmailFooter({ note: "Feedback sent from the KPI Manager." })}</td></tr>
          </table>
        </td></tr></table>
      </body></html>`;
};

router.post("/api/help-support", async (req, res) => {
  try {
    const feedback = normalizeOptionalTextInput(req.body.feedback);
    const page = normalizeOptionalTextInput(req.body.page);
    const name = normalizeOptionalTextInput(req.body.name);
    const role = normalizeOptionalTextInput(req.body.role);
    const group = normalizeOptionalTextInput(req.body.group);
    const week = normalizeOptionalTextInput(req.body.week);

    if (!feedback) {
      return res.status(400).json({ success: false, message: "Feedback is required." });
    }

    const transporter = createTransporter();

    await transporter.sendMail({
      from: '"KPI Support" <administration.STS@avocarbon.com>',
      to: "ahmed.horri@avocarbon.com",
      cc: "taha.khiari@avocarbon.com",
      subject: `KPI Help Support Feedback${week ? ` - ${week}` : ""}`,
      text: `
Feedback:
${feedback}

Context:
Name: ${name || ""}
Role: ${role || ""}
Group: ${group || ""}
Week: ${week || ""}
Page: ${page || ""}
      `,
      html: renderHelpSupportEmailHtml({ feedback, name, role, group, week, page }),
      attachments: withLogoAttachment()
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Help support email failed:", error);
    res.status(500).json({ success: false, message: "Unable to send feedback." });
  }
});

module.exports = router;
