// Traceability of KPI and target allocation changes (administration, tab
// "KPI audit trail"): what was created, updated or deleted, when, and by whom.
//
// Each route that writes public.kpi or public.kpi_target_allocation takes a
// snapshot of the rows it touches right after BEGIN and again just before
// COMMIT, then calls record() with both: new ids are "created", vanished ids
// "deleted", the others "updated" with the fields that changed (from -> to).
// The trace is written in the same transaction, so a change is never saved
// without it. Only public.kpi_app_change_log is written here.

const CHANGE_LOG_SCHEMA_STATEMENTS = [
  `
  CREATE TABLE IF NOT EXISTS public.kpi_app_change_log (
    change_id SERIAL PRIMARY KEY,
    entity_type VARCHAR(30) NOT NULL CHECK (entity_type IN ('kpi', 'target_allocation')),
    entity_id INTEGER NOT NULL,
    kpi_id INTEGER NULL,
    action VARCHAR(20) NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
    label TEXT NOT NULL DEFAULT '',
    owner_people_id INTEGER NULL,
    owner_name VARCHAR(255) NULL,
    actor_user_id INTEGER NULL,
    actor_people_id INTEGER NULL,
    actor_name VARCHAR(255) NULL,
    actor_email VARCHAR(255) NULL,
    source VARCHAR(30) NOT NULL,
    changes JSONB NULL,
    note TEXT NULL,
    ip_address VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
  `,
  `CREATE INDEX IF NOT EXISTS kpi_app_change_log_created_idx ON public.kpi_app_change_log (created_at)`
];

// Where a change was made.
const SOURCES = ["dashboard", "kpi_admin", "target_review"];

// Columns never compared: timestamps, and the KPI knowledge base the app
// regenerates on every save.
const IGNORED_FIELDS = new Set(["created_at", "updated_at", "kpi_knowledge_base", "kpi_knowledge_updated_date"]);

// Fields kept on a "created" / "deleted" entry, to know what the row was.
const SUMMARY_FIELDS = {
  kpi: ["kpi_code", "unit", "frequency", "target_value", "target_direction", "low_limit", "high_limit", "status"],
  target_allocation: [
    "kpi_type",
    "target_value",
    "target_unit",
    "low_limit",
    "high_limit",
    "target_start_date",
    "target_end_date",
    "target_status"
  ]
};

const MAX_TEXT = 500;

const pad = (value) => String(value).padStart(2, "0");

// Comparable, JSON-friendly value: numbers without trailing zeros ("3.0000" ->
// "3"), dates as YYYY-MM-DD, long texts shortened, empty as null.
const normalizeValue = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // DATE columns come back at midnight (local time with node-postgres).
    if (value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0 && value.getMilliseconds() === 0) {
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    if (value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0) {
      return value.toISOString().slice(0, 10);
    }
    return value.toISOString();
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "object") return JSON.stringify(value).slice(0, MAX_TEXT);
  const text = String(value).trim();
  if (!text) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return String(Number(text));
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
};

const isTrackedField = (field) => !IGNORED_FIELDS.has(field) && !field.startsWith("_");

const diffRows = (before, after) => {
  const changes = {};
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!isTrackedField(field)) continue;
    const from = normalizeValue(before[field]);
    const to = normalizeValue(after[field]);
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
};

const summarize = (entityType, row, side) => {
  const changes = {};
  for (const field of SUMMARY_FIELDS[entityType]) {
    const value = normalizeValue(row[field]);
    if (value !== null) changes[field] = side === "to" ? { from: null, to: value } : { from: value, to: null };
  }
  return changes;
};

const personName = (firstName, name) => [firstName, name].filter(Boolean).join(" ").trim();

const placeholders = (count, offset = 0) => Array.from({ length: count }, (_, index) => `$${index + 1 + offset}`).join(", ");

const toIds = (ids) =>
  Array.from(new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));

