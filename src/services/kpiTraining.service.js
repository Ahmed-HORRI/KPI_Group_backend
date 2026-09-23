const crypto = require("crypto");
const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { createTransporter } = require("../config/mailer");
const { getPeopleDisplayName } = require("../models/kpi.model");
const { escapeHtml, formatDisplayDate } = require("./kpiShared.service");
const { formatIsoDateValue } = require("../utils/weekPeriod");
const { getPeopleHierarchy } = require("./hierarchyReport.service");

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
};

const KPI_TRAINING_DEFAULT_TEST_DUE_DAYS = 7;
const KPI_TRAINING_REMINDER_INTERVAL_DAYS = 7;
const KPI_TRAINING_RESPONSIBLE_REMINDER_COUNT = 3;
const KPI_TRAINING_EXECUTIVE_ESCALATION_DELAY_DAYS = 15;
const KPI_TRAINING_MIN_VALIDATION_SCORE = 80;
const KPI_TRAINING_PENDING_VALIDATION_STATUSES = [
  "training_assigned",
  "training_sent",
  "training_done",
  "test_sent",
  "test_overdue",
  "completed_fail",
  "escalated"
];
const KPI_TRAINING_PENDING_VALIDATION_STATUS_SET = new Set(
  KPI_TRAINING_PENDING_VALIDATION_STATUSES
);
const KPI_TRAINING_EXECUTIVE_ROLE_LOOKUP_NAMES = [
  "ceo",
  "vp finance"
];
const KPI_TRAINING_RESPONSIBLE_REMINDER_STAGES = [
  {
    key: "responsible_reminder_1",
    label: "Reminder 1/3",
    reminderNumber: 1,
    escalationLevel: 1
  },
  {
    key: "responsible_reminder_2",
    label: "Reminder 2/3",
    reminderNumber: 2,
    escalationLevel: 2
  },
  {
    key: "responsible_reminder_3",
    label: "Reminder 3/3",
    reminderNumber: 3,
    escalationLevel: 3
  }
];
const KPI_TRAINING_MANAGER_ESCALATION_STAGE = {
  key: "direct_manager_escalation",
  label: "Direct manager escalation",
  escalationLevel: 4
};
const KPI_TRAINING_EXECUTIVE_ESCALATION_STAGE = {
  key: "executive_escalation",
  label: "Executive escalation",
  escalationLevel: 5
};
const KPI_TRAINING_COMPLETED_STATUSES = new Set([
  "training_assigned",
  "training_sent",
  "training_done",
  "test_sent",
  "test_overdue",
  "completed_pass",
  "completed_fail",
  "escalated"
]);
const KPI_TRAINING_TEST_SENT_STATUSES = new Set([
  "training_assigned",
  "training_sent",
  "training_done",
  "test_sent",
  "test_overdue",
  "completed_pass",
  "completed_fail",
  "escalated"
]);
const KPI_TRAINING_TEST_COMPLETED_STATUSES = new Set([
  "completed_pass",
  "completed_fail"
]);
let kpiTrainingEscalationSchemaPromise = null;

const formatIsoTimestampValue = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const normalizeJsonColumnValue = (value) => {
  if (value === undefined || value === null) return null;

  if (typeof value === "object") {
    return value;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;

    if (
      (text.startsWith("{") && text.endsWith("}")) ||
      (text.startsWith("[") && text.endsWith("]"))
    ) {
      try {
        return JSON.parse(text);
      } catch (error) {
        return text;
      }
    }

    return text;
  }

  return value;
};

const normalizeTrainingPlainText = (value) => {
  if (value === undefined || value === null) return null;

  if (typeof value === "string") {
    const text = value.replace(/\r\n/g, "\n").trim();
    return text || null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
};

const pickFirstPortalText = (...values) => {
  for (const value of values) {
    const text = normalizeTrainingPlainText(value);
    if (text) return text;
  }

  return null;
};

const normalizePortalBulletItems = (value) =>
  toArray(value)
    .flatMap((item) => {
      if (item === undefined || item === null) return [];

      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        const text = normalizeTrainingPlainText(item);
        return text ? [text] : [];
      }

      if (typeof item === "object") {
        const text = pickFirstPortalText(
          item.text,
          item.label,
          item.title,
          item.value,
          item.name,
          item.description
        );
        return text ? [text] : [];
      }

      return [];
    })
    .filter(Boolean);

const buildNormalizedTrainingBlocks = (rawContent) => {
  const parsedContent = normalizeJsonColumnValue(rawContent);
  if (!parsedContent) return [];

  const blocks = [];
  const seenSignatures = new Set();
  const childKeys = [
    "sections",
    "modules",
    "lessons",
    "slides",
    "items",
    "content",
    "topics",
    "steps",
    "chapters",
    "parts",
    "cards",
    "entries"
  ];
  const bulletKeys = [
    "bullets",
    "points",
    "takeaways",
    "key_points",
    "keyPoints",
    "highlights",
    "checklist",
    "objectives",
    "outcomes",
    "options",
    "choices"
  ];

  const pushBlock = ({ title = null, body = null, bullets = [] } = {}) => {
    const normalizedTitle = normalizeTrainingPlainText(title);
    const normalizedBody = normalizeTrainingPlainText(body);
    const normalizedBullets = Array.from(
      new Set(normalizePortalBulletItems(bullets))
    );

    if (!normalizedTitle && !normalizedBody && !normalizedBullets.length) {
      return;
    }

    const signature = JSON.stringify([
      normalizedTitle || "",
      normalizedBody || "",
      normalizedBullets
    ]).toLowerCase();

    if (seenSignatures.has(signature)) {
      return;
    }

    seenSignatures.add(signature);
    blocks.push({
      id: `training-block-${blocks.length + 1}`,
      title: normalizedTitle || `Learning Block ${blocks.length + 1}`,
      body: normalizedBody || "",
      bullets: normalizedBullets
    });
  };

  const visitNode = (node, fallbackTitle = null) => {
    if (node === undefined || node === null) return;

    if (Array.isArray(node)) {
      node.forEach((entry) => visitNode(entry, fallbackTitle));
      return;
    }

    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      pushBlock({
        title: fallbackTitle,
        body: node
      });
      return;
    }

    if (typeof node !== "object") {
      return;
    }

    const title = pickFirstPortalText(
      node.title,
      node.heading,
      node.name,
      node.label,
      node.question,
      node.prompt,
      fallbackTitle
    );

    const bodySegments = [
      node.text,
      typeof node.content === "string" ? node.content : null,
      node.description,
      node.body,
      node.summary,
      node.explanation,
      node.instructions,
      node.note,
      node.notes,
      node.context,
      node.overview
    ]
      .map((entry) => normalizeTrainingPlainText(entry))
      .filter(Boolean);

    const bulletItems = bulletKeys.flatMap((key) => normalizePortalBulletItems(node[key]));

    if (title || bodySegments.length || bulletItems.length) {
      pushBlock({
        title,
        body: bodySegments.join("\n\n"),
        bullets: bulletItems
      });
    }

    childKeys.forEach((key) => {
      const child = node[key];
      if (Array.isArray(child)) {
        visitNode(child, title);
      } else if (child && typeof child === "object") {
        visitNode(child, title);
      }
    });
  };

  visitNode(parsedContent);
  return blocks.slice(0, 80);
};

const buildComparableToken = (value) => {
  const normalized = normalizeTrainingPlainText(value);
  return normalized ? normalized.toLowerCase() : null;
};

const QUESTION_OPTION_LINE_RE = /^\s*([A-Z]|\d{1,2})[\.\)\:\-]\s+(.+?)\s*$/i;

