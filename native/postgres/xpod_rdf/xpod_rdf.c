#include "postgres.h"

#include "access/stratnum.h"
#include "access/amapi.h"
#include "access/genam.h"
#include "access/generic_xlog.h"
#include "access/table.h"
#include "access/tableam.h"
#include "catalog/pg_type_d.h"
#include "executor/tuptable.h"
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
#include "utils/snapmgr.h"
#include "utils/tuplestore.h"

PG_MODULE_MAGIC;

PG_FUNCTION_INFO_V1(xpod_rdf_version);
PG_FUNCTION_INFO_V1(xpod_rdf_capabilities);
PG_FUNCTION_INFO_V1(xpod_rdf_term_id_cmp);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_index_stats);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_index_probe);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_index_scan);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_index_scan_any);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_index_count);
PG_FUNCTION_INFO_V1(xpod_rdf_perm_index_count_any);
PG_FUNCTION_INFO_V1(xpod_rdf_subject_star_join);
PG_FUNCTION_INFO_V1(xpod_rdf_subject_star_count);
PG_FUNCTION_INFO_V1(xpod_rdf_bgp_join);
PG_FUNCTION_INFO_V1(xpod_rdf_values_join);
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
#define XPOD_RDF_QUAD_GRAPH_ATTNUM 1
#define XPOD_RDF_QUAD_SUBJECT_ATTNUM 2
#define XPOD_RDF_QUAD_PREDICATE_ATTNUM 3
#define XPOD_RDF_QUAD_OBJECT_ATTNUM 4
#define XPOD_RDF_STAR_COUNT_MAX_AGGREGATES 8
#define XPOD_RDF_BGP_MAX_PATTERNS 4
#define XPOD_RDF_BGP_MAX_VARIABLES 8
#define XPOD_RDF_BGP_MAX_OUTPUTS 8

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

typedef struct XpodRdfPermPrefixSet
{
  int64 *values;
  int value_count;
} XpodRdfPermPrefixSet;

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

typedef bool (*XpodRdfPermScanVisitor)(ItemPointerData *heap_tid,
                                       int64 *keys,
                                       uint16 nkeys,
                                       void *state);

typedef struct XpodRdfInt64ArrayArg
{
  int64 *values;
  bool *nulls;
  int count;
} XpodRdfInt64ArrayArg;

typedef struct XpodRdfInt16ArrayArg
{
  int16 *values;
  bool *nulls;
  int count;
} XpodRdfInt16ArrayArg;

typedef struct XpodRdfOidArrayArg
{
  Oid *values;
  bool *nulls;
  int count;
} XpodRdfOidArrayArg;

#define XPOD_RDF_STAR_JOIN_MAX_PROBES 4

typedef struct XpodRdfStarJoinProbe
{
  int64 predicate_id;
  bool has_object_id;
  int64 object_id;
} XpodRdfStarJoinProbe;

typedef struct XpodRdfStarJoinProbeMatches
{
  int64 *object_ids;
  int count;
  int capacity;
} XpodRdfStarJoinProbeMatches;

typedef struct XpodRdfInt64List
{
  int64 *values;
  int count;
  int capacity;
} XpodRdfInt64List;

typedef struct XpodRdfSubjectStarJoinState
{
  Relation heap_relation;
  Relation probe_index_relation;
  TupleTableSlot *heap_slot;
  ReturnSetInfo *rsinfo;
  XpodRdfStarJoinProbe probes[XPOD_RDF_STAR_JOIN_MAX_PROBES];
  int probe_count;
  int seed_subject_key;
  AttrNumber seed_attnums[XPOD_RDF_PERM_MAX_KEYS];
  AttrNumber probe_attnums[XPOD_RDF_PERM_MAX_KEYS];
  int64 *graph_ids;
  int graph_id_count;
  bool count_summary;
  int aggregate_count;
  int aggregate_variables[XPOD_RDF_STAR_COUNT_MAX_AGGREGATES];
  bool aggregate_distinct[XPOD_RDF_STAR_COUNT_MAX_AGGREGATES];
  uint64 aggregate_counts[XPOD_RDF_STAR_COUNT_MAX_AGGREGATES];
  XpodRdfInt64List aggregate_distinct_values[XPOD_RDF_STAR_COUNT_MAX_AGGREGATES];
} XpodRdfSubjectStarJoinState;

typedef struct XpodRdfPermCountState
{
  Relation heap_relation;
  TupleTableSlot *heap_slot;
  AttrNumber attnums[XPOD_RDF_PERM_MAX_KEYS];
  int64 *graph_ids;
  int graph_id_count;
  int64 *subject_ids;
  int subject_id_count;
  int64 *predicate_ids;
  int predicate_id_count;
  int64 *object_ids;
  int object_id_count;
  uint64 count;
} XpodRdfPermCountState;

typedef struct XpodRdfBgpPattern
{
  Relation index_relation;
  AttrNumber attnums[XPOD_RDF_PERM_MAX_KEYS];
  bool has_constant[XPOD_RDF_PERM_MAX_KEYS];
  int64 constants[XPOD_RDF_PERM_MAX_KEYS];
  int variable_slots[XPOD_RDF_PERM_MAX_KEYS];
} XpodRdfBgpPattern;

typedef struct XpodRdfBgpJoinState
{
  Relation heap_relation;
  TupleTableSlot *heap_slot;
  ReturnSetInfo *rsinfo;
  XpodRdfBgpPattern patterns[XPOD_RDF_BGP_MAX_PATTERNS];
  int pattern_count;
  bool bound[XPOD_RDF_BGP_MAX_VARIABLES];
  int64 bindings[XPOD_RDF_BGP_MAX_VARIABLES];
  int output_slots[XPOD_RDF_BGP_MAX_OUTPUTS];
  int output_count;
  int value_slots[XPOD_RDF_BGP_MAX_OUTPUTS];
  int value_width;
  int value_row_count;
  int64 *value_rows;
} XpodRdfBgpJoinState;

typedef struct XpodRdfBgpScanState
{
  XpodRdfBgpJoinState *join_state;
  int pattern_index;
} XpodRdfBgpScanState;

typedef struct XpodRdfSubjectStarProbeState
{
  XpodRdfSubjectStarJoinState *join_state;
  XpodRdfStarJoinProbe *probe;
  int64 subject_id;
  XpodRdfStarJoinProbeMatches *matches;
} XpodRdfSubjectStarProbeState;

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
static BlockNumber xpod_rdf_perm_seek_lower_block_for_prefix(Relation indexRelation,
                                                             BlockNumber first_block,
                                                             BlockNumber block_count,
                                                             int64 *keys,
                                                             uint16 prefix_nkeys,
                                                             uint64 *seek_pages_examined);
static OffsetNumber xpod_rdf_perm_page_seek_lower_bound(IndexScanDesc scan, Page page);
static OffsetNumber xpod_rdf_perm_page_seek_prefix(Page page, int64 *keys, uint16 prefix_nkeys);
static bool xpod_rdf_perm_page_prefix_may_match(Page page,
                                                int64 *keys,
                                                uint16 prefix_nkeys,
                                                bool *last_before,
                                                bool *first_past);
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
static void xpod_rdf_perm_probe_prefix_args(FunctionCallInfo fcinfo,
                                            uint16 index_nkeys,
                                            int start_arg_index,
                                            int64 *keys,
                                            uint16 *prefix_nkeys);
static void xpod_rdf_perm_array_prefix_args(FunctionCallInfo fcinfo,
                                            uint16 index_nkeys,
                                            int start_arg_index,
                                            XpodRdfPermPrefixSet *prefix_sets,
                                            uint16 *prefix_nkeys,
                                            bool *empty_prefix);
static void xpod_rdf_perm_scan_prefix(Relation indexRelation,
                                      int64 *prefix_keys,
                                      uint16 prefix_nkeys,
                                      ReturnSetInfo *rsinfo);
static void xpod_rdf_perm_scan_prefix_visit(Relation indexRelation,
                                            int64 *prefix_keys,
                                            uint16 prefix_nkeys,
                                            XpodRdfPermScanVisitor visitor,
                                            void *visitor_state);
static bool xpod_rdf_perm_scan_tuplestore_visitor(ItemPointerData *heap_tid,
                                                  int64 *keys,
                                                  uint16 nkeys,
                                                  void *state);
static void xpod_rdf_perm_scan_prefix_sets(Relation indexRelation,
                                           XpodRdfPermPrefixSet *prefix_sets,
                                           uint16 prefix_nkeys,
                                           ReturnSetInfo *rsinfo);
static void xpod_rdf_perm_scan_prefix_sets_visit(Relation indexRelation,
                                                 XpodRdfPermPrefixSet *prefix_sets,
                                                 uint16 prefix_nkeys,
                                                 XpodRdfPermScanVisitor visitor,
                                                 void *visitor_state);
static void xpod_rdf_perm_scan_prefix_sets_visit_recurse(Relation indexRelation,
                                                         XpodRdfPermPrefixSet *prefix_sets,
                                                         uint16 prefix_nkeys,
                                                         uint16 depth,
                                                         int64 *prefix_keys,
                                                         XpodRdfPermScanVisitor visitor,
                                                         void *visitor_state);
static void xpod_rdf_perm_scan_put_row(ReturnSetInfo *rsinfo,
                                       ItemPointerData *heap_tid,
                                       int64 *keys,
                                       uint16 nkeys);
static int xpod_rdf_perm_int64_compare(const void *left, const void *right);
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
static XpodRdfInt64ArrayArg xpod_rdf_int64_array_arg(FunctionCallInfo fcinfo,
                                                     int arg_index,
                                                     bool allow_nulls);
static XpodRdfInt16ArrayArg xpod_rdf_int16_array_arg(FunctionCallInfo fcinfo,
                                                     int arg_index,
                                                     bool allow_nulls);
static XpodRdfOidArrayArg xpod_rdf_oid_array_arg(FunctionCallInfo fcinfo,
                                                 int arg_index,
                                                 bool allow_nulls);
static bool xpod_rdf_int64_array_contains_sorted(int64 *values, int count, int64 value);
static void xpod_rdf_subject_star_join_put_rows(XpodRdfSubjectStarJoinState *state,
                                                int64 subject_id,
                                                XpodRdfStarJoinProbeMatches *matches,
                                                int probe_index,
                                                int64 *selected_objects);
static void xpod_rdf_subject_star_count_summary_add(XpodRdfSubjectStarJoinState *state,
                                                    int64 subject_id,
                                                    XpodRdfStarJoinProbeMatches *matches);
static void xpod_rdf_subject_star_count_summary_put_row(XpodRdfSubjectStarJoinState *state);
static bool xpod_rdf_subject_star_seed_visitor(ItemPointerData *heap_tid,
                                               int64 *keys,
                                               uint16 nkeys,
                                               void *state);
static bool xpod_rdf_subject_star_probe_visitor(ItemPointerData *heap_tid,
                                                int64 *keys,
                                                uint16 nkeys,
                                                void *state);
static void xpod_rdf_bgp_join_run(XpodRdfBgpJoinState *state);
static void xpod_rdf_bgp_join_recurse(XpodRdfBgpJoinState *state,
                                      int pattern_index);
static bool xpod_rdf_bgp_join_visitor(ItemPointerData *heap_tid,
                                      int64 *keys,
                                      uint16 nkeys,
                                      void *state);
static void xpod_rdf_bgp_join_put_row(XpodRdfBgpJoinState *state);
static bool xpod_rdf_perm_count_visitor(ItemPointerData *heap_tid,
                                        int64 *keys,
                                        uint16 nkeys,
                                        void *state);
