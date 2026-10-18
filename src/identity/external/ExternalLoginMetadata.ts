import { RepresentationMetadata } from '@solid/community-server';
import { DataFactory } from 'n3';

/** Private interaction responses must not be cached or leak the OAuth URL as a referrer. */
export function protectExternalLoginMetadata(metadata: RepresentationMetadata): RepresentationMetadata {
  metadata.set(DataFactory.namedNode('urn:xpod:external-login:cache-control'), 'no-store');
  metadata.set(DataFactory.namedNode('urn:xpod:external-login:referrer-policy'), 'no-referrer');
  return metadata;
}
