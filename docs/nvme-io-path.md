# 应用程序 → Linux 内核 → NVMe 驱动：完整 IO 链路

> 以内核 **Linux 6.x**（本机 6.8）为准，内核源码路径相对 `linux/`。分「数据提交路径（submit）」与「完成路径（complete）」两条主线。

---

## 0. 总览：分层与主干函数

```
应用进程
  read()/write()/pread()/io_uring_enter()          ← 用户态
────────────────────────────────────────── syscall 边界
VFS 层        ksys_read → vfs_read → f_op->{read,write}_iter
  └─ kiocb / iov_iter / address_space
文件系统层     ext4 / xfs / btrfs（iomap 统一框架）
  ├─ 缓冲IO：page cache + 回写(writeback)
  └─ 直接IO：iomap_dio_rw / __blkdev_direct_IO
通用块层       submit_bio → blk_mq_submit_bio  (blk-mq 多队列)
  └─ IO 调度器：none / mq-deadline / kyber / bfq
NVMe 核心      nvme_queue_rq → nvme_setup_cmd → nvme_submit_cmd → doorbell
NVMe PCIe传输  nvme-pci：BAR0 MMIO doorbell + MSI-X 中断 + DMA(PRP/SGL)
硬件            NVMe 控制器 → FTL → NAND
──────────────────────────────────────────
完成：MSI-X 中断 → nvme_process_cq → blk_mq_complete_request → bio_endio → 唤醒进程
```

---

## 1. 应用层（用户态）

- **入口 API**
  - 阻塞同步：`read()/write()/pread()/pwrite()/preadv2()`
  - 异步 IO：POSIX AIO（`io_submit`，libaio）、**io_uring**（`io_uring_enter`，现代主流）
  - 内存映射：`mmap()`（普通文件 / DAX）
- **关键选择：缓冲 vs 直接 IO**
  - 缓冲（默认）：数据先进入内核 **page cache**，异步回写盘；读命中即内存拷贝。
  - `O_DIRECT`：绕过 page cache，数据在用户 buffer 与设备之间直接 DMA；对齐要求（扇区/页对齐）。
  - `O_SYNC` / `fdatasync()` / `fsync()`：强制落盘（触发 FLUSH/FUA）。
  - `RWF_HIPRI`：使用块层轮询（polling）。
- **目标对象**：既可以是**文件**（经文件系统），也可以是**块设备** `/dev/nvme0n1`（绕过文件系统）。
- glibc 只是 syscall 薄封装。io_uring 通过共享 SQ/CQ 环形队列批量提交/收割，减少 syscall 与上下文切换。

---

## 2. 系统调用 / VFS 层

- **源码**：`fs/read_write.c`、`fs/io_uring/`、`mm/filemap.c`
- **主干**：`ksys_read()` → `vfs_read()` → `file->f_op->read_iter()`（`kiocb` + `iov_iter`）
  - 文件：`ext4_file_read_iter` / `xfs_file_read_iter` …
  - 块设备：`blkdev_read_iter`（`block/fops.c`）
  - io_uring：`io_read()` / `io_write()`（`io_uring/rw.c`）
- **关键结构**：`struct file` / `file_operations` / `inode` / `address_space` / `kiocb` / `iov_iter`
- VFS 决定走 **page cache** 还是 **direct IO**，随后下沉到文件系统或块设备层。

---

## 3. 文件系统层

### 3.1 缓冲读（buffered read）
`filemap_read()`（`mm/filemap.c`）
→ 命中 page cache：直接从 folio 拷贝到用户 buffer
→ 未命中：`page_cache_sync_readahead()` / `do_read_cache_folio()` → `a_ops->read_folio` / `readahead`
→ 具体 FS（ext4/xfs）→ **iomap** → `iomap_read_folio` → `submit_bio()`

### 3.2 缓冲写（buffered write）与回写
- 快速路径：`generic_perform_write()` 只写 page cache，标记 dirty，返回（延迟落盘）。
- 回写：由 `flusher` 线程 / kworker 触发 `writepages` → `iomap_writepages` → `submit_bio()`。
- 触发点：脏页阈值、`fsync()`、`sync`、内存回收。