static bool xpod_rdf_perm_count_filter_matches(XpodRdfPermCountState *state,
                                               int64 graph_id,
                                               int64 subject_id,
                                               int64 predicate_id,
                                               int64 object_id);
static void xpod_rdf_sort_int64_arg(XpodRdfInt64ArrayArg *arg);
static bool xpod_rdf_heap_quad_visible_matches(Relation heapRelation,
                                               TupleTableSlot *slot,
                                               ItemPointerData *heap_tid,
                                               int64 graph_id,
                                               int64 subject_id,
                                               int64 predicate_id,
                                               int64 object_id);
static int64 xpod_rdf_slot_int64(TupleTableSlot *slot, AttrNumber attnum, bool *ok);
static bool xpod_rdf_perm_keys_quad_value(int64 *keys,
                                          uint16 nkeys,
                                          AttrNumber *attnums,
                                          AttrNumber attnum,
                                          int64 *value);
static void xpod_rdf_star_join_matches_add(XpodRdfStarJoinProbeMatches *matches,
                                           int64 object_id);
static void xpod_rdf_int64_list_add(XpodRdfInt64List *list, int64 value);
static uint64 xpod_rdf_int64_list_unique_count(XpodRdfInt64List *list);

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
    "join.required_bgp.native,"
    "join.values.native,"
    "aggregate.count,"
    "aggregate.numeric,"
    "aggregate.subject_star_count,"
    "cache.result,"
    "index.xpod_rdf_perm,"
    "index.xpod_rdf_perm.probe,"
    "index.xpod_rdf_perm.scan,"
    "index.xpod_rdf_perm.scan_any,"
    "index.xpod_rdf_perm.count,"
    "index.xpod_rdf_perm.count_any,"
    "join.subject_star"
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
xpod_rdf_perm_index_probe(PG_FUNCTION_ARGS)
{
  Oid index_oid = PG_GETARG_OID(0);
  Relation indexRelation;
  BlockNumber block_count;
  BlockNumber first_data_block;
  BlockNumber block;
  BlockNumber start_block;
  bool global_sorted;
  int64 prefix_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 prefix_nkeys = 0;
  uint16 index_nkeys;
  uint64 data_pages = 0;
  uint64 seek_pages_examined = 0;
  uint64 pages_visited = 0;
  uint64 pages_skipped = 0;
  uint64 pages_skipped_before_lower = 0;
  uint64 pages_skipped_past_upper = 0;
  uint64 pages_skipped_by_range = 0;
  uint64 page_local_seeks = 0;
  uint64 items_examined = 0;
  uint64 items_matched = 0;
  uint64 postings_matched = 0;
  bool stopped_at_upper_bound = false;
  StringInfoData json;

  indexRelation = index_open(index_oid, AccessShareLock);
  xpod_rdf_perm_assert_supported_nkeys(indexRelation->rd_att->natts);
  index_nkeys = (uint16) Min(indexRelation->rd_att->natts, XPOD_RDF_PERM_MAX_KEYS);
  xpod_rdf_perm_probe_prefix_args(fcinfo, index_nkeys, 1, prefix_keys, &prefix_nkeys);

  block_count = RelationGetNumberOfBlocks(indexRelation);
  first_data_block = xpod_rdf_perm_first_data_block(indexRelation);
  global_sorted = xpod_rdf_perm_relation_is_globally_sorted(indexRelation);
  start_block = first_data_block;
  if (global_sorted && prefix_nkeys > 0)
  {
    start_block = xpod_rdf_perm_seek_lower_block_for_prefix(
      indexRelation,
      first_data_block,
      block_count,
      prefix_keys,
      prefix_nkeys,
      &seek_pages_examined
    );
  }

  for (block = start_block; block < block_count; block++)
  {
    Buffer buffer;
    Page page;
    XpodRdfPermPageOpaque *opaque;
    bool last_before = false;
    bool first_past = false;
    bool page_sorted;
    OffsetNumber max_offset;
    OffsetNumber offset;

    buffer = ReadBuffer(indexRelation, block);
    LockBuffer(buffer, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buffer);
    opaque = xpod_rdf_perm_page_opaque(page);
    if (opaque == NULL)
    {
      UnlockReleaseBuffer(buffer);
      continue;
    }
    data_pages++;
    page_sorted = (opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) != 0;

    if (!xpod_rdf_perm_page_prefix_may_match(page, prefix_keys, prefix_nkeys, &last_before, &first_past))
    {
      pages_skipped++;
      if (last_before)
      {
        pages_skipped_before_lower++;
      }
      else if (first_past)
      {
        pages_skipped_past_upper++;
        if (global_sorted)
        {
          stopped_at_upper_bound = true;
          UnlockReleaseBuffer(buffer);
          break;
        }
      }
      else
      {
        pages_skipped_by_range++;
      }
      UnlockReleaseBuffer(buffer);
      continue;
    }

    pages_visited++;
    max_offset = PageGetMaxOffsetNumber(page);
    offset = FirstOffsetNumber;
    if (page_sorted && prefix_nkeys > 0)
    {
      OffsetNumber lower_bound_offset = xpod_rdf_perm_page_seek_prefix(page, prefix_keys, prefix_nkeys);

      page_local_seeks++;
      if (!OffsetNumberIsValid(lower_bound_offset))
      {
        UnlockReleaseBuffer(buffer);
        continue;
      }
      offset = lower_bound_offset;
    }

    for (; offset <= max_offset; offset = OffsetNumberNext(offset))
    {
      void *entry = xpod_rdf_perm_page_entry(page, offset);
      int prefix_compare = 0;

      if (entry == NULL)
      {
        continue;
      }
      if (prefix_nkeys > 0)
      {
        prefix_compare = xpod_rdf_perm_entry_compare_key_prefix(entry, prefix_keys, prefix_nkeys);
        if (page_sorted && prefix_compare > 0)
        {
          break;
        }
        if (prefix_compare < 0)
        {
          continue;
        }
      }
      items_examined++;
      if (prefix_compare == 0)
      {
        items_matched++;
        postings_matched += xpod_rdf_perm_entry_live_posting_count(entry);
      }
    }

    UnlockReleaseBuffer(buffer);
  }

  index_close(indexRelation, AccessShareLock);
  initStringInfo(&json);
  appendStringInfo(
    &json,
    "{\"probe\":\"prefix-equality-v1\","
    "\"layout\":\"compressed-posting-v1\","
    "\"nkeys\":%u,"
    "\"prefixKeys\":%u,"
    "\"globalSorted\":%s,"
    "\"pages\":%u,"
    "\"firstDataBlock\":%u,"
    "\"startBlock\":%u,"
    "\"dataPages\":%llu,"
    "\"seekPagesExamined\":%llu,"
    "\"pagesVisited\":%llu,"
    "\"pagesSkipped\":%llu,"
    "\"pagesSkippedBeforeLower\":%llu,"
    "\"pagesSkippedPastUpper\":%llu,"
    "\"pagesSkippedByRange\":%llu,"
    "\"stoppedAtUpperBound\":%s,"
    "\"pageLocalSeeks\":%llu,"
    "\"itemsExamined\":%llu,"
    "\"itemsMatched\":%llu,"
    "\"postingsMatched\":%llu}",
    (unsigned int) index_nkeys,
    (unsigned int) prefix_nkeys,
    global_sorted ? "true" : "false",
    (unsigned int) block_count,
    (unsigned int) first_data_block,
    (unsigned int) start_block,
    (unsigned long long) data_pages,
    (unsigned long long) seek_pages_examined,
    (unsigned long long) pages_visited,
    (unsigned long long) pages_skipped,
    (unsigned long long) pages_skipped_before_lower,
    (unsigned long long) pages_skipped_past_upper,
    (unsigned long long) pages_skipped_by_range,
    stopped_at_upper_bound ? "true" : "false",
    (unsigned long long) page_local_seeks,
    (unsigned long long) items_examined,
    (unsigned long long) items_matched,
    (unsigned long long) postings_matched
  );
  PG_RETURN_TEXT_P(cstring_to_text(json.data));
}

Datum
xpod_rdf_perm_index_scan(PG_FUNCTION_ARGS)
{
  Oid index_oid = PG_GETARG_OID(0);
  Relation indexRelation;
  uint16 index_nkeys;
  int64 prefix_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 prefix_nkeys = 0;
  ReturnSetInfo *rsinfo;

  indexRelation = index_open(index_oid, AccessShareLock);
  index_nkeys = Min(indexRelation->rd_att->natts, XPOD_RDF_PERM_MAX_KEYS);
  xpod_rdf_perm_assert_supported_nkeys(index_nkeys);
  xpod_rdf_perm_probe_prefix_args(fcinfo, index_nkeys, 1, prefix_keys, &prefix_nkeys);

  InitMaterializedSRF(fcinfo, MAT_SRF_USE_EXPECTED_DESC);
  rsinfo = (ReturnSetInfo *) fcinfo->resultinfo;
  if (rsinfo == NULL || rsinfo->setResult == NULL || rsinfo->setDesc == NULL)
  {
    index_close(indexRelation, AccessShareLock);
    ereport(ERROR, (errmsg("xpod_rdf.perm_index_scan expected a materialized set-returning context")));
  }

  xpod_rdf_perm_scan_prefix(indexRelation, prefix_keys, prefix_nkeys, rsinfo);

  index_close(indexRelation, AccessShareLock);
  PG_RETURN_NULL();
}

Datum
xpod_rdf_perm_index_scan_any(PG_FUNCTION_ARGS)
{
  Oid index_oid = PG_GETARG_OID(0);
  Relation indexRelation;
  uint16 index_nkeys;
  XpodRdfPermPrefixSet prefix_sets[XPOD_RDF_PERM_MAX_KEYS];
  uint16 prefix_nkeys = 0;
  bool empty_prefix = false;
  ReturnSetInfo *rsinfo;

  memset(prefix_sets, 0, sizeof(prefix_sets));
  indexRelation = index_open(index_oid, AccessShareLock);
  index_nkeys = Min(indexRelation->rd_att->natts, XPOD_RDF_PERM_MAX_KEYS);
  xpod_rdf_perm_assert_supported_nkeys(index_nkeys);
  xpod_rdf_perm_array_prefix_args(fcinfo, index_nkeys, 1, prefix_sets, &prefix_nkeys, &empty_prefix);

  InitMaterializedSRF(fcinfo, MAT_SRF_USE_EXPECTED_DESC);
  rsinfo = (ReturnSetInfo *) fcinfo->resultinfo;
  if (rsinfo == NULL || rsinfo->setResult == NULL || rsinfo->setDesc == NULL)
  {
    index_close(indexRelation, AccessShareLock);
    ereport(ERROR, (errmsg("xpod_rdf.perm_index_scan_any expected a materialized set-returning context")));
  }

  if (!empty_prefix)
  {
    xpod_rdf_perm_scan_prefix_sets(indexRelation, prefix_sets, prefix_nkeys, rsinfo);
  }

  index_close(indexRelation, AccessShareLock);
  PG_RETURN_NULL();
}

