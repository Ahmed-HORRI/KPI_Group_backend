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

module.exports = { normalizeOptionalTextInput, normalizeOptionalIntegerInput };
