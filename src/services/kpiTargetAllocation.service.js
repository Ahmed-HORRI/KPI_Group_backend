const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput, normalizeOptionalNumericInput } = require("../utils/normalize");
const { createHttpError } = require("../utils/httpError");
const { normalizeOptionalDateInput, formatDateOnlyValue } = require("../utils/weekPeriod");
const { getPeopleDisplayName, loadSubjectHierarchyData } = require("../models/kpi.model");

let kpiObjectSchemaPromise = null;

const enrichIndividualAllocationScope = async (db, row = {}) => {
  if (String(row.kpi_type || "").trim().toLowerCase() !== "individual") {
    return row;
  }

  const peopleId = normalizeOptionalIntegerInput(row.set_by_people_id);
  const roleId = normalizeOptionalIntegerInput(row.role_id);

  if (!peopleId || !roleId) return row;
  if (row.plant_id && row.unit_id) return row;

  const result = await db.query(
    `
    SELECT
      pra.unit_id,
      pra.zone_id,
      pra.market_id,
      pra.product_line_id
    FROM public.people_role_assignment pra
    WHERE pra.people_id = $1
      AND pra.role_id = $2
      AND COALESCE(pra.assignment_status, 'ACTIVE') = 'ACTIVE'
      AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
    ORDER BY COALESCE(pra.is_primary, false) DESC, pra.assignment_id DESC
    LIMIT 1
    `,
    [peopleId, roleId]
  );

  const assignment = result.rows[0];
  if (!assignment) return row;

  return {
    ...row,
    plant_id: row.plant_id || assignment.unit_id || null,
    unit_id: row.unit_id || assignment.unit_id || null,
    zone_id: row.zone_id || assignment.zone_id || null,
    market_id: row.market_id || assignment.market_id || null,
    product_line_id: row.product_line_id || assignment.product_line_id || null
  };
};

const ensureKpiObjectSchema = async () => {
  if (!kpiObjectSchemaPromise) {
    kpiObjectSchemaPromise = (async () => {
      await pool.query(`
        ALTER TABLE public.kpi_target_allocation
        ADD COLUMN IF NOT EXISTS unit_type_id INTEGER
      `);

      await pool.query(`
        ALTER TABLE public.kpi_target_allocation
        ADD COLUMN IF NOT EXISTS role_id INTEGER
      `);

      await pool.query(`
        ALTER TABLE public.kpi_target_allocation
        ADD COLUMN IF NOT EXISTS created_by_people_id INTEGER
      `);

      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'fk_kpi_target_allocation_unit_type'
          ) THEN
            ALTER TABLE public.kpi_target_allocation
            ADD CONSTRAINT fk_kpi_target_allocation_unit_type
            FOREIGN KEY (unit_type_id)
            REFERENCES public.unit_type (unit_type_id)
            ON UPDATE NO ACTION
            ON DELETE NO ACTION;
          END IF;
        END
        $$;
      `);

      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'fk_kpi_target_allocation_role'
          ) THEN
            ALTER TABLE public.kpi_target_allocation
            ADD CONSTRAINT fk_kpi_target_allocation_role
            FOREIGN KEY (role_id)
            REFERENCES public.role (role_id)
            ON UPDATE NO ACTION
            ON DELETE NO ACTION;
          END IF;
        END
        $$;
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kpi_target_allocation_created_by
        ON public.kpi_target_allocation (created_by_people_id)
      `);
    })().catch((error) => {
      kpiObjectSchemaPromise = null;
      throw error;
    });
  }

  return kpiObjectSchemaPromise;
};