Datum
xpod_rdf_perm_index_count(PG_FUNCTION_ARGS)
{
  Oid heap_oid = PG_GETARG_OID(0);
  Oid index_oid = PG_GETARG_OID(1);
  Relation indexRelation;
  XpodRdfPermCountState state;
  XpodRdfInt64ArrayArg graph_ids;
  XpodRdfInt64ArrayArg subject_ids;
  XpodRdfInt64ArrayArg predicate_ids;
  XpodRdfInt64ArrayArg object_ids;
  uint16 index_nkeys;
  int64 prefix_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 prefix_nkeys = 0;
  int key_index;

  memset(&state, 0, sizeof(state));
  indexRelation = index_open(index_oid, AccessShareLock);
  index_nkeys = Min(indexRelation->rd_att->natts, XPOD_RDF_PERM_MAX_KEYS);
  xpod_rdf_perm_assert_supported_nkeys(index_nkeys);
  xpod_rdf_perm_probe_prefix_args(fcinfo, index_nkeys, 2, prefix_keys, &prefix_nkeys);

  graph_ids = xpod_rdf_int64_array_arg(fcinfo, 6, false);
  subject_ids = xpod_rdf_int64_array_arg(fcinfo, 7, false);
  predicate_ids = xpod_rdf_int64_array_arg(fcinfo, 8, false);
  object_ids = xpod_rdf_int64_array_arg(fcinfo, 9, false);
  xpod_rdf_sort_int64_arg(&graph_ids);
  xpod_rdf_sort_int64_arg(&subject_ids);
  xpod_rdf_sort_int64_arg(&predicate_ids);
  xpod_rdf_sort_int64_arg(&object_ids);
  state.graph_ids = graph_ids.values;
  state.graph_id_count = graph_ids.count;
  state.subject_ids = subject_ids.values;
  state.subject_id_count = subject_ids.count;
  state.predicate_ids = predicate_ids.values;
  state.predicate_id_count = predicate_ids.count;
  state.object_ids = object_ids.values;
  state.object_id_count = object_ids.count;

  state.heap_relation = table_open(heap_oid, AccessShareLock);
  state.heap_slot = table_slot_create(state.heap_relation, NULL);
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    state.attnums[key_index] = key_index < indexRelation->rd_att->natts
      ? indexRelation->rd_index->indkey.values[key_index]
      : InvalidAttrNumber;
  }

  xpod_rdf_perm_scan_prefix_visit(indexRelation, prefix_keys, prefix_nkeys, xpod_rdf_perm_count_visitor, &state);

  ExecDropSingleTupleTableSlot(state.heap_slot);
  table_close(state.heap_relation, AccessShareLock);
  index_close(indexRelation, AccessShareLock);
  PG_RETURN_INT64((int64) state.count);
}

Datum
xpod_rdf_perm_index_count_any(PG_FUNCTION_ARGS)
{
  Oid heap_oid = PG_GETARG_OID(0);
  Oid index_oid = PG_GETARG_OID(1);
  Relation indexRelation;
  XpodRdfPermCountState state;
  XpodRdfInt64ArrayArg graph_ids;
  XpodRdfInt64ArrayArg subject_ids;
  XpodRdfInt64ArrayArg predicate_ids;
  XpodRdfInt64ArrayArg object_ids;
  uint16 index_nkeys;
  XpodRdfPermPrefixSet prefix_sets[XPOD_RDF_PERM_MAX_KEYS];
  uint16 prefix_nkeys = 0;
  bool empty_prefix = false;
  int key_index;

  memset(prefix_sets, 0, sizeof(prefix_sets));
  memset(&state, 0, sizeof(state));
  indexRelation = index_open(index_oid, AccessShareLock);
  index_nkeys = Min(indexRelation->rd_att->natts, XPOD_RDF_PERM_MAX_KEYS);
  xpod_rdf_perm_assert_supported_nkeys(index_nkeys);
  xpod_rdf_perm_array_prefix_args(fcinfo, index_nkeys, 2, prefix_sets, &prefix_nkeys, &empty_prefix);

  graph_ids = xpod_rdf_int64_array_arg(fcinfo, 6, false);
  subject_ids = xpod_rdf_int64_array_arg(fcinfo, 7, false);
  predicate_ids = xpod_rdf_int64_array_arg(fcinfo, 8, false);
  object_ids = xpod_rdf_int64_array_arg(fcinfo, 9, false);
  xpod_rdf_sort_int64_arg(&graph_ids);
  xpod_rdf_sort_int64_arg(&subject_ids);
  xpod_rdf_sort_int64_arg(&predicate_ids);
  xpod_rdf_sort_int64_arg(&object_ids);
  state.graph_ids = graph_ids.values;
  state.graph_id_count = graph_ids.count;
  state.subject_ids = subject_ids.values;
  state.subject_id_count = subject_ids.count;
  state.predicate_ids = predicate_ids.values;
  state.predicate_id_count = predicate_ids.count;
  state.object_ids = object_ids.values;
  state.object_id_count = object_ids.count;

  state.heap_relation = table_open(heap_oid, AccessShareLock);
  state.heap_slot = table_slot_create(state.heap_relation, NULL);
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    state.attnums[key_index] = key_index < indexRelation->rd_att->natts
      ? indexRelation->rd_index->indkey.values[key_index]
      : InvalidAttrNumber;
  }

  if (!empty_prefix)
  {
    xpod_rdf_perm_scan_prefix_sets_visit(
      indexRelation,
      prefix_sets,
      prefix_nkeys,
      xpod_rdf_perm_count_visitor,
      &state
    );
  }

  ExecDropSingleTupleTableSlot(state.heap_slot);
  table_close(state.heap_relation, AccessShareLock);
  index_close(indexRelation, AccessShareLock);
  PG_RETURN_INT64((int64) state.count);
}

Datum
xpod_rdf_subject_star_join(PG_FUNCTION_ARGS)
{
  Oid heap_oid = PG_GETARG_OID(0);
  Oid seed_index_oid = PG_GETARG_OID(1);
  int16 seed_subject_key = PG_GETARG_INT16(2);
  Oid probe_index_oid = PG_GETARG_OID(7);
  int64 seed_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 seed_prefix_nkeys = 0;
  XpodRdfInt64ArrayArg predicate_ids;
  XpodRdfInt64ArrayArg object_ids;
  XpodRdfInt64ArrayArg graph_ids;
  Relation seed_index_relation;
  XpodRdfSubjectStarJoinState state;
  int key_index;
  ReturnSetInfo *rsinfo;

  if (seed_subject_key < 1 || seed_subject_key > XPOD_RDF_PERM_MAX_KEYS)
  {
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_join seed subject key must be between 1 and 4")));
  }

  memset(seed_keys, 0, sizeof(seed_keys));
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    int arg_index = 3 + key_index;

    if (PG_ARGISNULL(arg_index))
    {
      break;
    }
    seed_keys[key_index] = PG_GETARG_INT64(arg_index);
    seed_prefix_nkeys++;
  }
  if (seed_prefix_nkeys == 0)
  {
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_join requires a non-empty seed prefix")));
  }

  predicate_ids = xpod_rdf_int64_array_arg(fcinfo, 8, false);
  object_ids = xpod_rdf_int64_array_arg(fcinfo, 9, true);
  graph_ids = xpod_rdf_int64_array_arg(fcinfo, 10, false);
  if (predicate_ids.count > XPOD_RDF_STAR_JOIN_MAX_PROBES)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.subject_star_join supports at most %d probe patterns", XPOD_RDF_STAR_JOIN_MAX_PROBES)));
  }
  if (object_ids.count != predicate_ids.count)
  {
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_join predicate and object arrays must have the same length")));
  }

  memset(&state, 0, sizeof(state));
  state.heap_relation = table_open(heap_oid, AccessShareLock);
  seed_index_relation = index_open(seed_index_oid, AccessShareLock);
  state.probe_index_relation = index_open(probe_index_oid, AccessShareLock);
  xpod_rdf_perm_assert_supported_nkeys(seed_index_relation->rd_att->natts);
  xpod_rdf_perm_assert_supported_nkeys(state.probe_index_relation->rd_att->natts);
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    state.seed_attnums[key_index] = key_index < seed_index_relation->rd_att->natts
      ? seed_index_relation->rd_index->indkey.values[key_index]
      : InvalidAttrNumber;
    state.probe_attnums[key_index] = key_index < state.probe_index_relation->rd_att->natts
      ? state.probe_index_relation->rd_index->indkey.values[key_index]
      : InvalidAttrNumber;
  }
  state.heap_slot = table_slot_create(state.heap_relation, NULL);
  state.seed_subject_key = seed_subject_key;
  state.graph_ids = graph_ids.values;
  state.graph_id_count = graph_ids.count;
  state.probe_count = predicate_ids.count;

  for (key_index = 0; key_index < predicate_ids.count; key_index++)
  {
    state.probes[key_index].predicate_id = predicate_ids.values[key_index];
    state.probes[key_index].has_object_id = !object_ids.nulls[key_index];
    state.probes[key_index].object_id = object_ids.nulls[key_index] ? 0 : object_ids.values[key_index];
  }

  InitMaterializedSRF(fcinfo, MAT_SRF_USE_EXPECTED_DESC);
  rsinfo = (ReturnSetInfo *) fcinfo->resultinfo;
  if (rsinfo == NULL || rsinfo->setResult == NULL || rsinfo->setDesc == NULL)
  {
    ExecDropSingleTupleTableSlot(state.heap_slot);
    index_close(state.probe_index_relation, AccessShareLock);
    index_close(seed_index_relation, AccessShareLock);
    table_close(state.heap_relation, AccessShareLock);
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_join expected a materialized set-returning context")));
  }
  state.rsinfo = rsinfo;

  if (state.graph_id_count > 1)
  {
    qsort(state.graph_ids, state.graph_id_count, sizeof(int64), xpod_rdf_perm_int64_compare);
  }
  xpod_rdf_perm_scan_prefix_visit(seed_index_relation, seed_keys, seed_prefix_nkeys, xpod_rdf_subject_star_seed_visitor, &state);

  ExecDropSingleTupleTableSlot(state.heap_slot);
  index_close(state.probe_index_relation, AccessShareLock);
  index_close(seed_index_relation, AccessShareLock);
  table_close(state.heap_relation, AccessShareLock);
  PG_RETURN_NULL();
}

