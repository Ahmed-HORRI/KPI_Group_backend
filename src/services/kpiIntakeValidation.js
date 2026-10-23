// Checks of the KPI & Target Intake lines (/kpi-intake), cell by cell, so the
// page can show each problem in its cell.
//
// A line is checked against kpiIntakeColumns.js (types, required columns,
// names -> ids), then against the rules of the existing create routes
// (prepareKpiWritePayload / prepareKpiObjectPayload: what the KPI admin form
// and the dashboard enforce), then for duplicates:
//   - KPI: same name + sub-title as an existing KPI, or as an earlier line;
//   - allocation: same KPI and scope (plant, zone, unit, unit type, role, set
//     by, product, product line, market, customer, function) as an active,
//     not Inactive allocation -- or an earlier line -- whose period overlaps.
// A duplicate is never inserted nor merged into the existing row.
//
// Result per line: status "error" (something to fix), "duplicate" or "pending"
// (ready to be submitted by an administrator).
//
// A line that changes a row already in the database (signed-in users) is
// checked the same way, but only for the cells the person changed -- and the
// rules that tie a changed cell to another one (a min value with its min type).
// Untouched cells keep whatever the database holds, even an old value the
// page would refuse today: the line writes only the cells it changes.

const { INTAKE_COLUMNS } = require("./kpiIntakeColumns");
const { normalizeOptionalTextInput, normalizeOptionalNumericInput } = require("../utils/normalize");
const { normalizeOptionalDateInput } = require("../utils/weekPeriod");
const { createHttpError } = require("../utils/httpError");
const { prepareKpiWritePayload } = require("../models/kpi.model");
const { prepareKpiObjectPayload } = require("./kpiTargetAllocation.service");
const { normalizeMatchText, toReferenceInput } = require("./kpiIntakeResolver.service");
const { normalizeValue } = require("./kpiChangeLog.service");
const { changedKeys, sameCell } = require("./kpiIntakeRecords.service");

// Longest text a cell may hold before it is even checked (columns have their own limit).
const MAX_CELL_LENGTH = 10000;

const ALLOCATION_SCOPE_COLUMNS = [
  "plant_id",
  "zone_id",
  "unit_id",
  "unit_type_id",
  "role_id",
  "set_by_people_id",
  "product_id",
  "product_line_id",
  "market_id",
  "customer_id"
];

const columnsOf = (entityType) => {
  const columns = INTAKE_COLUMNS[entityType];
  if (!columns) throw createHttpError(400, "Unknown intake table.");
  return columns;
};

// What the page sent for a line -> what is stored: known columns only, text
// trimmed, references as { id, intake_id, label }.
const sanitizeRawValues = (entityType, values) => {
  if (values !== undefined && (values === null || typeof values !== "object" || Array.isArray(values))) {
    throw createHttpError(400, "Each line must be a set of column values.");
  }
  const clean = {};
  for (const column of columnsOf(entityType)) {
    const value = values?.[column.key];
    if (value === undefined || value === null) continue;
    if (column.type === "ref") {
      const reference = toReferenceInput(value);
      if (reference?.label && reference.label.length > MAX_CELL_LENGTH) {
        throw createHttpError(400, `${column.label}: text too long.`);
      }
      if (reference) clean[column.key] = reference;
      continue;
    }
    if (typeof value === "object") throw createHttpError(400, `${column.label}: invalid value.`);
    const text = normalizeOptionalTextInput(value);
    if (text === null) continue;
    if (text.length > MAX_CELL_LENGTH) throw createHttpError(400, `${column.label}: text too long.`);
    clean[column.key] = text;
  }
  return clean;
};

// "2026-03-31", "31/03/2026" or "31.03.2026" -> "2026-03-31".
const parseDate = (text) => {
  const iso = normalizeOptionalDateInput(text);
  const european = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  const candidate = iso || (european ? `${european[3]}-${european[2].padStart(2, "0")}-${european[1].padStart(2, "0")}` : null);
  if (!candidate) return null;
  const date = new Date(`${candidate}T00:00:00Z`);
  // 2026-02-31 parses as March 3rd: refuse it.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate ? candidate : null;
};

const matchOption = (column, text) => {
  const normalized = normalizeMatchText(text);
  return column.options.find(
    (option) => normalizeMatchText(option.value) === normalized || normalizeMatchText(option.label) === normalized
  );
};

const optionLabels = (column, values) =>
  values.map((value) => column.options?.find((option) => option.value === value)?.label || value).join(" or ");

const conditionMet = (condition, resolved) => condition && condition.values.includes(resolved[condition.key]);

