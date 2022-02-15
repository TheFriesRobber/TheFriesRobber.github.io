---
title: Apache Spark资源管理以及YARN中的应用模型
date: 2020-04-12 23:26:01
description: 本文将对Apache Spark中的资源管理进行梳理，并且分析Apache Spark通过YARN进行资源管理时的应用模型
categories: [Spark, Yarn]
tags: [Spark, Bigdata]
---

# 问题
Apache Spark应用的架构是咋样的？和MapReduce有啥区别？Apache Spark应用是如何利用Yarn进行管理的？

# Spark 和 MapReduce的一些对比
## Applications
MapReduce中最高level的单位是job，整个过程是加载数据，执行map function，shuffle数据，执行reduce function，最后把数据写回存储。

而Spark中，最高level的单位是Application，一个application包含多个job，一个job可以划分成多个stage， 然后多个stage中会有多个tasks。

另外，一个Spark Application对应一个SparkContext实例（一个JVM建议只有一个SparkContext，后面会另写一篇关于sparksession和sparkcontext），这个application可以用来执行一个batch job，或者交互式的执行多个job。不同于MapReduce，一个Spark Application会拥有多个进程（通过向resource manager申请），也叫做**Executors**。这些进程会存在于cluster内即使没有job在跑。**这就意味着1. 数据可以存在于内存，方便access 2. 避免创建进程的开销。**

## Executors
Spark application的executor中又可以有多个thread（core）同时并发的跑任务。不过像这样的资源占用对整个cluster来说非常不友好，我们可以利用**dynamic allocation** [^1]（如Yarn中提供的container resizing）去动态的获取和归还资源。

## Driver
Spark Application通过一个driver来管理job flow和调度tasks。 通常driver进程和client进程是同一个，不过在YARN mode下，driver可以在YARN container里（--deploy-mode client / cluster）。driver中有很多重要的组件，如DAG构造，任务编排，执行计划生成等，这里暂时不展开。

## 支持多种resource management
Spark支持YARN，Mesons，Standalone，Kubernetes。所有这些frameworks都具备两种功能的组件：1. 一个主控服务，控制哪个applicaton可以启动executor，在哪里和什么时候跑（YARN ResourceManager，Mesos master，spark standalone master, K8s master processers in master node）2. 一个跑在每一个node上的从服务用来启动executor进程和监控他们是否存活和资源消耗（YARN NodeManager，Mesos slave，spark standalone master，K8s worker processes）

# Running on Yarn
## cluster mode
- client向Resource Manager为app master提交申请，app master生成后，client就可以退出了
- app master由Node Manager启动，driver此时由app master运行在同一个YARN container中
- app master向Resource Manager申请资源，启动spark executors
- driver编排任务，直接与executor交流执行tasks

<figure>
  <img
  src="spark-yarn-cluster-mode.png"
  alt="Spark YARN cluster mode">
  <figcaption>Spark YARN cluster mode</figcaption>
</figure>

## client mode
- client向Resource Manager为app master提交申请，此时driver由client运行在client进程中
- app master由Node Manager启动，此时仅仅用于申请cluster资源
- app master向Resource Manager申请资源，启动spark executors
- driver编排任务，直接与executor交流执行tasks

<figure>
  <img
  src="spark-yarn-client-mode.png"
  alt="Spark YARN client mode">
  <figcaption>Spark YARN client mode</figcaption>
</figure>

## Key differences

|           | YARN Cluster | YARN Client | Spark Standalone |
| ------- | -------------- | ---------------------------- | ----------------------------------- |
| Driver runs in: | Application Master | Client | Client |
| Who requests resources? | YARN NodeManager | YARN NodeManager | Spark Slave |
| PersistentServices | YARN NodeManager and NodeManagers | YARN NodeManager and NodeManagers | Spark Master and Workers |
| Supports Spark Shell? | No | Yes | Yes |

## Spark on YARN的几点优势
- YARN cluster可以不需要任何配置同时跑多个Spark以外的frameworkjob，如MapReduce，Impala query，Tez，Pig。
- 可以利用YARN的shceduler[^2]做分类，隔离和设置优先级。
- Security。可以通过kerberos令牌来支持executor之间的验证。


[^1]: https://spark.apache.org/docs/latest/configuration.html#dynamic-allocation
[^2]: http://hadoop.apache.org/docs/r2.4.0/hadoop-yarn/hadoop-yarn-site/FairScheduler.html