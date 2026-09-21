const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const {
  loadSubjectHierarchyData,
  getPeopleDisplayName,
  normalizeKpiImportanceValue,
  normalizeKpiPricingTypeValue,
} = require("../models/kpi.model");

let kpiKnowledgeRefreshWorkerTimer = null;
let kpiKnowledgeRefreshWorkerRunning = false;
let kpiRatioSchemaPromise = null;
let kpiAssistantConversationSchemaPromise = null;

const KPI_KNOWLEDGE_BASE_MAX_DEPTH = 5;

const KPI_KNOWLEDGE_REFRESH_BATCH_SIZE = 10;
const KPI_KNOWLEDGE_REFRESH_INTERVAL_MS = 5000;

const KPI_KNOWLEDGE_BASE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
  "de",
  "des",
  "du",
  "et",
  "la",
  "le",
  "les",
  "pour",
  "sur",
  "une",
  "un"
]);

const normalizeKnowledgeBaseSearchText = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const tokenizeKnowledgeBaseText = (value, maxItems = 24) => {
  const normalized = normalizeKnowledgeBaseSearchText(value);
  if (!normalized) return [];

  const tokens = normalized
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 2 &&
        !KPI_KNOWLEDGE_BASE_STOP_WORDS.has(token)
    );

  return [...new Set(tokens)].slice(0, maxItems);
};

const flattenKnowledgeBaseStrings = (value) => {
  if (value === undefined || value === null) return [];

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap(flattenKnowledgeBaseStrings);
  }

  if (typeof value === "object") {
    return Object.values(value).flatMap(flattenKnowledgeBaseStrings);
  }

  return [];
};

const uniqueKnowledgeBaseTexts = (values = [], maxItems = 20) => {
  const seen = new Set();
  const results = [];

  for (const value of values) {
    const text = normalizeOptionalTextInput(value);
    const normalized = normalizeKnowledgeBaseSearchText(text);
    if (!text || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    results.push(text);
    if (results.length >= maxItems) break;
  }

  return results;
};

const buildKnowledgeBaseKeywordList = (values = [], maxItems = 40) => {
  const phrases = uniqueKnowledgeBaseTexts(
    flattenKnowledgeBaseStrings(values),
    Math.min(maxItems, 18)
  );
  const tokens = uniqueKnowledgeBaseTexts(
    phrases.flatMap((entry) => tokenizeKnowledgeBaseText(entry, maxItems)),
    maxItems
  );

  return [...phrases, ...tokens].slice(0, maxItems);
};

const formatKnowledgeBaseTimestamp = (value) => {
  if (!value) return null;
  const dateValue = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dateValue.getTime())) {
    return normalizeOptionalTextInput(value);
  }
  return dateValue.toISOString();
};

