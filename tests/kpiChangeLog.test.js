// Traceability of KPI and target allocation changes, against an in-memory copy
// of the tables (pg-mem): no production access.

const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const { newDb } = require("pg-mem");
const { actorFromRequest, createKpiChangeLog, normalizeValue } = require("../src/services/kpiChangeLog.service");

let db;
let changeLog;

const AHMED = { user_id: 5, people_id: 2284, full_name: "Ahmed HORRI", email: "ahmed.horri@avocarbon.com" };
const dashboard = () => actorFromRequest({ auth: { user: AHMED }, ip: "10.0.0.7" }, "dashboard");

// Same shape as the routes: BEGIN, work, COMMIT (ROLLBACK on error).
const inTransaction = async (work) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const latest = async (filters = {}) => (await changeLog.list(filters))[0];

before(async () => {
  const memoryDb = newDb({ noAstCoverageCheck: true });
  const { Pool } = memoryDb.adapters.createPg();
  db = new Pool();
  await db.query(`
    CREATE TABLE public.people (people_id INTEGER PRIMARY KEY, first_name VARCHAR(100), name VARCHAR(100), email VARCHAR(255));
    CREATE TABLE public.unit (unit_id INTEGER PRIMARY KEY, unit_name VARCHAR(100));
    CREATE TABLE public.zone (zone_id INTEGER PRIMARY KEY, zone_name VARCHAR(100));
    CREATE TABLE public.role (role_id INTEGER PRIMARY KEY, role_name VARCHAR(100));
    CREATE TABLE public.kpi (
      kpi_id INTEGER PRIMARY KEY, kpi_name VARCHAR(200), kpi_code VARCHAR(50), unit VARCHAR(50), frequency VARCHAR(50),
      target_value NUMERIC, target_direction VARCHAR(10), low_limit NUMERIC, high_limit NUMERIC, status VARCHAR(30),
      created_by_people_id INTEGER, kpi_knowledge_base JSONB, updated_at TIMESTAMPTZ
    );
    CREATE TABLE public.kpi_target_allocation (
      kpi_target_allocation_id INTEGER PRIMARY KEY, kpi_id INTEGER, plant_id INTEGER, zone_id INTEGER, unit_id INTEGER,
      role_id INTEGER, set_by_people_id INTEGER, kpi_type VARCHAR(30), target_value NUMERIC, target_unit VARCHAR(30),
      low_limit NUMERIC, high_limit NUMERIC, target_start_date DATE, target_end_date DATE, target_status VARCHAR(30),
      updated_at TIMESTAMPTZ
    );
    INSERT INTO public.people VALUES
      (2284, 'Ahmed', 'HORRI', 'ahmed.horri@avocarbon.com'),
      (114, 'Florence', 'LIU', 'florence.liu@avocarbon.com'),
      (4, 'Florence', 'PARADIS', 'florence.paradis@avocarbon.com');
    INSERT INTO public.unit VALUES (30, 'Kunshan');
    INSERT INTO public.zone VALUES (2, 'Asia');
    INSERT INTO public.role VALUES (17, 'Plant manager');
  `);
  changeLog = createKpiChangeLog({ db });
});

test("values are compared the way they mean, not the way they are stored", () => {
  assert.equal(normalizeValue("3.0000"), "3");
  assert.equal(normalizeValue(3), "3");
  assert.equal(normalizeValue(""), null);
  assert.equal(normalizeValue("  Monthly "), "Monthly");
  assert.equal(normalizeValue(new Date(2026, 0, 31)), "2026-01-31", "local-midnight DATE");
  assert.equal(normalizeValue(new Date(Date.UTC(2026, 0, 31))), "2026-01-31", "UTC-midnight DATE");
  assert.equal(normalizeValue(true), true);
  assert.equal(normalizeValue("x".repeat(600)).length, 501, "long texts are shortened");
});

