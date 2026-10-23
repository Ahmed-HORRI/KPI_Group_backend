// Names -> ids for the KPI & Target Intake page (/kpi-intake).
//
// Responsibles fill in names (a KPI, a plant, a person...), never ids. Every
// reference column of kpiIntakeColumns.js points to one of the lists below. A
// value is either picked in the page -- it then carries its id, checked again
// here -- or typed / pasted from Excel as text, matched regardless of case,
// accents, spacing or dash style: first on the full label, then on the bare name.
// Nothing is ever picked silently: no match is "Unknown", several matches are
// "Ambiguous" (with the candidates), and the line cannot be submitted.
//
// Names are not unique in the database: "Finance" is a department of every
// plant, customers and people have namesakes, a few KPI names are used twice.
// Labels therefore carry what tells records apart ("Finance — Kunshan",
// "Ahmed HORRI — ahmed.horri@avocarbon.com", "Scrap rate — Plant (#12)").
//
// people and customer are too long to send whole to a public page: the page
// searches them (search()), and they are looked up one by one here.

const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { getPeopleDisplayName, loadSubjectHierarchyData } = require("../models/kpi.model");
const { filterActiveSubjectTree } = require("../utils/subjectHierarchy");

// As the subject picker of the KPI dashboard: a KPI is filed under a final subject.
const SUBJECT_TREE_MAX_LEVELS = 5;
const SEARCH_LIMIT = 20;
const MAX_CANDIDATES_SHOWN = 5;

