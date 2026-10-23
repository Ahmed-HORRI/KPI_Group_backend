// Columns of the KPI & Target Intake page (/kpi-intake): one entry per column
// of public.kpi / public.kpi_target_allocation a responsible fills in. The page
// draws its grids from this list (GET /api/kpi-intake/lookups) and the server
// checks every saved line against it, so both always agree.
//
// type:
//   text / longtext  free text (maxLength = size of the database column)
//   number           decimal number ("12,5" is accepted)
//   tolerance        number or percentage ("5" or "5%")
//   date             YYYY-MM-DD (DD/MM/YYYY is accepted)
//   enum             one of `options`, stored in that exact spelling
//   ref              a name looked up in a reference list (kpiIntakeResolver.service.js)
// requiredWhen: required only when another column has one of these values;
//   with exclusive: true, the column is also left empty otherwise (as the KPI
//   admin form does: a min value only goes with min type "Value").
// suggestions: usual values of a free-text column, proposed by the page.
//
// Never entered: the ids (IDENTITY GENERATED ALWAYS), created_at / updated_at,
// is_active (true), created_by_people_id (the "Submitted by" person), the KPI
// knowledge base and the attached file. The same columns are the ones a
// signed-in user can change on a row already in the database.

const option = (value, label = value) => ({ value, label });

const KPI_COLUMNS = [
  { key: "kpi_name", label: "KPI name", type: "text", required: true, maxLength: 255 },
  { key: "kpi_sub_title", label: "Sub-title", type: "text", maxLength: 255 },
  { key: "subject", label: "Subject", type: "ref", ref: "subject", required: true },
  { key: "kpi_code", label: "KPI code", type: "text", maxLength: 100 },
  { key: "kpi_explanation", label: "Definition", type: "longtext", required: true, maxLength: 5000 },
  { key: "kpi_formula", label: "Formula", type: "longtext", maxLength: 5000 },
  {
    key: "unit",
    label: "Unit",
    type: "text",
    required: true,
    maxLength: 50,
    suggestions: ["kCur", "%", "EA", "PPM", "Number", "Days", "Ratio"]
  },
  {
    key: "frequency",
    label: "Frequency",
    type: "enum",
    required: true,
    options: [
      option("Daily"),
      option("Weekly"),
      option("By Weekly", "BI Weekly"),
      option("Monthly"),
      option("By Monthly", "BI Monthly"),
      option("Yearly"),
      option("By Yearly", "BI Yearly")
    ]
  },
  { key: "target_value", label: "Target", type: "number" },
  { key: "target_direction", label: "Direction", type: "enum", required: true, options: [option("Up"), option("Down")] },
  {
    key: "target_auto_adjustment",
    label: "Target auto adjustment",
    type: "enum",
    required: true,
    options: [option("Yes"), option("No")]
  },
  {
    key: "min_type",
    label: "Min type",
    type: "enum",
    required: true,
    defaultValue: "Null",
    options: [option("Null"), option("0"), option("Valeur a entrer", "Value")]
  },
  {
    key: "min_value",
    label: "Min value",
    type: "number",
    requiredWhen: { key: "min_type", values: ["Valeur a entrer"] },
    exclusive: true
  },
  {
    key: "max_type",
    label: "Max type",
    type: "enum",
    required: true,
    defaultValue: "Null",
    options: [option("Null"), option("0"), option("Valeur a entrer", "Value")]
  },
  {
    key: "max_value",
    label: "Max value",
    type: "number",
    requiredWhen: { key: "max_type", values: ["Valeur a entrer"] },
    exclusive: true
  },
  {
    key: "tolerance_type",
    label: "Tolerance type",
    type: "enum",
    required: true,
    options: [option("Absolute"), option("Relative")]
  },
  { key: "low_limit", label: "Low limit", type: "number", requiredWhen: { key: "tolerance_type", values: ["Absolute"] } },
  { key: "high_limit", label: "High limit", type: "number", requiredWhen: { key: "tolerance_type", values: ["Absolute"] } },
  {
    key: "low_tolerance",
    label: "Low tolerance",
    type: "tolerance",
    maxLength: 255,
    requiredWhen: { key: "tolerance_type", values: ["Relative"] }
  },
  {
    key: "up_tolerance",
    label: "Up tolerance",
    type: "tolerance",
    maxLength: 255,
    requiredWhen: { key: "tolerance_type", values: ["Relative"] }
  },
  {
    key: "calculation_on",
    label: "Calculation on",
    type: "enum",
    required: true,
    options: [option("Value"), option("Average")]
  },
  {
    key: "nombre_periode",
    label: "Number of periods",
    type: "text",
    maxLength: 255,
    suggestions: ["1 period", "1 week", "4 weeks"],
    requiredWhen: { key: "calculation_on", values: ["Average"] },
    exclusive: true
  },
  {
    key: "calculation_mode",
    label: "Calculation mode",
    type: "enum",
    required: true,
    options: [option("Direct"), option("Ratio")]
  },
  {
    key: "reference_kpi_id",
    label: "Reference KPI",
    type: "ref",
    ref: "kpi",
    requiredWhen: { key: "calculation_mode", values: ["Ratio"] },
    exclusive: true
  },
  { key: "display_trend", label: "Display trend", type: "enum", required: true, options: [option("No"), option("Yes")] },
  {
    key: "regression",
    label: "Regression",
    type: "enum",
    options: [option("1 week"), option("2 weeks"), option("3 weeks"), option("4 weeks")],
    requiredWhen: { key: "display_trend", values: ["Yes"] }
  },
  { key: "kfs", label: "KPI / KFS", type: "enum", required: true, defaultValue: "KPI", options: [option("KPI"), option("KFS")] },
  {
    key: "reactivity_status",
    label: "Reactivity status",
    type: "enum",
    options: [option("Anticipated"), option("Reactive")]
  },
  { key: "importance", label: "Importance", type: "enum", options: [option("High"), option("Medium"), option("Low")] },
  {
    key: "reactivity_need",
    label: "Reactivity need",
    type: "enum",
    options: [option("Urgent"), option("Not Urgent")]
  },
  { key: "pricing_type", label: "Pricing type", type: "enum", options: [option("Operational"), option("Selling")] },
  {
    key: "currency_type",
    label: "Currency",
    type: "text",
    maxLength: 20,
    suggestions: ["EUR", "USD", "CNY", "INR", "KRW"]
  },
  {
    key: "type",
    label: "KPI type",
    type: "enum",
    options: [option("Manual"), option("Standard KPI"), option("calculated", "Calculated")]
  },
  { key: "owner_role_id", label: "Owner role", type: "ref", ref: "role" },
  {
    key: "status",
    label: "Status",
    type: "enum",
    required: true,
    defaultValue: "Active",
    options: [option("Active"), option("Inactive"), option("Draft Governance Proposal"), option("To Validate")]
  },
  { key: "comments", label: "Comments", type: "longtext", maxLength: 5000 }
];