const prepareKpiObjectPayload = (payload = {}) => {
  const rawKpiId = normalizeOptionalTextInput(payload.kpi_id);
  const rawPlantId = normalizeOptionalTextInput(payload.plant_id);
  const rawZoneId = normalizeOptionalTextInput(payload.zone_id);
  const rawUnitId = normalizeOptionalTextInput(payload.unit_id);
  const rawUnitTypeId = normalizeOptionalTextInput(payload.unit_type_id);
  const rawRoleId = normalizeOptionalTextInput(payload.role_id);
  const rawProductId = normalizeOptionalTextInput(payload.product_id);
  const rawProductLineId = normalizeOptionalTextInput(payload.product_line_id);
  const rawMarketId = normalizeOptionalTextInput(payload.market_id);
  const rawCustomerId = normalizeOptionalTextInput(payload.customer_id);
  const rawSetByPeopleId = normalizeOptionalTextInput(payload.set_by_people_id);
  const rawCreatedByPeopleId = normalizeOptionalTextInput(payload.created_by_people_id);
  const rawApprovedByPeopleId = normalizeOptionalTextInput(payload.approved_by_people_id);
  const rawTargetValue = normalizeOptionalTextInput(payload.target_value ?? payload.target);
  const rawLastBestTarget = normalizeOptionalTextInput(payload.last_best_target ?? payload.best_new_target);
  const rawPreviousTargetValue = normalizeOptionalTextInput(payload.previous_target_value ?? payload.value);
  const rawTargetSetupDate = normalizeOptionalTextInput(payload.target_setup_date ?? payload.value_date);
  const rawTargetStartDate = normalizeOptionalTextInput(payload.target_start_date);
  const rawTargetEndDate = normalizeOptionalTextInput(payload.target_end_date);
  const kpiId = rawKpiId === null ? null : Number(rawKpiId);
  const plantId = rawPlantId === null ? null : Number(rawPlantId);
  const zoneId = rawZoneId === null ? null : Number(rawZoneId);
  const unitId = rawUnitId === null ? null : Number(rawUnitId);
  const unitTypeId = rawUnitTypeId === null ? null : Number(rawUnitTypeId);
  const roleId = rawRoleId === null ? null : Number(rawRoleId);
  const productId = rawProductId === null ? null : Number(rawProductId);
  const productLineId = rawProductLineId === null ? null : Number(rawProductLineId);
  const marketId = rawMarketId === null ? null : Number(rawMarketId);
  const customerId = rawCustomerId === null ? null : Number(rawCustomerId);
  const setByPeopleId = rawSetByPeopleId === null ? null : Number(rawSetByPeopleId);
  const createdByPeopleId = rawCreatedByPeopleId === null ? null : Number(rawCreatedByPeopleId);
  const approvedByPeopleId = rawApprovedByPeopleId === null ? null : Number(rawApprovedByPeopleId);

  const normalizedTargetValue = normalizeOptionalNumericInput(rawTargetValue);
  const normalizedLastBestTarget = normalizeOptionalNumericInput(rawLastBestTarget);
  const normalizedPreviousTargetValue = normalizeOptionalNumericInput(rawPreviousTargetValue);
  const normalizedTargetSetupDate =
    normalizeOptionalDateInput(rawTargetSetupDate) ||
    formatDateOnlyValue(new Date());
  const normalizedTargetStartDate = normalizeOptionalDateInput(rawTargetStartDate);
  const normalizedTargetEndDate = normalizeOptionalDateInput(rawTargetEndDate);

  if (rawKpiId === null || !Number.isInteger(kpiId) || kpiId <= 0) {
    throw createHttpError(400, "KPI Name is required.");
  }

  if (rawTargetValue === null || normalizedTargetValue === null) {
    throw createHttpError(400, "Target value is required and must be numeric.");
  }

  if (rawLastBestTarget !== null && normalizedLastBestTarget === null) {
    throw createHttpError(400, "Last best target must be numeric.");
  }

  if (rawPreviousTargetValue !== null && normalizedPreviousTargetValue === null) {
    throw createHttpError(400, "Previous target value must be numeric.");
  }

  if (rawTargetSetupDate !== null && normalizeOptionalDateInput(rawTargetSetupDate) === null) {
    throw createHttpError(400, "Target setup date must use YYYY-MM-DD format.");
  }

  if (rawTargetStartDate !== null && normalizedTargetStartDate === null) {
    throw createHttpError(400, "Target start date must use YYYY-MM-DD format.");
  }

  if (rawTargetEndDate !== null && normalizedTargetEndDate === null) {
    throw createHttpError(400, "Target end date must use YYYY-MM-DD format.");
  }

  if (
    normalizedTargetStartDate &&
    normalizedTargetEndDate &&
    normalizedTargetStartDate > normalizedTargetEndDate
  ) {
    throw createHttpError(400, "Target end date must be after the start date.");
  }

  const localCurrency = normalizeOptionalTextInput(payload.local_currency);
  const kpiType = normalizeOptionalTextInput(payload.kpi_type);
  const targetUnit = normalizeOptionalTextInput(payload.target_unit);
  const targetStatus = normalizeOptionalTextInput(payload.target_status) || "Draft";
  const functionName = normalizeOptionalTextInput(payload.function);
  const normalizedKpiType = String(kpiType || "").trim().toLowerCase();

  if (normalizedKpiType === "individual" && roleId === null) {
    throw createHttpError(400, "Role is required for Individual KPI type.");
  }

  for (const [label, rawValue, numericValue] of [
    ["Plant", rawPlantId, plantId],
    ["Zone", rawZoneId, zoneId],
    ["Unit", rawUnitId, unitId],
    ["Unit type", rawUnitTypeId, unitTypeId],
    ["Role", rawRoleId, roleId],
    ["Product", rawProductId, productId],
    ["Product line", rawProductLineId, productLineId],
    ["Market", rawMarketId, marketId],
    ["Customer", rawCustomerId, customerId],
    ["Set by people", rawSetByPeopleId, setByPeopleId],
    ["Created by people", rawCreatedByPeopleId, createdByPeopleId],
    ["Approved by people", rawApprovedByPeopleId, approvedByPeopleId]
  ]) {
    if (rawValue !== null && (!Number.isInteger(numericValue) || numericValue <= 0)) {
      throw createHttpError(400, `${label} must be a valid selection.`);
    }
  }

  return {
    kpi_id: kpiId,
    local_currency: localCurrency,
    plant_id: plantId,
    zone_id: zoneId,
    unit_id: unitId,
    unit_type_id: unitTypeId,
    role_id: roleId,
    function: functionName,
    product_id: productId,
    product_line_id: productLineId,
    market_id: marketId,
    customer_id: customerId,
    target_value: Number(normalizedTargetValue),
    target_unit: targetUnit,
    kpi_type: kpiType,
    target_setup_date: normalizedTargetSetupDate,
    target_start_date: normalizedTargetStartDate,
    target_end_date: normalizedTargetEndDate,
    last_best_target: normalizedLastBestTarget === null ? null : Number(normalizedLastBestTarget),
    previous_target_value: normalizedPreviousTargetValue === null ? null : Number(normalizedPreviousTargetValue),
    target_status: targetStatus,
    set_by_people_id: setByPeopleId,
    created_by_people_id: createdByPeopleId,
    approved_by_people_id: approvedByPeopleId,
    comments: normalizeOptionalTextInput(payload.comments)
  };
};