test("a KPI's creation, update and deletion are traced with who did it", async () => {
  // Created
  await inTransaction(async (client) => {
    await client.query(`
      INSERT INTO public.kpi (kpi_id, kpi_name, kpi_code, unit, frequency, target_value, low_limit, high_limit, status, created_by_people_id)
      VALUES (1, 'Scrap rate', 'SCR', '%', 'Monthly', 3, 2, 4, 'Active', 114)
    `);
    await changeLog.record(client, { entityType: "kpi", before: new Map(), after: await changeLog.snapshotKpis(client, [1]), actor: dashboard() });
  });
  let entry = await latest();
  assert.equal(entry.action, "created");
  assert.equal(entry.entity_type, "kpi");
  assert.equal(entry.label, "Scrap rate");
  assert.deepEqual(entry.owner, { people_id: 114, full_name: "Florence LIU" });
  assert.deepEqual(entry.actor, { user_id: 5, people_id: 2284, name: "Ahmed HORRI", email: "ahmed.horri@avocarbon.com" });
  assert.equal(entry.source, "dashboard");
  assert.equal(entry.ip_address, "10.0.0.7");
  assert.deepEqual(entry.changes.target_value, { from: null, to: "3" });
  assert.deepEqual(entry.changes.unit, { from: null, to: "%" });

  // Updated: only the fields that really changed (not the knowledge base nor the timestamps).
  await inTransaction(async (client) => {
    const beforeRows = await changeLog.snapshotKpis(client, [1]);
    await client.query(`
      UPDATE public.kpi
      SET kpi_name = 'Scrap rate (all lines)', target_value = 2.5, low_limit = 2.0000,
          kpi_knowledge_base = '{"summary": "regenerated"}', updated_at = NOW()
      WHERE kpi_id = 1
    `);
    await changeLog.record(client, { entityType: "kpi", before: beforeRows, after: await changeLog.snapshotKpis(client, [1]), actor: dashboard() });
  });
  entry = await latest();
  assert.equal(entry.action, "updated");
  assert.deepEqual(entry.changes, {
    kpi_name: { from: "Scrap rate", to: "Scrap rate (all lines)" },
    target_value: { from: "3", to: "2.5" }
  });

  // Saved without any change: nothing to trace.
  const count = await inTransaction(async (client) => {
    const beforeRows = await changeLog.snapshotKpis(client, [1]);
    await client.query(`UPDATE public.kpi SET updated_at = NOW() WHERE kpi_id = 1`);
    return changeLog.record(client, { entityType: "kpi", before: beforeRows, after: await changeLog.snapshotKpis(client, [1]), actor: dashboard() });
  });
  assert.equal(count, 0);

  // Deleted, from the open /kpi-admin page by nobody signed in.
  await inTransaction(async (client) => {
    const beforeRows = await changeLog.snapshotKpis(client, [1]);
    await client.query(`DELETE FROM public.kpi WHERE kpi_id = 1`);
    await changeLog.record(client, {
      entityType: "kpi",
      before: beforeRows,
      after: new Map(),
      actor: actorFromRequest({ ip: "10.0.0.9" }, "kpi_admin"),
      note: "Its 3 target allocation(s) were deleted with it."
    });
  });
  entry = await latest();
  assert.equal(entry.action, "deleted");
  assert.equal(entry.label, "Scrap rate (all lines)");
  assert.equal(entry.source, "kpi_admin");
  assert.deepEqual(entry.actor, { user_id: null, people_id: null, name: "", email: "" });
  assert.equal(entry.note, "Its 3 target allocation(s) were deleted with it.");
  assert.deepEqual(entry.changes.target_value, { from: "2.5", to: null });
});

test("editing a target allocation group traces each row updated, added and removed", async () => {
  await db.query(`
    INSERT INTO public.kpi (kpi_id, kpi_name, created_by_people_id) VALUES (2, 'OEE', 114);
    INSERT INTO public.kpi_target_allocation
      (kpi_target_allocation_id, kpi_id, unit_id, zone_id, role_id, set_by_people_id, kpi_type, target_value, target_start_date)
    VALUES
      (10, 2, 30, NULL, NULL, 114, 'Individual', 80, '2026-01-01'),
      (11, 2, NULL, 2, NULL, 114, 'Zone', 75, '2026-01-01');
  `);

  await inTransaction(async (client) => {
    const beforeRows = await changeLog.snapshotAllocations(client, [10, 11]);
    await client.query(`UPDATE public.kpi_target_allocation SET target_value = 85, updated_at = NOW() WHERE kpi_target_allocation_id = 10`);
    await client.query(`DELETE FROM public.kpi_target_allocation WHERE kpi_target_allocation_id = 11`);
    await client.query(`
      INSERT INTO public.kpi_target_allocation (kpi_target_allocation_id, kpi_id, role_id, set_by_people_id, kpi_type, target_value)
      VALUES (12, 2, 17, 114, 'Role', 70)
    `);
    const recorded = await changeLog.record(client, {
      entityType: "target_allocation",
      before: beforeRows,
      after: await changeLog.snapshotAllocations(client, [10, 11, 12]),
      actor: dashboard()
    });
    assert.equal(recorded, 3);
  });

  const entries = await changeLog.list({ entityType: "target_allocation" });
  const byId = Object.fromEntries(entries.map((entry) => [entry.entity_id, entry]));
  assert.equal(byId[10].action, "updated");
  assert.equal(byId[10].label, "OEE · Kunshan");
  assert.deepEqual(byId[10].changes, { target_value: { from: "80", to: "85" } }, "the unchanged start date is not reported");
  assert.equal(byId[11].action, "deleted");
  assert.equal(byId[11].label, "OEE · Asia");
  assert.equal(byId[12].action, "created");
  assert.equal(byId[12].label, "OEE · Plant manager");
  assert.equal(byId[12].kpi_id, 2);
  assert.deepEqual(byId[12].owner, { people_id: 114, full_name: "Florence LIU" });
});

