const SIDEBAR_WIDTH = 280
const SIDEBAR_COLLAPSED_WIDTH = 56
const DETAILS_WIDTH = 360
const DETAILS_MIN_WIDTH = 300
const WORKSPACE_MIN_WIDTH = 640

export interface OpenloopColumns {
  sidebar: number
  workspace: number
  details: number
}

/** Resolve shell columns without mutating the user's stored panel preferences. */
export function computeOpenloopColumns(
  viewport: number,
  sidebarOpen: boolean,
  detailsOpen: boolean,
): OpenloopColumns {
  const available = Math.max(0, Math.round(viewport))
  const sidebar = sidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH
  const preferredDetails = detailsOpen ? DETAILS_WIDTH : 0

  if (sidebar + preferredDetails + WORKSPACE_MIN_WIDTH <= available) {
    return {
      sidebar,
      workspace: available - sidebar - preferredDetails,
      details: preferredDetails,
    }
  }

  const concededDetails = preferredDetails === 0
    ? 0
    : Math.max(DETAILS_MIN_WIDTH, available - sidebar - WORKSPACE_MIN_WIDTH)
  if (sidebar + concededDetails + WORKSPACE_MIN_WIDTH <= available) {
    return { sidebar, workspace: WORKSPACE_MIN_WIDTH, details: concededDetails }
  }

  return {
    sidebar,
    workspace: Math.max(0, available - sidebar),
    details: 0,
  }
}
