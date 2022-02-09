---
title: CMD or ENTRYPOINT in Dockerfile?
date: 2020-01-17 12:23:41
tags: [Docker, TechNotes]
---

# 问题
CMD和ENTRYPOINT在Dockerfile中应该怎么使用？有什么区别？

# exec模式&shell模式
这两种模式可以用来指定不同进程中的1号进程（PID = 1）

## exec模式
如果使用这种模式，容器中的任务进程就是1号进程。
```dockerfile
    FROM alpine:3.9
    CMD [ "top" ]
```
这种模式下不会通过shell执行相关命令，所以一些环境变量是取不到的，如$HOME。不过如果通过下面这样那就另说了。

```dockerfile
    FROM alpine:3.9
    CMD [ "sh", "-c", "echo $HOME" ]
```

## shell模式

相对的， 这种方式会用bash来执行传递的命令，所以1号进程会是bash。

```dockerfile
    FROM alpine:3.9
    CMD top
```

其实也就是相当于

``` dockerfile
    FROM alpine:3.9
    CMD [ "sh", "-c", "top" ]
```

# CMD [^1]
> The CMD instruction has three forms:
>
> `CMD ["executable","param1","param2"]` (exec form, this is the preferred form)
> 
> `CMD ["param1","param2"]` (as default parameters to ENTRYPOINT)
> 
> `CMD command param1 param2` (shell form)
> 
> There can only be one CMD instruction in a Dockerfile. If you list more than one CMD then only the last CMD will take effect.
>
> The main purpose of a CMD is to provide defaults for an executing container. These defaults can include an executable, or they can omit the executable, in which case you must specify an ENTRYPOINT instruction as well.
>
> If CMD is used to provide default arguments for the ENTRYPOINT instruction, both the CMD and ENTRYPOINT instructions should be specified with the JSON array format.

从官方文档来看，CMD有三种格式：
- exec 模式
- 作为ENTRYPOINT的默认参数
- shell 模式

**一个dockerfile中只能有一个CMD，如果有多个只有最后的CMD生效**

所以总的来说，CMD是给container提供一个默认的执行入口。如果CMD没有提供可执行的executable，那必须有声明ENTRYPOINT，此时CMD被用于给ENTRYPOINT提供默认参数。

> If the user specifies arguments to docker run then they will override the default specified in CMD.

一般的镜像都会提供容器启动时的默认命令，但是有些场景中用户并不想执行默认的命令。用户可以通过命令行参数的方式覆盖CMD指令提供的默认命令，**这里要注意，有别于ENTRYPOINT，命令行上的命令同样会覆盖shell模式的CMD指令。**。

# ENTRYPOINT [^2]
> ENTRYPOINT has two forms:
>
> The exec form, which is the preferred form:
>
> `ENTRYPOINT ["executable", "param1", "param2"]`
> 
> The shell form:
>
> `ENTRYPOINT command param1 param2`
>
> An ENTRYPOINT allows you to configure a container that will run as an executable.

ENTRYPOINT也同样是为container指定默认执行的任务，有exec模式和shell模式。

几个例子：
- **指定ENTRYPOINT指令为exec模式时，命令行上指定的参数会作为参数添加到ENTRYPOINT指定命令的参数列表中。** 下面的container执行的命令是 `top -b -c`
```dockerfile
    FROM alpine:3.9
    CMD [ "top", "-b" ]
```
```bash
    docker run --rm test1 -c
```
- **由CMD指令指定默认的可选参数。** 下面的container执行的命令是 `top -b -c`
```dockerfile
    FROM alpine:3.9
    ENTRYPOINT [ "top", "-b" ]
    CMD [ "-c" ]
```
```bash
    docker run --rm test1
```
- docker run可以覆盖CMD默认参数，如下，最终执行的命令是 `top -b -n 1`
```dockerfile
    FROM alpine:3.9
    ENTRYPOINT [ "top", "-b" ]
    CMD [ "-c" ]
```
```bash
    docker run --rm test1 -n 1
```
- **当ENTRYPOINT写成shell模式时，会完全忽略命令行参数。** 如下， `ls`命令被忽略了（CMD会被override）。
```dockerfile
    FROM alpine:3.9
    ENTRYPOINT echo $HOME
```
```bash
    docker run --rm test1 ls
```
- 如果要覆盖默认的ENTRYPOINT，需要用 `--entrypoint`
```bash
    docker run --rm --entrypoint ls test1
```

# 回到问题
所以从结果上看，CMD和ENTRYPOINT都可以给container指定默认的执行入口。并且，如果镜像中既没有指定CMD也没有指定ENTRYPOINT那么在启动容器时会报错。不过现在绝大多数镜像都默认添加了CMD或ENTRYPOINT指令。
多数情况下，这两个应该单独使用，结合使用的时候会出现比较复杂的情况，我们可以借助docker官方的这张table[^3]:，具体分析。

|        | No ENTRYPOINT | ENTRYPOINT exec_entry p1_entry | ENTRYPOINT [“exec_entry”, “p1_entry”]
| ------- | -------------- | ---------------------------- | ----------------------------------- |
| No CMD | error, not allowed | /bin/sh -c exec_entry p1_entry | exec_entry p1_entry |
| CMD [“exec_cmd”, “p1_cmd”] | exec_cmd p1_cmd | /bin/sh -c exec_entry p1_entry | exec_entry p1_entry exec_cmd p1_cmd|
| CMD [“p1_cmd”, “p2_cmd”] | p1_cmd p2_cmd | /bin/sh -c exec_entry p1_entry | exec_entry p1_entry p1_cmd p2_cmd |
| CMD exec_cmd p1_cmd | /bin/sh -c exec_cmd p1_cmd | /bin/sh -c exec_entry p1_entry | exec_entry p1_entry /bin/sh -c exec_cmd p1_cmd |



[^1]: https://docs.docker.com/engine/reference/builder/#run
[^2]: https://docs.docker.com/engine/reference/builder/#entrypoint
[^3]: https://docs.docker.com/engine/reference/builder/#understand-how-cmd-and-entrypoint-interact