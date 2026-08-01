import { EVENTS, Session, } from '@inrupt/solid-client-authn-browser';
function snapshotFromSessionInfo(info) {
    if (info?.isLoggedIn && info.webId) {
        return {
            status: 'authenticated',
            webId: info.webId,
        };
    }
    return { status: 'anonymous' };
}
function normalizeError(error) {
    if (error instanceof Error) {
        return error;
    }
    return new Error(String(error));
}
function snapshotFromSessionError(error, info) {
    return {
        status: 'error',
        webId: info.webId,
        error: normalizeError(error),
    };
}
function areSnapshotsEqual(left, right) {
    if (!left || left.status !== right.status || left.webId !== right.webId) {
        return false;
    }
    if (left.status === 'error' && right.status === 'error') {
        return left.error === right.error;
    }
    return true;
}
export function createSolidSessionRuntime(options = {}) {
    const session = options.session ?? new Session();
    const listeners = new Set();
    let snapshot = { status: 'initializing' };
    let lastNotifiedSnapshot;
    let initialization;
    let isInitializing = false;
    let initializationErrorSnapshot;
    let disposed = false;
    const publish = (nextSnapshot) => {
        snapshot = nextSnapshot;
        if (disposed) {
            return snapshot;
        }
        if (areSnapshotsEqual(lastNotifiedSnapshot, snapshot)) {
            return snapshot;
        }
        lastNotifiedSnapshot = snapshot;
        for (const listener of listeners) {
            listener(snapshot);
        }
        return snapshot;
    };
    const publishSessionInfo = () => publish(snapshotFromSessionInfo(session.info));
    const publishAnonymous = () => publish({ status: 'anonymous' });
    const publishSessionExpired = () => publish(snapshotFromSessionError('Solid session expired', session.info));
    const publishSessionError = (code, description) => {
        const errorSnapshot = snapshotFromSessionError(description ?? code ?? 'Solid session error', session.info);
        if (isInitializing) {
            initializationErrorSnapshot = errorSnapshot;
        }
        publish(errorSnapshot);
    };
    session.events.on(EVENTS.LOGIN, publishSessionInfo);
    session.events.on(EVENTS.SESSION_RESTORED, publishSessionInfo);
    session.events.on(EVENTS.LOGOUT, publishAnonymous);
    session.events.on(EVENTS.SESSION_EXPIRED, publishSessionExpired);
    const errorEvents = session.events;
    errorEvents.on(EVENTS.ERROR, publishSessionError);
    return {
        fetch: session.fetch,
        getSnapshot() {
            return snapshot;
        },
        initialize(options = {}) {
            if (initialization) {
                return initialization;
            }
            isInitializing = true;
            initializationErrorSnapshot = undefined;
            publish({ status: 'initializing' });
            const nextInitialization = session.handleIncomingRedirect({
                restorePreviousSession: options.restorePreviousSession ?? true,
            }).then((info) => {
                const nextSnapshot = snapshotFromSessionInfo(info ?? session.info);
                if (nextSnapshot.status === 'anonymous' && initializationErrorSnapshot?.status === 'error') {
                    return initializationErrorSnapshot;
                }
                return publish(nextSnapshot);
            })
                .catch((error) => publish(snapshotFromSessionError(error, session.info)))
                .finally(() => {
                if (initialization === nextInitialization) {
                    initialization = undefined;
                    isInitializing = false;
                    initializationErrorSnapshot = undefined;
                }
            });
            initialization = nextInitialization;
            return initialization;
        },
        login(options) {
            return session.login(options);
        },
        async logout(options) {
            await session.logout(options);
            publish({ status: 'anonymous' });
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose() {
            disposed = true;
            listeners.clear();
            session.events.off(EVENTS.LOGIN, publishSessionInfo);
            session.events.off(EVENTS.SESSION_RESTORED, publishSessionInfo);
            session.events.off(EVENTS.LOGOUT, publishAnonymous);
            session.events.off(EVENTS.SESSION_EXPIRED, publishSessionExpired);
            errorEvents.off(EVENTS.ERROR, publishSessionError);
        },
    };
}
