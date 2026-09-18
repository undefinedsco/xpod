import { expect, type Page } from '@playwright/test';

/** Delay only delivery of a real Pod result; neither transport nor identity is mocked. */
export async function armDelayedProviders(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const root = document.getElementById('root')!;
    const key = Object.keys(root).find(key => key.startsWith('__reactContainer$'))!;
    const queue = [(root as any)[key]?.stateNode?.current];
    while (queue.length) {
      const fiber = queue.shift();
      if (!fiber) continue;
      const { host, controller } = fiber.memoizedProps ?? {};
      const store = host?.capabilities?.aiConnectionsPodStore;
      if (store?.listProviders && controller?.client?.listProviders) {
        if ((window as any).__delayedProviders) throw new Error('Previous provider gate still installed');
        const original = store.listProviders;
        let release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        const gate = { entered: false, resultReady: false, released: false, settled: false, rejected: false,
          statusAtRelease: '', release: () => { gate.statusAtRelease = host.solid.session.getSnapshot().status; gate.released = true; release(); },
          restore: () => { store.listProviders = original; }, operation: undefined as Promise<void> | undefined };
        store.listProviders = async (...args: unknown[]) => {
          store.listProviders = original; // Delay exactly this operation.
          gate.entered = true;
          const result = await original.apply(store, args);
          gate.resultReady = true;
          await barrier;
          return result;
        };
        (window as any).__delayedProviders = gate;
        gate.operation = controller.client.listProviders().then(() => undefined, () => { gate.rejected = true; })
          .finally(() => { gate.settled = true; });
        return true;
      }
      queue.push(fiber.child, fiber.sibling);
    }
    return false;
  }), { timeout: 30_000, message: 'Waiting for mounted AI Connections host/controller' }).toBe(true);
  await expect.poll(() => delayedProvidersState(page), { timeout: 60_000 }).toMatchObject({ entered: true, resultReady: true, released: false, settled: false });
}
export async function delayedProvidersState(page: Page) {
  return page.evaluate(() => {
    const gate = (window as any).__delayedProviders;
    if (!gate) throw new Error('Provider gate document was replaced');
    const { entered, resultReady, released, settled, rejected, statusAtRelease } = gate;
    return { entered, resultReady, released, settled, rejected, statusAtRelease };
  });
}
export async function releaseDelayedProviders(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__delayedProviders.release());
  await expect.poll(() => delayedProvidersState(page), { timeout: 30_000 }).toMatchObject({ released: true, settled: true });
}
export async function cleanupDelayedProviders(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const gate = (window as any).__delayedProviders;
    if (!gate) return;
    gate.restore(); gate.release();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([gate.operation, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Provider gate cleanup timed out after 5 seconds')), 5_000);
      })]);
      delete (window as any).__delayedProviders;
    } finally {
      clearTimeout(timeout);
    }
  });
}
