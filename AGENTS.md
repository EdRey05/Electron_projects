# Build and release workflow

Read build-tools/README.md before changing packaging, runtimes, versions, or release commands.

For a request to build portable Windows applications, use build-tools/Build-Apps.ps1 with the requested app IDs. Omitting -Apps builds all registered apps in one disposable Windows Sandbox. Do not install npm, Node, Python, uv, or app dependencies on the host to perform release builds. Source is mapped read-only; actual dependency installation and compilation occur inside the guest. Export artifacts outside this repository, normally Desktop/App_builds.

Use build-tools/Test-Apps.ps1 -BuildOutput <run/output> for clean offline checks of both the portable EXE and folder ZIP. It stops each owned test Sandbox. Build success alone does not establish runtime success. Report artifact hashes, test evidence, and remaining product-acceptance limits accurately.

Every app keeps its own dependency locks and declares its resources explicitly. Reuse shared toolchain/configuration and caches; do not combine incompatible Python packages or share mutable node_modules between apps. Add new apps through build-tools/apps.json and follow the onboarding checklist in the manual.

Keep package.json, package-lock.json root metadata, and release versions consistent. Update dependency locks deliberately, never during a release build. Keep packaged settings in portable data paths and resolve bundled Python explicitly. Do not add runtime package installation or system-Python fallbacks.
