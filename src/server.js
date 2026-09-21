require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const cron = require("node-cron");

const { pool } = require("./config/db");
const openai = require("./config/openai");
const { createTransporter } = require("./config/mailer");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("./utils/normalize");
const { createHttpError } = require("./utils/httpError");
const { upsertPrimarySubjectKpiLink } = require("./models/kpi.model");

const kpisRoutes = require("./routes/kpis.routes");
const { ensureKpiRatioSchema, refreshKpiKnowledgeBaseForKpiId } = require("./services/kpiKnowledgeBase.service");
const { registerRecommendationRoutes } = require("./services/kpiRecommendations.service");
const { registerAIGeneratedKpiRoutes } = require("./services/kpiDerivedGenerator.service");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));
app.use(bodyParser.json({ limit: "40mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "40mb" }));

app.use(kpisRoutes);

registerRecommendationRoutes(app, pool, createTransporter);
registerAIGeneratedKpiRoutes(app, {
  pool,
  ensureKpiRatioSchema,
  refreshKpiKnowledgeBaseForKpiId,
  upsertPrimarySubjectKpiLink,
  getOpenAIClient: () => openai,
  cronScheduler: cron,
  normalizeOptionalIntegerInput,
  normalizeOptionalTextInput,
  createHttpError
});

ensureKpiRatioSchema()
  .then(() => {
    console.log("[KPI Knowledge Base] Sync infrastructure is ready.");
  })
  .catch((error) => {
    console.error("[KPI Knowledge Base] Sync infrastructure setup failed:", error.message);
  });

app.listen(port, () => console.log("Server running on port " + port));
