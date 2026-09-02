/** Largest decoded payload carried by one file broker bridge chunk. */
export const MAX_FILE_CHUNK_BYTES = 32 * 1024

declare const normalizedRelativePathBrand: unique symbol

/** A non-empty, slash-separated Workspace-relative path. */
export type NormalizedRelativePath = string & {
  readonly [normalizedRelativePathBrand]: true
}

const encodedTraversal = /%(?:25|2e|2f|5c)/iu
const windowsDrive = /^[a-z]:/iu

/**
 * Reject path syntax with platform-dependent or traversal semantics.
 *
 * The explicit `.` root marker is reserved for the package's internal
 * `openRoot` call and is never accepted from callers as a relative path.
 */
export function normalizeRelativePath(path: string): NormalizedRelativePath {
  const segments = path.split('/')
  if (path.length === 0
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || windowsDrive.test(path)
    || encodedTraversal.test(path)
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError('Workspace relative path must be non-empty and normalized')
  }
  return path as NormalizedRelativePath
}
