# docket -- tracker core library: @rackbops/docket-core and @rackbops/docket-types
# Requires: just, node >= 24, pnpm (the version in package.json's packageManager)

mod core 'packages/core/Justfile'
mod types 'packages/types/Justfile'

default:
    @just --list

# Install dependencies (workspace-wide)
install:
    pnpm install --frozen-lockfile

# Run all checks in the order that works: lint, build (types needs core's dist), typecheck, test
check: lint build typecheck test

# Lint and check formatting
lint:
    pnpm biome check .

# Fix lint and formatting issues
fix:
    pnpm biome check --write .

# Build all packages, in dependency order
build:
    pnpm -r run build

# Type-check all packages (run build first: types resolves core through its dist)
typecheck:
    pnpm -r run typecheck

# Run all tests
test:
    pnpm -r run test

# Set the one shared version on every package (no commit, no tag); then commit and tag v<version>
version version:
    pnpm -r exec npm version {{version}} --no-git-tag-version
    @echo "now: git commit -am 'chore(release): v{{version}}' && git tag v{{version}} && git push --follow-tags"

# Remove build artifacts and node_modules
clean:
    rm -rf node_modules coverage packages/*/node_modules packages/*/dist packages/*/coverage packages/*/*.tsbuildinfo

# Reinstall from scratch
fresh: clean install
