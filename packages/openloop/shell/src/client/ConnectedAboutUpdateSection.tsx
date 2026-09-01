import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { UpdateView } from '@openloop/desktop-bridge-client/client'
import {
  AboutUpdateSection,
  type AboutUpdateSectionProps,
  type AppView,
} from './AboutUpdateSection.tsx'

interface ConnectedAboutUpdateSectionProps {
  readonly app: AppView
  readonly useUpdate: SnapshotSelectorHook<UpdateView>
  readonly onCheck: () => void
  readonly onInstallAndRestart: () => void
  readonly t?: AboutUpdateSectionProps['t']
}

/** Bind the update service store to the presentation-only About section. */
export function ConnectedAboutUpdateSection({
  useUpdate,
  ...props
}: ConnectedAboutUpdateSectionProps) {
  const update = useUpdate(value => value)
  return (
    <AboutUpdateSection
      app={props.app}
      update={update}
      onCheck={props.onCheck}
      onInstallAndRestart={props.onInstallAndRestart}
      {...props.t === undefined ? {} : { t: props.t }}
    />
  )
}
