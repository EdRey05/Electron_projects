module.exports = {
  asar: true,
  compression: 'normal',
  directories: { output: 'release', buildResources: 'assets' },
  win: { target: [{ target: 'portable', arch: ['x64'] }] },
  portable: { artifactName: '${name}-${version}-win-${arch}-portable.${ext}' },
  nsis: { artifactName: '${name}-${version}-win-${arch}-setup.${ext}', oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
};
