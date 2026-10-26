# Known issues

These issues were reproduced during the two-agent review. Lifecycle problems from
that review were fixed in v0.1.75; the remaining work concerns UI navigation.

## Reordering cards loses keyboard focus

Status: not yet recreated as a public issue.

Focus a live agent card, then update the forest so its keyed node moves to another
position. Moving the subtree with `insertBefore()` can leave focus on the document
body. Preserve focus across moves and add a browser regression for changed order.

## Historical search results remain collapsed

Status: not yet recreated as a public issue.

Search for a task that exists only in completed or inactive history. Its matching
card remains inside collapsed history while the prominent empty state suggests
trying another search. Reveal matching historical results during search and show
their result count.

## Packaging dependency audit

Status: not yet recreated as a public issue.

The baseline lockfile's development-only `@vscode/vsce` dependency chain reports
two high-severity audit findings in `@azure/identity` and `@azure/msal-node`.
Compatible automatic updates were evaluated in a temporary checkout but did not
produce a clean dependency audit. Follow up on an upstream-compatible resolution
and rerun clean installation, tests, browser checks, and packaging. The extension
has no runtime npm dependencies.
