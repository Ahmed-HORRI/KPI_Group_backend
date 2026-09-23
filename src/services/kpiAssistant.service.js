const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { getPeopleDisplayName } = require("../models/kpi.model");
const {
  normalizeText,
  inferKpiDirection,
  getKpiStatus,
  normalizeKpiDirection,
  parseMetricNumber,
  normalizeCorrectiveActionImportance,
  normalizeCorrectiveActionUrgency,
  normalizeCorrectiveActionEstimatedDurationDays,
} = require("./kpiShared.service");
const { getOpenAIClient } = require("../config/openai");
const { buildDelayKnowledgeBaseContext } = require("./delayKnowledgeBase.service");
const { buildKpiAssistantKnowledgeContext, formatKpiAssistantGuidedQuestion } = require("./kpiAssistantGuides.service");
const {
  buildKnowledgeBaseKeywordList,
  uniqueKnowledgeBaseTexts,
  normalizeKnowledgeBaseSearchText,
  tokenizeKnowledgeBaseText,
} = require("./kpiKnowledgeBase.service");

const ASSISTANT_EMPTY_TEXT_VALUES = new Set([
  "null",
  "undefined",
  "not defined"
]);

const sanitizeAssistantKnowledgeBaseValue = (value) => {
  if (value === undefined || value === null) return null;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    return ASSISTANT_EMPTY_TEXT_VALUES.has(text.toLowerCase()) ? null : text;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const cleanedItems = value
      .map((item) => sanitizeAssistantKnowledgeBaseValue(item))
      .filter((item) => item !== null);

    return cleanedItems.length ? cleanedItems : null;
  }

  if (typeof value === "object") {
    const cleanedEntries = Object.entries(value).reduce((accumulator, [key, entryValue]) => {
      const cleanedValue = sanitizeAssistantKnowledgeBaseValue(entryValue);
      if (cleanedValue !== null) {
        accumulator[key] = cleanedValue;
      }
      return accumulator;
    }, {});

    return Object.keys(cleanedEntries).length ? cleanedEntries : null;
  }

  return null;
};

const loadKpiKnowledgeBaseForAssistant = async (kpiId) => {
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  if (!normalizedKpiId) return null;

  const result = await pool.query(
    `
    SELECT
      kpi_id,
      kpi_name,
      kpi_sub_title,
      kpi_knowledge_base
    FROM public.kpi
    WHERE kpi_id = $1
    LIMIT 1
    `,
    [normalizedKpiId]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    ...row,
    kpi_knowledge_base:
      sanitizeAssistantKnowledgeBaseValue(row.kpi_knowledge_base) || null
  };
};

const buildStrictKpiKnowledgePrompt = (kpiRow, ragContext = null) => {
  const kb = sanitizeAssistantKnowledgeBaseValue(kpiRow?.kpi_knowledge_base) || {};
  const compactRagContext = ragContext?.available
    ? sanitizeAssistantKnowledgeBaseValue({
      summary: ragContext.summary,
      top_matches: ragContext.top_matches
    })
    : null;

  return `
You are a KPI Support Assistant.

CRITICAL RULES:
- Use ONLY the KPI knowledge base JSON and matched KPI knowledge context below.
- All answers and suggestions must come from that KPI-specific knowledge base.
- Match the user's request against the JSON before answering.
- NEVER invent generic causes, suggestions, or actions.
- NEVER hardcode low limit, high limit, tolerance type, target, unit, or direction.
- Current KPI KNOWLEDGE BASE JSON is always more important than previous conversation.
- If previous conversation conflicts with the JSON, ignore previous conversation.
- Always answer numeric KPI fields from the latest JSON only.
- Use recent conversation context only to understand follow-up questions.
- NEVER display null, undefined, empty string, or "Not defined".
- If a field does not exist in the sanitized KPI knowledge base, omit it completely.
- Hide empty sections completely.
- Keep answers compact and business-friendly.
- For diagnosis/root-cause requests, ask one question at a time.
- Each diagnosis question must include suggestions generated from matching JSON knowledge.
- Continue diagnosis until a probable root cause is found.

MATCHED KPI KNOWLEDGE BASE RAG CONTEXT:
${compactRagContext ? JSON.stringify(compactRagContext, null, 2) : "No focused match extracted for this request. Use the sanitized KPI JSON directly."}

KPI KNOWLEDGE BASE JSON:
${JSON.stringify(kb, null, 2)}

RESPONSE LOGIC:

DIAGNOSIS MODE:

If the user describes a KPI problem, decrease, anomaly, weak performance, or asks for root cause analysis, start diagnosis mode.

Trigger examples:
- diminution
- baisse
- decrease
- dropped
- low performance
- below target
- issue
- problème
- root cause
- cause racine
- diagnose

DIAGNOSIS RAG PROCESS:

Step A — Understand the user request:
- Extract the problem keywords from the user message.
- Detect whether the user mentions decrease, target issue, financial issue, operational issue, scope issue, data issue, or root cause.

Step B — Match the request against the KPI JSON:
Search the extracted keywords inside:
- kpi.name
- kpi.display_name
- kpi.explanation
- kpi.sub_title
- kpi.thresholds
- kpi.target
- kpi.calculation
- subject_context.primary_subject_path
- subject_context.knowledge_nodes
- subject_context.linked_subjects
- subject_context.cause_effect_links
- target_allocations
- scope_summary
- search_index.keywords
- search_index.subject_paths
- search_index.allocation_scopes

Step C — Generate suggestions:
- Suggestions must come ONLY from matched or closely related JSON fields.
- Prefer exact matches from search_index.keywords, subject path, knowledge nodes, cause-effect links, and target allocations.
- If cause_effect_links exist, use them first.
- If cause_effect_links are empty, use:
  1. subject_context.primary_subject_path
  2. subject_context.knowledge_nodes
  3. target_allocations
  4. scope_summary
  5. kpi.thresholds
  6. kpi.calculation
- Do NOT suggest supplier, stock, overtime, planning, staffing, finance, quality, delay, budget, or cost unless those terms exist in the JSON or were explicitly mentioned by the user.
- If the user mentions a term not found in JSON, keep it as user context and ask the user to connect it to one of the available JSON scopes/options.
- Every suggestion must include its JSON source path.

Step D — Ask one diagnostic question:
- Ask only ONE question at a time.
- The question must be based on the best JSON match.
- Include 3 to 5 suggestions from the JSON.
- Continue using conversation history until probable root cause is found.

DIAGNOSIS RESPONSE FORMAT:

❓<one focused question based on matched KPI knowledge>

Suggestions:
1. <suggestion from kpi_knowledge_base> 
2. <suggestion from kpi_knowledge_base> 
3. <suggestion from kpi_knowledge_base> 

ROOT CAUSE RULE:
When enough answers are collected, return:

🧩 Probable root cause
├── Cause: <probable cause>
├── Evidence from user answers
├── KPI knowledge used
└── Corrective actions based only on JSON

0. SPECIFIC FIELD QUESTIONS

If the user asks for ONE specific field, answer ONLY that field using the matching JSON value.

Field mapping:
- low limit => kpi.thresholds.low_limit
- high limit => kpi.thresholds.high_limit
- tolerance type => kpi.thresholds.tolerance_type
- frequency => kpi.frequency
- formula => kpi.formula
- status => kpi.status
- owner => kpi.ownership
- target direction => kpi.target.direction
- default target => kpi.target.default_value
- target value => target_allocations[].target.value
- unit => kpi.unit

Output:
<Field>: <JSON value>

Related info:
- Include only 1 to 3 closely related values from the same JSON area.
- Related info must also come from JSON.
- Do not show related info if no related values exist.

1. KPI OVERVIEW QUESTIONS

If the user asks:
- what is this KPI
- KPI overview
- explain this KPI
- KPI details
- tell me about this KPI

Return a compact overview using available JSON values only:
🎯 KPI
├── Name
├── Unit
├── Status
├── Frequency
├── Description
└── Subject path

Include compact:
🧮 Calculation
🎯 Target & Thresholds
🌳 Subject Hierarchy

2. TARGET QUESTIONS

If user asks about target, thresholds, limits, allocations, or objective:
Return ONLY available target information from:
- kpi.target
- kpi.thresholds
- target_allocations

3. CALCULATION QUESTIONS

If user asks about calculation, formula, computation, or trend:
Return ONLY available calculation information from:
- kpi.formula
- kpi.calculation

4. SUBJECT / HIERARCHY QUESTIONS

If user asks about subject, hierarchy, tree, knowledge nodes, or related subjects:
Return ONLY available subject information from:
- subject_context.primary_subject_path
- subject_context.linked_subjects
- subject_context.knowledge_nodes

5. CAUSE / EFFECT QUESTIONS

If user asks about causes, impact, effect, dependencies, or drivers:
Return ONLY cause-effect information from:
- subject_context.cause_effect_links

If no links exist, say exactly:
No cause-effect links are defined.

6. RECOMMENDATION QUESTIONS

If user asks about recommendations, improvement, actions, optimization, or corrective actions:
Return ONLY recommendations directly supported by the JSON.
If data is insufficient, say what knowledge should be added.

7. FULL KNOWLEDGE TREE QUESTIONS

If user asks for full tree, all knowledge, complete KPI, show everything, or detailed overview:
Return the full KPI knowledge tree using only available JSON values.

8. VAGUE FOLLOW-UP QUESTIONS

If the user asks:
- what else
- another information
- more
- continue
- why
- explain more

Use the recent conversation context to continue from the previous topic.
Never answer "No additional information is available" if the JSON has related fields.

OUTPUT STYLE RULES:
- Use compact formatting.
- Use trees only when useful.
- Do not show unrelated sections.
- Never display empty values.
- Never display empty sections.
`;
};

