`timescale 1ns / 1ps
//============================================================================
// 模块名称 : uart_tx
// 功能描述 : UART 发送状态机。帧格式 8N1（1 起始位 + 8 数据位 LSB 先发 +
//            1 停止位）。内部实例化 baud_gen 提供位节拍。
// 接口      : tx_start  - 1 拍脉冲启动发送
//            tx_data   - 待发送字节（tx_start 有效时锁存）
//            txd       - 串行发送数据线，空闲为高
//            tx_busy   - 发送进行中标志
//            tx_done   - 停止位发送完成时拉高 1 拍
// 时钟/复位 : clk 上升沿；rst 同步高有效。
//============================================================================
module uart_tx #(
    parameter CLK_FREQ  = 100_000_000,
    parameter BAUD_RATE = 9600
) (
    input  wire       clk,
    input  wire       rst,
    input  wire       tx_start,
    input  wire [7:0] tx_data,
    output reg        txd,
    output reg        tx_busy,
    output reg        tx_done
);

    localparam CLKS_PER_BIT = (CLK_FREQ + (BAUD_RATE >> 1)) / BAUD_RATE;

    // 状态编码
    localparam [1:0] IDLE  = 2'd0;
    localparam [1:0] START = 2'd1;
    localparam [1:0] DATA  = 2'd2;
    localparam [1:0] STOP  = 2'd3;

    reg  [1:0]  state;
    reg  [2:0]  bit_idx;       // 当前数据位序号 0..7
    reg  [7:0]  data_reg;      // 发送数据移位寄存器
    wire        baud_tick;

    // 位节拍发生器：仅发送期间计数
    baud_gen #(
        .CLK_FREQ (CLK_FREQ),
        .BAUD_RATE(BAUD_RATE)
    ) u_baud (
        .clk       (clk),
        .rst       (rst),
        .ce        (tx_busy),
        .baud_tick (baud_tick)
    );

    always @(posedge clk) begin
        if (rst) begin
            state    <= IDLE;
            bit_idx  <= 3'd0;
            data_reg <= 8'd0;
            txd      <= 1'b1;
            tx_busy  <= 1'b0;
            tx_done  <= 1'b0;
        end else begin
            tx_done <= 1'b0;          // 默认拉低
            case (state)
                //--------------------------------------------
                IDLE: begin
                    txd <= 1'b1;       // 线路空闲为高
                    if (tx_start) begin
                        data_reg <= tx_data;
                        tx_busy  <= 1'b1;
                        state    <= START;
                    end
                end
                //--------------------------------------------
                START: begin
                    txd <= 1'b0;       // 起始位
                    if (baud_tick) begin
                        state <= DATA;
                    end
                end
                //--------------------------------------------
                DATA: begin
                    txd <= data_reg[bit_idx]; // 数据位，LSB 先发
                    if (baud_tick) begin
                        if (bit_idx == 3'd7) begin
                            bit_idx <= 3'd0;
                            state   <= STOP;
                        end else begin
                            bit_idx <= bit_idx + 3'd1;
                        end
                    end
                end
                //--------------------------------------------
                STOP: begin
                    txd <= 1'b1;       // 停止位
                    if (baud_tick) begin
                        tx_done <= 1'b1;
                        tx_busy <= 1'b0;
                        state   <= IDLE;
                    end
                end
                //--------------------------------------------
                default: state <= IDLE;
            endcase
        end
    end

endmodule
