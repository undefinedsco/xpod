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
#define XPOD_RDF_PERM_META_MAGIC 0x58524d54
#define XPOD_RDF_PERM_PAGE_MAGIC 0x58525047
#define XPOD_RDF_PERM_SCHEMA_VERSION 1
#define XPOD_RDF_PERM_MAX_KEYS 4
#define XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED 0x0001
#define XPOD_RDF_PERM_PAGE_FLAG_SORTED 0x0001
#define XPOD_RDF_PERM_META_SPECIAL_SIZE MAXALIGN(sizeof(XpodRdfPermMetaOpaque))
#define XPOD_RDF_PERM_PAGE_SPECIAL_SIZE MAXALIGN(sizeof(XpodRdfPermPageOpaque))
#define XPOD_RDF_PERM_MAX_ENTRY_SIZE (BLCKSZ - SizeOfPageHeaderData - XPOD_RDF_PERM_PAGE_SPECIAL_SIZE)

typedef struct XpodRdfPermMetaOpaque
{
  uint32 magic;
  uint16 schema_version;
  uint16 nkeys;
  uint16 flags;
  uint16 reserved16;
  uint32 reserved32;
  uint64 tuple_count;
  int64 last_keys[XPOD_RDF_PERM_MAX_KEYS];
} XpodRdfPermMetaOpaque;

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

typedef struct XpodRdfPermColumnBound
{
  bool has_equal;
  int64 equal;
  bool has_lower;
  bool lower_inclusive;
  int64 lower;
  bool has_upper;
  bool upper_inclusive;
  int64 upper;
} XpodRdfPermColumnBound;

typedef struct XpodRdfPermScanBounds
{
  bool impossible;
  uint16 nkeys;
  XpodRdfPermColumnBound columns[XPOD_RDF_PERM_MAX_KEYS];
} XpodRdfPermScanBounds;

typedef struct XpodRdfPermScanOpaque
{
  BlockNumber first_data_block;
  BlockNumber current_block;
  OffsetNumber current_offset;
  bool global_sorted;
  XpodRdfPermScanBounds bounds;
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
                                             XpodRdfPermBuildEntry *entry,
                                             bool update_meta);
static void xpod_rdf_perm_ensure_metapage(Relation indexRelation, uint16 nkeys);
static XpodRdfPermMetaOpaque *xpod_rdf_perm_meta_opaque(Page page);
static bool xpod_rdf_perm_relation_has_metapage(Relation indexRelation);
static BlockNumber xpod_rdf_perm_first_data_block(Relation indexRelation);
static bool xpod_rdf_perm_relation_is_globally_sorted(Relation indexRelation);
static void xpod_rdf_perm_meta_note_append(Relation indexRelation, XpodRdfPermBuildEntry *entry);
static void xpod_rdf_perm_meta_finish_ordered_build(Relation indexRelation,
                                                    uint16 nkeys,
                                                    uint64 tuple_count,
                                                    XpodRdfPermBuildEntry *last_entry);
static int xpod_rdf_perm_meta_compare_last_keys(XpodRdfPermMetaOpaque *opaque, XpodRdfPermBuildEntry *entry);
static bool xpod_rdf_perm_page_add_entry(Relation indexRelation,
                                         Buffer buffer,
                                         XpodRdfPermBuildEntry *build_entry,
                                         bool init_page);
