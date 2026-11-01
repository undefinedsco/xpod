"""Pure endpoint composition only; not kernel/original verification or a cap.

The module is imported as the ACTUAL production module (not an AST-extracted
function in a fake scope). The previous extraction re-created only
`retained_metadata_chain`, so the real fail-only diagnostic helper it calls was
undefined and the fixture diverged from production. Importing the module keeps
every existing assertion and also exercises the real bounded diagnostic.
"""
import copy,importlib.util,unittest
from pathlib import Path
SOURCE=Path(__file__).resolve().parents[1]/'scripts/sdk-generation-multiprocess-bindings.py'
spec=importlib.util.spec_from_file_location('sdk_generation_multiprocess_bindings_retained',SOURCE)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
join=module.retained_metadata_chain
class Tests(unittest.TestCase):
 def setUp(self):
  self.pre=[1,2,33188,1571,40,50];self.ren=[1,2,33188,1571,40,60];self.mode=[1,2,33261,1571,40,70]
  self.producer=dict(sequence=10,path='/build/temp',identity=self.pre)
  self.rename=(dict(kind='actual-rename-window',producerCaptureSequence=10,fromPath='/build/temp',toPath='/build/final',beforeIdentity=self.pre),dict(sequence=20,afterIdentity=self.ren))
  self.chmod=(dict(kind='actual-mode-window',beforeIdentity=self.ren),dict(sequence=30,afterIdentity=self.mode))
  self.consumer=dict(sequence=40,path='/build/final',identity=self.mode)
 def test_rename_then_chmod_exact_full_six(self):self.assertEqual(join(self.producer,self.consumer,[self.rename,self.chmod]),[20,30])
 def test_chmod_then_rename(self):
  mode=copy.deepcopy(self.chmod);mode[0]['beforeIdentity']=self.pre;mode[1]['sequence']=20
  rename=copy.deepcopy(self.rename);rename[0]['beforeIdentity']=self.mode;rename[1].update(sequence=30,afterIdentity=[*self.mode[:5],80]);consumer=dict(self.consumer,identity=[*self.mode[:5],80]);self.assertEqual(join(self.producer,consumer,[mode,rename]),[20,30])
 def test_no_post_only_gap_bridge(self):
  rename=copy.deepcopy(self.rename);rename[0]['beforeIdentity'][5]+=1
  with self.assertRaisesRegex(ValueError,'gap'):join(self.producer,self.consumer,[rename,self.chmod])
 def test_every_preimage_identity_axis_is_required(self):
  for index in range(6):
   with self.subTest(axis=index):
    chmod=copy.deepcopy(self.chmod);chmod[0]['beforeIdentity'][index]+=1
    with self.assertRaises(ValueError):join(self.producer,self.consumer,[self.rename,chmod])
 def test_wrong_producer_path_and_changed_rename_metadata(self):
  for key,value in [('producerCaptureSequence',9),('fromPath','/other')]:
   rename=copy.deepcopy(self.rename);rename[0][key]=value
   with self.assertRaises(ValueError):join(self.producer,self.consumer,[rename,self.chmod])
  for index in range(5):
   rename=copy.deepcopy(self.rename);rename[1]['afterIdentity'][index]+=1
   with self.assertRaises(ValueError):join(self.producer,self.consumer,[rename,self.chmod])
 def test_missing_duplicate_reordered_and_after_consumer_refuse(self):
  for states in [[self.chmod],[self.rename],[self.rename,self.rename,self.chmod],[self.chmod,self.rename]]:
   with self.assertRaises(ValueError):join(self.producer,self.consumer,states)
  rename=copy.deepcopy(self.rename);rename[1]['sequence']=41
  with self.assertRaises(ValueError):join(self.producer,self.consumer,[rename,self.chmod])
 def test_wrong_final_ctime_path_or_inode_refuses(self):
  for index in range(6):
   consumer=copy.deepcopy(self.consumer);consumer['identity'][index]+=1
   with self.assertRaises(ValueError):join(self.producer,consumer,[self.rename,self.chmod])
  with self.assertRaises(ValueError):join(self.producer,dict(self.consumer,path='/wrong'),[self.rename,self.chmod])
 def test_generated_unmap_checkpoint_uses_the_same_exact_metadata_chain(self):
  producer=dict(self.producer,kind='generated-vma-operation-exit',operation='unmap')
  rename=copy.deepcopy(self.rename);rename[0]['generatedCheckpointSequence']=rename[0].pop('producerCaptureSequence')
  self.assertEqual(join(producer,self.consumer,[rename,self.chmod]),[20,30])
  for mutation in ['wrong-checkpoint','ordinary-reference','both-references','missing-change']:
   changed=copy.deepcopy(rename)
   if mutation=='wrong-checkpoint':changed[0]['generatedCheckpointSequence']=9
   elif mutation=='ordinary-reference':changed[0]['producerCaptureSequence']=changed[0].pop('generatedCheckpointSequence')
   elif mutation=='both-references':changed[0]['producerCaptureSequence']=10
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):
    join(producer,self.consumer,[changed]if mutation=='missing-change'else [changed,self.chmod])
 def test_unknown_operation_cannot_fill_ctime_gap(self):
  rename=copy.deepcopy(self.rename);rename[0]['kind']='retained-fd-rename-binding'
  with self.assertRaises(ValueError):join(self.producer,self.consumer,[rename,self.chmod])
