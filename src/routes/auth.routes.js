const express = require("express");
const { RateLimiterMemory } = require("rate-limiter-flexible");
const { setSessionCookie, clearSessionCookie, getRequestMeta } = require("../middlewares/auth.middleware");

const TOO_MANY_REQUESTS_MESSAGE =
  "Too many failed attempts. Try again in a few minutes or reset your password.";

const sendError = (res, error, logLabel) => {
  if (!error.statusCode) console.error(`${logLabel} error:`, error);
  return res.status(error.statusCode || 500).json({
    error: error.statusCode ? error.message : "Unexpected error. Please try again."
  });
};

// Resolves to true when the request may proceed; otherwise answers 429 itself.
const consumeOrReject = async (limiter, key, res) => {
  try {
    await limiter.consume(key);
    return true;
  } catch (rateLimiterRes) {
    if (rateLimiterRes instanceof Error) throw rateLimiterRes;
    res.set("Retry-After", String(Math.ceil((rateLimiterRes.msBeforeNext || 60000) / 1000)));
    res.status(429).json({ error: TOO_MANY_REQUESTS_MESSAGE });
    return false;
  }
};

const createAuthRouter = ({ authService, config }) => {
  const router = express.Router();

  // Per e-mail + IP, so one person cannot lock out a colleague's account from
  // elsewhere, and per IP, against password spraying across many accounts.
  const loginByAccountLimiter = new RateLimiterMemory({ points: config.maxFailedLogins, duration: 15 * 60 });
  const loginByIpLimiter = new RateLimiterMemory({ points: config.loginRateLimitPerIp, duration: 15 * 60 });
  const forgotPasswordLimiter = new RateLimiterMemory({ points: config.forgotPasswordRateLimitPerIp, duration: 15 * 60 });
  const tokenLimiter = new RateLimiterMemory({ points: config.tokenRateLimitPerIp, duration: 15 * 60 });
  const changePasswordLimiter = new RateLimiterMemory({ points: 10, duration: 15 * 60 });

  router.use("/api/auth", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.post("/api/auth/login", async (req, res) => {
    try {
      const meta = getRequestMeta(req);
      const email = String(req.body?.email || "").trim().toLowerCase();
      const accountKey = `${meta.ipAddress}|${email}`;
      if (!(await consumeOrReject(loginByIpLimiter, String(meta.ipAddress), res))) return;
      if (!(await consumeOrReject(loginByAccountLimiter, accountKey, res))) return;

      const { user, token, expiresAt } = await authService.login(
        { email: req.body?.email, password: req.body?.password },
        meta
      );
      await loginByAccountLimiter.delete(accountKey);

      // A session cookie left from a previous login on this browser is revoked.
      if (req.auth?.token) await authService.logout(req.auth.token, meta);
      setSessionCookie(res, config, token, expiresAt);
      return res.json({ user });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/login");
    }
  });

  router.post("/api/auth/logout", async (req, res) => {
    try {
      if (req.auth?.token) await authService.logout(req.auth.token, getRequestMeta(req));
      clearSessionCookie(res, config);
      return res.json({ success: true });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/logout");
    }
  });

  router.get("/api/auth/me", (req, res) => {
    res.json({ user: req.auth ? authService.toSessionUser(req.auth.user) : null });
  });

  router.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const meta = getRequestMeta(req);
      if (!(await consumeOrReject(forgotPasswordLimiter, String(meta.ipAddress), res))) return;
      await authService.requestPasswordReset({ email: req.body?.email }, meta);
      return res.json({
        success: true,
        message: "If an active account exists for this e-mail, a reset link has been sent to it."
      });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/forgot-password");
    }
  });

  router.get("/api/auth/password-token", async (req, res) => {
    try {
      if (!(await consumeOrReject(tokenLimiter, String(getRequestMeta(req).ipAddress), res))) return;
      return res.json(await authService.validatePasswordToken(String(req.query?.token || "")));
    } catch (error) {
      return sendError(res, error, "GET /api/auth/password-token");
    }
  });

  router.post("/api/auth/reset-password", async (req, res) => {
    try {
      const meta = getRequestMeta(req);
      if (!(await consumeOrReject(tokenLimiter, String(meta.ipAddress), res))) return;
      const result = await authService.completePasswordReset(
        { token: String(req.body?.token || ""), password: req.body?.password },
        meta
      );
      // Every session of the account was revoked, including this browser's if any.
      clearSessionCookie(res, config);
      return res.json({ success: true, email: result.email });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/reset-password");
    }
  });

  // Allowed while a password change is required (temporary password).
  router.post("/api/auth/change-password", async (req, res) => {
    try {
      if (!req.auth) return res.status(401).json({ error: "Authentication required.", code: "AUTH_REQUIRED" });
      if (!(await consumeOrReject(changePasswordLimiter, String(req.auth.user.user_id), res))) return;
      const user = await authService.changePassword(
        req.auth.user,
        req.auth.sessionId,
        { currentPassword: req.body?.current_password, newPassword: req.body?.new_password },
        getRequestMeta(req)
      );
      return res.json({ user });
    } catch (error) {
      return sendError(res, error, "POST /api/auth/change-password");
    }
  });

  return router;
};

module.exports = { createAuthRouter };