const normalizePortalQuestionText = (value) => {
  const normalized = normalizeTrainingPlainText(value);
  if (!normalized) return null;

  return normalized
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const extractInlineQuestionOptions = (value) => {
  const normalized = normalizePortalQuestionText(value);
  if (!normalized) {
    return {
      text: "",
      options: []
    };
  }

  const lines = normalized
    .split(/\n+/)
    .map((line) => normalizeTrainingPlainText(line))
    .filter(Boolean);
  const options = [];
  const keptLines = [];

  lines.forEach((line, index) => {
    const match = line.match(QUESTION_OPTION_LINE_RE);
    if (!match) {
      keptLines.push(line);
      return;
    }

    const key = normalizeTrainingPlainText(match[1]) || `option-${index + 1}`;
    const label = normalizeTrainingPlainText(match[2]);
    if (!label) return;

    options.push({
      key: key.toUpperCase(),
      label
    });
  });

  return {
    text: keptLines.join("\n").trim(),
    options
  };
};

const extractObjectQuestionOptions = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const sortWeight = (key) => {
    const normalizedKey = String(key || "").trim().toUpperCase();
    if (/^[A-Z]$/.test(normalizedKey)) return normalizedKey.charCodeAt(0) - 64;
    if (/^\d+$/.test(normalizedKey)) return 100 + Number(normalizedKey);
    return 1000;
  };

  return Object.entries(value)
    .map(([rawKey, rawValue], index) => {
      const label = rawValue && typeof rawValue === "object"
        ? pickFirstPortalText(rawValue.text, rawValue.label, rawValue.title, rawValue.value, rawValue.name, rawValue.answer)
        : pickFirstPortalText(rawValue);

      if (!label) return null;

      return {
        key: normalizeTrainingPlainText(rawKey) || `option-${index + 1}`,
        label,
        sortOrder: sortWeight(rawKey)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map(({ key, label }) => ({ key, label }));
};

const extractNamedQuestionOptions = (node = {}) => {
  if (!node || typeof node !== "object") return [];

  const optionFieldGroups = [
    ["option_a", "optionA", "choice_a", "choiceA", "answer_a", "answerA", "response_a", "responseA", "a", "A"],
    ["option_b", "optionB", "choice_b", "choiceB", "answer_b", "answerB", "response_b", "responseB", "b", "B"],
    ["option_c", "optionC", "choice_c", "choiceC", "answer_c", "answerC", "response_c", "responseC", "c", "C"],
    ["option_d", "optionD", "choice_d", "choiceD", "answer_d", "answerD", "response_d", "responseD", "d", "D"],
    ["option_e", "optionE", "choice_e", "choiceE", "answer_e", "answerE", "response_e", "responseE", "e", "E"],
    ["option_f", "optionF", "choice_f", "choiceF", "answer_f", "answerF", "response_f", "responseF", "f", "F"]
  ];

  return optionFieldGroups
    .map((fieldNames, index) => {
      for (const fieldName of fieldNames) {
        const value = node[fieldName];
        const label = value && typeof value === "object"
          ? pickFirstPortalText(value.text, value.label, value.title, value.value, value.name, value.answer)
          : pickFirstPortalText(value);

        if (label) {
          return {
            key: String.fromCharCode(65 + index),
            label
          };
        }
      }

      return null;
    })
    .filter(Boolean);
};

const buildNormalizedQuestionnaire = (rawQuestionnaire) => {
  const parsedQuestionnaire = normalizeJsonColumnValue(rawQuestionnaire);
  if (!parsedQuestionnaire) return [];

  const questions = [];
  const childKeys = ["questions", "items", "sections", "pages", "groups", "quiz", "questionnaire", "chapters", "modules", "lessons", "slides", "topics", "steps", "parts", "cards", "entries", "content"];
  const optionKeys = ["options", "choices", "answers", "propositions", "responses"];

  const visitNode = (node, fallbackTitle = null) => {
    if (node === undefined || node === null) return;

    if (Array.isArray(node)) {
      node.forEach((entry) => visitNode(entry, fallbackTitle));
      return;
    }

    if (typeof node !== "object") {
      return;
    }

    const rawPrompt = pickFirstPortalText(
      node.question,
      node.prompt,
      node.title,
      node.label,
      node.text,
      node.name,
      fallbackTitle
    );
    const rawHelpText = pickFirstPortalText(
      node.description,
      node.explanation,
      node.help_text,
      node.helpText,
      node.instructions,
      node.context
    );
    const promptExtraction = extractInlineQuestionOptions(rawPrompt);
    const helpExtraction = extractInlineQuestionOptions(rawHelpText);
    const inlineOptionText = pickFirstPortalText(
      typeof node.options === "string" ? node.options : null,
      typeof node.choices === "string" ? node.choices : null,
      typeof node.answers === "string" ? node.answers : null,
      typeof node.propositions === "string" ? node.propositions : null,
      typeof node.responses === "string" ? node.responses : null,
      node.option_text,
      node.optionText,
      node.choice_text,
      node.choiceText
    );
    const inlineOptionExtraction = extractInlineQuestionOptions(inlineOptionText);
    const prompt = pickFirstPortalText(promptExtraction.text, rawPrompt, fallbackTitle);

    const rawCorrectValues = [
      ...toArray(node.correct_answers),
      ...toArray(node.correctAnswers),
      ...toArray(node.valid_answers),
      ...toArray(node.validAnswers),
      ...toArray(node.expected_answers),
      ...toArray(node.expectedAnswers)
    ]
      .map((entry) => normalizeTrainingPlainText(entry))
      .filter(Boolean);

    const singleCorrectValue = pickFirstPortalText(
      node.correct_option_id,
      node.correctOptionId,
      node.correct_answer,
      node.correctAnswer,
      node.expected_answer,
      node.expectedAnswer,
      node.right_answer,
      node.rightAnswer,
      node.solution,
      typeof node.answer === "string" ? node.answer : null
    );

    if (singleCorrectValue) {
      rawCorrectValues.push(singleCorrectValue);
    }

    const correctIndexSet = new Set(
      [
        ...toArray(node.correct_index),
        ...toArray(node.correctIndex),
        ...toArray(node.correct_indexes),
        ...toArray(node.correctIndexes),
        ...toArray(node.correct_option_index),
        ...toArray(node.correctOptionIndex)
      ]
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry >= 0)
    );

    const correctTokenSet = new Set(
      rawCorrectValues
        .map((entry) => buildComparableToken(entry))
        .filter(Boolean)
    );
    const implicitHelpAnswerToken = buildComparableToken(helpExtraction.text || rawHelpText);

    const rawOptions = optionKeys
      .map((key) => node[key])
      .find((entry) => Array.isArray(entry) && entry.length);
    const rawOptionObject = optionKeys
      .map((key) => node[key])
      .find((entry) => entry && typeof entry === "object" && !Array.isArray(entry));

    let options = Array.isArray(rawOptions)
      ? rawOptions
        .map((option, optionIndex) => {
          if (option === undefined || option === null) return null;

          const label = typeof option === "object"
            ? pickFirstPortalText(option.text, option.label, option.title, option.value, option.name, option.answer)
            : pickFirstPortalText(option);
          if (!label) return null;

          const explicitKey = typeof option === "object"
            ? pickFirstPortalText(option.key, option.id, option.value, option.code)
            : null;
          const key = explicitKey || `option-${optionIndex + 1}`;
          const comparisonTokens = new Set(
            [
              key,
              label,
              typeof option === "object" ? option.value : null,
              typeof option === "object" ? option.id : null,
              optionIndex,
              optionIndex + 1
            ]
              .map((entry) => buildComparableToken(entry))
              .filter(Boolean)
          );

          const isCorrectFlag = typeof option === "object" && (
            option.correct === true ||
            option.is_correct === true ||
            option.isCorrect === true ||
            option.valid === true ||
            option.expected === true ||
            option.answer === true
          );

          const isCorrect = Boolean(
            isCorrectFlag ||
            correctIndexSet.has(optionIndex) ||
            correctIndexSet.has(optionIndex + 1) ||
            Array.from(comparisonTokens).some((token) => correctTokenSet.has(token)) ||
            (!correctTokenSet.size && implicitHelpAnswerToken && Array.from(comparisonTokens).some((token) => token === implicitHelpAnswerToken))
          );

          return {
            key,
            label,
            isCorrect
          };
        })
        .filter(Boolean)
      : [];

    if (!options.length) {
      const inlineOptions = [
        ...promptExtraction.options,
        ...helpExtraction.options,
        ...inlineOptionExtraction.options,
        ...extractObjectQuestionOptions(rawOptionObject),
        ...extractNamedQuestionOptions(node)
      ].filter((option) => option && option.label);
      const seenInlineLabels = new Set();

      options = inlineOptions.filter((option, optionIndex) => {
        const labelToken = buildComparableToken(option.label);
        if (!labelToken || seenInlineLabels.has(labelToken)) return false;
        seenInlineLabels.add(labelToken);
        return true;
      }).map((option, optionIndex) => {
        const normalizedKey = normalizeTrainingPlainText(option.key) || `option-${optionIndex + 1}`;
        const keyToken = buildComparableToken(normalizedKey);
        const labelToken = buildComparableToken(option.label);

        return {
          key: normalizedKey,
          label: option.label,
          isCorrect: Boolean(
            (labelToken && correctTokenSet.has(labelToken)) ||
            (keyToken && correctTokenSet.has(keyToken)) ||
            (!correctTokenSet.size && implicitHelpAnswerToken && (labelToken === implicitHelpAnswerToken || keyToken === implicitHelpAnswerToken)) ||
            correctIndexSet.has(optionIndex) ||
            correctIndexSet.has(optionIndex + 1)
          )
        };
      });
    }

    const acceptedAnswers = options.length
      ? []
      : [
        ...rawCorrectValues.filter(Boolean),
        ...(!rawCorrectValues.length && implicitHelpAnswerToken ? [helpExtraction.text || rawHelpText] : [])
      ].filter(Boolean);
    let helpText = pickFirstPortalText(helpExtraction.text, rawHelpText) || "";
    const helpToken = buildComparableToken(helpText);

    if (helpToken) {
      const acceptedTokenSet = new Set(
        acceptedAnswers
          .map((entry) => buildComparableToken(entry))
          .filter(Boolean)
      );
      const correctOptionTokenSet = new Set(
        options
          .filter((option) => option.isCorrect)
          .flatMap((option) => [option.label, option.key])
          .map((entry) => buildComparableToken(entry))
          .filter(Boolean)
      );

      if (acceptedTokenSet.has(helpToken) || correctOptionTokenSet.has(helpToken)) {
        helpText = "";
      }
    }

    const scorable = options.length
      ? options.some((option) => option.isCorrect)
      : acceptedAnswers.length > 0;

    const looksLikeQuestion = Boolean(
      prompt &&
      (options.length || acceptedAnswers.length || node.question || node.prompt)
    );

    if (looksLikeQuestion) {
      questions.push({
        id: pickFirstPortalText(node.id, node.question_id, node.questionId) || "",
        prompt,
        helpText: helpText || "",
        type: options.length
          ? (options.filter((option) => option.isCorrect).length > 1 ? "multi" : "single")
          : "text",
        options,
        acceptedAnswers,
        scorable
      });
    }

    childKeys.forEach((key) => {
      const child = node[key];
      if (Array.isArray(child)) {
        visitNode(child, prompt || fallbackTitle);
      } else if (child && typeof child === "object") {
        visitNode(child, prompt || fallbackTitle);
      }
    });
  };

  visitNode(parsedQuestionnaire);

  return questions.map((question, index) => ({
    ...question,
    id: question.id || `question-${index + 1}`,
    order: index + 1
  }));
};

const buildClientFacingQuestion = (question = {}) => ({
  id: question.id,
  order: question.order,
  prompt: question.prompt,
  help_text: question.helpText || "",
  type: question.type || "single",
  options: Array.isArray(question.options)
    ? question.options.map((option) => ({
      key: option.key,
      label: option.label
    }))
    : []
});

const mergeTrainingQuestions = (primaryQuestions = [], fallbackQuestions = []) => {
  const primary = Array.isArray(primaryQuestions) ? primaryQuestions : [];
  const fallback = Array.isArray(fallbackQuestions) ? fallbackQuestions : [];

  if (!primary.length) {
    return fallback;
  }

  const fallbackByPrompt = new Map();
  fallback.forEach((question) => {
    const key = buildComparableToken(question?.prompt);
    if (key && !fallbackByPrompt.has(key)) {
      fallbackByPrompt.set(key, question);
    }
  });

  return primary.map((question, index) => {
    const promptKey = buildComparableToken(question?.prompt);
    const fallbackQuestion =
      (promptKey ? fallbackByPrompt.get(promptKey) : null) ||
      fallback[index] ||
      null;

    if (!fallbackQuestion) {
      return question;
    }

    const primaryOptions = Array.isArray(question.options) ? question.options : [];
    const fallbackOptions = Array.isArray(fallbackQuestion.options) ? fallbackQuestion.options : [];

    if (primaryOptions.length || !fallbackOptions.length) {
      return question;
    }

    const acceptedTokenSet = new Set(
      toArray(question.acceptedAnswers)
        .map((entry) => buildComparableToken(entry))
        .filter(Boolean)
    );

    const mergedOptions = fallbackOptions.map((option) => {
      const optionKeyToken = buildComparableToken(option.key);
      const optionLabelToken = buildComparableToken(option.label);

      return {
        ...option,
        isCorrect: Boolean(
          option.isCorrect ||
          (optionKeyToken && acceptedTokenSet.has(optionKeyToken)) ||
          (optionLabelToken && acceptedTokenSet.has(optionLabelToken))
        )
      };
    });

    const correctOptionCount = mergedOptions.filter((option) => option.isCorrect).length;
    let mergedHelpText = question.helpText || fallbackQuestion.helpText || "";
    const mergedHelpToken = buildComparableToken(mergedHelpText);

    if (mergedHelpToken) {
      const mergedCorrectTokenSet = new Set(
        mergedOptions
          .filter((option) => option.isCorrect)
          .flatMap((option) => [option.label, option.key])
          .map((entry) => buildComparableToken(entry))
          .filter(Boolean)
      );

      if (mergedCorrectTokenSet.has(mergedHelpToken)) {
        mergedHelpText = "";
      }
    }

    return {
      ...question,
      helpText: mergedHelpText,
      type: correctOptionCount > 1 ? "multi" : "single",
      options: mergedOptions,
      acceptedAnswers: [],
      scorable: mergedOptions.some((option) => option.isCorrect) || question.scorable
    };
  });
};

const normalizeSubmittedTrainingAnswers = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalizedAnswers = {};

  Object.entries(value).forEach(([questionId, answerValue]) => {
    const normalizedQuestionId = normalizeOptionalTextInput(questionId);
    if (!normalizedQuestionId) return;

    normalizedAnswers[normalizedQuestionId] = toArray(answerValue)
      .map((entry) => normalizeTrainingPlainText(entry))
      .filter(Boolean);
  });

  return normalizedAnswers;
};

const scoreTrainingQuestionnaire = (questions = [], submittedAnswers = {}) => {
  const normalizedQuestions = Array.isArray(questions) ? questions : [];
  const answerMap = normalizeSubmittedTrainingAnswers(submittedAnswers);

  let scorableCount = 0;
  let correctCount = 0;

  const responses = normalizedQuestions.map((question) => {
    const selectedValues = Array.from(
      new Set(
        toArray(answerMap[question.id]).map((entry) => normalizeTrainingPlainText(entry)).filter(Boolean)
      )
    );
    const selectedTokenSet = new Set(
      selectedValues.map((entry) => buildComparableToken(entry)).filter(Boolean)
    );

    let isCorrect = null;
    let correctLabels = [];

    if (question.type === "text" && Array.isArray(question.acceptedAnswers) && question.acceptedAnswers.length) {
      scorableCount += 1;
      correctLabels = question.acceptedAnswers.slice();
      const acceptedTokenSet = new Set(
        question.acceptedAnswers
          .map((entry) => buildComparableToken(entry))
          .filter(Boolean)
      );
      isCorrect = selectedValues.length > 0 &&
        selectedValues.length === 1 &&
        acceptedTokenSet.has(buildComparableToken(selectedValues[0]));
    } else {
      const correctOptions = Array.isArray(question.options)
        ? question.options.filter((option) => option.isCorrect)
        : [];
      if (correctOptions.length) {
        scorableCount += 1;
        correctLabels = correctOptions.map((option) => option.label);
        const correctTokenSet = new Set(
          correctOptions
            .map((option) => buildComparableToken(option.key))
            .filter(Boolean)
        );
        isCorrect =
          selectedTokenSet.size === correctTokenSet.size &&
          Array.from(correctTokenSet).every((token) => selectedTokenSet.has(token));
      }
    }

    if (isCorrect === true) {
      correctCount += 1;
    }

    const selectedLabels = question.type === "text"
      ? selectedValues
      : Array.isArray(question.options)
        ? question.options
          .filter((option) => selectedTokenSet.has(buildComparableToken(option.key)))
          .map((option) => option.label)
        : selectedValues;

    return {
      question_id: question.id,
      prompt: question.prompt,
      type: question.type,
      selected_values: selectedValues,
      selected_labels: selectedLabels,
      correct_labels: correctLabels,
      is_correct: isCorrect
    };
  });

  const score = scorableCount > 0
    ? Number(((correctCount / scorableCount) * 100).toFixed(2))
    : null;

  return {
    score,
    correctCount,
    scorableCount,
    responses
  };
};

const buildTrainingReview = (rawAnswersJson, fullQuestions = []) => {
  const parsedAnswers = normalizeJsonColumnValue(rawAnswersJson);
  if (!parsedAnswers) return [];

  const directResponses = Array.isArray(parsedAnswers?.questions)
    ? parsedAnswers.questions
    : Array.isArray(parsedAnswers?.responses)
      ? parsedAnswers.responses
      : [];

  if (directResponses.length) {
    return directResponses.map((entry, index) => ({
      question_id: normalizeOptionalTextInput(entry.question_id ?? entry.questionId) || `review-${index + 1}`,
      prompt: normalizeOptionalTextInput(entry.prompt) || `Question ${index + 1}`,
      selected_labels: Array.isArray(entry.selected_labels)
        ? entry.selected_labels
        : toArray(entry.selected_labels ?? entry.selected_values ?? entry.selectedValue).filter(Boolean),
      correct_labels: Array.isArray(entry.correct_labels)
        ? entry.correct_labels
        : toArray(entry.correct_labels ?? entry.correct_values ?? entry.correctValue).filter(Boolean),
      is_correct: entry.is_correct === true ? true : entry.is_correct === false ? false : null
    }));
  }

  const answerMap = normalizeSubmittedTrainingAnswers(
    parsedAnswers.answers && typeof parsedAnswers.answers === "object"
      ? parsedAnswers.answers
      : parsedAnswers
  );

  if (!Object.keys(answerMap).length || !Array.isArray(fullQuestions) || !fullQuestions.length) {
    return [];
  }

  return scoreTrainingQuestionnaire(fullQuestions, answerMap).responses;
};

const buildTrainingPortalAssignment = (row = {}) => {
  const status =
    normalizeOptionalTextInput(row.status) ||
    "training_sent";
  const normalizedTrainingHtml = normalizeOptionalTextInput(row.training_html);
  const trainingBlocks = buildNormalizedTrainingBlocks(row.training_content);
  const questionnaireQuestions = buildNormalizedQuestionnaire(row.questionnaire_json);
  const trainingQuestions = buildNormalizedQuestionnaire(row.training_content);
  const fullQuestions = mergeTrainingQuestions(questionnaireQuestions, trainingQuestions);
  const review = buildTrainingReview(row.answers_json, fullQuestions);
  const parsedPassScore = Number(row.pass_score);
  const trainingCompleted =
    Boolean(row.training_completed_at) ||
    KPI_TRAINING_COMPLETED_STATUSES.has(status);
  const testAvailable = Boolean(normalizeOptionalIntegerInput(row.test_id));
  const passScore = testAvailable
    ? (Number.isFinite(parsedPassScore) ? parsedPassScore : 80)
    : null;
  const testCompleted =
    Boolean(row.test_completed_at) ||
    KPI_TRAINING_TEST_COMPLETED_STATUSES.has(status);
  const progressPercent = testCompleted ? 100 : 72;

  return {
    result_id: normalizeOptionalIntegerInput(row.result_id),
    training_id: normalizeOptionalIntegerInput(row.training_id),
    test_id: normalizeOptionalIntegerInput(row.test_id),
    people_id: normalizeOptionalIntegerInput(row.people_id),
    kpi_id: normalizeOptionalIntegerInput(row.kpi_id),
    kpi_target_allocation_id: normalizeOptionalIntegerInput(row.kpi_target_allocation_id),
    status,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    passed: row.passed === true,
    escalation_level: Number(row.escalation_level || 0),
    due_date: formatIsoDateValue(row.test_due_date),
    training_sent_at: formatIsoTimestampValue(row.training_sent_at),
    training_completed_at: formatIsoTimestampValue(row.training_completed_at),
    test_sent_at: formatIsoTimestampValue(row.test_sent_at),
    test_completed_at: formatIsoTimestampValue(row.test_completed_at),
    last_reminder_sent_at: formatIsoTimestampValue(row.last_reminder_sent_at),
    next_reminder_due_at: formatIsoTimestampValue(row.next_reminder_due_at),
    created_at: formatIsoTimestampValue(row.created_at),
    updated_at: formatIsoTimestampValue(row.updated_at),
    comments: normalizeOptionalTextInput(row.comments) || "",
    progress: {
      training_completed: trainingCompleted,
      test_available: testAvailable,
      test_sent: Boolean(row.test_sent_at) || KPI_TRAINING_TEST_SENT_STATUSES.has(status),
      test_completed: testCompleted,
      progress_percent: progressPercent
    },
    responsible: {
      people_id: normalizeOptionalIntegerInput(row.people_id),
      name: normalizeOptionalTextInput(row.people_name) || "Responsible",
      email: normalizeOptionalTextInput(row.people_email),
      role_name: normalizeOptionalTextInput(row.role_name) || ""
    },
    kpi: {
      id: normalizeOptionalIntegerInput(row.kpi_id),
      name: normalizeOptionalTextInput(row.kpi_name) || `KPI #${row.kpi_id}`,
      frequency: normalizeOptionalTextInput(row.kpi_frequency) || ""
    },
    training: {
      id: normalizeOptionalIntegerInput(row.training_id),
      name: normalizeOptionalTextInput(row.training_name) || `Training #${row.training_id}`,
      version: normalizeOptionalTextInput(row.training_version) || "",
      comments: normalizeOptionalTextInput(row.training_comments) || "",
      html: normalizedTrainingHtml,
      html_available: Boolean(normalizedTrainingHtml),
      blocks: trainingBlocks,
      block_count: trainingBlocks.length
    },
    test: {
      available: testAvailable,
      id: normalizeOptionalIntegerInput(row.test_id),
      name: normalizeOptionalTextInput(row.test_name) || "Knowledge Check",
      version: normalizeOptionalTextInput(row.test_version) || "",
      comments: normalizeOptionalTextInput(row.test_comments) || "",
      pass_score: passScore,
      question_count: fullQuestions.length,
      scorable_count: fullQuestions.filter((question) => question.scorable).length,
      questions: fullQuestions.map((question) => buildClientFacingQuestion(question))
    },
    review
  };
};

const loadKpiTrainingPortalRows = async ({
  peopleId = null,
  resultId = null
} = {}) => {
  const conditions = [];
  const params = [];

  if (normalizeOptionalIntegerInput(peopleId)) {
    params.push(Number(peopleId));
    conditions.push(`ktr.people_id = $${params.length}`);
  }

  if (normalizeOptionalIntegerInput(resultId)) {
    params.push(Number(resultId));
    conditions.push(`ktr.result_id = $${params.length}`);
  }

  const whereClause = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const result = await pool.query(
    `SELECT
      ktr.result_id,
      ktr.training_id,
      ktr.test_id,
      ktr.people_id,
      ktr.kpi_id,
      ktr.kpi_target_allocation_id,
      NULLIF(TRIM(CONCAT_WS(' ', COALESCE(p.first_name,''), COALESCE(p.name,''))), '') AS people_name,
      p.email AS people_email,
      pra_role.role_name,
      COALESCE(k.kpi_sub_title, k.kpi_name, 'KPI #' || ktr.kpi_id) AS kpi_name,
      k.frequency AS kpi_frequency,
      COALESCE(kt.training_name, 'Training #' || ktr.training_id) AS training_name,
      kt.training_content,
      kt.training_html,
      kt.version AS training_version,
      kt.comments AS training_comments,
      COALESCE(ktest.test_name, 'Knowledge Check') AS test_name,
      ktest.questionnaire_json,
      ktest.pass_score,
      ktest.version AS test_version,
      ktest.comments AS test_comments,
      ktr.answers_json,
      ktr.status,
      ktr.score,
      COALESCE(
        ktr.passed,
        CASE
          WHEN ktr.score IS NULL THEN NULL
          WHEN ktr.score >= GREATEST(COALESCE(ktest.pass_score, 80), 80) THEN TRUE
          ELSE FALSE
        END
      ) AS passed,
      ktr.escalation_level,
      ktr.test_due_date,
      ktr.training_sent_at,
      ktr.training_completed_at,
      ktr.test_sent_at,
      ktr.test_completed_at,
      ktr.last_reminder_sent_at,
      ktr.next_reminder_due_at,
      ktr.comments,
      ktr.created_at,
      ktr.updated_at
    FROM public.kpi_training_result ktr
    LEFT JOIN public.people p ON p.people_id = ktr.people_id
    LEFT JOIN LATERAL (
      SELECT r.role_name
      FROM public.people_role_assignment pra
      JOIN public.role r ON r.role_id = pra.role_id
      WHERE pra.people_id = ktr.people_id
        AND COALESCE(pra.assignment_status,'ACTIVE') = 'ACTIVE'
        AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
      ORDER BY COALESCE(pra.is_primary,false) DESC,
               pra.allocation_percentage DESC NULLS LAST,
               pra.assignment_id DESC
      LIMIT 1
    ) pra_role ON TRUE
    LEFT JOIN public.kpi k           ON k.kpi_id       = ktr.kpi_id
    LEFT JOIN public.kpi_training kt ON kt.training_id = ktr.training_id
    LEFT JOIN public.kpi_test ktest  ON ktest.test_id  = ktr.test_id
    ${whereClause}
    ORDER BY
      CASE ktr.status
        WHEN 'escalated'      THEN 1
        WHEN 'test_overdue'   THEN 2
        WHEN 'completed_fail' THEN 3
        WHEN 'test_sent'      THEN 4
        WHEN 'training_done'  THEN 5
        WHEN 'training_sent'  THEN 6
        WHEN 'completed_pass' THEN 7
        ELSE 8
      END,
      ktr.escalation_level DESC,
      ktr.test_due_date ASC NULLS LAST,
      ktr.result_id DESC`,
    params
  );

  return result.rows;
};

const getKpiTrainingAppBaseUrl = () =>
  (
    normalizeOptionalTextInput(process.env.APP_BASE_URL) ||
    "https://kpi-form.azurewebsites.net"
  ).replace(/\/+$/, "");

const normalizeKpiTrainingRoleLookupName = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const getKpiTrainingRequiredValidationScore = (row = {}) => {
  const configuredPassScore = Number(row.pass_score);
  return Number.isFinite(configuredPassScore)
    ? Math.max(KPI_TRAINING_MIN_VALIDATION_SCORE, configuredPassScore)
    : KPI_TRAINING_MIN_VALIDATION_SCORE;
};

const isKpiTrainingValidationPending = (row = {}) => {
  const status = normalizeOptionalTextInput(row.status) || "";
  const hasLinkedTest = Boolean(normalizeOptionalIntegerInput(row.test_id));
  const score = row.score === null || row.score === undefined ? null : Number(row.score);
  const requiredScore = getKpiTrainingRequiredValidationScore(row);

  if (!hasLinkedTest && (status === "training_done" || row.training_completed_at)) {
    return false;
  }

  if (Number.isFinite(score)) {
    return score < requiredScore;
  }

  if (row.passed === true || status === "completed_pass") {
    return false;
  }

  return KPI_TRAINING_PENDING_VALIDATION_STATUS_SET.has(status) || !status;
};

const getKpiTrainingLifecycleAnchor = (row = {}) =>
  row.training_sent_at || row.created_at || null;

const addDaysToTimestamp = (value, days) => {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setDate(date.getDate() + Number(days || 0));
  return date;
};

const isTimestampDue = (value, now = new Date()) => {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime();
};

const formatKpiTrainingPercent = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Number.isInteger(parsed) ? `${parsed}%` : `${parsed.toFixed(1)}%`;
};

