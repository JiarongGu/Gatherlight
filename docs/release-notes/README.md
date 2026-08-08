# Release notes

`next.md` is the **hand-written** summary of the release that hasn't been cut yet. Write it as you
go, in the household's language — what changed for the person using Gatherlight, not what changed in
the code.

`release.yml` puts it at the top of the GitHub release body and files the generated commit log
underneath, collapsed. Without it the body is the commit log alone, which reads like a dev log: the
platform/container track alone would have led with 53 flat bullets such as "the node model, fourteen
component schemas and the tree validator" — all true, none of it meaningful to someone deciding
whether to update.

On a successful release the workflow renames `next.md` to `<version>.md` in the version-bump commit
and pushes it. That rename is load-bearing: a `next.md` left in place is republished verbatim on the
*following* release, which would ship a confident description of the wrong version. Start the next
one by creating a fresh `next.md`.

Archived files stay here as the changelog.
