const { Pool } = require("pg");

const sharedPostgresConfig = {
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  password: process.env.PG_PASSWORD,
  port: Number(process.env.PG_PORT) || 5432,
  ssl: { rejectUnauthorized: false },
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
