#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/futex.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

struct control {
  _Atomic uint32_t start;
  _Atomic uint32_t done;
  _Atomic uint32_t worker_ready;
  _Atomic uint32_t passive_ready;
  _Atomic uint32_t release_passive;
  unsigned char *output;
  long woken;
};
static void *produce(void *argument) {
  struct control *state = argument;
  atomic_store_explicit(&state->worker_ready, 1, memory_order_release);
  while (!atomic_load_explicit(&state->start, memory_order_acquire)) {}
  for (volatile unsigned long i = 0; i < 10000000UL; i++) {}
  state->output[0] = 0x42;
  atomic_store_explicit(&state->done, 1, memory_order_release);
  state->woken = syscall(SYS_futex, &state->done,
    (unsigned long)(FUTEX_WAKE | FUTEX_PRIVATE_FLAG), 1UL, 0UL, 0UL, 0UL);
  return NULL;
}
static void *passive(void *argument) {
  struct control *state = argument;
  atomic_store_explicit(&state->passive_ready, 1, memory_order_release);
  while (!atomic_load_explicit(&state->release_passive, memory_order_acquire)) {}
  return NULL;
}
int main(void) {
  struct control *state = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (state == MAP_FAILED) return 10;
  pthread_t passive_worker;
  if (pthread_create(&passive_worker, NULL, passive, state)) return 17;
  while (!atomic_load_explicit(&state->passive_ready, memory_order_acquire)) {}
  pthread_t worker;
  if (pthread_create(&worker, NULL, produce, state)) return 11;
  while (!atomic_load_explicit(&state->worker_ready, memory_order_acquire)) {}
  int fd = open("/opt/qlever-sdk/build/finite-output", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd < 0 || ftruncate(fd, 1)) return 12;
  state->output = mmap(NULL, 1, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_NORESERVE, fd, 0);
  if (state->output == MAP_FAILED) return 13;
  atomic_store_explicit(&state->start, 1, memory_order_release);
  long waited = syscall(SYS_futex, &state->done,
    (unsigned long)(FUTEX_WAIT_BITSET | FUTEX_PRIVATE_FLAG | FUTEX_CLOCK_REALTIME),
    0UL, 0UL, 0UL, (unsigned long)FUTEX_BITSET_MATCH_ANY);
  int wait_errno = errno;
  unsigned value = state->output[0];
  if (munmap(state->output, 1) || write(fd, "z", 1) != 1 || close(fd) || pthread_join(worker, NULL)) return 14;
  atomic_store_explicit(&state->release_passive, 1, memory_order_release);
  if (pthread_join(passive_worker, NULL)) return 18;
  printf("{\"waited\":%ld,\"waitErrno\":%d,\"woken\":%ld,\"value\":%u}\n",
    waited, wait_errno, state->woken, value);
  int result = waited == 0 && state->woken == 1 && value == 0x42 ? 0 : 15;
  if (munmap(state, 4096)) return 16;
  return result;
}