const buildKpiTrainingValidationStatusText = (row = {}) => {
  const scoreLabel = formatKpiTrainingPercent(row.score);
  const requiredScore = getKpiTrainingRequiredValidationScore(row);
  const status = normalizeOptionalTextInput(row.status) || "training_assigned";

  if (scoreLabel) {
    return `Latest result: ${scoreLabel}. Minimum required score: ${requiredScore}%.`;
  }

  if (status === "training_done") {
    return "Training content is complete, but validation is still pending.";
  }

  if (status === "test_sent" || status === "test_overdue") {
    return "The assessment is still pending.";
  }

  return "The training has not been validated yet.";
};

const buildKpiTrainingPortalUrl = (row = {}) => {
  const peopleId = normalizeOptionalIntegerInput(row.people_id);
  const resultId = normalizeOptionalIntegerInput(row.result_id);
  const params = new URLSearchParams();

  if (peopleId) {
    params.set("people_id", String(peopleId));
  }

  if (resultId) {
    params.set("result_id", String(resultId));
  }

  const baseUrl = `${getKpiTrainingAppBaseUrl()}/kpi-training-center`;
  const queryString = params.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
};

const buildKpiTrainingDashboardUrl = () =>
  `${getKpiTrainingAppBaseUrl()}/kpi-training-dashboard`;