static void xpod_rdf_perm_init_page(Page page, Size page_size, uint16 nkeys);
static XpodRdfPermPageOpaque *xpod_rdf_perm_page_opaque(Page page);
static XpodRdfPermEntry *xpod_rdf_perm_page_entry(Page page, OffsetNumber offset);
static bool xpod_rdf_perm_page_is_sorted(Page page);
static void xpod_rdf_perm_page_update_range(Page page, XpodRdfPermEntry *entry);
static void xpod_rdf_perm_page_recompute_range(Page page);
static void xpod_rdf_perm_page_update_sorted_flag(Page page, XpodRdfPermEntry *entry);
static bool xpod_rdf_perm_page_may_match(IndexScanDesc scan, Page page);
static bool xpod_rdf_perm_page_last_before_lower_bound(IndexScanDesc scan, Page page);
static bool xpod_rdf_perm_page_first_past_upper_bound(IndexScanDesc scan, Page page);
static BlockNumber xpod_rdf_perm_seek_lower_block(IndexScanDesc scan, BlockNumber first_block, BlockNumber block_count);
static OffsetNumber xpod_rdf_perm_page_seek_lower_bound(IndexScanDesc scan, Page page);
static bool xpod_rdf_perm_entry_past_upper_bound(IndexScanDesc scan, XpodRdfPermEntry *entry);
static bool xpod_rdf_perm_entry_matches(IndexScanDesc scan, XpodRdfPermEntry *entry);
static void xpod_rdf_perm_prepare_scan_bounds(IndexScanDesc scan);
static void xpod_rdf_perm_prepare_scan_position(IndexScanDesc scan);
static void xpod_rdf_perm_apply_scan_key_bound(XpodRdfPermScanBounds *bounds, ScanKey key);
static void xpod_rdf_perm_finalize_scan_bounds(XpodRdfPermScanBounds *bounds);
static bool xpod_rdf_perm_bounds_lower_prefix(XpodRdfPermScanBounds *bounds, uint16 nkeys, int64 *keys, uint16 *prefix_nkeys);
static bool xpod_rdf_perm_bounds_upper_prefix(XpodRdfPermScanBounds *bounds, uint16 nkeys, int64 *keys, uint16 *prefix_nkeys, bool *inclusive);
static int xpod_rdf_perm_entry_compare_entry(XpodRdfPermEntry *left, XpodRdfPermEntry *right);
static int xpod_rdf_perm_entry_compare_key_prefix(XpodRdfPermEntry *entry, int64 *keys, uint16 nkeys);
static int xpod_rdf_perm_key_prefix_compare(int64 *left, uint16 left_nkeys, int64 *right, uint16 right_nkeys);

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
  xpod_rdf_perm_ensure_metapage(indexRelation, build_state.nkeys);

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
    if (xpod_rdf_perm_append_build_entry(indexRelation, &build_state.entries[index_entry], false))
    {
      build_state.index_tuples++;
    }
  }
  xpod_rdf_perm_meta_finish_ordered_build(
    indexRelation,
    build_state.nkeys,
    build_state.entry_count,
    build_state.entry_count > 0 ? &build_state.entries[build_state.entry_count - 1] : NULL
  );

  result->index_tuples = build_state.index_tuples;
  return result;
}

static void
xpod_rdf_perm_build_empty(Relation indexRelation)
{
  xpod_rdf_perm_assert_supported_nkeys(indexRelation->rd_att->natts);
  xpod_rdf_perm_ensure_metapage(indexRelation, indexRelation->rd_att->natts);
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

  opaque->first_data_block = xpod_rdf_perm_first_data_block(indexRelation);
  opaque->current_block = opaque->first_data_block;
  opaque->current_offset = FirstOffsetNumber;
  scan->opaque = opaque;
  xpod_rdf_perm_prepare_scan_bounds(scan);
  xpod_rdf_perm_prepare_scan_position(scan);
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

  opaque->first_data_block = xpod_rdf_perm_first_data_block(scan->indexRelation);
  opaque->current_block = opaque->first_data_block;
  opaque->current_offset = FirstOffsetNumber;
  xpod_rdf_perm_prepare_scan_bounds(scan);
  xpod_rdf_perm_prepare_scan_position(scan);
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
    bool page_sorted;

    buffer = ReadBuffer(scan->indexRelation, opaque->current_block);
    LockBuffer(buffer, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buffer);
    max_offset = PageGetMaxOffsetNumber(page);
    page_sorted = xpod_rdf_perm_page_is_sorted(page);

    if (opaque->global_sorted && xpod_rdf_perm_page_first_past_upper_bound(scan, page))
    {
      UnlockReleaseBuffer(buffer);
      return false;
    }

    if (!xpod_rdf_perm_page_may_match(scan, page))
    {
      UnlockReleaseBuffer(buffer);
      opaque->current_block++;
      opaque->current_offset = FirstOffsetNumber;
      continue;
    }

    if (opaque->current_offset == FirstOffsetNumber)
    {
      OffsetNumber lower_bound_offset = xpod_rdf_perm_page_seek_lower_bound(scan, page);

      if (!OffsetNumberIsValid(lower_bound_offset))
      {
        UnlockReleaseBuffer(buffer);
        opaque->current_block++;
        opaque->current_offset = FirstOffsetNumber;
        continue;
      }
      opaque->current_offset = lower_bound_offset;
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
      if (page_sorted && xpod_rdf_perm_entry_past_upper_bound(scan, entry))
      {
        break;
      }
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
  return xpod_rdf_perm_append_build_entry(indexRelation, &entry, true);
}

static bool
xpod_rdf_perm_append_build_entry(Relation indexRelation, XpodRdfPermBuildEntry *entry, bool update_meta)
{
  Size entry_size = xpod_rdf_perm_entry_size(entry->nkeys);
  BlockNumber block_count;
  BlockNumber first_data_block;
  Buffer buffer;

  if (entry_size > XPOD_RDF_PERM_MAX_ENTRY_SIZE)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf_perm index entry is too large"),
             errdetail("Entry size %zu exceeds page capacity.", entry_size)));
  }

  xpod_rdf_perm_ensure_metapage(indexRelation, entry->nkeys);
  if (update_meta)
  {
    xpod_rdf_perm_meta_note_append(indexRelation, entry);
  }

  block_count = RelationGetNumberOfBlocks(indexRelation);
  first_data_block = xpod_rdf_perm_first_data_block(indexRelation);
  if (block_count > first_data_block)
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

