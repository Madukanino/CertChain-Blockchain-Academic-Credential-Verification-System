/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    debugLog,
    debugWarn,
    isDebugLoggingEnabled,
    scrubSensitiveData,
    ingestDebugEvent,
    recordMetric,
} from '../src/lib/debug';

const originalNodeEnv = process.env.NODE_ENV;
const originalDebugFlag = process.env.NEXT_PUBLIC_ENABLE_DEBUG_LOGS;

afterEach(() => {
    (process.env as any).NODE_ENV = originalNodeEnv;
    if (typeof originalDebugFlag === 'undefined') {
        delete process.env.NEXT_PUBLIC_ENABLE_DEBUG_LOGS;
    } else {
        process.env.NEXT_PUBLIC_ENABLE_DEBUG_LOGS = originalDebugFlag;
    }
    vi.restoreAllMocks();
});

describe('debug logging', () => {
    it('stays disabled in production', () => {
        (process.env as any).NODE_ENV = 'production';
        process.env.NEXT_PUBLIC_ENABLE_DEBUG_LOGS = 'true';

        expect(isDebugLoggingEnabled()).toBe(false);
    });

    it('stays disabled without the explicit debug flag', () => {
        (process.env as any).NODE_ENV = 'development';
        delete process.env.NEXT_PUBLIC_ENABLE_DEBUG_LOGS;

        expect(isDebugLoggingEnabled()).toBe(false);
    });

    it('logs only when debug logging is explicitly enabled outside production', () => {
        (process.env as any).NODE_ENV = 'development';
        process.env.NEXT_PUBLIC_ENABLE_DEBUG_LOGS = 'true';

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        debugLog('test log');
        debugWarn('test warn');

        expect(logSpy).toHaveBeenCalledWith('test log');
        expect(warnSpy).toHaveBeenCalledWith('test warn');
    });
});

describe('scrubSensitiveData', () => {
    it('scrubs sensitive keys at any depth', () => {
        const scrubbed = scrubSensitiveData({
            user: {
                name: 'Ada',
                password: 'hunter2',
                nested: { token: 'abc123', apiKey: 'key-xyz', keep: 'ok' },
            },
            list: [{ secret: 's1' }, { authorization: 'Bearer xyz' }],
        }) as any;

        expect(scrubbed.user.name).toBe('Ada');
        expect(scrubbed.user.password).not.toBe('hunter2');
        expect(scrubbed.user.nested.token).not.toBe('abc123');
        expect(scrubbed.user.nested.apiKey).not.toBe('key-xyz');
        expect(scrubbed.user.nested.keep).toBe('ok');
        expect(scrubbed.list[0].secret).not.toBe('s1');
        expect(scrubbed.list[1].authorization).not.toBe('Bearer xyz');
    });

    it('scrubs bearer tokens in auth headers', () => {
        const scrubbed = scrubSensitiveData({
            headers: { Authorization: 'Bearer super-secret-token' },
        }) as any;

        expect(scrubbed.headers.Authorization).not.toContain('super-secret-token');
    });

    it('truncates long strings', () => {
        const long = 'a'.repeat(5000);
        const scrubbed = scrubSensitiveData({ message: long }) as any;

        expect(typeof scrubbed.message).toBe('string');
        expect(scrubbed.message.length).toBeLessThan(long.length);
    });
});

describe('ingest and metrics', () => {
    it('prefers the explicit ingest URL over the env default', () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch' as any)
            .mockResolvedValue({ ok: true } as any);

        ingestDebugEvent({ level: 'info', message: 'hi' }, 'https://explicit.example/ingest');

        expect(fetchSpy).toHaveBeenCalled();
        const calledUrl = String((fetchSpy.mock.calls[0] as any[])[0]);
        expect(calledUrl).toContain('https://explicit.example/ingest');
    });

    it('never throws when ingest fails', () => {
        vi.spyOn(globalThis, 'fetch' as any).mockRejectedValue(new Error('network down'));

        expect(() => ingestDebugEvent({ level: 'error', message: 'boom' })).not.toThrow();
    });

    it('never throws when recording a metric fails', () => {
        vi.spyOn(globalThis, 'fetch' as any).mockRejectedValue(new Error('network down'));

        expect(() => recordMetric('test.metric', 1)).not.toThrow();
    });
});
