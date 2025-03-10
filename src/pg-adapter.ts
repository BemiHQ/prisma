/* eslint-disable @typescript-eslint/require-await */

import type {
  ColumnType,
  ConnectionInfo,
  DriverAdapter,
  Query,
  Queryable,
  Result,
  ResultSet,
  Transaction,
  TransactionContext,
  TransactionOptions,
} from '@prisma/driver-adapter-utils'
import { Debug, err, ok } from '@prisma/driver-adapter-utils'
// @ts-ignore: this is used to avoid the `Module '"<path>/node_modules/@types/pg/index"' has no default export.` error.
import pg from 'pg'

import { customParsers, fieldToColumnType, fixArrayBufferValues, UnsupportedNativeDataType } from './conversion'

const types = pg.types

const debug = Debug('prisma:driver-adapter:pg')

// PATCH: Import additional things
import { logger } from './logger'
import {
  StdClient,
  TransactionClient,
  EMPTY_RESULT,
  contextToSqlComment,
  sqlCommentToContext,
  isContextComment,
  isWriteQuery,
  isBeginQuery,
  isCommitQuery,
} from './pg-utils'
// PATCH: end

class PgQueryable<ClientT extends StdClient | TransactionClient> implements Queryable {
  readonly provider = 'postgres'
  readonly adapterName = '@prisma/adapter-pg'

  constructor(protected readonly client: ClientT) {}

  /**
   * Execute a query given as SQL, interpolating the given parameters.
   */
  async queryRaw(query: Query): Promise<Result<ResultSet>> {
    const tag = '[js::query_raw]'
    debug(`${tag} %O`, query)

    const res = await this.performIO(query)

    if (!res.ok) {
      return err(res.error)
    }

    const { fields, rows } = res.value
    const columnNames = fields.map((field) => field.name)
    let columnTypes: ColumnType[] = []

    try {
      columnTypes = fields.map((field) => fieldToColumnType(field.dataTypeID))
    } catch (e) {
      if (e instanceof UnsupportedNativeDataType) {
        return err({
          kind: 'UnsupportedNativeDataType',
          type: e.type,
        })
      }
      throw e
    }

    return ok({
      columnNames,
      columnTypes,
      rows,
    })
  }

  /**
   * Execute a query given as SQL, interpolating the given parameters and
   * returning the number of affected rows.
   * Note: Queryable expects a u64, but napi.rs only supports u32.
   */
  async executeRaw(query: Query): Promise<Result<number>> {
    const tag = '[js::execute_raw]'
    debug(`${tag} %O`, query)

    // Note: `rowsAffected` can sometimes be null (e.g., when executing `"BEGIN"`)
    return (await this.performIO(query)).map(({ rowCount: rowsAffected }) => rowsAffected ?? 0)
  }

  /**
   * Run a query against the database, returning the result set.
   * Should the query fail due to a connection error, the connection is
   * marked as unhealthy.
   */
  // PATCH: pass extra argument
  private async performIO(query: Query, catchingUp = false): Promise<Result<pg.QueryArrayResult<any>>> {
  // PATCH: end

    try {
      // PATCH: Call compactPerformIOResult
      const result = await this.compactPerformIOResult(query, catchingUp)
      // PATCH: end
      return ok(result)
    // PATCH: Fix TypeScript errors
    } catch (e: any) {
    // PATCH: end
      const error = e as Error
      debug('Error in performIO: %O', error)
      if (e && typeof e.code === 'string' && typeof e.severity === 'string' && typeof e.message === 'string') {
        return err({
          kind: 'Postgres',
          code: e.code,
          severity: e.severity,
          message: e.message,
          detail: e.detail,
          column: e.column,
          hint: e.hint,
        })
      }
      throw error
    }
  }

