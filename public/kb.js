/* NVMe IO 链路互动教学 —— 知识库
 * 为每一步补充：简化关键结构体(STRUCTS)、关键代码逻辑(LOGIC)、模块框图箭头标签(ARROW_LABELS)。
 * 由 data.js 之后加载，直接挂到 window.APP_DATA 上。
 */
(function () {
  const A = (window.APP_DATA = window.APP_DATA || {});

  /* ================= 简化关键结构体 ================= */
  A.STRUCTS = {
    page: `struct page {                 /* 内存页 (<=5.15 的 IO 单位) */
    unsigned long flags;
    struct address_space *mapping;  /* 隶属的页缓存 */
    pgoff_t index;                  /* 页在文件中的序号 */
    ...
};`,
    folio: `struct folio {                  /* 一个或多个连续页 (5.16+) */
    struct page page;
    ...
};`,
    file: `struct file {                  /* 打开的文件 / 块设备 */
    struct path f_path;
    struct inode *f_inode;
    const struct file_operations *f_op;
    unsigned int f_flags;           /* O_DIRECT / O_SYNC ... */
    ...
};`,
    file_operations: `struct file_operations {
    ssize_t (*read_iter)(struct kiocb *, struct iov_iter *);
    ssize_t (*write_iter)(struct kiocb *, struct iov_iter *);
    ...
};`,
    kiocb: `struct kiocb {                 /* 一次 IO 的上下文 */
    struct file *ki_filp;
    loff_t ki_pos;
    void (*ki_complete)(struct kiocb *, long, long);
    unsigned int ki_flags;          /* IOCB_DIRECT / IOCB_DSYNC */
    ...
};`,
    iov_iter: `struct iov_iter {               /* 用户/内核缓冲区描述 */
    unsigned int type;              /* ITER_IOVEC / ITER_DISCARD... */
    size_t count;
    union { struct iovec *iov; struct kvec *kvec; ... };
};`,
    address_space: `struct address_space {         /* 页缓存锚点 */
    struct inode *host;
    struct xarray i_pages;          /* 缓存的 page/folio */
    unsigned long nrpages;
    ...
};`,
    iomap: `struct iomap {                 /* 逻辑偏移 -> 物理映射 */
    u64   addr;                     /* 物理地址(字节/LBA) */
    loff_t offset;
    u64   length;
    u16   type;                     /* IOMAP_MAPPED / HOLE ... */
    ...
};`,
    bio: `struct bio {                   /* 块层 IO 请求 */
    struct block_device *bi_bdev;
    struct bvec_iter bi_iter;       /* bi_sector / bi_size */
    unsigned int bi_opf;            /* REQ_OP_READ/WRITE, FUA */
    struct bio_vec bi_inline_vecs[];
};`,
    blk_mq_ctx: `struct blk_mq_ctx {            /* 每 CPU 软件队列 */
    struct list_head rq_lists[HCTX_MAX_TYPES];
    ...
};`,
    request: `struct request {               /* blk-mq 请求(带 tag) */
    struct request_queue *q;
    struct blk_mq_ctx   *mq_ctx;    /* 所属软件队列 */
    struct blk_mq_hw_ctx *mq_hctx;  /* 所属硬件队列 */
    unsigned int tag;              /* 队列 slot 索引 */
    struct bio *bio;
    ...
};`,
    blk_mq_tags: `struct blk_mq_tags {           /* tag 池 */
    unsigned int nr_tags;
    struct sbitmap bitmap;          /* tag 分配位图 */
    struct request **rqs;
    ...
};`,
    blk_mq_hw_ctx: `struct blk_mq_hw_ctx {         /* 硬件派发队列 */
    void *sched_data;               /* 调度器私有数据 */
    struct blk_mq_tags *tags;
    unsigned int nr_tags;
    struct request_queue *queue;
    ...
};`,
    elevator_queue: `struct elevator_queue {        /* IO 调度器实例 */
    struct elevator_type *type;     /* none / mq-deadline / kyber / bfq */
    void *elevator_data;
    ...
};`,
    nvme_dev: `struct nvme_dev {              /* 一个 PCIe NVMe 控制器 */
    struct nvme_ctrl ctrl;
    u32 __iomem *dbs;               /* doorbell 区(BAR0) */
    struct nvme_queue *queues;      /* IO 队列数组 */
    struct dma_pool *prp_page_pool; /* PRP 列表池 */
    ...
};`,
    nvme_queue: `struct nvme_queue {            /* 一对 SQ/CQ */
    struct nvme_dev *dev;
    __le64 *sq;                     /* 提交队列(DMA 内存) */
    __le64 *cq;                     /* 完成队列(DMA 内存) */
    dma_addr_t sq_dma_addr, cq_dma_addr;
    u32 __iomem *q_db;              /* 本队列 doorbell */
    u16 q_depth, qid;
    u16 sq_head, sq_tail, cq_head;
    ...
};`,
    nvme_command: `struct nvme_command {          /* 提交队列项 SQE (64B) */
    __u8  opcode;   __u8  flags;
    __le16 command_id;  __le16 nsid;
    __le32 cdw2[2]; __le64 metadata;
    __le64 prp1;    __le64 prp2;    /* 数据页指针 */
    union { struct nvme_rw_command rw; ... };
};`,
    nvme_completion: `struct nvme_completion {       /* 完成队列项 CQE (16B) */
    __le32 result;
    __le16 sq_head;  __le16 sq_id;
    __le16 command_id;
    __le16 status;                  /* 含 phase bit */
};`,
    nvme_ctrl: `struct nvme_ctrl {             /* 控制器抽象 */
    struct device *dev;
    struct nvme_subsystem *subsys;  /* 以 subnqn 分组 */
    u16  cntlid;                    /* 控制器 ID */
    int  instance;                  /* nvme0 里的 0 */
    char subnqn[NVMF_NQN_SIZE];
    char nqn[NVMF_NQN_SIZE];
    ...
};`,
    nvme_subsystem: `struct nvme_subsystem {        /* 同 subnqn 的控制器集合(多路径域) */
    char subnqn[NVMF_NQN_SIZE];
    char serial[20];
    char model[40];
    struct list_head ctrls;
    ...
};`,
    nvme_ns: `struct nvme_ns {               /* 命名空间 */
    struct nvme_ctrl *ctrl;
    u32 ns_id;                      /* NSID */
    u8  uuid[16]; u8 nguid[16]; u64 eui64;
    u8  lba_shift;                  /* 块大小 = 2^lba_shift */
    struct gendisk *disk;
    ...
};`,
    gendisk: `struct gendisk {               /* 块设备 -> /dev/nvme0n1 */
    int major; int first_minor;
    char disk_name[32];             /* "nvme0n1" */
    struct request_queue *queue;
    const struct block_device_operations *fops;
    ...
};`,
    nvme_id_ctrl: `struct nvme_id_ctrl {          /* Identify Controller 返回 */
    __le16 vid;  __le16 ssvid;
    char sn[20]; char mn[40]; char fr[8];
    __le16 cntlid;                  /* 控制器 ID */
    char subnqn[256];               /* 子系统 NQN */
    __u8  mdts;  __le16 oacs;
    ...
};`,
    nvme_id_ns: `struct nvme_id_ns {            /* Identify Namespace 返回 */
    __le64 nsze;                    /* 容量(逻辑块) */
    __le64 ncap;                    /* 可分配容量 */
    __le64 nuse;                    /* 已用 */
    __u8   nguid[16]; __u8 eui64[8];
    __u8   lbaf[16];                /* LBA 格式表 */
    ...
};`,
    pci_driver: `struct pci_driver {
    const char *name;
    const struct pci_device_id *id_table;  /* class = 0x010802 */
    int (*probe)(struct pci_dev *, const struct pci_device_id *);
    ...
};`,
    prp_list: `/* PRP 列表：数据跨多页时，PRP2 指向该列表 */
struct prp_list {
    __le64 prp[PAGE_SIZE / 8 - 1];   /* 每项=一页物理地址 */
};`,
    io_uring_sqe: `struct io_uring_sqe {          /* 共享提交环项 */
    __u8  opcode;               /* IORING_OP_READ / WRITE */
    __u8  flags;
    __s32 fd;
    __u64 off;   __u64 addr;    /* 文件偏移 / 缓冲区地址 */
    __u32 len;
    __u64 user_data;            /* 原样带回给应用 */
    ...
};`,
    io_kiocb: `struct io_kiocb {              /* io_uring 内核侧请求 */
    struct file *file;
    struct io_ring_ctx *ctx;
    u8 opcode;
    union { struct io_rw rw; ... };
    ...
};`
  };

  /* ================= 模块框图箭头标签 ================= */
  A.ARROW_LABELS = {
    syscall: "系统调用", fs: "kiocb / iov_iter", block: "bio",
    sched: "request", nvme_core: "request → SQE", nvme_pci: "SQE / doorbell",
    hw: "doorbell", complete: "CQE / 中断",
    pci: "PCI 匹配", ctrl: "CAP / CC 寄存器", ident: "admin 命令",
    queue: "Create SQ/CQ", ns: "NSID / gendisk"
  };

  /* ================= 关键代码逻辑 ================= */
  A.LOGIC = {
    /* ---------- 初始化 ---------- */
    "加载 nvme-core 模块": `bus_register(&nvme_bus_type);
alloc_chrdev_region(&nvme_chr_devt, 0, NVME_MINORS, "nvme");
class_create("nvme");                             /* /sys/class/nvme */
class_create("nvme-subsystem");                   /* /sys/class/nvme-subsystem */`,
    "注册 PCI 驱动": `/* id_table: class = 0x010802 (NVM Express) */
pci_register_driver(&nvme_driver);
/* 匹配成功后，PCI 子系统调用 nvme_probe() */`,
    "PCI probe 入口": `pcim_enable_device(pdev);      /* 使能设备 */
pci_set_master(pdev);          /* 打开 bus master，允许 DMA */
return nvme_dev_add(dev);`,
    "映射 BAR0": `/* BAR0 同时包含控制器寄存器与 SQ/CQ doorbell */
dev->bar = ioremap(pci_resource_start(pdev, 0), size);
dev->dbs = dev->bar + NVME_REG_DBS;   /* doorbell 基址 */`,
    "分配 ctrl / 申请 MSI-X": `nvme_init_ctrl(&dev->ctrl, dev->dev, &nvme_pci_ctrl_ops, id);
/* 理想：每个完成队列一个中断向量 */
pci_alloc_irq_vectors(pdev, 1, nr_queues, PCI_IRQ_ALL_TYPES);`,
    "读 CAP 寄存器": `cap   = readl(dev->bar + NVME_REG_CAP);
mqes  = CAP_MQES(cap);     /* 最大队列深度 */
dstrd = CAP_DSTRD(cap);    /* doorbell 步长 */
dev->db_stride = 1 << dstrd;`,
    "关闭控制器 (CC.EN=0)": `writel(0, dev->ctrl.ctrl_config);            /* CC.EN = 0 */
do { usleep_range(1, 2); }
while (readl(dev->bar + NVME_REG_CSTS) & NVME_CSTS_RDY);  /* 等 RDY=0 */`,
    "配置 Admin 队列": `writel((qd - 1) | ((qd - 1) << 16), bar + NVME_REG_AQA);
writel(lower_32_bits(admin_q.sq_dma_addr), bar + NVME_REG_ASQ);
writel(lower_32_bits(admin_q.cq_dma_addr), bar + NVME_REG_ACQ);`,
    "使能控制器 (CC.EN=1)": `val = NVME_CC_ENABLE | NVME_CC_CSS_NVM
    | NVME_CC_MPS(0) | NVME_CC_IOSQES(4) | NVME_CC_IOCQES(4);
writel(val, bar + NVME_REG_CC);
while (!(readl(bar + NVME_REG_CSTS) & NVME_CSTS_RDY)) { /* 等 RDY=1 */ }`,
    "Identify Controller": `nvme_identify_ctrl(ctrl, &id);           /* admin: CNS=1 */
ctrl->cntlid = le16_to_cpu(id->cntlid);
memcpy(ctrl->subnqn, id->subnqn, sizeof(ctrl->subnqn));
ctrl->mdts = id->mdts;`,
    "建立子系统 (subsys)": `subsys = nvme_find_get_subsystem(ctrl->subnqn);
if (!subsys) subsys = nvme_alloc_subsystem(ctrl);  /* 新建子系统 */
list_add(&ctrl->subsys_entry, &subsys->ctrls);     /* 挂到同一 subnqn 下 */`,
    "Identify Namespace": `for (nsid = 1; nvme_identify_ns(ctrl, nsid, &id_ns); nsid++)
    if (id_ns->nsze)   /* 容量非 0 => 有效命名空间 */
        nvme_alloc_ns(ctrl, nsid, &id_ns);`,
    "Set Features": `nvme_set_queue_count(ctrl, &nr_queues);   /* 协商队列数 */
nvme_set_features(ctrl, NVME_FEAT_ARBITRATION, ...);
nvme_set_features(ctrl, NVME_FEAT_ASYNC_EVENT, ...);`,
    "创建 IO 队列对": `for (i = 0; i < ctrl->queue_count; i++) {
    nvme_create_cq(dev, i);   /* admin: Create I/O Completion Queue */
    nvme_create_sq(dev, i);   /* admin: Create I/O Submission Queue */
}`,
    "队列绑定 CPU": `/* 把每个 hctx 映射到 CPU，实现每核队列、无锁并发 */
nvme_pci_map_queues(&ctrl->tagset) -> blk_mq_map_queues();`,
    "扫描命名空间": `ns->disk = alloc_disk(NVME_MINORS);
ns->disk->queue = blk_mq_init_queue(&ctrl->tagset);
set_capacity(ns->disk, nvme_ns_nlbas(ns));
add_disk(ns->disk);`,
    "注册控制器": `ctrl->cntlid = ...;                 /* Identify 得到 */
ctrl->instance = ida_alloc(&nvme_instance_ida, ...);  /* -> nvme0 */
device_add(&ctrl->ctrl_device);    /* /sys/class/nvme/nvme0 */
cdev_device_add(&ctrl->cdev, ...); /* /dev/nvme0 (ioctl 通道) */`,
    "块设备就绪": `device_add_disk(disk, ns);
/* 内核中出现 /dev/nvme0n1，可挂载或直接读写 */`,

    /* ---------- 下行公共步骤 ---------- */
    "提交 bio 到块层": `submit_bio(bio);          /* -> submit_bio_noacct() */
/* 旧版: generic_make_request() 递归下发 */`,
    "blk-mq 分配 request + tag": `req = blk_mq_alloc_request(q, op, BLK_MQ_REQ_NOWAIT);
req->tag = sbitmap_queue_get(&tags->bitmap);   /* 分配 tag */
blk_mq_sched_insert_request(req);              /* 入队 */`,
    "plug 攒批 / 合并": `blk_start_plug(&plug);
... 提交多个相邻 bio ...
blk_finish_plug(&plug);     /* -> blk_mq_flush_plug_list() 合并批量下发 */`,
    "IO 调度器裁决": `/* NVMe 默认 none: 直通; 可选 mq-deadline/kyber/bfq */
e->type->ops.insert_requests(hctx, &list);`,
    "派发到硬件队列": `blk_mq_dispatch_rq_list(hctx, &list, false);
  -> q->mq_ops->queue_rq(hctx, &bd);   /* 调到驱动: nvme_queue_rq */`,
    "进入 NVMe 驱动": `static blk_status_t nvme_queue_rq(struct blk_mq_hw_ctx *hctx,
                                   const struct blk_mq_queue_data *bd)
{
    ret = nvme_prep_rq(dev, req);   /* 编码命令(nvme_setup_cmd)+DMA 映射 */
    spin_lock(&nvmeq->sq_lock);
    nvme_sq_copy_cmd(nvmeq, &iod->cmd);  /* SQE 入 SQ，批量走 nvme_submit_cmds */
    nvme_write_sq_db(nvmeq, bd->last);   /* 敲 doorbell */
    spin_unlock(&nvmeq->sq_lock);
}`,
    "编码 NVMe 命令": `cmd->common.opcode = nvme_cmd_read;   /* 0x02, 写为 0x01 */
cmd->common.nsid   = ns->head->ns_id; /* 命名空间 ID */
cmd->rw.slba  = cpu_to_le64(blk_rq_pos(req) >> (ns->lba_shift - 9));
cmd->rw.length = cpu_to_le16((blk_rq_bytes(req) >> ns->lba_shift) - 1);`,
    "DMA 映射 (PRP / SGL)": `dma_map_sgtable(dev->dev, &req->sg_table, dir, 0);
cmnd->rw.prp1 = cpu_to_le64(sg_dma_address(sg));
/* 多段时用 PRP list 或 SGL 描述 */`,
    "写入提交队列 SQ": `memcpy(&nvmeq->sq[nvmeq->sq_tail], cmnd, sizeof(*cmnd));
if (++nvmeq->sq_tail == nvmeq->q_depth)
    nvmeq->sq_tail = 0;            /* 环形回绕 */`,
    "敲 doorbell 通知": `/* 写该队列 SQ tail doorbell（BAR0 MMIO） */
writel(nvmeq->sq_tail, nvmeq->q_db + nvmeq->dev->db_stride);`,
    "MMIO 写到达控制器": `/* doorbell 是 BAR0 上的 MMIO 寄存器;
 * writel() 经 PCIe TLP 直达控制器寄存器空间 */`,
    "控制器取 SQ → 执行": `/* 控制器 DMA 读 SQ[tail] 取 SQE -> 解析 -> 
 * FTL 地址映射(LBA->PBA) + 磨损均衡/GC -> NAND 读写 */`,
    "写完成项 CQE": `/* 命令完成：把 CQE 写入完成队列 CQ，翻转 phase bit */
cq[cq_head] = completion;      /* status 内嵌 phase bit */
/* 触发 MSI-X 中断 */`,
    "中断入口": `irqreturn_t nvme_irq(int irq, void *data)
{
    nvme_process_cq(nvmeq);    /* 按 phase bit 找出新完成项 */
}`,
    "结束请求": `blk_mq_complete_request(req);
  -> blk_mq_end_request(req, status);   /* 软中断 / 提交 CPU 收尾 */`,
    "bio_endio 唤醒进程": `blk_update_request(req, error, nr_bytes);
bio_endio(req->bio);           /* -> 解锁 folio / iomap_dio_complete */
/* complete() 唤醒等待的进程，syscall 返回 */`,

    /* ---------- 读路径 ---------- */
    "应用发起读": `char *buf = malloc(4096);
ssize_t n = read(fd, buf, 4096);
/* 或 pread(fd, buf, 4096, offset); */`,
    "进入系统调用 / VFS": `SYSCALL_DEFINE3(read, ...) -> ksys_read();
  -> vfs_read();
    -> file->f_op->read_iter(file, kiocb, iter);`,
    "准备 kiocb / iov_iter": `init_sync_kiocb(&kiocb, file);
iov_iter_init(&iter, ITER_DEST, &iov, 1, count);`,
    "缓冲读：查 page cache": `/* 6.x: filemap_read() + folio; 旧版 generic_file_read_iter() */
filemap_read(kiocb, iter, count)
  -> folio = filemap_get_folio(mapping, index);
  /* 命中：直接 copy 到用户缓冲区 */`,
    "未命中：预读 / 读入": `if (!folio) {
    page_cache_sync_readahead(mapping, ra, file, index, ...);
    folio = filemap_read_folio(file, mapping, index);  /* 触发读盘 */
}`,
    "iomap 映射 → submit_bio": `iomap_read_folio() -> iomap_begin();
/* FS 把逻辑偏移映射为物理 LBA，构造 bio 提交 */
a_ops->submit_bio(bio);`,
    "直接读 (O_DIRECT，可选)": `iomap_dio_rw(iocb, iter, &iomap_ops, NULL, 0);
/* 绕过页缓存，数据在用户缓冲与设备之间直接 DMA */`,

    /* ---------- 写路径 ---------- */
    "应用发起写": `ssize_t n = write(fd, buf, 4096);
/* 或 pwrite(fd, buf, 4096, offset); */`,
    "VFS 写入口": `SYSCALL_DEFINE3(write, ...) -> ksys_write();
  -> vfs_write();
    -> file->f_op->write_iter(file, kiocb, iter);`,
    "缓冲写：只写页缓存": `generic_perform_write(file, iter, pos):
    folio = pagecache_get_page(mapping, index, DIRTY);
    copy_from_iter(folio, bytes, iter);
    folio_mark_dirty(folio);       /* 标记脏页，延迟落盘 */`,
    "回写 (writeback)": `do_writepages(mapping, wbc)
  -> iomap_writepages() -> submit_bio(bio);   /* 提交脏页 */
/* fsync()/O_SYNC 触发 FLUSH/FUA，强制刷到介质 */`,
    "直接写 (O_DIRECT，可选)": `iomap_dio_rw(iocb, iter, &iomap_ops, NULL,
    IOMAP_DIO_WRITE | (fua ? IOMAP_DIO_FUA : 0));`,

    /* ---------- io_uring ---------- */
    "填充 SQ ring": `struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buf, 4096, offset);
io_uring_submit(&ring);        /* -> io_uring_enter() */`,
    "内核收割 SQE": `io_uring_enter() -> io_submit_sqes();
    for (each sqe)
        io_issue_sqe() -> io_read() / io_write();`,
    "进入读/写路径": `io_read() -> 复用文件系统 + 块层：
    /* 缓冲/直接 -> iomap -> submit_bio() */`,
    "完成写入共享 CQ ring": `/* IOPOLL 模式：内核主动轮询 CQ，不依赖中断 */
io_uring_cqe = ...;   /* 应用直接读共享完成环，零额外 syscall */`
  };

  /* ================= 协议字段表（简化，按结构体名） ================= */
  A.FIELDS = {
    nvme_command: [
      { n: "opcode", b: "1B @0", d: "操作码：Read=0x02 / Write=0x01 / Flush=0x00 / WriteZeroes=0x08 ..." },
      { n: "flags", b: "1B @1", d: "PSDT(PRP 还是 SGL)、FUSE(是否融合命令)" },
      { n: "command_id", b: "2B @2", d: "命令标识 CID，完成时原样返回，用于配对 SQE↔CQE" },
      { n: "nsid", b: "4B @4", d: "命名空间 ID (NSID)，命令作用的命名空间" },
      { n: "cdw2/cdw3", b: "8B @8", d: "命令相关字段(保留/扩展)" },
      { n: "metadata", b: "8B @16", d: "元数据指针 MPTR" },
      { n: "prp1", b: "8B @24", d: "数据页指针 1 (PRP，或 SGL 段)" },
      { n: "prp2", b: "8B @32", d: "数据页指针 2 (可能是 PRP 列表入口)" },
      { n: "cdw10/11", b: "8B @40", d: "Read/Write: SLBA 起始逻辑块地址 (64bit)" },
      { n: "cdw12", b: "4B @48", d: "Read/Write: NLB(块数-1) + FUA/LR/DTYPE/PRINFO 等标志" },
      { n: "cdw13", b: "4B @52", d: "Read/Write: DSM 访问频率/延迟提示" },
      { n: "cdw14/15", b: "8B @56", d: "Read/Write: EILBRT / ELBAT (写保护校验标签)" }
    ],
    nvme_completion: [
      { n: "result", b: "4B @0", d: "命令相关结果 (如错误位置/完成计数)" },
      { n: "rsvd", b: "4B @4", d: "保留" },
      { n: "sq_head", b: "2B @8", d: "控制器侧 SQ 头指针 (已消费到哪)" },
      { n: "sq_id", b: "2B @10", d: "提交队列标识 (命令来自哪个 SQ)" },
      { n: "command_id", b: "2B @12", d: "命令标识 CID (与 SQE 配对)" },
      { n: "status", b: "2B @14", d: "状态字段: bit0=Phase(P), bit1=状态类型, bit2-15=状态码/类型信息" },
      { n: "phase bit (P)", b: "bit0", d: "相位位，随队列每绕一圈翻转；驱动据此判断哪些 CQE 是新完成项" }
    ],
    nvme_id_ctrl: [
      { n: "vid / ssvid", d: "PCI 厂商 ID / 子系统厂商 ID" },
      { n: "sn", d: "序列号 (Serial Number)" },
      { n: "mn", d: "型号 (Model Number)" },
      { n: "fr", d: "固件版本 (Firmware Revision)" },
      { n: "cntlid", d: "控制器 ID —— 子系统内唯一，多路径靠它区分" },
      { n: "subnqn", d: "子系统 NQN —— 多路径分组/故障域的依据" },
      { n: "oacs", d: "可选管理命令支持位图 (如格式化/命名空间管理)" },
      { n: "mdts", d: "最大传输尺寸 = 2^mdts × 最小内存页" },
      { n: "oncs / vwc", d: "可选 NVM 命令、易失写缓存能力" },
      { n: "sqes / cqes", d: "SQE/CQE 大小要求 (NVMe 固定 4=16B)" }
    ],
    nvme_id_ns: [
      { n: "nsze", d: "命名空间容量 (逻辑块数)" },
      { n: "ncap", d: "可分配容量 (逻辑块数)" },
      { n: "nuse", d: "已用逻辑块数" },
      { n: "nguid", d: "命名空间全局唯一标识 (16B)" },
      { n: "eui64", d: "64 位 IEEE EUI 标识" },
      { n: "lbaf[]", d: "LBA 格式表: 逻辑块大小 2^n、(元)数据大小" },
      { n: "nmic / dps", d: "多路径能力 / 数据保护类型" },
      { n: "nsattr", d: "命名空间属性 (如 ZNS 分区命名空间)" }
    ],
    prp_list: [
      { n: "prp[0..N]", d: "每个表项是一个物理页地址；数据跨 >2 页时 PRP2 指向本列表" },
      { n: "规则", d: "PRP1 必须页对齐；PRP2 为最后一页(可不齐)或指向 PRP 列表；列表页必须页对齐" }
    ],
    nvme_queue: [
      { n: "sq", d: "提交队列内存 (SQE 数组，q_depth 项)" },
      { n: "cq", d: "完成队列内存 (CQE 数组，q_depth 项)" },
      { n: "sq_dma_addr / cq_dma_addr", d: "SQ/CQ 物理地址，建队时告知控制器" },
      { n: "q_db", d: "本队列 doorbell 寄存器地址" },
      { n: "q_depth / qid", d: "队列深度 / 队列标识 (admin=0, IO=1..N)" },
      { n: "sq_head / sq_tail", d: "提交队列头/尾索引 (环形回绕)" },
      { n: "cq_head", d: "完成队列消费索引" }
    ]
  };

  /* ================= 字节布局条（SQE / CQE） ================= */
  A.LAYOUT = {
    nvme_command: [
      { f: "opcode", w: 1 }, { f: "flags", w: 1 }, { f: "cid", w: 2 }, { f: "nsid", w: 4 },
      { f: "cdw2", w: 4 }, { f: "cdw3", w: 4 }, { f: "meta", w: 8 }, { f: "prp1", w: 8 },
      { f: "prp2", w: 8 }, { f: "cdw10", w: 4 }, { f: "cdw11", w: 4 }, { f: "cdw12", w: 4 },
      { f: "cdw13", w: 4 }, { f: "cdw14", w: 4 }, { f: "cdw15", w: 4 }
    ],
    nvme_completion: [
      { f: "result", w: 4 }, { f: "rsvd", w: 4 }, { f: "sq_head", w: 2 },
      { f: "sq_id", w: 2 }, { f: "cid", w: 2 }, { f: "status", w: 2 }
    ]
  };

  /* ================= 寄存器 / 管理命令字段（按步骤标题） ================= */
  A.PROTO = {
    "读 CAP 寄存器": [
      { n: "MQES", b: "bit0-15", d: "最大队列项数-1 (队列深度上限)" },
      { n: "CQR", b: "bit16", d: "是否要求物理连续队列" },
      { n: "TO", b: "bit24-31", d: "超时 (×500ms)" },
      { n: "DSTRD", b: "bit32-35", d: "doorbell 步长：寄存器偏移 = 4 << DSTRD" },
      { n: "CSS", b: "bit37-44", d: "支持的命令集位图 (NVM/I/O 等)" },
      { n: "MPSMIN/MPSMAX", b: "bit48-55", d: "最小/最大内存页尺寸 (2^n)" }
    ],
    "使能控制器 (CC.EN=1)": [
      { n: "CC.EN", b: "bit0", d: "1=使能控制器；需等待 CSTS.RDY=1" },
      { n: "CC.CSS", b: "bit4-6", d: "命令集：000=NVM" },
      { n: "CC.MPS", b: "bit7-10", d: "内存页尺寸 (2^12 × 2^n)" },
      { n: "CC.AMS", b: "bit11-13", d: "仲裁方式 (round-robin / WRR)" },
      { n: "CC.IOSQES", b: "bit16-19", d: "SQE 大小=2^n，NVMe 固定 4 (16B)" },
      { n: "CC.IOCQES", b: "bit20-23", d: "CQE 大小=2^n，NVMe 固定 4 (16B)" }
    ],
    "关闭控制器 (CC.EN=0)": [
      { n: "CC.EN", b: "bit0", d: "置 0 请求控制器关闭" },
      { n: "CSTS.RDY", b: "bit0", d: "轮询直到为 0，表示已停妥、可重配" },
      { n: "CSTS.CFS", b: "bit1", d: "控制器致命状态 (需复位)" }
    ],
    "配置 Admin 队列": [
      { n: "AQA.ASQS", b: "bit0-11", d: "admin 提交队列深度-1" },
      { n: "AQA.ACQS", b: "bit16-27", d: "admin 完成队列深度-1" },
      { n: "ASQ", b: "64bit", d: "admin SQ 基址 (物理 DMA 地址)" },
      { n: "ACQ", b: "64bit", d: "admin CQ 基址 (物理 DMA 地址)" }
    ],
    "创建 IO 队列对": [
      { n: "Create I/O CQ", b: "opcode 0x05", d: "CDW10: QID+队列大小; CDW11: PC/IV/IEN(中断向量)" },
      { n: "Create I/O SQ", b: "opcode 0x01", d: "CDW10: QID+队列大小; CDW11: PC/QPRI/CQID" }
    ],
    "敲 doorbell 通知": [
      { n: "SQxTDBL", d: "提交队列 x 的 tail doorbell；写入 = 新的 sq_tail" },
      { n: "CQxHDBL", d: "完成队列 x 的 head doorbell；驱动消费后回写" },
      { n: "偏移", d: "1000h + 2x×(4<<DSTRD)=SQ tail；+1×(4<<DSTRD)=CQ head" }
    ],
    "MMIO 写到达控制器": [
      { n: "doorbell", d: "BAR0 上的 MMIO 寄存器；writel() 经 PCIe TLP 直达控制器" },
      { n: "方向", d: "SQ: 主机->控制器 (通知新命令)；CQ: 控制器->主机 (中断/轮询)" }
    ],
    "写完成项 CQE": [
      { n: "CQE 写入", d: "控制器把 16B CQE 写入 CQ，翻转 phase bit" },
      { n: "phase bit", d: "每绕一圈翻转，是驱动判断新完成项的关键" },
      { n: "MSI-X", d: "按队列触发中断 (或 IOPOLL 轮询)" }
    ]
  };
})();