const loadKpiTargetAllocationRowsForUi = async ({ allocationId = null, responsibleId = null } = {}) => {
  const subjectHierarchy = await loadSubjectHierarchyData();
  const normalizedResponsibleId = normalizeOptionalIntegerInput(responsibleId);
  const result = await pool.query(
    `
    SELECT
      a.kpi_target_allocation_id,
      a.kpi_id,
      a.plant_id,
      plant.unit_name AS plant_name,
      plant.unit_type_id AS plant_unit_type_id,
      a.zone_id,
      zone.zone_name,
      zone_responsible.people_id AS zone_responsible_people_id,
      zone_responsible.name AS zone_responsible_name,
      zone_responsible.first_name AS zone_responsible_first_name,
      a.unit_id,
      unit_scope.unit_name AS unit_name,
      a.unit_type_id,
      unit_type.unit_type_name,
      a.role_id,
      role.role_name,
      a.function,
      a.product_id,
      product.product_name,
      a.product_line_id,
      product_line.product_line_name,
      a.market_id,
      market.market_name,
      a.customer_id,
      customer.customer_name,
      a.target_value,
      a.target_unit,
      a.local_currency,
      a.kpi_type,
      TO_CHAR(a.target_setup_date, 'YYYY-MM-DD') AS target_setup_date,
      TO_CHAR(a.target_start_date, 'YYYY-MM-DD') AS target_start_date,
      TO_CHAR(a.target_end_date, 'YYYY-MM-DD') AS target_end_date,
      a.last_best_target,
      a.previous_target_value,
      a.target_status,
      a.set_by_people_id,
      a.created_by_people_id,
      set_by_people.name AS set_by_people_name,
      set_by_people.first_name AS set_by_people_first_name,
      created_by_people.name AS created_by_people_name,
      created_by_people.first_name AS created_by_people_first_name,
      a.approved_by_people_id,
      approved_by_people.name AS approved_by_people_name,
      approved_by_people.first_name AS approved_by_people_first_name,
      a.comments,
      a.created_at,
      a.updated_at,
      k.kpi_name,
      k.kpi_sub_title,
      k.frequency,
      primary_subject.subject_id AS subject_id
   FROM public.kpi_target_allocation a
    INNER JOIN public.kpi k
     ON k.kpi_id = a.kpi_id
    AND k.is_active IS TRUE
    LEFT JOIN public.unit plant
      ON plant.unit_id = a.plant_id
    LEFT JOIN public.unit_type unit_type
      ON unit_type.unit_type_id = a.unit_type_id
    LEFT JOIN public.zone zone
      ON zone.zone_id = a.zone_id
    LEFT JOIN LATERAL (
      SELECT
        pra.people_id,
        p.name,
        p.first_name
      FROM public.people_role_assignment pra
      LEFT JOIN public.people p
        ON p.people_id = pra.people_id
      WHERE pra.zone_id = a.zone_id
        AND pra.assignment_status = 'ACTIVE'
      ORDER BY COALESCE(pra.is_primary, false) DESC, pra.assignment_id DESC
      LIMIT 1
    ) zone_responsible ON TRUE
    LEFT JOIN public.unit unit_scope
      ON unit_scope.unit_id = a.unit_id
    LEFT JOIN public.role role
      ON role.role_id = a.role_id
    LEFT JOIN public.product product
      ON product.product_id = a.product_id
    LEFT JOIN public.product_line product_line
      ON product_line.product_line_id = a.product_line_id
    LEFT JOIN public.market market
      ON market.market_id = a.market_id
    LEFT JOIN public.customer customer
      ON customer.customer_id = a.customer_id
    LEFT JOIN public.people set_by_people
      ON set_by_people.people_id = a.set_by_people_id
    LEFT JOIN public.people created_by_people
      ON created_by_people.people_id = a.created_by_people_id
    LEFT JOIN public.people approved_by_people
      ON approved_by_people.people_id = a.approved_by_people_id
    LEFT JOIN LATERAL (
      SELECT sk.subject_id
      FROM public.subject_kpi sk
      WHERE sk.kpi_id = a.kpi_id
      ORDER BY COALESCE(sk.is_primary, false) DESC, sk.subject_kpi_id ASC
      LIMIT 1
    ) primary_subject ON TRUE
    WHERE ($1::integer IS NULL OR a.kpi_target_allocation_id = $1)
      AND (
        $2::integer IS NULL
        OR a.set_by_people_id = $2
        OR a.created_by_people_id = $2
      )
    ORDER BY a.created_at DESC, a.kpi_target_allocation_id DESC
    `,
    [allocationId, normalizedResponsibleId]
  );

  return result.rows.map((row) => {
    const zoneResponsibleLabel =
      getPeopleDisplayName({
        name: row.zone_responsible_name,
        first_name: row.zone_responsible_first_name
      }) || getPeopleDisplayName({
        name: row.set_by_people_name,
        first_name: row.set_by_people_first_name
      }) || "";

    return {
      ...row,
      unit_type_id: row.unit_type_id ?? row.plant_unit_type_id ?? null,
      unit_type_name: row.unit_type_name || "",
      role_name: row.role_name || "",
      frequency: row.frequency || "",
      responsable_zone: zoneResponsibleLabel,
      kpi_subject: row.subject_id ? subjectHierarchy.pathById.get(String(row.subject_id)) || "" : "",
      kpi_group: row.kpi_sub_title || "",
      set_by_people_display_name: getPeopleDisplayName({
        name: row.set_by_people_name,
        first_name: row.set_by_people_first_name
      }) || zoneResponsibleLabel || "",
      created_by_people_display_name: getPeopleDisplayName({
        name: row.created_by_people_name,
        first_name: row.created_by_people_first_name
      }) || "",
      approved_by_people_display_name: getPeopleDisplayName({
        name: row.approved_by_people_name,
        first_name: row.approved_by_people_first_name
      }) || ""
    };
  });
};

