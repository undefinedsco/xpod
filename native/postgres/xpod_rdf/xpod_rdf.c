#include "postgres.h"

#include "access/amapi.h"
#include "access/genam.h"
#include "access/generic_xlog.h"
#include "access/tableam.h"
#include "fmgr.h"
#include "miscadmin.h"
#include "nodes/pathnodes.h"
#include "storage/bufpage.h"
#include "storage/bufmgr.h"
#include "storage/itemptr.h"
#include "utils/rel.h"
#include "utils/builtins.h"

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(xpod_rdf_version);
PG_FUNCTION_INFO_V1(xpod_rdf_capabilities);
PG_FUNCTION_INFO_V1(xpod_rdf_term_id_cmp);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_handler);

static IndexBuildResult *xpod_rdf_perm_build(Relation heapRelation,
                                             Relation indexRelation,
                                             struct IndexInfo *indexInfo);
static void xpod_rdf_perm_build_empty(Relation indexRelation);
static bool xpod_rdf_perm_insert(Relation indexRelation,
                                 Datum *values,
                                 bool *isnull,
                                 ItemPointer heap_tid,
                                 Relation heapRelation,
                                 IndexUniqueCheck checkUnique,
                                 bool indexUnchanged,
                                 struct IndexInfo *indexInfo);
static IndexBulkDeleteResult *xpod_rdf_perm_bulk_delete(IndexVacuumInfo *info,
                                                        IndexBulkDeleteResult *stats,
                                                        IndexBulkDeleteCallback callback,
                                                        void *callback_state);
static IndexBulkDeleteResult *xpod_rdf_perm_vacuum_cleanup(IndexVacuumInfo *info,
                                                           IndexBulkDeleteResult *stats);
static void xpod_rdf_perm_cost_estimate(struct PlannerInfo *root,
                                        struct IndexPath *path,
                                        double loop_count,
                                        Cost *indexStartupCost,
                                        Cost *indexTotalCost,
                                        Selectivity *indexSelectivity,
                                        double *indexCorrelation,
                                        double *indexPages);
static bool xpod_rdf_perm_validate(Oid opclassoid);
static IndexScanDesc xpod_rdf_perm_begin_scan(Relation indexRelation,
                                              int nkeys,
                                              int norderbys);
static void xpod_rdf_perm_rescan(IndexScanDesc scan,
                                 ScanKey keys,
                                 int nkeys,
                                 ScanKey orderbys,
                                 int norderbys);
static bool xpod_rdf_perm_get_tuple(IndexScanDesc scan, ScanDirection direction);
static int64 xpod_rdf_perm_get_bitmap(IndexScanDesc scan, TIDBitmap *tbm);
static void xpod_rdf_perm_end_scan(IndexScanDesc scan);

#define XPOD_RDF_PERM_MAGIC 0x58524446
#define XPOD_RDF_PERM_MAX_ENTRY_SIZE (BLCKSZ - SizeOfPageHeaderData)

typedef struct XpodRdfPermEntry
{
  uint32 magic;
  uint16 nkeys;
  uint16 reserved;
  ItemPointerData heap_tid;
  int64 keys[FLEXIBLE_ARRAY_MEMBER];
} XpodRdfPermEntry;

typedef struct XpodRdfPermBuildState
{
  double index_tuples;
} XpodRdfPermBuildState;

typedef struct XpodRdfPermScanOpaque
{
  BlockNumber current_block;
  OffsetNumber current_offset;
} XpodRdfPermScanOpaque;

static void xpod_rdf_perm_build_callback(Relation indexRelation,
                                         ItemPointer tid,
                                         Datum *values,
                                         bool *isnull,
                                         bool tupleIsAlive,
                                         void *state);
static Size xpod_rdf_perm_entry_size(uint16 nkeys);
static bool xpod_rdf_perm_append_entry(Relation indexRelation,
                                       Datum *values,
                                       bool *isnull,
                                       ItemPointer heap_tid,
                                       uint16 nkeys);
