const express = require("express");
const router = express.Router();
const { normalizeOptionalTextInput } = require("../utils/normalize");
const { createTransporter } = require("../config/mailer");
const { escapeHtml } = require("../services/kpiShared.service");

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
      html: `
        <h3>KPI Help Support Feedback</h3>
        <p><b>Feedback:</b></p>
        <p>${escapeHtml(feedback).replace(/\n/g, "<br>")}</p>
        <hr>
        <p><b>Name:</b> ${escapeHtml(name || "")}</p>
        <p><b>Role:</b> ${escapeHtml(role || "")}</p>
        <p><b>Group:</b> ${escapeHtml(group || "")}</p>
        <p><b>Week:</b> ${escapeHtml(week || "")}</p>
        <p><b>Page:</b> ${escapeHtml(page || "")}</p>
      `
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Help support email failed:", error);
    res.status(500).json({ success: false, message: "Unable to send feedback." });
  }
});

module.exports = router;
