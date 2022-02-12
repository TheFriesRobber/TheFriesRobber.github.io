---
title: Docker Image中为什么要用tini作为入口
date: 2020-01-16 07:33:21
description: tini是什么？为什么要用tini作为container的入口？
categories: Docker
tags: [Docker, Process, Linux, TechNotes]
---

# 问题
之前在看到jupyter notebook的dockerfile的时候经常看到


    ENTRYPOINT ["tini", "-g", "--"]
    CMD ["start.sh"]

非常好奇这个是啥，便查看查看tini的文档，其中写了三个benefits
> 1. It protects you from software that accidentally creates zombie processes, which can (over time!) starve your entire system for PIDs (and make it unusable).
> 2. It ensures that the default signal handlers work for the software you run in your Docker image. For example, with Tini, SIGTERM properly terminates your process even if you didn't explicitly install a signal handler for it.
> 3. It does so completely transparently! Docker images that work without Tini will work with Tini without any changes.

这主要是有两点：防止僵尸进程 & 传递系统信号量。要更好的理解这两点，让我们先review一下关于进程和系统信号量。

# linux系统中的进程
进程是运行中的程序，是分配资源的基本单位。进程实体由PCB（Process Control Block, **linux中是一个叫task_struct的结构体**），程序段，数据组成。

PCB中包含
- 进程描述信息
    - pid
    - uid
- 进程控制和管理信息
    - CPU，Disk，Network使用情况
    - 进程当前状态
- 资源分配清单
    - 使用的文件
    - 使用的内存区域
    - IO设备
- 各种寄存器的值

理解僵尸进程，就要重点关注一下这里的进程状态。

## 进程状态 [^1]

``` c task_state https://github.com/torvalds/linux/blob/master/fs/proc/array.c#L117 linux/fs/proc/array.c 

/*
 * The task state array is a strange "bitmap" of
 * reasons to sleep. Thus "running" is zero, and
 * you can test for combinations of others with
 * simple bit tests.
 */
static const char * const task_state_array[] = {

	/* states in TASK_REPORT: */
	"R (running)",		/* 0x00 */
	"S (sleeping)",		/* 0x01 */
	"D (disk sleep)",	/* 0x02 */
	"T (stopped)",		/* 0x04 */
	"t (tracing stop)",	/* 0x08 */
	"X (dead)",		/* 0x10 */
	"Z (zombie)",		/* 0x20 */
	"P (parked)",		/* 0x40 */

	/* states beyond TASK_REPORT: */
	"I (idle)",		/* 0x80 */
};

```
### 1. R - 可执行状态, running or runnable (on run queue)

表示进程拥有了所有资源，并且处于正在CPU上运行或等待被CPU执行。这些进程的task_struct结构（进程控制块）被放入对应CPU的**可执行队列**中（一个进程最多只能出现在一个CPU的可执行队列中）。

有些地方把这个状态细分成Running(正在CPU上执行)和Ready（可执行），不过这两种在linux下统一为TASK_RUNNING.

### 2. S - 可中断的睡眠状态，interruptible sleep (waiting for an event to complete)

一般是由于等待某某事件的发生（比如等待socket连接、等待信号量），而被挂起。这些进程的task_struct结构（进程控制块）被放入对应事件的**等待队列**中。当这些事件发生时（由外部中断触发、或由其他进程触发），对应的等待队列中的一个或多个进程将被唤醒。

进程列表中的绝大多数进程都处于这个状态.

### 3. D - 不可中断的睡眠状态，uninterruptible sleep (usually IO)

当进程正在内核态进行某些处理时（如IO），可能需要使用TASK_UNINTERRUPTIBLE状态对进程进行保护，以避免进程与设备交互的过程被打断，造成设备陷入不可控的状态。此状态总是非常短暂，ps命令基本上捕捉不到。

### 4. T/t - 暂停状态或跟踪状态, stopped by job control signal / stopped by debugger during the tracing

- T: 向进程发送一个SIGSTOP信号，它就会因响应该信号而进入TASK_STOPPED状态（除非该进程本身处于TASK_UNINTERRUPTIBLE状态而不响应信号）。
 SIGSTOP与SIGKILL信号一样，是非常强制的。不允许用户进程通过signal系列的系统调用重新设置对应的信号处理函数。
 向进程发送一个SIGCONT信号（kill -18），可以让其从TASK_STOPPED状态恢复到TASK_RUNNING状态；或者kill -9直接尝试杀死。

- t：当进程正在被跟踪时，它处于TASK_TRACED这个特殊的状态。“正在被跟踪”指的是进程暂停下来，等待跟踪它的进程对它进行操作。比如在gdb（UNIX及UNIX-like下的调试工具）调试中对被跟踪的进程下一个断点，进程在断点处停下来的时候就处于TASK_TRACED状态。而在其他时候，被跟踪的进程还是处于前面提到的那些状态。

### 5. X - 退出状态，进程即将被销毁

进程在退出过程中也可以不保留task_struct（不进入zombie态）。比如这个进程是多线程程序中被detach过的进程。或者父进程通过设置SIGCHLD信号的handler为SIG_IGN，显式的忽略了SIGCHLD信号。（这是posix的规定，尽管子进程的退出信号可以被设置为SIGCHLD以外的其他信号。）此时，进程将被置于EXIT_DEAD退出状态，这意味着接下来的代码立即就会将该进程彻底释放。所以EXIT_DEAD状态是非常短暂的，几乎不可能通过ps命令捕捉到。

