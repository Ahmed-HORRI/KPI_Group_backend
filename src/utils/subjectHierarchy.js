// Match the KPI Group picker: inactive subjects and their branches are hidden.
function filterActiveSubjectTree(nodes = []) {
  return nodes
    .filter((node) => String(node.status || "").trim().toLowerCase() === "active")
    .map((node) => ({
      ...node,
      children: filterActiveSubjectTree(node.children || []),
    }));
}

module.exports = { filterActiveSubjectTree };
