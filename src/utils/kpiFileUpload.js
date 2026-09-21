const path = require("path");
const { createHttpError } = require("./httpError");
const { normalizeOptionalTextInput } = require("./normalize");

const KPI_FILE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const normalizeKpiFileUploadPayload = (value) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileName = normalizeOptionalTextInput(
    value.name ?? value.file_name ?? value.filename
  );
  const fileType =
    normalizeOptionalTextInput(value.type ?? value.mime_type) ||
    "application/octet-stream";
  const sizeValue = Number(value.size);
  const contentBase64 = normalizeOptionalTextInput(
    value.content_base64 ?? value.base64 ?? value.contentBase64
  );

  if (!fileName && !contentBase64) {
    return null;
  }

  if (!fileName || !contentBase64) {
    throw createHttpError(400, "Uploaded KPI file is incomplete.");
  }

  if (!Number.isFinite(sizeValue) || sizeValue < 0) {
    throw createHttpError(400, "Uploaded KPI file size is invalid.");
  }

  if (sizeValue > KPI_FILE_UPLOAD_MAX_BYTES) {
    throw createHttpError(
      400,
      `Uploaded KPI file exceeds the ${Math.round(KPI_FILE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB limit.`
    );
  }

  const normalizedBase64 = contentBase64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalizedBase64)) {
    throw createHttpError(400, "Uploaded KPI file content is invalid.");
  }

  return {
    name: fileName,
    type: fileType,
    size: sizeValue,
    content_base64: normalizedBase64
  };
};

const sanitizeKpiFileName = (value) => {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  const cleaned = normalized
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .trim();

  return cleaned || "kpi-file";
};

const buildStoredKpiFileName = (kpiId, originalName) => {
  const sanitizedName = sanitizeKpiFileName(originalName);
  const extension = path.extname(sanitizedName).slice(0, 32);
  const baseName = path
    .basename(sanitizedName, extension)
    .slice(0, 120)
    .replace(/[^\w\-()]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `kpi-${kpiId}-${Date.now()}-${baseName || "file"}${extension}`;
};

module.exports = {
  KPI_FILE_UPLOAD_MAX_BYTES,
  normalizeKpiFileUploadPayload,
  sanitizeKpiFileName,
  buildStoredKpiFileName,
};
