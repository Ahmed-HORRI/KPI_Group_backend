// KPI & Target Intake page (/kpi-intake): names -> ids, duplicates, the public
// save API, and the administrator's submit into public.kpi /
// public.kpi_target_allocation. Real Express app + HTTP requests against an
// in-memory PostgreSQL (pg-mem): nothing touches the production database.

const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const express = require("express");
const bodyParser = require("body-parser");
const { newDb, DataType } = require("pg-mem");
const { loadAuthConfig } = require("../src/config/auth");
const { installAuth } = require("../src/installAuth");
const model = require("../src/models/auth.model");
const { hashPassword } = require("../src/utils/password");
const { insertKpiRow } = require("../src/models/kpi.model");
const { createKpiIntakeService } = require("../src/services/kpiIntake.service");
const { createKpiIntakeRouter } = require("../src/routes/kpiIntake.routes");
const { createIntakeResolver } = require("../src/services/kpiIntakeResolver.service");
const { parseDate, validateIntakeLine } = require("../src/services/kpiIntakeValidation");

const APP_ORIGIN = "http://localhost:5173";
const ADMIN = { email: "admin@avocarbon.com", password: "Admin-Password-2026" };
const USER = { email: "florence.liu@avocarbon.com", password: "User-Password-2026" };
const AHMED = { id: 2284, label: "Ahmed HORRI — ahmed.horri@avocarbon.com" };

let memoryDb;
let pool;
let server;
let baseUrl;
let scrapRateId;
let energyCostId;
let failKnowledgeBaseRefresh = false;
const knowledgeBaseRefreshes = [];

// Minimal browser: keeps the session cookie between requests.
class Browser {
  constructor() {
    this.cookie = "";
  }

  async request(method, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Origin: APP_ORIGIN,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const [setCookie] = response.headers.getSetCookie();
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, text };
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body = {}) {
    return this.request("POST", path, body);
  }

  delete(path) {
    return this.request("DELETE", path);
  }
}

const signedIn = async ({ email, password }) => {
  const browser = new Browser();
  const res = await browser.post("/api/auth/login", { email, password });
  assert.equal(res.status, 200, res.text);
  return browser;
};

const anonymous = () => new Browser();

// A complete KPI line, as a responsible types it (names, loose spelling).
const kpiLine = (overrides = {}) => ({
  kpi_name: "On-time delivery",
  kpi_sub_title: "Plant",
  subject: "sales",
  kpi_explanation: "Share of the orders delivered on time.",
  unit: "%",
  frequency: "monthly",
  target_value: "95,5",
  target_direction: "up",
  target_auto_adjustment: "Yes",
  min_type: "Null",
  max_type: "Null",
  tolerance_type: "Relative",
  low_tolerance: "-5 %",
  up_tolerance: "5%",
  calculation_on: "Value",
  calculation_mode: "Direct",
  display_trend: "No",
  kfs: "KPI",
  status: "Active",
  owner_role_id: "plant manager",
  ...overrides
});

const allocationLine = (overrides = {}) => ({
  kpi_id: "Scrap rate",
  kpi_type: "Multisite",
  plant_id: "kunshan",
  unit_id: "Kunshan",
  target_value: "2.5",
  target_unit: "%",
  set_by_people_id: "ahmed.horri@avocarbon.com",
  target_start_date: "01/01/2027",
  target_end_date: "2027-12-31",
  ...overrides
});

const save = (browser, entityType, lines, submittedBy = AHMED) =>
  browser.post("/api/kpi-intake/lines", {
    entity_type: entityType,
    submitted_by: submittedBy,
    lines: lines.map((line) => (line.values ? line : { values: line }))
  });

const openLines = async (entityType) => (await anonymous().get(`/api/kpi-intake/lines?entity=${entityType}`)).json.lines;

const clearIntake = () => pool.query("DELETE FROM public.kpi_app_intake_row");

