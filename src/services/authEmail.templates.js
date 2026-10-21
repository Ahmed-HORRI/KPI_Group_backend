// HTML e-mails of the authentication module (invitation, password reset).
//
// Built for Outlook first, since that is where they are read: table layout,
// inline styles only, bgcolor attributes, a VML button for Outlook desktop,
// and the logo attached inline (cid:) so it shows without "download pictures".

const path = require("path");

const LOGO_CID = "kpi-manager-logo";
const LOGO_PATH = path.join(__dirname, "..", "assets", "email", "avocarbon-logo.png");

const COLORS = {
  brand: "#0078D7",
  brandDark: "#005a9e",
  ink: "#0f172a",
  text: "#334155",
  muted: "#64748b",
  faint: "#94a3b8",
  line: "#e2e8f0",
  panel: "#f8fafc",
  page: "#eef2f7"
};

const FONT = "'Segoe UI',Arial,Helvetica,sans-serif";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatUtcDateTime = (date) =>
  `${new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC"
  }).format(date)} UTC`;

const formatDuration = (ms) => {
  const minutes = Math.round(ms / 60000);
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
};

const ROLE_LABELS = { admin: "Administrator", user: "User" };

// Bulletproof button: VML for Outlook desktop, a styled link everywhere else.
const renderButton = (label, link, color = COLORS.brand) => `
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;">
    <tr>
      <td align="center" bgcolor="${color}" style="border-radius:12px;background:${color};">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
          href="${escapeHtml(link)}" style="height:50px;v-text-anchor:middle;width:260px;" arcsize="24%" stroke="f" fillcolor="${color}">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${escapeHtml(label)}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-- -->
        <a href="${escapeHtml(link)}" target="_blank"
           style="display:inline-block;padding:15px 34px;font-family:${FONT};font-size:15px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:12px;background:${color};">
          ${escapeHtml(label)}&nbsp;&rarr;
        </a>
        <!--<![endif]-->
      </td>
    </tr>
  </table>
`;

// Label / value rows inside a light panel (account summary).
const renderDetails = (rows) => `
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
         bgcolor="${COLORS.panel}" style="background:${COLORS.panel};border:1px solid ${COLORS.line};border-radius:12px;">
    ${rows
      .map(
        ([label, value], index) => `
    <tr>
      <td style="padding:${index === 0 ? "16px" : "10px"} 20px ${index === rows.length - 1 ? "16px" : "0"};font-family:${FONT};font-size:12px;line-height:18px;color:${COLORS.muted};text-transform:uppercase;letter-spacing:0.6px;font-weight:700;width:120px;" valign="top">
        ${escapeHtml(label)}
      </td>
      <td style="padding:${index === 0 ? "16px" : "10px"} 20px ${index === rows.length - 1 ? "16px" : "0"} 0;font-family:${FONT};font-size:14px;line-height:18px;color:${COLORS.ink};font-weight:600;" valign="top">
        ${value}
      </td>
    </tr>`
      )
      .join("")}
  </table>
`;

const renderNotice = (html, { background, border, color }) => `
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
         bgcolor="${background}" style="background:${background};border:1px solid ${border};border-left:4px solid ${color};border-radius:10px;">
    <tr>
      <td style="padding:12px 16px;font-family:${FONT};font-size:13px;line-height:20px;color:${COLORS.text};">${html}</td>
    </tr>
  </table>
`;

const renderSteps = (title, steps) => `
  <div style="font-family:${FONT};font-size:13px;font-weight:700;color:${COLORS.ink};margin:0 0 12px;text-transform:uppercase;letter-spacing:0.6px;">
    ${escapeHtml(title)}
  </div>
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
    ${steps
      .map(
        (step, index) => `
    <tr>
      <td width="34" valign="top" style="padding:0 0 12px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0">
          <tr>
            <td width="24" height="24" align="center" bgcolor="#e8f2fc"
                style="width:24px;height:24px;border-radius:12px;background:#e8f2fc;font-family:${FONT};font-size:12px;font-weight:700;color:${COLORS.brand};line-height:24px;">
              ${index + 1}
            </td>
          </tr>
        </table>
      </td>
      <td valign="top" style="padding:2px 0 12px;font-family:${FONT};font-size:14px;line-height:21px;color:${COLORS.text};">${step}</td>
    </tr>`
      )
      .join("")}
  </table>
`;