Datum
xpod_rdf_subject_star_count(PG_FUNCTION_ARGS)
{
  Oid heap_oid = PG_GETARG_OID(0);
  Oid seed_index_oid = PG_GETARG_OID(1);
  int16 seed_subject_key = PG_GETARG_INT16(2);
  Oid probe_index_oid = PG_GETARG_OID(7);
  int64 seed_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 seed_prefix_nkeys = 0;
  XpodRdfInt64ArrayArg predicate_ids;
  XpodRdfInt64ArrayArg object_ids;
  XpodRdfInt64ArrayArg graph_ids;
  XpodRdfInt64ArrayArg aggregate_variables;
  XpodRdfInt64ArrayArg aggregate_distinct;
  Relation seed_index_relation;
  XpodRdfSubjectStarJoinState state;
  int key_index;
  ReturnSetInfo *rsinfo;

  if (seed_subject_key < 1 || seed_subject_key > XPOD_RDF_PERM_MAX_KEYS)
  {
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_count seed subject key must be between 1 and 4")));
  }

  memset(seed_keys, 0, sizeof(seed_keys));
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    int arg_index = 3 + key_index;

    if (PG_ARGISNULL(arg_index))
    {
      break;
    }
    seed_keys[key_index] = PG_GETARG_INT64(arg_index);
    seed_prefix_nkeys++;
  }
  if (seed_prefix_nkeys == 0)
  {
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_count requires a non-empty seed prefix")));
  }

  predicate_ids = xpod_rdf_int64_array_arg(fcinfo, 8, false);
  object_ids = xpod_rdf_int64_array_arg(fcinfo, 9, true);
  graph_ids = xpod_rdf_int64_array_arg(fcinfo, 10, false);
  aggregate_variables = xpod_rdf_int64_array_arg(fcinfo, 11, false);
  aggregate_distinct = xpod_rdf_int64_array_arg(fcinfo, 12, false);
  if (predicate_ids.count > XPOD_RDF_STAR_JOIN_MAX_PROBES)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.subject_star_count supports at most %d probe patterns", XPOD_RDF_STAR_JOIN_MAX_PROBES)));
  }
  if (object_ids.count != predicate_ids.count)
  {
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_count predicate and object arrays must have the same length")));
  }
  if (aggregate_variables.count == 0 || aggregate_variables.count > XPOD_RDF_STAR_COUNT_MAX_AGGREGATES)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.subject_star_count supports between 1 and %d count aggregates", XPOD_RDF_STAR_COUNT_MAX_AGGREGATES)));
  }
  if (aggregate_distinct.count != aggregate_variables.count)
  {
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_count aggregate variable and distinct arrays must have the same length")));
  }

  memset(&state, 0, sizeof(state));
  state.count_summary = true;
  state.aggregate_count = aggregate_variables.count;
  for (key_index = 0; key_index < aggregate_variables.count; key_index++)
  {
    int64 variable_index = aggregate_variables.values[key_index];
    int64 distinct_flag = aggregate_distinct.values[key_index];

    if (variable_index < -1 || variable_index > predicate_ids.count)
    {
      ereport(ERROR, (errmsg("xpod_rdf.subject_star_count aggregate variable index is outside the joined row")));
    }
    if (variable_index < 0 && distinct_flag != 0)
    {
      ereport(ERROR, (errmsg("xpod_rdf.subject_star_count cannot DISTINCT count an unbound wildcard")));
    }
    if (distinct_flag != 0 && distinct_flag != 1)
    {
      ereport(ERROR, (errmsg("xpod_rdf.subject_star_count distinct flags must be 0 or 1")));
    }
    state.aggregate_variables[key_index] = (int) variable_index;
    state.aggregate_distinct[key_index] = distinct_flag != 0;
  }

  state.heap_relation = table_open(heap_oid, AccessShareLock);
  seed_index_relation = index_open(seed_index_oid, AccessShareLock);
  state.probe_index_relation = index_open(probe_index_oid, AccessShareLock);
  xpod_rdf_perm_assert_supported_nkeys(seed_index_relation->rd_att->natts);
  xpod_rdf_perm_assert_supported_nkeys(state.probe_index_relation->rd_att->natts);
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    state.seed_attnums[key_index] = key_index < seed_index_relation->rd_att->natts
      ? seed_index_relation->rd_index->indkey.values[key_index]
      : InvalidAttrNumber;
    state.probe_attnums[key_index] = key_index < state.probe_index_relation->rd_att->natts
      ? state.probe_index_relation->rd_index->indkey.values[key_index]
      : InvalidAttrNumber;
  }
  state.heap_slot = table_slot_create(state.heap_relation, NULL);
  state.seed_subject_key = seed_subject_key;
  state.graph_ids = graph_ids.values;
  state.graph_id_count = graph_ids.count;
  state.probe_count = predicate_ids.count;

  for (key_index = 0; key_index < predicate_ids.count; key_index++)
  {
    state.probes[key_index].predicate_id = predicate_ids.values[key_index];
    state.probes[key_index].has_object_id = !object_ids.nulls[key_index];
    state.probes[key_index].object_id = object_ids.nulls[key_index] ? 0 : object_ids.values[key_index];
  }

  InitMaterializedSRF(fcinfo, MAT_SRF_USE_EXPECTED_DESC);
  rsinfo = (ReturnSetInfo *) fcinfo->resultinfo;
  if (rsinfo == NULL || rsinfo->setResult == NULL || rsinfo->setDesc == NULL)
  {
    ExecDropSingleTupleTableSlot(state.heap_slot);
    index_close(state.probe_index_relation, AccessShareLock);
    index_close(seed_index_relation, AccessShareLock);
    table_close(state.heap_relation, AccessShareLock);
    ereport(ERROR, (errmsg("xpod_rdf.subject_star_count expected a materialized set-returning context")));
  }
  state.rsinfo = rsinfo;

  if (state.graph_id_count > 1)
  {
    qsort(state.graph_ids, state.graph_id_count, sizeof(int64), xpod_rdf_perm_int64_compare);
  }
  xpod_rdf_perm_scan_prefix_visit(seed_index_relation, seed_keys, seed_prefix_nkeys, xpod_rdf_subject_star_seed_visitor, &state);
  xpod_rdf_subject_star_count_summary_put_row(&state);

  ExecDropSingleTupleTableSlot(state.heap_slot);
  index_close(state.probe_index_relation, AccessShareLock);
  index_close(seed_index_relation, AccessShareLock);
  table_close(state.heap_relation, AccessShareLock);
  PG_RETURN_NULL();
}

Datum
xpod_rdf_bgp_join(PG_FUNCTION_ARGS)
{
  Oid heap_oid = PG_GETARG_OID(0);
  XpodRdfOidArrayArg index_oids = xpod_rdf_oid_array_arg(fcinfo, 1, false);
  XpodRdfInt64ArrayArg constants = xpod_rdf_int64_array_arg(fcinfo, 2, true);
  XpodRdfInt16ArrayArg variable_slots = xpod_rdf_int16_array_arg(fcinfo, 3, false);
  XpodRdfInt16ArrayArg output_slots = xpod_rdf_int16_array_arg(fcinfo, 4, false);
  XpodRdfBgpJoinState state;
  int pattern_index;
  int key_index;
  ReturnSetInfo *rsinfo;

  if (index_oids.count < 1 || index_oids.count > XPOD_RDF_BGP_MAX_PATTERNS)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.bgp_join supports between 1 and %d patterns", XPOD_RDF_BGP_MAX_PATTERNS)));
  }
  if (constants.count != index_oids.count * XPOD_RDF_PERM_MAX_KEYS
      || variable_slots.count != index_oids.count * XPOD_RDF_PERM_MAX_KEYS)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.bgp_join constant and variable slot arrays must contain pattern_count * 4 entries")));
  }
  if (output_slots.count > XPOD_RDF_BGP_MAX_OUTPUTS)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.bgp_join supports at most %d output variables", XPOD_RDF_BGP_MAX_OUTPUTS)));
  }

  memset(&state, 0, sizeof(state));
  state.pattern_count = index_oids.count;
  state.output_count = output_slots.count;
  for (key_index = 0; key_index < output_slots.count; key_index++)
  {
    int16 slot = output_slots.values[key_index];

    if (slot < 1 || slot > XPOD_RDF_BGP_MAX_VARIABLES)
    {
      ereport(ERROR,
              (errmsg("xpod_rdf.bgp_join output slots must be between 1 and %d", XPOD_RDF_BGP_MAX_VARIABLES)));
    }
    state.output_slots[key_index] = slot;
  }

  state.heap_relation = table_open(heap_oid, AccessShareLock);
  state.heap_slot = table_slot_create(state.heap_relation, NULL);
  for (pattern_index = 0; pattern_index < index_oids.count; pattern_index++)
  {
    XpodRdfBgpPattern *pattern = &state.patterns[pattern_index];

    pattern->index_relation = index_open(index_oids.values[pattern_index], AccessShareLock);
    xpod_rdf_perm_assert_supported_nkeys(pattern->index_relation->rd_att->natts);
    for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
    {
      int flat_index = (pattern_index * XPOD_RDF_PERM_MAX_KEYS) + key_index;
      int16 slot = variable_slots.values[flat_index];

      pattern->attnums[key_index] = key_index < pattern->index_relation->rd_att->natts
        ? pattern->index_relation->rd_index->indkey.values[key_index]
        : InvalidAttrNumber;
      pattern->has_constant[key_index] = !constants.nulls[flat_index];
      pattern->constants[key_index] = constants.nulls[flat_index] ? 0 : constants.values[flat_index];
      if (slot < 0 || slot > XPOD_RDF_BGP_MAX_VARIABLES)
      {
        ereport(ERROR,
                (errmsg("xpod_rdf.bgp_join variable slots must be between 0 and %d", XPOD_RDF_BGP_MAX_VARIABLES)));
      }
      pattern->variable_slots[key_index] = slot;
    }
  }

  InitMaterializedSRF(fcinfo, MAT_SRF_USE_EXPECTED_DESC);
  rsinfo = (ReturnSetInfo *) fcinfo->resultinfo;
  if (rsinfo == NULL || rsinfo->setResult == NULL || rsinfo->setDesc == NULL)
  {
    for (pattern_index = 0; pattern_index < state.pattern_count; pattern_index++)
    {
      index_close(state.patterns[pattern_index].index_relation, AccessShareLock);
    }
    ExecDropSingleTupleTableSlot(state.heap_slot);
    table_close(state.heap_relation, AccessShareLock);
    ereport(ERROR, (errmsg("xpod_rdf.bgp_join expected a materialized set-returning context")));
  }
  state.rsinfo = rsinfo;

  xpod_rdf_bgp_join_run(&state);

  for (pattern_index = 0; pattern_index < state.pattern_count; pattern_index++)
  {
    index_close(state.patterns[pattern_index].index_relation, AccessShareLock);
  }
  ExecDropSingleTupleTableSlot(state.heap_slot);
  table_close(state.heap_relation, AccessShareLock);
  PG_RETURN_NULL();
}

