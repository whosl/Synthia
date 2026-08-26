`timescale 1ns / 1ps
//============================================================================
// 模块名称 : uart_rx
// 功能描述 : UART 接收状态机。帧格式 8N1。对输入做两级寄存器同步；检测
//            起始位下降沿后延时半位到达起始位中点确认，再每隔整位在数据
//            位中点采样，提高采样裕度（对波特率偏差的容差）。
// 接口      : rxd       - 串行接收数据线
//            rx_data   - 接收到的字节，rx_done 有效时有效
//            rx_done   - 帧接收完成时拉高 1 拍
//            frame_err - 停止位中点采样不为 1 时拉高 1 拍（帧错误）
// 时钟/复位 : clk 上升沿；rst 同步高有效。
//============================================================================
module uart_rx #(
    parameter CLK_FREQ  = 100_000_000,
    parameter BAUD_RATE = 9600
) (
    input  wire       clk,
    input  wire       rst,
    input  wire       rxd,
    output reg  [7:0] rx_data,
    output reg        rx_done,
    output reg        frame_err
);

    function integer clog2;
        input integer value;
        integer work;
        begin
            work = value - 1;
            clog2 = 1;
            while (work > 1) begin
                work = work >> 1;
                clog2 = clog2 + 1;
            end
        end
    endfunction

    localparam integer CLKS_PER_BIT = CLK_FREQ / BAUD_RATE;
    localparam integer COUNTER_WIDTH = clog2(CLKS_PER_BIT);

    // 状态编码
    // 采用 3 bit 显式编码，保留 4 个非法码供状态完整性检查和故障恢复。
    localparam [2:0] IDLE  = 3'd0;
    localparam [2:0] START = 3'd1;
    localparam [2:0] DATA  = 3'd2;
    localparam [2:0] STOP  = 3'd3;

    (* fsm_encoding = "none" *) reg [2:0] state;
    reg  [COUNTER_WIDTH-1:0] clk_cnt;
    reg  [2:0]  bit_idx;
    reg  [7:0]  data_reg;
    (* ASYNC_REG = "TRUE" *) reg rxd_meta;
    (* ASYNC_REG = "TRUE" *) reg rxd_sync;

    // 两级输入同步（复位置 1 = 线路空闲电平，避免误触发起始位）。
    // 只有第二级 rxd_sync 可被功能逻辑消费。
    always @(posedge clk) begin
        if (rst) begin
            rxd_meta <= 1'b1;
            rxd_sync <= 1'b1;
        end else begin
            rxd_meta <= rxd;
            rxd_sync <= rxd_meta;
        end
    end

    always @(posedge clk) begin
        if (rst) begin
            state     <= IDLE;
            clk_cnt   <= {COUNTER_WIDTH{1'b0}};
            bit_idx   <= 3'd0;
            data_reg  <= 8'd0;
            rx_data   <= 8'd0;
            rx_done   <= 1'b0;
            frame_err <= 1'b0;
        end else begin
            rx_done   <= 1'b0;        // 默认拉低
            frame_err <= 1'b0;        // 默认拉低
            case (state)
                //--------------------------------------------
                IDLE: begin
                    clk_cnt <= {COUNTER_WIDTH{1'b0}};
                    bit_idx <= 3'd0;
                    if (rxd_sync == 1'b0) begin   // 检测到起始位下降沿
                        state <= START;
                    end
                end
                //--------------------------------------------
                START: begin
                    // 计数半位，到达起始位中点
                    if (clk_cnt == (CLKS_PER_BIT - 1) / 2) begin
                        if (rxd_sync == 1'b0) begin
                            clk_cnt <= {COUNTER_WIDTH{1'b0}}; // 确认起始位有效
                            state   <= DATA;
                        end else begin
                            state <= IDLE;        // 假起始位，回退
                        end
                    end else begin
                        clk_cnt <= clk_cnt + {{(COUNTER_WIDTH-1){1'b0}}, 1'b1};
                    end
                end
                //--------------------------------------------
                DATA: begin
                    // 每整位在中点采样
                    if (clk_cnt == CLKS_PER_BIT - 1) begin
                        clk_cnt           <= {COUNTER_WIDTH{1'b0}};
                        data_reg[bit_idx] <= rxd_sync;
                        if (bit_idx == 3'd7) begin
                            bit_idx <= 3'd0;
                            state   <= STOP;
                        end else begin
                            bit_idx <= bit_idx + 3'd1;
                        end
                    end else begin
                        clk_cnt <= clk_cnt + {{(COUNTER_WIDTH-1){1'b0}}, 1'b1};
                    end
                end
                //--------------------------------------------
                STOP: begin
                    // 在停止位中点采样
                    if (clk_cnt == CLKS_PER_BIT - 1) begin
                        clk_cnt   <= {COUNTER_WIDTH{1'b0}};
                        rx_data   <= data_reg;
                        rx_done   <= 1'b1;
                        frame_err <= ~rxd_sync;   // 停止位应为 1
                        state     <= IDLE;
                    end else begin
                        clk_cnt <= clk_cnt + {{(COUNTER_WIDTH-1){1'b0}}, 1'b1};
                    end
                end
                //--------------------------------------------
                default: begin
                    state     <= IDLE;
                    clk_cnt   <= {COUNTER_WIDTH{1'b0}};
                    bit_idx   <= 3'd0;
                    data_reg  <= 8'd0;
                    rx_done   <= 1'b0;
                    frame_err <= 1'b0;
                end
            endcase
        end
    end

endmodule
