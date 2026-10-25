import { Code, MagnifyingGlass, Notebook, Sparkle } from '@phosphor-icons/react'
import type { BotProfile } from '@gadgets/workshop-shared/api'

export const BOT_ICONS: Record<BotProfile['icon'], { label: string; Component: typeof Sparkle; color: string }> = {
  spark: { label: 'Spark', Component: Sparkle, color: 'text-violet-600 dark:text-violet-300 bg-violet-500/10' },
  search: { label: 'Research', Component: MagnifyingGlass, color: 'text-sky-700 dark:text-sky-300 bg-sky-500/10' },
  code: { label: 'Code', Component: Code, color: 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/10' },
  notebook: { label: 'Writing', Component: Notebook, color: 'text-amber-700 dark:text-amber-300 bg-amber-500/10' },
}

export function BotIcon({ icon, small = false }: { icon: BotProfile['icon']; small?: boolean }) {
  const { Component, color } = BOT_ICONS[icon]
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-xl ${color} ${small ? 'h-7 w-7' : 'h-11 w-11'}`}>
    <Component size={small ? 15 : 22} weight="duotone" />
  </span>
}