const refId = (value) => (value && value.id ? value.id : null);

// Checks one cell (not "required"): -> { stored, resolved, error }.
const checkCell = async (column, raw, { resolver, intakeKpis }) => {
  if (column.type === "ref") {
    const result = await resolver.resolve(column.ref, raw, {
      columnLabel: column.label,
      allowIntake: Boolean(column.allowIntake),
      intakeKpis
    });
    if (!result) return {};
    if (result.error) return { stored: toReferenceInput(raw), error: result.error };
    const value = result.intake_id ? { intake_id: result.intake_id, label: result.label } : { id: result.id, label: result.label };
    return { stored: value, resolved: value };
  }

  const text = normalizeOptionalTextInput(raw);
  if (text === null) return {};

  switch (column.type) {
    case "number": {
      const number = normalizeOptionalNumericInput(text);
      return number === null
        ? { stored: text, error: `${column.label} must be a number.` }
        : { stored: text, resolved: number };
    }
    case "tolerance": {
      const number = normalizeOptionalNumericInput(text, { allowPercent: true });
      if (number === null) return { stored: text, error: `${column.label} must be a number, like 5 or 5%.` };
      return { stored: text, resolved: `${Number(number)}${text.trim().endsWith("%") ? "%" : ""}` };
    }
    case "date": {
      const date = parseDate(text);
      return date ? { stored: date, resolved: date } : { stored: text, error: `${column.label} must be a date (YYYY-MM-DD).` };
    }
    case "enum": {
      const option = matchOption(column, text);
      return option
        ? { stored: option.value, resolved: option.value }
        : { stored: text, error: `${column.label} must be one of: ${column.options.map((item) => item.label).join(", ")}.` };
    }
    default:
      if (column.maxLength && text.length > column.maxLength) {
        return { stored: text, error: `${column.label} is too long (${column.maxLength} characters at most).` };
      }
      return { stored: text, resolved: text };
  }
};

// What the existing KPI create route receives (POST /api/kpis).
const toKpiPayload = (resolved) => ({
  ...resolved,
  subject: undefined,
  subject_id: refId(resolved.subject),
  reference_kpi_id: refId(resolved.reference_kpi_id),
  owner_role_id: refId(resolved.owner_role_id)
});

// What the existing allocation create route receives. A KPI still waiting in
// the intake has no id yet: a stand-in id lets the other rules be checked.
const toAllocationPayload = (resolved, { createdByPeopleId = null } = {}) => {
  const payload = { ...resolved, created_by_people_id: createdByPeopleId };
  for (const column of INTAKE_COLUMNS.target_allocation) {
    if (column.type === "ref") payload[column.key] = refId(resolved[column.key]);
  }
  if (!payload.kpi_id && resolved.kpi_id?.intake_id) payload.kpi_id = Number.MAX_SAFE_INTEGER;
  return payload;
};

const cellText = (value) => (value && typeof value === "object" ? value.label || "" : String(value ?? ""));

// An untouched cell of a row of the database, as the rules see it: understood
// when it can be, else kept as it is (never an error: nobody changed it). The
// line keeps what the page sent for it.
const keepDatabaseCell = async (column, value, raw, context) => {
  if (value === undefined || value === null) return { stored: raw };
  if (column.type === "ref") return { stored: raw, resolved: value };
  const result = await checkCell(column, value, context);
  return { stored: raw, resolved: result.error ? value : result.resolved };
};

