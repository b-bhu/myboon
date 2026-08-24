import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ProcessSnapshotRow {
  pid: number
  ppid: number
  pgid: number
  ageMs: number
  command: string
}

export interface HermesOrphanSweepResult {
  staleHermesGroups: number[]
  staleBrowserGroups: number[]
  terminatedGroups: number[]
  killedGroups: number[]
  browserCloseAttempted: boolean
  browserCleanupSkipped: boolean
}

export interface HermesOrphanSweeperOptions {
  maxAgeMs?: number
  killGraceMs?: number
  workspaceRoot?: string
  agentBrowserCommand?: string
  listProcesses?: () => Promise<ProcessSnapshotRow[]>
  closeBrowserSessions?: () => Promise<void>
  protectedBrowserPids?: (livePids: Set<number>) => Set<number>
  signalGroup?: (pgid: number, signal: NodeJS.Signals) => void
  wait?: (ms: number) => Promise<void>
  ownProcessGroupId?: number
  logger?: (message: string) => void
}

const DEFAULT_MAX_AGE_MS = 15 * 60_000
const DEFAULT_KILL_GRACE_MS = 5_000

function parsePsOutput(stdout: string): ProcessSnapshotRow[] {
  const rows: ProcessSnapshotRow[] = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      ageMs: Number(match[4]) * 1_000,
      command: match[5],
    })
  }
  return rows
}

async function listSystemProcesses(): Promise<ProcessSnapshotRow[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pgid=,etimes=,args='], {
    maxBuffer: 10 * 1024 * 1024,
  })
  return parsePsOutput(stdout)
}

function browserPidsWithLiveHermesOwners(livePids: Set<number>): Set<number> {
  const protectedPids = new Set<number>()
  let names: string[]
  try {
    names = readdirSync('/tmp').filter((name) => /^agent-browser-(?:h_|cdp_|hermes_)/.test(name))
  } catch {
    return protectedPids
  }
  for (const name of names) {
    const sessionName = name.replace(/^agent-browser-/, '')
    try {
      const ownerPid = Number(readFileSync(`/tmp/${name}/${sessionName}.owner_pid`, 'utf8').trim())
      const daemonPid = Number(readFileSync(`/tmp/${name}/${sessionName}.pid`, 'utf8').trim())
      if (livePids.has(ownerPid) && Number.isInteger(daemonPid) && daemonPid > 1) {
        protectedPids.add(daemonPid)
      }
    } catch {
      // Legacy and partial socket directories have no trustworthy ownership
      // marker. Their age threshold remains the fallback protection.
    }
  }
  return protectedPids
}

function isHermesInvocation(command: string): boolean {
  if (!/(?:^|\s|\/)(?:hermes)(?:\s|$)/.test(command)) return false
  return /(?:^|\s)chat(?:\s|$)|(?:^|\s)-z(?:\s|$)/.test(command)
}

function isAgentBrowserDaemon(command: string): boolean {
  if (isAgentBrowserChrome(command)) return false
  return /(?:^|\/|\s)agent-browser(?:-[a-z0-9-]+)?(?:\s|$)/i.test(command)
    && !/(?:^|\s)(?:close|session\s+list)(?:\s|$)/.test(command)
}

function isAgentBrowserChrome(command: string): boolean {
  return command.includes('--user-data-dir=/tmp/agent-browser-chrome-')
}

function hasWorkspaceOwner(
  row: ProcessSnapshotRow,
  rowsByPid: Map<number, ProcessSnapshotRow>,
  workspaceRoot: string,
): boolean {
  const visited = new Set<number>()
  let parent = rowsByPid.get(row.ppid)
  while (parent && !visited.has(parent.pid)) {
    visited.add(parent.pid)
    if (parent.command.includes(workspaceRoot)) return true
    parent = rowsByPid.get(parent.ppid)
  }
  return false
}

function groupIsAlive(rows: ProcessSnapshotRow[], pgid: number): boolean {
  return rows.some((row) => row.pgid === pgid)
}

function safeGroups(groups: Iterable<number>, ownProcessGroupId: number): number[] {
  return [...new Set(groups)].filter((pgid) => pgid > 1 && pgid !== ownProcessGroupId)
}

export class HermesOrphanSweeper {
  private readonly maxAgeMs: number
  private readonly killGraceMs: number
  private readonly workspaceRoot: string
  private readonly listProcesses: () => Promise<ProcessSnapshotRow[]>
  private readonly closeBrowserSessions: () => Promise<void>
  private readonly protectedBrowserPids: (livePids: Set<number>) => Set<number>
  private readonly signalGroup: (pgid: number, signal: NodeJS.Signals) => void
  private readonly wait: (ms: number) => Promise<void>
  private readonly ownProcessGroupId: number
  private readonly logger: (message: string) => void

