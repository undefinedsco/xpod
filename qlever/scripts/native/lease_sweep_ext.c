/* Bulk held-read-lease sweep as a REAL CPython extension.
 *
 * Contract mirrored from the shipped LeaseSet.check (R qlever/scripts/
 * sdk-tool-lifetime-leases.py): one fcntl(F_GETLEASE) then one fstat per held
 * row; the same six fields in the same order (st_dev, st_ino, st_mode,
 * st_size, st_mtime_ns, st_ctime_ns); first failing row wins; no cache, no
 * skipped row, no second authority.
 *
 * TWO CORRECTIONS vs the frozen 5f202e22 draft (both real defects):
 *
 *  1. Py_BuildValue format. Py_BuildValue is VARIADIC and reads each value at
 *     the width named by its format character. The draft used "(nin)" while
 *     passing (int verdict, Py_ssize_t index, int errno). "n" reads a
 *     Py_ssize_t (8 bytes on LP64) from an int (4 bytes) and "i" reads an int
 *     from a Py_ssize_t. That is an ABI mismatch -- it silently truncates the
 *     index on large registries. Correct types are i/n/i -> "(ini)".
 *
 *  2. eq_unsigned on an exact int outside signed 64-bit. The draft returned 0
 *     ("not equal") whenever PyLong_AsLongLongAndOverflow reported overflow.
 *     A legitimate st_ino/st_dev/st_mode value in the unsigned high half
 *     (2^63 .. 2^64-1) is representable and may be exactly equal, so returning
 *     0 wrongly REJECTED a valid lease row. Now an overflowing exact int is
 *     compared with exact Python integer equality instead of being narrowed.
 *
 * Ownership rules kept from the draft (this is the part v5 got wrong):
 *   - every value the loop reads is an OWNED reference taken BEFORE any call
 *     that can run Python code (PyErr_CheckSignals, rich compare);
 *   - so a handler that mutates or pops the caller's containers cannot cause
 *     a use-after-free;
 *   - a raising handler's exception object propagates unchanged (status -1),
 *     so CPython never substitutes SystemError;
 *   - the helper never calls F_SETLEASE, so it can never unlock another fd.
 */
#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <string.h>

#define NS_PER_SEC 1000000000LL
#define NS_FAST_MAX_SEC 9223372035LL

typedef struct Plan Plan;

enum { V_OK = 0, V_LEASE = 1, V_IDENTITY = 2, V_ERRNO = 3, V_NEEDPY = 4 };

/* Exact-int equality WITHOUT narrowing: used whenever a fast path would be
 * unsafe or would need an out-of-range cast. */
static int eq_exact_via_python(PyObject *expected, long long actual)
{
    PyObject *built = PyLong_FromLongLong(actual);
    if (built == NULL) return -1;
    int equal = PyObject_RichCompareBool(built, expected, Py_EQ);
    Py_DECREF(built);
    return equal;
}

static int eq_exact_unsigned_via_python(PyObject *expected, unsigned long long actual)
{
    PyObject *built = PyLong_FromUnsignedLongLong(actual);
    if (built == NULL) return -1;
    int equal = PyObject_RichCompareBool(built, expected, Py_EQ);
    Py_DECREF(built);
    return equal;
}

/* Signed compare (st_size). Exact ints use an int64 fast path; an exact int
 * that does not fit int64 keeps exact Python equality (it can still be equal
 * only if it fits, but we let Python decide rather than assuming). */
static int eq_signed(PyObject *expected, long long actual)
{
    if (!PyLong_CheckExact(expected)) return eq_exact_via_python(expected, actual);
    int overflow = 0;
    long long value = PyLong_AsLongLongAndOverflow(expected, &overflow);
    if (value == -1 && PyErr_Occurred()) return -1;
    if (overflow == 0) return value == actual;
    return eq_exact_via_python(expected, actual);   /* exact, never narrowed */
}

/* Unsigned compare (st_dev/st_ino/st_mode).
 *
 * FIX 2: an exact int in the unsigned high half must be compared exactly, not
 * rejected. We therefore try unsigned parsing first and fall back to exact
 * Python equality for anything that does not fit. */
