import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import type { AuthMode } from './AuthMode';
import { normalizeAuthMode } from './AuthMode';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const FOAF = 'http://xmlns.com/foaf/0.1/';
const ACL = 'http://www.w3.org/ns/auth/acl#';
const ACP = 'http://www.w3.org/ns/solid/acp#';

const { blankNode, namedNode, quad } = DataFactory;

export type PodAuthorizationResourceKind = 'acp' | 'acl';

export interface PodAuthorizationResourceInput {
  authMode: AuthMode | string | undefined;
  podUrl: string;
  cardUrl: string;
  webId: string;
  stableId: (input: string) => string;
  iri: (base: string, relative: string) => string;
}

export interface PodAuthorizationResourceOutput {
  kind: PodAuthorizationResourceKind;
  rootResourceUrl: string;
  profileResourceUrl: string;
  cardResourceUrl: string;
  quads: Quad[];
}

function resourceKindForAuthMode(authMode: AuthMode): PodAuthorizationResourceKind {
  return authMode === 'acl' ? 'acl' : 'acp';
}

export function buildPodAuthorizationResources(input: PodAuthorizationResourceInput): PodAuthorizationResourceOutput {
  const authMode = normalizeAuthMode(input.authMode);
  const kind = resourceKindForAuthMode(authMode);
  const rootResourceUrl = input.iri(input.podUrl, kind === 'acl' ? '.acl' : '.acr');
  const profileResourceUrl = input.iri(input.podUrl, kind === 'acl' ? 'profile/.acl' : 'profile/.acr');
  const cardResourceUrl = input.iri(input.podUrl, kind === 'acl' ? 'profile/card.acl' : 'profile/card.acr');
  const quads = kind === 'acl'
    ? buildWebAclQuads(input, rootResourceUrl, profileResourceUrl, cardResourceUrl)
    : buildAcpQuads(input, rootResourceUrl, profileResourceUrl, cardResourceUrl);

  return {
    kind,
    rootResourceUrl,
    profileResourceUrl,
    cardResourceUrl,
    quads,
  };
}

