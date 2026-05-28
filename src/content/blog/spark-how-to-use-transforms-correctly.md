---
title: Spark Transformations 应该怎么用
date: 2020-04-18 14:22:35
description: Spark transformations 是惰性求值的逻辑描述。理解 narrow/wide dependency、shuffle 边界和 actions 触发时机，是写出稳定 Spark 作业的基础。
categories: [Spark]
tags: [Spark, Bigdata, RDD]
---

## 问题

Spark 里的 `map`、`filter`、`flatMap`、`reduceByKey`、`join` 都叫 transformation。它们看起来像是在“执行计算”，但实际上大多数时候只是记录一段计算逻辑。真正触发执行的是 action，比如 `count`、`collect`、`save`。

如果没有理解这一点，很容易写出看似简单、实际代价很高的代码：

```scala
val parsed = raw.map(parse)
println(parsed.count())
println(parsed.filter(_.isValid).count())
```

这里 `parsed` 并不会因为第一行 `map` 就被物化。两个 action 会分别触发 lineage 重新计算。如果 `parse` 很重，就会被执行两遍，除非显式 cache/persist。

## Transformation 是逻辑，不是立即执行

Spark 的 transformation 是 lazy 的。每次调用 transformation，Spark 会构建一段 lineage，也就是“这个 RDD/DataFrame 如何从上游数据计算出来”。

好处是 Spark 可以：

- 把多个连续操作合并成一个 stage。
- 根据依赖关系决定 task 如何划分。
- 在部分数据丢失时通过 lineage 重新计算。
- 对 DataFrame/Dataset 做逻辑计划和物理计划优化。

代价是：代码里的每一行 transformation 不等于一次真实执行。真正执行发生在 action。

## Narrow dependency 和 wide dependency

理解 transformation 的关键，是区分 narrow dependency 和 wide dependency。

### Narrow dependency

一个父 partition 最多被一个子 partition 使用，通常不需要 shuffle。

常见例子：

- `map`
- `filter`
- `flatMap`
- `mapPartitions`
- `union`

这些操作一般可以 pipeline 在同一个 stage 中，开销相对可控。

### Wide dependency

一个父 partition 会被多个子 partition 使用，通常需要 shuffle。

常见例子：

- `groupByKey`
- `reduceByKey`
- `join`
- `distinct`
- `repartition`
- DataFrame 的 `groupBy`、`orderBy`、部分 join

wide dependency 会形成 stage 边界，也会引入网络、磁盘和序列化开销。Spark 性能问题里，shuffle 往往是最重要的观察点。

## 常见误区

### 1. 滥用 `collect`

`collect` 会把所有数据拉回 driver。它适合小数据调试，不适合正式链路。

```scala
// 危险：数据大时 driver 容易 OOM
val all = df.collect()

// 更适合调试
df.show(20, truncate = false)
df.limit(100).collect()
```

如果确实要把结果落地，优先写到分布式存储，而不是回收集到 driver。

### 2. 用 `groupByKey` 做聚合

如果目标是求和、计数、取最大值，优先使用可以 map-side combine 的操作。

```scala
// 不推荐
rdd.groupByKey().mapValues(_.sum)

// 推荐
rdd.reduceByKey(_ + _)
```

`groupByKey` 会把同一个 key 的所有 value 传到 reducer 端，网络和内存压力都更大。

### 3. 在循环里触发 action

```scala
keys.foreach { key =>
  println(df.filter($"id" === key).count())
}
```

这类写法会启动多个 Spark job。更好的方式通常是把条件表达成一次分布式计算：

```scala
df.groupBy("id").count()
```

如果必须逐个处理，也要确认每次 action 的代价是可接受的。

### 4. 不必要的 repartition

`repartition` 会触发 shuffle。它可以改善并行度，也可以制造额外开销。

常见建议：

- 输入 partition 太少时，可以适当 `repartition`。
- 只想减少 partition 数量时，优先考虑 `coalesce`。
- 写文件前可以根据目标文件大小调整 partition。
- 不要把 `repartition` 当成性能问题的默认解法。

### 5. cache 后不复用

`cache`/`persist` 适合“同一份中间结果被多个 action 或多个下游分支复用”的场景。

```scala
val cleaned = raw.map(parse).filter(_.isValid).persist()

val total = cleaned.count()
val byType = cleaned.map(x => (x.kind, 1)).reduceByKey(_ + _)
```

如果中间结果只被使用一次，cache 只会增加内存压力。cache 后也要注意合适的 unpersist 时机。

## DataFrame API 的额外注意点

DataFrame/Dataset 会经过 Catalyst optimizer 优化。相比手写 RDD transformation，DataFrame 通常能得到更好的执行计划，比如 predicate pushdown、column pruning、join strategy selection。

所以在结构化数据场景下，优先考虑：

- 用 DataFrame 表达过滤、聚合、join。
- 避免过早转成 RDD。
- 避免在 UDF 中隐藏太多逻辑，让 optimizer 无法理解。
- 多看 `explain("formatted")`，确认是否发生了不必要的 shuffle。

```scala
df.explain("formatted")
```

## 写 transformation 的检查清单

我一般会问自己几个问题：

1. 这个 transformation 会不会触发 shuffle？
2. 这个中间结果是否会被多个 action 复用？
3. 有没有把大数据拉到 driver？
4. partition 数量是否和数据量、集群资源匹配？
5. 能不能用 DataFrame API 表达，让 Catalyst 做优化？
6. action 的数量是否符合预期？

## 回到问题

Spark transformation 的正确使用方式，不是追求把所有逻辑写成一串链式调用，而是理解这串调用会形成怎样的执行图。

narrow transformation 适合 pipeline，wide transformation 要重点关注 shuffle；action 会触发真实执行，多个 action 可能重复计算；cache 适合复用，不适合“看起来会更快”的心理安慰。写 Spark 作业时，多看 Spark UI 和 `explain`，比盲目调 executor 参数更可靠。

参考：

- [Spark RDD Programming Guide](https://spark.apache.org/docs/latest/rdd-programming-guide.html)
- [Spark SQL Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
