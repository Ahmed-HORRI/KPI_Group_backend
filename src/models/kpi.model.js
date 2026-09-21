const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");

const getKpiStoredFileName = (storedPath) => {
  const normalizedPath = normalizeOptionalTextInput(storedPath);
  if (!normalizedPath) return "";

  const cleanedPath = normalizedPath.split("?")[0].replace(/\\/g, "/");
  const parts = cleanedPath.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
};

const getKpiDisplayFileName = (storedPath) => {
  const storedFileName = getKpiStoredFileName(storedPath);
  if (!storedFileName) return "";

  return storedFileName.replace(/^kpi-\d+-\d+-/, "") || storedFileName;
};

const buildKpiFilePublicUrl = (kpiId, storedPath) => {
  const normalizedPath = normalizeOptionalTextInput(storedPath);
  if (!normalizedPath) return null;

  if (/^(https?:)?\/\//i.test(normalizedPath) || normalizedPath.startsWith("/")) {
    return normalizedPath;
  }

  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  if (!normalizedKpiId) return null;

  const fileNameSegment = encodeURIComponent(
    getKpiDisplayFileName(normalizedPath) ||
    getKpiStoredFileName(normalizedPath) ||
    "kpi-file"
  );

  return `/api/kpis/${normalizedKpiId}/file/${fileNameSegment}`;
};

const getPeopleDisplayName = (row = {}) => {
  const firstName = normalizeOptionalTextInput(row.first_name);
  const name = normalizeOptionalTextInput(row.name);

  if (firstName && name && firstName !== name) {
    return `${firstName} ${name}`;
  }

  return name || firstName || null;
};

const KPI_IMPORTANCE_OPTIONS = Object.freeze(["High", "Medium", "Low"]);
const KPI_REACTIVITY_NEED_OPTIONS = Object.freeze(["Urgent", "Not Urgent"]);
const KPI_PRICING_TYPE_OPTIONS = Object.freeze(["Operational", "Selling"]);

const normalizeKpiImportanceValue = (value, fallback = null) => {
  const text = normalizeOptionalTextInput(value);
  if (!text) return fallback;

  if (text.toLowerCase() === "not important") {
    return "Low";
  }

  const matchedOption = KPI_IMPORTANCE_OPTIONS.find(
    (option) => option.toLowerCase() === text.toLowerCase()
  );

  return matchedOption || fallback;
};

const normalizeKpiPricingTypeValue = (value, fallback = null) => {
  const text = normalizeOptionalTextInput(value);
  if (!text) return fallback;

  const matchedOption = KPI_PRICING_TYPE_OPTIONS.find(
    (option) => option.toLowerCase() === text.toLowerCase()
  );

  return matchedOption || fallback;
};

const mapKpiRowToClient = (row, subjectPathById = new Map()) => {
  const subjectId = row.subject_id === null || row.subject_id === undefined
    ? null
    : String(row.subject_id);
  const subjectPath = subjectId ? subjectPathById.get(subjectId) || row.subject_name || "" : "";
  const setByPeopleDisplayName = getPeopleDisplayName({
    name: row.set_by_people_name,
    first_name: row.set_by_people_first_name
  }) || "";
  const storedFilePath = normalizeOptionalTextInput(row.file);
  const fileUrl = buildKpiFilePublicUrl(row.kpi_id, storedFilePath);
  const fileName = getKpiDisplayFileName(storedFilePath);

  return {
    kpi_id: row.kpi_id,
    indicator_title: row.kpi_sub_title || "",
    indicator_sub_title: row.kpi_name || "",
    kfs: row.kfs || "KPI",
    kpi_code: row.kpi_code || "",
    kpi_formula: row.kpi_formula || "",
    unit: row.unit || "",
    subject: subjectPath,
    subject_node_id: subjectId,
    definition: row.kpi_explanation || "",
    frequency: row.frequency || "",
    target: row.allocation_target_value ?? row.target_value,
    target_direction: row.target_direction || "",
    tolerance_type: row.tolerance_type || "",
    up_tolerance: row.up_tolerance || "",
    low_tolerance: row.low_tolerance || "",
    max: row.max_value,
    min: row.min_value,
    calculation_on: row.calculation_on || "",
    nombre_periode: row.nombre_periode || "",
    calculation_mode: row.calculation_mode || "",
    display_trend: row.display_trend || "",
    regression: row.regression || "",
    min_type: row.min_type || "",
    max_type: row.max_type || "",
    reference_kpi_id: row.reference_kpi_id,
    target_auto_adjustment: row.target_auto_adjustment || "",
    reactivity_status: row.reactivity_status || "",
    importance: normalizeKpiImportanceValue(row.importance) || "",
    pricing_type: normalizeKpiPricingTypeValue(row.pricing_type) || "",
    reactivity_need: row.reactivity_need || "",
    high_limit: row.high_limit,
    low_limit: row.low_limit,
    owner_role_id: row.owner_role_id,
    status: row.status || "Active",
    comments: row.comments || "",
    file: storedFilePath,
    file_name: fileName || null,
    file_url: fileUrl,
    created_at: row.created_at,
    updated_at: row.updated_at,
    kpi_knowledge_updated_date: row.kpi_knowledge_updated_date ?? null,
    created_by_people_id: row.created_by_people_id ?? null,
    kpi_knowledge_base: row.kpi_knowledge_base ?? null,
    full_subject_path: subjectPath,
    kpi_target_allocation_id: row.kpi_target_allocation_id ?? null,
    allocation_target_value: row.allocation_target_value ?? null,
    allocation_target_unit: row.allocation_target_unit || "",
    allocation_target_status: row.allocation_target_status || "",
    set_by_people_id: row.set_by_people_id ?? null,
    set_by_people_display_name: setByPeopleDisplayName
  };
};