static bool xpod_rdf_perm_page_add_entry(Relation indexRelation,
                                         Buffer buffer,
                                         Datum *values,
                                         bool *isnull,
                                         ItemPointer heap_tid,
                                         uint16 nkeys,
                                         bool init_page);
static bool xpod_rdf_perm_entry_matches(IndexScanDesc scan, XpodRdfPermEntry *entry);

Datum
xpod_rdf_version(PG_FUNCTION_ARGS)
{
  (void) fcinfo;
  PG_RETURN_TEXT_P(cstring_to_text("0.1.0-native"));
}

Datum
xpod_rdf_capabilities(PG_FUNCTION_ARGS)
{
  (void) fcinfo;
  PG_RETURN_TEXT_P(cstring_to_text(
    "scan.exact_graph,"
    "scan.graph_prefix,"
    "scan.term_in,"
    "join.required_bgp,"
    "aggregate.count,"
    "aggregate.numeric,"
    "cache.result,"
    "index.xpod_rdf_perm"
  ));
}

Datum
xpod_rdf_term_id_cmp(PG_FUNCTION_ARGS)
{
  int64 left = PG_GETARG_INT64(0);
  int64 right = PG_GETARG_INT64(1);

  if (left < right)
  {
    PG_RETURN_INT32(-1);
  }
  if (left > right)
  {
    PG_RETURN_INT32(1);
  }
  PG_RETURN_INT32(0);
}

Datum
xpod_rdf_perm_handler(PG_FUNCTION_ARGS)
{
  IndexAmRoutine *routine = makeNode(IndexAmRoutine);

  (void) fcinfo;

  routine->amstrategies = 5;
  routine->amsupport = 1;
  routine->amoptsprocnum = 0;
  routine->amcanorder = false;
  routine->amcanorderbyop = false;
  routine->amcanbackward = false;
  routine->amcanunique = false;
  routine->amcanmulticol = true;
  routine->amoptionalkey = true;
  routine->amsearcharray = false;
  routine->amsearchnulls = false;
  routine->amstorage = false;
  routine->amclusterable = false;
  routine->ampredlocks = false;
  routine->amcanparallel = false;
  routine->amcanbuildparallel = false;
  routine->amcaninclude = false;
  routine->amusemaintenanceworkmem = false;
  routine->amsummarizing = false;
  routine->amparallelvacuumoptions = 0;
  routine->amkeytype = InvalidOid;

  routine->ambuild = xpod_rdf_perm_build;
  routine->ambuildempty = xpod_rdf_perm_build_empty;
  routine->aminsert = xpod_rdf_perm_insert;
  routine->aminsertcleanup = NULL;
  routine->ambulkdelete = xpod_rdf_perm_bulk_delete;
  routine->amvacuumcleanup = xpod_rdf_perm_vacuum_cleanup;
  routine->amcanreturn = NULL;
  routine->amcostestimate = xpod_rdf_perm_cost_estimate;
  routine->amoptions = NULL;
  routine->amproperty = NULL;
  routine->ambuildphasename = NULL;
  routine->amvalidate = xpod_rdf_perm_validate;
  routine->amadjustmembers = NULL;
  routine->ambeginscan = xpod_rdf_perm_begin_scan;
  routine->amrescan = xpod_rdf_perm_rescan;
  routine->amgettuple = xpod_rdf_perm_get_tuple;
  routine->amgetbitmap = xpod_rdf_perm_get_bitmap;
  routine->amendscan = xpod_rdf_perm_end_scan;
  routine->ammarkpos = NULL;
  routine->amrestrpos = NULL;
  routine->amestimateparallelscan = NULL;
  routine->aminitparallelscan = NULL;
  routine->amparallelrescan = NULL;

  PG_RETURN_POINTER(routine);
}

static IndexBuildResult *
xpod_rdf_perm_build(Relation heapRelation,
                    Relation indexRelation,
                    struct IndexInfo *indexInfo)
{
  IndexBuildResult *result = palloc0(sizeof(IndexBuildResult));
  XpodRdfPermBuildState build_state;

  build_state.index_tuples = 0;

