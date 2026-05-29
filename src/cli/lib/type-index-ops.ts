import type { CliAuthContext } from './auth-context';
import {
  type ModelTypeIndexEntry,
  buildModelTypeIndexInsertData,
  buildProfileTypeIndexInsertData,
  renderModelTypeIndexTurtle,
  typeIndexDocumentType,
  typeIndexLabel,
} from '../../provision/model-type-index';
import {
  ensureOk,
  fetchResource,
  resolveResourceTarget,
  responseData,
} from './resource';

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function documentResourceInput(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//iu.test(trimmed)) {
    const hashIndex = trimmed.indexOf('#');
    return hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  }

  const url = new URL(trimmed);
  url.hash = '';
  return url.toString();
}

export async function ensureContainerResource(context: CliAuthContext, containerUrl: string): Promise<Record<string, unknown>> {
  const target = resolveResourceTarget(context, ensureTrailingSlash(containerUrl));
  const head = await fetchResource(context, target, { method: 'HEAD' });
  if (head.ok) {
    return {
      action: 'already_exists',
      ...responseData(target, head),
    };
  }
  if (head.status !== 404) {
    ensureOk(head, 'container_check_failed', `Failed to check container ${containerUrl}`);
  }

  const created = await fetchResource(context, target, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });
  ensureOk(created, 'container_create_failed', `Failed to create container ${containerUrl}`);
  return {
    action: 'created',
    ...responseData(target, created),
  };
}

export async function writeOrPatchModelTypeIndex(input: {
  context: CliAuthContext;
  typeIndexUrl: string;
  entries: ModelTypeIndexEntry[];
}): Promise<Record<string, unknown>> {
  const target = resolveResourceTarget(input.context, input.typeIndexUrl);
  const head = await fetchResource(input.context, target, { method: 'HEAD' });
  if (head.ok) {
    const patch = await fetchResource(input.context, target, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: buildModelTypeIndexInsertData(input.typeIndexUrl, input.entries),
    });
    ensureOk(patch, 'type_index_patch_failed', `Failed to patch TypeIndex ${input.typeIndexUrl}`);
    return {
      action: 'patched',
      ...responseData(target, patch),
    };
  }
  if (head.status !== 404) {
    ensureOk(head, 'type_index_check_failed', `Failed to check TypeIndex ${input.typeIndexUrl}`);
  }

  const created = await fetchResource(input.context, target, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: renderModelTypeIndexTurtle(
      input.entries,
      typeIndexLabel(input.typeIndexUrl),
      typeIndexDocumentType(input.typeIndexUrl),
    ),
  });
  ensureOk(created, 'type_index_create_failed', `Failed to create TypeIndex ${input.typeIndexUrl}`);
  return {
    action: 'created',
    ...responseData(target, created),
  };
}

export async function patchProfileTypeIndexes(input: {
  context: CliAuthContext;
  podRoot: string;
  privateTypeIndex?: string;
  publicTypeIndex?: string;
}): Promise<Record<string, unknown>> {
  const target = resolveResourceTarget(input.context, documentResourceInput(input.context.webId));
  const response = await fetchResource(input.context, target, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/sparql-update' },
    body: buildProfileTypeIndexInsertData({
      webId: input.context.webId,
      podRoot: input.podRoot,
      privateTypeIndex: input.privateTypeIndex,
      publicTypeIndex: input.publicTypeIndex,
    }),
  });
  ensureOk(response, 'profile_patch_failed', `Failed to link TypeIndex from profile ${input.context.webId}`);
  return {
    action: 'patched',
    ...responseData(target, response),
  };
}