const loadKpiAssistantConversationRow = async (
  db,
  {
    assignmentId = null,
    peopleId = null,
    kpiId = null,
    forUpdate = false
  } = {}
) => {
  const normalizedAssignmentId = normalizeOptionalIntegerInput(assignmentId);
  const normalizedPeopleId = normalizeOptionalIntegerInput(peopleId);
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);

  if (!normalizedAssignmentId && !normalizedPeopleId) {
    return null;
  }

  const result = await db.query(
    `
    SELECT
      conversation_id,
      people_role_assignment_id,
      people_id,
      conversation
    FROM public.kpi_assistant_conversation
    WHERE kpi_id IS NOT DISTINCT FROM $3
      AND (
        ($1::integer IS NOT NULL AND people_role_assignment_id = $1)
        OR (
          $2::integer IS NOT NULL
          AND people_id = $2
          AND ($1::integer IS NULL OR people_role_assignment_id IS NULL)
        )
      )
    ORDER BY
      CASE
        WHEN $1::integer IS NOT NULL AND people_role_assignment_id = $1 THEN 0
        WHEN $2::integer IS NOT NULL AND people_id = $2 THEN 1
        ELSE 2
      END,
      updated_at DESC,
      conversation_id DESC
    LIMIT 1
    ${forUpdate ? "FOR UPDATE" : ""}
    `,
    [normalizedAssignmentId, normalizedPeopleId, normalizedKpiId]
  );

  return result.rows[0] || null;
};

const buildKpiAssistantMessagesForOpenAI = ({
  kpiRow,
  existingConversation,
  message,
  ragContext
}) => {
  const systemPrompt = buildStrictKpiKnowledgePrompt(kpiRow, ragContext);

  return [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(existingConversation) ? existingConversation : []).slice(-10).map((entry) => ({
      role: entry.role,
      content: entry.content || entry.text || ""
    })),
    {
      role: "system",
      content:
        "Use the current KPI knowledge base JSON as the source of truth. Use the matched KPI knowledge context first, then the rest of the KPI JSON. Ignore old conversation values if they conflict."
    },
    { role: "user", content: message }
  ];
};

