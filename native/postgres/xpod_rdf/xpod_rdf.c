#include "postgres.h"

#include "access/stratnum.h"
#include "access/amapi.h"
#include "access/genam.h"
#include "access/generic_xlog.h"
#include "access/tableam.h"
#include "catalog/pg_type_d.h"
#include "executor/spi.h"
#include "fmgr.h"
#include "funcapi.h"
#include "lib/stringinfo.h"
#include "miscadmin.h"
#include "nodes/pathnodes.h"
#include "nodes/primnodes.h"
#include "storage/bufpage.h"
#include "storage/bufmgr.h"
#include "storage/itemptr.h"
#include "utils/array.h"
#include "utils/builtins.h"
#include "utils/lsyscache.h"
#include "utils/rel.h"

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(xpod_rdf_version);
PG_FUNCTION_INFO_V1(xpod_rdf_capabilities);
PG_FUNCTION_INFO_V1(xpod_rdf_term_id_cmp);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_index_stats);
PG_FUNCTION_INFO_V1(xpod_rdf_scan_quads);
PG_FUNCTION_INFO_V1(xpod_rdf_count_quads);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_handler);

typedef struct XpodRdfPermCostState XpodRdfPermCostState;

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
static void xpod_rdf_perm_read_cost_meta(Oid index_oid,
                                         uint64 *tuple_count,
                                         bool *global_sorted,
                                         bool *prefix_stats_exact,
                                         uint16 *nkeys,
                                         uint64 *distinct_prefix_counts);
static void xpod_rdf_perm_prepare_cost_state(IndexPath *path, XpodRdfPermCostState *state);
static void xpod_rdf_perm_note_cost_clause(IndexPath *path,
                                           XpodRdfPermCostState *state,
                                           IndexClause *clause);
static StrategyNumber xpod_rdf_perm_clause_strategy(IndexPath *path, IndexClause *clause);
static StrategyNumber xpod_rdf_perm_op_strategy_for_index_column(IndexPath *path,
                                                                 int index_col,
                                                                 Oid opno);
static Selectivity xpod_rdf_perm_result_selectivity(XpodRdfPermCostState *state,
                                                    double tuple_count,
                                                    bool prefix_stats_exact,
                                                    uint64 *distinct_prefix_counts);
static Selectivity xpod_rdf_perm_page_selectivity(XpodRdfPermCostState *state,
                                                  double page_count,
                                                  bool prefix_stats_exact,
                                                  uint64 *distinct_prefix_counts);
static Selectivity xpod_rdf_perm_clamp_selectivity(Selectivity value,
                                                   double tuple_count);
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
#define XPOD_RDF_PERM_POSTING_ARRAY_MAGIC 0x5852504c
#define XPOD_RDF_PERM_POSTING_MAGIC 0x58525044
#define XPOD_RDF_PERM_META_MAGIC 0x58524d54
#define XPOD_RDF_PERM_PAGE_MAGIC 0x58525047
#define XPOD_RDF_PERM_SCHEMA_VERSION 2
#define XPOD_RDF_PERM_MAX_KEYS 4
#define XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED 0x0001
#define XPOD_RDF_PERM_META_FLAG_PREFIX_STATS_EXACT 0x0002
#define XPOD_RDF_PERM_PAGE_FLAG_SORTED 0x0001
#define XPOD_RDF_PERM_META_V1_SPECIAL_SIZE MAXALIGN(offsetof(XpodRdfPermMetaOpaque, distinct_prefix_counts))
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
  uint64 distinct_prefix_counts[XPOD_RDF_PERM_MAX_KEYS];
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

typedef struct XpodRdfPermPostingEntry
{
  uint32 magic;
  uint16 nkeys;
  uint16 reserved;
  uint32 posting_count;
  uint32 payload_size;
  int64 keys[FLEXIBLE_ARRAY_MEMBER];
} XpodRdfPermPostingEntry;

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
  uint32 current_posting;
  bool global_sorted;
  XpodRdfPermScanBounds bounds;
} XpodRdfPermScanOpaque;

typedef struct XpodRdfPermCostColumn
{
  bool has_equal;
  bool has_range;
  bool has_unknown;
} XpodRdfPermCostColumn;

typedef struct XpodRdfPermCostState
{
  uint16 nkeys;
  XpodRdfPermCostColumn columns[XPOD_RDF_PERM_MAX_KEYS];
  uint32 clause_count;
} XpodRdfPermCostState;

static void xpod_rdf_perm_build_callback(Relation indexRelation,
                                         ItemPointer tid,
                                         Datum *values,
                                         bool *isnull,
                                         bool tupleIsAlive,
                                         void *state);
static int xpod_rdf_perm_build_entry_compare(const void *left, const void *right);
static void xpod_rdf_perm_build_distinct_prefix_counts(XpodRdfPermBuildEntry *entries,
                                                       uint64 entry_count,
                                                       uint16 nkeys,
                                                       uint64 *distinct_prefix_counts);
static Size xpod_rdf_perm_entry_size(uint16 nkeys);
static void xpod_rdf_perm_assert_supported_nkeys(uint16 nkeys);
static bool xpod_rdf_perm_decode_build_entry(XpodRdfPermBuildEntry *entry,
                                             Datum *values,
                                             bool *isnull,
                                             ItemPointer heap_tid,
                                             uint16 nkeys);
static void xpod_rdf_perm_collect_build_entry(XpodRdfPermBuildState *state,
                                              XpodRdfPermBuildEntry *entry);
static bool xpod_rdf_perm_build_entries_same_keys(XpodRdfPermBuildEntry *left,
                                                  XpodRdfPermBuildEntry *right);
static Size xpod_rdf_perm_posting_build_entry_size(XpodRdfPermBuildEntry *entries,
                                                   uint32 posting_count);
static uint32 xpod_rdf_perm_build_posting_count_for_page(XpodRdfPermBuildEntry *entries,
                                                         uint64 remaining_count);
static bool xpod_rdf_perm_append_entry(Relation indexRelation,
                                       Datum *values,
                                       bool *isnull,
                                       ItemPointer heap_tid,
                                       uint16 nkeys);
static bool xpod_rdf_perm_append_build_entry(Relation indexRelation,
                                             XpodRdfPermBuildEntry *entry,
                                             bool update_meta);
static bool xpod_rdf_perm_append_posting_build_entries(Relation indexRelation,
                                                       XpodRdfPermBuildEntry *entries,
                                                       uint32 posting_count);
static void xpod_rdf_perm_ensure_metapage(Relation indexRelation, uint16 nkeys);
static XpodRdfPermMetaOpaque *xpod_rdf_perm_meta_opaque(Page page);
static bool xpod_rdf_perm_meta_supports_prefix_stats(Page page,
                                                     XpodRdfPermMetaOpaque *opaque);
static bool xpod_rdf_perm_relation_has_metapage(Relation indexRelation);
static BlockNumber xpod_rdf_perm_first_data_block(Relation indexRelation);
static bool xpod_rdf_perm_relation_is_globally_sorted(Relation indexRelation);
static void xpod_rdf_perm_meta_note_append(Relation indexRelation, XpodRdfPermBuildEntry *entry);
static void xpod_rdf_perm_meta_finish_ordered_build(Relation indexRelation,
                                                    uint16 nkeys,
                                                    uint64 tuple_count,
                                                    XpodRdfPermBuildEntry *last_entry,
                                                    uint64 *distinct_prefix_counts);
static int xpod_rdf_perm_meta_compare_last_keys(XpodRdfPermMetaOpaque *opaque, XpodRdfPermBuildEntry *entry);
static bool xpod_rdf_perm_page_add_item(Relation indexRelation,
                                        Buffer buffer,
                                        void *entry,
                                        Size entry_size,
                                        bool init_page,
                                        uint16 nkeys);
static bool xpod_rdf_perm_page_add_entry(Relation indexRelation,
                                         Buffer buffer,
                                         XpodRdfPermBuildEntry *build_entry,
                                         bool init_page);
static bool xpod_rdf_perm_page_add_posting_entry(Relation indexRelation,
                                                 Buffer buffer,
                                                 XpodRdfPermBuildEntry *entries,
                                                 uint32 posting_count,
                                                 bool init_page);
static void xpod_rdf_perm_init_page(Page page, Size page_size, uint16 nkeys);
static XpodRdfPermPageOpaque *xpod_rdf_perm_page_opaque(Page page);
static void *xpod_rdf_perm_page_entry(Page page, OffsetNumber offset);
static bool xpod_rdf_perm_page_is_sorted(Page page);
static void xpod_rdf_perm_page_update_range(Page page, void *entry);
static void xpod_rdf_perm_page_recompute_range(Page page);
static void xpod_rdf_perm_page_update_sorted_flag(Page page, void *entry);
static bool xpod_rdf_perm_page_may_match(IndexScanDesc scan, Page page);
static bool xpod_rdf_perm_page_last_before_lower_bound(IndexScanDesc scan, Page page);
static bool xpod_rdf_perm_page_first_past_upper_bound(IndexScanDesc scan, Page page);
static BlockNumber xpod_rdf_perm_seek_lower_block(IndexScanDesc scan, BlockNumber first_block, BlockNumber block_count);
static OffsetNumber xpod_rdf_perm_page_seek_lower_bound(IndexScanDesc scan, Page page);
static bool xpod_rdf_perm_entry_past_upper_bound(IndexScanDesc scan, void *entry);
static bool xpod_rdf_perm_entry_matches(IndexScanDesc scan, void *entry);
static bool xpod_rdf_perm_entry_next_tid(void *entry, uint32 start_index, ItemPointerData *heap_tid, uint32 *next_index);
static void xpod_rdf_perm_prepare_scan_bounds(IndexScanDesc scan);
static void xpod_rdf_perm_prepare_scan_position(IndexScanDesc scan);
static void xpod_rdf_perm_apply_scan_key_bound(XpodRdfPermScanBounds *bounds, ScanKey key);
static bool xpod_rdf_perm_scan_key_argument_int64(ScanKey key, int64 *argument);
static void xpod_rdf_perm_finalize_scan_bounds(XpodRdfPermScanBounds *bounds);
static bool xpod_rdf_perm_bounds_lower_prefix(XpodRdfPermScanBounds *bounds, uint16 nkeys, int64 *keys, uint16 *prefix_nkeys);
static bool xpod_rdf_perm_bounds_upper_prefix(XpodRdfPermScanBounds *bounds, uint16 nkeys, int64 *keys, uint16 *prefix_nkeys, bool *inclusive);
static int xpod_rdf_perm_entry_compare_entry(void *left, void *right);
static int xpod_rdf_perm_entry_compare_key_prefix(void *entry, int64 *keys, uint16 nkeys);
static int xpod_rdf_perm_key_prefix_compare(int64 *left, uint16 left_nkeys, int64 *right, uint16 right_nkeys);
static bool xpod_rdf_perm_entry_is_valid(void *entry);
static uint16 xpod_rdf_perm_entry_nkeys(void *entry);
static int64 *xpod_rdf_perm_entry_keys(void *entry);
static uint32 xpod_rdf_perm_entry_live_posting_count(void *entry);
static void xpod_rdf_perm_rewrite_meta_tuple_count(Relation indexRelation, uint64 tuples_removed);
static Size xpod_rdf_perm_posting_entry_header_size(uint16 nkeys);
static Size xpod_rdf_perm_posting_entry_size(uint16 nkeys, uint32 payload_size);
static Size xpod_rdf_perm_posting_payload_size_from_build_entries(XpodRdfPermBuildEntry *entries,
                                                                  uint32 posting_count);
