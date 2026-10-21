const { Pool } = require("pg");

const sharedPostgresConfig = {
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  password: process.env.PG_PASSWORD,
  port: Number(process.env.PG_PORT) || 5432,
  ssl: { rejectUnauthorized: false },
  // Fail a query stuck behind a table lock instead of hanging the request forever.
  options: "-c lock_timeout=30000",
};

const pool = new Pool({
  ...sharedPostgresConfig,
  database: process.env.PG_DATABASE_KPI || "KPI_DB_Final",
});

const actionPlanPool = new Pool({
  ...sharedPostgresConfig,
  database: process.env.PG_DATABASE_ACTION_PLAN || "Action Plan",
});

module.exports = { pool, actionPlanPool };
