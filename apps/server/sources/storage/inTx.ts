import { parseIntEnv } from "@/config/env";
import { delay } from "@/utils/runtime/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";

export type Tx = TransactionClient;

export type InTxOptions = Readonly<{
    deadlineAtMs?: number;
}>;

export class TransactionAcquisitionUnavailableError extends Error {
    readonly code = "P2028";
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("Database transaction acquisition is temporarily unavailable");
        this.name = "TransactionAcquisitionUnavailableError";
        this.cause = cause;
    }
}

export class TransactionDeadlineExceededError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown) {
        super("Database transaction request deadline expired");
        this.name = "TransactionDeadlineExceededError";
        this.cause = cause;
    }
}

const symbol = Symbol();

type TransactionConfig = Readonly<{
    maxRetries: number;
    maxWaitMs: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    timeoutMs: number;
    totalRetryBudgetMs: number;
}>;

const DEFAULT_TRANSACTION_MAX_RETRIES = 3;
const DEFAULT_TRANSACTION_MAX_WAIT_MS = 2_000;
const DEFAULT_TRANSACTION_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_TRANSACTION_RETRY_MAX_DELAY_MS = 800;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSACTION_TOTAL_RETRY_BUDGET_MS = 600_000;
const DEFAULT_SQLITE_TRANSACTION_MAX_RETRIES = 8;
const DEFAULT_SQLITE_TRANSACTION_MAX_WAIT_MS = 5_000;
// Keep default inTx retry scheduling inside request/client timeout envelopes; raise via env only for known background paths.
const DEFAULT_SQLITE_TRANSACTION_TOTAL_RETRY_BUDGET_MS = 25_000;

function readTransactionConfigFromEnv(env: NodeJS.ProcessEnv, provider: string): TransactionConfig {
    const sqlite = provider === "sqlite";
    const retryBaseDelayMs = parseIntEnv(
        env.HAPPIER_DB_TX_RETRY_BASE_DELAY_MS ?? env.HAPPY_DB_TX_RETRY_BASE_DELAY_MS,
        DEFAULT_TRANSACTION_RETRY_BASE_DELAY_MS,
        { min: 0, max: 60_000 },
    );

    return {
        maxRetries: parseIntEnv(
            env.HAPPIER_DB_TX_MAX_RETRIES ?? env.HAPPY_DB_TX_MAX_RETRIES,
            sqlite ? DEFAULT_SQLITE_TRANSACTION_MAX_RETRIES : DEFAULT_TRANSACTION_MAX_RETRIES,
            { min: 0, max: 100 },
        ),
        maxWaitMs: parseIntEnv(
            env.HAPPIER_DB_TX_MAX_WAIT_MS ?? env.HAPPY_DB_TX_MAX_WAIT_MS,
            sqlite ? DEFAULT_SQLITE_TRANSACTION_MAX_WAIT_MS : DEFAULT_TRANSACTION_MAX_WAIT_MS,
            { min: 1_000, max: 600_000 },
        ),
        retryBaseDelayMs,
        retryMaxDelayMs: parseIntEnv(
            env.HAPPIER_DB_TX_RETRY_MAX_DELAY_MS ?? env.HAPPY_DB_TX_RETRY_MAX_DELAY_MS,
            DEFAULT_TRANSACTION_RETRY_MAX_DELAY_MS,
            { min: retryBaseDelayMs, max: 600_000 },
        ),
        timeoutMs: parseIntEnv(
            env.HAPPIER_DB_TX_TIMEOUT_MS ?? env.HAPPY_DB_TX_TIMEOUT_MS,
            DEFAULT_TRANSACTION_TIMEOUT_MS,
            { min: 1_000, max: 600_000 },
        ),
        totalRetryBudgetMs: parseIntEnv(
            env.HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS ?? env.HAPPY_DB_TX_TOTAL_RETRY_BUDGET_MS,
            sqlite ? DEFAULT_SQLITE_TRANSACTION_TOTAL_RETRY_BUDGET_MS : DEFAULT_TRANSACTION_TOTAL_RETRY_BUDGET_MS,
            { min: 1, max: 600_000 },
        ),
    };
}

function resolveTransactionRetryDelayMs(
    attempt: number,
    config: Pick<TransactionConfig, "retryBaseDelayMs" | "retryMaxDelayMs">,
): number {
    return Math.min(config.retryMaxDelayMs, attempt * config.retryBaseDelayMs);
}

function canStartAnotherTransactionAttempt(params: Readonly<{
    config: TransactionConfig;
    retryDelayMs: number;
    startedAtMs: number;
}>): boolean {
    const elapsedMs = Math.max(0, Date.now() - params.startedAtMs);
    const nextAttemptBudgetMs = params.config.maxWaitMs + params.config.timeoutMs;
    return elapsedMs + params.retryDelayMs + nextAttemptBudgetMs <= params.config.totalRetryBudgetMs;
}

export function isRetryableTransactionError(params: Readonly<{ provider: string; err: unknown }>): boolean {
    // Acquisition-shaped P2028 requires callback-entry context, which only inTx owns.
    if (isTransactionAcquisitionTimeout(params.err)) return false;
    if (isPrismaErrorCode(params.err, "P2034")) return true;

    if (params.provider === "sqlite") {
        if (isRetryableSqliteWriteError(params.err)) return true;
    }

    return false;
}

