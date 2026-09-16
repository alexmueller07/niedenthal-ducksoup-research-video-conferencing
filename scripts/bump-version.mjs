#!/usr/bin/env node
// Auto-bumps the patch version number (e.g. 3.0.0 -> 3.0.1) so every push to
// main that reaches a release is a distinct, comparable version. Without
// this, the dashboard's "Update available" check (main/main.ts, see
// docs/for-technical-users.md §10.5) would never see a version change and
// the button would never appear.
//
// Run by .github/workflows/release.yml before building. Keeps package.json
// and main/protocol.ts's APP_VERSION in sync — package.json is the source of
// truth, this script is what copies it into protocol.ts.

import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkgPath = path.join(root, 'package.json')
const protocolPath = path.join(root, 'main/protocol.ts')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const parts = pkg.version.split('.').map(Number)
parts[2] += 1
const nextVersion = parts.join('.')

pkg.version = nextVersion
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const protocol = readFileSync(protocolPath, 'utf8')
writeFileSync(
  protocolPath,
  protocol.replace(/export const APP_VERSION = '[^']+'/, `export const APP_VERSION = '${nextVersion}'`),
)

console.log(nextVersion)
