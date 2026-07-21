import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getProvenanceDetails, hasProvenance, hasStagedPublish, hasTrustedPublisher } from '../lib/provenance.ts'

let responder: ((url: string) => { statusCode: number, body: string } | { error: Error }) | undefined

vi.mock('node:https', () => {
  function get(url: string | URL, _opts: any, cb?: (res: any) => void) {
    const href = typeof url === 'string' ? url : String(url)
    const r = responder?.(href)
    // Minimal request-like object supporting on('error')
    const req = {
      _errHandlers: [] as ((e: any) => void)[],
      on(event: string, fn: (e: any) => void) {
        if (event === 'error')
          this._errHandlers.push(fn)
        return this
      },
    }
    if (!r) {
      // No responder configured → emit error asynchronously
      setTimeout(() => req._errHandlers.forEach(fn => fn(new Error('No mock responder'))), 0)
      return req
    }
    if ('error' in r) {
      setTimeout(() => req._errHandlers.forEach(fn => fn(r.error)), 0)
      return req
    }
    const res = {
      statusCode: r.statusCode,
      _dataHandlers: [] as ((chunk: any) => void)[],
      _endHandlers: [] as (() => void)[],
      on(event: string, fn: any) {
        if (event === 'data')
          this._dataHandlers.push(fn)
        if (event === 'end')
          this._endHandlers.push(fn)
        return this
      },
    }
    if (cb)
      setTimeout(cb, 0, res)
    // Emit data/end
    setTimeout(() => {
      res._dataHandlers.forEach((fn: any) => fn(r.body))
      res._endHandlers.forEach((fn: any) => fn())
    }, 0)
    return req
  }
  return { get }
})

function readFixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

const meta = readFixture('./fixtures/npm-registry/metadata/nuxt.json')
const npmV1_412 = readFixture('./fixtures/npm-registry/attestations/npm-v1/nuxt@4.1.2.json')
const npmV1_313 = readFixture('./fixtures/npm-registry/attestations/npm-v1/nuxt@3.13.0.json')

function setNuxtResponder(options?: {
  override?: Record<string, { statusCode: number, body: string }>
  invalidJsonFor?: string[]
  force404For?: string[]
}) {
  responder = (url: string) => {
    if (options?.override && url in options.override)
      return options.override[url]
    if (options?.force404For?.some(u => url.includes(u)))
      return { statusCode: 404, body: 'not found' }
    if (options?.invalidJsonFor?.some(u => url.includes(u)))
      return { statusCode: 200, body: '{ invalid json' }

    if (url === 'https://registry.npmjs.org/nuxt')
      return { statusCode: 200, body: meta }
    if (url === 'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@4.1.2')
      return { statusCode: 200, body: npmV1_412 }
    if (url === 'https://registry.npmjs.org/-/v1/attestations/nuxt@4.1.2')
      return { statusCode: 404, body: 'not found' }
    if (url === 'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@3.13.0')
      return { statusCode: 200, body: npmV1_313 }
    if (url === 'https://registry.npmjs.org/-/v1/attestations/nuxt@3.13.0')
      return { statusCode: 404, body: 'not found' }
    if (url === 'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@3.0.0')
      return { statusCode: 404, body: 'not found' }
    if (url === 'https://registry.npmjs.org/-/v1/attestations/nuxt@3.0.0')
      return { statusCode: 404, body: 'not found' }

    // default: 404
    return { statusCode: 404, body: 'not found' }
  }
}

function setResponseMap(map: Record<string, { statusCode: number, body: any }>, fallback404 = true) {
  responder = (url: string) => {
    if (url in map)
      return map[url]
    return fallback404 ? { statusCode: 404, body: 'not found' } : { statusCode: 200, body: '{}' }
  }
}

beforeEach(() => {
  setNuxtResponder()
})

