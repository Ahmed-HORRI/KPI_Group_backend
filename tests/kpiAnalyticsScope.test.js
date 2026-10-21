// Who sees whose KPIs in "My KPI Analytics": scope by account role, against an
// in-memory copy of the organisation tables (pg-mem, no production access).

const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const { newDb } = require("pg-mem");
const { getAnalyticsLevel, createKpiAnalyticsScope } = require("../src/services/kpiAnalyticsScope.service");

let scope;

// Ids of the people below.
const VALERIE = 10; // works at CYCLAM
const GWEN = 11; // Poitiers
const DANIEL = 12; // Frankfurt
const FLORENCE_LIU = 13; // Kunshan
const HONGMEI = 14; // Tianjin
const NO_RESULTS = 15; // CYCLAM, KPI allocation but no result yet
const PARADIS = 20; // plant manager of CYCLAM + Poitiers (assignments)
const RIEGEL = 21; // plant manager without assignment, works at Kunshan
const LAGADEC = 22; // zone manager of Europe (assignment)
const TAO = 23; // zone manager without assignment, works at Kunshan (Asia)
const ENDED = 25; // plant assignment on Frankfurt ended, works at Tianjin

const sorted = (ids) => [...ids].sort((a, b) => a - b);
const viewer = (role, peopleId) => ({ role, people_id: peopleId });

before(async () => {
  const memoryDb = newDb({ noAstCoverageCheck: true });
  const { Pool } = memoryDb.adapters.createPg();
  const db = new Pool();

  await db.query(`
    CREATE TABLE public.unit (unit_id INTEGER PRIMARY KEY, unit_name VARCHAR(100), zone_id INTEGER);
    CREATE TABLE public.people (people_id INTEGER PRIMARY KEY, first_name VARCHAR(100), name VARCHAR(100), work_at_unit_id INTEGER);
    CREATE TABLE public.role (role_id INTEGER PRIMARY KEY, role_name VARCHAR(100));
    CREATE TABLE public.people_role_assignment (
      assignment_id INTEGER PRIMARY KEY, people_id INTEGER, role_id INTEGER, unit_id INTEGER, zone_id INTEGER,
      assignment_status VARCHAR(20), start_date DATE, end_date DATE
    );
    CREATE TABLE public.kpi_target_allocation (kpi_target_allocation_id INTEGER PRIMARY KEY, set_by_people_id INTEGER);
    CREATE TABLE public.kpi_result (kpi_result_id INTEGER PRIMARY KEY, kpi_target_allocation_id INTEGER, raw_value NUMERIC);

    INSERT INTO public.unit VALUES
      (1, 'CYCLAM', 1), (2, 'Poitiers', 1), (3, 'Frankfurt', 1), (4, 'Kunshan', 2), (5, 'Tianjin', 2), (6, 'Luxembourg HQ', NULL);
    INSERT INTO public.people VALUES
      (10, 'Valerie', 'BOUDOUX', 1), (11, 'Gwen', 'PETIT', 2), (12, 'Daniel', 'BEIL', 3), (13, 'Florence', 'LIU', 4),
      (14, 'Hongmei', 'JU', 5), (15, 'No', 'RESULTS', 1), (20, 'Florence', 'PARADIS', 1), (21, 'Allan', 'RIEGEL', 4),
      (22, 'Franck', 'LAGADEC', 2), (23, 'Tao', 'REN', 4), (24, 'Olivier', 'SPICKER', 6), (25, 'Ended', 'ASSIGNMENT', 5);
    INSERT INTO public.role VALUES (17, 'Plant manager'), (11, 'Zone managers'), (1, 'CEO');
    INSERT INTO public.people_role_assignment VALUES
      (1, 20, 17, 1, NULL, 'ACTIVE', NULL, NULL),
      (2, 20, 17, 2, NULL, 'ACTIVE', '2020-01-01', NULL),
      (3, 22, 11, NULL, 1, 'ACTIVE', NULL, NULL),
      (4, 25, 17, 3, NULL, 'ACTIVE', '2020-01-01', '2021-12-31'),
      (5, 24, 1, 6, NULL, 'ACTIVE', NULL, NULL);
    INSERT INTO public.kpi_target_allocation VALUES (1, 10), (2, 11), (3, 12), (4, 13), (5, 14), (6, 15), (7, 20);
    INSERT INTO public.kpi_result VALUES (1, 1, 5), (2, 2, 7), (3, 3, 1), (4, 4, 3), (5, 5, 9), (6, 6, NULL), (7, 7, 2);
  `);

  scope = createKpiAnalyticsScope({ db });
});

const responsibleIds = async (who) => (await scope.getFilters(who)).responsibles.map((r) => r.people_id);

