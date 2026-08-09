import { FileSearch, ListRestart, ScanText, SlidersHorizontal } from 'lucide-react';

function aiConfigItem(
  id: string,
  label: string,
  path: string,
  description: string,
  icon: typeof SlidersHorizontal,
) {
  return { id, label, path, href: `/ai-config/${path}`, end: true, description, icon };
}

export const aiConfigNavigationItems = [
  aiConfigItem('model-assignments', 'Model Assignments', 'model-assignments', 'Choose the model used by each Xpod capability.', SlidersHorizontal),
  aiConfigItem('document-processing', 'Document Processing', 'document-processing', 'Control OCR and structured document reading.', ScanText),
  aiConfigItem('search-indexing', 'Search & Indexing', 'search-indexing', 'Enable FTS, vector retrieval, and backend selection.', FileSearch),
  aiConfigItem('index-lifecycle', 'Index Lifecycle', 'index-lifecycle', 'Control automatic indexing and derived-index rebuilds.', ListRestart),
] as const;