const buildKpiTrainingNotificationRowsHtml = (rows = []) =>
  rows
    .filter((row) => normalizeOptionalTextInput(row?.value))
    .map(
      (row) => `
        <tr>
          <td style="padding:11px 14px;background:#f8fafc;color:#475569;font-weight:700;width:180px;border-top:1px solid #e2e8f0;">${escapeHtml(row.label)}</td>
          <td style="padding:11px 14px;color:#0f172a;border-top:1px solid #e2e8f0;">${escapeHtml(row.value)}</td>
        </tr>`
    )
    .join("");

const buildKpiTrainingNotificationEmailHtml = ({
  eyebrow,
  title,
  greeting,
  introHtml,
  summaryRows = [],
  actionLabel = null,
  actionUrl = null,
  accentStart = "#1d4ed8",
  accentEnd = "#0f766e",
  footerHtml = null
}) => {
  const summaryRowsHtml = buildKpiTrainingNotificationRowsHtml(summaryRows);
  const actionBlock =
    normalizeOptionalTextInput(actionLabel) && normalizeOptionalTextInput(actionUrl)
      ? `
        <div style="margin:26px 0 0;">
          <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:${accentStart};color:#ffffff;text-decoration:none;padding:13px 20px;border-radius:999px;font-weight:700;font-size:14px;">
            ${escapeHtml(actionLabel)}
          </a>
        </div>
        <div style="margin-top:10px;font-size:12px;line-height:1.6;color:#64748b;">${escapeHtml(actionUrl)}</div>`
      : "";
  const summaryBlock = summaryRowsHtml
    ? `
      <div style="margin-top:22px;font-size:12px;font-weight:800;letter-spacing:0.10em;text-transform:uppercase;color:#64748b;">
        Summary
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:12px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;">
        ${summaryRowsHtml}
      </table>`
    : "";

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1.0" />
      <title>${escapeHtml(title)}</title>
    </head>
    <body style="margin:0;padding:0;background:#edf2f7;font-family:'Segoe UI',Arial,sans-serif;color:#0f172a;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#edf2f7;">
        <tr>
          <td align="center" style="padding:26px 16px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:760px;width:100%;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #dbe3ee;border-radius:26px;overflow:hidden;box-shadow:0 24px 60px rgba(15,23,42,0.10);">
              <tr>
                <td style="padding:0;background:${accentStart};background-image:linear-gradient(135deg, ${accentStart}, ${accentEnd});">
                  <div style="padding:30px 32px 28px;">
                    <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:rgba(255,255,255,0.16);border:1px solid rgba(255,255,255,0.18);font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;">
                      ${escapeHtml(eyebrow)}
                    </div>
                    <h1 style="margin:18px 0 0;font-size:30px;line-height:1.18;color:#ffffff;letter-spacing:-0.03em;">
                      ${escapeHtml(title)}
                    </h1>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:28px 32px 32px;">
                  <div style="font-size:15px;line-height:1.8;color:#1e293b;">
                    <div style="font-weight:700;margin-bottom:12px;">${escapeHtml(greeting)}</div>
                    ${introHtml}
                  </div>
                  ${summaryBlock}
                  ${actionBlock}
                  <div style="margin-top:26px;padding-top:18px;border-top:1px solid #e2e8f0;font-size:13px;line-height:1.8;color:#64748b;">
                    ${footerHtml || "This notification was sent automatically by the AVOCarbon KPI Training workflow."}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;
};