before(async () => {
  memoryDb = newDb({ noAstCoverageCheck: true });
  // Intake writes are serialized by an advisory lock (no-op here: one connection at a time).
  memoryDb.public.registerFunction({
    name: "pg_advisory_xact_lock",
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: () => true
  });
  // PostgreSQL has it; pg-mem does not.
  memoryDb.public.registerFunction({
    name: "trim",
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value) => (value === null ? null : String(value).trim())
  });
  const { Pool } = memoryDb.adapters.createPg();
  pool = new Pool();
  await pool.query(`
    CREATE TABLE public.people (
      people_id SERIAL PRIMARY KEY, first_name VARCHAR(100), name VARCHAR(100), email VARCHAR(255)
    );
    CREATE TABLE public.unit_type (unit_type_id INTEGER PRIMARY KEY, unit_type_name TEXT);
    CREATE TABLE public.unit (
      unit_id INTEGER PRIMARY KEY, unit_name VARCHAR(100), parent_unit_id INTEGER, unit_type_id INTEGER, zone_id INTEGER
    );
    CREATE TABLE public.zone (zone_id INTEGER PRIMARY KEY, zone_name VARCHAR(100));
    CREATE TABLE public.role (role_id INTEGER PRIMARY KEY, role_name VARCHAR(100), is_active BOOLEAN);
    CREATE TABLE public.product_line (
      product_line_id INTEGER PRIMARY KEY, product_line_name VARCHAR(100), product_line_code VARCHAR(20)
    );
    CREATE TABLE public.product (product_id INTEGER PRIMARY KEY, product_name VARCHAR(100), product_code VARCHAR(20));
    CREATE TABLE public.market (market_id INTEGER PRIMARY KEY, market_name VARCHAR(100));
    CREATE TABLE public.customer (
      customer_id INTEGER PRIMARY KEY, customer_name VARCHAR(100), customer_code VARCHAR(20), country VARCHAR(50),
      is_deleted BOOLEAN
    );
    CREATE TABLE public.subject (
      subject_id INTEGER PRIMARY KEY, parent_subject_id INTEGER, subject_name VARCHAR(100), subject_explanation TEXT,
      subject_example TEXT, knowledge TEXT, status VARCHAR(30), comments TEXT
    );
    CREATE TABLE public.subject_kpi (
      subject_kpi_id SERIAL PRIMARY KEY, subject_id INTEGER, kpi_id INTEGER, importance_level VARCHAR(30),
      is_primary BOOLEAN, comments TEXT
    );
    CREATE TABLE public.people_role_assignment (
      assignment_id SERIAL PRIMARY KEY, people_id INTEGER, role_id INTEGER, unit_id INTEGER, zone_id INTEGER,
      market_id INTEGER, product_line_id INTEGER, assignment_status VARCHAR(20), end_date DATE, is_primary BOOLEAN
    );
    CREATE TABLE public.kpi (
      kpi_id SERIAL PRIMARY KEY, kpi_name VARCHAR(255) NOT NULL, kpi_sub_title VARCHAR(255), kpi_code VARCHAR(100),
      kpi_explanation TEXT, kpi_formula TEXT, target_value NUMERIC, target_direction VARCHAR(255),
      target_auto_adjustment VARCHAR(255), min_value NUMERIC, min_type VARCHAR(255), max_value NUMERIC,
      max_type VARCHAR(255), low_limit NUMERIC, high_limit NUMERIC, tolerance_type VARCHAR(255),
      low_tolerance VARCHAR(255), up_tolerance VARCHAR(255), unit VARCHAR(50), frequency VARCHAR(50),
      nombre_periode VARCHAR(255), calculation_mode VARCHAR(255), calculation_on VARCHAR(255),
      display_trend VARCHAR(255), regression VARCHAR(255), reference_kpi_id INTEGER, owner_role_id INTEGER,
      status VARCHAR(50), comments TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_by_people_id INTEGER, kpi_knowledge_base JSONB, currency_type VARCHAR(20), kfs VARCHAR(255),
      reactivity_status VARCHAR(255), importance VARCHAR(255), reactivity_need VARCHAR(255),
      pricing_type VARCHAR(255), file VARCHAR(255), type VARCHAR(255) DEFAULT 'Manual',
      is_active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE public.kpi_target_allocation (
      kpi_target_allocation_id SERIAL PRIMARY KEY, kpi_id INTEGER NOT NULL, plant_id INTEGER, zone_id INTEGER,
      unit_id INTEGER, "function" VARCHAR(100), product_id INTEGER, product_line_id INTEGER, market_id INTEGER,
      customer_id INTEGER, target_value NUMERIC, target_unit VARCHAR(50), local_currency VARCHAR(50),
      kpi_type VARCHAR(120), target_setup_date DATE, target_start_date DATE, target_end_date DATE,
      last_best_target NUMERIC, previous_target_value NUMERIC, target_status VARCHAR(50), set_by_people_id INTEGER,
      approved_by_people_id INTEGER, comments TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(), unit_type_id INTEGER, role_id INTEGER, created_by_people_id INTEGER,
      low_limit NUMERIC, high_limit NUMERIC, is_active BOOLEAN NOT NULL DEFAULT TRUE
    );

    INSERT INTO public.unit_type VALUES (1, 'Factory'), (2, 'Department'), (3, 'Sales ');
    INSERT INTO public.zone VALUES (1, 'Europe'), (2, 'Asia');
    INSERT INTO public.unit VALUES
      (27, 'Kunshan', NULL, 1, 2),
      (30, 'Chennai', NULL, 1, 2),
      (40, 'Finance', 27, 2, NULL),
      (41, 'Finance', 30, 2, NULL),
      (50, 'Poitiers Sales', NULL, 3, 1);
    INSERT INTO public.role VALUES (17, 'Plant manager', TRUE), (18, 'Quality manager', TRUE), (19, 'Old role', FALSE);
    INSERT INTO public.product_line VALUES (1, 'Brushes', 'BRU');
    INSERT INTO public.product VALUES (1, 'Brush holder', 'BH');
    INSERT INTO public.market VALUES (1, 'Automotive');
    INSERT INTO public.customer VALUES
      (1, 'BOSCH', 'B1', 'Germany', FALSE),
      (2, 'BOSCH', 'B2', 'France', FALSE),
      (3, 'VALEO', 'V1', 'France', FALSE),
      (4, 'OLDCO', 'O1', 'France', TRUE);
    INSERT INTO public.subject VALUES
      (1, NULL, 'Company Success', NULL, NULL, NULL, 'Active', NULL),
      (2, 1, 'Cash generation', NULL, NULL, NULL, 'Active', NULL),
      (3, 2, 'Sales', NULL, NULL, NULL, 'Active', NULL),
      (4, 1, 'Retired branch', NULL, NULL, NULL, 'Inactive', NULL);
  `);
  for (const [id, firstName, name, email] of [
    [2284, "Ahmed", "HORRI", "ahmed.horri@avocarbon.com"],
    [114, "Florence", "LIU", "florence.liu@avocarbon.com"],
    [50, "Jean", "DUPONT", "jean.dupont@avocarbon.com"],
    [51, "Jean", "DUPONT", "jean.dupont2@avocarbon.com"]
  ]) {
    await pool.query("INSERT INTO public.people (people_id, first_name, name, email) VALUES ($1, $2, $3, $4)", [
      id,
      firstName,
      name,
      email
    ]);
  }
  scrapRateId = (
    await pool.query(
      `INSERT INTO public.kpi (kpi_name, kpi_sub_title, kpi_explanation, unit, status) VALUES ('Scrap rate', 'Plant', 'x', '%', 'Active') RETURNING kpi_id`
    )
  ).rows[0].kpi_id;
  energyCostId = (
    await pool.query(
      `INSERT INTO public.kpi (kpi_name, kpi_explanation, unit, status) VALUES ('Energy cost', 'x', 'kCur', 'Active') RETURNING kpi_id`
    )
  ).rows[0].kpi_id;
  // Active allocation of "Scrap rate" in Kunshan for 2026.
  await pool.query(
    `
    INSERT INTO public.kpi_target_allocation (
      kpi_id, plant_id, unit_id, kpi_type, target_value, target_start_date, target_end_date, target_status, set_by_people_id
    )
    VALUES ($1, 27, 27, 'Multisite', 3, '2026-01-01', '2026-12-31', 'Active', 2284)
    `,
    [scrapRateId]
  );

  const kpiIntake = createKpiIntakeService({
    db: pool,
    refreshKnowledgeBases: async (_client, kpiIds, options) => {
      if (failKnowledgeBaseRefresh) throw new Error("knowledge base unavailable");
      knowledgeBaseRefreshes.push({ kpiIds, reason: options.reason });
    }
  });
  const config = loadAuthConfig({
    FRONTEND_URL: APP_ORIGIN,
    NODE_ENV: "test",
    AUTH_LOGIN_RATE_LIMIT_PER_IP: "10000",
    AUTH_FORGOT_PASSWORD_RATE_LIMIT_PER_IP: "10000",
    AUTH_TOKEN_RATE_LIMIT_PER_IP: "10000"
  });
  const app = express();
  app.use(bodyParser.json());
  const { authService } = installAuth(app, {
    db: pool,
    config,
    kpiIntake,
    logger: { error: () => {}, log: () => {}, warn: () => {} },
    sendMail: async () => {}
  });
  app.use(createKpiIntakeRouter({ kpiIntake, readsPerIp: 100000, writesPerIp: 100000 }));

  await authService.ensureSchema();
  await kpiIntake.ensureSchema();
  for (const account of [
    { ...ADMIN, role: "admin", peopleId: null, fullName: "First Admin" },
    { ...USER, role: "user", peopleId: 114, fullName: "Florence LIU" }
  ]) {
    await model.insertUser(pool, {
      email: account.email,
      fullName: account.fullName,
      peopleId: account.peopleId,
      role: account.role,
      passwordHash: await hashPassword(account.password),
      mustChangePassword: false,
      createdByUserId: null,
      now: new Date()
    });
  }

  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------

test("names are matched to the right record, never guessed", async () => {
  const resolver = createIntakeResolver(pool);
  const resolve = (ref, value, options) => resolver.resolve(ref, value, { columnLabel: ref, ...options });

  assert.deepEqual(await resolve("plant", "  KUNSHAN "), { id: 27, label: "Kunshan" }, "case and spaces do not matter");
  assert.deepEqual(await resolve("unit", "Finance – Kunshan"), { id: 40, label: "Finance — Kunshan" }, "any dash");
  assert.deepEqual(await resolve("unit", { id: 41, label: "whatever" }), { id: 41, label: "Finance — Chennai" });
  assert.deepEqual(await resolve("unit_type", "sales"), { id: 3, label: "Sales" });
  assert.deepEqual(await resolve("product", "BH"), { id: 1, label: "Brush holder" }, "a code is a name too");
  assert.deepEqual(await resolve("subject", "Sales"), { id: 3, label: "Company Success / Cash generation / Sales" });
  assert.deepEqual(await resolve("kpi", "scrap rate"), { id: scrapRateId, label: `Scrap rate — Plant (#${scrapRateId})` });
  assert.deepEqual(await resolve("people", "Ahmed HORRI"), { id: 2284, label: AHMED.label });
  assert.deepEqual(await resolve("people", "horri ahmed"), { id: 2284, label: AHMED.label }, "last name first");
  assert.deepEqual(await resolve("customer", "valeo"), { id: 3, label: "VALEO [V1] — France (#3)" });
  assert.equal(await resolve("zone", "   "), null, "an empty cell is no reference");

  const ambiguousUnit = await resolve("unit", "Finance");
  assert.match(ambiguousUnit.error, /matches 2 unit records — pick one: Finance — Chennai; Finance — Kunshan/);
  assert.equal(ambiguousUnit.candidates.length, 2);
  assert.match((await resolve("people", "Jean Dupont")).error, /matches 2 people records/);
  assert.match((await resolve("customer", "Bosch")).error, /matches 2 customer records/);
  assert.deepEqual(await resolve("customer", "BOSCH [B2] — France (#2)"), { id: 2, label: "BOSCH [B2] — France (#2)" });

  assert.match((await resolve("plant", "Finance")).error, /is a department, not a plant/);
  assert.match((await resolve("plant", { id: 40, label: "Finance" })).error, /is not a plant/);
  assert.match((await resolve("zone", "Atlantis")).error, /^Unknown zone: "Atlantis"\.$/);
  assert.match((await resolve("customer", "OLDCO")).error, /^Unknown customer/, "deleted customers are not offered");
  assert.match((await resolve("role", "Old role")).error, /^Unknown role/, "inactive roles are not offered");
  assert.match((await resolve("subject", "Company Success")).error, /^Unknown subject/, "only final subjects");
  assert.match((await resolve("market", { id: 999, label: "Gone" })).error, /no longer exists/);
});

test("each cell is checked and understood", async () => {
  assert.equal(parseDate("31/03/2026"), "2026-03-31");
  assert.equal(parseDate("2026-02-31"), null, "no 31st of February");

  const resolver = createIntakeResolver(pool);
  const ok = await validateIntakeLine({ entityType: "kpi", values: kpiLine(), resolver });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.resolved.frequency, "Monthly");
  assert.equal(ok.resolved.target_direction, "Up");
  assert.equal(ok.resolved.target_value, "95.5");
  assert.equal(ok.resolved.low_tolerance, "-5%");
  assert.deepEqual(ok.resolved.owner_role_id, { id: 17, label: "Plant manager" });
  assert.equal(ok.prepared.subject_id, 3, "the rules of POST /api/kpis were applied");

  const bad = await validateIntakeLine({
    entityType: "kpi",
    values: kpiLine({
      kpi_explanation: "",
      frequency: "Hourly",
      target_value: "lots",
      tolerance_type: "Absolute",
      min_value: "3",
      calculation_mode: "Ratio",
      unit: "x".repeat(51)
    }),
    resolver
  });
  assert.equal(bad.errors.kpi_explanation, "Definition is required.");
  assert.match(bad.errors.frequency, /^Frequency must be one of: Daily, Weekly, BI Weekly/);
  assert.equal(bad.errors.target_value, "Target must be a number.");
  assert.equal(bad.errors.low_limit, "Low limit is required when Tolerance type is Absolute.");
  assert.equal(bad.errors.min_value, "Min value is only used when Min type is Value — leave it empty.");
  assert.equal(bad.errors.reference_kpi_id, "Reference KPI is required when Calculation mode is Ratio.");
  assert.match(bad.errors.unit, /too long/);
  assert.equal(bad.values.target_value, "lots", "what was typed is kept, to be corrected");

  const allocation = await validateIntakeLine({
    entityType: "target_allocation",
    values: allocationLine({ kpi_type: "Individual", target_end_date: "2026-06-30" }),
    resolver
  });
  assert.equal(allocation.errors.role_id, "Role is required when Allocation type is Individual.");
  assert.equal(allocation.errors.target_end_date, "End date must be on or after the start date.");
});

