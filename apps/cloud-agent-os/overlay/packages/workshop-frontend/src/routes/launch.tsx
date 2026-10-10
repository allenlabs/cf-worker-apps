import { createFileRoute } from '@tanstack/react-router'
import { SiteLaunchPage } from '../features/site-launch/SiteLaunchPage'

export const Route = createFileRoute('/launch')({ component: SiteLaunchPage })