static void
xpod_rdf_perm_ensure_metapage(Relation indexRelation, uint16 nkeys)
{
  BlockNumber block_count = RelationGetNumberOfBlocks(indexRelation);
  Buffer buffer;
  GenericXLogState *state;
  Page page;
  XpodRdfPermMetaOpaque *opaque;

  if (block_count > 0)
  {
    return;
  }

  buffer = ReadBuffer(indexRelation, P_NEW);
  LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
  state = GenericXLogStart(indexRelation);
  page = GenericXLogRegisterBuffer(state, buffer, GENERIC_XLOG_FULL_IMAGE);
  PageInit(page, BufferGetPageSize(buffer), XPOD_RDF_PERM_META_SPECIAL_SIZE);
  opaque = (XpodRdfPermMetaOpaque *) PageGetSpecialPointer(page);
  memset(opaque, 0, sizeof(XpodRdfPermMetaOpaque));
  opaque->magic = XPOD_RDF_PERM_META_MAGIC;
  opaque->schema_version = XPOD_RDF_PERM_SCHEMA_VERSION;
  opaque->nkeys = nkeys;
  opaque->flags = XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED;
  GenericXLogFinish(state);
  UnlockReleaseBuffer(buffer);
}

static XpodRdfPermMetaOpaque *
xpod_rdf_perm_meta_opaque(Page page)
{
  XpodRdfPermMetaOpaque *opaque;

  if (PageGetSpecialSize(page) < sizeof(XpodRdfPermMetaOpaque))
  {
    return NULL;
  }
  opaque = (XpodRdfPermMetaOpaque *) PageGetSpecialPointer(page);
  return opaque->magic == XPOD_RDF_PERM_META_MAGIC ? opaque : NULL;
}

static bool
xpod_rdf_perm_relation_has_metapage(Relation indexRelation)
{
  Buffer buffer;
  Page page;
  bool has_metapage;

  if (RelationGetNumberOfBlocks(indexRelation) == 0)
  {
    return false;
  }

  buffer = ReadBuffer(indexRelation, 0);
  LockBuffer(buffer, BUFFER_LOCK_SHARE);
  page = BufferGetPage(buffer);
  has_metapage = xpod_rdf_perm_meta_opaque(page) != NULL;
  UnlockReleaseBuffer(buffer);
  return has_metapage;
}

static BlockNumber
xpod_rdf_perm_first_data_block(Relation indexRelation)
{
  return xpod_rdf_perm_relation_has_metapage(indexRelation) ? 1 : 0;
}

