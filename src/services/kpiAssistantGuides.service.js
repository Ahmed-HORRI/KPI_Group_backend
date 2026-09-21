const fs = require("fs");
const path = require("path");

const GUIDES_DIRECTORY = path.join(__dirname, "data", "kpi-assistant-guides");
const DEFAULT_RELATED_LIMIT = 2;

let guidesCache = {
  signature: "",
  guides: []
};

const normalizeText = (value) => { 
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const normalizeSearchText = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
};

const flattenStrings = (value) => {
  if (value === undefined || value === null) return [];

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap(flattenStrings);
  }

  if (typeof value === "object") {
    return Object.values(value).flatMap(flattenStrings);
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

const toStringList = (value, maxItems = 12) =>
  uniqueStrings(flattenStrings(value).map((entry) => String(entry).trim()).filter(Boolean)).slice(0, maxItems);

const slugify = (value) =>
  normalizeSearchText(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

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

const normalizeGuideQuestion = (question, index) => {
  if (typeof question === "string") {
    const text = normalizeText(question);
    if (!text) return null;

    return {
      id: slugify(text) || `question_${index + 1}`,
      question: text,
      options: [],
      category: null,
      why_it_matters: null,
      priority: index + 1
    };
  }

  if (!question || typeof question !== "object") return null;

  const text = normalizeText(
    question.question ??
      question.text ??
      question.prompt ??
      question.label
  );

  if (!text) return null;

  return {
    id: normalizeText(question.id) || slugify(text) || `question_${index + 1}`,
    question: text,
    options: toStringList(question.options ?? question.choices ?? question.answers, 6),
    category: normalizeText(question.category),
    why_it_matters: normalizeText(
      question.why_it_matters ??
        question.whyImportant ??
        question.reason
    ),
    priority: Number.isFinite(Number(question.priority))
      ? Number(question.priority)
      : index + 1
  };
};

const normalizeGuideDocument = (rawGuide, sourceFile, guideIndex = 0) => {
  if (!rawGuide || typeof rawGuide !== "object") return null;

  const data = rawGuide.data && typeof rawGuide.data === "object"
    ? rawGuide.data
    : rawGuide;
  const appliesTo = rawGuide.applies_to || rawGuide.appliesTo || {};
  const guideName = normalizeText(
    rawGuide.name ??
      rawGuide.title ??
      pickBestText(data.subject) ??
      rawGuide.subject
  );
  const description = normalizeText(
    rawGuide.description ?? pickBestText(data.description)
  );

  if (!guideName && !description) return null;

  const importantQuestions = toArray(
    rawGuide.important_questions ??
      rawGuide.questions ??
      data.questions
  )
    .map((entry, index) => normalizeGuideQuestion(entry, index))
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority);

  const kpiIds = toStringList(appliesTo.kpi_ids, 30);
  const kpiValuesIds = toStringList(appliesTo.kpi_values_ids, 30);
  const kpiCodes = toStringList(appliesTo.kpi_codes, 30);

  return {
    id:
      normalizeText(rawGuide.id) ||
      normalizeText(data.node_id) ||
      slugify(guideName) ||
      `${path.basename(sourceFile, path.extname(sourceFile))}_${guideIndex + 1}`,
    name: guideName || "Untitled KPI guide",
    description: description || "",
    type: normalizeText(rawGuide.type ?? data.type),
    is_default: Boolean(rawGuide.is_default),
    source_file: sourceFile,
    applies_to: {
      kpi_ids: kpiIds,
      kpi_values_ids: kpiValuesIds,
      kpi_codes: kpiCodes,
      title_keywords: toStringList(appliesTo.title_keywords, 30),
      subtitle_keywords: toStringList(appliesTo.subtitle_keywords, 30),
      message_keywords: toStringList(
        appliesTo.message_keywords ?? appliesTo.keywords,
        30
      )
    },
    important_questions: importantQuestions,
    evidence_to_collect: toStringList(
      rawGuide.evidence_to_collect ?? data.evidence_to_collect,
      8
    ),
    root_cause_hypotheses: toStringList(
      rawGuide.root_cause_hypotheses ?? data.root_cause_hypotheses,
      8
    ),
    actions: toStringList(rawGuide.actions ?? data.actions, 8),
    metrics: toStringList(rawGuide.metrics ?? data.metrics, 8),
    owners: toStringList(
      rawGuide.owners ??
        data.collaboration?.participants ??
        data.function_owner,
      6
    ),
    tags: toStringList(rawGuide.tags ?? data.tags ?? rawGuide.keywords, 10)
  };
};

const getGuideFiles = () => {
  if (!fs.existsSync(GUIDES_DIRECTORY)) {
    return [];
  }

  return fs.readdirSync(GUIDES_DIRECTORY)
    .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
    .sort();
};

const buildGuidesSignature = (fileNames) =>
  fileNames
    .map((fileName) => {
      const absolutePath = path.join(GUIDES_DIRECTORY, fileName);
      const stat = fs.statSync(absolutePath);
      return `${fileName}:${stat.mtimeMs}:${stat.size}`;
    })
    .join("|");

const loadKpiAssistantGuides = () => {
  const fileNames = getGuideFiles();
  const signature = buildGuidesSignature(fileNames);

  if (guidesCache.signature === signature && guidesCache.guides.length) {
    return guidesCache.guides;
  }

  const loadedGuides = [];

  fileNames.forEach((fileName) => {
    const absolutePath = path.join(GUIDES_DIRECTORY, fileName);

    try {
      const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
      const rawGuides = Array.isArray(parsed) ? parsed : [parsed];

      rawGuides.forEach((rawGuide, guideIndex) => {
        const normalizedGuide = normalizeGuideDocument(rawGuide, fileName, guideIndex);
        if (normalizedGuide) {
          loadedGuides.push(normalizedGuide);
        }
      });
    } catch (error) {
      console.error(`[KPI Assistant Guides] Could not load ${fileName}:`, error.message);
    }
  });

  guidesCache = {
    signature,
    guides: loadedGuides
  };

  return loadedGuides;
};

const scoreKeywordMatches = (keywords, haystack, weight, matchedTerms) => {
  let score = 0;

  keywords.forEach((keyword) => {
    const normalizedKeyword = normalizeSearchText(keyword);
    if (!normalizedKeyword || !haystack.includes(normalizedKeyword)) return;
    score += weight;
    matchedTerms.add(keyword);
  });

  return score;
};

const scoreGuideMatch = (guide, selectedKpi = null, message = "") => {
  const matchedTerms = new Set();
  let score = guide.is_default ? 1 : 0;

  const selectedKpiId = normalizeText(selectedKpi?.kpi_id);
  const selectedKpiValuesId = normalizeText(selectedKpi?.kpi_values_id);
  const selectedKpiCode = normalizeText(selectedKpi?.kpi_code);
  const titleText = normalizeSearchText(selectedKpi?.title);
  const subtitleText = normalizeSearchText(selectedKpi?.subtitle);
  const messageText = normalizeSearchText(message);
  const combinedText = [titleText, subtitleText, messageText]
    .filter(Boolean)
    .join(" ");

  if (
    selectedKpiId &&
    guide.applies_to.kpi_ids.some((entry) => String(entry) === String(selectedKpiId))
  ) {
    matchedTerms.add(`kpi_id:${selectedKpiId}`);
    score += 400;
  }

  if (
    selectedKpiValuesId &&
    guide.applies_to.kpi_values_ids.some((entry) => String(entry) === String(selectedKpiValuesId))
  ) {
    matchedTerms.add(`kpi_values_id:${selectedKpiValuesId}`);
    score += 320;
  }

  if (
    selectedKpiCode &&
    guide.applies_to.kpi_codes.some((entry) => normalizeSearchText(entry) === normalizeSearchText(selectedKpiCode))
  ) {
    matchedTerms.add(`kpi_code:${selectedKpiCode}`);
    score += 260;
  }

  score += scoreKeywordMatches(guide.applies_to.title_keywords, titleText, 30, matchedTerms);
  score += scoreKeywordMatches(guide.applies_to.title_keywords, subtitleText, 20, matchedTerms);
  score += scoreKeywordMatches(guide.applies_to.subtitle_keywords, subtitleText, 26, matchedTerms);
  score += scoreKeywordMatches(guide.applies_to.message_keywords, messageText, 18, matchedTerms);
  score += scoreKeywordMatches(guide.tags, combinedText, 10, matchedTerms);

  if (guide.type && combinedText.includes(normalizeSearchText(guide.type))) {
    matchedTerms.add(`type:${guide.type}`);
    score += 12;
  }

  return {
    score,
    matchedTerms: [...matchedTerms]
  };
};

const normalizeConversationHistory = (history = []) =>
  (Array.isArray(history) ? history : [])
    .map((entry) => {
      const role = entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : null;
      const content = normalizeText(
        entry?.content ??
          entry?.contextText ??
          entry?.text ??
          entry?.message
      );
      if (!role || !content) return null;
      return { role, content };
    })
    .filter(Boolean)
    .slice(-24);

const isLowInformationReply = (value) => {
  const normalized = normalizeSearchText(value);
  if (!normalized) return true;

  return [
    "i dont know",
    "dont know",
    "not sure",
    "unknown",
    "n a",
    "na",
    "none",
    "no idea"
  ].includes(normalized);
};

const findGuideQuestionInAssistantText = (assistantText, questions = []) => {
  const normalizedAssistantText = normalizeSearchText(assistantText);
  if (!normalizedAssistantText) return null;

  return questions.find((question) => {
    const normalizedQuestion = normalizeSearchText(question.question);
    return normalizedQuestion && normalizedAssistantText.includes(normalizedQuestion);
  }) || null;
};

const buildGuideQuestionProgress = (guide, conversationHistory = []) => {
  if (!guide) {
    return {
      total_questions: 0,
      answered_count: 0,
      answered_questions: [],
      unanswered_questions: [],
      next_question: null
    };
  }

  const history = normalizeConversationHistory(conversationHistory);
  const answersByQuestionId = new Map();
  const askedQuestionIds = new Set();

  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (entry.role !== "assistant") continue;

    const matchedQuestion = findGuideQuestionInAssistantText(
      entry.content,
      guide.important_questions
    );

    if (!matchedQuestion) continue;
    askedQuestionIds.add(matchedQuestion.id);

    const nextUserReply = history
      .slice(index + 1)
      .find((historyEntry) => historyEntry.role === "user");

    if (nextUserReply && !isLowInformationReply(nextUserReply.content)) {
      answersByQuestionId.set(matchedQuestion.id, nextUserReply.content);
    }
  }

  const answeredQuestions = guide.important_questions
    .filter((question) => answersByQuestionId.has(question.id))
    .map((question) => ({
      id: question.id,
      question: question.question,
      answer: answersByQuestionId.get(question.id)
    }));

  const unansweredQuestions = guide.important_questions
    .filter((question) => !answersByQuestionId.has(question.id))
    .map((question) => ({
      id: question.id,
      question: question.question,
      options: question.options,
      category: question.category,
      why_it_matters: question.why_it_matters,
      already_asked: askedQuestionIds.has(question.id)
    }));

  return {
    total_questions: guide.important_questions.length,
    answered_count: answeredQuestions.length,
    answered_questions: answeredQuestions,
    unanswered_questions: unansweredQuestions.slice(0, 6),
    next_question: unansweredQuestions[0] || null
  };
};