test("each role has its analytics level", () => {
  assert.equal(getAnalyticsLevel("ceo"), "all");
  assert.equal(getAnalyticsLevel("vp"), "all");
  assert.equal(getAnalyticsLevel("admin"), "all");
  assert.equal(getAnalyticsLevel("plant_manager"), "plant");
  assert.equal(getAnalyticsLevel("zone_manager"), "zone");
  assert.equal(getAnalyticsLevel("user"), "own");
  assert.equal(getAnalyticsLevel(undefined), "own");
});

test("CEO and VP see every responsible with KPI results", async () => {
  const filters = await scope.getFilters(viewer("ceo", 24));
  assert.equal(filters.level, "all");
  assert.deepEqual(sorted(filters.responsibles.map((r) => r.people_id)), [VALERIE, GWEN, DANIEL, FLORENCE_LIU, HONGMEI, PARADIS]);
  assert.ok(!filters.responsibles.some((r) => r.people_id === NO_RESULTS), "nothing to chart without results");
  assert.deepEqual(filters.units.map((u) => u.unit_name), ["CYCLAM", "Frankfurt", "Kunshan", "Poitiers", "Tianjin"]);
  assert.deepEqual(filters.responsibles.find((r) => r.people_id === FLORENCE_LIU), {
    people_id: FLORENCE_LIU,
    full_name: "Florence LIU",
    unit_id: 4,
    unit_name: "Kunshan"
  });
  assert.deepEqual(sorted(await responsibleIds(viewer("vp", 24))), sorted(filters.responsibles.map((r) => r.people_id)));
});

test("a plant manager sees the responsibles of their plant(s)", async () => {
  const filters = await scope.getFilters(viewer("plant_manager", PARADIS));
  assert.equal(filters.level, "plant");
  assert.deepEqual(filters.scope_units.map((u) => u.unit_name), ["CYCLAM", "Poitiers"], "from the assignments");
  assert.deepEqual(sorted(filters.responsibles.map((r) => r.people_id)), [VALERIE, GWEN, PARADIS]);

  assert.deepEqual(await responsibleIds(viewer("plant_manager", RIEGEL)), [FLORENCE_LIU], "no assignment: their work unit");
  assert.deepEqual(await responsibleIds(viewer("plant_manager", ENDED)), [HONGMEI], "an ended assignment does not count");
});

test("a zone manager sees the responsibles of every plant in their zone(s)", async () => {
  assert.deepEqual(sorted(await responsibleIds(viewer("zone_manager", LAGADEC))), [VALERIE, GWEN, DANIEL, PARADIS]);
  assert.deepEqual(
    sorted(await responsibleIds(viewer("zone_manager", TAO))),
    [FLORENCE_LIU, HONGMEI],
    "no assignment: the zone of their work unit"
  );
});

test("a user only has their own analytics", async () => {
  assert.deepEqual(await scope.getFilters(viewer("user", VALERIE)), {
    level: "own",
    scope_units: [],
    units: [],
    responsibles: []
  });
  const me = viewer("user", VALERIE);
  assert.deepEqual(await scope.resolveSelection(me, { ownerId: VALERIE }), [VALERIE]);
  assert.deepEqual(await scope.resolveSelection(me, { ownerId: VALERIE, responsible: "me" }), [VALERIE]);
  await assert.rejects(scope.resolveSelection(me, { ownerId: VALERIE, responsible: String(GWEN) }), { statusCode: 403 });
  await assert.rejects(scope.resolveSelection(me, { ownerId: VALERIE, responsible: "all" }), { statusCode: 403 });
});

test("selections are checked against the viewer's scope", async () => {
  const paradis = viewer("plant_manager", PARADIS);
  const pick = (query) => scope.resolveSelection(paradis, { ownerId: PARADIS, ...query });

  assert.deepEqual(sorted(await pick({ responsible: "all" })), [VALERIE, GWEN, PARADIS]);
  assert.deepEqual(await pick({ responsible: "all", unitId: "2" }), [GWEN]);
  assert.deepEqual(await pick({ responsible: String(GWEN) }), [GWEN]);
  await assert.rejects(pick({ responsible: String(FLORENCE_LIU) }), { statusCode: 403 }, "another plant");
  await assert.rejects(pick({ responsible: "all", unitId: "3" }), { statusCode: 403 }, "a unit outside the scope");
  await assert.rejects(pick({ responsible: "all", unitId: "abc" }), { statusCode: 400 });
  await assert.rejects(pick({ responsible: "nobody" }), { statusCode: 400 });

  const ceo = viewer("ceo", 24);
  assert.deepEqual(await scope.resolveSelection(ceo, { ownerId: 24, responsible: String(HONGMEI) }), [HONGMEI]);
  assert.deepEqual(sorted(await scope.resolveSelection(ceo, { ownerId: 24, responsible: "all", unitId: "1" })), [VALERIE, PARADIS]);
});
