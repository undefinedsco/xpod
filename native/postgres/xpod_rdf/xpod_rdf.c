#include "postgres.h"

#include "access/stratnum.h"
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
#define XPOD_RDF_PERM_PAGE_MAGIC 0x58525047
#define XPOD_RDF_PERM_MAX_KEYS 4
#define XPOD_RDF_PERM_PAGE_SPECIAL_SIZE MAXALIGN(sizeof(XpodRdfPermPageOpaque))
#define XPOD_RDF_PERM_MAX_ENTRY_SIZE (BLCKSZ - SizeOfPageHeaderData - XPOD_RDF_PERM_PAGE_SPECIAL_SIZE)

typedef struct XpodRdfPermPageOpaque
{
  uint32 magic;
  uint16 nkeys;
  uint16 flags;
  uint32 tuple_count;
  uint32 reserved;
  int64 min_keys[XPOD_RDF_PERM_MAX_KEYS];
  int64 max_keys[XPOD_RDF_PERM_MAX_KEYS];
} XpodRdfPermPageOpaque;

typedef struct XpodRdfPermEntry
{
  uint32 magic;
  uint16 nkeys;
  uint16 reserved;
  ItemPointerData heap_tid;
  int64 keys[FLEXIBLE_ARRAY_MEMBER];
} XpodRdfPermEntry;

typedef struct XpodRdfPermBuildEntry
{
  ItemPointerData heap_tid;
  uint16 nkeys;
  uint16 reserved;
  int64 keys[XPOD_RDF_PERM_MAX_KEYS];
} XpodRdfPermBuildEntry;

typedef struct XpodRdfPermBuildState
{
  XpodRdfPermBuildEntry *entries;
  uint64 entry_count;
  uint64 entry_capacity;
  uint16 nkeys;
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
static int xpod_rdf_perm_build_entry_compare(const void *left, const void *right);
static Size xpod_rdf_perm_entry_size(uint16 nkeys);
static void xpod_rdf_perm_assert_supported_nkeys(uint16 nkeys);
static bool xpod_rdf_perm_decode_build_entry(XpodRdfPermBuildEntry *entry,
                                             Datum *values,
                                             bool *isnull,
                                             ItemPointer heap_tid,
                                             uint16 nkeys);
static void xpod_rdf_perm_collect_build_entry(XpodRdfPermBuildState *state,
                                              XpodRdfPermBuildEntry *entry);
static bool xpod_rdf_perm_append_entry(Relation indexRelation,
                                       Datum *values,
                                       bool *isnull,
                                       ItemPointer heap_tid,
                                       uint16 nkeys);
static bool xpod_rdf_perm_append_build_entry(Relation indexRelation,
                                             XpodRdfPermBuildEntry *entry);
static bool xpod_rdf_perm_page_add_entry(Relation indexRelation,
                                         Buffer buffer,
                                         XpodRdfPermBuildEntry *build_entry,
                                         bool init_page);
static void xpod_rdf_perm_init_page(Page page, Size page_size, uint16 nkeys);
static XpodRdfPermPageOpaque *xpod_rdf_perm_page_opaque(Page page);
static void xpod_rdf_perm_page_update_range(Page page, XpodRdfPermEntry *entry);
static void xpod_rdf_perm_page_recompute_range(Page page);
static bool xpod_rdf_perm_page_may_match(IndexScanDesc scan, Page page);
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
  uint64 index_entry;

  memset(&build_state, 0, sizeof(XpodRdfPermBuildState));
  build_state.nkeys = indexRelation->rd_att->natts;
  build_state.index_tuples = 0;
  xpod_rdf_perm_assert_supported_nkeys(build_state.nkeys);

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

  if (build_state.entry_count > 1)
  {
    qsort(build_state.entries, build_state.entry_count, sizeof(XpodRdfPermBuildEntry), xpod_rdf_perm_build_entry_compare);
  }
  for (index_entry = 0; index_entry < build_state.entry_count; index_entry++)
  {
    if (xpod_rdf_perm_append_build_entry(indexRelation, &build_state.entries[index_entry]))
    {
      build_state.index_tuples++;
    }
  }

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
  xpod_rdf_perm_assert_supported_nkeys(indexRelation->rd_att->natts);
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
      xpod_rdf_perm_page_recompute_range(xlog_page);
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
  (void) loop_count;

  *indexStartupCost = 1.0;
  *indexSelectivity = 1.0;
  if (path->indexclauses != NIL)
  {
    int clause_count = list_length(path->indexclauses);

    while (clause_count-- > 0)
    {
      *indexSelectivity *= 0.1;
    }
  }
  *indexTotalCost = 1.0 + ((Cost) Max(path->indexinfo->pages, 1) * (*indexSelectivity));
  *indexCorrelation = 0.0;
  *indexPages = Max(path->indexinfo->pages, 1) * (*indexSelectivity);
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

    if (!xpod_rdf_perm_page_may_match(scan, page))
    {
      UnlockReleaseBuffer(buffer);
      opaque->current_block++;
      opaque->current_offset = FirstOffsetNumber;
      continue;
    }

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
  XpodRdfPermBuildEntry entry;

  (void) indexRelation;
  (void) tupleIsAlive;

  if (xpod_rdf_perm_decode_build_entry(&entry, values, isnull, tid, build_state->nkeys))
  {
    xpod_rdf_perm_collect_build_entry(build_state, &entry);
  }
}