static int eq_unsigned(PyObject *expected, unsigned long long actual)
{
    if (!PyLong_CheckExact(expected)) return eq_exact_unsigned_via_python(expected, actual);
    unsigned long long value = PyLong_AsUnsignedLongLong(expected);
    if (value == (unsigned long long)-1 && PyErr_Occurred()) {
        PyErr_Clear();                                  /* not representable */
        return eq_exact_unsigned_via_python(expected, actual);
    }
    return value == actual;
}

/* Times: int64 fast path only when provably in range, else exact PyLong math. */
static int eq_timespec(PyObject *expected, const struct timespec *ts)
{
    if (ts->tv_nsec >= 0 && ts->tv_nsec < NS_PER_SEC
        && ts->tv_sec >= -NS_FAST_MAX_SEC && ts->tv_sec <= NS_FAST_MAX_SEC) {
        long long total = (long long)ts->tv_sec * NS_PER_SEC + (long long)ts->tv_nsec;
        return eq_signed(expected, total);
    }
    PyObject *seconds = PyLong_FromLongLong((long long)ts->tv_sec);
    PyObject *scale = seconds ? PyLong_FromLongLong(NS_PER_SEC) : NULL;
    PyObject *scaled = scale ? PyNumber_Multiply(seconds, scale) : NULL;
    PyObject *nanos = scaled ? PyLong_FromLong((long)ts->tv_nsec) : NULL;
    PyObject *total = nanos ? PyNumber_Add(scaled, nanos) : NULL;
    int equal = total ? PyObject_RichCompareBool(total, expected, Py_EQ) : -1;
    Py_XDECREF(total); Py_XDECREF(nanos); Py_XDECREF(scaled);
    Py_XDECREF(scale); Py_XDECREF(seconds);
    return equal;
}

/* B4 FIX: the SINGLE place that builds the public verdict tuple.
 *
 * Both lease_sweep() and the synthetic width seam call this, so the variadic
 * format and the argument widths live in exactly one function. Previously the
 * seam repeated the format string itself, which meant a future product-format
 * regression could leave the seam passing.
 *
 * The explicit casts are the bug fix: Py_BuildValue is variadic and reads each
 * value at the width named by its format character, so "(ini)" REQUIRES
 * (int, Py_ssize_t, int). Passing a Py_ssize_t where "i" is expected (or the
 * reverse) is an ABI mismatch that truncates the index.
 */
static PyObject *verdict_tuple(int verdict, Py_ssize_t index, int errno_value)
{
    return Py_BuildValue("(ini)", (int)verdict, (Py_ssize_t)index, (int)errno_value);
}

/* ---------------------------------------------------------------------------
 * IMMUTABLE REGISTRATION-INPUT PLAN (not an observation cache)
 *
 * The Python LeaseSet already freezes, per held row, the (fd, expected identity)
 * pair recorded at `acquire`. Those expected values never change while the owned
 * set is unchanged, so the PyLong->C decode of the six expected fields can be
 * done ONCE per membership change instead of on every sweep.
 *
 * What this does NOT change, by construction:
 *   * every sweep still issues the SAME live fcntl(F_GETLEASE) then fstat(fd);
 *   * all six live fields are still compared, in the same order;
 *   * the same signal checks, EINTR retry, errno and first-error reporting;
 *   * every call site still performs its own sweep at its own boundary.
 * Only the decode of the EXPECTED side is reused. No observation, verdict or
 * syscall result is ever stored.
 *
 * A row whose expected values are not all small exact ints keeps the generic
 * object path (unsigned high half, huge timespec, non-int comparisons), so
 * Python semantics are preserved exactly. The plan therefore stores the original
 * row object too and falls back per row.
 * ------------------------------------------------------------------------- */

typedef struct {
    PyObject *row;              /* OWNED: fallback + keeps fd alive */
    PyObject *fd_object;        /* OWNED */
    int fd;
    int decoded;                /* 1 => all six expected values are exact ints */
    unsigned long long dev, ino, mode;
    long long size, mtime_ns, ctime_ns;
} PlanRow;

