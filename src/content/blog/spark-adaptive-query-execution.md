---
title: Spark Adaptive Query Execution 简记
date: 2022-02-17 17:23:10
description: Adaptive Query Execution 让 Spark SQL 可以根据运行时统计信息调整物理计划，常见能力包括合并 shuffle partition、处理倾斜 join、动态调整 join 策略。
categories: [Spark]
tags: [Spark, Bigdata, SQL, Performance]
---

## 问题

Spark SQL 在执行前会通过 Catalyst optimizer 生成逻辑计划和物理计划。但很多优化依赖数据规模和分布，而这些信息在提交 query 时未必准确。

例如：

- 过滤条件执行后，实际数据量远小于统计信息。
- 某些 join key 极度倾斜，少数 partition 远大于其他 partition。
- `spark.sql.shuffle.partitions` 设得偏大，导致产生大量小 task。
- 原计划选择 sort merge join，但运行时发现一侧数据已经足够小，可以 broadcast。

Adaptive Query Execution（AQE）解决的就是这个问题：**在 query 运行过程中，根据 shuffle 阶段产生的真实统计信息，重新优化后续执行计划。**

## AQE 解决什么

AQE 主要关注 Spark SQL/DataFrame 的物理执行计划。它不是 RDD API 的通用优化器，也不是自动解决所有性能问题的开关。

常见能力包括：

### 1. 合并 shuffle partitions

很多作业会把 `spark.sql.shuffle.partitions` 设得比较大，避免大数据场景下 partition 过粗。但当实际数据量很小时，过多 partition 会造成大量小 task，调度开销反而明显。

AQE 可以根据 shuffle 输出大小，把相邻的小 partition 合并，减少 task 数量。

相关配置：

```text
spark.sql.adaptive.enabled
spark.sql.adaptive.coalescePartitions.enabled
spark.sql.adaptive.advisoryPartitionSizeInBytes
```

这类优化通常比较安全，因为它是在 shuffle 之后减少后续 task 数量。

### 2. 动态调整 join 策略

Spark 生成物理计划时，会根据统计信息选择 join 策略，比如 sort merge join、broadcast hash join、shuffle hash join。

如果运行时发现某一侧 shuffle 后的数据量很小，AQE 可以把原来的 sort merge join 改成 broadcast join，从而减少后续 shuffle 和 sort 的开销。

相关配置：

```text
spark.sql.adaptive.enabled
spark.sql.autoBroadcastJoinThreshold
spark.sql.adaptive.localShuffleReader.enabled
```

注意，broadcast join 仍然需要考虑 executor 内存。如果被 broadcast 的数据并不小，只是统计信息不准，可能会引入新的内存压力。

### 3. 处理 skew join

数据倾斜时，某些 shuffle partition 会特别大。AQE 可以识别明显大于其他 partition 的 skewed partition，并把它拆成更小的分片处理。

相关配置：

```text
spark.sql.adaptive.skewJoin.enabled
spark.sql.adaptive.skewJoin.skewedPartitionFactor
spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes
```

这个能力适合处理运行时才能看清的数据倾斜。不过它仍然依赖 SQL/DataFrame 的执行计划，也不能替代对异常 key、脏数据和业务 join 粒度的治理。

## 如何打开

在 Spark SQL 场景中，一般先打开 AQE：

```scala
spark.conf.set("spark.sql.adaptive.enabled", "true")
```

然后根据具体问题再调整细项。很多版本中 AQE 已经默认打开，但生产环境仍建议显式确认配置，避免不同 Spark 版本或平台默认值不同。

提交参数可以这样写：

```bash
spark-submit \
  --conf spark.sql.adaptive.enabled=true \
  --conf spark.sql.adaptive.coalescePartitions.enabled=true \
  --conf spark.sql.adaptive.skewJoin.enabled=true \
  ...
```

## 怎么确认 AQE 是否生效

最直接的方式是看 Spark UI 和执行计划。

在 SQL tab 中，可以看到 adaptive plan。执行过程中，plan 可能从 initial plan 变成 final plan。你可以关注：

- 是否出现 `AdaptiveSparkPlan`。
- join 类型是否发生变化。
- shuffle partition 数量是否减少。
- skewed partition 是否被拆分。
- stage 数量和 task 数是否符合预期。

代码里也可以用：

```scala
df.explain("formatted")
```

但要注意，AQE 的最终计划依赖运行时统计信息。只看执行前的 explain，可能看不到最终变化。

## AQE 不是万能药

AQE 很适合解决“运行时数据规模和分布与预估不同”的问题，但它不应该变成忽略建模和数据质量的理由。

几个边界：

- 如果 join key 设计本身有问题，AQE 只能缓解，不能修正业务逻辑。
- 如果数据中有大量 `null`、默认值、脏 key，最好先治理数据。
- 如果 UDF 让优化器无法理解过滤和表达式，AQE 能做的事情会变少。
- 如果输入文件本身极度碎片化，AQE 主要作用在 shuffle 之后，仍然需要处理小文件问题。
- 如果资源配置过小，AQE 不能凭空创造 executor memory。

## 一个实践顺序

我通常会这样用 AQE：

1. 先打开 `spark.sql.adaptive.enabled`。
2. 保持一个相对保守的 `spark.sql.shuffle.partitions`，让 AQE 有合并空间。
3. 对 SQL/DataFrame 作业观察 Spark UI 中的 adaptive plan。
4. 如果主要问题是小 task，重点看 coalesce partitions。
5. 如果主要问题是 join 慢，重点看 join strategy 是否发生变化。
6. 如果主要问题是 task 长尾，结合 key 分布和 skew join 配置一起看。

## 回到问题

AQE 的价值在于，它让 Spark SQL 不必完全依赖执行前的估算，而可以根据运行时 shuffle 统计信息修正后续计划。对真实生产数据来说，这非常重要，因为数据规模、过滤选择率和 key 分布经常不是静态的。

但 AQE 更像一个运行时优化层，而不是性能问题的总开关。打开它之后，仍然要看 Spark UI、理解 query plan、检查数据分布。能用数据建模解决的问题，不要只交给参数；能让优化器理解的逻辑，不要过早藏进 UDF。

参考：

- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
