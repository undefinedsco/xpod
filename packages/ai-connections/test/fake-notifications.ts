import type {
  SolidLiveUpdateSignal,
  SolidLiveUpdateState,
  SolidNotificationsCapability,
} from '@undefineds.co/extension-sdk/web'

/**
 * Stands in for the host's notification channels: it records who watches which
 * document, can push dirty signals, and can report a degraded state.
 *
 * Shared by the page suites that need to observe *which* documents a page
 * subscribes to - the live-update suite and the collection-ownership suite.
 */
export function fakeNotifications(initialState: SolidLiveUpdateState = 'idle') {
  const watched = new Map<string, Set<(signal: SolidLiveUpdateSignal) => void>>()
  const stateListeners = new Set<(state: SolidLiveUpdateState) => void>()
  const watchCalls: string[] = []
  const releaseCalls: string[] = []
  const delivered = new Map<string, number>()
  let state = initialState

  const capability: SolidNotificationsCapability = {
    watch(topicUrl, listener) {
      watchCalls.push(topicUrl)
      const listeners = watched.get(topicUrl) ?? new Set()
      listeners.add(listener)
      watched.set(topicUrl, listeners)
      return () => {
        releaseCalls.push(topicUrl)
        const current = watched.get(topicUrl)
        if (!current?.delete(listener)) return
        if (current.size === 0) watched.delete(topicUrl)
      }
    },
    getState: () => state,
    subscribeState(listener) {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
    dispose() {
      watched.clear()
    },
  }

  return {
    capability,
    topics: () => [...watched.keys()].sort(),
    subscriberCount: () => [...watched.values()].reduce((total, listeners) => total + listeners.size, 0),
    watchCalls,
    releaseCalls,
    /** `times` writes to one watched document, as one burst. */
    signal(document: string, times = 1) {
      for (let index = 0; index < times; index += 1) {
        const sequence = (delivered.get(document) ?? 0) + 1
        delivered.set(document, sequence)
        const signal: SolidLiveUpdateSignal = { topic: document, sequence, receivedAt: Date.now() }
        for (const listener of [...watched.get(document) ?? []]) listener(signal)
      }
    },
    report(next: SolidLiveUpdateState) {
      state = next
      for (const listener of [...stateListeners]) listener(next)
    },
  }
}