static Size xpod_rdf_perm_posting_payload_size_from_tids(ItemPointerData *tids,
                                                         uint32 posting_count);
static XpodRdfPermPostingEntry *xpod_rdf_perm_create_posting_entry(uint16 nkeys,
                                                                   int64 *keys,
                                                                   ItemPointerData *tids,
                                                                   uint32 posting_count,
                                                                   Size *entry_size);
static uint8 *xpod_rdf_perm_posting_entry_payload(XpodRdfPermPostingEntry *entry);
static ItemPointerData *xpod_rdf_perm_posting_array_entry_tids(XpodRdfPermPostingEntry *entry);
static bool xpod_rdf_perm_posting_entry_tid_at(XpodRdfPermPostingEntry *entry,
                                               uint32 posting_index,
                                               ItemPointerData *heap_tid);
static uint64 xpod_rdf_perm_tid_value(ItemPointerData *tid);
static void xpod_rdf_perm_tid_from_value(uint64 value, ItemPointerData *tid);
static Size xpod_rdf_perm_varint_size(uint64 value);
static uint8 *xpod_rdf_perm_varint_encode(uint8 *cursor, uint64 value);
static bool xpod_rdf_perm_varint_decode(uint8 **cursor, uint8 *end, uint64 *value);
static void xpod_rdf_scan_quads_add_array_filter(StringInfo sql,
                                                 Datum *values,
                                                 char *nulls,
                                                 Oid *argtypes,
                                                 int *nargs,
                                                 FunctionCallInfo fcinfo,
                                                 int arg_index,
                                                 const char *column,
                                                 bool *has_where);
static void xpod_rdf_scan_quads_add_int8_clause(StringInfo sql,
                                                Datum *values,
                                                char *nulls,
                                                Oid *argtypes,
                                                int *nargs,
                                                FunctionCallInfo fcinfo,
                                                int arg_index,
                                                const char *clause);
static void xpod_rdf_scan_quads_add_graph_prefix_filter(StringInfo sql,
                                                        Datum *values,
                                                        char *nulls,
                                                        Oid *argtypes,
                                                        int *nargs,
                                                        FunctionCallInfo fcinfo,
                                                        int head_min_arg_index,
                                                        int head_max_arg_index,
                                                        int prefix_min_arg_index,
                                                        int prefix_max_arg_index,
                                                        bool *has_where);
static void xpod_rdf_scan_quads_add_text_condition(StringInfo sql,
                                                   Datum *values,
                                                   char *nulls,
                                                   Oid *argtypes,
                                                   int *nargs,
                                                   FunctionCallInfo fcinfo,
                                                   int arg_index,
                                                   const char *clause);
static void xpod_rdf_scan_quads_add_where(StringInfo sql, bool *has_where);
static int xpod_rdf_array_arg_length(FunctionCallInfo fcinfo, int arg_index);
static void xpod_rdf_scan_quads_put_rows(ReturnSetInfo *rsinfo);

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
xpod_rdf_perm_index_stats(PG_FUNCTION_ARGS)
{
  Oid index_oid = PG_GETARG_OID(0);
  Relation indexRelation;
  BlockNumber block_count;
  BlockNumber first_data_block = 0;
  BlockNumber block;
  bool has_metapage = false;
  bool global_sorted = false;
  bool prefix_stats_exact = false;
  uint16 schema_version = 0;
  uint16 nkeys = 0;
  uint64 tuple_count = 0;
  uint64 distinct_prefix_counts[XPOD_RDF_PERM_MAX_KEYS];
  uint64 page_tuple_count = 0;
  uint64 item_count = 0;
  uint64 posting_count = 0;
  uint64 item_bytes = 0;
  uint64 free_bytes = 0;
  uint32 data_pages = 0;
  uint32 empty_pages = 0;
  uint32 sorted_pages = 0;
  uint32 unsorted_pages = 0;
  uint32 min_tuples_per_page = 0;
  uint32 max_tuples_per_page = 0;
  double avg_tuples_per_page;
  double avg_entry_bytes;
  double avg_postings_per_item;
  double avg_postings_per_prefix[XPOD_RDF_PERM_MAX_KEYS];
  uint16 key_index;
  StringInfoData json;

  memset(distinct_prefix_counts, 0, sizeof(distinct_prefix_counts));
  memset(avg_postings_per_prefix, 0, sizeof(avg_postings_per_prefix));
  indexRelation = index_open(index_oid, AccessShareLock);
  block_count = RelationGetNumberOfBlocks(indexRelation);

  if (block_count > 0)
  {
    Buffer buffer = ReadBuffer(indexRelation, 0);
    Page page;
    XpodRdfPermMetaOpaque *meta;

    LockBuffer(buffer, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buffer);
    meta = xpod_rdf_perm_meta_opaque(page);
    if (meta != NULL)
    {
      has_metapage = true;
      first_data_block = 1;
      schema_version = meta->schema_version;
      nkeys = meta->nkeys;
      tuple_count = meta->tuple_count;
      global_sorted = (meta->flags & XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED) != 0;
      if (xpod_rdf_perm_meta_supports_prefix_stats(page, meta))
      {
        prefix_stats_exact = (meta->flags & XPOD_RDF_PERM_META_FLAG_PREFIX_STATS_EXACT) != 0;
        for (key_index = 0; key_index < nkeys && key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
        {
          distinct_prefix_counts[key_index] = meta->distinct_prefix_counts[key_index];
        }
      }
    }
    UnlockReleaseBuffer(buffer);
  }

  for (block = first_data_block; block < block_count; block++)
  {
    Buffer buffer;
    Page page;
    XpodRdfPermPageOpaque *opaque;
    OffsetNumber max_offset;
    OffsetNumber offset;
    uint32 page_postings = 0;

    buffer = ReadBuffer(indexRelation, block);
    LockBuffer(buffer, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buffer);
    opaque = xpod_rdf_perm_page_opaque(page);
    if (opaque != NULL)
    {
      data_pages++;
      page_tuple_count += opaque->tuple_count;
      free_bytes += PageGetFreeSpace(page);
      max_offset = PageGetMaxOffsetNumber(page);
      for (offset = FirstOffsetNumber; offset <= max_offset; offset = OffsetNumberNext(offset))
      {
        ItemId item_id = PageGetItemId(page, offset);

        if (ItemIdHasStorage(item_id))
        {
          void *entry = PageGetItem(page, item_id);

          if (xpod_rdf_perm_entry_is_valid(entry))
          {
            uint32 live_postings = xpod_rdf_perm_entry_live_posting_count(entry);

            item_count++;
            page_postings += live_postings;
            posting_count += live_postings;
            item_bytes += ItemIdGetLength(item_id);
          }
        }
      }
      if (opaque->tuple_count == 0)
      {
        empty_pages++;
      }
      if ((opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) != 0)
      {
        sorted_pages++;
      }
      else
      {
        unsorted_pages++;
      }
      if (min_tuples_per_page == 0 || page_postings < min_tuples_per_page)
      {
        min_tuples_per_page = page_postings;
      }
      if (page_postings > max_tuples_per_page)
      {
        max_tuples_per_page = page_postings;
      }
    }
    UnlockReleaseBuffer(buffer);
  }

  index_close(indexRelation, AccessShareLock);
  avg_tuples_per_page = data_pages == 0 ? 0.0 : ((double) posting_count / (double) data_pages);
  avg_entry_bytes = item_count == 0 ? 0.0 : ((double) item_bytes / (double) item_count);
  avg_postings_per_item = item_count == 0 ? 0.0 : ((double) posting_count / (double) item_count);
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    avg_postings_per_prefix[key_index] = distinct_prefix_counts[key_index] == 0
      ? 0.0
      : ((double) posting_count / (double) distinct_prefix_counts[key_index]);
  }

  initStringInfo(&json);
  appendStringInfo(
    &json,
    "{\"layout\":\"compressed-posting-v1\","
    "\"compressed\":true,"
    "\"schemaVersion\":%u,"
    "\"hasMetapage\":%s,"
    "\"globalSorted\":%s,"
    "\"prefixStatsExact\":%s,"
    "\"nkeys\":%u,"
    "\"tupleCount\":%llu,"
    "\"distinctPrefix1\":%llu,"
    "\"distinctPrefix2\":%llu,"
    "\"distinctPrefix3\":%llu,"
    "\"distinctPrefix4\":%llu,"
    "\"avgPostingsPerPrefix1\":%.6f,"
    "\"avgPostingsPerPrefix2\":%.6f,"
    "\"avgPostingsPerPrefix3\":%.6f,"
    "\"avgPostingsPerPrefix4\":%.6f,"
    "\"pageTupleCount\":%llu,"
    "\"itemCount\":%llu,"
    "\"postingCount\":%llu,"
    "\"pages\":%u,"
    "\"dataPages\":%u,"
    "\"emptyPages\":%u,"
    "\"sortedPages\":%u,"
    "\"unsortedPages\":%u,"
    "\"minTuplesPerPage\":%u,"
    "\"maxTuplesPerPage\":%u,"
    "\"avgTuplesPerPage\":%.6f,"
    "\"avgPostingsPerItem\":%.6f,"
    "\"itemBytes\":%llu,"
    "\"freeBytes\":%llu,"
    "\"avgEntryBytes\":%.6f}",
    (unsigned int) schema_version,
    has_metapage ? "true" : "false",
    global_sorted ? "true" : "false",
    prefix_stats_exact ? "true" : "false",
    (unsigned int) nkeys,
    (unsigned long long) tuple_count,
    (unsigned long long) distinct_prefix_counts[0],
    (unsigned long long) distinct_prefix_counts[1],
    (unsigned long long) distinct_prefix_counts[2],
    (unsigned long long) distinct_prefix_counts[3],
    avg_postings_per_prefix[0],
    avg_postings_per_prefix[1],
    avg_postings_per_prefix[2],
    avg_postings_per_prefix[3],
    (unsigned long long) page_tuple_count,
    (unsigned long long) item_count,
    (unsigned long long) posting_count,
    (unsigned int) block_count,
    (unsigned int) data_pages,
    (unsigned int) empty_pages,
    (unsigned int) sorted_pages,
    (unsigned int) unsorted_pages,
    (unsigned int) min_tuples_per_page,
    (unsigned int) max_tuples_per_page,
    avg_tuples_per_page,
    avg_postings_per_item,
    (unsigned long long) item_bytes,
    (unsigned long long) free_bytes,
    avg_entry_bytes
  );
  PG_RETURN_TEXT_P(cstring_to_text(json.data));
}

