import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DeepResearchProcess {
  stdout: NodeJS.EventEmitter | null
  stderr: NodeJS.EventEmitter | null
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface DeepResearchSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface DeepResearchSystemdController {
  isAvailable(): Promise<boolean>
  spawnTransient(args: string[], options: DeepResearchSpawnOptions): DeepResearchProcess
  killUnit(unitName: string, signal: 'TERM' | 'KILL'): Promise<void>
  isUnitActive(unitName: string): Promise<boolean>
}

export interface NodeSystemdControllerOptions {
  systemdRunCommand?: string
  systemctlCommand?: string
  execFileImpl?: typeof execFileAsync
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
}

export class NodeSystemdController implements DeepResearchSystemdController {
  private readonly systemdRunCommand: string
  private readonly systemctlCommand: string
  private readonly execFileImpl: typeof execFileAsync
  private readonly spawnImpl: (command: string, args: string[], options: SpawnOptions) => ChildProcess

  constructor(options: NodeSystemdControllerOptions = {}) {
    this.systemdRunCommand = options.systemdRunCommand ?? 'systemd-run'
    this.systemctlCommand = options.systemctlCommand ?? 'systemctl'
    this.execFileImpl = options.execFileImpl ?? execFileAsync
    this.spawnImpl = options.spawnImpl ?? spawn
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false
    try {
      await this.execFileImpl(this.systemdRunCommand, ['--version'])
      await this.execFileImpl(this.systemctlCommand, ['--version'])
      await this.execFileImpl(this.systemctlCommand, ['show', '--property=Version', '--value'])
      return true
    } catch {
      return false
    }
  }

  spawnTransient(args: string[], options: DeepResearchSpawnOptions): DeepResearchProcess {
    return this.spawnImpl(this.systemdRunCommand, args, {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: options.env,
    }) as DeepResearchProcess
  }

  async killUnit(unitName: string, signal: 'TERM' | 'KILL'): Promise<void> {
    await this.execFileImpl(this.systemctlCommand, [
      'kill',
      '--kill-who=all',
      `--signal=${signal}`,
      unitName,
    ])
  }

  async isUnitActive(unitName: string): Promise<boolean> {
    try {
      await this.execFileImpl(this.systemctlCommand, ['is-active', '--quiet', unitName])
      return true
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 3 || code === 4 || code === '3' || code === '4') return false
      throw error
    }
  }
}
