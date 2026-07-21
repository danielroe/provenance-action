import type { ProvenanceDetails } from './provenance.ts'
import { join } from 'node:path'
import process from 'node:process'
import { annotate, appendSummary, getInput, log, logError, setOutput } from './gh.ts'
import { gitShowFile, guessDefaultBaseRef } from './git.ts'
import { detectLockfile, diffDependencySets, findLockfileLine, matchesTrustPolicyExclude, parseLockfile, parsePnpmWorkspaceConfig, readTextFile, supportedLockfiles } from './lockfile.ts'
import { getProvenanceDetails, hasProvenance, hasStagedPublish, hasTrustedPublisher } from './provenance.ts'

export async function run(): Promise<void> {
  try {
    const workspacePath = getInput('workspace-path') || process.env.GITHUB_WORKSPACE || process.cwd()
    const lockfileInput = getInput('lockfile')
    const baseRefInput = getInput('base-ref')
    const failOnDowngradeValue = (getInput('fail-on-downgrade') || 'true').toLowerCase()
    const failAnyDowngrade = failOnDowngradeValue === 'true'
      || failOnDowngradeValue === 'any'
      || failOnDowngradeValue === ''
    const failOnlyProvenanceLoss = failOnDowngradeValue === 'only-provenance-loss'
    const failOnProvChange = (getInput('fail-on-provenance-change') || 'false').toLowerCase() === 'true'

    const lockfilePath = lockfileInput || detectLockfile(workspacePath)
    if (!lockfilePath) {
      log(`No supported lockfile found. Supported: ${supportedLockfiles.join(', ')}`)
      return
    }

    const absLockfilePath = join(workspacePath, lockfilePath)
    const headContent = readTextFile(absLockfilePath)

    const baseRef = baseRefInput || process.env.GITHUB_BASE_REF || await guessDefaultBaseRef()
    const baseContent = await gitShowFile(baseRef, lockfilePath, workspacePath)
    if (!baseContent) {
      log(`Could not read base lockfile from ref "${baseRef}". Nothing to compare.`)
      return
    }

    const currentDeps = parseLockfile(lockfilePath, headContent)
    const previousDeps = parseLockfile(lockfilePath, baseContent)

    const changed = diffDependencySets(previousDeps, currentDeps)
    if (changed.length === 0) {
      log('No dependency version changes detected in lockfile.')
      return
    }

    // Read trustPolicyExclude from pnpm-workspace.yaml (only for pnpm lockfiles)
    const trustPolicyExclude = lockfilePath.endsWith('pnpm-lock.yaml')
      ? parsePnpmWorkspaceConfig(workspacePath).trustPolicyExclude || []
      : []
    if (trustPolicyExclude.length > 0) {
      log(`Loaded ${trustPolicyExclude.length} trustPolicyExclude pattern(s) from pnpm-workspace.yaml`)
    }

    const provenanceCache = new Map<string, boolean>()
    const provenanceDetailsCache = new Map<string, ProvenanceDetails>()
    const trustedPublisherCache = new Map<string, boolean>()
    const stagedPublishCache = new Map<string, boolean>()
    type DowngradeType = 'provenance' | 'trusted_publisher' | 'staged_publish'
    interface DowngradeEvent { name: string, from: string, to: string, downgradeType: DowngradeType, keptProvenance?: boolean }
    const events: DowngradeEvent[] = []
    type ChangeWarningType = 'repo_changed' | 'branch_changed'
    interface ChangeWarning { name: string, from: string, to: string, type: ChangeWarningType, prevRepo?: string, newRepo?: string, prevBranch?: string, newBranch?: string }
    const warnings: ChangeWarning[] = []

    for (const change of changed) {
      if (change.previous.size === 0 || change.current.size === 0)
        continue

      for (const newVersion of change.current) {
        if (change.previous.has(newVersion))
          continue

        // Skip packages that match trustPolicyExclude patterns
        if (trustPolicyExclude.length > 0 && matchesTrustPolicyExclude(change.name, newVersion, trustPolicyExclude)) {
          log(`Skipping ${change.name}@${newVersion} (excluded by trustPolicyExclude)`)
          continue
        }

        const [hasProvNew, newDetails, hasTPNew, hasStagedNew] = await Promise.all([
          hasProvenance(change.name, newVersion, provenanceCache),
          getProvenanceDetails(change.name, newVersion, provenanceDetailsCache),
          hasTrustedPublisher(change.name, newVersion, trustedPublisherCache),
          hasStagedPublish(change.name, newVersion, stagedPublishCache),
        ])

        if (!hasStagedNew) {
          for (const prevVersion of change.previous) {
            const hadStagedPrev = await hasStagedPublish(change.name, prevVersion, stagedPublishCache)
            if (hadStagedPrev) {
              events.push({ name: change.name, from: prevVersion, to: newVersion, downgradeType: 'staged_publish', keptProvenance: hasProvNew })
              break
            }
          }
        }

        if (!hasTPNew) {
          for (const prevVersion of change.previous) {
            const hadTPPrev = await hasTrustedPublisher(change.name, prevVersion, trustedPublisherCache)
            if (hadTPPrev) {
              events.push({ name: change.name, from: prevVersion, to: newVersion, downgradeType: 'trusted_publisher', keptProvenance: hasProvNew })
              break
            }
          }
        }

        if (!hasProvNew) {
          for (const prevVersion of change.previous) {
            const hadProv = await hasProvenance(change.name, prevVersion, provenanceCache)
            if (hadProv) {
              events.push({ name: change.name, from: prevVersion, to: newVersion, downgradeType: 'provenance' })
              break
            }
          }
          continue
        }

        for (const prevVersion of change.previous) {
          const prevDetails = await getProvenanceDetails(change.name, prevVersion, provenanceDetailsCache)
          if (!prevDetails.has)
            continue
          if (prevDetails.repository && newDetails.repository && prevDetails.repository !== newDetails.repository) {
            warnings.push({ name: change.name, from: prevVersion, to: newVersion, type: 'repo_changed', prevRepo: prevDetails.repository, newRepo: newDetails.repository })
            break
          }
          const prevBranch = prevDetails.branch
          const newBranch = newDetails.branch
          if (prevBranch && newBranch && prevBranch !== newBranch) {
            warnings.push({ name: change.name, from: prevVersion, to: newVersion, type: 'branch_changed', prevBranch, newBranch })
            break
          }
        }
      }
    }

    if (events.length === 0) {
      log('No downgrades detected.')
      setOutput('downgraded', '[]')
      if (warnings.length === 0) {
        setOutput('changed', '[]')
        return
      }
    }

    if (events.length > 0) {
      const summaryLines = events.map(d => `- ${d.name}: ${d.from} -> ${d.to} [${d.downgradeType}${d.downgradeType !== 'provenance' && d.keptProvenance ? ', kept provenance' : ''}]`)
      log('Detected dependency downgrades:')
      for (const line of summaryLines) log(line)
      appendSummary(['Dependency downgrades:', ...summaryLines].join('\n'))
    }

    if (warnings.length > 0) {
      const warnLines = warnings.map((w) => {
        if (w.type === 'repo_changed')
          return `- ${w.name}: ${w.from} -> ${w.to} [provenance repository changed: ${w.prevRepo} -> ${w.newRepo}]`
        return `- ${w.name}: ${w.from} -> ${w.to} [provenance branch changed: ${w.prevBranch} -> ${w.newBranch}]`
      })
      log('Detected provenance changes:')
      for (const line of warnLines) log(line)
      appendSummary(['Provenance changes:', ...warnLines].join('\n'))
    }

    for (const d of events) {
      const line = findLockfileLine(lockfilePath, headContent, d.name, d.to)
      const shouldFail = (failAnyDowngrade || (failOnlyProvenanceLoss && d.downgradeType === 'provenance'))
      const level: 'error' | 'warning' = shouldFail ? 'error' : 'warning'
      const base = d.downgradeType === 'provenance'
        ? 'lost npm provenance'
        : d.downgradeType === 'staged_publish' ? 'lost staged publishing' : 'lost trusted publisher'
      const extra = d.downgradeType !== 'provenance' && d.keptProvenance ? ' (kept provenance)' : ''
      const msg = `${d.name} ${base}: ${d.from} -> ${d.to}${extra}`
      if (line)
        annotate(level, lockfilePath, line, 1, msg)
      else annotate(level, lockfilePath, 1, 1, msg)
    }

    for (const w of warnings) {
      const line = findLockfileLine(lockfilePath, headContent, w.name, w.to)
      const msg = w.type === 'repo_changed'
        ? `${w.name} provenance repository changed: ${w.prevRepo} -> ${w.newRepo}`
        : `${w.name} provenance branch changed: ${w.prevBranch} -> ${w.newBranch}`
      const level = failOnProvChange ? 'error' : 'warning'
      if (line)
        annotate(level, lockfilePath, line, 1, msg)
      else annotate(level, lockfilePath, 1, 1, msg)
    }

    const outputEvents = events.map(e => ({ name: e.name, from: e.from, to: e.to, downgradeType: e.downgradeType }))
    setOutput('downgraded', JSON.stringify(outputEvents))
    const changedOutput = warnings.map(w => ({
      name: w.name,
      from: w.from,
      to: w.to,
      type: w.type,
      previousRepository: w.prevRepo,
      newRepository: w.newRepo,
      previousBranch: w.prevBranch,
      newBranch: w.newBranch,
    }))
    setOutput('changed', JSON.stringify(changedOutput))

    if (failAnyDowngrade || failOnlyProvenanceLoss || failOnProvChange) {
      const hasFailDowngrade = events.some(e => failAnyDowngrade || (failOnlyProvenanceLoss && e.downgradeType === 'provenance'))
      const hasFailProvChange = failOnProvChange && warnings.length > 0
      if (hasFailDowngrade || hasFailProvChange)
        process.exitCode = 1
    }
  }
  catch (err) {
    logError(err)
    process.exitCode = 1
  }
}
