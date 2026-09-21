---
summary: "OpenCode provider notes: profile ownership, API/Web/local quota authority, ambient credentials and session detail."
read_when:
  - Changing OpenCode profiles, credential moves/merges or ambient auth discovery
  - Changing OpenCode Go API, Web cookie or local usage fallback precedence
  - Changing OpenCode session metadata/detail or cross-device aggregation
---

# OpenCode

OpenCode limits can combine a Go API key, a Web cookie and local auth/usage. The provider treats them as components of named accounts rather than one global credential bag.

## Profiles and credential ownership

Each stored credential belongs to at most one profile. Move, rename, merge and remove operations are immutable transforms and refuse collisions that would overwrite another credential. Disabling a profile does not free its credentials for another account.

The auto-detected API key is represented by a pinned reference, not copied blindly into every profile. A bound reference stops resolving when the machine key changes. An unclaimed ambient key may appear as its own account; binding it into a profile stops the duplicate observation. A configured profile always outranks ambient association.

Profile names are user labels, not stable account identity. API keys and Web responses provide canonical identity where possible, and aggregation keeps aliases bounded when older observations used legacy labels.

## Source authority

Within an explicitly associated account, source order is API, then Web, then local. Each component remains authoritative only for the windows it actually answers. Supplemental windows must be dropped when the API or local source already answered the same kind; merge order must not duplicate quota.

An expired explicit cookie or stale explicit key surfaces its error instead of disappearing into an unrelated ambient/local success. A missing Go subscription is not an authorization failure and may fall through quietly. Cancellation discards the scoped result rather than publishing an error row or papering it over with local estimates.

Do not label a merged row `Web` when any local-only window remains in it. Source presentation follows the components that survived aggregation.

## Sessions

Session metadata and detail read OpenCode's local storage on demand. Keep profile/limits identity out of session attribution: local token sessions are not proof of the billing account selected by a credential profile.

## Transport

Every Web probe must receive the runtime-injected transport. Do not bypass proxy and Electron behavior by constructing provider-local fetch implicitly.