if __name__=='__main__':unittest.main()

class LeaseClosingBridge(unittest.TestCase):
    """N2: a closing lease token may differ from its acquisition ONLY via a
    validated owned metadata chain, composed by the SAME authorizer.

    The acquisition row is immutable evidence; it is never rewritten. Replay
    bridges acquisition -> closing by composing the already-verified transition
    endpoints with `identity_only=True`, which applies the identical six-field
    BEFORE continuity and per-kind effect rules and proves the final identity.
    """

    def setUp(self):
        self.pre = [7, 9, 33188, 10767, 100, 200]
        self.ren = [7, 9, 33188, 10767, 100, 260]
        self.producer = dict(sequence=100, identity=self.pre)      # acquisition
        self.consumer = dict(sequence=900, identity=self.ren)      # closing
        self.rename = (dict(kind='actual-rename-window', beforeIdentity=self.pre),
                       dict(sequence=500, afterIdentity=self.ren))

    def test_validated_chain_bridges_acquisition_to_closing(self):
        self.assertEqual(join(self.producer, self.consumer, [self.rename],
                              identity_only=True), [500])

    def test_no_transition_still_refuses_a_bare_identity_change(self):
        with self.assertRaises(ValueError):
            join(self.producer, self.consumer, [], identity_only=True)

    def test_gap_in_before_continuity_refuses(self):
        broken = (dict(kind='actual-rename-window', beforeIdentity=[7, 9, 33188, 10767, 100, 999]),
                  dict(sequence=500, afterIdentity=self.ren))
        with self.assertRaises(ValueError):
            join(self.producer, self.consumer, [broken], identity_only=True)

    def test_reordered_endpoints_refuse(self):
        late = (dict(kind='actual-rename-window', beforeIdentity=self.pre),
                dict(sequence=50, afterIdentity=self.ren))     # before acquisition
        with self.assertRaises(ValueError):
            join(self.producer, self.consumer, [late], identity_only=True)

    def test_wrong_final_identity_refuses(self):
        other = dict(self.consumer, identity=[7, 9, 33188, 10767, 100, 261])
        with self.assertRaises(ValueError):
            join(self.producer, other, [self.rename], identity_only=True)

    def test_unrelated_inode_transition_is_never_absorbed(self):
        foreign = (dict(kind='actual-rename-window', beforeIdentity=[7, 8, 33188, 10767, 100, 200]),
                   dict(sequence=500, afterIdentity=[7, 8, 33188, 10767, 100, 260]))
        with self.assertRaises(ValueError):
            join(self.producer, self.consumer, [foreign], identity_only=True)

    def test_link_effect_that_changes_size_refuses(self):
        bad = (dict(kind='actual-link-window', beforeIdentity=self.pre),
               dict(sequence=500, afterIdentity=[7, 9, 33188, 99999, 100, 260]))
        with self.assertRaises(ValueError):
            join(self.producer, self.consumer, [bad], identity_only=True)

    def test_identity_only_chain_rejects_a_path_bearing_endpoint(self):
        with self.assertRaises(ValueError):
            join(dict(self.producer, path='/proc/9/fd/3'), self.consumer,
                 [self.rename], identity_only=True)

    def test_legacy_path_bearing_chain_is_unchanged(self):
        producer = dict(sequence=10, path='/build/temp', identity=self.pre)
        rename = (dict(kind='actual-rename-window', producerCaptureSequence=10,
                       fromPath='/build/temp', toPath='/build/final', beforeIdentity=self.pre),
                  dict(sequence=20, afterIdentity=self.ren))
        consumer = dict(sequence=40, path='/build/final', identity=self.ren)
        self.assertEqual(join(producer, consumer, [rename]), [20])
    def test_default_mode_refuses_a_missing_endpoint_path(self):
        """`identity_only=False` composes a NAMESPACE chain: path is mandatory.

        ROOT flagged that `producer.get('path')` is not equivalent to the old
        `producer['path']` when the key is absent. A malformed legacy stream must be
        refused explicitly, not merely fail later in some branch that uses it.
        """
        for producer, consumer in (
                (dict(sequence=10, identity=self.pre),
                 dict(sequence=40, path='/build/final', identity=self.ren)),
                (dict(sequence=10, path='/build/temp', identity=self.pre),
                 dict(sequence=40, identity=self.ren)),
                (dict(sequence=10, identity=self.pre),
                 dict(sequence=40, identity=self.ren))):
            with self.assertRaises(ValueError) as caught:
                join(producer, consumer, [self.rename])
            self.assertIn('requires endpoint paths', str(caught.exception))

    def test_identity_only_mode_refuses_any_path_bearing_endpoint(self):
        """The narrow mode is explicit: it must not silently accept a path."""
        for producer, consumer in (
                (dict(sequence=10, path='/x', identity=self.pre),
                 dict(sequence=40, identity=self.ren)),
                (dict(sequence=10, identity=self.pre),
                 dict(sequence=40, path='/y', identity=self.ren))):
            with self.assertRaises(ValueError) as caught:
                join(producer, consumer, [self.rename], identity_only=True)
            self.assertIn('must not carry a path', str(caught.exception))

    # ---- N1 displaced-destination closing vectors -----------------------
    def _destination_rename(self, target_before, target_after, links=0):
        source_pre = self.pre
        source_post = self.ren
        return (
            dict(kind='actual-rename-window', beforeIdentity=list(source_pre),
                 replacementBefore=dict(identity=list(target_before),
                                        namedIdentity=list(target_before), links=1,
                                        original=dict(path='capture-0001.original', bytes=9,
                                                      sha256='a'*64))),
            dict(sequence=500, afterIdentity=list(source_post),
                 replacementAfter=dict(identity=list(target_after), links=links,
                                       original=dict(path='capture-0002.original', bytes=9,
                                                     sha256='b'*64))))

    def test_displaced_destination_closing_bridges_on_its_own_endpoints(self):
        """N1: the overwritten inode's closing token resolves via the same row.

        The destination is a DIFFERENT inode from the source, so the source's
        before[:2] can never select it. Its own replacement endpoints must.
        """
        target_pre = [7, 11, 33188, 1664, 100, 300]
        target_post = [7, 11, 33188, 1664, 100, 360]
        producer = dict(sequence=100, identity=target_pre)     # destination acquisition
        consumer = dict(sequence=900, identity=target_post)    # destination closing
        self.assertEqual(
            join(producer, consumer, [self._destination_rename(target_pre, target_post)],
                 identity_only=True), [500])

    def test_displaced_destination_requires_links_zero(self):
        target_pre = [7, 11, 33188, 1664, 100, 300]
        target_post = [7, 11, 33188, 1664, 100, 360]
        with self.assertRaises(ValueError):
            join(dict(sequence=100, identity=target_pre),
                 dict(sequence=900, identity=target_post),
                 [self._destination_rename(target_pre, target_post, links=1)],
                 identity_only=True)

    def test_displaced_endpoint_cannot_stand_in_for_the_source(self):
        """A destination claim must never authorize the SOURCE's closing."""
        target_pre = [7, 11, 33188, 1664, 100, 300]
        target_post = [7, 11, 33188, 1664, 100, 360]
        with self.assertRaises(ValueError):
            join(dict(sequence=100, identity=self.pre),
                 dict(sequence=900, identity=target_post),
                 [self._destination_rename(target_pre, target_post)],
                 identity_only=True)

    def test_displaced_endpoint_that_changes_size_or_mtime_refuses(self):
        target_pre = [7, 11, 33188, 1664, 100, 300]
        bad_post = [7, 11, 33188, 99999, 100, 360]     # size moved
        with self.assertRaises(ValueError):
            join(dict(sequence=100, identity=target_pre),
                 dict(sequence=900, identity=bad_post),
                 [self._destination_rename(target_pre, bad_post)],
                 identity_only=True)

    def test_displaced_endpoint_with_unchanged_ctime_refuses(self):
        target_pre = [7, 11, 33188, 1664, 100, 300]
        with self.assertRaises(ValueError):
            join(dict(sequence=100, identity=target_pre),
                 dict(sequence=900, identity=target_pre),
                 [self._destination_rename(target_pre, target_pre)],
                 identity_only=True)

    def test_source_chain_still_works_when_a_replacement_also_exists(self):
        """The namespace default path over the SOURCE is unchanged.

        Same shape as the existing passing rename vector, plus a replacement block
        that must NOT interfere with the source composition.
        """
        tp=[7,11,33188,1664,100,300];tq=[7,11,33188,1664,100,360]
        producer=dict(sequence=10,path='/build/temp',identity=list(self.pre))
        window=dict(kind='actual-rename-window',producerCaptureSequence=10,
                    fromPath='/build/temp',toPath='/build/final',
                    beforeIdentity=list(self.pre),
                    replacementBefore=dict(identity=list(tp),namedIdentity=list(tp),links=1,
                                           original=dict(path='c1',bytes=9,sha256='a'*64)))
        change=dict(sequence=20,afterIdentity=list(self.ren),
                    replacementAfter=dict(identity=list(tq),links=0,
                                          original=dict(path='c2',bytes=9,sha256='b'*64)))
        consumer=dict(sequence=40,path='/build/final',identity=list(self.ren))
        self.assertEqual(join(producer,consumer,[(window,change)]),[20])

    def test_ambiguous_same_inode_source_and_destination_must_refuse(self):
        """A replacement whose dev/ino EQUALS the source is not a distinct inode.

        ROOT requires source-before and replacementBefore be distinguished by
        dev/ino with uniqueness; a same-inode "displaced" claim must refuse rather
        than silently authorize either side.
        """
        same = list(self.pre)              # identical dev/ino to the SOURCE
        same_post = [*same[:5], same[5] + 60]
        with self.assertRaises(ValueError):
            join(dict(sequence=100, identity=list(same)),
                 dict(sequence=900, identity=same_post),
                 [self._destination_rename(same, same_post)], identity_only=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)