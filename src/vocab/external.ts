/**
 * External Vocabularies - 外部标准词汇表
 *
 * 常用的 RDF 标准词汇表，避免重复定义。
 */

// ============================================
// Namespace Builder (same as udfs.ts)
// ============================================

type NamespaceObject<T extends Record<string, string>> = ((term: string) => string) & {
  prefix: string;
  uri: string;
} & { [K in keyof T]: string };

function createNamespace<T extends Record<string, string>>(
  prefix: string,
  baseUri: string,
  terms: T,
): NamespaceObject<T> {
  const ABSOLUTE_IRI = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

  const builder = ((term: string) =>
    ABSOLUTE_IRI.test(term) ? term : `${baseUri}${term}`) as NamespaceObject<T>;

  builder.prefix = prefix;
  builder.uri = baseUri;

  for (const [key, local] of Object.entries(terms)) {
    Object.defineProperty(builder, key, {
      value: builder(local),
      enumerable: true,
    });
  }

  return builder;
}

// ============================================
// Dublin Core Terms
// ============================================

/**
 * Dublin Core Terms
 * @see https://www.dublincore.org/specifications/dublin-core/dcmi-terms/
 */
export const DCTerms = createNamespace('dc', 'http://purl.org/dc/terms/', {
  // 常用属性
  title: 'title',
  description: 'description',
  creator: 'creator',
  created: 'created',
  modified: 'modified',
  date: 'date',
  type: 'type',
  format: 'format',
  identifier: 'identifier',
  language: 'language',
  subject: 'subject',
});

// ============================================
// LDP (Linked Data Platform)
// ============================================

/**
 * Linked Data Platform
 * @see https://www.w3.org/ns/ldp
 */
export const LDP = createNamespace('ldp', 'http://www.w3.org/ns/ldp#', {
  // Classes
  Resource: 'Resource',
  Container: 'Container',
  BasicContainer: 'BasicContainer',
  DirectContainer: 'DirectContainer',
  IndirectContainer: 'IndirectContainer',
  NonRDFSource: 'NonRDFSource',
  RDFSource: 'RDFSource',

  // Properties
  contains: 'contains',
  member: 'member',
  membershipResource: 'membershipResource',
  hasMemberRelation: 'hasMemberRelation',
  isMemberOfRelation: 'isMemberOfRelation',
  insertedContentRelation: 'insertedContentRelation',
});

// ============================================
// Schema.org
// ============================================

/**
 * Schema.org vocabulary (常用子集)
 * @see https://schema.org/
 */
export const Schema = createNamespace('schema', 'https://schema.org/', {
  // Classes
  Person: 'Person',
  Organization: 'Organization',
  Thing: 'Thing',
  CreativeWork: 'CreativeWork',
  Article: 'Article',
  WebPage: 'WebPage',
  SoftwareApplication: 'SoftwareApplication',

  // Properties
  name: 'name',
  description: 'description',
  url: 'url',
  image: 'image',
  email: 'email',
  dateCreated: 'dateCreated',
  dateModified: 'dateModified',
  author: 'author',
  creator: 'creator',
});

// ============================================
// RDF / RDFS
// ============================================

/**
 * RDF vocabulary
 * @see https://www.w3.org/1999/02/22-rdf-syntax-ns
 */
export const RDF = createNamespace('rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', {
  type: 'type',
  Property: 'Property',
  Statement: 'Statement',
  subject: 'subject',
  predicate: 'predicate',
  object: 'object',
  first: 'first',
  rest: 'rest',
  nil: 'nil',
});

/**
 * RDFS vocabulary
 * @see https://www.w3.org/2000/01/rdf-schema
 */
export const RDFS = createNamespace('rdfs', 'http://www.w3.org/2000/01/rdf-schema#', {
  Class: 'Class',
  Resource: 'Resource',
  Literal: 'Literal',
  label: 'label',
  comment: 'comment',
  subClassOf: 'subClassOf',
  subPropertyOf: 'subPropertyOf',
  domain: 'domain',
  range: 'range',
  seeAlso: 'seeAlso',
  isDefinedBy: 'isDefinedBy',
});

// ============================================
// XSD (XML Schema Datatypes)
// ============================================

/**
 * XSD datatypes
 * @see https://www.w3.org/2001/XMLSchema
 */
