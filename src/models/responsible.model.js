const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const { getPeopleDisplayName } = require("./kpi.model");

const loadLegacyResponsibleIdentity = async (responsibleId) => {
  const normalizedResponsibleId = normalizeOptionalIntegerInput(responsibleId);
  if (!normalizedResponsibleId) return null;

  try {
    const result = await pool.query(
      `
      SELECT responsible_id, name, email
      FROM public."Responsible"
      WHERE responsible_id = $1
      LIMIT 1
      `,
      [normalizedResponsibleId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      responsible_id: row.responsible_id,
      name: normalizeOptionalTextInput(row.name),
      email: normalizeOptionalTextInput(row.email)
    };
  } catch (error) {
    return null;
  }
};

const findPeopleContextForLegacyResponsible = async (legacyResponsible = {}) => {
  const legacyEmail = normalizeOptionalTextInput(legacyResponsible.email);
  const legacyName = normalizeOptionalTextInput(legacyResponsible.name);
  if (!legacyEmail && !legacyName) return null;

  const result = await pool.query(
    `
    SELECT
      p.people_id,
      p.first_name,
      p.name,
      p.email,
      u.unit_name AS plant_name
    FROM public.people p
    LEFT JOIN public.unit u
      ON u.unit_id = p.work_at_unit_id
    WHERE
      ($1::text IS NOT NULL AND LOWER(COALESCE(p.email, '')) = LOWER($1))
      OR (
        $2::text IS NOT NULL
        AND (
          LOWER(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, '')))) = LOWER($2)
          OR LOWER(COALESCE(p.name, '')) = LOWER($2)
          OR LOWER(COALESCE(p.first_name, '')) = LOWER($2)
        )
      )
    ORDER BY
      CASE
        WHEN $1::text IS NOT NULL AND LOWER(COALESCE(p.email, '')) = LOWER($1) THEN 0
        WHEN $2::text IS NOT NULL
          AND LOWER(TRIM(CONCAT_WS(' ', COALESCE(p.first_name, ''), COALESCE(p.name, '')))) = LOWER($2) THEN 1
        WHEN $2::text IS NOT NULL AND LOWER(COALESCE(p.name, '')) = LOWER($2) THEN 2
        WHEN $2::text IS NOT NULL AND LOWER(COALESCE(p.first_name, '')) = LOWER($2) THEN 3
        ELSE 4
      END,
      p.people_id ASC
    LIMIT 1
    `,
    [legacyEmail, legacyName]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    people_id: row.people_id,
    name: getPeopleDisplayName(row) || legacyName || `People #${row.people_id}`,
    email: normalizeOptionalTextInput(row.email) || legacyEmail,
    plant_name: normalizeOptionalTextInput(row.plant_name) || "Allocated scope",
    department_name: ""
  };
};

const loadFormResponsibleContext = async (responsibleId, unitId = null) => {
  const normalizedResponsibleId =
    normalizeOptionalIntegerInput(responsibleId);

  const normalizedUnitId = normalizeOptionalIntegerInput(unitId);

  if (!normalizedResponsibleId) return null;

  const result = await pool.query(
    `
    SELECT
      p.people_id,
      p.name,
      p.first_name,
      p.email,
      COALESCE(requested_unit.unit_name, home_unit.unit_name, allocation_scope.group_name) AS plant_name,
      COALESCE(primary_role.role_name, allocation_scope.role_name) AS role_name,
      people_department.department_name
    FROM public.people p
    LEFT JOIN public.unit home_unit
      ON home_unit.unit_id = p.work_at_unit_id
    LEFT JOIN public.unit requested_unit
      ON requested_unit.unit_id = $2  
    LEFT JOIN LATERAL (
      SELECT r.role_name
      FROM public.people_role_assignment pra
      LEFT JOIN public.role r
        ON r.role_id = pra.role_id
      WHERE pra.people_id = p.people_id
        AND pra.assignment_status = 'ACTIVE'
      ORDER BY COALESCE(pra.is_primary, false) DESC, pra.assignment_id DESC
      LIMIT 1
    ) primary_role ON TRUE
    LEFT JOIN LATERAL (
      SELECT vpd.department_name
      FROM public.v_people_department vpd
      WHERE vpd.people_id = p.people_id
        AND COALESCE(vpd.assignment_status, 'ACTIVE') = 'ACTIVE'
        AND vpd.department_name IS NOT NULL
      ORDER BY COALESCE(vpd.is_primary, false) DESC,
               vpd.department_id ASC
      LIMIT 1
    ) people_department ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(plant.unit_name, zone.zone_name, unit_scope.unit_name) AS group_name,
        role.role_name
      FROM public.kpi_target_allocation kta
      LEFT JOIN public.unit plant
        ON plant.unit_id = kta.plant_id
      LEFT JOIN public.zone zone
        ON zone.zone_id = kta.zone_id
      LEFT JOIN public.unit unit_scope
        ON unit_scope.unit_id = kta.unit_id
      LEFT JOIN public.role role
        ON role.role_id = kta.role_id
      WHERE kta.set_by_people_id = p.people_id
      ORDER BY kta.target_start_date DESC NULLS LAST, kta.kpi_target_allocation_id DESC
      LIMIT 1
    ) allocation_scope ON TRUE
    WHERE p.people_id = $1
    LIMIT 1
    `,
    [normalizedResponsibleId, normalizedUnitId]
  );

  if (!result.rows.length) {
    return null;
  }

  return {
    people_id: result.rows[0].people_id,
    name: getPeopleDisplayName(result.rows[0]),
    email: result.rows[0].email,
    plant_name: normalizeOptionalTextInput(result.rows[0].plant_name) || "Allocated scope",
    group_name: normalizeOptionalTextInput(result.rows[0].plant_name) || "Allocated scope",
    role_name: normalizeOptionalTextInput(result.rows[0].role_name) || "",
    role: normalizeOptionalTextInput(result.rows[0].role_name) || "",
    department_name: normalizeOptionalTextInput(result.rows[0].department_name) || ""
  };
};

const resolveResponsibleOwnerContext = async (responsibleId) => {
  const normalizedResponsibleId = normalizeOptionalIntegerInput(responsibleId);
  if (!normalizedResponsibleId) return null;

  const directContext = await loadFormResponsibleContext(normalizedResponsibleId);
  if (directContext?.people_id) {
    return directContext;
  }

  const legacyResponsible = await loadLegacyResponsibleIdentity(normalizedResponsibleId);
  if (!legacyResponsible) {
    return null;
  }

  const matchedPeopleContext = await findPeopleContextForLegacyResponsible(legacyResponsible);
  if (!matchedPeopleContext?.people_id) {
    return null;
  }

  const enrichedContext = await loadFormResponsibleContext(matchedPeopleContext.people_id);
  return {
    ...matchedPeopleContext,
    ...enrichedContext,
    people_id: normalizeOptionalIntegerInput(
      enrichedContext?.people_id ?? matchedPeopleContext.people_id
    ),
    name:
      normalizeOptionalTextInput(enrichedContext?.name) ||
      normalizeOptionalTextInput(matchedPeopleContext.name) ||
      normalizeOptionalTextInput(legacyResponsible.name) ||
      `People #${matchedPeopleContext.people_id}`,
    email:
      normalizeOptionalTextInput(enrichedContext?.email) ||
      normalizeOptionalTextInput(matchedPeopleContext.email) ||
      normalizeOptionalTextInput(legacyResponsible.email),
    plant_name:
      normalizeOptionalTextInput(enrichedContext?.plant_name) ||
      normalizeOptionalTextInput(matchedPeopleContext.plant_name) ||
      "Allocated scope",
    department_name:
      normalizeOptionalTextInput(enrichedContext?.department_name) ||
      normalizeOptionalTextInput(matchedPeopleContext.department_name) ||
      "",
    role_name:
      normalizeOptionalTextInput(enrichedContext?.role_name) ||
      normalizeOptionalTextInput(matchedPeopleContext.role_name) ||
      ""
  };
};

const resolveResponsiblePeopleId = async (responsibleId) => {
  const responsibleContext = await resolveResponsibleOwnerContext(responsibleId);
  return normalizeOptionalIntegerInput(responsibleContext?.people_id);
};

module.exports = {
  loadLegacyResponsibleIdentity,
  findPeopleContextForLegacyResponsible,
  loadFormResponsibleContext,
  resolveResponsibleOwnerContext,
  resolveResponsiblePeopleId,
};
