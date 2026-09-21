"use strict";

const PROMPT_VERSION = "industrial-derived-kpi-lite-v1";
const DEFAULT_MODEL = process.env.OPENAI_DERIVED_KPI_MODEL || "gpt-4o-mini";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_CATALOG_CHARS = 320000;
const AI_GENERATED_KPI_CALCULATION_MODE = "AI Derived KPI";
const AI_GENERATED_KPI_TYPE = "calculated";
const AI_GENERATED_KPI_COMMENT =
  "Generated automatically by Industrial KPI Generator. Derivation logic is stored in kpi_explanation.";
const HARD_CODED_CRON_ENABLED = true;
const HARD_CODED_CRON_EXPRESSION = "0 30 5 * * 1";
const HARD_CODED_CRON_TIMEZONE = "Africa/Tunis";
const HARD_CODED_CRON_RUN_ON_STARTUP = false;
const HARD_CODED_CRON_SEARCH = "";
const HARD_CODED_CRON_SUBJECT_ID = null;
const HARD_CODED_CRON_LIMIT = DEFAULT_LIMIT;
const EXPLANATION_STOP_WORDS = new Set([
  "a",
  "an",
  "as",
  "based",
  "be",
  "by",
  "calculate",
  "calculated",
  "calculation",
  "compute",
  "computed",
  "defined",
  "derived",
  "formula",
  "from",
  "is",
  "measure",
  "measured",
  "of",
  "the",
  "using",
  "value"
]);

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const normalizeMachineText = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const buildNameSignature = (row = {}) =>
  [
    normalizeMachineText(row.kpi_name),
    normalizeMachineText(row.kpi_sub_title)
  ].join("|");

const buildExistingNameIndex = (rows = []) =>
  new Set((Array.isArray(rows) ? rows : []).map((row) => buildNameSignature(row)).filter(Boolean));

const singularizeMeaningToken = (token) => {
  const text = String(token ?? "").trim();
  if (!text || text.length <= 3) return text;
  if (/^\d+$/.test(text)) return text;
  if (text.endsWith("ies") && text.length > 4) {
    return `${text.slice(0, -3)}y`;
  }
  if (text.endsWith("sses") || text.endsWith("ss")) {
    return text;
  }
  if (text.endsWith("s") && !text.endsWith("us") && !text.endsWith("is")) {
    return text.slice(0, -1);
  }
  return text;
};

const canonicalizeExplanationMeaning = (value) => {
  let text = normalizeMachineText(value);
  if (!text) return "";

  text = text
    .replace(/\b(calculated|computed|derived|defined|measured)\s+as\b/g, " ")
    .replace(/\b(divided by|divide by|over|per)\b/g, " / ")
    .replace(/\b(plus|added to|add)\b/g, " + ")
    .replace(/\b(minus|less|subtracted by|subtract)\b/g, " - ")
    .replace(/\b(multiplied by|times)\b/g, " * ")
    .replace(/[%]/g, " % ")
    .replace(/[()[\],.:;]/g, " ")
    .replace(/[^a-z0-9+\-*/%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = text
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      if (/^[+\-*/%]$/.test(token)) return token;
      const singular = singularizeMeaningToken(token);
      return EXPLANATION_STOP_WORDS.has(singular) ? "" : singular;
    })
    .filter(Boolean);

  return tokens.join(" ").replace(/\s+/g, " ").trim();
};

const tokenizeMeaningSignature = (value) =>
  canonicalizeExplanationMeaning(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);

const computeTokenJaccardSimilarity = (leftTokens = [], rightTokens = []) => {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);

  if (!left.size || !right.size) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
};

const buildMeaningAnchor = (row = {}) =>
  normalizeMachineText(row.kpi_sub_title || row.kpi_name || "");

const buildExplanationMeaningSignature = (row = {}) =>
  canonicalizeExplanationMeaning(row.kpi_explanation);

const buildExistingMeaningEntries = (rows = []) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    kpi_name: row.kpi_name || "",
    kpi_sub_title: row.kpi_sub_title || "",
    meaning_anchor: buildMeaningAnchor(row),
    explanation_signature: buildExplanationMeaningSignature(row),
    explanation_tokens: tokenizeMeaningSignature(row.kpi_explanation)
  })).filter((entry) => entry.explanation_signature);

