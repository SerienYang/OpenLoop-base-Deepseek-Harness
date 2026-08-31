import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ShellKey } from './locales.ts'
import css from './OpenloopSettings.module.css'

/** Application identity shown by the About section. */
export type AppView =
  | { readonly state: 'loading' }
  | {
    readonly state: 'ready'
    readonly version: string
    readonly channel: 'test' | 'stable'
    readonly dshCommit: string
    readonly attribution: 'Built on DeepSeek Harness'
  }
  | { readonly state: 'error'; readonly message?: string }

export type UpdatePhase =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'failed'
  | 'downloading'
  | 'verifying'
  | 'ready-to-install'
  | 'installing'
  | 'restarting'
  | 'committed'
  | 'rolled-back'

export interface UpdateActionView {
  readonly enabled: boolean
  readonly pending?: boolean
}

/** Update state shown by the About section. */
export interface UpdateView {
  readonly phase: UpdatePhase
  readonly lastCheckedAt?: string
  readonly targetVersion?: string
  readonly message?: string
  readonly progress?: number
  readonly actions: {
    readonly check: UpdateActionView
    readonly installAndRestart: UpdateActionView
  }
}

const APP_ERROR: AppView = Object.freeze({ state: 'error' })
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const DSH_COMMIT = /^[0-9a-f]{40}$/u

/** Parse browser bootstrap identity into a presentation-only view. */
export function parseBootstrapAppView(value: unknown): AppView {
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || !Object.isFrozen(value)) {
    return APP_ERROR
  }
  const manifest = (value as { readonly coreManifest?: unknown }).coreManifest
  if (typeof manifest !== 'object'
    || manifest === null
    || Array.isArray(manifest)
    || !Object.isFrozen(manifest)) {
    return APP_ERROR
  }
  const record = manifest as Readonly<Record<string, unknown>>
  const brand = record.brand
  if (typeof record.appVersion !== 'string'
    || !SEMVER.test(record.appVersion)
    || (record.channel !== 'test' && record.channel !== 'stable')
    || typeof record.dshCommit !== 'string'
    || !DSH_COMMIT.test(record.dshCommit)
    || typeof brand !== 'object'
    || brand === null
    || Array.isArray(brand)
    || !Object.isFrozen(brand)
    || (brand as Readonly<Record<string, unknown>>).attribution
      !== 'Built on DeepSeek Harness') {
    return APP_ERROR
  }
  return {
    state: 'ready',
    version: record.appVersion,
    channel: record.channel,
    dshCommit: record.dshCommit,
    attribution: 'Built on DeepSeek Harness',
  }
}

export interface AboutUpdateSectionProps extends Partial<PropsLocale<'openloop.shell'>> {
  readonly app: AppView
  readonly update: UpdateView
  readonly onCheck: () => void
  readonly onInstallAndRestart: () => void
}

const ENGLISH: Partial<Record<ShellKey, string>> = {
  aboutTitle: 'About Openloop',
  aboutLoading: 'Loading build information…',
  aboutUnavailable: 'Openloop build information is unavailable.',
  aboutVersion: 'Version',
  aboutChannel: 'Channel',
  aboutDshCommit: 'DSH commit',
  updateTitle: 'Updates',
  updateLastChecked: 'Last checked',
  updateNeverChecked: 'Never',
  updateTargetVersion: 'Target version',
  updateUnavailable: 'Update service unavailable',
  updateIdle: 'Ready to check',
  updateChecking: 'Checking for updates',
  updateUpToDate: 'Openloop is up to date',
  updateAvailable: 'Update available',
  updateFailed: 'Update failed',
  updateDownloading: 'Downloading update',
  updateVerifying: 'Verifying update',
  updateReadyToInstall: 'Ready to install',
  updateInstalling: 'Installing update',
  updateRestarting: 'Restarting',
  updateCommitted: 'Update installed',
  updateRolledBack: 'Update rolled back',
  updateCheck: 'Check for updates',
  updateInstallRestart: 'Install and restart',
  updateProgress: 'Update progress',
}

function phaseKey(phase: UpdatePhase): ShellKey {
  const keys: Record<UpdatePhase, ShellKey> = {
    unavailable: 'updateUnavailable',
    idle: 'updateIdle',
    checking: 'updateChecking',
    'up-to-date': 'updateUpToDate',
    available: 'updateAvailable',
    failed: 'updateFailed',
    downloading: 'updateDownloading',
    verifying: 'updateVerifying',
    'ready-to-install': 'updateReadyToInstall',
    installing: 'updateInstalling',
    restarting: 'updateRestarting',
    committed: 'updateCommitted',
    'rolled-back': 'updateRolledBack',
  }
  return keys[phase]
}

/** Present application and update status without owning transport state. */
export function AboutUpdateSection({
  app,
  update,
  onCheck,
  onInstallAndRestart,
  t,
}: AboutUpdateSectionProps) {
  const text = (key: ShellKey): string => t?.(key) ?? ENGLISH[key] ?? key
  return (
    <section className={css.aboutSection}>
      <div className={css.sectionHeading}>
        <h3>{text('aboutTitle')}</h3>
      </div>
      {app.state === 'loading' && <p role="status">{text('aboutLoading')}</p>}
      {app.state === 'error' && <p role="alert">{app.message ?? text('aboutUnavailable')}</p>}
      {app.state === 'ready' && (
        <>
          <p className={css.attribution}>{app.attribution}</p>
          <dl className={css.facts}>
            <div><dt>{text('aboutVersion')}</dt><dd>{app.version}</dd></div>
            <div><dt>{text('aboutChannel')}</dt><dd>{app.channel}</dd></div>
            <div><dt>{text('aboutDshCommit')}</dt><dd><code>{app.dshCommit}</code></dd></div>
          </dl>
        </>
      )}

      <div className={css.update}>
        <div className={css.sectionHeading}>
          <h3>{text('updateTitle')}</h3>
        </div>
        <dl className={css.facts}>
          <div>
            <dt>{text('updateLastChecked')}</dt>
            <dd>{update.lastCheckedAt ?? text('updateNeverChecked')}</dd>
          </div>
          {update.targetVersion !== undefined && (
            <div><dt>{text('updateTargetVersion')}</dt><dd>{update.targetVersion}</dd></div>
          )}
        </dl>
        <p role={update.phase === 'failed' ? 'alert' : 'status'}>
          {update.message ?? text(phaseKey(update.phase))}
        </p>
        {update.progress !== undefined && (
          <progress
            aria-label={text('updateProgress')}
            max={100}
            value={Math.max(0, Math.min(100, update.progress))}
          />
        )}
        <div className={css.updateActions}>
          <button
            type="button"
            disabled={!update.actions.check.enabled || update.actions.check.pending === true}
            onClick={onCheck}
          >
            {text('updateCheck')}
          </button>
          <button
            type="button"
            disabled={!update.actions.installAndRestart.enabled
              || update.actions.installAndRestart.pending === true}
            onClick={onInstallAndRestart}
          >
            {text('updateInstallRestart')}
          </button>
        </div>
      </div>
    </section>
  )
}