static bool
xpod_rdf_perm_relation_is_globally_sorted(Relation indexRelation)
{
  Buffer buffer;
  Page page;
  XpodRdfPermMetaOpaque *opaque;
  bool sorted = false;

  if (RelationGetNumberOfBlocks(indexRelation) == 0)
  {
    return false;
  }

  buffer = ReadBuffer(indexRelation, 0);
  LockBuffer(buffer, BUFFER_LOCK_SHARE);
  page = BufferGetPage(buffer);
  opaque = xpod_rdf_perm_meta_opaque(page);
  sorted = opaque != NULL && (opaque->flags & XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED) != 0;
  UnlockReleaseBuffer(buffer);
  return sorted;
}

static void
xpod_rdf_perm_meta_note_append(Relation indexRelation, XpodRdfPermBuildEntry *entry)
{
  Buffer buffer;
  GenericXLogState *state;
  Page page;
  XpodRdfPermMetaOpaque *opaque;
  uint16 key_index;

  if (!xpod_rdf_perm_relation_has_metapage(indexRelation))
  {
    return;
  }

  buffer = ReadBuffer(indexRelation, 0);
  LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
  state = GenericXLogStart(indexRelation);
  page = GenericXLogRegisterBuffer(state, buffer, GENERIC_XLOG_FULL_IMAGE);
  opaque = xpod_rdf_perm_meta_opaque(page);
  if (opaque != NULL)
  {
    if (opaque->tuple_count > 0 && xpod_rdf_perm_meta_compare_last_keys(opaque, entry) > 0)
    {
      opaque->flags &= ~XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED;
    }
    opaque->nkeys = entry->nkeys;
    opaque->tuple_count++;
    for (key_index = 0; key_index < entry->nkeys; key_index++)
    {
      opaque->last_keys[key_index] = entry->keys[key_index];
    }
  }
  GenericXLogFinish(state);
  UnlockReleaseBuffer(buffer);
}

static void
xpod_rdf_perm_meta_finish_ordered_build(Relation indexRelation,
                                        uint16 nkeys,
                                        uint64 tuple_count,
                                        XpodRdfPermBuildEntry *last_entry)
{
  Buffer buffer;
  GenericXLogState *state;
  Page page;
  XpodRdfPermMetaOpaque *opaque;
  uint16 key_index;

  if (!xpod_rdf_perm_relation_has_metapage(indexRelation))
  {
    return;
  }

  buffer = ReadBuffer(indexRelation, 0);
  LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
  state = GenericXLogStart(indexRelation);
  page = GenericXLogRegisterBuffer(state, buffer, GENERIC_XLOG_FULL_IMAGE);
  opaque = xpod_rdf_perm_meta_opaque(page);
  if (opaque != NULL)
  {
    opaque->nkeys = nkeys;
    opaque->tuple_count = tuple_count;
    opaque->flags |= XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED;
    memset(opaque->last_keys, 0, sizeof(opaque->last_keys));
    if (last_entry != NULL)
    {
      for (key_index = 0; key_index < last_entry->nkeys; key_index++)
      {
        opaque->last_keys[key_index] = last_entry->keys[key_index];
      }
    }
  }
  GenericXLogFinish(state);
  UnlockReleaseBuffer(buffer);
}

