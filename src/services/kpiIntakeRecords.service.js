// Rows already in public.kpi / public.kpi_target_allocation, as the grids of
// the KPI & Target Intake page (/kpi-intake) hold them: signed-in users see
// them there and change them; an administrator submits the changes.
//
// Each value is converted the way a cell typed in the grid is stored -- text
// trimmed, numbers without trailing zeros, dates as YYYY-MM-DD, an option in
// its exact spelling, a reference as { id, label } -- so a cell nobody touched
// compares equal to the database. Values the rules of the page would refuse
// today (old options such as "AI Derived KPI") are kept as they are: only the
// cells a person changes are checked, and only those are written.

const { INTAKE_COLUMNS } = require("./kpiIntakeColumns");
const { normalizeMatchText } = require("./kpiIntakeResolver.service");
const { normalizeValue } = require("./kpiChangeLog.service");
const { normalizeOptionalNumericInput, normalizeOptionalTextInput } = require("../utils/normalize");

const RECORD_ID_COLUMN = { kpi: "kpi_id", target_allocation: "kpi_target_allocation_id" };
const RECORD_NOUN = { kpi: "KPI", target_allocation: "Allocation" };

const placeholders = (count) => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ");

const personName = (firstName, name) => [firstName, name].filter(Boolean).join(" ").trim();

// "5.0 %" -> "5%", as a typed tolerance is stored.
const toleranceText = (text) => {
  const number = normalizeOptionalNumericInput(text, { allowPercent: true });
  return number === null ? text : `${Number(number)}${text.trim().endsWith("%") ? "%" : ""}`;
};

// A database value -> the cell (undefined: empty). labels: Map per reference name.
const toCell = (column, value, labels) => {
  if (value === null || value === undefined) return undefined;
  if (column.type === "ref") {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? { id, label: labels[column.ref]?.get(id) || `#${id}` } : undefined;
  }
  if (column.type === "date") {
    const date = normalizeValue(value);
    return date ? String(date).slice(0, 10) : undefined;
  }
  const text = normalizeOptionalTextInput(value);
  if (text === null) return undefined;
  if (column.type === "number") return Number.isFinite(Number(text)) ? String(Number(text)) : text;
  if (column.type === "tolerance") return toleranceText(text);
  if (column.type === "enum") {
    // "down" is the option "Down"; an option that no longer exists stays as it is.
    const normalized = normalizeMatchText(text);
    return column.options.find((option) => normalizeMatchText(option.value) === normalized)?.value || text;
  }
  return text;
};

// Two cells hold the same value: references by record, numbers by value, the rest by text.
const sameCell = (column, left, right) => {
  const empty = (value) =>
    value === null || value === undefined || (typeof value === "object" ? !value.id && !value.intake_id && !normalizeOptionalTextInput(value.label) : normalizeOptionalTextInput(value) === null);
  if (empty(left) || empty(right)) return empty(left) && empty(right);
  if (column.type === "ref" || typeof left === "object" || typeof right === "object") {
    const key = (value) =>
      typeof value !== "object"
        ? `text:${normalizeMatchText(value)}`
        : value.id
          ? `id:${value.id}`
          : value.intake_id
            ? `line:${value.intake_id}`
            : `text:${normalizeMatchText(value.label)}`;
    return key(left) === key(right);
  }
  if (column.type === "number") {
    const [a, b] = [normalizeOptionalNumericInput(left), normalizeOptionalNumericInput(right)];
    if (a !== null && b !== null) return Number(a) === Number(b);
  }
  return String(left).trim() === String(right).trim();
};

// Columns whose cell differs between two sets of values.
const changedKeys = (entityType, values = {}, other = {}) =>
  INTAKE_COLUMNS[entityType]
    .filter((column) => !sameCell(column, values?.[column.key], other?.[column.key]))
    .map((column) => column.key);

const RECORD_QUERIES = {
  kpi: (where) => `
    SELECT k.*, p.first_name AS _created_by_first_name, p.name AS _created_by_last_name
    FROM public.kpi k
    LEFT JOIN public.people p ON p.people_id = k.created_by_people_id
    ${where("k.kpi_id")}
    ORDER BY k.kpi_name, k.kpi_sub_title, k.kpi_id
  `,
  target_allocation: (where) => `
    SELECT kta.*, p.first_name AS _created_by_first_name, p.name AS _created_by_last_name
    FROM public.kpi_target_allocation kta
    LEFT JOIN public.kpi k ON k.kpi_id = kta.kpi_id
    LEFT JOIN public.people p ON p.people_id = kta.created_by_people_id
    ${where("kta.kpi_target_allocation_id")}
    ORDER BY k.kpi_name, kta.kpi_target_allocation_id
  `
};

// The subject a KPI is filed under: its primary link, else its first one (as the KPI admin page).
const loadPrimarySubjects = async (db, kpiIds) => {
  if (!kpiIds.length) return new Map();
  const result = await db.query(
    `SELECT kpi_id, subject_id, is_primary, subject_kpi_id FROM public.subject_kpi WHERE kpi_id IN (${placeholders(kpiIds.length)})`,
    kpiIds
  );
  const best = new Map();
  for (const row of result.rows) {
    const kpiId = Number(row.kpi_id);
    const current = best.get(kpiId);
    const rank = [row.is_primary ? 0 : 1, Number(row.subject_kpi_id)];
    if (!current || rank[0] < current.rank[0] || (rank[0] === current.rank[0] && rank[1] < current.rank[1])) {
      best.set(kpiId, { subjectId: Number(row.subject_id), rank });
    }
  }
  return new Map([...best].map(([kpiId, { subjectId }]) => [kpiId, subjectId]));
};

// Rows of one table (all, or those of ids), in the grid's order:
// -> Map record_id -> { record_id, values, info, active }.
const loadRecords = async (db, entityType, { ids = null, resolver }) => {
  const columns = INTAKE_COLUMNS[entityType];
  const idColumn = RECORD_ID_COLUMN[entityType];
  const wanted = ids === null ? null : Array.from(new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  if (wanted && !wanted.length) return new Map();

  const result = await db.query(
    RECORD_QUERIES[entityType]((column) => (wanted ? `WHERE ${column} IN (${placeholders(wanted.length)})` : "")),
    wanted || []
  );
  const rows = result.rows;
  if (entityType === "kpi") {
    const subjects = await loadPrimarySubjects(db, rows.map((row) => Number(row.kpi_id)));
    for (const row of rows) row.subject = subjects.get(Number(row.kpi_id)) ?? null;
  }

  // One look-up per list for the whole table.
  const labels = {};
  for (const column of columns.filter((item) => item.type === "ref")) {
    labels[column.ref] = labels[column.ref] || [];
    for (const row of rows) {
      if (row[column.key] !== null && row[column.key] !== undefined) labels[column.ref].push(row[column.key]);
    }
  }
  for (const name of Object.keys(labels)) labels[name] = await resolver.labelsOf(name, labels[name]);

  const records = new Map();
  for (const row of rows) {
    const recordId = Number(row[idColumn]);
    const values = {};
    for (const column of columns) {
      const cell = toCell(column, row[column.key], labels);
      if (cell !== undefined) values[column.key] = cell;
    }
    records.set(recordId, {
      record_id: recordId,
      values,
      active: row.is_active !== false,
      info: {
        is_active: row.is_active === false ? "No" : "Yes",
        created_by: personName(row._created_by_first_name, row._created_by_last_name) || null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
      }
    });
  }
  return records;
};

module.exports = { RECORD_ID_COLUMN, RECORD_NOUN, changedKeys, loadRecords, sameCell, toCell };