const writeSseEvent = (res, eventName, payload) => {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const buildAssistantKpiContext = (kpis = []) =>
  kpis.slice(0, 30).map((kpi) => ({
    kpi_id: kpi.kpi_id ?? null,
    kpi_values_id: kpi.kpi_values_id ?? null,
    kpi_code: normalizeText(kpi.kpi_code),
    title: normalizeText(kpi.title || kpi.subject) || "Untitled KPI",
    subtitle: normalizeText(kpi.subtitle || kpi.indicator_sub_title),
    unit: normalizeText(kpi.unit),
    current_value: normalizeText(kpi.current_value ?? kpi.value),
    target: normalizeText(kpi.target),
    low_limit: normalizeText(kpi.low_limit),
    high_limit: normalizeText(kpi.high_limit),
    week: normalizeText(kpi.week),
    comment: normalizeText(kpi.comment),
    corrective_action_status: normalizeText(kpi.corrective_action_status || kpi.ca_status),
    root_cause: normalizeText(kpi.root_cause),
    implemented_solution: normalizeText(kpi.implemented_solution),
    evidence: normalizeText(kpi.evidence),
    good_direction: normalizeText(kpi.good_direction) || inferKpiDirection(kpi),
    due_date: normalizeText(kpi.due_date),
    estimated_duration_days: normalizeCorrectiveActionEstimatedDurationDays(
      kpi.estimated_duration_days
    ),
    importance: normalizeCorrectiveActionImportance(kpi.importance),
    urgency: normalizeCorrectiveActionUrgency(kpi.urgency),
    responsible: normalizeText(kpi.responsible),
    corrective_actions: Array.isArray(kpi.corrective_actions)
      ? kpi.corrective_actions.slice(0, 5).map((action) => ({
        corrective_action_id: action.corrective_action_id ?? action.correctiveActionId ?? null,
        root_cause: normalizeText(action.root_cause ?? action.rootCause),
        implemented_solution: normalizeText(action.implemented_solution ?? action.implementedSolution),
        evidence: normalizeText(action.evidence),
        due_date: normalizeText(action.due_date ?? action.dueDate),
        estimated_duration_days: normalizeCorrectiveActionEstimatedDurationDays(
          action.estimated_duration_days ?? action.estimatedDurationDays
        ),
        importance: normalizeCorrectiveActionImportance(action.importance),
        urgency: normalizeCorrectiveActionUrgency(action.urgency),
        responsible: normalizeText(action.responsible ?? action.responsibleName),
        status: normalizeText(action.status)
      }))
      : []
  }));

const parseStoredKpiKnowledgeBase = (value) => {
  if (!value) return null;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  return typeof value === "object" ? value : null;
};

const collectStoredKpiKnowledgeTreeNodes = (treeNode, results = []) => {
  if (!treeNode || typeof treeNode !== "object") return results;

  results.push(treeNode);
  (Array.isArray(treeNode.children) ? treeNode.children : []).forEach((childNode) => {
    collectStoredKpiKnowledgeTreeNodes(childNode, results);
  });

  return results;
};

const flattenStoredKpiKnowledgeBaseItems = (knowledgeBase = null) => {
  const parsedKnowledgeBase = parseStoredKpiKnowledgeBase(knowledgeBase);
  if (!parsedKnowledgeBase) return [];

  const items = [];
  const kpiMeta = parsedKnowledgeBase.kpi || {};
  const linkedSubjects = Array.isArray(parsedKnowledgeBase?.subject_context?.linked_subjects)
    ? parsedKnowledgeBase.subject_context.linked_subjects
    : [];
  const storedKnowledgeNodes = Array.isArray(parsedKnowledgeBase?.subject_context?.knowledge_nodes)
    ? parsedKnowledgeBase.subject_context.knowledge_nodes
    : [];
  const fallbackKnowledgeNodes = storedKnowledgeNodes.length
    ? []
    : linkedSubjects.flatMap((entry) =>
      collectStoredKpiKnowledgeTreeNodes(entry?.knowledge_tree, [])
    );
  const knowledgeNodes = storedKnowledgeNodes.length
    ? storedKnowledgeNodes
    : fallbackKnowledgeNodes;
  const targetAllocations = Array.isArray(parsedKnowledgeBase.target_allocations)
    ? parsedKnowledgeBase.target_allocations
    : [];

  items.push({
    item_id: `kpi:${kpiMeta.kpi_id ?? "selected"}`,
    item_type: "kpi",
    title: normalizeText(kpiMeta.display_name || kpiMeta.name) || "Selected KPI",
    subtitle: normalizeText(kpiMeta.code),
    description: normalizeText(kpiMeta.explanation || kpiMeta.formula || kpiMeta.comments),
    keywords: buildKnowledgeBaseKeywordList([
      kpiMeta.display_name,
      kpiMeta.name,
      kpiMeta.sub_title,
      kpiMeta.code,
      kpiMeta.explanation,
      kpiMeta.formula,
      kpiMeta.unit,
      kpiMeta.frequency,
      parsedKnowledgeBase?.subject_context?.primary_subject_path
    ], 16),
    relation_context: [],
    metadata: {
      unit: normalizeText(kpiMeta.unit),
      frequency: normalizeText(kpiMeta.frequency)
    }
  });

  knowledgeNodes.forEach((node) => {
    if (!node || typeof node !== "object") return;

    items.push({
      item_id: normalizeText(node.node_id) || `subject:${node.subject_id ?? "unknown"}`,
      item_type: "subject",
      title: normalizeText(node.name || node.subject_name || node.path) || "Subject",
      subtitle: normalizeText(node.path),
      description: normalizeText(node.knowledge || node.description || node.example || node.comments),
      keywords: Array.isArray(node.keywords)
        ? node.keywords.slice(0, 18)
        : buildKnowledgeBaseKeywordList([
          node.name,
          node.path,
          node.knowledge,
          node.description,
          node.example,
          node.comments
        ], 18),
      relation_context: Array.isArray(node.children_ids)
        ? node.children_ids.slice(0, 5)
        : []
    });
  });

  targetAllocations.forEach((allocation) => {
    if (!allocation || typeof allocation !== "object") return;

    const allocationTarget = allocation.target || {};
    const allocationScope = allocation.scope || {};
    items.push({
      item_id: `allocation:${allocation.allocation_id ?? "unknown"}`,
      item_type: "allocation",
      title: normalizeText(allocation.scope_label) || "Target allocation",
      subtitle: normalizeText(allocationTarget.type || allocationTarget.status),
      description: normalizeText([
        allocation.comments,
        allocationScope?.function_name,
        allocationTarget.value !== null && allocationTarget.value !== undefined
          ? `Target ${allocationTarget.value}${allocationTarget.unit ? ` ${allocationTarget.unit}` : ""}`
          : null
      ].filter(Boolean).join(" | ")),
      keywords: Array.isArray(allocation.keywords)
        ? allocation.keywords.slice(0, 18)
        : buildKnowledgeBaseKeywordList([
          allocation.scope_label,
          allocation.comments,
          allocationTarget.type,
          allocationTarget.status,
          allocationScope?.function_name
        ], 18),
      relation_context: uniqueKnowledgeBaseTexts([
        allocationScope?.plant?.name,
        allocationScope?.zone?.name,
        allocationScope?.unit?.name,
        allocationScope?.role?.name,
        allocationScope?.product?.name,
        allocationScope?.product_line?.name,
        allocationScope?.market?.name,
        allocationScope?.customer?.name
      ], 8)
    });
  });

  return items.filter((item) => {
    return item && (
      normalizeText(item.title) ||
      normalizeText(item.description) ||
      (Array.isArray(item.keywords) && item.keywords.length)
    );
  });
};

const scoreStoredKpiKnowledgeBaseItem = (item, queryText) => {
  const titleText = normalizeKnowledgeBaseSearchText(item?.title);
  const subtitleText = normalizeKnowledgeBaseSearchText(item?.subtitle);
  const descriptionText = normalizeKnowledgeBaseSearchText(item?.description);
  const keywordText = normalizeKnowledgeBaseSearchText(
    Array.isArray(item?.keywords) ? item.keywords.join(" ") : ""
  );
  const relationText = normalizeKnowledgeBaseSearchText(
    Array.isArray(item?.relation_context) ? item.relation_context.join(" ") : ""
  );
  const normalizedQuery = normalizeKnowledgeBaseSearchText(queryText);
  const queryTokens = tokenizeKnowledgeBaseText(queryText, 24);
  const matchedTerms = new Set();
  let score = item?.item_type === "kpi" ? 2 : 0;

  if (
    normalizedQuery &&
    (
      titleText.includes(normalizedQuery) ||
      subtitleText.includes(normalizedQuery) ||
      descriptionText.includes(normalizedQuery) ||
      keywordText.includes(normalizedQuery) ||
      relationText.includes(normalizedQuery)
    )
  ) {
    score += 70;
  }

  queryTokens.forEach((token) => {
    if (titleText.includes(token)) {
      matchedTerms.add(token);
      score += 14;
      return;
    }

    if (subtitleText.includes(token) || keywordText.includes(token)) {
      matchedTerms.add(token);
      score += 10;
      return;
    }

    if (descriptionText.includes(token) || relationText.includes(token)) {
      matchedTerms.add(token);
      score += 6;
    }
  });

  return {
    score,
    matched_terms: [...matchedTerms]
  };
};

const buildStoredKpiKnowledgeBaseContext = ({
  knowledgeBase,
  message,
  conversationHistory,
  selectedKpiSummary,
  selectedKpi
}) => {
  const parsedKnowledgeBase = parseStoredKpiKnowledgeBase(knowledgeBase);
  if (!parsedKnowledgeBase) {
    return {
      available: false,
      summary: null,
      top_matches: []
    };
  }

  const recentConversationInputs = normalizeAssistantConversationHistory(conversationHistory)
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content)
    .slice(-4);
  const searchQuery = [
    message,
    ...recentConversationInputs,
    selectedKpiSummary?.display_name,
    selectedKpi?.comment,
    selectedKpi?.root_cause,
    selectedKpi?.implemented_solution
  ]
    .filter(Boolean)
    .join("\n");
  const flattenedItems = flattenStoredKpiKnowledgeBaseItems(parsedKnowledgeBase);
  const scoredMatches = flattenedItems
    .map((item) => {
      const scoring = scoreStoredKpiKnowledgeBaseItem(item, searchQuery);
      return {
        ...item,
        ...scoring
      };
    })
    .filter((item) => Number(item.score || 0) > 0)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, 4)
    .map((item) => ({
      item_id: item.item_id,
      item_type: item.item_type,
      title: item.title,
      subtitle: item.subtitle || null,
      description: item.description || null,
      keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, 8) : [],
      relation_context: Array.isArray(item.relation_context)
        ? item.relation_context.slice(0, 5)
        : [],
      matched_terms: item.matched_terms || [],
      score: item.score
    }));

  return {
    available: true,
    summary: {
      generated_at: parsedKnowledgeBase.generated_at || null,
      primary_subject_path:
        parsedKnowledgeBase?.subject_context?.primary_subject_path || null,
      linked_subject_count: Array.isArray(parsedKnowledgeBase?.subject_context?.linked_subjects)
        ? parsedKnowledgeBase.subject_context.linked_subjects.length
        : 0,
      knowledge_node_count: Array.isArray(parsedKnowledgeBase?.subject_context?.knowledge_nodes)
        ? parsedKnowledgeBase.subject_context.knowledge_nodes.length
        : flattenedItems.filter((entry) => entry.item_type === "subject").length,
      allocation_count: Array.isArray(parsedKnowledgeBase.target_allocations)
        ? parsedKnowledgeBase.target_allocations.length
        : 0,
      scope_summary: parsedKnowledgeBase.scope_summary || {},
      keywords: Array.isArray(parsedKnowledgeBase?.search_index?.keywords)
        ? parsedKnowledgeBase.search_index.keywords.slice(0, 18)
        : []
    },
    usage: parsedKnowledgeBase.ai_usage || null,
    top_matches: scoredMatches
  };
};

const buildAssistantKpiDisplayName = (title, subtitle) => {
  const cleanTitle = normalizeText(title);
  const cleanSubtitle = normalizeText(subtitle);

  if (cleanSubtitle && cleanTitle) {
    return `${cleanSubtitle} (${cleanTitle})`;
  }

  return cleanSubtitle || cleanTitle || "Untitled KPI";
};