const normalizeRecommendationPayload = (item = {}) => ({
  kpi_name: String(item.kpi_name ?? "").trim(),
  kpi_sub_title: String(item.kpi_sub_title ?? "").trim(),
  kpi_explanation: String(item.kpi_explanation ?? "").trim(),
  frequency: String(item.frequency ?? "").trim(),
  unit: String(item.unit ?? "").trim()
});

const validateRecommendation = (recommendation, existingNameIndex, existingMeaningEntries = []) => {
  const errors = [];

  if (!recommendation.kpi_name) {
    errors.push("kpi_name is required.");
  }

  if (!recommendation.kpi_explanation) {
    errors.push("kpi_explanation is required.");
  }

  const signature = buildNameSignature(recommendation);
  if (signature && existingNameIndex.has(signature)) {
    errors.push("This KPI name and subtitle already exist.");
  }

  const recommendationMeaningAnchor = buildMeaningAnchor(recommendation);
  const recommendationExplanationSignature = buildExplanationMeaningSignature(recommendation);
  const recommendationExplanationTokens = tokenizeMeaningSignature(recommendation.kpi_explanation);

  if (recommendationExplanationSignature) {
    const duplicateMeaningEntry = existingMeaningEntries.find((entry) => {
      if (!entry.explanation_signature) return false;

      if (entry.explanation_signature === recommendationExplanationSignature) {
        return true;
      }

      const similarity = computeTokenJaccardSimilarity(
        recommendationExplanationTokens,
        entry.explanation_tokens
      );

      if (
        recommendationMeaningAnchor &&
        entry.meaning_anchor &&
        recommendationMeaningAnchor === entry.meaning_anchor &&
        similarity >= 0.78
      ) {
        return true;
      }

      if (similarity >= 0.92) {
        return true;
      }

      return false;
    });

    if (duplicateMeaningEntry) {
      errors.push(
        `This KPI explanation has the same meaning as an existing KPI: ${duplicateMeaningEntry.kpi_name || "Unnamed KPI"}.`
      );
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

const serializeGeneratedRow = (row) => ({
  id: row.id ?? row.kpi_id,
  kpi_name: row.kpi_name || "",
  kpi_explanation: row.kpi_explanation || "",
  kpi_sub_title: row.kpi_sub_title || "",
  frequency: row.frequency || "",
  unit: row.unit || ""
});

const buildPromptMessages = (catalogRows = [], limit, existingGeneratedRows = []) => {
  const catalogPayload = catalogRows.map((row) => ({
    kpi_id: row.kpi_id,
    kpi_name: row.kpi_name,
    kpi_sub_title: row.kpi_sub_title,
    kpi_explanation: row.kpi_explanation,
    frequency: row.frequency,
    unit: row.unit
  }));

  const generatedPayload = (Array.isArray(existingGeneratedRows) ? existingGeneratedRows : []).map((row) => ({
    kpi_name: row.kpi_name,
    kpi_sub_title: row.kpi_sub_title,
    kpi_explanation: row.kpi_explanation,
    frequency: row.frequency,
    unit: row.unit
  }));

  return [
    {
      role: "system",
      content: [
        "You are an Industrial KPI Generator.",
        "",
        "You specialize in:",
        "- manufacturing",
        "- industrial finance",
        "- automotive subcontracting",
        "- production",
        "- quality",
        "- maintenance",
        "- logistics",
        "- purchasing",
        "- inventory",
        "- sales",
        "- accounts receivable",
        "- cost control",
        "- labor productivity",
        "- material productivity",
        "- operational excellence",
        "- cash generation",
        "- working capital",
        "",
        "Your task is to analyze the existing KPI catalog and recommend new derived industrial KPIs.",
        "A derived KPI must be calculated from at least two KPIs already present in the catalog.",
        "Use only the KPI context available from kpi_name, kpi_sub_title, and kpi_explanation.",
        "Do not repeat existing KPIs.",
        "Do not generate paraphrases of KPI ideas that already exist in the generated KPI list.",
        "If the meaning of kpi_explanation is already covered by an existing KPI, skip it.",
        "Because the database table is simplified for now, include the short derivation logic inside kpi_explanation itself.",
        "For example: 'Calculated as AR Current + AR Late <15 days + AR Late 15-30 days + AR Late >30 days.'",
        "",
        "Return only valid JSON with this exact shape:",
        "{",
        '  "recommendations": [',
        "    {",
        '      "kpi_name": "string",',
        '      "kpi_sub_title": "string",',
        '      "kpi_explanation": "string",',
        '      "frequency": "string",',
        '      "unit": "string"',
        "    }",
        "  ]",
        "}",
        "",
        `Return up to ${limit} recommendations.`
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Existing active KPI catalog:",
        JSON.stringify(catalogPayload, null, 2),
        "",
        "Already generated KPIs to avoid repeating:",
        JSON.stringify(generatedPayload, null, 2)
      ].join("\n\n")
    }
  ];
};

const buildPageHtml = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Industrial KPI Generator</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    :root {
      --bg: #f3f7fc;
      --surface: rgba(255,255,255,0.92);
      --border: rgba(15,23,42,0.08);
      --text: #0f172a;
      --muted: #64748b;
      --primary: #2563eb;
      --accent: #0f766e;
      --shadow: 0 18px 45px rgba(15,23,42,0.08);
      --radius: 22px;
    }
    body {
      margin: 0;
      font-family: "Inter", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(37,99,235,0.08), transparent 22%),
        radial-gradient(circle at top right, rgba(15,118,110,0.08), transparent 24%),
        linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    .page { max-width: 1400px; margin: 0 auto; padding: 28px; }
    .panel, .hero, .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .hero {
      padding: 28px;
      margin-bottom: 22px;
      display: grid;
      gap: 18px;
      grid-template-columns: 1.8fr 1fr;
    }
    .hero h1 { margin: 0; font-size: 36px; letter-spacing: -1.4px; }
    .hero p { margin: 10px 0 0; color: var(--muted); line-height: 1.7; }
    .hero-stats {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .stat {
      background: rgba(248,250,252,0.92);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
    }
    .stat .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 800;
    }
    .stat .value {
      margin-top: 8px;
      font-size: 28px;
      font-weight: 900;
    }
    .toolbar {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      margin-bottom: 18px;
    }
    .panel { padding: 18px; }
    label {
      display: block;
      font-size: 12px;
      font-weight: 800;
      color: var(--muted);
      margin-bottom: 8px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      border: 1px solid rgba(148,163,184,0.35);
      background: white;
      border-radius: 14px;
      padding: 12px 14px;
      font: inherit;
      color: var(--text);
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    button {
      border: none;
      border-radius: 14px;
      padding: 12px 16px;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      transition: transform 0.18s ease, opacity 0.18s ease;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
    .btn-primary { background: linear-gradient(135deg, var(--primary), #1d4ed8); color: white; }
    .btn-soft { background: #ecfeff; color: var(--accent); }
    .status {
      color: var(--muted);
      min-height: 20px;
      margin-bottom: 16px;
    }
    .cards {
      display: grid;
      gap: 16px;
    }
    .card {
      padding: 20px;
      display: grid;
      gap: 14px;
    }
    .card h3 {
      margin: 0;
      font-size: 22px;
      letter-spacing: -0.04em;
    }
    .subhead {
      color: var(--muted);
      font-weight: 600;
      margin-top: 6px;
    }
    .meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .pill {
      padding: 7px 10px;
      border-radius: 999px;
      background: #e2e8f0;
      color: #334155;
      font-size: 12px;
      font-weight: 800;
    }
    .detail {
      background: rgba(248,250,252,0.92);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
    }
    .detail .label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .detail .value {
      margin-top: 8px;
      white-space: pre-wrap;
      line-height: 1.6;
    }
    .empty {
      padding: 42px;
      text-align: center;
      color: var(--muted);
      background: rgba(255,255,255,0.75);
      border: 1px dashed rgba(148,163,184,0.4);
      border-radius: var(--radius);
    }
    @media (max-width: 1000px) {
      .hero, .toolbar { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div>
        <h1>Industrial KPI Generator</h1>
        <p>This version saves generated KPIs directly into the main KPI table. The explanation should contain the derivation logic for now because formula fields are not yet stored separately.</p>
      </div>
      <div class="hero-stats">
        <div class="stat">
          <div class="label">Generated KPIs</div>
          <div class="value" id="generatedCount">0</div>
        </div>
        <div class="stat">
          <div class="label">Catalog KPIs</div>
          <div class="value" id="catalogCount">0</div>
        </div>
      </div>
    </section>

    <section class="toolbar">
      <div class="panel">
        <label for="searchInput">Catalog Search</label>
        <input id="searchInput" placeholder="Search KPI name, subtitle, explanation" />
      </div>
      <div class="panel">
        <label for="subjectInput">Filter Subject ID</label>
        <input id="subjectInput" placeholder="Optional subject_id" />
      </div>
      <div class="panel">
        <label for="limitInput">Recommendation Limit</label>
        <input id="limitInput" type="number" min="1" max="20" value="8" />
      </div>
    </section>

    <section class="panel" style="margin-bottom:18px;">
      <div class="actions">
        <button class="btn-primary" id="generateBtn">Generate KPIs</button>
        <button class="btn-soft" id="reloadBtn">Reload Saved KPIs</button>
      </div>
    </section>

    <div class="status" id="statusMessage">Ready.</div>
    <section class="cards" id="cards"></section>
  </div>

  <script>
    const generatedCountEl = document.getElementById("generatedCount");
    const catalogCountEl = document.getElementById("catalogCount");
    const statusMessage = document.getElementById("statusMessage");
    const cardsEl = document.getElementById("cards");
    const searchInput = document.getElementById("searchInput");
    const subjectInput = document.getElementById("subjectInput");
    const limitInput = document.getElementById("limitInput");
    const generateBtn = document.getElementById("generateBtn");
    const reloadBtn = document.getElementById("reloadBtn");

    const escapeHtml = (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

    const parsePositiveInt = (value) => {
      const n = Number.parseInt(String(value ?? "").trim(), 10);
      return Number.isInteger(n) && n > 0 ? n : null;
    };

    const setStatus = (message, isError = false) => {
      statusMessage.textContent = message;
      statusMessage.style.color = isError ? "#b91c1c" : "#64748b";
    };

    const renderCards = (items) => {
      const rows = Array.isArray(items) ? items : [];
      generatedCountEl.textContent = String(rows.length);

      if (!rows.length) {
        cardsEl.innerHTML = '<div class="empty">No generated KPIs saved yet.</div>';
        return;
      }

      cardsEl.innerHTML = rows.map((item) => (
        '<article class="card">' +
          '<div>' +
            '<h3>' + escapeHtml(item.kpi_name || "Untitled KPI") + '</h3>' +
            '<div class="subhead">' + escapeHtml(item.kpi_sub_title || "Generated KPI") + '</div>' +
          '</div>' +
          '<div class="meta">' +
            '<span class="pill">' + escapeHtml(item.frequency || "No frequency") + '</span>' +
            '<span class="pill">' + escapeHtml(item.unit || "No unit") + '</span>' +
            '<span class="pill">ID ' + escapeHtml(item.id || "") + '</span>' +
          '</div>' +
          '<div class="detail">' +
            '<div class="label">Explanation</div>' +
            '<div class="value">' + escapeHtml(item.kpi_explanation || "") + '</div>' +
          '</div>' +
        '</article>'
      )).join("");
    };

    const loadCatalogCount = async () => {
      const params = new URLSearchParams();
      const search = String(searchInput.value || "").trim();
      const subjectId = parsePositiveInt(subjectInput.value);
      if (search) params.set("search", search);
      if (subjectId) params.set("subject_id", String(subjectId));

      const response = await fetch("/api/ai-generated-kpis/catalog?" + params.toString());
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load catalog");
      catalogCountEl.textContent = String(data.count || 0);
    };

    const loadGenerated = async () => {
      setStatus("Loading saved generated KPIs...");
      try {
        const response = await fetch("/api/ai-generated-kpis");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load generated KPIs");
        renderCards(data.items || []);
        await loadCatalogCount();
        setStatus("Loaded " + (data.items || []).length + " generated KPI(s).");
      } catch (error) {
        setStatus(error.message || "Failed to load generated KPIs.", true);
      }
    };

    const generate = async () => {
      const payload = {
        search: String(searchInput.value || "").trim(),
        subject_id: parsePositiveInt(subjectInput.value),
        limit: Math.max(1, Math.min(20, parsePositiveInt(limitInput.value) || 8))
      };

      generateBtn.disabled = true;
      setStatus("Generating new industrial KPI recommendations...");

      try {
        const response = await fetch("/api/ai-generated-kpis/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Generation failed");
        renderCards(data.items || []);
        await loadCatalogCount();
        setStatus("Saved " + (data.items || []).length + " generated KPI(s)." + (data.skipped_duplicates && data.skipped_duplicates.length ? " Some duplicates were skipped." : ""));
      } catch (error) {
        setStatus(error.message || "Generation failed.", true);
      } finally {
        generateBtn.disabled = false;
      }
    };

    generateBtn.addEventListener("click", generate);
    reloadBtn.addEventListener("click", loadGenerated);

    loadGenerated();
  </script>
</body>
</html>`;

const registerAIGeneratedKpiRoutes = (
  app,
  {
    pool,
    ensureKpiRatioSchema,
    getOpenAIClient,
    refreshKpiKnowledgeBaseForKpiId,
    upsertPrimarySubjectKpiLink,
    normalizeOptionalIntegerInput,
    normalizeOptionalTextInput,
    createHttpError,
    cronScheduler
  }
) => {
  let generatorSetupPromise = null;
  let cronRunInProgress = false;

  const ensureAIGeneratedKpiSchema = async () => {
    if (!generatorSetupPromise) {
      generatorSetupPromise = (async () => {
        if (typeof ensureKpiRatioSchema === "function") {
          await ensureKpiRatioSchema();
        }
      })().catch((error) => {
        generatorSetupPromise = null;
        throw error;
      });
    }

    return generatorSetupPromise;
  };

  const loadActiveKpiCatalog = async ({ search = "", subjectId = null } = {}) => {
    const normalizedSearch = normalizeOptionalTextInput(search) || "";
    const normalizedSubjectId = normalizeOptionalIntegerInput(subjectId);
    const result = await pool.query(
      `
      SELECT
        k.kpi_id,
        COALESCE(NULLIF(BTRIM(k.kpi_name), ''), 'KPI #' || k.kpi_id::text) AS kpi_name,
        COALESCE(NULLIF(BTRIM(k.kpi_sub_title), ''), '') AS kpi_sub_title,
        COALESCE(NULLIF(BTRIM(k.kpi_explanation), ''), '') AS kpi_explanation,
        COALESCE(NULLIF(BTRIM(k.frequency), ''), '') AS frequency,
        COALESCE(NULLIF(BTRIM(k.unit), ''), '') AS unit,
        primary_subject.subject_id
      FROM public.kpi k
      LEFT JOIN LATERAL (
        SELECT sk.subject_id
        FROM public.subject_kpi sk
        WHERE sk.kpi_id = k.kpi_id
        ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
        LIMIT 1
      ) primary_subject ON TRUE
      WHERE
        COALESCE(NULLIF(LOWER(BTRIM(k.status)), ''), 'active') NOT IN ('inactive', 'archived', 'deleted')
        AND ($1::text = '' OR (
          COALESCE(k.kpi_name, '') ILIKE $2
          OR COALESCE(k.kpi_sub_title, '') ILIKE $2
          OR COALESCE(k.kpi_explanation, '') ILIKE $2
        ))
        AND ($3::integer IS NULL OR primary_subject.subject_id = $3)
      ORDER BY k.kpi_id ASC
      `,
      [normalizedSearch, `%${normalizedSearch}%`, normalizedSubjectId]
    );

    return result.rows.map((row) => ({
      kpi_id: row.kpi_id,
      kpi_name: row.kpi_name || "",
      kpi_sub_title: row.kpi_sub_title || "",
      kpi_explanation: row.kpi_explanation || "",
      frequency: row.frequency || "",
      unit: row.unit || ""
    }));
  };

  const loadGeneratedRows = async () => {
    const result = await pool.query(
      `
      SELECT
        kpi_id AS id,
        kpi_id,
        kpi_name,
        kpi_explanation,
        kpi_sub_title,
        frequency,
        unit
      FROM public.kpi
      WHERE
        LOWER(COALESCE(NULLIF(BTRIM(type), ''), '')) = LOWER($1)
        OR
        LOWER(COALESCE(NULLIF(BTRIM(calculation_mode), ''), '')) = LOWER($2)
        OR COALESCE(NULLIF(BTRIM(comments), ''), '') = $3
      ORDER BY kpi_id DESC
      `,
      [
        AI_GENERATED_KPI_TYPE,
        AI_GENERATED_KPI_CALCULATION_MODE,
        AI_GENERATED_KPI_COMMENT
      ]
    );

    return result.rows.map(serializeGeneratedRow);
  };

  const insertRowsIntoMainKpiTable = async (
    client,
    rows = [],
    { subjectId = null } = {}
  ) => {
    const inserted = [];
    const normalizedSubjectId = normalizeOptionalIntegerInput(subjectId);

    for (const row of rows) {
      const result = await client.query(
        `
        INSERT INTO public.kpi (
          kpi_name,
          kpi_sub_title,
          kpi_code,
          kpi_formula,
          unit,
          kpi_explanation,
          frequency,
          target_value,
          target_direction,
          tolerance_type,
          up_tolerance,
          low_tolerance,
          max_value,
          min_value,
          min_type,
          max_type,
          nombre_periode,
          calculation_on,
          calculation_mode,
          reference_kpi_id,
          target_auto_adjustment,
          reactivity_status,
          importance,
          pricing_type,
          reactivity_need,
          display_trend,
          regression,
          owner_role_id,
          status,
          comments,
          high_limit,
          low_limit,
          created_by_people_id,
          kfs,
          type
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35
        )
        RETURNING
          kpi_id AS id,
          kpi_id,
          kpi_name,
          kpi_sub_title,
          kpi_explanation,
          frequency,
          unit
        `,
        [
          row.kpi_name,
          row.kpi_sub_title || null,
          null,
          null,
          row.unit || null,
          row.kpi_explanation || null,
          row.frequency || null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          AI_GENERATED_KPI_CALCULATION_MODE,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          "Active",
          AI_GENERATED_KPI_COMMENT,
          null,
          null,
          null,
          "KPI",
          AI_GENERATED_KPI_TYPE
        ]
      );

      const insertedKpi = result.rows[0];

      if (
        normalizedSubjectId &&
        typeof upsertPrimarySubjectKpiLink === "function"
      ) {
        await upsertPrimarySubjectKpiLink(client, insertedKpi.kpi_id, normalizedSubjectId);
      }

      if (typeof refreshKpiKnowledgeBaseForKpiId === "function") {
        await refreshKpiKnowledgeBaseForKpiId(client, insertedKpi.kpi_id, {
          reason: "kpi_derived_generator_auto_inserted"
        });
      }

      inserted.push(insertedKpi);
    }

    return inserted;
  };

  const generateAndStoreRecommendations = async ({
    search = "",
    subjectId = null,
    limit = DEFAULT_LIMIT,
    allowEmptyInsert = true
  } = {}) => {
    let client;

    try {
      await ensureAIGeneratedKpiSchema();

      const normalizedSearch = normalizeOptionalTextInput(search) || "";
      const normalizedSubjectId = normalizeOptionalIntegerInput(subjectId);
      const requestedLimit = Math.max(
        1,
        Math.min(MAX_LIMIT, normalizeOptionalIntegerInput(limit) || DEFAULT_LIMIT)
      );

      const catalogRows = await loadActiveKpiCatalog({
        search: normalizedSearch,
        subjectId: normalizedSubjectId
      });
      if (catalogRows.length < 2) {
        throw createHttpError(400, "At least two active KPIs are required to generate derived KPI recommendations.");
      }

      const existingGeneratedRows = await loadGeneratedRows();
      const messages = buildPromptMessages(catalogRows, requestedLimit, existingGeneratedRows);
      const promptSize = JSON.stringify(messages).length;
      if (promptSize > MAX_CATALOG_CHARS) {
        throw createHttpError(
          400,
          "The active KPI catalog is too large for one request. Narrow it with subject_id or search."
        );
      }

      const openai = getOpenAIClient();
      const completion = await openai.chat.completions.create({
        model: DEFAULT_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: Math.min(5000, 1200 + requestedLimit * 350),
        messages
      });

      const content = String(completion.choices?.[0]?.message?.content || "").trim();
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (_error) {
        throw createHttpError(502, "The AI response could not be parsed as JSON.");
      }

      const rawRecommendations = Array.isArray(parsed?.recommendations)
        ? parsed.recommendations.slice(0, requestedLimit)
        : [];

      if (!rawRecommendations.length) {
        throw createHttpError(422, "The AI returned no KPI recommendations.");
      }

      const existingComparisonRows = [
        ...catalogRows,
        ...existingGeneratedRows
      ];
      const existingNameIndex = buildExistingNameIndex(existingComparisonRows);
      const existingMeaningEntries = buildExistingMeaningEntries(existingComparisonRows);
      const seenInBatch = new Set();
      const seenMeaningSignatures = new Set();
      const rowsToInsert = [];
      const skippedDuplicates = [];

      for (const rawItem of rawRecommendations) {
        const recommendation = normalizeRecommendationPayload(rawItem);
        const validation = validateRecommendation(
          recommendation,
          existingNameIndex,
          existingMeaningEntries
        );
        const signature = buildNameSignature(recommendation);
        const explanationMeaningSignature = buildExplanationMeaningSignature(recommendation);

        if (!validation.isValid) {
          skippedDuplicates.push({
            kpi_name: recommendation.kpi_name || "Untitled KPI",
            reason: validation.errors.join(" ")
          });
          continue;
        }

        if (signature && seenInBatch.has(signature)) {
          skippedDuplicates.push({
            kpi_name: recommendation.kpi_name || "Untitled KPI",
            reason: "Duplicate recommendation in the same AI batch."
          });
          continue;
        }

        if (signature) {
          seenInBatch.add(signature);
          existingNameIndex.add(signature);
        }

        if (explanationMeaningSignature) {
          if (seenMeaningSignatures.has(explanationMeaningSignature)) {
            skippedDuplicates.push({
              kpi_name: recommendation.kpi_name || "Untitled KPI",
              reason: "Duplicate KPI meaning in the same AI batch."
            });
            continue;
          }

          seenMeaningSignatures.add(explanationMeaningSignature);
          existingMeaningEntries.push({
            kpi_name: recommendation.kpi_name || "",
            kpi_sub_title: recommendation.kpi_sub_title || "",
            meaning_anchor: buildMeaningAnchor(recommendation),
            explanation_signature: explanationMeaningSignature,
            explanation_tokens: tokenizeMeaningSignature(recommendation.kpi_explanation)
          });
        }

        rowsToInsert.push(recommendation);
      }

      if (!rowsToInsert.length) {
        if (!allowEmptyInsert) {
          throw createHttpError(422, "All generated KPI ideas were duplicates or incomplete.");
        }

        return {
          count: 0,
          items: [],
          skipped_duplicates: skippedDuplicates,
          catalog_count: catalogRows.length
        };
      }

      client = await pool.connect();
      await client.query("BEGIN");
      const insertedMainKpis = await insertRowsIntoMainKpiTable(client, rowsToInsert, {
        subjectId: normalizedSubjectId
      });
      await client.query("COMMIT");

      return {
        count: insertedMainKpis.length,
        items: insertedMainKpis.map(serializeGeneratedRow),
        skipped_duplicates: skippedDuplicates,
        catalog_count: catalogRows.length,
        inserted_into_kpi_count: insertedMainKpis.length,
        inserted_kpis: insertedMainKpis
      };
    } catch (error) {
      if (client) {
        await client.query("ROLLBACK").catch(() => {});
      }
      throw error;
    } finally {
      if (client) client.release();
    }
  };

  const runScheduledGeneration = async () => {
    if (cronRunInProgress) {
      console.log("[Industrial KPI Generator] Scheduled run skipped because a previous run is still in progress.");
      return;
    }

    cronRunInProgress = true;

    try {
      const result = await generateAndStoreRecommendations({
        search: HARD_CODED_CRON_SEARCH,
        subjectId: HARD_CODED_CRON_SUBJECT_ID,
        limit: HARD_CODED_CRON_LIMIT,
        allowEmptyInsert: true
      });

      console.log(
        `[Industrial KPI Generator] Scheduled run completed. Inserted=${result.count}, skipped=${(result.skipped_duplicates || []).length}, catalog=${result.catalog_count}.`
      );
    } catch (error) {
      console.error("[Industrial KPI Generator] Scheduled run failed:", error.message);
    } finally {
      cronRunInProgress = false;
    }
  };

  app.get("/kpi-derived-generator", async (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(buildPageHtml());
  });

  app.get("/api/ai-generated-kpis/catalog", async (req, res) => {
    try {
      await ensureAIGeneratedKpiSchema();
      const items = await loadActiveKpiCatalog({
        search: req.query.search,
        subjectId: req.query.subject_id
      });
      res.json({ count: items.length, items });
    } catch (error) {
      console.error("GET /api/ai-generated-kpis/catalog error:", error);
      res.status(500).json({ error: "Failed to load the active KPI catalog" });
    }
  });

  app.post("/api/ai-generated-kpis/generate", async (req, res) => {
    try {
      const result = await generateAndStoreRecommendations({
        search: req.body.search,
        subjectId: req.body.subject_id,
        limit: req.body.limit,
        allowEmptyInsert: true
      });

      res.status(result.count > 0 ? 201 : 200).json(result);
    } catch (error) {
      console.error("POST /api/ai-generated-kpis/generate error:", error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "Failed to generate KPI recommendations"
      });
    }
  });

  app.get("/api/ai-generated-kpis", async (_req, res) => {
    try {
      await ensureAIGeneratedKpiSchema();
      const items = await loadGeneratedRows();
      res.json({ count: items.length, items });
    } catch (error) {
      console.error("GET /api/ai-generated-kpis error:", error);
      res.status(500).json({ error: "Failed to load generated KPIs" });
    }
  });

  app.get("/api/ai-generated-kpis/:id", async (req, res) => {
    try {
      await ensureAIGeneratedKpiSchema(); 
      const id = normalizeOptionalIntegerInput(req.params.id);
      if (!id) {
        throw createHttpError(400, "A valid generated KPI id is required.");
      }

      const result = await pool.query(
        `
        SELECT
          kpi_id AS id,
          kpi_name,
          kpi_explanation,
          kpi_sub_title,
          frequency,
          unit
        FROM public.kpi
        WHERE kpi_id = $1
          AND (
            LOWER(COALESCE(NULLIF(BTRIM(type), ''), '')) = LOWER($2)
            OR LOWER(COALESCE(NULLIF(BTRIM(calculation_mode), ''), '')) = LOWER($3)
            OR COALESCE(NULLIF(BTRIM(comments), ''), '') = $4
          )
        LIMIT 1
        `,
        [id, AI_GENERATED_KPI_TYPE, AI_GENERATED_KPI_CALCULATION_MODE, AI_GENERATED_KPI_COMMENT]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Generated KPI not found" });
      }

      res.json(serializeGeneratedRow(result.rows[0]));
    } catch (error) {
      console.error("GET /api/ai-generated-kpis/:id error:", error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "Failed to load generated KPI"
      });
    }
  });

  app.post("/api/ai-generated-kpis/:id/approve", async (_req, res) => {
    res.status(501).json({
      error: "Approve is not enabled in direct KPI table mode."
    });
  });

  app.post("/api/ai-generated-kpis/:id/reject", async (_req, res) => {
    res.status(501).json({
      error: "Reject is not enabled in direct KPI table mode."
    });
  });

  app.post("/api/ai-generated-kpis/run-now", async (req, res) => {
    try {
      const result = await generateAndStoreRecommendations({
        search: req.body.search,
        subjectId: req.body.subject_id,
        limit: req.body.limit,
        allowEmptyInsert: true
      });

      res.status(result.count > 0 ? 201 : 200).json(result);
    } catch (error) {
      console.error("POST /api/ai-generated-kpis/run-now error:", error);
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "Failed to execute KPI generation run"
      });
    }
  });

  ensureAIGeneratedKpiSchema()
    .then(() => {
      console.log("[Industrial KPI Generator] Direct KPI table workflow is ready.");
    })
    .catch((error) => {
      console.error("[Industrial KPI Generator] Schema setup failed:", error.message);
    });

  const cronEnabled = HARD_CODED_CRON_ENABLED;
  const cronExpression = HARD_CODED_CRON_EXPRESSION;
  const cronTimezone = HARD_CODED_CRON_TIMEZONE;
  const runOnStartup = HARD_CODED_CRON_RUN_ON_STARTUP;

  if (cronScheduler && cronEnabled) {
    if (typeof cronScheduler.validate === "function" && !cronScheduler.validate(cronExpression)) {
      console.error(`[Industrial KPI Generator] Invalid cron expression: ${cronExpression}`);
    } else {
      cronScheduler.schedule(
        cronExpression,
        async () => {
          await runScheduledGeneration();
        },
        { scheduled: true, timezone: cronTimezone }
      );

      console.log(
        `[Industrial KPI Generator] Auto-generation scheduled with '${cronExpression}' (${cronTimezone}).`
      );

      if (runOnStartup) {
        runScheduledGeneration().catch((error) => {
          console.error("[Industrial KPI Generator] Startup run failed:", error.message);
        });
      }
    }
  } else {
    console.log("[Industrial KPI Generator] Auto-generation cron is disabled.");
  }
};

module.exports = {
  registerAIGeneratedKpiRoutes
};