function buildAcpQuads(
  input: PodAuthorizationResourceInput,
  rootAcrUrl: string,
  profileAcrUrl: string,
  cardAcrUrl: string,
): Quad[] {
  const rootGraph = namedNode(rootAcrUrl);
  const profileGraph = namedNode(profileAcrUrl);
  const cardGraph = namedNode(cardAcrUrl);
  const root = namedNode(`${rootAcrUrl}#root`);
  const rootPublicRead = namedNode(`${rootAcrUrl}#publicReadAccess`);
  const rootFullOwner = namedNode(`${rootAcrUrl}#fullOwnerAccess`);
  const rootPublicPolicy = blankNode(`public-policy-${input.stableId(rootAcrUrl)}`);
  const rootPublicMatcher = blankNode(`public-matcher-${input.stableId(rootAcrUrl)}`);
  const rootOwnerPolicy = blankNode(`owner-policy-${input.stableId(rootAcrUrl)}`);
  const rootOwnerMatcher = blankNode(`owner-matcher-${input.stableId(rootAcrUrl)}`);
  const profile = namedNode(`${profileAcrUrl}#profile`);
  const profilePublicRead = namedNode(`${profileAcrUrl}#publicReadAccess`);
  const profilePolicy = blankNode(`profile-policy-${input.stableId(profileAcrUrl)}`);
  const profileMatcher = blankNode(`profile-matcher-${input.stableId(profileAcrUrl)}`);
  const card = namedNode(`${cardAcrUrl}#card`);
  const cardPublicRead = namedNode(`${cardAcrUrl}#publicReadAccess`);
  const cardPolicy = blankNode(`card-policy-${input.stableId(cardAcrUrl)}`);
  const cardMatcher = blankNode(`card-matcher-${input.stableId(cardAcrUrl)}`);
  const profileUrl = input.iri(input.podUrl, 'profile/');

  return [
    quad(root, namedNode(`${RDF}type`), namedNode(`${ACP}AccessControlResource`), rootGraph),
    quad(root, namedNode(`${ACP}resource`), namedNode(input.podUrl), rootGraph),
    quad(root, namedNode(`${ACP}accessControl`), rootPublicRead, rootGraph),
    quad(root, namedNode(`${ACP}accessControl`), rootFullOwner, rootGraph),
    quad(root, namedNode(`${ACP}memberAccessControl`), rootFullOwner, rootGraph),
    quad(rootPublicRead, namedNode(`${RDF}type`), namedNode(`${ACP}AccessControl`), rootGraph),
    quad(rootPublicRead, namedNode(`${ACP}apply`), rootPublicPolicy, rootGraph),
    quad(rootPublicPolicy, namedNode(`${RDF}type`), namedNode(`${ACP}Policy`), rootGraph),
    quad(rootPublicPolicy, namedNode(`${ACP}allow`), namedNode(`${ACL}Read`), rootGraph),
    quad(rootPublicPolicy, namedNode(`${ACP}anyOf`), rootPublicMatcher, rootGraph),
    quad(rootPublicMatcher, namedNode(`${RDF}type`), namedNode(`${ACP}Matcher`), rootGraph),
    quad(rootPublicMatcher, namedNode(`${ACP}agent`), namedNode(`${ACP}PublicAgent`), rootGraph),
    quad(rootFullOwner, namedNode(`${RDF}type`), namedNode(`${ACP}AccessControl`), rootGraph),
    quad(rootFullOwner, namedNode(`${ACP}apply`), rootOwnerPolicy, rootGraph),
    quad(rootOwnerPolicy, namedNode(`${RDF}type`), namedNode(`${ACP}Policy`), rootGraph),
    quad(rootOwnerPolicy, namedNode(`${ACP}allow`), namedNode(`${ACL}Read`), rootGraph),
    quad(rootOwnerPolicy, namedNode(`${ACP}allow`), namedNode(`${ACL}Write`), rootGraph),
    quad(rootOwnerPolicy, namedNode(`${ACP}allow`), namedNode(`${ACL}Control`), rootGraph),
    quad(rootOwnerPolicy, namedNode(`${ACP}anyOf`), rootOwnerMatcher, rootGraph),
    quad(rootOwnerMatcher, namedNode(`${RDF}type`), namedNode(`${ACP}Matcher`), rootGraph),
    quad(rootOwnerMatcher, namedNode(`${ACP}agent`), namedNode(input.webId), rootGraph),

    quad(profile, namedNode(`${RDF}type`), namedNode(`${ACP}AccessControlResource`), profileGraph),
    quad(profile, namedNode(`${ACP}resource`), namedNode(profileUrl), profileGraph),
    quad(profile, namedNode(`${ACP}accessControl`), profilePublicRead, profileGraph),
    quad(profilePublicRead, namedNode(`${RDF}type`), namedNode(`${ACP}AccessControl`), profileGraph),
    quad(profilePublicRead, namedNode(`${ACP}apply`), profilePolicy, profileGraph),
    quad(profilePolicy, namedNode(`${RDF}type`), namedNode(`${ACP}Policy`), profileGraph),
    quad(profilePolicy, namedNode(`${ACP}allow`), namedNode(`${ACL}Read`), profileGraph),
    quad(profilePolicy, namedNode(`${ACP}anyOf`), profileMatcher, profileGraph),
    quad(profileMatcher, namedNode(`${RDF}type`), namedNode(`${ACP}Matcher`), profileGraph),
    quad(profileMatcher, namedNode(`${ACP}agent`), namedNode(`${ACP}PublicAgent`), profileGraph),

    quad(card, namedNode(`${RDF}type`), namedNode(`${ACP}AccessControlResource`), cardGraph),
    quad(card, namedNode(`${ACP}resource`), namedNode(input.cardUrl), cardGraph),
    quad(card, namedNode(`${ACP}accessControl`), cardPublicRead, cardGraph),
    quad(cardPublicRead, namedNode(`${RDF}type`), namedNode(`${ACP}AccessControl`), cardGraph),
    quad(cardPublicRead, namedNode(`${ACP}apply`), cardPolicy, cardGraph),
    quad(cardPolicy, namedNode(`${RDF}type`), namedNode(`${ACP}Policy`), cardGraph),
    quad(cardPolicy, namedNode(`${ACP}allow`), namedNode(`${ACL}Read`), cardGraph),
    quad(cardPolicy, namedNode(`${ACP}anyOf`), cardMatcher, cardGraph),
    quad(cardMatcher, namedNode(`${RDF}type`), namedNode(`${ACP}Matcher`), cardGraph),
    quad(cardMatcher, namedNode(`${ACP}agent`), namedNode(`${ACP}PublicAgent`), cardGraph),
  ];
}