const KPI_DELAY_KB_RULES = Object.freeze([
  {
    id: "quote_flow",
    patterns: [/\bquote\b/i, /\bquotation\b/i, /\bdevis\b/i, /\brfq\b/i, /\bcosting\b/i, /\bestimat/i],
    rationale: "This KPI is directly connected to the quotation and costing process, so the delay knowledge base is directly relevant.",
    preferredNodeIds: ["P008", "M001", "P001", "P003", "P007", "P005", "P002", "P006", "S001", "S004", "S006"],
    kbHints: [
      "quote released late",
      "incomplete RFQ package at intake",
      "late supplier quotation",
      "detailed costing blocked",
      "costing rework",
      "quote OTD"
    ],
    ownerFocus: ["Sales", "Costing", "Purchasing", "Management"],
    metricFocus: ["Quote OTD", "Average quote lead time", "Supplier response lead time", "% RFQ complete at intake", "Backlog days"],
    nextChecks: [
      "Check committed quote date versus actual release date",
      "Review whether the RFQ package was complete before costing started",
      "Identify blocked cost lines waiting on supplier or engineering input",
      "Review reprioritization or backlog changes during the quote cycle"
    ],
    nodeRelevanceMap: {
      P008: "This KPI is directly affected when quotes are released after the committed customer date.",
      M001: "Quote OTD is the primary timing metric to verify whether quotation lateness is driving this KPI.",
      P001: "Incomplete RFQ intake delays quote start and creates clarification loops before a customer-ready offer exists.",
      P003: "Late supplier prices delay quote completion when bought parts or material costs are still open.",
      P007: "Blocked detailed costing prevents a complete and reliable commercial release.",
      P005: "Repeated costing rework consumes time and pushes quote release later.",
      P002: "Insufficient costing capacity increases backlog and slows quotation throughput.",
      P006: "Frequent reprioritization interrupts quote completion and causes missed due dates.",
      S001: "An intake gate reduces late starts caused by unstable or missing RFQ inputs.",
      S004: "Should-cost and supplier SLAs reduce waiting time on supplier-dependent cost lines.",
      S006: "Priority governance protects the quote flow from constant interruption."
    }
  },
  {
    id: "commercial_outcome",
    patterns: [/\bbusiness take\b/i, /\border intake\b/i, /\bsales\b/i, /\brevenue\b/i, /\bbookings?\b/i],
    rationale: "Commercial performance can be reduced when quotes are late, incomplete, or blocked before customer release.",
    preferredNodeIds: ["P008", "M001", "P001", "P003", "P002", "P006", "S001", "S004", "S006"],
    kbHints: [
      "quote released late",
      "quote OTD",
      "incomplete RFQ package at intake",
      "late supplier quotation",
      "insufficient costing capacity",
      "shifting priorities and permanent urgencies"
    ],
    ownerFocus: ["Sales", "Purchasing", "Costing", "Management"],
    metricFocus: ["Quote OTD", "% RFQ complete at intake", "Supplier response lead time", "Backlog days", "Priority changes per week"],
    nextChecks: [
      "Review the last 5 missed or delayed business opportunities",
      "Map each one to the quotation stage where time was lost",
      "Check whether quotes were released after the customer's expected response window",
      "Review missing RFQ inputs, supplier delays, and internal backlog on those cases"
    ],
    nodeRelevanceMap: {
      P008: "Late quote release can directly reduce business take because the customer receives the offer too late to place the order.",
      M001: "Quote OTD is the best direct metric to test whether quotation timing is affecting business take.",
      P001: "Incomplete RFQ intake delays the costing start and shortens the commercial response window.",
      P003: "Supplier quotation delays keep the commercial offer open longer and can delay customer submission.",
      P002: "Insufficient costing capacity slows opportunity handling and can reduce captured business.",
      P006: "Shifting priorities can leave valuable opportunities unfinished or submitted too late.",
      S001: "An RFQ intake gate helps start opportunities with complete data and fewer commercial delays.",
      S004: "Should-cost and supplier response targets reduce wait time on bought parts before submission.",
      S006: "Priority governance protects strategic opportunities from constant interruption."
    }
  },
  {
    id: "flow_timeliness",
    patterns: [/\botd\b/i, /\blead time\b/i, /\bdelay\b/i, /\bbacklog\b/i, /\bcycle time\b/i, /\bdeadline\b/i],
    rationale: "This KPI measures timeliness or flow performance, so delay, backlog, and prioritization nodes are directly relevant.",
    preferredNodeIds: ["M001", "P008", "P002", "P006", "P005", "P003", "S003", "S006"],
    kbHints: [
      "quote OTD",
      "quote released late",
      "insufficient costing capacity",
      "shifting priorities and permanent urgencies",
      "costing rework"
    ],
    ownerFocus: ["Management", "Costing", "Sales"],
    metricFocus: ["Quote OTD", "Average quote lead time", "Backlog days", "WIP count", "Priority changes per week"],
    nextChecks: [
      "Break the delay into intake, costing, supplier, validation, and release stages",
      "Measure backlog and WIP at the same time as the KPI drop",
      "Check how often work sequence changed before completion"
    ],
    nodeRelevanceMap: {
      M001: "This KPI is itself a timing metric or is strongly linked to quote timeliness.",
      P008: "Late release is the visible end effect when the quotation process misses its date.",
      P002: "Capacity shortages create queue buildup and longer lead times.",
      P006: "Frequent reprioritization creates stop-start work and delay accumulation.",
      P005: "Rework adds avoidable cycle time before release.",
      P003: "Supplier waits can extend the total quote timeline.",
      S003: "Flow segmentation helps keep simple and strategic work from being delayed by one shared path.",
      S006: "Priority governance reduces WIP churn and keeps due dates stable."
    }
  },
  {
    id: "cost_margin",
    patterns: [/\bcost\b/i, /\bmargin\b/i, /\bprofit\b/i],
    rationale: "Cost and margin KPIs can be affected by blocked or unstable costing inputs, supplier quotation delays, and rework.",
    preferredNodeIds: ["P003", "P007", "P005", "P004", "S004", "S005", "P002"],
    kbHints: [
      "late supplier quotation",
      "detailed costing blocked",
      "costing rework",
      "should-cost plus supplier SLA",
      "simplify costing model"
    ],
    ownerFocus: ["Purchasing", "Costing", "Management"],
    metricFocus: ["Supplier response lead time", "Time quote stays in draft", "Rework hours per quote", "Manual data entry time", "Throughput per analyst"],
    nextChecks: [
      "Identify which cost lines stayed uncertain longest",
      "Review bought-part quotations and should-cost coverage",
      "Measure how much time was lost to re-entry or recalculation"
    ],
    nodeRelevanceMap: {
      P003: "Late supplier prices can force assumptions or delays in cost completion, affecting margin quality.",
      P007: "Blocked detailed costing leaves key cost lines unresolved and weakens margin confidence.",
      P005: "Rework changes assumptions repeatedly and can destabilize the final cost position.",
      P004: "A heavy costing tool adds manual effort and slows cost-ready decision making.",
      S004: "Should-cost and supplier SLAs provide faster backup pricing for bought parts.",
      S005: "Simplifying the costing model reduces manual effort and repeated assumptions.",
      P002: "Limited analyst capacity can delay detailed cost completion on margin-critical opportunities."
    }
  }
]);

const buildSelectedKpiSummary = (selectedKpi = null) => {
  if (!selectedKpi) return null;

  const currentValue = parseMetricNumber(selectedKpi.current_value);
  const targetValue = parseMetricNumber(selectedKpi.target);
  const lowLimit = parseMetricNumber(selectedKpi.low_limit);
  const highLimit = parseMetricNumber(selectedKpi.high_limit);
  const goodDirection = normalizeKpiDirection(selectedKpi.good_direction) || "up";
  const status = getKpiStatus(currentValue, lowLimit, highLimit, goodDirection);

  const gapToTarget =
    currentValue !== null && targetValue !== null
      ? Number((currentValue - targetValue).toFixed(2))
      : null;

  let targetAssessment = "Target data is not available.";
  if (currentValue !== null && targetValue !== null) {
    if (goodDirection === "down") {
      if (currentValue > targetValue) {
        targetAssessment = `${Number((currentValue - targetValue).toFixed(2))} above target, so improvement is needed.`;
      } else if (currentValue < targetValue) {
        targetAssessment = `${Number((targetValue - currentValue).toFixed(2))} better than target.`;
      } else {
        targetAssessment = "On target.";
      }
    } else if (currentValue < targetValue) {
      targetAssessment = `${Number((targetValue - currentValue).toFixed(2))} below target, so improvement is needed.`;
    } else if (currentValue > targetValue) {
      targetAssessment = `${Number((currentValue - targetValue).toFixed(2))} above target.`;
    } else {
      targetAssessment = "On target.";
    }
  }

  let thresholdAssessment = "Threshold status is not available.";
  if (status.isGood === false && currentValue !== null) {
    if (status.lowerBound !== null && currentValue < status.lowerBound) {
      thresholdAssessment = `${Number((status.lowerBound - currentValue).toFixed(2))} below the acceptable limit.`;
    } else if (status.upperBound !== null && currentValue > status.upperBound) {
      thresholdAssessment = `${Number((currentValue - status.upperBound).toFixed(2))} above the acceptable limit.`;
    } else {
      thresholdAssessment = "Outside the acceptable threshold.";
    }
  } else if (status.isGood === true) {
    thresholdAssessment = "Inside the acceptable threshold.";
  }

  return {
    display_name: buildAssistantKpiDisplayName(selectedKpi.title, selectedKpi.subtitle),
    title: selectedKpi.title || "Untitled KPI",
    subtitle: selectedKpi.subtitle || null,
    unit: selectedKpi.unit || null,
    week: selectedKpi.week || null,
    good_direction: goodDirection,
    current_value: currentValue,
    target: targetValue,
    low_limit: lowLimit,
    high_limit: highLimit,
    gap_to_target: gapToTarget,
    target_assessment: targetAssessment,
    threshold_assessment: thresholdAssessment,
    corrective_action_status: selectedKpi.corrective_action_status || null,
    comment: selectedKpi.comment || null,
    latest_root_cause: selectedKpi.root_cause || null,
    latest_implemented_solution: selectedKpi.implemented_solution || null,
    due_date: selectedKpi.due_date || null,
    responsible: selectedKpi.responsible || null
  };
};