test("anyone with the link reads the lists and saves lines; checks and duplicates are shown per line", async () => {
  await clearIntake();
  const visitor = anonymous();

  const lookups = await visitor.get("/api/kpi-intake/lookups");
  assert.equal(lookups.status, 200);
  assert.ok(lookups.json.columns.kpi.some((column) => column.key === "kpi_name"));
  assert.deepEqual(
    lookups.json.references.plant.map((item) => item.label),
    ["Chennai", "Kunshan", "Poitiers Sales"],
    "plants: no departments"
  );
  assert.deepEqual(lookups.json.searched_references, ["people", "customer"], "people and customers are searched, not listed");
  assert.equal(lookups.json.references.people, undefined);

  const people = await visitor.get("/api/kpi-intake/people?search=horri");
  assert.deepEqual(people.json.results, [AHMED]);
  assert.deepEqual((await visitor.get("/api/kpi-intake/people?search=h")).json.results, [], "two letters at least");

  const savedKpis = await save(visitor, "kpi", [
    kpiLine(),
    kpiLine({ kpi_name: "Scrap rate", kpi_sub_title: "plant" }),
    kpiLine({ kpi_name: "On-time delivery " }),
    kpiLine({ kpi_name: "Energy intensity", kpi_sub_title: "", subject: "Finance" })
  ]);
  assert.equal(savedKpis.status, 200, savedKpis.text);
  const [onTime, scrap, onTimeAgain, energy] = savedKpis.json.lines;
  assert.equal(onTime.status, "pending");
  assert.deepEqual(onTime.values.owner_role_id, { id: 17, label: "Plant manager" }, "a typed name becomes the record it matched");
  assert.deepEqual(onTime.submitted_by, AHMED);
  assert.equal(scrap.status, "duplicate");
  assert.match(scrap.duplicate.message, /already exists: "Scrap rate" — Plant/);
  assert.equal(onTimeAgain.status, "duplicate");
  assert.equal(onTimeAgain.duplicate.message, `Same KPI as intake line #${onTime.intake_id}.`);
  assert.equal(energy.status, "error");
  assert.match(energy.errors.subject, /^Unknown subject: "Finance"/);

  const savedAllocations = await save(visitor, "target_allocation", [
    allocationLine({ target_start_date: "", target_end_date: "" }),
    allocationLine(),
    allocationLine({ kpi_id: "On-time delivery", plant_id: "Chennai", unit_id: "Finance — Chennai" }),
    allocationLine({ kpi_id: "Energy intensity" })
  ]);
  assert.equal(savedAllocations.status, 200, savedAllocations.text);
  const [overlapping, nextYear, newKpi, brokenKpi] = savedAllocations.json.lines;
  assert.equal(overlapping.status, "duplicate", "no dates: overlaps the active 2026 allocation");
  assert.match(overlapping.duplicate.message, /already covers this scope and period/);
  assert.equal(nextYear.status, "pending", "2027 does not overlap 2026");
  assert.equal(newKpi.status, "pending", "a KPI entered in the KPI grid can be used before it exists");
  assert.deepEqual(newKpi.values.kpi_id, {
    intake_id: onTime.intake_id,
    label: `On-time delivery — Plant (new KPI, line #${onTime.intake_id})`
  });
  assert.equal(brokenKpi.status, "error");
  assert.match(brokenKpi.errors.kpi_id, new RegExp(`intake line #${energy.intake_id} has errors`));

  // Fixing the KPI line clears the allocation that depends on it.
  const fixed = await save(visitor, "kpi", [
    { intake_id: energy.intake_id, row_version: energy.row_version, values: { ...energy.values, subject: "Sales" } }
  ]);
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.json.lines.find((line) => line.intake_id === energy.intake_id).status, "pending");
  const allocationsAfterFix = await openLines("target_allocation");
  assert.equal(allocationsAfterFix.find((line) => line.intake_id === brokenKpi.intake_id).status, "pending");

  // Someone else's change is never overwritten silently.
  const stale = await save(visitor, "kpi", [
    { intake_id: energy.intake_id, row_version: energy.row_version, values: energy.values }
  ]);
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /changed by someone else/);

  const noName = await visitor.post("/api/kpi-intake/lines", { entity_type: "kpi", lines: [{ values: kpiLine() }] });
  assert.equal(noName.status, 400);
  assert.match(noName.json.error, /Submitted by/);
  assert.equal((await save(visitor, "kpi", [{}])).status, 400, "empty lines are refused");
  assert.equal((await save(visitor, "kpi", Array.from({ length: 201 }, () => kpiLine()))).status, 400);

  // A waiting line can be deleted.
  const deleted = await visitor.delete(`/api/kpi-intake/lines/${onTimeAgain.intake_id}`);
  assert.equal(deleted.status, 200);
  assert.equal((await openLines("kpi")).some((line) => line.intake_id === onTimeAgain.intake_id), false);
});

