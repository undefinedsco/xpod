import {test,expect} from 'bun:test';
import {applyVerifierUnifiedPatch} from '../../scripts/lib/independent-admission/afs-verifier-patch-originals';
const project=(original:string,hunk:string)=>applyVerifierUnifiedPatch(new Map([['file',Buffer.from(original)]]),Buffer.from('diff --git a/file b/file\n--- a/file\n+++ b/file\n'+hunk)).get('file')!.toString();
const marker='\\ No newline at end of file\n';
test('middle hunk preserves the unmentioned final newline state exactly',()=>{
 expect(project('a\nb\nc','@@ -2 +2 @@\n-b\n+B\n')).toBe('a\nB\nc');
 expect(project('a\nb\nc\n','@@ -2 +2 @@\n-b\n+B\n')).toBe('a\nB\nc\n');
});
test('an EOF hunk requires the actual old no-newline marker',()=>{
 expect(()=>project('a\nb','@@ -2 +2 @@\n-b\n+B\n')).toThrow('upstream final newline differs');
 expect(project('a\nb','@@ -2 +2 @@\n-b\n'+marker+'+B\n'+marker)).toBe('a\nB');
 expect(project('a\nb\n','@@ -2 +2 @@\n-b\n+B\n')).toBe('a\nB\n');
});
test('explicit EOF transitions can add or remove the final newline',()=>{
 expect(project('a\nb','@@ -2 +2 @@\n-b\n'+marker+'+B\n')).toBe('a\nB\n');
 expect(project('a\nb\n','@@ -2 +2 @@\n-b\n+B\n'+marker)).toBe('a\nB');
});
test('middle markers and altered preimages remain rejected',()=>{
 expect(()=>project('a\nb\nc','@@ -2 +2 @@\n-b\n'+marker+'+B\n')).toThrow('upstream final newline differs');
 expect(()=>project('a\nb\nc','@@ -2 +2 @@\n-b\n+B\n'+marker)).toThrow('projected final newline position differs');
 expect(()=>project('a\nx\nc','@@ -2 +2 @@\n-b\n+B\n')).toThrow('exact upstream preimage differs');
 expect(()=>project('a\nb\n','@@ -2 +2 @@\n-b\n'+marker+'+B\n')).toThrow('upstream final newline differs');
});
