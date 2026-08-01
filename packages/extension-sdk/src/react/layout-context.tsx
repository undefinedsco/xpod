import { createContext, useContext } from 'react'

export type WorkspaceLayoutMode = 'split' | 'stack'
export type WorkspaceLayoutPane = 'list' | 'main' | 'context'

export interface WorkspaceLayoutNavigation {
  mode: WorkspaceLayoutMode
  activePane: WorkspaceLayoutPane
  openList(): void
  openMain(): void
  openContext(): void
}

export const WorkspaceLayoutContext = createContext<WorkspaceLayoutNavigation | null>(null)

export function useWorkspaceLayout(): WorkspaceLayoutNavigation {
  const navigation = useContext(WorkspaceLayoutContext)
  if (!navigation) {
    throw new Error('useWorkspaceLayout must be used inside TwoPaneLayout')
  }
  return navigation
}
