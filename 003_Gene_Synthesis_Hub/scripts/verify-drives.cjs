const assert=require('node:assert/strict'),{parseDriveInventory}=require('../electron/drives.cjs');
assert.deepEqual(parseDriveInventory('\uFEFF'+JSON.stringify([{DeviceID:'x:',VolumeName:'B8. Gene Synthesis'},{DeviceID:'Y:',VolumeName:'B6. DNA Sequencing'},{DeviceID:'C:',VolumeName:'Windows'},{DeviceID:'Z:',VolumeName:'Public'}])),{'B8. Gene Synthesis':'X:','B6. DNA Sequencing':'Y:',Public:'Z:'});
assert.deepEqual(parseDriveInventory('{"DeviceID":"x:","VolumeName":"Public"}'),{Public:'X:'});
assert.deepEqual(parseDriveInventory('[{"DeviceID":"X:","VolumeName":"Public"},{"DeviceID":"Y:","VolumeName":"Public"}]'),{});
assert.deepEqual(parseDriveInventory('null'),{});assert.deepEqual(parseDriveInventory(''),{});
assert.deepEqual(parseDriveInventory('[{"DeviceID":"C:/unsafe","VolumeName":"Public"}]'),{});
console.log('Locale-independent drive inventory: JSON, single/multiple/empty results, valid drive letters and ambiguous labels passed.');