const buildResponsibleTrainingReminderEmailHtml = ({
  row,
  stage,
  responsibleName,
  portalUrl
}) => {
  const requiredScore = getKpiTrainingRequiredValidationScore(row);
  const sentOnLabel = formatDisplayDate(row.training_sent_at || row.created_at);

  return buildKpiTrainingNotificationEmailHtml({
    eyebrow: stage.label,
    title: "KPI training validation pending",
    greeting: `Hello ${responsibleName},`,
    introHtml: `
      <p style="margin:0 0 12px;">${escapeHtml(stage.label)}. Your KPI training assignment is still waiting for validation.</p>
      <p style="margin:0 0 12px;">${escapeHtml(buildKpiTrainingValidationStatusText(row))}</p>
      <p style="margin:0;">If the training is still not validated after 3 weekly reminders, your direct manager will be notified automatically.</p>`,
    summaryRows: [
      {
        label: "Training",
        value: normalizeOptionalTextInput(row.training_name) || `Training #${row.training_id}`
      },
      {
        label: "KPI",
        value: normalizeOptionalTextInput(row.kpi_name) || `KPI #${row.kpi_id}`
      },
      {
        label: "Current status",
        value: normalizeOptionalTextInput(row.status) || "training_assigned"
      },
      {
        label: "Required score",
        value: `${requiredScore}%`
      },
      {
        label: "Assignment sent",
        value: sentOnLabel
      }
    ],
    actionLabel: "Open My KPI Training",
    actionUrl: portalUrl,
    accentStart: "#1d4ed8",
    accentEnd: "#0f766e"
  });
};

const buildManagerTrainingEscalationEmailHtml = ({
  row,
  managerName,
  dashboardUrl
}) => {
  const responsibleName =
    normalizeOptionalTextInput(row.people_name) ||
    `Responsible #${row.people_id}`;
  const trainingName =
    normalizeOptionalTextInput(row.training_name) ||
    `Training #${row.training_id}`;

  return buildKpiTrainingNotificationEmailHtml({
    eyebrow: KPI_TRAINING_MANAGER_ESCALATION_STAGE.label,
    title: "Training escalation requires your action",
    greeting: `Bonjour ${managerName},`,
    introHtml: `
      <p style="margin:0 0 12px;">${escapeHtml(responsibleName)} n'a pas valide la formation ${escapeHtml(trainingName)} apres 3 relances.</p>
      <p style="margin:0 0 12px;">Ceci demande une action de votre part.</p>
      <p style="margin:0;">Sans validation sous ${KPI_TRAINING_EXECUTIVE_ESCALATION_DELAY_DAYS} jours, le cas sera remonte a la direction generale du groupe.</p>`,
    summaryRows: [
      {
        label: "Responsible",
        value: responsibleName
      },
      {
        label: "Training",
        value: trainingName
      },
      {
        label: "KPI",
        value: normalizeOptionalTextInput(row.kpi_name) || `KPI #${row.kpi_id}`
      },
      {
        label: "Current result",
        value: buildKpiTrainingValidationStatusText(row)
      },
      {
        label: "Last reminder sent",
        value: formatDisplayDate(row.last_reminder_sent_at || row.updated_at)
      }
    ],
    actionLabel: "Open Training Dashboard",
    actionUrl: dashboardUrl,
    accentStart: "#b45309",
    accentEnd: "#dc2626",
    footerHtml: "Merci d'avance pour votre support.<br />Training manager"
  });
};