Datum
xpod_rdf_values_join(PG_FUNCTION_ARGS)
{
  Oid heap_oid = PG_GETARG_OID(0);
  XpodRdfOidArrayArg index_oids = xpod_rdf_oid_array_arg(fcinfo, 1, false);
  XpodRdfInt64ArrayArg constants = xpod_rdf_int64_array_arg(fcinfo, 2, true);
  XpodRdfInt16ArrayArg variable_slots = xpod_rdf_int16_array_arg(fcinfo, 3, false);
  XpodRdfInt16ArrayArg output_slots = xpod_rdf_int16_array_arg(fcinfo, 4, false);
  XpodRdfInt16ArrayArg value_slots = xpod_rdf_int16_array_arg(fcinfo, 5, false);
  XpodRdfInt64ArrayArg value_rows = xpod_rdf_int64_array_arg(fcinfo, 6, false);
  XpodRdfBgpJoinState state;
  int pattern_index;
  int key_index;
  ReturnSetInfo *rsinfo;

  if (index_oids.count < 1 || index_oids.count > XPOD_RDF_BGP_MAX_PATTERNS)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.values_join supports between 1 and %d patterns", XPOD_RDF_BGP_MAX_PATTERNS)));
  }
  if (constants.count != index_oids.count * XPOD_RDF_PERM_MAX_KEYS
      || variable_slots.count != index_oids.count * XPOD_RDF_PERM_MAX_KEYS)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.values_join constant and variable slot arrays must contain pattern_count * 4 entries")));
  }
  if (output_slots.count > XPOD_RDF_BGP_MAX_OUTPUTS)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.values_join supports at most %d output variables", XPOD_RDF_BGP_MAX_OUTPUTS)));
  }
  if (value_slots.count < 1 || value_slots.count > XPOD_RDF_BGP_MAX_OUTPUTS)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.values_join supports between 1 and %d VALUES variables", XPOD_RDF_BGP_MAX_OUTPUTS)));
  }
  if (value_rows.count % value_slots.count != 0)
  {
    ereport(ERROR,
            (errmsg("xpod_rdf.values_join values row array must be a multiple of the VALUES variable count")));
  }

  memset(&state, 0, sizeof(state));
  state.pattern_count = index_oids.count;
  state.output_count = output_slots.count;
  state.value_width = value_slots.count;
  state.value_row_count = value_rows.count / value_slots.count;
  state.value_rows = value_rows.values;
  for (key_index = 0; key_index < output_slots.count; key_index++)
  {
    int16 slot = output_slots.values[key_index];

    if (slot < 1 || slot > XPOD_RDF_BGP_MAX_VARIABLES)
    {
      ereport(ERROR,
              (errmsg("xpod_rdf.values_join output slots must be between 1 and %d", XPOD_RDF_BGP_MAX_VARIABLES)));
    }
    state.output_slots[key_index] = slot;
  }
  for (key_index = 0; key_index < value_slots.count; key_index++)
  {
    int16 slot = value_slots.values[key_index];
    int previous_index;

    if (slot < 1 || slot > XPOD_RDF_BGP_MAX_VARIABLES)
    {
      ereport(ERROR,
              (errmsg("xpod_rdf.values_join VALUES slots must be between 1 and %d", XPOD_RDF_BGP_MAX_VARIABLES)));
    }
    for (previous_index = 0; previous_index < key_index; previous_index++)
    {
      if (state.value_slots[previous_index] == slot)
      {
        ereport(ERROR, (errmsg("xpod_rdf.values_join VALUES slots must be unique")));
      }
    }
    state.value_slots[key_index] = slot;
  }

  state.heap_relation = table_open(heap_oid, AccessShareLock);
  state.heap_slot = table_slot_create(state.heap_relation, NULL);
  for (pattern_index = 0; pattern_index < index_oids.count; pattern_index++)
  {
    XpodRdfBgpPattern *pattern = &state.patterns[pattern_index];

    pattern->index_relation = index_open(index_oids.values[pattern_index], AccessShareLock);
    xpod_rdf_perm_assert_supported_nkeys(pattern->index_relation->rd_att->natts);
    for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
    {
      int flat_index = (pattern_index * XPOD_RDF_PERM_MAX_KEYS) + key_index;
      int16 slot = variable_slots.values[flat_index];

      pattern->attnums[key_index] = key_index < pattern->index_relation->rd_att->natts
        ? pattern->index_relation->rd_index->indkey.values[key_index]
        : InvalidAttrNumber;
      pattern->has_constant[key_index] = !constants.nulls[flat_index];
      pattern->constants[key_index] = constants.nulls[flat_index] ? 0 : constants.values[flat_index];
      if (slot < 0 || slot > XPOD_RDF_BGP_MAX_VARIABLES)
      {
        ereport(ERROR,
                (errmsg("xpod_rdf.values_join variable slots must be between 0 and %d", XPOD_RDF_BGP_MAX_VARIABLES)));
      }
      pattern->variable_slots[key_index] = slot;
    }
  }

  InitMaterializedSRF(fcinfo, MAT_SRF_USE_EXPECTED_DESC);
  rsinfo = (ReturnSetInfo *) fcinfo->resultinfo;
  if (rsinfo == NULL || rsinfo->setResult == NULL || rsinfo->setDesc == NULL)
  {
    for (pattern_index = 0; pattern_index < state.pattern_count; pattern_index++)
    {
      index_close(state.patterns[pattern_index].index_relation, AccessShareLock);
    }
    ExecDropSingleTupleTableSlot(state.heap_slot);
    table_close(state.heap_relation, AccessShareLock);
    ereport(ERROR, (errmsg("xpod_rdf.values_join expected a materialized set-returning context")));
  }
  state.rsinfo = rsinfo;

  xpod_rdf_bgp_join_run(&state);

  for (pattern_index = 0; pattern_index < state.pattern_count; pattern_index++)
  {
    index_close(state.patterns[pattern_index].index_relation, AccessShareLock);
  }
  ExecDropSingleTupleTableSlot(state.heap_slot);
  table_close(state.heap_relation, AccessShareLock);
  PG_RETURN_NULL();
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

static BlockNumber
xpod_rdf_perm_seek_lower_block_for_prefix(Relation indexRelation,
                                          BlockNumber first_block,
                                          BlockNumber block_count,
                                          int64 *keys,
                                          uint16 prefix_nkeys,
                                          uint64 *seek_pages_examined)
{
  BlockNumber low;
  BlockNumber high;

  if (first_block >= block_count || prefix_nkeys == 0)
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
    void *last_entry;
    bool before_lower = false;

    buffer = ReadBuffer(indexRelation, mid);
    LockBuffer(buffer, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buffer);
    if (seek_pages_examined != NULL)
    {
      (*seek_pages_examined)++;
    }
    last_entry = xpod_rdf_perm_page_entry(page, PageGetMaxOffsetNumber(page));
    before_lower = last_entry != NULL && xpod_rdf_perm_entry_compare_key_prefix(last_entry, keys, prefix_nkeys) < 0;
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

static OffsetNumber
xpod_rdf_perm_page_seek_prefix(Page page, int64 *keys, uint16 prefix_nkeys)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  OffsetNumber max_offset;
  int low;
  int high;

  if (
    opaque == NULL
    || (opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) == 0
    || prefix_nkeys == 0
  )
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

    if (entry == NULL || xpod_rdf_perm_entry_compare_key_prefix(entry, keys, prefix_nkeys) < 0)
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
xpod_rdf_perm_page_prefix_may_match(Page page,
                                    int64 *keys,
                                    uint16 prefix_nkeys,
                                    bool *last_before,
                                    bool *first_past)
{
  XpodRdfPermPageOpaque *opaque = xpod_rdf_perm_page_opaque(page);
  uint16 key_index;

  *last_before = false;
  *first_past = false;
  if (opaque == NULL || opaque->tuple_count == 0)
  {
    return false;
  }
  if (prefix_nkeys == 0)
  {
    return true;
  }

  if ((opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) != 0)
  {
    void *first_entry = xpod_rdf_perm_page_entry(page, FirstOffsetNumber);
    void *last_entry = xpod_rdf_perm_page_entry(page, PageGetMaxOffsetNumber(page));

    if (last_entry != NULL && xpod_rdf_perm_entry_compare_key_prefix(last_entry, keys, prefix_nkeys) < 0)
    {
      *last_before = true;
      return false;
    }
    if (first_entry != NULL && xpod_rdf_perm_entry_compare_key_prefix(first_entry, keys, prefix_nkeys) > 0)
    {
      *first_past = true;
      return false;
    }
  }

  for (key_index = 0; key_index < prefix_nkeys && key_index < opaque->nkeys; key_index++)
  {
    if (opaque->max_keys[key_index] < keys[key_index] || opaque->min_keys[key_index] > keys[key_index])
    {
      return false;
    }
  }
  return true;
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
xpod_rdf_perm_probe_prefix_args(FunctionCallInfo fcinfo,
                                uint16 index_nkeys,
                                int start_arg_index,
                                int64 *keys,
                                uint16 *prefix_nkeys)
{
  int key_index;
  bool saw_null = false;

  *prefix_nkeys = 0;
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    int arg_index = start_arg_index + key_index;
    int key_position = key_index + 1;

    if (arg_index >= PG_NARGS() || PG_ARGISNULL(arg_index))
    {
      saw_null = true;
      continue;
    }
    if (key_position > index_nkeys)
    {
      ereport(ERROR,
              (errmsg("xpod_rdf_perm probe key exceeds index key count"),
               errdetail("Argument %d was provided for an index with %u key columns.", key_position, index_nkeys)));
    }
    if (saw_null)
    {
      ereport(ERROR,
              (errmsg("xpod_rdf_perm probe keys must be a contiguous leading prefix"),
               errdetail("Argument %d was provided after a null leading key.", key_position)));
    }
    keys[*prefix_nkeys] = PG_GETARG_INT64(arg_index);
    (*prefix_nkeys)++;
  }
}

static void
xpod_rdf_perm_array_prefix_args(FunctionCallInfo fcinfo,
                                uint16 index_nkeys,
                                int start_arg_index,
                                XpodRdfPermPrefixSet *prefix_sets,
                                uint16 *prefix_nkeys,
                                bool *empty_prefix)
{
  int key_index;
  bool saw_null = false;

  *prefix_nkeys = 0;
  *empty_prefix = false;
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    int arg_index = start_arg_index + key_index;
    int key_position = key_index + 1;
    ArrayType *array;
    Datum *datums;
    bool *nulls;
    int item_count;
    int item_index;
    int unique_count = 0;
    int16 typlen;
    bool typbyval;
    char typalign;
    XpodRdfPermPrefixSet *set;

    if (arg_index >= PG_NARGS() || PG_ARGISNULL(arg_index))
    {
      saw_null = true;
      continue;
    }
    if (key_position > index_nkeys)
    {
      ereport(ERROR,
              (errmsg("xpod_rdf_perm scan_any key exceeds index key count"),
               errdetail("Argument %d was provided for an index with %u key columns.", key_position, index_nkeys)));
    }
    if (saw_null)
    {
      ereport(ERROR,
              (errmsg("xpod_rdf_perm scan_any keys must be a contiguous leading prefix"),
               errdetail("Argument %d was provided after a null leading key.", key_position)));
    }

    array = PG_GETARG_ARRAYTYPE_P(arg_index);
    item_count = ArrayGetNItems(ARR_NDIM(array), ARR_DIMS(array));
    set = &prefix_sets[*prefix_nkeys];
    if (item_count == 0)
    {
      set->values = NULL;
      set->value_count = 0;
      *empty_prefix = true;
      (*prefix_nkeys)++;
      PG_FREE_IF_COPY(array, arg_index);
      continue;
    }

    get_typlenbyvalalign(INT8OID, &typlen, &typbyval, &typalign);
    deconstruct_array(array, INT8OID, typlen, typbyval, typalign, &datums, &nulls, &item_count);
    set->values = palloc(sizeof(int64) * item_count);
    for (item_index = 0; item_index < item_count; item_index++)
    {
      if (nulls[item_index])
      {
        ereport(ERROR, (errmsg("xpod_rdf_perm scan_any arrays cannot contain null values")));
      }
      set->values[item_index] = DatumGetInt64(datums[item_index]);
    }
    qsort(set->values, item_count, sizeof(int64), xpod_rdf_perm_int64_compare);
    for (item_index = 0; item_index < item_count; item_index++)
    {
      if (unique_count == 0 || set->values[item_index] != set->values[unique_count - 1])
      {
        set->values[unique_count++] = set->values[item_index];
      }
    }
    set->value_count = unique_count;
    if (unique_count == 0)
    {
      *empty_prefix = true;
    }
    (*prefix_nkeys)++;
    pfree(datums);
    pfree(nulls);
    PG_FREE_IF_COPY(array, arg_index);
  }
}

static void
xpod_rdf_perm_scan_prefix(Relation indexRelation,
                          int64 *prefix_keys,
                          uint16 prefix_nkeys,
                          ReturnSetInfo *rsinfo)
{
  xpod_rdf_perm_scan_prefix_visit(indexRelation, prefix_keys, prefix_nkeys, xpod_rdf_perm_scan_tuplestore_visitor, rsinfo);
}

