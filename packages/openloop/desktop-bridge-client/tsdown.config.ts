import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@openloop/desktop-bridge-client',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
