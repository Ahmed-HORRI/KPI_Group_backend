const { normalizeOptionalTextInput, normalizeOptionalIntegerInput, normalizeOptionalNumericInput } = require("../utils/normalize");
const { pool } = require("../config/db");
const { createHttpError } = require("../utils/httpError");
const { normalizeOptionalDateInput } = require("../utils/weekPeriod");

let responsibleParameterKpiSchemaPromise = null;

const ensureResponsibleParameterKpiSchema = async () => {
  if (!responsibleParameterKpiSchemaPromise) {
    responsibleParameterKpiSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.responsible_parameter_kpis (
          parameter_kpi_id BIGSERIAL PRIMARY KEY,
          responsible_id INTEGER NOT NULL
            REFERENCES public."Responsible" (responsible_id)
            ON DELETE CASCADE,
          kpi_id INTEGER
            REFERENCES public."Kpi" (kpi_id)
            ON DELETE SET NULL,
          location VARCHAR(255) NOT NULL,
          local_currency VARCHAR(50) NOT NULL,
          value NUMERIC(18, 2),
          value_date DATE,
          target NUMERIC(18, 2),
          best_new_target NUMERIC(18, 2),
          kpi_type VARCHAR(120) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        ALTER TABLE public.responsible_parameter_kpis
        ADD COLUMN IF NOT EXISTS kpi_id INTEGER
      `);

      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'fk_responsible_parameter_kpis_kpi'
          ) THEN
            ALTER TABLE public.responsible_parameter_kpis
            ADD CONSTRAINT fk_responsible_parameter_kpis_kpi
            FOREIGN KEY (kpi_id)
            REFERENCES public."Kpi" (kpi_id)
            ON DELETE SET NULL;
          END IF;
        END
        $$;
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_responsible_parameter_kpis_responsible
        ON public.responsible_parameter_kpis (responsible_id, created_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_responsible_parameter_kpis_kpi
        ON public.responsible_parameter_kpis (kpi_id)
      `);
    })().catch((error) => {
      responsibleParameterKpiSchemaPromise = null;
      throw error;
    });
  }

  return responsibleParameterKpiSchemaPromise;
};

const prepareResponsibleParameterKpiPayload = (payload = {}) => {
  const rawKpiId = normalizeOptionalTextInput(payload.kpi_id);
  const rawValue = normalizeOptionalTextInput(payload.value);
  const rawTarget = normalizeOptionalTextInput(payload.target);
  const rawBestNewTarget = normalizeOptionalTextInput(payload.best_new_target);
  const rawValueDate = normalizeOptionalTextInput(payload.value_date);
  const kpiId = rawKpiId === null ? null : Number(rawKpiId);

  const normalizedValue = normalizeOptionalNumericInput(rawValue);
  const normalizedTarget = normalizeOptionalNumericInput(rawTarget);
  const normalizedBestNewTarget = normalizeOptionalNumericInput(rawBestNewTarget);
  const normalizedValueDate = normalizeOptionalDateInput(rawValueDate);

  if (rawKpiId === null || !Number.isInteger(kpiId) || kpiId <= 0) {
    throw createHttpError(400, "KPI Name is required.");
  }

  if (rawValue !== null && normalizedValue === null) {
    throw createHttpError(400, "Value must be numeric.");
  }

  if (rawTarget !== null && normalizedTarget === null) {
    throw createHttpError(400, "Target must be numeric.");
  }

  if (rawBestNewTarget !== null && normalizedBestNewTarget === null) {
    throw createHttpError(400, "Best new target must be numeric.");
  }

  if (rawValueDate !== null && normalizedValueDate === null) {
    throw createHttpError(400, "Date must use YYYY-MM-DD format.");
  }

  const location = normalizeOptionalTextInput(payload.location);
  const localCurrency = normalizeOptionalTextInput(payload.local_currency);
  const kpiType = normalizeOptionalTextInput(payload.kpi_type);

  if (!location) {
    throw createHttpError(400, "Location is required.");
  }

  if (!localCurrency) {
    throw createHttpError(400, "Sell Currency is required.");
  }

  if (!kpiType) {
    throw createHttpError(400, "KPI type is required.");
  }

  return {
    kpi_id: kpiId,
    location,
    local_currency: localCurrency,
    value: normalizedValue === null ? null : Number(normalizedValue),
    value_date: normalizedValueDate,
    target: normalizedTarget === null ? null : Number(normalizedTarget),
    best_new_target: normalizedBestNewTarget === null ? null : Number(normalizedBestNewTarget),
    kpi_type: kpiType
  };
};

module.exports = { ensureResponsibleParameterKpiSchema, prepareResponsibleParameterKpiPayload };
