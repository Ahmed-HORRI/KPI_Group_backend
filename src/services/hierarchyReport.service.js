const { pool } = require("../config/db");
const { normalizeOptionalTextInput, normalizeOptionalIntegerInput } = require("../utils/normalize");
const {
  getPreviousWeek,
  runHierarchyKpiReports,
  getCurrentWeek,
  generateWeeklyReportEmail,
} = require("./ceoReportGeneration.service");
const { getPeopleDisplayName } = require("../models/kpi.model");

let managerCronRunning = false;

async function getPeopleHierarchy(peopleId) {
  const result = await pool.query(
    `
    WITH RECURSIVE hierarchy AS (
      SELECT
        seed.assignment_id,
        seed.people_id,
        seed.first_name,
        seed.name,
        seed.email,
        seed.role_id,
        seed.role_name,
        seed.parent_role_id,
        seed.unit_id,
        seed.zone_id,
        seed.market_id,
        0 AS level,
        ARRAY[seed.people_id::bigint] AS people_path
      FROM (
        SELECT
          pra.assignment_id,
          p.people_id,
          p.first_name,
          p.name,
          p.email,
          pra.role_id,
          role.role_name,
          role.parent_role_id,
          pra.unit_id,
          pra.zone_id,
          pra.market_id
        FROM public.people_role_assignment pra
        JOIN public.role role
          ON role.role_id = pra.role_id
        JOIN public.people p
          ON p.people_id = pra.people_id
        WHERE pra.people_id = $1
          AND COALESCE(pra.assignment_status, 'ACTIVE') = 'ACTIVE'
          AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
        ORDER BY
          COALESCE(pra.is_primary, false) DESC,
          pra.allocation_percentage DESC NULLS LAST,
          pra.start_date DESC NULLS LAST,
          pra.assignment_id DESC
        LIMIT 1
      ) seed

      UNION ALL

      SELECT
        manager_assignment.assignment_id,
        manager.people_id,
        manager.first_name,
        manager.name,
        manager.email,
        manager_assignment.role_id,
        manager_role.role_name,
        manager_role.parent_role_id,
        manager_assignment.unit_id,
        manager_assignment.zone_id,
        manager_assignment.market_id,
        h.level + 1,
        h.people_path || manager.people_id::bigint
      FROM hierarchy h
      JOIN LATERAL (
        SELECT pra.*
        FROM public.people_role_assignment pra
        WHERE pra.role_id = h.parent_role_id
          AND COALESCE(pra.assignment_status, 'ACTIVE') = 'ACTIVE'
          AND (pra.end_date IS NULL OR pra.end_date >= CURRENT_DATE)
          AND NOT (pra.people_id = ANY(h.people_path))
        ORDER BY
          CASE
            WHEN h.zone_id IS NOT NULL AND pra.zone_id = h.zone_id THEN 0
            WHEN h.zone_id IS NOT NULL AND pra.zone_id IS NULL THEN 1
            ELSE 2
          END,
          CASE
            WHEN h.unit_id IS NOT NULL AND pra.unit_id = h.unit_id THEN 0
            WHEN h.unit_id IS NOT NULL AND pra.unit_id IS NULL THEN 1
            ELSE 2
          END,
          CASE
            WHEN h.market_id IS NOT NULL AND pra.market_id = h.market_id THEN 0
            WHEN h.market_id IS NOT NULL AND pra.market_id IS NULL THEN 1
            ELSE 2
          END,
          CASE WHEN COALESCE(pra.is_primary, false) THEN 0 ELSE 1 END,
          pra.allocation_percentage DESC NULLS LAST,
          pra.start_date DESC NULLS LAST,
          pra.assignment_id DESC
        LIMIT 1
      ) manager_assignment ON TRUE
      JOIN public.role manager_role
        ON manager_role.role_id = manager_assignment.role_id
      JOIN public.people manager
        ON manager.people_id = manager_assignment.people_id
      WHERE h.level < 20
        AND h.parent_role_id IS NOT NULL
    )
    SELECT *
    FROM hierarchy
    ORDER BY level ASC
    `,
    [peopleId]
  );

  return result.rows;
}
async function sendKPIReportToHierarchy(responsiblePeopleId, currentWeek) {
  const hierarchy = await getPeopleHierarchy(responsiblePeopleId);

  if (!hierarchy.length) {
    return {
      responsiblePeopleId: normalizeOptionalIntegerInput(responsiblePeopleId),
      responsibleName: "",
      managerResults: [],
      skippedReason: "No active hierarchy assignment found"
    };
  }

  const responsible = hierarchy[0];
  const managers = hierarchy.slice(1, 2).filter(manager => manager.email); // direct boss only
  const responsibleName =
    getPeopleDisplayName(responsible) || String(responsible.people_id || responsiblePeopleId);
  const managerResults = [];

  if (!managers.length) {
    return {
      responsiblePeopleId: normalizeOptionalIntegerInput(responsiblePeopleId),
      responsibleName,
      managerResults,
      skippedReason: "No managers with email found in the role hierarchy"
    };
  }

  for (const manager of managers) {
    const managerName =
      getPeopleDisplayName(manager) || `${manager.first_name || ""} ${manager.name || ""}`.trim();
    try {
      await generateWeeklyReportEmail(
        responsiblePeopleId,
        currentWeek,
        {
          recipientEmail: manager.email,
          recipientPeopleId: manager.people_id,
          recipientName: managerName,
          recipientRoleName: normalizeOptionalTextInput(manager.role_name) || "Manager"
        }
      );

      console.log(
        `[Hierarchy Report] Report for ${responsibleName} sent to ${manager.email}${manager.role_name ? ` (${manager.role_name})` : ""}`
      );

      managerResults.push({
        peopleId: normalizeOptionalIntegerInput(manager.people_id),
        name: managerName,
        email: manager.email,
        roleName: normalizeOptionalTextInput(manager.role_name) || "",
        status: "sent"
      });
    } catch (error) {
      console.error(
        `[Hierarchy Report] Failed for ${responsibleName} -> ${manager.email}:`,
        error.message
      );
      managerResults.push({
        peopleId: normalizeOptionalIntegerInput(manager.people_id),
        name: managerName,
        email: manager.email,
        roleName: normalizeOptionalTextInput(manager.role_name) || "",
        status: "failed",
        error: error.message
      });
    }

    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  return {
    responsiblePeopleId: normalizeOptionalIntegerInput(responsiblePeopleId),
    responsibleName,
    managerResults
  };
}

const triggerHierarchyReportNow = async (req, res) => {
  if (managerCronRunning) {
    return res.status(409).json({ error: "Hierarchy report job is already running." });
  }

  const frequency = normalizeOptionalTextInput(req.body?.frequency ?? req.query?.frequency) || "Weekly";
  const reportWeek =
    normalizeOptionalTextInput(req.body?.week ?? req.query?.week) ||
    getPreviousWeek(getCurrentWeek());
  const responsiblePeopleId = normalizeOptionalIntegerInput(
    req.body?.responsible_people_id ??
    req.body?.responsibleId ??
    req.query?.responsible_people_id ??
    req.query?.responsibleId
  );

  managerCronRunning = true;

  try {
    const result = await runHierarchyKpiReports(frequency, {
      reportWeek,
      responsiblePeopleId
    });

    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error("[Hierarchy Report] Manual trigger error:", error.message);
    return res.status(500).json({ error: error.message || "Failed to trigger hierarchy report." });
  } finally {
    managerCronRunning = false;
  }
};


module.exports = { getPeopleHierarchy, sendKPIReportToHierarchy, triggerHierarchyReportNow };
