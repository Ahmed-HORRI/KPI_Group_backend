// AVOCarbon Group graphic charter, as used by every e-mail, PDF, chart and
// server-rendered page of the backend. The four brand colors are read off the
// logo itself (src/assets/email/avocarbon-logo.png):
//   "AVO" blue #076EAF, "Carbon" gray #585858, rule gray #C5C5C4, "GROUP" orange #EF7904.
// The frontend uses the same values (KPI-Group-frontend/src/index.css).
//
// Pure module (no database, no mailer): safe to require from anywhere.

const fs = require("fs");
const path = require("path");

const BRAND = {
  // AVO blue: primary color (header bar, buttons, links, titles accents).
  blue: "#076EAF",
  blueDark: "#025E98", // hover / pressed, text on blue tints
  blueDeep: "#11293E", // darkest step, for dark bands
  blueTint: "#EFF6FD", // light background of blue badges and panels
  blueSoft: "#DAE9F8", // border of blue panels
  // GROUP orange: accent only. It is too light for text on white (2.8:1):
  // write orange text with orangeText, keep orange itself for bars and dots.
  orange: "#EF7904",
  orangeText: "#AE5600",
  orangeTint: "#FFF7F2",
  orangeSoft: "#FFD3B9",
  // Carbon gray and its neutral scale (no blue cast).
  gray: "#585858",
  rule: "#C5C5C4",
  ink: "#171717", // headings
  text: "#404040", // body text
  muted: "#737373", // secondary text (4.7:1 on white)
  faint: "#A1A1A1", // fine print
  line: "#E5E5E5", // borders
  panel: "#FAFAFA", // light panels
  page: "#F5F5F5", // e-mail / page background
  white: "#FFFFFF"
};

// Status colors keep their meaning across the group (good / warning / critical);
// they are not brand colors and never serve as a series color.
const STATUS = {
  good: "#0CA30C",
  goodText: "#15803D",
  goodTint: "#F0FDF4",
  goodSoft: "#BBF7D0",
  warning: "#FAB219",
  warningText: "#A16207",
  warningTint: "#FFFBEB",
  warningSoft: "#FDE68A",
  critical: "#D03B3B",
  criticalText: "#B91C1C",
  criticalTint: "#FEF2F2",
  criticalSoft: "#FECACA"
};

// Series colors of charts, in this fixed order (validated for color-blind
// separation): AVO blue and GROUP orange first.
const CHART_SERIES = ["#076EAF", "#EF7904", "#1BAF7A", "#EDA100", "#E87BA4", "#008300", "#6250D6", "#E34948"];

const FONT = "'Segoe UI',Arial,Helvetica,sans-serif";

const PRODUCT_NAME = "KPI Manager";

// The logo travels as an inline attachment (cid:) so Outlook shows it without
// "download pictures". Add logoAttachment() to the attachments of any e-mail
// whose HTML contains renderEmailHeader().
const LOGO_CID = "avocarbon-logo";
const LOGO_PATH = path.join(__dirname, "..", "assets", "email", "avocarbon-logo.png");

const logoAttachment = () => ({ filename: "avocarbon-logo.png", path: LOGO_PATH, cid: LOGO_CID });

const withLogoAttachment = (attachments = []) => [
  ...(Array.isArray(attachments) ? attachments.filter(Boolean) : []),
  logoAttachment()
];

// Top of every e-mail card: the logo on white, the product (or a short label)
// on the right, then the brand bar, AVO blue ending in a GROUP orange segment.
// Pass `width` (px) for fixed-width layouts; it fills its container otherwise.
// `radius` rounds the top corners to match a rounded card.
const renderEmailHeader = ({ label = PRODUCT_NAME, logoUrl = `cid:${LOGO_CID}`, radius = 0 } = {}) => `
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${BRAND.white}"
         style="width:100%;background:${BRAND.white};border-collapse:separate;${radius ? `border-radius:${radius}px ${radius}px 0 0;` : ""}">
    <tr>
      <td valign="middle" style="padding:22px 32px 18px;">
        <img src="${logoUrl}" width="164" height="30" alt="AVOCarbon Group"
             style="display:block;width:164px;height:30px;border:0;outline:none;text-decoration:none;">
      </td>
      <td valign="middle" align="right"
          style="padding:22px 32px 18px;font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.6px;color:${BRAND.gray};text-transform:uppercase;">
        ${label}
      </td>
    </tr>
  </table>
  ${renderBrandBar()}
`;

