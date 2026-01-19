import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  detectLockfile,
  diffDependencySets,
  findLockfileLine,
  matchesTrustPolicyExclude,
  parseBunLock,
  parseLockfile,
  parseNpmLock,
  parsePnpmLock,
  parsePnpmWorkspaceConfig,
  parseTrustPolicyExclude,
  parseYarnBerryLock,
  parseYarnV1Lock,
  readTextFile,
  yarnBerrySpecifierToName,
  yarnV1SpecifierToName,
} from '../lib/lockfile.ts'

describe('lockfile utils', () => {
  it('detectLockfile finds supported lockfiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oidc-action-'))
    try {
    // No file
      expect(detectLockfile(dir)).toBe(undefined)
      // Create pnpm first
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
      expect(detectLockfile(dir)).toBe('pnpm-lock.yaml')
      // If pnpm exists, it should still prefer that even if others are present
      writeFileSync(join(dir, 'package-lock.json'), '{}')
      writeFileSync(join(dir, 'yarn.lock'), '')
      expect(detectLockfile(dir)).toBe('pnpm-lock.yaml')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readTextFile reads utf8 content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oidc-action-'))
    try {
      const p = join(dir, 'file.txt')
      writeFileSync(p, 'hello', 'utf8')
      expect(readTextFile(p)).toBe('hello')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Test parseLockfile with unsupported file types
  it('parseLockfile returns empty map for unsupported lockfile types', () => {
    const result = parseLockfile('unsupported.lock', 'content')
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })

  // Test yarnV1SpecifierToName edge cases
  it('yarnV1SpecifierToName handles specs without @', () => {
    expect(yarnV1SpecifierToName('invalid-spec')).toBe(undefined)
  })

  it('yarnV1SpecifierToName handles specs with @ at position 0', () => {
    expect(yarnV1SpecifierToName('@invalid')).toBe(undefined)
  })

  // Test yarnBerrySpecifierToName edge cases
  it('yarnBerrySpecifierToName handles scoped packages without version', () => {
    expect(yarnBerrySpecifierToName('@scope/name')).toBe(undefined)
  })

  it('yarnBerrySpecifierToName handles regular packages without version', () => {
    expect(yarnBerrySpecifierToName('name')).toBe(undefined)
  })

  it('yarnBerrySpecifierToName handles quoted specs', () => {
    expect(yarnBerrySpecifierToName('"@scope/name@npm:1.0.0"')).toBe('@scope/name')
    expect(yarnBerrySpecifierToName('\'test@npm:1.0.0\'')).toBe('test')
  })

  // Test findLockfileLine edge cases
  it('findLockfileLine returns undefined for unsupported lockfile types', () => {
    const result = findLockfileLine('unsupported.lock', 'content', 'test', '1.0.0')
    expect(result).toBe(undefined)
  })

  it('findLockfileLine handles npm lockfile without matches', () => {
    const content = '{"packages": {}}'
    const result = findLockfileLine('package-lock.json', content, 'nonexistent', '1.0.0')
    expect(result).toBe(undefined)
  })

  it('findLockfileLine handles pnpm lockfile without matches', () => {
    const content = 'packages:\n\n  /other@1.0.0:\n    resolution: {}'
    const result = findLockfileLine('pnpm-lock.yaml', content, 'test', '1.0.0')
    expect(result).toBe(undefined)
  })

  it('findLockfileLine handles yarn v1 lockfile without matches', () => {
    const content = '# yarn lockfile v1\n\nother@^1.0.0:\n  version "1.0.0"'
    const result = findLockfileLine('yarn.lock', content, 'test', '1.0.0')
    expect(result).toBe(undefined)
  })

  it('findLockfileLine handles yarn berry lockfile without matches', () => {
    const content = '"other@npm:^1.0.0":\n  version: "1.0.0"'
    const result = findLockfileLine('yarn.lock', content, 'test', '1.0.0')
    expect(result).toBe(undefined)
  })

  it('findLockfileLine handles bun lockfile without matches', () => {
    const content = '{"packages": {"different@2.0.0": {"version": "2.0.0"}}}'
    const result = findLockfileLine('bun.lock', content, 'test', '1.0.0')
    expect(result).toBe(undefined)
  })

  // Test diffDependencySets to cover setsEqual edge cases
  it('diffDependencySets detects different versions in sets', () => {
    const prev = new Map([['lodash', new Set(['4.17.21'])]])
    const curr = new Map([['lodash', new Set(['4.17.22'])]])
    const diff = diffDependencySets(prev, curr)
    expect(diff.length).toBe(1)
    expect(diff[0].name).toBe('lodash')
  })

  it('diffDependencySets detects removed packages', () => {
    const prev = new Map([['lodash', new Set(['4.17.21'])], ['removed', new Set(['1.0.0'])]])
    const curr = new Map([['lodash', new Set(['4.17.21'])]])
    const diff = diffDependencySets(prev, curr)
    expect(diff.length).toBe(1)
    expect(diff[0].name).toBe('removed')
    expect(diff[0].previous.has('1.0.0')).toBe(true)
    expect(diff[0].current.size).toBe(0)
  })
})

describe('parseNpmLock', () => {
// Test parseNpmLock error cases
  it('parseNpmLock handles malformed JSON', () => {
    const result = parseNpmLock('invalid json {')
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })

  it('parseNpmLock handles missing packages property', () => {
    const result = parseNpmLock('{}')
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })

  it('parseNpmLock handles entries without version', () => {
    const content = '{"packages":{"node_modules/test":{"name":"test"}}}'
    const result = parseNpmLock(content)
    expect(result.size).toBe(0)
  })

  it('parseNpmLock handles root package entry', () => {
    const content = '{"packages":{"":{"name":"root","version":"1.0.0"}}}'
    const result = parseNpmLock(content)
    expect(result.size).toBe(0) // Root package should be skipped
  })

  it('parseNpmLock handles entry without name', () => {
    const content = '{"packages":{"node_modules/test":{"version":"1.0.0"}}}'
    const result = parseNpmLock(content)
    expect(result.get('test')).toContain('1.0.0')
  })

  it('parseNpmLock handles entry with explicit name', () => {
    const content = '{"packages":{"node_modules/test":{"name":"different","version":"1.0.0"}}}'
    const result = parseNpmLock(content)
    expect(result.get('different')).toContain('1.0.0')
  })
})

describe('parsePnpmLock', () => {
// Test parsePnpmLock edge cases
  it('parsePnpmLock handles content without packages section', () => {
    const content = 'settings:\n  autoInstallPeers: true'
    const result = parsePnpmLock(content)
    expect(result.size).toBe(0)
  })

  it('parsePnpmLock handles packages section without entries', () => {
    const content = 'packages:\n\nsettings:\n  autoInstallPeers: true'
    const result = parsePnpmLock(content)
    expect(result.size).toBe(0)
  })

  it('parsePnpmLock handles malformed package entries', () => {
    const content = `packages:

  /test@1.0.0:
    resolution: {integrity: sha512-test}
  
  invalid-entry-without-colon
  
  /valid@2.0.0:
    resolution: {integrity: sha512-test}`
    const result = parsePnpmLock(content)
    // Both test and valid should be parsed because both have valid format
    expect(result.get('test')).toContain('1.0.0')
    expect(result.get('valid')).toContain('2.0.0')
    expect(result.size).toBe(2)
  })

  it('parsePnpmLock handles entries without @ symbol', () => {
    const content = `packages:

  /no-at-symbol:
    resolution: {integrity: sha512-test}`
    const result = parsePnpmLock(content)
    expect(result.size).toBe(0)
  })

  it('parsePnpmLock handles entries with @ at position 0', () => {
    const content = `packages:

  /@scoped:
    resolution: {integrity: sha512-test}`
    const result = parsePnpmLock(content)
    expect(result.size).toBe(0)
  })

  it('parsePnpmLock handles entries without version', () => {
    const content = `packages:

  /test@:
    resolution: {integrity: sha512-test}`
    const result = parsePnpmLock(content)
    expect(result.size).toBe(0)
  })

  it('parsePnpmLock handles quoted package names', () => {
    const content = `packages:

  "/test@1.0.0":
    resolution: {integrity: sha512-test}
  
  '/another@2.0.0':
    resolution: {integrity: sha512-test}`
    const result = parsePnpmLock(content)
    expect(result.size).toBe(2)
    // The parser doesn't strip leading slash for quoted names
    expect(result.get('/test')).toContain('1.0.0')
    expect(result.get('/another')).toContain('2.0.0')
  })

  it('parsePnpmLock handles packages with peer dependencies suffix', () => {
    const content = `packages:

  /test@1.0.0(peer@2.0.0):
    resolution: {integrity: sha512-test}`
    const result = parsePnpmLock(content)
    expect(result.get('test')).toContain('1.0.0')
  })
})

describe('parseYarnV1Lock', () => {
// Test parseYarnV1Lock edge cases
  it('parseYarnV1Lock handles entries without version', () => {
    const content = `# yarn lockfile v1

test@^1.0.0:
  resolved "https://registry.yarnpkg.com/test"
  # no version field`
    const result = parseYarnV1Lock(content)
    expect(result.size).toBe(0)
  })

  it('parseYarnV1Lock handles multi-line headers', () => {
    const content = `# yarn lockfile v1

"test@^1.0.0",
"test@^1.1.0":
  version "1.2.0"
  resolved "https://registry.yarnpkg.com/test"`
    const result = parseYarnV1Lock(content)
    expect(result.get('test')).toContain('1.2.0')
  })

  it('parseYarnV1Lock skips invalid specifiers', () => {
    const content = `# yarn lockfile v1

invalid-spec:
  version "1.0.0"
  
test@^1.0.0:
  version "2.0.0"`
    const result = parseYarnV1Lock(content)
    expect(result.get('test')).toContain('2.0.0')
    expect(result.size).toBe(1)
  })
})

describe('parseYarnBerryLock', () => {
// Test parseYarnBerryLock edge cases
  it('parseYarnBerryLock handles entries without version', () => {
    const content = `"test@npm:^1.0.0":
  resolution: "test@npm:1.2.0"
  # no version field`
    const result = parseYarnBerryLock(content)
    expect(result.size).toBe(0)
  })

  it('parseYarnBerryLock handles invalid specifiers', () => {
    const content = `"invalid-spec":
  version: "1.0.0"
  
"test@npm:^1.0.0":
  version: "2.0.0"`
    const result = parseYarnBerryLock(content)
    expect(result.get('test')).toContain('2.0.0')
    expect(result.size).toBe(1)
  })

  it('parseYarnBerryLock skips comment lines', () => {
    const content = `# This is a comment
"test@npm:^1.0.0":
  version: "1.0.0"
  
# Another comment
"other@npm:^2.0.0":
  version: "2.0.0"`
    const result = parseYarnBerryLock(content)
    expect(result.get('test')).toContain('1.0.0')
    expect(result.get('other')).toContain('2.0.0')
  })

  it('parseYarnBerryLock handles single quotes in specifiers', () => {
    const content = `'test@npm:^1.0.0':
  version: '1.0.0'`
    const result = parseYarnBerryLock(content)
    expect(result.get('test')).toContain('1.0.0')
  })

  it('parseYarnBerryLock handles lines without colon', () => {
    const content = `"test@npm:^1.0.0"
  version: "1.0.0"
  
"valid@npm:^2.0.0":
  version: "2.0.0"`
    const result = parseYarnBerryLock(content)
    // Only valid should be parsed since test line doesn't end with ':'
    expect(result.get('valid')).toContain('2.0.0')
    expect(result.has('test')).toBe(false)
    expect(result.size).toBe(1)
  })
})

describe('parseBunLock', () => {
// Test parseBunLock edge cases
  it('parseBunLock handles malformed JSON', () => {
    const result = parseBunLock('invalid json {')
    expect(result).toBeInstanceOf(Map)
    expect(result.size).toBe(0)
  })

  it('parseBunLock handles JSONC with comments', () => {
    const content = `{
  // This is a comment
  "packages": [
    {
      "name": "test",
      "version": "1.0.0" // Another comment
    }
  ]
}`
    const result = parseBunLock(content)
    expect(result.get('test')).toContain('1.0.0')
  })

  it('parseBunLock handles malformed JSONC', () => {
    const content = `{
  // This is a comment
  "packages": [
    invalid json
  ]
}`
    const result = parseBunLock(content)
    expect(result.size).toBe(0)
  })

  it('parseBunLock handles missing packages property', () => {
    const result = parseBunLock('{}')
    expect(result.size).toBe(0)
  })

  it('parseBunLock handles null packages', () => {
    const result = parseBunLock('{"packages": null}')
    expect(result.size).toBe(0)
  })

  it('parseBunLock handles array format with null entries', () => {
    const content = '{"packages": [null, {"name": "test", "version": "1.0.0"}]}'
    const result = parseBunLock(content)
    expect(result.get('test')).toContain('1.0.0')
    expect(result.size).toBe(1)
  })

  it('parseBunLock handles array format without name or version', () => {
    const content = '{"packages": [{"description": "test"}]}'
    const result = parseBunLock(content)
    expect(result.size).toBe(0)
  })

  it('parseBunLock handles object format without version', () => {
    const content = '{"packages": {"test@1.0.0": {"name": "test"}}}'
    const result = parseBunLock(content)
    expect(result.size).toBe(0)
  })

  it('parseBunLock handles object format without name but with key pattern', () => {
    const content = '{"packages": {"test@1.0.0": {"version": "1.0.0"}}}'
    const result = parseBunLock(content)
    expect(result.get('test')).toContain('1.0.0')
  })

  it('parseBunLock handles scoped packages in key pattern', () => {
    const content = '{"packages": {"@scope/test@1.0.0": {"version": "1.0.0"}}}'
    const result = parseBunLock(content)
    expect(result.get('@scope/test')).toContain('1.0.0')
  })

  it('parseBunLock handles invalid key patterns', () => {
    const content = '{"packages": {"invalid-key": {"version": "1.0.0"}}}'
    const result = parseBunLock(content)
    expect(result.size).toBe(0)
  })

  it('parseBunLock handles non-array non-object packages', () => {
    const content = '{"packages": "invalid"}'
    const result = parseBunLock(content)
    expect(result.size).toBe(0)
  })
})

describe('findLockfileLine', () => {
  it('findLockfileLine finds npm lockfile by node_modules key', () => {
    const content = '{"packages": {"node_modules/test": {"version": "1.0.0"}}}'
    const line = findLockfileLine('package-lock.json', content, 'test', '1.0.0')
    expect(typeof line).toBe('number')
  })

  it('findLockfileLine finds npm lockfile by name field', () => {
    const content = '{"packages": {"": {}, "x": {"name": "test", "version": "1.0.0"}}}'
    const line = findLockfileLine('package-lock.json', content, 'test', '1.0.0')
    expect(typeof line).toBe('number')
  })

  it('findLockfileLine finds pnpm lockfile primary pattern', () => {
    const content = 'packages:\n\n  /test@1.0.0:\n    resolution: {integrity: sha512-test}'
    const line = findLockfileLine('pnpm-lock.yaml', content, 'test', '1.0.0')
    expect(line).toBe(3)
  })

  it('findLockfileLine finds pnpm lockfile secondary pattern (trimStart startsWith)', () => {
    const content = 'packages:\n\n    /test@1.0.0(peer@2.0.0):\n      resolution: {integrity: sha512-test}'
    const line = findLockfileLine('pnpm-lock.yaml', content, 'test', '1.0.0')
    expect(typeof line).toBe('number')
  })

  it('findLockfileLine finds yarn v1 lockfile matching version', () => {
    const content = '# yarn lockfile v1\n\n"test@^1.0.0":\n  version "1.0.0"\n\nother@^1.0.0:\n  version "1.0.0"'
    const line = findLockfileLine('yarn.lock', content, 'test', '1.0.0')
    expect(typeof line).toBe('number')
  })

  it('findLockfileLine in yarn v1 breaks when next header encountered', () => {
    const content = '# yarn lockfile v1\n\n"test@^1.0.0":\n  resolved "x"\nother@^1.0.0:\n  version "1.0.0"'
    const line = findLockfileLine('yarn.lock', content, 'test', '2.0.0')
    expect(line).toBe(undefined)
  })

  it('findLockfileLine finds yarn berry lockfile matching version', () => {
    const content = '"test@npm:^1.0.0":\n  version: "1.0.0"\n"other@npm:^1.0.0":\n  version: "1.0.0"'
    const line = findLockfileLine('yarn.lock', content, 'test', '1.0.0')
    expect(typeof line).toBe('number')
  })

  it('findLockfileLine finds bun lockfile by name then version and breaks at closing brace when not found', () => {
    const content = '{\n  "packages": [\n    {\n      "name": "test",\n      "desc": "noop"\n    }\n  ]\n}'
    const line = findLockfileLine('bun.lock', content, 'test', '9.9.9')
    expect(line).toBeUndefined()
  })

  it('findLockfileLine finds bun lockfile by array name and version', () => {
    const content = '{\n  "packages": [\n    {\n      "name": "test",\n      "version": "1.0.0"\n    }\n  ]\n}'
    const line = findLockfileLine('bun.lock', content, 'test', '1.0.0')
    expect(typeof line).toBe('number')
  })

  it('findLockfileLine finds bun lockfile by key pattern', () => {
    const content = '{"packages": {"test@1.0.0": {"something": 1}}}'
    const line = findLockfileLine('bun.lock', content, 'test', '1.0.0')
    expect(typeof line).toBe('number')
  })

  it('findLockfileLine finds bun lockfile by version regex fallback', () => {
    const content = '{"x": 1}\n{"y": 2}\n  "version": "1.0.0"\n{"z": 3}'
    const line = findLockfileLine('bun.lock', content, 'noname', '1.0.0')
    expect(typeof line).toBe('number')
  })
})

describe('parsePnpmWorkspaceConfig', () => {
  it('returns empty config when file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provenance-action-'))
    try {
      const result = parsePnpmWorkspaceConfig(dir)
      expect(result).toEqual({})
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses trustPolicyExclude from pnpm-workspace.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provenance-action-'))
    try {
      const content = `trustPolicyExclude:
  - 'chokidar@4.0.3'
  - 'webpack@4.47.0 || 5.102.1'
  - '@babel/core@7.28.5'
`
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), content, 'utf8')
      const result = parsePnpmWorkspaceConfig(dir)
      expect(result.trustPolicyExclude).toEqual([
        'chokidar@4.0.3',
        'webpack@4.47.0 || 5.102.1',
        '@babel/core@7.28.5',
      ])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parseTrustPolicyExclude', () => {
  it('parses list format with single quotes', () => {
    const content = `trustPolicyExclude:
  - 'chokidar@4.0.3'
  - 'webpack'
`
    const result = parseTrustPolicyExclude(content)
    expect(result.trustPolicyExclude).toEqual(['chokidar@4.0.3', 'webpack'])
  })

  it('parses list format with double quotes', () => {
    const content = `trustPolicyExclude:
  - "chokidar@4.0.3"
  - "webpack@5.0.0"
`
    const result = parseTrustPolicyExclude(content)
    expect(result.trustPolicyExclude).toEqual(['chokidar@4.0.3', 'webpack@5.0.0'])
  })

  it('parses list format without quotes', () => {
    const content = `trustPolicyExclude:
  - chokidar@4.0.3
  - webpack
`
    const result = parseTrustPolicyExclude(content)
    expect(result.trustPolicyExclude).toEqual(['chokidar@4.0.3', 'webpack'])
  })

  it('parses inline array format', () => {
    const content = `trustPolicyExclude: ['chokidar@4.0.3', 'webpack']`
    const result = parseTrustPolicyExclude(content)
    expect(result.trustPolicyExclude).toEqual(['chokidar@4.0.3', 'webpack'])
  })

  it('parses inline array format with double quotes', () => {
    const content = `trustPolicyExclude: ["chokidar@4.0.3", "webpack"]`
    const result = parseTrustPolicyExclude(content)
    expect(result.trustPolicyExclude).toEqual(['chokidar@4.0.3', 'webpack'])
  })

  it('handles empty content', () => {
    const result = parseTrustPolicyExclude('')
    expect(result).toEqual({})
  })

  it('handles content without trustPolicyExclude', () => {
    const content = `packages:
  - 'packages/*'
`
    const result = parseTrustPolicyExclude(content)
    expect(result).toEqual({})
  })

  it('handles comments', () => {
    const content = `# This is a comment
trustPolicyExclude:
  # Another comment
  - chokidar@4.0.3
`
    const result = parseTrustPolicyExclude(content)
    expect(result.trustPolicyExclude).toEqual(['chokidar@4.0.3'])
  })

  it('stops parsing at next top-level key', () => {
    const content = `trustPolicyExclude:
  - chokidar@4.0.3
packages:
  - 'packages/*'
`
    const result = parseTrustPolicyExclude(content)
    expect(result.trustPolicyExclude).toEqual(['chokidar@4.0.3'])
  })

  it('handles disjunction patterns', () => {
    const content = `trustPolicyExclude:
  - 'webpack@4.47.0 || 5.102.1'
`
    const result = parseTrustPolicyExclude(content)
    expect(result.trustPolicyExclude).toEqual(['webpack@4.47.0 || 5.102.1'])
  })
})

