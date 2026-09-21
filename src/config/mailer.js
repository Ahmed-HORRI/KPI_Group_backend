const nodemailer = require("nodemailer");
const { normalizeOptionalTextInput } = require("../utils/normalize");

const parseBooleanEnv = (value, fallback = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const createTransporter = () => {
  const host = normalizeOptionalTextInput(process.env.SMTP_HOST) || "avocarbon-com.mail.protection.outlook.com";
  const parsedPort = Number.parseInt(String(process.env.SMTP_PORT || "25"), 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 25;
  const secure = parseBooleanEnv(process.env.SMTP_SECURE, port === 465);
  const authMode = String(
    process.env.SMTP_AUTH_MODE || "basic"
  ).trim().toLowerCase();
  const smtpUser = normalizeOptionalTextInput(process.env.SMTP_USER) || "administration.STS@avocarbon.com";
  const smtpPass = normalizeOptionalTextInput(process.env.SMTP_PASS);

  const transporterOptions = {
    host,
    port,
    secure,
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    tls: {
      servername: host
    }
  };

  if (parseBooleanEnv(process.env.SMTP_REQUIRE_TLS, false)) {
    transporterOptions.requireTLS = true;
  }

  if (authMode !== "none" && smtpUser && smtpPass) {
    transporterOptions.auth = {
      user: smtpUser,
      pass: smtpPass
    };
  }

  return nodemailer.createTransport(transporterOptions);
};

module.exports = { createTransporter, parseBooleanEnv };