  result->heap_tuples = table_index_build_scan(
    heapRelation,
    indexRelation,
    indexInfo,
    true,
    true,
    xpod_rdf_perm_build_callback,
    &build_state,
    NULL
  );
  result->index_tuples = build_state.index_tuples;
  return result;
}

static void
xpod_rdf_perm_build_empty(Relation indexRelation)
{
  (void) indexRelation;
}

static bool
xpod_rdf_perm_insert(Relation indexRelation,
                     Datum *values,
                     bool *isnull,
                     ItemPointer heap_tid,
                     Relation heapRelation,
                     IndexUniqueCheck checkUnique,
                     bool indexUnchanged,
                     struct IndexInfo *indexInfo)
{
  (void) heapRelation;
  (void) checkUnique;
  (void) indexUnchanged;
  (void) indexInfo;
  return xpod_rdf_perm_append_entry(indexRelation, values, isnull, heap_tid, indexRelation->rd_att->natts);
}

static IndexBulkDeleteResult *
xpod_rdf_perm_bulk_delete(IndexVacuumInfo *info,
                          IndexBulkDeleteResult *stats,
                          IndexBulkDeleteCallback callback,
                          void *callback_state)
{
  BlockNumber block_count;
  BlockNumber block;

  if (stats == NULL)
  {
    stats = palloc0(sizeof(IndexBulkDeleteResult));
  }

  block_count = RelationGetNumberOfBlocks(info->index);
  stats->num_pages = block_count;
  stats->estimated_count = false;

  for (block = 0; block < block_count; block++)
  {
    Buffer buffer;
    Page page;
    OffsetNumber max_offset;
    OffsetNumber *offsets;
    int delete_count = 0;
    OffsetNumber offset;

    buffer = ReadBuffer(info->index, block);
    LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
    page = BufferGetPage(buffer);
    max_offset = PageGetMaxOffsetNumber(page);
    offsets = max_offset > 0 ? palloc(sizeof(OffsetNumber) * max_offset) : NULL;

    for (offset = FirstOffsetNumber; offset <= max_offset; offset = OffsetNumberNext(offset))
    {
      ItemId item_id = PageGetItemId(page, offset);
      XpodRdfPermEntry *entry;

      if (!ItemIdHasStorage(item_id))
      {
        continue;
      }

      entry = (XpodRdfPermEntry *) PageGetItem(page, item_id);
      if (entry->magic != XPOD_RDF_PERM_MAGIC)
      {
        continue;
      }

      if (callback != NULL && callback(&entry->heap_tid, callback_state))
      {
        offsets[delete_count++] = offset;
      }
      else
      {
        stats->num_index_tuples++;
      }
    }

    if (delete_count > 0)
    {
      GenericXLogState *state = GenericXLogStart(info->index);
      Page xlog_page = GenericXLogRegisterBuffer(state, buffer, GENERIC_XLOG_FULL_IMAGE);

      PageIndexMultiDelete(xlog_page, offsets, delete_count);
      GenericXLogFinish(state);
      stats->tuples_removed += delete_count;
    }

    if (offsets != NULL)
    {
      pfree(offsets);
    }
    UnlockReleaseBuffer(buffer);
  }
  return stats;
}

static IndexBulkDeleteResult *
xpod_rdf_perm_vacuum_cleanup(IndexVacuumInfo *info, IndexBulkDeleteResult *stats)
{
  if (stats == NULL)
  {
    stats = palloc0(sizeof(IndexBulkDeleteResult));
  }
  stats->num_pages = RelationGetNumberOfBlocks(info->index);
  return stats;
}

static void
xpod_rdf_perm_cost_estimate(struct PlannerInfo *root,
                            struct IndexPath *path,
                            double loop_count,
                            Cost *indexStartupCost,
                            Cost *indexTotalCost,
                            Selectivity *indexSelectivity,
                            double *indexCorrelation,
                            double *indexPages)
{
  (void) root;
  (void) path;
  (void) loop_count;

  *indexStartupCost = 1000000000.0;
  *indexTotalCost = 1000000000.0;
  *indexSelectivity = 1.0;
  *indexCorrelation = 0.0;
  *indexPages = 1.0;
}