test("only an administrator reviews and submits", async () => {
  const visitor = anonymous();
  assert.equal((await visitor.get("/api/admin/kpi-intake/preview")).status, 401);
  assert.equal((await visitor.post("/api/admin/kpi-intake/submit")).status, 401);
  assert.equal((await visitor.post("/api/admin/kpi-intake/reject", { intake_ids: [1] })).status, 401);

  const user = await signedIn(USER);
  const forbidden = await user.post("/api/admin/kpi-intake/submit");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.code, "ADMIN_REQUIRED");
  assert.equal((await user.get("/api/admin/kpi-intake/preview")).status, 403);
});

test("the administrator previews, then submits: KPIs first, then their allocations", async () => {
  const admin = await signedIn(ADMIN);
  const kpiCountBefore = Number((await pool.query("SELECT COUNT(*) AS n FROM public.kpi")).rows[0].n);

  const preview = await admin.get("/api/admin/kpi-intake/preview");
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.json.counts.kpi, { ready: 2, duplicate: 1, error: 0 });
  assert.deepEqual(preview.json.counts.target_allocation, { ready: 3, duplicate: 1, error: 0 });
  const onTimePreview = preview.json.kpi.find((line) => line.label === "On-time delivery — Plant");
  assert.ok(onTimePreview.resolved.some((cell) => cell.key === "owner_role_id" && cell.id === 17));
  assert.equal(
    Number((await pool.query("SELECT COUNT(*) AS n FROM public.kpi")).rows[0].n),
    kpiCountBefore,
    "a preview writes nothing"
  );

  // A failure halfway leaves everything as it was: every write of the submit
  // goes through its transaction, which ends with ROLLBACK. pg-mem ignores
  // ROLLBACK, so PostgreSQL's part is played by a backup of the database.
  const backup = memoryDb.backup();
  const realConnect = pool.connect.bind(pool);
  const statements = [];
  pool.connect = async () => {
    const client = await realConnect();
    return {
      query: (sql, params) => {
        statements.push(String(sql).trim());
        return client.query(sql, params);
      },
      release: () => client.release()
    };
  };
  failKnowledgeBaseRefresh = true;
  let failed;
  try {
    failed = await admin.post("/api/admin/kpi-intake/submit");
  } finally {
    failKnowledgeBaseRefresh = false;
    pool.connect = realConnect;
  }
  assert.equal(failed.status, 500);
  assert.equal(statements[0], "BEGIN");
  assert.ok(statements.some((sql) => sql.startsWith("INSERT INTO public.kpi ")), "the KPIs were inserted in the transaction");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.includes("COMMIT"));
  backup.restore();
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM public.kpi")).rows[0].n), kpiCountBefore);
  assert.equal((await openLines("kpi")).filter((line) => line.status === "pending").length, 2);

  const submitted = await admin.post("/api/admin/kpi-intake/submit");
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.json.created.kpi.length, 2);
  assert.equal(submitted.json.created.target_allocation.length, 3);

  const onTime = submitted.json.created.kpi.find((item) => item.label === "On-time delivery — Plant");
  const kpi = (await pool.query("SELECT * FROM public.kpi WHERE kpi_id = $1", [onTime.kpi_id])).rows[0];
  assert.equal(kpi.frequency, "Monthly");
  assert.equal(kpi.target_direction, "Up");
  assert.equal(Number(kpi.target_value), 95.5);
  assert.equal(kpi.owner_role_id, 17);
  assert.equal(kpi.created_by_people_id, 2284, "created by the person who entered it");
  assert.equal(kpi.type, "Manual");
  const subjectLink = await pool.query("SELECT subject_id, is_primary FROM public.subject_kpi WHERE kpi_id = $1", [onTime.kpi_id]);
  assert.deepEqual(subjectLink.rows, [{ subject_id: 3, is_primary: true }]);

  const allocationOfNewKpi = (
    await pool.query("SELECT * FROM public.kpi_target_allocation WHERE kpi_id = $1", [onTime.kpi_id])
  ).rows[0];
  assert.equal(allocationOfNewKpi.plant_id, 30);
  assert.equal(allocationOfNewKpi.unit_id, 41, "Finance — Chennai");
  assert.equal(allocationOfNewKpi.set_by_people_id, 2284);
  assert.equal(allocationOfNewKpi.target_status, "Draft");
  const reviewedAllocations = (await anonymous().get("/api/kpi-intake/lines?entity=target_allocation&view=reviewed")).json.lines;
  assert.deepEqual(
    reviewedAllocations.find((line) => line.created_record_id === allocationOfNewKpi.kpi_target_allocation_id).resolved.kpi_id,
    { id: onTime.kpi_id, label: `On-time delivery — Plant (#${onTime.kpi_id})` },
    "the KPI created in the same submit is named by its new id"
  );

  assert.ok(knowledgeBaseRefreshes.some((call) => call.reason === "kpi_created" && call.kpiIds.includes(onTime.kpi_id)));
  assert.ok(knowledgeBaseRefreshes.some((call) => call.reason === "target_allocation_created" && call.kpiIds.includes(scrapRateId)));

  const trace = await pool.query(
    "SELECT entity_type, action, source, actor_email FROM public.kpi_app_change_log ORDER BY change_id"
  );
  assert.equal(trace.rows.filter((row) => row.entity_type === "kpi").length, 2);
  assert.equal(trace.rows.filter((row) => row.entity_type === "target_allocation").length, 3);
  assert.ok(trace.rows.every((row) => row.action === "created" && row.source === "intake" && row.actor_email === ADMIN.email));

  const intakeRow = (await pool.query("SELECT * FROM public.kpi_app_intake_row WHERE created_record_id = $1 AND entity_type = 'kpi'", [onTime.kpi_id])).rows[0];
  assert.equal(intakeRow.status, "submitted");
  assert.equal(intakeRow.reviewed_by_name, "First Admin");

  // What is left: the duplicate allocation, waiting for the administrator to reject it.
  const left = await openLines("target_allocation");
  assert.deepEqual(left.map((line) => line.status), ["duplicate"]);
  const rejected = await admin.post("/api/admin/kpi-intake/reject", {
    intake_ids: [left[0].intake_id],
    comment: "Already allocated for 2026."
  });
  assert.deepEqual(rejected.json.rejected, [left[0].intake_id]);
  assert.deepEqual(await openLines("target_allocation"), []);
  const reviewed = (await anonymous().get("/api/kpi-intake/lines?entity=target_allocation&view=reviewed")).json.lines;
  assert.equal(reviewed.find((line) => line.intake_id === left[0].intake_id).review_comment, "Already allocated for 2026.");

  // Submitted lines are final.
  const late = await save(anonymous(), "kpi", [{ intake_id: intakeRow.intake_id, row_version: intakeRow.row_version, values: {} }]);
  assert.equal(late.status, 409);
});