### 3.3 直接 IO（direct IO）
- 文件：`iomap_dio_rw()`（`fs/iomap/direct-io.c`）→ 分块 → `iomap_dio_submit_bio` → `submit_bio()`；提交后 `iomap_dio_complete()` 等待完成。
- 块设备：`__blkdev_direct_IO()`（`block/fops.c`）→ 构造 **指向块设备的 bio** → `submit_bio()`。

### 3.4 块映射
- ext4 extent / xfs bmap → 逻辑块 → **物理块（LBA）**；`iomap` 提供 FS 无关的统一映射接口。

---

## 4. 通用块层 / blk-mq（多队列）

- **源码**：`block/blk-core.c`、`block/blk-mq.c`
- **提交链**：
  `submit_bio()` → `submit_bio_noacct()` → `submit_bio_noacct_nocheck()` →（分区重映射 `blk_partition_remap`）→ `__submit_bio()` → **`blk_mq_submit_bio()`**
- **blk-mq 结构**
  - 每个 IO 提交被分配一个 **request**（由 **tag** 索引，tagset 管理）。
  - **Software queue**：每 CPU 一个（`ctx->rq_lists`），减少锁竞争。
  - **Hardware dispatch queue（hctx）**：映射到硬件队列；`blk_mq_dispatch_rq_list()` 从中派发。
  - **plug**：`blk_start_plug()`/`blk_finish_plug()` 批量攒请求后一次性下发（`blk_mq_flush_plug_list`）。
- **调度器**（`elevator`）：`none`（NVMe 默认，直通） / `mq-deadline` / `kyber` / `bfq`
  - 通过 `/sys/block/nvme0n1/queue/scheduler` 切换。
- **派发**：`blk_mq_dispatch_rq_list()` → `q->mq_ops->queue_rq()` → **`nvme_queue_rq()`**

---

## 5. NVMe 核心层（协议与命令）

- **源码**：`drivers/nvme/host/core.c`
- **`nvme_queue_rq()`**：入口回调（由 blk-mq 调用）
  1. **`nvme_setup_cmd()`**：把 request 翻译成 NVMe 命令
     - `nvme_setup_rw()`：设置 opcode（Read=0x02 / Write=0x01）、`NSID`、`SLBA`、`NLB`、`DSM`（访问频率/延迟提示）。
     - Flush=0x00（带 FUA）、Discard/Write Zeroes、Admin 命令等。
  2. **`nvme_map_data()`**：DMA 映射用户/页数据 → **PRP 列表** 或 **SGL**（`dma_map_sg`）。
  3. **`nvme_submit_cmd()`**：把 **SQE** 写入提交队列 SQ，更新 `sq_tail`。
  4. **`nvme_write_sq_db()`**：**敲 doorbell**（写 BAR0 中 SQ tail doorbell 寄存器），通知控制器有新命令。
- **队列模型**：成对的 **SQ/CQ**（`struct nvme_queue`），管理员队列 + N 个 IO 队列；队列深度、`qid`。
- **完成**：控制器写 **CQE** 到 CQ；驱动 `nvme_process_cq()` 读取、校验 **phase bit**、`blk_mq_complete_request()`。

---

## 6. NVMe PCIe 传输层（硬件交互）

- **源码**：`drivers/nvme/host/pci.c`
- **探测/初始化**：映射 **BAR0**（MMIO，含 doorbell 寄存器区 `dev->dbs` 与控制器寄存器），建立 admin 队列，创建 IO 队列；`nvme_pci_map_queues()` 把队列绑定到 CPU（`blk_mq_map_queues`）。
- **Doorbell**：`nvme_write_sq_db()` → `writel()` 写 MMIO 寄存器。
- **中断**：**MSI-X**（理想每 CQ 一个向量）；`nvme_irq()` → `nvme_process_cq()`。
- **DMA**：命令/数据经 **PRP**（单页 + PRP list）或 **SGL** 描述，控制器直接 DMA 读写主机内存。
- **轮询**：支持队列轮询（polling）以降低延迟（配合 io_uring `IORING_SETUP_IOPOLL` / `RWF_HIPRI`）。