static int
xpod_rdf_perm_build_entry_compare(const void *left, const void *right)
{
  const XpodRdfPermBuildEntry *left_entry = (const XpodRdfPermBuildEntry *) left;
  const XpodRdfPermBuildEntry *right_entry = (const XpodRdfPermBuildEntry *) right;
  uint16 nkeys = Min(left_entry->nkeys, right_entry->nkeys);
  uint16 key_index;
  int tid_compare;

  for (key_index = 0; key_index < nkeys; key_index++)
  {
    if (left_entry->keys[key_index] < right_entry->keys[key_index])
    {
      return -1;
    }
    if (left_entry->keys[key_index] > right_entry->keys[key_index])
    {
      return 1;
    }
  }
  if (left_entry->nkeys < right_entry->nkeys)
  {
    return -1;
  }
  if (left_entry->nkeys > right_entry->nkeys)
  {
    return 1;
  }

  tid_compare = ItemPointerCompare(
    (ItemPointer) &left_entry->heap_tid,
    (ItemPointer) &right_entry->heap_tid
  );
  return tid_compare < 0 ? -1 : tid_compare > 0 ? 1 : 0;
}

static Size
xpod_rdf_perm_entry_size(uint16 nkeys)
{
  return MAXALIGN(offsetof(XpodRdfPermEntry, keys) + (sizeof(int64) * nkeys));
}

static void
xpod_rdf_perm_assert_supported_nkeys(uint16 nkeys)
{
  if (nkeys == 0 || nkeys > XPOD_RDF_PERM_MAX_KEYS)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf_perm supports between 1 and %d indexed columns", XPOD_RDF_PERM_MAX_KEYS),
             errdetail("Requested indexed columns: %u.", nkeys)));
  }
}

static bool
xpod_rdf_perm_decode_build_entry(XpodRdfPermBuildEntry *entry,
                                 Datum *values,
                                 bool *isnull,
                                 ItemPointer heap_tid,
                                 uint16 nkeys)
{
  uint16 key_index;

  xpod_rdf_perm_assert_supported_nkeys(nkeys);
  memset(entry, 0, sizeof(XpodRdfPermBuildEntry));
  entry->nkeys = nkeys;
  ItemPointerCopy(heap_tid, &entry->heap_tid);

  for (key_index = 0; key_index < nkeys; key_index++)
  {
    if (isnull[key_index])
    {
      return false;
    }
    entry->keys[key_index] = DatumGetInt64(values[key_index]);
  }
  return true;
}

static void
xpod_rdf_perm_collect_build_entry(XpodRdfPermBuildState *state, XpodRdfPermBuildEntry *entry)
{
  if (state->entry_count == state->entry_capacity)
  {
    uint64 new_capacity = state->entry_capacity == 0 ? 1024 : state->entry_capacity * 2;

    if (state->entries == NULL)
    {
      state->entries = palloc(sizeof(XpodRdfPermBuildEntry) * new_capacity);
    }
    else
    {
      state->entries = repalloc(state->entries, sizeof(XpodRdfPermBuildEntry) * new_capacity);
    }
    state->entry_capacity = new_capacity;
  }
  state->entries[state->entry_count++] = *entry;
}

static bool
xpod_rdf_perm_append_entry(Relation indexRelation,
                           Datum *values,
                           bool *isnull,
                           ItemPointer heap_tid,
                           uint16 nkeys)
{
  XpodRdfPermBuildEntry entry;

  if (!xpod_rdf_perm_decode_build_entry(&entry, values, isnull, heap_tid, nkeys))
  {
    return false;
  }
  return xpod_rdf_perm_append_build_entry(indexRelation, &entry);
}