const buildPreparedKpiObjectRows = (
  payload = {},
  defaultSetByPeopleId = null,
  defaultCreatedByPeopleId = null
) => {
  const payloadHasSetByPeopleId = Object.prototype.hasOwnProperty.call(payload, "set_by_people_id");
  const payloadHasCreatedByPeopleId = Object.prototype.hasOwnProperty.call(payload, "created_by_people_id");
  const basePayload = {
    ...payload,
    set_by_people_id: payloadHasSetByPeopleId
      ? payload.set_by_people_id
      : defaultSetByPeopleId,
    created_by_people_id: payloadHasCreatedByPeopleId
      ? payload.created_by_people_id
      : defaultCreatedByPeopleId
  };
  const requestedRows = Array.isArray(payload.unit_allocations)
    ? payload.unit_allocations.filter(
      (row) => normalizeOptionalTextInput(row?.target_value ?? row?.target) !== null
    )
    : [];
  const baseAllocationId =
    normalizeOptionalIntegerInput(
      payload.kpi_target_allocation_id ?? payload.allocation_id ?? payload.parameter_object_id
    );

  if (!requestedRows.length) {
    const preparedPayload = prepareKpiObjectPayload(basePayload);
    return [
      baseAllocationId
        ? {
          ...preparedPayload,
          kpi_target_allocation_id: baseAllocationId
        }
        : preparedPayload
    ];
  }

  return requestedRows.map((row) => {
    const preparedPayload = prepareKpiObjectPayload({
      ...basePayload,
      ...row,
      kpi_id: row.kpi_id ?? payload.kpi_id,
      kpi_type: row.kpi_type ?? payload.kpi_type,
      plant_id: row.plant_id ?? row.unit_id ?? payload.plant_id,
      zone_id: row.zone_id ?? payload.zone_id,
      unit_id: row.unit_id ?? payload.unit_id,
      unit_type_id: row.unit_type_id ?? payload.unit_type_id,
      role_id: row.role_id ?? payload.role_id,
      function: row.function ?? payload.function,
      product_id: row.product_id ?? payload.product_id,
      product_line_id: row.product_line_id ?? payload.product_line_id,
      market_id: row.market_id ?? payload.market_id,
      customer_id: row.customer_id ?? payload.customer_id,
      target_value: row.target_value ?? payload.target_value,
      target_unit: row.target_unit ?? payload.target_unit,
      local_currency: row.local_currency ?? payload.local_currency,
      target_setup_date: row.target_setup_date ?? payload.target_setup_date,
      target_start_date: row.target_start_date ?? payload.target_start_date,
      target_end_date: row.target_end_date ?? payload.target_end_date,
      last_best_target: row.last_best_target ?? payload.last_best_target,
      previous_target_value: row.previous_target_value ?? payload.previous_target_value,
      target_status: row.target_status ?? payload.target_status,
      set_by_people_id: Object.prototype.hasOwnProperty.call(row, "set_by_people_id")
        ? row.set_by_people_id
        : (payloadHasSetByPeopleId ? payload.set_by_people_id : defaultSetByPeopleId),
      created_by_people_id: Object.prototype.hasOwnProperty.call(row, "created_by_people_id")
        ? row.created_by_people_id
        : (payloadHasCreatedByPeopleId ? payload.created_by_people_id : defaultCreatedByPeopleId),
      approved_by_people_id: row.approved_by_people_id ?? payload.approved_by_people_id,
      comments: row.comments ?? payload.comments
    });
    const rowAllocationId =
      normalizeOptionalIntegerInput(
        row.kpi_target_allocation_id ?? row.allocation_id
      );

    return rowAllocationId
      ? {
        ...preparedPayload,
        kpi_target_allocation_id: rowAllocationId
      }
      : preparedPayload;
  });
};