---

## 7. 硬件（SSD 内部）

- NVMe 控制器通过 DMA **取 SQ 命令** → 执行 → **写 CQE 到 CQ** → 更新 phase → 触发 **MSI-X 中断**。
- **FTL（Flash Translation Layer）**：LBA→PBA 映射表、**磨损均衡**、**垃圾回收(GC)**、坏块管理。
- **NAND**：通道(channel) / way / die / plane / page（读写单位）/ block（擦除单位）。
- 关键影响：**写放大**、GC 抖动、SLC/QLC 缓存策略、掉电保护。

---

## 8. 完成路径（completion）

```
SSD 完成 → MSI-X 中断
  → nvme_irq() → nvme_process_cq()          读 CQE, 定位 request
  → blk_mq_complete_request()               (可能 IPI 到提交 CPU / BLOCK_SOFTIRQ)
  → blk_mq_end_request() → bio_endio()
      ├─ 直接IO：iomap_dio_bio_end_io → iomap_dio_complete → 唤醒等待进程
      └─ 缓冲IO：page_endio / end_buffer_read_sync → 解锁 page → 唤醒
  → 进程被唤醒，系统调用返回用户态
```

- 软中断 `BLOCK_SOFTIRQ` 处理完成以避免中断上下文过长。
- 中断合并（interrupt coalescing）可减少中断次数、提升吞吐。

---

## 9. 关键函数 / 结构 速查表

| 层 | 关键函数 | 关键结构 | 源码 |
|---|---|---|---|
| 应用 | `read/write`, `io_uring_enter` | `io_uring_sqe/cqe` | — |
| VFS | `vfs_read`, `f_op->read_iter` | `file/inode/kiocb/iov_iter` | `fs/read_write.c` |
| 文件系统 | `filemap_read`, `iomap_dio_rw`, `writepages` | `address_space` | `mm/filemap.c`, `fs/iomap/` |
| 块设备文件 | `__blkdev_direct_IO` | `block_device` | `block/fops.c` |
| 通用块层 | `submit_bio`, `blk_mq_submit_bio`, `blk_mq_dispatch_rq_list` | `bio/request/tagset/hctx` | `block/blk-core.c`, `block/blk-mq.c` |
| 调度器 | `elevator dispatch` | `elevator_queue` | `block/mq-deadline.c` 等 |
| NVMe 核心 | `nvme_queue_rq`, `nvme_setup_cmd`, `nvme_submit_cmd` | `nvme_queue`, `nvme_dev` | `drivers/nvme/host/core.c` |
| NVMe PCIe | `nvme_write_sq_db`, `nvme_irq`, `nvme_process_cq` | `nvme_queue`(nvmeq) | `drivers/nvme/host/pci.c` |
| 硬件 | FTL / NAND | — | SSD 固件 |

---

## 10. 优化与旁路技术

- **多队列 / 每核队列**：消除全局锁与跨核竞争（blk-mq + NVMe 多队列是前提）。
- **io_uring + IOPOLL**：轮询模式，去除中断与上下文切换，降尾延迟。
- **中断合并（coalescing）**：`ethtool` 式思路，减少中断风暴。
- **大 IO / PRP 优化 / 合并**：减少命令数，提高 DMA 效率。
- **SPDK / DPDK 用户态驱动**：完全绕过内核，轮询 SQ/CQ，极致低延迟。
- **NVMe-oF**：over Fabrics（TCP / RDMA / FC），跨网络访问。
- **CPU/队列亲和、NUMA 对齐**：避免跨节点内存与队列不匹配。

---

## 11. 可观测性 / 排查工具

- `blktrace` / `btt`、`blkparse`：块层全链路事件。
- `fio`：压测与队列深度/IO 类型建模。
- `bpftrace`：`biolatency`、`biosnoop`、`nvme` 跟踪。
- `perf` / `ftrace`（`function_graph` 跟踪 `nvme_queue_rq`、`blk_mq_submit_bio`）。
- `iostat -x`：`aqu-sz`、`await`、`%util` 等。
- `nvme-cli`：`nvme id-ctrl/id-ns/smart-log`。
- `/sys/block/nvme0n1/queue/*`：`nr_requests`、`scheduler`、`nomerges`、`rq_affinity`。

