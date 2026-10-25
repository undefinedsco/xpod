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

#define NS_PER_SEC 1000000000LL
#define NS_FAST_MAX_SEC 9223372035LL

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

/* One row. Returns 1 matched, 0 verdict reached, -1 Python error. */
static int check_row(PyObject *row, int *verdict, int *errno_out, Py_ssize_t *index_out,
                     Py_ssize_t row_index)
{
    PyObject *pair = PySequence_Fast(row, "row must be (fd, expected)");
    if (pair == NULL) return -1;
    if (PySequence_Fast_GET_SIZE(pair) != 2) {
        Py_DECREF(pair);
        PyErr_SetString(PyExc_ValueError, "row must be (fd, expected)");
        return -1;
    }
    /* OWNED refs on BOTH row items before anything can run Python code. */
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
    /* OWNED snapshot of all six, before any PyErr_CheckSignals. */
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
        /* EINTR CONTRACT FIX (see the observed CPython behaviour): CPython's
         * fcntl_fcntl_impl loops `while (ret == -1 && errno == EINTR &&
         * !(async_err = PyErr_CheckSignals()))`, i.e. it retries the SAME call
         * after checking signals, and only surfaces the error when a handler
         * raised. We must do the same for the SAME reason:
         *
         *   - a raising handler still wins: PyErr_CheckSignals() < 0 -> goto out
         *     with the handler's own exception object, never a verdict;
         *   - a non-raising handler means "retry", not "ERRNO(EINTR)";
         *   - every other errno keeps its existing sticky-ERRNO behaviour.
         * The retry re-issues fcntl FIRST, preserving the shipped order. */
        int lease;
        for (;;) {
            errno = 0;
            lease = fcntl(fd, F_GETLEASE);
            int saved = errno;
            if (PyErr_CheckSignals() < 0) goto out;  /* handler exception wins */
            if (lease == -1 && saved == EINTR) continue;
            if (lease == -1) { *verdict = V_ERRNO; *errno_out = saved; status = 0; goto out; }
            break;
        }
        if (lease != F_RDLCK) { *verdict = V_LEASE; status = 0; goto out; }
    }
    {
        struct stat st;
        /* Same EINTR retry rule for fstat; os_fstat_impl has the identical
         * `do { FSTAT } while (res != 0 && errno == EINTR && !CheckSignals())`.
         * fstat still runs SECOND, after a successful F_GETLEASE. */
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

        int equal = eq_unsigned(want[0], (unsigned long long)st.st_dev);
        if (equal < 0) goto out;
        if (!equal) { *verdict = V_IDENTITY; status = 0; goto out; }
        equal = eq_unsigned(want[1], (unsigned long long)st.st_ino);
        if (equal < 0) goto out;
        if (!equal) { *verdict = V_IDENTITY; status = 0; goto out; }
        equal = eq_unsigned(want[2], (unsigned long long)st.st_mode);
        if (equal < 0) goto out;
        if (!equal) { *verdict = V_IDENTITY; status = 0; goto out; }
        equal = eq_signed(want[3], (long long)st.st_size);
        if (equal < 0) goto out;
        if (!equal) { *verdict = V_IDENTITY; status = 0; goto out; }
        equal = eq_timespec(want[4], &st.st_mtim);
        if (equal < 0) goto out;
        if (!equal) { *verdict = V_IDENTITY; status = 0; goto out; }
        equal = eq_timespec(want[5], &st.st_ctim);
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
        int status = check_row(owned[i], &verdict, &errno_value, &index, i);
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