### 6. Z - 退出状态，进程成为僵尸进程， defunct ("zombie") process, terminated but not-reaped by its parent

此时进程依然处于退出过程，除task_struct（保留了进程的退出码、以及一些统计信息）。其父进程很可能会关心这些信息。父进程可以通过wait系列的系统调用（如wait4、waitid）来等待某个或某些子进程的退出，并获取它的退出信息（保存在task_struct里）。然后wait系列的系统调用会顺便将子进程的尸体（task_struct）也释放掉。

> 当父/子进程在不同时间点退出时，就可能会出现Z的细分状态：
>
> 1. 僵尸状态
>
> 一个进程使用 fork 创建子进程，如果子进程退出后父进程没有调用 wait 或 waitpid 获取子进程的状态信息，并将子进程释放掉。那么子进程的进程描述符仍然保存在系统中，仍然占用进程表，此时进程就处于僵尸状态。子进程在退出的过程中，内核会给其父进程发送一个信号，通知父进程来“收尸”。出现僵尸状态可能有两种情况：
> - 第一种情况，父进程收到通知还没来得及完成收尸，此时正常；
> - 第二种情况，父进程收尸出现异常，此时，只要父进程不退出，子进程的僵尸状态就一直存在，可以通过杀死父进程或者重启来解决。
>
> 2. 孤儿状态
> 
> 父进程退出，相应的一个或多个子进程还在运行，那么那些子进程将处于孤儿状态，成为孤儿进程。这些进程会被托管给别的进程，托管给谁呢？可能是退出进程所在进程组的下一个进程（如果存在的话），或者是1号进程。所以每个进程、每时每刻都有父进程存在。**除非它是1号进程。1号进程，pid为1的进程，又称init进程**。
> 
> linux系统启动后，**第一个被创建的用户态进程就是init进程**。它有两项使命：
> - 执行系统初始化脚本，创建一系列的进程（它们都是init进程的子孙）
> - **在一个死循环中等待其子进程的退出事件，并调waitid系统调用来完成“收尸”工作**
>
>init进程不会被暂停、也不会被杀死（这是由内核来保证>的）。它在等待子进程退出的过程中处于TASK_INTERRUPTIBLE状态，“收尸”过程中则处TASK_RUNNING状态。

# 信号
信号signal是进程间通讯（IPC）的一种方式[^2]。实质上是一个进程通过内核发送给另一个进程，信号会在特定时机被处理。

进程可以为自己感兴趣的信号注册处理程序（比如为了能让程序优雅的退出(接到退出的请求后能够对资源进行清理)一般程序都会处理**SIGTERM**信号。与SIGTERM信号不同，SIGKILL信号会粗暴的结束一个进程。因此我们的应用应该实现这样的目录：捕获并处理 SIGTERM 信号，从而优雅的退出程序。如果我们失败了，用户就只能通过 SIGKILL 信号这一终极手段了。除了 SIGTERM 和 SIGKILL，还有像 SIGUSR1 这样的专门支持用户自定义行为的信号）

## container中的信号 [^3]
在Docker中，stop 和 kill 命令都可以用来向容器发送信号的。

**只有容器中的1号进程能够收到信号，这一点非常关键！**

> stop命令会首先发送SIGTERM信号，并等待应用优雅的结束。如果发现应用没有结束(用户可以指定等待的时间)，就再发送一个 SIGKILL 信号强行结束程序。
> kill命令默认发送的是 SIGKILL 信号，当然你可以通过 -s 选项指定任何信号。

因此，容器中的1号进程非常关键，如果它不能正确的处理相关的信号，那么应用程序退出的方式几乎总是被强制杀死而不是优雅的退出。究竟谁是1号进程则主要由 EntryPoint, CMD, RUN 等指令的写法决定，所以这些指令的使用是很有讲究的[^4]。

# 回到问题

所以通过

	ENTRYPOINT ["tini", "-g", "--"]
	CMD ["start.sh"]

我们可以启动一个tini进程，并且其为container内PID为1的init进程。这个init进程需要给‘不负责任’的父进程（意外退出）创建的子进程‘收尸’（reaping）。当然，我们也要尽量避免生成zombie进程，但是有些时候我们无法控制执行的代码，例如Jenkins。

同时tini会forward发送给container的信号给子进程（这也是为啥不用Bash作为init进程的原因之一，虽然Bash可以reaping zombies）。

所以如果你的container中会有zombie（‘defunct’） process存在的话(multiple processes in a container;run a single process that spawns a lot of child processes)，使用tini既保险又方便。

> NOTE: If you are using Docker 1.13 or greater, Tini is included in Docker itself. This includes all versions of Docker CE. To enable Tini, just pass the --init flag to docker run [^5]

[^1]: https://cloud.tencent.com/developer/article/1568077
[^2]: https://www.jianshu.com/p/c1015f5ffa74
[^3]: https://www.cnblogs.com/sparkdev/p/7598590.html
[^4]: https://www.cnblogs.com/sparkdev/p/8461576.html
[^5]: https://github.com/krallin/tini