---

## 12. 一句话串起来

> **应用** 发起 `read()/write()`（或 io_uring）→ **VFS** 分发（缓冲走 page cache，直接走 `O_DIRECT`）→ **文件系统/块设备** 把逻辑 IO 映射为 LBA 并构造 `bio` → **通用块层 blk-mq** 把 `bio` 变成带 tag 的 `request` 经调度后派发 → **NVMe 核心** 把 request 编码为 NVMe 命令、DMA 映射、写入 SQ 并敲 doorbell → **PCIe 传输层** 经 MMIO/DMA 交给控制器 → **SSD** 经 FTL 落到 NAND → 完成后写 CQE、发 MSI-X 中断，内核沿 `blk_mq_end_request → bio_endio` 反向解锁并唤醒进程。

---

### 版本备注
- 页单位已由 `page` 迁移为 **folio**（5.16+），`readpage/readpages`→`read_folio/readahead`。
- `generic_make_request` 已并入 `submit_bio_noacct` 递归处理（5.x）。
- io_uring 为现代异步首选；传统 libaio 逐渐被取代。

---

# 第二部分：驱动加载、标识符与 SPEC 演进

## 13. 驱动加载与初始化（module → PCI → 控制器使能 → namespace）

### 13.1 模块加载
- **`nvme-core.ko`**：`nvme_core_init()` —— 注册 NVMe 总线（`nvme_bus_type`）、`nvme_class` / `nvme_subsys_class`、申请 `/dev/nvme*` 字符设备主设备号、初始化 workqueue 与 sysfs。
- **`nvme.ko`（PCIe 传输）**：`drivers/nvme/host/pci.c`，`module_init(nvme_init)` → `pci_register_driver(&nvme_driver)`，id_table 匹配 **class code = 0x010802（NVM Express）**。
- **NVMe-oF**：`nvme-fabrics.ko` + `nvme-tcp.ko` / `nvme-rdma.ko` / `nvme-fc.ko`。

### 13.2 PCI probe（`nvme_probe`）
1. `pcim_enable_device` + 置 **bus master**（允许 DMA）。
2. `nvme_dev_map()`：映射 **BAR0 MMIO**（控制器寄存器区 + doorbell 区 `dev->dbs`）。
3. `nvme_init_ctrl()`：分配 `struct nvme_ctrl` / `struct nvme_dev`。
4. `nvme_setup_irqs()`：`pci_alloc_irq_vectors(MSI-X)`，理想情况**每 CQ 一个中断向量**。
5. **控制器使能序列**（`nvme_pci_enable` / `nvme_enable_ctrl`，严格按规范顺序）：
   - 读 **CAP** 寄存器：`MQES`（队列深度上限）、`DSTRD`（doorbell 步长）、`TO`（超时）、`CSS`（命令集）、`MPS`/`MPSMIN`。
   - 关闭控制器：`CC.EN=0`，轮询等待 `CSTS.RDY=0`。
   - 配置 admin 队列：写 **AQA**（admin 队列属性）、**ASQ / ACQ**（admin SQ/CQ 的物理 DMA 地址）。
   - 写 **CC**：`IOSQES=IOCQES=4`（16B 命令/完成项）、MPS、CSS；然后 `CC.EN=1`，轮询等待 `CSTS.RDY=1`。

### 13.3 识别阶段（`nvme_init_identify`）
- **Identify Controller（CNS=1）**：得到 `VID/SSVID`、`SN`（序列号）、`MN`（型号）、`FR`（固件版本）、**`CNTLID`**、控制器 NQN、**`SUBNQN`（子系统 NQN）**、`MDTS`、`OACS`、`AERL`、`HMPRE/HMMIN` 等。
- **Identify Namespace（CNS=0）** × 每个 NSID：得到 `NSZE/NCAP/NUSE`、`LBAF`、**`NGUID/UUID/EUI64`**、`DLFEAT`、`DPS`。
- `nvme_init_subsystem()`：以 **subnqn** 为 key 创建/查找 `struct nvme_subsystem`（**多路径的核心**）。
- `nvme_get_log_page`：读取 ANA 日志、SMART/健康日志、持久事件日志。
- **Set Features**：队列数、仲裁（round-robin/WRR）、中断合并、异步事件、温度阈值等。