const loadSubjectHierarchyData = async (db = pool) => {
  const result = await db.query(`
    SELECT
      subject_id,
      parent_subject_id,
      subject_name,
      subject_explanation,
      subject_example,
      knowledge,
      status,
      comments
    FROM public.subject
    ORDER BY subject_id
  `);

  const nodeMap = new Map();

  result.rows.forEach((row) => {
    const id = String(row.subject_id);
    nodeMap.set(id, {
      id,
      name: normalizeOptionalTextInput(row.subject_name) || `Subject ${row.subject_id}`,
      parent_id: row.parent_subject_id === null ? null : String(row.parent_subject_id),
      parent_name: null,
      level: 0,
      full_path: normalizeOptionalTextInput(row.subject_name) || `Subject ${row.subject_id}`,
      description: normalizeOptionalTextInput(row.subject_explanation) || "",
      comment: normalizeOptionalTextInput(row.comments) || "",
      why_important: normalizeOptionalTextInput(row.knowledge) || "",
      subject_example: normalizeOptionalTextInput(row.subject_example) || "",
      status: normalizeOptionalTextInput(row.status) || "",
      children: []
    });
  });

  nodeMap.forEach((node) => {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id).children.push(node);
    }
  });

  const resolvePath = (node) => {
    if (!node) return "";
    if (node.__resolvedPath) return node.__resolvedPath;

    if (node.parent_id && nodeMap.has(node.parent_id)) {
      const parentNode = nodeMap.get(node.parent_id);
      const parentPath = resolvePath(parentNode);
      node.parent_name = parentNode.name || null;
      node.level = (parentNode.level || 0) + 1;
      node.__resolvedPath = `${parentPath} / ${node.name}`;
    } else {
      node.parent_name = null;
      node.level = 0;
      node.__resolvedPath = node.name;
    }

    node.full_path = node.__resolvedPath;
    return node.__resolvedPath;
  };

  const roots = [];
  const pathById = new Map();

  nodeMap.forEach((node) => {
    resolvePath(node);
    pathById.set(String(node.id), node.full_path);

    if (!node.parent_id || !nodeMap.has(node.parent_id)) {
      roots.push(node);
    }

    delete node.__resolvedPath;
  });

  const sortNodes = (nodes = []) => {
    nodes.sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
    nodes.forEach((node) => sortNodes(node.children));
    return nodes;
  };

  return {
    tree: sortNodes(roots),
    nodeMap,
    pathById
  };
};

