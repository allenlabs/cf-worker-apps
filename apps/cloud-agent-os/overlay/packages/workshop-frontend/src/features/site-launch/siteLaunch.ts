import { getSiteLaunchErrorCode, type AuthenticatedApi, type SiteLaunchErrorCode, type SiteLaunchRedemption } from '@gadgets/workshop-shared/api'

export const parseSiteLaunchParentOrigins = (value: string | undefined): string[] => {
  if (!value) return []
  try {
    const origins: unknown = JSON.parse(value)
    if (!Array.isArray(origins) || origins.length === 0 || origins.length > 10 ||
      new Set(origins).size !== origins.length) return []
    if (!origins.every(origin => {
      if (typeof origin !== 'string') return false
      const url = new URL(origin)
      return url.origin === origin && url.protocol === 'https:' && !url.port &&
        !url.username && !url.password && url.hostname !== 'workers.dev' && !url.hostname.endsWith('.workers.dev')
    })) return []
    return origins
  } catch { return [] }
}

export type SiteLaunchResultCode = SiteLaunchErrorCode | 'site_launch_failed' | 'site_launch_unavailable'
export type SiteLaunchState =
  | { status: 'unavailable' | 'waiting' | 'busy' | 'ready' }
  | { status: 'sign-in-required' }
  | { status: 'error'; code: SiteLaunchResultCode }

type LaunchApi = Pick<AuthenticatedApi, 'redeemSiteLaunch'>
type LaunchMessage =
  | { type: 'cloud-agent-os:host-init'; protocol: 1 }
  | { type: 'cloud-agent-os:site-launch'; protocol: 1; ticket: string }

const parseMessage = (data: unknown): LaunchMessage | null => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const fields = data as Record<string, unknown>
  if (fields.protocol !== 1) return null
  if (fields.type === 'cloud-agent-os:host-init' && Object.keys(fields).length === 2) {
    return { type: fields.type, protocol: 1 }
  }
  if (fields.type === 'cloud-agent-os:site-launch' && Object.keys(fields).length === 3 &&
    typeof fields.ticket === 'string' && /^[0-9a-f]{64}$/.test(fields.ticket)) {
    return { type: fields.type, protocol: 1, ticket: fields.ticket }
  }
  return null
}

type Options = {
  allowedOrigins: string[]
  parent: MessageEventSource | null
  post: (message: unknown, origin: string) => void
  onWorkspace: (result: SiteLaunchRedemption) => void
  onState: (state: SiteLaunchState) => void
}

export class SiteLaunchSession {
  private parentOrigin: string | null = null
  private announced = false
  private authReady = false
  private api: LaunchApi | null = null
  private pendingTicket: string | null = null
  private seenTickets = new Set<string>()
  private generation = 0
  private disposed = false
  private state: SiteLaunchState

  constructor(private options: Options) {
    this.state = { status: options.allowedOrigins.length && options.parent ? 'waiting' : 'unavailable' }
  }

  receive(event: Pick<MessageEvent, 'data' | 'origin' | 'source'>) {
    if (this.disposed || !this.options.parent || event.source !== this.options.parent ||
      !this.options.allowedOrigins.includes(event.origin)) return
    const message = parseMessage(event.data)
    if (!message) return
    if (message.type === 'cloud-agent-os:host-init') {
      if (this.parentOrigin && this.parentOrigin !== event.origin) return
      this.parentOrigin = event.origin
      this.announce()
      return
    }
    if (event.origin !== this.parentOrigin || !this.announced || !this.authReady ||
      this.state.status === 'busy' || this.state.status === 'ready' ||
      this.seenTickets.has(message.ticket) || this.seenTickets.size >= 64) return
    this.seenTickets.add(message.ticket)
    this.pendingTicket = message.ticket
    this.redeem()
  }

  setAuthentication(api: LaunchApi | null, ready: boolean) {
    if (this.disposed) return
    if (this.api !== api) {
      this.generation++
      if (this.state.status === 'busy') this.update({ status: 'sign-in-required' })
    }
    this.api = api
    this.authReady = ready
    this.announce()
    if (ready && this.pendingTicket && this.state.status === 'sign-in-required' && api) this.redeem()
  }

  private announce() {
    if (!this.authReady || !this.parentOrigin || this.announced) return
    this.announced = true
    this.options.post({ type: 'cloud-agent-os:ready', protocol: 1 }, this.parentOrigin)
  }

  private update(state: SiteLaunchState) {
    this.state = state
    this.options.onState(state)
  }

  private failure(code: SiteLaunchResultCode) {
    this.update(code === 'site_launch_sign_in_required' ? { status: 'sign-in-required' } : { status: 'error', code })
    if (this.parentOrigin) this.options.post({ type: 'cloud-agent-os:site-launch-result', protocol: 1,
      status: 'error', code }, this.parentOrigin)
  }

  private redeem() {
    const api = this.api
    const ticket = this.pendingTicket
    if (!ticket) return
    if (!api) { this.failure('site_launch_sign_in_required'); return }
    const generation = ++this.generation
    this.update({ status: 'busy' })
    void (async () => {
      try {
        const result = await api.redeemSiteLaunch(ticket)
        if (this.disposed || generation !== this.generation) return
        this.pendingTicket = null
        this.update({ status: 'ready' })
        if (this.parentOrigin) this.options.post({ type: 'cloud-agent-os:site-launch-result', protocol: 1,
          status: 'ready' }, this.parentOrigin)
        this.options.onWorkspace(result)
      } catch (error) {
        if (this.disposed || generation !== this.generation) return
        const code = getSiteLaunchErrorCode(error) ?? 'site_launch_failed'
        if (code !== 'site_launch_sign_in_required') this.pendingTicket = null
        this.failure(code)
      }
    })()
  }

  dispose() {
    this.disposed = true
    this.generation++
    this.pendingTicket = null
    this.seenTickets.clear()
    this.api = null
  }
}
