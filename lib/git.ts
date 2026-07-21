import { execFile as _execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execFile = promisify(_execFile)

const ORIGIN_HEAD_RE = /refs\/remotes\/origin\/(.*)$/

export async function guessDefaultBaseRef(): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: process.cwd() })
    const m = stdout.trim().match(ORIGIN_HEAD_RE)
    if (m)
      return `origin/${m[1]}`
  }
  catch {}
  return 'origin/main'
}

export async function gitShowFile(ref: string, filePath: string, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['show', `${ref}:${filePath}`], { cwd })
    return stdout
  }
  catch {
    try {
      const { stdout } = await execFile('git', ['show', `HEAD^:${filePath}`], { cwd })
      return stdout
    }
    catch {
      return undefined
    }
  }
}
