const fs = require("fs");
const path = require("path");
const { createHttpError } = require("../utils/httpError");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const {
  KPI_FILE_UPLOAD_MAX_BYTES,
  normalizeKpiFileUploadPayload,
  buildStoredKpiFileName,
} = require("../utils/kpiFileUpload");
const { getKpiDisplayFileName, getKpiStoredFileName } = require("../models/kpi.model");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const KPI_FILE_STORAGE_DIRECTORY = path.join(PROJECT_ROOT, "data", "kpi-files");

const resolveStoredKpiFileAbsolutePath = (storedPath) => {
  const normalizedPath = normalizeOptionalTextInput(storedPath);
  if (
    !normalizedPath ||
    /^(https?:)?\/\//i.test(normalizedPath) ||
    normalizedPath.startsWith("/")
  ) {
    return null;
  }

  const relativeStoragePath = /[\\/]/.test(normalizedPath)
    ? normalizedPath
    : path.posix.join("data", "kpi-files", normalizedPath);
  const resolvedPath = path.resolve(
    PROJECT_ROOT,
    relativeStoragePath.replace(/\//g, path.sep)
  );
  const storageRoot = path.resolve(KPI_FILE_STORAGE_DIRECTORY);

  if (
    resolvedPath !== storageRoot &&
    !resolvedPath.startsWith(storageRoot + path.sep)
  ) {
    return null;
  }

  return resolvedPath;
};

const writeUploadedKpiFile = async (kpiId, fileUpload) => {
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  if (!normalizedKpiId) {
    throw createHttpError(400, "A valid KPI ID is required before saving a file.");
  }

  const normalizedUpload = normalizeKpiFileUploadPayload(fileUpload);
  if (!normalizedUpload) {
    return null;
  }

  const buffer = Buffer.from(normalizedUpload.content_base64, "base64");
  if (!buffer.length && normalizedUpload.size > 0) {
    throw createHttpError(400, "Uploaded KPI file content is empty.");
  }

  if (buffer.length > KPI_FILE_UPLOAD_MAX_BYTES) {
    throw createHttpError(
      400,
      `Uploaded KPI file exceeds the ${Math.round(KPI_FILE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB limit.`
    );
  }

  await fs.promises.mkdir(KPI_FILE_STORAGE_DIRECTORY, { recursive: true });

  const storedFileName = buildStoredKpiFileName(normalizedKpiId, normalizedUpload.name);
  const relativePath = path.posix.join("data", "kpi-files", storedFileName);
  const absolutePath = path.join(KPI_FILE_STORAGE_DIRECTORY, storedFileName);

  await fs.promises.writeFile(absolutePath, buffer);

  return {
    stored_path: relativePath,
    absolute_path: absolutePath,
    file_name: normalizedUpload.name,
    file_size: buffer.length
  };
};

const copyExistingKpiFile = async (
  kpiId,
  sourcePath,
  { preferredFileName = "" } = {}
) => {
  const normalizedKpiId = normalizeOptionalIntegerInput(kpiId);
  if (!normalizedKpiId) {
    throw createHttpError(400, "A valid KPI ID is required before copying a file.");
  }

  const normalizedSourcePath = normalizeOptionalTextInput(sourcePath);
  if (!normalizedSourcePath) {
    return null;
  }

  const normalizedPreferredFileName = normalizeOptionalTextInput(preferredFileName);
  const displayFileName =
    normalizedPreferredFileName ||
    getKpiDisplayFileName(normalizedSourcePath) ||
    getKpiStoredFileName(normalizedSourcePath) ||
    "kpi-file";

  if (
    /^(https?:)?\/\//i.test(normalizedSourcePath) ||
    normalizedSourcePath.startsWith("/")
  ) {
    return {
      stored_path: normalizedSourcePath,
      absolute_path: null,
      file_name: displayFileName,
      file_size: null
    };
  }

  const sourceAbsolutePath = resolveStoredKpiFileAbsolutePath(normalizedSourcePath);
  if (!sourceAbsolutePath) {
    throw createHttpError(400, "Existing KPI file path is invalid.");
  }

  await fs.promises.access(sourceAbsolutePath, fs.constants.F_OK);
  await fs.promises.mkdir(KPI_FILE_STORAGE_DIRECTORY, { recursive: true });

  const storedFileName = buildStoredKpiFileName(normalizedKpiId, displayFileName);
  const relativePath = path.posix.join("data", "kpi-files", storedFileName);
  const absolutePath = path.join(KPI_FILE_STORAGE_DIRECTORY, storedFileName);

  await fs.promises.copyFile(sourceAbsolutePath, absolutePath);
  const copiedStat = await fs.promises.stat(absolutePath);

  return {
    stored_path: relativePath,
    absolute_path: absolutePath,
    file_name: displayFileName,
    file_size: copiedStat.size
  };
};

const deleteStoredKpiFile = async (storedPath) => {
  const absolutePath = resolveStoredKpiFileAbsolutePath(storedPath);
  if (!absolutePath) return;

  try {
    await fs.promises.unlink(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Unable to delete KPI file:", error.message);
    }
  }
};

module.exports = {
  KPI_FILE_UPLOAD_MAX_BYTES,
  resolveStoredKpiFileAbsolutePath,
  writeUploadedKpiFile,
  copyExistingKpiFile,
  deleteStoredKpiFile,
};
