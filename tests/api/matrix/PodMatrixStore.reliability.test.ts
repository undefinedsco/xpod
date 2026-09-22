import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';

import { matrixHarness as harness } from '../../helpers/MatrixMemoryDatabase';

describe('Matrix durable collaboration invariants', () => {
  it('keeps distinct WebIDs distinct on one homeserver', async () => {
    const {store,context} = harness();
    expect((await store.getAccount(context)).userId).not.toBe((await store.getAccount({...context,webId:'https://bob.example/profile/card#me'})).userId);
  });
  it('drains backlog without losing events and discovers late native writes', async () => {
    const {store,context,rows} = harness();
    const room = await store.createRoom({},context);
    const expected: string[] = [];
    for(let i=0;i<60;i++) expected.push((await store.sendEvent(room.roomId,'m.room.message',`txn-${i}`,{body:String(i)},context)).eventId);
    let since: string | undefined; const seen=new Set<string>();
    for(let n=0;n<20;n++) {
      const sync=await store.sync(context,{since,limit:7}); since=sync.next_batch;
      const events=Object.values(sync.rooms.join).flatMap(r=>r.timeline.events);
      events.forEach(e=>seen.add(e.event_id)); if(!events.length) break;
    }
    expect(expected.every(id=>seen.has(id))).toBe(true);
    const exemplar=rows.get(messageResource)!.find(r=>r.role==='user');
    rows.get(messageResource)!.push({...exemplar,id:'chat/native/2000/01/01/messages.ttl#late',content:'late reply',maker:'https://pod.example/agent#one',role:'assistant',metadata:{},createdAt:'2000-01-01T00:00:00Z'});
    const next=await store.sync(context,{since});
    const reply=next.rooms.join[room.roomId].timeline.events.find(e=>e.content.body==='late reply');
    expect(reply?.room_id).toBe(room.roomId); expect(reply?.sender).toMatch(/^@/);
  });
  it('paginates equal-time events backwards without repetition', async () => {
    const {store,context}=harness(); const room=await store.createRoom({},context);
    const ids=[];
    const clock = vi.spyOn(Date,'now').mockReturnValue(Date.now()+10);
    try {
      for(let i=0;i<5;i++) ids.push((await store.sendEvent(room.roomId,'m.room.message',String(i),{body:String(i)},context)).eventId);
    } finally { clock.mockRestore(); }
    let from: string|undefined; const seen:string[]=[];
    for(let n=0;n<10;n++) { const page=await store.listMessages(room.roomId,context,{from,dir:'b',limit:2}); from=page.end; if(!page.chunk.length)break; seen.push(...page.chunk.map(e=>e.event_id)); }
    expect(new Set(seen).size).toBe(seen.length); expect(ids.every(id=>seen.includes(id))).toBe(true);
  });
  it('isolates devices and deduplicates concurrent retries', async () => {
    const {store,context,rows}=harness(); const room=await store.createRoom({},context);
    const sent=await Promise.all(Array.from({length:8},()=>store.sendEvent(room.roomId,'m.room.message','same',{body:'one'},context)));
    expect(new Set(sent.map(e=>e.eventId)).size).toBe(1);
    expect(rows.get(messageResource)!.filter(r=>r.content==='one')).toHaveLength(1);
    await expect(store.sendEvent(room.roomId,'m.room.message','same',{body:'changed'},context)).rejects.toMatchObject({status:409});
    const other=await store.sendEvent(room.roomId,'m.room.message','same',{body:'two'},{...context,auth:{...context.auth,clientId:'device-b'}});
    expect(other.eventId).not.toBe(sent[0].eventId);
  });
  it('does not treat an invitation as joined and denies leave then send', async () => {
    const {store,context}=harness();
    const bob={...context,webId:'https://bob.example/profile/card#me'};
    const bobId=(await store.getAccount(bob)).userId;
    const room=await store.createRoom({invite:[bobId]},context);
    expect(await store.listJoinedRooms(bob)).not.toContain(room.roomId);
    await store.joinRoom(room.roomId,bob);
    await store.leaveRoom(room.roomId,bob);
    await expect(store.sendEvent(room.roomId,'m.room.message','bad',{body:'bad'},bob)).rejects.toThrow();
    await expect(store.setState(room.roomId,'m.room.member',(await store.getAccount(context)).userId,{membership:'join'},bob)).rejects.toThrow();
  });
  it('rejects unauthorized agent routing before writing', async () => {
    const {store,context,rows}=harness(); const room=await store.createRoom({},context);
    const count=rows.get(messageResource)!.length;
    await expect(store.sendEvent(room.roomId,'m.room.message','bad',{body:'run',routeTargetAgent:'https://evil.example/agent'},context)).rejects.toThrow();
    expect(rows.get(messageResource)!).toHaveLength(count);
  });
  it('returns the stored event when a client retries after an unanswered write', async () => {
    // The acceptance sample retries a timed-out backlog PUT with the same txnId.
    const {store,context,rows}=harness(); const room=await store.createRoom({},context);
    const first=await store.sendEvent(room.roomId,'m.room.message','slow-txn',{body:'retry me'},context);
    const stored=rows.get(messageResource)!.filter(r=>r.content==='retry me').length;
    const second=await store.sendEvent(room.roomId,'m.room.message','slow-txn',{body:'retry me'},context);
    expect(second.eventId).toBe(first.eventId);
    expect(rows.get(messageResource)!.filter(r=>r.content==='retry me')).toHaveLength(stored);
    await expect(store.sendEvent(room.roomId,'m.room.message','slow-txn',{body:'different'},context)).rejects.toMatchObject({status:409});
  });
});
