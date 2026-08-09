import { FileSearch, ListRestart, ScanText, SlidersHorizontal } from 'lucide-react';

export const aiConfigNavigationItems = [
  {
    id: 'model-assignments',
    label: 'Model Assignments',
    path: '/ai-config/model-assignments',
    description: 'Choose the model used by each Xpod capability.',
    icon: SlidersHorizontal,
  },
  {
    id: 'document-processing',
    label: 'Document Processing',
    path: '/ai-config/document-processing',
    description: 'Control OCR and structured document reading.',
    icon: ScanText,
  },
  {
    id: 'search-indexing',
    label: 'Search & Indexing',
    path: '/ai-config/search-indexing',
    description: 'Enable FTS, vector retrieval, and backend selection.',
    icon: FileSearch,
  },
  {
    id: 'index-lifecycle',
    label: 'Index Lifecycle',
    path: '/ai-config/index-lifecycle',
    description: 'Control automatic indexing and derived-index rebuilds.',
    icon: ListRestart,
  },
] as const;
