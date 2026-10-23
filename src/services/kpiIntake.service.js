// KPI & Target Intake (/kpi-intake): responsibles enter new KPIs and new
// target allocations in grids, with names instead of ids; signed-in users also
// see the rows already in the database there and change them. An
// administrator reviews the lines and submits them to public.kpi /
// public.kpi_target_allocation.
//
// Lines wait in public.kpi_app_intake_row (one table for both grids: same life
// cycle, only the column values differ, kept as JSON). Nothing is written to
// public.kpi or public.kpi_target_allocation before an administrator submits.
// A line either creates a row, or changes the row target_record_id: then
// base_values are the row's values the person saw, so the cells they changed
// are known (only those are written) and a cell changed meanwhile in the
// database is caught instead of overwritten. One waiting line per row.
//
// Status of a line: "pending" (ready), "error" (something to fix) or
// "duplicate" while it waits -- recomputed after every change, since a line can
// depend on another one (an allocation of a KPI entered in the KPI grid) --
// then "submitted" (created_record_id = the new kpi_id / allocation id, or the
// row changed) or "rejected". Every write takes the same advisory lock, so
// lines are always checked against a list nobody is changing at the same time.

const { INTAKE_COLUMNS, INTAKE_ENTITY_TYPES, RECORD_INFO_COLUMNS } = require("./kpiIntakeColumns");
const { createIntakeResolver, LIST_REFERENCES, SEARCHED_REFERENCE_NAMES } = require("./kpiIntakeResolver.service");
const { RECORD_ID_COLUMN, RECORD_NOUN, changedKeys, loadRecords } = require("./kpiIntakeRecords.service");
const {
  markDuplicates,
  sanitizeRawValues,
  statusOf,
  toAllocationPayload,
  validateIntakeLine
} = require("./kpiIntakeValidation");
const { createKpiChangeLog } = require("./kpiChangeLog.service");
const { insertKpiRow, upsertPrimarySubjectKpiLink } = require("../models/kpi.model");
const {
  enrichIndividualAllocationScope,
  getKpiObjectInsertValues,
  prepareKpiObjectPayload
} = require("./kpiTargetAllocation.service");
const { normalizeOptionalIntegerInput, normalizeOptionalTextInput } = require("../utils/normalize");
const { createHttpError } = require("../utils/httpError");

