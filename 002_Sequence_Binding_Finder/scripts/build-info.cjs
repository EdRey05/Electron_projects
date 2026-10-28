require('node:fs').writeFileSync(require('node:path').join(__dirname,'../electron/build-info.json'),JSON.stringify({date:new Date().toISOString().slice(0,10)}));