Datum
xpod_rdf_scan_quads(PG_FUNCTION_ARGS)
{
  StringInfoData sql;
  Oid argtypes[10];
  Datum values[10];
  char nulls[10];
  int nargs = 0;
  int ret;
  bool has_where = false;

  initStringInfo(&sql);
  appendStringInfoString(&sql, "SELECT q.graph_id, q.subject_id, q.predicate_id, q.object_id FROM rdf_quads q");
  xpod_rdf_scan_quads_add_graph_prefix_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 4, 5, 6, 7, &has_where);
  xpod_rdf_scan_quads_add_array_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 0, "q.subject_id", &has_where);
  xpod_rdf_scan_quads_add_array_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 1, "q.predicate_id", &has_where);
  xpod_rdf_scan_quads_add_array_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 2, "q.object_id", &has_where);
  xpod_rdf_scan_quads_add_array_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 3, "q.graph_id", &has_where);
  appendStringInfoString(&sql, " ORDER BY q.subject_id, q.predicate_id, q.object_id, q.graph_id");
  xpod_rdf_scan_quads_add_int8_clause(&sql, values, nulls, argtypes, &nargs, fcinfo, 8, " LIMIT ");
  xpod_rdf_scan_quads_add_int8_clause(&sql, values, nulls, argtypes, &nargs, fcinfo, 9, " OFFSET ");
  InitMaterializedSRF(fcinfo, MAT_SRF_USE_EXPECTED_DESC);
  if (SPI_connect() != SPI_OK_CONNECT)
  {
    ereport(ERROR, (errmsg("xpod_rdf.scan_quads could not connect to SPI")));
  }
  ret = SPI_execute_with_args(
    sql.data,
    nargs,
    argtypes,
    values,
    nulls,
    true,
    0
  );
  if (ret != SPI_OK_SELECT)
  {
    SPI_finish();
    ereport(ERROR, (errmsg("xpod_rdf.scan_quads SPI query failed")));
  }
  xpod_rdf_scan_quads_put_rows((ReturnSetInfo *) fcinfo->resultinfo);
  SPI_finish();
  PG_RETURN_NULL();
}

Datum
xpod_rdf_count_quads(PG_FUNCTION_ARGS)
{
  StringInfoData sql;
  Oid argtypes[8];
  Datum values[8];
  char nulls[8];
  int nargs = 0;
  int ret;
  bool isnull = false;
  Datum count;
  bool has_where = false;

  initStringInfo(&sql);
  appendStringInfoString(&sql, "SELECT COUNT(*)::bigint AS count FROM rdf_quads q");
  xpod_rdf_scan_quads_add_graph_prefix_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 4, 5, 6, 7, &has_where);
  xpod_rdf_scan_quads_add_array_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 0, "q.subject_id", &has_where);
  xpod_rdf_scan_quads_add_array_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 1, "q.predicate_id", &has_where);
  xpod_rdf_scan_quads_add_array_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 2, "q.object_id", &has_where);
  xpod_rdf_scan_quads_add_array_filter(&sql, values, nulls, argtypes, &nargs, fcinfo, 3, "q.graph_id", &has_where);
  if (SPI_connect() != SPI_OK_CONNECT)
  {
    ereport(ERROR, (errmsg("xpod_rdf.count_quads could not connect to SPI")));
  }
  ret = SPI_execute_with_args(
    sql.data,
    nargs,
    argtypes,
    values,
    nulls,
    true,
    1
  );
  if (ret != SPI_OK_SELECT || SPI_processed != 1)
  {
    SPI_finish();
    ereport(ERROR, (errmsg("xpod_rdf.count_quads SPI query failed")));
  }
  count = SPI_getbinval(SPI_tuptable->vals[0], SPI_tuptable->tupdesc, 1, &isnull);
  SPI_finish();
  if (isnull)
  {
    PG_RETURN_INT64(0);
  }
  PG_RETURN_DATUM(count);
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
  uint64 distinct_prefix_counts[XPOD_RDF_PERM_MAX_KEYS];
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
  xpod_rdf_perm_build_distinct_prefix_counts(
    build_state.entries,
    build_state.entry_count,
    build_state.nkeys,
    distinct_prefix_counts
  );
  index_entry = 0;
  while (index_entry < build_state.entry_count)
  {
    uint64 group_end = index_entry + 1;

    while (
      group_end < build_state.entry_count
      && xpod_rdf_perm_build_entries_same_keys(&build_state.entries[index_entry], &build_state.entries[group_end])
    )
    {
      group_end++;
    }

    if (group_end - index_entry > 1)
    {
      uint64 posting_index = index_entry;

      while (posting_index < group_end)
      {
        uint32 posting_count = xpod_rdf_perm_build_posting_count_for_page(
          &build_state.entries[posting_index],
          group_end - posting_index
        );

        if (posting_count > 1 && xpod_rdf_perm_append_posting_build_entries(indexRelation, &build_state.entries[posting_index], posting_count))
        {
          build_state.index_tuples += posting_count;
        }
        else if (xpod_rdf_perm_append_build_entry(indexRelation, &build_state.entries[posting_index], false))
        {
          build_state.index_tuples++;
          posting_count = 1;
        }
        posting_index += posting_count;
      }
    }
    else if (xpod_rdf_perm_append_build_entry(indexRelation, &build_state.entries[index_entry], false))
    {
      build_state.index_tuples++;
    }
    index_entry = group_end;
  }
  xpod_rdf_perm_meta_finish_ordered_build(
    indexRelation,
    build_state.nkeys,
    build_state.entry_count,
    build_state.entry_count > 0 ? &build_state.entries[build_state.entry_count - 1] : NULL,
    distinct_prefix_counts
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
  uint64 total_removed = 0;

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
    XpodRdfPermPageOpaque *page_opaque;
    OffsetNumber max_offset;
    OffsetNumber offset;
    char **live_items = NULL;
    Size *live_item_sizes = NULL;
    int live_item_count = 0;
    uint64 page_removed = 0;

    buffer = ReadBuffer(info->index, block);
    LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
    page = BufferGetPage(buffer);
    page_opaque = xpod_rdf_perm_page_opaque(page);
    if (page_opaque == NULL)
    {
      UnlockReleaseBuffer(buffer);
      continue;
    }
    max_offset = PageGetMaxOffsetNumber(page);
    if (max_offset >= FirstOffsetNumber)
    {
      live_items = palloc0(sizeof(char *) * max_offset);
      live_item_sizes = palloc0(sizeof(Size) * max_offset);
    }

    for (offset = FirstOffsetNumber; offset <= max_offset; offset = OffsetNumberNext(offset))
    {
      ItemId item_id = PageGetItemId(page, offset);
      void *entry;
      uint32 entry_magic;
      Size item_size;

      if (!ItemIdHasStorage(item_id))
      {
        continue;
      }

      entry = PageGetItem(page, item_id);
      if (!xpod_rdf_perm_entry_is_valid(entry))
      {
        continue;
      }
      entry_magic = *((uint32 *) entry);
      item_size = ItemIdGetLength(item_id);

      if (entry_magic == XPOD_RDF_PERM_MAGIC)
      {
        XpodRdfPermEntry *tuple_entry = (XpodRdfPermEntry *) entry;

        if (callback != NULL && callback(&tuple_entry->heap_tid, callback_state))
        {
          page_removed++;
          continue;
        }

        live_items[live_item_count] = palloc(item_size);
        memcpy(live_items[live_item_count], entry, item_size);
        live_item_sizes[live_item_count] = item_size;
        live_item_count++;
        stats->num_index_tuples++;
      }
      else if (entry_magic == XPOD_RDF_PERM_POSTING_MAGIC || entry_magic == XPOD_RDF_PERM_POSTING_ARRAY_MAGIC)
      {
        XpodRdfPermPostingEntry *posting_entry = (XpodRdfPermPostingEntry *) entry;
        ItemPointerData *live_tids = palloc(sizeof(ItemPointerData) * posting_entry->posting_count);
        uint32 posting_index;
        uint32 live_posting_count = 0;

        for (posting_index = 0; posting_index < posting_entry->posting_count; posting_index++)
        {
          ItemPointerData posting_tid;

          if (!xpod_rdf_perm_posting_entry_tid_at(posting_entry, posting_index, &posting_tid))
          {
            continue;
          }
          if (callback != NULL && callback(&posting_tid, callback_state))
          {
            page_removed++;
            continue;
          }
          ItemPointerCopy(&posting_tid, &live_tids[live_posting_count]);
          live_posting_count++;
        }

        if (live_posting_count > 0)
        {
          Size live_item_size;
          XpodRdfPermPostingEntry *live_entry = xpod_rdf_perm_create_posting_entry(
            posting_entry->nkeys,
            posting_entry->keys,
            live_tids,
            live_posting_count,
            &live_item_size
          );

          live_items[live_item_count] = (char *) live_entry;
          live_item_sizes[live_item_count] = live_item_size;
          live_item_count++;
          stats->num_index_tuples += live_posting_count;
        }
        pfree(live_tids);
      }
    }

    if (page_removed > 0)
    {
      GenericXLogState *state = GenericXLogStart(info->index);
      Page xlog_page = GenericXLogRegisterBuffer(state, buffer, GENERIC_XLOG_FULL_IMAGE);
      int live_index;

      xpod_rdf_perm_init_page(xlog_page, BufferGetPageSize(buffer), page_opaque->nkeys);
      for (live_index = 0; live_index < live_item_count; live_index++)
      {
        OffsetNumber inserted = PageAddItem(
          xlog_page,
          (Item) live_items[live_index],
          live_item_sizes[live_index],
          InvalidOffsetNumber,
          false,
          false
        );

        if (inserted == InvalidOffsetNumber)
        {
          GenericXLogAbort(state);
          UnlockReleaseBuffer(buffer);
          ereport(ERROR,
                  (errmsg("could not rewrite xpod_rdf_perm index page during vacuum"),
                   errdetail("Live index entries no longer fit on the original page.")));
        }
      }
      xpod_rdf_perm_page_recompute_range(xlog_page);
      GenericXLogFinish(state);
      stats->tuples_removed += page_removed;
      total_removed += page_removed;
    }

    if (live_items != NULL)
    {
      int live_index;

      for (live_index = 0; live_index < live_item_count; live_index++)
      {
        pfree(live_items[live_index]);
      }
      pfree(live_items);
      pfree(live_item_sizes);
    }
    UnlockReleaseBuffer(buffer);
  }
  xpod_rdf_perm_rewrite_meta_tuple_count(info->index, total_removed);
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
  XpodRdfPermCostState state;
  uint64 meta_tuple_count = 0;
  bool global_sorted = false;
  bool prefix_stats_exact = false;
  uint16 meta_nkeys = 0;
  uint64 distinct_prefix_counts[XPOD_RDF_PERM_MAX_KEYS];
  double tuple_count;
  double page_count;
  Selectivity row_selectivity;
  Selectivity page_selectivity;
  double expected_rows;
  double expected_pages;

  (void) root;
  (void) loop_count;

  xpod_rdf_perm_prepare_cost_state(path, &state);
  memset(distinct_prefix_counts, 0, sizeof(distinct_prefix_counts));
  xpod_rdf_perm_read_cost_meta(
    path->indexinfo->indexoid,
    &meta_tuple_count,
    &global_sorted,
    &prefix_stats_exact,
    &meta_nkeys,
    distinct_prefix_counts
  );
  if (meta_nkeys > 0 && meta_nkeys < state.nkeys)
  {
    state.nkeys = meta_nkeys;
  }

  tuple_count = meta_tuple_count > 0
    ? (double) meta_tuple_count
    : Max(path->indexinfo->tuples, 1.0);
  page_count = Max((double) path->indexinfo->pages, 1.0);
  row_selectivity = xpod_rdf_perm_result_selectivity(&state, tuple_count, prefix_stats_exact, distinct_prefix_counts);
  page_selectivity = xpod_rdf_perm_page_selectivity(&state, page_count, prefix_stats_exact, distinct_prefix_counts);
  expected_rows = Max(1.0, tuple_count * row_selectivity);
  expected_pages = Max(1.0, page_count * page_selectivity);

  *indexStartupCost = global_sorted && page_selectivity < 1.0 ? 0.75 : 1.0;
  *indexTotalCost = *indexStartupCost + (Cost) expected_pages + (Cost) (expected_rows * 0.01);
  *indexSelectivity = row_selectivity;
  *indexCorrelation = global_sorted ? 0.95 : 0.0;
  *indexPages = expected_pages;
}

