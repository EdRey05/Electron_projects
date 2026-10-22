// Keep Electron ports wired when importing the upstream Python catalog.
const entries = {
  'ligation_layout_app.py': 'LigationLayout.jsx',
  'ColonyPCR_layout_app.py': 'ColonyPCRLayout.jsx',
  'primer_finder_app.py': 'PrimerFinder.jsx',
  'Sequencing_reference_files_app.py': 'SequencingReferenceFiles.jsx',
  'sequencing_order_form_app.py': 'SequencingOrderForm.jsx',
  'sequencing_file_organizer_app.py': 'SequencingFileOrganizer.jsx',
};
function normalize(registry) {
  return registry.split(/(?=^\[)/m).map(section => {
    const entry = section.match(/^entry\s*=\s*([^\r\n]+)/m);
    const route = entry && entries[entry[1].trim()];
    if (!route) return section;
    return section.replace(/^category\s*=[^\r\n]*/m, 'category = react_route')
      .replace(/^entry\s*=[^\r\n]*/m, `entry = ${route}`);
  }).join('');
}
module.exports = { normalize };