const getKpiObjectInsertValues = (payload = {}) => ([
  payload.kpi_id,
  payload.plant_id,
  payload.zone_id,
  payload.unit_id,
  payload.function,
  payload.product_id,
  payload.product_line_id,
  payload.market_id,
  payload.customer_id,
  payload.target_value,
  payload.target_unit,
  payload.local_currency,
  payload.kpi_type,
  payload.unit_type_id,
  payload.role_id,
  payload.target_setup_date,
  payload.target_start_date,
  payload.target_end_date,
  payload.last_best_target,
  payload.previous_target_value,
  payload.target_status,
  payload.set_by_people_id,
  payload.created_by_people_id,
  payload.approved_by_people_id,
  payload.comments
]);

const getKpiTargetAllocationScopeKey = (row = {}) => {
  const normalizedZoneId = normalizeOptionalIntegerInput(row.zone_id);
  const normalizedUnitId = normalizeOptionalIntegerInput(row.plant_id ?? row.unit_id);
  const normalizedProductLineId = normalizeOptionalIntegerInput(row.product_line_id);
  const normalizedKpiId = normalizeOptionalIntegerInput(row.kpi_id);
  const normalizedUnitTypeId = normalizeOptionalIntegerInput(row.unit_type_id);
  const normalizedRoleId = normalizeOptionalIntegerInput(row.role_id);
  const normalizedProductId = normalizeOptionalIntegerInput(row.product_id);
  const normalizedMarketId = normalizeOptionalIntegerInput(row.market_id);
  const normalizedCustomerId = normalizeOptionalIntegerInput(row.customer_id);
  const normalizedSetByPeopleId = normalizeOptionalIntegerInput(row.set_by_people_id);
  const normalizedFunction = normalizeOptionalTextInput(row.function);
  const normalizedKpiType = normalizeOptionalTextInput(row.kpi_type);
  const isRoleScope =
    String(normalizedKpiType || "").trim().toLowerCase() === "role";

  const scopeIdentifier = normalizedZoneId
    ? `zone:${normalizedZoneId}`
    : normalizedUnitId
      ? `unit:${normalizedUnitId}`
      : normalizedProductLineId
        ? `productLine:${normalizedProductLineId}`
        : "";

  if (!scopeIdentifier) {
    return "";
  }

  return [
    scopeIdentifier,
    normalizedKpiId ? `kpi:${normalizedKpiId}` : "",
    normalizedKpiType ? `type:${String(normalizedKpiType).toLowerCase()}` : "",
    normalizedUnitTypeId ? `unitType:${normalizedUnitTypeId}` : "",
    normalizedRoleId ? `role:${normalizedRoleId}` : "",
    normalizedSetByPeopleId ? `people:${normalizedSetByPeopleId}` : "",
    normalizedFunction ? `function:${String(normalizedFunction).toLowerCase()}` : "",
    normalizedProductId ? `product:${normalizedProductId}` : "",
    normalizedProductLineId ? `productLine:${normalizedProductLineId}` : "",
    normalizedMarketId ? `market:${normalizedMarketId}` : "",
    normalizedCustomerId ? `customer:${normalizedCustomerId}` : ""
  ]
    .filter(Boolean)
    .join("|");
};