const compactGuide = (guide, scoreData = null) => {
  if (!guide) return null;

  return {
    id: guide.id,
    name: guide.name,
    description: guide.description,
    type: guide.type,
    is_default: guide.is_default,
    source_file: guide.source_file,
    matched_terms: scoreData?.matchedTerms || [],
    score: scoreData?.score ?? null,
    applies_to: {
      kpi_ids: guide.applies_to.kpi_ids,
      kpi_values_ids: guide.applies_to.kpi_values_ids,
      kpi_codes: guide.applies_to.kpi_codes,
      title_keywords: guide.applies_to.title_keywords.slice(0, 8),
      subtitle_keywords: guide.applies_to.subtitle_keywords.slice(0, 8),
      message_keywords: guide.applies_to.message_keywords.slice(0, 8)
    },
    important_questions: guide.important_questions.slice(0, 6),
    evidence_to_collect: guide.evidence_to_collect.slice(0, 6),
    root_cause_hypotheses: guide.root_cause_hypotheses.slice(0, 6),
    actions: guide.actions.slice(0, 6),
    metrics: guide.metrics.slice(0, 6),
    owners: guide.owners.slice(0, 6),
    tags: guide.tags.slice(0, 8)
  };
};

const buildKpiAssistantKnowledgeContext = ({
  selectedKpi = null,
  message = "",
  conversationHistory = [],
  relatedLimit = DEFAULT_RELATED_LIMIT
} = {}) => {
  const guides = loadKpiAssistantGuides();
  if (!guides.length) {
    return {
      matched_guide: null,
      related_guides: [],
      progress: null,
      next_question: null
    };
  }

  const scoredGuides = guides
    .map((guide) => ({
      guide,
      ...scoreGuideMatch(guide, selectedKpi, message)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const matchedEntry = scoredGuides[0] || null;
  const progress = matchedEntry
    ? buildGuideQuestionProgress(matchedEntry.guide, conversationHistory)
    : null;

  return {
    matched_guide: matchedEntry
      ? compactGuide(matchedEntry.guide, matchedEntry)
      : null,
    related_guides: scoredGuides
      .slice(1, Math.max(1, relatedLimit) + 1)
      .map((entry) => compactGuide(entry.guide, entry)),
    progress,
    next_question: progress?.next_question || null
  };
};

const formatKpiAssistantGuidedQuestion = (question = null) => {
  const questionText = normalizeText(question?.question);
  if (!questionText) return "";

  const header = questionText.endsWith(":")
    ? questionText
    : `${questionText}:`;
  const lines = [header];

  toArray(question.options).forEach((option, index) => {
    lines.push(`${index + 1}. ${option}`);
  });

  return lines.join("\n");
};

module.exports = {
  buildKpiAssistantKnowledgeContext,
  formatKpiAssistantGuidedQuestion
};
