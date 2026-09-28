`timescale 1ns / 1ps
//=============================================================================
// tb/tb_top.v — vga_golden_top 自检测试台
// 项目: bench-lib T2 (p21)  |  覆盖 VGA-DRQ-TST-002 场景 (a)-(j)
// v4 = v3 + FIX-T2：
//   1) sample_px 改严格 1:1（等 pix_ce 置位→#1 采样→等撤除；v1-v3 同槽重复
//      采样/跨槽跳样致 hp 失配 —— job-21072aa4 (b) hp=95 fatal 根因，非 DUT）；
//   2) 帧对齐改 vsync 下降后首个上升槽（row0/hp0），不再依赖"使能后首个
//      pix_ce=帧起点"（该假设仅使能首帧成立，场中切换场景必错）；
//   3) fatal 文案 ASCII 化（日志摘要防乱码）。
//-----------------------------------------------------------------------------
// [原则] VGA-DRQ-TST-001：期望值由 TB 内建参考产生（不取自 DUT）；失败 $fatal
//        打印场景/期望/实际；全过打印 PASS。
// [口径] DUT v6：D1（场总 525 行）、D6（极性 XOR）、D7（场界原子快照）、
//        D9（pix_ce 置位沿后 #1 采样）、FIX-5（使能后首拍=场起点）。
// [显存图案] mem[i] = {i[7:0], i[15:8], i[23:16], 1'b0}（地址签名）。
//=============================================================================

module tb_top;

    //=========================================================================
    // 时钟/复位
    //=========================================================================
    reg clk = 1'b0;
    reg rst = 1'b1;
    always #5 clk = ~clk;                 // 100 MHz（PERF-001）

    //=========================================================================
    // DUT 接线
    //=========================================================================
    reg         psel=0, penable=0, pwrite=0;
    reg  [5:0]  paddr=0;
    reg  [31:0] pwdata=0;
    wire [31:0] prdata;
    wire        pready;
    wire        hsync, vsync, blank, pix_ce, irq;
    wire [23:0] rgb;
    wire [31:0] fb_addr;
    wire        fb_rd;
    reg         fb_rvalid=0;
    wire [31:0] fb_rdata;

    vga_golden_top #(.PIXDIV(4), .FIFO_AW(4)) dut (
        .clk(clk), .rst(rst),
        .psel(psel), .penable(penable), .pwrite(pwrite),
        .paddr(paddr), .pwdata(pwdata), .prdata(prdata), .pready(pready),
        .hsync(hsync), .vsync(vsync), .blank(blank), .rgb(rgb), .pix_ce(pix_ce),
        .fb_addr(fb_addr), .fb_rdata(fb_rdata), .fb_rd(fb_rd), .fb_rvalid(fb_rvalid),
        .irq(irq)
    );

    //=========================================================================
    // 显存同步模型（VGA-DRQ-IF-003）+ 欠载注入
    //   bp_mode: 0=无注入(1拍) 1=固定2拍 2=周期性8拍(每4次请求1次)
    //=========================================================================
    reg [31:0] mem [0:262143];
    integer mi;
    initial for (mi = 0; mi < 262144; mi = mi + 1)
        mem[mi] = {mi[7:0], mi[15:8], mi[23:16], 1'b0};

    integer bp_mode = 0;
    integer bp_cnt  = 0;
    reg [31:0] rdata_r;
    reg        fb_pend = 1'b0;
    reg [6:0]  dly;

    always @(posedge clk) begin
        fb_rvalid <= 1'b0;
        if (fb_rd) begin
            rdata_r <= mem[fb_addr[19:2]];
            fb_pend <= 1'b1;
            case (bp_mode)
                0:       dly <= 7'd1;
                1:       dly <= 7'd2;
                2:       dly <= ((bp_cnt % 4) == 0) ? 7'd64 : 7'd1;
                default: dly <= 7'd1;
            endcase
            if (bp_mode == 2) bp_cnt <= bp_cnt + 1;
        end else if (fb_pend) begin
            if (dly <= 7'd1) begin
                fb_pend   <= 1'b0;
                fb_rvalid <= 1'b1;
            end else begin
                dly <= dly - 7'd1;
            end
        end
    end
    assign fb_rdata = rdata_r;

    // 场景 (j)：VEN=0 期间 fb 请求监测
    integer    fb_rd_viol = 0;
    reg        ctrl_ven_shadow = 1'b0;
    always @(posedge clk)
        if (!ctrl_ven_shadow && fb_rd) fb_rd_viol <= fb_rd_viol + 1;

    //=========================================================================
    // 处理器侧总线任务（零等待）
    //=========================================================================
    task wr(input [5:0] a, input [31:0] d);
        begin
            @(posedge clk);
            psel<=1; penable<=0; pwrite<=1; paddr<=a; pwdata<=d;
            @(posedge clk); penable<=1;
            @(posedge clk); psel<=0; penable<=0;
            if (a == 6'h00) ctrl_ven_shadow = d[0];
        end
    endtask

    task rd(input [5:0] a, output [31:0] d);
        begin
            @(posedge clk);
            psel<=1; penable<=0; pwrite<=0; paddr<=a; pwdata<=0;
            @(posedge clk); penable<=1;
            @(posedge clk); #1 d = prdata; psel<=0; penable<=0;
        end
    endtask

    task chk(input [5:0] a, input [31:0] expv, input [31:0] mask, input [127:0] nm);
        reg [31:0] d;
        begin
            rd(a, d);
            if ((d & mask) !== (expv & mask)) begin
                $display("[FATAL] chk %0s: addr=0x%02h exp=0x%08h got=0x%08h (mask=0x%08h)",
                         nm, a, expv & mask, d & mask, mask);
                $fatal(1, "register check failed");
            end
        end
    endtask

    task wr_bits(input [5:0] a, input [31:0] setm, input [31:0] clrm);
        reg [31:0] d;
        begin
            rd(a, d);
            wr(a, (d & ~clrm) | setm);
        end
    endtask

    //=========================================================================
    // 期望模型（TB 内建参考）
    //   标准帧：行 [96|48|640|16] 总 800；场 [2|29|480|14] 总 525（D1）
    //   短帧(i)：行 [40|32|128|20] 总 220；场 [3|5|12|4] 总 25
    //=========================================================================
    integer H_TS, H_BP, H_ACT, H_TOT;
    integer V_TS, V_BP, V_ACT, V_TOT;
    integer FB_BASE;                        // 活动 bank 基址【字单位】
    integer NW;                             // 每有效行取数字数

    function [7:0] fb_byte(input integer base, input integer line,
                           input integer nw, input integer k);
        begin
            fb_byte = mem[base + line*nw + k/4] >> (8*(3 - (k % 4)));
        end
    endfunction

    function [23:0] ext16(input [15:0] w);
        ext16 = {w[15:11], 3'b000, w[10:5], 2'b00, w[4:0], 3'b000};
    endfunction

    function [23:0] exp_pix(input integer bpp, input integer line, input integer j);
        reg [7:0] c0;
        begin
            c0 = fb_byte(FB_BASE, line, NW, j);
            case (bpp)
                0:       exp_pix = {c0, c0, c0};
                1:       exp_pix = ext16({fb_byte(FB_BASE, line, NW, 2*j),
                                          fb_byte(FB_BASE, line, NW, 2*j+1)});
                default: exp_pix = {fb_byte(FB_BASE, line, NW, 3*j),
                                    fb_byte(FB_BASE, line, NW, 3*j+1),
                                    fb_byte(FB_BASE, line, NW, 3*j+2)};
            endcase
        end
    endfunction

    //=========================================================================
    // 像素槽采样（D9）：等 pix_ce 置位 → #1 采样 → 等撤除（严格 1:1，FIX-T2）
    //=========================================================================
    reg        s_hs, s_vs, s_bl;
    reg [23:0] s_rgb;
    task sample_px;
        begin
            while (pix_ce !== 1'b1) @(posedge clk);
            #1;
            s_hs = hsync; s_vs = vsync; s_bl = blank; s_rgb = rgb;
            @(posedge clk);
            while (pix_ce !== 1'b0) @(posedge clk);
        end
    endtask

    task wait_vint;                         // 先清旧标志，再等新 VINT 置位
        reg [31:0] d;
        begin
            wr(6'h04, 32'h10);
            d = 32'h0;
            while (d[4] !== 1'b1) rd(6'h04, d);
        end
    endtask

    integer hp, fl, f;
    integer underrun_slots;
    reg [23:0] exp_p;

    //-------------------------------------------------------------------------
    // 单槽校验（(b) hsync / (c) vsync+blank / (d)(e) 数据行）
    //-------------------------------------------------------------------------
    task check_slot(input integer cfl, input integer chp,
                    input integer bpp, input integer check_row);
        integer al, sj;
        reg [23:0] ep;
        begin
            if (chp < 4 || (chp >= H_TS-1 && chp <= H_TS+1) || chp >= H_TOT-1)
                if (s_hs !== ((chp < H_TS) ? 1'b1 : 1'b0))
                    $fatal(1, "(b) row=%0d hp=%0d hsync exp=%0b got=%0b",
                           cfl, chp, (chp < H_TS), s_hs);
            if (chp == 0)
                if (s_vs !== ((cfl < V_TS) ? 1'b1 : 1'b0))
                    $fatal(1, "(c) row=%0d vsync exp=%0b got=%0b",
                           cfl, (cfl < V_TS), s_vs);
            al = cfl - (V_TS + V_BP);
            if (chp == H_TS+H_BP || chp == H_TS+H_BP+H_ACT-1 ||
                chp == H_TS+H_BP+H_ACT || chp == H_TOT-1)
                if (s_bl !== (((chp >= H_TS+H_BP) && (chp < H_TS+H_BP+H_ACT) &&
                               (al >= 0) && (al < V_ACT)) ? 1'b0 : 1'b1))
                    $fatal(1, "(c) row=%0d hp=%0d blank bad (=%0b)", cfl, chp, s_bl);
            if (cfl == check_row && chp >= H_TS+H_BP && chp < H_TS+H_BP+H_ACT) begin
                sj = chp - (H_TS + H_BP);
                ep = exp_pix(bpp, al, sj);
                if (s_rgb !== ep)
                    $fatal(1, "(d)(e) row=%0d px=%0d exp=%06h got=%06h (bpp=%0d base=%08h)",
                           al, sj, ep, s_rgb, bpp, FB_BASE);
            end
        end
    endtask

    //-------------------------------------------------------------------------
    // 帧全速扫描：对齐（vs 下降后首个上升槽 = row0/hp0）→ 逐槽校验
    //-------------------------------------------------------------------------
    task scan_frames(input integer nframes, input integer bpp, input integer check_row);
        begin
            for (f = 0; f < nframes; f = f + 1) begin
                while (s_vs !== 1'b0) sample_px;    // 等消隐段（vs=0 证据）
                while (s_vs !== 1'b1) sample_px;    // 等场起点（vs 上升首槽）
                check_slot(0, 0, bpp, check_row);   // 该槽已采样，直接校验
                for (fl = 0; fl < V_TOT; fl = fl + 1)
                    for (hp = (fl == 0) ? 1 : 0; hp < H_TOT; hp = hp + 1) begin
                        sample_px;
                        check_slot(fl, hp, bpp, check_row);
                    end
            end
        end
    endtask

    //=========================================================================
    // 场景主流程
    //=========================================================================
    initial begin
        `ifdef TB_VCD
        $dumpfile("tb_top.vcd");
        $dumpvars(0, tb_top);
        `endif

        //---------------------------------------------------------------------
        // (a) 复位默认值与静止输出
        //---------------------------------------------------------------------
        rst = 1'b1;
        repeat (4) @(posedge clk);
        #1 rst = 1'b0;
        repeat (4) @(posedge clk);
        chk(6'h00, 32'h0, 32'hFFFFFFFF, "(a)CTRL");
        chk(6'h04, 32'h0, 32'hFFFFFFFF, "(a)STAT");
        chk(6'h08, 32'h0, 32'hFFFFFFFF, "(a)HTIM");
        chk(6'h0C, 32'h0, 32'hFFFFFFFF, "(a)VTIM");
        chk(6'h10, 32'h0, 32'hFFFFFFFF, "(a)HVLEN");
        chk(6'h14, 32'h0, 32'hFFFFFFFF, "(a)VBARA");
        chk(6'h18, 32'h0, 32'hFFFFFFFF, "(a)VBARB");
        for (mi = 0; mi < 4096; mi = mi + 1) begin
            @(posedge clk); #1;
            if (pix_ce !== 1'b0 || hsync !== 1'b0 || vsync !== 1'b0 ||
                blank !== 1'b1 || rgb !== 24'h0)
                $fatal(1, "(a) reset idle viol: t=%0d pix_ce=%0b hs=%0b vs=%0b blank=%0b rgb=%06h",
                       mi, pix_ce, hsync, vsync, blank, rgb);
        end
        $display("[PASS] (a) reset defaults and static outputs");

        //---------------------------------------------------------------------
        // 标准时序编程（VESA 640x480@60；V 前沿=14 → 场总 525，D1）
        //---------------------------------------------------------------------
        H_TS = 96;  H_BP = 48; H_ACT = 640; H_TOT = 800;
        V_TS = 2;   V_BP = 29; V_ACT = 480; V_TOT = 525;
        FB_BASE = 32'h100 >> 2;                // 0x40 字
        NW      = H_ACT/4;

        wr(6'h08, {8'd95, 8'd47, 16'd639});
        wr(6'h0C, {8'd1,  8'd28, 16'd479});
        wr(6'h10, {4'h0, 12'd799, 4'h0, 12'd524});
        wr(6'h14, 32'h100);
        wr(6'h18, 32'h1000);
        wr(6'h00, 32'h0000_0001);              // VEN=1, CD=0, 极性=0

        //---------------------------------------------------------------------
        // (b)(c)(e) 8bpp 一帧全扫 + 数据行核对
        //---------------------------------------------------------------------
        scan_frames(1, 0, V_TS + V_BP + 69);
        $display("[PASS] (b) h timing 96/48/640/16 segments+polarity (full frame)");
        $display("[PASS] (c) v timing 2/29/480/14 (total 525 rows, D1)");
        $display("[PASS] (e) fb address map 8bpp (row stride=%0d words, signature)", NW);

        //---------------------------------------------------------------------
        // (g) 中断链路
        //---------------------------------------------------------------------
        wr_bits(6'h00, 32'h2, 32'h0);          // VIE=1
        #1 if (irq !== 1'b1) $fatal(1, "(g) irq exp=1 got=%0b (VIE&VINT)", irq);
        wr_bits(6'h00, 32'h0, 32'h2);          // VIE=0
        #1 if (irq !== 1'b0) $fatal(1, "(g) irq exp=0 got=%0b (VIE=0 gate)", irq);
        chk(6'h04, 32'h10, 32'h10, "(g)VINT set");
        wr(6'h04, 32'h10);
        chk(6'h04, 32'h0, 32'h10, "(g)VINT w1c");
        wr_bits(6'h00, 32'h4, 32'h0);          // HIE=1
        #1 if (irq !== 1'b1) $fatal(1, "(g) irq exp=1 got=%0b (HIE&HINT)", irq);
        wr_bits(6'h00, 32'h0, 32'h4);          // HIE=0
        chk(6'h04, 32'h20, 32'h20, "(g)HINT set");
        wr(6'h04, 32'h20);
        chk(6'h04, 32'h0, 32'h20, "(g)HINT w1c");
        $display("[PASS] (g) irq gating + STAT write-1-clear");

        //---------------------------------------------------------------------
        // (d) 16bpp / 24bpp / 8bpp 回归（场界生效）
        //---------------------------------------------------------------------
        wr_bits(6'h00, 32'h0_80, 32'h3_80);    // CD=1
        wait_vint;
        NW = H_ACT/2;
        scan_frames(1, 1, V_TS + V_BP + 69);
        $display("[PASS] (d) 16bpp RGB565 one active row");

        wr_bits(6'h00, 32'h1_00, 32'h3_80);    // CD=2
        wait_vint;
        NW = (H_ACT*3+3)/4;
        scan_frames(1, 2, V_TS + V_BP + 69);
        $display("[PASS] (d) 24bpp RGB888 one active row");

        wr_bits(6'h00, 32'h0, 32'h3_80);       // CD=0
        NW = H_ACT/4;
        wait_vint;
        scan_frames(1, 0, V_TS + V_BP + 69);
        $display("[PASS] (d) 8bpp grayscale regression");

        //---------------------------------------------------------------------
        // (h) 欠载注入（bp_mode=2 周期性 8 拍延迟）
        //---------------------------------------------------------------------
        bp_mode = 2; bp_cnt = 0;
        wr(6'h04, 32'h2);                      // 预清 LUINT
        underrun_slots = 0;
        while (s_vs !== 1'b0) sample_px;       // 帧对齐（同 scan_frames）
        while (s_vs !== 1'b1) sample_px;
        // (0,0) 槽已采样
        if ((s_rgb === 24'h0) && (s_bl === 1'b1)) underrun_slots = underrun_slots + 1;
        for (fl = 0; fl < V_TOT; fl = fl + 1)
            for (hp = (fl == 0) ? 1 : 0; hp < H_TOT; hp = hp + 1) begin
                sample_px;
                if ((fl >= V_TS+V_BP) && (fl < V_TS+V_BP+V_ACT) &&
                    (hp >= H_TS+H_BP) && (hp < H_TS+H_BP+H_ACT)) begin
                    if (s_rgb === 24'h0 && s_bl === 1'b1) begin
                        underrun_slots = underrun_slots + 1;
                        hp = hp - 1; // 欠载时 DUT 保持当前像素；恢复后仍校验该像素
                    end
                    else begin
                        exp_p = exp_pix(0, fl-(V_TS+V_BP), hp-(H_TS+H_BP));
                        if (s_rgb !== exp_p || s_bl !== 1'b0)
                            $fatal(1, "(h) non-underrun px bad row=%0d hp=%0d exp=%06h got=%06h blank=%0b",
                                   fl, hp, exp_p, s_rgb, s_bl);
                    end
                end
            end
        chk(6'h04, 32'h2, 32'h2, "(h)LUINT set");
        if (underrun_slots == 0) $fatal(1, "(h) no underrun slot observed (inject inactive)");
        wr(6'h04, 32'h2);
        chk(6'h04, 32'h0, 32'h2, "(h)LUINT w1c");
        $display("[PASS] (h) underrun: LUINT+blank+w1c (blank slots=%0d)", underrun_slots);
        bp_mode = 0;

        // 欠载恢复帧：ACT 行 0 序列无错位
        wait_vint;
        scan_frames(1, 0, V_TS + V_BP + 0);
        $display("[PASS] (h) recovery frame row0 no misalignment");

        //---------------------------------------------------------------------
        // (i) 非标准时序（短行/短场，场界生效）
        //---------------------------------------------------------------------
        H_TS = 40; H_BP = 32; H_ACT = 128; H_TOT = 220;
        V_TS = 3;  V_BP = 5;  V_ACT = 12;  V_TOT = 25;
        wr(6'h08, {8'd39, 8'd31, 16'd127});
        wr(6'h0C, {8'd2,  8'd4,  16'd11});
        wr(6'h10, {4'h0, 12'd219, 4'h0, 12'd24});
        NW = H_ACT/4;
        wait_vint;
        scan_frames(1, 0, V_TS + V_BP + 3);
        $display("[PASS] (i) non-standard timing H 40/32/128/20 V 3/5/12/4");

        //---------------------------------------------------------------------
        // (f) 双 bank 切换（标准时序恢复 → VBSWE=1 → 场界切换）
        //---------------------------------------------------------------------
        H_TS = 96;  H_BP = 48; H_ACT = 640; H_TOT = 800;
        V_TS = 2;   V_BP = 29; V_ACT = 480; V_TOT = 525;
        NW = H_ACT/4;
        wr(6'h08, {8'd95, 8'd47, 16'd639});
        wr(6'h0C, {8'd1,  8'd28, 16'd479});
        wr(6'h10, {4'h0, 12'd799, 4'h0, 12'd524});
        wait_vint;                              // 标准时序在场界生效
        wr_bits(6'h00, 32'h20, 32'h0);          // VBSWE=1
        wait_vint;                              // 切换场界
        chk(6'h04, 32'h10000, 32'h10000, "(f)AVMP=1");
        chk(6'h04, 32'h40, 32'h40, "(f)VBSINT set");
        wr(6'h04, 32'h40);
        chk(6'h04, 32'h0, 32'h40, "(f)VBSINT w1c");
        FB_BASE = 32'h1000 >> 2;               // 0x400 字
        scan_frames(1, 0, V_TS + V_BP + 0);     // bank B 数据核对
        wr_bits(6'h00, 32'h0, 32'h20);          // VBSWE=0（维持 bank B）
        $display("[PASS] (f) dual bank: field-boundary switch + AVMP + VBSINT + data");

        //---------------------------------------------------------------------
        // (j) VEN 门控
        //---------------------------------------------------------------------
        wr_bits(6'h00, 32'h0, 32'h1);          // VEN=0
        #1 if (fb_rd !== 1'b0) $fatal(1, "(j) fb_rd exp=0 got=%0b (VEN=0)", fb_rd);
        for (mi = 0; mi < 4096; mi = mi + 1) begin
            @(posedge clk); #1;
            if (pix_ce !== 1'b0 || blank !== 1'b1 || rgb !== 24'h0 ||
                hsync !== 1'b0 || vsync !== 1'b0)
                $fatal(1, "(j) VEN=0 idle viol: t=%0d pix_ce=%0b hs=%0b vs=%0b blank=%0b rgb=%06h",
                       mi, pix_ce, hsync, vsync, blank, rgb);
        end
        if (fb_rd_viol != 0) $fatal(1, "(j) fb_rd seen %0d times while VEN=0", fb_rd_viol);
        $display("[PASS] (j) VEN gating: no pixel output, no fetch request");

        //---------------------------------------------------------------------
        $display("=========================================");
        $display("PASS: VGA-DRQ-TST-002 scenarios (a)-(j) all passed");
        $display("=========================================");
        $finish;
    end

    // 看门狗
    initial begin
        #600_000_000;   // 600 ms（场景链 ~250ms 模拟时间 + 对齐/余量）
        $fatal(1, "watchdog timeout");
    end

endmodule