const getKpiTargetAllocationScopeIdentifier = (row = {}) => {
  const normalizedZoneId = normalizeOptionalIntegerInput(row.zone_id);
  const normalizedUnitId = normalizeOptionalIntegerInput(row.plant_id ?? row.unit_id);
  const normalizedProductLineId = normalizeOptionalIntegerInput(row.product_line_id);
  const normalizedRoleId = normalizeOptionalIntegerInput(row.role_id);
  const normalizedSetByPeopleId = normalizeOptionalIntegerInput(row.set_by_people_id);

  if (normalizedZoneId) {
    return [
      `zone:${normalizedZoneId}`,
      normalizedRoleId ? `role:${normalizedRoleId}` : "",
      normalizedSetByPeopleId ? `people:${normalizedSetByPeopleId}` : ""
    ].filter(Boolean).join("|");
  }

  if (normalizedUnitId) {
    return [
      `unit:${normalizedUnitId}`,
      normalizedRoleId ? `role:${normalizedRoleId}` : "",
      normalizedSetByPeopleId ? `people:${normalizedSetByPeopleId}` : ""
    ].filter(Boolean).join("|");
  }

  return normalizedProductLineId ? `productLine:${normalizedProductLineId}` : "";
};

const getKpiTargetAllocationGroupIds = async (allocationId) => {
  const normalizedAllocationId = normalizeOptionalIntegerInput(allocationId);
  if (!normalizedAllocationId) return [];

  const anchorResult = await pool.query(
    `
    SELECT
      kpi_target_allocation_id,
      kpi_id,
      kpi_type,
      unit_type_id,
      role_id,
      "function",
      product_id,
      product_line_id,
      market_id,
      customer_id,
      created_at
    FROM public.kpi_target_allocation
    WHERE kpi_target_allocation_id = $1
    LIMIT 1
    `,
    [normalizedAllocationId]
  );

  const anchorRow = anchorResult.rows[0];
  if (!anchorRow) return [];

  const siblingResult = await pool.query(
    `
    SELECT kpi_target_allocation_id
    FROM public.kpi_target_allocation
    WHERE kpi_id = $1
      AND COALESCE(kpi_type, '') = COALESCE($2, '')
      AND COALESCE(unit_type_id, 0) = COALESCE($3, 0)
      AND COALESCE(role_id, 0) = COALESCE($4, 0)
      AND COALESCE("function", '') = COALESCE($5, '')
      AND COALESCE(product_id, 0) = COALESCE($6, 0)
      AND COALESCE(product_line_id, 0) = COALESCE($7, 0)
      AND COALESCE(market_id, 0) = COALESCE($8, 0)
      AND COALESCE(customer_id, 0) = COALESCE($9, 0)
    ORDER BY kpi_target_allocation_id ASC
    `,
    [
      anchorRow.kpi_id,
      anchorRow.kpi_type,
      anchorRow.unit_type_id,
      anchorRow.role_id,
      anchorRow.function,
      anchorRow.product_id,
      anchorRow.product_line_id,
      anchorRow.market_id,
      anchorRow.customer_id
    ]
  );

  const groupIds = siblingResult.rows
    .map((row) => normalizeOptionalIntegerInput(row.kpi_target_allocation_id))
    .filter((value) => Number.isInteger(value));

  return groupIds.length ? groupIds : [normalizedAllocationId];
};