// "(#123)" at the end of a label: the record id itself.
const ID_SUFFIX = /\(#(\d+)\)\s*$/;
const EMAIL_PATTERN = /[^\s<>()[\]]+@[^\s<>()[\]]+\.[a-z]{2,}/i;

// Comparable text: no case, accents, double spaces or dash variants.
const normalizeMatchText = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// Same, for a comparison made by the database (which keeps the accents).
const lowerText = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const joinLabel = (name, detail) => (detail ? `${name} — ${detail}` : name);

// Several records with the same label: the id tells them apart.
const withUniqueLabels = (items) => {
  const counts = new Map();
  for (const item of items) {
    const key = normalizeMatchText(item.label);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return items.map((item) =>
    counts.get(normalizeMatchText(item.label)) > 1 ? { ...item, label: `${item.label} (#${item.id})` } : item
  );
};

const byLabel = (left, right) => left.label.localeCompare(right.label);

// Units feed two lists: plants (no departments) and units (all).
const loadUnits = async (db) => {
  const result = await db.query(`
    SELECT
      u.unit_id,
      u.unit_name,
      parent.unit_name AS parent_name,
      ut.unit_type_name
    FROM public.unit u
    LEFT JOIN public.unit parent ON parent.unit_id = u.parent_unit_id
    LEFT JOIN public.unit_type ut ON ut.unit_type_id = u.unit_type_id
    ORDER BY u.unit_name, u.unit_id
  `);
  return result.rows.map((row) => {
    const name = normalizeOptionalTextInput(row.unit_name) || `Unit ${row.unit_id}`;
    const isDepartment = normalizeMatchText(row.unit_type_name) === "department";
    return {
      id: Number(row.unit_id),
      // A department is named after its plant: "Finance — Kunshan".
      label: isDepartment ? joinLabel(name, normalizeOptionalTextInput(row.parent_name)) : name,
      names: [name],
      isDepartment
    };
  });
};

const simpleList = (sql, { idColumn, nameColumn, aliasColumns = [] }) => async (db) => {
  const result = await db.query(sql);
  return result.rows.map((row) => {
    const name = normalizeOptionalTextInput(row[nameColumn]) || `#${row[idColumn]}`;
    return {
      id: Number(row[idColumn]),
      label: name,
      names: [name, ...aliasColumns.map((column) => normalizeOptionalTextInput(row[column])).filter(Boolean)]
    };
  });
};

// Lists sent whole to the page and matched in memory.
const LIST_LOADERS = {
  kpi: async (db) => {
    const result = await db.query(`
      SELECT kpi_id, kpi_name, kpi_sub_title
      FROM public.kpi
      WHERE is_active IS TRUE
      ORDER BY kpi_name, kpi_id
    `);
    return result.rows.map((row) => {
      const name = normalizeOptionalTextInput(row.kpi_name) || `KPI ${row.kpi_id}`;
      const subTitle = normalizeOptionalTextInput(row.kpi_sub_title);
      return {
        id: Number(row.kpi_id),
        label: `${joinLabel(name, subTitle)} (#${row.kpi_id})`,
        names: [name, joinLabel(name, subTitle)]
      };
    });
  },
  subject: async (db) => {
    const { tree } = await loadSubjectHierarchyData(db);
    const finals = [];
    const walk = (nodes, level) => {
      for (const node of nodes) {
        if (!node.children?.length || level >= SUBJECT_TREE_MAX_LEVELS - 1) {
          finals.push({ id: Number(node.id), label: node.full_path || node.name, names: [node.name] });
        } else {
          walk(node.children, level + 1);
        }
      }
    };
    walk(filterActiveSubjectTree(tree), 0);
    return finals;
  },
  plant: async (db) => (await loadUnits(db)).filter((unit) => !unit.isDepartment),
  unit: loadUnits,
  zone: simpleList(`SELECT zone_id, zone_name FROM public.zone ORDER BY zone_name`, {
    idColumn: "zone_id",
    nameColumn: "zone_name"
  }),
  unit_type: simpleList(`SELECT unit_type_id, unit_type_name FROM public.unit_type ORDER BY unit_type_name`, {
    idColumn: "unit_type_id",
    nameColumn: "unit_type_name"
  }),
  role: simpleList(
    `SELECT role_id, role_name FROM public.role WHERE COALESCE(is_active, TRUE) = TRUE ORDER BY role_name`,
    { idColumn: "role_id", nameColumn: "role_name" }
  ),
  product_line: simpleList(
    `SELECT product_line_id, product_line_name, product_line_code FROM public.product_line ORDER BY product_line_name`,
    { idColumn: "product_line_id", nameColumn: "product_line_name", aliasColumns: ["product_line_code"] }
  ),
  product: simpleList(
    `SELECT product_id, product_name, product_code FROM public.product ORDER BY product_name`,
    { idColumn: "product_id", nameColumn: "product_name", aliasColumns: ["product_code"] }
  ),
  market: simpleList(`SELECT market_id, market_name FROM public.market ORDER BY market_name`, {
    idColumn: "market_id",
    nameColumn: "market_name"
  })
};

const personItem = (row) => {
  const name = getPeopleDisplayName(row) || `Person ${row.people_id}`;
  const email = normalizeOptionalTextInput(row.email);
  return {
    id: Number(row.people_id),
    label: email ? joinLabel(name, email) : `${name} (#${row.people_id})`,
    names: [name]
  };
};

const customerItem = (row) => {
  const name = normalizeOptionalTextInput(row.customer_name) || `Customer ${row.customer_id}`;
  const code = normalizeOptionalTextInput(row.customer_code);
  const country = normalizeOptionalTextInput(row.country);
  return {
    id: Number(row.customer_id),
    label: `${joinLabel(code ? `${name} [${code}]` : name, country)} (#${row.customer_id})`,
    names: [name]
  };
};

const PEOPLE_COLUMNS = `p.people_id, p.first_name, p.name, p.email`;
const CUSTOMER_COLUMNS = `c.customer_id, c.customer_name, c.customer_code, c.country`;
const ACTIVE_CUSTOMER = `COALESCE(c.is_deleted, FALSE) = FALSE`;

// Lists looked up one record at a time (and searched by the page).
const SEARCHED_REFERENCES = {
  people: {
    toItem: personItem,
    byId: (db, id) =>
      db.query(`SELECT ${PEOPLE_COLUMNS} FROM public.people p WHERE p.people_id = $1`, [id]),
    byText: (db, text) => {
      const email = EMAIL_PATTERN.exec(text)?.[0];
      if (email) {
        return db.query(
          `SELECT ${PEOPLE_COLUMNS} FROM public.people p WHERE LOWER(COALESCE(p.email, '')) = $1 ORDER BY p.people_id LIMIT 10`,
          [email.toLowerCase()]
        );
      }
      return db.query(
        `
        SELECT ${PEOPLE_COLUMNS}
        FROM public.people p
        WHERE LOWER(TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.name, ''))) = $1
           OR LOWER(TRIM(COALESCE(p.name, '') || ' ' || COALESCE(p.first_name, ''))) = $1
        ORDER BY p.people_id
        LIMIT 10
        `,
        [lowerText(text)]
      );
    },
    search: (db, term) =>
      db.query(
        `
        SELECT ${PEOPLE_COLUMNS}
        FROM public.people p
        WHERE (COALESCE(p.first_name, '') || ' ' || COALESCE(p.name, '')) ILIKE $1
           OR (COALESCE(p.name, '') || ' ' || COALESCE(p.first_name, '')) ILIKE $1
           OR COALESCE(p.email, '') ILIKE $1
        ORDER BY p.name, p.first_name, p.people_id
        LIMIT $2
        `,
        [`%${term}%`, SEARCH_LIMIT]
      )
  },
  customer: {
    toItem: customerItem,
    byId: (db, id) =>
      db.query(`SELECT ${CUSTOMER_COLUMNS} FROM public.customer c WHERE c.customer_id = $1 AND ${ACTIVE_CUSTOMER}`, [id]),
    byText: (db, text) =>
      db.query(
        `
        SELECT ${CUSTOMER_COLUMNS}
        FROM public.customer c
        WHERE ${ACTIVE_CUSTOMER}
          AND (LOWER(TRIM(c.customer_name)) = $1 OR LOWER(TRIM(COALESCE(c.customer_code, ''))) = $1)
        ORDER BY c.customer_id
        LIMIT 10
        `,
        [lowerText(text)]
      ),
    search: (db, term) =>
      db.query(
        `
        SELECT ${CUSTOMER_COLUMNS}
        FROM public.customer c
        WHERE ${ACTIVE_CUSTOMER}
          AND (c.customer_name ILIKE $1 OR COALESCE(c.customer_code, '') ILIKE $1)
        ORDER BY c.customer_name, c.customer_id
        LIMIT $2
        `,
        [`%${term}%`, SEARCH_LIMIT]
      )
  }
};

const REFERENCE_NAMES = [...Object.keys(LIST_LOADERS), ...Object.keys(SEARCHED_REFERENCES)];

const inIds = (count) => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ");

// Records a row of the database points to but the lists above leave out
// (inactive KPI or role, deleted customer, subject that is not final...):
// named by id, so the row shows them as they are. -> [[id, label]]
const RECORD_LABEL_LOADERS = {
  kpi: async (db, ids) => {
    const result = await db.query(
      `SELECT kpi_id, kpi_name, kpi_sub_title FROM public.kpi WHERE kpi_id IN (${inIds(ids.length)})`,
      ids
    );
    return result.rows.map((row) => {
      const name = normalizeOptionalTextInput(row.kpi_name) || `KPI ${row.kpi_id}`;
      return [Number(row.kpi_id), `${joinLabel(name, normalizeOptionalTextInput(row.kpi_sub_title))} (#${row.kpi_id})`];
    });
  },
  subject: async (db, ids) => {
    const { pathById } = await loadSubjectHierarchyData(db);
    return ids.filter((id) => pathById.has(String(id))).map((id) => [id, pathById.get(String(id))]);
  },
  role: async (db, ids) => {
    const result = await db.query(
      `SELECT role_id, role_name FROM public.role WHERE role_id IN (${inIds(ids.length)})`,
      ids
    );
    return result.rows.map((row) => [Number(row.role_id), normalizeOptionalTextInput(row.role_name) || `#${row.role_id}`]);
  },
  people: async (db, ids) => {
    const result = await db.query(`SELECT ${PEOPLE_COLUMNS} FROM public.people p WHERE p.people_id IN (${inIds(ids.length)})`, ids);
    return result.rows.map(personItem).map((item) => [item.id, item.label]);
  },
  customer: async (db, ids) => {
    const result = await db.query(
      `SELECT ${CUSTOMER_COLUMNS} FROM public.customer c WHERE c.customer_id IN (${inIds(ids.length)})`,
      ids
    );
    return result.rows.map(customerItem).map((item) => [item.id, item.label]);
  }
};

// A cell value as stored: { id, intake_id, label } (picked) or text (typed).
const toReferenceInput = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const id = normalizeOptionalIntegerInput(value.id);
    const intakeId = normalizeOptionalIntegerInput(value.intake_id);
    const label = normalizeOptionalTextInput(value.label);
    if (!id && !intakeId && !label) return null;
    return { id: id || null, intake_id: intakeId || null, label };
  }
  const label = normalizeOptionalTextInput(value);
  return label ? { id: null, intake_id: null, label } : null;
};

