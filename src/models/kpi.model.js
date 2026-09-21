const { pool } = require("../config/db");
const {
  normalizeOptionalTextInput,
  normalizeOptionalIntegerInput,
  normalizeOptionalNumericInput,
} = require("../utils/normalize");
const { createHttpError } = require("../utils/httpError");
const { normalizeKpiFileUploadPayload } = require("../utils/kpiFileUpload");

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

const KPI_REACTIVITY_STATUS_OPTIONS = Object.freeze(["Anticipated", "Reactive"]);

const prepareKpiWritePayload = (payload = {}) => {
  const rawSubjectNodeId = normalizeOptionalTextInput(payload.subject_node_id ?? payload.subject_id);
  const rawTarget = normalizeOptionalTextInput(payload.target ?? payload.target_value);
  const rawMinValue = normalizeOptionalTextInput(payload.min ?? payload.min_value);
  const rawMaxValue = normalizeOptionalTextInput(payload.max ?? payload.max_value);
  const rawUpTolerance = normalizeOptionalTextInput(payload.up_tolerance);
  const rawLowTolerance = normalizeOptionalTextInput(payload.low_tolerance);
  const rawHighLimit = normalizeOptionalTextInput(payload.high_limit);
  const rawLowLimit = normalizeOptionalTextInput(payload.low_limit);
  const rawReferenceKpiId = normalizeOptionalTextInput(payload.reference_kpi_id);
  const rawOwnerRoleId = normalizeOptionalTextInput(payload.owner_role_id);
  const rawKfs = normalizeOptionalTextInput(payload.kfs);
  const fileUpload = normalizeKpiFileUploadPayload(
    payload.file_upload ?? payload.fileUpload
  );
  const fileSourcePath = normalizeOptionalTextInput(
    payload.file_source_path ?? payload.fileSourcePath
  );
  const fileSourceName = normalizeOptionalTextInput(
    payload.file_source_name ?? payload.fileSourceName ?? payload.file_name
  );
  const kfs = ["KPI", "KFS"].includes(rawKfs) ? rawKfs : null;
  const subjectNodeId = rawSubjectNodeId === null ? null : Number(rawSubjectNodeId);
  const targetValue = normalizeOptionalNumericInput(rawTarget);
  const minValue = normalizeOptionalNumericInput(rawMinValue);
  const maxValue = normalizeOptionalNumericInput(rawMaxValue);
  const upTolerance = normalizeOptionalNumericInput(rawUpTolerance, { allowPercent: true });
  const lowTolerance = normalizeOptionalNumericInput(rawLowTolerance, { allowPercent: true });
  const highLimit = normalizeOptionalNumericInput(rawHighLimit);
  const lowLimit = normalizeOptionalNumericInput(rawLowLimit);
  const calculationMode = normalizeOptionalTextInput(payload.calculation_mode);
  const calculationOn = normalizeOptionalTextInput(payload.calculation_on);
  const frequency = normalizeOptionalTextInput(payload.frequency);
  const targetDirection = normalizeOptionalTextInput(payload.target_direction || payload.direction);
  const toleranceType = normalizeOptionalTextInput(payload.tolerance_type);
  const displayTrend = normalizeOptionalTextInput(payload.display_trend);
  const regression = normalizeOptionalTextInput(payload.regression);
  const minType = normalizeOptionalTextInput(payload.min_type);
  const maxType = normalizeOptionalTextInput(payload.max_type);
  const nombrePeriode = normalizeOptionalTextInput(payload.nombre_periode);
  const targetAutoAdjustment = normalizeOptionalTextInput(payload.target_auto_adjustment);
  const reactivityStatus = normalizeOptionalTextInput(payload.reactivity_status);
  const rawImportance = normalizeOptionalTextInput(payload.importance);
  const importance = normalizeKpiImportanceValue(rawImportance);
  const rawPricingType = normalizeOptionalTextInput(payload.pricing_type);
  const pricingType = normalizeKpiPricingTypeValue(rawPricingType);
  const reactivityNeed = normalizeOptionalTextInput(payload.reactivity_need);
  const referenceKpiId = rawReferenceKpiId === null ? null : Number(rawReferenceKpiId);
  const ownerRoleId = rawOwnerRoleId === null ? null : Number(rawOwnerRoleId);
  const kpiName = normalizeOptionalTextInput(payload.kpi_name ?? payload.indicator_sub_title);
  const unit = normalizeOptionalTextInput(payload.unit);
  const subject = normalizeOptionalTextInput(payload.subject);
  const explanation = normalizeOptionalTextInput(payload.kpi_explanation ?? payload.definition);
  const status = normalizeOptionalTextInput(payload.status) || "Active";
  const normalizedCalculationMode = String(calculationMode || "").toLowerCase();
  const normalizedCalculationOn = String(calculationOn || "").toLowerCase();
  const normalizedDisplayTrend = String(displayTrend || "").toLowerCase();
  const normalizedToleranceType = String(toleranceType || "").toLowerCase();

  if (!kpiName) {
    throw createHttpError(400, "KPI name is required.");
  }

  if (!frequency) {
    throw createHttpError(400, "Frequency is required.");
  }

  if (!unit) {
    throw createHttpError(400, "Unit is required.");
  }

  if (!targetDirection) {
    throw createHttpError(400, "Direction is required.");
  }

  if (!explanation) {
    throw createHttpError(400, "Definition is required.");
  }

  if (!calculationOn) {
    throw createHttpError(400, "Calculation On is required.");
  }

  if (normalizedCalculationOn === "average" && !nombrePeriode) {
    throw createHttpError(400, "Nombre periode is required.");
  }

  if (!calculationMode) {
    throw createHttpError(400, "Calculation mode is required.");
  }

  if (!displayTrend) {
    throw createHttpError(400, "Display trend is required.");
  }

  if (normalizedDisplayTrend === "yes" && !regression) {
    throw createHttpError(400, "Regression is required when display trend is Yes.");
  }

  if (!kfs) {
    throw createHttpError(400, "KFS is required.");
  }

  if (!minType) {
    throw createHttpError(400, "Min selection is required.");
  }

  if (!maxType) {
    throw createHttpError(400, "Max selection is required.");
  }

  if (String(minType).toLowerCase() === "valeur a entrer" && rawMinValue === null) {
    throw createHttpError(400, "Min value is required.");
  }

  if (String(maxType).toLowerCase() === "valeur a entrer" && rawMaxValue === null) {
    throw createHttpError(400, "Max value is required.");
  }

  if (!toleranceType) {
    throw createHttpError(400, "Tolerance type is required.");
  }

  if (normalizedToleranceType === "relative" && rawUpTolerance === null) {
    throw createHttpError(400, "Up tolerance is required.");
  }

  if (normalizedToleranceType === "relative" && rawLowTolerance === null) {
    throw createHttpError(400, "Low tolerance is required.");
  }

  if (normalizedToleranceType === "absolute" && rawHighLimit === null) {
    throw createHttpError(400, "High limit is required.");
  }

  if (normalizedToleranceType === "absolute" && rawLowLimit === null) {
    throw createHttpError(400, "Low limit is required.");
  }

  if (!targetAutoAdjustment) {
    throw createHttpError(400, "Target auto adjust is required.");
  }

  if (reactivityStatus !== null && !KPI_REACTIVITY_STATUS_OPTIONS.includes(reactivityStatus)) {
    throw createHttpError(400, "Reactivity status is invalid.");
  }

  if (rawImportance !== null && importance === null) {
    throw createHttpError(400, "Importance is invalid.");
  }

  if (rawPricingType !== null && pricingType === null) {
    throw createHttpError(400, "Pricing type is invalid.");
  }

  if (reactivityNeed !== null && !KPI_REACTIVITY_NEED_OPTIONS.includes(reactivityNeed)) {
    throw createHttpError(400, "Reactivity need is invalid.");
  }

  if (rawSubjectNodeId !== null && (!Number.isInteger(subjectNodeId) || subjectNodeId <= 0)) {
    throw createHttpError(400, "Subject selection is invalid.");
  }

  if (rawTarget !== null && targetValue === null) {
    throw createHttpError(400, "Target must be numeric.");
  }

  if (rawMinValue !== null && minValue === null) {
    throw createHttpError(400, "Min value must be numeric.");
  }

  if (rawMaxValue !== null && maxValue === null) {
    throw createHttpError(400, "Max value must be numeric.");
  }

  if (rawUpTolerance !== null && upTolerance === null) {
    throw createHttpError(400, 'Up tolerance must be numeric. Use values like "100" or "100%".');
  }

  if (rawLowTolerance !== null && lowTolerance === null) {
    throw createHttpError(400, 'Low tolerance must be numeric. Use values like "60" or "60%".');
  }

  if (rawHighLimit !== null && highLimit === null) {
    throw createHttpError(400, "High limit must be numeric.");
  }

  if (rawLowLimit !== null && lowLimit === null) {
    throw createHttpError(400, "Low limit must be numeric.");
  }

  if (rawReferenceKpiId !== null && (!Number.isInteger(referenceKpiId) || referenceKpiId <= 0)) {
    throw createHttpError(400, "Reference KPI_ID must be a valid integer.");
  }

  if (normalizedCalculationMode === "ratio" && referenceKpiId === null) {
    throw createHttpError(400, "Reference KPI_ID is required for Ratio mode.");
  }

  if (rawOwnerRoleId !== null && (!Number.isInteger(ownerRoleId) || ownerRoleId <= 0)) {
    throw createHttpError(400, "Owner role must be a valid integer.");
  }

  return {
    subject_id: subjectNodeId,
    indicator_title: normalizeOptionalTextInput(payload.indicator_title),
    indicator_sub_title: kpiName,
    kpi_name: kpiName,
    kpi_sub_title: normalizeOptionalTextInput(payload.kpi_sub_title ?? payload.indicator_title),
    kpi_code: normalizeOptionalTextInput(payload.kpi_code),
    kpi_formula: normalizeOptionalTextInput(payload.kpi_formula),
    unit,
    subject,
    definition: explanation,
    kpi_explanation: explanation,
    frequency,
    target: targetValue === null ? null : Number(targetValue),
    target_value: targetValue === null ? null : Number(targetValue),
    target_direction: targetDirection,
    tolerance_type: toleranceType,
    up_tolerance: rawUpTolerance === null ? null : rawUpTolerance.replace(/\s+/g, ""),
    low_tolerance: rawLowTolerance === null ? null : rawLowTolerance.replace(/\s+/g, ""),
    max: maxValue === null ? null : Number(maxValue),
    max_value: maxValue === null ? null : Number(maxValue),
    min: minValue === null ? null : Number(minValue),
    min_value: minValue === null ? null : Number(minValue),
    nombre_periode: nombrePeriode,
    calculation_mode: calculationMode,
    display_trend: displayTrend,
    regression,
    min_type: minType,
    max_type: maxType,
    calculation_on: calculationOn,
    target_auto_adjustment: targetAutoAdjustment,
    reactivity_status: reactivityStatus,
    importance,
    pricing_type: pricingType,
    reactivity_need: reactivityNeed,
    kfs,
    reference_kpi_id: normalizedCalculationMode === "ratio" ? referenceKpiId : null,
    owner_role_id: ownerRoleId,
    status,
    comments: normalizeOptionalTextInput(payload.comments),
    high_limit: highLimit === null ? null : Number(highLimit),
    low_limit: lowLimit === null ? null : Number(lowLimit),
    file_upload: fileUpload,
    file_source_path: fileSourcePath,
    file_source_name: fileSourceName
  };
};

