const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
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

const normalizeText = (value) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

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

module.exports = {
  loadKpiKnowledgeBaseForAssistant,
  buildKpiAssistantMessagesForOpenAI,
  writeSseEvent,
  loadKpiAssistantConversationRow,
  buildStoredKpiKnowledgeBaseContext,
  normalizeAssistantConversationHistory,
};