const loadKpiRowsForUi = async ({ search = "", kpiId = null, responsibleId = null } = {}) => {
  const subjectHierarchy = await loadSubjectHierarchyData();
  const searchText = normalizeOptionalTextInput(search) || "";
  const normalizedResponsibleId = normalizeOptionalIntegerInput(responsibleId);
  const params =
    normalizedResponsibleId === null
      ? [searchText, `%${searchText}%`, kpiId]
      : [searchText, `%${searchText}%`, kpiId, normalizedResponsibleId];

  const result = await pool.query(
    `
    SELECT
      k.kpi_id,
      k.kpi_name,
      k.kpi_sub_title,
      k.kpi_code,
      k.kpi_formula,
      k.kpi_explanation,
      k.target_value,
      k.target_direction,
      k.target_auto_adjustment,
      k.reactivity_status,
      k.importance,
      k.pricing_type,
      k.reactivity_need,
      k.min_value,
      k.min_type,
      k.max_value,
      k.max_type,
      k.low_limit,
      k.high_limit,
      k.tolerance_type,
      k.low_tolerance,
      k.up_tolerance,
      k.unit,
      k.frequency,
      k.nombre_periode,
      k.calculation_mode,
      k.calculation_on,
      k.display_trend,
      k.regression,
      k.reference_kpi_id,
      k.owner_role_id,
      k.status,
      k.kfs,
      k.comments,
      k.file,
      k.created_at,
      k.updated_at,
      k.kpi_knowledge_updated_date,
      k.created_by_people_id,
      k.kpi_knowledge_base,
      primary_subject.subject_id,
      assignment.kpi_target_allocation_id,
      assignment.target_value AS allocation_target_value,
      assignment.target_unit AS allocation_target_unit,
      assignment.target_status AS allocation_target_status,
      assignment.set_by_people_id,
      set_by_people.name AS set_by_people_name,
      set_by_people.first_name AS set_by_people_first_name
    FROM public.kpi k

    ${normalizedResponsibleId === null ? "" : `
    LEFT JOIN LATERAL (
      SELECT
        a.kpi_target_allocation_id,
        a.target_value,
        a.target_unit,
        a.target_status,
        a.set_by_people_id
      FROM public.kpi_target_allocation a
      WHERE a.kpi_id = k.kpi_id
        AND a.set_by_people_id = $4
      ORDER BY COALESCE(a.updated_at, a.created_at) DESC, a.kpi_target_allocation_id DESC
      LIMIT 1
    ) assignment ON TRUE
    LEFT JOIN public.people set_by_people
      ON set_by_people.people_id = assignment.set_by_people_id
    `}

    ${normalizedResponsibleId === null ? `
    LEFT JOIN LATERAL (
      SELECT
        NULL::integer AS kpi_target_allocation_id,
        NULL::numeric AS target_value,
        NULL::varchar AS target_unit,
        NULL::varchar AS target_status,
        NULL::integer AS set_by_people_id
    ) assignment ON TRUE
    LEFT JOIN public.people set_by_people
      ON 1 = 0
    ` : ""}

    LEFT JOIN LATERAL (
      SELECT sk.subject_id
      FROM public.subject_kpi sk
      WHERE sk.kpi_id = k.kpi_id
      ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
      LIMIT 1
    ) primary_subject ON TRUE

    WHERE
      k.is_active IS TRUE
      AND ($3::integer IS NULL OR k.kpi_id = $3)
      ${normalizedResponsibleId === null ? "" : `
      AND assignment.set_by_people_id = $4
      `}
      AND (
        $1 = ''
        OR COALESCE(k.kpi_name, '') ILIKE $2
        OR COALESCE(k.kpi_sub_title, '') ILIKE $2
        OR COALESCE(k.kpi_code, '') ILIKE $2
        OR COALESCE(k.kpi_explanation, '') ILIKE $2
        OR COALESCE(k.frequency, '') ILIKE $2
        OR EXISTS (
          SELECT 1
          FROM public.subject_kpi sk2
          JOIN public.subject s2
            ON s2.subject_id = sk2.subject_id
          WHERE sk2.kpi_id = k.kpi_id
            AND COALESCE(s2.subject_name, '') ILIKE $2
        )
      )

    ORDER BY k.kpi_id DESC
    `,
    params
  );

  return result.rows.map((row) => mapKpiRowToClient(row, subjectHierarchy.pathById));
};

module.exports = {
  getKpiStoredFileName,
  getKpiDisplayFileName,
  buildKpiFilePublicUrl,
  getPeopleDisplayName,
  normalizeKpiImportanceValue,
  normalizeKpiPricingTypeValue,
  mapKpiRowToClient,
  loadSubjectHierarchyData,
  loadKpiRowsForUi,
};