const buildExecutiveTrainingEscalationEmailHtml = ({
  row,
  executiveAnchorDate,
  dashboardUrl
}) => {
  const responsibleName =
    normalizeOptionalTextInput(row.people_name) ||
    `Responsible #${row.people_id}`;
  const trainingName =
    normalizeOptionalTextInput(row.training_name) ||
    `Training #${row.training_id}`;

  return buildKpiTrainingNotificationEmailHtml({
    eyebrow: KPI_TRAINING_EXECUTIVE_ESCALATION_STAGE.label,
    title: "Final KPI training escalation",
    greeting: "Bonjour,",
    introHtml: `
      <p style="margin:0 0 12px;">${escapeHtml(responsibleName)} n'a toujours pas valide la formation ${escapeHtml(trainingName)}.</p>
      <p style="margin:0 0 12px;">Le dossier reste ouvert ${KPI_TRAINING_EXECUTIVE_ESCALATION_DELAY_DAYS} jours apres l'escalade manageriale.</p>
      <p style="margin:0;">Merci de prendre les actions necessaires au niveau groupe.</p>`,
    summaryRows: [
      {
        label: "Responsible",
        value: responsibleName
      },
      {
        label: "Training",
        value: trainingName
      },
      {
        label: "KPI",
        value: normalizeOptionalTextInput(row.kpi_name) || `KPI #${row.kpi_id}`
      },
      {
        label: "Current result",
        value: buildKpiTrainingValidationStatusText(row)
      },
      {
        label: "Manager escalation sent",
        value: formatDisplayDate(executiveAnchorDate)
      }
    ],
    actionLabel: "Open Training Dashboard",
    actionUrl: dashboardUrl,
    accentStart: "#7f1d1d",
    accentEnd: "#991b1b"
  });
};

