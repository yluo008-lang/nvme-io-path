/* NVMe IO 链路互动教学 —— 数据层
 * 结构：scenarios -> { order:[layers], steps:[...] }
 * 每个 step: { layer, title, desc, file, func, structs[], code, vnote }
 * func / vnote 可为字符串（全版本相同）或对象（key 为内核版本，缺省用 "*"）。
 */
window.APP_DATA = (function () {
  const KERNELS = ["4.19", "5.4", "5.15", "6.1", "6.8"];

  const LAYERS = {
    // 初始化场景
    mod:       { name: "模块加载",       color: "#a5b4fc", icon: "📦" },
    pci:       { name: "PCI 探测",       color: "#6ee7b7", icon: "🔎" },
    ctrl:      { name: "控制器使能",     color: "#fcd34d", icon: "🎛️" },
    ident:     { name: "识别 Identify",  color: "#5eead4", icon: "🪪" },
    queue:     { name: "建 IO 队列",     color: "#7dd3fc", icon: "🚚" },
    ns:        { name: "命名空间 / 注册", color: "#c4b5fd", icon: "🗂️" },
    // IO 路径
    user:      { name: "应用层",          color: "#7dd3fc", icon: "👤" },
    syscall:   { name: "系统调用 / VFS",   color: "#a5b4fc", icon: "🧩" },
    fs:        { name: "文件系统",         color: "#c4b5fd", icon: "📁" },
    block:     { name: "通用块层 blk-mq",  color: "#f0abfc", icon: "🧱" },
    sched:     { name: "IO 调度器",        color: "#fca5f1", icon: "🚦" },
    nvme_core: { name: "NVMe 核心",        color: "#5eead4", icon: "⚙️" },
    nvme_pci:  { name: "nvme-pci 传输",    color: "#6ee7b7", icon: "🔌" },
    hw:        { name: "硬件 SQ / CQ",     color: "#fcd34d", icon: "💽" },
    complete:  { name: "完成路径",         color: "#fdba74", icon: "✅" }
  };

  // ===================== 初始化场景 =====================
  const init = {
    key: "init",
    name: "驱动加载 / 初始化",
    cmd: "insmod nvme",
    blurb: "从模块加载一路走到 /dev/nvme0n1 出现，并拿到 cntlid / subnqn / NSID。",
    order: ["mod", "pci", "ctrl", "ident", "queue", "ns"],
    steps: [
      { layer: "mod", title: "加载 nvme-core 模块",
        desc: "nvme_core_init() 注册 NVMe 总线类型、申请字符设备主设备号、创建 sysfs class，为 /dev/nvme* 提供框架。",
        file: "drivers/nvme/host/core.c", func: "nvme_core_init", structs: ["nvme_ctrl", "nvme_subsystem", "nvme_ns"],
        code: "static int __init nvme_core_init(void)\n{\n    bus_register(&nvme_bus_type);\n    alloc_chrdev_region(&nvme_chr_devt, 0, NVME_MINORS, \"nvme\");\n    nvme_class = class_create(\"nvme\");\n    nvme_subsys_class = class_create(\"nvme-subsystem\");\n}" },
      { layer: "mod", title: "注册 PCI 驱动",
        desc: "nvme.ko 的 pci_driver 以 class code 0x010802 (NVM Express) 匹配设备；注册后 PCI 子系统把每个 NVMe 设备交给 nvme_probe()。",
        file: "drivers/nvme/host/pci.c", func: "pci_register_driver", structs: ["pci_driver"],
        code: "static struct pci_driver nvme_driver = {\n    .name     = \"nvme\",\n    .id_table = nvme_id_table,   /* class = 0x010802 */\n    .probe    = nvme_probe,\n    .remove   = nvme_remove,\n};" },
      { layer: "pci", title: "PCI probe 入口",
        desc: "nvme_probe() 使能设备、打开 bus master(DMA)，为后续寄存器访问与 DMA 做准备。",
        file: "drivers/nvme/host/pci.c", func: "nvme_probe", structs: ["nvme_dev"] },
      { layer: "pci", title: "映射 BAR0",
        desc: "nvme_dev_map() 把 BAR0 映射进内核：控制器寄存器(CAP/CC/CSTS) 与 SQ/CQ doorbell 区(dev->dbs)。",
        file: "drivers/nvme/host/pci.c", func: "nvme_dev_map",
        code: "dev->bar = ioremap(pci_resource_start(pdev, 0), size);\ndev->dbs = dev->bar + NVME_REG_DBS;   /* SQ/CQ doorbells */" },
      { layer: "pci", title: "分配 ctrl / 申请 MSI-X",
        desc: "nvme_init_ctrl() 分配 nvme_ctrl；nvme_setup_irqs() 申请 MSI-X 向量（理想每 CQ 一个）。",
        file: "drivers/nvme/host/pci.c", func: "nvme_setup_irqs", structs: ["nvme_ctrl"] },
      { layer: "ctrl", title: "读 CAP 寄存器",
        desc: "读取控制器能力：MQES(队列深度上限)、DSTRD(doorbell 步长)、TO(超时)、CSS(命令集)、MPS/MPSMIN。",
        file: "drivers/nvme/host/pci.c", func: "readl(dev->bar + NVME_REG_CAP)" },
      { layer: "ctrl", title: "关闭控制器 (CC.EN=0)",
        desc: "按规范先把 CC.EN 置 0 并轮询 CSTS.RDY=0，确保控制器处于可配置状态。",
        file: "drivers/nvme/host/pci.c", func: "nvme_disable_ctrl" },
      { layer: "ctrl", title: "配置 Admin 队列",
        desc: "写 AQA(admin 队列属性/深度)、ASQ/ACQ(admin SQ/CQ 的物理 DMA 地址)。",
        file: "drivers/nvme/host/pci.c", func: "nvme_setup_admin_queue" },
      { layer: "ctrl", title: "使能控制器 (CC.EN=1)",
        desc: "写 CC：IOSQES=IOCQES=4(16B 命令/完成项)、MPS、CSS；再置 CC.EN=1 并轮询 CSTS.RDY=1。",
        file: "drivers/nvme/host/pci.c", func: "nvme_enable_ctrl" },
      { layer: "ident", title: "Identify Controller",
        desc: "admin 命令 CNS=1，取回 cntlid、subnqn、控制器 NQN、sn/mn/fr、mdts、oacs 等。",
        file: "drivers/nvme/host/core.c", func: "nvme_identify_ctrl", structs: ["nvme_id_ctrl"],
        code: "cmd.identify.cns = NVME_ID_CNS_CTRL;   /* CNS = 1 */\n/* id->cntlid, id->subnqn, id->sn, id->mn, id->mdts, id->oacs ... */" },
      { layer: "ident", title: "建立子系统 (subsys)",
        desc: "nvme_init_subsystem() 以 subnqn 为 key 创建/复用 nvme_subsystem —— 多路径分组的依据。",
        file: "drivers/nvme/host/core.c", func: "nvme_init_subsystem", structs: ["nvme_subsystem"] },
      { layer: "ident", title: "Identify Namespace",
        desc: "对每个 NSID 执行 CNS=0，取 nsze/ncap、LBA 格式、nguid/uuid/eui64。",
        file: "drivers/nvme/host/core.c", func: "nvme_identify_ns", structs: ["nvme_id_ns"] },
      { layer: "ident", title: "Set Features",
        desc: "设置队列数、仲裁方式、中断合并、异步事件等运行时特性。",
        file: "drivers/nvme/host/core.c", func: "nvme_set_features" },
      { layer: "queue", title: "创建 IO 队列对",
        desc: "admin 命令 Create I/O CQ + Create I/O SQ，逐一建立 SQ/CQ 队列对并分配 DMA 内存。",
        file: "drivers/nvme/host/pci.c", func: "nvme_create_io_queues",
        code: "/* admin opcodes */\nNVME_ADMIN_CREATE_CQ;   NVME_ADMIN_CREATE_SQ;" },
      { layer: "queue", title: "队列绑定 CPU",
        desc: "blk_mq_map_queues() / nvme_pci_map_queues() 把 hctx 绑定到 CPU，实现每核队列、避免锁竞争。",
        file: "drivers/nvme/host/pci.c", func: "nvme_pci_map_queues" },
      { layer: "ns", title: "扫描命名空间",
        desc: "nvme_scan_namespaces() → nvme_alloc_ns()：alloc_disk、设置容量/LBA、创建 tagset。",
        file: "drivers/nvme/host/core.c", func: "nvme_alloc_ns", structs: ["nvme_ns", "gendisk"] },
      { layer: "ns", title: "注册控制器",
        desc: "nvme_register_ctrl() 设置 cntlid/实例号，创建字符设备 /dev/nvme0 与 /sys/class/nvme/nvme0。",
        file: "drivers/nvme/host/core.c", func: "nvme_register_ctrl" },
      { layer: "ns", title: "块设备就绪",
        desc: "device_add_disk() 完成后，内核中出现 /dev/nvme0n1，可被挂载或直接读写。",
        file: "drivers/nvme/host/core.c", func: "device_add_disk" }
    ]
  };

  // ===================== IO 路径公共层序 =====================
  const IO_ORDER = ["user", "syscall", "fs", "block", "sched", "nvme_core", "nvme_pci", "hw", "complete"];

  // ---- 公共的“下行”步骤（很多场景复用）----
  const S_down = [
    { layer: "block", title: "提交 bio 到块层",
      desc: "submit_bio() 把 bio 交给通用块层；submit_bio_noacct() 处理栈式递归提交（旧版为 generic_make_request）。",
      file: "block/blk-core.c",
      func: { "4.19": "generic_make_request", "5.4": "generic_make_request", "*": "submit_bio_noacct" },
      structs: ["bio"], vnote: { "4.19": "旧版本走 generic_make_request() 递归下发。", "*": "5.9 起由 submit_bio_noacct() 统一处理无账户提交。" } },
    { layer: "block", title: "blk-mq 分配 request + tag",
      desc: "blk_mq_submit_bio() 为该 IO 分配一个 request（由 tagset 的 tag 索引），放入每 CPU 的软件队列。",
      file: "block/blk-mq.c", func: "blk_mq_submit_bio", structs: ["request", "blk_mq_tags", "blk_mq_ctx"] },
    { layer: "block", title: "plug 攒批 / 合并",
      desc: "blk_start_plug()/blk_finish_plug() 把相邻请求攒在一起批量下发，提升合并与吞吐。",
      file: "block/blk-mq.c", func: "blk_mq_flush_plug_list" },
    { layer: "sched", title: "IO 调度器裁决",
      desc: "调度器（NVMe 默认 none，可选 mq-deadline / kyber / bfq）决定请求下发顺序。",
      file: "block/mq-deadline.c", func: "elevator dispatch" },
    { layer: "sched", title: "派发到硬件队列",
      desc: "blk_mq_dispatch_rq_list() 从 hctx 取出请求，调用驱动回调 q->mq_ops->queue_rq()。",
      file: "block/blk-mq.c", func: "blk_mq_dispatch_rq_list", structs: ["blk_mq_hw_ctx"] },
    { layer: "nvme_core", title: "进入 NVMe 驱动",
      desc: "nvme_queue_rq() 是驱动的提交入口，被 blk-mq 调用。",
      file: "drivers/nvme/host/core.c", func: "nvme_queue_rq", structs: ["nvme_queue", "nvme_dev"] },
    { layer: "nvme_core", title: "编码 NVMe 命令",
      desc: "nvme_setup_cmd() → nvme_setup_rw()：填入 opcode(Read 0x02/Write 0x01)、NSID、SLBA、NLB、DSM。",
      file: "drivers/nvme/host/core.c", func: "nvme_setup_cmd",
      code: "cmd->common.opcode = nvme_cmd_read;   /* 0x02 */\ncmd->common.nsid    = ns->head->ns_id;\ncmd->rw.slba = cpu_to_le64(blk_rq_pos(req) >> (ns->lba_shift - 9));\ncmd->rw.length = cpu_to_le16((blk_rq_bytes(req) >> ns->lba_shift) - 1);" },
    { layer: "nvme_core", title: "DMA 映射 (PRP / SGL)",
      desc: "nvme_map_data() 把数据页映射为 PRP 列表或 SGL，供控制器 DMA 读取/写入主机内存。",
      file: "drivers/nvme/host/pci.c", func: "nvme_map_data", structs: ["nvme_command", "prp_list"] },
    { layer: "nvme_core", title: "写入提交队列 SQ",
      desc: "nvme_submit_cmd() 把 SQE 写进 NVMe 提交队列(内存中的 SQ)，并推进 sq_tail。",
      file: "drivers/nvme/host/core.c", func: "nvme_submit_cmd", structs: ["nvme_queue"] },
    { layer: "nvme_core", title: "敲 doorbell 通知",
      desc: "nvme_write_sq_db() 写 BAR0 中该队列的 SQ tail doorbell —— 这一步真正“告诉”硬件有新命令。",
      file: "drivers/nvme/host/pci.c", func: "nvme_write_sq_db",
      code: "writel(nvmeq->sq_tail, nvmeq->q_db + nvmeq->dev->db_stride);" },
    { layer: "nvme_pci", title: "MMIO 写到达控制器",
      desc: "doorbell 是 BAR0 上的 MMIO 寄存器；写操作经 PCIe 直达 NVMe 控制器寄存器空间。",
      file: "drivers/nvme/host/pci.c", func: "writel() → MMIO", structs: ["nvme_dev"] },
    { layer: "hw", title: "控制器取 SQ → 执行",
      desc: "控制器通过 DMA 读取 SQ 中的 SQE，执行读/写；SSD 内部经 FTL(LBA→PBA、磨损均衡、GC) 落到 NAND。",
      file: "(SSD 固件)", func: "NVMe 控制器 + FTL + NAND" },
    { layer: "hw", title: "写完成项 CQE",
      desc: "命令完成后，控制器把完成项 CQE 写入完成队列 CQ，翻转 phase bit，并触发 MSI-X 中断。",
      file: "drivers/nvme/host/pci.c", func: "CQE → CQ", structs: ["nvme_completion"] },
    { layer: "complete", title: "中断入口",
      desc: "MSI-X 中断触发 nvme_irq() → nvme_process_cq()，读取 CQE、按 phase bit 判定新完成。",
      file: "drivers/nvme/host/pci.c", func: "nvme_irq → nvme_process_cq" },
    { layer: "complete", title: "结束请求",
      desc: "blk_mq_complete_request() → blk_mq_end_request()：在软中断(BLOCK_SOFTIRQ)或提交 CPU 上收尾。",
      file: "block/blk-mq.c", func: "blk_mq_end_request" },
    { layer: "complete", title: "bio_endio 唤醒进程",
      desc: "bio_endio() 解锁页/完成 iomap DIO，最终唤醒等待的进程，系统调用返回用户态。",
      file: "block/bio.c", func: "bio_endio" }
  ];

  // ===== 读 IO 场景 =====
  const read = {
    key: "read", name: "应用读 IO (read)", cmd: "read /dev/nvme0n1",
    blurb: "从 read() 系统调用一路钻到 SQ/CQ，再走完成路径返回。",
    order: IO_ORDER,
    steps: [
      { layer: "user", title: "应用发起读",
        desc: "用户进程调用 read()/pread()，把文件描述符、用户缓冲区与长度交给内核。",
        file: "(用户态)", func: "read(fd, buf, 4096)", structs: [] },
      { layer: "syscall", title: "进入系统调用 / VFS",
        desc: "ksys_read() → vfs_read() → 调用 file->f_op->read_iter()（普通文件走 ext4/xfs，块设备走 blkdev）。",
        file: "fs/read_write.c", func: "ksys_read → vfs_read → f_op->read_iter", structs: ["file", "file_operations"] },
      { layer: "syscall", title: "准备 kiocb / iov_iter",
        desc: "把用户地址封装为 iov_iter；是缓冲读还是直接读（O_DIRECT）在此判定。",
        file: "fs/read_write.c", func: "init_sync_kiocb / iov_iter_init", structs: ["kiocb", "iov_iter"] },
      { layer: "fs", title: "缓冲读：查 page cache",
        desc: "缓冲路径先查页缓存；命中则直接拷贝到用户缓冲区。",
        file: "mm/filemap.c",
        func: { "4.19": "generic_file_read_iter", "5.4": "generic_file_read_iter", "5.15": "filemap_read", "6.1": "filemap_read", "6.8": "filemap_read" },
        structs: ["address_space"],
        vnote: { "*": "6.x 使用 filemap_read() + folio；旧版本为 generic_file_read_iter() + page。" } },
      { layer: "fs", title: "未命中：预读 / 读入",
        desc: "缺页时触发 readahead / read_folio，向块层提交 bio 把数据读入页缓存。",
        file: "mm/readahead.c",
        func: { "4.19": "do_generic_file_read → readpage", "5.4": "readahead → readpage", "5.15": "filemap_read_folio", "6.1": "filemap_read_folio → read_folio", "6.8": "readahead → read_folio" },
        vnote: { "*": "5.16 起 readpage/readpages 改为 read_folio/readahead，单位由 page 变为 folio。" } },
      { layer: "fs", title: "iomap 映射 → submit_bio",
        desc: "文件系统(ext4/xfs)经 iomap 把逻辑偏移映射到物理 LBA，构造 bio 提交给块层。",
        file: "fs/iomap/buffered-io.c", func: "iomap_read_folio → submit_bio", structs: ["iomap", "bio"] },
      { layer: "fs", title: "直接读 (O_DIRECT，可选)",
        desc: "若使用 O_DIRECT，则绕过页缓存，iomap 直接组织 bio 发给块层。",
        file: "fs/iomap/direct-io.c",
        func: { "4.19": "__blockdev_direct_IO / ext4_direct_IO", "5.4": "iomap_dio_rw", "5.15": "iomap_dio_rw", "6.1": "iomap_dio_rw", "6.8": "iomap_dio_rw" },
        vnote: { "*": "5.x 起统一到 iomap；块设备经 __blkdev_direct_IO 提交真正的磁盘读。" } }
    ].concat(S_down)
  };

  // ===== 写 IO 场景 =====
  const write = {
    key: "write", name: "应用写 IO (write)", cmd: "write /dev/nvme0n1",
    blurb: "写路径：页缓存/回写或直接写，命令 opcode=Write(0x01)，涉及 FUA/FLUSH。",
    order: IO_ORDER,
    steps: [
      { layer: "user", title: "应用发起写",
        desc: "用户进程调用 write()/pwrite()，提交数据缓冲区。",
        file: "(用户态)", func: "write(fd, buf, 4096)" },
      { layer: "syscall", title: "VFS 写入口",
        desc: "ksys_write() → vfs_write() → file->f_op->write_iter()。",
        file: "fs/read_write.c", func: "ksys_write → vfs_write → f_op->write_iter" },
      { layer: "fs", title: "缓冲写：只写页缓存",
        desc: "generic_perform_write() 把数据写入页缓存并标脏，立即返回；真正落盘延迟到回写。",
        file: "mm/filemap.c", func: "generic_perform_write", structs: ["address_space"] },
      { layer: "fs", title: "回写 (writeback)",
        desc: "脏页由 flusher/kworker 触发 writepages，经 iomap 组织 bio 提交（O_SYNC/fsync 会即时触发）。",
        file: "mm/page-writeback.c", func: "do_writepages → iomap_writepages",
        vnote: { "*": "fsync()/O_SYNC 会触发 FLUSH/FUA，把易失缓存刷到介质。" } },
      { layer: "fs", title: "直接写 (O_DIRECT，可选)",
        desc: "iomap_dio_rw() 绕过页缓存，直接构造 bio 提交；FUA 控制单命令是否强制落盘。",
        file: "fs/iomap/direct-io.c", func: "iomap_dio_rw" }
    ].concat(S_down)
  };

  // ===== io_uring 场景 =====
  const iouring = {
    key: "iouring", name: "io_uring 异步 IO", cmd: "io_uring",
    blurb: "共享 SQ/CQ 环形队列批量提交，可开 IOPOLL 轮询省去中断。",
    order: IO_ORDER,
    steps: [
      { layer: "user", title: "填充 SQ ring",
        desc: "应用把 SQE(读/写描述)写入用户态与内核共享的提交环，调用一次 io_uring_enter() 批量提交。",
        file: "io_uring/io_uring.c", func: "io_uring_enter", structs: ["io_uring_sqe"] },
      { layer: "syscall", title: "内核收割 SQE",
        desc: "io_submit_sqes() 批量取出 SQE，转成 io_kiocb 并分派到对应操作。",
        file: "io_uring/rw.c", func: "io_submit_sqes → io_read/io_write", structs: ["io_kiocb"] },
      { layer: "fs", title: "进入读/写路径",
        desc: "与同步路径共用文件系统与块层：缓冲/直接、iomap → submit_bio。",
        file: "io_uring/rw.c", func: "io_rw → submit_bio" }
    ].concat(S_down).concat([
      { layer: "complete", title: "完成写入共享 CQ ring",
        desc: "若开启 IOPOLL，则内核主动轮询 CQ 而不依赖中断，完成后把 CQE 写入共享完成环，应用零系统调用收割。",
        file: "io_uring/io_uring.c", func: "io_uring_cqe / IORING_SETUP_IOPOLL",
        vnote: { "*": "IOPOLL 需驱动支持队列轮询（NVMe 支持）。" } }
    ])
  };

  const scenarios = { init: init, read: read, write: write, iouring: iouring };
  const scenarioList = [init, read, write, iouring];

  return { KERNELS: KERNELS, LAYERS: LAYERS, scenarios: scenarios, scenarioList: scenarioList };
})();
