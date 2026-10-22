# Standardization execution plan

Baseline: main at 0cd354f. Work branch: dev-std-build. Five app-specific commits after validation, with the shared foundation in the FileSync commit; a sixth commit contains the catalog, license, Pages setup, and synthetic demos. The former combined commit is preserved on backup/dev-std-build-single-commit.

1. Preserve independent app roots; centralize pinned tools, packaging defaults, profiles, and Sandbox lifecycle.
2. Apply stable patch release metadata: FileSync 0.0.7, Binding 1.0.1, Hub 2.0.1, Peak 2.0.1, KM 1.0.1. Preserve application identities and scientific algorithms.
3. Commit npm/Python locks. Move yesterday's Hub resource/OCR fixes into source. Standardize portable data/config and bundled Python discovery. Remove runtime dependency installation.
4. Add repeatable app validation with self-contained fixtures. Retain frontend architecture differences. Prefer a folder ZIP while also exporting a single portable EXE.
5. Run all apps in a single disposable build Sandbox. Fix failures and rerun affected checks; finish with a complete batch using the final build tools.
6. Test deliverables in clean offline Sandboxes. Record exact artifact hashes, functional coverage, relocation/persistence results, screenshots, and remaining acceptance limits.
7. Review and stage all intended changes, run Git whitespace checks, and make the five app commits and separate repository documentation commit. Keep build artifacts and execution logs outside Git.

Desktop/App_build_standardization holds the copied plan, execution log, notes, test evidence, and artifacts. build-tools/README.md is the durable agent-facing rebuild manual.