// The 4px bar under the header (also usable alone, e.g. at the top of a page).
const renderBrandBar = () => `
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;">
    <tr>
      <td width="84%" height="4" bgcolor="${BRAND.blue}" style="height:4px;line-height:4px;font-size:0;background:${BRAND.blue};">&nbsp;</td>
      <td width="16%" height="4" bgcolor="${BRAND.orange}" style="height:4px;line-height:4px;font-size:0;background:${BRAND.orange};">&nbsp;</td>
    </tr>
  </table>
`;

// Bottom of every e-mail card: a hairline, an optional reason line, then the
// group signature.
const renderEmailFooter = ({ note = "", signature = `AVOCarbon Group &middot; ${PRODUCT_NAME} &middot; This is an automated message, please do not reply.` } = {}) => `
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;">
    <tr>
      <td style="padding:24px 32px 28px;">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
          <tr><td height="1" bgcolor="${BRAND.line}" style="height:1px;line-height:1px;font-size:0;background:${BRAND.line};">&nbsp;</td></tr>
        </table>
        ${note ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:19px;color:${BRAND.muted};">${note}</p>` : ""}
        <p style="margin:${note ? "8px" : "16px"} 0 0;font-family:${FONT};font-size:12px;line-height:19px;color:${BRAND.faint};">
          ${signature}
        </p>
      </td>
    </tr>
  </table>
`;

// Bulletproof button: VML for Outlook desktop, a styled link everywhere else.
// `label` and `href` must already be HTML-escaped.
const renderEmailButton = ({ label, href, color = BRAND.blue, width = 260 }) => `
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;">
    <tr>
      <td align="center" bgcolor="${color}" style="border-radius:8px;background:${color};">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
          href="${href}" style="height:46px;v-text-anchor:middle;width:${width}px;" arcsize="18%" stroke="f" fillcolor="${color}">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${label}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-- -->
        <a href="${href}" target="_blank"
           style="display:inline-block;padding:13px 30px;font-family:${FONT};font-size:15px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;background:${color};">
          ${label}
        </a>
        <!--<![endif]-->
      </td>
    </tr>
  </table>
`;

// Same brand, for HTML pages served by the backend (forms, reports, errors):
// CSS variables plus the header markup, to drop into a <style> and a <body>.
const BRAND_PAGE_CSS = `
  :root {
    --avo-blue: ${BRAND.blue};
    --avo-blue-dark: ${BRAND.blueDark};
    --avo-blue-tint: ${BRAND.blueTint};
    --avo-orange: ${BRAND.orange};
    --avo-orange-text: ${BRAND.orangeText};
    --avo-gray: ${BRAND.gray};
    --avo-rule: ${BRAND.rule};
    --avo-ink: ${BRAND.ink};
    --avo-text: ${BRAND.text};
    --avo-muted: ${BRAND.muted};
    --avo-line: ${BRAND.line};
    --avo-panel: ${BRAND.panel};
    --avo-page: ${BRAND.page};
  }
  .avo-brand-header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 28px; background:#fff; }
  .avo-brand-header img { display:block; height:30px; width:auto; }
  .avo-brand-header span { font:700 11px/16px ${FONT}; letter-spacing:1.6px; text-transform:uppercase; color:${BRAND.gray}; }
  .avo-brand-bar { height:4px; background:linear-gradient(90deg, ${BRAND.blue} 0 84%, ${BRAND.orange} 84% 100%); }
`;

// Pages are opened in a browser, which shows a data: URI image (e-mail
// clients do not, hence the cid: attachment above). Read once, on first use.
let logoDataUri = null;
const getLogoDataUri = () => {
  if (!logoDataUri) {
    logoDataUri = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`;
  }
  return logoDataUri;
};

const renderPageHeader = ({ logoUrl = getLogoDataUri(), label = PRODUCT_NAME } = {}) => `
  <header class="avo-brand-header">
    <img src="${logoUrl}" alt="AVOCarbon Group">
    <span>${label}</span>
  </header>
  <div class="avo-brand-bar"></div>
`;

module.exports = {
  BRAND,
  STATUS,
  CHART_SERIES,
  FONT,
  PRODUCT_NAME,
  LOGO_CID,
  LOGO_PATH,
  logoAttachment,
  withLogoAttachment,
  renderEmailHeader,
  renderBrandBar,
  renderEmailFooter,
  renderEmailButton,
  BRAND_PAGE_CSS,
  getLogoDataUri,
  renderPageHeader
};
