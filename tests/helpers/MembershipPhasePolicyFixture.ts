import { DataFactory, Parser, Writer } from 'n3';
import { attachMembershipPolicyFixture } from './MembershipPolicyFixture';
import type { canonicalInviteFixture } from './CanonicalInviteFixture';

type CanonicalFixture = Parameters<Parameters<typeof canonicalInviteFixture>[0]>[0];
type PolicyFixture = Awaited<ReturnType<typeof attachMembershipPolicyFixture>> & { refreshPolicy: () => Promise<void> };
const attached = new WeakMap<CanonicalFixture, PolicyFixture>();

/** Actual HTTP and SPARQL phase oracle; fixture headers do not establish DPoP or CSS authorization. */
export async function membershipPhasePolicyFixture(base: CanonicalFixture): Promise<PolicyFixture> {
  const existing = attached.get(base);
  if (existing) return existing;
  const f = await attachMembershipPolicyFixture(base);
  const policyGraph = DataFactory.namedNode(f.roomPolicy);
  f.graph.addQuads(new Parser({ baseIRI: f.roomPolicy }).parse(f.replies.get(`GET ${f.roomPolicy}`)?.body ?? '')
    .map(q => DataFactory.quad(q.subject, q.predicate, q.object, policyGraph)));
  const refresh = async(): Promise<void> => {
    const writer = new Writer();
    writer.addQuads(f.graph.getQuads(null, null, null, policyGraph)
      .map(q => DataFactory.quad(q.subject, q.predicate, q.object)));
    const body = await new Promise<string>((resolve, reject) =>
      writer.end((error, text) => error ? reject(error) : resolve(text)));
    f.set('GET', f.roomPolicy, { status: 200, body });
  };
  f.onGuardedPost(async(request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const guarded = request.headers['content-type'] === 'application/vnd.xpod.guarded-sparql-update+json';
    const update = guarded ? (JSON.parse(text) as { update: string }).update : text;
    // Canonical phase CAS and policy delta share the endpoint; only the policy delta writes this graph.
    const policyMutation = guarded && new RegExp(`(?:INSERT|DELETE)\\s*\\{\\s*GRAPH\\s*<${f.roomPolicy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'i').test(update);
    await f.executePost(update, request, response, policyMutation ? 'policy' : 'source', refresh);
  });
  const result = { ...f, refreshPolicy: refresh };
  attached.set(base, result);
  return result;
}