const getKpiTargetAllocationFamilyIds = async (allocationId) => {
  const normalizedAllocationId = normalizeOptionalIntegerInput(allocationId);
  if (!normalizedAllocationId) return [];

  const anchorResult = await pool.query(
    `
    SELECT
      kpi_target_allocation_id,
      kpi_id,
      created_by_people_id,
      created_at
    FROM public.kpi_target_allocation
    WHERE kpi_target_allocation_id = $1
    LIMIT 1
    `,
    [normalizedAllocationId]
  );

  const anchorRow = anchorResult.rows[0];
  if (!anchorRow) return [];

  const siblingResult = await pool.query(
    `
    SELECT kpi_target_allocation_id
    FROM public.kpi_target_allocation
    WHERE kpi_id = $1
      AND COALESCE(created_by_people_id, 0) = COALESCE($2, 0)
      AND created_at = $3
    ORDER BY kpi_target_allocation_id ASC
    `,
    [
      anchorRow.kpi_id,
      anchorRow.created_by_people_id,
      anchorRow.created_at
    ]
  );

  const familyIds = siblingResult.rows
    .map((row) => normalizeOptionalIntegerInput(row.kpi_target_allocation_id))
    .filter((value) => Number.isInteger(value));

  return familyIds.length ? familyIds : [normalizedAllocationId];
};

