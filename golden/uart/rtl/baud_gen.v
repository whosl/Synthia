`timescale 1ns / 1ps
//============================================================================
// 模块名称 : baud_gen
// 功能描述 : 波特率节拍发生器。在 ce 有效期间，每隔 CLKS_PER_BIT 个系统
//            时钟周期产生一个 1 拍宽的 baud_tick 脉冲，供发送状态机用作
//            位时基准。接收状态机因需半位偏移采样，使用内部计数器，不复
//            用本模块。
// 时钟/复位 : clk 上升沿采样；rst 同步高有效复位。
// 参数关系 : CLKS_PER_BIT = round(CLK_FREQ / BAUD_RATE)
//            100 MHz / 9600 = 10416.67 -> 10417（四舍五入到最近整数）
//            实际波特率 = 100 MHz / 10417 = 9599.69 bps，误差 -0.0032%
//            （远小于 +/- 2% 容差）
//============================================================================
module baud_gen #(
    parameter CLK_FREQ  = 100_000_000, // 系统时钟频率 (Hz)
    parameter BAUD_RATE = 9600         // 目标波特率 (bps)
) (
    input  wire clk,                   // 系统时钟
    input  wire rst,                   // 同步复位，高有效
    input  wire ce,                    // 计数使能（发送期间有效）
    output reg  baud_tick              // 位节拍脉冲，每 CLKS_PER_BIT 拍拉高 1 拍
);

    // 四舍五入到最近整数，最小化波特率误差
    localparam CLKS_PER_BIT = (CLK_FREQ + (BAUD_RATE >> 1)) / BAUD_RATE;

    reg [15:0] counter;

    always @(posedge clk) begin
        if (rst) begin
            counter   <= 16'd0;
            baud_tick <= 1'b0;
        end else if (ce) begin
            if (counter == CLKS_PER_BIT - 1) begin
                counter   <= 16'd0;
                baud_tick <= 1'b1;
            end else begin
                counter   <= counter + 16'd1;
                baud_tick <= 1'b0;
            end
        end else begin
            counter   <= 16'd0;
            baud_tick <= 1'b0;
        end
    end

endmodule
