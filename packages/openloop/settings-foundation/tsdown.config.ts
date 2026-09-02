import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@openloop/settings-foundation',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
