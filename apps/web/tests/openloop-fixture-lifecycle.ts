interface Closeable {
  close(): Promise<void>
}

interface FixtureWorld<TBridge extends Closeable, TScaffold extends Closeable> {
  readonly bridge: TBridge
  readonly scaffold: TScaffold
}

interface FixtureWorldDependencies<TBridge extends Closeable, TScaffold extends Closeable> {
  readonly startBridge: () => Promise<TBridge>
  readonly launchScaffold: (bridge: TBridge) => Promise<TScaffold>
}

interface ClosingFixtureWorld {
  readonly bridge?: Closeable | undefined
  readonly scaffold?: Closeable | undefined
}

export async function startFixtureWorld<
  TBridge extends Closeable,
  TScaffold extends Closeable,
>(
  dependencies: FixtureWorldDependencies<TBridge, TScaffold>,
): Promise<FixtureWorld<TBridge, TScaffold>> {
  const bridge = await dependencies.startBridge()
  try {
    const scaffold = await dependencies.launchScaffold(bridge)
    return { bridge, scaffold }
  } catch (startupError) {
    try {
      await bridge.close()
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        'fixture startup failed and bridge cleanup failed',
      )
    }
    throw startupError
  }
}

export async function cleanupFixtureWorld(
  world: ClosingFixtureWorld,
  report: (message: string) => void = (message) => { console.error(message) },
): Promise<0 | 1> {
  const failures: unknown[] = []
  await world.scaffold?.close().catch((error: unknown) => failures.push(error))
  await world.bridge?.close().catch((error: unknown) => failures.push(error))
  if (failures.length === 0) return 0
  const error = new AggregateError(failures, 'fixture cleanup failed')
  const details = failures
    .map(failure => failure instanceof Error ? failure.stack ?? failure.message : String(failure))
    .join('\n')
  report(`${error.stack ?? error.message}\n${details}`)
  return 1
}