const normalizeOptionalDateInput = (value) => {
  const text = normalizeOptionalTextInput(value);
  if (text === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;

  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : text;
};

const formatDateOnlyValue = (value = new Date()) => {
  if (!value) return null;

  if (typeof value === "string") {
    const normalizedText = value.trim();
    const dateOnlyMatch = normalizedText.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateOnlyMatch) {
      return `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}`;
    }
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const buildKpiKnowledgeBaseScopeLabel = (parts = []) =>
  parts
    .map((value) => normalizeOptionalTextInput(value))
    .filter(Boolean)
    .join(" / ");

const buildKpiKnowledgeBaseAllocationEntry = (row = {}) => {
  const scopeLabel = buildKpiKnowledgeBaseScopeLabel([
    row.plant_name,
    row.zone_name,
    row.unit_name,
    row.unit_type_name,
    row.role_name,
    row.function_name,
    row.product_name,
    row.product_line_name,
    row.market_name,
    row.customer_name
  ]) || `Allocation ${row.kpi_target_allocation_id}`;

  return {
    allocation_id: row.kpi_target_allocation_id,
    scope_label: scopeLabel,
    target: {
      value: row.target_value ?? null,
      unit: row.target_unit || null,
      local_currency: row.local_currency || null,
      type: row.kpi_type || null,
      status: row.target_status || null
    },
    baseline: {
      previous_target_value: row.previous_target_value ?? null,
      last_best_target: row.last_best_target ?? null
    },
    dates: {
      setup_date: normalizeOptionalDateInput(row.target_setup_date),
      start_date: normalizeOptionalDateInput(row.target_start_date),
      end_date: normalizeOptionalDateInput(row.target_end_date),
      created_at: formatKnowledgeBaseTimestamp(row.created_at),
      updated_at: formatKnowledgeBaseTimestamp(row.updated_at)
    },
    scope: {
      plant: row.plant_id ? { id: row.plant_id, name: row.plant_name || "" } : null,
      zone: row.zone_id ? { id: row.zone_id, name: row.zone_name || "" } : null,
      unit: row.unit_id ? { id: row.unit_id, name: row.unit_name || "" } : null,
      unit_type: row.unit_type_id ? { id: row.unit_type_id, name: row.unit_type_name || "" } : null,
      role: row.role_id ? { id: row.role_id, name: row.role_name || "" } : null,
      function_name: row.function_name || null,
      product: row.product_id ? { id: row.product_id, name: row.product_name || "" } : null,
      product_line: row.product_line_id ? { id: row.product_line_id, name: row.product_line_name || "" } : null,
      market: row.market_id ? { id: row.market_id, name: row.market_name || "" } : null,
      customer: row.customer_id ? { id: row.customer_id, name: row.customer_name || "" } : null
    },
    people: {
      set_by: row.set_by_people_id
        ? { id: row.set_by_people_id, name: getPeopleDisplayName(row.set_by_people || {}) || "" }
        : null,
      created_by: row.created_by_people_id
        ? { id: row.created_by_people_id, name: getPeopleDisplayName(row.created_by_people || {}) || "" }
        : null,
      approved_by: row.approved_by_people_id
        ? { id: row.approved_by_people_id, name: getPeopleDisplayName(row.approved_by_people || {}) || "" }
        : null
    },
    comments: normalizeOptionalTextInput(row.comments) || "",
    keywords: buildKnowledgeBaseKeywordList([
      scopeLabel,
      row.function_name,
      row.plant_name,
      row.zone_name,
      row.unit_name,
      row.unit_type_name,
      row.role_name,
      row.product_name,
      row.product_line_name,
      row.market_name,
      row.customer_name,
      row.comments,
      row.kpi_type,
      row.target_status
    ], 18)
  };
};

const buildKpiKnowledgeBaseResultEntry = (row = {}, allocationScopeById = new Map()) => {
  const allocationId = normalizeOptionalIntegerInput(row.kpi_target_allocation_id);
  const allocationScope = allocationId ? allocationScopeById.get(allocationId) || null : null;
  const recordedByName = row.recorded_by_people_id
    ? getPeopleDisplayName({
      name: row.recorded_by_people_name,
      first_name: row.recorded_by_people_first_name
    }) || ""
    : "";

  return {
    result_id: row.kpi_result_id,
    allocation_id: allocationId,
    scope_label: allocationScope?.scope_label || (allocationId ? `Allocation ${allocationId}` : null),
    period: {
      result_date: row.result_date ? formatDateOnlyValue(row.result_date) : null,
      week: row.week || null,
      type: row.period_type || null,
      label: row.period_label || null
    },
    value: {
      raw_value: row.raw_value ?? null,
      unit: row.unit || null,
      status: row.result_status || null
    },
    targets: {
      target_value: row.target_value ?? null,
      best_new_target: row.best_new_target ?? null
    },
    thresholds: {
      lower_limit: row.lower_limit ?? null,
      upper_limit: row.upper_limit ?? null
    },
    source: {
      data_source: row.data_source || null,
      recorded_at: formatKnowledgeBaseTimestamp(row.recorded_at),
      recorded_by: row.recorded_by_people_id
        ? {
          id: row.recorded_by_people_id,
          name: recordedByName
        }
        : null
    },
    comments: normalizeOptionalTextInput(row.comments) || "",
    keywords: buildKnowledgeBaseKeywordList([
      allocationScope?.scope_label,
      row.period_type,
      row.period_label,
      row.week,
      row.result_status,
      row.data_source,
      row.comments,
      recordedByName,
      row.unit
    ], 16)
  };
};


const loadKpiKnowledgeBaseSourceData = async (db, kpiId) => {
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  if (!normalizedKpiId) return null;

  const [
    kpiResult,
    subjectLinksResult,
    targetAllocationsResult,
    recentResultsResult,
    subjectHierarchy
  ] = await Promise.all([
    db.query(
      `
      SELECT
        k.kpi_id,
        k.kpi_name,
        k.kpi_sub_title,
        k.kpi_code,
        k.kpi_explanation,
        k.kpi_formula,
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
        reference_kpi.kpi_name AS reference_kpi_name,
        k.owner_role_id,
        owner_role.role_name AS owner_role_name,
        k.status,
        k.comments,
        k.created_at,
        k.updated_at,
        k.created_by_people_id,
        created_by_people.name AS created_by_name,
        created_by_people.first_name AS created_by_first_name
      FROM public.kpi k
      LEFT JOIN public.kpi reference_kpi
        ON reference_kpi.kpi_id = k.reference_kpi_id
      LEFT JOIN public.role owner_role
        ON owner_role.role_id = k.owner_role_id
      LEFT JOIN public.people created_by_people
        ON created_by_people.people_id = k.created_by_people_id
      WHERE k.kpi_id = $1
      LIMIT 1
      `,
      [normalizedKpiId]
    ),
    db.query(
      `
      SELECT
        sk.subject_kpi_id,
        sk.subject_id,
        sk.importance_level,
        sk.is_primary,
        sk.comments,
        s.parent_subject_id,
        s.subject_name,
        s.subject_explanation,
        s.subject_example,
        s.knowledge,
        s.status AS subject_status
      FROM public.subject_kpi sk
      JOIN public.subject s
        ON s.subject_id = sk.subject_id
      WHERE sk.kpi_id = $1
      ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
      `,
      [normalizedKpiId]
    ),
    db.query(
      `
      SELECT
        a.kpi_target_allocation_id,
        a.kpi_id,
        a.plant_id,
        plant.unit_name AS plant_name,
        a.zone_id,
        zone.zone_name,
        a.unit_id,
        unit_scope.unit_name AS unit_name,
        a.unit_type_id,
        unit_type.unit_type_name,
        a.role_id,
        role.role_name,
        a."function" AS function_name,
        a.product_id,
        product.product_name,
        a.product_line_id,
        product_line.product_line_name,
        a.market_id,
        market.market_name,
        a.customer_id,
        customer.customer_name,
        a.target_value,
        a.target_unit,
        a.local_currency,
        a.kpi_type,
        a.target_setup_date,
        a.target_start_date,
        a.target_end_date,
        a.last_best_target,
        a.previous_target_value,
        a.target_status,
        a.set_by_people_id,
        a.created_by_people_id,
        a.approved_by_people_id,
        a.comments,
        a.created_at,
        a.updated_at,
        set_by_people.name AS set_by_people_name,
        set_by_people.first_name AS set_by_people_first_name,
        created_by_people.name AS created_by_people_name,
        created_by_people.first_name AS created_by_people_first_name,
        approved_by_people.name AS approved_by_people_name,
        approved_by_people.first_name AS approved_by_people_first_name
      FROM public.kpi_target_allocation a
      LEFT JOIN public.unit plant
        ON plant.unit_id = a.plant_id
      LEFT JOIN public.zone zone
        ON zone.zone_id = a.zone_id
      LEFT JOIN public.unit unit_scope
        ON unit_scope.unit_id = a.unit_id
      LEFT JOIN public.unit_type unit_type
        ON unit_type.unit_type_id = a.unit_type_id
      LEFT JOIN public.role role
        ON role.role_id = a.role_id
      LEFT JOIN public.product product
        ON product.product_id = a.product_id
      LEFT JOIN public.product_line product_line
        ON product_line.product_line_id = a.product_line_id
      LEFT JOIN public.market market
        ON market.market_id = a.market_id
      LEFT JOIN public.customer customer
        ON customer.customer_id = a.customer_id
      LEFT JOIN public.people set_by_people
        ON set_by_people.people_id = a.set_by_people_id
      LEFT JOIN public.people created_by_people
        ON created_by_people.people_id = a.created_by_people_id
      LEFT JOIN public.people approved_by_people
        ON approved_by_people.people_id = a.approved_by_people_id
      WHERE a.kpi_id = $1
      ORDER BY COALESCE(a.updated_at, a.created_at) DESC, a.kpi_target_allocation_id DESC
      `,
      [normalizedKpiId]
    ),
    db.query(
      `
      SELECT
        kr.kpi_result_id,
        kr.kpi_target_allocation_id,
        kr.kpi_id,
        kr.result_date,
        kr.week,
        kr.period_type,
        kr.period_label,
        kr.raw_value,
        kr.lower_limit,
        kr.upper_limit,
        kr.target_value,
        kr.best_new_target,
        kr.unit,
        kr.kpi_type,
        kr.result_status,
        kr.data_source,
        kr.recorded_by_people_id,
        kr.recorded_at,
        kr.comments,
        recorded_by_people.name AS recorded_by_people_name,
        recorded_by_people.first_name AS recorded_by_people_first_name
      FROM public.kpi_result kr
      LEFT JOIN public.people recorded_by_people
        ON recorded_by_people.people_id = kr.recorded_by_people_id
      WHERE kr.kpi_id = $1
      ORDER BY
        COALESCE(kr.recorded_at, kr.result_date::timestamp) DESC,
        kr.kpi_result_id DESC
      LIMIT 12
      `,
      [normalizedKpiId]
    ),
    loadSubjectHierarchyData(db)
  ]);

  if (!kpiResult.rows.length) {
    return null;
  }

  return {
    kpi: kpiResult.rows[0],
    subject_links: subjectLinksResult.rows,
    target_allocations: targetAllocationsResult.rows.map((row) => ({
      ...row,
      set_by_people: {
        name: row.set_by_people_name,
        first_name: row.set_by_people_first_name
      },
      created_by_people: {
        name: row.created_by_people_name,
        first_name: row.created_by_people_first_name
      },
      approved_by_people: {
        name: row.approved_by_people_name,
        first_name: row.approved_by_people_first_name
      }
    })),
    recent_results: recentResultsResult.rows,
    subject_hierarchy: subjectHierarchy
  };
};

const buildKpiKnowledgeBaseDocument = (
  sourceData,
  { reason = "manual_sync", generatedAt = null } = {}
) => {
  if (!sourceData?.kpi) return null;

  const {
    kpi,
    subject_links: subjectLinks,
    target_allocations: targetAllocations,
    recent_results: recentResults,
    subject_hierarchy: subjectHierarchy
  } = sourceData;
  const flatKnowledgeNodes = new Map();
  const causeEffectLinks = new Map();
  const generatedAtIso = formatKnowledgeBaseTimestamp(generatedAt) || new Date().toISOString();

  const buildSubjectTree = (subjectNode, rootSubjectId, depthFromRoot = 0) => {
    if (!subjectNode || depthFromRoot > KPI_KNOWLEDGE_BASE_MAX_DEPTH) {
      return null;
    }

    const childNodes = depthFromRoot >= KPI_KNOWLEDGE_BASE_MAX_DEPTH
      ? []
      : (Array.isArray(subjectNode.children) ? subjectNode.children : [])
        .map((childNode) => buildSubjectTree(childNode, rootSubjectId, depthFromRoot + 1))
        .filter(Boolean);

    const nodeEntry = {
      node_id: `subject:${subjectNode.id}`,
      subject_id: Number(subjectNode.id),
      parent_subject_id: normalizeOptionalIntegerInput(subjectNode.parent_id),
      root_subject_id: normalizeOptionalIntegerInput(rootSubjectId),
      name: subjectNode.name || `Subject ${subjectNode.id}`,
      path: subjectHierarchy.pathById.get(String(subjectNode.id)) || subjectNode.full_path || subjectNode.name || "",
      hierarchy_level: Number(subjectNode.level || 0),
      depth_from_root: depthFromRoot,
      description: subjectNode.description || "",
      knowledge: subjectNode.why_important || "",
      example: subjectNode.subject_example || "",
      status: subjectNode.status || "",
      comments: subjectNode.comment || "",
      keywords: buildKnowledgeBaseKeywordList([
        subjectNode.name,
        subjectNode.full_path,
        subjectNode.description,
        subjectNode.why_important,
        subjectNode.subject_example,
        subjectNode.comment
      ], 18),
      children: childNodes
    };

    const flatNodeEntry = {
      node_id: nodeEntry.node_id,
      subject_id: nodeEntry.subject_id,
      parent_subject_id: nodeEntry.parent_subject_id,
      root_subject_id: nodeEntry.root_subject_id,
      name: nodeEntry.name,
      path: nodeEntry.path,
      hierarchy_level: nodeEntry.hierarchy_level,
      depth_from_root: nodeEntry.depth_from_root,
      description: nodeEntry.description,
      knowledge: nodeEntry.knowledge,
      example: nodeEntry.example,
      status: nodeEntry.status,
      comments: nodeEntry.comments,
      keywords: nodeEntry.keywords,
      children_ids: childNodes.map((childNode) => childNode.node_id)
    };

    const existingFlatNode = flatKnowledgeNodes.get(flatNodeEntry.node_id);
    if (
      !existingFlatNode ||
      Number(flatNodeEntry.depth_from_root) < Number(existingFlatNode.depth_from_root)
    ) {
      flatKnowledgeNodes.set(flatNodeEntry.node_id, flatNodeEntry);
    }

    childNodes.forEach((childNode) => {
      const relation = {
        source_node_id: nodeEntry.node_id,
        source_subject_id: nodeEntry.subject_id,
        target_node_id: childNode.node_id,
        target_subject_id: childNode.subject_id,
        relation_type: "parent_child_influence",
        relation_basis: "subject_hierarchy",
        description: `${nodeEntry.name} provides the parent context for ${childNode.name}.`
      };
      const relationKey = [
        relation.source_node_id,
        relation.target_node_id,
        relation.relation_type
      ].join("|");
      if (!causeEffectLinks.has(relationKey)) {
        causeEffectLinks.set(relationKey, relation);
      }
    });

    return nodeEntry;
  };

  const linkedSubjects = subjectLinks.map((link) => {
    const subjectNode = subjectHierarchy.nodeMap.get(String(link.subject_id));
    const knowledgeTree = subjectNode
      ? buildSubjectTree(subjectNode, link.subject_id, 0)
      : null;

    return {
      subject_kpi_id: link.subject_kpi_id,
      subject_id: link.subject_id,
      is_primary: Boolean(link.is_primary),
      importance_level: normalizeOptionalTextInput(link.importance_level) || "",
      assignment_comments: normalizeOptionalTextInput(link.comments) || "",
      path: subjectHierarchy.pathById.get(String(link.subject_id)) || normalizeOptionalTextInput(link.subject_name) || "",
      subject_name: normalizeOptionalTextInput(link.subject_name) || "",
      subject_description: normalizeOptionalTextInput(link.subject_explanation) || "",
      subject_knowledge: normalizeOptionalTextInput(link.knowledge) || "",
      subject_example: normalizeOptionalTextInput(link.subject_example) || "",
      subject_status: normalizeOptionalTextInput(link.subject_status) || "",
      keywords: buildKnowledgeBaseKeywordList([
        link.subject_name,
        link.subject_explanation,
        link.knowledge,
        link.subject_example,
        link.comments
      ], 18),
      knowledge_tree: knowledgeTree
    };
  });

  const primarySubject = linkedSubjects.find((entry) => entry.is_primary) || linkedSubjects[0] || null;
  const allocationEntries = targetAllocations.map((row) => buildKpiKnowledgeBaseAllocationEntry(row));
  const allocationEntryById = new Map(
    allocationEntries
      .map((entry) => [normalizeOptionalIntegerInput(entry.allocation_id), entry])
      .filter(([allocationId]) => Number.isInteger(allocationId) && allocationId > 0)
  );
  const recentResultEntries = (Array.isArray(recentResults) ? recentResults : [])
    .map((row) => buildKpiKnowledgeBaseResultEntry(row, allocationEntryById));
  const latestResultEntry = recentResultEntries[0] || null;
  const scopeSummary = {
    plants: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.plant?.name), 12),
    zones: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.zone?.name), 12),
    units: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.unit?.name), 12),
    unit_types: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.unit_type?.name), 12),
    roles: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.role?.name), 12),
    functions: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.function_name), 12),
    products: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.product?.name), 12),
    product_lines: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.product_line?.name), 12),
    markets: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.market?.name), 12),
    customers: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope?.customer?.name), 12)
  };

  return {
    schema_version: "1.1.0",
    generated_at: generatedAtIso,
    generation_context: {
      reason,
      max_subject_depth: KPI_KNOWLEDGE_BASE_MAX_DEPTH,
      source_tables: ["kpi", "subject_kpi", "subject", "kpi_target_allocation", "kpi_result"],
      purpose: ["solution_search", "training", "rag", "diagnosis"]
    },
    kpi: {
      kpi_id: kpi.kpi_id,
      name: kpi.kpi_name || "",
      sub_title: kpi.kpi_sub_title || "",
      display_name: [kpi.kpi_sub_title, kpi.kpi_name].filter(Boolean).join(" - ") || kpi.kpi_name || `KPI ${kpi.kpi_id}`,
      code: kpi.kpi_code || "",
      explanation: kpi.kpi_explanation || "",
      formula: kpi.kpi_formula || "",
      unit: kpi.unit || "",
      frequency: kpi.frequency || "",
      status: kpi.status || "",
      comments: kpi.comments || "",
      target: {
        default_value: kpi.target_value ?? null,
        direction: kpi.target_direction || null,
        auto_adjustment: kpi.target_auto_adjustment || null
      },
      classification: {
        reactivity_status: kpi.reactivity_status || null,
        importance: normalizeKpiImportanceValue(kpi.importance),
        pricing_type: normalizeKpiPricingTypeValue(kpi.pricing_type),
        reactivity_need: kpi.reactivity_need || null
      },
      thresholds: {
        min_value: kpi.min_value ?? null,
        min_type: kpi.min_type || null,
        max_value: kpi.max_value ?? null,
        max_type: kpi.max_type || null,
        low_limit: kpi.low_limit ?? null,
        high_limit: kpi.high_limit ?? null,
        tolerance_type: kpi.tolerance_type || null,
        low_tolerance: kpi.low_tolerance || null,
        up_tolerance: kpi.up_tolerance || null
      },
      calculation: {
        mode: kpi.calculation_mode || null,
        calculation_on: kpi.calculation_on || null,
        nombre_periode: kpi.nombre_periode || null,
        display_trend: kpi.display_trend || null,
        regression: kpi.regression || null
      },
      ownership: {
        owner_role_id: kpi.owner_role_id ?? null,
        owner_role_name: kpi.owner_role_name || null,
        created_by_people_id: kpi.created_by_people_id ?? null,
        created_by_name: getPeopleDisplayName({
          name: kpi.created_by_name,
          first_name: kpi.created_by_first_name
        }) || null
      },
      reference_kpi: kpi.reference_kpi_id
        ? {
          kpi_id: kpi.reference_kpi_id,
          name: kpi.reference_kpi_name || ""
        }
        : null,
      timestamps: {
        created_at: formatKnowledgeBaseTimestamp(kpi.created_at),
        updated_at: formatKnowledgeBaseTimestamp(kpi.updated_at)
      }
    },
    subject_context: {
      primary_subject_id: primarySubject?.subject_id || null,
      primary_subject_path: primarySubject?.path || null,
      linked_subjects: linkedSubjects,
      knowledge_nodes: Array.from(flatKnowledgeNodes.values()).sort((left, right) => {
        const depthDiff = Number(left.depth_from_root || 0) - Number(right.depth_from_root || 0);
        if (depthDiff !== 0) return depthDiff;
        return String(left.path || left.name || "").localeCompare(String(right.path || right.name || ""));
      }),
      cause_effect_links: Array.from(causeEffectLinks.values())
    },
    performance: {
      latest_result: latestResultEntry,
      recent_results: recentResultEntries,
      result_count: recentResultEntries.length
    },
    target_allocations: allocationEntries,
    scope_summary: scopeSummary,
    search_index: {
      keywords: buildKnowledgeBaseKeywordList([
        kpi.kpi_name,
        kpi.kpi_sub_title,
        kpi.kpi_code,
        kpi.kpi_explanation,
        kpi.kpi_formula,
        primarySubject?.path,
        linkedSubjects.map((entry) => entry.subject_name),
        linkedSubjects.map((entry) => entry.subject_description),
        linkedSubjects.map((entry) => entry.subject_knowledge),
        latestResultEntry?.period?.label,
        latestResultEntry?.value?.status,
        latestResultEntry?.comments,
        recentResultEntries.map((entry) => entry.scope_label),
        recentResultEntries.map((entry) => entry.comments),
        allocationEntries.map((entry) => entry.scope_label),
        allocationEntries.map((entry) => entry.comments),
        Object.values(scopeSummary)
      ], 80),
      subject_paths: uniqueKnowledgeBaseTexts(linkedSubjects.map((entry) => entry.path), 20),
      allocation_scopes: uniqueKnowledgeBaseTexts(allocationEntries.map((entry) => entry.scope_label), 20),
      result_periods: uniqueKnowledgeBaseTexts(recentResultEntries.map((entry) => entry.period?.label), 20)
    },
    ai_usage: {
      instructions: "Use KPI definition first, then recent KPI results, then the subject tree and cause-effect links, then target allocation scope and comments.",
      preferred_order: ["kpi", "performance", "subject_context", "target_allocations", "scope_summary"]
    }
  };
};

