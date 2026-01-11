import { writePattern } from 'quadstore/dist/esm/serialization/patterns.js';

// 模拟 quadstore 的索引配置
const index = {
  prefix: 'GSPO:',
  terms: ['graph', 'subject', 'predicate', 'object']
};

const prefixes = {
  compactIri: (iri) => iri,
  expandTerm: (term) => term
};

// 测试1: 精确匹配 graph
console.log('=== 精确匹配 graph ===');
const pattern1 = {
  graph: { termType: 'NamedNode', value: 'messages/2024/01/01' },
  subject: null,
  predicate: null,
  object: null
};
const result1 = writePattern(pattern1, index, prefixes);
console.log('gt:', result1?.gt);
console.log('lt:', result1?.lt);

// 测试2: Range 匹配 graph (前缀)
console.log('\n=== Range 匹配 graph (尝试前缀) ===');
const pattern2 = {
  graph: { 
    termType: 'Range',
    gte: { termType: 'NamedNode', value: 'messages/2024/' }
  },
  subject: null,
  predicate: null,
  object: null
};
try {
  const result2 = writePattern(pattern2, index, prefixes);
  console.log('result:', result2);
} catch(e) {
  console.log('Error:', e.message);
}