test("an allocation of a KPI line that is not submitted with it stays waiting", async () => {
  await clearIntake();
  const visitor = anonymous();
  const [kpi] = (await save(visitor, "kpi", [kpiLine({ kpi_name: "First pass yield" })])).json.lines;
  const [allocation] = (await save(visitor, "target_allocation", [allocationLine({ kpi_id: "First pass yield" })])).json.lines;
  assert.equal(allocation.status, "pending");

  const admin = await signedIn(ADMIN);
  const onlyAllocation = await admin.post("/api/admin/kpi-intake/submit", { intake_ids: [allocation.intake_id] });
  assert.equal(onlyAllocation.status, 200, onlyAllocation.text);
  assert.deepEqual(onlyAllocation.json.created, { kpi: [], target_allocation: [] });
  assert.match(onlyAllocation.json.skipped[0].reason, new RegExp(`intake line #${kpi.intake_id}`));

  // Once its KPI is submitted, the allocation points to the new KPI.
  const kpiOnly = await admin.post("/api/admin/kpi-intake/submit", { intake_ids: [kpi.intake_id] });
  const newKpiId = kpiOnly.json.created.kpi[0].kpi_id;
  const [waiting] = await openLines("target_allocation");
  assert.deepEqual(waiting.resolved.kpi_id, { id: newKpiId, label: `First pass yield — Plant (#${newKpiId})` });
  const rest = await admin.post("/api/admin/kpi-intake/submit");
  assert.equal(rest.json.created.target_allocation[0].kpi_id, newKpiId);

  // In the history, the allocation names the KPI by its new id.
  const submittedAllocation = (await anonymous().get("/api/kpi-intake/lines?entity=target_allocation&view=reviewed")).json.lines[0];
  assert.deepEqual(submittedAllocation.resolved.kpi_id, { id: newKpiId, label: `First pass yield — Plant (#${newKpiId})` });
});

