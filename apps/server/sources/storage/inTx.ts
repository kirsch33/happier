import { parseIntEnv } from "@/config/env";
import { delay } from "@/utils/runtime/delay";
import { db } from "@/storage/db";
import { getDbProviderFromEnv, isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";
import { isRetryableSqliteWriteError } from "@/storage/sqliteRetryClassifier";

export type Tx = TransactionClient;

const symbol = Symbol();

type TransactionConfig = Readonly<{
    maxRetries: number;
    maxWaitMs: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    timeoutMs: number;
    totalRetryBudgetMs: number;
}>;

const DEFAULT_POSTGRES_TRANSACTION_MAX_RETRIES = 3;
const DEFAULT_POSTGRES_TRANSACTION_MAX_WAIT_MS = 2_000;
const DEFAULT_POSTGRES_TRANSACTION_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_POSTGRES_TRANSACTION_RETRY_MAX_DELAY_MS = 800;
const DEFAULT_POSTGRES_TRANSACTION_TIMEOUT_MS = 10_000;
const DEFAULT_POSTGRES_TRANSACTION_TOTAL_RETRY_BUDGET_MS = 25_000;

const DEFAULT_SQLITE_TRANSACTION_MAX_RETRIES = 8;
const DEFAULT_SQLITE_TRANSACTION_MAX_WAIT_MS = 5_000;
const DEFAULT_SQLITE_TRANSACTION_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_SQLITE_TRANSACTION_RETRY_MAX_DELAY_MS = 800;
const DEFAULT_SQLITE_TRANSACTION_TIMEOUT_MS = 10_000;
// Keep default inTx retry scheduling inside request/client timeout envelopes; raise via env only for known background paths.
const DEFAULT_SQLITE_TRANSACTION_TOTAL_RETRY_BUDGET_MS = 25_000;

function readTransactionConfigFromEnv(
    env: NodeJS.ProcessEnv,
    defaults: TransactionConfig,
): TransactionConfig {
    const retryBaseDelayMs = parseIntEnv(
        env.HAPPIER_DB_TX_RETRY_BASE_DELAY_MS ?? env.HAPPY_DB_TX_RETRY_BASE_DELAY_MS,
        defaults.retryBaseDelayMs,
        { min: 0, max: 60_000 },
    );

    return {
        maxRetries: parseIntEnv(
            env.HAPPIER_DB_TX_MAX_RETRIES ?? env.HAPPY_DB_TX_MAX_RETRIES,
            defaults.maxRetries,
            { min: 0, max: 100 },
        ),
        maxWaitMs: parseIntEnv(
            env.HAPPIER_DB_TX_MAX_WAIT_MS ?? env.HAPPY_DB_TX_MAX_WAIT_MS,
            defaults.maxWaitMs,
            { min: 1_000, max: 600_000 },
        ),
        retryBaseDelayMs,
        retryMaxDelayMs: parseIntEnv(
            env.HAPPIER_DB_TX_RETRY_MAX_DELAY_MS ?? env.HAPPY_DB_TX_RETRY_MAX_DELAY_MS,
            defaults.retryMaxDelayMs,
            { min: retryBaseDelayMs, max: 600_000 },
        ),
        timeoutMs: parseIntEnv(
            env.HAPPIER_DB_TX_TIMEOUT_MS ?? env.HAPPY_DB_TX_TIMEOUT_MS,
            defaults.timeoutMs,
            { min: 1_000, max: 600_000 },
        ),
        totalRetryBudgetMs: parseIntEnv(
            env.HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS ?? env.HAPPY_DB_TX_TOTAL_RETRY_BUDGET_MS,
            defaults.totalRetryBudgetMs,
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
    if (isPrismaErrorCode(params.err, "P2034")) return true;

    if (params.provider === "sqlite") {
        if (isRetryableSqliteWriteError(params.err)) return true;
    }

    return false;
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

export async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const provider = getDbProviderFromEnv(process.env, "postgres");
    const transactionConfig = readTransactionConfigFromEnv(process.env, provider === "sqlite"
        ? {
            maxRetries: DEFAULT_SQLITE_TRANSACTION_MAX_RETRIES,
            maxWaitMs: DEFAULT_SQLITE_TRANSACTION_MAX_WAIT_MS,
            retryBaseDelayMs: DEFAULT_SQLITE_TRANSACTION_RETRY_BASE_DELAY_MS,
            retryMaxDelayMs: DEFAULT_SQLITE_TRANSACTION_RETRY_MAX_DELAY_MS,
            timeoutMs: DEFAULT_SQLITE_TRANSACTION_TIMEOUT_MS,
            totalRetryBudgetMs: DEFAULT_SQLITE_TRANSACTION_TOTAL_RETRY_BUDGET_MS,
        }
        : {
            maxRetries: DEFAULT_POSTGRES_TRANSACTION_MAX_RETRIES,
            maxWaitMs: DEFAULT_POSTGRES_TRANSACTION_MAX_WAIT_MS,
            retryBaseDelayMs: DEFAULT_POSTGRES_TRANSACTION_RETRY_BASE_DELAY_MS,
            retryMaxDelayMs: DEFAULT_POSTGRES_TRANSACTION_RETRY_MAX_DELAY_MS,
            timeoutMs: DEFAULT_POSTGRES_TRANSACTION_TIMEOUT_MS,
            totalRetryBudgetMs: DEFAULT_POSTGRES_TRANSACTION_TOTAL_RETRY_BUDGET_MS,
        });
    const startedAtMs = Date.now();
    let counter = 0;
    let wrapped = async (tx: Tx) => {
        (tx as any)[symbol] = [];
        let result = await fn(tx);
        let callbacks = (tx as any)[symbol] as (() => void)[];
        return { result, callbacks };
    }
    while (true) {
        try {
            const txOpts = provider === "sqlite"
                ? { timeout: transactionConfig.timeoutMs, maxWait: transactionConfig.maxWaitMs }
                : { isolationLevel: "Serializable" as const, timeout: transactionConfig.timeoutMs, maxWait: transactionConfig.maxWaitMs };
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
            if (isRetryableTransactionError({ provider, err: e }) && counter < transactionConfig.maxRetries) {
                const nextAttempt = counter + 1;
                const retryDelayMs = resolveTransactionRetryDelayMs(nextAttempt, transactionConfig);
                if (
                    !canStartAnotherTransactionAttempt({
                        config: transactionConfig,
                        retryDelayMs,
                        startedAtMs,
                    })
                ) {
                    throw e;
                }
                counter = nextAttempt;
                await delay(retryDelayMs);
                continue;
            }
            throw e;
        }
    }
}