static int
xpod_rdf_perm_meta_compare_last_keys(XpodRdfPermMetaOpaque *opaque, XpodRdfPermBuildEntry *entry)
{
  uint16 nkeys = Min(opaque->nkeys, entry->nkeys);
  uint16 key_index;

  for (key_index = 0; key_index < nkeys; key_index++)
  {
    if (opaque->last_keys[key_index] < entry->keys[key_index])
    {
      return -1;
    }
    if (opaque->last_keys[key_index] > entry->keys[key_index])
    {
      return 1;
    }
  }
  if (opaque->nkeys < entry->nkeys)
  {
    return -1;
  }
  if (opaque->nkeys > entry->nkeys)
  {
    return 1;
  }
  return 0;
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

  xpod_rdf_perm_page_update_sorted_flag(page, entry);
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
  opaque->flags = XPOD_RDF_PERM_PAGE_FLAG_SORTED;
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

static XpodRdfPermEntry *
xpod_rdf_perm_page_entry(Page page, OffsetNumber offset)
{
  ItemId item_id;
  XpodRdfPermEntry *entry;

  if (!OffsetNumberIsValid(offset) || offset > PageGetMaxOffsetNumber(page))
  {
    return NULL;
  }
  item_id = PageGetItemId(page, offset);
  if (!ItemIdHasStorage(item_id))
  {
    return NULL;
  }
  entry = (XpodRdfPermEntry *) PageGetItem(page, item_id);
  return entry->magic == XPOD_RDF_PERM_MAGIC ? entry : NULL;
}

static bool
xpod_rdf_perm_page_is_sorted(Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);

  return opaque != NULL && (opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) != 0;
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
  XpodRdfPermEntry *previous_entry = NULL;

  if (opaque == NULL)
  {
    return;
  }

  opaque->tuple_count = 0;
  opaque->flags = XPOD_RDF_PERM_PAGE_FLAG_SORTED;
  memset(opaque->min_keys, 0, sizeof(opaque->min_keys));
  memset(opaque->max_keys, 0, sizeof(opaque->max_keys));

  max_offset = PageGetMaxOffsetNumber(page);
  for (offset = FirstOffsetNumber; offset <= max_offset; offset = OffsetNumberNext(offset))
  {
    XpodRdfPermEntry *entry = xpod_rdf_perm_page_entry(page, offset);

    if (entry == NULL)
    {
      continue;
    }
    if (previous_entry != NULL && xpod_rdf_perm_entry_compare_entry(previous_entry, entry) > 0)
    {
      opaque->flags &= ~XPOD_RDF_PERM_PAGE_FLAG_SORTED;
    }
    xpod_rdf_perm_page_update_range(page, entry);
    previous_entry = entry;
  }
}

static void
xpod_rdf_perm_page_update_sorted_flag(Page page, XpodRdfPermEntry *entry)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  OffsetNumber max_offset;
  XpodRdfPermEntry *last_entry;

  if (opaque == NULL)
  {
    return;
  }
  if (entry->nkeys != opaque->nkeys)
  {
    opaque->flags &= ~XPOD_RDF_PERM_PAGE_FLAG_SORTED;
    return;
  }
  if ((opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) == 0)
  {
    return;
  }
  max_offset = PageGetMaxOffsetNumber(page);
  if (max_offset < FirstOffsetNumber)
  {
    return;
  }
  last_entry = xpod_rdf_perm_page_entry(page, max_offset);
  if (last_entry == NULL)
  {
    opaque->flags &= ~XPOD_RDF_PERM_PAGE_FLAG_SORTED;
    return;
  }
  if (xpod_rdf_perm_entry_compare_entry(last_entry, entry) > 0)
  {
    opaque->flags &= ~XPOD_RDF_PERM_PAGE_FLAG_SORTED;
  }
}

static bool
xpod_rdf_perm_page_may_match(IndexScanDesc scan, Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  XpodRdfPermScanOpaque *scan_opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  uint16 key_index;
  XpodRdfPermScanBounds *bounds = &scan_opaque->bounds;

  if (opaque == NULL)
  {
    return true;
  }
  if (opaque->tuple_count == 0 || bounds->impossible)
  {
    return false;
  }

  for (key_index = 0; key_index < bounds->nkeys && key_index < opaque->nkeys; key_index++)
  {
    XpodRdfPermColumnBound *bound = &bounds->columns[key_index];

    if (bound->has_lower)
    {
      if (
        opaque->max_keys[key_index] < bound->lower
        || (opaque->max_keys[key_index] == bound->lower && !bound->lower_inclusive)
      )
      {
        return false;
      }
    }
    if (bound->has_upper)
    {
      if (
        opaque->min_keys[key_index] > bound->upper
        || (opaque->min_keys[key_index] == bound->upper && !bound->upper_inclusive)
      )
      {
        return false;
      }
    }
  }
  return true;
}

