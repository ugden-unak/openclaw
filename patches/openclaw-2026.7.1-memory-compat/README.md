# OpenClaw 2026.7.1 memory compatibility artifact

This backport applies the accepted Memory Core configuration refresh repair to
the exact published 2026.7.1 package. A loaded memory tool observes an explicit
effective `memorySearch` disable before its backing operation. Enabled agent
overrides, configuration refresh, captured/static fallback, removal defaults and
re-enable behavior remain intact. The wrapper patch changes two functions and
adds no imports or exports.

`manifest.json` binds the original archive, both patches and the three resulting
files. The archive retains all 8,550 regular files and their modes; 8,547 files
are unchanged. Its original build commit remains
`2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`. The containing fork commit identifies
the backport recipe and patches, not a full fork build. The package version is
unchanged; identify the modified artifact by its digest.

The dependency patch preserves the recorded compatibility baseline, including
`brace-expansion@5.0.9` and `ip-address@10.5.0`, and changes `tar` to `7.5.21`,
`undici` to `8.9.0` and `fast-uri` to `3.1.6`. The manifest records every baseline
difference from the published shrinkwrap. These are explicit baseline choices,
not instructions to replace another installation's existing dependency graph.

## Reproduce the artifact

Run from this repository root, with GNU tar, curl, git, Node and `sha256sum`
available. This creates a disposable archive workspace and calls the existing
artifact checker. It does not install or start OpenClaw.

```bash
(
set -euo pipefail
umask 022
BACKPORT_REPO="$PWD"
BACKPORT_PATCHES="$BACKPORT_REPO/patches/openclaw-2026.7.1-memory-compat"
BACKPORT_WORK="$(mktemp -d /tmp/openclaw-memory-compat.XXXXXX)"
mkdir "$BACKPORT_WORK/source" "$BACKPORT_WORK/artifact"
curl --fail --location --proto '=https' \
  https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz \
  --output "$BACKPORT_WORK/original.tgz"
echo "67ad539d9915efb63d5f294beeb9290b7172d23c92d8052110a9c8355f783458  $BACKPORT_WORK/original.tgz" | sha256sum --check
tar -xzf "$BACKPORT_WORK/original.tgz" -C "$BACKPORT_WORK/source"
git -C "$BACKPORT_WORK/source/package" apply --unidiff-zero --check \
  "$BACKPORT_PATCHES/memory-tools.patch" "$BACKPORT_PATCHES/dependencies.patch"
git -C "$BACKPORT_WORK/source/package" apply --unidiff-zero \
  "$BACKPORT_PATCHES/memory-tools.patch" "$BACKPORT_PATCHES/dependencies.patch"
chmod 0644 "$BACKPORT_WORK/source/package/dist/tools-C2Zf2j2W.js" \
  "$BACKPORT_WORK/source/package/package.json" \
  "$BACKPORT_WORK/source/package/npm-shrinkwrap.json"
tar --sort=name --format=gnu --mtime=2026-07-01T00:00:00Z \
  --owner=0 --group=0 --numeric-owner \
  -czf "$BACKPORT_WORK/artifact/openclaw-2026.7.1.tgz" \
  -C "$BACKPORT_WORK/source" package
echo "be5732f27cf79d70f662a048fea707df516365c04a8df16e3d1c0e8eb96c4cbf  $BACKPORT_WORK/artifact/openclaw-2026.7.1.tgz" | sha256sum --check
node scripts/resolve-openclaw-package-candidate.mjs \
  --source artifact --artifact-dir "$BACKPORT_WORK/artifact" \
  --package-sha256 be5732f27cf79d70f662a048fea707df516365c04a8df16e3d1c0e8eb96c4cbf \
  --output-dir "$BACKPORT_WORK/admitted" \
  --metadata "$BACKPORT_WORK/package-candidate.json"
)
```

Stop on any failed command or digest mismatch. Do not regenerate the artifact
from unpinned registry ranges or substitute `source=ref`. Do not set artifact
`packageSourceSha` to the fork recipe commit: the embedded original build
provenance and the backport revision are separate identities.

The memory patch uses zero context to keep compiled tab indentation out of
patch-context whitespace checks. The exact input and output archive digests are
mandatory guards; the three patched files retain their original `0644` modes.

## Parent installation dependencies

Dependency resolution was checked with Node 24.19.0 and npm 11.17.0. npm 12
removed shrinkwrap support and excludes the shrinkwrap from `npm pack`; it is
outside this candidate's supported installation route. The direct archive
repack also preserves an existing nested README omitted by `npm pack`.

A consuming parent installation must explicitly apply `installationOverrides`
from the manifest and bind its own complete lock. Package-owned overrides do not
control a parent installation. Verify both the direct and `@openclaw/fs-safe`
optional `tar` edges, the `@openclaw/proxyline` Undici peer, and `ajv`'s
`fast-uri` edge. Reject unexpected versions and preserve the intended baseline.

External plugins and their native CLI packages are outside this artifact's
dependency closure. A parent native selection must have its own exact manifest,
platform artifact and lock evidence. An embedded plugin shrinkwrap can hide a
parent override; the existing `generate-npm-shrinkwrap.mjs` normalization handles
that conflict before npm recomputes the parent lock. A declared override alone
does not prove the resulting resolution.

The source and artifact checks establish no installed-tool refresh behavior,
private-memory behavior, historical validity, forgetting, runtime performance
or measured benefit. Installation, lifecycle scripts and loaded-path adoption
require the runtime owner's separate decision and validation.