function readTransactionErrorMessage(error: unknown): string {
    if (error && typeof error === "object" && "meta" in error) {
        const metaError = (error as { meta?: { error?: unknown } }).meta?.error;
        if (typeof metaError === "string") return metaError;
    }
    return error instanceof Error ? error.message : "";
}

export function isTransactionAcquisitionTimeout(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2028")
        && readTransactionErrorMessage(error).toLowerCase().includes("unable to start a transaction");
}

export function isTransactionAcquisitionUnavailableError(
    error: unknown,
): error is TransactionAcquisitionUnavailableError {
    return error instanceof TransactionAcquisitionUnavailableError;
}

export function afterTx(tx: Tx, callback: () => void) {
    // Golden rule:
    // - Do NOT emit socket updates inside a DB transaction.
    // - Instead, schedule them with afterTx so they only fire after commit.
    //
    // `afterTx` is only valid for transactions created via `inTx()`.
    const callbacks = (tx as any)[symbol] as (() => void)[] | undefined;
    if (!callbacks) {
        throw new Error('afterTx(tx, ...) called outside inTx() transaction');
    }
    callbacks.push(callback);
}

function resolveBoundedTransactionOptions(params: Readonly<{
    deadlineAtMs: number;
    maxWaitMs: number;
    timeoutMs: number;
}>): Readonly<{ maxWait: number; timeout: number }> {
    const remainingMs = Math.floor(params.deadlineAtMs - Date.now());
    if (remainingMs < 2) throw new TransactionDeadlineExceededError(null);
    const maxWait = Math.max(1, Math.min(params.maxWaitMs, Math.floor(remainingMs / 3)));
    return {
        maxWait,
        timeout: Math.max(1, Math.min(params.timeoutMs, remainingMs - maxWait)),
    };
}

export function isTransactionDeadlineExceededError(error: unknown): error is TransactionDeadlineExceededError {
    return error instanceof TransactionDeadlineExceededError;
}

export async function inTx<T>(fn: (tx: Tx) => Promise<T>, options: InTxOptions = {}): Promise<T> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const transactionConfig = readTransactionConfigFromEnv(process.env, provider);
    const maxRetries = transactionConfig.maxRetries;
    const startedAtMs = Date.now();
    let counter = 0;
    let transactionCallbackEntered = false;
    let wrapped = async (tx: Tx) => {
        transactionCallbackEntered = true;
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        transactionCallbackEntered = false;
        try {
            const bounded = options.deadlineAtMs === undefined
                ? null
                : resolveBoundedTransactionOptions({
                    deadlineAtMs: options.deadlineAtMs,
                    maxWaitMs: transactionConfig.maxWaitMs,
                    timeoutMs: transactionConfig.timeoutMs,
                });
            const txOpts = provider === "sqlite"
                ? {
                    timeout: bounded?.timeout ?? transactionConfig.timeoutMs,
                    maxWait: bounded?.maxWait ?? transactionConfig.maxWaitMs,
                }
                : {
                    isolationLevel: "Serializable" as const,
                    timeout: bounded?.timeout ?? transactionConfig.timeoutMs,
                    maxWait: bounded?.maxWait ?? transactionConfig.maxWaitMs,
                };
            let result = await db.$transaction(wrapped, txOpts);
            for (let callback of result.callbacks) {
                try {
                    callback();
                } catch {
                    // Ignore callback failures; transactional result is already committed.
                }
            }
            return result.result;
        } catch (e) {
            const acquisitionTimeout = isTransactionAcquisitionTimeout(e) && !transactionCallbackEntered;
            const retryable = acquisitionTimeout || isRetryableTransactionError({ provider, err: e });
            if (
                options.deadlineAtMs !== undefined
                && transactionCallbackEntered
                && (
                    Date.now() >= options.deadlineAtMs
                    || isPrismaErrorCode(e, "P2028")
                )
            ) {
                throw new TransactionDeadlineExceededError(e);
            }
            if (retryable && counter < maxRetries) {
                const nextAttempt = counter + 1;
                const retryDelayMs = resolveTransactionRetryDelayMs(nextAttempt, transactionConfig);
                if (
                    !canStartAnotherTransactionAttempt({
                        config: transactionConfig,
                        retryDelayMs,
                        startedAtMs,
                    })
                ) {
                    if (acquisitionTimeout) {
                        throw new TransactionAcquisitionUnavailableError(e);
                    }
                    throw e;
                }
                if (
                    options.deadlineAtMs !== undefined
                    && Date.now() + retryDelayMs >= options.deadlineAtMs
                ) {
                    throw new TransactionDeadlineExceededError(e);
                }
                counter = nextAttempt;
                await delay(retryDelayMs);
                continue;
            }
            if (acquisitionTimeout) {
                if (options.deadlineAtMs !== undefined) {
                    throw new TransactionDeadlineExceededError(e);
                }
                throw new TransactionAcquisitionUnavailableError(e);
            }
            throw e;
        }
    }
}