  constructor(options: HermesOrphanSweeperOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.listProcesses = options.listProcesses ?? listSystemProcesses
    this.protectedBrowserPids = options.protectedBrowserPids ?? browserPidsWithLiveHermesOwners
    this.signalGroup = options.signalGroup ?? ((pgid, signal) => process.kill(-pgid, signal))
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.ownProcessGroupId = options.ownProcessGroupId ?? process.pid
    this.logger = options.logger ?? ((message) => console.warn(message))
    const agentBrowserCommand = options.agentBrowserCommand ?? 'agent-browser'
    this.closeBrowserSessions = options.closeBrowserSessions ?? (async () => {
      await execFileAsync(agentBrowserCommand, ['close', '--all'], { timeout: this.killGraceMs })
    })
    if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0) {
      throw new Error('Hermes orphan max age must be positive')
    }
    if (!Number.isFinite(this.killGraceMs) || this.killGraceMs <= 0) {
      throw new Error('Hermes orphan kill grace must be positive')
    }
  }

  async sweep(): Promise<HermesOrphanSweepResult> {
    const initial = await this.listProcesses()
    const rowsByPid = new Map(initial.map((row) => [row.pid, row]))
    const protectedBrowserPids = this.protectedBrowserPids(new Set(rowsByPid.keys()))
    const staleHermesGroups = safeGroups(
      initial
        .filter((row) => isHermesInvocation(row.command))
        .filter((row) => row.ageMs >= this.maxAgeMs)
        .filter((row) => !hasWorkspaceOwner(row, rowsByPid, this.workspaceRoot))
        .map((row) => row.pgid),
      this.ownProcessGroupId,
    )
    const staleBrowserDaemonGroups = safeGroups(
      initial
        .filter((row) => isAgentBrowserDaemon(row.command))
        .filter((row) => row.ageMs >= this.maxAgeMs)
        .filter((row) => !protectedBrowserPids.has(row.pid))
        .map((row) => row.pgid),
      this.ownProcessGroupId,
    )
    const staleChromeGroups = safeGroups(
      initial
        .filter((row) => isAgentBrowserChrome(row.command))
        .filter((row) => row.ageMs >= this.maxAgeMs)
        .map((row) => row.pgid),
      this.ownProcessGroupId,
    )
    const staleBrowserGroups = safeGroups(
      [...staleBrowserDaemonGroups, ...staleChromeGroups],
      this.ownProcessGroupId,
    )

    // Browser daemons deliberately detach and cannot retain a useful Unix
    // ancestry link. Do not close them while any legitimate Hermes call is
    // still alive; its browser may be one of the detached candidates.
    const liveOwnedHermesCall = initial
      .filter((row) => isHermesInvocation(row.command))
      .some((row) => hasWorkspaceOwner(row, rowsByPid, this.workspaceRoot))
    const browserCleanupSkipped = staleChromeGroups.length > 0 && liveOwnedHermesCall
    let browserCloseAttempted = false

    if (staleBrowserGroups.length > 0 && !liveOwnedHermesCall) {
      browserCloseAttempted = true
      try {
        await this.closeBrowserSessions()
        this.logger(`[hermes-sweeper] closed stale browser sessions (${staleBrowserGroups.length} groups)`)
      } catch (error) {
        this.logger(`[hermes-sweeper] browser lifecycle close failed; continuing with process-group cleanup: ${String(error)}`)
      }
    }

    const targetGroups = safeGroups([
      ...staleHermesGroups,
      ...staleBrowserDaemonGroups,
      ...(liveOwnedHermesCall ? [] : staleChromeGroups),
    ], this.ownProcessGroupId)
    const terminatedGroups: number[] = []
    for (const pgid of targetGroups) {
      try {
        this.signalGroup(pgid, 'SIGTERM')
        terminatedGroups.push(pgid)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }

    const killedGroups: number[] = []
    let survivors: number[] = []
    if (terminatedGroups.length > 0) {
      await this.wait(this.killGraceMs)
      const afterGrace = await this.listProcesses()
      for (const pgid of terminatedGroups) {
        if (!groupIsAlive(afterGrace, pgid)) continue
        try {
          this.signalGroup(pgid, 'SIGKILL')
          killedGroups.push(pgid)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await this.wait(Math.min(this.killGraceMs, 1_000))
      const afterKill = await this.listProcesses()
      survivors = terminatedGroups.filter((pgid) => groupIsAlive(afterKill, pgid))
      this.logger(
        `[hermes-sweeper] cleaned orphan groups: term=${terminatedGroups.length} kill=${killedGroups.length} survivors=${survivors.length}`,
      )
      if (survivors.length > 0) {
        this.logger(`[hermes-sweeper] WARNING: process groups still alive after SIGKILL: ${survivors.join(',')}`)
      }
    }

    return {
      staleHermesGroups,
      staleBrowserGroups,
      terminatedGroups,
      killedGroups,
      browserCloseAttempted,
      browserCleanupSkipped,
    }
  }
}