static void
xpod_rdf_perm_scan_prefix_visit(Relation indexRelation,
                                int64 *prefix_keys,
                                uint16 prefix_nkeys,
                                XpodRdfPermScanVisitor visitor,
                                void *visitor_state)
{
  BlockNumber block_count;
  BlockNumber first_data_block;
  BlockNumber start_block;
  BlockNumber block;
  bool global_sorted;
  uint64 seek_pages_examined = 0;

  block_count = RelationGetNumberOfBlocks(indexRelation);
  first_data_block = xpod_rdf_perm_first_data_block(indexRelation);
  global_sorted = xpod_rdf_perm_relation_is_globally_sorted(indexRelation);
  start_block = first_data_block;
  if (global_sorted && prefix_nkeys > 0)
  {
    start_block = xpod_rdf_perm_seek_lower_block_for_prefix(
      indexRelation,
      first_data_block,
      block_count,
      prefix_keys,
      prefix_nkeys,
      &seek_pages_examined
    );
  }
  (void) seek_pages_examined;

  for (block = start_block; block < block_count; block++)
  {
    Buffer buffer;
    Page page;
    XpodRdfPermPageOpaque *opaque;
    bool last_before = false;
    bool first_past = false;
    bool page_sorted;
    OffsetNumber max_offset;
    OffsetNumber offset;

    buffer = ReadBuffer(indexRelation, block);
    LockBuffer(buffer, BUFFER_LOCK_SHARE);
    page = BufferGetPage(buffer);
    opaque = xpod_rdf_perm_page_opaque(page);
    if (opaque == NULL)
    {
      UnlockReleaseBuffer(buffer);
      continue;
    }
    page_sorted = (opaque->flags & XPOD_RDF_PERM_PAGE_FLAG_SORTED) != 0;

    if (!xpod_rdf_perm_page_prefix_may_match(page, prefix_keys, prefix_nkeys, &last_before, &first_past))
    {
      if (first_past && global_sorted)
      {
        UnlockReleaseBuffer(buffer);
        break;
      }
      UnlockReleaseBuffer(buffer);
      continue;
    }

    max_offset = PageGetMaxOffsetNumber(page);
    offset = FirstOffsetNumber;
    if (page_sorted && prefix_nkeys > 0)
    {
      OffsetNumber lower_bound_offset = xpod_rdf_perm_page_seek_prefix(page, prefix_keys, prefix_nkeys);

      if (!OffsetNumberIsValid(lower_bound_offset))
      {
        UnlockReleaseBuffer(buffer);
        continue;
      }
      offset = lower_bound_offset;
    }

    for (; offset <= max_offset; offset = OffsetNumberNext(offset))
    {
      void *entry = xpod_rdf_perm_page_entry(page, offset);
      int prefix_compare = 0;
      int64 *entry_keys;
      uint16 entry_nkeys;
      ItemPointerData heap_tid;
      uint32 posting_index = 0;
      uint32 next_posting = 0;

      if (entry == NULL)
      {
        continue;
      }
      if (prefix_nkeys > 0)
      {
        prefix_compare = xpod_rdf_perm_entry_compare_key_prefix(entry, prefix_keys, prefix_nkeys);
        if (page_sorted && prefix_compare > 0)
        {
          break;
        }
        if (prefix_compare < 0)
        {
          continue;
        }
      }

      entry_keys = xpod_rdf_perm_entry_keys(entry);
      entry_nkeys = xpod_rdf_perm_entry_nkeys(entry);
      while (xpod_rdf_perm_entry_next_tid(entry, posting_index, &heap_tid, &next_posting))
      {
        if (!visitor(&heap_tid, entry_keys, entry_nkeys, visitor_state))
        {
          UnlockReleaseBuffer(buffer);
          return;
        }
        if (next_posting == 0)
        {
          break;
        }
        posting_index = next_posting;
      }
    }

    UnlockReleaseBuffer(buffer);
  }
}

static bool
xpod_rdf_perm_scan_tuplestore_visitor(ItemPointerData *heap_tid, int64 *keys, uint16 nkeys, void *state)
{
  xpod_rdf_perm_scan_put_row((ReturnSetInfo *) state, heap_tid, keys, nkeys);
  return true;
}

static bool
xpod_rdf_subject_star_seed_visitor(ItemPointerData *heap_tid, int64 *keys, uint16 nkeys, void *state_arg)
{
  XpodRdfSubjectStarJoinState *state = (XpodRdfSubjectStarJoinState *) state_arg;
  int64 graph_id;
  int64 subject_id;
  int64 predicate_id;
  int64 object_id;
  XpodRdfStarJoinProbeMatches matches[XPOD_RDF_STAR_JOIN_MAX_PROBES];
  int64 selected_objects[XPOD_RDF_STAR_JOIN_MAX_PROBES];
  int probe_index;

  memset(matches, 0, sizeof(matches));
  memset(selected_objects, 0, sizeof(selected_objects));
  if (!xpod_rdf_perm_keys_quad_value(keys, nkeys, state->seed_attnums, XPOD_RDF_QUAD_GRAPH_ATTNUM, &graph_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, state->seed_attnums, XPOD_RDF_QUAD_SUBJECT_ATTNUM, &subject_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, state->seed_attnums, XPOD_RDF_QUAD_PREDICATE_ATTNUM, &predicate_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, state->seed_attnums, XPOD_RDF_QUAD_OBJECT_ATTNUM, &object_id))
  {
    return true;
  }
  if (
    state->graph_id_count > 0
    && !xpod_rdf_int64_array_contains_sorted(state->graph_ids, state->graph_id_count, graph_id)
  )
  {
    return true;
  }
  if (!xpod_rdf_heap_quad_visible_matches(state->heap_relation, state->heap_slot, heap_tid, graph_id, subject_id, predicate_id, object_id))
  {
    return true;
  }

  for (probe_index = 0; probe_index < state->probe_count; probe_index++)
  {
    XpodRdfSubjectStarProbeState probe_state;
    int64 prefix_keys[XPOD_RDF_PERM_MAX_KEYS];
    uint16 prefix_nkeys;

    memset(&probe_state, 0, sizeof(probe_state));
    probe_state.join_state = state;
    probe_state.probe = &state->probes[probe_index];
    probe_state.subject_id = subject_id;
    probe_state.matches = &matches[probe_index];

    memset(prefix_keys, 0, sizeof(prefix_keys));
    prefix_keys[0] = state->probes[probe_index].predicate_id;
    prefix_keys[1] = subject_id;
    prefix_nkeys = 2;
    if (state->probes[probe_index].has_object_id)
    {
      prefix_keys[2] = state->probes[probe_index].object_id;
      prefix_nkeys = 3;
    }
    xpod_rdf_perm_scan_prefix_visit(
      state->probe_index_relation,
      prefix_keys,
      prefix_nkeys,
      xpod_rdf_subject_star_probe_visitor,
      &probe_state
    );
    if (matches[probe_index].count == 0)
    {
      for (probe_index = 0; probe_index < state->probe_count; probe_index++)
      {
        if (matches[probe_index].object_ids != NULL)
        {
          pfree(matches[probe_index].object_ids);
        }
      }
      return true;
    }
  }

  if (state->count_summary)
  {
    xpod_rdf_subject_star_count_summary_add(state, subject_id, matches);
  }
  else
  {
    xpod_rdf_subject_star_join_put_rows(state, subject_id, matches, 0, selected_objects);
  }
  for (probe_index = 0; probe_index < state->probe_count; probe_index++)
  {
    if (matches[probe_index].object_ids != NULL)
    {
      pfree(matches[probe_index].object_ids);
    }
  }
  return true;
}

static bool
xpod_rdf_subject_star_probe_visitor(ItemPointerData *heap_tid, int64 *keys, uint16 nkeys, void *state_arg)
{
  XpodRdfSubjectStarProbeState *state = (XpodRdfSubjectStarProbeState *) state_arg;
  XpodRdfSubjectStarJoinState *join_state = state->join_state;
  int64 graph_id;
  int64 subject_id;
  int64 predicate_id;
  int64 object_id;

  if (!xpod_rdf_perm_keys_quad_value(keys, nkeys, join_state->probe_attnums, XPOD_RDF_QUAD_GRAPH_ATTNUM, &graph_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, join_state->probe_attnums, XPOD_RDF_QUAD_SUBJECT_ATTNUM, &subject_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, join_state->probe_attnums, XPOD_RDF_QUAD_PREDICATE_ATTNUM, &predicate_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, join_state->probe_attnums, XPOD_RDF_QUAD_OBJECT_ATTNUM, &object_id))
  {
    return true;
  }
  if (subject_id != state->subject_id || predicate_id != state->probe->predicate_id)
  {
    return true;
  }
  if (state->probe->has_object_id && object_id != state->probe->object_id)
  {
    return true;
  }
  if (
    join_state->graph_id_count > 0
    && !xpod_rdf_int64_array_contains_sorted(join_state->graph_ids, join_state->graph_id_count, graph_id)
  )
  {
    return true;
  }
  if (!xpod_rdf_heap_quad_visible_matches(join_state->heap_relation, join_state->heap_slot, heap_tid, graph_id, subject_id, predicate_id, object_id))
  {
    return true;
  }

  xpod_rdf_star_join_matches_add(state->matches, object_id);
  return true;
}

static void
xpod_rdf_bgp_join_run(XpodRdfBgpJoinState *state)
{
  int row_index;

  if (state->value_width <= 0)
  {
    xpod_rdf_bgp_join_recurse(state, 0);
    return;
  }

  for (row_index = 0; row_index < state->value_row_count; row_index++)
  {
    bool saved_bound[XPOD_RDF_BGP_MAX_OUTPUTS];
    int64 saved_values[XPOD_RDF_BGP_MAX_OUTPUTS];
    int saved_slots[XPOD_RDF_BGP_MAX_OUTPUTS];
    int saved_count = 0;
    bool rejected = false;
    int value_index;

    for (value_index = 0; value_index < state->value_width; value_index++)
    {
      int slot = state->value_slots[value_index];
      int64 value = state->value_rows[(row_index * state->value_width) + value_index];

      if (state->bound[slot - 1])
      {
        if (state->bindings[slot - 1] != value)
        {
          rejected = true;
          break;
        }
        continue;
      }
      saved_slots[saved_count] = slot;
      saved_bound[saved_count] = state->bound[slot - 1];
      saved_values[saved_count] = state->bindings[slot - 1];
      state->bound[slot - 1] = true;
      state->bindings[slot - 1] = value;
      saved_count++;
    }

    if (!rejected)
    {
      xpod_rdf_bgp_join_recurse(state, 0);
    }

    while (saved_count > 0)
    {
      int slot;

      saved_count--;
      slot = saved_slots[saved_count];
      state->bound[slot - 1] = saved_bound[saved_count];
      state->bindings[slot - 1] = saved_values[saved_count];
    }
  }
}

static void
xpod_rdf_bgp_join_recurse(XpodRdfBgpJoinState *state, int pattern_index)
{
  XpodRdfBgpPattern *pattern;
  int64 prefix_keys[XPOD_RDF_PERM_MAX_KEYS];
  uint16 prefix_nkeys = 0;
  int key_index;
  XpodRdfBgpScanState scan_state;

  if (pattern_index >= state->pattern_count)
  {
    xpod_rdf_bgp_join_put_row(state);
    return;
  }

  pattern = &state->patterns[pattern_index];
  memset(prefix_keys, 0, sizeof(prefix_keys));
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    int slot = pattern->variable_slots[key_index];

    if (pattern->has_constant[key_index])
    {
      prefix_keys[key_index] = pattern->constants[key_index];
      prefix_nkeys++;
      continue;
    }
    if (slot > 0 && state->bound[slot - 1])
    {
      prefix_keys[key_index] = state->bindings[slot - 1];
      prefix_nkeys++;
      continue;
    }
    break;
  }

  memset(&scan_state, 0, sizeof(scan_state));
  scan_state.join_state = state;
  scan_state.pattern_index = pattern_index;
  xpod_rdf_perm_scan_prefix_visit(
    pattern->index_relation,
    prefix_keys,
    prefix_nkeys,
    xpod_rdf_bgp_join_visitor,
    &scan_state
  );
}