// One line: -> { values (stored), resolved, errors: { column: message, _row? },
// prepared, changes, conflicts }
// record (a line that changes a row of the database): the row's values now;
// base: the values the person saw when changing it (the row, by default).
// changes: [{ key, from, to }], the cells the line would write.
const validateIntakeLine = async ({
  entityType,
  values,
  resolver,
  intakeKpis = [],
  submittedByPeopleId = null,
  record = null,
  base = null
}) => {
  const columns = columnsOf(entityType);
  const stored = {};
  const resolved = {};
  const errors = {};
  const conflicts = [];
  const edited = new Set(record ? changedKeys(entityType, values, base || record) : columns.map((column) => column.key));

  for (const column of columns) {
    const context = { resolver, intakeKpis };
    const result = edited.has(column.key)
      ? await checkCell(column, values?.[column.key], context)
      : await keepDatabaseCell(column, record?.[column.key], values?.[column.key], context);
    if (result.stored !== undefined && result.stored !== null) stored[column.key] = result.stored;
    if (result.resolved !== undefined) resolved[column.key] = result.resolved;
    if (result.error) errors[column.key] = result.error;
  }

  // A cell changed both here and in the database since this line was saved:
  // the database's value is never overwritten without the person seeing it.
  if (record && base) {
    for (const column of columns) {
      if (!edited.has(column.key) || errors[column.key]) continue;
      if (sameCell(column, base[column.key], record[column.key])) continue;
      if (sameCell(column, resolved[column.key], record[column.key])) continue;
      conflicts.push(column.key);
      errors[column.key] = `Changed in the database since this line was saved (now: ${
        cellText(record[column.key]) || "empty"
      }) — check it and save the line again, or delete the line.`;
    }
  }

  // On a row of the database, a rule is checked when it involves a changed cell.
  const concerned = (column) =>
    !record || edited.has(column.key) || (column.requiredWhen && edited.has(column.requiredWhen.key));

  for (const column of columns) {
    if (errors[column.key] || !concerned(column)) continue;
    const condition = column.requiredWhen;
    const required = column.required || conditionMet(condition, resolved);
    const otherLabel = condition ? columns.find((other) => other.key === condition.key)?.label : "";
    if (required && resolved[column.key] === undefined) {
      errors[column.key] = column.required
        ? `${column.label} is required.`
        : `${column.label} is required when ${otherLabel} is ${optionLabels(columns.find((other) => other.key === condition.key), condition.values)}.`;
    } else if (column.exclusive && resolved[column.key] !== undefined && !conditionMet(condition, resolved)) {
      errors[column.key] = `${column.label} is only used when ${otherLabel} is ${optionLabels(
        columns.find((other) => other.key === condition.key),
        condition.values
      )} — leave it empty.`;
    }
  }

  if (
    entityType === "target_allocation" &&
    (!record || edited.has("target_start_date") || edited.has("target_end_date")) &&
    !errors.target_start_date &&
    !errors.target_end_date &&
    resolved.target_start_date &&
    resolved.target_end_date &&
    resolved.target_start_date > resolved.target_end_date
  ) {
    errors.target_end_date = "End date must be on or after the start date.";
  }

  if (record) {
    // What the line writes: the changed cells whose value differs from the database now.
    const changes = columns
      .filter((column) => edited.has(column.key) && !sameCell(column, resolved[column.key], record[column.key]))
      .map((column) => ({ key: column.key, from: record[column.key] ?? null, to: resolved[column.key] ?? null }));
    if (!Object.keys(errors).length && !changes.length) {
      errors._row = "Nothing to change: the database already has these values — delete this line.";
    }
    return { values: stored, resolved, errors, prepared: null, changes, conflicts };
  }

  // The rules of the existing create routes, so a line accepted here is
  // accepted there.
  let prepared = null;
  if (!Object.keys(errors).length) {
    try {
      prepared =
        entityType === "kpi"
          ? prepareKpiWritePayload(toKpiPayload(resolved))
          : prepareKpiObjectPayload(toAllocationPayload(resolved, { createdByPeopleId: submittedByPeopleId }));
    } catch (error) {
      if (!error.statusCode) throw error;
      errors._row = error.message;
    }
  }

  return { values: stored, resolved, errors, prepared, changes: [], conflicts };
};

const kpiKey = (resolved) => `${normalizeMatchText(resolved.kpi_name)}|${normalizeMatchText(resolved.kpi_sub_title)}`;

const kpiRefKey = (value) => (value?.id ? `kpi:${value.id}` : value?.intake_id ? `line:${value.intake_id}` : "");

const allocationKey = (kpiRef, scope) =>
  [kpiRef, ...ALLOCATION_SCOPE_COLUMNS.map((column) => scope[column] || ""), normalizeMatchText(scope.function)].join("|");

// Open-ended when a date is missing.
const periodsOverlap = (left, right) =>
  (!left.start || !right.end || left.start <= right.end) && (!left.end || !right.start || right.start <= left.end);

const toDateText = (value) => {
  const normalized = normalizeValue(value);
  return normalized ? String(normalized).slice(0, 10) : null;
};

const placeholders = (count) => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ");

// What makes a KPI / an allocation what it is: a line changing a row of the
// database is checked for duplicates only when it changes one of these.
const IDENTITY_COLUMNS = {
  kpi: ["kpi_name", "kpi_sub_title"],
  target_allocation: ["kpi_id", ...ALLOCATION_SCOPE_COLUMNS, "function", "target_start_date", "target_end_date"]
};

