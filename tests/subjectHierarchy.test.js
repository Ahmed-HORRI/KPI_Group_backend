const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { filterActiveSubjectTree } = require("../src/utils/subjectHierarchy");
const { loadSubjectHierarchyData } = require("../src/models/kpi.model");

const rows = [
  { subject_id: 1, parent_subject_id: null, subject_name: "Company Success", status: "Active" },
  { subject_id: 2, parent_subject_id: 1, subject_name: "Cash generation", status: "ACTIVE" },
  { subject_id: 3, parent_subject_id: 2, subject_name: "Sales", status: "active" },
  { subject_id: 4, parent_subject_id: 1, subject_name: "Retired branch", status: "Inactive" },
  { subject_id: 5, parent_subject_id: 4, subject_name: "Hidden active child", status: "Active" },
];
const fakePool = {
  query: async (sql) => {
    assert.match(sql.trim(), /^SELECT\b/i, "The hierarchy endpoint must only read data");
    return { rows: /FROM public\.subject\b/.test(sql) ? rows : [] };
  },
};

test("active hierarchy preserves full paths and excludes inactive branches", async () => {
  const hierarchy = await loadSubjectHierarchyData(fakePool);
  const active = filterActiveSubjectTree(hierarchy.tree);
  assert.equal(active.length, 1);
  assert.deepEqual(active[0].children.map((node) => node.id), ["2"]);
  assert.equal(active[0].children[0].children[0].full_path, "Company Success / Cash generation / Sales");
  assert.equal(hierarchy.nodeMap.has("5"), true, "Filtering must not mutate the loaded hierarchy");
});

test("dashboard context exposes the active hierarchy alongside existing lookups", async () => {
  const handlers = new Map();
  const router = {};
  for (const method of ["get", "post", "put", "delete"]) {
    router[method] = (route, handler) => handlers.set(`${method} ${route}`, handler);
  }
  const source = fs.readFileSync(path.join(__dirname, "../src/routes/responsibles.routes.js"), "utf8");
  vm.runInNewContext(source, {
    module: { exports: {} },
    console,
    process,
    require: (name) => {
      if (name === "express") return { Router: () => router };
      if (name === "../config/db") return { pool: fakePool };
      if (name === "../models/kpi.model") return {
        loadSubjectHierarchyData: () => loadSubjectHierarchyData(fakePool),
      };
      if (name === "../models/responsible.model") return {
        loadFormResponsibleContext: async () => ({ people_id: 9, name: "Test responsible" }),
      };
      if (name.startsWith("../utils/")) return require(path.join(__dirname, "../src/routes", name));
      if (name === "../services/kpiAnalyticsScope.service") return require(path.join(__dirname, "../src/routes", name));
      if (name === "../services/kpiChangeLog.service") return require(path.join(__dirname, "../src/routes", name));
      return {};
    },
  });
  let payload;
  await handlers.get("get /api/responsibles/:responsibleId/dashboard-context")(
    { params: { responsibleId: "9" } },
    {
      json: (data) => { payload = data; },
      status: (code) => { throw new Error(`Unexpected response status ${code}`); },
    }
  );
  assert.equal(payload.responsible.people_id, "9");
  assert.equal(payload.subject_hierarchy[0].children[0].children[0].id, "3");
  assert.equal(payload.subject_hierarchy[0].children.length, 1);
  assert.ok(Array.isArray(payload.role_options));
  assert.ok(payload.allocation_lookups);
});
