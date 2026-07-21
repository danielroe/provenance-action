import { writeFileSync } from 'node:fs'
import process from 'node:process'

const INPUT_SEPARATORS_RE = /[ -]/g

export function getInput(name: string): string | undefined {
  const key = `INPUT_${name.replace(INPUT_SEPARATORS_RE, '_').toUpperCase()}`
  return process.env[key]
}

export function setOutput(name: string, value: string): void {
  const filepath = process.env.GITHUB_OUTPUT
  if (!filepath)
    return
  writeFileSync(filepath, `${name}<<__EOF__\n${value}\n__EOF__\n`, { encoding: 'utf8', flag: 'a' })
}

export function appendSummary(text: string): void {
  const filepath = process.env.GITHUB_STEP_SUMMARY
  if (!filepath)
    return
  writeFileSync(filepath, `${text}\n`, { encoding: 'utf8', flag: 'a' })
}

export function log(message: any): void {
  // eslint-disable-next-line no-console
  console.log(String(message))
}

export function logError(err: any): void {
  console.error(err instanceof Error ? err.stack || err.message : String(err))
}

const PERCENT_RE = /%/g
const CR_RE = /\r/g
const LF_RE = /\n/g

export function annotate(level: 'error' | 'warning', file: string, line: number, col: number, message: string): void {
  const esc = (s: string) => String(s)
    .replace(PERCENT_RE, '%25')
    .replace(CR_RE, '%0D')
    .replace(LF_RE, '%0A')
  // eslint-disable-next-line no-console
  console.log(`::${level} file=${file},line=${line},col=${col}::${esc(message)}`)
}