const buildSelectedKpiDelayFocus = (selectedKpi = null) => {
  if (!selectedKpi) {
    return {
      is_direct_match: false,
      matched_rule_id: null,
      rationale: "No KPI is selected, so the knowledge base should be used only if the user explicitly asks about quotation or costing delay.",
      kb_hints: [],
      preferred_node_ids: [],
      node_relevance_map: {},
      owner_focus: [],
      metric_focus: [],
      next_checks: []
    };
  }

  const searchableText = [
    selectedKpi.title,
    selectedKpi.subtitle,
    selectedKpi.comment,
    selectedKpi.root_cause,
    selectedKpi.implemented_solution
  ]
    .filter(Boolean)
    .join(" ");

  const matchedRule = KPI_DELAY_KB_RULES.find((rule) =>
    rule.patterns.some((pattern) => pattern.test(searchableText))
  ) || null;

  if (!matchedRule) {
    return {
      is_direct_match: false,
      matched_rule_id: null,
      rationale: "This KPI does not clearly map to a delay knowledge-base category from its title alone. Use the knowledge base only if the user or KPI context points to quotation, RFQ, costing, supplier, backlog, lead time, or OTD issues.",
      kb_hints: [],
      preferred_node_ids: [],
      node_relevance_map: {},
      owner_focus: [],
      metric_focus: [],
      next_checks: []
    };
  }

  return {
    is_direct_match: true,
    matched_rule_id: matchedRule.id,
    rationale: matchedRule.rationale,
    kb_hints: matchedRule.kbHints,
    preferred_node_ids: matchedRule.preferredNodeIds || [],
    node_relevance_map: matchedRule.nodeRelevanceMap || {},
    owner_focus: matchedRule.ownerFocus || [],
    metric_focus: matchedRule.metricFocus || [],
    next_checks: matchedRule.nextChecks || []
  };
};

const applySelectedKpiKnowledgeBaseFocus = (knowledgeBaseContext, selectedKpiDelayFocus) => {
  if (!knowledgeBaseContext) return knowledgeBaseContext;

  const preferredNodeIds = Array.isArray(selectedKpiDelayFocus?.preferred_node_ids)
    ? selectedKpiDelayFocus.preferred_node_ids
    : [];
  const nodeRelevanceMap = selectedKpiDelayFocus?.node_relevance_map || {};
  const targetMatchCount = Math.max(knowledgeBaseContext.matches?.length || 0, 4);
  const targetRelatedCount = Math.max(knowledgeBaseContext.related?.length || 0, 4);

  const byNodeId = new Map();
  [...(knowledgeBaseContext.matches || []), ...(knowledgeBaseContext.related || [])].forEach((entry) => {
    const key = entry?.node_id || entry?.id;
    if (!key) return;
    const existing = byNodeId.get(key);
    if (!existing || Number(existing.score || 0) < Number(entry.score || 0)) {
      byNodeId.set(key, entry);
    }
  });

  const annotateEntry = (entry) => {
    const preferredIndex = preferredNodeIds.indexOf(entry.node_id);
    const preferredBoost = preferredIndex >= 0
      ? Math.max(0, 220 - (preferredIndex * 14))
      : 0;

    return {
      ...entry,
      kpi_relevance_reason: nodeRelevanceMap[entry.node_id] || null,
      preferred_for_selected_kpi: preferredIndex >= 0,
      kpi_priority_score: Number((Number(entry.score || 0) + preferredBoost).toFixed(2))
    };
  };

  const prioritizedEntries = [...byNodeId.values()]
    .map(annotateEntry)
    .sort((a, b) => Number(b.kpi_priority_score || 0) - Number(a.kpi_priority_score || 0));

  return {
    ...knowledgeBaseContext,
    matches: prioritizedEntries.slice(0, targetMatchCount),
    related: prioritizedEntries.slice(targetMatchCount, targetMatchCount + targetRelatedCount),
    kpi_specific_focus: {
      matched_rule_id: selectedKpiDelayFocus?.matched_rule_id || null,
      preferred_node_ids: preferredNodeIds,
      owner_focus: selectedKpiDelayFocus?.owner_focus || [],
      metric_focus: selectedKpiDelayFocus?.metric_focus || [],
      next_checks: selectedKpiDelayFocus?.next_checks || []
    }
  };
};

const MAX_ASSISTANT_HISTORY_MESSAGES = 14;

const normalizeAssistantConversationHistory = (history = []) =>
  (Array.isArray(history) ? history : [])
    .map((entry) => {
      const role = entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : null;
      const content = normalizeText(entry?.content ?? entry?.contextText ?? entry?.text ?? entry?.message);
      if (!role || !content) return null;
      return { role, content };
    })
    .filter(Boolean)
    .slice(-MAX_ASSISTANT_HISTORY_MESSAGES);

const buildAssistantConversationMemory = (history = []) => {
  const normalizedHistory = normalizeAssistantConversationHistory(history);
  const recentUserInputs = normalizedHistory
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content)
    .slice(-6);
  const recentAssistantQuestions = normalizedHistory
    .filter((entry) => entry.role === "assistant")
    .map((entry) => entry.content)
    .filter((content) => content.includes("?") || /\n\s*1\.\s+/m.test(content))
    .slice(-4);

  return {
    history_available: normalizedHistory.length > 0,
    recent_user_inputs: recentUserInputs,
    recent_assistant_questions: recentAssistantQuestions,
    last_user_input: recentUserInputs.length ? recentUserInputs[recentUserInputs.length - 1] : null,
    completed_turns: Math.floor(normalizedHistory.length / 2)
  };
};

const buildKpiScopedKnowledgeBaseQuery = ({
  message,
  conversationHistory,
  selectedKpi,
  selectedKpiSummary,
  selectedKpiDelayFocus
}) => {
  const queryParts = [String(message || "").trim()];
  const recentConversationInputs = normalizeAssistantConversationHistory(conversationHistory)
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content)
    .slice(-4);

  if (recentConversationInputs.length) {
    queryParts.push(`Recent conversation context: ${recentConversationInputs.join(" | ")}`);
  }

  if (selectedKpiSummary?.display_name) {
    queryParts.push(
      `Selected KPI: ${selectedKpiSummary.display_name}`
    );
  }

  if (selectedKpiSummary?.target_assessment) {
    queryParts.push(`KPI target assessment: ${selectedKpiSummary.target_assessment}`);
  }

  if (selectedKpiSummary?.threshold_assessment) {
    queryParts.push(`KPI threshold assessment: ${selectedKpiSummary.threshold_assessment}`);
  }

  if (selectedKpi?.comment) {
    queryParts.push(`KPI comment: ${selectedKpi.comment}`);
  }

  if (selectedKpiDelayFocus?.kb_hints?.length) {
    queryParts.push(`Delay knowledge-base hints: ${selectedKpiDelayFocus.kb_hints.join(", ")}`);
  }

  if (selectedKpiDelayFocus?.preferred_node_ids?.length) {
    queryParts.push(`Preferred node IDs for this KPI: ${selectedKpiDelayFocus.preferred_node_ids.join(", ")}`);
  }

  return queryParts.filter(Boolean).join("\n");
};

const buildGuidedAssistantQuestionReply = ({
  selectedKpiSummary,
  assistantKnowledgeContext
}) => {
  const guidedQuestionText = formatKpiAssistantGuidedQuestion(
    assistantKnowledgeContext?.next_question
  );

  if (!guidedQuestionText) return null;

  const lines = [];

  if (selectedKpiSummary?.display_name) {
    lines.push(`Focused KPI: ${selectedKpiSummary.display_name}.`);
  }

  if (assistantKnowledgeContext?.matched_guide?.name) {
    lines.push(`Guide: ${assistantKnowledgeContext.matched_guide.name}.`);
  }

  lines.push("Let's collect the next important point for this KPI.");
  lines.push(guidedQuestionText);

  return lines.join("\n\n");
};