describe('matchesTrustPolicyExclude', () => {
  it('matches package without version (any version)', () => {
    const patterns = ['chokidar']
    expect(matchesTrustPolicyExclude('chokidar', '4.0.3', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('chokidar', '3.0.0', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('other', '1.0.0', patterns)).toBe(false)
  })

  it('matches package with specific version', () => {
    const patterns = ['chokidar@4.0.3']
    expect(matchesTrustPolicyExclude('chokidar', '4.0.3', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('chokidar', '3.0.0', patterns)).toBe(false)
    expect(matchesTrustPolicyExclude('other', '4.0.3', patterns)).toBe(false)
  })

  it('matches scoped packages', () => {
    const patterns = ['@babel/core@7.28.5']
    expect(matchesTrustPolicyExclude('@babel/core', '7.28.5', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('@babel/core', '7.0.0', patterns)).toBe(false)
    expect(matchesTrustPolicyExclude('@babel/preset-env', '7.28.5', patterns)).toBe(false)
  })

  it('matches scoped packages without version', () => {
    const patterns = ['@babel/core']
    expect(matchesTrustPolicyExclude('@babel/core', '7.28.5', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('@babel/core', '7.0.0', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('@babel/preset-env', '7.28.5', patterns)).toBe(false)
  })

  it('matches disjunction patterns', () => {
    const patterns = ['webpack@4.47.0 || 5.102.1']
    expect(matchesTrustPolicyExclude('webpack', '4.47.0', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('webpack', '5.102.1', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('webpack', '5.0.0', patterns)).toBe(false)
    expect(matchesTrustPolicyExclude('other', '4.47.0', patterns)).toBe(false)
  })

  it('matches multiple patterns', () => {
    const patterns = ['chokidar@4.0.3', 'webpack', '@babel/core@7.28.5']
    expect(matchesTrustPolicyExclude('chokidar', '4.0.3', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('webpack', '5.0.0', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('@babel/core', '7.28.5', patterns)).toBe(true)
    expect(matchesTrustPolicyExclude('lodash', '4.0.0', patterns)).toBe(false)
  })

  it('returns false for empty patterns', () => {
    expect(matchesTrustPolicyExclude('chokidar', '4.0.3', [])).toBe(false)
  })
})