static bool
xpod_rdf_perm_validate(Oid opclassoid)
{
  (void) opclassoid;
  return true;
}

static IndexScanDesc
xpod_rdf_perm_begin_scan(Relation indexRelation, int nkeys, int norderbys)
{
  IndexScanDesc scan = RelationGetIndexScan(indexRelation, nkeys, norderbys);
  XpodRdfPermScanOpaque *opaque = palloc0(sizeof(XpodRdfPermScanOpaque));

  opaque->current_block = 0;
  opaque->current_offset = FirstOffsetNumber;
  scan->opaque = opaque;
  return scan;
}

static void
xpod_rdf_perm_rescan(IndexScanDesc scan,
                     ScanKey keys,
                     int nkeys,
                     ScanKey orderbys,
                     int norderbys)
{
  XpodRdfPermScanOpaque *opaque = (XpodRdfPermScanOpaque *) scan->opaque;

  if (keys && nkeys > 0)
  {
    memmove(scan->keyData, keys, nkeys * sizeof(ScanKeyData));
    scan->numberOfKeys = nkeys;
  }
  if (orderbys && norderbys > 0)
  {
    memmove(scan->orderByData, orderbys, norderbys * sizeof(ScanKeyData));
    scan->numberOfOrderBys = norderbys;
  }

  opaque->current_block = 0;
  opaque->current_offset = FirstOffsetNumber;
}

static bool
xpod_rdf_perm_get_tuple(IndexScanDesc scan, ScanDirection direction)
{
  XpodRdfPermScanOpaque *opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  BlockNumber block_count;

  if (!ScanDirectionIsForward(direction))
  {
    return false;
  }

  block_count = RelationGetNumberOfBlocks(scan->indexRelation);
  while (opaque->current_block < block_count)
  {
    Buffer buffer;
    Page page;
    OffsetNumber max_offset;
    OffsetNumber offset;

    buffer = ReadBuffer(scan->indexRelation, opaque->current_block);
    LockBuffer(buffer, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buffer);
    max_offset = PageGetMaxOffsetNumber(page);

    for (offset = opaque->current_offset; offset <= max_offset; offset = OffsetNumberNext(offset))
    {
      ItemId item_id = PageGetItemId(page, offset);
      XpodRdfPermEntry *entry;

      if (!ItemIdHasStorage(item_id))
      {
        continue;
      }

      entry = (XpodRdfPermEntry *) PageGetItem(page, item_id);
      if (entry->magic != XPOD_RDF_PERM_MAGIC || !xpod_rdf_perm_entry_matches(scan, entry))
      {
        continue;
      }

      scan->xs_heaptid = entry->heap_tid;
      scan->xs_recheck = false;
      opaque->current_offset = OffsetNumberNext(offset);
      UnlockReleaseBuffer(buffer);
      return true;
    }

    UnlockReleaseBuffer(buffer);
    opaque->current_block++;
    opaque->current_offset = FirstOffsetNumber;
  }
  return false;
}

static int64
xpod_rdf_perm_get_bitmap(IndexScanDesc scan, TIDBitmap *tbm)
{
  int64 count = 0;

  while (xpod_rdf_perm_get_tuple(scan, ForwardScanDirection))
  {
    tbm_add_tuples(tbm, &scan->xs_heaptid, 1, false);
    count++;
  }
  return count;
}

static void
xpod_rdf_perm_end_scan(IndexScanDesc scan)
{
  XpodRdfPermScanOpaque *opaque = (XpodRdfPermScanOpaque *) scan->opaque;

  if (opaque != NULL)
  {
    pfree(opaque);
  }
  pfree(scan);
}

static void
xpod_rdf_perm_build_callback(Relation indexRelation,
                             ItemPointer tid,
                             Datum *values,
                             bool *isnull,
                             bool tupleIsAlive,
                             void *state)
{
  XpodRdfPermBuildState *build_state = (XpodRdfPermBuildState *) state;

  (void) tupleIsAlive;

  if (xpod_rdf_perm_append_entry(indexRelation, values, isnull, tid, indexRelation->rd_att->natts))
  {
    build_state->index_tuples++;
  }
}