test("the shared KPI insert writes the columns of POST /api/kpis, plus whitelisted extras", async () => {
  const client = await pool.connect();
  try {
    const row = await insertKpiRow(
      client,
      { kpi_name: "Shared insert", kpi_explanation: "x", unit: "%", status: "Active", kfs: "KPI", frequency: "Weekly" },
      { createdByPeopleId: 114, extraColumns: { currency_type: "EUR", type: undefined, kpi_id: 999 } }
    );
    assert.equal(row.kpi_name, "Shared insert");
    assert.equal(row.created_by_people_id, 114);
    assert.equal(row.currency_type, "EUR");
    assert.equal(row.type, "Manual", "an extra left undefined keeps the default");
    assert.notEqual(row.kpi_id, 999, "only currency_type and type can be added");
  } finally {
    client.release();
  }
});

// --- Rows already in the database (signed-in users) --------------------------

const recordsOf = async (browser, entityType) => (await browser.get(`/api/kpi-intake/records?entity=${entityType}`)).json.records;

const recordOf = async (browser, entityType, recordId) =>
  (await recordsOf(browser, entityType)).find((record) => record.record_id === recordId);

// A line changing a row, as the page sends it: the row's values as shown, then the edits.
const change = (record, edits, line = {}) => ({ record_id: record.record_id, base: record.values, values: { ...record.values, ...edits }, ...line });

// A KPI as old rows are: values the page's rules would refuse today.
const insertLegacyKpi = async (name) => {
  const kpiId = (
    await pool.query(
      `
      INSERT INTO public.kpi (
        kpi_name, kpi_explanation, unit, status, target_value, target_direction, target_auto_adjustment,
        calculation_mode, regression, up_tolerance, created_by_people_id
      )
      VALUES ($1, 'x', 'EA', 'Active', 10, 'down', 'To Validate', 'AI Derived KPI', '4 months', '5.0%', 114)
      RETURNING kpi_id
      `,
      [name]
    )
  ).rows[0].kpi_id;
  // Filed under a subject that is not final.
  await pool.query("INSERT INTO public.subject_kpi (subject_id, kpi_id, is_primary) VALUES (2, $1, TRUE)", [kpiId]);
  return kpiId;
};