export const XSD = createNamespace('xsd', 'http://www.w3.org/2001/XMLSchema#', {
  string: 'string',
  boolean: 'boolean',
  integer: 'integer',
  decimal: 'decimal',
  float: 'float',
  double: 'double',
  date: 'date',
  time: 'time',
  dateTime: 'dateTime',
  duration: 'duration',
  anyURI: 'anyURI',
});

// ============================================
// FOAF (Friend of a Friend)
// ============================================

/**
 * FOAF vocabulary
 * @see http://xmlns.com/foaf/0.1/
 */
export const FOAF = createNamespace('foaf', 'http://xmlns.com/foaf/0.1/', {
  // Classes
  Person: 'Person',
  Agent: 'Agent',
  Organization: 'Organization',
  Document: 'Document',
  Image: 'Image',

  // Properties
  name: 'name',
  nick: 'nick',
  mbox: 'mbox',
  homepage: 'homepage',
  knows: 'knows',
  primaryTopic: 'primaryTopic',
  isPrimaryTopicOf: 'isPrimaryTopicOf',
});

// ============================================
// ACL (Web Access Control)
// ============================================

/**
 * ACL vocabulary
 * @see http://www.w3.org/ns/auth/acl
 */
export const ACL = createNamespace('acl', 'http://www.w3.org/ns/auth/acl#', {
  // Classes
  Authorization: 'Authorization',
  Access: 'Access',

  // Access Modes
  Read: 'Read',
  Write: 'Write',
  Append: 'Append',
  Control: 'Control',

  // Properties
  accessTo: 'accessTo',
  default: 'default',
  agent: 'agent',
  agentClass: 'agentClass',
  agentGroup: 'agentGroup',
  mode: 'mode',
  origin: 'origin',
});

// ============================================
// Solid Terms
// ============================================

/**
 * Solid vocabulary
 * @see http://www.w3.org/ns/solid/terms
 */
export const Solid = createNamespace('solid', 'http://www.w3.org/ns/solid/terms#', {
  // Classes
  TypeIndex: 'TypeIndex',
  ListedDocument: 'ListedDocument',
  UnlistedDocument: 'UnlistedDocument',
  Notification: 'Notification',

  // Properties
  oidcIssuer: 'oidcIssuer',
  account: 'account',
  privateTypeIndex: 'privateTypeIndex',
  publicTypeIndex: 'publicTypeIndex',
  storageQuota: 'storageQuota',
  storageUsage: 'storageUsage',
  forClass: 'forClass',
  instance: 'instance',
  instanceContainer: 'instanceContainer',
});

// ============================================
// SIOC (Semantically-Interlinked Online Communities)
// ============================================

/**
 * SIOC vocabulary (for chat threads/content)
 * @see http://rdfs.org/sioc/ns#
 */
export const SIOC = createNamespace('sioc', 'http://rdfs.org/sioc/ns#', {
  // Classes
  Thread: 'Thread',
  Post: 'Post',
  Forum: 'Forum',
  Container: 'Container',
  Item: 'Item',
  UserAccount: 'UserAccount',

  // Properties
  content: 'content',
  has_reply: 'has_reply',
  reply_of: 'reply_of',
  has_container: 'has_container',
  container_of: 'container_of',
  has_creator: 'has_creator',
  has_parent: 'has_parent',
  has_space: 'has_space',
  num_replies: 'num_replies',
});

// ============================================
// Meeting/Chat (SolidOS Long Chat)
// ============================================

/**
 * Meeting vocabulary (SolidOS chat)
 * @see http://www.w3.org/ns/pim/meeting#
 */
export const Meeting = createNamespace('meeting', 'http://www.w3.org/ns/pim/meeting#', {
  // Classes
  LongChat: 'LongChat',
  ShortChat: 'ShortChat',
  Meeting: 'Meeting',

  // Properties
  sharedNotes: 'sharedNotes',
});

// ============================================
// WF (Workflow - used for chat messages)
// ============================================

/**
 * Workflow vocabulary (used for chat message linking)
 * @see http://www.w3.org/2005/01/wf/flow#
 */
export const WF = createNamespace('wf', 'http://www.w3.org/2005/01/wf/flow#', {
  // Properties
  message: 'message',
  participant: 'participant',
});
