import { useNavigate } from '@tanstack/react-router'
import { useAuthenticatedApi } from '../../AuthContext'
import { useDocumentTitle } from '../../useDocumentTitle'
import { BotLibrary } from './BotLibrary'

export function BotsPage() {
  useDocumentTitle('Bots')
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const navigate = useNavigate()
  // Resolve identity before an editor can open; assigning its account key must not reset a draft.
  if (!currentUser) return <div role="status" className="mx-auto w-full max-w-7xl px-4 py-8 text-sm text-kumo-subtle sm:px-8 sm:py-12">Loading your account…</div>
  return <BotLibrary key={currentUser.id} api={authenticatedApi} onUseBot={id => { void navigate({ to: '/', search: { bot: id } }) }} />
}