test("the rows of the database are shown to signed-in users only, as the grid holds them", async () => {
  await clearIntake();
  const legacyId = await insertLegacyKpi("Legacy cost");
  const visitor = anonymous();
  const records = await visitor.get("/api/kpi-intake/records?entity=kpi");
  assert.equal(records.status, 401);
  assert.equal(records.json.code, "AUTH_REQUIRED");

  const user = await signedIn(USER);
  const legacy = await recordOf(user, "kpi", legacyId);
  assert.equal(legacy.values.kpi_name, "Legacy cost");
  assert.equal(legacy.values.target_value, "10");
  assert.equal(legacy.values.target_direction, "Down", "an option in its exact spelling");
  assert.equal(legacy.values.calculation_mode, "AI Derived KPI", "an old value is shown as it is");
  assert.equal(legacy.values.up_tolerance, "5%");
  assert.deepEqual(legacy.values.subject, { id: 2, label: "Company Success / Cash generation" }, "named even if not final");
  assert.equal(legacy.info.is_active, "Yes");
  assert.equal(legacy.info.created_by, "Florence LIU");

  const allocation = (await recordsOf(user, "target_allocation")).find(
    (record) => record.values.kpi_id?.id === scrapRateId && record.values.target_start_date === "2026-01-01"
  );
  assert.deepEqual(allocation.values.plant_id, { id: 27, label: "Kunshan" });
  assert.deepEqual(allocation.values.set_by_people_id, AHMED);
  assert.equal(allocation.values.target_value, "3");

  // Nobody changes a row without signing in.
  const anonymousChange = await save(visitor, "kpi", [change(legacy, { target_value: "12" })]);
  assert.equal(anonymousChange.status, 401);
  assert.deepEqual(await openLines("kpi"), []);
});

test("a signed-in user changes a row: only the changed cells are checked, and only they are written", async () => {
  await clearIntake();
  const legacyId = await insertLegacyKpi("Legacy freight");
  const user = await signedIn(USER);
  let legacy = await recordOf(user, "kpi", legacyId);

  const saved = await save(user, "kpi", [change(legacy, { target_value: "12,5" })]);
  assert.equal(saved.status, 200, saved.text);
  const [line] = saved.json.lines;
  assert.equal(line.status, "pending", "the old values nobody touched do not block the change");
  assert.equal(line.record_id, legacyId);

  // One waiting line per row; visitors do not see it.
  const second = await save(await signedIn(ADMIN), "kpi", [change(legacy, { unit: "%" })]);
  assert.equal(second.status, 409);
  assert.match(second.json.error, new RegExp(`KPI #${legacyId} is already being changed \\(line #${line.intake_id}\\)`));
  assert.deepEqual(await openLines("kpi"), []);
  assert.equal((await user.get("/api/kpi-intake/lines?entity=kpi")).json.lines.length, 1);
  assert.equal((await anonymous().delete(`/api/kpi-intake/lines/${line.intake_id}`)).status, 401);

  const admin = await signedIn(ADMIN);
  let preview = (await admin.get("/api/admin/kpi-intake/preview")).json;
  assert.deepEqual(preview.kpi[0].changes, [{ key: "target_value", label: "Target", from: "10", to: "12.5" }]);
  assert.equal(preview.kpi[0].record_id, legacyId);

  // The same cell changed meanwhile in the database: never overwritten unseen.
  await pool.query("UPDATE public.kpi SET target_value = 11, unit = 'Number' WHERE kpi_id = $1", [legacyId]);
  preview = (await admin.get("/api/admin/kpi-intake/preview")).json;
  assert.equal(preview.kpi[0].status, "error");
  assert.match(preview.kpi[0].errors.target_value, /^Changed in the database since this line was saved \(now: 11\)/);
  // The stored line is checked again at the next write; the page compares its
  // base with the row meanwhile.
  const [conflicted] = (await user.get("/api/kpi-intake/lines?entity=kpi")).json.lines;
  assert.equal(conflicted.base.target_value, "10");

  // Saved again on the row as it is now, the change goes through; the other
  // cell changed in the database (unit) is kept.
  legacy = await recordOf(user, "kpi", legacyId);
  const resaved = await save(user, "kpi", [
    change(legacy, { target_value: "12.5" }, { intake_id: conflicted.intake_id, row_version: conflicted.row_version })
  ]);
  assert.equal(resaved.json.lines[0].status, "pending", resaved.text);
  preview = (await admin.get("/api/admin/kpi-intake/preview")).json;
  assert.deepEqual(preview.kpi[0].changes, [{ key: "target_value", label: "Target", from: "11", to: "12.5" }]);

  const submitted = await admin.post("/api/admin/kpi-intake/submit");
  assert.equal(submitted.status, 200, submitted.text);
  assert.deepEqual(submitted.json.created.kpi, []);
  assert.equal(submitted.json.updated.kpi[0].kpi_id, legacyId);

  const row = (await pool.query("SELECT * FROM public.kpi WHERE kpi_id = $1", [legacyId])).rows[0];
  assert.equal(Number(row.target_value), 12.5);
  assert.equal(row.unit, "Number", "changed in the database meanwhile: kept");
  assert.equal(row.target_direction, "down", "untouched cells are not rewritten");
  assert.equal(row.calculation_mode, "AI Derived KPI");
  assert.equal(row.up_tolerance, "5.0%");

  const trace = (
    await pool.query("SELECT action, source, changes FROM public.kpi_app_change_log WHERE entity_type = 'kpi' AND entity_id = $1", [legacyId])
  ).rows;
  assert.equal(trace.length, 1);
  assert.equal(trace[0].action, "updated");
  assert.equal(trace[0].source, "intake");
  assert.deepEqual(Object.keys(trace[0].changes), ["target_value"]);
  assert.ok(knowledgeBaseRefreshes.some((call) => call.reason === "kpi_updated" && call.kpiIds.includes(legacyId)));

  const history = (await user.get("/api/kpi-intake/lines?entity=kpi&view=reviewed")).json.lines;
  assert.equal(history.find((item) => item.record_id === legacyId).created_record_id, legacyId);
  assert.equal((await anonymous().get("/api/kpi-intake/lines?entity=kpi&view=reviewed")).json.lines.some((item) => item.record_id), false);
});