const buildKpiAssistantFallbackReply = ({
  selectedKpiSummary,
  selectedKpiDelayFocus,
  knowledgeBaseContext,
  assistantKnowledgeContext,
  storedKpiKnowledgeContext
}) => {
  const guidedQuestionReply = buildGuidedAssistantQuestionReply({
    selectedKpiSummary,
    assistantKnowledgeContext
  });

  if (guidedQuestionReply) {
    return guidedQuestionReply;
  }

  const lines = [];

  if (selectedKpiSummary) {
    lines.push(`Focused KPI: ${selectedKpiSummary.display_name}.`);

    if (selectedKpiSummary.current_value !== null || selectedKpiSummary.target !== null) {
      lines.push(
        `Current value: ${selectedKpiSummary.current_value ?? "N/A"}${selectedKpiSummary.unit ? ` ${selectedKpiSummary.unit}` : ""}; target: ${selectedKpiSummary.target ?? "N/A"}${selectedKpiSummary.unit ? ` ${selectedKpiSummary.unit}` : ""}.`
      );
    }

    lines.push(selectedKpiSummary.target_assessment);
    lines.push(selectedKpiSummary.threshold_assessment);
  }

  if (selectedKpiDelayFocus?.rationale) {
    lines.push(`Delay KB relevance: ${selectedKpiDelayFocus.rationale}`);
  }

  if (storedKpiKnowledgeContext?.available) {
    if (storedKpiKnowledgeContext.summary?.primary_subject_path) {
      lines.push(`KPI subject path: ${storedKpiKnowledgeContext.summary.primary_subject_path}.`);
    }

    if (storedKpiKnowledgeContext.top_matches?.length) {
      const storedSummary = storedKpiKnowledgeContext.top_matches
        .slice(0, 3)
        .map((entry) => `${entry.title}${entry.description ? `: ${entry.description}` : ""}`)
        .join(" | ");
      lines.push(`Stored KPI knowledge: ${storedSummary}.`);
    }
  }

  if (knowledgeBaseContext?.matches?.length) {
    const topMatches = knowledgeBaseContext.matches.slice(0, 3);
    const kbSummary = topMatches
      .map((entry) => `${entry.node_id} - ${entry.subject}${entry.kpi_relevance_reason ? `: ${entry.kpi_relevance_reason}` : ""}`)
      .join(" | ");
    lines.push(`Most relevant knowledge-base nodes: ${kbSummary}.`);

    const actionSummary = topMatches
      .flatMap((entry) => entry.actions || [])
      .filter(Boolean)
      .slice(0, 4);
    if (actionSummary.length) {
      lines.push(`Recommended actions: ${actionSummary.join("; ")}.`);
    }

    const metricSummary = [
      ...(selectedKpiDelayFocus?.metric_focus || []),
      ...topMatches.flatMap((entry) => entry.metrics || [])
    ].filter(Boolean);
    if (metricSummary.length) {
      lines.push(`Track with: ${[...new Set(metricSummary)].slice(0, 5).join("; ")}.`);
    }
  } else {
    lines.push("No strong delay knowledge-base node matched this KPI and question.");
  }

  if (selectedKpiDelayFocus?.owner_focus?.length) {
    lines.push(`Owner functions to involve: ${selectedKpiDelayFocus.owner_focus.join("; ")}.`);
  }

  if (selectedKpiDelayFocus?.next_checks?.length) {
    lines.push(`Best next checks: ${selectedKpiDelayFocus.next_checks.slice(0, 3).join("; ")}.`);
  }

  return lines.filter(Boolean).join(" ");
};

const buildFastKpiAssistantReply = ({
  selectedKpiSummary,
  selectedKpiDelayFocus,
  knowledgeBaseContext,
  assistantKnowledgeContext,
  storedKpiKnowledgeContext
}) => {
  const lines = [];
  const topMatches = (knowledgeBaseContext?.matches || []).slice(0, 4);
  const topActions = [...new Set(topMatches.flatMap((entry) => entry.actions || []).filter(Boolean))].slice(0, 4);
  const topMetrics = [
    ...(selectedKpiDelayFocus?.metric_focus || []),
    ...topMatches.flatMap((entry) => entry.metrics || [])
  ].filter(Boolean);

  if (selectedKpiSummary) {
    lines.push(`### KPI Status`);
    lines.push(`- **KPI**: ${selectedKpiSummary.display_name}`);

    if (selectedKpiSummary.current_value !== null) {
      lines.push(`- **Current Value**: ${selectedKpiSummary.current_value}${selectedKpiSummary.unit ? ` ${selectedKpiSummary.unit}` : ""}`);
    }

    if (selectedKpiSummary.target !== null) {
      lines.push(`- **Target**: ${selectedKpiSummary.target}${selectedKpiSummary.unit ? ` ${selectedKpiSummary.unit}` : ""}`);
    }

    if (selectedKpiSummary.gap_to_target !== null) {
      const gapDirection = selectedKpiSummary.gap_to_target < 0 ? "below" : "above";
      lines.push(`- **Gap To Target**: ${selectedKpiSummary.gap_to_target}${selectedKpiSummary.unit ? ` ${selectedKpiSummary.unit}` : ""} (${Math.abs(selectedKpiSummary.gap_to_target)} ${gapDirection} target)`);
    }

    lines.push(`- **Target Assessment**: ${selectedKpiSummary.target_assessment}`);
    lines.push(`- **Threshold Assessment**: ${selectedKpiSummary.threshold_assessment}`);
  }

  if (assistantKnowledgeContext?.matched_guide?.name) {
    lines.push("");
    lines.push(`### KPI Guide`);
    lines.push(`- **Guide**: ${assistantKnowledgeContext.matched_guide.name}`);

    if (assistantKnowledgeContext.progress?.total_questions) {
      lines.push(
        `- **Progress**: ${assistantKnowledgeContext.progress.answered_count}/${assistantKnowledgeContext.progress.total_questions} guided questions answered`
      );
    }
  }

  if (storedKpiKnowledgeContext?.available) {
    lines.push("");
    lines.push(`### KPI Knowledge Base`);

    if (storedKpiKnowledgeContext.summary?.primary_subject_path) {
      lines.push(`- **Primary Subject**: ${storedKpiKnowledgeContext.summary.primary_subject_path}`);
    }

    if (
      storedKpiKnowledgeContext.summary?.allocation_count !== null &&
      storedKpiKnowledgeContext.summary?.allocation_count !== undefined
    ) {
      lines.push(`- **Allocations Covered**: ${storedKpiKnowledgeContext.summary.allocation_count}`);
    }

    if (storedKpiKnowledgeContext.top_matches?.length) {
      storedKpiKnowledgeContext.top_matches.forEach((entry, index) => {
        const detail = entry.description || entry.subtitle || "Relevant KPI knowledge-base entry";
        lines.push(`${index + 1}. **${entry.title}**: ${detail}`);
      });
    }
  }

  if (selectedKpiDelayFocus?.rationale) {
    lines.push("");
    lines.push(`The delay knowledge base is relevant here because ${selectedKpiDelayFocus.rationale.charAt(0).toLowerCase()}${selectedKpiDelayFocus.rationale.slice(1)}`);
  }

  if (topMatches.length) {
    lines.push("");
    lines.push(`### Likely Delay-Related Drivers`);
    topMatches.forEach((entry, index) => {
      const reason = entry.kpi_relevance_reason || entry.description || "This node may influence the KPI through the quotation flow.";
      lines.push(`${index + 1}. **${entry.node_id} - ${entry.subject}**: ${reason}`);
    });
  } else {
    lines.push("");
    lines.push(`### Likely Delay-Related Drivers`);
    lines.push(`No strong knowledge-base match was found for this KPI and question.`);
  }

  if (topActions.length) {
    lines.push("");
    lines.push(`### Recommended Actions`);
    topActions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action}`);
    });
  }

  if (selectedKpiDelayFocus?.owner_focus?.length) {
    lines.push("");
    lines.push(`### Owners`);
    selectedKpiDelayFocus.owner_focus.forEach((owner) => {
      lines.push(`- ${owner}`);
    });
  }

  const uniqueMetrics = [...new Set(topMetrics)].slice(0, 5);
  if (uniqueMetrics.length) {
    lines.push("");
    lines.push(`### Metrics To Monitor`);
    uniqueMetrics.forEach((metric) => {
      lines.push(`- ${metric}`);
    });
  }

  if (selectedKpiDelayFocus?.next_checks?.length) {
    lines.push("");
    lines.push(`### Next Checks`);
    selectedKpiDelayFocus.next_checks.slice(0, 3).forEach((check) => {
      lines.push(`- ${check}`);
    });
  }

  const guidedQuestionText = formatKpiAssistantGuidedQuestion(
    assistantKnowledgeContext?.next_question
  );
  if (guidedQuestionText) {
    lines.push("");
    lines.push(`### Next Guided Question`);
    lines.push(guidedQuestionText);
  }

  return lines.join("\n");
};