const INTAKE_SCHEMA_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS public.kpi_app_intake_row (
    intake_id SERIAL PRIMARY KEY,
    entity_type VARCHAR(30) NOT NULL CHECK (entity_type IN ('kpi', 'target_allocation')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'error', 'duplicate', 'submitted', 'rejected')),
    raw_values JSONB NOT NULL,
    resolved_values JSONB NULL,
    error_messages JSONB NULL,
    row_version INTEGER NOT NULL DEFAULT 1,
    submitted_by_people_id INTEGER NULL,
    submitted_by_name VARCHAR(255) NULL,
    updated_by_people_id INTEGER NULL,
    updated_by_name VARCHAR(255) NULL,
    ip_address VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by_user_id INTEGER NULL,
    reviewed_by_name VARCHAR(255) NULL,
    reviewed_at TIMESTAMPTZ NULL,
    review_comment TEXT NULL,
    created_record_id INTEGER NULL
  )
  `,
  `CREATE INDEX IF NOT EXISTS kpi_app_intake_row_status_idx ON public.kpi_app_intake_row (status, entity_type)`,
  // Lines that change a row already in the database (added after the table).
  `ALTER TABLE public.kpi_app_intake_row ADD COLUMN IF NOT EXISTS target_record_id INTEGER NULL`,
  `ALTER TABLE public.kpi_app_intake_row ADD COLUMN IF NOT EXISTS base_values JSONB NULL`
];

const OPEN_STATUSES = ["pending", "error", "duplicate"];
const OPEN_STATUS_SQL = OPEN_STATUSES.map((status) => `'${status}'`).join(", ");
const MAX_LINES_PER_SAVE = 200;
const MAX_REVIEW_COMMENT = 1000;
const REVIEWED_LIST_LIMIT = 200;
const INTAKE_LOCK_KEY = 72480301;

const placeholders = (count, offset = 0) => Array.from({ length: count }, (_, index) => `$${index + 1 + offset}`).join(", ");

const parseJson = (value) => (typeof value === "string" ? JSON.parse(value) : value ?? null);

const toIso = (value) => (value ? new Date(value).toISOString() : null);

// JSONB does not keep key order: compare with sorted keys.
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

const cellLabel = (value) => (value && typeof value === "object" ? value.label || "" : value || "");

// "Scrap rate — Plant" / "Scrap rate · Kunshan · Plant manager".
const lineLabel = (entityType, values = {}) => {
  if (entityType === "kpi") {
    return [cellLabel(values.kpi_name), cellLabel(values.kpi_sub_title)].filter(Boolean).join(" — ") || "New KPI";
  }
  const place = cellLabel(values.unit_id) || cellLabel(values.plant_id) || cellLabel(values.zone_id) || cellLabel(values.product_line_id);
  return [cellLabel(values.kpi_id).replace(/\s*\(#\d+\)$/, ""), place, cellLabel(values.role_id)].filter(Boolean).join(" · ") ||
    "New allocation";
};

const fromDb = (row) => ({
  ...row,
  intake_id: Number(row.intake_id),
  row_version: Number(row.row_version),
  submitted_by_people_id: row.submitted_by_people_id === null ? null : Number(row.submitted_by_people_id),
  created_record_id: row.created_record_id === null ? null : Number(row.created_record_id),
  target_record_id: row.target_record_id === null || row.target_record_id === undefined ? null : Number(row.target_record_id),
  raw_values: parseJson(row.raw_values) || {},
  base_values: parseJson(row.base_values),
  resolved_values: parseJson(row.resolved_values),
  error_messages: parseJson(row.error_messages)
});

const toClientLine = (row) => ({
  intake_id: row.intake_id,
  entity_type: row.entity_type,
  status: row.status,
  row_version: row.row_version,
  label: lineLabel(row.entity_type, row.raw_values),
  values: row.raw_values,
  // A line changing a row of the database: that row, and its values the person saw.
  record_id: row.target_record_id,
  base: row.target_record_id ? row.base_values || {} : null,
  resolved: row.resolved_values || {},
  errors: row.error_messages?.errors || {},
  conflicts: row.error_messages?.conflicts || [],
  duplicate: row.error_messages?.duplicate || null,
  submitted_by: row.submitted_by_people_id ? { id: row.submitted_by_people_id, label: row.submitted_by_name || "" } : null,
  updated_by_name: row.updated_by_name || null,
  created_at: toIso(row.created_at),
  updated_at: toIso(row.updated_at),
  reviewed_by_name: row.reviewed_by_name || null,
  reviewed_at: toIso(row.reviewed_at),
  review_comment: row.review_comment || null,
  created_record_id: row.created_record_id
});

// KPI lines an allocation may point to before they are submitted (once
// submitted, the allocation points to the KPI created from it).
const toIntakeKpi = (row) => {
  const name = cellLabel(row.raw_values.kpi_name) || "New KPI";
  const subTitle = cellLabel(row.raw_values.kpi_sub_title) || "";
  const title = subTitle ? `${name} — ${subTitle}` : name;
  const createdRecordId = row.status === "submitted" ? row.created_record_id : null;
  return {
    intake_id: row.intake_id,
    status: row.status,
    name,
    subTitle,
    label: createdRecordId ? `${title} (#${createdRecordId})` : `${title} (new KPI, line #${row.intake_id})`,
    created_record_id: createdRecordId
  };
};

// "Plant: Kunshan (#27)" lines of the review, column by column.
const describeResolved = (entityType, resolved = {}) =>
  INTAKE_COLUMNS[entityType]
    .filter((column) => resolved[column.key] !== undefined)
    .map((column) => {
      const value = resolved[column.key];
      return column.type === "ref"
        ? { key: column.key, label: column.label, value: value.label, id: value.id || null, intake_id: value.intake_id || null }
        : { key: column.key, label: column.label, value };
    });

// "Target: 10 -> 12" lines of the review of a line changing a row.
const describeChanges = (entityType, changes = []) =>
  changes.map((change) => ({
    key: change.key,
    label: INTAKE_COLUMNS[entityType].find((column) => column.key === change.key)?.label || change.key,
    from: cellLabel(change.from) || null,
    to: cellLabel(change.to) || null
  }));

const ensureEntityType = (entityType) => {
  if (!INTAKE_ENTITY_TYPES.includes(entityType)) throw createHttpError(400, "Unknown intake table.");
  return entityType;
};

// Rows of the database are for signed-in users only (lines changing them included).
const ensureSignedIn = (user, message = "Sign in to see and change the KPIs already in the database.") => {
  if (!user) throw createHttpError(401, message);
};

// A cell as written to the table: a record id, a number, a text, or NULL.
const toColumnValue = (column, value) => {
  if (value === undefined || value === null || value === "") return null;
  if (column.type === "ref") return value.id || null;
  if (column.type === "number") return Number(value);
  return value;
};

const toIdList = (ids) =>
  Array.isArray(ids)
    ? Array.from(new Set(ids.map((id) => normalizeOptionalIntegerInput(id)).filter((id) => id && id > 0)))
    : [];