const refreshKpiKnowledgeBaseForKpiId = async (db, kpiId, options = {}) => {
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  if (!normalizedKpiId) return null;

  const sourceData = await loadKpiKnowledgeBaseSourceData(db, normalizedKpiId);
  if (!sourceData) {
    await db.query(
      `
      DELETE FROM public.kpi_knowledge_refresh_queue
      WHERE kpi_id = $1
      `,
      [normalizedKpiId]
    ).catch(() => { });
    return null;
  }

  const refreshedAt = options.generatedAt instanceof Date
    ? options.generatedAt
    : new Date();
  const knowledgeBase = buildKpiKnowledgeBaseDocument(sourceData, {
    ...options,
    generatedAt: refreshedAt
  });
  if (!knowledgeBase) {
    await db.query(
      `
      DELETE FROM public.kpi_knowledge_refresh_queue
      WHERE kpi_id = $1
      `,
      [normalizedKpiId]
    ).catch(() => { });
    return null;
  }

  await db.query(
    `
    UPDATE public.kpi
    SET
      kpi_knowledge_base = $2::jsonb,
      kpi_knowledge_updated_date = $3::timestamptz
    WHERE kpi_id = $1
    `,
    [normalizedKpiId, JSON.stringify(knowledgeBase), refreshedAt.toISOString()]
  );

  await db.query(
    `
    DELETE FROM public.kpi_knowledge_refresh_queue
    WHERE kpi_id = $1
    `,
    [normalizedKpiId]
  ).catch(() => { });

  return knowledgeBase;
};

