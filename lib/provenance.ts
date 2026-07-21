import { Buffer } from 'node:buffer'
import * as https from 'node:https'

export interface ProvenanceDetails { has: boolean, repository?: string, ref?: string, branch?: string }

export async function hasProvenance(name: string, version: string, cache: Map<string, boolean>): Promise<boolean> {
  const key = `${name}@${version}`
  if (cache.has(key))
    return cache.get(key) as boolean

  const encodedName = encodeURIComponent(name)
  const encodedVersion = encodeURIComponent(version)
  const attestUrls = [
    `https://registry.npmjs.org/-/npm/v1/attestations/${encodedName}@${encodedVersion}`,
    `https://registry.npmjs.org/-/v1/attestations/${encodedName}@${encodedVersion}`,
  ]
  let endpointSaidHas = false
  for (const url of attestUrls) {
    try {
      const res = await httpJson(url)
      const count = typeof res?.count === 'number' ? res.count : (Array.isArray(res?.attestations) ? res.attestations.length : 0)
      if (count > 0) {
        endpointSaidHas = true
        break
      }
      cache.set(key, false)
      return false
    }
    catch (e: any) {
      if (e && e.statusCode === 404) {
        cache.set(key, false)
        return false
      }
      continue
    }
  }
  if (endpointSaidHas) {
    cache.set(key, true)
    return true
  }

  try {
    const meta = await httpJson(packageMetadataUrl(name))
    const ver = meta && meta.versions && meta.versions[version]
    const has = Boolean(ver && (
      ver.provenance
      || (ver.dist && (
        ver.dist.provenance
        || (ver.dist.attestations && (
          typeof ver.dist.attestations === 'object' || Array.isArray(ver.dist.attestations)
        ))
      ))
    ))
    cache.set(key, has)
    return has
  }
  catch {
    cache.set(key, false)
    return false
  }
}

export async function getProvenanceDetails(name: string, version: string, cache: Map<string, ProvenanceDetails>): Promise<ProvenanceDetails> {
  const key = `${name}@${version}`
  if (cache.has(key))
    return cache.get(key) as ProvenanceDetails

  const details: ProvenanceDetails = { has: false }
  const encodedName = encodeURIComponent(name)
  const encodedVersion = encodeURIComponent(version)
  const attestUrls = [
    `https://registry.npmjs.org/-/npm/v1/attestations/${encodedName}@${encodedVersion}`,
    `https://registry.npmjs.org/-/v1/attestations/${encodedName}@${encodedVersion}`,
  ]

  for (const url of attestUrls) {
    try {
      const res = await httpJson(url)
      const attestations: any[] = Array.isArray(res?.attestations) ? res.attestations : []
      if (attestations.length === 0)
        continue
      details.has = true
      for (const att of attestations) {
        const { repository, ref } = extractRepoAndRef(att)
        if (repository || ref) {
          details.repository = repository || details.repository
          details.ref = ref || details.ref
          if (details.ref)
            details.branch = normalizeRefToBranch(details.ref)
          if (details.repository && details.branch)
            break
        }
      }
      break
    }
    catch (e: any) {
      if (e && e.statusCode === 404) {
        cache.set(key, details)
        return details
      }
      continue
    }
  }

  if (!details.has) {
    try {
      const meta = await httpJson(packageMetadataUrl(name))
      const ver = meta && meta.versions && meta.versions[version]
      if (ver && ver.dist && ver.dist.attestations) {
        const attestations = Array.isArray(ver.dist.attestations) ? ver.dist.attestations : [ver.dist.attestations]
        if (attestations.length) {
          details.has = true
          for (const att of attestations) {
            const { repository, ref } = extractRepoAndRef(att)
            if (repository || ref) {
              details.repository = repository || details.repository
              details.ref = ref || details.ref
              if (details.ref)
                details.branch = normalizeRefToBranch(details.ref)
              if (details.repository && details.branch)
                break
            }
          }
        }
      }
    }
    catch {}
  }

  cache.set(key, details)
  return details
}

export async function hasTrustedPublisher(name: string, version: string, cache: Map<string, boolean>): Promise<boolean> {
  const key = `${name}@${version}`
  if (cache.has(key))
    return cache.get(key) as boolean
  try {
    const meta = await httpJson(packageMetadataUrl(name))
    const ver = meta && meta.versions && meta.versions[version]
    const tp = Boolean(ver && ver._npmUser && ver._npmUser.trustedPublisher)
      || Boolean(ver && ver._npmUser && ver._npmUser.name === 'GitHub Actions' && ver._npmUser.email === 'npm-oidc-no-reply@github.com')
    cache.set(key, tp)
    return tp
  }
  catch {
    cache.set(key, false)
    return false
  }
}