static void
xpod_rdf_perm_read_cost_meta(Oid index_oid,
                             uint64 *tuple_count,
                             bool *global_sorted,
                             bool *prefix_stats_exact,
                             uint16 *nkeys,
                             uint64 *distinct_prefix_counts)
{
  Relation indexRelation;
  BlockNumber block_count;
  Buffer buffer;
  Page page;
  XpodRdfPermMetaOpaque *meta;

  *tuple_count = 0;
  *global_sorted = false;
  *prefix_stats_exact = false;
  *nkeys = 0;
  memset(distinct_prefix_counts, 0, sizeof(uint64) * XPOD_RDF_PERM_MAX_KEYS);
  if (!OidIsValid(index_oid))
  {
    return;
  }

  indexRelation = index_open(index_oid, AccessShareLock);
  block_count = RelationGetNumberOfBlocks(indexRelation);
  if (block_count == 0)
  {
    index_close(indexRelation, AccessShareLock);
    return;
  }

  buffer = ReadBuffer(indexRelation, 0);
  LockBuffer(buffer, BUFFER_LOCK_SHARE);
  page = BufferGetPage(buffer);
  meta = xpod_rdf_perm_meta_opaque(page);
  if (meta != NULL)
  {
    *tuple_count = meta->tuple_count;
    *global_sorted = (meta->flags & XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED) != 0;
    *nkeys = meta->nkeys;
    if (xpod_rdf_perm_meta_supports_prefix_stats(page, meta))
    {
      uint16 key_index;

      *prefix_stats_exact = (meta->flags & XPOD_RDF_PERM_META_FLAG_PREFIX_STATS_EXACT) != 0;
      for (key_index = 0; key_index < meta->nkeys && key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
      {
        distinct_prefix_counts[key_index] = meta->distinct_prefix_counts[key_index];
      }
    }
  }
  UnlockReleaseBuffer(buffer);
  index_close(indexRelation, AccessShareLock);
}

static void
xpod_rdf_perm_prepare_cost_state(IndexPath *path, XpodRdfPermCostState *state)
{
  ListCell *cell;

  memset(state, 0, sizeof(XpodRdfPermCostState));
  state->nkeys = (uint16) Min(path->indexinfo->nkeycolumns, XPOD_RDF_PERM_MAX_KEYS);
  foreach(cell, path->indexclauses)
  {
    IndexClause *clause = (IndexClause *) lfirst(cell);

    xpod_rdf_perm_note_cost_clause(path, state, clause);
  }
}

static void
xpod_rdf_perm_note_cost_clause(IndexPath *path,
                               XpodRdfPermCostState *state,
                               IndexClause *clause)
{
  int index_col;
  StrategyNumber strategy;
  XpodRdfPermCostColumn *column;

  if (clause == NULL)
  {
    return;
  }
  index_col = clause->indexcol;
  if (index_col < 0 || index_col >= state->nkeys)
  {
    return;
  }

  state->clause_count++;
  column = &state->columns[index_col];
  strategy = xpod_rdf_perm_clause_strategy(path, clause);
  switch (strategy)
  {
    case BTEqualStrategyNumber:
      column->has_equal = true;
      break;
    case BTLessStrategyNumber:
    case BTLessEqualStrategyNumber:
    case BTGreaterEqualStrategyNumber:
    case BTGreaterStrategyNumber:
      column->has_range = true;
      break;
    default:
      column->has_unknown = true;
      break;
  }
}

static StrategyNumber
xpod_rdf_perm_clause_strategy(IndexPath *path, IndexClause *clause)
{
  ListCell *cell;

  foreach(cell, clause->indexquals)
  {
    RestrictInfo *rinfo = (RestrictInfo *) lfirst(cell);
    Node *node;
    OpExpr *op;
    StrategyNumber strategy;

    if (rinfo == NULL || !IsA(rinfo, RestrictInfo))
    {
      continue;
    }
    node = (Node *) rinfo->clause;
    if (node == NULL || !IsA(node, OpExpr))
    {
      continue;
    }
    op = (OpExpr *) node;
    strategy = xpod_rdf_perm_op_strategy_for_index_column(path, clause->indexcol, op->opno);
    if (strategy != InvalidStrategy)
    {
      return strategy;
    }
  }
  return InvalidStrategy;
}

static StrategyNumber
xpod_rdf_perm_op_strategy_for_index_column(IndexPath *path, int index_col, Oid opno)
{
  Oid opfamily;

  if (!OidIsValid(opno) || index_col < 0 || index_col >= path->indexinfo->nkeycolumns)
  {
    return InvalidStrategy;
  }
  opfamily = path->indexinfo->opfamily[index_col];
  return (StrategyNumber) get_op_opfamily_strategy(opno, opfamily);
}

static Selectivity
xpod_rdf_perm_result_selectivity(XpodRdfPermCostState *state,
                                 double tuple_count,
                                 bool prefix_stats_exact,
                                 uint64 *distinct_prefix_counts)
{
  Selectivity selectivity = 1.0;
  uint16 key_index;
  uint16 exact_prefix_nkeys = 0;

  if (state->clause_count == 0)
  {
    return 1.0;
  }

  if (prefix_stats_exact)
  {
    for (key_index = 0; key_index < state->nkeys; key_index++)
    {
      if (!state->columns[key_index].has_equal)
      {
        break;
      }
      exact_prefix_nkeys++;
    }
    if (
      exact_prefix_nkeys > 0
      && exact_prefix_nkeys <= XPOD_RDF_PERM_MAX_KEYS
      && distinct_prefix_counts[exact_prefix_nkeys - 1] > 0
    )
    {
      selectivity = 1.0 / (double) distinct_prefix_counts[exact_prefix_nkeys - 1];
      for (key_index = exact_prefix_nkeys; key_index < state->nkeys; key_index++)
      {
        XpodRdfPermCostColumn *column = &state->columns[key_index];

        if (column->has_equal)
        {
          selectivity *= 0.05;
        }
        else if (column->has_range)
        {
          selectivity *= 0.35;
        }
        else if (column->has_unknown)
        {
          selectivity *= 0.50;
        }
      }
      return xpod_rdf_perm_clamp_selectivity(selectivity, tuple_count);
    }
  }

  for (key_index = 0; key_index < state->nkeys; key_index++)
  {
    XpodRdfPermCostColumn *column = &state->columns[key_index];

    if (column->has_equal)
    {
      selectivity *= key_index == 0 ? 0.02 : 0.05;
    }
    else if (column->has_range)
    {
      selectivity *= key_index == 0 ? 0.20 : 0.35;
    }
    else if (column->has_unknown)
    {
      selectivity *= 0.50;
    }
  }
  return xpod_rdf_perm_clamp_selectivity(selectivity, tuple_count);
}

static Selectivity
xpod_rdf_perm_page_selectivity(XpodRdfPermCostState *state,
                               double page_count,
                               bool prefix_stats_exact,
                               uint64 *distinct_prefix_counts)
{
  Selectivity selectivity = 1.0;
  uint16 key_index;
  uint16 exact_prefix_nkeys = 0;

  if (state->clause_count == 0)
  {
    return 1.0;
  }
  if (prefix_stats_exact)
  {
    for (key_index = 0; key_index < state->nkeys; key_index++)
    {
      if (!state->columns[key_index].has_equal)
      {
        break;
      }
      exact_prefix_nkeys++;
    }
    if (
      exact_prefix_nkeys > 0
      && exact_prefix_nkeys <= XPOD_RDF_PERM_MAX_KEYS
      && distinct_prefix_counts[exact_prefix_nkeys - 1] > 0
    )
    {
      selectivity = 1.0 / (double) distinct_prefix_counts[exact_prefix_nkeys - 1];
      return xpod_rdf_perm_clamp_selectivity(selectivity, page_count);
    }
  }
  for (key_index = 0; key_index < state->nkeys; key_index++)
  {
    XpodRdfPermCostColumn *column = &state->columns[key_index];

    if (column->has_equal)
    {
      selectivity *= key_index == 0 ? 0.02 : 0.05;
      continue;
    }
    if (column->has_range)
    {
      selectivity *= key_index == 0 ? 0.20 : 0.35;
      break;
    }
    if (column->has_unknown)
    {
      selectivity *= key_index == 0 ? 0.50 : 0.75;
      break;
    }
    break;
  }
  if (selectivity < 0.001)
  {
    return 0.001;
  }
  if (selectivity > 1.0)
  {
    return 1.0;
  }
  return selectivity;
}

static Selectivity
xpod_rdf_perm_clamp_selectivity(Selectivity value, double tuple_count)
{
  Selectivity min_selectivity = tuple_count > 1.0 ? (1.0 / tuple_count) : 1.0;

  if (value < min_selectivity)
  {
    return min_selectivity;
  }
  if (value > 1.0)
  {
    return 1.0;
  }
  return value;
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
  opaque->current_posting = 0;
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
  opaque->current_posting = 0;
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
      opaque->current_posting = 0;
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
        opaque->current_posting = 0;
        continue;
      }
      opaque->current_offset = lower_bound_offset;
    }

    for (offset = opaque->current_offset; offset <= max_offset; offset = OffsetNumberNext(offset))
    {
      ItemId item_id = PageGetItemId(page, offset);
      void *entry;
      ItemPointerData heap_tid;
      uint32 next_posting = 0;

      if (!ItemIdHasStorage(item_id))
      {
        continue;
      }

      entry = PageGetItem(page, item_id);
      if (page_sorted && xpod_rdf_perm_entry_past_upper_bound(scan, entry))
      {
        break;
      }
      if (!xpod_rdf_perm_entry_is_valid(entry) || !xpod_rdf_perm_entry_matches(scan, entry))
      {
        opaque->current_posting = 0;
        continue;
      }
      if (!xpod_rdf_perm_entry_next_tid(entry, opaque->current_posting, &heap_tid, &next_posting))
      {
        opaque->current_posting = 0;
        continue;
      }

      scan->xs_heaptid = heap_tid;
      scan->xs_recheck = false;
      if (next_posting == 0)
      {
        opaque->current_offset = OffsetNumberNext(offset);
        opaque->current_posting = 0;
      }
      else
      {
        opaque->current_offset = offset;
        opaque->current_posting = next_posting;
      }
      UnlockReleaseBuffer(buffer);
      return true;
    }

    UnlockReleaseBuffer(buffer);
    opaque->current_block++;
    opaque->current_offset = FirstOffsetNumber;
    opaque->current_posting = 0;
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