const refreshKpiKnowledgeBases = async (db, kpiIds = [], options = {}) => {
  const uniqueKpiIds = [...new Set(
    (Array.isArray(kpiIds) ? kpiIds : [])
      .map((value) => normalizeOptionalIntegerInput(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];

  for (const kpiId of uniqueKpiIds) {
    await refreshKpiKnowledgeBaseForKpiId(db, kpiId, options);
  }
};

async function processPendingKpiKnowledgeRefreshQueue() {
  if (kpiKnowledgeRefreshWorkerRunning) {
    return;
  }

  kpiKnowledgeRefreshWorkerRunning = true;
  let client = null;
  let lockAcquired = false;
  const lockKey = Math.abs(
    "kpi_knowledge_refresh_worker"
      .split("")
      .reduce((accumulator, character) => ((accumulator << 5) - accumulator) + character.charCodeAt(0), 0)
  );

  try {
    client = await pool.connect();
    const lockResult = await client.query(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [lockKey]
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;

    if (!lockAcquired) {
      return;
    }

    await client.query("BEGIN");

    const queuedRowsResult = await client.query(
      `
      SELECT
        q.kpi_id,
        q.reason
      FROM public.kpi_knowledge_refresh_queue q
      ORDER BY q.requested_at ASC, q.kpi_id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
      `,
      [KPI_KNOWLEDGE_REFRESH_BATCH_SIZE]
    );

    if (!queuedRowsResult.rows.length) {
      await client.query("COMMIT");
      return;
    }

    for (const row of queuedRowsResult.rows) {
      await refreshKpiKnowledgeBaseForKpiId(client, row.kpi_id, {
        reason: normalizeOptionalTextInput(row.reason) || "queued_refresh"
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => { });
    }
    console.error("[KPI Knowledge Base] Refresh queue processing failed:", error.message);
  } finally {
    if (client && lockAcquired) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey]).catch(() => { });
    }
    if (client) {
      client.release();
    }
    kpiKnowledgeRefreshWorkerRunning = false;
  }
}

function startKpiKnowledgeRefreshWorker() {
  if (kpiKnowledgeRefreshWorkerTimer) {
    return;
  }

  const tick = () => {
    processPendingKpiKnowledgeRefreshQueue().catch((error) => {
      console.error("[KPI Knowledge Base] Refresh queue tick failed:", error.message);
    });
  };

  tick();
  kpiKnowledgeRefreshWorkerTimer = setInterval(tick, KPI_KNOWLEDGE_REFRESH_INTERVAL_MS);
  if (typeof kpiKnowledgeRefreshWorkerTimer.unref === "function") {
    kpiKnowledgeRefreshWorkerTimer.unref();
  }
}

const ensureKpiRatioSchema = async () => {
  if (!kpiRatioSchemaPromise) {
    kpiRatioSchemaPromise = (async () => {
      await pool.query(`
        ALTER TABLE public.kpi
        ADD COLUMN IF NOT EXISTS created_by_people_id INTEGER
      `);

      await pool.query(`
        ALTER TABLE public.kpi
        ADD COLUMN IF NOT EXISTS kpi_knowledge_base JSONB
      `);

      await pool.query(`
        ALTER TABLE public.kpi
        ADD COLUMN IF NOT EXISTS kpi_knowledge_updated_date TIMESTAMPTZ
      `);

      await pool.query(`
        ALTER TABLE public.kpi
        ADD COLUMN IF NOT EXISTS reactivity_status VARCHAR(255)
      `);

      await pool.query(`
        ALTER TABLE public.kpi
        ADD COLUMN IF NOT EXISTS importance VARCHAR(255)
      `);

      await pool.query(`
        ALTER TABLE public.kpi
        ADD COLUMN IF NOT EXISTS pricing_type VARCHAR(255)
      `);

      await pool.query(`
        ALTER TABLE public.kpi
        ADD COLUMN IF NOT EXISTS reactivity_need VARCHAR(255)
      `);

      await pool.query(`
        ALTER TABLE public.kpi
        ADD COLUMN IF NOT EXISTS file VARCHAR
      `);

      await pool.query(`
        ALTER TABLE public.kpi_target_allocation
        ADD COLUMN IF NOT EXISTS created_by_people_id INTEGER
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.kpi_knowledge_refresh_queue (
          kpi_id INTEGER PRIMARY KEY
            REFERENCES public.kpi (kpi_id)
            ON DELETE CASCADE,
          reason TEXT,
          requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kpi_knowledge_refresh_queue_requested_at
        ON public.kpi_knowledge_refresh_queue (requested_at ASC, kpi_id ASC)
      `);

      await pool.query(`
        CREATE OR REPLACE FUNCTION public.enqueue_kpi_knowledge_refresh_target(
          p_kpi_id INTEGER,
          p_reason TEXT DEFAULT NULL
        )
        RETURNS VOID
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF p_kpi_id IS NULL THEN
            RETURN;
          END IF;

          INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
          VALUES (
            p_kpi_id,
            COALESCE(NULLIF(BTRIM(COALESCE(p_reason, '')), ''), 'source_change'),
            NOW()
          )
          ON CONFLICT (kpi_id) DO UPDATE
          SET
            reason = EXCLUDED.reason,
            requested_at = EXCLUDED.requested_at;
        END;
        $$;
      `);

      await pool.query(`
        CREATE OR REPLACE FUNCTION public.enqueue_all_kpi_knowledge_refresh(
          p_reason TEXT DEFAULT NULL
        )
        RETURNS VOID
        LANGUAGE plpgsql
        AS $$
        BEGIN
          INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
          SELECT
            k.kpi_id,
            COALESCE(NULLIF(BTRIM(COALESCE(p_reason, '')), ''), 'source_change'),
            NOW()
          FROM public.kpi k
          ON CONFLICT (kpi_id) DO UPDATE
          SET
            reason = EXCLUDED.reason,
            requested_at = EXCLUDED.requested_at;
        END;
        $$;
      `);

      await pool.query(`
        CREATE OR REPLACE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
          v_reason TEXT := LOWER(TG_TABLE_NAME) || '_' || LOWER(TG_OP);
          v_role_id INTEGER;
          v_people_id INTEGER;
          v_unit_id INTEGER;
          v_zone_id INTEGER;
          v_unit_type_id INTEGER;
          v_product_id INTEGER;
          v_product_line_id INTEGER;
          v_market_id INTEGER;
          v_customer_id INTEGER;
        BEGIN
          IF TG_TABLE_NAME = 'kpi' THEN
            IF TG_OP = 'INSERT' THEN
              PERFORM public.enqueue_kpi_knowledge_refresh_target(NEW.kpi_id, v_reason);
              RETURN NEW;
            END IF;

            IF TG_OP = 'UPDATE' THEN
              IF
                (to_jsonb(NEW) - 'kpi_knowledge_base' - 'kpi_knowledge_updated_date')
                IS DISTINCT FROM
                (to_jsonb(OLD) - 'kpi_knowledge_base' - 'kpi_knowledge_updated_date')
              THEN
                PERFORM public.enqueue_kpi_knowledge_refresh_target(NEW.kpi_id, v_reason);

                INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
                SELECT DISTINCT
                  ref.kpi_id,
                  'reference_kpi_updated',
                  NOW()
                FROM public.kpi ref
                WHERE ref.reference_kpi_id = NEW.kpi_id
                  AND ref.kpi_id <> NEW.kpi_id
                ON CONFLICT (kpi_id) DO UPDATE
                SET
                  reason = EXCLUDED.reason,
                  requested_at = EXCLUDED.requested_at;
              END IF;

              RETURN NEW;
            END IF;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'subject_kpi' THEN
            PERFORM public.enqueue_kpi_knowledge_refresh_target(COALESCE(NEW.kpi_id, OLD.kpi_id), v_reason);

            IF TG_OP = 'UPDATE' AND NEW.kpi_id IS DISTINCT FROM OLD.kpi_id THEN
              PERFORM public.enqueue_kpi_knowledge_refresh_target(OLD.kpi_id, 'subject_kpi_relinked');
            END IF;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'subject' THEN
            PERFORM public.enqueue_all_kpi_knowledge_refresh(v_reason);
            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'kpi_target_allocation' THEN
            PERFORM public.enqueue_kpi_knowledge_refresh_target(COALESCE(NEW.kpi_id, OLD.kpi_id), v_reason);

            IF TG_OP = 'UPDATE' AND NEW.kpi_id IS DISTINCT FROM OLD.kpi_id THEN
              PERFORM public.enqueue_kpi_knowledge_refresh_target(OLD.kpi_id, 'kpi_target_allocation_relinked');
            END IF;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'kpi_result' THEN
            PERFORM public.enqueue_kpi_knowledge_refresh_target(COALESCE(NEW.kpi_id, OLD.kpi_id), v_reason);

            IF TG_OP = 'UPDATE' AND NEW.kpi_id IS DISTINCT FROM OLD.kpi_id THEN
              PERFORM public.enqueue_kpi_knowledge_refresh_target(OLD.kpi_id, 'kpi_result_relinked');
            END IF;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'role' THEN
            v_role_id := COALESCE(NEW.role_id, OLD.role_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              affected.kpi_id,
              v_reason,
              NOW()
            FROM (
              SELECT k.kpi_id
              FROM public.kpi k
              WHERE k.owner_role_id = v_role_id
              UNION
              SELECT a.kpi_id
              FROM public.kpi_target_allocation a
              WHERE a.role_id = v_role_id
            ) affected
            WHERE affected.kpi_id IS NOT NULL
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'people' THEN
            v_people_id := COALESCE(NEW.people_id, OLD.people_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              affected.kpi_id,
              v_reason,
              NOW()
            FROM (
              SELECT k.kpi_id
              FROM public.kpi k
              WHERE k.created_by_people_id = v_people_id
              UNION
              SELECT a.kpi_id
              FROM public.kpi_target_allocation a
              WHERE a.set_by_people_id = v_people_id
                 OR a.created_by_people_id = v_people_id
                 OR a.approved_by_people_id = v_people_id
              UNION
              SELECT r.kpi_id
              FROM public.kpi_result r
              WHERE r.recorded_by_people_id = v_people_id
            ) affected
            WHERE affected.kpi_id IS NOT NULL
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'unit' THEN
            v_unit_id := COALESCE(NEW.unit_id, OLD.unit_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              a.kpi_id,
              v_reason,
              NOW()
            FROM public.kpi_target_allocation a
            WHERE a.plant_id = v_unit_id
               OR a.unit_id = v_unit_id
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'zone' THEN
            v_zone_id := COALESCE(NEW.zone_id, OLD.zone_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              a.kpi_id,
              v_reason,
              NOW()
            FROM public.kpi_target_allocation a
            WHERE a.zone_id = v_zone_id
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'unit_type' THEN
            v_unit_type_id := COALESCE(NEW.unit_type_id, OLD.unit_type_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              a.kpi_id,
              v_reason,
              NOW()
            FROM public.kpi_target_allocation a
            WHERE a.unit_type_id = v_unit_type_id
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'product' THEN
            v_product_id := COALESCE(NEW.product_id, OLD.product_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              a.kpi_id,
              v_reason,
              NOW()
            FROM public.kpi_target_allocation a
            WHERE a.product_id = v_product_id
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'product_line' THEN
            v_product_line_id := COALESCE(NEW.product_line_id, OLD.product_line_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              a.kpi_id,
              v_reason,
              NOW()
            FROM public.kpi_target_allocation a
            WHERE a.product_line_id = v_product_line_id
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'market' THEN
            v_market_id := COALESCE(NEW.market_id, OLD.market_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              a.kpi_id,
              v_reason,
              NOW()
            FROM public.kpi_target_allocation a
            WHERE a.market_id = v_market_id
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          IF TG_TABLE_NAME = 'customer' THEN
            v_customer_id := COALESCE(NEW.customer_id, OLD.customer_id);

            INSERT INTO public.kpi_knowledge_refresh_queue (kpi_id, reason, requested_at)
            SELECT DISTINCT
              a.kpi_id,
              v_reason,
              NOW()
            FROM public.kpi_target_allocation a
            WHERE a.customer_id = v_customer_id
            ON CONFLICT (kpi_id) DO UPDATE
            SET
              reason = EXCLUDED.reason,
              requested_at = EXCLUDED.requested_at;

            RETURN COALESCE(NEW, OLD);
          END IF;

          RETURN COALESCE(NEW, OLD);
        END;
        $$;
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_kpi ON public.kpi;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_kpi
        AFTER INSERT OR UPDATE ON public.kpi
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_subject_kpi ON public.subject_kpi;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_subject_kpi
        AFTER INSERT OR UPDATE OR DELETE ON public.subject_kpi
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_subject ON public.subject;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_subject
        AFTER INSERT OR UPDATE OR DELETE ON public.subject
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_kpi_target_allocation ON public.kpi_target_allocation;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_kpi_target_allocation
        AFTER INSERT OR UPDATE OR DELETE ON public.kpi_target_allocation
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_kpi_result ON public.kpi_result;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_kpi_result
        AFTER INSERT OR UPDATE OR DELETE ON public.kpi_result
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_role ON public.role;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_role
        AFTER INSERT OR UPDATE OR DELETE ON public.role
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_people ON public.people;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_people
        AFTER INSERT OR UPDATE OR DELETE ON public.people
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_unit ON public.unit;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_unit
        AFTER INSERT OR UPDATE OR DELETE ON public.unit
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_zone ON public.zone;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_zone
        AFTER INSERT OR UPDATE OR DELETE ON public.zone
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_unit_type ON public.unit_type;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_unit_type
        AFTER INSERT OR UPDATE OR DELETE ON public.unit_type
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_product ON public.product;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_product
        AFTER INSERT OR UPDATE OR DELETE ON public.product
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_product_line ON public.product_line;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_product_line
        AFTER INSERT OR UPDATE OR DELETE ON public.product_line
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_market ON public.market;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_market
        AFTER INSERT OR UPDATE OR DELETE ON public.market
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DROP TRIGGER IF EXISTS trg_kpi_knowledge_refresh_on_customer ON public.customer;
        CREATE TRIGGER trg_kpi_knowledge_refresh_on_customer
        AFTER INSERT OR UPDATE OR DELETE ON public.customer
        FOR EACH ROW
        EXECUTE FUNCTION public.enqueue_kpi_knowledge_refresh_for_change();
      `);

      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'fk_kpi_created_by_people'
          ) THEN
            ALTER TABLE public.kpi
            ADD CONSTRAINT fk_kpi_created_by_people
            FOREIGN KEY (created_by_people_id)
            REFERENCES public.people (people_id)
            ON UPDATE NO ACTION
            ON DELETE SET NULL;
          END IF;
        END
        $$;
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kpi_created_by_people
        ON public.kpi (created_by_people_id)
      `);

      await pool.query(`
        WITH ownership AS (
          SELECT DISTINCT ON (a.kpi_id)
            a.kpi_id,
            COALESCE(a.created_by_people_id, a.set_by_people_id) AS created_by_people_id
          FROM public.kpi_target_allocation a
          WHERE COALESCE(a.created_by_people_id, a.set_by_people_id) IS NOT NULL
          ORDER BY
            a.kpi_id,
            COALESCE(a.created_at, a.updated_at, NOW()) ASC,
            a.kpi_target_allocation_id ASC
        )
        UPDATE public.kpi k
        SET created_by_people_id = ownership.created_by_people_id
        FROM ownership
        WHERE k.kpi_id = ownership.kpi_id
          AND k.created_by_people_id IS NULL
      `);

      startKpiKnowledgeRefreshWorker();
    })().catch((error) => {
      kpiRatioSchemaPromise = null;
      throw error;
    });
  }

  return kpiRatioSchemaPromise;
};

const ensureKpiAssistantConversationSchema = async () => {
  if (!kpiAssistantConversationSchemaPromise) {
    kpiAssistantConversationSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.kpi_assistant_conversation (
          conversation_id BIGSERIAL PRIMARY KEY,
          people_role_assignment_id INTEGER,
          people_id INTEGER,
          kpi_id INTEGER,
          conversation JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        ALTER TABLE public.kpi_assistant_conversation
        ADD COLUMN IF NOT EXISTS people_id INTEGER
      `);

      await pool.query(`
        ALTER TABLE public.kpi_assistant_conversation
        ADD COLUMN IF NOT EXISTS kpi_id INTEGER
      `);

      await pool.query(`
        ALTER TABLE public.kpi_assistant_conversation
        ADD COLUMN IF NOT EXISTS conversation JSONB
      `);

      await pool.query(`
        ALTER TABLE public.kpi_assistant_conversation
        ALTER COLUMN people_role_assignment_id DROP NOT NULL
      `);

      await pool.query(`
        ALTER TABLE public.kpi_assistant_conversation
        ALTER COLUMN conversation SET DEFAULT '[]'::jsonb
      `);

      await pool.query(`
        UPDATE public.kpi_assistant_conversation
        SET conversation = '[]'::jsonb
        WHERE conversation IS NULL
      `);

      await pool.query(`
        UPDATE public.kpi_assistant_conversation kac
        SET people_id = pra.people_id
        FROM public.people_role_assignment pra
        WHERE kac.people_role_assignment_id = pra.assignment_id
          AND kac.people_id IS NULL
      `);

      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'kpi_assistant_conversation_people_role_assignment_id_fkey'
          ) THEN
            ALTER TABLE public.kpi_assistant_conversation
            ADD CONSTRAINT kpi_assistant_conversation_people_role_assignment_id_fkey
            FOREIGN KEY (people_role_assignment_id)
            REFERENCES public.people_role_assignment (assignment_id)
            ON UPDATE NO ACTION
            ON DELETE SET NULL;
          END IF;
        END
        $$;
      `);

      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'kpi_assistant_conversation_people_id_fkey'
          ) THEN
            ALTER TABLE public.kpi_assistant_conversation
            ADD CONSTRAINT kpi_assistant_conversation_people_id_fkey
            FOREIGN KEY (people_id)
            REFERENCES public.people (people_id)
            ON UPDATE NO ACTION
            ON DELETE SET NULL;
          END IF;
        END
        $$;
      `);

      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'kpi_assistant_conversation_kpi_id_fkey'
          ) THEN
            ALTER TABLE public.kpi_assistant_conversation
            ADD CONSTRAINT kpi_assistant_conversation_kpi_id_fkey
            FOREIGN KEY (kpi_id)
            REFERENCES public.kpi (kpi_id)
            ON UPDATE NO ACTION
            ON DELETE SET NULL;
          END IF;
        END
        $$;
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kpi_assistant_conversation_assignment
        ON public.kpi_assistant_conversation (people_role_assignment_id, kpi_id, updated_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kpi_assistant_conversation_people
        ON public.kpi_assistant_conversation (people_id, kpi_id, updated_at DESC)
      `);
    })().catch((error) => {
      kpiAssistantConversationSchemaPromise = null;
      throw error;
    });
  }

  return kpiAssistantConversationSchemaPromise;
};

module.exports = { ensureKpiRatioSchema, refreshKpiKnowledgeBaseForKpiId, refreshKpiKnowledgeBases, ensureKpiAssistantConversationSchema };
