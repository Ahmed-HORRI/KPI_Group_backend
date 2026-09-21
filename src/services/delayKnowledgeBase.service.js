const fs = require("fs");
const path = require("path");

const KNOWLEDGE_BASE_PATH = path.join(__dirname, "data", "estimating-delay-kb.json");
const DEFAULT_MATCH_LIMIT = 4;
const DEFAULT_RELATED_LIMIT = 4;

const STOP_WORDS = new Set([
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
  "i",
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
  "we",
  "what",
  "when",
  "why",
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
  "un",
  "der",
  "die",
  "das",
  "mit",
  "und",
  "wie",
  "was",
  "warum"
]);

let knowledgeBaseCache = {
  mtimeMs: 0,
  entries: [],
  byNodeId: new Map(),
  reverseLinksByTargetId: new Map()
};

const normalizeSearchText = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const tokenizeSearchText = (value) => {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];

  const tokens = normalized
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

  return [...new Set(tokens)];
};

const collectStrings = (value) => {
  if (value === null || value === undefined) return [];

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }

  if (typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }

  return [];
};

const uniqueStrings = (values) => {
  const seen = new Set();
  return values.filter((value) => {
    const normalized = normalizeSearchText(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

const pickBestText = (value) => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const preferredKeys = ["en", "fr", "de", "ar_tn", "zh", "ko"];
  for (const key of preferredKeys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  for (const candidate of Object.values(value)) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return "";
};

const toList = (value, maxItems = 4) =>
  uniqueStrings(collectStrings(value)).slice(0, maxItems);

const summarizeRelation = (relation = {}, linkedEntry = null, direction = "outgoing") => ({
  direction,
  relation_type: relation.relation_type || null,
  relation_label: pickBestText(relation.relation_label) || null,
  strength: Number.isFinite(Number(relation.strength)) ? Number(relation.strength) : null,
  linked_node_id:
    relation.target_node_id ||
    relation.source_node_id ||
    linkedEntry?.data?.node_id ||
    null,
  linked_subject:
    pickBestText(linkedEntry?.data?.subject) ||
    linkedEntry?.subject ||
    null,
  linked_type: linkedEntry?.data?.type || linkedEntry?.type || null
});

const compactKnowledgeBaseEntry = (entry, extra = {}) => {
  const data = entry?.data || {};

  return {
    id: entry?.id || null,
    node_id: data.node_id || null,
    type: data.type || entry?.type || null,
    subject: pickBestText(data.subject) || entry?.subject || "",
    description: pickBestText(data.description) || entry?.description || "",
    function_owner: data.function_owner || null,
    process_stage: data.process_stage || null,
    category_6m: data["6M_category"] || null,
    severity: data.severity || null,
    symptoms: toList(data.symptoms),
    questions: toList(data.questions),
    evidence_to_collect: toList(data.evidence_to_collect),
    root_cause_hypotheses: toList(data.root_cause_hypotheses),
    actions: toList(data.actions),
    metrics: toList(data.metrics),
    tags: toList(data.tags, 6),
    owner_decision: data.collaboration?.decision_needed || null,
    workshop_prompt: data.collaboration?.workshop_prompt || null,
    matched_terms: extra.matchedTerms || [],
    score: extra.score ?? null,
    relation_context: extra.relationContext || []
  };
};

const getSearchFields = (entry) => {
  const data = entry?.data || {};
  const fields = [];

  const pushField = (label, value, weight) => {
    const values = uniqueStrings(collectStrings(value));
    values.forEach((text) => {
      fields.push({ label, text, weight });
    });
  };

  pushField("entry_subject", entry?.subject, 10);
  pushField("entry_description", entry?.description, 8);
  pushField("entry_keywords", entry?.keywords, 12);
  pushField("entry_type", entry?.type, 4);

  pushField("node_id", data.node_id, 10);
  pushField("subject", data.subject, 10);
  pushField("description", data.description, 8);
  pushField("keywords", data.keywords, 12);
  pushField("symptoms", data.symptoms, 7);
  pushField("questions", data.questions, 5);
  pushField("evidence", data.evidence_to_collect, 5);
  pushField("root_cause_hypotheses", data.root_cause_hypotheses, 7);
  pushField("actions", data.actions, 9);
  pushField("metrics", data.metrics, 6);
  pushField("process_stage", data.process_stage, 5);
  pushField("function_owner", data.function_owner, 5);
  pushField("severity", data.severity, 4);
  pushField("category_6m", data["6M_category"], 5);
  pushField("tags", data.tags, 7);
  pushField("collaboration", data.collaboration, 4);
  pushField("effect_links", data.effect_links, 4);

  return fields;
};

const detectIntent = (message) => {
  const normalized = normalizeSearchText(message);
  return {
    wantsSolutions:
      /\b(action|actions|solution|solutions|fix|fixes|corrective|countermeasure|mitigation|recommend|recommendation|next step|next steps|what should we do|what to do|que faire|quoi faire|plan d action|was tun|massnahme)\b/.test(normalized),
    wantsCauses:
      /\b(cause|causes|reason|reasons|why|root cause|problem|problems|diagnos|delay|late|blocked|blocker|pourquoi|ursache|سبب|原因|원인)\b/.test(normalized),
    wantsEffects:
      /\b(effect|effects|impact|impacts|symptom|symptoms|rework|blocked|delay|late|impact commercial)\b/.test(normalized),
    wantsMetrics:
      /\b(metric|metrics|measure|measurement|measured|measurements|kpi|otd|sla|lead time|throughput|backlog|performance|how do we measure)\b/.test(normalized),
    wantsOwner:
      /\b(owner|ownership|responsible|who owns|function owner)\b/.test(normalized)
  };
};

const scoreKnowledgeBaseEntry = (entry, message) => {
  const normalizedMessage = normalizeSearchText(message);
  const tokens = tokenizeSearchText(message);
  const fields = getSearchFields(entry);
  const matchedTerms = new Set();
  const matchedFieldLabels = new Set();
  let score = 0;

  fields.forEach(({ label, text, weight }) => {
    const normalizedText = normalizeSearchText(text);
    if (!normalizedText) return;

    let fieldScore = 0;

    if (normalizedMessage && normalizedText.includes(normalizedMessage)) {
      fieldScore += weight * 6;
      matchedFieldLabels.add(label);
    }

    let tokenHits = 0;
    tokens.forEach((token) => {
      if (normalizedText.includes(token)) {
        tokenHits += 1;
        matchedTerms.add(token);
      }
    });

    if (tokenHits > 0) {
      fieldScore += tokenHits * weight * 1.7;
      matchedFieldLabels.add(label);
    }

    if (tokenHits >= 2) {
      fieldScore += weight;
    }

    score += fieldScore;
  });

  const intent = detectIntent(message);
  const entryType = entry?.data?.type || entry?.type || "";

  if (intent.wantsSolutions && entryType === "solution") score += 32;
  if (intent.wantsCauses && (entryType === "cause" || entryType === "problem")) score += 12;
  if (intent.wantsEffects && entryType === "effect") score += 10;
  if (intent.wantsMetrics && entryType === "metric") score += 72;
  if (intent.wantsMetrics && entryType === "effect") score += 16;
  if (intent.wantsOwner && entry?.data?.function_owner) score += 4;

  if (score > 0) {
    score += matchedFieldLabels.size * 0.75;
  }

  return {
    score: Number(score.toFixed(2)),
    matchedTerms: [...matchedTerms].slice(0, 8)
  };
};

const loadDelayKnowledgeBase = () => {
  const stat = fs.statSync(KNOWLEDGE_BASE_PATH);
  if (
    knowledgeBaseCache.entries.length &&
    knowledgeBaseCache.mtimeMs === stat.mtimeMs
  ) {
    return knowledgeBaseCache;
  }

  const raw = fs.readFileSync(KNOWLEDGE_BASE_PATH, "utf8");
  const entries = JSON.parse(raw);
  const byNodeId = new Map();
  const reverseLinksByTargetId = new Map();

  entries.forEach((entry) => {
    const nodeId = entry?.data?.node_id;
    if (nodeId) {
      byNodeId.set(nodeId, entry);
    }
  });

  entries.forEach((entry) => {
    const sourceNodeId = entry?.data?.node_id;
    const effectLinks = Array.isArray(entry?.data?.effect_links)
      ? entry.data.effect_links
      : [];

    effectLinks.forEach((relation) => {
      if (!relation?.target_node_id) return;

      const current = reverseLinksByTargetId.get(relation.target_node_id) || [];
      current.push({
        source_node_id: sourceNodeId || null,
        source_entry_id: entry?.id || null,
        relation_type: relation.relation_type || null,
        relation_label: relation.relation_label || null,
        strength: relation.strength || null
      });
      reverseLinksByTargetId.set(relation.target_node_id, current);
    });
  });

  knowledgeBaseCache = {
    mtimeMs: stat.mtimeMs,
    entries,
    byNodeId,
    reverseLinksByTargetId
  };

  return knowledgeBaseCache;
};

const searchDelayKnowledgeBase = (message, options = {}) => {
  const { entries, byNodeId, reverseLinksByTargetId } = loadDelayKnowledgeBase();
  const intent = detectIntent(message);
  const preferredNodeIds = Array.isArray(options.preferredNodeIds)
    ? options.preferredNodeIds.filter(Boolean)
    : [];
  const preferredNodeIndex = new Map(
    preferredNodeIds.map((nodeId, index) => [String(nodeId), index])
  );
  const ranked = entries
    .filter((entry) => entry?.type !== "overview")
    .map((entry) => {
      const result = scoreKnowledgeBaseEntry(entry, message);
      const nodeId = String(entry?.data?.node_id || "");
      const preferredIndex = preferredNodeIndex.has(nodeId)
        ? preferredNodeIndex.get(nodeId)
        : -1;
      const preferredBoost =
        preferredIndex >= 0
          ? Math.max(0, 52 - (preferredIndex * 6))
          : 0;
      return {
        entry,
        score: Number((result.score + preferredBoost).toFixed(2)),
        matchedTerms: result.matchedTerms,
        preferredBoost
      };
    })
    .filter((result) => result.score > 0 || result.preferredBoost > 0)
    .sort((a, b) => b.score - a.score);

  const topScore = ranked[0]?.score || 0;
  const strongThreshold = Math.max(14, topScore * 0.28);
  const softThreshold = Math.max(8, topScore * 0.18);
  const limit = options.limit || DEFAULT_MATCH_LIMIT;
  const relatedLimit = options.relatedLimit || DEFAULT_RELATED_LIMIT;

  let matches = ranked
    .filter((result) => result.score >= softThreshold)
    .slice(0, limit);

  const matchNodeIds = new Set(matches.map((result) => result.entry?.data?.node_id).filter(Boolean));
  const relatedCandidates = [];

  matches.forEach((result) => {
    const sourceEntry = result.entry;
    const sourceNodeId = sourceEntry?.data?.node_id;
    const outgoingRelations = Array.isArray(sourceEntry?.data?.effect_links)
      ? sourceEntry.data.effect_links
      : [];

    outgoingRelations.forEach((relation) => {
      const targetEntry = byNodeId.get(relation.target_node_id);
      if (!targetEntry || matchNodeIds.has(relation.target_node_id)) return;

      relatedCandidates.push({
        entry: targetEntry,
        score: Number((((relation.strength || 0) * 10) + (result.score * 0.22)).toFixed(2)),
        matchedTerms: result.matchedTerms,
        relationContext: [summarizeRelation(relation, targetEntry, "outgoing")]
      });
    });

    const incomingRelations = reverseLinksByTargetId.get(sourceNodeId) || [];
    incomingRelations.forEach((relation) => {
      if (!relation.source_node_id || matchNodeIds.has(relation.source_node_id)) return;
      const linkedEntry = byNodeId.get(relation.source_node_id);
      if (!linkedEntry) return;

      relatedCandidates.push({
        entry: linkedEntry,
        score: Number((((relation.strength || 0) * 10) + (result.score * 0.2)).toFixed(2)),
        matchedTerms: result.matchedTerms,
        relationContext: [
          summarizeRelation(
            {
              source_node_id: relation.source_node_id,
              relation_type: relation.relation_type,
              relation_label: relation.relation_label,
              strength: relation.strength
            },
            sourceEntry,
            "incoming"
          )
        ]
      });
    });
  });

  const relatedByNodeId = new Map();
  relatedCandidates.forEach((candidate) => {
    const nodeId = candidate.entry?.data?.node_id;
    if (!nodeId || matchNodeIds.has(nodeId)) return;

    const existing = relatedByNodeId.get(nodeId);
    if (!existing || existing.score < candidate.score) {
      relatedByNodeId.set(nodeId, candidate);
    }
  });

  const promoteRelatedCandidate = (wantedType, boostAmount) => {
    if (matches.some((result) => (result.entry?.data?.type || result.entry?.type) === wantedType)) {
      return;
    }

    const candidate = [...relatedByNodeId.values()]
      .filter((result) => (result.entry?.data?.type || result.entry?.type) === wantedType)
      .sort((a, b) => b.score - a.score)[0];

    if (!candidate) return;

    const boostedScore = Math.max(
      candidate.score + boostAmount,
      (matches[matches.length - 1]?.score || 0) + 0.5
    );

    const promoted = {
      ...candidate,
      score: Number(boostedScore.toFixed(2))
    };

    if (matches.length < limit) {
      matches = [...matches, promoted];
    } else {
      matches = [...matches.slice(0, limit - 1), promoted];
    }

    matches.sort((a, b) => b.score - a.score);
    matchNodeIds.add(promoted.entry?.data?.node_id);
  };

  if (intent.wantsMetrics) {
    promoteRelatedCandidate("metric", 150);
  }

  if (intent.wantsSolutions) {
    promoteRelatedCandidate("solution", 90);
  }

  const related = [...relatedByNodeId.values()]
    .filter((result) => !matchNodeIds.has(result.entry?.data?.node_id))
    .sort((a, b) => b.score - a.score)
    .slice(0, relatedLimit);

  return {
    topScore,
    hasStrongMatch: topScore >= strongThreshold,
    matches,
    related
  };
};

const buildDelayKnowledgeBaseContext = (message, options = {}) => {
  const { entries } = loadDelayKnowledgeBase();
  const overviewEntry = entries.find((entry) => entry?.type === "overview") || null;
  const search = searchDelayKnowledgeBase(message, options);

  return {
    overview: overviewEntry
      ? {
        id: overviewEntry.id || null,
        subject: overviewEntry.subject || "",
        description: overviewEntry.description || "",
        language: overviewEntry.language || null,
        keywords: toList(overviewEntry.keywords, 10)
      }
      : null,
    matches: search.matches.map((result) =>
      compactKnowledgeBaseEntry(result.entry, {
        score: result.score,
        matchedTerms: result.matchedTerms
      })
    ),
    related: search.related.map((result) =>
      compactKnowledgeBaseEntry(result.entry, {
        score: result.score,
        matchedTerms: result.matchedTerms,
        relationContext: result.relationContext
      })
    ),
    diagnostics: {
      top_score: search.topScore,
      has_strong_match: search.hasStrongMatch,
      match_count: search.matches.length,
      related_count: search.related.length
    }
  };
};

const generateDelayKnowledgeBaseFallbackReply = ({
  message,
  knowledgeBaseContext
}) => {
  const context = knowledgeBaseContext || buildDelayKnowledgeBaseContext(message);
  const primary = context.matches[0] || null;

  if (!primary) {
    return [
      "I could not map that question to a strong match in the estimating delay knowledge base.",
      "Try asking about RFQ intake, costing capacity, supplier quotation delays, tooling complexity, rework, shifting priorities, or quote OTD."
    ].join(" ");
  }

  const lines = [
    `Closest match: ${primary.node_id || primary.id} - ${primary.subject}.`,
    primary.description || ""
  ];

  if (primary.root_cause_hypotheses.length) {
    lines.push(`Likely causes: ${primary.root_cause_hypotheses.join("; ")}.`);
  }

  if (primary.actions.length) {
    lines.push(`Recommended actions: ${primary.actions.join("; ")}.`);
  }

  if (primary.metrics.length) {
    lines.push(`Track with: ${primary.metrics.join("; ")}.`);
  }

  if (context.related.length) {
    const relatedSummary = context.related
      .map((entry) => `${entry.node_id || entry.id} - ${entry.subject}`)
      .join("; ");
    lines.push(`Related nodes: ${relatedSummary}.`);
  }

  return lines.filter(Boolean).join(" ");
};

module.exports = {
  buildDelayKnowledgeBaseContext,
  generateDelayKnowledgeBaseFallbackReply,
  loadDelayKnowledgeBase,
  searchDelayKnowledgeBase
};