struct Plan {
    Py_ssize_t count;
    PlanRow *rows;
    PyObject *source;      /* OWNED immutable registration graph; LeaseSet selects the plan. */
};

#define PLAN_NS_FAST_MAX_SEC 9223372035LL

/* Decode one exact-int expected value to a C integer. Returns 1 on success, 0 if
 * the value is not a small exact int (caller must use the generic path). */
static int decode_unsigned_exact(PyObject *value, unsigned long long *out)
{
    if (!PyLong_CheckExact(value)) return 0;
    unsigned long long parsed = PyLong_AsUnsignedLongLong(value);
    if (parsed == (unsigned long long)-1 && PyErr_Occurred()) { PyErr_Clear(); return 0; }
    *out = parsed;
    return 1;
}

static int decode_signed_exact(PyObject *value, long long *out)
{
    if (!PyLong_CheckExact(value)) return 0;
    int overflow = 0;
    long long parsed = PyLong_AsLongLongAndOverflow(value, &overflow);
    if (parsed == -1 && PyErr_Occurred()) return 0;
    if (overflow != 0) return 0;
    *out = parsed;
    return 1;
}

/* Decode a pre-scaled nanoseconds int (the Python side already stores ns). */
static int decode_ns_exact(PyObject *value, long long *out)
{
    return decode_signed_exact(value, out);
}

static void plan_row_clear(PlanRow *row)
{
    Py_XDECREF(row->row);
    Py_XDECREF(row->fd_object);
    row->row = NULL;
    row->fd_object = NULL;
}

static void plan_clear(Plan *plan)
{
    if (plan == NULL) return;
    for (Py_ssize_t i = 0; i < plan->count; i++) plan_row_clear(&plan->rows[i]);
    Py_XDECREF(plan->source);
    PyMem_Free(plan->rows);
    PyMem_Free(plan);
}

/* Build a plan from the caller's sequence of (fd, expected) pairs.
 *
 * Every row takes its OWN references before any Python code may run, so a signal
 * handler that mutates the registry (or drops the plan) cannot free them from
 * under a later sweep. Rows that are not exactly decodable are stored with
 * decoded=0 and keep the generic comparison path.
 */
static void lease_plan_capsule_free(PyObject *capsule);

/* Strict immutable-input contract for a plan.
 *
 * A plan captures EXPECTED values once, so its input must be provably immutable:
 *   * the outer container is an EXACT tuple,
 *   * every row is an EXACT 2-tuple `(fd, expected)`,
 *   * every `fd` is an EXACT int,
 *   * every `expected` is an EXACT 6-tuple.
 * Anything else is rejected with TypeError BEFORE any user-defined code runs.
 *
 * This is what makes "predecoded once" sound: a list (or any mutable/custom
 * container) can be mutated after plan creation, which would leave the plan
 * comparing against STALE expectations. Generic sweep(rows) stays fully
 * permissive; only the plan path requires the strict shape.
 *
 * Individual identity VALUES may still be non-exact (float, huge int): such rows
 * set decoded=0 and fall back to the original generic comparisons, so precision
 * semantics are unchanged.
 *
 * Using an exact tuple also removes the borrowed-iterator hazard: with a real
 * tuple, no user code can run between `PySequence_Fast_ITEMS` and our reads, so a
 * custom `fileno`/iterator cannot clear the container underneath us.
 */
static void plan_require_immutable(PyObject *value, const char *what)
{
    if (!PyTuple_CheckExact(value)) {
        PyErr_Format(PyExc_TypeError,
                     "%s must be an exact tuple (immutable plan input)", what);
    }
}