static bool
xpod_rdf_bgp_join_visitor(ItemPointerData *heap_tid, int64 *keys, uint16 nkeys, void *state_arg)
{
  XpodRdfBgpScanState *scan_state = (XpodRdfBgpScanState *) state_arg;
  XpodRdfBgpJoinState *state = scan_state->join_state;
  XpodRdfBgpPattern *pattern = &state->patterns[scan_state->pattern_index];
  bool saved_bound[XPOD_RDF_PERM_MAX_KEYS];
  int64 saved_values[XPOD_RDF_PERM_MAX_KEYS];
  int saved_slots[XPOD_RDF_PERM_MAX_KEYS];
  int saved_count = 0;
  int key_index;
  int64 graph_id;
  int64 subject_id;
  int64 predicate_id;
  int64 object_id;

  if (nkeys < XPOD_RDF_PERM_MAX_KEYS)
  {
    return true;
  }

  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    int64 value = keys[key_index];
    int slot = pattern->variable_slots[key_index];

    if (pattern->has_constant[key_index] && value != pattern->constants[key_index])
    {
      goto reject;
    }
    if (slot <= 0)
    {
      continue;
    }
    if (state->bound[slot - 1])
    {
      if (state->bindings[slot - 1] != value)
      {
        goto reject;
      }
      continue;
    }
    saved_slots[saved_count] = slot;
    saved_bound[saved_count] = false;
    saved_values[saved_count] = 0;
    state->bound[slot - 1] = true;
    state->bindings[slot - 1] = value;
    saved_count++;
  }

  if (!xpod_rdf_perm_keys_quad_value(keys, nkeys, pattern->attnums, XPOD_RDF_QUAD_GRAPH_ATTNUM, &graph_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, pattern->attnums, XPOD_RDF_QUAD_SUBJECT_ATTNUM, &subject_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, pattern->attnums, XPOD_RDF_QUAD_PREDICATE_ATTNUM, &predicate_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, pattern->attnums, XPOD_RDF_QUAD_OBJECT_ATTNUM, &object_id)
      || !xpod_rdf_heap_quad_visible_matches(state->heap_relation, state->heap_slot, heap_tid, graph_id, subject_id, predicate_id, object_id))
  {
    goto reject;
  }

  xpod_rdf_bgp_join_recurse(state, scan_state->pattern_index + 1);

reject:
  while (saved_count > 0)
  {
    int slot;

    saved_count--;
    slot = saved_slots[saved_count];
    state->bound[slot - 1] = saved_bound[saved_count];
    state->bindings[slot - 1] = saved_values[saved_count];
  }
  return true;
}

static void
xpod_rdf_bgp_join_put_row(XpodRdfBgpJoinState *state)
{
  Datum values[XPOD_RDF_BGP_MAX_OUTPUTS];
  bool nulls[XPOD_RDF_BGP_MAX_OUTPUTS];
  int output_index;

  memset(values, 0, sizeof(values));
  memset(nulls, 0, sizeof(nulls));
  for (output_index = 0; output_index < XPOD_RDF_BGP_MAX_OUTPUTS; output_index++)
  {
    if (output_index < state->output_count)
    {
      int slot = state->output_slots[output_index];

      if (slot > 0 && slot <= XPOD_RDF_BGP_MAX_VARIABLES && state->bound[slot - 1])
      {
        values[output_index] = Int64GetDatum(state->bindings[slot - 1]);
      }
      else
      {
        nulls[output_index] = true;
      }
    }
    else
    {
      nulls[output_index] = true;
    }
  }
  tuplestore_putvalues(state->rsinfo->setResult, state->rsinfo->setDesc, values, nulls);
}

static bool
xpod_rdf_perm_count_visitor(ItemPointerData *heap_tid, int64 *keys, uint16 nkeys, void *state_arg)
{
  XpodRdfPermCountState *state = (XpodRdfPermCountState *) state_arg;
  int64 graph_id;
  int64 subject_id;
  int64 predicate_id;
  int64 object_id;

  if (!xpod_rdf_perm_keys_quad_value(keys, nkeys, state->attnums, XPOD_RDF_QUAD_GRAPH_ATTNUM, &graph_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, state->attnums, XPOD_RDF_QUAD_SUBJECT_ATTNUM, &subject_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, state->attnums, XPOD_RDF_QUAD_PREDICATE_ATTNUM, &predicate_id)
      || !xpod_rdf_perm_keys_quad_value(keys, nkeys, state->attnums, XPOD_RDF_QUAD_OBJECT_ATTNUM, &object_id))
  {
    return true;
  }
  if (!xpod_rdf_perm_count_filter_matches(state, graph_id, subject_id, predicate_id, object_id))
  {
    return true;
  }
  if (xpod_rdf_heap_quad_visible_matches(state->heap_relation, state->heap_slot, heap_tid, graph_id, subject_id, predicate_id, object_id))
  {
    state->count++;
  }
  return true;
}

static bool
xpod_rdf_perm_count_filter_matches(XpodRdfPermCountState *state,
                                   int64 graph_id,
                                   int64 subject_id,
                                   int64 predicate_id,
                                   int64 object_id)
{
  if (state->graph_id_count > 0 && !xpod_rdf_int64_array_contains_sorted(state->graph_ids, state->graph_id_count, graph_id))
  {
    return false;
  }
  if (state->subject_id_count > 0 && !xpod_rdf_int64_array_contains_sorted(state->subject_ids, state->subject_id_count, subject_id))
  {
    return false;
  }
  if (state->predicate_id_count > 0 && !xpod_rdf_int64_array_contains_sorted(state->predicate_ids, state->predicate_id_count, predicate_id))
  {
    return false;
  }
  if (state->object_id_count > 0 && !xpod_rdf_int64_array_contains_sorted(state->object_ids, state->object_id_count, object_id))
  {
    return false;
  }
  return true;
}

static void
xpod_rdf_sort_int64_arg(XpodRdfInt64ArrayArg *arg)
{
  if (arg->count > 1)
  {
    qsort(arg->values, arg->count, sizeof(int64), xpod_rdf_perm_int64_compare);
  }
}

static void
xpod_rdf_subject_star_count_summary_add(XpodRdfSubjectStarJoinState *state,
                                        int64 subject_id,
                                        XpodRdfStarJoinProbeMatches *matches)
{
  uint64 row_count = 1;
  int probe_index;
  int aggregate_index;

  for (probe_index = 0; probe_index < state->probe_count; probe_index++)
  {
    row_count *= (uint64) matches[probe_index].count;
  }

  for (aggregate_index = 0; aggregate_index < state->aggregate_count; aggregate_index++)
  {
    int variable_index = state->aggregate_variables[aggregate_index];

    if (!state->aggregate_distinct[aggregate_index])
    {
      state->aggregate_counts[aggregate_index] += row_count;
      continue;
    }

    if (variable_index == 0)
    {
      xpod_rdf_int64_list_add(&state->aggregate_distinct_values[aggregate_index], subject_id);
    }
    else if (variable_index > 0 && variable_index <= state->probe_count)
    {
      XpodRdfStarJoinProbeMatches *probe_matches = &matches[variable_index - 1];
      int match_index;

      for (match_index = 0; match_index < probe_matches->count; match_index++)
      {
        xpod_rdf_int64_list_add(
          &state->aggregate_distinct_values[aggregate_index],
          probe_matches->object_ids[match_index]
        );
      }
    }
  }
}

static void
xpod_rdf_subject_star_count_summary_put_row(XpodRdfSubjectStarJoinState *state)
{
  Datum values[XPOD_RDF_STAR_COUNT_MAX_AGGREGATES];
  bool nulls[XPOD_RDF_STAR_COUNT_MAX_AGGREGATES];
  int aggregate_index;

  memset(values, 0, sizeof(values));
  memset(nulls, 0, sizeof(nulls));
  for (aggregate_index = 0; aggregate_index < XPOD_RDF_STAR_COUNT_MAX_AGGREGATES; aggregate_index++)
  {
    if (aggregate_index < state->aggregate_count)
    {
      uint64 count = state->aggregate_distinct[aggregate_index]
        ? xpod_rdf_int64_list_unique_count(&state->aggregate_distinct_values[aggregate_index])
        : state->aggregate_counts[aggregate_index];

      values[aggregate_index] = Int64GetDatum((int64) count);
    }
    else
    {
      nulls[aggregate_index] = true;
    }
  }
  tuplestore_putvalues(state->rsinfo->setResult, state->rsinfo->setDesc, values, nulls);
}

static void
xpod_rdf_subject_star_join_put_rows(XpodRdfSubjectStarJoinState *state,
                                    int64 subject_id,
                                    XpodRdfStarJoinProbeMatches *matches,
                                    int probe_index,
                                    int64 *selected_objects)
{
  if (probe_index < state->probe_count)
  {
    int match_index;

    for (match_index = 0; match_index < matches[probe_index].count; match_index++)
    {
      selected_objects[probe_index] = matches[probe_index].object_ids[match_index];
      xpod_rdf_subject_star_join_put_rows(state, subject_id, matches, probe_index + 1, selected_objects);
    }
    return;
  }

  {
    Datum values[XPOD_RDF_STAR_JOIN_MAX_PROBES + 1];
    bool nulls[XPOD_RDF_STAR_JOIN_MAX_PROBES + 1];
    int column_index;

    memset(values, 0, sizeof(values));
    memset(nulls, 0, sizeof(nulls));
    values[0] = Int64GetDatum(subject_id);
    for (column_index = 0; column_index < XPOD_RDF_STAR_JOIN_MAX_PROBES; column_index++)
    {
      if (column_index < state->probe_count)
      {
        values[column_index + 1] = Int64GetDatum(selected_objects[column_index]);
      }
      else
      {
        nulls[column_index + 1] = true;
      }
    }
    tuplestore_putvalues(state->rsinfo->setResult, state->rsinfo->setDesc, values, nulls);
  }
}

static bool
xpod_rdf_heap_quad_visible_matches(Relation heapRelation,
                                   TupleTableSlot *slot,
                                   ItemPointerData *heap_tid,
                                   int64 graph_id,
                                   int64 subject_id,
                                   int64 predicate_id,
                                   int64 object_id)
{
  bool ok = false;
  int64 heap_graph_id;
  int64 heap_subject_id;
  int64 heap_predicate_id;
  int64 heap_object_id;

  ExecClearTuple(slot);
  if (!table_tuple_fetch_row_version(heapRelation, heap_tid, GetActiveSnapshot(), slot))
  {
    ExecClearTuple(slot);
    return false;
  }

  heap_graph_id = xpod_rdf_slot_int64(slot, XPOD_RDF_QUAD_GRAPH_ATTNUM, &ok);
  if (!ok || heap_graph_id != graph_id) goto done;
  heap_subject_id = xpod_rdf_slot_int64(slot, XPOD_RDF_QUAD_SUBJECT_ATTNUM, &ok);
  if (!ok || heap_subject_id != subject_id) goto done;
  heap_predicate_id = xpod_rdf_slot_int64(slot, XPOD_RDF_QUAD_PREDICATE_ATTNUM, &ok);
  if (!ok || heap_predicate_id != predicate_id) goto done;
  heap_object_id = xpod_rdf_slot_int64(slot, XPOD_RDF_QUAD_OBJECT_ATTNUM, &ok);
  if (!ok || heap_object_id != object_id) goto done;

  ok = true;

done:
  ExecClearTuple(slot);
  return ok;
}

