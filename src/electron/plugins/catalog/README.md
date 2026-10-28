# App-distributed catalog

This directory is the offline official catalog. It intentionally contains no
production plugin packages while the platform is experimental. Official
attribution comes from inclusion in the App, not a publisher-supplied flag.

Future curated `.tmplugin` files use the same package parser, disabled install,
revision trust, origin pinning and transactional updates as imported packages.
Tests supply synthetic packages in a temporary catalog directory; fixtures must
not be copied here or shipped as showcase plugins.
