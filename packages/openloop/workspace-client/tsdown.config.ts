import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@openloop/workspace-client',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
