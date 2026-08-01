import { createContext, useContext } from 'react';
export const WorkspaceLayoutContext = createContext(null);
export function useWorkspaceLayout() {
    const navigation = useContext(WorkspaceLayoutContext);
    if (!navigation) {
        throw new Error('useWorkspaceLayout must be used inside TwoPaneLayout');
    }
    return navigation;
}
