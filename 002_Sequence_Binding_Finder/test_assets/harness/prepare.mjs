import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(directory, "corpus.json"), "utf8"));
for (const [name, rows] of [["reference_phage_database.xlsx", corpus.references], ["test_query_assemblies.xlsx", corpus.queries]]) {
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Source / provenance", "Sequence"], ...rows]), "Sequences"); XLSX.writeFile(wb, file); }
}