static bool
xpod_rdf_perm_page_last_before_lower_bound(IndexScanDesc scan, Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  XpodRdfPermScanOpaque *scan_opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  int64 lower_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 lower_nkeys = 0;
  XpodRdfPermEntry *last_entry;

  if (
    opaque == NULL
    || opaque->tuple_count == 0
    || !xpod_rdf_perm_bounds_lower_prefix(&scan_opaque->bounds, opaque->nkeys, lower_keys, &lower_nkeys)
  )
  {
    return false;
  }

  last_entry = xpod_rdf_perm_page_entry(page, PageGetMaxOffsetNumber(page));
  return last_entry != NULL && xpod_rdf_perm_entry_compare_key_prefix(last_entry, lower_keys, lower_nkeys) < 0;
}

static bool
xpod_rdf_perm_page_first_past_upper_bound(IndexScanDesc scan, Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  XpodRdfPermScanOpaque *scan_opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  int64 upper_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 upper_nkeys = 0;
  bool inclusive = true;
  XpodRdfPermEntry *first_entry;
  int compare;

  if (
    opaque == NULL
    || opaque->tuple_count == 0
    || !xpod_rdf_perm_bounds_upper_prefix(&scan_opaque->bounds, opaque->nkeys, upper_keys, &upper_nkeys, &inclusive)
  )
  {
    return false;
  }

  first_entry = xpod_rdf_perm_page_entry(page, FirstOffsetNumber);
  if (first_entry == NULL)
  {
    return false;
  }
  compare = xpod_rdf_perm_entry_compare_key_prefix(first_entry, upper_keys, upper_nkeys);
  return compare > 0 || (compare == 0 && !inclusive);
}

static BlockNumber
xpod_rdf_perm_seek_lower_block(IndexScanDesc scan, BlockNumber first_block, BlockNumber block_count)
{
  BlockNumber low;
  BlockNumber high;
  XpodRdfPermScanOpaque *scan_opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  int64 lower_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 lower_nkeys = 0;

  if (
    first_block >= block_count
    || scan_opaque->bounds.impossible
    || !xpod_rdf_perm_bounds_lower_prefix(&scan_opaque->bounds, scan_opaque->bounds.nkeys, lower_keys, &lower_nkeys)
  )
  {
    return first_block;
  }

  low = first_block;
  high = block_count;
  while (low < high)
  {
    BlockNumber mid = low + ((high - low) / 2);
    Buffer buffer;
    Page page;
    bool before_lower;

    buffer = ReadBuffer(scan->indexRelation, mid);
    LockBuffer(buffer, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buffer);
    before_lower = xpod_rdf_perm_page_last_before_lower_bound(scan, page);
    UnlockReleaseBuffer(buffer);

    if (before_lower)
    {
      low = mid + 1;
    }
    else
    {
      high = mid;
    }
  }
  return low;
}

static OffsetNumber
xpod_rdf_perm_page_seek_lower_bound(IndexScanDesc scan, Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  XpodRdfPermScanOpaque *scan_opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  XpodRdfPermScanBounds *bounds = &scan_opaque->bounds;
  int64 lower_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 lower_nkeys = 0;
  uint16 key_index;
  OffsetNumber max_offset;
  int low;
  int high;

  if (opaque == NULL || (opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) == 0 || bounds->impossible)
  {
    return FirstOffsetNumber;
  }

  for (key_index = 0; key_index < bounds->nkeys && key_index < opaque->nkeys; key_index++)
  {
    XpodRdfPermColumnBound *bound = &bounds->columns[key_index];

    if (bound->has_equal)
    {
      lower_keys[lower_nkeys++] = bound->equal;
      continue;
    }
    if (bound->has_lower)
    {
      lower_keys[lower_nkeys++] = bound->lower;
    }
    break;
  }
  if (lower_nkeys == 0)
  {
    return FirstOffsetNumber;
  }

  max_offset = PageGetMaxOffsetNumber(page);
  low = FirstOffsetNumber;
  high = max_offset + 1;
  while (low < high)
  {
    int mid = low + ((high - low) / 2);
    XpodRdfPermEntry *entry = xpod_rdf_perm_page_entry(page, (OffsetNumber) mid);

    if (entry == NULL || xpod_rdf_perm_entry_compare_key_prefix(entry, lower_keys, lower_nkeys) < 0)
    {
      low = mid + 1;
    }
    else
    {
      high = mid;
    }
  }
  return low <= max_offset ? (OffsetNumber) low : InvalidOffsetNumber;
}