static Plan *plan_build(PyObject *rows)
{
    plan_require_immutable(rows, "plan rows");
    if (PyErr_Occurred()) return NULL;

    Py_ssize_t count = PyTuple_GET_SIZE(rows);
    Plan *plan = PyMem_New(Plan, 1);
    if (plan == NULL) { PyErr_NoMemory(); return NULL; }
    plan->count = 0;
    plan->rows = NULL;
    /* Own the caller's tuple BEFORE any allocation that can fail, so every early
     * return unwinds through plan_clear() (which DECREFs `source`) instead of
     * leaking it. */
    plan->source = rows;
    Py_INCREF(plan->source);
    plan->rows = count > 0 ? PyMem_New(PlanRow, (size_t)count) : NULL;
    if (count > 0 && plan->rows == NULL) { plan_clear(plan); PyErr_NoMemory(); return NULL; }
    /* An EMPTY registration has no row storage, so plan->rows is NULL. C requires a
     * valid pointer argument even for a zero length: memset(NULL, 0, 0) is undefined
     * behaviour (UBSAN "null pointer argument declared never null"). */
    if (count > 0) memset(plan->rows, 0, sizeof(PlanRow) * (size_t)count);

    /* `rows` was already proven to be an EXACT tuple, and it stays alive for the
     * whole call through the caller's arguments plus plan->source. Iterating it
     * directly therefore needs NO borrowed-sequence wrapper: PySequence_Fast would
     * take an extra owning reference on that outer tuple, which every structural
     * early return would then have to give back. One fewer owner, no cleanup path
     * to forget. `PyTuple_GET_ITEM` returns a borrowed reference and never runs
     * user code, so the reads below cannot be invalidated mid-traversal. */
    for (Py_ssize_t i = 0; i < count; i++) {
        PlanRow *row = &plan->rows[i];
        PyObject *pair = PyTuple_GET_ITEM(rows, i);
        plan_require_immutable(pair, "plan row");
        if (PyErr_Occurred()) { plan_clear(plan); return NULL; }
        if (PyTuple_GET_SIZE(pair) != 2) {
            plan_clear(plan);
            PyErr_SetString(PyExc_TypeError, "plan row must be an exact 2-tuple (fd, expected)");
            return NULL;
        }
        PyObject *fd_object = PyTuple_GET_ITEM(pair, 0);
        PyObject *expected_object = PyTuple_GET_ITEM(pair, 1);
        if (!PyLong_CheckExact(fd_object)) {
            plan_clear(plan);
            PyErr_SetString(PyExc_TypeError, "plan fd must be an exact int (no custom fileno)");
            return NULL;
        }
        int fd = PyLong_AsLong(fd_object);
        if (fd == -1 && PyErr_Occurred()) { plan_clear(plan); return NULL; }
        plan_require_immutable(expected_object, "plan expected identity");
        if (PyErr_Occurred()) { plan_clear(plan); return NULL; }
        if (PyTuple_GET_SIZE(expected_object) != 6) {
            plan_clear(plan);
            PyErr_SetString(PyExc_TypeError,
                            "plan expected identity must be an exact 6-tuple");
            return NULL;
        }

        /* From here the row owns its references; plan_clear unwinds it. */
        Py_INCREF(pair);
        row->row = pair;
        plan->count = i + 1;
        row->fd_object = NULL;   /* the exact tuple keeps fd/expected alive */
        row->fd = fd;
        row->decoded = 0;

        /* Same argument: an exact 6-tuple, held alive by its parent row tuple. */
        if (decode_unsigned_exact(PyTuple_GET_ITEM(expected_object, 0), &row->dev)
            && decode_unsigned_exact(PyTuple_GET_ITEM(expected_object, 1), &row->ino)
            && decode_unsigned_exact(PyTuple_GET_ITEM(expected_object, 2), &row->mode)
            && decode_signed_exact(PyTuple_GET_ITEM(expected_object, 3), &row->size)
            && decode_ns_exact(PyTuple_GET_ITEM(expected_object, 4), &row->mtime_ns)
            && decode_ns_exact(PyTuple_GET_ITEM(expected_object, 5), &row->ctime_ns)) {
            row->decoded = 1;
        }
        if (PyErr_Occurred()) { plan_clear(plan); return NULL; }
    }
    return plan;
}

/* Compare live stat data against the SIX expected objects, reusing a prededoded
 * plan row when available. The fast path applies ONLY to a plan row whose six
 * values were exact ints and where the live times are inside the int64 fast
 * range; every other case runs the ORIGINAL object comparisons, so float, huge
 * integer and unsigned-high-half semantics are preserved exactly.
 * Returns 1 matched, 0 identity mismatch, -1 Python error. */
