# Optional offline catalog

This directory supports optional App-distributed offline `.tmplugin` packages. No production plugin is bundled here. Official source stays in the repository’s `plugins/` directory and is published to `dist`; `officialSources.js` selects the remote catalog. Tests use their own fixture directories.

Offline packages are listed in filename order. Installation identity comes from the manifest and source, independently of the archive filename.