static void
xpod_rdf_perm_build_distinct_prefix_counts(XpodRdfPermBuildEntry *entries,
                                           uint64 entry_count,
                                           uint16 nkeys,
                                           uint64 *distinct_prefix_counts)
{
  uint64 entry_index;
  uint16 prefix_nkeys;
  uint16 bounded_nkeys = Min(nkeys, XPOD_RDF_PERM_MAX_KEYS);

  memset(distinct_prefix_counts, 0, sizeof(uint64) * XPOD_RDF_PERM_MAX_KEYS);
  for (entry_index = 0; entry_index < entry_count; entry_index++)
  {
    for (prefix_nkeys = 1; prefix_nkeys <= bounded_nkeys; prefix_nkeys++)
    {
      if (
        entry_index == 0
        || xpod_rdf_perm_key_prefix_compare(
          entries[entry_index - 1].keys,
          prefix_nkeys,
          entries[entry_index].keys,
          prefix_nkeys
        ) != 0
      )
      {
        distinct_prefix_counts[prefix_nkeys - 1]++;
      }
    }
  }
}

static Size
xpod_rdf_perm_entry_size(uint16 nkeys)
{
  return MAXALIGN(offsetof(XpodRdfPermEntry, keys) + (sizeof(int64) * nkeys));
}

static Size
xpod_rdf_perm_posting_entry_header_size(uint16 nkeys)
{
  return MAXALIGN(offsetof(XpodRdfPermPostingEntry, keys) + (sizeof(int64) * nkeys));
}

static Size
xpod_rdf_perm_posting_entry_size(uint16 nkeys, uint32 payload_size)
{
  return MAXALIGN(xpod_rdf_perm_posting_entry_header_size(nkeys) + payload_size);
}

static Size
xpod_rdf_perm_posting_build_entry_size(XpodRdfPermBuildEntry *entries, uint32 posting_count)
{
  return xpod_rdf_perm_posting_entry_size(
    entries[0].nkeys,
    (uint32) xpod_rdf_perm_posting_payload_size_from_build_entries(entries, posting_count)
  );
}