static int compare_identity_from_want(PyObject **want, const PlanRow *plan_row,
                                      const struct stat *st)
{
    if (plan_row != NULL && plan_row->decoded
        && st->st_mtim.tv_nsec >= 0 && st->st_mtim.tv_nsec < NS_PER_SEC
        && st->st_mtim.tv_sec >= -NS_FAST_MAX_SEC && st->st_mtim.tv_sec <= NS_FAST_MAX_SEC
        && st->st_ctim.tv_nsec >= 0 && st->st_ctim.tv_nsec < NS_PER_SEC
        && st->st_ctim.tv_sec >= -NS_FAST_MAX_SEC && st->st_ctim.tv_sec <= NS_FAST_MAX_SEC) {
        if ((unsigned long long)st->st_dev != plan_row->dev) return 0;
        if ((unsigned long long)st->st_ino != plan_row->ino) return 0;
        if ((unsigned long long)st->st_mode != plan_row->mode) return 0;
        if ((long long)st->st_size != plan_row->size) return 0;
        if ((long long)st->st_mtim.tv_sec * NS_PER_SEC + (long long)st->st_mtim.tv_nsec != plan_row->mtime_ns) return 0;
        if ((long long)st->st_ctim.tv_sec * NS_PER_SEC + (long long)st->st_ctim.tv_nsec != plan_row->ctime_ns) return 0;
        return 1;
    }
    int equal = eq_unsigned(want[0], (unsigned long long)st->st_dev);
    if (equal > 0) equal = eq_unsigned(want[1], (unsigned long long)st->st_ino);
    if (equal > 0) equal = eq_unsigned(want[2], (unsigned long long)st->st_mode);
    if (equal > 0) equal = eq_signed(want[3], (long long)st->st_size);
    if (equal > 0) equal = eq_timespec(want[4], &st->st_mtim);
    if (equal > 0) equal = eq_timespec(want[5], &st->st_ctim);
    return equal;
}

/* One row: live F_GETLEASE then fstat, then the six-field identity comparison.
 * `plan_row` is NULL for the generic path; a non-NULL prededoded row only changes
 * how the EXPECTED side is decoded. Returns 1 matched, 0 verdict, -1 error. */
static int check_row(PyObject *row, int *verdict, int *errno_out, Py_ssize_t *index_out,
                     Py_ssize_t row_index, const PlanRow *plan_row)
{
    PyObject *pair = PySequence_Fast(row, "row must be (fd, expected)");
    if (pair == NULL) return -1;
    if (PySequence_Fast_GET_SIZE(pair) != 2) {
        Py_DECREF(pair);
        PyErr_SetString(PyExc_ValueError, "row must be (fd, expected)");
        return -1;
    }
    PyObject **items = PySequence_Fast_ITEMS(pair);
    PyObject *fd_object = items[0];
    PyObject *expected_object = items[1];
    Py_INCREF(fd_object);
    Py_INCREF(expected_object);
    Py_DECREF(pair);

    int fd = PyObject_AsFileDescriptor(fd_object);
    if (fd < 0 && PyErr_Occurred()) {
        Py_DECREF(expected_object); Py_DECREF(fd_object);
        return -1;
    }

    PyObject *expected_seq = PySequence_Fast(expected_object, "expected must be 6 values");
    Py_DECREF(expected_object);
    if (expected_seq == NULL) { Py_DECREF(fd_object); return -1; }
    if (PySequence_Fast_GET_SIZE(expected_seq) != 6) {
        Py_DECREF(expected_seq); Py_DECREF(fd_object);
        PyErr_SetString(PyExc_ValueError, "expected identity must have 6 fields");
        return -1;
    }
    PyObject *want[6];
    {
        PyObject **snapshot = PySequence_Fast_ITEMS(expected_seq);
        for (int field = 0; field < 6; field++) { want[field] = snapshot[field]; Py_INCREF(want[field]); }
    }
    Py_DECREF(expected_seq);

    int status = -1;
    *index_out = row_index;
    *errno_out = 0;
    *verdict = V_OK;
    if (PyErr_CheckSignals() < 0) goto out;

    {
        int lease;
        for (;;) {
            errno = 0;
            lease = fcntl(fd, F_GETLEASE);
            int saved = errno;
            if (PyErr_CheckSignals() < 0) goto out;
            if (lease == -1 && saved == EINTR) continue;
            if (lease == -1) { *verdict = V_ERRNO; *errno_out = saved; status = 0; goto out; }
            break;
        }
        if (lease != F_RDLCK) { *verdict = V_LEASE; status = 0; goto out; }
    }
    {
        struct stat st;
        int stat_result;
        for (;;) {
            errno = 0;
            stat_result = fstat(fd, &st);
            int saved = errno;
            if (PyErr_CheckSignals() < 0) goto out;
            if (stat_result != 0 && saved == EINTR) continue;
            if (stat_result != 0) { *verdict = V_ERRNO; *errno_out = saved; status = 0; goto out; }
            break;
        }
        if (PyErr_CheckSignals() < 0) goto out;
        int equal = compare_identity_from_want(want, plan_row, &st);
        if (equal < 0) goto out;
        if (!equal) { *verdict = V_IDENTITY; status = 0; goto out; }
    }
    status = 1;

out:
    for (int field = 0; field < 6; field++) Py_XDECREF(want[field]);
    Py_DECREF(fd_object);
    return status;
}