function buildWebAclQuads(
  input: PodAuthorizationResourceInput,
  rootAclUrl: string,
  profileAclUrl: string,
  cardAclUrl: string,
): Quad[] {
  const rootGraph = namedNode(rootAclUrl);
  const profileGraph = namedNode(profileAclUrl);
  const cardGraph = namedNode(cardAclUrl);
  const rootPublic = namedNode(`${rootAclUrl}#public`);
  const rootOwner = namedNode(`${rootAclUrl}#owner`);
  const profilePublic = namedNode(`${profileAclUrl}#public`);
  const profileOwner = namedNode(`${profileAclUrl}#owner`);
  const cardPublic = namedNode(`${cardAclUrl}#public`);
  const cardOwner = namedNode(`${cardAclUrl}#owner`);
  const profileUrl = input.iri(input.podUrl, 'profile/');

  return [
    quad(rootPublic, namedNode(`${RDF}type`), namedNode(`${ACL}Authorization`), rootGraph),
    quad(rootPublic, namedNode(`${ACL}agentClass`), namedNode(`${FOAF}Agent`), rootGraph),
    quad(rootPublic, namedNode(`${ACL}accessTo`), namedNode(input.podUrl), rootGraph),
    quad(rootPublic, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`), rootGraph),
    quad(rootOwner, namedNode(`${RDF}type`), namedNode(`${ACL}Authorization`), rootGraph),
    quad(rootOwner, namedNode(`${ACL}agent`), namedNode(input.webId), rootGraph),
    quad(rootOwner, namedNode(`${ACL}accessTo`), namedNode(input.podUrl), rootGraph),
    quad(rootOwner, namedNode(`${ACL}default`), namedNode(input.podUrl), rootGraph),
    quad(rootOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`), rootGraph),
    quad(rootOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Write`), rootGraph),
    quad(rootOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Control`), rootGraph),

    quad(profilePublic, namedNode(`${RDF}type`), namedNode(`${ACL}Authorization`), profileGraph),
    quad(profilePublic, namedNode(`${ACL}agentClass`), namedNode(`${FOAF}Agent`), profileGraph),
    quad(profilePublic, namedNode(`${ACL}accessTo`), namedNode(profileUrl), profileGraph),
    quad(profilePublic, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`), profileGraph),
    quad(profileOwner, namedNode(`${RDF}type`), namedNode(`${ACL}Authorization`), profileGraph),
    quad(profileOwner, namedNode(`${ACL}agent`), namedNode(input.webId), profileGraph),
    quad(profileOwner, namedNode(`${ACL}accessTo`), namedNode(profileUrl), profileGraph),
    quad(profileOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`), profileGraph),
    quad(profileOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Write`), profileGraph),
    quad(profileOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Control`), profileGraph),

    quad(cardPublic, namedNode(`${RDF}type`), namedNode(`${ACL}Authorization`), cardGraph),
    quad(cardPublic, namedNode(`${ACL}agentClass`), namedNode(`${FOAF}Agent`), cardGraph),
    quad(cardPublic, namedNode(`${ACL}accessTo`), namedNode(input.cardUrl), cardGraph),
    quad(cardPublic, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`), cardGraph),
    quad(cardOwner, namedNode(`${RDF}type`), namedNode(`${ACL}Authorization`), cardGraph),
    quad(cardOwner, namedNode(`${ACL}agent`), namedNode(input.webId), cardGraph),
    quad(cardOwner, namedNode(`${ACL}accessTo`), namedNode(input.cardUrl), cardGraph),
    quad(cardOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`), cardGraph),
    quad(cardOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Write`), cardGraph),
    quad(cardOwner, namedNode(`${ACL}mode`), namedNode(`${ACL}Control`), cardGraph),
  ];
}