static int64
xpod_rdf_slot_int64(TupleTableSlot *slot, AttrNumber attnum, bool *ok)
{
  bool isnull = false;
  Datum value = slot_getattr(slot, attnum, &isnull);

  *ok = !isnull;
  return *ok ? DatumGetInt64(value) : 0;
}

static bool
xpod_rdf_perm_keys_quad_value(int64 *keys,
                              uint16 nkeys,
                              AttrNumber *attnums,
                              AttrNumber attnum,
                              int64 *value)
{
  uint16 key_index;

  for (key_index = 0; key_index < nkeys && key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    if (attnums[key_index] == attnum)
    {
      *value = keys[key_index];
      return true;
    }
  }
  return false;
}

static void
xpod_rdf_star_join_matches_add(XpodRdfStarJoinProbeMatches *matches, int64 object_id)
{
  if (matches->count >= matches->capacity)
  {
    int64 *next_values;

    matches->capacity = matches->capacity == 0 ? 4 : matches->capacity * 2;
    next_values = matches->object_ids == NULL
      ? palloc(sizeof(int64) * matches->capacity)
      : repalloc(matches->object_ids, sizeof(int64) * matches->capacity);
    matches->object_ids = next_values;
  }
  matches->object_ids[matches->count] = object_id;
  matches->count++;
}

static void
xpod_rdf_int64_list_add(XpodRdfInt64List *list, int64 value)
{
  if (list->count >= list->capacity)
  {
    int64 *next_values;

    list->capacity = list->capacity == 0 ? 8 : list->capacity * 2;
    next_values = list->values == NULL
      ? palloc(sizeof(int64) * list->capacity)
      : repalloc(list->values, sizeof(int64) * list->capacity);
    list->values = next_values;
  }
  list->values[list->count] = value;
  list->count++;
}

static uint64
xpod_rdf_int64_list_unique_count(XpodRdfInt64List *list)
{
  int index;
  uint64 unique_count = 0;

  if (list->count == 0)
  {
    return 0;
  }
  qsort(list->values, list->count, sizeof(int64), xpod_rdf_perm_int64_compare);
  for (index = 0; index < list->count; index++)
  {
    if (index == 0 || list->values[index] != list->values[index - 1])
    {
      unique_count++;
    }
  }
  return unique_count;
}

static XpodRdfInt64ArrayArg
xpod_rdf_int64_array_arg(FunctionCallInfo fcinfo, int arg_index, bool allow_nulls)
{
  XpodRdfInt64ArrayArg result;
  ArrayType *array;
  Datum *datums;
  bool *nulls;
  int item_count;
  int item_index;
  int16 typlen;
  bool typbyval;
  char typalign;

  memset(&result, 0, sizeof(result));
  if (arg_index >= PG_NARGS() || PG_ARGISNULL(arg_index))
  {
    return result;
  }

  array = PG_GETARG_ARRAYTYPE_P(arg_index);
  item_count = ArrayGetNItems(ARR_NDIM(array), ARR_DIMS(array));
  if (item_count == 0)
  {
    PG_FREE_IF_COPY(array, arg_index);
    return result;
  }

  get_typlenbyvalalign(INT8OID, &typlen, &typbyval, &typalign);
  deconstruct_array(array, INT8OID, typlen, typbyval, typalign, &datums, &nulls, &item_count);
  result.values = palloc0(sizeof(int64) * item_count);
  result.nulls = palloc0(sizeof(bool) * item_count);
  result.count = item_count;
  for (item_index = 0; item_index < item_count; item_index++)
  {
    if (nulls[item_index])
    {
      if (!allow_nulls)
      {
        ereport(ERROR, (errmsg("xpod_rdf int8 array argument cannot contain null values")));
      }
      result.nulls[item_index] = true;
      continue;
    }
    result.values[item_index] = DatumGetInt64(datums[item_index]);
  }

  pfree(datums);
  pfree(nulls);
  PG_FREE_IF_COPY(array, arg_index);
  return result;
}

static XpodRdfInt16ArrayArg
xpod_rdf_int16_array_arg(FunctionCallInfo fcinfo, int arg_index, bool allow_nulls)
{
  XpodRdfInt16ArrayArg result;
  ArrayType *array;
  Datum *datums;
  bool *nulls;
  int item_count;
  int item_index;
  int16 typlen;
  bool typbyval;
  char typalign;

  memset(&result, 0, sizeof(result));
  if (arg_index >= PG_NARGS() || PG_ARGISNULL(arg_index))
  {
    return result;
  }

  array = PG_GETARG_ARRAYTYPE_P(arg_index);
  item_count = ArrayGetNItems(ARR_NDIM(array), ARR_DIMS(array));
  if (item_count == 0)
  {
    PG_FREE_IF_COPY(array, arg_index);
    return result;
  }

  get_typlenbyvalalign(INT2OID, &typlen, &typbyval, &typalign);
  deconstruct_array(array, INT2OID, typlen, typbyval, typalign, &datums, &nulls, &item_count);
  result.values = palloc0(sizeof(int16) * item_count);
  result.nulls = palloc0(sizeof(bool) * item_count);
  result.count = item_count;
  for (item_index = 0; item_index < item_count; item_index++)
  {
    if (nulls[item_index])
    {
      if (!allow_nulls)
      {
        ereport(ERROR, (errmsg("xpod_rdf int2 array argument cannot contain null values")));
      }
      result.nulls[item_index] = true;
      continue;
    }
    result.values[item_index] = DatumGetInt16(datums[item_index]);
  }

  pfree(datums);
  pfree(nulls);
  PG_FREE_IF_COPY(array, arg_index);
  return result;
}

static XpodRdfOidArrayArg
xpod_rdf_oid_array_arg(FunctionCallInfo fcinfo, int arg_index, bool allow_nulls)
{
  XpodRdfOidArrayArg result;
  ArrayType *array;
  Datum *datums;
  bool *nulls;
  int item_count;
  int item_index;
  int16 typlen;
  bool typbyval;
  char typalign;

  memset(&result, 0, sizeof(result));
  if (arg_index >= PG_NARGS() || PG_ARGISNULL(arg_index))
  {
    return result;
  }

  array = PG_GETARG_ARRAYTYPE_P(arg_index);
  item_count = ArrayGetNItems(ARR_NDIM(array), ARR_DIMS(array));
  if (item_count == 0)
  {
    PG_FREE_IF_COPY(array, arg_index);
    return result;
  }

  get_typlenbyvalalign(OIDOID, &typlen, &typbyval, &typalign);
  deconstruct_array(array, OIDOID, typlen, typbyval, typalign, &datums, &nulls, &item_count);
  result.values = palloc0(sizeof(Oid) * item_count);
  result.nulls = palloc0(sizeof(bool) * item_count);
  result.count = item_count;
  for (item_index = 0; item_index < item_count; item_index++)
  {
    if (nulls[item_index])
    {
      if (!allow_nulls)
      {
        ereport(ERROR, (errmsg("xpod_rdf oid array argument cannot contain null values")));
      }
      result.nulls[item_index] = true;
      continue;
    }
    result.values[item_index] = DatumGetObjectId(datums[item_index]);
  }

  pfree(datums);
  pfree(nulls);
  PG_FREE_IF_COPY(array, arg_index);
  return result;
}

static bool
xpod_rdf_int64_array_contains_sorted(int64 *values, int count, int64 value)
{
  int left = 0;
  int right = count - 1;

  while (left <= right)
  {
    int middle = left + ((right - left) / 2);
    int64 middle_value = values[middle];

    if (middle_value == value)
    {
      return true;
    }
    if (middle_value < value)
    {
      left = middle + 1;
    }
    else
    {
      right = middle - 1;
    }
  }
  return false;
}

static void
xpod_rdf_perm_scan_prefix_sets(Relation indexRelation,
                               XpodRdfPermPrefixSet *prefix_sets,
                               uint16 prefix_nkeys,
                               ReturnSetInfo *rsinfo)
{
  xpod_rdf_perm_scan_prefix_sets_visit(
    indexRelation,
    prefix_sets,
    prefix_nkeys,
    xpod_rdf_perm_scan_tuplestore_visitor,
    rsinfo
  );
}

static void
xpod_rdf_perm_scan_prefix_sets_visit(Relation indexRelation,
                                     XpodRdfPermPrefixSet *prefix_sets,
                                     uint16 prefix_nkeys,
                                     XpodRdfPermScanVisitor visitor,
                                     void *visitor_state)
{
  int64 prefix_keys[XPOD_RDF_PERM_MAX_KEYS];

  memset(prefix_keys, 0, sizeof(prefix_keys));
  xpod_rdf_perm_scan_prefix_sets_visit_recurse(
    indexRelation,
    prefix_sets,
    prefix_nkeys,
    0,
    prefix_keys,
    visitor,
    visitor_state
  );
}

static void
xpod_rdf_perm_scan_prefix_sets_visit_recurse(Relation indexRelation,
                                             XpodRdfPermPrefixSet *prefix_sets,
                                             uint16 prefix_nkeys,
                                             uint16 depth,
                                             int64 *prefix_keys,
                                             XpodRdfPermScanVisitor visitor,
                                             void *visitor_state)
{
  int value_index;

  if (depth >= prefix_nkeys)
  {
    xpod_rdf_perm_scan_prefix_visit(indexRelation, prefix_keys, prefix_nkeys, visitor, visitor_state);
    return;
  }

  for (value_index = 0; value_index < prefix_sets[depth].value_count; value_index++)
  {
    prefix_keys[depth] = prefix_sets[depth].values[value_index];
    xpod_rdf_perm_scan_prefix_sets_visit_recurse(
      indexRelation,
      prefix_sets,
      prefix_nkeys,
      depth + 1,
      prefix_keys,
      visitor,
      visitor_state
    );
  }
}

static void
xpod_rdf_perm_scan_put_row(ReturnSetInfo *rsinfo, ItemPointerData *heap_tid, int64 *keys, uint16 nkeys)
{
  Datum values[5];
  bool nulls[5];
  uint16 key_index;

  memset(values, 0, sizeof(values));
  memset(nulls, 0, sizeof(nulls));
  values[0] = PointerGetDatum(heap_tid);
  for (key_index = 0; key_index < XPOD_RDF_PERM_MAX_KEYS; key_index++)
  {
    if (keys != NULL && key_index < nkeys)
    {
      values[key_index + 1] = Int64GetDatum(keys[key_index]);
    }
    else
    {
      nulls[key_index + 1] = true;
    }
  }
  tuplestore_putvalues(rsinfo->setResult, rsinfo->setDesc, values, nulls);
}

static int
xpod_rdf_perm_int64_compare(const void *left, const void *right)
{
  int64 left_value = *((const int64 *) left);
  int64 right_value = *((const int64 *) right);

  if (left_value < right_value)
  {
    return -1;
  }
  if (left_value > right_value)
  {
    return 1;
  }
  return 0;
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
