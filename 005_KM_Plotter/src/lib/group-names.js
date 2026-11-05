// Reference-style value/range names, qualified by variable to identify combinations.
const number = n => n === "" || n == null ? "…" : Number(Number(n).toPrecision(8)).toString();
export function groupName(column, mode, group) {
  const selection = mode === "ranges" ? `${number(group.lo)} to ${number(group.hi)}` : (group.values || []).join("+");
  return `${column}: ${selection || "Select values"}`;
}
export function autoName(column, mode, group) {
  return group.customName ? group : { ...group, name: groupName(column, mode, group) };
}