// Who made the change, from the request: the signed-in account if any.
const actorFromRequest = (req, source) => {
  const user = req?.auth?.user;
  return {
    source,
    userId: user?.user_id || null,
    peopleId: user?.people_id || null,
    name: user?.full_name || null,
    email: user?.email || null,
    ip: req?.ip || req?.socket?.remoteAddress || null
  };
};

const createKpiChangeLog = ({ db }) => {
  let schemaPromise = null;

  const ensureSchema = () => {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        for (const statement of CHANGE_LOG_SCHEMA_STATEMENTS) await db.query(statement);
      })().catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  };

  // Map id -> row (with _label / _owner_* for display) of the given KPIs.
  const snapshotKpis = async (client, ids) => {
    const kpiIds = toIds(ids);
    if (!kpiIds.length) return new Map();
    const result = await client.query(
      `
      SELECT k.*, p.first_name AS _owner_first_name, p.name AS _owner_last_name
      FROM public.kpi k
      LEFT JOIN public.people p ON p.people_id = k.created_by_people_id
      WHERE k.kpi_id IN (${placeholders(kpiIds.length)})
      `,
      kpiIds
    );
    return new Map(
      result.rows.map((row) => [
        Number(row.kpi_id),
        {
          ...row,
          _id: Number(row.kpi_id),
          _kpi_id: Number(row.kpi_id),
          _label: row.kpi_name || `KPI ${row.kpi_id}`,
          _owner_people_id: row.created_by_people_id,
          _owner_name: personName(row._owner_first_name, row._owner_last_name)
        }
      ])
    );
  };

  // Map id -> row of the given target allocations, labelled "KPI · scope".
  const snapshotAllocations = async (client, ids) => {
    const allocationIds = toIds(ids);
    if (!allocationIds.length) return new Map();
    const result = await client.query(
      `
      SELECT
        kta.*,
        k.kpi_name AS _kpi_name,
        u.unit_name AS _unit_name,
        pl.unit_name AS _plant_name,
        z.zone_name AS _zone_name,
        r.role_name AS _role_name,
        p.first_name AS _owner_first_name,
        p.name AS _owner_last_name
      FROM public.kpi_target_allocation kta
      LEFT JOIN public.kpi k ON k.kpi_id = kta.kpi_id
      LEFT JOIN public.unit u ON u.unit_id = kta.unit_id
      LEFT JOIN public.unit pl ON pl.unit_id = kta.plant_id
      LEFT JOIN public.zone z ON z.zone_id = kta.zone_id
      LEFT JOIN public.role r ON r.role_id = kta.role_id
      LEFT JOIN public.people p ON p.people_id = kta.set_by_people_id
      WHERE kta.kpi_target_allocation_id IN (${placeholders(allocationIds.length)})
      `,
      allocationIds
    );
    return new Map(
      result.rows.map((row) => {
        // "KPI · where · role", e.g. "Energy Cost · Chennai · Maintenance Manager".
        const place = row._unit_name || row._plant_name || row._zone_name || "";
        return [
          Number(row.kpi_target_allocation_id),
          {
            ...row,
            _id: Number(row.kpi_target_allocation_id),
            _kpi_id: row.kpi_id === null ? null : Number(row.kpi_id),
            _label: [row._kpi_name || `KPI ${row.kpi_id}`, place, row._role_name].filter(Boolean).join(" · "),
            _owner_people_id: row.set_by_people_id,
            _owner_name: personName(row._owner_first_name, row._owner_last_name)
          }
        ];
      })
    );
  };

  // Ids of the target allocations of a KPI (deleted along with it).
  const allocationIdsOfKpi = async (client, kpiId) => {
    const result = await client.query(
      `SELECT kpi_target_allocation_id FROM public.kpi_target_allocation WHERE kpi_id = $1`,
      [kpiId]
    );
    return result.rows.map((row) => Number(row.kpi_target_allocation_id));
  };

  // A person without an account (e.g. the approver of an e-mail link): name it.
  const resolveActor = async (client, actor) => {
    if (actor.name || actor.email || !actor.peopleId) return actor;
    const result = await client.query(`SELECT first_name, name, email FROM public.people WHERE people_id = $1`, [
      actor.peopleId
    ]);
    const person = result.rows[0];
    return person ? { ...actor, name: personName(person.first_name, person.name), email: person.email || null } : actor;
  };

  // Writes one entry per created / updated / deleted row; returns how many.
  const record = async (client, { entityType, before, after, actor, note = null }) => {
    if (!SUMMARY_FIELDS[entityType]) throw new Error(`Unknown change log entity: ${entityType}`);
    if (!SOURCES.includes(actor?.source)) throw new Error(`Unknown change log source: ${actor?.source}`);

    const entries = [];
    for (const [id, row] of after) {
      const previous = before.get(id);
      if (!previous) entries.push({ action: "created", row, changes: summarize(entityType, row, "to") });
      else {
        const changes = diffRows(previous, row);
        if (Object.keys(changes).length) entries.push({ action: "updated", row, changes });
      }
    }
    for (const [id, row] of before) {
      if (!after.has(id)) entries.push({ action: "deleted", row, changes: summarize(entityType, row, "from") });
    }
    if (!entries.length) return 0;

    await ensureSchema();
    const who = await resolveActor(client, actor);
    for (const entry of entries) {
      await client.query(
        `
        INSERT INTO public.kpi_app_change_log (
          entity_type, entity_id, kpi_id, action, label, owner_people_id, owner_name,
          actor_user_id, actor_people_id, actor_name, actor_email, source, changes, note, ip_address
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `,
        [
          entityType,
          entry.row._id,
          entry.row._kpi_id,
          entry.action,
          entry.row._label || "",
          entry.row._owner_people_id || null,
          entry.row._owner_name || null,
          who.userId || null,
          who.peopleId || null,
          who.name || null,
          who.email || null,
          who.source,
          JSON.stringify(entry.changes),
          entry.action === "deleted" ? note : null,
          who.ip || null
        ]
      );
    }
    return entries.length;
  };

  // Newest first, for the administration.
  const list = async ({ entityType, action, search, limit } = {}) => {
    await ensureSchema();
    const term = String(search || "").trim().toLowerCase();
    const result = await db.query(
      `
      SELECT *
      FROM public.kpi_app_change_log
      WHERE ($1::text IS NULL OR entity_type = $1)
        AND ($2::text IS NULL OR action = $2)
        AND (
          $3::text IS NULL
          OR LOWER(label) LIKE $3
          OR LOWER(COALESCE(owner_name, '')) LIKE $3
          OR LOWER(COALESCE(actor_name, '')) LIKE $3
          OR LOWER(COALESCE(actor_email, '')) LIKE $3
        )
      ORDER BY created_at DESC, change_id DESC
      LIMIT $4
      `,
      [
        SUMMARY_FIELDS[entityType] ? entityType : null,
        ["created", "updated", "deleted"].includes(action) ? action : null,
        term ? `%${term.slice(0, 100)}%` : null,
        Math.min(Math.max(Number(limit) || 300, 1), 1000)
      ]
    );
    return result.rows.map((row) => ({
      change_id: row.change_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      kpi_id: row.kpi_id,
      action: row.action,
      label: row.label,
      owner: row.owner_people_id ? { people_id: row.owner_people_id, full_name: row.owner_name || "" } : null,
      actor: {
        user_id: row.actor_user_id,
        people_id: row.actor_people_id,
        name: row.actor_name || "",
        email: row.actor_email || ""
      },
      source: row.source,
      changes: typeof row.changes === "string" ? JSON.parse(row.changes) : row.changes || {},
      note: row.note,
      ip_address: row.ip_address,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null
    }));
  };

  return { ensureSchema, snapshotKpis, snapshotAllocations, allocationIdsOfKpi, record, list };
};

module.exports = { CHANGE_LOG_SCHEMA_STATEMENTS, actorFromRequest, createKpiChangeLog, normalizeValue };
