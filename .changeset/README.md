# Changesets

Each change that should appear in the changelog gets a small markdown file here,
describing it and saying whether it is a patch, minor or major.

    npx changeset            # write one, interactively
    npm run version          # consume them: bumps package.json, writes CHANGELOG.md

`npm run version` is what turns them into a release: the version bump is what
`.github/workflows/release.yml` watches for, so merging its result publishes.

See https://github.com/changesets/changesets for the full format.