const loadKpiTargetAllocationGroupRowsForUi = async (allocationId) => {
  const groupIds = await getKpiTargetAllocationGroupIds(allocationId);
  if (!groupIds.length) return [];

  const rowCollections = await Promise.all(
    groupIds.map((groupAllocationId) =>
      loadKpiTargetAllocationRowsForUi({ allocationId: groupAllocationId, responsibleId: null })
    )
  );

  return rowCollections
    .flat()
    .filter(Boolean)
    .sort((left, right) => Number(left.kpi_target_allocation_id) - Number(right.kpi_target_allocation_id));
};

const loadKpiTargetAllocationFamilyRowsForUi = async (allocationId) => {
  const familyIds = await getKpiTargetAllocationFamilyIds(allocationId);
  if (!familyIds.length) return [];

  const rowCollections = await Promise.all(
    familyIds.map((familyAllocationId) =>
      loadKpiTargetAllocationRowsForUi({ allocationId: familyAllocationId, responsibleId: null })
    )
  );

  return rowCollections
    .flat()
    .filter(Boolean)
    .sort((left, right) => Number(left.kpi_target_allocation_id) - Number(right.kpi_target_allocation_id));
};

const loadKpiTargetAllocationRowsByIdsForUi = async (allocationIds = []) => {
  const normalizedAllocationIds = Array.from(
    new Set(
      (Array.isArray(allocationIds) ? allocationIds : [allocationIds])
        .map((allocationId) => normalizeOptionalIntegerInput(allocationId))
        .filter((allocationId) => Number.isInteger(allocationId) && allocationId > 0)
    )
  );
  if (!normalizedAllocationIds.length) return [];

  const rowCollections = await Promise.all(
    normalizedAllocationIds.map((allocationId) =>
      loadKpiTargetAllocationRowsForUi({ allocationId, responsibleId: null })
    )
  );

  return rowCollections
    .flat()
    .filter(Boolean)
    .sort((left, right) => Number(left.kpi_target_allocation_id) - Number(right.kpi_target_allocation_id));
};

module.exports = {
  enrichIndividualAllocationScope,
  ensureKpiObjectSchema,
  prepareKpiObjectPayload,
  loadKpiTargetAllocationRowsForUi,
  buildPreparedKpiObjectRows,
  getKpiObjectInsertValues,
  getKpiTargetAllocationScopeKey,
  getKpiTargetAllocationScopeIdentifier,
  getKpiTargetAllocationGroupIds,
  getKpiTargetAllocationFamilyIds,
  loadKpiTargetAllocationGroupRowsForUi,
  loadKpiTargetAllocationFamilyRowsForUi,
  loadKpiTargetAllocationRowsByIdsForUi,
};
