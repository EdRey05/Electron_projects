// Keep Electron ports wired when importing the upstream Python catalog.
const entries = {
  'QC_file_prep_app.py': 'QCFilePrep.jsx',
  'QC_digestion_design_app.py': 'QCDesign.jsx',
  'batch_qc_report_app.py': 'BatchQCReport.jsx',
  'label_generator_app.py': 'LabelGenerator.jsx',
  'integra_worklist_app.py': 'IntegraWorklist.jsx',
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
    if(route==='QCFilePrep.jsx'){
      const extras='QC_Gel_Images:gel_images_path; Shipment_and_QC_Log:shipment_qc_log_path; Sorted_Sequencing_Files:sorted_sequencing_files_path';
      if(!section.includes('gel_images_path'))section=section.replace(/^(pass_dir_as_kwarg\s*=[^\r\n]*)/m,`$1; ${extras}`);
    }
    return section.replace(/^category\s*=[^\r\n]*/m, 'category = react_route')
      .replace(/^entry\s*=[^\r\n]*/m, `entry = ${route}`);
  }).join('').replace(/[ \t]+$/gm,'');
}
module.exports = { normalize };