static bool
xpod_rdf_perm_entry_past_upper_bound(IndexScanDesc scan, XpodRdfPermEntry *entry)
{
  XpodRdfPermScanOpaque *scan_opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  XpodRdfPermScanBounds *bounds = &scan_opaque->bounds;
  uint16 key_index;

  if (entry->magic != XPOD_RDF_PERM_MAGIC || bounds->impossible)
  {
    return false;
  }

  for (key_index = 0; key_index < bounds->nkeys && key_index < entry->nkeys; key_index++)
  {
    XpodRdfPermColumnBound *bound = &bounds->columns[key_index];

    if (bound->has_equal)
    {
      if (entry->keys[key_index] > bound->equal)
      {
        return true;
      }
      if (entry->keys[key_index] < bound->equal)
      {
        return false;
      }
      continue;
    }
    if (bound->has_upper)
    {
      return entry->keys[key_index] > bound->upper
        || (entry->keys[key_index] == bound->upper && !bound->upper_inclusive);
    }
    return false;
  }
  return false;
}

static void
xpod_rdf_perm_prepare_scan_bounds(IndexScanDesc scan)
{
  XpodRdfPermScanOpaque *opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  XpodRdfPermScanBounds *bounds = &opaque->bounds;
  int index_key;

  memset(bounds, 0, sizeof(XpodRdfPermScanBounds));
  bounds->nkeys = Min(scan->indexRelation->rd_att->natts, XPOD_RDF_PERM_MAX_KEYS);
  for (index_key = 0; index_key < scan->numberOfKeys; index_key++)
  {
    xpod_rdf_perm_apply_scan_key_bound(bounds, &scan->keyData[index_key]);
  }
  xpod_rdf_perm_finalize_scan_bounds(bounds);
}

static void
xpod_rdf_perm_prepare_scan_position(IndexScanDesc scan)
{
  XpodRdfPermScanOpaque *opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  BlockNumber block_count = RelationGetNumberOfBlocks(scan->indexRelation);

  opaque->first_data_block = xpod_rdf_perm_first_data_block(scan->indexRelation);
  opaque->current_block = opaque->first_data_block;
  opaque->current_offset = FirstOffsetNumber;
  opaque->global_sorted = xpod_rdf_perm_relation_is_globally_sorted(scan->indexRelation);

  if (opaque->bounds.impossible)
  {
    opaque->current_block = block_count;
    return;
  }
  if (opaque->global_sorted)
  {
    opaque->current_block = xpod_rdf_perm_seek_lower_block(scan, opaque->first_data_block, block_count);
  }
}

static void
xpod_rdf_perm_apply_scan_key_bound(XpodRdfPermScanBounds *bounds, ScanKey key)
{
  int attr_index = key->sk_attno - 1;
  int64 argument;
  XpodRdfPermColumnBound *bound;

  if ((key->sk_flags & SK_ISNULL) || attr_index < 0 || attr_index >= bounds->nkeys)
  {
    bounds->impossible = true;
    return;
  }

  argument = DatumGetInt64(key->sk_argument);
  bound = &bounds->columns[attr_index];

  switch (key->sk_strategy)
  {
    case BTLessStrategyNumber:
    case BTLessEqualStrategyNumber:
      if (
        !bound->has_upper
        || argument < bound->upper
        || (argument == bound->upper && key->sk_strategy == BTLessStrategyNumber)
      )
      {
        bound->has_upper = true;
        bound->upper = argument;
        bound->upper_inclusive = key->sk_strategy == BTLessEqualStrategyNumber;
      }
      break;
    case BTEqualStrategyNumber:
      if (bound->has_equal && bound->equal != argument)
      {
        bounds->impossible = true;
        return;
      }
      bound->has_equal = true;
      bound->equal = argument;
      bound->has_lower = true;
      bound->lower = argument;
      bound->lower_inclusive = true;
      bound->has_upper = true;
      bound->upper = argument;
      bound->upper_inclusive = true;
      break;
    case BTGreaterEqualStrategyNumber:
    case BTGreaterStrategyNumber:
      if (
        !bound->has_lower
        || argument > bound->lower
        || (argument == bound->lower && key->sk_strategy == BTGreaterStrategyNumber)
      )
      {
        bound->has_lower = true;
        bound->lower = argument;
        bound->lower_inclusive = key->sk_strategy == BTGreaterEqualStrategyNumber;
      }
      break;
    default:
      break;
  }
}

