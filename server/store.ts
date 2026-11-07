import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { z } from 'zod';
import type { eventInput } from './domain';

export const table = process.env.TABLE!;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
export type Event = z.infer<typeof eventInput> & { pk: string; kind: 'event'; id: string; reserved: number; sold: number; rev: number };
export type Order = {
  pk: string; kind: 'order'; id: string; eventId: string; quantity: number; email: string; amount: number;
  statusToken: string; state: 'creating' | 'pending' | 'paid' | 'expired' | 'refunded'; created: number;
  rev: number; checked: number; refunded: number; providerId?: string; url?: string; paidAt?: string;
  tickets?: string[]; review?: boolean;
};
export type Ticket = { pk: string; kind: 'ticket'; eventId: string; orderId: string; checkedAt?: string };
export type Refund = { pk: string; kind: 'refund'; orderId: string; eventId: string; providerId: string; amount: number; completedAt: string };
export type Mail = { pk: string; kind: 'mail'; orderId: string; created: number; lease?: number; sent?: boolean };

export async function get<T>(pk: string): Promise<T | undefined> {
  return (await db.send(new GetCommand({ TableName: table, Key: { pk }, ConsistentRead: true }))).Item as T | undefined;
}

export async function* records<T>(kind: string) {
  let start: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new ScanCommand({
      TableName: table, ExclusiveStartKey: start, FilterExpression: 'kind = :kind',
      ExpressionAttributeValues: { ':kind': kind },
    }));
    for (const item of page.Items ?? []) yield item as T;
    start = page.LastEvaluatedKey;
  } while (start);
}

type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export const put = <T extends { pk: string }>(item: T) => ({ Put: {
  TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)',
} });
export const replace = <T extends { pk: string; rev: number }>(item: T) => ({ Put: {
  TableName: table, Item: { ...item, rev: item.rev + 1 }, ConditionExpression: 'rev = :rev',
  ExpressionAttributeValues: { ':rev': item.rev },
} });
export const update = (pk: string, expression: string, condition: string, values: Record<string, unknown>) => ({
  Update: { TableName: table, Key: { pk }, UpdateExpression: expression,
    ConditionExpression: condition, ExpressionAttributeValues: values },
});
export const transact = (...items: Write[]) => db.send(new TransactWriteCommand({ TransactItems: items }));
export const conflict = (error: unknown) => error instanceof Error && error.name === 'TransactionCanceledException'
  && (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.some(reason =>
    reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict');