const createKpiIntakeService = ({
  db,
  kpiChangeLog = createKpiChangeLog({ db }),
  // Rebuilds the KPI knowledge base, as the other create routes do (injected:
  // kpiKnowledgeBase.service reads many tables).
  refreshKnowledgeBases = async () => {},
  now = () => new Date()
}) => {
  let schemaPromise = null;

  const ensureSchema = () => {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        for (const statement of INTAKE_SCHEMA_STATEMENTS) await db.query(statement);
      })().catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  };

  const inLockedTransaction = async (work) => {
    await ensureSchema();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  // Checks every waiting line (both grids); nothing is written.
  const evaluateOpenLines = async (client) => {
    const result = await client.query(
      `
      SELECT *
      FROM public.kpi_app_intake_row
      WHERE status IN (${OPEN_STATUS_SQL})
         OR (entity_type = 'kpi' AND status = 'submitted')
      ORDER BY intake_id
      `
    );
    const rows = result.rows.map(fromDb);
    // KPIs an allocation may point to before they exist: the lines creating one.
    const intakeKpis = rows.filter((row) => row.entity_type === "kpi" && !row.target_record_id).map(toIntakeKpi);
    const resolver = createIntakeResolver(client);
    const openRows = rows.filter((item) => OPEN_STATUSES.includes(item.status));

    // The rows of the database the waiting lines change, as they are now.
    const records = {};
    for (const entityType of INTAKE_ENTITY_TYPES) {
      const ids = openRows.filter((row) => row.entity_type === entityType && row.target_record_id).map((row) => row.target_record_id);
      records[entityType] = ids.length ? await loadRecords(client, entityType, { ids, resolver }) : new Map();
    }

    const evaluations = [];
    for (const row of openRows) {
      const recordId = row.target_record_id;
      const record = recordId ? records[row.entity_type].get(recordId) : null;
      const line = { row, intakeId: row.intake_id, entityType: row.entity_type, recordId, duplicate: null };
      if (recordId && !record) {
        evaluations.push({
          ...line,
          values: row.raw_values,
          resolved: {},
          errors: { _row: `${RECORD_NOUN[row.entity_type]} #${recordId} no longer exists in the database — delete this line.` },
          prepared: null,
          changes: [],
          conflicts: []
        });
        continue;
      }
      const checked = await validateIntakeLine({
        entityType: row.entity_type,
        values: row.raw_values,
        resolver,
        intakeKpis: row.entity_type === "target_allocation" ? intakeKpis : [],
        submittedByPeopleId: row.submitted_by_people_id,
        record: record ? record.values : null,
        base: record ? row.base_values : null
      });
      evaluations.push({ ...checked, ...line });
    }

    await markDuplicates(client, evaluations);

    // An allocation of a KPI still in the intake waits for that KPI line.
    const kpiLineStatus = new Map(
      evaluations.filter((evaluation) => evaluation.entityType === "kpi").map((evaluation) => [evaluation.intakeId, statusOf(evaluation)])
    );
    for (const evaluation of evaluations) {
      const kpiLineId = evaluation.resolved.kpi_id?.intake_id;
      if (evaluation.entityType !== "target_allocation" || !kpiLineId) continue;
      const kpiStatus = kpiLineStatus.get(kpiLineId);
      if (kpiStatus !== "pending") {
        evaluation.errors.kpi_id = `The KPI of intake line #${kpiLineId} ${
          kpiStatus === "duplicate" ? "is a duplicate" : "has errors"
        } — fix that line first, or pick an existing KPI.`;
      }
    }

    for (const evaluation of evaluations) evaluation.status = statusOf(evaluation);
    return evaluations;
  };

  // Stores the outcome of the checks (and, for the lines just saved, the
  // values as understood: a typed name becomes the record it matched).
  const persistEvaluations = async (client, evaluations, { canonicalIds = new Set() } = {}) => {
    for (const evaluation of evaluations) {
      const errorMessages =
        Object.keys(evaluation.errors).length || evaluation.duplicate
          ? {
            errors: evaluation.errors,
            duplicate: evaluation.duplicate,
            ...(evaluation.conflicts?.length ? { conflicts: evaluation.conflicts } : {})
          }
          : null;
      const canonical = canonicalIds.has(evaluation.intakeId);
      const unchanged =
        !canonical &&
        evaluation.row.status === evaluation.status &&
        stableStringify(evaluation.row.resolved_values) === stableStringify(evaluation.resolved) &&
        stableStringify(evaluation.row.error_messages) === stableStringify(errorMessages);
      if (unchanged) continue;

      const params = [
        evaluation.intakeId,
        evaluation.status,
        JSON.stringify(evaluation.resolved),
        errorMessages ? JSON.stringify(errorMessages) : null
      ];
      if (canonical) params.push(JSON.stringify(evaluation.values));
      await client.query(
        `
        UPDATE public.kpi_app_intake_row
        SET status = $2, resolved_values = $3, error_messages = $4${canonical ? ", raw_values = $5" : ""}
        WHERE intake_id = $1
        `,
        params
      );
    }
  };

  const buildReport = (evaluations) => {
    const report = { kpi: [], target_allocation: [], counts: {} };
    for (const entityType of INTAKE_ENTITY_TYPES) {
      report.counts[entityType] = { ready: 0, duplicate: 0, error: 0 };
    }
    for (const evaluation of evaluations) {
      const counts = report.counts[evaluation.entityType];
      if (evaluation.status === "pending") counts.ready += 1;
      else counts[evaluation.status] += 1;
      report[evaluation.entityType].push({
        intake_id: evaluation.intakeId,
        entity_type: evaluation.entityType,
        status: evaluation.status,
        label: lineLabel(evaluation.entityType, evaluation.recordId ? evaluation.resolved : evaluation.values),
        submitted_by_name: evaluation.row.submitted_by_name || null,
        // A line changing a row of the database: the row, and what changes in it.
        record_id: evaluation.recordId || null,
        changes: describeChanges(evaluation.entityType, evaluation.changes),
        errors: evaluation.errors,
        duplicate: evaluation.duplicate,
        resolved: describeResolved(evaluation.entityType, evaluation.resolved)
      });
    }
    return report;
  };

  // --- Public page ---------------------------------------------------------

  // Columns and the reference lists of the dropdowns (people and customers are searched).
  const getLookups = async () => {
    await ensureSchema();
    const resolver = createIntakeResolver(db);
    const lists = await Promise.all(LIST_REFERENCES.map((name) => resolver.listOptions(name)));
    const intakeKpis = await db.query(
      `
      SELECT *
      FROM public.kpi_app_intake_row
      WHERE entity_type = 'kpi' AND status IN (${OPEN_STATUS_SQL}) AND target_record_id IS NULL
      ORDER BY intake_id
      `
    );
    return {
      columns: INTAKE_COLUMNS,
      record_info_columns: RECORD_INFO_COLUMNS,
      references: Object.fromEntries(LIST_REFERENCES.map((name, index) => [name, lists[index]])),
      searched_references: SEARCHED_REFERENCE_NAMES,
      intake_kpis: intakeKpis.rows.map(fromDb).map(toIntakeKpi).map(({ intake_id: intakeId, label }) => ({ intake_id: intakeId, label }))
    };
  };

  const search = async (name, term) => {
    if (!SEARCHED_REFERENCE_NAMES.includes(name)) throw createHttpError(400, "Unknown list.");
    return createIntakeResolver(db).search(name, term);
  };

  // Every row of a table, as the grid shows it (signed-in users: the route is protected).
  const listRecords = async ({ entityType } = {}) => {
    ensureEntityType(entityType);
    const records = await loadRecords(db, entityType, { resolver: createIntakeResolver(db) });
    return [...records.values()];
  };

  // view "open": lines waiting for review; "reviewed": the last submitted / rejected ones.
  // Lines changing a row of the database are only listed for a signed-in user.
  const listLines = async ({ entityType, view = "open", user = null } = {}) => {
    ensureEntityType(entityType);
    await ensureSchema();
    const onlyNew = user ? "" : "AND target_record_id IS NULL";
    const result =
      view === "reviewed"
        ? await db.query(
          `
          SELECT *
          FROM public.kpi_app_intake_row
          WHERE entity_type = $1 AND status IN ('submitted', 'rejected') ${onlyNew}
          ORDER BY reviewed_at DESC, intake_id DESC
          LIMIT ${REVIEWED_LIST_LIMIT}
          `,
          [entityType]
        )
        : await db.query(
          `
          SELECT *
          FROM public.kpi_app_intake_row
          WHERE entity_type = $1 AND status IN (${OPEN_STATUS_SQL}) ${onlyNew}
          ORDER BY intake_id
          `,
          [entityType]
        );
    return result.rows.map(fromDb).map(toClientLine);
  };

  // Saves new lines and changes to waiting ones (all or nothing). A line
  // changed by someone else since the page loaded it is refused (row_version).
  // A line with record_id changes that row of the database (signed-in users):
  // base = the row's values the page showed. A line that no longer changes
  // anything is dropped (discarded_ids).
  const saveLines = async ({ entityType, submittedBy, lines } = {}, { ip = null, user = null } = {}) => {
    ensureEntityType(entityType);
    if (!Array.isArray(lines) || !lines.length) throw createHttpError(400, "Add at least one line before saving.");
    if (lines.length > MAX_LINES_PER_SAVE) {
      throw createHttpError(400, `Save at most ${MAX_LINES_PER_SAVE} lines at a time.`);
    }

    const prepared = lines
      .map((line) => {
        if (!line || typeof line !== "object") throw createHttpError(400, "Invalid line.");
        const recordId = normalizeOptionalIntegerInput(line.record_id);
        return {
          intakeId: normalizeOptionalIntegerInput(line.intake_id),
          rowVersion: normalizeOptionalIntegerInput(line.row_version),
          recordId,
          values: sanitizeRawValues(entityType, line.values),
          base: recordId && line.base ? sanitizeRawValues(entityType, line.base) : null
        };
      })
      .filter((line) => line.intakeId || line.recordId || Object.keys(line.values).length);
    if (!prepared.length) throw createHttpError(400, "The lines are empty — fill in at least one column.");

    const existingIds = prepared.filter((line) => line.intakeId).map((line) => line.intakeId);
    if (new Set(existingIds).size !== existingIds.length) throw createHttpError(400, "A line was sent twice.");
    const recordIds = prepared.filter((line) => line.recordId).map((line) => line.recordId);
    if (new Set(recordIds).size !== recordIds.length) throw createHttpError(400, "A line was sent twice.");
    if (recordIds.length) ensureSignedIn(user, "Sign in to change the KPIs already in the database.");
    const noun = RECORD_NOUN[entityType];

    const { savedIds, discardedIds } = await inLockedTransaction(async (client) => {
      const resolver = createIntakeResolver(client);
      const person = await resolver.resolve("people", submittedBy, { columnLabel: "Submitted by" });
      if (!person) throw createHttpError(400, 'Pick your name in "Submitted by" before saving.');
      if (person.error) throw createHttpError(400, `Submitted by: ${person.error}`);
      const personName = person.label.slice(0, 255);

      if (existingIds.length) {
        const current = await client.query(
          `SELECT intake_id, entity_type, status, row_version, target_record_id FROM public.kpi_app_intake_row WHERE intake_id IN (${placeholders(existingIds.length)})`,
          existingIds
        );
        const byId = new Map(current.rows.map((row) => [Number(row.intake_id), row]));
        for (const line of prepared.filter((item) => item.intakeId)) {
          const row = byId.get(line.intakeId);
          if (!row || row.entity_type !== entityType) {
            throw createHttpError(409, `Line #${line.intakeId} no longer exists — reload the page.`);
          }
          if (!OPEN_STATUSES.includes(row.status)) {
            throw createHttpError(409, `Line #${line.intakeId} was already ${row.status} by an administrator — reload the page.`);
          }
          if (Number(row.row_version) !== line.rowVersion) {
            throw createHttpError(409, `Line #${line.intakeId} was changed by someone else in the meantime — reload the page to see it.`);
          }
          if ((row.target_record_id === null ? null : Number(row.target_record_id)) !== line.recordId) {
            throw createHttpError(409, `Line #${line.intakeId} does not change ${line.recordId ? `${noun} #${line.recordId}` : "this row"} — reload the page.`);
          }
        }
      }

      if (recordIds.length) {
        const records = await loadRecords(client, entityType, { ids: recordIds, resolver });
        const missing = recordIds.find((id) => !records.has(id));
        if (missing) throw createHttpError(409, `${noun} #${missing} no longer exists in the database — reload the page.`);
        for (const line of prepared.filter((item) => item.recordId && !item.base)) line.base = records.get(line.recordId).values;

        // One waiting line per row: a second person changes the same line.
        const open = await client.query(
          `
          SELECT intake_id, target_record_id
          FROM public.kpi_app_intake_row
          WHERE entity_type = $1 AND status IN (${OPEN_STATUS_SQL})
            AND target_record_id IN (${placeholders(recordIds.length, 1)})
          `,
          [entityType, ...recordIds]
        );
        for (const row of open.rows) {
          const line = prepared.find((item) => item.recordId === Number(row.target_record_id));
          if (line && line.intakeId !== Number(row.intake_id)) {
            throw createHttpError(
              409,
              `${noun} #${line.recordId} is already being changed (line #${row.intake_id}) — reload the page to see that change.`
            );
          }
        }
      }

      const at = now();
      const ids = [];
      const discarded = [];
      for (const line of prepared) {
        const base = line.base ? JSON.stringify(line.base) : null;
        // Back to the row's values: nothing left to change.
        if (line.recordId && !changedKeys(entityType, line.values, line.base).length) {
          if (line.intakeId) {
            await client.query(`DELETE FROM public.kpi_app_intake_row WHERE intake_id = $1`, [line.intakeId]);
            discarded.push(line.intakeId);
          }
          continue;
        }
        if (line.intakeId) {
          await client.query(
            `
            UPDATE public.kpi_app_intake_row
            SET raw_values = $2, base_values = $7, row_version = row_version + 1, updated_by_people_id = $3,
                updated_by_name = $4, updated_at = $5, ip_address = $6
            WHERE intake_id = $1
            `,
            [line.intakeId, JSON.stringify(line.values), person.id, personName, at, ip, base]
          );
          ids.push(line.intakeId);
        } else {
          const inserted = await client.query(
            `
            INSERT INTO public.kpi_app_intake_row (
              entity_type, status, raw_values, row_version, submitted_by_people_id, submitted_by_name,
              updated_by_people_id, updated_by_name, ip_address, created_at, updated_at, target_record_id, base_values
            )
            VALUES ($1, 'pending', $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING intake_id
            `,
            [entityType, JSON.stringify(line.values), person.id, personName, person.id, personName, ip, at, at, line.recordId, base]
          );
          ids.push(Number(inserted.rows[0].intake_id));
        }
      }

      await persistEvaluations(client, await evaluateOpenLines(client), { canonicalIds: new Set(ids) });
      return { savedIds: ids, discardedIds: discarded };
    });

    return { saved_ids: savedIds, discarded_ids: discardedIds, lines: await listLines({ entityType, user }) };
  };

  // A waiting line is deleted -- for a line changing a row of the database, the
  // change is dropped (signed-in users); the row itself is never touched.
  const deleteLine = async (intakeId, { user = null } = {}) => {
    const id = normalizeOptionalIntegerInput(intakeId);
    if (!id) throw createHttpError(400, "Invalid line.");
    await inLockedTransaction(async (client) => {
      const current = await client.query(
        `SELECT target_record_id FROM public.kpi_app_intake_row WHERE intake_id = $1 AND status IN (${OPEN_STATUS_SQL})`,
        [id]
      );
      if (!current.rows.length) {
        throw createHttpError(404, "This line no longer exists or was already reviewed — reload the page.");
      }
      if (current.rows[0].target_record_id !== null) ensureSignedIn(user, "Sign in to drop a change of the KPIs already in the database.");
      await client.query(`DELETE FROM public.kpi_app_intake_row WHERE intake_id = $1`, [id]);
      await persistEvaluations(client, await evaluateOpenLines(client));
    });
    return { deleted: id };
  };

  // --- Administrators --------------------------------------------------------

  // What a submit would do, line by line; nothing is written.
  const preview = async () => {
    await ensureSchema();
    const client = await db.connect();
    try {
      return buildReport(await evaluateOpenLines(client));
    } finally {
      client.release();
    }
  };

  // Writes the changed cells of a line to its row of the database (a subject:
  // the KPI's primary subject link). kpiId: the allocation's KPI when it is one
  // created in the same submit.
  const writeChanges = async (client, evaluation, { kpiId = null } = {}) => {
    const { entityType, recordId } = evaluation;
    const assignments = [];
    const params = [];
    let subjectId = null;
    for (const change of evaluation.changes) {
      const column = INTAKE_COLUMNS[entityType].find((item) => item.key === change.key);
      const value = column.key === "kpi_id" && kpiId ? kpiId : toColumnValue(column, evaluation.resolved[column.key]);
      if (entityType === "kpi" && column.key === "subject") {
        subjectId = value;
        continue;
      }
      params.push(value);
      assignments.push(`"${column.key}" = $${params.length}`);
    }
    if (assignments.length) {
      params.push(recordId);
      const result = await client.query(
        `
        UPDATE public.${entityType === "kpi" ? "kpi" : "kpi_target_allocation"}
        SET ${assignments.join(", ")}, updated_at = NOW()
        WHERE ${RECORD_ID_COLUMN[entityType]} = $${params.length}
        RETURNING ${RECORD_ID_COLUMN[entityType]}
        `,
        params
      );
      if (!result.rows.length) throw createHttpError(409, `${RECORD_NOUN[entityType]} #${recordId} no longer exists.`);
    }
    if (subjectId) await upsertPrimarySubjectKpiLink(client, recordId, subjectId);
  };

  // Writes the ready lines (all, or those of intakeIds): new KPIs, changed
  // KPIs, then new and changed allocations (one may point to a KPI created just
  // before). One transaction: if a line cannot be written, nothing is.
  const submit = async ({ intakeIds } = {}, actor = {}) => {
    const selected = intakeIds === undefined || intakeIds === null ? null : new Set(toIdList(intakeIds));
    if (selected && !selected.size) throw createHttpError(400, "Select at least one line to submit.");

    const reviewer = { userId: actor.userId || null, name: (actor.name || actor.email || "").slice(0, 255) || null };
    const changeLogActor = { ...actor, source: "intake" };

    return inLockedTransaction(async (client) => {
      const evaluations = await evaluateOpenLines(client);
      const chosen = (evaluation) => evaluation.status === "pending" && (!selected || selected.has(evaluation.intakeId));
      const at = now();
      const created = { kpi: [], target_allocation: [] };
      const updated = { kpi: [], target_allocation: [] };
      const skipped = [];
      const kpiIdByLine = new Map();

      // The rows changed, as they were before (audit trail).
      const changing = (entityType) =>
        evaluations.filter((item) => item.entityType === entityType && item.recordId && chosen(item)).map((item) => item.recordId);
      const kpisBefore = await kpiChangeLog.snapshotKpis(client, changing("kpi"));
      const allocationsBefore = await kpiChangeLog.snapshotAllocations(client, changing("target_allocation"));

      const insertLine = async (evaluation, work) => {
        try {
          return await work();
        } catch (error) {
          throw createHttpError(
            422,
            `Intake line #${evaluation.intakeId} (${lineLabel(evaluation.entityType, evaluation.values)}) could not be saved: ${
              error.message
            } Nothing was submitted — fix or reject that line, then submit again.`
          );
        }
      };

      const markSubmitted = (evaluation, recordId, resolved) =>
        client.query(
          `
          UPDATE public.kpi_app_intake_row
          SET status = 'submitted', created_record_id = $2, resolved_values = $3, error_messages = NULL,
              reviewed_by_user_id = $4, reviewed_by_name = $5, reviewed_at = $6
          WHERE intake_id = $1
          `,
          [evaluation.intakeId, recordId, JSON.stringify(resolved), reviewer.userId, reviewer.name, at]
        );

      for (const evaluation of evaluations.filter((item) => item.entityType === "kpi" && !item.recordId && chosen(item))) {
        const kpiId = await insertLine(evaluation, async () => {
          const row = await insertKpiRow(client, evaluation.prepared, {
            createdByPeopleId: evaluation.row.submitted_by_people_id,
            extraColumns: { currency_type: evaluation.resolved.currency_type, type: evaluation.resolved.type }
          });
          if (evaluation.prepared.subject_id) {
            await upsertPrimarySubjectKpiLink(client, row.kpi_id, evaluation.prepared.subject_id);
          }
          return Number(row.kpi_id);
        });
        kpiIdByLine.set(evaluation.intakeId, kpiId);
        created.kpi.push({ intake_id: evaluation.intakeId, kpi_id: kpiId, label: lineLabel("kpi", evaluation.values) });
        await markSubmitted(evaluation, kpiId, evaluation.resolved);
      }

      for (const evaluation of evaluations.filter((item) => item.entityType === "kpi" && item.recordId && chosen(item))) {
        await insertLine(evaluation, () => writeChanges(client, evaluation));
        updated.kpi.push({
          intake_id: evaluation.intakeId,
          kpi_id: evaluation.recordId,
          label: lineLabel("kpi", evaluation.resolved),
          changes: describeChanges("kpi", evaluation.changes)
        });
        await markSubmitted(evaluation, evaluation.recordId, evaluation.resolved);
      }

      for (const evaluation of evaluations.filter((item) => item.entityType === "target_allocation" && chosen(item))) {
        const kpiReference = evaluation.resolved.kpi_id;
        const kpiId = kpiReference.id || kpiIdByLine.get(kpiReference.intake_id);
        if (!kpiId) {
          skipped.push({
            intake_id: evaluation.intakeId,
            reason: `Its KPI (intake line #${kpiReference.intake_id}) was not submitted with it.`
          });
          continue;
        }
        // A KPI created just before: named with its new id.
        const resolvedKpi = kpiReference.id
          ? kpiReference
          : { id: kpiId, label: kpiReference.label.replace(/\s*\(new KPI, line #\d+\)$/, ` (#${kpiId})`) };

        if (evaluation.recordId) {
          await insertLine(evaluation, () => writeChanges(client, evaluation, { kpiId }));
          updated.target_allocation.push({
            intake_id: evaluation.intakeId,
            kpi_target_allocation_id: evaluation.recordId,
            kpi_id: kpiId,
            label: lineLabel("target_allocation", { ...evaluation.resolved, kpi_id: resolvedKpi }),
            changes: describeChanges("target_allocation", evaluation.changes)
          });
          await markSubmitted(evaluation, evaluation.recordId, { ...evaluation.resolved, kpi_id: resolvedKpi });
          continue;
        }

        const allocationId = await insertLine(evaluation, async () => {
          const payload = prepareKpiObjectPayload({
            ...toAllocationPayload(evaluation.resolved, { createdByPeopleId: evaluation.row.submitted_by_people_id }),
            kpi_id: kpiId
          });
          const scoped = await enrichIndividualAllocationScope(client, payload);
          const result = await client.query(
            `
            INSERT INTO public.kpi_target_allocation (
              kpi_id, plant_id, zone_id, unit_id, "function", product_id, product_line_id, market_id, customer_id,
              target_value, target_unit, local_currency, kpi_type, unit_type_id, role_id, target_setup_date,
              target_start_date, target_end_date, last_best_target, previous_target_value, target_status,
              set_by_people_id, created_by_people_id, approved_by_people_id, comments, low_limit, high_limit
            )
            VALUES (${placeholders(27)})
            RETURNING kpi_target_allocation_id
            `,
            [...getKpiObjectInsertValues(scoped), evaluation.resolved.low_limit ?? null, evaluation.resolved.high_limit ?? null]
          );
          return Number(result.rows[0].kpi_target_allocation_id);
        });
        created.target_allocation.push({
          intake_id: evaluation.intakeId,
          kpi_target_allocation_id: allocationId,
          kpi_id: kpiId,
          label: lineLabel("target_allocation", evaluation.values)
        });
        await markSubmitted(evaluation, allocationId, { ...evaluation.resolved, kpi_id: resolvedKpi });
      }

      // The KPI knowledge base follows every KPI touched, once per KPI.
      const refreshed = new Set();
      const refresh = async (kpiIds, reason) => {
        const ids = Array.from(new Set(kpiIds)).filter((kpiId) => !refreshed.has(kpiId));
        ids.forEach((kpiId) => refreshed.add(kpiId));
        if (ids.length) await refreshKnowledgeBases(client, ids, { reason });
      };
      await refresh(created.kpi.map((item) => item.kpi_id), "kpi_created");
      await refresh(updated.kpi.map((item) => item.kpi_id), "kpi_updated");
      await refresh(created.target_allocation.map((item) => item.kpi_id), "target_allocation_created");
      await refresh(updated.target_allocation.map((item) => item.kpi_id), "target_allocation_updated");

      // Audit trail: new rows "created", changed rows "updated" (field by field).
      // Only the rows written are compared (a row left out would read as deleted).
      const written = (before, ids) => new Map([...before].filter(([id]) => ids.includes(id)));
      const kpiIds = [...created.kpi, ...updated.kpi].map((item) => item.kpi_id);
      if (kpiIds.length) {
        await kpiChangeLog.record(client, {
          entityType: "kpi",
          before: written(kpisBefore, kpiIds),
          after: await kpiChangeLog.snapshotKpis(client, kpiIds),
          actor: changeLogActor
        });
      }
      const allocationIds = [...created.target_allocation, ...updated.target_allocation].map((item) => item.kpi_target_allocation_id);
      if (allocationIds.length) {
        await kpiChangeLog.record(client, {
          entityType: "target_allocation",
          before: written(allocationsBefore, allocationIds),
          after: await kpiChangeLog.snapshotAllocations(client, allocationIds),
          actor: changeLogActor
        });
      }

      // The lines left: an allocation of a KPI created now points to it.
      const remaining = await evaluateOpenLines(client);
      await persistEvaluations(client, remaining);
      return { created, updated, skipped, report: buildReport(remaining) };
    });
  };

  const reject = async ({ intakeIds, comment } = {}, actor = {}) => {
    const ids = toIdList(intakeIds);
    if (!ids.length) throw createHttpError(400, "Select at least one line to reject.");
    const note = normalizeOptionalTextInput(comment);
    if (note && note.length > MAX_REVIEW_COMMENT) {
      throw createHttpError(400, `The comment is too long (${MAX_REVIEW_COMMENT} characters at most).`);
    }

    return inLockedTransaction(async (client) => {
      const result = await client.query(
        `
        UPDATE public.kpi_app_intake_row
        SET status = 'rejected', reviewed_by_user_id = $1, reviewed_by_name = $2, reviewed_at = $3, review_comment = $4
        WHERE intake_id IN (${placeholders(ids.length, 4)}) AND status IN (${OPEN_STATUS_SQL})
        RETURNING intake_id
        `,
        [actor.userId || null, (actor.name || actor.email || "").slice(0, 255) || null, now(), note, ...ids]
      );
      await persistEvaluations(client, await evaluateOpenLines(client));
      return { rejected: result.rows.map((row) => Number(row.intake_id)) };
    });
  };

  return { ensureSchema, getLookups, search, listRecords, listLines, saveLines, deleteLine, preview, submit, reject };
};

module.exports = { INTAKE_SCHEMA_STATEMENTS, MAX_LINES_PER_SAVE, createKpiIntakeService };
