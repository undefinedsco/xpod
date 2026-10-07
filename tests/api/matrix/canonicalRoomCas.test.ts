import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource, type ChatMemberRole } from '@undefineds.co/models';
import { QueryEngine } from '@comunica/query-sparql';
import { DataFactory, Store } from 'n3';
import { buildCanonicalRoomCas } from '../../../src/api/matrix/canonicalRoomCas';
import type { CanonicalRoomSnapshot } from '../../../src/api/matrix/canonicalRoomSource';
const root = 'https://pod.example/cas/';
const owner = root + 'profile/card#me';
const bob = 'https://bob.example/profile/card#me';
const iri = chatResource.buildIri(root, {id:'cas'});
const metadataIri = iri + '/metadata';
const document = iri.split('#')[0];
async function fixture(roles: Record<string, ChatMemberRole> | null = null) {
  const db = drizzle({info:{webId:owner,podUrl:root,isLoggedIn:true},fetch:async()=>{throw Error('Compiler must not fetch');}} as never,
    {podUrl:root,resourcePreparation:'off',disableInteropDiscovery:true});
  const graph = new Store(); const engine = new QueryEngine();
  const protocols = {other:{keep:true},matrix:{roomId:'fixture'}};
  await engine.queryVoid(db.insert(chatResource).values({id:chatResource.buildId({id:'cas'}),author:owner,participants:[owner],title:'keep',
    metadata:{'@id':metadataIri,customRoot:{keep:true},...(roles===null?{}:{memberRoles:roles}),protocols}} as never).toSPARQL().query,
    {sources:[graph],destination:graph});
  const quads=graph.getQuads(null,null,null,null);
  const protocolsQuad=quads.find(q=>q.subject.value===metadataIri&&q.predicate.value.endsWith('#protocols'))!;
  const snapshot:CanonicalRoomSnapshot={facts:{roomId:'fixture',sourceIri:iri,sourcePodId:'cas',sourcePodUrl:root,authorWebId:owner,
    participants:[owner],memberRoles:roles??{}},quads,metadataIri,protocolsQuad,protocols};
  const execute=async(query:string)=>await engine.queryVoid(query,{sources:[graph],destination:graph});
  return {db,graph,snapshot,execute};
}
describe('canonical snapshot CAS public ORM targets and actual RDF',()=>{
  it('adds exact participants and present-empty roles while preserving all unrelated facts',async()=>{
    const f=await fixture(); const next={...f.snapshot.protocols,matrix:{roomId:'fixture',extra:'keep'}};
    const query=buildCanonicalRoomCas(f.db,f.snapshot,{participants:[owner,bob],memberRoles:{},protocols:next});
    await f.execute(query);
    const role=f.graph.getQuads(DataFactory.namedNode(metadataIri),null,null,null).find(q=>q.predicate.value.endsWith('#memberRoles'))!;
    expect(role.object.value).toBe('{}'); expect(role.object.termType).toBe('Literal');
    const participant=chatResource.getColumn('participants')!.getPredicate(chatResource.config.namespace);
    expect(f.graph.getQuads(DataFactory.namedNode(iri),DataFactory.namedNode(participant),null,null).map(q=>q.object.value).sort()).toEqual([owner,bob].sort());
    for(const q of f.snapshot.quads.filter(q=>!q.equals(f.snapshot.protocolsQuad)&&q.predicate.value!==participant))expect(f.graph.has(q)).toBe(true);
  });
  it('deletes roles predicate and all participants explicitly without deleting metadata',async()=>{
    const f=await fixture({[owner]:'owner'});
    await f.execute(buildCanonicalRoomCas(f.db,f.snapshot,{participants:[],memberRoles:null}));
    expect(f.graph.getQuads(null,null,null,null).filter(q=>q.predicate.value.endsWith('#memberRoles'))).toHaveLength(0);
    const participant=chatResource.getColumn('participants')!.getPredicate(chatResource.config.namespace);
    expect(f.graph.getQuads(DataFactory.namedNode(iri),DataFactory.namedNode(participant),null,null)).toHaveLength(0);
    expect(f.graph.has(f.snapshot.protocolsQuad)).toBe(true);
    expect(f.graph.getQuads(null,null,null,null).some(q=>q.predicate.value.endsWith('#customRoot'))).toBe(true);
  });
  it.each(['participants','memberRoles','protocols'])('rejects extra old %s terms without mutations',async(name)=>{
    const f=await fixture(); const nn=DataFactory.namedNode;
    const predicate=name==='participants'?chatResource.getColumn(name)!.getPredicate(chatResource.config.namespace):'https://undefineds.co/ns#'+name;
    f.graph.addQuad(nn(name==='participants'?iri:metadataIri),nn(predicate),DataFactory.literal('extra'),nn(document));
    const before=f.graph.getQuads(null,null,null,null);
    await f.execute(buildCanonicalRoomCas(f.db,f.snapshot,{participants:[bob],memberRoles:{},protocols:{matrix:{roomId:'changed'}}}));
    expect(f.graph.size).toBe(before.length);for(const q of before)expect(f.graph.has(q)).toBe(true);
  });
  it('stale snapshots cannot overwrite a prior successful CAS',async()=>{
    const f=await fixture();await f.execute(buildCanonicalRoomCas(f.db,f.snapshot,{memberRoles:{[bob]:'member'}}));
    const before=f.graph.getQuads(null,null,null,null);
    await f.execute(buildCanonicalRoomCas(f.db,f.snapshot,{participants:[bob]}));
    expect(f.graph.size).toBe(before.length);for(const q of before)expect(f.graph.has(q)).toBe(true);
  });
});
