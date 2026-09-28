`timescale 1ns / 1ps
//=============================================================================
// vga_golden_top.v — VGA/LCD 显示控制器黄金基线封装顶层
// 项目: bench-lib T2 (p21)  |  需求基线: doc/01-开发技术要求.md (VGA-DOC-001 v1.0)
// v6 = v5 + FIX-5：V_IDLE 与 H_IDLE 同拍瞬移（FUN-002"VEN=1 后从下一场边界起
//      按配置扫描"——使能后第一个像素槽即场起点，消除使能瞬态半行）。
//   FIX-1: 每行取数字数改用 TGATE+1（寄存值为 -1 编码）；
//   FIX-2: VEN=0 跟踪分支复位 avmp_q（重新使能首场 AVMP 与实际 bank 一致）；
//   FIX-3: 有效区内部字节窗饥饿且非行末槽时，行/场 FSM 就地冻结（行拉长、
//          恢复后像素序列无缺口）；行末槽不冻结以防活锁（该像素让位）；
//   FIX-4: FIFO 字装填字节窗时字节反转，最老字节 = 字 MSB（对齐 vga_colproc）；
//   FIX-5: 场 IDLE 为瞬态：首个 tick_go 即 V_IDLE→V_SYNC（与行 IDLE 同拍），
//          使能后首拍 = 场起点（行 0 同步段），场结构与 pix_ce 对齐。
//-----------------------------------------------------------------------------
// [角色] 黄金侧顶层。参考 rtl/vga_enh_top.v 及全部子模块冻结未动、未例化。
//        语义对齐参考核：时序分段 = vga_vtim（-1 编码，段长=编程值+1 像素拍）；
//        像素字节序 = vga_colproc（字内 MSB 在前，RGB565 低位补零）；
//        双 bank = vga_wb_master（场界翻转 AVMP，VBSWE 门控）。
// [时钟] 单域 100 MHz，像素节拍=使能 pix_ce（clk/PIXDIV，PERF-001），无生成时钟。
// [分歧/假设]（TB 同口径核对）
//  D1 场时序：PERF-002 V=2/29/480/13 段和 524 ≠ 场总 525 → 按"场总 525"权威，
//     前沿=14 行；TB 按"分段实测+总长 525"判定。
//  D2 CD=3'b11 未定义 → 按 24bpp（TB 不用）。
//  D3 SINT 恒 0（无系统错误源）。
//  D4 固定单字取数（OQ-003 VBL=1 口径）。
//  D5 VBAR[1:0] 忽略；TGATE 须为 4 的倍数（字粒度取数）。
//  D6 极性=XOR 语义（参考核同）：hsync 空闲=HSL 脉冲=^HSL，vsync 同 VSL，
//     blank 有效区=BL、消隐/欠载=^BL（BL=1 负有效）；CSL 仅存储回读。
//  D7 生效点：HTIM/VTIM/HVLEN/CD/HSL/VSL/BL 于"场回扫起始"（最后有效行行尾，
//     VINT 事件）原子快照；VBSWE 与 VBARA/B 在该场界按"写入后首次场界"实时
//     裁决（等价"写 VBARB 后下一场边界切换"，FUN-007）；VEN/中断使能即时。
//  D8 欠载（FIX-3）：有效区内取数未就绪 → 该像素槽 rgb=0、blank 强制消隐、
//     LUINT 置位；FSM 就地暂停（像素不跳点，行拉长），恢复后接续原序列；
//     行末槽例外（不冻结，防活锁，该像素让位）；行首刷新取数地址并冲洗
//     FIFO，异常不跨行传播（强于 REL-002"允许行错位"下限）。
//  D9 采样契约：pix_ce 为寄存器单拍脉冲；TB 在"pix_ce 置位的那个 clk 上升沿"
//     之后采样，同一沿得到该像素槽完整五元组 (hsync,vsync,blank,rgb,pix_ce)
//     （NBA 语义下原子，无竞态）。VEN=0 期间 pix_ce=0，输出静止。
//  D10 fb 协议：fb_rd 单拍脉冲与 fb_addr 同拍；fb_rvalid >=1 拍后单拍有效，
//      请求-应答一一对应；DUT 对未应答请求保持等待（欠载路径暴露为 LUINT）。
//  D11 fb 请求只在行界/场界之间的有效取数预算内发出；行首冲洗丢弃在途残字。
//=============================================================================

module vga_golden_top #(
    parameter integer PIXDIV  = 4,   // pix_ce = clk/PIXDIV（4 → 25 MHz 档）
    parameter integer FIFO_AW = 4    // 行取数 FIFO 深度 = 2**FIFO_AW 字
)(
    input  wire        clk,
    input  wire        rst,      // 同步高有效（IF-001/REL-001）
    input  wire        psel,
    input  wire        penable,
    input  wire        pwrite,
    input  wire [5:0]  paddr,
    input  wire [31:0] pwdata,
    output wire [31:0] prdata,
    output wire        pready,
    output wire        hsync,
    output wire        vsync,
    output wire        blank,
    output wire [23:0] rgb,
    output wire        pix_ce,
    output wire [31:0] fb_addr,
    input  wire [31:0] fb_rdata,
    output wire        fb_rd,
    input  wire        fb_rvalid,
    output wire        irq
);

    //=========================================================================
    // 1. 寄存器堆（FUN-001，§3.1 地址表）
    //=========================================================================
    reg  [31:0] ctrl_r, stat_r, htim_r, vtim_r, hvlen_r, vbara_r, vbarb_r;
    wire        reg_wr = psel & penable & pwrite;
    wire [3:0]  sel    = paddr[5:2];
    wire        wr_stat = reg_wr & (sel == 4'd1);

    always @(posedge clk) begin
        if (rst) begin
            ctrl_r<=32'h0; htim_r<=32'h0; vtim_r<=32'h0;
            hvlen_r<=32'h0; vbara_r<=32'h0; vbarb_r<=32'h0;   // FUN-009
        end else if (reg_wr) begin
            case (sel)
                4'd0: ctrl_r  <= pwdata;
                4'd2: htim_r  <= pwdata;
                4'd3: vtim_r  <= pwdata;
                4'd4: hvlen_r <= pwdata;
                4'd5: vbara_r <= pwdata;
                4'd6: vbarb_r <= pwdata;
                default: ;                       // 0x1C-0x3C 写忽略
            endcase
        end
    end

    wire       ctrl_ven   = ctrl_r[0];
    wire       ctrl_vie   = ctrl_r[1];
    wire       ctrl_hie   = ctrl_r[2];
    wire       ctrl_vbsie = ctrl_r[3];
    wire       ctrl_vbswe = ctrl_r[5];
    wire [2:0] ctrl_cd    = ctrl_r[9:7];
    wire       ctrl_hsl   = ctrl_r[12];
    wire       ctrl_vsl   = ctrl_r[13];
    wire       ctrl_bl    = ctrl_r[15];

    assign pready = 1'b1;
    assign prdata = (sel==4'd0) ? ctrl_r  : (sel==4'd1) ? stat_r :
                    (sel==4'd2) ? htim_r  : (sel==4'd3) ? vtim_r :
                    (sel==4'd4) ? hvlen_r : (sel==4'd5) ? vbara_r :
                    (sel==4'd6) ? vbarb_r : 32'h0;

    //=========================================================================
    // 2. 像素节拍（PERF-001/002）
    //=========================================================================
    reg [7:0] pixdiv_cnt;
    always @(posedge clk)
        if (rst) pixdiv_cnt <= 8'd0;
        else     pixdiv_cnt <= (pixdiv_cnt == PIXDIV-1) ? 8'd0 : pixdiv_cnt + 8'd1;
    wire tick    = (pixdiv_cnt == PIXDIV-1);
    wire tick_go = tick & ctrl_ven;      // VEN=0 冻结时序（FUN-002/009）

    //=========================================================================
    // 3. 影子寄存器（D7）
    //=========================================================================
    reg [7:0]  s_ts, s_tgd, s_tvs, s_tvd;
    reg [15:0] s_tg, s_tvg;
    reg [11:0] s_thlen, s_tvlen;
    reg [2:0]  s_cd;
    reg        s_hsl, s_vsl, s_bl;

    wire [7:0]  live_ts=htim_r[31:24], live_tgd=htim_r[23:16];
    wire [15:0] live_tg=htim_r[15:0];
    wire [7:0]  live_tvs=vtim_r[31:24], live_tvd=vtim_r[23:16];
    wire [15:0] live_tvg=vtim_r[15:0];
    wire [11:0] live_thlen=hvlen_r[27:16], live_tvlen=hvlen_r[11:0];

    function [15:0] calc_nw;             // 每行取数字数（D5；入参为 TGATE 实际值）
        input [2:0]  cd;
        input [15:0] tg;
        begin
            if (cd == 3'd0)      calc_nw = {2'b00, tg[15:2]};
            else if (cd == 3'd1) calc_nw = {1'b0, tg[15:1]};
            else                 calc_nw = {tg[15:2], 1'b0} + {2'b00, tg[15:2]};
        end
    endfunction
    wire [15:0] nw_live = calc_nw(ctrl_cd, live_tg + 16'd1);   // FIX-1

    wire [15:0] s_hfrnt = ({4'h0,s_thlen}) - ({8'h0,s_ts}) - ({8'h0,s_tgd}) - s_tg  - 16'd3;
    wire [15:0] s_vfrnt = ({4'h0,s_tvlen}) - ({8'h0,s_tvs}) - ({8'h0,s_tvd}) - s_tvg - 16'd3;

    //=========================================================================
    // 4. 行/场时序 FSM：组合次态 + 单点提交（FIX-3 hold / FIX-5 瞬态 IDLE）
    //=========================================================================
    localparam [2:0] H_IDLE=3'd0, H_SYNC=3'd1, H_BP=3'd2, H_ACT=3'd3, H_FRNT=3'd4;
    localparam [2:0] V_IDLE=3'd0, V_SYNC=3'd1, V_BP=3'd2, V_ACT=3'd3, V_FRNT=3'd4;

    reg [2:0]  hphase, vphase;
    reg [15:0] hcnt, vcnt, vline;

    wire can_supply;   // 字节窗本拍可供给一个像素（块 8 赋值）

    wire       h_last     = (hphase==H_ACT ) && (hcnt==0);
    wire       line_last  = (hphase==H_FRNT) && (hcnt==0);
    wire       nxt_active = ((vphase==V_ACT)&&(vcnt!=0)) || ((vphase==V_BP)&&(vcnt==0));
    wire       evt_hint   = tick_go && h_last;
    wire       evt_vint   = tick_go && line_last && (vphase==V_ACT) && (vcnt==0);
    wire       row_start  = tick_go && line_last && nxt_active;
    wire [15:0] vline_after = (vphase==V_BP) ? 16'h0 : vline + 16'd1;

    // FIX-3：有效区内部饥饿 → 冻结推进（行末槽除外，防活锁）
    wire hold_fsm = tick_go && (hphase==H_ACT) && (vphase==V_ACT) &&
                    (hcnt != 16'd0) && !can_supply;

    reg [2:0]  ns_hphase, ns_vphase;
    reg [15:0] ns_hcnt, ns_vcnt;
    always @* begin
        ns_hphase=hphase; ns_hcnt=hcnt; ns_vphase=vphase; ns_vcnt=vcnt;
        if (tick_go && !hold_fsm) begin
            // FIX-5：场 IDLE 瞬态——首拍即入场（不依赖行界）
            if (vphase == V_IDLE) begin
                ns_vphase = V_SYNC; ns_vcnt = {8'h0, s_tvs};
            end else if (line_last) begin          // 行界：场推进
                case (vphase)
                    V_SYNC: if (vcnt==16'd0) begin ns_vphase=V_BP;   ns_vcnt={8'h0,s_tvd}; end
                            else ns_vcnt = vcnt - 16'd1;
                    V_BP:   if (vcnt==16'd0) begin ns_vphase=V_ACT;  ns_vcnt={8'h0,s_tvg}; end
                            else ns_vcnt = vcnt - 16'd1;
                    V_ACT:  if (vcnt==16'd0) begin ns_vphase=V_FRNT; ns_vcnt=s_vfrnt; end
                            else ns_vcnt = vcnt - 16'd1;
                    default: if (vcnt==16'd0) begin ns_vphase=V_SYNC; ns_vcnt={8'h0,s_tvs}; end
                             else ns_vcnt = vcnt - 16'd1;
                endcase
            end
            case (hphase)                              // 行推进
                H_IDLE: begin ns_hphase=H_SYNC; ns_hcnt={8'h0,s_ts};  end
                H_SYNC: if (hcnt==16'd0) begin ns_hphase=H_BP;   ns_hcnt={8'h0,s_tgd}; end
                        else ns_hcnt = hcnt - 16'd1;
                H_BP:   if (hcnt==16'd0) begin ns_hphase=H_ACT;  ns_hcnt=s_tg;   end
                        else ns_hcnt = hcnt - 16'd1;
                H_ACT:  if (hcnt==16'd0) begin ns_hphase=H_FRNT; ns_hcnt=s_hfrnt; end
                        else ns_hcnt = hcnt - 16'd1;
                default: if (hcnt==16'd0) begin ns_hphase=H_SYNC; ns_hcnt={8'h0,s_ts}; end
                         else ns_hcnt = hcnt - 16'd1;
            endcase
        end
    end

    always @(posedge clk) begin
        if (rst || !ctrl_ven) begin
            hphase<=H_IDLE; hcnt<=16'h0; vphase<=V_IDLE; vcnt<=16'h0; vline<=16'h0;
        end else begin
            hphase<=ns_hphase; hcnt<=ns_hcnt;
            vphase<=ns_vphase; vcnt<=ns_vcnt;
            if (row_start) vline <= vline_after;
        end
    end

    wire ns_act   = (ns_hphase==H_ACT) && (ns_vphase==V_ACT);
    wire ns_hsync = (ns_hphase==H_SYNC);
    wire ns_vsync = (ns_vphase==V_SYNC);

    //=========================================================================
    // 5. 场界装载：影子快照 + bank 裁决（D7 / FUN-006/007）
    //=========================================================================
    reg [29:0] frame_base_w;
    reg [15:0] nw_latched;
    reg        avmp_q;

    always @(posedge clk) begin
        if (rst) begin
            s_ts<=8'h0; s_tgd<=8'h0; s_tg<=16'h0; s_tvs<=8'h0; s_tvd<=8'h0;
            s_tvg<=16'h0; s_thlen<=12'h0; s_tvlen<=12'h0;
            s_cd<=3'h0; s_hsl<=1'b0; s_vsl<=1'b0; s_bl<=1'b0;
            frame_base_w<=30'h0; nw_latched<=16'h0; avmp_q<=1'b0;
        end else if (!ctrl_ven) begin
            s_ts<=live_ts; s_tgd<=live_tgd; s_tg<=live_tg;
            s_tvs<=live_tvs; s_tvd<=live_tvd; s_tvg<=live_tvg;
            s_thlen<=live_thlen; s_tvlen<=live_tvlen;
            s_cd<=ctrl_cd; s_hsl<=ctrl_hsl; s_vsl<=ctrl_vsl; s_bl<=ctrl_bl;
            nw_latched<=nw_live;
            frame_base_w<=vbara_r[31:2];
            avmp_q<=1'b0;                             // FIX-2
        end else if (evt_vint) begin
            s_ts<=live_ts; s_tgd<=live_tgd; s_tg<=live_tg;
            s_tvs<=live_tvs; s_tvd<=live_tvd; s_tvg<=live_tvg;
            s_thlen<=live_thlen; s_tvlen<=live_tvlen;
            s_cd<=ctrl_cd; s_hsl<=ctrl_hsl; s_vsl<=ctrl_vsl; s_bl<=ctrl_bl;
            nw_latched<=nw_live;
            if (ctrl_vbswe) avmp_q <= ~avmp_q;        // 下一场边界切换（FUN-007）
            frame_base_w <= (avmp_q ^ ctrl_vbswe) ? vbarb_r[31:2] : vbara_r[31:2];
        end
    end

    //=========================================================================
    // 6. 取数引擎（FUN-006/D10）
    //=========================================================================
    reg  [29:0] fetch_addr;
    reg  [15:0] words_left;
    reg         req_pend;

    wire        fifo_full;
    wire        fetch_fire = ctrl_ven && !req_pend && !fifo_full &&
                             (words_left != 16'h0) && !row_start;
    assign      fb_rd   = fetch_fire;
    assign      fb_addr = {fetch_addr, 2'b00};

    (* use_dsp = "no" *) wire [31:0] row_off = nw_latched * vline_after;
    always @(posedge clk) begin
        if (rst || !ctrl_ven) begin
            fetch_addr<=30'h0; words_left<=16'h0; req_pend<=1'b0;
        end else if (row_start) begin
            fetch_addr <= frame_base_w + row_off[29:0];
            words_left <= nw_latched;
            req_pend   <= 1'b0;                      // 在途残字随行首冲洗丢弃（D11）
        end else if (fetch_fire) begin
            req_pend <= 1'b1;
        end else if (req_pend && fb_rvalid) begin
            req_pend   <= 1'b0;
            fetch_addr <= fetch_addr + 30'h1;
            words_left <= words_left - 16'd1;
        end
    end

    //=========================================================================
    // 7. 行取数字 FIFO（单驱动指针；行首冲洗）
    //=========================================================================
    reg [31:0] fifo_mem [0:(1<<FIFO_AW)-1];
    reg [FIFO_AW-1:0] fwp, frp;
    reg [FIFO_AW:0]   fcnt;
    reg [3:0]  bcnt;

    wire fifo_empty = (fcnt == 0);
    assign fifo_full  = (fcnt == (1<<FIFO_AW));
    wire [31:0] fifo_q = fifo_mem[frp];
    wire        fifo_we = fb_rvalid && req_pend && !row_start;
    wire        do_fill = ctrl_ven && !fifo_empty && !row_start && (bcnt <= 4'd2);

    always @(posedge clk)
        if (fifo_we) fifo_mem[fwp] <= fb_rdata;

    always @(posedge clk) begin
        if (rst || !ctrl_ven || row_start) begin
            fwp<={FIFO_AW{1'b0}}; frp<={FIFO_AW{1'b0}}; fcnt<={(FIFO_AW+1){1'b0}};
        end else begin
            case ({fifo_we, do_fill})
                2'b10: begin fwp<=fwp+1'b1; fcnt<=fcnt+1'b1; end
                2'b01: begin frp<=frp+1'b1; fcnt<=fcnt-1'b1; end
                2'b11: begin fwp<=fwp+1'b1; frp<=frp+1'b1; end
                default: ;
            endcase
        end
    end

    //=========================================================================
    // 8. 字节窗解包 + 视频输出（FUN-003/004/005，D6/D8/D9）
    //=========================================================================
    reg [47:0] sr;        // 有效字节右对齐，最老字节在低位
    wire [1:0] need = (s_cd==3'd0) ? 2'd1 : (s_cd==3'd1) ? 2'd2 : 2'd3;
    wire [3:0] bcnt_af = bcnt + (do_fill ? 4'd4 : 4'd0);
    assign can_supply = (bcnt_af >= {2'b0, need});
    wire       do_emit = tick_go && ns_act && can_supply;
    wire       underrun_evt = tick_go && ns_act && !can_supply;
    // FIX-4：字节反转装填，最老字节 = 字 MSB（对齐 vga_colproc）
    wire [31:0] qw = {fifo_q[7:0], fifo_q[15:8], fifo_q[23:16], fifo_q[31:24]};
    wire [47:0] sr_af_fill = do_fill ? (sr | (qw << (8*bcnt))) : sr;

    wire [7:0] b0 = sr_af_fill[7:0],  b1 = sr_af_fill[15:8], b2 = sr_af_fill[23:16];
    reg [23:0] emit_pix;
    always @* begin
        case (s_cd)
            3'd0:    emit_pix = {b0, b0, b0};                     // 8bpp 灰度
            3'd1:    emit_pix = {b0[7:3], 3'b000,                 // RGB565 补零
                                 b0[2:0], b1[7:5], 2'b00,
                                 b1[4:0], 3'b000};
            default: emit_pix = {b0, b1, b2};                     // RGB888
        endcase
    end

    always @(posedge clk) begin
        if (rst || !ctrl_ven || row_start) begin
            sr <= 48'h0; bcnt <= 4'd0;
        end else begin
            sr   <= do_emit ? (sr_af_fill >> (8*need)) : sr_af_fill;
            bcnt <= do_emit ? (bcnt_af - {2'b0, need}) : bcnt_af;
        end
    end

    // 像素槽寄存器：tick 沿装载"进入槽"五元组（D9 原子采样）
    reg        pix_ce_r, hsync_r, vsync_r, blank_r;
    reg [23:0] rgb_r;
    always @(posedge clk) begin
        if (rst || !ctrl_ven) begin
            pix_ce_r<=1'b0; hsync_r<=1'b0; vsync_r<=1'b0; blank_r<=1'b1; rgb_r<=24'h0;
        end else begin
            pix_ce_r <= tick_go;
            if (tick_go) begin
                hsync_r <= ns_hsync ^ s_hsl;                 // 空闲=HSL，脉冲=^HSL（D6）
                vsync_r <= ns_vsync ^ s_vsl;
                blank_r <= ns_act ? (can_supply ? s_bl : ~s_bl) : ~s_bl;
                rgb_r   <= (ns_act && can_supply) ? emit_pix : 24'h0;
            end
        end
    end

    assign hsync  = hsync_r;
    assign vsync  = vsync_r;
    assign blank  = blank_r;
    assign rgb    = rgb_r;
    assign pix_ce = pix_ce_r;

    //=========================================================================
    // 9. STAT / 中断（FUN-008，写 1 清，置位优先）
    //=========================================================================
    reg st_luint, st_vint, st_hint, st_vbsint;
    wire evt_vbsw = evt_vint && ctrl_vbswe;
    always @(posedge clk) begin
        if (rst) begin
            st_luint<=1'b0; st_vint<=1'b0; st_hint<=1'b0; st_vbsint<=1'b0;
        end else begin
            if (underrun_evt)              st_luint  <= 1'b1;
            else if (wr_stat && pwdata[1]) st_luint  <= 1'b0;
            if (evt_vint)                  st_vint   <= 1'b1;
            else if (wr_stat && pwdata[4]) st_vint   <= 1'b0;
            if (evt_hint)                  st_hint   <= 1'b1;
            else if (wr_stat && pwdata[5]) st_hint   <= 1'b0;
            if (evt_vbsw)                  st_vbsint <= 1'b1;
            else if (wr_stat && pwdata[6]) st_vbsint <= 1'b0;
        end
    end

    always @(posedge clk)
        stat_r <= {15'h0, avmp_q, 9'h0, st_vbsint, st_hint, st_vint, 2'b00, st_luint, 1'b0};

    assign irq = (st_vint & ctrl_vie) | (st_hint & ctrl_hie) |
                 (st_vbsint & ctrl_vbsie) | st_luint;    // LUINT 无独立使能位（参考核同）

endmodule