describe('provenance via fixtures with mocked https', () => {
  it('hasProvenance true for nuxt@4.1.2 (attestations endpoint)', async () => {
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '4.1.2', cache)).resolves.toBe(true)
  })

  it('hasProvenance true for nuxt@3.13.0 (attestations exist, not trusted publisher)', async () => {
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '3.13.0', cache)).resolves.toBe(true)
  })

  it('hasProvenance false for nuxt@3.0.0 (404 on endpoints)', async () => {
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '3.0.0', cache)).resolves.toBe(false)
  })

  it('hasProvenance falls back to metadata when endpoint JSON invalid', async () => {
    setNuxtResponder({ invalidJsonFor: ['/-/npm/v1/attestations/nuxt@3.13.0', '/-/v1/attestations/nuxt@3.13.0'] })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '3.13.0', cache)).resolves.toBe(true)
  })

  it('hasProvenance caches results and avoids subsequent network calls', async () => {
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '4.1.2', cache)).resolves.toBe(true)
    // Change responder to invalid to ensure cache short-circuits
    setNuxtResponder({ invalidJsonFor: ['/-/npm/v1/attestations/nuxt@4.1.2'] })
    await expect(hasProvenance('nuxt', '4.1.2', cache)).resolves.toBe(true)
  })

  it('hasTrustedPublisher true for nuxt@4.1.2 and false for 3.13.0', async () => {
    const cache = new Map<string, boolean>()
    await expect(hasTrustedPublisher('nuxt', '4.1.2', cache)).resolves.toBe(true)
    await expect(hasTrustedPublisher('nuxt', '3.13.0', cache)).resolves.toBe(false)
  })

  it('getProvenanceDetails returns has=false on 404 and caches', async () => {
    const cache = new Map<string, any>()
    const d1 = await getProvenanceDetails('nuxt', '3.0.0', cache)
    expect(d1.has).toBe(false)
    // Change responder to invalid json to verify cache prevents network usage
    setNuxtResponder({ invalidJsonFor: ['/-/npm/v1/attestations/nuxt@3.0.0', 'https://registry.npmjs.org/nuxt'] })
    const d2 = await getProvenanceDetails('nuxt', '3.0.0', cache)
    expect(d2.has).toBe(false)
  })

  it('getProvenanceDetails uses metadata fallback when endpoint has no attestations', async () => {
    const empty = JSON.stringify({ attestations: [] })
    // Craft minimal metadata exposing dist.attestations so fallback sets has=true
    const metaWithAtt = JSON.stringify({
      versions: {
        '4.1.2': {
          dist: {
            attestations: [
              {
                predicate: {
                  invocation: {
                    configSource: {
                      uri: 'git+https://github.com/owner/repo@refs/heads/main',
                    },
                  },
                },
              },
            ],
          },
        },
      },
    })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@4.1.2': { statusCode: 200, body: empty },
        'https://registry.npmjs.org/-/v1/attestations/nuxt@4.1.2': { statusCode: 200, body: empty },
        'https://registry.npmjs.org/nuxt': { statusCode: 200, body: metaWithAtt },
      },
    })
    const cache = new Map<string, any>()
    const d = await getProvenanceDetails('nuxt', '4.1.2', cache)
    expect(d.has).toBe(true)
    expect(d.repository).toBe('owner/repo')
    expect(d.ref).toBe('refs/heads/main')
    expect(d.branch).toBe('main')
  })

  it('hasProvenance continues on non-404 error and succeeds via second endpoint', async () => {
    // First endpoint 500, second endpoint has attestations
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@4.1.2': { statusCode: 500, body: 'oops' },
        'https://registry.npmjs.org/-/v1/attestations/nuxt@4.1.2': { statusCode: 200, body: npmV1_412 },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '4.1.2', cache)).resolves.toBe(true)
  })

  it('hasProvenance returns false when endpoints error and metadata fails', async () => {
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@4.1.2': { statusCode: 500, body: 'err' },
        'https://registry.npmjs.org/-/v1/attestations/nuxt@4.1.2': { statusCode: 500, body: 'err' },
        'https://registry.npmjs.org/nuxt': { statusCode: 500, body: 'err' },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '4.1.2', cache)).resolves.toBe(false)
  })

  it('hasTrustedPublisher true when _npmUser is GitHub Actions OIDC', async () => {
    const metaWithGH = JSON.stringify({
      versions: {
        '9.9.9': {
          _npmUser: { name: 'GitHub Actions', email: 'npm-oidc-no-reply@github.com' },
        },
      },
    })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/nuxt': { statusCode: 200, body: metaWithGH },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasTrustedPublisher('nuxt', '9.9.9', cache)).resolves.toBe(true)
  })

  it('hasProvenance handles missing statusCode then 404', async () => {
    // First endpoint responds without statusCode -> httpJson rejects with "No status code"
    // Second endpoint responds 404 -> returns false
    const noStatus: any = { body: '' }
    ;(noStatus as any).statusCode = undefined
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@9.9.9': noStatus as any,
        'https://registry.npmjs.org/-/v1/attestations/nuxt@9.9.9': { statusCode: 404, body: 'not found' },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '9.9.9', cache)).resolves.toBe(false)
  })

  it('hasStagedPublish true when _npmUser has approver', async () => {
    const metaStaged = JSON.stringify({
      versions: {
        '9.9.9': {
          _npmUser: { name: 'GitHub Actions', email: 'npm-oidc-no-reply@github.com', trustedPublisher: { id: 'github', oidcConfigId: 'x' }, approver: { name: 'danielroe' } },
        },
        '9.9.8': {
          _npmUser: { name: 'GitHub Actions', email: 'npm-oidc-no-reply@github.com', trustedPublisher: { id: 'github', oidcConfigId: 'x' } },
        },
      },
    })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/nuxt': { statusCode: 200, body: metaStaged },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasStagedPublish('nuxt', '9.9.9', cache)).resolves.toBe(true)
    await expect(hasStagedPublish('nuxt', '9.9.8', cache)).resolves.toBe(false)
  })

  it('hasStagedPublish caches results and returns false on metadata error', async () => {
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/nuxt': { statusCode: 500, body: 'err' },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasStagedPublish('nuxt', '1.2.3', cache)).resolves.toBe(false)
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/nuxt': { statusCode: 200, body: JSON.stringify({ versions: { '1.2.3': { _npmUser: { approver: { name: 'x' } } } } }) },
      },
    })
    await expect(hasStagedPublish('nuxt', '1.2.3', cache)).resolves.toBe(false)
  })

  it('hasTrustedPublisher returns false on metadata error (catch path)', async () => {
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/nuxt': { statusCode: 500, body: 'err' },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasTrustedPublisher('nuxt', '1.2.3', cache)).resolves.toBe(false)
  })

  it('hasProvenance metadata path: uses ver.provenance boolean', async () => {
    const meta = JSON.stringify({ versions: { '8.8.8': { provenance: true } } })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@8.8.8': { statusCode: 500, body: 'err' },
        'https://registry.npmjs.org/-/v1/attestations/nuxt@8.8.8': { statusCode: 500, body: 'err' },
        'https://registry.npmjs.org/nuxt': { statusCode: 200, body: meta },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '8.8.8', cache)).resolves.toBe(true)
  })

  it('hasProvenance metadata path: uses ver.dist.provenance boolean', async () => {
    const meta = JSON.stringify({ versions: { '7.7.7': { dist: { provenance: true } } } })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@7.7.7': { statusCode: 500, body: 'err' },
        'https://registry.npmjs.org/-/v1/attestations/nuxt@7.7.7': { statusCode: 500, body: 'err' },
        'https://registry.npmjs.org/nuxt': { statusCode: 200, body: meta },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '7.7.7', cache)).resolves.toBe(true)
  })

  it('getProvenanceDetails metadata fallback catch path when metadata errors', async () => {
    const empty = JSON.stringify({ attestations: [] })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@6.6.6': { statusCode: 200, body: empty },
        'https://registry.npmjs.org/-/v1/attestations/nuxt@6.6.6': { statusCode: 200, body: empty },
        'https://registry.npmjs.org/nuxt': { statusCode: 500, body: 'err' },
      },
    })
    const cache = new Map<string, any>()
    const d = await getProvenanceDetails('nuxt', '6.6.6', cache)
    expect(d.has).toBe(false)
  })

  it('hasProvenance returns false when endpoint returns count=0 (early return)', async () => {
    const zero = JSON.stringify({ count: 0 })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@5.5.5': { statusCode: 200, body: zero },
      },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '5.5.5', cache)).resolves.toBe(false)
  })

  it('getProvenanceDetails uses endpoint attestation and extracts repository/ref/branch', async () => {
    const att = JSON.stringify({
      attestations: [
        {
          predicate: {
            invocation: { configSource: { uri: 'git+https://github.com/org/repo@refs/heads/feature' } },
          },
        },
      ],
    })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@5.0.0': { statusCode: 200, body: att },
      },
    })
    const cache = new Map<string, any>()
    const d = await getProvenanceDetails('nuxt', '5.0.0', cache)
    expect(d.has).toBe(true)
    expect(d.repository).toBe('org/repo')
    expect(d.ref).toBe('refs/heads/feature')
    expect(d.branch).toBe('feature')
  })

  it('getProvenanceDetails continues on non-404 error to next endpoint that succeeds', async () => {
    const att = JSON.stringify({
      attestations: [
        { predicate: { invocation: { configSource: { uri: 'git+https://github.com/x/y@refs/heads/dev' } } } },
      ],
    })
    setNuxtResponder({
      override: {
        'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@5.0.1': { statusCode: 500, body: 'err' },
        'https://registry.npmjs.org/-/v1/attestations/nuxt@5.0.1': { statusCode: 200, body: att },
      },
    })
    const cache = new Map<string, any>()
    const d = await getProvenanceDetails('nuxt', '5.0.1', cache)
    expect(d.has).toBe(true)
    expect(d.repository).toBe('x/y')
    expect(d.branch).toBe('dev')
  })

  it('hasProvenance true when endpoint returns numeric count > 0', async () => {
    setResponseMap({
      'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@1.2.3': { statusCode: 200, body: JSON.stringify({ count: 1 }) },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '1.2.3', cache)).resolves.toBe(true)
  })

  it('hasProvenance metadata path: ver.dist.attestations as object (non-array)', async () => {
    const meta = JSON.stringify({ versions: { '2.2.2': { dist: { attestations: { predicate: { invocation: { configSource: { uri: 'git+https://github.com/a/b@refs/heads/x' } } } } } } } })
    setResponseMap({
      'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@2.2.2': { statusCode: 500, body: 'err' },
      'https://registry.npmjs.org/-/v1/attestations/nuxt@2.2.2': { statusCode: 500, body: 'err' },
      'https://registry.npmjs.org/nuxt': { statusCode: 200, body: meta },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '2.2.2', cache)).resolves.toBe(true)
  })

  it('httpJson handles Buffer chunks', async () => {
    const bufBody = Buffer.from(JSON.stringify({ attestations: [] }), 'utf8')
    setResponseMap({
      'https://registry.npmjs.org/-/npm/v1/attestations/nuxt@0.0.1': { statusCode: 200, body: bufBody },
      'https://registry.npmjs.org/-/v1/attestations/nuxt@0.0.1': { statusCode: 404, body: 'x' },
    })
    const cache = new Map<string, boolean>()
    await expect(hasProvenance('nuxt', '0.0.1', cache)).resolves.toBe(false)
  })
})
