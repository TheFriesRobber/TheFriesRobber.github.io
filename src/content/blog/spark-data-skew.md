---
title: Spark 数据倾斜问题梳理
date: 2020-04-16 12:54:21
description: 数据倾斜通常不是 Spark 本身的 bug，而是数据分布、shuffle 边界和 join key 基数共同作用的结果。本文梳理如何识别、定位和处理 Spark 数据倾斜。
categories: [Spark]
tags: [Spark, Bigdata, Performance]
---

## 问题

Spark 作业中经常会遇到这样一种现象：大部分 task 很快结束，少数几个 task 长时间跑不完，甚至 executor 反复 OOM 或者 shuffle fetch failed。直觉上看，集群资源还有很多，但整个 stage 只能等那几个慢 task。

这类问题很多时候不是资源不够，而是**数据倾斜**：某些 partition 中的数据量明显大于其他 partition，导致同一个 stage 里的 task 负载不均。

## 数据倾斜为什么会发生

Spark 的很多算子都会触发 shuffle，例如 `groupByKey`、`reduceByKey`、`join`、`distinct`、`repartition`。shuffle 之后的数据会按照 partitioner 被分配到不同 partition。默认情况下，key 相同的数据会进入同一个 partition。

如果某些 key 的数据量特别大，例如：

- 某个用户、商家、城市、渠道天然就是热点。
- join key 中存在大量空值、默认值或脏数据。
- 业务时间窗口造成某些分区数据集中爆发。
- 上游数据已经按照某个维度聚集，后续又按相同或相关维度 shuffle。

那么这些 key 所在的 partition 就会比其他 partition 大很多。Spark 的调度单位是 task，而一个 task 通常处理一个 partition，所以这个 partition 会拖慢整个 stage。

## 如何识别倾斜

最直接的方式是看 Spark UI。

在 stage 页面里关注：

- task duration 是否长尾明显。
- shuffle read/write size 是否只有少数 task 特别大。
- records 数量是否集中在少数 task。
- executor 是否只有个别节点频繁 GC 或 OOM。

如果 UI 中看到 90% 的 task 都很快完成，剩下几个 task 的 input records 或 shuffle read size 大出一个数量级，基本就可以判断为倾斜。

也可以在数据层面先做 key 分布抽样：

```scala
df.groupBy("join_key")
  .count()
  .orderBy(desc("count"))
  .show(50, truncate = false)
```

这一步的价值很高。很多时候我们以为是 Spark 参数问题，真正看完 key 分布后会发现是业务数据中有一个非常大的热点 key。

## 常见处理思路

### 1. 先过滤或单独处理异常 key

如果倾斜来自脏数据，例如空字符串、`null`、`unknown`、`-1` 这类默认值，最优先的做法不是调参数，而是明确业务语义：

- 可以过滤就过滤。
- 可以拆到单独流程就单独处理。
- 可以补齐真实 key 就在上游修正。

这种方式最干净，因为它减少的是不必要的数据，而不是把问题往后推。

### 2. 避免使用 `groupByKey`

如果是聚合类逻辑，优先使用带 map-side combine 的算子，比如 `reduceByKey`、`aggregateByKey`，或者 DataFrame API 中的聚合表达式。相比 `groupByKey` 把同一个 key 的所有 value 拉到一起，提前聚合可以减少 shuffle 数据量。

```scala
// 不推荐：把所有 value 拉到 reducer 端
rdd.groupByKey().mapValues(_.sum)

// 推荐：map 端先局部聚合
rdd.reduceByKey(_ + _)
```

如果热点 key 本身极大，这不能完全消除倾斜，但通常能先把数据量压下来。

### 3. 增加 shuffle partition 数量

对于倾斜不严重、只是 partition 太粗的情况，可以提高 `spark.sql.shuffle.partitions` 或 RDD 算子中的 partition 数。

```scala
spark.conf.set("spark.sql.shuffle.partitions", 600)
```

这个方法适合“每个 partition 都偏大”或“倾斜轻微”的场景。它不适合只有一个 key 特别大的场景，因为同一个 key 仍然会被分到同一个 partition。

### 4. 大小表 join 使用 broadcast

如果 join 的一侧足够小，使用 broadcast join 可以避免大表按 join key shuffle。

```scala
import org.apache.spark.sql.functions.broadcast

largeDf.join(broadcast(smallDf), Seq("id"))
```

这类优化特别适合维表 join。需要注意的是，broadcast 的表要能放进 executor 内存，否则会引入新的内存问题。

### 5. 对热点 key 加盐

如果某个 key 特别大，并且必须参与 join 或聚合，可以把热点 key 拆散到多个随机 bucket 中。这通常叫 salting。

以 join 为例，假设大表中 `id = 42` 特别热点：

```scala
import org.apache.spark.sql.functions._

val saltBuckets = 16

val skewedLarge = largeDf.withColumn(
  "salt",
  when(col("id") === 42, floor(rand() * saltBuckets)).otherwise(lit(0))
)

val expandedSmall = smallDf.withColumn(
  "salt",
  when(col("id") === 42, explode(array((0 until saltBuckets).map(lit): _*))).otherwise(lit(0))
)

val joined = skewedLarge.join(expandedSmall, Seq("id", "salt"))
```

加盐的本质是把一个热点 key 拆成多个逻辑 key，从而让它落到多个 partition。代价是小表热点 key 需要复制多份，代码复杂度也会上升。

### 6. 利用 Adaptive Query Execution

Spark SQL 的 Adaptive Query Execution（AQE）可以在运行时根据 shuffle 统计信息处理部分倾斜 join。相关参数包括：

```text
spark.sql.adaptive.enabled
spark.sql.adaptive.skewJoin.enabled
spark.sql.adaptive.skewJoin.skewedPartitionFactor
spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes
```

AQE 很有用，但它不是万能的。它解决的是 Spark SQL 计划中的一部分运行时倾斜问题；如果数据本身有异常 key、业务逻辑选错 join 粒度，仍然需要从数据和逻辑层面处理。

## 排查顺序

我会按这个顺序看：

1. Spark UI 确认是否存在明显 task 长尾。
2. 找到慢 stage 对应的算子和 SQL plan。
3. 看 shuffle read/write size 和 records 分布。
4. 对 join key 或 group key 做 topN 分布统计。
5. 判断是脏数据、热点 key、partition 太少，还是 join 策略不合适。
6. 先改数据和逻辑，再调 Spark 参数。

## 回到问题

Spark 数据倾斜的核心不是“某个 task 慢”，而是**相同 stage 内 task 处理的数据量不均匀**。解决它也不应该只盯着 executor memory 或 core 数量，而要回到 shuffle、key 分布和 join/aggregate 逻辑。

如果只是 partition 过粗，可以增加 shuffle partition；如果是小表 join，可以 broadcast；如果是热点 key，就要考虑过滤、拆分、加盐或 AQE skew join。真正有效的优化，往往来自先理解数据分布，再决定用哪种手段。

参考：

- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Spark RDD Programming Guide](https://spark.apache.org/docs/latest/rdd-programming-guide.html)