static uint32
xpod_rdf_perm_build_posting_count_for_page(XpodRdfPermBuildEntry *entries, uint64 remaining_count)
{
  uint32 posting_count = 0;
  Size payload_size = 0;
  uint64 previous_tid = 0;

  while (posting_count < remaining_count)
  {
    uint64 tid = xpod_rdf_perm_tid_value(&entries[posting_count].heap_tid);
    uint64 delta = posting_count == 0 ? tid : tid - previous_tid;
    Size next_payload_size = payload_size + xpod_rdf_perm_varint_size(delta);
    Size next_entry_size = xpod_rdf_perm_posting_entry_size(entries[0].nkeys, (uint32) next_payload_size);

    if (next_entry_size > XPOD_RDF_PERM_MAX_ENTRY_SIZE)
    {
      break;
    }
    payload_size = next_payload_size;
    previous_tid = tid;
    posting_count++;
  }

  return posting_count == 0 ? 1 : posting_count;
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
xpod_rdf_perm_build_entries_same_keys(XpodRdfPermBuildEntry *left, XpodRdfPermBuildEntry *right)
{
  uint16 key_index;

  if (left->nkeys != right->nkeys)
  {
    return false;
  }
  for (key_index = 0; key_index < left->nkeys; key_index++)
  {
    if (left->keys[key_index] != right->keys[key_index])
    {
      return false;
    }
  }
  return true;
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

static bool
xpod_rdf_perm_append_posting_build_entries(Relation indexRelation, XpodRdfPermBuildEntry *entries, uint32 posting_count)
{
  Size entry_size = xpod_rdf_perm_posting_build_entry_size(entries, posting_count);
  BlockNumber block_count;
  BlockNumber first_data_block;
  Buffer buffer;

  if (entry_size > XPOD_RDF_PERM_MAX_ENTRY_SIZE)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf_perm posting entry is too large"),
             errdetail("Entry size %zu exceeds page capacity.", entry_size)));
  }

  xpod_rdf_perm_ensure_metapage(indexRelation, entries[0].nkeys);

  block_count = RelationGetNumberOfBlocks(indexRelation);
  first_data_block = xpod_rdf_perm_first_data_block(indexRelation);
  if (block_count > first_data_block)
  {
    buffer = ReadBuffer(indexRelation, block_count - 1);
    LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
    if (xpod_rdf_perm_page_add_posting_entry(indexRelation, buffer, entries, posting_count, false))
    {
      UnlockReleaseBuffer(buffer);
      return true;
    }
    UnlockReleaseBuffer(buffer);
  }

  buffer = ReadBuffer(indexRelation, P_NEW);
  LockBuffer(buffer, BUFFER_LOCK_EXCLUSIVE);
  if (!xpod_rdf_perm_page_add_posting_entry(indexRelation, buffer, entries, posting_count, true))
  {
    UnlockReleaseBuffer(buffer);
    ereport(ERROR,
            (errmsg("could not append xpod_rdf_perm posting entry"),
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
  opaque->flags = XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED | XPOD_RDF_PERM_META_FLAG_PREFIX_STATS_EXACT;
  GenericXLogFinish(state);
  UnlockReleaseBuffer(buffer);
}

static XpodRdfPermMetaOpaque *
xpod_rdf_perm_meta_opaque(Page page)
{
  XpodRdfPermMetaOpaque *opaque;

  if (PageGetSpecialSize(page) < XPOD_RDF_PERM_META_V1_SPECIAL_SIZE)
  {
    return NULL;
  }
  opaque = (XpodRdfPermMetaOpaque *) PageGetSpecialPointer(page);
  return opaque->magic == XPOD_RDF_PERM_META_MAGIC ? opaque : NULL;
}

static bool
xpod_rdf_perm_meta_supports_prefix_stats(Page page, XpodRdfPermMetaOpaque *opaque)
{
  return opaque != NULL
    && opaque->schema_version >= 2
    && PageGetSpecialSize(page) >= XPOD_RDF_PERM_META_SPECIAL_SIZE;
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
  bool out_of_order = false;
  bool prefix_stats_exact = false;

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
      out_of_order = true;
      opaque->flags &= ~XPOD_RDF_PERM_META_FLAG_GLOBAL_SORTED;
      opaque->flags &= ~XPOD_RDF_PERM_META_FLAG_PREFIX_STATS_EXACT;
    }
    prefix_stats_exact = !out_of_order
      && xpod_rdf_perm_meta_supports_prefix_stats(page, opaque)
      && (opaque->flags & XPOD_RDF_PERM_META_FLAG_PREFIX_STATS_EXACT) != 0;
    if (prefix_stats_exact)
    {
      for (key_index = 0; key_index < entry->nkeys && key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
      {
        if (
          opaque->tuple_count == 0
          || xpod_rdf_perm_key_prefix_compare(
            opaque->last_keys,
            key_index + 1,
            entry->keys,
            key_index + 1
          ) != 0
        )
        {
          opaque->distinct_prefix_counts[key_index]++;
        }
      }
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
                                        XpodRdfPermBuildEntry *last_entry,
                                        uint64 *distinct_prefix_counts)
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
    if (xpod_rdf_perm_meta_supports_prefix_stats(page, opaque))
    {
      opaque->flags |= XPOD_RDF_PERM_META_FLAG_PREFIX_STATS_EXACT;
      memset(opaque->distinct_prefix_counts, 0, sizeof(opaque->distinct_prefix_counts));
      for (key_index = 0; key_index < nkeys && key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
      {
        opaque->distinct_prefix_counts[key_index] = distinct_prefix_counts[key_index];
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
xpod_rdf_perm_page_add_item(Relation indexRelation,
                            Buffer buffer,
                            void *entry,
                            Size entry_size,
                            bool init_page,
                            uint16 nkeys)
{
  GenericXLogState *state;
  Page page;
  OffsetNumber inserted;

  page = BufferGetPage(buffer);
  if (!init_page && PageGetFreeSpace(page) < entry_size)
  {
    return false;
  }

  state = GenericXLogStart(indexRelation);
  page = GenericXLogRegisterBuffer(state, buffer, GENERIC_XLOG_FULL_IMAGE);
  if (init_page || PageGetMaxOffsetNumber(page) == 0)
  {
    xpod_rdf_perm_init_page(page, BufferGetPageSize(buffer), nkeys);
  }

  xpod_rdf_perm_page_update_sorted_flag(page, entry);
  inserted = PageAddItem(page, (Item) entry, entry_size, InvalidOffsetNumber, false, false);

  if (inserted == InvalidOffsetNumber)
  {
    GenericXLogAbort(state);
    return false;
  }

  xpod_rdf_perm_page_update_range(page, entry);
  GenericXLogFinish(state);
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
  bool added;
  uint16 key_index;

  entry = palloc0(entry_size);
  entry->magic = XPOD_RDF_PERM_MAGIC;
  entry->nkeys = build_entry->nkeys;
  entry->reserved = 0;
  ItemPointerCopy(&build_entry->heap_tid, &entry->heap_tid);

  for (key_index = 0; key_index < build_entry->nkeys; key_index++)
  {
    entry->keys[key_index] = build_entry->keys[key_index];
  }

  added = xpod_rdf_perm_page_add_item(indexRelation, buffer, entry, entry_size, init_page, build_entry->nkeys);
  pfree(entry);
  return added;
}

static bool
xpod_rdf_perm_page_add_posting_entry(Relation indexRelation,
                                     Buffer buffer,
                                     XpodRdfPermBuildEntry *entries,
                                     uint32 posting_count,
                                     bool init_page)
{
  Size entry_size;
  XpodRdfPermPostingEntry *entry;
  ItemPointerData *tids;
  bool added;
  uint32 posting_index;

  tids = palloc(sizeof(ItemPointerData) * posting_count);
  for (posting_index = 0; posting_index < posting_count; posting_index++)
  {
    ItemPointerCopy(&entries[posting_index].heap_tid, &tids[posting_index]);
  }

  entry = xpod_rdf_perm_create_posting_entry(
    entries[0].nkeys,
    entries[0].keys,
    tids,
    posting_count,
    &entry_size
  );
  added = xpod_rdf_perm_page_add_item(indexRelation, buffer, entry, entry_size, init_page, entries[0].nkeys);
  pfree(tids);
  pfree(entry);
  return added;
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

static void *
xpod_rdf_perm_page_entry(Page page, OffsetNumber offset)
{
  ItemId item_id;
  void *entry;

  if (!OffsetNumberIsValid(offset) || offset > PageGetMaxOffsetNumber(page))
  {
    return NULL;
  }
  item_id = PageGetItemId(page, offset);
  if (!ItemIdHasStorage(item_id))
  {
    return NULL;
  }
  entry = PageGetItem(page, item_id);
  return xpod_rdf_perm_entry_is_valid(entry) ? entry : NULL;
}

static bool
xpod_rdf_perm_page_is_sorted(Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);

  return opaque != NULL && (opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) != 0;
}

static void
xpod_rdf_perm_page_update_range(Page page, void *entry)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  int64 *entry_keys = xpod_rdf_perm_entry_keys(entry);
  uint16 entry_nkeys = xpod_rdf_perm_entry_nkeys(entry);
  uint16 key_index;

  if (opaque == NULL || entry_keys == NULL || entry_nkeys > XPOD_RDF_PERM_MAX_KEYS)
  {
    return;
  }

  if (opaque->tuple_count == 0)
  {
    opaque->nkeys = entry_nkeys;
    for (key_index = 0; key_index < entry_nkeys; key_index++)
    {
      opaque->min_keys[key_index] = entry_keys[key_index];
      opaque->max_keys[key_index] = entry_keys[key_index];
    }
  }
  else
  {
    for (key_index = 0; key_index < entry_nkeys; key_index++)
    {
      if (entry_keys[key_index] < opaque->min_keys[key_index])
      {
        opaque->min_keys[key_index] = entry_keys[key_index];
      }
      if (entry_keys[key_index] > opaque->max_keys[key_index])
      {
        opaque->max_keys[key_index] = entry_keys[key_index];
      }
    }
  }
  opaque->tuple_count += xpod_rdf_perm_entry_live_posting_count(entry);
}

static void
xpod_rdf_perm_page_recompute_range(Page page)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  OffsetNumber max_offset;
  OffsetNumber offset;
  void *previous_entry = NULL;

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
    void *entry = xpod_rdf_perm_page_entry(page, offset);

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
xpod_rdf_perm_page_update_sorted_flag(Page page, void *entry)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  OffsetNumber max_offset;
  void *last_entry;

  if (opaque == NULL)
  {
    return;
  }
  if (xpod_rdf_perm_entry_nkeys(entry) != opaque->nkeys)
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
  void *last_entry;

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
  void *first_entry;
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
    void *entry = xpod_rdf_perm_page_entry(page, (OffsetNumber) mid);

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
xpod_rdf_perm_entry_past_upper_bound(IndexScanDesc scan, void *entry)
{
  XpodRdfPermScanOpaque *scan_opaque = (XpodRdfPermScanOpaque *) scan->opaque;
  XpodRdfPermScanBounds *bounds = &scan_opaque->bounds;
  int64 *entry_keys = xpod_rdf_perm_entry_keys(entry);
  uint16 entry_nkeys = xpod_rdf_perm_entry_nkeys(entry);
  uint16 key_index;

  if (entry_keys == NULL || bounds->impossible)
  {
    return false;
  }

  for (key_index = 0; key_index < bounds->nkeys && key_index < entry_nkeys; key_index++)
  {
    XpodRdfPermColumnBound *bound = &bounds->columns[key_index];

    if (bound->has_equal)
    {
      if (entry_keys[key_index] > bound->equal)
      {
        return true;
      }
      if (entry_keys[key_index] < bound->equal)
      {
        return false;
      }
      continue;
    }
    if (bound->has_upper)
    {
      return entry_keys[key_index] > bound->upper
        || (entry_keys[key_index] == bound->upper && !bound->upper_inclusive);
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
  opaque->current_posting = 0;
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

  if (!xpod_rdf_perm_scan_key_argument_int64(key, &argument))
  {
    bounds->impossible = true;
    return;
  }
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

static bool
xpod_rdf_perm_scan_key_argument_int64(ScanKey key, int64 *argument)
{
  switch (key->sk_subtype)
  {
    case InvalidOid:
    case INT8OID:
      *argument = DatumGetInt64(key->sk_argument);
      return true;
    case INT4OID:
      *argument = (int64) DatumGetInt32(key->sk_argument);
      return true;
    case INT2OID:
      *argument = (int64) DatumGetInt16(key->sk_argument);
      return true;
    default:
      return false;
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
xpod_rdf_perm_entry_compare_entry(void *left, void *right)
{
  int64 *left_keys = xpod_rdf_perm_entry_keys(left);
  int64 *right_keys = xpod_rdf_perm_entry_keys(right);
  uint16 left_nkeys = xpod_rdf_perm_entry_nkeys(left);
  uint16 right_nkeys = xpod_rdf_perm_entry_nkeys(right);
  uint16 nkeys = Min(left_nkeys, right_nkeys);
  uint16 key_index;
  ItemPointerData left_tid;
  ItemPointerData right_tid;
  uint32 next_index;

  for (key_index = 0; key_index < nkeys; key_index++)
  {
    if (left_keys[key_index] < right_keys[key_index])
    {
      return -1;
    }
    if (left_keys[key_index] > right_keys[key_index])
    {
      return 1;
    }
  }
  if (left_nkeys < right_nkeys)
  {
    return -1;
  }
  if (left_nkeys > right_nkeys)
  {
    return 1;
  }
  if (!xpod_rdf_perm_entry_next_tid(left, 0, &left_tid, &next_index))
  {
    return -1;
  }
  if (!xpod_rdf_perm_entry_next_tid(right, 0, &right_tid, &next_index))
  {
    return 1;
  }
  return ItemPointerCompare(&left_tid, &right_tid);
}

static int
xpod_rdf_perm_entry_compare_key_prefix(void *entry, int64 *keys, uint16 nkeys)
{
  return xpod_rdf_perm_key_prefix_compare(xpod_rdf_perm_entry_keys(entry), xpod_rdf_perm_entry_nkeys(entry), keys, nkeys);
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
xpod_rdf_perm_entry_matches(IndexScanDesc scan, void *entry)
{
  int index_key;
  int64 *entry_keys = xpod_rdf_perm_entry_keys(entry);
  uint16 entry_nkeys = xpod_rdf_perm_entry_nkeys(entry);

  if (entry_keys == NULL)
  {
    return false;
  }

  for (index_key = 0; index_key < scan->numberOfKeys; index_key++)
  {
    ScanKey key = &scan->keyData[index_key];
    Datum value;
    Datum matched;

    if ((key->sk_flags & SK_ISNULL) || key->sk_attno < 1 || key->sk_attno > entry_nkeys)
    {
      return false;
    }

    value = Int64GetDatum(entry_keys[key->sk_attno - 1]);
    matched = FunctionCall2Coll(&key->sk_func, key->sk_collation, value, key->sk_argument);
    if (!DatumGetBool(matched))
    {
      return false;
    }
  }

  return true;
}

static bool
xpod_rdf_perm_entry_next_tid(void *entry, uint32 start_index, ItemPointerData *heap_tid, uint32 *next_index)
{
  uint32 magic;

  if (entry == NULL)
  {
    return false;
  }
  magic = *((uint32 *) entry);
  if (magic == XPOD_RDF_PERM_MAGIC)
  {
    XpodRdfPermEntry *tuple_entry = (XpodRdfPermEntry *) entry;

    if (start_index > 0)
    {
      return false;
    }
    ItemPointerCopy(&tuple_entry->heap_tid, heap_tid);
    *next_index = 0;
    return true;
  }
  if (magic == XPOD_RDF_PERM_POSTING_MAGIC || magic == XPOD_RDF_PERM_POSTING_ARRAY_MAGIC)
  {
    XpodRdfPermPostingEntry *posting_entry = (XpodRdfPermPostingEntry *) entry;

    if (start_index >= posting_entry->posting_count)
    {
      return false;
    }
    if (!xpod_rdf_perm_posting_entry_tid_at(posting_entry, start_index, heap_tid))
    {
      return false;
    }
    *next_index = start_index + 1 < posting_entry->posting_count ? start_index + 1 : 0;
    return true;
  }
  return false;
}

static bool
xpod_rdf_perm_entry_is_valid(void *entry)
{
  uint32 magic;
  uint16 nkeys;

  if (entry == NULL)
  {
    return false;
  }
  magic = *((uint32 *) entry);
  if (magic != XPOD_RDF_PERM_MAGIC && magic != XPOD_RDF_PERM_POSTING_MAGIC && magic != XPOD_RDF_PERM_POSTING_ARRAY_MAGIC)
  {
    return false;
  }
  nkeys = xpod_rdf_perm_entry_nkeys(entry);
  if (nkeys == 0 || nkeys > XPOD_RDF_PERM_MAX_KEYS)
  {
    return false;
  }
  if (magic == XPOD_RDF_PERM_POSTING_MAGIC || magic == XPOD_RDF_PERM_POSTING_ARRAY_MAGIC)
  {
    XpodRdfPermPostingEntry *posting_entry = (XpodRdfPermPostingEntry *) entry;
    ItemPointerData last_tid;

    if (posting_entry->posting_count == 0)
    {
      return false;
    }
    if (magic == XPOD_RDF_PERM_POSTING_MAGIC && posting_entry->payload_size == 0)
    {
      return false;
    }
    return xpod_rdf_perm_posting_entry_tid_at(posting_entry, posting_entry->posting_count - 1, &last_tid);
  }
  return true;
}

static uint16
xpod_rdf_perm_entry_nkeys(void *entry)
{
  uint32 magic;

  if (entry == NULL)
  {
    return 0;
  }
  magic = *((uint32 *) entry);
  if (magic == XPOD_RDF_PERM_MAGIC)
  {
    return ((XpodRdfPermEntry *) entry)->nkeys;
  }
  if (magic == XPOD_RDF_PERM_POSTING_MAGIC || magic == XPOD_RDF_PERM_POSTING_ARRAY_MAGIC)
  {
    return ((XpodRdfPermPostingEntry *) entry)->nkeys;
  }
  return 0;
}

static int64 *
xpod_rdf_perm_entry_keys(void *entry)
{
  uint32 magic;

  if (entry == NULL)
  {
    return NULL;
  }
  magic = *((uint32 *) entry);
  if (magic == XPOD_RDF_PERM_MAGIC)
  {
    return ((XpodRdfPermEntry *) entry)->keys;
  }
  if (magic == XPOD_RDF_PERM_POSTING_MAGIC || magic == XPOD_RDF_PERM_POSTING_ARRAY_MAGIC)
  {
    return ((XpodRdfPermPostingEntry *) entry)->keys;
  }
  return NULL;
}

static uint32
xpod_rdf_perm_entry_live_posting_count(void *entry)
{
  uint32 magic;

  if (entry == NULL)
  {
    return 0;
  }
  magic = *((uint32 *) entry);
  if (magic == XPOD_RDF_PERM_MAGIC)
  {
    return 1;
  }
  if (magic == XPOD_RDF_PERM_POSTING_MAGIC || magic == XPOD_RDF_PERM_POSTING_ARRAY_MAGIC)
  {
    return ((XpodRdfPermPostingEntry *) entry)->posting_count;
  }
  return 0;
}

static void
xpod_rdf_perm_rewrite_meta_tuple_count(Relation indexRelation, uint64 tuples_removed)
{
  Buffer buffer;
  GenericXLogState *state;
  Page page;
  XpodRdfPermMetaOpaque *opaque;

  if (tuples_removed == 0 || !xpod_rdf_perm_relation_has_metapage(indexRelation))
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
    opaque->tuple_count = opaque->tuple_count > tuples_removed ? opaque->tuple_count - tuples_removed : 0;
  }
  GenericXLogFinish(state);
  UnlockReleaseBuffer(buffer);
}

static Size
xpod_rdf_perm_posting_payload_size_from_build_entries(XpodRdfPermBuildEntry *entries, uint32 posting_count)
{
  Size payload_size = 0;
  uint64 previous_tid = 0;
  uint32 posting_index;

  for (posting_index = 0; posting_index < posting_count; posting_index++)
  {
    uint64 tid = xpod_rdf_perm_tid_value(&entries[posting_index].heap_tid);
    uint64 delta = posting_index == 0 ? tid : tid - previous_tid;

    payload_size += xpod_rdf_perm_varint_size(delta);
    previous_tid = tid;
  }
  return payload_size;
}

static Size
xpod_rdf_perm_posting_payload_size_from_tids(ItemPointerData *tids, uint32 posting_count)
{
  Size payload_size = 0;
  uint64 previous_tid = 0;
  uint32 posting_index;

  for (posting_index = 0; posting_index < posting_count; posting_index++)
  {
    uint64 tid = xpod_rdf_perm_tid_value(&tids[posting_index]);
    uint64 delta = posting_index == 0 ? tid : tid - previous_tid;

    payload_size += xpod_rdf_perm_varint_size(delta);
    previous_tid = tid;
  }
  return payload_size;
}

static XpodRdfPermPostingEntry *
xpod_rdf_perm_create_posting_entry(uint16 nkeys,
                                   int64 *keys,
                                   ItemPointerData *tids,
                                   uint32 posting_count,
                                   Size *entry_size)
{
  Size payload_size = xpod_rdf_perm_posting_payload_size_from_tids(tids, posting_count);
  XpodRdfPermPostingEntry *entry;
  uint8 *payload;
  uint8 *cursor;
  uint64 previous_tid = 0;
  uint16 key_index;
  uint32 posting_index;

  *entry_size = xpod_rdf_perm_posting_entry_size(nkeys, (uint32) payload_size);
  if (*entry_size > XPOD_RDF_PERM_MAX_ENTRY_SIZE)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf_perm compressed posting entry is too large"),
             errdetail("Entry size %zu exceeds page capacity.", *entry_size)));
  }

  entry = palloc0(*entry_size);
  entry->magic = XPOD_RDF_PERM_POSTING_MAGIC;
  entry->nkeys = nkeys;
  entry->posting_count = posting_count;
  entry->payload_size = (uint32) payload_size;
  for (key_index = 0; key_index < nkeys; key_index++)
  {
    entry->keys[key_index] = keys[key_index];
  }

  payload = xpod_rdf_perm_posting_entry_payload(entry);
  cursor = payload;
  for (posting_index = 0; posting_index < posting_count; posting_index++)
  {
    uint64 tid = xpod_rdf_perm_tid_value(&tids[posting_index]);
    uint64 delta = posting_index == 0 ? tid : tid - previous_tid;

    cursor = xpod_rdf_perm_varint_encode(cursor, delta);
    previous_tid = tid;
  }
  Assert((Size) (cursor - payload) == payload_size);
  return entry;
}

static uint8 *
xpod_rdf_perm_posting_entry_payload(XpodRdfPermPostingEntry *entry)
{
  return ((uint8 *) entry) + xpod_rdf_perm_posting_entry_header_size(entry->nkeys);
}

static ItemPointerData *
xpod_rdf_perm_posting_array_entry_tids(XpodRdfPermPostingEntry *entry)
{
  return (ItemPointerData *) (((char *) entry) + xpod_rdf_perm_posting_entry_header_size(entry->nkeys));
}

static bool
xpod_rdf_perm_posting_entry_tid_at(XpodRdfPermPostingEntry *entry,
                                   uint32 posting_index,
                                   ItemPointerData *heap_tid)
{
  uint32 magic;
  uint32 current_posting;
  uint64 tid = 0;
  uint8 *cursor;
  uint8 *end;

  if (entry == NULL || posting_index >= entry->posting_count)
  {
    return false;
  }
  magic = entry->magic;
  if (magic == XPOD_RDF_PERM_POSTING_ARRAY_MAGIC)
  {
    ItemPointerData *tids = xpod_rdf_perm_posting_array_entry_tids(entry);

    ItemPointerCopy(&tids[posting_index], heap_tid);
    return true;
  }
  if (magic != XPOD_RDF_PERM_POSTING_MAGIC || entry->payload_size == 0)
  {
    return false;
  }

  cursor = xpod_rdf_perm_posting_entry_payload(entry);
  end = cursor + entry->payload_size;
  for (current_posting = 0; current_posting <= posting_index; current_posting++)
  {
    uint64 delta;

    if (!xpod_rdf_perm_varint_decode(&cursor, end, &delta))
    {
      return false;
    }
    tid += delta;
  }

  xpod_rdf_perm_tid_from_value(tid, heap_tid);
  return true;
}

static uint64
xpod_rdf_perm_tid_value(ItemPointerData *tid)
{
  return (((uint64) ItemPointerGetBlockNumber(tid)) << 16) | (uint64) ItemPointerGetOffsetNumber(tid);
}

static void
xpod_rdf_perm_tid_from_value(uint64 value, ItemPointerData *tid)
{
  BlockNumber block = (BlockNumber) (value >> 16);
  OffsetNumber offset = (OffsetNumber) (value & 0xffff);

  ItemPointerSet(tid, block, offset);
}

static Size
xpod_rdf_perm_varint_size(uint64 value)
{
  Size size = 1;

  while (value >= 0x80)
  {
    value >>= 7;
    size++;
  }
  return size;
}

static uint8 *
xpod_rdf_perm_varint_encode(uint8 *cursor, uint64 value)
{
  while (value >= 0x80)
  {
    *cursor++ = (uint8) ((value & 0x7f) | 0x80);
    value >>= 7;
  }
  *cursor++ = (uint8) value;
  return cursor;
}

static bool
xpod_rdf_perm_varint_decode(uint8 **cursor, uint8 *end, uint64 *value)
{
  uint64 result = 0;
  uint32 shift = 0;

  while (*cursor < end && shift < 64)
  {
    uint8 byte = **cursor;

    (*cursor)++;
    result |= ((uint64) (byte & 0x7f)) << shift;
    if ((byte & 0x80) == 0)
    {
      *value = result;
      return true;
    }
    shift += 7;
  }
  return false;
}

static void
xpod_rdf_scan_quads_put_rows(ReturnSetInfo *rsinfo)
{
  uint64 row_index;

  if (rsinfo == NULL || rsinfo->setResult == NULL || rsinfo->setDesc == NULL || SPI_tuptable == NULL)
  {
    ereport(ERROR, (errmsg("xpod_rdf.scan_quads expected a materialized set-returning context")));
  }

  for (row_index = 0; row_index < SPI_processed; row_index++)
  {
    Datum values[4];
    bool nulls[4] = { false, false, false, false };
    HeapTuple tuple = SPI_tuptable->vals[row_index];
    TupleDesc tupdesc = SPI_tuptable->tupdesc;
    int column;

    for (column = 0; column < 4; column++)
    {
      values[column] = SPI_getbinval(tuple, tupdesc, column + 1, &nulls[column]);
    }
    tuplestore_putvalues(rsinfo->setResult, rsinfo->setDesc, values, nulls);
  }
}

static void
xpod_rdf_scan_quads_add_array_filter(StringInfo sql,
                                     Datum *values,
                                     char *nulls,
                                     Oid *argtypes,
                                     int *nargs,
                                     FunctionCallInfo fcinfo,
                                     int arg_index,
                                     const char *column,
                                     bool *has_where)
{
  int length;
  int param_index;

  if (PG_ARGISNULL(arg_index))
  {
    return;
  }

  xpod_rdf_scan_quads_add_where(sql, has_where);

  length = xpod_rdf_array_arg_length(fcinfo, arg_index);
  if (length <= 0)
  {
    appendStringInfoString(sql, "1 = 0");
    return;
  }

  values[*nargs] = PG_GETARG_DATUM(arg_index);
  nulls[*nargs] = ' ';
  argtypes[*nargs] = INT8ARRAYOID;
  (*nargs)++;
  param_index = *nargs;

  if (length == 1)
  {
    appendStringInfo(sql, "%s = ($%d::bigint[])[1]", column, param_index);
    return;
  }
  appendStringInfo(sql, "%s = ANY($%d::bigint[])", column, param_index);
}

static void
xpod_rdf_scan_quads_add_int8_clause(StringInfo sql,
                                    Datum *values,
                                    char *nulls,
                                    Oid *argtypes,
                                    int *nargs,
                                    FunctionCallInfo fcinfo,
                                    int arg_index,
                                    const char *clause)
{
  int param_index;

  if (PG_ARGISNULL(arg_index))
  {
    return;
  }

  values[*nargs] = PG_GETARG_DATUM(arg_index);
  nulls[*nargs] = ' ';
  argtypes[*nargs] = INT8OID;
  (*nargs)++;
  param_index = *nargs;
  appendStringInfo(sql, "%s$%d::bigint", clause, param_index);
}

static void
xpod_rdf_scan_quads_add_graph_prefix_filter(StringInfo sql,
                                            Datum *values,
                                            char *nulls,
                                            Oid *argtypes,
                                            int *nargs,
                                            FunctionCallInfo fcinfo,
                                            int head_min_arg_index,
                                            int head_max_arg_index,
                                            int prefix_min_arg_index,
                                            int prefix_max_arg_index,
                                            bool *has_where)
{
  if (PG_ARGISNULL(head_min_arg_index) ||
      PG_ARGISNULL(head_max_arg_index) ||
      PG_ARGISNULL(prefix_min_arg_index) ||
      PG_ARGISNULL(prefix_max_arg_index))
  {
    return;
  }

  appendStringInfoString(sql, " JOIN rdf_terms graph_prefix_term ON graph_prefix_term.id = q.graph_id");
  xpod_rdf_scan_quads_add_where(sql, has_where);
  appendStringInfoString(sql, "graph_prefix_term.kind = 'iri'");
  xpod_rdf_scan_quads_add_text_condition(sql, values, nulls, argtypes, nargs, fcinfo, head_min_arg_index, " AND graph_prefix_term.value_head >= ");
  xpod_rdf_scan_quads_add_text_condition(sql, values, nulls, argtypes, nargs, fcinfo, head_max_arg_index, " AND graph_prefix_term.value_head < ");
  xpod_rdf_scan_quads_add_text_condition(sql, values, nulls, argtypes, nargs, fcinfo, prefix_min_arg_index, " AND graph_prefix_term.value >= ");
  xpod_rdf_scan_quads_add_text_condition(sql, values, nulls, argtypes, nargs, fcinfo, prefix_max_arg_index, " AND graph_prefix_term.value < ");
}

static void
xpod_rdf_scan_quads_add_text_condition(StringInfo sql,
                                       Datum *values,
                                       char *nulls,
                                       Oid *argtypes,
                                       int *nargs,
                                       FunctionCallInfo fcinfo,
                                       int arg_index,
                                       const char *clause)
{
  int param_index;

  values[*nargs] = PG_GETARG_DATUM(arg_index);
  nulls[*nargs] = ' ';
  argtypes[*nargs] = TEXTOID;
  (*nargs)++;
  param_index = *nargs;
  appendStringInfo(sql, "%s$%d::text", clause, param_index);
}

static void
xpod_rdf_scan_quads_add_where(StringInfo sql, bool *has_where)
{
  if (*has_where)
  {
    appendStringInfoString(sql, " AND ");
  }
  else
  {
    appendStringInfoString(sql, " WHERE ");
    *has_where = true;
  }
}

static int
xpod_rdf_array_arg_length(FunctionCallInfo fcinfo, int arg_index)
{
  ArrayType *array;
  int length;

  if (PG_ARGISNULL(arg_index))
  {
    return -1;
  }

  array = PG_GETARG_ARRAYTYPE_P(arg_index);
  length = ArrayGetNItems(ARR_NDIM(array), ARR_DIMS(array));
  PG_FREE_IF_COPY(array, arg_index);
  return length;
}