// Marks the duplicates among evaluated lines (ordered by line number, oldest
// first: the first one of a pair stays, the later one is the duplicate). A
// line changing a row of the database is never a duplicate of that row.
const markDuplicates = async (db, evaluations) => {
  const clean = (entityType) =>
    evaluations.filter(
      (evaluation) =>
        evaluation.entityType === entityType &&
        !Object.keys(evaluation.errors).length &&
        (!evaluation.recordId || (evaluation.changes || []).some((change) => IDENTITY_COLUMNS[entityType].includes(change.key)))
    );

  const kpiLines = clean("kpi");
  if (kpiLines.length) {
    const existing = await db.query(`SELECT kpi_id, kpi_name, kpi_sub_title, is_active FROM public.kpi ORDER BY kpi_id`);
    const existingByKey = new Map();
    for (const row of existing.rows) {
      const key = kpiKey(row);
      if (!existingByKey.has(key)) existingByKey.set(key, []);
      existingByKey.get(key).push(row);
    }
    const seen = new Map();
    for (const evaluation of kpiLines) {
      const key = kpiKey(evaluation.resolved);
      const match = (existingByKey.get(key) || []).find((row) => Number(row.kpi_id) !== evaluation.recordId);
      if (match) {
        evaluation.duplicate = {
          kpi_id: Number(match.kpi_id),
          message: `This KPI already exists: "${match.kpi_name}"${match.kpi_sub_title ? ` — ${match.kpi_sub_title}` : ""} (#${match.kpi_id}${match.is_active === false ? ", inactive" : ""}).`
        };
      } else if (seen.has(key)) {
        evaluation.duplicate = { intake_id: seen.get(key), message: `Same KPI as intake line #${seen.get(key)}.` };
      } else {
        seen.set(key, evaluation.intakeId);
      }
    }
  }

  const allocationLines = clean("target_allocation");
  if (allocationLines.length) {
    const kpiIds = Array.from(new Set(allocationLines.map((evaluation) => evaluation.resolved.kpi_id?.id).filter(Boolean)));
    const existingByKey = new Map();
    if (kpiIds.length) {
      const existing = await db.query(
        `
        SELECT
          kpi_target_allocation_id, kpi_id, ${ALLOCATION_SCOPE_COLUMNS.join(", ")}, "function",
          target_start_date, target_end_date, target_status
        FROM public.kpi_target_allocation
        WHERE is_active IS TRUE
          AND kpi_id IN (${placeholders(kpiIds.length)})
        ORDER BY kpi_target_allocation_id
        `,
        kpiIds
      );
      for (const row of existing.rows) {
        if (normalizeMatchText(row.target_status) === "inactive") continue;
        const scope = { function: row.function };
        for (const column of ALLOCATION_SCOPE_COLUMNS) scope[column] = row[column] === null ? null : Number(row[column]);
        const key = allocationKey(`kpi:${Number(row.kpi_id)}`, scope);
        if (!existingByKey.has(key)) existingByKey.set(key, []);
        existingByKey.get(key).push({
          id: Number(row.kpi_target_allocation_id),
          start: toDateText(row.target_start_date),
          end: toDateText(row.target_end_date)
        });
      }
    }

    const seen = new Map();
    for (const evaluation of allocationLines) {
      const { resolved } = evaluation;
      const scope = { function: resolved.function };
      for (const column of ALLOCATION_SCOPE_COLUMNS) scope[column] = refId(resolved[column]);
      const key = allocationKey(kpiRefKey(resolved.kpi_id), scope);
      const period = { start: resolved.target_start_date || null, end: resolved.target_end_date || null };

      const existingMatch = (existingByKey.get(key) || []).find(
        (other) => other.id !== evaluation.recordId && periodsOverlap(period, other)
      );
      const earlierLine = (seen.get(key) || []).find((other) => periodsOverlap(period, other));
      if (existingMatch) {
        evaluation.duplicate = {
          kpi_target_allocation_id: existingMatch.id,
          message: `An active allocation of this KPI already covers this scope and period (allocation #${existingMatch.id}).`
        };
      } else if (earlierLine) {
        evaluation.duplicate = { intake_id: earlierLine.intakeId, message: `Same allocation as intake line #${earlierLine.intakeId}.` };
      } else {
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push({ ...period, intakeId: evaluation.intakeId });
      }
    }
  }
};

const statusOf = (evaluation) =>
  Object.keys(evaluation.errors).length ? "error" : evaluation.duplicate ? "duplicate" : "pending";

module.exports = {
  ALLOCATION_SCOPE_COLUMNS,
  MAX_CELL_LENGTH,
  markDuplicates,
  parseDate,
  sanitizeRawValues,
  statusOf,
  toAllocationPayload,
  validateIntakeLine
};