const renderLayout = ({ preheader, badge, title, intro, sections, footerReason }) => `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(title)}</title>
  <!--[if mso]><style>table,td,div,p,a{font-family:Arial,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${COLORS.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.page};">
    ${escapeHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;
  </div>
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${COLORS.page}" style="background:${COLORS.page};">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"
               style="max-width:600px;background:#ffffff;border:1px solid ${COLORS.line};border-radius:18px;" bgcolor="#ffffff">
          <tr>
            <td height="6" bgcolor="${COLORS.brand}" style="height:6px;line-height:6px;font-size:0;background:${COLORS.brand};border-radius:18px 18px 0 0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:26px 36px 0;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td valign="middle">
                    <img src="cid:${LOGO_CID}" width="170" height="31" alt="AVOCarbon Group"
                         style="display:block;width:170px;height:31px;border:0;outline:none;text-decoration:none;">
                  </td>
                  <td valign="middle" align="right"
                      style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.6px;color:${COLORS.faint};text-transform:uppercase;">
                    KPI Manager
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 36px 0;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td bgcolor="${badge.background}"
                      style="padding:5px 12px;border-radius:999px;background:${badge.background};font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.8px;color:${badge.color};text-transform:uppercase;">
                    ${escapeHtml(badge.label)}
                  </td>
                </tr>
              </table>
              <h1 style="margin:14px 0 0;font-family:${FONT};font-size:26px;line-height:32px;font-weight:800;color:${COLORS.ink};">
                ${escapeHtml(title)}
              </h1>
              <p style="margin:12px 0 0;font-family:${FONT};font-size:15px;line-height:24px;color:${COLORS.text};">${intro}</p>
            </td>
          </tr>
          ${sections.map((section) => `<tr><td style="padding:${section.padding || "24px 36px 0"};">${section.html}</td></tr>`).join("")}
          <tr>
            <td style="padding:30px 36px 32px;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr><td height="1" bgcolor="${COLORS.line}" style="height:1px;line-height:1px;font-size:0;background:${COLORS.line};">&nbsp;</td></tr>
              </table>
              <p style="margin:18px 0 0;font-family:${FONT};font-size:12px;line-height:19px;color:${COLORS.muted};">
                ${footerReason}
              </p>
              <p style="margin:8px 0 0;font-family:${FONT};font-size:12px;line-height:19px;color:${COLORS.faint};">
                AVOCarbon Group &middot; KPI Manager &middot; This is an automated message, please do not reply.
              </p>
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;

const logoAttachment = () => ({ filename: "avocarbon-logo.png", path: LOGO_PATH, cid: LOGO_CID });

const fallbackLinkSection = (link) => ({
  html: `
    <p style="margin:0;font-family:${FONT};font-size:12px;line-height:19px;color:${COLORS.muted};">
      Button not working? Copy this address into your browser:
    </p>
    <p style="margin:6px 0 0;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:18px;word-break:break-all;">
      <a href="${escapeHtml(link)}" target="_blank" style="color:${COLORS.brand};text-decoration:underline;">${escapeHtml(link)}</a>
    </p>
  `
});

// Invitation e-mail sent when an administrator creates an account.
const buildInvitationEmail = ({ fullName, email, role, link, expiresAt, ttlMs, inviter, loginUrl }) => {
  const firstName = String(fullName || "").trim().split(/\s+/)[0] || "";
  const roleLabel = ROLE_LABELS[role] || "User";
  const inviterText = inviter?.full_name
    ? `${inviter.full_name}${inviter.email ? ` (${inviter.email})` : ""}`
    : "";
  const expiry = `${formatDuration(ttlMs)}, until ${formatUtcDateTime(expiresAt)}`;

  const subject = "Your KPI Manager account is ready";
  const intro = `${firstName ? `Hello ${escapeHtml(firstName)}, ` : "Hello, "}${
    inviterText ? `<strong>${escapeHtml(inviter.full_name)}</strong> has` : "an administrator has"
  } created your KPI Manager account. Choose your password to activate it and access your Responsible KPI Dashboard.`;

  const html = renderLayout({
    preheader: "Activate your KPI Manager account: choose your password.",
    badge: { label: "Account invitation", background: "#e8f2fc", color: COLORS.brandDark },
    title: "Welcome to KPI Manager",
    intro,
    sections: [
      {
        html: renderDetails([
          ["Account", `<a style="color:${COLORS.ink};text-decoration:none;">${escapeHtml(email)}</a>`],
          ["Role", escapeHtml(roleLabel)],
          ...(inviterText ? [["Invited by", escapeHtml(inviterText)]] : [])
        ])
      },
      { padding: "28px 36px 0", html: renderButton("Set my password", link) },
      {
        padding: "24px 36px 0",
        html: renderNotice(
          `<strong>This link works once</strong> and expires in ${escapeHtml(expiry)}. If it expires, ask your administrator for a new invitation.`,
          { background: "#fffbeb", border: "#fde68a", color: "#f59e0b" }
        )
      },
      {
        padding: "28px 36px 0",
        html: renderSteps("How to get started", [
          "Click <strong>Set my password</strong> above.",
          "Choose a password of at least 10 characters, with an uppercase letter, a lowercase letter and a digit.",
          `Sign in any time at <a href="${escapeHtml(loginUrl)}" target="_blank" style="color:${COLORS.brand};text-decoration:none;font-weight:600;">${escapeHtml(loginUrl)}</a> with <strong>${escapeHtml(email)}</strong>.`
        ])
      },
      { padding: "8px 36px 0", ...fallbackLinkSection(link) }
    ],
    footerReason: `You received this e-mail because an account was created for ${escapeHtml(email)} on KPI Manager. If you were not expecting it, you can ignore it: the account stays inactive until a password is chosen.`
  });

  const text = [
    `${firstName ? `Hello ${firstName},` : "Hello,"}`,
    "",
    `${inviterText || "An administrator"} created your KPI Manager account.`,
    "",
    `Account: ${email}`,
    `Role: ${roleLabel}`,
    "",
    `Set my password: ${link}`,
    "",
    `This link works once and expires in ${expiry}.`,
    `Afterwards, sign in at ${loginUrl}`,
    "",
    "If you were not expecting this invitation, you can ignore this e-mail.",
    "",
    "AVOCarbon Group - KPI Manager (automated message, please do not reply)"
  ].join("\n");

  return { subject, text, html, attachments: [logoAttachment()] };
};

// Password reset e-mail: requested from "Forgot your password?", or sent by an administrator.
const buildPasswordResetEmail = ({ fullName, email, link, expiresAt, ttlMs, requestedAt, sentBy, loginUrl }) => {
  const firstName = String(fullName || "").trim().split(/\s+/)[0] || "";
  const expiry = `${formatDuration(ttlMs)}, until ${formatUtcDateTime(expiresAt)}`;
  const byAdmin = Boolean(sentBy?.full_name);

  const subject = "Reset your KPI Manager password";
  const intro = `${firstName ? `Hello ${escapeHtml(firstName)}, ` : "Hello, "}${
    byAdmin
      ? `<strong>${escapeHtml(sentBy.full_name)}</strong>, administrator of KPI Manager, sent you a link to choose a new password.`
      : "we received a request to reset the password of your KPI Manager account."
  }`;

  const html = renderLayout({
    preheader: "Choose a new password for your KPI Manager account. The link expires soon.",
    badge: { label: "Password reset", background: "#f1f5f9", color: COLORS.text },
    title: "Reset your password",
    intro,
    sections: [
      {
        html: renderDetails([
          ["Account", escapeHtml(email)],
          [byAdmin ? "Sent by" : "Requested", escapeHtml(byAdmin ? sentBy.full_name : formatUtcDateTime(requestedAt))]
        ])
      },
      { padding: "28px 36px 0", html: renderButton("Choose a new password", link) },
      {
        padding: "24px 36px 0",
        html: renderNotice(
          `<strong>This link works once</strong> and expires in ${escapeHtml(expiry)}. Once your password is changed, every device signed in to your account is signed out.`,
          { background: "#fffbeb", border: "#fde68a", color: "#f59e0b" }
        )
      },
      {
        padding: "16px 36px 0",
        html: renderNotice(
          `<strong>Didn't ask for this?</strong> Ignore this e-mail: your password stays unchanged. If you keep receiving it, tell your KPI Manager administrator.`,
          { background: COLORS.panel, border: COLORS.line, color: COLORS.faint }
        )
      },
      { padding: "24px 36px 0", ...fallbackLinkSection(link) }
    ],
    footerReason: `You received this e-mail because a password reset was requested for ${escapeHtml(email)} on KPI Manager. After the reset, sign in at <a href="${escapeHtml(loginUrl)}" target="_blank" style="color:${COLORS.muted};">${escapeHtml(loginUrl)}</a>.`
  });

  const text = [
    `${firstName ? `Hello ${firstName},` : "Hello,"}`,
    "",
    byAdmin
      ? `${sentBy.full_name}, administrator of KPI Manager, sent you a link to choose a new password.`
      : "We received a request to reset the password of your KPI Manager account.",
    "",
    `Account: ${email}`,
    "",
    `Choose a new password: ${link}`,
    "",
    `This link works once and expires in ${expiry}.`,
    "Didn't ask for this? Ignore this e-mail: your password stays unchanged.",
    "",
    "AVOCarbon Group - KPI Manager (automated message, please do not reply)"
  ].join("\n");

  return { subject, text, html, attachments: [logoAttachment()] };
};

module.exports = {
  LOGO_CID,
  LOGO_PATH,
  buildInvitationEmail,
  buildPasswordResetEmail
};