static PyObject *lease_sweep(PyObject *module_self, PyObject *args)
{
    (void)module_self;                 /* unused by design, -Werror clean */
    PyObject *rows;
    if (!PyArg_ParseTuple(args, "O:sweep", &rows)) return NULL;
    PyObject *fast = PySequence_Fast(rows, "rows must be a sequence");
    if (fast == NULL) return NULL;

    PyObject *result = NULL;
    PyObject **items = PySequence_Fast_ITEMS(fast);
    Py_ssize_t count = PySequence_Fast_GET_SIZE(fast);

    /* OWNED outer snapshot: a handler mutating the caller's list cannot move it. */
    PyObject **owned = NULL;
    if (count > 0) {
        owned = PyMem_New(PyObject *, (size_t)count);
        if (owned == NULL) { Py_DECREF(fast); return PyErr_NoMemory(); }
        for (Py_ssize_t i = 0; i < count; i++) { owned[i] = items[i]; Py_INCREF(owned[i]); }
    }

    for (Py_ssize_t i = 0; i < count; i++) {
        int verdict = V_OK, errno_value = 0;
        Py_ssize_t index = i;
        /* NO module-global plan is ever consulted here: generic sweep(rows) is
         * behaviour-identical regardless of which plan capsules exist. */
        int status = check_row(owned[i], &verdict, &errno_value, &index, i, NULL);
        if (status < 0) goto done;
        if (status == 0) {
            /* FIX 1: Py_BuildValue is variadic; the format MUST match the
             * argument widths. verdict=int ('i'), index=Py_ssize_t ('n'),
             * errno=int ('i') => "(ini)". */
            result = verdict_tuple(verdict, index, errno_value);
            goto done;
        }
    }
    result = verdict_tuple(V_OK, (Py_ssize_t)-1, 0);

done:
    if (owned != NULL) {
        for (Py_ssize_t i = 0; i < count; i++) Py_XDECREF(owned[i]);
        PyMem_Free(owned);
    }
    Py_DECREF(fast);
    return result;
}

/* SYNTHETIC marshalling seam, not a product API.
 *
 * There is no way to hold 2**31 live kernel leases, so the variadic width of
 * the verdict tuple cannot be exercised with real rows. This entry point takes a
 * Py_ssize_t and returns it through the SAME Py_BuildValue format the real
 * sweep uses, so a test can prove the exact boundary value survives. It touches
 * no fd and makes no lease claim.
 */