const describeCandidates = (items) => {
  const shown = items.slice(0, MAX_CANDIDATES_SHOWN).map((item) => item.label);
  return items.length > shown.length ? `${shown.join("; ")}; …` : shown.join("; ");
};

const unknown = (columnLabel, text) => ({ error: `Unknown ${columnLabel}: "${text}".` });
const ambiguous = (columnLabel, text, items) => ({
  error: `"${text}" matches ${items.length} ${columnLabel} records — pick one: ${describeCandidates(items)}.`,
  candidates: items.slice(0, MAX_CANDIDATES_SHOWN).map(({ id, label }) => ({ id, label }))
});

// One resolver per operation (save, preview, submit): lists are loaded once,
// on first use, with the operation's connection (inside its transaction).
const createIntakeResolver = (db) => {
  const lists = new Map();
  const lookups = new Map();

  const getList = (name) => {
    if (!lists.has(name)) {
      lists.set(
        name,
        LIST_LOADERS[name](db).then((items) => {
          const ordered = withUniqueLabels(items).sort(byLabel);
          const index = { items: ordered, byId: new Map(), byLabel: new Map(), byName: new Map() };
          for (const item of ordered) {
            index.byId.set(item.id, item);
            index.byLabel.set(normalizeMatchText(item.label), item);
            for (const name of new Set(item.names.map(normalizeMatchText))) {
              if (!index.byName.has(name)) index.byName.set(name, []);
              index.byName.get(name).push(item);
            }
          }
          return index;
        })
      );
    }
    return lists.get(name);
  };

  const lookup = (name, kind, key) => {
    const cacheKey = `${name}|${kind}|${typeof key === "string" ? lowerText(key) : key}`;
    if (!lookups.has(cacheKey)) {
      const reference = SEARCHED_REFERENCES[name];
      lookups.set(
        cacheKey,
        reference[kind](db, key).then((result) => withUniqueLabels(result.rows.map(reference.toItem)))
      );
    }
    return lookups.get(cacheKey);
  };

  // In-memory list: label first, then the bare names.
  const matchInList = async (name, text) => {
    const index = await getList(name);
    const normalized = normalizeMatchText(text);
    const exact = index.byLabel.get(normalized);
    if (exact) return [exact];
    return index.byName.get(normalized) || [];
  };

  // KPI lines of the intake, referenced by an allocation before they are
  // submitted. A line already found to be a duplicate is not a candidate.
  const matchIntakeKpis = (intakeKpis, text) => {
    const normalized = normalizeMatchText(text);
    return intakeKpis.filter(
      (kpi) =>
        kpi.status !== "duplicate" &&
        [kpi.label, kpi.name, joinLabel(kpi.name, kpi.subTitle)].some((value) => normalizeMatchText(value) === normalized)
    );
  };

  // -> { id, label } | { intake_id, label } | { error, candidates? } | null (empty)
  const resolve = async (name, value, { columnLabel = name, allowIntake = false, intakeKpis = [] } = {}) => {
    const input = toReferenceInput(value);
    if (!input) return null;
    const label = columnLabel.toLowerCase();

    if (input.intake_id) {
      if (!allowIntake) return { error: `Pick an existing ${label}.` };
      const intakeKpi = intakeKpis.find((kpi) => kpi.intake_id === input.intake_id);
      if (!intakeKpi) return { error: `The KPI of intake line #${input.intake_id} was rejected or deleted — pick the KPI again.` };
      if (intakeKpi.created_record_id) return { id: intakeKpi.created_record_id, label: intakeKpi.label };
      return { intake_id: intakeKpi.intake_id, label: intakeKpi.label };
    }

    const idFromLabel = input.id || normalizeOptionalIntegerInput(ID_SUFFIX.exec(input.label || "")?.[1]);
    if (idFromLabel) {
      const item = SEARCHED_REFERENCES[name]
        ? (await lookup(name, "byId", idFromLabel))[0]
        : (await getList(name)).byId.get(idFromLabel);
      if (!item) {
        return {
          error:
            name === "plant"
              ? `"${input.label || `#${idFromLabel}`}" is not a plant — pick a plant (departments are units).`
              : `${columnLabel} "${input.label || `#${idFromLabel}`}" no longer exists — pick it again.`
        };
      }
      return { id: item.id, label: item.label };
    }

    const text = input.label;
    const matches = SEARCHED_REFERENCES[name]
      ? await lookup(name, "byText", text)
      : await matchInList(name, text);

    if (!matches.length && allowIntake) {
      const intakeMatches = matchIntakeKpis(intakeKpis, text);
      if (intakeMatches.length === 1) {
        const [intakeKpi] = intakeMatches;
        return intakeKpi.created_record_id
          ? { id: intakeKpi.created_record_id, label: intakeKpi.label }
          : { intake_id: intakeKpi.intake_id, label: intakeKpi.label };
      }
      if (intakeMatches.length > 1) {
        return ambiguous(label, text, intakeMatches.map((kpi) => ({ id: `line ${kpi.intake_id}`, label: kpi.label })));
      }
    }

    if (!matches.length && name === "plant") {
      // A department typed as a plant: say so rather than "unknown".
      const units = await matchInList("unit", text);
      if (units.length) return { error: `"${text}" is a department, not a plant — put it in Unit and pick its plant.` };
    }

    if (!matches.length) return unknown(label, text);
    if (matches.length > 1) return ambiguous(label, text, matches);
    const [match] = matches;
    return { id: match.id, label: match.label };
  };

  // Lists for the page's dropdowns.
  const listOptions = async (name) => (await getList(name)).items.map(({ id, label }) => ({ id, label }));

  // Labels of the records rows of the database point to: those of the lists
  // when they are in them (a plant that is a department: as a unit), the others
  // read by id. -> Map id -> label ("#id" for an id pointing to nothing).
  const labelsOf = async (name, ids) => {
    const wanted = Array.from(new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)));
    const labels = new Map();
    if (!wanted.length) return labels;
    const listName = name === "plant" ? "unit" : name;
    if (LIST_LOADERS[listName]) {
      const index = await getList(listName);
      for (const id of wanted) {
        if (index.byId.has(id)) labels.set(id, index.byId.get(id).label);
      }
    }
    const missing = wanted.filter((id) => !labels.has(id));
    if (missing.length && RECORD_LABEL_LOADERS[name]) {
      for (const [id, label] of await RECORD_LABEL_LOADERS[name](db, missing)) labels.set(id, label);
    }
    for (const id of wanted) {
      if (!labels.has(id)) labels.set(id, `#${id}`);
    }
    return labels;
  };

  const search = async (name, term) => {
    const text = String(term || "").trim().slice(0, 100);
    if (text.length < 2 || !SEARCHED_REFERENCES[name]) return [];
    const result = await SEARCHED_REFERENCES[name].search(db, text);
    return withUniqueLabels(result.rows.map(SEARCHED_REFERENCES[name].toItem)).map(({ id, label }) => ({ id, label }));
  };

  return { resolve, listOptions, search, labelsOf };
};

module.exports = {
  LIST_REFERENCES: Object.freeze(Object.keys(LIST_LOADERS)),
  SEARCHED_REFERENCE_NAMES: Object.freeze(Object.keys(SEARCHED_REFERENCES)),
  REFERENCE_NAMES,
  createIntakeResolver,
  normalizeMatchText,
  toReferenceInput
};