static Size
xpod_rdf_perm_entry_size(uint16 nkeys)
{
  return MAXALIGN(offsetof(XpodRdfPermEntry, keys) + (sizeof(int64) * nkeys));
}

static bool
xpod_rdf_perm_append_entry(Relation indexRelation,
                           Datum *values,
                           bool *isnull,
                           ItemPointer heap_tid,
                           uint16 nkeys)
{
  Size entry_size = xpod_rdf_perm_entry_size(nkeys);
  BlockNumber block_count = RelationGetNumberOfBlocks(indexRelation);
  Buffer buffer;

  if (entry_size > XPOD_RDF_PERM_MAX_ENTRY_SIZE)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf_perm index entry is too large"),
             errdetail("Entry size %zu exceeds page capacity.", entry_size)));
  }

  if (block_count > 0)
  {
    buffer = ReadBuffer(indexRelation, block_count - 1);
    LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
    if (xpod_rdf_perm_page_add_entry(indexRelation, buffer, values, isnull, heap_tid, nkeys, false))
    {
      UnlockReleaseBuffer(buffer);
      return true;
    }
    UnlockReleaseBuffer(buffer);
  }

  buffer = ReadBuffer(indexRelation, P_NEW);
  LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
  if (!xpod_rdf_perm_page_add_entry(indexRelation, buffer, values, isnull, heap_tid, nkeys, true))
  {
    UnlockReleaseBuffer(buffer);
    ereport(ERROR,
            (errmsg("could not append xpod_rdf_perm index entry"),
             errdetail("New index page did not have enough free space.")));
  }
  UnlockReleaseBuffer(buffer);
  return true;
}

static bool
xpod_rdf_perm_page_add_entry(Relation indexRelation,
                             Buffer buffer,
                             Datum *values,
                             bool *isnull,
                             ItemPointer heap_tid,
                             uint16 nkeys,
                             bool init_page)
{
  Size entry_size = xpod_rdf_perm_entry_size(nkeys);
  XpodRdfPermEntry *entry;
  GenericXLogState *state;
  Page page;
  OffsetNumber inserted;
  uint16 key_index;

  page = BufferGetPage(buffer);
  if (!init_page && PageGetFreeSpace(page) < entry_size)
  {
    return false;
  }

  entry = palloc0(entry_size);
  entry->magic = XPOD_RDF_PERM_MAGIC;
  entry->nkeys = nkeys;
  entry->reserved = 0;
  ItemPointerCopy(heap_tid, &entry->heap_tid);

  for (key_index = 0; key_index < nkeys; key_index++)
  {
    if (isnull[key_index])
    {
      pfree(entry);
      return false;
    }
    entry->keys[key_index] = DatumGetInt64(values[key_index]);
  }

  state = GenericXLogStart(indexRelation);
  page = GenericXLogRegisterBuffer(state, buffer, GENERIC_XLOG_FULL_IMAGE);
  if (init_page || PageGetMaxOffsetNumber(page) == 0)
  {
    PageInit(page, BufferGetPageSize(buffer), 0);
  }

  inserted = PageAddItem(page, (Item) entry, entry_size, InvalidOffsetNumber, false, false);
  pfree(entry);

  if (inserted == InvalidOffsetNumber)
  {
    GenericXLogAbort(state);
    return false;
  }

  GenericXLogFinish(state);
  return true;
}

static bool
xpod_rdf_perm_entry_matches(IndexScanDesc scan, XpodRdfPermEntry *entry)
{
  int index_key;

  for (index_key = 0; index_key < scan->numberOfKeys; index_key++)
  {
    ScanKey key = &scan->keyData[index_key];
    Datum value;
    Datum matched;

    if ((key->sk_flags & SK_ISNULL) || key->sk_attno < 1 || key->sk_attno > entry->nkeys)
    {
      return false;
    }

    value = Int64GetDatum(entry->keys[key->sk_attno - 1]);
    matched = FunctionCall2Coll(&key->sk_func, key->sk_collation, value, key->sk_argument);
    if (!DatumGetBool(matched))
    {
      return false;
    }
  }

  return true;
}
