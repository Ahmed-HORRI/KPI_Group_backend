const normalizeOptionalTextInput = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
};

const normalizeOptionalIntegerInput = (value) => {
  const text = normalizeOptionalTextInput(value);
  if (text === null || !/^\d+$/.test(text)) return null;
  return Number(text);
};

const NUMERIC_TEXT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const normalizeOptionalNumericInput = (value, { allowPercent = false } = {}) => {
  const text = normalizeOptionalTextInput(value);
  if (text === null) return null;

  let normalized = text.replace(/\s+/g, "").replace(/,/g, ".");
  if (allowPercent && normalized.endsWith("%")) {
    normalized = normalized.slice(0, -1);
  }

  return NUMERIC_TEXT_PATTERN.test(normalized) ? normalized : null;
};

module.exports = {
  normalizeOptionalTextInput,
  normalizeOptionalIntegerInput,
  normalizeOptionalNumericInput,
};