const generateKpiAssistantReply = async ({
  responsible,
  week,
  selectedKpiId,
  kpis,
  message,
  conversationHistory,
  selectedKpiKnowledgeBase
}) => {
  const assistantKpis = buildAssistantKpiContext(kpis);
  const normalizedConversationHistory = normalizeAssistantConversationHistory(conversationHistory);
  const conversationMemory = buildAssistantConversationMemory(normalizedConversationHistory);
  const selectedKpi = assistantKpis.find((kpi) =>
    String(kpi.kpi_id) === String(selectedKpiId) ||
    String(kpi.kpi_values_id) === String(selectedKpiId)
  ) || null;
  const selectedKpiSummary = buildSelectedKpiSummary(selectedKpi);
  const assistantKnowledgeContext = buildKpiAssistantKnowledgeContext({
    selectedKpi,
    message,
    conversationHistory: normalizedConversationHistory
  });
  const storedKpiKnowledgeContext = buildStoredKpiKnowledgeBaseContext({
    knowledgeBase: selectedKpiKnowledgeBase,
    message,
    conversationHistory: normalizedConversationHistory,
    selectedKpiSummary,
    selectedKpi
  });
  const selectedKpiDelayFocus = buildSelectedKpiDelayFocus(selectedKpi);
  const knowledgeBaseQuery = buildKpiScopedKnowledgeBaseQuery({
    message,
    conversationHistory: normalizedConversationHistory,
    selectedKpi,
    selectedKpiSummary,
    selectedKpiDelayFocus
  });
  const rawKnowledgeBaseContext = buildDelayKnowledgeBaseContext(knowledgeBaseQuery, {
    limit: 4,
    relatedLimit: 4,
    preferredNodeIds: selectedKpiDelayFocus.preferred_node_ids || []
  });
  const knowledgeBaseContext = applySelectedKpiKnowledgeBaseFocus(
    rawKnowledgeBaseContext,
    selectedKpiDelayFocus
  );
  const fastLocalReply = buildFastKpiAssistantReply({
    selectedKpiSummary,
    selectedKpiDelayFocus,
    knowledgeBaseContext,
    assistantKnowledgeContext,
    storedKpiKnowledgeContext
  });

  // if (isFastKpiAssistantRequest({
  //   message,
  //   selectedKpi,
  //   knowledgeBaseContext
  // })) {
  //   return fastLocalReply;
  // }

  const promptKpiContext = selectedKpi ? [selectedKpi] : assistantKpis.slice(0, 8);
  const promptKnowledgeMatches = (knowledgeBaseContext.matches || []).slice(0, 3);
  const promptKnowledgeRelated = (knowledgeBaseContext.related || []).slice(0, 2);

  const contextPrompt = `
CONFIRMED PAGE CONTEXT
${JSON.stringify({
    responsible: responsible?.name || null,
    plant: responsible?.plant_name || null,
    department: responsible?.department_name || null,
    week: week || null
  }, null, 2)}

KNOWN CONVERSATION MEMORY
${JSON.stringify(conversationMemory, null, 2)}

RECENT KPI CONTEXT
${JSON.stringify(promptKpiContext, null, 2)}

SELECTED KPI
${selectedKpi ? JSON.stringify(selectedKpi, null, 2) : "None selected"}

SELECTED KPI SUMMARY
${JSON.stringify(selectedKpiSummary, null, 2)}

SELECTED KPI STORED KNOWLEDGE BASE SUMMARY
${storedKpiKnowledgeContext?.available ? JSON.stringify(storedKpiKnowledgeContext.summary, null, 2) : "None"}

SELECTED KPI STORED KNOWLEDGE BASE MATCHES
${storedKpiKnowledgeContext?.top_matches?.length ? JSON.stringify(storedKpiKnowledgeContext.top_matches, null, 2) : "None"}

MATCHED KNOWLEDGE BASE NODES
${JSON.stringify(promptKnowledgeMatches, null, 2)}

RELATED KNOWLEDGE BASE NODES
${JSON.stringify(promptKnowledgeRelated, null, 2)}

MATCHED KPI QUESTION GUIDE
${JSON.stringify(assistantKnowledgeContext.matched_guide, null, 2)}

RELATED KPI QUESTION GUIDES
${JSON.stringify(assistantKnowledgeContext.related_guides, null, 2)}

GUIDED QUESTION PROGRESS
${JSON.stringify(assistantKnowledgeContext.progress, null, 2)}

NEXT GUIDED QUESTION
${assistantKnowledgeContext.next_question ? JSON.stringify(assistantKnowledgeContext.next_question, null, 2) : "None"}

USER MESSAGE
${message}

IMPORTANT
- Follow the system prompt exactly.
- Treat the conversation history as the active memory for this diagnosis.
- Use the available memory before asking any follow-up question.
- Do not repeat a question if the answer is already present or strongly implied in the history.
- If the user's latest reply is short, resolve it using the immediately preceding assistant question and options.
- Use the stored KPI knowledge base as the KPI-specific source of subject structure, cause/effect context, and allocation scope when it is available.
- Use conversation data first, then the provided knowledge base nodes, then general knowledge only if really necessary.
- If a matched KPI question guide exists, prefer its next unanswered question over inventing a new diagnostic question.
- Ask question by question for KPI data collection unless the user explicitly asks for a summary, suggestion, or clarification.
- Use confirmed page/KPI context as part of the conversation evidence.
- Use the knowledge base to support diagnosis.
- Do not invent causes, actions, owners, deadlines, metrics, or evidence.
- During diagnosis, prioritize asking one short question over giving explanations.
- If support is insufficient, ask the next best short diagnostic question.
- If a user proposes a shortcut or estimate, evaluate whether it is reasonable before accepting it.
`.trim();

  let openai = null;
  try {
    openai = getOpenAIClient();
  } catch (err) {
    return buildKpiAssistantFallbackReply({
      selectedKpiSummary,
      selectedKpiDelayFocus,
      knowledgeBaseContext,
      assistantKnowledgeContext,
      storedKpiKnowledgeContext
    });
  }

  try {

    const systemPrompt = `
You are an intelligent assistant designed to capture, structure, analyze, and refine user information through natural conversation in order to identify:

- a root cause
- an action
- an owner
- a reasonable deadline

Your behavior follows these core principles:

### 1. Memory and Context
- You remember all previously provided user inputs.
- You NEVER ask a question if the answer has already been provided.
- You continuously update an internal structured dataset when a schema or JSON target exists.
- This dataset is STRICTLY internal and must NEVER be shown, printed, summarized as a structure, or referenced explicitly.
- You reuse past answers when logically valid.
- You may infer missing links from prior answers, but never invent facts.

### 2. Main Objective
Your goal is to guide the user efficiently toward a usable diagnosis and decision by identifying:
- the real problem
- the root cause
- the practical corrective action
- who should own it
- a realistic deadline

You must keep moving toward these five outputs unless the user changes the topic.

### 3. Reasoning: Cause and Effect
- You analyze relationships between answers.
- You detect cause-effect links across the conversation.
- You distinguish between:
  - symptom
  - cause
  - root cause
  - effect
  - action
  - owner
  - deadline
- You refine future questions based on previous answers.
- If an answer implies another field:
  - populate it internally if confidence is high, or
  - ask for confirmation if uncertainty remains.
- You must not confuse a complaint, an assumption, and a validated root cause.

### 4. Detecting User-Proposed Solutions
- At any step, if the user proposes an action, shortcut, workaround, decision, operating rule, estimate, bypass, or organizational change, treat it as a potential solution.
- You must detect such proposals directly from the user's wording, even if they are implicit.
- Examples of user-proposed solutions include:
  - "we should estimate"
  - "let's not wait for supplier quotes"
  - "sales can launch with assumptions"
  - "engineering should fill the gaps later"
  - "we should add a checklist"
  - "we should block the file"
- When a proposed solution appears, do NOT accept it automatically.
- First evaluate whether it is reasonable.

### 5. Reasonableness Test for Proposed Solutions
Whenever the user suggests a solution, test it using these criteria:

1. Does it reduce the delay or problem in a real way?
2. Does it create a bigger downstream risk?
3. Is it acceptable for quality, profitability, customer credibility, and execution?
4. Is it based on controlled assumptions or on guesswork?
5. Can it be framed with clear conditions of use?
6. Does it require validation, containment, or boundaries?
7. Is it a root-cause solution or just a speed shortcut?

If the solution seems reasonable:
- accept it provisionally
- refine it
- add the conditions that make it safe and professional

If the solution seems only partly reasonable:
- keep the useful part
- challenge the risky part
- reformulate it into a controlled version

If the solution is not reasonable:
- explain briefly why
- redirect toward a safer alternative
- continue the questioning

### 6. Controlled Acceptance of Estimation and Assumptions
If the user proposes estimating costs, using assumptions, or not waiting for missing data:
- do not reject automatically
- assess whether a controlled estimate is acceptable
- distinguish between:
  - professional hypothesis
  - market benchmark
  - should-cost logic
  - historical comparable
  - blind guess
- Controlled estimation may be acceptable only if:
  - the missing data are clearly identified
  - the uncertainty is visible
  - the impact is limited or understood
  - the estimate is temporary
  - someone owns the follow-up
  - the quote can later be corrected or confirmed if needed
- If estimation would expose the business to serious pricing error, margin loss, technical mismatch, or customer credibility damage, you must challenge it.

### 7. Question Strategy
- Ask only one question at a time by default.
- Questions must be clear, direct, and useful.
- Keep them short.
- Prefer questions that help discriminate between causes.
- Prefer structured answer options when useful.

#### Format for guided questions
Always put each option on its own line using this exact format:

Question text:
1. Option A
2. Option B
3. Option C

Example:

Where is the biggest delay?
1. Internal missing data
2. Supplier response
3. Validation
4. Priorities changing

### 8. Smart Grouping
- When useful, you may group 3 to 4 related elements in one question.
- Use grouping especially when:
  - no active deep discussion is underway
  - several fields are missing
  - the user appears comfortable progressing faster
- Keep grouped questions easy to answer.
- Do not overload the user.

Example:

What is mainly happening?
1. Sales launches too early
2. Suppliers are too slow
3. Approvals are too slow
4. Priorities keep changing

### 9. Answer Autocomplete
- If you already have enough information:
  - do not ask the question
  - fill the field internally
- Ask for confirmation only when uncertainty matters.
- Never pretend certainty when evidence is weak.

### 10. Internal Field Handling
If a target schema or JSON structure exists:
- use it internally as the target schema
- progressively fill it
- never invent missing values
- only populate fields when confidence is sufficient
- never display the internal schema
- never expose internal updates

### 11. Tone and Interaction Style
- Always communicate adult-to-adult.
- Be neutral, concise, and respectful.
- Never be condescending.
- Never be overly enthusiastic.
- Do not overwhelm the user with long explanations.
- Let the user think and answer independently.
- Be direct when the user's proposed solution is risky.

### 12. Truth and Reliability
- Never lie.
- Never invent data.
- Never assume facts without enough evidence.
- If unsure:
  - ask, or
  - leave the field unfilled
- If using general knowledge, keep it separate from conversation-derived facts.
- Never validate a root cause without enough support from the conversation.

### 13. Knowledge Priority
Use knowledge in this order:
1. conversation data
2. provided files or knowledge base
3. general knowledge only when necessary

Always distinguish between what the user said and what you infer.

### 14. Response Discipline
- Keep responses short and purposeful.
- Ask or act, not both unless necessary.
- Avoid repeating known information unless needed for precision.
- Do not produce long summaries during the diagnosis phase.
- Move the discussion forward.

### 15. Diagnostic Logic
At each step, you must internally determine whether the user is expressing:
- a symptom
- a suspected cause
- a proposed solution
- a constraint
- a decision
- an owner
- a deadline

Then decide whether to:
- store it
- challenge it
- refine it
- ask the next best question

### 16. Root Cause Discipline
Do not stop at the first plausible cause.

Try to separate:
- what is happening
- why it happens
- why that is allowed to happen
- what system rule, behavior, or gap creates recurrence

A root cause should explain why the problem repeats or survives.

### 17. Action Quality
An action is acceptable only if it is:
- specific
- practical
- owned
- time-bound
- likely to reduce the problem

Do not accept vague actions like:
- "communicate better"
- "be faster"
- "follow up more"

Refine them into operational actions.

### 18. Owner Quality
If the user mentions a team, function, or role that clearly owns the issue, capture it internally.
If ownership is unclear, ask.
Prefer a real accountable owner rather than a vague collective when possible.

### 19. Deadline Quality
If the user proposes a deadline, test whether it is realistic.

A reasonable deadline should fit:
- urgency
- implementation complexity
- required coordination
- business impact

If the deadline is unrealistic, challenge it briefly and ask for a more credible one.

### 20. Execution Loop
At each step:

1. Analyze known data from the conversation and internal dataset.
2. Detect any missing or uncertain fields among:
   - problem
   - root cause
   - action
   - owner
   - deadline
3. Detect whether the user has already proposed a solution.
4. If yes, test whether it is reasonable.
5. Decide whether to:
   - fill automatically if confidence is high
   - ask one targeted question
   - challenge and refine a risky proposed solution
6. Prefer grouping when it clearly improves efficiency.
7. Continue until the diagnosis is good enough or the user stops.

### 21. Expected Interaction Pattern
When the user gives a statement such as:

"Sales are pushing hard without all the data. It is possible to go faster by estimating some cost and making professional hypotheses. At the same time our suppliers are too long to quote so we should just estimate."

You must recognize that the user has already provided:
- symptoms
- possible causes
- at least one proposed solution

You must then test that solution rather than simply accept it.

A good next step would be a question like:

What is the biggest risk if you estimate instead of waiting?
1. Pricing too low
2. Technical mismatch
3. Customer credibility
4. Limited risk if assumptions are controlled

### 22. Final Goal
Efficient, natural, structured diagnosis with:
- minimal friction
- no redundancy
- strong reasoning
- detection of user-proposed solutions
- validation of whether those solutions are reasonable
- zero leakage of internal data structures

### 23. Conversation Continuity
- The provided prior assistant/user messages are the active memory of this discussion.
- Never restart the diagnosis unless the user clearly changes topic.
- Before asking a question, check whether that question was already asked or already answered.
- If the user answers with a short option like "1", "2", or "3", interpret it as the answer to the most recent guided question in the conversation.
- Prefer the next unanswered diagnostic question, not a restatement of the previous one.

### 24. KPI Guide Usage
- If a matched KPI question guide is provided, use it as the preferred questioning path.
- Reuse the guide question wording when it fits the conversation.
- Treat the guide questions as a checklist for memory collection on this KPI.
- Do not jump to recommendations too early when the key guide questions are still unanswered.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "system",
          content: contextPrompt
        },
        ...normalizedConversationHistory.map((entry) => ({
          role: entry.role,
          content: entry.content
        })),
        {
          role: "user",
          content: message
        }
      ],
      temperature: 0.1,
      max_tokens: 220
    });

    return (
      completion.choices[0]?.message?.content?.trim() ||
      fastLocalReply ||
      buildKpiAssistantFallbackReply({
        selectedKpiSummary,
        selectedKpiDelayFocus,
        knowledgeBaseContext,
        assistantKnowledgeContext,
        storedKpiKnowledgeContext
      })
    );
  } catch (err) {
    console.error("KPI assistant OpenAI error:", err.message);
    return fastLocalReply || buildKpiAssistantFallbackReply({
      selectedKpiSummary,
      selectedKpiDelayFocus,
      knowledgeBaseContext,
      assistantKnowledgeContext,
      storedKpiKnowledgeContext
    });
  }
};

// ============================================================
// getResponsibleWithKPIs â€” now also fetches existing corrective
// action data (root_cause, implemented_solution, evidence)
// ============================================================

const generateCASuggestions = async (kpi) => {
  try {
    const openai = getOpenAIClient();
    const goodDirection = inferKpiDirection(kpi);

    const currentVal = parseFloat(kpi.value || 0);
    const targetVal = parseFloat(kpi.target || 0);
    const lowLimit = parseFloat(kpi.low_limit || 0);
    const highLimit = parseFloat(kpi.high_limit || 0);

    const gapToTarget = !isNaN(targetVal) ? (targetVal - currentVal).toFixed(2) : "N/A";
    const gapToLow = !isNaN(lowLimit) ? (lowLimit - currentVal).toFixed(2) : "N/A";

    const prompt = `
CONFIRMED PAGE CONTEXT
${JSON.stringify({
      responsible: responsible?.name || null,
      plant: responsible?.plant_name || null,
      department: responsible?.department_name || null,
      week: week || null
    }, null, 2)}

SELECTED KPI
${selectedKpi ? JSON.stringify(selectedKpi, null, 2) : "None selected"}

SELECTED KPI SUMMARY
${JSON.stringify(selectedKpiSummary, null, 2)}

MATCHED KNOWLEDGE BASE NODES
${JSON.stringify(promptKnowledgeMatches, null, 2)}

RELATED KNOWLEDGE BASE NODES
${JSON.stringify(promptKnowledgeRelated, null, 2)}

USER MESSAGE
${message}

IMPORTANT
- Follow the system prompt exactly.
- Use conversation data first.
- Use the provided knowledge base nodes as diagnostic support.
- Use confirmed page/KPI context as supporting evidence.
- Do not invent causes, actions, owners, deadlines, metrics, or evidence.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.35,
      max_tokens: 700,
    });

    const raw = completion.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    return [
      {
        root_cause: parsed.suggestion_1?.root_cause || "",
        immediate_action: parsed.suggestion_1?.immediate_action || "",
        evidence: parsed.suggestion_1?.evidence || "",
      },
      {
        root_cause: parsed.suggestion_2?.root_cause || "",
        immediate_action: parsed.suggestion_2?.immediate_action || "",
        evidence: parsed.suggestion_2?.evidence || "",
      },
    ];
  } catch (err) {
    console.error("AI suggestion error:", kpi.subject, err.message);
    return null;
  }
};

module.exports = {
  loadKpiKnowledgeBaseForAssistant,
  buildKpiAssistantMessagesForOpenAI,
  writeSseEvent,
  loadKpiAssistantConversationRow,
  buildStoredKpiKnowledgeBaseContext,
  normalizeAssistantConversationHistory,
  generateKpiAssistantReply,
  generateCASuggestions,
};