test("an approved target adjustment is traced to the approver of the e-mail link", async () => {
  await inTransaction(async (client) => {
    const beforeRows = await changeLog.snapshotAllocations(client, [10]);
    await client.query(`UPDATE public.kpi_target_allocation SET target_value = 90, target_status = 'Approved' WHERE kpi_target_allocation_id = 10`);
    await changeLog.record(client, {
      entityType: "target_allocation",
      before: beforeRows,
      after: await changeLog.snapshotAllocations(client, [10]),
      actor: { ...actorFromRequest(null, "target_review"), peopleId: 4, ip: "10.0.0.8" }
    });
  });
  const entry = await latest();
  assert.equal(entry.source, "target_review");
  assert.deepEqual(entry.actor, { user_id: null, people_id: 4, name: "Florence PARADIS", email: "florence.paradis@avocarbon.com" });
  assert.deepEqual(entry.changes.target_value, { from: "85", to: "90" });
});

// pg-mem ignores ROLLBACK, so the guarantee is checked where it comes from: the
// trace is written on the route's own transaction connection -- PostgreSQL then
// commits or rolls back the change and its trace together.
test("the trace is written on the route's transaction, never on a separate connection", async () => {
  const insertsInto = (log) => log.filter((sql) => /INSERT INTO public\.kpi_app_change_log/.test(sql)).length;
  const poolQuery = db.query.bind(db);
  const onClient = [];
  const onPool = [];
  const routeClient = { query: (sql, params) => (onClient.push(String(sql)), poolQuery(sql, params)) };
  db.query = (sql, params) => (onPool.push(String(sql)), poolQuery(sql, params));
  try {
    const beforeRows = await changeLog.snapshotAllocations(routeClient, [10]);
    const afterRows = new Map([[10, { ...beforeRows.get(10), target_value: 1 }]]);
    await changeLog.record(routeClient, { entityType: "target_allocation", before: beforeRows, after: afterRows, actor: dashboard() });
  } finally {
    db.query = poolQuery;
  }
  assert.equal(insertsInto(onClient), 1);
  assert.equal(insertsInto(onPool), 0);
});

test("the administration can filter the changes", async () => {
  const all = await changeLog.list();
  assert.ok(all.length >= 7);
  assert.ok(new Date(all[0].created_at) >= new Date(all[all.length - 1].created_at), "newest first");

  assert.ok((await changeLog.list({ entityType: "kpi" })).every((entry) => entry.entity_type === "kpi"));
  assert.ok((await changeLog.list({ action: "deleted" })).every((entry) => entry.action === "deleted"));
  assert.deepEqual(
    (await changeLog.list({ search: "PARADIS" })).map((entry) => entry.actor.name),
    ["Florence PARADIS"],
    "by who"
  );
  assert.ok((await changeLog.list({ search: "kunshan" })).every((entry) => entry.label.includes("Kunshan")), "by item");
  assert.equal((await changeLog.list({ limit: 2 })).length, 2);
});

test("only known sources and entities are accepted", async () => {
  await assert.rejects(
    changeLog.record(db, { entityType: "kpi", before: new Map(), after: new Map(), actor: { source: "somewhere" } })
  );
  await assert.rejects(
    changeLog.record(db, { entityType: "invoice", before: new Map(), after: new Map(), actor: dashboard() })
  );
});