  // PATCH: Remove unnnecessary transactions
  private async compactPerformIOResult(query: Query, catchingUp: boolean): Promise<pg.QueryResult> {
    const { sql, args: values } = query
    const transactionClient = this.client as TransactionClient
    const { previousQueries, readyToExecuteTransaction } = transactionClient

    let text = sql

    // Modify the execution
    if (this.client.logQueries && !catchingUp) {
      logger.debug('QUERY:', sql, previousQueries ? previousQueries.length : '')
    }

    // Transaction queries
    if (previousQueries) {
      const isContext = isContextComment(sql)
      const isWrite = isWriteQuery(sql)
      const previousContextComment = previousQueries.find((q) => isContextComment(q.sql))?.sql

      if (previousContextComment && isWrite) {
        text = `${sql} ${contextToSqlComment({ SQL: sql, ...sqlCommentToContext(previousContextComment) })}`
      }

      if (!catchingUp) {
        previousQueries.push(query)
      }

      // Skip accumulated queries or catch up and mark the transaction as ready to execute
      if (!readyToExecuteTransaction) {
        // Skip accumulated BEGIN
        if (isBeginQuery(sql) && previousQueries.length === 1) return EMPTY_RESULT

        // Skip accumulated COMMIT
        if (isCommitQuery(sql) && previousContextComment && previousQueries.length === 4) return EMPTY_RESULT

        // Catch up and continue the entire transaction
        if (
          (previousQueries.length === 2 && !isContext) ||
          (previousQueries.length === 3 && !isWrite)
        ) {
          transactionClient.readyToExecuteTransaction = true
          for(const prevQuery of previousQueries.slice(0, previousQueries.length - 1)) {
            await this.performIO(prevQuery as Query, true)
          }
        }
      }

      // Skip accumulated context
      if (isContextComment(sql)) return EMPTY_RESULT
    }

    // Log modified queries
    if (this.client.logQueries) {
      logger.log(`${logger.tags['info'] ?? ''}`, text)
    }

    const result = await this.client.query(
      {
        text,
        values: fixArrayBufferValues(values),
        rowMode: 'array',
        types: {
          // This is the error expected:
          // No overload matches this call.
          // The last overload gave the following error.
          // Type '(oid: number, format?: any) => (json: string) => unknown' is not assignable to type '{ <T>(oid: number): TypeParser<string, string | T>; <T>(oid: number, format: "text"): TypeParser<string, string | T>; <T>(oid: number, format: "binary"): TypeParser<...>; }'.
          //   Type '(json: string) => unknown' is not assignable to type 'TypeParser<Buffer, any>'.
          //     Types of parameters 'json' and 'value' are incompatible.
          //       Type 'Buffer' is not assignable to type 'string'.ts(2769)
          //
          // Because pg-types types expect us to handle both binary and text protocol versions,
          // where as far we can see, pg will ever pass only text version.
          //
          // @ts-expect-error
          getTypeParser: (oid: number, format: binary) => {
            if (format === 'text' && customParsers[oid]) {
              return customParsers[oid]
            }

            return types.getTypeParser(oid, format)
          },
        },
      },
      fixArrayBufferValues(values),
    )

    return result
  }
  // PATCH: end
}

class PgTransaction extends PgQueryable<TransactionClient> implements Transaction {
  // PATCH: Fix TypeScript errors
  constructor(client: TransactionClient, readonly options: TransactionOptions) {
  // PATCH: end
    super(client)
  }

  async commit(): Promise<Result<void>> {
    debug(`[js::commit]`)

    this.client.release()
    return ok(undefined)
  }

  async rollback(): Promise<Result<void>> {
    debug(`[js::rollback]`)

    this.client.release()
    return ok(undefined)
  }
}

class PgTransactionContext extends PgQueryable<TransactionClient> implements TransactionContext {
  constructor(readonly conn: TransactionClient) {
    super(conn)
  }

  async startTransaction(): Promise<Result<Transaction>> {
    const options: TransactionOptions = {
      usePhantomQuery: false,
    }

    const tag = '[js::startTransaction]'
    debug('%s options: %O', tag, options)

    return ok(new PgTransaction(this.conn, options))
  }
}

export type PrismaPgOptions = {
  schema?: string
}

export class PrismaPg extends PgQueryable<StdClient> implements DriverAdapter {
  // PATCH: Add logQueries
  logQueries: boolean

  constructor(
    client: pg.Pool,
    private options?: PrismaPgOptions,
    { logQueries }: { logQueries?: boolean } = {}
  ) {
  // PATCH: end

    // PATCH: Ignore type checking
    if (false) {
    // PATCH: end
      throw new TypeError(`PrismaPg must be initialized with an instance of Pool:
import { Pool } from 'pg'
const pool = new Pool({ connectionString: url })
const adapter = new PrismaPg(pool)
`)
    }

    // PATCH: Add logQueries
    const standardClient = client as StdClient
    standardClient.logQueries = logQueries || false
    super(standardClient)
    this.logQueries = standardClient.logQueries
    // PATCH: end
  }

  getConnectionInfo(): Result<ConnectionInfo> {
    return ok({
      schemaName: this.options?.schema,
    })
  }

  async transactionContext(): Promise<Result<TransactionContext>> {
    // PATCH: Customize connection
    const conn = await this.client.connect() as TransactionClient
    conn.previousQueries = []
    conn.logQueries = this.logQueries
    conn.readyToExecuteTransaction = false
    // PATCH: end

    return ok(new PgTransactionContext(conn))
  }
}