static void
xpod_rdf_perm_finalize_scan_bounds(XpodRdfPermScanBounds *bounds)
{
  uint16 key_index;

  for (key_index = 0; key_index < bounds->nkeys; key_index++)
  {
    XpodRdfPermColumnBound *bound = &bounds->columns[key_index];

    if (!bound->has_lower || !bound->has_upper)
    {
      continue;
    }
    if (
      bound->lower > bound->upper
      || (
        bound->lower == bound->upper
        && (!bound->lower_inclusive || !bound->upper_inclusive)
      )
    )
    {
      bounds->impossible = true;
      return;
    }
  }
}

static bool
xpod_rdf_perm_bounds_lower_prefix(XpodRdfPermScanBounds *bounds, uint16 nkeys, int64 *keys, uint16 *prefix_nkeys)
{
  uint16 key_index;

  *prefix_nkeys = 0;
  if (bounds->impossible)
  {
    return false;
  }
  for (key_index = 0; key_index < bounds->nkeys && key_index < nkeys; key_index++)
  {
    XpodRdfPermColumnBound *bound = &bounds->columns[key_index];

    if (bound->has_equal)
    {
      keys[(*prefix_nkeys)++] = bound->equal;
      continue;
    }
    if (bound->has_lower)
    {
      keys[(*prefix_nkeys)++] = bound->lower;
    }
    break;
  }
  return *prefix_nkeys > 0;
}

static bool
xpod_rdf_perm_bounds_upper_prefix(XpodRdfPermScanBounds *bounds, uint16 nkeys, int64 *keys, uint16 *prefix_nkeys, bool *inclusive)
{
  uint16 key_index;

  *prefix_nkeys = 0;
  *inclusive = true;
  if (bounds->impossible)
  {
    return false;
  }
  for (key_index = 0; key_index < bounds->nkeys && key_index < nkeys; key_index++)
  {
    XpodRdfPermColumnBound *bound = &bounds->columns[key_index];

    if (bound->has_equal)
    {
      keys[(*prefix_nkeys)++] = bound->equal;
      *inclusive = true;
      continue;
    }
    if (bound->has_upper)
    {
      keys[(*prefix_nkeys)++] = bound->upper;
      *inclusive = bound->upper_inclusive;
    }
    break;
  }
  return *prefix_nkeys > 0;
}

static int
xpod_rdf_perm_entry_compare_entry(XpodRdfPermEntry *left, XpodRdfPermEntry *right)
{
  uint16 nkeys = Min(left->nkeys, right->nkeys);
  uint16 key_index;

  for (key_index = 0; key_index < nkeys; key_index++)
  {
    if (left->keys[key_index] < right->keys[key_index])
    {
      return -1;
    }
    if (left->keys[key_index] > right->keys[key_index])
    {
      return 1;
    }
  }
  if (left->nkeys < right->nkeys)
  {
    return -1;
  }
  if (left->nkeys > right->nkeys)
  {
    return 1;
  }
  return ItemPointerCompare(&left->heap_tid, &right->heap_tid);
}

static int
xpod_rdf_perm_entry_compare_key_prefix(XpodRdfPermEntry *entry, int64 *keys, uint16 nkeys)
{
  return xpod_rdf_perm_key_prefix_compare(entry->keys, entry->nkeys, keys, nkeys);
}

static int
xpod_rdf_perm_key_prefix_compare(int64 *left, uint16 left_nkeys, int64 *right, uint16 right_nkeys)
{
  uint16 key_index;
  uint16 nkeys = Min(left_nkeys, right_nkeys);

  for (key_index = 0; key_index < nkeys; key_index++)
  {
    if (left[key_index] < right[key_index])
    {
      return -1;
    }
    if (left[key_index] > right[key_index])
    {
      return 1;
    }
  }
  if (left_nkeys < right_nkeys)
  {
    return -1;
  }
  return 0;
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
