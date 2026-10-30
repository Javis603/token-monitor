# App-distributed catalog

This directory is the offline official catalog. It intentionally contains no
production plugin packages while the platform is experimental. Official
attribution comes from inclusion in the App, not a publisher-supplied flag.

Use numeric `.tmplugin` filename prefixes to set the official display order within
Featured plugins. A manifest `homepage` pointing to a GitHub repository supplies
its README details. This does not load images until details open.

Future curated `.tmplugin` files use the same package parser, disabled install,
revision trust, origin pinning and transactional updates as imported packages.
Tests supply synthetic packages in a temporary catalog directory; fixtures must
not be copied here or shipped as showcase plugins.