### 13.4 建立 IO 队列
- `nvme_alloc_io_queues()` → 计算队列数与深度（受 `CAP.MQES`、CPU 数限制）。
- 通过 admin 命令 **Create I/O CQ** + **Create I/O SQ** 逐一创建**队列对**（queue pairs）。
- `nvme_pci_map_queues()` / `blk_mq_map_queues()`：把 blk-mq 的 hctx **绑定到 CPU**（每核队列）。

### 13.5 扫描 namespace 与注册（`nvme_scan_namespaces` → `nvme_alloc_ns` → `nvme_register_ctrl`）
- 每个命名空间：`alloc_disk()`，块设备命名 **`nvme0n1`**（= 控制器实例 0 + NSID 1）。
- 填充 `ns->ns_id`、`ns->uuid/nguid/eui64`、LBA 格式、容量、`blk_mq_tagset`。
- `nvme_mpath_add_disk()`：读取并持续维护 **ANA 状态**。
- `nvme_register_ctrl()`：设置 **`ctrl->cntlid`** 与控制器实例号，创建字符设备 `/dev/nvme0`（admin/IO 命令 ioctl 通道）与 `/sys/class/nvme/nvme0`。
- 最终系统出现：块设备 `/dev/nvme0n1`、字符设备 `/dev/nvme0`、`/sys/block/nvme0n1/`、`/sys/class/nvme/`、`/sys/class/nvme-subsystem/`。

```
insmod nvme  → PCI 匹配(0x010802) → probe → map BAR0 → 使能控制器(CC.EN)
  → Identify Ctrl/NS(拿 cntlid/subnqn/NSID) → Set Features
  → Create IO SQ/CQ → map_queues(每核) → scan_namespaces
  → alloc_disk(nvme0n1) + register_ctrl → /dev/nvme0n1 可读写
```

---

## 14. 关键标识符：它们如何影响“盘”

| 标识 | 定义 / 作用域 | 谁分配 | Linux 中的体现 | 对 IO 的影响 |
|---|---|---|---|---|
| **NQN** | NVMe Qualified Name，全局名字 | 主机/约定 | `hostnqn`、控制器 NQN | 标识主机与控制器；NVMe-oF 连接的身份 |
| **subnqn** | **子系统 NQN**，标识 NVM Subsystem（一个**故障域**） | 子系统/控制器 | `nvme-subsysX` | **决定多路径分组**；同一 subnqn 的多个控制器共享命名空间 |
| **cntlid** | **控制器 ID**，16-bit，**子系统内唯一** | 控制器（Identify 上报） | `/sys/class/nvme/nvmeX/cntlid` | **区分多路径中的各条路径**；ANA 按 cntlid 上报路径状态 |
| **NSID** | **命名空间 ID**，32-bit，**子系统内唯一**（非每控制器） | 控制器 | `nvme0n1` 里的 `n1` | **命令寻址**：`nvme_setup_rw` 把 NSID 填入命令 |
| **NGUID/UUID/EUI64** | 命名空间的**全局唯一标识** | 控制器 | `ns->uuid/nguid/eui64` | 跨路径、跨控制器识别“同一个”命名空间 |

