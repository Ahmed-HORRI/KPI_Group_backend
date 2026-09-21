require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const kpisRoutes = require("./routes/kpis.routes");
const { ensureKpiRatioSchema } = require("./services/kpiKnowledgeBase.service");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));
app.use(bodyParser.json({ limit: "40mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "40mb" }));

app.use(kpisRoutes);

ensureKpiRatioSchema()
  .then(() => {
    console.log("[KPI Knowledge Base] Sync infrastructure is ready.");
  })
  .catch((error) => {
    console.error("[KPI Knowledge Base] Sync infrastructure setup failed:", error.message);
  });

app.listen(port, () => console.log("Server running on port " + port));