export async function hasStagedPublish(name: string, version: string, cache: Map<string, boolean>): Promise<boolean> {
  const key = `${name}@${version}`
  if (cache.has(key))
    return cache.get(key) as boolean
  try {
    const meta = await httpJson(packageMetadataUrl(name))
    const ver = meta && meta.versions && meta.versions[version]
    const staged = Boolean(ver && ver._npmUser && ver._npmUser.approver)
    cache.set(key, staged)
    return staged
  }
  catch {
    cache.set(key, false)
    return false
  }
}

function packageMetadataUrl(name: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}`
}

function httpJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      const { statusCode } = res
      if (!statusCode) {
        reject(new Error('No status code'))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', d => chunks.push(typeof d === 'string' ? Buffer.from(d) : d))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (statusCode < 200 || statusCode >= 300) {
          const err: any = new Error(`HTTP ${statusCode} for ${url}`)
          err.statusCode = statusCode
          err.body = body
          reject(err)
          return
        }
        try {
          resolve(body ? JSON.parse(body) : {})
        }
        catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
  })
}

export function extractRepoAndRef(att: any): { repository?: string, ref?: string } {
  const stmt = att?.statement || att?.envelope || att
  const predicate = stmt?.predicate || att?.predicate
  const bd = predicate?.buildDefinition || predicate?.buildConfig || predicate?.build || {}
  const ext = bd?.externalParameters || bd?.externalParametersJSON || {}
  const workflow = ext?.workflow || ext?.github?.workflow || {}
  const invocation = predicate?.invocation || {}
  const configSource = invocation?.configSource || {}

  let repository: string | undefined
  let ref: string | undefined

  if (typeof workflow?.repository === 'string')
    repository = normalizeRepository(workflow.repository)
  if (typeof workflow?.ref === 'string')
    ref = workflow.ref

  const uri = typeof configSource?.uri === 'string' ? configSource.uri : undefined
  if (!repository || !ref) {
    const parsed = uri ? parseRepoRefFromUri(uri) : undefined
    if (parsed) {
      repository = repository || parsed.repository
      ref = ref || parsed.ref
    }
  }

  if (!repository) {
    const deps = Array.isArray(bd?.resolvedDependencies) ? bd.resolvedDependencies : []
    for (const d of deps) {
      const u = typeof d?.uri === 'string' ? d.uri : undefined
      const parsed = u ? parseRepoRefFromUri(u) : undefined
      if (parsed?.repository) {
        repository = parsed.repository
        break
      }
    }
  }

  return { repository, ref }
}

export function normalizeRepository(repo: string): string {
  if (/^[^\s/]+\/[^^\s/]+$/.test(repo))
    return repo.replace(/\.git$/, '')
  try {
    const url = new URL(repo.replace(/^git\+/, ''))
    if (url.hostname === 'github.com' || url.hostname.endsWith('.github.com')) {
      const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
      if (parts.length >= 2)
        return `${parts[0]}/${parts[1]}`
    }
  }
  catch {}
  return repo
}

export function parseRepoRefFromUri(uri: string): { repository?: string, ref?: string } | undefined {
  try {
    const cleaned = uri.replace(/^git\+/, '')
    const at = cleaned.lastIndexOf('@')
    let repoUrl = cleaned
    let ref: string | undefined
    if (at > cleaned.indexOf('://') + 2) {
      repoUrl = cleaned.slice(0, at)
      ref = cleaned.slice(at + 1)
    }
    const url = new URL(repoUrl)
    const allowedHosts = ['github.com', 'www.github.com']
    if (!allowedHosts.includes(url.hostname))
      return undefined
    const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
    if (parts.length < 2)
      return undefined
    const repository = `${parts[0]}/${parts[1]}`
    return { repository, ref }
  }
  catch {
    return undefined
  }
}

export function normalizeRefToBranch(ref?: string): string | undefined {
  if (!ref || typeof ref !== 'string')
    return undefined
  if (ref.startsWith('refs/heads/'))
    return ref.slice('refs/heads/'.length)
  return undefined
}