test("the rules still apply to the cells a person changes, and to the cells tied to them", async () => {
  await clearIntake();
  const legacyId = await insertLegacyKpi("Legacy energy");
  const user = await signedIn(USER);
  const legacy = await recordOf(user, "kpi", legacyId);

  const lines = (
    await save(user, "kpi", [change(legacy, { min_type: "Valeur a entrer", unit: "", subject: "Sales" })])
  ).json.lines;
  assert.equal(lines[0].status, "error");
  assert.equal(lines[0].errors.min_value, "Min value is required when Min type is Value.");
  assert.equal(lines[0].errors.unit, "Unit is required.");
  assert.equal(lines[0].errors.calculation_mode, undefined, "untouched: not checked");

  // A new name already used by another KPI is a duplicate.
  const renamed = (
    await save(user, "kpi", [
      change(legacy, { kpi_name: "Energy cost" }, { intake_id: lines[0].intake_id, row_version: lines[0].row_version })
    ])
  ).json.lines[0];
  assert.equal(renamed.status, "duplicate");
  assert.match(renamed.duplicate.message, /already exists: "Energy cost"/);

  // Back to the row's values: the line is dropped.
  const reverted = await save(user, "kpi", [change(legacy, {}, { intake_id: renamed.intake_id, row_version: renamed.row_version })]);
  assert.deepEqual(reverted.json.discarded_ids, [renamed.intake_id]);
  assert.deepEqual(reverted.json.lines, []);

  // A new subject is the KPI's primary subject link.
  const resubject = (await save(user, "kpi", [change(legacy, { subject: "Sales" })])).json.lines[0];
  assert.equal(resubject.status, "pending");
  const admin = await signedIn(ADMIN);
  assert.equal((await admin.post("/api/admin/kpi-intake/submit")).status, 200);
  const links = (await pool.query("SELECT subject_id, is_primary FROM public.subject_kpi WHERE kpi_id = $1 ORDER BY subject_kpi_id", [legacyId])).rows;
  assert.deepEqual(links, [
    { subject_id: 2, is_primary: false },
    { subject_id: 3, is_primary: true }
  ]);
});

test("a signed-in user changes target allocations; a new scope is checked for duplicates", async () => {
  await clearIntake();
  const insertAllocation = async (start, end) =>
    (
      await pool.query(
        `
        INSERT INTO public.kpi_target_allocation (
          kpi_id, plant_id, unit_id, kpi_type, target_value, target_start_date, target_end_date, target_status, set_by_people_id
        )
        VALUES ($1, 30, 30, 'Multisite', 5, $2, $3, 'Active', 114)
        RETURNING kpi_target_allocation_id
        `,
        [energyCostId, start, end]
      )
    ).rows[0].kpi_target_allocation_id;
  const firstHalf = await insertAllocation("2028-01-01", "2028-06-30");
  const secondHalf = await insertAllocation("2028-07-01", "2028-12-31");

  const user = await signedIn(USER);
  const first = await recordOf(user, "target_allocation", firstHalf);
  const second = await recordOf(user, "target_allocation", secondHalf);
  const [retarget, overlap] = (
    await save(user, "target_allocation", [
      change(first, { target_value: "4", set_by_people_id: "ahmed.horri@avocarbon.com" }),
      change(second, { target_start_date: "2028-06-01" })
    ])
  ).json.lines;
  assert.equal(retarget.status, "pending", JSON.stringify(retarget.errors));
  assert.equal(overlap.status, "duplicate");
  assert.match(overlap.duplicate.message, new RegExp(`allocation #${firstHalf}`));

  const admin = await signedIn(ADMIN);
  const submitted = await admin.post("/api/admin/kpi-intake/submit");
  assert.equal(submitted.status, 200, submitted.text);
  assert.deepEqual(
    submitted.json.updated.target_allocation.map((item) => item.kpi_target_allocation_id),
    [firstHalf]
  );
  const row = (await pool.query("SELECT * FROM public.kpi_target_allocation WHERE kpi_target_allocation_id = $1", [firstHalf])).rows[0];
  assert.equal(Number(row.target_value), 4);
  assert.equal(row.set_by_people_id, 2284);
  assert.equal(row.plant_id, 30, "untouched");
  const trace = (
    await pool.query(
      "SELECT action, changes FROM public.kpi_app_change_log WHERE entity_type = 'target_allocation' AND entity_id = $1",
      [firstHalf]
    )
  ).rows;
  assert.equal(trace[0].action, "updated");
  assert.deepEqual(Object.keys(trace[0].changes).sort(), ["set_by_people_id", "target_value"]);
  assert.ok(knowledgeBaseRefreshes.some((call) => call.reason === "target_allocation_updated" && call.kpiIds.includes(energyCostId)));
});

test("public writes are limited per IP address", async () => {
  const app = express();
  app.use(bodyParser.json());
  const fakeIntake = { saveLines: async () => ({ saved_ids: [], lines: [] }), getLookups: async () => ({}) };
  app.use(createKpiIntakeRouter({ kpiIntake: fakeIntake, readsPerIp: 100, writesPerIp: 2 }));
  const limited = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const url = `http://127.0.0.1:${limited.address().port}/api/kpi-intake/lines`;
    const post = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const third = await post();
    assert.equal(third.status, 429);
    assert.ok(third.headers.get("retry-after"));
  } finally {
    await new Promise((resolve) => limited.close(resolve));
  }
});