const ensureKpiTrainingEscalationSchema = async () => {
  if (!kpiTrainingEscalationSchemaPromise) {
    kpiTrainingEscalationSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.kpi_training_escalation_log (
          training_escalation_id BIGSERIAL PRIMARY KEY,
          result_id BIGINT NOT NULL,
          people_id BIGINT,
          escalation_stage TEXT NOT NULL,
          sent_to_email TEXT NOT NULL,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_kpi_training_escalation_log
            UNIQUE (result_id, escalation_stage, sent_to_email)
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kpi_training_escalation_log_result
        ON public.kpi_training_escalation_log (result_id, sent_at DESC)
      `);
    })().catch((error) => {
      kpiTrainingEscalationSchemaPromise = null;
      throw error;
    });
  }

  return kpiTrainingEscalationSchemaPromise;
};

const loadKpiTrainingEscalationLogMap = async (resultIds = []) => {
  const normalizedResultIds = resultIds
    .map((value) => normalizeOptionalIntegerInput(value))
    .filter(Boolean);

  if (!normalizedResultIds.length) {
    return new Map();
  }

  const result = await pool.query(
    `
    SELECT
      result_id,
      escalation_stage,
      sent_to_email,
      sent_at
    FROM public.kpi_training_escalation_log
    WHERE result_id = ANY($1::bigint[])
    ORDER BY sent_at ASC
    `,
    [normalizedResultIds]
  );

  return result.rows.reduce((accumulator, row) => {
    const resultId = Number(row.result_id);
    if (!accumulator.has(resultId)) {
      accumulator.set(resultId, {});
    }

    const stageLogMap = accumulator.get(resultId);
    if (!Array.isArray(stageLogMap[row.escalation_stage])) {
      stageLogMap[row.escalation_stage] = [];
    }

    stageLogMap[row.escalation_stage].push({
      sent_to_email: normalizeOptionalTextInput(row.sent_to_email),
      sent_at: row.sent_at
    });

    return accumulator;
  }, new Map());
};

const getKpiTrainingStageLogEntries = (stageLogMap = {}, stageKey = "") =>
  Array.isArray(stageLogMap?.[stageKey]) ? stageLogMap[stageKey] : [];

const getLatestKpiTrainingStageSentAt = (stageLogMap = {}, stageKey = "") => {
  const entries = getKpiTrainingStageLogEntries(stageLogMap, stageKey);
  if (!entries.length) return null;

  return entries.reduce((latest, entry) => {
    if (!latest) return entry.sent_at;
    return new Date(entry.sent_at).getTime() > new Date(latest).getTime()
      ? entry.sent_at
      : latest;
  }, null);
};

const getKpiTrainingReminderCount = (stageLogMap = {}) =>
  KPI_TRAINING_RESPONSIBLE_REMINDER_STAGES.reduce(
    (count, stage) =>
      count + (getKpiTrainingStageLogEntries(stageLogMap, stage.key).length ? 1 : 0),
    0
  );

const loadKpiTrainingReminderCandidates = async () => {
  await ensureKpiTrainingEscalationSchema();

  const result = await pool.query(
    `
    SELECT
      ktr.result_id,
      ktr.people_id,
      ktr.training_id,
      ktr.test_id,
      ktr.kpi_id,
      NULLIF(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, ''))), '') AS people_name,
      p.email AS people_email,
      COALESCE(k.kpi_sub_title, k.kpi_name, 'KPI #' || ktr.kpi_id) AS kpi_name,
      COALESCE(kt.training_name, 'Training #' || ktr.training_id) AS training_name,
      COALESCE(ktest.pass_score, $2::numeric) AS pass_score,
      COALESCE(ktr.status, 'training_assigned') AS status,
      ktr.score,
      COALESCE(
        ktr.passed,
        CASE
          WHEN ktr.score IS NULL THEN NULL
          WHEN ktr.score >= GREATEST(COALESCE(ktest.pass_score, 80), 80) THEN TRUE
          ELSE FALSE
        END
      ) AS passed,
      ktr.escalation_level,
      ktr.training_sent_at,
      ktr.training_completed_at,
      ktr.test_sent_at,
      ktr.test_completed_at,
      ktr.last_reminder_sent_at,
      ktr.next_reminder_due_at,
      ktr.created_at,
      ktr.updated_at
    FROM public.kpi_training_result ktr
    LEFT JOIN public.people p
      ON p.people_id = ktr.people_id
    LEFT JOIN public.kpi k
      ON k.kpi_id = ktr.kpi_id
    LEFT JOIN public.kpi_training kt
      ON kt.training_id = ktr.training_id
    LEFT JOIN public.kpi_test ktest
      ON ktest.test_id = ktr.test_id
    WHERE COALESCE(ktr.status, 'training_assigned') = ANY($1::text[])
    ORDER BY
      COALESCE(ktr.next_reminder_due_at, ktr.training_sent_at, ktr.created_at) ASC NULLS LAST,
      ktr.result_id ASC
    `,
    [
      KPI_TRAINING_PENDING_VALIDATION_STATUSES,
      KPI_TRAINING_MIN_VALIDATION_SCORE
    ]
  );

  return result.rows;
};

const getDirectManagerRecipient = async (peopleId) => {
  const hierarchy = await getPeopleHierarchy(peopleId);
  const directManager = Array.isArray(hierarchy) ? hierarchy[1] : null;
  const managerEmail = normalizeOptionalTextInput(directManager?.email);

  if (!directManager || !managerEmail) {
    return null;
  }

  return {
    people_id: normalizeOptionalIntegerInput(directManager.people_id),
    name:
      getPeopleDisplayName(directManager) ||
      managerEmail,
    email: managerEmail,
    role_name: normalizeOptionalTextInput(directManager.role_name) || "Manager"
  };
};

const hashKpiTargetAdjustmentToken = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

const getKpiTargetAdjustmentApprover = async (allocation = {}, triggeredByPeopleId = null) => {
  const configuredApproverId = normalizeOptionalIntegerInput(allocation.approved_by_people_id);

  if (configuredApproverId) {
    const configuredApproverRes = await pool.query(
      `
      SELECT people_id, first_name, name, email
      FROM public.people
      WHERE people_id = $1
        AND COALESCE(TRIM(email), '') <> ''
      LIMIT 1
      `,
      [configuredApproverId]
    );
    const configuredApprover = configuredApproverRes.rows[0];
    if (configuredApprover) {
      return {
        people_id: configuredApprover.people_id,
        name: getPeopleDisplayName(configuredApprover) || configuredApprover.email,
        email: configuredApprover.email,
        source: "allocation_approver"
      };
    }
  }

  const responsiblePeopleId =
    normalizeOptionalIntegerInput(triggeredByPeopleId) ||
    normalizeOptionalIntegerInput(allocation.set_by_people_id);
  const directManager = responsiblePeopleId
    ? await getDirectManagerRecipient(responsiblePeopleId)
    : null;

  return directManager
    ? { ...directManager, source: "direct_manager" }
    : null;
};

const loadKpiTrainingRoleRecipients = async (roleLookupNames = []) => {
  const normalizedTargets = new Set(
    roleLookupNames
      .map((entry) => normalizeKpiTrainingRoleLookupName(entry))
      .filter(Boolean)
  );

  if (!normalizedTargets.size) {
    return [];
  }

  const result = await pool.query(`
    SELECT
      p.people_id,
      p.first_name,
      p.name,
      p.email,
      r.role_name,
      r.normalized_role_name,
      pra.assignment_id,
      COALESCE(pra.is_primary, false) AS is_primary
    FROM public.people_role_assignment pra
    JOIN public.people p
      ON p.people_id = pra.people_id
    JOIN public.role r
      ON r.role_id = pra.role_id
    WHERE COALESCE(pra.assignment_status, 'ACTIVE') = 'ACTIVE'
      AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
      AND COALESCE(TRIM(p.email), '') <> ''
    ORDER BY
      COALESCE(pra.is_primary, false) DESC,
      pra.allocation_percentage DESC NULLS LAST,
      pra.start_date DESC NULLS LAST,
      pra.assignment_id DESC
  `);

  const recipientsByEmail = new Map();

  result.rows.forEach((row) => {
    const email = normalizeOptionalTextInput(row.email);
    if (!email) return;

    const normalizedRoleNames = [
      normalizeKpiTrainingRoleLookupName(row.normalized_role_name),
      normalizeKpiTrainingRoleLookupName(row.role_name)
    ].filter(Boolean);

    if (!normalizedRoleNames.some((name) => normalizedTargets.has(name))) {
      return;
    }

    const emailKey = email.toLowerCase();
    if (recipientsByEmail.has(emailKey)) {
      return;
    }

    recipientsByEmail.set(emailKey, {
      people_id: normalizeOptionalIntegerInput(row.people_id),
      name: getPeopleDisplayName(row) || email,
      email,
      role_name: normalizeOptionalTextInput(row.role_name) || ""
    });
  });

  return [...recipientsByEmail.values()];
};

const resolveNextKpiTrainingNotification = async ({
  row,
  stageLogMap = {},
  executiveRecipients = [],
  managerRecipientCache,
  now = new Date()
}) => {
  if (!isKpiTrainingValidationPending(row)) {
    return null;
  }

  const anchor = getKpiTrainingLifecycleAnchor(row);
  if (!anchor) {
    return null;
  }

  const reminderCount = getKpiTrainingReminderCount(stageLogMap);
  const responsibleEmail = normalizeOptionalTextInput(row.people_email);
  const responsibleName =
    normalizeOptionalTextInput(row.people_name) ||
    `Responsible #${row.people_id}`;

  if (reminderCount < KPI_TRAINING_RESPONSIBLE_REMINDER_COUNT) {
    const stage = KPI_TRAINING_RESPONSIBLE_REMINDER_STAGES[reminderCount];
    const defaultDueAt = reminderCount === 0
      ? addDaysToTimestamp(anchor, KPI_TRAINING_REMINDER_INTERVAL_DAYS)
      : addDaysToTimestamp(
        row.last_reminder_sent_at || anchor,
        KPI_TRAINING_REMINDER_INTERVAL_DAYS
      );
    const dueAt = row.next_reminder_due_at || defaultDueAt;

    if (responsibleEmail && isTimestampDue(dueAt, now)) {
      return {
        stage,
        recipients: [
          {
            people_id: normalizeOptionalIntegerInput(row.people_id),
            name: responsibleName,
            email: responsibleEmail,
            role_name: "Responsible"
          }
        ]
      };
    }
  }

  const managerFallbackDueAt = addDaysToTimestamp(
    anchor,
    KPI_TRAINING_REMINDER_INTERVAL_DAYS * KPI_TRAINING_RESPONSIBLE_REMINDER_COUNT
  );
  const canEscalateToManager =
    reminderCount >= KPI_TRAINING_RESPONSIBLE_REMINDER_COUNT ||
    (!responsibleEmail && isTimestampDue(managerFallbackDueAt, now));

  if (
    canEscalateToManager &&
    !getKpiTrainingStageLogEntries(stageLogMap, KPI_TRAINING_MANAGER_ESCALATION_STAGE.key).length
  ) {
    const peopleId = normalizeOptionalIntegerInput(row.people_id);
    let managerRecipient = managerRecipientCache.get(peopleId);

    if (managerRecipient === undefined) {
      managerRecipient = peopleId
        ? await getDirectManagerRecipient(peopleId)
        : null;
      managerRecipientCache.set(peopleId, managerRecipient || null);
    }

    if (managerRecipient?.email) {
      return {
        stage: KPI_TRAINING_MANAGER_ESCALATION_STAGE,
        recipients: [managerRecipient]
      };
    }
  }

  const executiveAnchorDate =
    getLatestKpiTrainingStageSentAt(stageLogMap, KPI_TRAINING_MANAGER_ESCALATION_STAGE.key) ||
    row.last_reminder_sent_at ||
    managerFallbackDueAt;

  if (
    canEscalateToManager &&
    executiveRecipients.length &&
    isTimestampDue(
      addDaysToTimestamp(executiveAnchorDate, KPI_TRAINING_EXECUTIVE_ESCALATION_DELAY_DAYS),
      now
    )
  ) {
    const alreadySentEmailSet = new Set(
      getKpiTrainingStageLogEntries(stageLogMap, KPI_TRAINING_EXECUTIVE_ESCALATION_STAGE.key)
        .map((entry) => String(entry.sent_to_email || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const pendingRecipients = executiveRecipients.filter((recipient) => {
      const email = String(recipient.email || "").trim().toLowerCase();
      return email && !alreadySentEmailSet.has(email);
    });

    if (pendingRecipients.length) {
      return {
        stage: KPI_TRAINING_EXECUTIVE_ESCALATION_STAGE,
        recipients: pendingRecipients,
        executiveAnchorDate
      };
    }
  }

  return null;
};

const recordKpiTrainingStageLog = async ({
  resultId,
  peopleId = null,
  stageKey,
  recipientEmail
}) => {
  await pool.query(
    `
    INSERT INTO public.kpi_training_escalation_log (
      result_id,
      people_id,
      escalation_stage,
      sent_to_email
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (result_id, escalation_stage, sent_to_email) DO NOTHING
    `,
    [resultId, peopleId, stageKey, recipientEmail]
  );
};

const updateKpiTrainingResultAfterNotification = async ({
  resultId,
  stage
}) => {
  if (stage?.reminderNumber) {
    await pool.query(
      `
      UPDATE public.kpi_training_result
      SET
        training_sent_at = COALESCE(training_sent_at, NOW()),
        last_reminder_sent_at = NOW(),
        next_reminder_due_at = CASE
          WHEN $2::int < $3::int THEN NOW() + ($4::int * INTERVAL '1 day')
          ELSE NULL
        END,
        escalation_level = GREATEST(COALESCE(escalation_level, 0), $5::int),
        status = CASE
          WHEN COALESCE(status, 'training_assigned') = 'training_assigned' THEN 'training_sent'
          ELSE status
        END,
        updated_at = NOW()
      WHERE result_id = $1
      `,
      [
        resultId,
        stage.reminderNumber,
        KPI_TRAINING_RESPONSIBLE_REMINDER_COUNT,
        KPI_TRAINING_REMINDER_INTERVAL_DAYS,
        stage.escalationLevel
      ]
    );
    return;
  }

  await pool.query(
    `
    UPDATE public.kpi_training_result
    SET
      status = 'escalated',
      escalation_level = GREATEST(COALESCE(escalation_level, 0), $2::int),
      next_reminder_due_at = NULL,
      updated_at = NOW()
    WHERE result_id = $1
    `,
    [resultId, stage.escalationLevel]
  );
};

const buildKpiTrainingNotificationPayload = ({
  row,
  stage,
  recipient,
  executiveAnchorDate = null
}) => {
  const portalUrl = buildKpiTrainingPortalUrl(row);
  const dashboardUrl = buildKpiTrainingDashboardUrl();
  const trainingLabel =
    normalizeOptionalTextInput(row.training_name) ||
    `Training #${row.training_id}`;
  const responsibleName =
    normalizeOptionalTextInput(row.people_name) ||
    `Responsible #${row.people_id}`;

  if (stage?.reminderNumber) {
    return {
      subject: `${stage.label}: KPI training validation pending - ${trainingLabel}`,
      html: buildResponsibleTrainingReminderEmailHtml({
        row,
        stage,
        responsibleName,
        portalUrl
      })
    };
  }

  if (stage?.key === KPI_TRAINING_MANAGER_ESCALATION_STAGE.key) {
    return {
      subject: `Escalation: ${responsibleName} has not validated ${trainingLabel} after 3 reminders`,
      html: buildManagerTrainingEscalationEmailHtml({
        row,
        managerName: recipient.name || "Manager",
        dashboardUrl
      })
    };
  }

  return {
    subject: `Final escalation: ${responsibleName} still has not validated ${trainingLabel}`,
    html: buildExecutiveTrainingEscalationEmailHtml({
      row,
      executiveAnchorDate,
      dashboardUrl
    })
  };
};

const sendKpiTrainingNotification = async ({
  transporter,
  row,
  notification
}) => {
  const sent = [];
  const failed = [];
  const normalizedResultId = normalizeOptionalIntegerInput(row.result_id);
  const normalizedPeopleId = normalizeOptionalIntegerInput(row.people_id);

  for (const recipient of notification.recipients) {
    const recipientEmail = normalizeOptionalTextInput(recipient?.email);
    if (!recipientEmail) {
      continue;
    }

    const payload = buildKpiTrainingNotificationPayload({
      row,
      stage: notification.stage,
      recipient,
      executiveAnchorDate: notification.executiveAnchorDate || null
    });

    try {
      const info = await transporter.sendMail({
        from: '"AVOCarbon KPI Training" <administration.STS@avocarbon.com>',
        to: recipientEmail,
        subject: payload.subject,
        html: payload.html
      });

      await recordKpiTrainingStageLog({
        resultId: normalizedResultId,
        peopleId: normalizedPeopleId,
        stageKey: notification.stage.key,
        recipientEmail
      });

      sent.push({
        result_id: normalizedResultId,
        people_id: normalizedPeopleId,
        stage: notification.stage.key,
        email: recipientEmail,
        message_id: info.messageId
      });
    } catch (error) {
      failed.push({
        result_id: normalizedResultId,
        people_id: normalizedPeopleId,
        stage: notification.stage.key,
        email: recipientEmail,
        error: error.message
      });
    }
  }

  if (sent.length) {
    await updateKpiTrainingResultAfterNotification({
      resultId: normalizedResultId,
      stage: notification.stage
    });
  }

  return { sent, failed };
};

const runKpiTrainingReminderEscalationJob = async () => {
  await ensureKpiTrainingEscalationSchema();

  const candidates = await loadKpiTrainingReminderCandidates();
  if (!candidates.length) {
    console.log("[KPI Training Reminder] No training candidates found.");
    return {
      ok: true,
      candidate_count: 0,
      sent_count: 0,
      failed_count: 0,
      sent: [],
      failed: []
    };
  }

  const stageLogMapByResultId = await loadKpiTrainingEscalationLogMap(
    candidates.map((row) => row.result_id)
  );
  const executiveRecipients = await loadKpiTrainingRoleRecipients(
    KPI_TRAINING_EXECUTIVE_ROLE_LOOKUP_NAMES
  );
  const managerRecipientCache = new Map();
  const sent = [];
  const failed = [];
  let transporter = null;

  for (const row of candidates) {
    const resultId = normalizeOptionalIntegerInput(row.result_id);
    const stageLogMap = stageLogMapByResultId.get(resultId) || {};
    const notification = await resolveNextKpiTrainingNotification({
      row,
      stageLogMap,
      executiveRecipients,
      managerRecipientCache
    });

    if (!notification) {
      continue;
    }

    transporter = transporter || createTransporter();
    const deliveryResult = await sendKpiTrainingNotification({
      transporter,
      row,
      notification
    });

    sent.push(...deliveryResult.sent);
    failed.push(...deliveryResult.failed);

    if (deliveryResult.sent.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (!sent.length && !failed.length) {
    console.log("[KPI Training Reminder] No pending reminders or escalations.");
  }

  return {
    ok: true,
    candidate_count: candidates.length,
    sent_count: sent.length,
    failed_count: failed.length,
    sent,
    failed
  };
};

async function sendKpiTrainingLinksToResponsibles() {
  const appBaseUrl = getKpiTrainingAppBaseUrl();

  const result = await pool.query(`
    SELECT
      ktr.people_id,
      NULLIF(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, ''))), '') AS people_name,
      p.email,
      COUNT(*) AS assignment_count,
      MIN(ktr.test_due_date) AS nearest_due_date
    FROM public.kpi_training_result ktr
    JOIN public.people p
      ON p.people_id = ktr.people_id
    WHERE p.email IS NOT NULL
      AND TRIM(p.email) <> ''
      AND COALESCE(ktr.status, 'training_assigned') = ANY($1::text[])
      AND NOT (
        COALESCE(ktr.status, 'training_assigned') = 'training_done'
        AND ktr.test_id IS NULL
        AND ktr.training_completed_at IS NOT NULL
      )
    GROUP BY
      ktr.people_id,
      p.first_name,
      p.name,
      p.email
    ORDER BY people_name, ktr.people_id
  `, [KPI_TRAINING_PENDING_VALIDATION_STATUSES]);

  const transporter = createTransporter();
  const sent = [];
  const failed = [];

  for (const row of result.rows) {
    const peopleId = row.people_id;
    const responsibleName = row.people_name || `Responsible #${peopleId}`;
    const recipientEmail = row.email;

    const trainingUrl =
      `${appBaseUrl}/kpi-training-center?people_id=${encodeURIComponent(peopleId)}`;

    const emailHtml = `
      <div style="font-family:Arial,sans-serif;background:#f4f7fb;padding:24px;">
        <div style="max-width:680px;margin:auto;background:#ffffff;border-radius:18px;padding:28px;border:1px solid #e2e8f0;">
          <h2 style="margin:0 0 12px;color:#0f172a;">KPI Training Assigned</h2>

          <p style="font-size:14px;color:#334155;line-height:1.6;">
            Hello ${escapeHtml(responsibleName)},
          </p>

          <p style="font-size:14px;color:#334155;line-height:1.6;">
            You have <strong>${row.assignment_count}</strong> KPI training assignment(s).
            Please review all documentation, then complete the QCM.
          </p>

          <div style="margin:24px 0;">
            <a href="${trainingUrl}"
               style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:13px 20px;border-radius:999px;font-weight:700;font-size:14px;">
              Open My KPI Training
            </a>
          </div>

          <p style="font-size:12px;color:#64748b;">
            ${trainingUrl}
          </p>
        </div>
      </div>
    `;

    try {
      const info = await transporter.sendMail({
        from: '"AVOCarbon KPI Training" <administration.STS@avocarbon.com>',
        to: recipientEmail,
        subject: "Your KPI Training Center",
        html: emailHtml
      });

      await pool.query(`
        UPDATE public.kpi_training_result
        SET
          training_sent_at = COALESCE(training_sent_at, NOW()),
          next_reminder_due_at = COALESCE(
            next_reminder_due_at,
            COALESCE(training_sent_at, NOW()) + ($2::int * INTERVAL '1 day')
          ),
          status = CASE
            WHEN status IN ('completed_pass', 'completed_fail') THEN status
            ELSE 'training_sent'
          END,
          updated_at = NOW()
        WHERE people_id = $1
          AND COALESCE(status, 'training_assigned') = ANY($3::text[])
      `, [
        peopleId,
        KPI_TRAINING_REMINDER_INTERVAL_DAYS,
        KPI_TRAINING_PENDING_VALIDATION_STATUSES
      ]);

      sent.push({
        people_id: peopleId,
        email: recipientEmail,
        assignment_count: Number(row.assignment_count),
        message_id: info.messageId
      });
    } catch (error) {
      failed.push({
        people_id: peopleId,
        email: recipientEmail,
        error: error.message
      });
    }
  }

  return {
    ok: true,
    sent_count: sent.length,
    failed_count: failed.length,
    sent,
    failed
  };
}

module.exports = {
  KPI_TRAINING_DEFAULT_TEST_DUE_DAYS,
  buildNormalizedQuestionnaire,
  mergeTrainingQuestions,
  normalizeSubmittedTrainingAnswers,
  scoreTrainingQuestionnaire,
  buildTrainingPortalAssignment,
  loadKpiTrainingPortalRows,
  ensureKpiTrainingEscalationSchema,
  runKpiTrainingReminderEscalationJob,
  sendKpiTrainingLinksToResponsibles,
};
