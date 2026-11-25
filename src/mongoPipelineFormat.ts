export const mongoPipelineOperators = {
  $match: "{}",
  $project: '{"_id": 1}',
  $group: '{"_id": null, "count": {"$sum": 1}}',
  $sort: '{"_id": 1}',
  $limit: "10",
  $skip: "1",
  $count: '"count"',
  $unwind: '{"path": "$items"}',
  $addFields: '{"value": 1}',
  $set: '{"value": 1}',
  $unset: '"field"',
  $replaceRoot: '{"newRoot": "$document"}',
  $replaceWith: '"$document"',
  $sample: '{"size": 10}',
  $sortByCount: '"$category"',
  $bucket: '{"groupBy": "$value", "boundaries": [0, 10, 20], "default": "other"}',
  $bucketAuto: '{"groupBy": "$value", "buckets": 5}',
  $setWindowFields: '{"sortBy": {"_id": 1}, "output": {"rank": {"$documentNumber": {}}}}',
  $lookup: '{"from": "collection", "localField": "key", "foreignField": "key", "as": "joined"}',
  $facet: '{"summary": [{"$count": "count"}]}',
  $unionWith: '"collection"',
} as const;

export type MongoOperator = keyof typeof mongoPipelineOperators;
export type MongoStage = { operator: MongoOperator; expression: string; enabled: boolean };
export type MongoPipelineSummary = { id: string; name: string; revision: number };
export type SavedMongoPipeline = MongoPipelineSummary & { stages: MongoStage[] };
export const mongoStageLimit = 24;
const format = "stackport.mongo-pipeline";
export const pipelineExchangeLimit = 1024 * 1024;

export function encodeMongoPipeline(stages: MongoStage[]) {
  return JSON.stringify({ format, version: 1, stages }, null, 2);
}

export function decodeMongoPipeline(text: string): MongoStage[] {
  if (text.length > pipelineExchangeLimit) throw new Error("파이프라인 JSON은 1 MiB 이하여야 합니다.");
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("파이프라인 JSON 형식을 확인하세요."); }
  if (value?.format !== format || value.version !== 1 || !Array.isArray(value.stages) ||
    value.stages.length < 1 || value.stages.length > mongoStageLimit) {
    throw new Error("StackPort 파이프라인 JSON에는 1~24단계가 필요합니다.");
  }
  const encoder = new TextEncoder();
  let bytes = 0;
  return value.stages.map((stage: Partial<MongoStage> | null, index: number) => {
    if (!stage || typeof stage.operator !== "string" || !Object.hasOwn(mongoPipelineOperators, stage.operator) ||
      typeof stage.enabled !== "boolean" || typeof stage.expression !== "string") {
      throw new Error(`${index + 1}단계의 연산자, 활성화 여부와 JSON 값을 확인하세요.`);
    }
    const size = encoder.encode(stage.expression).length;
    if (size > 16 * 1024) throw new Error(`${index + 1}단계의 JSON은 16 KiB 이하여야 합니다.`);
    bytes += size;
    if (bytes > 128 * 1024) throw new Error("파이프라인 JSON 합계는 128 KiB 이하여야 합니다.");
    return { operator: stage.operator, expression: stage.expression, enabled: stage.enabled };
  });
}
