---
title: 如何查看linux进程占用的内存资源
date: 2020-04-10 17:12:50
description: 本文简单介绍linux进程相关的内存占用情况，VSS/RSS/PSS/USS
categories: [Linux]
tags: [Linux, Process]
---

# 问题
最近在分析一个线上java程序performance和资源占用情况的时候，遇到了一些关于linux进程中内存查看的问题，遂总结一下。

# Jargon Time

> VSS (reported as VSZ from ps) is the total accessible address space of a process. This size also includes memory that may not be resident in RAM like mallocs that have been allocated but not written to. VSS is of very little use for determing real memory usage of a process.
>
> RSS is the total memory actually held in RAM for a process. RSS can be misleading, because it reports the total all of the shared libraries that the process uses, even though a shared library is only loaded into memory once regardless of how many processes use it. RSS is not an accurate representation of the memory usage for a single process.
>
> PSS differs from RSS in that it reports the proportional size of its shared libraries, i.e. if three processes all use a shared library that has 30 pages, that library will only contribute 10 pages to the PSS that is reported for each of the three processes. PSS is a very useful number because when the PSS for all processes in the system are summed together, that is a good representation for the total memory usage in the system. When a process is killed, the shared libraries that contributed to its PSS will be proportionally distributed to the PSS totals for the remaining processes still using that library. In this way PSS can be slightly misleading, because when a process is killed, PSS does not accurately represent the memory returned to the overall system.
>
> USS is the total private memory for a process, i.e. that memory that is completely unique to that process. USS is an extremely useful number because it indicates the true incremental cost of running a particular process. When a process is killed, the USS is the total memory that is actually returned to the system. USS is the best number to watch when initially suspicious of memory leaks in a process.

## VSS
一个进程被分配的所有虚拟内存，包括了已经被映射到物理内存和还没有映射的部分。也包含了共享库占用的内存。

对于实际分析一个进程的真实内存占用意义不大。

## RSS
一个进程目前所占的物理内存大小 + 共享库占用的内存，因此不能精确的表示一个进程所占内存。

## PSS
一个进程目前所占的物理内存大小 + 共享库占用的内存 / 进程数量。

## USS
一个进程真正占用的物理内存。但我们遇到可疑地内存泄漏时，USS是我们最应该关心的。

# 如何查看
RSS和VSS可以通过 `ps` 来查看（vsz == VSS）
```
ps -p [pid] -o rss,vsz
```
USS可以借助 `pmap` 来查看
```
pmap -d [pid]
```
- mapped 表示该进程映射的虚拟地址空间大小，也就是该进程预先分配的虚拟内存大小，即ps出的vsz 
- writeable/private 表示进程所占用的私有地址空间大小，也就是该进程实际使用的内存大小 
- shared 表示进程和其他进程共享的内存大小
