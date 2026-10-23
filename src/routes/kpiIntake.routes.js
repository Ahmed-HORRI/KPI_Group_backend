const express = require("express");
const { RateLimiterMemory } = require("rate-limiter-flexible");

// Public API of the KPI & Target Intake page (/kpi-intake): anyone with the
// link reads the lists and saves lines -- no account, like the other pages
// opened from a link. The rows already in the database, and the lines that
// change them, are for signed-in users (GET /api/kpi-intake/records is a
// protected route, middlewares/auth.middleware.js). Submitting the lines to
// the KPI tables is for administrators only (/api/admin/kpi-intake/*,
// routes/admin.routes.js).
//
// Writes are open to anyone, so requests are limited per IP address and in size.

const MAX_BODY_BYTES = 2 * 1024 * 1024;

// The signed-in user, once their password is set (as the protected routes require).
const signedInUser = (req) => (req.auth?.user && !req.auth.user.must_change_password ? req.auth.user : null);

const createKpiIntakeRouter = ({ kpiIntake, readsPerIp = 600, writesPerIp = 120, windowSeconds = 15 * 60 }) => {
  const router = express.Router();
  const readLimiter = new RateLimiterMemory({ points: readsPerIp, duration: windowSeconds });
  const writeLimiter = new RateLimiterMemory({ points: writesPerIp, duration: windowSeconds });

  router.use("/api/kpi-intake", async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (isWrite && Number(req.get("content-length") || 0) > MAX_BODY_BYTES) {
      return res.status(413).json({ error: "Too much data at once — save fewer lines." });
    }
    try {
      await (isWrite ? writeLimiter : readLimiter).consume(String(req.ip || req.socket?.remoteAddress || "unknown"));
      return next();
    } catch (rateLimiterRes) {
      if (rateLimiterRes instanceof Error) return next(rateLimiterRes);
      res.set("Retry-After", String(Math.ceil((rateLimiterRes.msBeforeNext || 60000) / 1000)));
      return res.status(429).json({ error: "Too many requests — wait a few minutes and try again." });
    }
  });

  const handle = (label, handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (!error.statusCode) console.error(`${label} error:`, error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "Unexpected error. Please try again."
      });
    }
  };

  router.get(
    "/api/kpi-intake/lookups",
    handle("GET /api/kpi-intake/lookups", async (_req, res) => {
      res.json(await kpiIntake.getLookups());
    })
  );

  router.get(
    "/api/kpi-intake/people",
    handle("GET /api/kpi-intake/people", async (req, res) => {
      res.json({ results: await kpiIntake.search("people", req.query.search) });
    })
  );

  router.get(
    "/api/kpi-intake/customers",
    handle("GET /api/kpi-intake/customers", async (req, res) => {
      res.json({ results: await kpiIntake.search("customer", req.query.search) });
    })
  );

  router.get(
    "/api/kpi-intake/records",
    handle("GET /api/kpi-intake/records", async (req, res) => {
      res.json({ records: await kpiIntake.listRecords({ entityType: req.query.entity }) });
    })
  );

  router.get(
    "/api/kpi-intake/lines",
    handle("GET /api/kpi-intake/lines", async (req, res) => {
      res.json({
        lines: await kpiIntake.listLines({ entityType: req.query.entity, view: req.query.view, user: signedInUser(req) })
      });
    })
  );

  router.post(
    "/api/kpi-intake/lines",
    handle("POST /api/kpi-intake/lines", async (req, res) => {
      res.json(
        await kpiIntake.saveLines(
          { entityType: req.body?.entity_type, submittedBy: req.body?.submitted_by, lines: req.body?.lines },
          { ip: req.ip || req.socket?.remoteAddress || null, user: signedInUser(req) }
        )
      );
    })
  );

  router.delete(
    "/api/kpi-intake/lines/:intakeId",
    handle("DELETE /api/kpi-intake/lines/:intakeId", async (req, res) => {
      res.json(await kpiIntake.deleteLine(req.params.intakeId, { user: signedInUser(req) }));
    })
  );

  return router;
};

module.exports = { createKpiIntakeRouter };