**关系与影响（串起来看）**
- **subnqn** 定义一个子系统（= 故障域/多路径域）；**同一个 subnqn 下可以有多个控制器**，靠不同的 **cntlid** 区分。
- **NSID 是子系统级作用域**：因此“控制器 A 的 NSID=1”与“控制器 B 的 NSID=1”指的是**同一个命名空间**。这正是多路径成立的前提。
- **多路径路由**：内核按 **ANA 状态**（optimized / non-optimized / inaccessible / change）选择 `optimized` 路径的控制器（cntlid）下发 IO；路径故障时切换到其他 cntlid。参见第 15 节。
- **命名规则**：单路径为 `/dev/nvme<控制器实例>n<NSID>`；开启多路径时为 `head` 设备 + 每控制器路径设备 `/dev/nvme<n>c<c>n<NSID>`（`c` 由控制器的 cntlid/实例推导）。
- **命名空间管理（1.3+）**：主机可经 `/dev/nvme0` 的 ioctl（`NVME_IOCTL_ADMIN_CMD`）动态**创建/删除命名空间**，无需重载驱动。

---

## 15. Linux 多路径（Multipath + ANA）与命名

- 默认 `nvme_core.multipath=Y`。同一 **subnqn** 下的多个控制器（不同 **cntlid**）被聚合为一个 `nvme-subsysX`。
- 设备节点形态：
  - 聚合 head 命名空间：`/dev/nvme0n1`
  - 每控制器路径：`/dev/nvme0c0n1`、`/dev/nvme0c1n1`（首段子系统实例 + `c` + 控制器实例 + `n` + NSID）
- **ANA（Asymmetric Namespace Access，NVMe 1.4+）**：控制器上报每个命名空间相对本控制器的可访问状态；内核据此在 `optimized` 路径下发 IO，`non-optimized` 次之，`inaccessible` 停用，`change` 触发重查。
- 路径故障切换、IO 重试由 `nvme_mpath_*` 与 blk-mq 层共同完成。

---

## 16. NVMe SPEC 演进：1.2 → 2.4

