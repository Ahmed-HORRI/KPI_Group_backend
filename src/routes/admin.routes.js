const express = require("express");
const { getRequestMeta } = require("../middlewares/auth.middleware");

// User administration: every route here requires an administrator session.
const createAdminRouter = ({ authService, requireAdmin }) => {
  const router = express.Router();

  router.use("/api/admin", requireAdmin, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
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
    "/api/admin/users",
    handle("GET /api/admin/users", async (req, res) => {
      res.json({
        users: await authService.listUsers({
          search: req.query.search,
          role: req.query.role,
          status: req.query.status
        })
      });
    })
  );

  router.post(
    "/api/admin/users",
    handle("POST /api/admin/users", async (req, res) => {
      const result = await authService.createUser(req.auth.user, req.body || {}, getRequestMeta(req));
      res.status(201).json(result);
    })
  );

  router.get(
    "/api/admin/users/:userId",
    handle("GET /api/admin/users/:userId", async (req, res) => {
      res.json({ user: await authService.getUser(req.params.userId) });
    })
  );

  router.patch(
    "/api/admin/users/:userId",
    handle("PATCH /api/admin/users/:userId", async (req, res) => {
      const user = await authService.updateUser(req.auth.user, req.params.userId, req.body || {}, getRequestMeta(req));
      res.json({ user });
    })
  );

  router.delete(
    "/api/admin/users/:userId",
    handle("DELETE /api/admin/users/:userId", async (req, res) => {
      await authService.deleteUser(req.auth.user, req.params.userId, getRequestMeta(req));
      res.json({ success: true });
    })
  );

  router.post(
    "/api/admin/users/:userId/password-link",
    handle("POST /api/admin/users/:userId/password-link", async (req, res) => {
      res.json(await authService.sendPasswordLink(req.auth.user, req.params.userId, getRequestMeta(req)));
    })
  );

  router.post(
    "/api/admin/users/:userId/temporary-password",
    handle("POST /api/admin/users/:userId/temporary-password", async (req, res) => {
      const user = await authService.setTemporaryPassword(
        req.auth.user,
        req.params.userId,
        { password: req.body?.password },
        getRequestMeta(req)
      );
      res.json({ user });
    })
  );

  router.post(
    "/api/admin/users/:userId/unlock",
    handle("POST /api/admin/users/:userId/unlock", async (req, res) => {
      res.json({ user: await authService.unlockUser(req.auth.user, req.params.userId, getRequestMeta(req)) });
    })
  );

  router.post(
    "/api/admin/users/:userId/revoke-sessions",
    handle("POST /api/admin/users/:userId/revoke-sessions", async (req, res) => {
      res.json(
        await authService.revokeSessions(req.auth.user, req.auth.sessionId, req.params.userId, getRequestMeta(req))
      );
    })
  );

  router.get(
    "/api/admin/auth-events",
    handle("GET /api/admin/auth-events", async (req, res) => {
      res.json({
        events: await authService.listEvents({
          userId: req.query.user_id,
          eventType: req.query.event_type,
          limit: req.query.limit
        })
      });
    })
  );

  router.get(
    "/api/admin/people",
    handle("GET /api/admin/people", async (req, res) => {
      res.json({ people: await authService.searchPeople(req.query.search) });
    })
  );

  return router;
};

module.exports = { createAdminRouter };