const resolveSubjectIdForKpiPayload = async (payload = {}) => {
  if (Number.isInteger(payload.subject_id) && payload.subject_id > 0) {
    return payload.subject_id;
  }

  const subjectText = normalizeOptionalTextInput(payload.subject);
  if (!subjectText) return null;

  const subjectHierarchy = await loadSubjectHierarchyData();
  const loweredSubjectText = subjectText.toLowerCase();

  for (const [subjectId, fullPath] of subjectHierarchy.pathById.entries()) {
    if (String(fullPath || "").toLowerCase() === loweredSubjectText) {
      return Number(subjectId);
    }
  }

  for (const [subjectId, node] of subjectHierarchy.nodeMap.entries()) {
    if (String(node?.name || "").toLowerCase() === loweredSubjectText) {
      return Number(subjectId);
    }
  }

  return null;
};

const upsertPrimarySubjectKpiLink = async (client, kpiId, subjectId) => {
  await client.query(
    `
    UPDATE public.subject_kpi
    SET is_primary = FALSE
    WHERE kpi_id = $1
    `,
    [kpiId]
  );

  const existing = await client.query(
    `
    SELECT subject_kpi_id
    FROM public.subject_kpi
    WHERE kpi_id = $1
      AND subject_id = $2
    ORDER BY subject_kpi_id ASC
    LIMIT 1
    `,
    [kpiId, subjectId]
  );

  if (existing.rows.length) {
    await client.query(
      `
      UPDATE public.subject_kpi
      SET
        is_primary = TRUE,
        importance_level = COALESCE(importance_level, 'Primary')
      WHERE subject_kpi_id = $1
      `,
      [existing.rows[0].subject_kpi_id]
    );
    return;
  }

  await client.query(
    `
    INSERT INTO public.subject_kpi (
      subject_id,
      kpi_id,
      importance_level,
      is_primary,
      comments
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
    [subjectId, kpiId, "Primary", true, null]
  );
};

const deleteKpiDependentRecords = async (client, kpiId) => {
  const allocationResult = await client.query(
    `
    SELECT kpi_target_allocation_id
    FROM public.kpi_target_allocation
    WHERE kpi_id = $1
    `,
    [kpiId]
  );

  const allocationIds = allocationResult.rows
    .map((row) =>
      normalizeOptionalIntegerInput(row.kpi_target_allocation_id)
    )
    .filter((value) => Number.isInteger(value) && value > 0);

  // Delete KPI assistant conversations
  await client.query(
    `
    DELETE FROM public.kpi_assistant_conversation
    WHERE kpi_id = $1
    `,
    [kpiId]
  );

  if (allocationIds.length) {


    // Delete KPI results before allocations
    await client.query(
      `
      DELETE FROM public.kpi_result
      WHERE kpi_target_allocation_id = ANY($1::int[])
      `,
      [allocationIds]
    );
  }

  // Now allocations can be deleted safely
  await client.query(
    `
    DELETE FROM public.kpi_target_allocation
    WHERE kpi_id = $1
    `,
    [kpiId]
  );

  await client.query(
  `
  DELETE FROM public.kpi_training_result
  WHERE test_id IN (
    SELECT test_id
    FROM public.kpi_test
    WHERE kpi_id = $1
  )
  `,
  [kpiId]
);

  await client.query(
  `
  DELETE FROM public.kpi_test
  WHERE kpi_id = $1
  `,
  [kpiId]
);


await client.query(
  `
  DELETE FROM public.kpi_training
  WHERE kpi_id = $1
  `,
  [kpiId]
);

  await client.query(
    `
    DELETE FROM public.subject_kpi
    WHERE kpi_id = $1
    `,
    [kpiId]
  );
};


const annotateOwnedKpisForResponsible = (rows = [], responsiblePeopleId = null) => {
  const normalizedResponsiblePeopleId = normalizeOptionalIntegerInput(responsiblePeopleId);

  return (Array.isArray(rows) ? rows : []).map((row) => {
    const normalizedCreatedByPeopleId = normalizeOptionalIntegerInput(row?.created_by_people_id);

    return {
      ...row,
      is_owned_by_responsible:
        normalizedResponsiblePeopleId !== null &&
        normalizedCreatedByPeopleId !== null &&
        normalizedCreatedByPeopleId === normalizedResponsiblePeopleId
    };
  });
};

const deleteKpiTargetAllocationDependentRecords = async (
  client,
  allocationIds = []
) => {
  const normalizedAllocationIds = Array.from(
    new Set(
      (Array.isArray(allocationIds) ? allocationIds : [allocationIds])
        .map((value) => normalizeOptionalIntegerInput(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

  if (!normalizedAllocationIds.length) {
    return [];
  }

  await client.query(
    `
    DELETE FROM public.kpi_monitoring_status
    WHERE kpi_target_allocation_id = ANY($1::int[])
    `,
    [normalizedAllocationIds]
  );

  await client.query(
    `
    DELETE FROM public.kpi_result
    WHERE kpi_target_allocation_id = ANY($1::int[])
    `,
    [normalizedAllocationIds]
  );

  return normalizedAllocationIds;
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
  prepareKpiWritePayload,
  resolveSubjectIdForKpiPayload,
  upsertPrimarySubjectKpiLink,
  deleteKpiDependentRecords,
  annotateOwnedKpisForResponsible,
  deleteKpiTargetAllocationDependentRecords,
  KPI_IMPORTANCE_OPTIONS,
};