> 当前 NVMe 规范集合已拆分为 **11 个 spec**（Base + 各命令集 + 各传输 + MI/Boot）[^a](https://nvmexpress.org/specification/nvm-express-base-specification/)。以下按时间线列关键版本与特性。

| 版本 | 时间 | 关键新增特性 |
|---|---|---|
| 1.0 / 1.0e | 2011 / 2013 | 首个正式版；多队列、命令队列模型奠定 |
| 1.1 / 1.1b | 2012 / 2014 | 多路径 IO（早期命名空间共享）、任意长度 SGL |
| **1.2 / 1.2.1** | 2014-11 / 2016 | **HMB（主机内存缓冲）**、命名空间预留（Reservation）、**RPMB**、**Doorbell Stride**（为多控制器/虚拟化铺路）、电源管理 [^d](https://en.wikipedia.org/wiki/NVM_Express) |
| **1.3 / 1.3d** | 2017-05 / 2019 | **命名空间管理**（动态创建/删除）、Boot Partitions、**Sanitize 安全擦除**、**Directives/Streams 数据放置**、**Telemetry 遥测**、**SR-IOV 虚拟化**（多 PF/VF）、Device Self-test、**PMR（持久内存区）**、多固件槽位 [^d](https://en.wikipedia.org/wiki/NVM_Express) |
| **1.4 / 1.4c** | 2019-06 / 2021 | **ANA 非对称命名空间访问（多路径核心）**、**ZNS（分区命名空间，作为 TP 引入）**、**NVM Sets**、**持久事件日志**、**可预测延迟 / IO Determinism**、**Endurance Groups**、Keep Alive 计时器、命名空间粒度、Read Recovery Levels、命名空间写保护 [^d](https://en.wikipedia.org/wiki/NVM_Express) |
| **2.0** | 2021 | **大重构**：拆为 8 个 spec（Base + 命令集 NVM/ZNS/KV + 传输 PCIe/RDMA/TCP + MI）[^b](https://nvmexpress.org/changes-in-nvm-express-revision-2-0/)；新增 **Simple Copy**、**Domains & Partitioning（域与分区）**、NVM Set/Endurance Group 管理、**命令与特性锁定（Lockdown）**、**KV 命令集**、**ZNS 正式化**、**FDP（灵活数据放置）**、**支持旋转介质（HDD）** [^b](https://nvmexpress.org/changes-in-nvm-express-revision-2-0/)[^d](https://en.wikipedia.org/wiki/NVM_Express) |
| 2.0d / 2.0e | 2024-01 / 2024-07 | 2.0 系列的维护修订 |
| **2.1** | 2024-08 | **Live Migration（控制器/命名空间在线迁移）**、**Key Per I/O（每 IO 独立密钥）**、**NVMe-MI 高可用带外管理**、**NVMe Network Boot/UEFI（NVMe-oF 网络启动）**、Scalable Resource Management、**Fabric Zoning & Pull Registrations**（CDC 集中发现控制器）[^c](https://nvmexpress.org/everything-you-need-to-know-an-essential-overview-of-nvm-express-2-1-base-specification-and-new-key-features/) |
| **2.2** | 2025-03 | 常规修订/汇总技术提案 |
| **2.3** | 2025-08 | 汇总 TP4202/TP4153/TP4163/TP4199 等；ZNS / KV / 旋转介质 / Endurance Group 管理更新 [^e](https://nvmexpress.org/wp-content/uploads/NVM-Express-Base-Specification-Revision-2.3-2025.08.01-Ratified.pdf) |
| **2.4** | 2026-08-04 | **后量子安全（Post-quantum）**、**电压监控**、**限速（Rate limiting）**、**存储迁移**、**恢复出厂默认配置** [^f](https://ampinc.com/nvme-2-4-ssd-specification/)[^a](https://nvmexpress.org/specification/nvm-express-base-specification/) |

**演进总趋势**
1. **1.x**：补齐企业特性（命名空间管理、Sanitize、虚拟化、可预测延迟、多路径）。
2. **2.0 重构**：协议与介质解耦 —— 命令集（NVM/ZNS/KV/计算存储…）与传输（PCIe/RDMA/TCP/FC）各自独立演进，为 ZNS/FDP/KV 等“面向介质/应用”的特性和 NVMe-oF 铺路 [^b](https://nvmexpress.org/changes-in-nvm-express-revision-2-0/)[^a](https://nvmexpress.org/specification/nvm-express-base-specification/)。
3. **2.1+**：面向云/数据中心 —— 在线迁移、每 IO 密钥、网络启动、高可用、安全（含 2.4 的后量子）。

> ⚠️ 规范版本 ≠ 产品能力：某版本定义的能力需由 SSD 控制器/固件与主机平台**各自实现**才会出现，升级 spec 不会自动升级已有盘 [^f](https://ampinc.com/nvme-2-4-ssd-specification/)。

---

## 17. 在 Linux 中查看这些标识符

```bash
cat /etc/nvme/hostnqn              # 主机 NQN
nvme id-ctrl /dev/nvme0            # cntlid / subnqn / sn / mn / fr / mdts
dmesg | grep -i nvme               # 加载与识别日志
nvme list-subsys                   # 子系统 / 控制器 / 路径 拓扑（含 ANA）
nvme list                          # 命名空间 → /dev/nvmeXnY 与容量
nvme id-ns /dev/nvme0n1            # nguid / uuid / eui64 / lba 格式
lsblk -o NAME,NSID,SUBSYSTEMS
cat /sys/class/nvme/nvme0/{cntlid,subsysnqn,address,model}
ls /sys/class/nvme-subsystem/      # nvme-subsys0 ...
cat /sys/block/nvme0n1/queue/scheduler   # none / mq-deadline / kyber / bfq
```

---

## 一句话串起来（含加载）

> **加载**时：`nvme.ko` 经 PCI probe → 映射 BAR0 → 按规范使能控制器（CC.EN）→ Identify 拿到 **cntlid / subnqn / NSID** → Set Features → 建 IO 队列（每核）→ 扫描命名空间生成 `/dev/nvme0n1`。**运行时**：应用 `read/write` → VFS/FS（iomap）→ blk-mq（每核队列 + tag）→ `nvme_queue_rq` 编码命令、DMA 映射、写 SQ、敲 doorbell → 控制器经 FTL 落到 NAND → 完成后 CQE + MSI-X 中断 → `bio_endio` 唤醒进程；**subnqn 决定多路径域、cntlid 决定走哪条路径、NSID 决定访问哪个命名空间**。