const ALLOCATION_COLUMNS = [
  { key: "kpi_id", label: "KPI", type: "ref", ref: "kpi", allowIntake: true, required: true },
  {
    key: "kpi_type",
    label: "Allocation type",
    type: "enum",
    options: [option("Multisite"), option("Role"), option("Zone"), option("Individual"), option("Product Line")]
  },
  { key: "plant_id", label: "Plant", type: "ref", ref: "plant" },
  { key: "zone_id", label: "Zone", type: "ref", ref: "zone" },
  { key: "unit_id", label: "Unit", type: "ref", ref: "unit" },
  { key: "unit_type_id", label: "Unit type", type: "ref", ref: "unit_type" },
  {
    key: "role_id",
    label: "Role",
    type: "ref",
    ref: "role",
    requiredWhen: { key: "kpi_type", values: ["Individual"] }
  },
  { key: "function", label: "Function", type: "text", maxLength: 100 },
  { key: "product_line_id", label: "Product line", type: "ref", ref: "product_line" },
  { key: "product_id", label: "Product", type: "ref", ref: "product" },
  { key: "market_id", label: "Market", type: "ref", ref: "market" },
  { key: "customer_id", label: "Customer", type: "ref", ref: "customer" },
  { key: "target_value", label: "Target", type: "number", required: true },
  {
    key: "target_unit",
    label: "Target unit",
    type: "text",
    maxLength: 50,
    suggestions: ["kCur", "%", "Number", "PPM"]
  },
  {
    key: "local_currency",
    label: "Local currency",
    type: "text",
    maxLength: 50,
    suggestions: ["EUR", "CNY", "USD", "KRW", "INR"]
  },
  { key: "low_limit", label: "Low limit", type: "number" },
  { key: "high_limit", label: "High limit", type: "number" },
  { key: "last_best_target", label: "Last best target", type: "number" },
  { key: "previous_target_value", label: "Previous target", type: "number" },
  { key: "target_setup_date", label: "Setup date", type: "date" },
  { key: "target_start_date", label: "Start date", type: "date" },
  { key: "target_end_date", label: "End date", type: "date" },
  {
    key: "target_status",
    label: "Target status",
    type: "enum",
    defaultValue: "Draft",
    options: [option("Draft"), option("Active"), option("Inactive"), option("Approved")]
  },
  { key: "set_by_people_id", label: "Set by", type: "ref", ref: "people" },
  { key: "approved_by_people_id", label: "Approved by", type: "ref", ref: "people" },
  { key: "comments", label: "Comments", type: "longtext", maxLength: 5000 }
];

const INTAKE_COLUMNS = Object.freeze({
  kpi: KPI_COLUMNS,
  target_allocation: ALLOCATION_COLUMNS
});

const INTAKE_ENTITY_TYPES = Object.freeze(Object.keys(INTAKE_COLUMNS));

// Shown, read only, next to the rows already in the database (signed-in users
// change those rows on the page): set by the application, never entered.
const INFO_COLUMNS = [
  { key: "is_active", label: "Active" },
  { key: "created_by", label: "Created by" },
  { key: "created_at", label: "Created", type: "datetime" },
  { key: "updated_at", label: "Updated", type: "datetime" }
];

const RECORD_INFO_COLUMNS = Object.freeze({ kpi: INFO_COLUMNS, target_allocation: INFO_COLUMNS });

module.exports = { INTAKE_COLUMNS, INTAKE_ENTITY_TYPES, RECORD_INFO_COLUMNS };
