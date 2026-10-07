/** User-facing purposes of existing Pod AI Config model relations. */
export const POD_MODEL_ASSIGNMENTS = [
  { id: 'chatModel', label: '智能', group: '对话' },
  { id: 'ocrModel', label: '视觉辅助', group: '对话' },
  { id: 'readerModel', label: '文档理解', group: '文档理解' },
  { id: 'embeddingModel', label: '语义检索', group: '向量' },
  { id: 'indexerModel', label: '准备与摘要索引', group: '索引' },
  { id: 'rerankerModel', label: '搜索结果重排', group: '检索' },
] as const;