static bool
xpod_rdf_perm_append_build_entry(Relation indexRelation, XpodRdfPermBuildEntry *entry)
{
  Size entry_size = xpod_rdf_perm_entry_size(entry->nkeys);
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
    if (xpod_rdf_perm_page_add_entry(indexRelation, buffer, entry, false))
    {
      UnlockReleaseBuffer(buffer);
      return true;
    }
    UnlockReleaseBuffer(buffer);
  }

  buffer = ReadBuffer(indexRelation, P_NEW);
  LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
  if (!xpod_rdf_perm_page_add_entry(indexRelation, buffer, entry, true))
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
                             XpodRdfPermBuildEntry *build_entry,
                             bool init_page)
{
  Size entry_size = xpod_rdf_perm_entry_size(build_entry->nkeys);
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
  entry->nkeys = build_entry->nkeys;
  entry->reserved = 0;
  ItemPointerCopy(&build_entry->heap_tid, &entry->heap_tid);

  for (key_index = 0; key_index < build_entry->nkeys; key_index++)
  {
    entry->keys[key_index] = build_entry->keys[key_index];
  }

  state = GenericXLogStart(indexRelation);
  page = GenericXLogRegisterBuffer(state, buffer, GENERIC_XLOG_FULL_IMAGE);
  if (init_page || PageGetMaxOffsetNumber(page) == 0)
  {
    xpod_rdf_perm_init_page(page, BufferGetPageSize(buffer), build_entry->nkeys);
  }

  inserted = PageAddItem(page, (Item) entry, entry_size, InvalidOffsetNumber, false, false);

  if (inserted == InvalidOffsetNumber)
  {
    pfree(entry);
    GenericXLogAbort(state);
    return false;
  }

  xpod_rdf_perm_page_update_range(page, entry);
  pfree(entry);
  GenericXLogFinish(state);
  return true;
}

static void
xpod_rdf_perm_init_page(Page page, Size page_size, uint16 nkeys)
{
  XpodRdfPermPageOpaque *opaque;

  PageInit(page, page_size, XPOD_RDF_PERM_PAGE_SPECIAL_SIZE);
  opaque = (XpodRdfPermPageOpaque *) PageGetSpecialPointer(page);
  memset(opaque, 0, sizeof(XpodRdfPermPageOpaque));
  opaque->magic = XPOD_RDF_PERM_PAGE_MAGIC;
  opaque->nkeys = nkeys;
}

static XpodRdfPermPageOpaque *
xpod_rdf_perm_page_opaque(Page page)
{
  XpodRdfPermPageOpaque *opaque;

  if (PageGetSpecialSize(page) < sizeof(XpodRdfPermPageOpaque))
  {
    return NULL;
  }
  opaque = (XpodRdfPermPageOpaque *) PageGetSpecialPointer(page);
  return opaque->magic == XPOD_RDF_PERM_PAGE_MAGIC ? opaque : NULL;
}

static void
xpod_rdf_perm_page_update_range(Page page, XpodRdfPermEntry *entry)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  uint16 key_index;

  if (opaque == NULL || entry->nkeys > XPOD_RDF_PERM_MAX_KEYS)
  {
    return;
  }

  if (opaque->tuple_count == 0)
  {
    opaque->nkeys = entry->nkeys;
    for (key_index = 0; key_index < entry->nkeys; key_index++)
    {
      opaque->min_keys[key_index] = entry->keys[key_index];
      opaque->max_keys[key_index] = entry->keys[key_index];
    }
  }
  else
  {
    for (key_index = 0; key_index < entry->nkeys; key_index++)
    {
      if (entry->keys[key_index] < opaque->min_keys[key_index])
      {
        opaque->min_keys[key_index] = entry->keys[key_index];
      }
      if (entry->keys[key_index] > opaque->max_keys[key_index])
      {
        opaque->max_keys[key_index] = entry->keys[key_index];
      }
    }
  }
  opaque->tuple_count++;
}

static void
xpod_rdf_perm_page_recompute_range(Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  OffsetNumber max_offset;
  OffsetNumber offset;

  if (opaque == NULL)
  {
    return;
  }

  opaque->tuple_count = 0;
  memset(opaque->min_keys, 0, sizeof(opaque->min_keys));
  memset(opaque->max_keys, 0, sizeof(opaque->max_keys));

  max_offset = PageGetMaxOffsetNumber(page);
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
    xpod_rdf_perm_page_update_range(page, entry);
  }
}

static bool
xpod_rdf_perm_page_may_match(IndexScanDesc scan, Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  int index_key;

  if (opaque == NULL)
  {
    return true;
  }
  if (opaque->tuple_count == 0)
  {
    return false;
  }

  for (index_key = 0; index_key < scan->numberOfKeys; index_key++)
  {
    ScanKey key = &scan->keyData[index_key];
    int attr_index = key->sk_attno - 1;
    int64 argument;

    if ((key->sk_flags & SK_ISNULL) || attr_index < 0 || attr_index >= opaque->nkeys)
    {
      return false;
    }
    argument = DatumGetInt64(key->sk_argument);

    switch (key->sk_strategy)
    {
      case BTLessStrategyNumber:
        if (opaque->min_keys[attr_index] >= argument)
        {
          return false;
        }
        break;
      case BTLessEqualStrategyNumber:
        if (opaque->min_keys[attr_index] > argument)
        {
          return false;
        }
        break;
      case BTEqualStrategyNumber:
        if (argument < opaque->min_keys[attr_index] || argument > opaque->max_keys[attr_index])
        {
          return false;
        }
        break;
      case BTGreaterEqualStrategyNumber:
        if (opaque->max_keys[attr_index] < argument)
        {
          return false;
        }
        break;
      case BTGreaterStrategyNumber:
        if (opaque->max_keys[attr_index] <= argument)
        {
          return false;
        }
        break;
      default:
        return true;
    }
  }
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