static PyObject *lease_sweep_plan(PyObject *module_self, PyObject *args)
{
    (void)module_self;
    PyObject *capsule;
    if (!PyArg_ParseTuple(args, "O:sweep_plan", &capsule)) return NULL;
    if (!PyCapsule_IsValid(capsule, "xpod.lease.plan")) {
        PyErr_SetString(PyExc_TypeError, "sweep_plan requires a lease plan capsule");
        return NULL;
    }
    Plan *plan = (Plan *)PyCapsule_GetPointer(capsule, "xpod.lease.plan");
    if (plan == NULL) return NULL;

    Py_ssize_t count = plan->count;
    PyObject **owned = NULL;
    if (count > 0) {
        owned = PyMem_New(PyObject *, (size_t)count);
        if (owned == NULL) return PyErr_NoMemory();
        for (Py_ssize_t i = 0; i < count; i++) { owned[i] = plan->rows[i].row; Py_INCREF(owned[i]); }
    }

    PyObject *result = NULL;
    for (Py_ssize_t i = 0; i < count; i++) {
        int verdict = V_OK, errno_value = 0;
        Py_ssize_t index = i;
        int status = check_row(owned[i], &verdict, &errno_value, &index, i, &plan->rows[i]);
        if (status < 0) goto done;
        if (status == 0) { result = verdict_tuple(verdict, index, errno_value); goto done; }
    }
    result = verdict_tuple(V_OK, (Py_ssize_t)-1, 0);

done:
    if (owned != NULL) {
        for (Py_ssize_t i = 0; i < count; i++) Py_XDECREF(owned[i]);
        PyMem_Free(owned);
    }
    return result;
}

/* Capsule destructor: releases the plan's owned row references exactly once. */
static void lease_plan_capsule_free(PyObject *capsule)
{
    Plan *plan = (Plan *)PyCapsule_GetPointer(capsule, "xpod.lease.plan");
    if (plan == NULL) { PyErr_Clear(); return; }
    plan_clear(plan);
}

/* plan_new(rows) -> capsule owning an immutable decoded registration plan. */
static PyObject *lease_plan_new(PyObject *module_self, PyObject *args)
{
    (void)module_self;
    PyObject *rows;
    if (!PyArg_ParseTuple(args, "O:plan_new", &rows)) return NULL;
    Plan *plan = plan_build(rows);
    if (plan == NULL) return NULL;
    PyObject *capsule = PyCapsule_New(plan, "xpod.lease.plan", lease_plan_capsule_free);
    if (capsule == NULL) { plan_clear(plan); return NULL; }
    return capsule;
}

static PyObject *lease_index_roundtrip(PyObject *module_self, PyObject *args)
{
    (void)module_self;
    Py_ssize_t index;
    if (!PyArg_ParseTuple(args, "n:index_roundtrip", &index)) return NULL;
    return verdict_tuple(V_OK, index, 0);
}

static PyMethodDef methods[] = {
    {"sweep", lease_sweep, METH_VARARGS,
     "sweep(rows) -> (verdict, index, errno); checks every (fd, expected) row"},
    {"sweep_plan", lease_sweep_plan, METH_VARARGS,
     "sweep_plan(capsule) -> (verdict, index, errno); live syscalls per row"},
    {"plan_new", lease_plan_new, METH_VARARGS,
     "plan_new(rows) -> capsule; decodes immutable expected identities once"},
    {"index_roundtrip", lease_index_roundtrip, METH_VARARGS,
     "index_roundtrip(n) -> (OK, n, 0); SYNTHETIC width seam for tests"},
    {NULL, NULL, 0, NULL},
};

static struct PyModuleDef module = {
    PyModuleDef_HEAD_INIT, "lease_sweep_ext",
    "Held-read-lease bulk sweep (contract-exact, no state, no cache).",
    -1, methods, NULL, NULL, NULL, NULL,
};

PyMODINIT_FUNC PyInit_lease_sweep_ext(void)
{
    PyObject *m = PyModule_Create(&module);
    if (m == NULL) return NULL;
    PyModule_AddIntConstant(m, "OK", V_OK);
    PyModule_AddIntConstant(m, "LEASE", V_LEASE);
    PyModule_AddIntConstant(m, "IDENTITY", V_IDENTITY);
    PyModule_AddIntConstant(m, "ERRNO", V_ERRNO);
    PyModule_AddIntConstant(m, "NEEDPY", V_NEEDPY);
    return m;
}
