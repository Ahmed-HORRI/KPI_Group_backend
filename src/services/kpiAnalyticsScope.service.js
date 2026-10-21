// Who sees whose KPIs in "My KPI Analytics" (Responsible KPI Dashboard).
//
// Every account sees its own KPIs. On top of that, by account role:
// - ceo, vp, admin: every responsible;
// - plant_manager: the responsibles working in their plant(s);
// - zone_manager: the responsibles working in the plants of their zone(s);
// - user: nobody else.
//
// A manager's plants / zones come from their active assignments in
// people_role_assignment ("Plant manager" -> its unit, "Zone managers" -> every
// unit of its zone), else from the unit they work at. A responsible is someone
// with KPI results (the set_by_people_id of the allocations the results were
// entered against); their unit is the one they work at (people.work_at_unit_id).

const { createHttpError } = require("../utils/httpError");

const ANALYTICS_LEVELS = { admin: "all", ceo: "all", vp: "all", plant_manager: "plant", zone_manager: "zone" };

const getAnalyticsLevel = (role) => ANALYTICS_LEVELS[role] || "own";

const ACTIVE_ASSIGNMENT = `
  UPPER(pra.assignment_status) = 'ACTIVE'
  AND (pra.start_date IS NULL OR pra.start_date <= CURRENT_DATE)
  AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
`;

const toIds = (rows) => rows.map((row) => Number(row.unit_id)).filter(Number.isInteger);

const parsePositiveId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const createKpiAnalyticsScope = ({ db }) => {
  // Units a manager oversees: null means every unit, [] none.
  const loadScopeUnitIds = async (level, peopleId) => {
    if (level === "all") return null;
    if (level === "own" || !peopleId) return [];

    const assigned =
      level === "plant"
        ? await db.query(
            `
            SELECT DISTINCT pra.unit_id
            FROM public.people_role_assignment pra
            JOIN public.role r ON r.role_id = pra.role_id
            WHERE pra.people_id = $1 AND r.role_name ILIKE 'plant manager%' AND pra.unit_id IS NOT NULL
              AND ${ACTIVE_ASSIGNMENT}
            `,
            [peopleId]
          )
        : await db.query(
            `
            SELECT DISTINCT u.unit_id
            FROM public.people_role_assignment pra
            JOIN public.role r ON r.role_id = pra.role_id
            JOIN public.unit u ON u.zone_id = pra.zone_id
            WHERE pra.people_id = $1 AND r.role_name ILIKE 'zone manager%'
              AND ${ACTIVE_ASSIGNMENT}
            `,
            [peopleId]
          );
    if (assigned.rows.length) return toIds(assigned.rows);

    // No such assignment: the unit they work at -- for a zone manager, every
    // unit of that unit's zone.
    const workUnit = await db.query(
      `
      SELECT wu.unit_id, wu.zone_id
      FROM public.people p
      JOIN public.unit wu ON wu.unit_id = p.work_at_unit_id
      WHERE p.people_id = $1
      `,
      [peopleId]
    );
    const home = workUnit.rows[0];
    if (!home) return [];
    if (level === "plant" || home.zone_id === null) return [Number(home.unit_id)];
    const zoneUnits = await db.query(`SELECT unit_id FROM public.unit WHERE zone_id = $1`, [home.zone_id]);
    return toIds(zoneUnits.rows);
  };

  // Responsibles with KPI results, with the unit they work at.
  const loadResponsibles = async () => {
    const result = await db.query(`
      SELECT p.people_id, p.first_name, p.name, wu.unit_id, wu.unit_name
      FROM public.people p
      LEFT JOIN public.unit wu ON wu.unit_id = p.work_at_unit_id
      WHERE p.people_id IN (
        SELECT kta.set_by_people_id
        FROM public.kpi_result kr
        JOIN public.kpi_target_allocation kta ON kta.kpi_target_allocation_id = kr.kpi_target_allocation_id
        WHERE kr.raw_value IS NOT NULL
      )
      ORDER BY wu.unit_name, p.name, p.first_name
    `);
    return result.rows.map((row) => ({
      people_id: Number(row.people_id),
      full_name: [row.first_name, row.name].filter(Boolean).join(" ").trim() || `Person ${row.people_id}`,
      unit_id: row.unit_id === null ? null : Number(row.unit_id),
      unit_name: row.unit_name || ""
    }));
  };

  const loadScope = async (viewer) => {
    const level = getAnalyticsLevel(viewer?.role);
    const unitIds = await loadScopeUnitIds(level, viewer?.people_id);
    const inScope = (responsible) => unitIds === null || unitIds.includes(responsible.unit_id);
    return { level, unitIds, inScope };
  };

  // What the viewer can filter on.
  const getFilters = async (viewer) => {
    const { level, unitIds, inScope } = await loadScope(viewer);
    if (level === "own") return { level, scope_units: [], units: [], responsibles: [] };

    const responsibles = (await loadResponsibles()).filter(inScope);
    const units = [];
    for (const responsible of responsibles) {
      if (responsible.unit_id !== null && !units.some((unit) => unit.unit_id === responsible.unit_id)) {
        units.push({ unit_id: responsible.unit_id, unit_name: responsible.unit_name });
      }
    }
    units.sort((a, b) => a.unit_name.localeCompare(b.unit_name));

    // Names of the plants a manager oversees, even those without results yet.
    let scopeUnits = [];
    if (unitIds !== null && unitIds.length) {
      const named = await db.query(`SELECT unit_id, unit_name FROM public.unit ORDER BY unit_name`);
      scopeUnits = named.rows
        .filter((row) => unitIds.includes(Number(row.unit_id)))
        .map((row) => ({ unit_id: Number(row.unit_id), unit_name: row.unit_name }));
    }
    return { level, scope_units: scopeUnits, units, responsibles };
  };

  // The people whose KPI series the viewer asked for, once checked against
  // their scope. ownerId is the dashboard's person ("my KPIs", the default).
  const resolveSelection = async (viewer, { ownerId, responsible, unitId }) => {
    const wanted = String(responsible ?? "").trim().toLowerCase();
    if (!wanted || wanted === "me" || wanted === String(ownerId)) return [ownerId];

    const { level, unitIds, inScope } = await loadScope(viewer);
    if (level === "own") throw createHttpError(403, "You can only see your own KPI analytics.");

    let unit = null;
    if (unitId !== undefined && String(unitId).trim() !== "") {
      unit = parsePositiveId(unitId);
      if (unit === null) throw createHttpError(400, "Invalid unit.");
      if (unitIds !== null && !unitIds.includes(unit)) throw createHttpError(403, "This unit is outside your scope.");
    }
    const candidates = (await loadResponsibles()).filter(
      (candidate) => inScope(candidate) && (unit === null || candidate.unit_id === unit)
    );

    if (wanted === "all") return candidates.map((candidate) => candidate.people_id);

    const peopleId = parsePositiveId(wanted);
    if (peopleId === null) throw createHttpError(400, "Invalid responsible.");
    if (!candidates.some((candidate) => candidate.people_id === peopleId)) {
      throw createHttpError(403, "This responsible is outside your scope.");
    }
    return [peopleId];
  };

  return { getFilters, resolveSelection };
};

module.exports = { ANALYTICS_LEVELS, getAnalyticsLevel, createKpiAnalyticsScope };
